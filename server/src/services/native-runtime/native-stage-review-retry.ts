import { and, desc, eq, gt, inArray, lt, ne, or, sql } from "drizzle-orm";
import {
  agentWakeupRequests, environmentLeases, heartbeatRunEvents, heartbeatRuns,
  issueRecoveryActions, nativeRunFinalizations, nativeRunResults, statusDecisions, statusDecisionEffects,
  workAssessments, type Db,
} from "@paperclipai/db";
import { parseNativeExecutionInput, nativeSessionCleanupBlock } from "../../vendor/paperclip-runner/index.js";
import { adapterExecutionControls } from "../adapter-execution-control.js";
import { hasPendingRunCleanup } from "../execution-blocker.js";
import { PROCESS_IDENTITY_RECORDED, PROCESS_START_REQUESTED } from "../native-local-process-stop.js";
import { readTaskRetryIntent, taskRetryMutationAllowed } from "../task-retry.js";
import { nativeSha256 } from "./canonical.js";

type Decision = typeof statusDecisions.$inferSelect;
type Scope = { companyId: string; issueId: string; agentId: string };
const REASSESSMENT_RETRY_FAILURE = "native_continuation_requires_reconciliation";

/** Prove the immediate reassessment of the same accepted result. The original
 * decision still owns the wake; the reassessment owns the current status. */
export async function readStageRetryLineage(db: Db, current: Decision, result: typeof nativeRunResults.$inferSelect) {
  if (!current.supersedesDecisionId || current.applicationState !== "applied" ||
      current.fromStatus !== "blocked" || current.toStatus !== "in_review" ||
      current.reasonCode !== "task_total_review_pending" || current.decisionJson.statusAction !== "in_review") return null;
  const [original] = await db.select().from(statusDecisions).where(and(
    eq(statusDecisions.id, current.supersedesDecisionId), eq(statusDecisions.companyId, current.companyId),
    eq(statusDecisions.issueId, current.issueId), eq(statusDecisions.runId, current.runId),
  )).limit(1);
  if (!original || original.applicationState !== "applied" || original.reasonCode !== current.reasonCode ||
      original.toStatus !== "in_review" || original.decisionJson.statusAction !== "in_review") return null;
  const wakeVersion = original.decisionJson.projectedStatusVersion;
  const blockedVersion = current.decisionJson.priorStatusVersion;
  if (typeof wakeVersion !== "number" || blockedVersion !== wakeVersion + 1 ||
      current.decisionJson.projectedStatusVersion !== blockedVersion + 1 ||
      current.decisionVersion !== Math.max(original.decisionVersion, blockedVersion) + 1) return null;
  const [intervening] = await db.select({ id: statusDecisions.id }).from(statusDecisions).where(and(
    eq(statusDecisions.companyId, current.companyId), eq(statusDecisions.issueId, current.issueId),
    gt(statusDecisions.decisionVersion, original.decisionVersion), lt(statusDecisions.decisionVersion, current.decisionVersion),
  )).limit(1);
  if (intervening) return null;
  const assessments = await db.select().from(workAssessments).where(and(
    eq(workAssessments.companyId, current.companyId), eq(workAssessments.issueId, current.issueId),
    eq(workAssessments.runId, current.runId), eq(workAssessments.resultId, result.id),
    eq(workAssessments.contractId, result.completionContractId),
    inArray(workAssessments.id, [original.assessmentId, current.assessmentId]),
  ));
  const reassessment = assessments.find(row => row.id === current.assessmentId);
  if (assessments.length !== 2 || reassessment?.supersedesAssessmentId !== original.assessmentId ||
      reassessment.priorIssueStatus !== "blocked" || reassessment.priorStatusVersion !== blockedVersion ||
      reassessment.priorDecisionId !== original.id) return null;
  const effects = await db.select().from(statusDecisionEffects).where(and(
    eq(statusDecisionEffects.companyId, current.companyId), eq(statusDecisionEffects.issueId, current.issueId),
    eq(statusDecisionEffects.decisionId, current.id),
  )).limit(3);
  if (effects.length !== 2 || effects.some(effect => effect.deliveryState !== "delivered") ||
      !effects.some(effect => effect.effectKind === "issue_status_projection") ||
      !effects.some(effect => effect.effectKind === "append_superseding_assessment")) return null;
  return { original, wakeVersion, blockedVersion };
}

export async function readStageRetryReceipt(db: Db, scope: Scope, input: {
  requestId: string; runId?: string; historical?: boolean;
}) {
  const [receipt] = await db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.id, input.requestId), eq(agentWakeupRequests.companyId, scope.companyId),
    eq(agentWakeupRequests.agentId, scope.agentId), eq(agentWakeupRequests.reason, "task_retry"),
    eq(agentWakeupRequests.requestedByActorType, "user"),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${scope.issueId}`,
  )).limit(1);
  const intent = readTaskRetryIntent(receipt?.payload);
  if (!receipt || !intent || intent.generationId !== receipt.id || intent.actorId !== receipt.requestedByActorId ||
      intent.chatActionId || intent.canonicalIntentId || intent.queuedChatRequestId || intent.boardMessageOrigin) return null;

  if (!input.runId) {
    if (receipt.runId || receipt.status !== "deferred_issue_execution") return null;
  } else {
    if (!input.historical && !["queued", "claimed"].includes(receipt.status)) return null;
    const [run] = await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, scope.companyId),
      eq(heartbeatRuns.agentId, scope.agentId), eq(heartbeatRuns.issueId, scope.issueId),
    )).limit(1);
    if (!run || receipt.runId !== run.id || run.wakeupRequestId !== receipt.id ||
        run.contextSnapshot?.nativeStageRetryRequestId !== receipt.id ||
        run.contextSnapshot?.previousRunId !== intent.sourceRunId || run.retryOfRunId !== intent.sourceRunId ||
        run.responsibleUserId !== intent.actorId || (!input.historical && !["queued", "running"].includes(run.status))) return null;
  }

  if (!input.historical && !await taskRetryMutationAllowed(db, {
    ...scope, actorId: intent.actorId, actorSource: intent.actorSource,
  })) return null;
  return { receipt, sourceRunId: intent.sourceRunId, actorId: intent.actorId };
}

/** Existing failure block and launch trace must both refer to the same run.
 * A generic adapter failure or an absent PID alone cannot prove nonlaunch. */
export async function verifyStageRetryPredecessor(db: Db, scope: Scope, input: {
  sourceRunId: string; wakeId: string; originalDecisionId: string; admissionId: string;
  wakeVersion: number; blockedVersion: number; workspaceId: string; workspaceCwd: string;
  requestId: string; actorId: string; successorRunId?: string; checkPhysical: boolean;
}) {
  const [run] = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, input.sourceRunId), eq(heartbeatRuns.companyId, scope.companyId),
    eq(heartbeatRuns.agentId, scope.agentId), eq(heartbeatRuns.nativeIssueId, scope.issueId),
  )).limit(1);
  if (!run || run.status !== "failed" || run.runtimeMode !== "native" || !run.finishedAt ||
      run.errorCode !== "adapter_failed" || run.error !== "native_session_supervisor_busy" ||
      run.processPid || run.processGroupId || run.processStartedAt || run.sessionIdAfter ||
      run.resultJson?.operatorInterrupted || run.runnerProfileJson?.sessionCheckpoint ||
      adapterExecutionControls.has(run.id) ||
      (run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt > new Date())) return false;
  const context = run.contextSnapshot;
  if (context?.nativeStatusWakeIntentId !== input.wakeId || context.nativeStageDecisionId !== input.originalDecisionId ||
      context.nativeStageAdmissionId !== input.admissionId || context.nativeStageStatusVersion !== input.wakeVersion) return false;
  let execution;
  try { execution = parseNativeExecutionInput(run.runnerProfileJson?.nativeExecutionInput); }
  catch { return false; }
  const binding = execution.binding;
  if (binding.companyId !== scope.companyId || binding.issueId !== scope.issueId || binding.agentId !== scope.agentId ||
      binding.runId !== run.id || binding.executionWorkspaceId !== input.workspaceId ||
      execution.workspace.cwd !== input.workspaceCwd || execution.provider.kind !== "codex" ||
      execution.session.driverKind !== "codex_app_server") return false;

  const [latest] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, scope.companyId), or(
      eq(heartbeatRuns.nativeIssueId, scope.issueId), eq(heartbeatRuns.issueId, scope.issueId),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${scope.issueId}`,
    ),
    input.successorRunId ? ne(heartbeatRuns.id, input.successorRunId) : undefined,
  )).orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(1);
  const [owner] = await db.select().from(nativeRunFinalizations).where(and(
    eq(nativeRunFinalizations.companyId, scope.companyId), eq(nativeRunFinalizations.issueId, scope.issueId),
    eq(nativeRunFinalizations.runId, run.id),
  )).limit(1);
  if (latest?.id !== run.id || !owner || owner.phase !== "terminal_failure" || owner.failureCode !== REASSESSMENT_RETRY_FAILURE ||
      owner.leaseOwner || owner.nextAttemptAt || owner.resultId || owner.failureDetail?.successorRunId) return false;
  const blocks = await db.select().from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, scope.companyId), eq(issueRecoveryActions.sourceIssueId, scope.issueId),
    eq(issueRecoveryActions.kind, "active_run_watchdog"), eq(issueRecoveryActions.ownerType, "board"),
    eq(issueRecoveryActions.cause, REASSESSMENT_RETRY_FAILURE),
    sql`${issueRecoveryActions.evidence}->>'runId' = ${run.id}`,
    sql`${issueRecoveryActions.evidence}#>>'{nativeFailureBlock,runId}' = ${run.id}`,
    sql`${issueRecoveryActions.evidence}#>'{nativeFailureBlock,statusVersion}' = to_jsonb(${input.blockedVersion}::integer)`,
  )).limit(2);
  const block = blocks[0];
  if (blocks.length !== 1 || !block || block.status !== "resolved" || block.returnOwnerAgentId !== scope.agentId ||
      block.evidence.systemRecovery || block.evidence.executionReconciliation ||
      block.evidence.workspaceOwnerStop || block.evidence.providerSessionEstablished === true) return false;
  const replay = (block.evidence.automaticRecovery as { replay?: string } | undefined)?.replay;
  const continuation = block.evidence.explicitUserContinuation as Record<string, unknown> | undefined;
  if (input.successorRunId
    ? replay !== "explicit_user_continuation" || continuation?.runId !== input.successorRunId ||
      continuation.previousRunId !== run.id || continuation.taskRetryRequestId !== input.requestId ||
      continuation.actorId !== input.actorId
    : replay !== "blocked" || continuation) return false;

  const [result] = await db.select({ id: nativeRunResults.id }).from(nativeRunResults).where(and(
    eq(nativeRunResults.companyId, scope.companyId), eq(nativeRunResults.issueId, scope.issueId),
    eq(nativeRunResults.runId, run.id),
  )).limit(1);
  const [started] = await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, scope.companyId), eq(heartbeatRunEvents.runId, run.id),
    or(sql`${heartbeatRunEvents.sourceEventId} is not null`,
      inArray(heartbeatRunEvents.eventType, [PROCESS_START_REQUESTED, PROCESS_IDENTITY_RECORDED]),
      sql`${heartbeatRunEvents.eventType} ~ '^(session|turn|item|tool|semantic_tool|run[.]result)[.]'`),
  )).limit(1);
  const spans = await db.select({ event: heartbeatRunEvents.payload }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, scope.companyId), eq(heartbeatRunEvents.runId, run.id),
    eq(heartbeatRunEvents.agentId, scope.agentId), eq(heartbeatRunEvents.eventType, "run.performance.span"),
    sql`${heartbeatRunEvents.payload}->>'schema' = 'paperclip.run-performance-span.v1'`,
    sql`${heartbeatRunEvents.payload}->>'span' in ('native.coordinator.claim','task.prepare')`,
  )).orderBy(heartbeatRunEvents.seq).limit(3);
  if (result || started || spans.length !== 2 || spans[0]?.event?.span !== "native.coordinator.claim" ||
      spans[0].event.outcome !== "ok" || spans[1]?.event?.span !== "task.prepare" ||
      spans[1].event.outcome !== "failed") return false;

  const [unsettledLease] = await db.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
    eq(environmentLeases.companyId, scope.companyId), eq(environmentLeases.heartbeatRunId, run.id),
    sql`(${environmentLeases.provider} <> 'local' or ${environmentLeases.releasedAt} is null
      or ${environmentLeases.status} = 'pending_cleanup' or ${environmentLeases.cleanupStatus} = 'failed')`,
  )).limit(1);
  if (unsettledLease || await hasPendingRunCleanup(db, scope.companyId, run.id) || nativeSessionCleanupBlock(scope)) return false;
  if (!input.checkPhysical) return true;
  const { inspectNativeAgentPolicyWarmOwners, unidentifiedLocalRunnerProvenAbsent } = await import("./native-session-executor.js");
  if (inspectNativeAgentPolicyWarmOwners(scope).some(entry => entry.busy || entry.closing)) return false;
  return unidentifiedLocalRunnerProvenAbsent({ runId: run.id, execution });
}

export function stageRetryConfigurationDigest(agent: {
  adapterConfig: Record<string, unknown>; runtimeConfig: Record<string, unknown>;
}) {
  return nativeSha256({ adapterConfig: agent.adapterConfig, runtimeConfig: agent.runtimeConfig });
}

import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import {
  agentInstructionWorkingCopies, heartbeatRunEvents, heartbeatRuns, issues,
  nativeRunFinalizations, nativeRunResults, statusDecisions, workAssessments, githubPushOperationReceipts, reviewerGithubOperations, type Db,
} from "@paperclipai/db";
import { captureLegacyDurablePrpCheckpoint, validatePrpEvent, NativeProviderStateIncompatibleError, parseNativeExecutionInput, type NativeExecutionInput } from "../../vendor/paperclip-runner/index.js";
import { referenceFolderAdmissionSchema } from "../agent-reference-folder-admission.js";
import { hasPendingRunCleanup } from "../execution-blocker.js";
import { boundRunIssueId } from "../run-task-binding.js";
import { nativeSha256 } from "./canonical.js";
import { basename, dirname } from "node:path";
import { readReviewerProcessEvidence } from "./reviewer-policy-process-proof.js";

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function coldContinuationHold(reason: string): never {
  throw new NativeProviderStateIncompatibleError(`scoped_cold_continuation_${reason}`);
}

/** This is a positive incompatibility signal, not a replacement for the
 * runner's complete launch validator. The copy is admitted separately below.
 * Same-run recovery, remote providers and immutable/legacy instructions keep
 * their existing identity and recovery rules. */
export function hasChangedManagedNativeCopy(previous: NativeExecutionInput, current: NativeExecutionInput): boolean {
  if (previous.binding.runId === current.binding.runId || previous.provider.kind !== "codex" || current.provider.kind !== "codex"
    || !("runtimeContext" in previous) || !("runtimeContext" in current)
    || ("homeMode" in current && current.homeMode === "preconfigured")) return false;
  const before = previous.runtimeContext.instructions.workingCopy, after = current.runtimeContext.instructions.workingCopy;
  return before?.kind === "agent_files" && after?.kind === "agent_files" && before.rootPath !== after.rootPath;
}

/** PK-bound database authority for a NEW cold continuation. Physical ownership
 * is deliberately proved by the native executor, in its real service singleton.
 * This reader also runs at selection commit and again before native dispatch;
 * its fingerprint is never an authorization supplied by an API caller. */
export async function readCompletedNativeColdSource(db: Db, sourceRunId: string, current: NativeExecutionInput) {
  return readColdSource(db, sourceRunId, current, sourceRunId);
}

// Historical warm copies are superseded by the real directory owner, not
// stopped/saved independently. Only the complete native-origin reader below
// can use this private historical branch; the latest-source API stays strict.
async function readColdSource(db: Db, sourceRunId: string, current: NativeExecutionInput, receiptSourceRunId: string,
  historical?: { successorRunId: string; materializationRunId: string }) {
  const b = current.binding;
  const [bound] = await db.select({ run: heartbeatRuns, owner: nativeRunFinalizations, result: nativeRunResults,
    assessment: workAssessments, decision: statusDecisions })
    .from(heartbeatRuns)
    .innerJoin(nativeRunFinalizations, and(eq(nativeRunFinalizations.runId, heartbeatRuns.id), eq(nativeRunFinalizations.companyId, heartbeatRuns.companyId)))
    .innerJoin(nativeRunResults, and(eq(nativeRunResults.id, nativeRunFinalizations.resultId), eq(nativeRunResults.runId, heartbeatRuns.id)))
    .innerJoin(workAssessments, and(eq(workAssessments.id, nativeRunFinalizations.assessmentId), eq(workAssessments.runId, heartbeatRuns.id)))
    .innerJoin(statusDecisions, and(eq(statusDecisions.id, nativeRunFinalizations.decisionId), eq(statusDecisions.runId, heartbeatRuns.id)))
    .where(and(eq(heartbeatRuns.id, sourceRunId), eq(heartbeatRuns.companyId, b.companyId), eq(heartbeatRuns.agentId, b.agentId), eq(heartbeatRuns.nativeIssueId, b.issueId))).limit(1);
  if (!bound) coldContinuationHold("completed_source_missing");
  const { run, owner, result, assessment, decision } = bound;
  let previous: NativeExecutionInput;
  try { previous = parseNativeExecutionInput(record(run.runnerProfileJson).nativeExecutionInput); }
  catch { coldContinuationHold("saved_execution_invalid"); }
  if (run.id === b.runId || run.runtimeMode !== "native" || run.status !== "succeeded" || !run.finishedAt || run.errorCode
    || previous.binding.runId !== run.id || previous.binding.companyId !== b.companyId || previous.binding.agentId !== b.agentId
    || previous.binding.issueId !== b.issueId || previous.binding.executionWorkspaceId !== b.executionWorkspaceId
    || nativeSha256(previous.workspace) !== nativeSha256(current.workspace) || nativeSha256(previous.provider) !== nativeSha256(current.provider)
    || run.nativeSessionId !== previous.session.normalizedSessionId || !run.runnerInstanceId
    || !hasChangedManagedNativeCopy(previous, current)
    || !("runtimeContext" in previous) || !("runtimeContext" in current)
    || previous.runtimeContext.aggregateDigest !== current.runtimeContext.aggregateDigest) coldContinuationHold("source_binding_changed");
  if (owner.phase !== "committed" || owner.recoveryState || owner.leaseOwner || owner.nextAttemptAt || owner.failureCode
    || owner.issueId !== b.issueId || result.companyId !== b.companyId || result.issueId !== b.issueId
    || result.schemaStatus !== "accepted" || !result.canonicalSha256 || result.completionContractId !== run.completionContractId
    || record(record(result.resultJson).terminal).runTerminalState !== "succeeded"
    || assessment.companyId !== b.companyId || assessment.issueId !== b.issueId || assessment.resultId !== result.id
    || assessment.contractId !== result.completionContractId || decision.companyId !== b.companyId || decision.issueId !== b.issueId
    || decision.applicationState !== "applied") coldContinuationHold("source_not_committed");
  const checkpoint = record(record(run.runnerProfileJson).sessionCheckpoint);
  const checkpointIdentity = record(checkpoint.identity);
  if (checkpoint.backendKind !== "runner" || checkpoint.driverKind !== previous.session.driverKind
    || checkpoint.workingDirectory !== previous.workspace.cwd
    || checkpointIdentity.runId !== run.id || checkpointIdentity.companyId !== run.companyId
    || checkpointIdentity.agentId !== run.agentId || checkpointIdentity.issueId !== run.nativeIssueId
    || checkpointIdentity.sessionId !== run.nativeSessionId) coldContinuationHold("checkpoint_binding_changed");
  if (!Object.keys(checkpoint).length || checkpoint.activeTurnId != null
    || !Array.isArray(checkpoint.pendingRuntimeRequests) || checkpoint.pendingRuntimeRequests.length
    || checkpoint.providerRecoveryPolicy === "same_session_only"
    || checkpoint.goal != null && (typeof checkpoint.goal !== "object" || Array.isArray(checkpoint.goal) || record(checkpoint.goal).status !== "complete")) coldContinuationHold("source_requires_same_session");
  const [target] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, b.runId), eq(heartbeatRuns.companyId, b.companyId), eq(heartbeatRuns.agentId, b.agentId))).limit(1);
  const [issue] = await db.select().from(issues).where(and(eq(issues.id, b.issueId), eq(issues.companyId, b.companyId))).limit(1);
  if (!target || target.status !== "running" || boundRunIssueId(target) !== b.issueId
    || !issue || issue.executionRunId !== b.runId || issue.assigneeAgentId !== b.agentId) coldContinuationHold("target_not_current");
  const targetProfile = record(target.runnerProfileJson), persisted = targetProfile.nativeExecutionInput;
  if (persisted !== undefined) {
    const receipt = record(targetProfile.nativeColdScopedContinuation);
    if (receipt.sourceRunId !== receiptSourceRunId || receipt.targetExecutionSha256 !== nativeSha256(current)
      || nativeSha256(persisted) !== nativeSha256(current)) coldContinuationHold("target_receipt_changed");
  } else {
    if (target.processPid || target.processGroupId || target.processStartedAt) coldContinuationHold("target_already_started");
    const [started] = await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(
      eq(heartbeatRunEvents.companyId, b.companyId), eq(heartbeatRunEvents.runId, b.runId),
      sql`(${heartbeatRunEvents.sourceEventId} IS NOT NULL OR ${heartbeatRunEvents.eventType} IN ('native.process_start_requested','native.process_identity_recorded'))`,
    )).limit(1);
    if (started) coldContinuationHold("target_already_started");
  }
  const sourcePolicyResult = referenceFolderAdmissionSchema.safeParse(record(run.runnerProfileJson).referenceFolderAdmission);
  const targetPolicyResult = referenceFolderAdmissionSchema.safeParse(targetProfile.referenceFolderAdmission);
  if (!sourcePolicyResult.success || !targetPolicyResult.success) coldContinuationHold("workspace_policy_invalid");
  const sourcePolicy = sourcePolicyResult.data, targetPolicy = targetPolicyResult.data;
  const policyScope = (p: typeof sourcePolicy) => ({ ...p, binding: { ...p.binding, runId: null } });
  if (!sourcePolicy.paths.length || sourcePolicy.binding.runId !== run.id || targetPolicy.binding.runId !== b.runId
    || targetPolicy.binding.companyId !== b.companyId || targetPolicy.binding.agentId !== b.agentId
    || targetPolicy.binding.projectId !== issue.projectId
    || targetPolicy.binding.workspaceId !== b.executionWorkspaceId || targetPolicy.workspaceDirectory !== current.workspace.cwd
    || nativeSha256(policyScope(sourcePolicy)) !== nativeSha256(policyScope(targetPolicy))) coldContinuationHold("workspace_policy_changed");
  const copies = await db.select().from(agentInstructionWorkingCopies).where(and(
    eq(agentInstructionWorkingCopies.companyId, b.companyId), eq(agentInstructionWorkingCopies.agentId, b.agentId),
    sql`${agentInstructionWorkingCopies.runId} IN (${run.id}::uuid, ${b.runId}::uuid)`,
  ));
  const sourceCopy = copies.find(copy => copy.runId === run.id), targetCopy = copies.find(copy => copy.runId === b.runId);
  const validOrigin = (copy: typeof copies[number]) => {
    const origin = copy.receipt?.materializationRunId ?? copy.receipt?.directoryRunId
      ?? (historical && copy.runId === sourceRunId ? historical.materializationRunId : copy.runId);
    if (typeof origin !== "string") return false;
    return /^[a-zA-Z0-9_-]{1,128}$/.test(origin) && basename(copy.localRoot) === "live"
      && basename(dirname(copy.localRoot)) === origin && basename(dirname(dirname(copy.localRoot))) === "runs"
      && basename(dirname(dirname(dirname(copy.localRoot)))) === "file-sync"
      && (copy.receipt?.directoryRunId == null || copy.receipt.directoryRunId === origin);
  };
  const sourceSettled = sourceCopy && (historical
    ? sourceCopy.state === "superseded" && sourceCopy.receipt?.warm === true
      && sourceCopy.receipt?.successorRunId === historical.successorRunId
      && basename(dirname(sourceCopy.localRoot)) === historical.materializationRunId
    : sourceCopy.processStoppedAt && ["saved", "unchanged", "resolved"].includes(sourceCopy.state)
      && sourceCopy.receipt?.cleanupPending === false);
  if (!sourceCopy || !targetCopy || !sourceSettled
    || [sourceCopy, targetCopy].some(copy => copy.location !== "local" || copy.localRoot !== copy.executionRoot
      || copy.receipt?.schema !== "paperclip.agent-files.v1" || copy.receipt?.retainedByRunId != null || !validOrigin(copy))
    || dirname(dirname(dirname(dirname(sourceCopy.localRoot)))) !== dirname(dirname(dirname(dirname(targetCopy.localRoot))))
    || sourceCopy.errorCode
    || !persisted && (targetCopy.state !== "prepared" || targetCopy.processStoppedAt) || targetCopy.errorCode
    || persisted && !["prepared", "warm_saved", "unchanged_turn", "saved", "unchanged", "resolved"].includes(targetCopy.state)
    || sourceCopy.executionRoot !== previous.runtimeContext.instructions.workingCopy?.rootPath
    || targetCopy.executionRoot !== current.runtimeContext.instructions.workingCopy?.rootPath
    || sourceCopy.entryFile !== previous.runtimeContext.instructions.workingCopy?.entryPath
    || targetCopy.entryFile !== current.runtimeContext.instructions.workingCopy?.entryPath) coldContinuationHold("instruction_copy_unsettled");
  const [newer] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, b.companyId), eq(heartbeatRuns.agentId, b.agentId), eq(heartbeatRuns.nativeSessionId, run.nativeSessionId!), ne(heartbeatRuns.id, b.runId),
    sql`${heartbeatRuns.createdAt} > (SELECT created_at FROM heartbeat_runs WHERE id = ${run.id}::uuid)`,
  )).limit(1);
  if (!historical && newer || await hasPendingRunCleanup(db, b.companyId, run.id)) coldContinuationHold("source_cleanup_or_new_owner");
  // Terminal run status does not settle an externally ambiguous write.
  // These existing closed-operation owners retain pending/unknown outcomes.
  const [[push], [discussion]] = await Promise.all([
    db.select({ id: githubPushOperationReceipts.id }).from(githubPushOperationReceipts).where(and(
      eq(githubPushOperationReceipts.companyId, b.companyId), eq(githubPushOperationReceipts.agentId, b.agentId),
      eq(githubPushOperationReceipts.runId, run.id), inArray(githubPushOperationReceipts.state, ["pending", "uncertain"]),
    )).limit(1),
    db.select({ id: reviewerGithubOperations.id }).from(reviewerGithubOperations).where(and(
      eq(reviewerGithubOperations.companyId, b.companyId), eq(reviewerGithubOperations.agentId, b.agentId),
      eq(reviewerGithubOperations.runId, run.id), inArray(reviewerGithubOperations.status, ["pending", "writing", "uncertain"]),
    )).limit(1),
  ]);
  if (push || discussion) coldContinuationHold("source_side_effect_unsettled");
  // Scheduling/touch timestamps are not execution authority. The target copy
  // may checkpoint during same-run recovery; its registered identity must stay
  // exact, while the native copy owner continues to govern collection/save.
  const copyIdentity = (copy: typeof sourceCopy) => ({ runId: copy.runId, companyId: copy.companyId, agentId: copy.agentId,
    responsibleUserId: copy.responsibleUserId, entryFile: copy.entryFile, localRoot: copy.localRoot, executionRoot: copy.executionRoot, location: copy.location });
  return { run, previous, checkpoint, sourceCopy, fingerprint: nativeSha256({
    source: { id: run.id, companyId: run.companyId, agentId: run.agentId, issueId: run.nativeIssueId, status: run.status,
      nativeSessionId: run.nativeSessionId, runnerInstanceId: run.runnerInstanceId, processPid: run.processPid,
      processGroupId: run.processGroupId, processStartedAt: run.processStartedAt, processHostHash: run.processHostHash,
      execution: previous, checkpoint },
    owner: { phase: owner.phase, resultId: owner.resultId, assessmentId: owner.assessmentId, decisionId: owner.decisionId,
      leaseOwner: owner.leaseOwner, recoveryState: owner.recoveryState, failureCode: owner.failureCode, nextAttemptAt: owner.nextAttemptAt },
    accepted: { resultId: result.id, resultSha256: result.canonicalSha256, contractId: result.completionContractId,
      assessmentId: assessment.id, assessmentInputDigest: assessment.inputDigest, decisionId: decision.id, applicationState: decision.applicationState },
    sourceCopy: { ...copyIdentity(sourceCopy), state: sourceCopy.state, baseHash: sourceCopy.baseHash,
      candidateHash: sourceCopy.candidateHash, processStoppedAt: sourceCopy.processStoppedAt, errorCode: sourceCopy.errorCode, receipt: sourceCopy.receipt },
    targetCopy: copyIdentity(targetCopy), sourcePolicy, targetPolicy,
  }) };
}

/** LOCAL origin proof for a NEW session, never attachment/replay authority.
 * Native local warm handoff preserves bootstrap origin + the latest completed
 * transfer, not encrypted per-run checkpoints. All intervening accepted runs,
 * real copy handoffs and authenticated attachment/process events therefore
 * remain independent obligations. Missing older evidence is a permanent hold.
 */
export async function readNativeColdWarmOrigin(db: Db, latest: Awaited<ReturnType<typeof readCompletedNativeColdSource>>,
  current: NativeExecutionInput, control: Record<string, unknown>) {
  if (control.completedWarmTransition == null && control.bootstrapHistory == null) return null;
  // First-launch (non-attached) scopes keep the existing strict per-run proof.
  if (control.completedWarmTransition == null && record(control.identity).runId === latest.run.id
    && record(record(control.bootstrapHistory).originIdentity).runId === latest.run.id) return null;
  const maximumBytes = 8 * 1024 * 1024, deadline = Date.now() + 25_000;
  let observedBytes = 0;
  const bounded = (value: unknown) => {
    observedBytes += Buffer.byteLength(JSON.stringify(value));
    if (observedBytes > maximumBytes || Date.now() > deadline) coldContinuationHold("warm_history_bound");
  };
  bounded(control);
  let native;
  try { native = captureLegacyDurablePrpCheckpoint(JSON.stringify(control), {
    runId: latest.run.id, runnerInstanceId: latest.run.runnerInstanceId!, normalizedSessionId: latest.run.nativeSessionId!,
  }); } catch { coldContinuationHold("warm_checkpoint_invalid"); }
  const header = record(JSON.parse(native.records.get("header")!)), state = record(header.state);
  const originIdentity = record(record(state.bootstrapHistory).originIdentity);
  const latestIdentity = record(state.identity), transfer = record(record(state.completedWarmTransition).receipt);
  const oldIdentity = record(transfer.oldIdentity);
  if (record(state.bootstrapHistory).adopted !== true || typeof originIdentity.runId !== "string"
    || originIdentity.runId === latest.run.id || !state.completedWarmTransition
    || [originIdentity, oldIdentity].some(identity => ["runnerInstanceId", "environmentLeaseId", "normalizedSessionId"]
      .some(key => identity[key] !== latestIdentity[key]))
    || latestIdentity.environmentLeaseId !== latest.previous.binding.executionWorkspaceId) coldContinuationHold("warm_origin_binding");
  // Do not filter out failed, foreign-agent or foreign-issue rows that happen
  // to share this session. They are conflicts, not gaps in an approved chain.
  const history = await db.select({ id: heartbeatRuns.id,
    bytes: sql<number>`octet_length(to_jsonb(${heartbeatRuns})::text)`,
  }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, latest.run.companyId),
    eq(heartbeatRuns.nativeSessionId, latest.run.nativeSessionId!), ne(heartbeatRuns.id, current.binding.runId)))
    .orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id)).limit(17);
  if (history.length < 2 || history.length > 16 || history[0]?.id !== originIdentity.runId
    || history.at(-1)?.id !== latest.run.id || history.at(-2)?.id !== oldIdentity.runId
    || history.reduce((n, row) => n + Number(row.bytes), observedBytes) > maximumBytes) coldContinuationHold("warm_history_binding");
  const sources: Array<typeof latest> = [];
  for (let i = 0; i < history.length; i++) {
    const source = i === history.length - 1 ? latest : await readColdSource(db, history[i]!.id, current, latest.run.id,
      { successorRunId: history[i + 1]!.id, materializationRunId: String(originIdentity.runId) });
    bounded(source);
    if (source.run.runnerInstanceId !== latest.run.runnerInstanceId
      || source.run.nativeSessionId !== latest.run.nativeSessionId
      || source.run.processPid !== latest.run.processPid || source.run.processGroupId !== latest.run.processGroupId
      || source.run.processStartedAt?.getTime() !== latest.run.processStartedAt?.getTime()
      || source.run.processHostHash != null && source.run.processHostHash !== sources[0]?.run.processHostHash && sources.length > 0
      || source.sourceCopy.localRoot !== latest.sourceCopy.localRoot
      || source.sourceCopy.entryFile !== latest.sourceCopy.entryFile
      || source.checkpoint.sessionId !== latest.checkpoint.sessionId
      || source.checkpoint.providerSessionId !== latest.checkpoint.providerSessionId
      || (record(record(source.run.contextSnapshot).paperclipEnvironment).id ?? null)
        !== (record(record(latest.run.contextSnapshot).paperclipEnvironment).id ?? null)) coldContinuationHold("warm_generation_changed");
    sources.push(source);
  }
  const origin = sources[0]!;
  if (latest.sourceCopy.receipt?.materializationRunId !== origin.run.id
    || latest.sourceCopy.receipt?.directoryRunId != null && latest.sourceCopy.receipt.directoryRunId !== origin.run.id
    || typeof latest.checkpoint.sessionId !== "string" || !latest.checkpoint.sessionId) coldContinuationHold("warm_directory_origin");
  const runIds = history.map(row => row.id);
  const [processEvents, attachments] = await Promise.all([
    readReviewerProcessEvidence(db, latest.run.companyId, runIds),
    db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.companyId, latest.run.companyId),
      inArray(heartbeatRunEvents.runId, runIds), eq(heartbeatRunEvents.eventType, "run.attached")))
      .orderBy(asc(heartbeatRunEvents.runId), asc(heartbeatRunEvents.seq)).limit(17),
  ]);
  if (attachments.length !== history.length - 1) coldContinuationHold("warm_attachment_missing");
  const events = [...processEvents, ...attachments]; bounded(events);
  for (const eventRow of events) {
    const source = sources.find(s => s.run.id === eventRow.runId);
    if (!source || eventRow.agentId !== source.run.agentId || eventRow.companyId !== source.run.companyId) coldContinuationHold("warm_event_binding");
    if (eventRow.sourceEventId === null) {
      // A new/restarted local generation must have its own native proof; never
      // reinterpret a later private spawn or stop record as an inherited one.
      if (source !== origin) coldContinuationHold("warm_generation_changed");
      continue;
    }
    const event = record(record(eventRow.payload).prpEvent), payload = record(event.payload);
    if (!validatePrpEvent(event).ok || event.sourceKind !== "runner" || event.sourceInstanceId !== source.run.runnerInstanceId
      || event.runId !== source.run.id || event.normalizedSessionId !== source.run.nativeSessionId
      || event.sourceSeq !== eventRow.sourceSeq || event.eventType !== eventRow.eventType
      || eventRow.sourceInstanceId !== source.run.runnerInstanceId || event.sourceEventId !== eventRow.sourceEventId
      || eventRow.sourceEventId !== `${source.run.runnerInstanceId}:${source.run.id}:${eventRow.sourceSeq}`
      || eventRow.sourcePayloadSha256 !== nativeSha256(event)) coldContinuationHold("warm_event_provenance");
    if (eventRow.eventType === "run.attached" && (source === origin || payload.runId !== source.run.id || payload.sameSession !== true)) coldContinuationHold("warm_attachment_invalid");
    if (["session.started", "session.resumed"].includes(eventRow.eventType)) {
      // Native Rust events call the driver thread providerSessionId, whereas
      // harness events use driverSessionId and reserve providerSessionId for
      // the account. Neither is the Paperclip normalized session identity.
      const thread = payload.driverSessionId ?? payload.providerSessionId;
      const account = payload.driverSessionId != null ? payload.providerSessionId : payload.providerAccountSessionId;
      if (thread !== latest.checkpoint.sessionId || (account ?? null) !== (latest.checkpoint.providerSessionId ?? null)) coldContinuationHold("warm_provider_changed");
    } else if (eventRow.eventType === "session.reconciled") {
      // Rust identifies its provider and reports the driver thread here;
      // the harness reconciliation event reports only the account identity.
      if (payload.provider === "codex" ? payload.providerSessionId !== latest.checkpoint.sessionId
        : (payload.providerSessionId ?? null) !== (latest.checkpoint.providerSessionId ?? null)) coldContinuationHold("warm_provider_changed");
    }
  }
  for (const source of sources.slice(1)) if (attachments.filter(row => row.runId === source.run.id).length !== 1) coldContinuationHold("warm_attachment_missing");
  if (!processEvents.some(row => row.runId === origin.run.id && ["session.started", "session.resumed"].includes(row.eventType))) coldContinuationHold("warm_provider_origin_missing");
  return { runs: sources.map(source => source.run), origin: origin.run, processEvents,
    threadId: String(latest.checkpoint.sessionId), accountSessionId: latest.checkpoint.providerSessionId ?? null,
    fingerprint: nativeSha256({ native: [...native.records].sort(([a], [b]) => a.localeCompare(b)),
      sources: sources.map(source => source.fingerprint), events }) };
}

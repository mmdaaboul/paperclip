import { NativeProviderStateIncompatibleError } from "../../vendor/paperclip-runner/index.js";
import { z } from "zod";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { activityLog, issueExecutionDecisions, agents, agentWakeupRequests, heartbeatRuns, issues, issueReviewCycleBudgets, nativeRunResults, nativeRunFinalizations, statusDecisions, statusDecisionEffects, executionWorkspaces, workAssessments, type Db } from "@paperclipai/db";
import { issueReviewCycleBudgetSchema } from "@paperclipai/shared";
import { normalizeIssueExecutionPolicy, parseIssueExecutionState } from "../issue-execution-policy.js";
import { parseNativeExecutionInput } from "../../vendor/paperclip-runner/index.js";
import { nativeSha256 } from "./canonical.js";
import { readStageRetryLineage, readStageRetryReceipt, stageRetryConfigurationDigest, verifyStageRetryPredecessor } from "./native-stage-review-retry.js";

/** Resolve the native committer's durable intent through its exact effect.
 * The dispatcher creates a SECOND row with the same idempotency key; its
 * delivery failure is not the original stage authority. Never select by row
 * order, accept arbitrary caller hints or fall back to another matching wake. */
async function nativeStageWakeIntent(db:Db,input:{companyId:string;issueId:string;agentId:string;decisionId:string;stageId:string;intentId?:string}) {
  const effects=await db.select().from(statusDecisionEffects).where(and(eq(statusDecisionEffects.companyId,input.companyId),
    eq(statusDecisionEffects.issueId,input.issueId),eq(statusDecisionEffects.decisionId,input.decisionId),
    eq(statusDecisionEffects.effectKind,"execution_stage_wake"),eq(statusDecisionEffects.targetType,"agent_wakeup_request"))).limit(2);
  if(effects.length!==1)return null;
  const effect=effects[0]!;
  if(effect.deliveryState!=="delivered" || !effect.targetId || effect.payload.stageId!==input.stageId || effect.payload.agentId!==input.agentId
    || input.intentId!==undefined && input.intentId!==effect.targetId)return null;
  const [wake]=await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.id,effect.targetId),
    eq(agentWakeupRequests.companyId,input.companyId),eq(agentWakeupRequests.agentId,input.agentId)));
  if(!wake || wake.requestedByActorType!=="system" || wake.requestedByActorId!=="native-status-committer"
    || wake.idempotencyKey!==`native-execution-stage:${input.decisionId}:${input.stageId}`)return null;
  return wake;
}

function stageWakeTupleMatches(wake:typeof agentWakeupRequests.$inferSelect,context:{nativeStageDecisionId:string;nativeStageAdmissionId:string;nativeStageStatusVersion:number}) {
  const payload=wake.payload, nested=payload?._paperclipWakeContext as Record<string,unknown>|undefined;
  return [payload,nested].every(value=>value?.nativeStageDecisionId===context.nativeStageDecisionId
    && value.nativeStageAdmissionId===context.nativeStageAdmissionId && value.nativeStageStatusVersion===context.nativeStageStatusVersion);
}

/** DB-derived normal-stage assignment. Hints alone never grant a review: the
 * latest task ledger, committed native result/decision and durable stage wake
 * must all name the same candidate, selected independent Reviewer and version.
 */
type StageAssignmentInput = {
  companyId: string; issueId: string; agentId: string; runId?: string;
  claimRunId?: string; verifyRetryPhysical?: boolean; contextSnapshot: unknown;
};

export async function getNativeStageReviewAssignment(db: Db, input: StageAssignmentInput) {
  return readStageAssignment(db, input);
}

async function readStageAssignment(db: Db, input: StageAssignmentInput, boardRetryRequestId?: string) {
  const context=readNativeStageReviewContext(input.contextSnapshot);
  if(!context)return null;
  const [issue]=await db.select().from(issues).where(and(eq(issues.id,input.issueId),eq(issues.companyId,input.companyId)));
  const policy=normalizeIssueExecutionPolicy(issue?.executionPolicy),state=parseIssueExecutionState(issue?.executionState);
  if(!issue || policy?.totalReviewCycles!==5 || issue.status!=="in_review" || issue.statusVersion!==context.nativeStageStatusVersion || state?.status!=="pending" || state.currentStageType!=="review"
    || state.currentParticipant?.type!=="agent" || state.currentParticipant.agentId!==input.agentId || issue.assigneeAgentId!==input.agentId || issue.assigneeUserId) return null;
  const stage=policy.stages.find(s=>s.id===state.currentStageId);
  if(!stage || stage.type!=="review" || !stage.participants.some(p=>p.type==="agent" && p.agentId===input.agentId)) return null;
  const [ledger]=await db.select().from(issueReviewCycleBudgets).where(and(eq(issueReviewCycleBudgets.companyId,input.companyId),eq(issueReviewCycleBudgets.issueId,input.issueId)));
  const admission=ledger?issueReviewCycleBudgetSchema.parse(ledger.ledger).admissions.at(-1):null;
  if(!admission || admission.kind!=="normal" || admission.id!==context.nativeStageAdmissionId || admission.builderAgentId===input.agentId || state.returnAssignee?.agentId!==admission.builderAgentId) return null;
  const [sourceRun]=await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id,admission.builderRunId),eq(heartbeatRuns.companyId,input.companyId),eq(heartbeatRuns.agentId,admission.builderAgentId),eq(heartbeatRuns.nativeIssueId,input.issueId)));
  const [result]=await db.select().from(nativeRunResults).where(and(eq(nativeRunResults.id,admission.id),eq(nativeRunResults.companyId,input.companyId),eq(nativeRunResults.issueId,input.issueId),eq(nativeRunResults.runId,admission.builderRunId)));
  const [sourceDecision]=await db.select().from(statusDecisions).where(and(eq(statusDecisions.id,context.nativeStageDecisionId),eq(statusDecisions.companyId,input.companyId),eq(statusDecisions.issueId,input.issueId),eq(statusDecisions.runId,admission.builderRunId)));
  const [coordinator]=await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId,admission.builderRunId));
  if(!sourceRun || sourceRun.runtimeMode!=="native" || !result || result.schemaStatus!=="accepted" || admission.candidateId!==`native-result:${result.id}:${result.canonicalSha256}`
    || !sourceDecision || sourceDecision.applicationState!=="applied" || coordinator?.resultId!==result.id || coordinator.decisionId!==sourceDecision.id) return null;
  const retryRequestId = context.nativeStageRetryRequestId;
  const retryRunId = input.runId ?? input.claimRunId;
  const retry = retryRequestId && (retryRunId || retryRequestId === boardRetryRequestId)
    ? await readStageRetryReceipt(db, input, { requestId: retryRequestId, runId: retryRunId }) : null;
  if (retryRequestId && !retry) return null;
  const lineage = retry ? await readStageRetryLineage(db, sourceDecision, result) : null;
  if (retry && (!lineage || coordinator.phase !== "committed" || coordinator.leaseOwner ||
      coordinator.assessmentId !== sourceDecision.assessmentId || issue.lastStatusDecisionId !== sourceDecision.id ||
      sourceDecision.decisionJson.projectedStatusVersion !== issue.statusVersion ||
      result.completionContractId !== sourceRun.completionContractId)) return null;
  const origin = lineage ? {
    ...context, nativeStageDecisionId: lineage.original.id, nativeStageStatusVersion: lineage.wakeVersion,
  } : context;
  const wake=await nativeStageWakeIntent(db,{...input,decisionId:origin.nativeStageDecisionId,stageId:stage.id,intentId:context.nativeStatusWakeIntentId});
  if(!wake || ["cancelled","skipped","failed"].includes(wake.status) || !stageWakeTupleMatches(wake,origin)) return null;
  const capturedStage=(wake.payload as {executionStage?:{policySha256?:unknown;workspaceBindingRevision?:unknown;executionWorkspaceId?:unknown;reviewRequest?:unknown}}|null)?.executionStage;
  if(capturedStage?.policySha256!==nativeSha256(policy) || capturedStage.workspaceBindingRevision!==issue.workspaceBindingRevision || capturedStage.executionWorkspaceId!==issue.executionWorkspaceId) return null;
  if (retry && (wake.status !== "coalesced" || wake.reason !== "execution_review_requested" ||
      nativeSha256(capturedStage.reviewRequest ?? null) !== nativeSha256(state.reviewRequest ?? null))) return null;
  let execution;try {execution=parseNativeExecutionInput(sourceRun.runnerProfileJson?.nativeExecutionInput);}catch{return null;}
  if(execution.binding.companyId!==input.companyId || execution.binding.agentId!==admission.builderAgentId || execution.binding.runId!==sourceRun.id || execution.binding.issueId!==input.issueId || !issue.executionWorkspaceId) return null;
  const [workspace]=await db.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.id,issue.executionWorkspaceId),eq(executionWorkspaces.companyId,input.companyId)));
  if(!workspace || workspace.cwd!==execution.workspace.cwd || workspace.id!==execution.binding.executionWorkspaceId) return null;
  const [agent]=await db.select().from(agents).where(and(eq(agents.id,input.agentId),eq(agents.companyId,input.companyId)));
  if(!agent || agent.adapterType!=="paperclip_runner" || ["paused","terminated"].includes(agent.status)) return null;
  const retryConfigDigest = retry ? stageRetryConfigurationDigest(agent) : null;
  if (retry && retryRunId && (context.nativeStageRetryConfigDigest !== retryConfigDigest ||
      retry.receipt.payload?.nativeStageRetryConfigDigest !== retryConfigDigest || !stageWakeTupleMatches(retry.receipt, context))) return null;
  if (retry && lineage && (!workspace.cwd || !await verifyStageRetryPredecessor(db, input, {
    sourceRunId: retry.sourceRunId, wakeId: wake.id, originalDecisionId: lineage.original.id,
    admissionId: admission.id, wakeVersion: lineage.wakeVersion, blockedVersion: lineage.blockedVersion,
    workspaceId: workspace.id, workspaceCwd: workspace.cwd, successorRunId: retryRunId,
    requestId: retry.receipt.id, actorId: retry.actorId,
    reassessedDecisionId: sourceDecision.id, configDigest: retryConfigDigest!,
    checkPhysical: !retryRunId || input.verifyRetryPhysical === true,
  }))) return null;
  let actingRun:typeof heartbeatRuns.$inferSelect|undefined;
  if(input.runId) {
    [actingRun]=await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id,input.runId),eq(heartbeatRuns.companyId,input.companyId),eq(heartbeatRuns.agentId,input.agentId),eq(heartbeatRuns.nativeIssueId,input.issueId)));
    const actual=actingRun?.contextSnapshot as Record<string,unknown>|null;
    if(!actingRun || actingRun.status!=="running" || actingRun.runtimeMode!=="native" || issue.executionRunId!==actingRun.id || actual?.nativeStageDecisionId!==sourceDecision.id || actual.nativeStageAdmissionId!==admission.id || actual.nativeStageStatusVersion!==issue.statusVersion) return null;
  }
  return {issue,policy,state,stage,admission,sourceRun,sourceDecision,result,execution,workspace,wake,actingRun,
    policySha256:nativeSha256(policy),executionSha256:nativeSha256(execution),retry, retryConfigDigest};
}

const stageContextSchema=z.object({nativeStageDecisionId:z.string().guid(),nativeStageAdmissionId:z.string().guid(),nativeStageStatusVersion:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),nativeStatusWakeIntentId:z.string().guid().optional(),
  nativeStageRetryRequestId:z.string().guid().optional(),nativeStageRetryConfigDigest:z.string().regex(/^[0-9a-f]{64}$/).optional()});
export function readNativeStageReviewContext(value:unknown) {
  if(!value || typeof value!=="object" || Array.isArray(value))return null;
  if(!["nativeStageDecisionId","nativeStageAdmissionId","nativeStageStatusVersion"].some(key=>Object.hasOwn(value,key)))return null;
  const parsed=stageContextSchema.safeParse(value);
  if(!parsed.success)throw new NativeProviderStateIncompatibleError("native_stage_review_context_incompatible");
  return parsed.data;
}
/** Recovery derives fresh authority from the current server-owned ledger and
 * committer, then reuses every normal-stage guard. It never copies authority
 * from a failed run, generic stage hints or caller-supplied recovery text. */
export async function getNativeStageReviewRecoveryContext(db:Db,input:{companyId:string;issueId:string;agentId:string;boardRetryRequestId?:string}) {
  const [issue]=await db.select().from(issues).where(and(eq(issues.companyId,input.companyId),eq(issues.id,input.issueId)));
  const [ledger]=await db.select().from(issueReviewCycleBudgets).where(and(eq(issueReviewCycleBudgets.companyId,input.companyId),eq(issueReviewCycleBudgets.issueId,input.issueId)));
  const admission=ledger?issueReviewCycleBudgetSchema.parse(ledger.ledger).admissions.at(-1):null;
  if(!issue || !admission || admission.kind!=="normal")return null;
  const [coordinator]=await db.select().from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.companyId,input.companyId),eq(nativeRunFinalizations.issueId,input.issueId),eq(nativeRunFinalizations.runId,admission.builderRunId)));
  if(!coordinator?.decisionId)return null;
  const context={nativeStageDecisionId:coordinator.decisionId,nativeStageAdmissionId:admission.id,nativeStageStatusVersion:issue.statusVersion};
  const ordinary=await getNativeStageReviewAssignment(db,{...input,contextSnapshot:context});
  if (ordinary) return { ...context, nativeStatusWakeIntentId: ordinary.wake.id,
    executionStage: ordinary.wake.payload?.executionStage, forceFreshSession: true };
  if (!input.boardRetryRequestId) return null;
  const rebound = { ...context, nativeStageRetryRequestId: input.boardRetryRequestId };
  const proof = await readStageAssignment(db, {...input,contextSnapshot:rebound}, input.boardRetryRequestId);
  if (!proof?.retry || !proof.retryConfigDigest) return null;
  return {...rebound,nativeStatusWakeIntentId:proof.wake.id,executionStage:proof.wake.payload?.executionStage,
    nativeStageRetryConfigDigest:proof.retryConfigDigest,verifiedRetryPredecessorId:proof.retry.sourceRunId,forceFreshSession:true};
}

/** A discovery predicate, never admission authority. Revalidate the receipt
 * and the current stage under the issue lock before using it. */
export const deferredNativeStageReviewDispatchSql = and(
  isNull(agentWakeupRequests.runId),
  eq(agentWakeupRequests.reason, "issue_execution_deferred"),
  eq(agentWakeupRequests.requestedByActorType, "system"),
  sql`${agentWakeupRequests.payload} #>> '{_paperclipWakeContext,wakeReason}' = 'execution_review_requested'`,
  sql`${agentWakeupRequests.requestedByActorId} = 'native-status-wake-dispatch:' ||
    (${agentWakeupRequests.payload} #>> '{_paperclipWakeContext,nativeStatusWakeIntentId}')`,
);

export async function readDeferredNativeStageReviewDispatch(db: Db, input: {
  companyId: string; issueId: string; wakeId: string;
}) {
  const [dispatch] = await db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.id, input.wakeId),
    eq(agentWakeupRequests.status, "deferred_issue_execution"), deferredNativeStageReviewDispatchSql,
    sql`${agentWakeupRequests.payload}->>'issueId' = ${input.issueId}`,
  )).for("update");
  if (!dispatch) return null;
  const context = dispatch.payload?._paperclipWakeContext;
  const stage = stageContextSchema.safeParse(context);
  if (!stage.success || !stage.data.nativeStatusWakeIntentId || !stageWakeTupleMatches(dispatch, stage.data)) return null;
  const proof = await getNativeStageReviewAssignment(db, { ...input, agentId: dispatch.agentId, contextSnapshot: context });
  if (!proof || proof.wake.reason !== "execution_review_requested" || proof.wake.status !== "coalesced" ||
    proof.wake.runId || proof.wake.idempotencyKey !== dispatch.idempotencyKey) return null;
  const [other] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.agentId, dispatch.agentId),
    eq(agentWakeupRequests.requestedByActorType, "system"),
    eq(agentWakeupRequests.requestedByActorId, `native-status-wake-dispatch:${proof.wake.id}`),
    ne(agentWakeupRequests.id, dispatch.id),
  )).limit(1);
  if (other) return null;
  return { dispatch, ...proof };
}

export function nativeStageAssignmentRecord(proof: NonNullable<Awaited<ReturnType<typeof getNativeStageReviewAssignment>>>) {
  return {kind:"execution_stage_review" as const,stageId:proof.stage.id,admissionId:proof.admission.id,
    sourceDecisionId:proof.sourceDecision.id,sourceRunId:proof.sourceRun.id,builderAgentId:proof.sourceRun.agentId,
    statusVersion:proof.issue.statusVersion,workspaceBindingRevision:proof.issue.workspaceBindingRevision,
    policySha256:proof.policySha256,executionSha256:proof.executionSha256};
}

type HistoricalStageDecisionInput = {
  companyId: string; issueId: string; agentId: string; runId: string;
  request?: import("./native-stage-review-decision.js").NativeStageReviewDecisionRequest;
};

async function isLaterBuilderPreserveProjection(
  db: Db,
  original: typeof statusDecisions.$inferSelect,
  result: typeof nativeRunResults.$inferSelect,
  coordinator: typeof nativeRunFinalizations.$inferSelect,
) {
  if (coordinator.phase !== "committed" || !coordinator.decisionId || !coordinator.assessmentId
    || coordinator.companyId !== original.companyId || coordinator.issueId !== original.issueId) return false;
  const [later] = await db.select().from(statusDecisions).where(and(
    eq(statusDecisions.id, coordinator.decisionId),
    eq(statusDecisions.companyId, original.companyId),
    eq(statusDecisions.issueId, original.issueId),
    eq(statusDecisions.runId, original.runId),
    eq(statusDecisions.assessmentId, coordinator.assessmentId),
  ));
  if (!later || later.applicationState !== "applied" || later.decisionVersion <= original.decisionVersion
    || later.fromStatus !== later.toStatus || later.reasonCode !== "prior_status_terminal_preserved") return false;
  const decision = later.decisionJson;
  if (decision.statusAction !== "preserve" || decision.toStatus !== later.toStatus
    || decision.reasonCode !== later.reasonCode || decision.unblockDescriptor !== null
    || nativeSha256(decision.effects) !== nativeSha256([{ kind: "append_superseding_assessment" }])) return false;

  // Reassessment can advance the coordinator while keeping the accepted
  // result. Follow only assessments of that exact result and contract.
  const assessments = await db.select({
    id: workAssessments.id,
    supersedes: workAssessments.supersedesAssessmentId,
  }).from(workAssessments).where(and(
    eq(workAssessments.companyId, original.companyId),
    eq(workAssessments.issueId, original.issueId),
    eq(workAssessments.runId, original.runId),
    eq(workAssessments.resultId, result.id),
    eq(workAssessments.contractId, result.completionContractId),
  ));
  const lineage = new Map(assessments.map(({ id, supersedes }) => [id, supersedes]));
  let next: string | null = later.assessmentId;
  while (next && lineage.has(next)) {
    if (next === original.assessmentId) return true;
    const previous: string | null = lineage.get(next) ?? null;
    lineage.delete(next);
    next = previous;
  }
  return false;
}

/** Exact historical acknowledgement only. Never a grant for new provider work,
 * PR discussion or credentials. The native activity receipt commits atomically
 * with its decision and binds the complete original request and assignment. */
export function historicalNativeStageDecision(db: Db, input: HistoricalStageDecisionInput) {
  return readHistoricalNativeStageDecision(db, input, false);
}

async function readHistoricalNativeStageDecision(
  db: Db, input: HistoricalStageDecisionInput, allowBuilderPreserveForFinalization: boolean,
) {
  const [run]=await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id,input.runId),eq(heartbeatRuns.companyId,input.companyId),eq(heartbeatRuns.agentId,input.agentId),eq(heartbeatRuns.nativeIssueId,input.issueId)));
  const context=readNativeStageReviewContext(run?.contextSnapshot);
  if(!run || run.runtimeMode!=="native" || !context)return null;
  const decisions=await db.select().from(issueExecutionDecisions).where(and(eq(issueExecutionDecisions.companyId,input.companyId),eq(issueExecutionDecisions.issueId,input.issueId),eq(issueExecutionDecisions.actorAgentId,input.agentId),eq(issueExecutionDecisions.createdByRunId,input.runId),...(input.request?[eq(issueExecutionDecisions.id,input.request.id)]:[]))).limit(2);
  if(decisions.length!==1)return null;
  const decision=decisions[0]!;
  const activities=await db.select({details:activityLog.details}).from(activityLog).where(and(eq(activityLog.companyId,input.companyId),eq(activityLog.entityId,input.issueId),eq(activityLog.action,"issue.execution_stage_decided"),eq(activityLog.agentId,input.agentId),eq(activityLog.runId,input.runId)));
  const receipts=activities.map(row=>row.details?.stageDecisionReceipt as {request?:import("./native-stage-review-decision.js").NativeStageReviewDecisionRequest;assignment?:ReturnType<typeof nativeStageAssignmentRecord>}|undefined)
    .filter(receipt=>receipt?.request?.id===decision.id);
  if(receipts.length!==1)return null;
  const receipt=receipts[0]!,request=receipt.request!,record=receipt.assignment;
  if(!record || record.kind!=="execution_stage_review" || request.stageId!==decision.stageId || request.outcome!==decision.outcome || request.body!==decision.body
    || record.stageId!==decision.stageId || record.admissionId!==request.admissionId || record.sourceDecisionId!==request.sourceDecisionId
    || record.statusVersion!==request.expectedStatusVersion || context.nativeStageDecisionId!==record.sourceDecisionId
    || context.nativeStageAdmissionId!==record.admissionId || context.nativeStageStatusVersion!==record.statusVersion
    || input.request && nativeSha256(request)!==nativeSha256(input.request))return null;
  const [ledger]=await db.select().from(issueReviewCycleBudgets).where(and(eq(issueReviewCycleBudgets.companyId,input.companyId),eq(issueReviewCycleBudgets.issueId,input.issueId)));
  const admission=ledger?issueReviewCycleBudgetSchema.parse(ledger.ledger).admissions.find(row=>row.id===record.admissionId):null;
  if(!admission || admission.kind!=="normal" || admission.builderRunId!==record.sourceRunId || admission.builderAgentId!==record.builderAgentId || record.builderAgentId===input.agentId)return null;
  const [sourceRun]=await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id,record.sourceRunId),eq(heartbeatRuns.companyId,input.companyId),eq(heartbeatRuns.agentId,record.builderAgentId),eq(heartbeatRuns.nativeIssueId,input.issueId)));
  const [sourceDecision]=await db.select().from(statusDecisions).where(and(eq(statusDecisions.id,record.sourceDecisionId),eq(statusDecisions.companyId,input.companyId),eq(statusDecisions.issueId,input.issueId),eq(statusDecisions.runId,record.sourceRunId)));
  const [result]=await db.select().from(nativeRunResults).where(and(eq(nativeRunResults.id,record.admissionId),eq(nativeRunResults.companyId,input.companyId),eq(nativeRunResults.issueId,input.issueId),eq(nativeRunResults.runId,record.sourceRunId)));
  const [coordinator]=await db.select().from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.runId,record.sourceRunId),eq(nativeRunFinalizations.companyId,input.companyId),eq(nativeRunFinalizations.issueId,input.issueId)));
  if(!sourceRun || sourceRun.runtimeMode!=="native" || !sourceDecision || sourceDecision.applicationState!=="applied" || !result || result.schemaStatus!=="accepted"
    || result.completionContractId!==sourceRun.completionContractId || admission.candidateId!==`native-result:${result.id}:${result.canonicalSha256}`
    || coordinator?.resultId!==result.id) return null;
  const retry = context.nativeStageRetryRequestId ? await readStageRetryReceipt(db, input, {
    requestId: context.nativeStageRetryRequestId, runId: run.id, historical: true,
  }) : null;
  const lineage = retry ? await readStageRetryLineage(db, sourceDecision, result) : null;
  if (context.nativeStageRetryRequestId && (!lineage || sourceDecision.decisionJson.projectedStatusVersion !== record.statusVersion ||
      retry?.receipt.payload?.nativeStageRetryConfigDigest !== context.nativeStageRetryConfigDigest)) return null;
  const wakeDecisionId = lineage?.original.id ?? record.sourceDecisionId;
  const wake=await nativeStageWakeIntent(db,{...input,decisionId:wakeDecisionId,stageId:record.stageId,intentId:context.nativeStatusWakeIntentId});
  const captured=(wake?.payload as {executionStage?:{policySha256?:unknown;workspaceBindingRevision?:unknown}}|null)?.executionStage;
  if (!wake || !stageWakeTupleMatches(wake,{nativeStageDecisionId:wakeDecisionId,nativeStageAdmissionId:record.admissionId,
      nativeStageStatusVersion:lineage?.wakeVersion ?? record.statusVersion}) || captured?.policySha256!==record.policySha256 ||
      captured.workspaceBindingRevision!==record.workspaceBindingRevision) return null;
  let execution;try{execution=parseNativeExecutionInput(sourceRun.runnerProfileJson?.nativeExecutionInput);}catch{return null;}
  if(nativeSha256(execution)!==record.executionSha256)return null;
  if (coordinator.decisionId !== sourceDecision.id && (!allowBuilderPreserveForFinalization
    || !await isLaterBuilderPreserveProjection(db, sourceDecision, result, coordinator))) return null;
  return {decision,request,record,sourceRun,sourceDecision,sourceWakeId:wake.id};
}

/** A terminal provider report cannot act as its own stage verdict. */
export async function nativeStageReviewOutcome(db:Db,input:{companyId:string;issueId:string;agentId:string;runId:string;contextSnapshot:unknown}):Promise<"pending"|"resolved"|"stale"|null> {
  const context=readNativeStageReviewContext(input.contextSnapshot);if(!context)return null;
  if(await getNativeStageReviewAssignment(db,input))return "pending";
  const receipt=await readHistoricalNativeStageDecision(db,input,true);
  return receipt && receipt.record.sourceDecisionId===context.nativeStageDecisionId
    && receipt.record.admissionId===context.nativeStageAdmissionId
    && receipt.record.statusVersion===context.nativeStageStatusVersion
    && (context.nativeStatusWakeIntentId===undefined || context.nativeStatusWakeIntentId===receipt.sourceWakeId)
    ? "resolved" : "stale";
}

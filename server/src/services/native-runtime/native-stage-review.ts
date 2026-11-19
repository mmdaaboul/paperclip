import { NativeProviderStateIncompatibleError } from "../../vendor/paperclip-runner/index.js";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { activityLog, issueExecutionDecisions, agents, agentWakeupRequests, heartbeatRuns, issues, issueReviewCycleBudgets, nativeRunResults, nativeRunFinalizations, statusDecisions, executionWorkspaces, type Db } from "@paperclipai/db";
import { issueReviewCycleBudgetSchema } from "@paperclipai/shared";
import { normalizeIssueExecutionPolicy, parseIssueExecutionState } from "../issue-execution-policy.js";
import { parseNativeExecutionInput } from "../../vendor/paperclip-runner/index.js";
import { nativeSha256 } from "./canonical.js";

/** DB-derived normal-stage assignment. Hints alone never grant a review: the
 * latest task ledger, committed native result/decision and durable stage wake
 * must all name the same candidate, selected independent Reviewer and version.
 */
export async function getNativeStageReviewAssignment(db:Db,input:{companyId:string;issueId:string;agentId:string;runId?:string;contextSnapshot:unknown}) {
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
  const [wake]=await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId,input.companyId),eq(agentWakeupRequests.agentId,input.agentId),eq(agentWakeupRequests.idempotencyKey,`native-execution-stage:${sourceDecision.id}:${stage.id}`)));
  if(!wake || ["cancelled","skipped","failed"].includes(wake.status)) return null;
  const capturedStage=(wake.payload as {executionStage?:{policySha256?:unknown;workspaceBindingRevision?:unknown;executionWorkspaceId?:unknown}}|null)?.executionStage;
  if(capturedStage?.policySha256!==nativeSha256(policy) || capturedStage.workspaceBindingRevision!==issue.workspaceBindingRevision || capturedStage.executionWorkspaceId!==issue.executionWorkspaceId) return null;
  let execution;try {execution=parseNativeExecutionInput(sourceRun.runnerProfileJson?.nativeExecutionInput);}catch{return null;}
  if(execution.binding.companyId!==input.companyId || execution.binding.agentId!==admission.builderAgentId || execution.binding.runId!==sourceRun.id || execution.binding.issueId!==input.issueId || !issue.executionWorkspaceId) return null;
  const [workspace]=await db.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.id,issue.executionWorkspaceId),eq(executionWorkspaces.companyId,input.companyId)));
  if(!workspace || workspace.cwd!==execution.workspace.cwd || workspace.id!==execution.binding.executionWorkspaceId) return null;
  const [agent]=await db.select().from(agents).where(and(eq(agents.id,input.agentId),eq(agents.companyId,input.companyId)));
  if(!agent || agent.adapterType!=="paperclip_runner" || ["paused","terminated"].includes(agent.status)) return null;
  let actingRun:typeof heartbeatRuns.$inferSelect|undefined;
  if(input.runId) {
    [actingRun]=await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id,input.runId),eq(heartbeatRuns.companyId,input.companyId),eq(heartbeatRuns.agentId,input.agentId),eq(heartbeatRuns.nativeIssueId,input.issueId)));
    const actual=actingRun?.contextSnapshot as Record<string,unknown>|null;
    if(!actingRun || actingRun.status!=="running" || actingRun.runtimeMode!=="native" || issue.executionRunId!==actingRun.id || actual?.nativeStageDecisionId!==sourceDecision.id || actual.nativeStageAdmissionId!==admission.id || actual.nativeStageStatusVersion!==issue.statusVersion) return null;
  }
  return {issue,policy,state,stage,admission,sourceRun,sourceDecision,result,execution,workspace,wake,actingRun,
    policySha256:nativeSha256(policy),executionSha256:nativeSha256(execution)};
}

const stageContextSchema=z.object({nativeStageDecisionId:z.string().guid(),nativeStageAdmissionId:z.string().guid(),nativeStageStatusVersion:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)});
export function readNativeStageReviewContext(value:unknown) {
  if(!value || typeof value!=="object" || Array.isArray(value))return null;
  if(!["nativeStageDecisionId","nativeStageAdmissionId","nativeStageStatusVersion"].some(key=>Object.hasOwn(value,key)))return null;
  const parsed=stageContextSchema.safeParse(value);
  if(!parsed.success)throw new NativeProviderStateIncompatibleError("native_stage_review_context_incompatible");
  return parsed.data;
}
export function nativeStageAssignmentRecord(proof: NonNullable<Awaited<ReturnType<typeof getNativeStageReviewAssignment>>>) {
  return {kind:"execution_stage_review" as const,stageId:proof.stage.id,admissionId:proof.admission.id,
    sourceDecisionId:proof.sourceDecision.id,sourceRunId:proof.sourceRun.id,builderAgentId:proof.sourceRun.agentId,
    statusVersion:proof.issue.statusVersion,workspaceBindingRevision:proof.issue.workspaceBindingRevision,
    policySha256:proof.policySha256,executionSha256:proof.executionSha256};
}

/** Exact historical acknowledgement only. Never a grant for new provider work,
 * PR discussion or credentials. The native activity receipt commits atomically
 * with its decision and binds the complete original request and assignment. */
export async function historicalNativeStageDecision(db:Db,input:{companyId:string;issueId:string;agentId:string;runId:string;
  request?:import("./native-stage-review-decision.js").NativeStageReviewDecisionRequest}) {
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
  const [wake]=await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId,input.companyId),eq(agentWakeupRequests.agentId,input.agentId),eq(agentWakeupRequests.idempotencyKey,`native-execution-stage:${record.sourceDecisionId}:${record.stageId}`)));
  const captured=(wake?.payload as {executionStage?:{policySha256?:unknown;workspaceBindingRevision?:unknown}}|null)?.executionStage;
  if(!sourceRun || sourceRun.runtimeMode!=="native" || !sourceDecision || sourceDecision.applicationState!=="applied" || !result || result.schemaStatus!=="accepted"
    || result.completionContractId!==sourceRun.completionContractId || admission.candidateId!==`native-result:${result.id}:${result.canonicalSha256}`
    || coordinator?.resultId!==result.id || coordinator.decisionId!==sourceDecision.id || captured?.policySha256!==record.policySha256 || captured.workspaceBindingRevision!==record.workspaceBindingRevision)return null;
  let execution;try{execution=parseNativeExecutionInput(sourceRun.runnerProfileJson?.nativeExecutionInput);}catch{return null;}
  if(nativeSha256(execution)!==record.executionSha256)return null;
  return {decision,request,record,sourceRun,sourceDecision};
}

/** A terminal provider report cannot act as its own stage verdict. */
export async function nativeStageReviewOutcome(db:Db,input:{companyId:string;issueId:string;agentId:string;runId:string;contextSnapshot:unknown}):Promise<"pending"|"resolved"|"stale"|null> {
  const context=readNativeStageReviewContext(input.contextSnapshot);if(!context)return null;
  if(await getNativeStageReviewAssignment(db,input))return "pending";
  const receipt=await historicalNativeStageDecision(db,input);
  return receipt && receipt.record.sourceDecisionId===context.nativeStageDecisionId && receipt.record.admissionId===context.nativeStageAdmissionId && receipt.record.statusVersion===context.nativeStageStatusVersion?"resolved":"stale";
}

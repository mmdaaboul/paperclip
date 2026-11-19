import { nativeStageReviewOutcome, readNativeStageReviewContext } from "./native-stage-review.js";
import { and, eq } from "drizzle-orm";
import { heartbeatRuns, issues, nativeRunFinalizations, nativeRunResults, workAssessments, type Db } from "@paperclipai/db";
import { conflict } from "../../errors.js";
import { applyIssueExecutionPolicyTransition, normalizeIssueExecutionPolicy, parseIssueExecutionState, type TransitionInput } from "../issue-execution-policy.js";
import { readReviewBudgetPreviewContext } from "../review-cycle-budget-store.js";
import type { NativeStatusDecision } from "./status-arbiter.js";

/** Read-only admission plan. Native coordinator/result acceptance remains the
 * execution authority; an execution-stage Reviewer finish is not a verdict.
 * Caller must recompute the same transition under task->ledger locks.
 */
export async function previewNativeReviewCycleBudget(db: Db, input: {
  companyId: string; issueId: string; runId: string; assessmentId: string; decision: NativeStatusDecision;
}) {
  const [issue] = await db.select().from(issues).where(and(eq(issues.id,input.issueId),eq(issues.companyId,input.companyId)));
  const policy=normalizeIssueExecutionPolicy(issue?.executionPolicy);
  if(!issue || policy?.totalReviewCycles!==5) return null;
  const [reportedRun]=await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id,input.runId),eq(heartbeatRuns.companyId,input.companyId)));
  if(readNativeStageReviewContext(reportedRun?.contextSnapshot)) {
    const outcome=reportedRun?await nativeStageReviewOutcome(db,{...input,agentId:reportedRun.agentId,contextSnapshot:reportedRun.contextSnapshot}):"stale";
    if(outcome==="stale") throw conflict("The native stage review receipt is no longer authoritative");
    // A review report cannot become another Builder candidate or override its
    // dedicated stage verdict. Native finalizer supplies preserve semantics.
    if(input.decision.statusAction!=="preserve") throw conflict("A native stage review report must preserve the recorded stage outcome");
    return null;
  }
  if(issue.conversationAgentId) throw conflict("Persistent conversations cannot use whole-task review-cycle accounting",{code:"total_review_conversation_incompatible"});
  if(input.decision.effects.some(effect=>effect.kind==="bind_reviewer")) throw conflict(
    "Native completion-review attention and the selected execution-stage budget require an explicit shared-owner adapter", {code:"total_review_native_attention_conflict"});
  const state=parseIssueExecutionState(issue.executionState);
  const startsCandidate=input.decision.statusAction==="done" && state?.status!=="pending" && state?.status!=="completed";
  const transition: TransitionInput={issue,policy,previousPolicy:policy,requestedAssigneePatch:{},actor:{},
    ...await readReviewBudgetPreviewContext(db,input),reviewCycleNow:new Date().toISOString(),
    // A terminal report from a stage Reviewer cannot silently approve its stage.
    requestedStatus: state?.status==="pending" ? undefined : input.decision.statusAction==="preserve" ? undefined : input.decision.toStatus};
  if(startsCandidate) {
    const [bound]=await db.select({run:heartbeatRuns,result:nativeRunResults,assessment:workAssessments,coordinator:nativeRunFinalizations})
      .from(nativeRunFinalizations).innerJoin(heartbeatRuns,and(eq(heartbeatRuns.id,nativeRunFinalizations.runId),eq(heartbeatRuns.companyId,nativeRunFinalizations.companyId)))
      .innerJoin(nativeRunResults,and(eq(nativeRunResults.id,nativeRunFinalizations.resultId),eq(nativeRunResults.runId,heartbeatRuns.id)))
      .innerJoin(workAssessments,and(eq(workAssessments.id,input.assessmentId),eq(workAssessments.runId,heartbeatRuns.id),eq(workAssessments.resultId,nativeRunResults.id)))
      .where(and(eq(nativeRunFinalizations.runId,input.runId),eq(nativeRunFinalizations.companyId,input.companyId),eq(nativeRunFinalizations.issueId,input.issueId)));
    if(!bound || bound.run.runtimeMode!=="native" || bound.run.nativeIssueId!==issue.id || bound.run.agentId!==issue.assigneeAgentId
      || bound.result.companyId!==issue.companyId || bound.result.issueId!==issue.id || bound.result.schemaStatus!=="accepted"
      || !bound.result.canonicalSha256 || bound.result.completionContractId!==bound.run.completionContractId
      || bound.assessment.companyId!==issue.companyId || bound.assessment.issueId!==issue.id || bound.assessment.contractId!==bound.run.completionContractId
      || bound.assessment.priorStatusVersion!==issue.statusVersion || bound.assessment.priorIssueStatus!==issue.status
      || bound.assessment.priorDecisionId!==issue.lastStatusDecisionId) {
      throw conflict("Native review submission lacks its accepted bound Builder result and assessment",{code:"total_review_native_receipt_invalid"});
    }
    transition.actor={agentId:bound.run.agentId,runId:bound.run.id};
    transition.reviewCycleAdmission={id:bound.result.id,companyId:issue.companyId,issueId:issue.id,
      builderAgentId:bound.run.agentId,builderRunId:bound.run.id,candidateId:`native-result:${bound.result.id}:${bound.result.canonicalSha256}`,kind:"normal",scopeId:null};
  }
  const preview=applyIssueExecutionPolicyTransition(transition);
  const projectedStatus=typeof preview.patch.status==="string" ? preview.patch.status : state?.status==="pending" && input.decision.statusAction==="done" ? "in_review" : input.decision.toStatus;
  const decision: NativeStatusDecision=projectedStatus!==input.decision.toStatus ? {
    ...input.decision,statusAction:projectedStatus as NativeStatusDecision["toStatus"],toStatus:projectedStatus as NativeStatusDecision["toStatus"],
    reasonCode:"task_total_review_pending",effects:input.decision.effects,
  }:input.decision;
  return {transition,preview,decision,issue};
}

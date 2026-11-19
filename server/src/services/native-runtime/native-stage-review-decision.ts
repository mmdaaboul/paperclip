import { and, eq } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, issueExecutionDecisions, issues, type Db } from "@paperclipai/db";
import { nativeStageReviewDecisionSchema, type NativeStageReviewDecisionRequest } from "@paperclipai/shared";
export { nativeStageReviewDecisionSchema, type NativeStageReviewDecisionRequest } from "@paperclipai/shared";
import { conflict, forbidden, notFound } from "../../errors.js";
import { assertAgentRunWriteAllowed } from "../../agent-run-cancellation.js";
import { authorizationService, authorizationDeniedDetails, type AuthorizationActor } from "../authorization.js";
import { nativeRunKeyScope } from "./native-skill-test-scope.js";
import { getNativeStageReviewAssignment, historicalNativeStageDecision, nativeStageAssignmentRecord } from "./native-stage-review.js";
import { applyIssueExecutionPolicyTransition, type TransitionInput } from "../issue-execution-policy.js";
import { applyLockedReviewBudgetTransition, readReviewBudgetPreviewContext } from "../review-cycle-budget-store.js";
import { issueService } from "../issues.js";
import { persistActivity, publishActivity, type ActivityPublication } from "../activity-log.js";

/** Narrow owner for a selected native execution-stage Reviewer. This operation
 * never accepts arbitrary issue patches, assignments, comments or policy edits.
 */
export async function decideNativeStageReview(db:Db,input:{companyId:string;issueId:string;agentId:string;runId:string;request:NativeStageReviewDecisionRequest;actor?:AuthorizationActor}) {
  const request=nativeStageReviewDecisionSchema.parse(input.request),publications:ActivityPublication[]=[];
  async function authorize(connection:Db,run:typeof heartbeatRuns.$inferSelect) {
    const actor=input.actor??{type:"agent" as const,agentId:input.agentId,runId:input.runId,companyId:input.companyId,source:"agent_jwt" as const,onBehalfOfUserId:run.responsibleUserId,keyScope:nativeRunKeyScope({...input,contextSnapshot:run.contextSnapshot})};
    if(actor.type!=="agent" || actor.agentId!==input.agentId || actor.runId!==input.runId || actor.companyId!==input.companyId)throw forbidden("Stage actor identity does not match the native run");
    const authorization=await authorizationService(connection).decide({actor,action:"issue:resolve_assigned_stage_review",resource:{type:"issue",companyId:input.companyId,issueId:input.issueId},scope:{stageDecisionRequest:request}});
    if(!authorization.allowed)throw forbidden(authorization.explanation,authorizationDeniedDetails(authorization));
  }
  async function proof(connection:Db) {
    const [run]=await connection.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id,input.runId),eq(heartbeatRuns.companyId,input.companyId),eq(heartbeatRuns.agentId,input.agentId)));
    const assignment=run?await getNativeStageReviewAssignment(connection,{...input,contextSnapshot:run.contextSnapshot}):null;
    if(!assignment || assignment.stage.id!==request.stageId || assignment.admission.id!==request.admissionId || assignment.sourceDecision.id!==request.sourceDecisionId || assignment.issue.statusVersion!==request.expectedStatusVersion)
      throw forbidden("No current native stage assignment authorizes this review decision");
    await authorize(connection,run!);
    return assignment;
  }
  const replay=async(connection:Db)=>{
    const [saved]=await connection.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.id,request.id));
    if(!saved) return null;
    if(saved.companyId!==input.companyId || saved.issueId!==input.issueId || saved.actorAgentId!==input.agentId || saved.createdByRunId!==input.runId || saved.stageId!==request.stageId || saved.outcome!==request.outcome || saved.body!==request.body)
      throw conflict("Review decision ID was reused with different content");
    const receipt=await historicalNativeStageDecision(connection,{...input,request});
    if(!receipt)throw conflict("Historical stage decision lacks its exact immutable source/request receipt",{code:"native_stage_review_receipt_unavailable"});
    const [run]=await connection.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id,input.runId),eq(heartbeatRuns.companyId,input.companyId),eq(heartbeatRuns.agentId,input.agentId)));
    if(!run)throw forbidden("The original stage run is unavailable");
    await authorize(connection,run);
    return saved;
  };
  // Replays return immutable native decision history without granting a new
  // provider turn or retargeting a changed task.
  const prior=await replay(db);if(prior) return {decision:prior,replayed:true};
  const observed=await proof(db),now=new Date().toISOString();
  const transition:TransitionInput={issue:observed.issue,policy:observed.policy,previousPolicy:observed.policy,requestedStatus:request.outcome==="approved"?"done":"in_progress",requestedAssigneePatch:{},
    actor:{agentId:input.agentId,runId:input.runId},commentBody:request.body,...await readReviewBudgetPreviewContext(db,input),reviewCycleNow:now};
  const expected=applyIssueExecutionPolicyTransition(transition);
  if(!expected.decision || expected.decision.outcome!==request.outcome) throw conflict("The selected native review stage did not produce this decision");
  const result=await db.transaction(async tx=>{
    const [task]=await tx.select().from(issues).where(and(eq(issues.id,input.issueId),eq(issues.companyId,input.companyId))).for("update");
    if(!task) throw notFound("Task not found");
    const duplicated=await replay(tx as unknown as Db);if(duplicated) return {decision:duplicated,replayed:true};
    await assertAgentRunWriteAllowed(tx as unknown as Db,input.companyId,input);
    await proof(tx as unknown as Db);
    let decision:typeof issueExecutionDecisions.$inferSelect|undefined;
    await applyLockedReviewBudgetTransition(tx,{companyId:input.companyId,issueId:input.issueId,transition,expectedPreview:expected,expectedStoredPolicy:observed.policy},async(_owner,_issue,outcome)=>{
      if(!outcome.decision) throw conflict("Native stage decision disappeared during commit");
      const state=outcome.patch.executionState as Record<string,unknown>|undefined;if(!state) throw conflict("Native stage decision has no state projection");
      const updated=await issueService(tx as unknown as Db).update(input.issueId,{...outcome.patch,executionState:{...state,lastDecisionId:request.id},actorAgentId:input.agentId,actorRunId:input.runId,companyGuard:input.companyId},tx,publications);
      if(!updated) throw notFound("Task not found");
      await tx.update(issues).set({executionRunId:task.executionRunId,executionAgentNameKey:task.executionAgentNameKey,executionLockedAt:task.executionLockedAt}).where(eq(issues.id,task.id));
      [decision]=await tx.insert(issueExecutionDecisions).values({id:request.id,companyId:input.companyId,issueId:input.issueId,stageId:outcome.decision.stageId,stageType:outcome.decision.stageType,
        actorAgentId:input.agentId,createdByRunId:input.runId,outcome:outcome.decision.outcome,body:outcome.decision.body}).returning();
      if(updated.assigneeAgentId && updated.assigneeAgentId!==input.agentId && updated.status!=="done") await tx.insert(agentWakeupRequests).values({companyId:input.companyId,agentId:updated.assigneeAgentId,
        source:"automation",triggerDetail:"system",reason:"execution_review_decided",idempotencyKey:`native-stage-decision:${request.id}`,requestedByActorType:"system",requestedByActorId:"native-status-committer",
        payload:{issueId:input.issueId,taskId:input.issueId,_paperclipWakeContext:{issueId:input.issueId,taskId:input.issueId,forceFreshSession:true,executionStageDecisionId:request.id},paperclipAgentMessage:`Independent review requested changes: ${request.body}. Complete corrections, then submit for fresh configured review. Shared task budget/history is preserved.`}});
      const {publication}=await persistActivity(tx as unknown as Db,{companyId:input.companyId,actorType:"agent",actorId:input.agentId,agentId:input.agentId,runId:input.runId,action:"issue.execution_stage_decided",entityType:"issue",entityId:input.issueId,issueId:input.issueId,
        details:{decisionId:request.id,stageId:request.stageId,admissionId:request.admissionId,sourceDecisionId:request.sourceDecisionId,outcome:request.outcome,budgetRefunded:false,stageDecisionReceipt:{request,assignment:nativeStageAssignmentRecord(observed)}}});publications.push(publication);
    });
    return {decision:decision!,replayed:false};
  });publications.forEach(publishActivity);return result;
}

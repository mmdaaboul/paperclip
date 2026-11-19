import { and, eq, or, sql } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, issues, issueScopedReviews, issueThreadInteractions, type Db } from "@paperclipai/db";
import { reviewCycleBudgetAvailable, scopedReviewSnapshotSchema, type ScopedReviewSnapshot } from "@paperclipai/shared";
import { conflict, forbidden, notFound } from "../errors.js";
import { withLockedScopedReviewBudget } from "./review-cycle-budget-store.js";
import { assertCurrentScopedArtifact } from "./scoped-reviews.js";
import { normalizeIssueExecutionPolicy, parseIssueExecutionState } from "./issue-execution-policy.js";
import { issueService } from "./issues.js";
import { persistActivity, type ActivityPublication } from "./activity-log.js";

export function isScopedReviewInteraction(row:{kind:string;payload:unknown}) {
  const payload=row.payload as {target?:{type?:string;key?:string}}|null;
  return row.kind==="request_confirmation" && payload?.target?.type==="custom" && payload.target.key==="scoped_review";
}

/** Runs inside the native interaction resolution transaction, after its
 * standard authorization/Stop checks. No partial outcome completes the task.
 */
export async function resolveScopedReviewInTransaction(input:{db:Db;tx:Db;companyId:string;issueId:string;interactionId:string;
  actor:{agentId?:string|null;runId?:string|null;userId?:string|null};outcome:"passed"|"changes_requested";reason:string;
  publications:ActivityPublication[]}) {
  if(!input.actor.agentId || !input.actor.runId || input.actor.userId) throw forbidden("Only the assigned native independent Reviewer may decide this scope");
  const actorAgentId=input.actor.agentId,actorRunId=input.actor.runId;
  const [scope]=await input.tx.select().from(issueScopedReviews).where(and(eq(issueScopedReviews.companyId,input.companyId),eq(issueScopedReviews.issueId,input.issueId),eq(issueScopedReviews.interactionId,input.interactionId)));
  if(!scope) throw notFound("Scoped review not found");
  const snapshot=scopedReviewSnapshotSchema.parse(scope.snapshot);
  return withLockedScopedReviewBudget(input.tx,{companyId:input.companyId,issueId:input.issueId,scopeId:scope.id,expectedSnapshot:snapshot,now:new Date().toISOString(),
    operation:{kind:"resolve",reviewerAgentId:actorAgentId,reviewerRunId:actorRunId}},async context=>{
      await assertCurrentScopedArtifact(input.tx,snapshot,true);
      const [current]=await input.tx.select().from(issues).where(and(eq(issues.id,input.issueId),eq(issues.companyId,input.companyId)));
      if(!current || current.executionRunId!==actorRunId || current.executionWorkspaceId!==snapshot.executionWorkspaceId || current.assigneeAgentId!==snapshot.builderAgentId || current.assigneeUserId)
        throw conflict("This Reviewer no longer owns the scoped execution lock");
      const [interaction]=await input.tx.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id,input.interactionId));
      if(!interaction || interaction.status!==(input.outcome==="passed"?"accepted":"rejected") || interaction.resolvedByAgentId!==actorAgentId || interaction.resolvedByRunId!==actorRunId)
        throw conflict("Scoped outcome must match the native authenticated interaction decision");
      const policy=normalizeIssueExecutionPolicy(current.executionPolicy)!;
      const finalStage=policy.stages.at(-1),human=finalStage?.type==="approval"?finalStage.participants.find(p=>p.type==="user")?.userId:null;
      if(!human) throw conflict("The scope has no configured final human");
      const exhausted=reviewCycleBudgetAvailable(context.budget)===0;
      const previous=parseIssueExecutionState(current.executionState);
      const state={...(previous??{status:"idle",currentStageId:null,currentStageIndex:null,currentStageType:null,currentParticipant:null,
        returnAssignee:{type:"agent",agentId:snapshot.builderAgentId,userId:null},completedStageIds:[],lastDecisionId:null,lastDecisionOutcome:null,reviewRequest:null,changesRequestedCount:0}),
        totalReviewCyclesUsed:context.budget.admissions.length,totalReviewCycleAllowance:context.budget.initialAllowance+context.budget.allowances.reduce((n,a)=>n+a.additionalCycles,0)};
      const executionState=exhausted?{...state,status:"changes_requested",totalReviewBudgetHold:true,currentStageId:null,currentStageIndex:null,currentStageType:null,
        currentParticipant:{type:"user",userId:human,agentId:null},returnAssignee:{type:"agent",agentId:snapshot.builderAgentId,userId:null}}:state;
      const updated=await issueService(input.tx).update(input.issueId,{status:exhausted?"in_review":"todo",assigneeAgentId:exhausted?null:snapshot.builderAgentId,
        assigneeUserId:exhausted?human:null,executionState,actorAgentId:actorAgentId,actorRunId:actorRunId},input.tx,input.publications);
      if(!updated) throw notFound("Task not found");
      // Status/assignment projection normally clears execution. Retain this
      // Reviewer's live lock until native finalization releases it; a queued
      // return cannot start another writer during the reviewer's finishing turn.
      await input.tx.update(issues).set({executionRunId:current.executionRunId,executionAgentNameKey:current.executionAgentNameKey,
        executionLockedAt:current.executionLockedAt}).where(eq(issues.id,input.issueId));
      let returnWakeupId:string|null=null;
      if(!exhausted) {
        returnWakeupId=await enqueueScopedReturn(input.tx,{companyId:input.companyId,issueId:input.issueId,scopeId:scope.id,interactionId:input.interactionId,
          snapshot,outcome:input.outcome,reason:input.reason,actor:{type:"agent",id:actorAgentId}});
      }
      const [saved]=await input.tx.update(issueScopedReviews).set({state:exhausted?"held":input.outcome,verdict:input.outcome,verdictRunId:actorRunId,
        returnWakeupId,returnStatusVersion:updated.statusVersion,version:sql`${issueScopedReviews.version}+1`,updatedAt:new Date()}).where(and(eq(issueScopedReviews.id,scope.id),eq(issueScopedReviews.state,"pending"),eq(issueScopedReviews.version,Number(context.scope.version)))).returning({id:issueScopedReviews.id});
      if(!saved) throw conflict("Scoped decision lost its version claim");
      const {publication}=await persistActivity(input.tx,{companyId:input.companyId,actorType:"agent",actorId:actorAgentId,agentId:actorAgentId,runId:actorRunId,
        action:"issue.scoped_review_decided",entityType:"issue",entityId:input.issueId,issueId:input.issueId,
        details:{scopeId:scope.id,interactionId:input.interactionId,verdict:input.outcome,revisionId:snapshot.revisionId,contentSha256:snapshot.contentSha256,
          parentTaskUnfinished:true,returnWakeupId,heldForHuman:exhausted?human:null,reviewCyclesUsed:context.budget.admissions.length}});
      input.publications.push(publication);
      return updated;
    });
}

export async function assertScopedAllowanceExecutionSettled(db:Db,companyId:string,issueId:string) {
  const [active]=await db.select({id:heartbeatRuns.id}).from(issueScopedReviews)
    .innerJoin(heartbeatRuns,eq(heartbeatRuns.id,issueScopedReviews.verdictRunId))
    .innerJoin(issues,eq(issues.id,issueScopedReviews.issueId))
    .where(and(eq(issueScopedReviews.companyId,companyId),eq(issueScopedReviews.issueId,issueId),eq(issueScopedReviews.state,"held"),
      or(sql`${heartbeatRuns.status} in ('running','queued')`,eq(issues.executionRunId,heartbeatRuns.id))));
  if(active) throw conflict("The Reviewer execution is still settling; retry the allowance after its native turn finishes",{code:"scoped_review_execution_settling"});
}


export async function enqueueScopedReturn(tx:Db,input:{companyId:string;issueId:string;scopeId:string;interactionId:string;snapshot:ScopedReviewSnapshot;
  outcome:"passed"|"changes_requested"|"cancelled";reason:string;actor:{type:"agent"|"user";id:string}}) {
  const {snapshot}=input, truncated=snapshot.remainingWork.length>6500;
  const message=[`Scoped review ${input.outcome==="passed"?"passed":input.outcome==="cancelled"?"was cancelled without a verdict":"requested corrections"}; the parent task remains unfinished.`,
    `Scope: ${snapshot.purpose}`,`Revision: ${snapshot.revisionId}; SHA256: ${snapshot.contentSha256}`,
    `Remaining work: ${snapshot.remainingWork.slice(0,6500)}`,truncated?`Remaining work is truncated here. Read the full retained scope ${input.scopeId} from GET /api/issues/${input.issueId}/scoped-reviews.`:null,
    input.reason?`Review or cancellation notes: ${input.reason.slice(0,1000)}`:null,
    input.outcome==="cancelled"?"No partial approval applies. Inspect current documents and request a fresh scoped review if needed.":null,
    "Continue only this task's remaining work. A partial pass is not final task approval. Final completion still requires configured review and selected human approval; all cycles share the parent budget."].filter(Boolean).join("\n\n");
  const paperclipAgentMessage={text:message,source:"scoped_review",sessionId:input.scopeId};
  const status=input.outcome==="passed"?"accepted":input.outcome==="cancelled"?"cancelled":"rejected";
  const [wake]=await tx.insert(agentWakeupRequests).values({companyId:input.companyId,agentId:snapshot.builderAgentId,source:"automation",triggerDetail:"system",reason:"issue_commented",
    requestedByActorType:"system",requestedByActorId:"native-status-committer",idempotencyKey:`native-scoped-return:${input.scopeId}:${status}`,
    payload:{issueId:input.issueId,taskId:input.issueId,interactionId:input.interactionId,interactionKind:"request_confirmation",interactionStatus:status,
      scopedReviewId:input.scopeId,scopedReviewDecisionActor:input.actor,paperclipAgentMessage,_paperclipWakeContext:{issueId:input.issueId,taskId:input.issueId,interactionId:input.interactionId,
        interactionKind:"request_confirmation",interactionStatus:status,scopedReviewId:input.scopeId,paperclipAgentMessage,wakeReason:"issue_commented",source:"scoped_review.return",forceFreshSession:true}}}).returning({id:agentWakeupRequests.id});
  if(!wake) throw new Error("Scoped return intent was not persisted");
  return wake.id;
}

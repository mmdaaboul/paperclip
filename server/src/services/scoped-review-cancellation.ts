import { boundRunIssueId, boundRunIssueIdSql } from "./run-task-binding.js";
import { and, eq, inArray, sql } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, issueScopedReviews, issueThreadInteractions, issues, type Db } from "@paperclipai/db";
import { cancelScopedReviewSchema, reviewCycleBudgetAvailable, scopedReviewSnapshotSchema, type CancelScopedReview, type ScopedReviewCancellation, type ScopedReviewSnapshot } from "@paperclipai/shared";
import { conflict, forbidden, notFound } from "../errors.js";
import { assertAgentRunWriteAllowed } from "../agent-run-cancellation.js";
import { nativeSha256 } from "./native-runtime/canonical.js";
import { normalizeIssueExecutionPolicy, parseIssueExecutionState } from "./issue-execution-policy.js";
import { withLockedScopedReviewBudget } from "./review-cycle-budget-store.js";
import { enqueueScopedReturn } from "./scoped-review-resolution.js";
import { issueService } from "./issues.js";
import { persistActivity, publishActivity, type ActivityPublication } from "./activity-log.js";

type Actor={userId?:string|null;agentId?:string|null;runId?:string|null};
function assertSameCancellation(saved:ScopedReviewCancellation,request:CancelScopedReview,actor:Actor) {
  if(saved.requestId!==request.requestId || saved.reason!==request.reason || saved.expectedVersion!==request.expectedVersion
    || saved.requestedByUserId!==(actor.userId??null) || saved.requestedByAgentId!==(actor.agentId??null))
    throw conflict("Resume the existing scoped cancellation with its original request ID and reason");
}

export type ScopedReviewStopProofReader=(input:{companyId:string;runId:string},database:Db)=>Promise<{runId:string;companyId:string;agentId:string;issueId:string|null;proof:string}|null>;

/** Reuse native Stop's target-aware proof both at cancellation commit and at
 * subsequent Builder dispatch. A saved terminal status is never that proof. */
export async function assertScopedCancellationTargetsStopped(db:Db,snapshot:ScopedReviewSnapshot,cancellation:ScopedReviewCancellation|null,executionRunId:string|null,readProof?:ScopedReviewStopProofReader) {
  const identity=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
  if(!cancellation || !Array.isArray(cancellation.targetRunIds) || cancellation.targetRunIds.some(id=>typeof id!=="string" || !identity.test(id)))throw conflict("Recorded scoped Stop targets are unavailable",{code:"scoped_review_stop_targets_incompatible"});
  const targets=[...new Set(cancellation.targetRunIds)];
  if(targets.length>128)throw conflict("Scoped Stop targets exceed the bounded native settlement check",{code:"scoped_review_stop_target_overflow"});
  if(targets.length && !readProof)throw conflict("Native scoped Stop verification is unavailable",{code:"scoped_review_stop_verifier_unavailable"});
  for(const runId of targets) {
    const [target]=await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id,runId),eq(heartbeatRuns.companyId,snapshot.companyId))).for("share");
    if(!target || target.agentId!==snapshot.reviewerAgentId || boundRunIssueId(target)!==snapshot.issueId || executionRunId===target.id)
      throw conflict("Native scoped Stop still owns execution or its target binding changed",{code:"scoped_review_stop_unsettled"});
    const proof=await readProof!({companyId:snapshot.companyId,runId},db);
    if(!proof || proof.runId!==runId || proof.companyId!==snapshot.companyId || proof.agentId!==snapshot.reviewerAgentId || proof.issueId!==snapshot.issueId)
      throw conflict("Native scoped Stop lacks target-aware termination proof",{code:"scoped_review_stop_unsettled"});
  }
}

/** Stop is delegated to the native heartbeat owner BETWEEN these two short
 * transactions. A failed/lost Stop leaves a durable non-dispatchable intent.
 */
export function scopedReviewCancellationService(db:Db,options:{readRunTerminationProof:ScopedReviewStopProofReader}) {
  async function begin(input:{companyId:string;issueId:string;scopeId:string;actor:Actor;request:CancelScopedReview}) {
    const request=cancelScopedReviewSchema.parse(input.request),publications:ActivityPublication[]=[];
    const result=await db.transaction(async tx=>{
      const [issue]=await tx.select().from(issues).where(and(eq(issues.id,input.issueId),eq(issues.companyId,input.companyId))).for("update");
      const [scope]=await tx.select().from(issueScopedReviews).where(and(eq(issueScopedReviews.id,input.scopeId),eq(issueScopedReviews.issueId,input.issueId),eq(issueScopedReviews.companyId,input.companyId))).for("update");
      if(!issue || !scope) throw notFound("Scoped review not found");
      const snapshot=scopedReviewSnapshotSchema.parse(scope.snapshot);
      if(input.actor.agentId) {
        if(!(scope.state==="draft" || scope.state==="cancelled" && !scope.sourceDecisionId) || input.actor.agentId!==snapshot.builderAgentId || input.actor.runId!==snapshot.builderRunId || issue.assigneeAgentId!==input.actor.agentId)
          throw forbidden("Only the captured Builder may withdraw its unsubmitted draft; dispatched review cancellation requires a human");
        await assertAgentRunWriteAllowed(tx as unknown as Db,input.companyId,input.actor);
      } else if(!input.actor.userId) throw forbidden("Authenticated task management is required");
      const live=scope.interactionId ? await tx.select({id:heartbeatRuns.id}).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId,input.companyId),eq(heartbeatRuns.agentId,snapshot.reviewerAgentId),
        eq(boundRunIssueIdSql(),input.issueId),sql`${heartbeatRuns.contextSnapshot}->>'nativeReviewInteractionId'=${scope.interactionId}`,inArray(heartbeatRuns.status,["queued","running"]))) : [];
      if(scope.state==="cancelled") {
        if(scope.cancellation?.requestId===request.requestId) assertSameCancellation(scope.cancellation,request,input.actor);
        return {scope,replayed:true,runIds:[] as string[]};
      }
      if(scope.state==="cancelling") {
        if(!scope.cancellation) throw conflict("Scoped cancellation metadata is unavailable");
        assertSameCancellation(scope.cancellation,request,input.actor);
        const targets=[...new Set([...(scope.cancellation.targetRunIds??[]),...live.map(run=>run.id)])];
        if(targets.length!==(scope.cancellation.targetRunIds??[]).length) {
          const [retargeted]=await tx.update(issueScopedReviews).set({cancellation:{...scope.cancellation,targetRunIds:targets},version:sql`${issueScopedReviews.version}+1`,updatedAt:new Date()})
            .where(and(eq(issueScopedReviews.id,scope.id),eq(issueScopedReviews.version,scope.version))).returning();
          if(!retargeted) throw conflict("Scoped cancellation changed while collecting native Stop targets");Object.assign(scope,retargeted);
        }
      } else {
        if(!["draft","pending"].includes(scope.state) || scope.version!==request.expectedVersion) throw conflict("The scoped review changed; reload its current state before cancelling");
        const cancellation:ScopedReviewCancellation={...request,requestedByUserId:input.actor.userId??null,requestedByAgentId:input.actor.agentId??null,requestedAt:new Date().toISOString(),targetRunIds:live.map(run=>run.id)};
        const [changed]=await tx.update(issueScopedReviews).set({state:scope.state==="draft"?"cancelled":"cancelling",cancellation,
          version:sql`${issueScopedReviews.version}+1`,updatedAt:new Date()}).where(and(eq(issueScopedReviews.id,scope.id),eq(issueScopedReviews.version,scope.version))).returning();
        if(!changed) throw conflict("Scoped cancellation lost its version claim");
        const {publication}=await persistActivity(tx as unknown as Db,{companyId:input.companyId,actorType:input.actor.agentId?"agent":"user",actorId:input.actor.agentId??input.actor.userId!,
          agentId:input.actor.agentId??null,runId:input.actor.runId??null,action:changed.state==="cancelled"?"issue.scoped_review_cancelled":"issue.scoped_review_cancellation_requested",entityType:"issue",entityId:input.issueId,
          issueId:input.issueId,details:{scopeId:scope.id,requestId:request.requestId,reason:request.reason,budgetRefunded:false}});publications.push(publication);
        Object.assign(scope,changed);
      }
      if((scope as {state:string}).state==="cancelled") return {scope,replayed:false,runIds:[] as string[]};
      await tx.update(agentWakeupRequests).set({status:"cancelled",finishedAt:new Date(),updatedAt:new Date(),error:"Scoped review cancellation requested"}).where(and(eq(agentWakeupRequests.companyId,input.companyId),
        eq(agentWakeupRequests.agentId,snapshot.reviewerAgentId),eq(agentWakeupRequests.idempotencyKey,`native-review:${scope.interactionId}`),inArray(agentWakeupRequests.status,["queued","deferred_issue_execution"])));
      return {scope,replayed:false,runIds:scope.cancellation?.targetRunIds??live.map(run=>run.id)};
    });
    publications.forEach(publishActivity);return result;
  }
  async function finish(input:{companyId:string;issueId:string;scopeId:string;actor:Actor;request:CancelScopedReview}) {
    if(!input.actor.userId || input.actor.agentId) throw forbidden("Dispatched scoped cancellation requires an authenticated human");
    const userId=input.actor.userId,publications:ActivityPublication[]=[];
    const result=await db.transaction(async tx=>{
      const [scope]=await tx.select().from(issueScopedReviews).where(and(eq(issueScopedReviews.id,input.scopeId),eq(issueScopedReviews.issueId,input.issueId),eq(issueScopedReviews.companyId,input.companyId)));
      if(!scope) throw notFound("Scoped review not found");
      if(scope.state==="cancelled") return scope;
      if(!scope.cancellation) throw conflict("No native scoped cancellation was requested");assertSameCancellation(scope.cancellation,input.request,input.actor);
      const snapshot=scopedReviewSnapshotSchema.parse(scope.snapshot);
      return withLockedScopedReviewBudget(tx,{companyId:input.companyId,issueId:input.issueId,scopeId:scope.id,expectedSnapshot:snapshot,now:new Date().toISOString(),
        operation:{kind:"cancel",requestId:input.request.requestId,userId}},async context=>{
          const [issue]=await tx.select().from(issues).where(eq(issues.id,input.issueId));if(!issue) throw notFound("Task not found");
          await assertScopedCancellationTargetsStopped(tx as unknown as Db,snapshot,scope.cancellation,issue.executionRunId,options.readRunTerminationProof);
          const policy=normalizeIssueExecutionPolicy(issue.executionPolicy),finalStage=policy?.stages.at(-1),human=finalStage?.type==="approval"?finalStage.participants.find(p=>p.type==="user")?.userId:null;
          const canReturn=policy?.totalReviewCycles===5 && nativeSha256(policy)===snapshot.policySha256 && issue.assigneeAgentId===snapshot.builderAgentId && !issue.assigneeUserId
            && issue.executionWorkspaceId===snapshot.executionWorkspaceId && issue.workspaceBindingRevision===snapshot.workspaceBindingRevision && !["done","cancelled"].includes(issue.status);
          let returnWakeupId:string|null=null,returnStatusVersion:number|null=null;
          if(canReturn) {
            const exhausted=reviewCycleBudgetAvailable(context.budget)===0;
            if(exhausted && !human) throw conflict("An exhausted scoped cancellation requires its configured human");
            const previous=parseIssueExecutionState(issue.executionState),state={...(previous??{status:"idle",currentStageId:null,currentStageIndex:null,currentStageType:null,currentParticipant:null,
              returnAssignee:{type:"agent",agentId:snapshot.builderAgentId,userId:null},completedStageIds:[],lastDecisionId:null,lastDecisionOutcome:null,reviewRequest:null,changesRequestedCount:0}),
              totalReviewCyclesUsed:context.budget.admissions.length,totalReviewCycleAllowance:context.budget.initialAllowance+context.budget.allowances.reduce((n,a)=>n+a.additionalCycles,0)};
            const executionState=exhausted?{...state,status:"changes_requested",totalReviewBudgetHold:true,currentStageId:null,currentStageIndex:null,currentStageType:null,
              currentParticipant:{type:"user",userId:human,agentId:null},returnAssignee:{type:"agent",agentId:snapshot.builderAgentId,userId:null}}:state;
            const updated=await issueService(tx as unknown as Db).update(issue.id,{status:exhausted?"in_review":"todo",assigneeAgentId:exhausted?null:snapshot.builderAgentId,assigneeUserId:exhausted?human:null,
              executionState,actorUserId:userId},tx,publications);if(!updated) throw notFound("Task not found");returnStatusVersion=updated.statusVersion;
            if(!exhausted && scope.interactionId) returnWakeupId=await enqueueScopedReturn(tx as unknown as Db,{companyId:input.companyId,issueId:input.issueId,scopeId:scope.id,interactionId:scope.interactionId,
              snapshot,outcome:"cancelled",reason:input.request.reason,actor:{type:"user",id:userId}});
          }
          if(scope.interactionId) await tx.update(issueThreadInteractions).set({status:"cancelled",result:{version:1,outcome:"withdrawn",reason:input.request.reason},resolvedByUserId:userId,resolvedAt:new Date(),updatedAt:new Date()})
            .where(and(eq(issueThreadInteractions.id,scope.interactionId),eq(issueThreadInteractions.status,"pending")));
          const [saved]=await tx.update(issueScopedReviews).set({state:"cancelled",returnWakeupId,returnStatusVersion,version:sql`${issueScopedReviews.version}+1`,updatedAt:new Date()})
            .where(and(eq(issueScopedReviews.id,scope.id),eq(issueScopedReviews.state,"cancelling"),eq(issueScopedReviews.version,Number(context.scope.version)))).returning();
          if(!saved) throw conflict("Scoped cancellation changed before native settlement");
          const {publication}=await persistActivity(tx as unknown as Db,{companyId:input.companyId,actorType:"user",actorId:userId,action:"issue.scoped_review_cancelled",entityType:"issue",entityId:input.issueId,issueId:input.issueId,
            details:{scopeId:scope.id,requestId:input.request.requestId,reason:input.request.reason,budgetRefunded:false,reviewCyclesUsed:context.budget.admissions.length,returnWakeupId,ownerChanged:!canReturn}});publications.push(publication);
          return saved;
        });
    });publications.forEach(publishActivity);return result;
  }
  return {begin,finish};
}

import { boundRunIssueIdSql } from "./run-task-binding.js";
import { assertScopedCancellationTargetsStopped, type ScopedReviewStopProofReader } from "./scoped-review-cancellation.js";
import { and, eq, inArray } from "drizzle-orm";
import { agentWakeupRequests, agents, heartbeatRuns, issueScopedReviews, issues, type Db } from "@paperclipai/db";
import { scopedReviewSnapshotSchema } from "@paperclipai/shared";
import { conflict, forbidden } from "../errors.js";
import { normalizeIssueExecutionPolicy } from "./issue-execution-policy.js";
import { assertCurrentScopedArtifact } from "./scoped-reviews.js";
import { nativeSha256 } from "./native-runtime/canonical.js";
import { getNativeReviewAssignment } from "./native-runtime/native-review-participant.js";
import { parseNativeExecutionInput } from "../vendor/paperclip-runner/index.js";

/** Controller-owned gate before workspace preparation. Caller supplies DB run
 * identity; wake hints cannot create a grant or bypass parent-task ownership.
 */
export async function assertScopedRunAdmission(db:Db,input:{companyId:string;issueId:string;runId:string},options?:{readRunTerminationProof:ScopedReviewStopProofReader}) {
  return db.transaction(async tx=>{
    const [issue]=await tx.select().from(issues).where(and(eq(issues.id,input.issueId),eq(issues.companyId,input.companyId))).for("share");
    if(!issue || normalizeIssueExecutionPolicy(issue.executionPolicy)?.totalReviewCycles!==5) return;
    const [run]=await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id,input.runId),eq(heartbeatRuns.companyId,input.companyId))).for("share");
    if(!run) throw forbidden("Scoped task admission requires its persisted run");
    const [active]=await tx.select().from(issueScopedReviews).where(and(eq(issueScopedReviews.companyId,input.companyId),eq(issueScopedReviews.issueId,input.issueId),inArray(issueScopedReviews.state,["draft","pending","cancelling"]))).for("share");
    if(active) {
      const snapshot=scopedReviewSnapshotSchema.parse(active.snapshot);
      if(active.state==="cancelling") throw conflict("Scoped review cancellation is waiting for native execution settlement",{code:"scoped_review_cancelling"});
      if(issue.executionWorkspaceId!==snapshot.executionWorkspaceId || issue.workspaceBindingRevision!==snapshot.workspaceBindingRevision
        || nativeSha256(normalizeIssueExecutionPolicy(issue.executionPolicy))!==snapshot.policySha256)
        throw conflict("The active scope's workspace or configured workflow changed before dispatch");
      if(active.state==="draft") {
        if(run.id!==snapshot.builderRunId || run.agentId!==snapshot.builderAgentId || issue.assigneeAgentId!==snapshot.builderAgentId)
          throw conflict("A scoped draft is already owned by its captured Builder run",{code:"scoped_review_source_running"});
        let pinned;try{pinned=parseNativeExecutionInput(run.runnerProfileJson?.nativeExecutionInput);}catch{throw conflict("Scoped source execution is unavailable");}
        if(nativeSha256(pinned)!==snapshot.executionSha256) throw conflict("Scoped source execution changed");
        return;
      }
      const [reviewerAgent]=await tx.select({adapterType:agents.adapterType}).from(agents).where(and(eq(agents.id,run.agentId),eq(agents.companyId,input.companyId)));
      // Queue identity precedes native preparation. Use its canonical task and
      // durable assignment here; the post-preparation call still requires the
      // native acting-run identity below.
      const context=run.contextSnapshot??{};
      const unresolved=run.runtimeMode==="legacy" && !run.runtimeModeResolvedAt && run.nativeIssueId===null
        && reviewerAgent?.adapterType==="paperclip_runner" && run.scopeKind==="issue" && run.issueId===issue.id
        && context.issueId===issue.id && (context.taskId===undefined || context.taskId===issue.id)
        && ["queued","running"].includes(run.status) && (run.status!=="running" || issue.executionRunId===run.id);
      if(run.agentId!==snapshot.reviewerAgentId || !(unresolved || run.runtimeMode==="native" && run.nativeIssueId===issue.id))
        throw conflict("A new Builder turn cannot start during the pending scoped review",{code:"scoped_review_pending"});
      const proof=await getNativeReviewAssignment(tx as unknown as Db,{companyId:input.companyId,issueId:input.issueId,agentId:run.agentId,
        contextSnapshot:run.contextSnapshot,...(!unresolved && run.status==="running"?{actingRunId:run.id,issueExecutionRunId:issue.executionRunId}:{})});
      if(!proof?.scopedReview || proof.scopedReview.id!==active.id) throw forbidden("This native run has no current scoped Reviewer assignment");
      if(unresolved && (context.sourceRunId!==undefined && context.sourceRunId!==proof.sourceRun.id
        || context.revisionId!==undefined && context.revisionId!==proof.sourceDecision.id))
        throw forbidden("This queued run does not match its native Reviewer source");
      return;
    }
    const context=run.contextSnapshot as {scopedReviewId?:unknown;nativeReviewInteractionId?:unknown}|null;
    if(typeof context?.nativeReviewInteractionId==="string") {
      const [decided]=await tx.select({id:issueScopedReviews.id}).from(issueScopedReviews).where(and(eq(issueScopedReviews.companyId,input.companyId),eq(issueScopedReviews.issueId,input.issueId),eq(issueScopedReviews.interactionId,context.nativeReviewInteractionId)));
      if(decided) throw conflict("This scoped review is already decided; finish platform settlement without restarting its provider turn",{code:"scoped_review_already_decided"});
    }
    const [receipt]=run.wakeupRequestId ? await tx.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.id,run.wakeupRequestId),eq(agentWakeupRequests.companyId,input.companyId))) : [];
    const receiptPayload=receipt?.payload as {scopedReviewId?:unknown;_paperclipWakeContext?:{scopedReviewId?:unknown}}|null;
    const scopeId=context?.scopedReviewId??receiptPayload?.scopedReviewId??receiptPayload?._paperclipWakeContext?.scopedReviewId;
    if(typeof scopeId!=="string") return;
    const [scope]=await tx.select().from(issueScopedReviews).where(and(eq(issueScopedReviews.id,scopeId),eq(issueScopedReviews.companyId,input.companyId),eq(issueScopedReviews.issueId,input.issueId))).for("share");
    if(!scope || !["passed","changes_requested","cancelled"].includes(scope.state) || !scope.returnWakeupId || scope.returnStatusVersion===null || !receipt)
      throw forbidden("No durable scoped return owns this Builder run");
    const snapshot=scopedReviewSnapshotSchema.parse(scope.snapshot);
    const originalReceipt=receipt.id===scope.returnWakeupId;
    const dispatchedReceipt=receipt.requestedByActorType==="system" && receipt.requestedByActorId===`native-status-wake-dispatch:${scope.returnWakeupId}`;
    if((!originalReceipt && !dispatchedReceipt) || receipt.agentId!==snapshot.builderAgentId || run.agentId!==snapshot.builderAgentId
      || issue.assigneeAgentId!==snapshot.builderAgentId || issue.assigneeUserId || !["todo","in_progress"].includes(issue.status)
      || issue.statusVersion!==scope.returnStatusVersion || issue.executionWorkspaceId!==snapshot.executionWorkspaceId
      || issue.workspaceBindingRevision!==snapshot.workspaceBindingRevision || nativeSha256(normalizeIssueExecutionPolicy(issue.executionPolicy))!==snapshot.policySha256)
      throw conflict("The scoped return target or native receipt is no longer current",{code:"scoped_review_return_stale"});
    const targetRunIds=scope.state==="cancelled" ? scope.cancellation?.targetRunIds??[] : scope.verdictRunId?[scope.verdictRunId]:[];
    const reviewers=targetRunIds.length ? await tx.select().from(heartbeatRuns).where(and(inArray(heartbeatRuns.id,targetRunIds),eq(heartbeatRuns.companyId,input.companyId),
      eq(heartbeatRuns.agentId,snapshot.reviewerAgentId),eq(boundRunIssueIdSql(),input.issueId))).for("share") : [];
    if(reviewers.length!==targetRunIds.length || scope.state!=="cancelled" && !scope.verdictRunId
      || reviewers.some(reviewer=>["queued","running"].includes(reviewer.status) || issue.executionRunId===reviewer.id)
      || issue.executionRunId && issue.executionRunId!==run.id)
      throw conflict("The scoped Reviewer must settle before the Builder can restart",{code:"scoped_review_return_waiting_release"});
    if(scope.state==="cancelled")await assertScopedCancellationTargetsStopped(tx as unknown as Db,snapshot,scope.cancellation,issue.executionRunId,options?.readRunTerminationProof);
    if(scope.state!=="cancelled") await assertCurrentScopedArtifact(tx as unknown as Db,snapshot,true);
  });
}

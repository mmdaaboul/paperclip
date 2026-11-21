import { boundRunIssueIdSql } from "./run-task-binding.js";
import { assertScopedCancellationTargetsStopped, type ScopedReviewStopProofReader } from "./scoped-review-cancellation.js";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { agentWakeupRequests, agents, environmentLeases, heartbeatRunEvents, heartbeatRuns, issueRecoveryActions, issueScopedReviews, issues, nativeRunFinalizations, nativeRunResults, toolInvocations, type Db } from "@paperclipai/db";
import { isUuidLike, scopedReviewSnapshotSchema } from "@paperclipai/shared";
import { conflict, forbidden } from "../errors.js";
import { normalizeIssueExecutionPolicy } from "./issue-execution-policy.js";
import { assertCurrentScopedArtifact } from "./scoped-reviews.js";
import { nativeSha256 } from "./native-runtime/canonical.js";
import { getNativeReviewAssignment } from "./native-runtime/native-review-participant.js";
import { parseNativeExecutionInput } from "../vendor/paperclip-runner/index.js";
import { executionStartedEventPredicate } from "./pre-dispatch-execution-evidence.js";
import { NATIVE_PROVIDER_DURABLE_EVENT_TYPES } from "./native-runtime/native-retired-backup-source.js";
import { referenceFolderAdmissionSchema } from "./agent-reference-folder-admission.js";

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
    // Native checkout is the one expected version transition after the early
    // gate. Accept only this same claimed native Builder's exact checkout;
    // manual status edits, another owner or any further version remain stale.
    const ownCheckout=run.status==="running" && run.runtimeMode==="native" && run.nativeIssueId===issue.id
      && run.scopeKind==="issue" && run.issueId===issue.id && run.contextSnapshot?.issueId===issue.id
      && (run.contextSnapshot.taskId===undefined || run.contextSnapshot.taskId===issue.id)
      && receipt.runId===run.id && issue.status==="in_progress" && issue.checkoutRunId===run.id
      && issue.executionRunId===run.id && issue.statusVersion===scope.returnStatusVersion+1
      && run.runnerProfileJson?.scopedReturnCheckout != null
      && nativeSha256(run.runnerProfileJson.scopedReturnCheckout)===nativeSha256(scopedReturnCheckoutReceipt(scope,snapshot,run,scope.returnStatusVersion,issue.statusVersion));
    if((!originalReceipt && !dispatchedReceipt) || receipt.agentId!==snapshot.builderAgentId || run.agentId!==snapshot.builderAgentId
      || issue.assigneeAgentId!==snapshot.builderAgentId || issue.assigneeUserId || !["todo","in_progress"].includes(issue.status)
      || (issue.statusVersion!==scope.returnStatusVersion && !ownCheckout) || issue.executionWorkspaceId!==snapshot.executionWorkspaceId
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

function scopedReturnCheckoutReceipt(scope: typeof issueScopedReviews.$inferSelect,
  snapshot: ReturnType<typeof scopedReviewSnapshotSchema.parse>, run: typeof heartbeatRuns.$inferSelect, from: number, to: number) {
  return { schema: "paperclip.scoped-return-checkout.v1", companyId: run.companyId, issueId: scope.issueId,
    scopeId: scope.id, scopeVersion: scope.version, runId: run.id, agentId: run.agentId, wakeupRequestId: run.wakeupRequestId,
    returnWakeupId: scope.returnWakeupId, fromStatus: "todo", fromStatusVersion: from, toStatus: "in_progress", toStatusVersion: to,
    executionWorkspaceId: snapshot.executionWorkspaceId, workspaceBindingRevision: snapshot.workspaceBindingRevision, policySha256: snapshot.policySha256 };
}

/** Called ONLY in the real issue-checkout transaction, after its successful
 * todo CAS while the issue lock retains the preimage. Adoption never calls it.
 * Stamp server-owned run metadata; wake payload hints cannot mint this proof.
 */
export async function recordScopedReturnCheckout(tx: Db, input: {
  companyId: string; issueId: string; runId: string; agentId: string; beforeStatus: string; beforeStatusVersion: number;
  afterStatusVersion: number;
}) {
  if (input.beforeStatus !== "todo" || input.afterStatusVersion !== input.beforeStatusVersion + 1) return;
  const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId),
    eq(heartbeatRuns.agentId, input.agentId), eq(heartbeatRuns.issueId, input.issueId), eq(heartbeatRuns.scopeKind, "issue"))).for("update");
  const id = run?.contextSnapshot?.scopedReviewId;
  if (!run || run.status !== "running" || !run.wakeupRequestId || typeof id !== "string" || !isUuidLike(id)) return;
  const [scope] = await tx.select().from(issueScopedReviews).where(and(eq(issueScopedReviews.companyId, input.companyId),
    eq(issueScopedReviews.issueId, input.issueId), eq(issueScopedReviews.id, id)));
  if (!scope || !["passed", "changes_requested", "cancelled"].includes(scope.state) || !scope.returnWakeupId
    || scope.returnStatusVersion !== input.beforeStatusVersion) return;
  const parsed = scopedReviewSnapshotSchema.safeParse(scope.snapshot); if (!parsed.success) return;
  const [receipt] = await tx.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.id, run.wakeupRequestId)));
  if (parsed.data.builderAgentId !== run.agentId || !receipt || receipt.runId !== run.id || receipt.agentId !== run.agentId
    || !(receipt.id === scope.returnWakeupId || receipt.requestedByActorType === "system"
      && receipt.requestedByActorId === `native-status-wake-dispatch:${scope.returnWakeupId}`)) return;
  const proof = scopedReturnCheckoutReceipt(scope, parsed.data, run, input.beforeStatusVersion, input.afterStatusVersion);
  await tx.update(heartbeatRuns).set({ runnerProfileJson: sql`coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb)
    || jsonb_build_object('scopedReturnCheckout', ${JSON.stringify(proof)}::jsonb)` }).where(eq(heartbeatRuns.id, run.id));
}

/** Read-only no-launch proof for an exact failed scoped return. This grants no
 * task/review authority and never replays its consumed wake. The existing
 * explicit-user continuation still owns current assignment, holds, cleanup,
 * user intent and successor admission. Native identity may have been prepared
 * even though the runner coordinator was never claimed or dispatched.
 */
export async function isUnclaimedScopedReturnPreparation(db: Db, input: {
  companyId: string; issueId: string; runId: string;
}) {
  const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId)));
  const recovery = run?.resultJson?.executionRecovery as Record<string, unknown> | undefined;
  if (!run || run.runtimeMode !== "native" || run.status !== "failed" || !run.finishedAt
    || run.errorCode !== "adapter_failed" || run.scopeKind !== "issue" || run.issueId !== input.issueId || run.nativeIssueId !== input.issueId
    || run.contextSnapshot?.issueId !== input.issueId || run.contextSnapshot.taskId !== input.issueId
    || recovery?.kind !== "bootstrap" || recovery.providerWorkStarted !== false
    || run.processPid || run.processGroupId || run.processStartedAt || run.sessionIdAfter
    || run.controllerBootId || run.controllerLeaseExpiresAt || !run.wakeupRequestId
    || run.runnerProfileJson?.nativeWorkspaceSync != null || run.runnerProfileJson?.remoteWorkspace != null
    || run.runnerProfileJson?.sessionCheckpoint != null || run.runnerProfileJson?.nativeWorkspaceFinalizationOwner != null
    || run.contextSnapshot.nativePreClaimContinuationOf != null
    || ["cancellation", "nativeCancellation", "executionCancellation"].some(key => Object.hasOwn(run.resultJson ?? {}, key))) return false;
  const [owner] = await db.select().from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.companyId, input.companyId), eq(nativeRunFinalizations.runId, run.id)));
  if (!owner || owner.issueId !== input.issueId || owner.phase !== "terminal_failure" || owner.attempt !== 0
    || owner.failureCode !== "native_continuation_requires_reconciliation" || owner.controllerGeneration !== 0
    || owner.recoveryHistory.length || [owner.leaseOwner, owner.leaseHolder, owner.leaseExpiresAt, owner.controllerPid,
      owner.controllerBootId, owner.controllerHostHash, owner.controllerProcessStartedAt, owner.resultId, owner.assessmentId,
      owner.decisionId, owner.controlDeadlineAt, owner.nextAttemptAt, owner.recoveryState, owner.recoveryRequestId,
      owner.failureDetail].some(value => value != null)) return false;
  const parsedScopeId = typeof run.contextSnapshot.scopedReviewId === "string" ? run.contextSnapshot.scopedReviewId : null;
  if (!parsedScopeId || !isUuidLike(parsedScopeId)) return false;
  const [scope] = parsedScopeId ? await db.select().from(issueScopedReviews).where(and(eq(issueScopedReviews.companyId, input.companyId),
    eq(issueScopedReviews.issueId, input.issueId), eq(issueScopedReviews.id, parsedScopeId))) : [];
  if (!scope || !["passed", "changes_requested"].includes(scope.state) || scope.verdict !== scope.state
    || !scope.verdictRunId || !scope.sourceDecisionId || !scope.returnWakeupId || scope.returnStatusVersion === null) return false;
  const parsed = scopedReviewSnapshotSchema.safeParse(scope.snapshot); if (!parsed.success) return false;
  const snapshot = parsed.data;
  if (snapshot.builderAgentId !== run.agentId || snapshot.companyId !== input.companyId || snapshot.issueId !== input.issueId) return false;
  let execution; try { execution = parseNativeExecutionInput(run.runnerProfileJson?.nativeExecutionInput); } catch { return false; }
  if (execution.binding.companyId !== input.companyId || execution.binding.runId !== run.id || execution.binding.agentId !== run.agentId
    || execution.binding.issueId !== input.issueId || execution.binding.executionWorkspaceId !== snapshot.executionWorkspaceId) return false;
  if (run.runnerProfileJson?.referenceFolderAdmission != null) {
    const admitted = referenceFolderAdmissionSchema.safeParse(run.runnerProfileJson.referenceFolderAdmission);
    if (!admitted.success || admitted.data.binding.companyId !== input.companyId || admitted.data.binding.agentId !== run.agentId
      || admitted.data.binding.runId !== run.id || admitted.data.binding.workspaceId !== snapshot.executionWorkspaceId
      || admitted.data.workspaceDirectory !== execution.workspace.cwd) return false;
  }
  const [intent] = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.id, scope.returnWakeupId)));
  const [delivery] = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.id, run.wakeupRequestId)));
  const expectedKey = `native-scoped-return:${scope.id}:${scope.state === "passed" ? "accepted" : "rejected"}`;
  const wakeContext = delivery?.payload?._paperclipWakeContext as Record<string, unknown> | undefined;
  if (!intent || !delivery || intent.requestedByActorType !== "system" || intent.requestedByActorId !== "native-status-committer"
    || intent.agentId !== run.agentId || intent.idempotencyKey !== expectedKey || intent.payload?.scopedReviewId !== scope.id
    || delivery.requestedByActorType !== "system" || delivery.requestedByActorId !== `native-status-wake-dispatch:${intent.id}`
    || delivery.agentId !== run.agentId || delivery.idempotencyKey !== expectedKey || delivery.runId !== run.id || delivery.status !== "failed"
    || delivery.payload?.scopedReviewId !== scope.id || wakeContext?.scopedReviewId !== scope.id
    || run.contextSnapshot.nativeStatusWakeIntentId !== intent.id) return false;
  const [issue] = await db.select().from(issues).where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId)));
  const [failure] = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, input.companyId),
    eq(issueRecoveryActions.sourceIssueId, input.issueId), eq(issueRecoveryActions.cause, "native_continuation_requires_reconciliation"),
    sql`${issueRecoveryActions.evidence}->>'runId' = ${run.id}`));
  const block = failure?.evidence?.nativeFailureBlock as Record<string, unknown> | undefined;
  if (!issue || issue.status !== "blocked" || issue.statusVersion !== scope.returnStatusVersion + 2
    || block?.runId !== run.id || block.statusVersion !== issue.statusVersion || failure?.evidence.runId !== run.id
    || issue.assigneeAgentId !== run.agentId || issue.assigneeUserId || issue.checkoutRunId || issue.executionRunId
    || issue.executionWorkspaceId !== snapshot.executionWorkspaceId || issue.workspaceBindingRevision !== snapshot.workspaceBindingRevision
    || nativeSha256(normalizeIssueExecutionPolicy(issue.executionPolicy)) !== snapshot.policySha256) return false;
  const [reviewer] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, scope.verdictRunId),
    eq(heartbeatRuns.agentId, snapshot.reviewerAgentId), eq(boundRunIssueIdSql(), input.issueId)));
  if (!reviewer || reviewer.status !== "succeeded" || !reviewer.finishedAt || issue.executionRunId === reviewer.id) return false;
  const [result] = await db.select({ id: nativeRunResults.id }).from(nativeRunResults).where(and(eq(nativeRunResults.companyId, input.companyId), eq(nativeRunResults.runId, run.id)));
  const [event] = await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.companyId, input.companyId),
    eq(heartbeatRunEvents.runId, run.id), or(executionStartedEventPredicate(), inArray(heartbeatRunEvents.eventType, [...NATIVE_PROVIDER_DURABLE_EVENT_TYPES]),
      eq(heartbeatRunEvents.eventType, "native.local_process_stopped"), sql`${heartbeatRunEvents.eventType} ~ '^(turn|item|tool|semantic_tool|run[.]result)[.]'`)));
  const [invocation] = await db.select({ id: toolInvocations.id }).from(toolInvocations).where(and(eq(toolInvocations.companyId, input.companyId), eq(toolInvocations.runId, run.id)));
  if (result || event || invocation) return false;
  const leases = await db.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, input.companyId), eq(environmentLeases.heartbeatRunId, run.id)));
  if (!leases.length || leases.some(lease => lease.issueId !== input.issueId || lease.provider !== "local" || lease.providerLeaseId != null
    || !["released", "failed", "expired"].includes(lease.status) || !lease.releasedAt
    || lease.cleanupStatus != null && lease.cleanupStatus !== "success"
    || lease.metadata?.pendingCleanupInFlight != null && lease.metadata.pendingCleanupInFlight !== false)) return false;
  try { await assertCurrentScopedArtifact(db, snapshot, true); } catch { return false; }
  return true;
}

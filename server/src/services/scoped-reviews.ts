import { and, eq, inArray, sql } from "drizzle-orm";
import { agents, documentRevisions, documents, executionWorkspaces, heartbeatRuns, issueDocuments, issueScopedReviews, issues, nativeRunFinalizations, nativeRunResults, workAssessments, type Db } from "@paperclipai/db";
import { createScopedReviewSchema, scopedReviewSnapshotSchema, type CreateScopedReview, type ScopedReview, reviewCycleBudgetAvailable } from "@paperclipai/shared";
import { parseNativeExecutionInput } from "../vendor/paperclip-runner/index.js";
import { assertAgentRunWriteAllowed } from "../agent-run-cancellation.js";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { normalizeIssueExecutionPolicy, parseIssueExecutionState } from "./issue-execution-policy.js";
import { persistActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { readReviewBudgetPreviewContext } from "./review-cycle-budget-store.js";
import type { NativeStatusDecision } from "./native-runtime/status-arbiter.js";
import { nativeSha256 } from "./native-runtime/canonical.js";

type Row = typeof issueScopedReviews.$inferSelect;
function publicReview(row: Row): ScopedReview {
  return { ...row, snapshot: scopedReviewSnapshotSchema.parse(row.snapshot), createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

/** Drafts are durable intent only. Native accepted-result finalization owns
 * review admission, outgoing release and Reviewer dispatch; this does not wake.
 */
export function scopedReviewService(db: Db) {
  return {
    async list(companyId: string, issueId: string): Promise<ScopedReview[]> {
      return (await db.select().from(issueScopedReviews).where(and(eq(issueScopedReviews.companyId, companyId), eq(issueScopedReviews.issueId, issueId)))).map(publicReview);
    },
    async createDraft(input: { companyId: string; issueId: string; actor: { agentId: string; runId: string }; request: CreateScopedReview }) {
      const request = createScopedReviewSchema.parse(input.request);
      const publications: ActivityPublication[] = [];
      const result = await db.transaction(async tx => {
        const [issue] = await tx.select().from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId))).for("update");
        if (!issue) throw notFound("Task not found");
        if (issue.assigneeAgentId !== input.actor.agentId || issue.assigneeUserId || !["todo", "in_progress"].includes(issue.status)) {
          throw forbidden("Only the current Builder can request a scoped review of unfinished work");
        }
        const [existing] = await tx.select().from(issueScopedReviews).where(eq(issueScopedReviews.id, request.id));
        if (existing) {
          const snapshot = scopedReviewSnapshotSchema.parse(existing.snapshot);
          const previous = Object.fromEntries(Object.keys(request).map(key => [key, snapshot[key as keyof typeof snapshot]]));
          if (existing.companyId !== issue.companyId || existing.issueId !== issue.id || snapshot.builderAgentId !== input.actor.agentId || nativeSha256(previous) !== nativeSha256(request)) {
            throw conflict("Scoped review request ID was reused with different content");
          }
          return { review: publicReview(existing), replayed: true };
        }
        await assertAgentRunWriteAllowed(tx as unknown as Db, input.companyId, input.actor);
        const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, input.actor.runId), eq(heartbeatRuns.companyId, issue.companyId), eq(heartbeatRuns.agentId, input.actor.agentId))).for("share");
        if (!run || run.runtimeMode !== "native" || run.nativeIssueId !== issue.id || run.status !== "running") {
          throw forbidden("Scoped review requires the current authenticated native Builder run");
        }
        let execution: ReturnType<typeof parseNativeExecutionInput>;
        try { execution = parseNativeExecutionInput(run.runnerProfileJson?.nativeExecutionInput); }
        catch { throw conflict("The Builder's pinned native execution is unavailable"); }
        if (execution.binding.companyId !== issue.companyId || execution.binding.issueId !== issue.id || execution.binding.agentId !== run.agentId || execution.binding.runId !== run.id
          || execution.binding.executionWorkspaceId !== request.executionWorkspaceId || issue.executionWorkspaceId !== request.executionWorkspaceId || issue.statusVersion !== request.expectedStatusVersion) {
          throw conflict("Task owner, workspace or status version changed before scoped review");
        }
        const [workspace] = await tx.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.id, request.executionWorkspaceId), eq(executionWorkspaces.companyId, issue.companyId))).for("share");
        if (!workspace || !["active", "idle"].includes(workspace.status)) throw conflict("Scoped review requires the task's current available workspace");
        const policy = normalizeIssueExecutionPolicy(issue.executionPolicy);
        const reviewer = policy?.stages.find(stage => stage.type === "review")?.participants.find(participant => participant.type === "agent")?.agentId;
        const finalStage = policy?.stages.at(-1);
        const approver = finalStage?.type === "approval" ? finalStage.participants.find(participant => participant.type === "user")?.userId : null;
        if (policy?.totalReviewCycles !== 5 || !reviewer || reviewer === run.agentId || !approver) {
          throw unprocessable("Select the independent Reviewer and final human in the task-wide five-cycle workflow first");
        }
        const budgetContext = await readReviewBudgetPreviewContext(tx, { companyId: issue.companyId, issueId: issue.id });
        if (budgetContext.reviewCycleBudget && reviewCycleBudgetAvailable(budgetContext.reviewCycleBudget) <= 0)
          throw conflict("The selected human must authorize another shared review cycle before requesting a new scope");
        if (!budgetContext.reviewCycleBudget && !budgetContext.reviewCycleInitializationAuthorized)
          throw conflict("Existing task review history requires reconciliation before a new scope");
        const [reviewerAgent]=await tx.select({adapterType:agents.adapterType}).from(agents).where(and(eq(agents.id,reviewer),eq(agents.companyId,issue.companyId)));
        if(reviewerAgent?.adapterType!=="paperclip_runner") throw unprocessable("Scoped document review currently requires a configured native Paperclip Runner Reviewer");
        if (parseIssueExecutionState(issue.executionState)?.status === "pending") throw conflict("Finish the current whole-task review before requesting a partial scope");
        const [active] = await tx.select({ id: issueScopedReviews.id }).from(issueScopedReviews).where(and(eq(issueScopedReviews.companyId, issue.companyId), eq(issueScopedReviews.issueId, issue.id), inArray(issueScopedReviews.state, ["draft", "pending", "cancelling"])));
        if (active) throw conflict("This task already has an outstanding scoped review", { scopeId: active.id });
        const [document] = await tx.select({ document: documents }).from(documents).innerJoin(issueDocuments, and(eq(issueDocuments.documentId, documents.id), eq(issueDocuments.companyId, issue.companyId), eq(issueDocuments.issueId, issue.id)))
          .where(and(eq(documents.id, request.documentId), eq(documents.companyId, issue.companyId))).for("share", { of: documents });
        const [revision] = await tx.select().from(documentRevisions).where(and(eq(documentRevisions.id, request.revisionId), eq(documentRevisions.documentId, request.documentId), eq(documentRevisions.companyId, issue.companyId))).for("share");
        if (!document || !revision || document.document.latestRevisionId !== revision.id || document.document.latestBody !== revision.body || document.document.format !== revision.format) {
          throw conflict("The selected native document revision is stale or outside this task");
        }
        if (Buffer.byteLength(revision.body, "utf8") > 1024 * 1024) throw unprocessable("Scoped document review currently supports at most 1 MiB per native revision");
        const snapshot = scopedReviewSnapshotSchema.parse({ ...request, schemaVersion: 1, companyId: issue.companyId, issueId: issue.id,
          builderAgentId: run.agentId, builderRunId: run.id, reviewerAgentId: reviewer, workspaceBindingRevision: issue.workspaceBindingRevision,
          executionSha256: nativeSha256(execution), contentSha256: nativeSha256({ title: revision.title, format: revision.format, body: revision.body }), policySha256: nativeSha256(policy) });
        const [saved] = await tx.insert(issueScopedReviews).values({ id: request.id, companyId: issue.companyId, issueId: issue.id, snapshot }).returning();
        const { publication } = await persistActivity(tx as unknown as Db, { companyId: issue.companyId, actorType: "agent", actorId: run.agentId, agentId: run.agentId, runId: run.id,
          action: "issue.scoped_review_requested", entityType: "issue", entityId: issue.id, issueId: issue.id,
          details: { scopeId: request.id, documentId: revision.documentId, revisionId: revision.id, contentSha256: snapshot.contentSha256, reviewerAgentId: reviewer, purpose: request.purpose, remainingWork: request.remainingWork } });
        publications.push(publication);
        return { review: publicReview(saved), replayed: false };
      });
      publications.forEach(publishActivity);
      return result;
    },
  };
}


export async function assertCurrentScopedArtifact(db:Db,snapshot:ScopedReview["snapshot"],lock=false) {
  let documentQuery=db.select({document:documents,revision:documentRevisions}).from(documents)
    .innerJoin(issueDocuments,and(eq(issueDocuments.documentId,documents.id),eq(issueDocuments.issueId,snapshot.issueId),eq(issueDocuments.companyId,snapshot.companyId)))
    .innerJoin(documentRevisions,and(eq(documentRevisions.id,snapshot.revisionId),eq(documentRevisions.documentId,documents.id),eq(documentRevisions.companyId,snapshot.companyId)))
    .where(and(eq(documents.id,snapshot.documentId),eq(documents.companyId,snapshot.companyId))).$dynamic();
  if(lock) documentQuery=documentQuery.for("share",{of:[documents,documentRevisions]});
  const [selected]=await documentQuery;
  if(!selected || selected.document.latestRevisionId!==snapshot.revisionId || selected.document.latestBody!==selected.revision.body
    || selected.document.format!==selected.revision.format || selected.document.title!==selected.revision.title
    || nativeSha256({title:selected.revision.title,format:selected.revision.format,body:selected.revision.body})!==snapshot.contentSha256)
    throw conflict("The scoped document revision was changed or superseded",{code:"scoped_review_artifact_changed"});
  return selected;
}

/** Native finalization consumes a draft only after its accepted result names
 * the configured independent Reviewer. No arbitrary artifact hash is trusted.
 */
export async function previewNativeScopedReview(db:Db,input:{companyId:string;issueId:string;runId:string;assessmentId:string;decision:NativeStatusDecision}) {
  const [issue]=await db.select().from(issues).where(and(eq(issues.id,input.issueId),eq(issues.companyId,input.companyId)));
  const policy=normalizeIssueExecutionPolicy(issue?.executionPolicy);
  if(!issue || policy?.totalReviewCycles!==5) return null;
  const [scope]=await db.select().from(issueScopedReviews).where(and(eq(issueScopedReviews.companyId,input.companyId),eq(issueScopedReviews.issueId,input.issueId),
    eq(issueScopedReviews.state,"draft"),sql`${issueScopedReviews.snapshot}->>'builderRunId'=${input.runId}`));
  if(!scope) return null;
  const snapshot=scopedReviewSnapshotSchema.parse(scope.snapshot);
  const bindingEffects=input.decision.effects.filter(effect=>effect.kind==="bind_reviewer");
  if(bindingEffects.length!==1 || bindingEffects[0].ownerAgentId!==snapshot.reviewerAgentId || bindingEffects[0].ownerUserId)
    throw conflict("Finish this scoped request with one explicit review attention request for its configured Reviewer",{code:"scoped_review_native_attention_required"});
  if(input.decision.toStatus!=="in_review" || issue.assigneeAgentId!==snapshot.builderAgentId || issue.assigneeUserId || issue.executionWorkspaceId!==snapshot.executionWorkspaceId
    || issue.statusVersion!==snapshot.expectedStatusVersion || issue.workspaceBindingRevision!==snapshot.workspaceBindingRevision || nativeSha256(policy)!==snapshot.policySha256 || parseIssueExecutionState(issue.executionState)?.status==="pending")
    throw conflict("The scoped review's task, workspace or workflow changed before admission");
  const [bound]=await db.select({run:heartbeatRuns,result:nativeRunResults,assessment:workAssessments}).from(nativeRunFinalizations)
    .innerJoin(heartbeatRuns,eq(heartbeatRuns.id,nativeRunFinalizations.runId))
    .innerJoin(nativeRunResults,and(eq(nativeRunResults.id,nativeRunFinalizations.resultId),eq(nativeRunResults.runId,heartbeatRuns.id)))
    .innerJoin(workAssessments,and(eq(workAssessments.id,input.assessmentId),eq(workAssessments.resultId,nativeRunResults.id),eq(workAssessments.runId,heartbeatRuns.id)))
    .where(and(eq(nativeRunFinalizations.runId,input.runId),eq(nativeRunFinalizations.companyId,input.companyId),eq(nativeRunFinalizations.issueId,input.issueId)));
  if(!bound || bound.run.runtimeMode!=="native" || bound.run.agentId!==snapshot.builderAgentId || bound.run.nativeIssueId!==issue.id
    || bound.result.schemaStatus!=="accepted" || bound.result.companyId!==issue.companyId || bound.result.issueId!==issue.id || bound.result.completionContractId!==bound.run.completionContractId
    || bound.assessment.companyId!==issue.companyId || bound.assessment.issueId!==issue.id || bound.assessment.priorStatusVersion!==issue.statusVersion || bound.assessment.priorDecisionId!==issue.lastStatusDecisionId)
    throw conflict("Scoped admission requires its bound accepted native result and assessment");
  let execution:ReturnType<typeof parseNativeExecutionInput>;
  try {execution=parseNativeExecutionInput(bound.run.runnerProfileJson?.nativeExecutionInput);} catch {throw conflict("Pinned scope execution is unavailable");}
  if(nativeSha256(execution)!==snapshot.executionSha256) throw conflict("The source native execution changed after scope selection");
  await assertCurrentScopedArtifact(db,snapshot);
  const budget=await readReviewBudgetPreviewContext(db,input);
  return {scope,snapshot,issue,resultId:bound.result.id,assessmentId:bound.assessment.id,
    budgetSha256:nativeSha256(budget.reviewCycleBudget),now:new Date().toISOString()};
}


export const SCOPED_CONTROL_FIELDS=["status","assigneeAgentId","assigneeUserId","executionPolicy","projectId","projectWorkspaceId","executionWorkspaceId","executionWorkspacePreference","executionWorkspaceSettings","parentId"] as const;
export async function assertNoActiveScopedControlMutation(db:Db,issue:{id:string;companyId:string;executionPolicy:unknown},body:Record<string,unknown>) {
  if(normalizeIssueExecutionPolicy(issue.executionPolicy)?.totalReviewCycles!==5 || !SCOPED_CONTROL_FIELDS.some(key=>body[key]!==undefined)) return;
  const [active]=await db.select({id:issueScopedReviews.id}).from(issueScopedReviews).where(and(eq(issueScopedReviews.companyId,issue.companyId),eq(issueScopedReviews.issueId,issue.id),inArray(issueScopedReviews.state,["draft","pending","cancelling"])));
  if(active) throw conflict("Resolve or explicitly cancel the active scoped review before changing whole-task workflow",{code:"scoped_review_controls_pending",scopeId:active.id});
}

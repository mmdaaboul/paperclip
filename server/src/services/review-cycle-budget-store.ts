import { assertProtectedReviewSubmissionSupported } from "./review-cycle-protected-reviewer.js";
import { sql, type SQL } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import { issueReviewCycleBudgetSchema, scopedReviewSnapshotSchema, type ScopedReviewSnapshot, type IssueReviewCycleBudget } from "@paperclipai/shared";
import { admitReviewCycle, createReviewCycleBudget } from "./total-review-budget.js";
import { nativeSha256 } from "./native-runtime/canonical.js";
import { parseIssueExecutionState } from "./issue-execution-policy.js";
import { conflict, notFound } from "../errors.js";
import { applyIssueExecutionPolicyTransition, normalizeIssueExecutionPolicy, type TransitionInput, type TransitionResult } from "./issue-execution-policy.js";

export interface ReviewBudgetTransaction {
  execute(query: SQL): PromiseLike<unknown>;
}

/** Native postgres-js returns RowList arrays; node-pg fixtures return { rows }. */
function resultRows(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Array.isArray((value as { rows?: unknown }).rows)) return (value as { rows: unknown[] }).rows;
  throw new Error("Unsupported review budget SQL result shape");
}
// This is a call-composition guard, not durable ownership. PostgreSQL's task and
// ledger row locks/transaction own all accounting; the guard only prevents an
// unadapted native setter from bypassing that already-locked callback.
const activeBudgetCallbacks = new WeakMap<object, Set<string>>();
const scopeKey = (companyId: string, issueId: string) => `${companyId}:${issueId}`;

export function assertReviewBudgetMutationTransaction(
  tx: object,
  existing: { id: string; companyId: string; status: string; assigneeAgentId?: string | null; assigneeUserId?: string | null; executionPolicy?: unknown; executionState?: unknown },
  patch: Record<string, unknown>,
) {
  const previous = existing.executionPolicy as { totalReviewCycles?: unknown } | null;
  const next = patch.executionPolicy === undefined ? previous : patch.executionPolicy as { totalReviewCycles?: unknown } | null;
  if (previous?.totalReviewCycles !== 5 && next?.totalReviewCycles !== 5) return;
  const withoutMonitor = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const { monitor: _monitor, ...retained } = value as Record<string, unknown>; return retained;
  };
  const controlsChanged = (patch.status !== undefined && patch.status !== existing.status)
    || (patch.assigneeAgentId !== undefined && patch.assigneeAgentId !== existing.assigneeAgentId)
    || (patch.assigneeUserId !== undefined && patch.assigneeUserId !== existing.assigneeUserId)
    || (patch.executionPolicy !== undefined && !isDeepStrictEqual(withoutMonitor(patch.executionPolicy), withoutMonitor(existing.executionPolicy)))
    || (patch.executionState !== undefined && !isDeepStrictEqual(withoutMonitor(patch.executionState), withoutMonitor(existing.executionState)));
  if (controlsChanged && !activeBudgetCallbacks.get(tx)?.has(scopeKey(existing.companyId, existing.id))) {
    throw conflict("This mutation path must use the locked task-wide review budget adapter", { code: "total_review_adapter_required" });
  }
}

/** Read-only prediction for native precommit authorization/stop decisions.
 * It is never commit authority; the locked consumer below recomputes it.
 */
export async function readReviewBudgetPreviewContext(db: ReviewBudgetTransaction, input: { companyId: string; issueId: string }) {
  const rows = await db.execute(sql`select ledger from issue_review_cycle_budgets where issue_id = ${input.issueId} and company_id = ${input.companyId}`);
  const row = resultRows(rows)[0] as { ledger: unknown } | undefined;
  const budget = row ? issueReviewCycleBudgetSchema.parse(row.ledger) : null;
  return { reviewCycleBudget: budget, reviewCycleInitializationAuthorized: !row && !await hasPriorReviewHistory(db, input) };
}

type BudgetScope = {companyId:string;issueId:string};
/** A new ledger may not erase either legacy stages or native interaction
 * reviews. Ordinary status decisions are not substantive review usage. */
async function hasPriorReviewHistory(db: ReviewBudgetTransaction, input: BudgetScope) {
  const rows = await db.execute(sql`select id from (
    select id from issue_execution_decisions where issue_id=${input.issueId} and company_id=${input.companyId}
    union all
    select id from issue_thread_interactions where issue_id=${input.issueId} and company_id=${input.companyId}
      and kind='request_confirmation' and payload->'target'->>'key' in ('native_completion_review','scoped_review')
    union all
    select e.id from status_decision_effects e join status_decisions d on d.id=e.decision_id
      where d.issue_id=${input.issueId} and d.company_id=${input.companyId} and e.effect_kind='bind_reviewer'
  ) history limit 1`);
  return resultRows(rows).length > 0;
}


type BudgetRow = {revision:string|number;ledger:unknown};
async function loadLockedBudget(tx:ReviewBudgetTransaction,input:BudgetScope) {
  const taskRows = await tx.execute(sql`select id, company_id as "companyId", status,
    assignee_agent_id as "assigneeAgentId", assignee_user_id as "assigneeUserId",
    responsible_user_id as "responsibleUserId", created_by_user_id as "createdByUserId",
    execution_policy as "executionPolicy", execution_state as "executionState",
    monitor_next_check_at as "monitorNextCheckAt", monitor_wake_requested_at as "monitorWakeRequestedAt",
    monitor_last_triggered_at as "monitorLastTriggeredAt", monitor_attempt_count as "monitorAttemptCount",
    monitor_notes as "monitorNotes", monitor_scheduled_by as "monitorScheduledBy"
    from issues where id = ${input.issueId} and company_id = ${input.companyId} for update`);
  const issue = resultRows(taskRows)[0] as TransitionInput["issue"] | undefined;
  if (!issue) throw notFound("Task not found");
  const stored = await tx.execute(sql`select revision, ledger from issue_review_cycle_budgets
    where issue_id = ${input.issueId} and company_id = ${input.companyId} for update`);
  const row = resultRows(stored)[0] as BudgetRow | undefined;
  const budget = row ? issueReviewCycleBudgetSchema.parse(row.ledger) : null;
  if (budget && (budget.companyId !== input.companyId || budget.issueId !== input.issueId)) throw conflict("Stored review budget identity mismatch");
  return {issue,row,budget};
}

async function persistLockedBudget(tx:ReviewBudgetTransaction,input:BudgetScope,row:BudgetRow|undefined,budget:IssueReviewCycleBudget) {
  const encoded=JSON.stringify(budget);
  const write=row ? await tx.execute(sql`update issue_review_cycle_budgets set ledger=${encoded}::jsonb,
    revision=revision+1,updated_at=now() where issue_id=${input.issueId} and company_id=${input.companyId}
    and revision=${row.revision} returning issue_id`) : await tx.execute(sql`insert into issue_review_cycle_budgets
    (issue_id,company_id,revision,ledger) values(${input.issueId},${input.companyId},1,${encoded}::jsonb)
    on conflict(issue_id) do nothing returning issue_id`);
  if(resultRows(write).length!==1) throw conflict("Review budget changed concurrently; reload the task");
}
async function withBudgetCallback<T>(tx:ReviewBudgetTransaction,input:BudgetScope,work:()=>Promise<T>):Promise<T> {
  const key=scopeKey(input.companyId,input.issueId),active=activeBudgetCallbacks.get(tx)??new Set<string>();
  const alreadyActive=active.has(key); active.add(key);activeBudgetCallbacks.set(tx,active);
  try {return await work();} finally {if(!alreadyActive) active.delete(key);if(!active.size)activeBudgetCallbacks.delete(tx);}
}

/** Only the native setter's actual nested savepoint may inherit an already
 * active parent callback for this same task. No root/unrelated callback gains
 * authority; PostgreSQL still owns locks and outer transaction settlement. */
export function withInheritedReviewBudgetMutationTransaction<T>(parent:object,child:ReviewBudgetTransaction,input:BudgetScope,work:()=>Promise<T>):Promise<T> {
  return activeBudgetCallbacks.get(parent)?.has(scopeKey(input.companyId,input.issueId))
    ? withBudgetCallback(child,input,work):work();
}

/** Caller owns a real transaction. Native state/decision/audit callback uses it too.
 * Task row is locked before ledger row, matching native issue mutation ownership.
 */
export async function applyLockedReviewBudgetTransition(
  tx: ReviewBudgetTransaction,
  input: { companyId: string; issueId: string; transition: Omit<TransitionInput, "issue" | "reviewCycleBudget" | "policy"> & { policy?: TransitionInput["policy"] }; expectedPreview?: TransitionResult; expectedStoredPolicy?: TransitionInput["policy"];scopedControlMutation?:boolean },
  persistNativeTransition: (tx: ReviewBudgetTransaction, issue: TransitionInput["issue"], result: TransitionResult) => Promise<void>,
): Promise<TransitionResult> {
  const {issue,row,budget}=await loadLockedBudget(tx,input);
  const previousPolicy = normalizeIssueExecutionPolicy(issue.executionPolicy ?? null);
  if(input.expectedStoredPolicy!==undefined && !isDeepStrictEqual(previousPolicy,input.expectedStoredPolicy))
    throw conflict("The configured review policy changed during this request; reload before retrying",{code:"review_budget_policy_changed"});
  const controlsRequested=input.scopedControlMutation || input.transition.requestedStatus!==undefined || Object.values(input.transition.requestedAssigneePatch).some(value=>value!==undefined)
    || input.transition.policy!==undefined && !isDeepStrictEqual(input.transition.policy,previousPolicy);
  if(previousPolicy?.totalReviewCycles===5 && controlsRequested) {
    const activeScope=await tx.execute(sql`select id from issue_scoped_reviews where issue_id=${input.issueId} and company_id=${input.companyId}
      and state in ('draft','pending','cancelling') limit 1 for share`);
    if(resultRows(activeScope).length) throw conflict("Resolve or explicitly cancel the active scoped review before changing whole-task workflow",{code:"scoped_review_controls_pending"});
  }
  const selectedPolicy = input.transition.policy === undefined ? previousPolicy : input.transition.policy;
  if (!row && selectedPolicy?.totalReviewCycles === 5) {
    if (await hasPriorReviewHistory(tx, input)) throw conflict("Existing review history requires explicit reconciliation; a fresh allowance cannot replace it");
  }
  if(input.transition.reviewCycleAllowance) {
    const settling=await tx.execute(sql`select r.id from issue_scoped_reviews s join heartbeat_runs r on r.id=s.verdict_run_id
      join issues i on i.id=s.issue_id where s.company_id=${input.companyId} and s.issue_id=${input.issueId} and s.state='held'
      and (r.status in ('running','queued') or i.execution_run_id=r.id) limit 1 for share of r`);
    if(resultRows(settling).length) throw conflict("The Reviewer execution is still settling; retry the allowance after its native turn finishes",{code:"scoped_review_execution_settling"});
  }
  const admission = input.transition.reviewCycleAdmission;
  if (admission) {
    // A route actor or client receipt alone cannot invent a Builder observation.
    // Native Stop authorization is still checked by the existing task setter;
    // its intentional self-handoff may already have marked this run cancelled.
    const observed = await tx.execute(sql`select id from heartbeat_runs where id = ${admission.builderRunId}
      and company_id = ${input.companyId} and agent_id = ${admission.builderAgentId}
      and coalesce(native_issue_id::text, issue_id::text,
        case when jsonb_typeof(context_snapshot->'issueId') = 'string' then nullif(btrim(context_snapshot->>'issueId'), '') end,
        case when jsonb_typeof(context_snapshot->'taskId') = 'string' then nullif(btrim(context_snapshot->>'taskId'), '') end) = ${input.issueId}
      for share`);
    if (resultRows(observed).length !== 1) throw conflict("Review submission has no matching native Builder run observation", { code: "review_builder_observation_missing" });
  }
  const result = applyIssueExecutionPolicyTransition({ ...input.transition, issue, reviewCycleBudget: budget,
    previousPolicy, policy: selectedPolicy, reviewCycleInitializationAuthorized: !row });
  const comparable = (transition: TransitionResult) => {
    const copy = structuredClone(transition);
    const state = copy.patch.executionState as { monitor?: { status?: string; clearedAt?: unknown } } | null | undefined;
    // Native monitor bounds still recheck the actual commit time. Only the
    // non-authoritative timestamp of the same clear event may differ.
    if (state?.monitor?.status === "cleared") state.monitor.clearedAt = "checked-at-commit";
    return copy;
  };
  if (input.expectedPreview && !isDeepStrictEqual(comparable(result), comparable(input.expectedPreview))) {
    throw conflict("The review task or budget changed during this request; reload before retrying", { code: "review_budget_transition_changed" });
  }
  await assertProtectedReviewSubmissionSupported(tx,{companyId:input.companyId,issueId:input.issueId,admission:input.transition.reviewCycleAdmission,result,lock:true});
  if(result.reviewCycleBudget) await persistLockedBudget(tx,input,row,result.reviewCycleBudget);
  // All native task/decision/audit effects stay in this same guarded transaction.
  await withBudgetCallback(tx,input,()=>persistNativeTransition(tx,issue,result));
  return result;
}

export function parseStoredReviewCycleBudget(value: unknown): IssueReviewCycleBudget {
  return issueReviewCycleBudgetSchema.parse(value);
}


/** Dedicated scoped consumer shares the SAME task/ledger owner; it never calls
 * the whole-task transition with a scoped label or silently rewrites history.
 * Native decision/result ownership and the immutable scope are checked here.
 */
export async function withLockedScopedReviewBudget<T>(
  tx:ReviewBudgetTransaction,
  input:BudgetScope & {scopeId:string;expectedSnapshot:ScopedReviewSnapshot;expectedBudgetSha256?:string;now:string;operation:
    | {kind:"admit";sourceDecisionId:string;assessmentId:string;resultId:string}
    | {kind:"resolve";reviewerAgentId:string;reviewerRunId:string}
    | {kind:"cancel";requestId:string;userId:string}},
  work:(context:{tx:ReviewBudgetTransaction;issue:TransitionInput["issue"];budget:IssueReviewCycleBudget;scope:{state:string;version:string|number;interactionId:string|null;sourceDecisionId:string|null};duplicate:boolean})=>Promise<T>,
):Promise<T> {
  const {issue,row,budget:storedBudget}=await loadLockedBudget(tx,input);
  const policy=normalizeIssueExecutionPolicy(issue.executionPolicy);
  if(input.operation.kind!=="cancel" && (policy?.totalReviewCycles!==5 || nativeSha256(policy)!==input.expectedSnapshot.policySha256))
    throw conflict("The scoped review's configured workflow changed",{code:"scoped_review_policy_changed"});
  const scopedRows=await tx.execute(sql`select snapshot,state,version,interaction_id as "interactionId",source_decision_id as "sourceDecisionId",cancellation
    from issue_scoped_reviews where id=${input.scopeId} and issue_id=${input.issueId} and company_id=${input.companyId} for update`);
  const scope=resultRows(scopedRows)[0] as {snapshot:unknown;state:string;version:string|number;interactionId:string|null;sourceDecisionId:string|null;cancellation:{requestId?:string;requestedByUserId?:string}|null}|undefined;
  if(!scope) throw notFound("Scoped review not found");
  const snapshot=scopedReviewSnapshotSchema.parse(scope.snapshot);
  if(!isDeepStrictEqual(snapshot,input.expectedSnapshot) || snapshot.id!==input.scopeId || snapshot.companyId!==input.companyId || snapshot.issueId!==input.issueId)
    throw conflict("The scoped review's immutable binding changed");
  let budget=storedBudget;
  if(!budget) {
    const state=parseIssueExecutionState(issue.executionState);
    const hasHistory=await hasPriorReviewHistory(tx,input);
    if(input.operation.kind!=="admit" || hasHistory || state && (state.status!=="idle" || state.lastDecisionId || state.completedStageIds.length))
      throw conflict("Historical review usage cannot be replaced by a new scoped allowance");
    budget=createReviewCycleBudget(input.companyId,input.issueId);
  }
  let duplicate=false;
  if(input.operation.kind==="admit") {
    const proof=input.operation;
    const historicalAdmission=storedBudget?.admissions.find(admission=>admission.id===snapshot.id);
    if(!historicalAdmission && input.expectedBudgetSha256!==undefined && nativeSha256(storedBudget)!==input.expectedBudgetSha256)
      throw conflict("The shared review budget changed during scoped admission",{code:"scoped_review_budget_changed"});
    if(!["draft","pending"].includes(scope.state) || scope.sourceDecisionId && scope.sourceDecisionId!==proof.sourceDecisionId)
      throw conflict("This scoped request is no longer available for this native result");
    const observations=await tx.execute(sql`select r.id from heartbeat_runs r
      join native_run_results result on result.run_id=r.id and result.id=${proof.resultId}
      join work_assessments assessment on assessment.id=${proof.assessmentId} and assessment.result_id=result.id and assessment.run_id=r.id
      join status_decisions decision on decision.id=${proof.sourceDecisionId} and decision.assessment_id=assessment.id and decision.run_id=r.id
      where r.id=${snapshot.builderRunId} and r.company_id=${input.companyId} and r.agent_id=${snapshot.builderAgentId}
        and r.native_issue_id=${input.issueId} and r.runtime_mode='native'
        and result.company_id=${input.companyId} and result.issue_id=${input.issueId} and result.schema_status='accepted'
        and result.completion_contract_id=r.completion_contract_id
        and assessment.company_id=${input.companyId} and assessment.issue_id=${input.issueId}
        and decision.company_id=${input.companyId} and decision.issue_id=${input.issueId}
        and decision.decision_json->'scopedReview'->>'id'=${input.scopeId}
        and decision.decision_json->'scopedReview'->>'contentSha256'=${snapshot.contentSha256}
      for share of r,result,assessment,decision`);
    if(resultRows(observations).length!==1) throw conflict("Scoped admission requires the accepted native Builder result, assessment and decision");
    const admitted=admitReviewCycle(budget,{id:snapshot.id,companyId:input.companyId,issueId:input.issueId,builderAgentId:snapshot.builderAgentId,
      builderRunId:snapshot.builderRunId,candidateId:`document-revision:${snapshot.revisionId}:${snapshot.contentSha256}`,kind:"scoped",scopeId:snapshot.id},input.now);
    budget=admitted.budget;duplicate=admitted.duplicate;
    if(duplicate && scope.state!=="pending") throw conflict("A historical scope admission cannot start another review");
    if(!duplicate) await persistLockedBudget(tx,input,row,budget);
  } else if(input.operation.kind==="cancel") {
    if(scope.state!=="cancelling" || scope.cancellation?.requestId!==input.operation.requestId || scope.cancellation.requestedByUserId!==input.operation.userId
      || !budget.admissions.some(admission=>admission.id===snapshot.id && admission.kind==="scoped")) throw conflict("No admitted cancellation intent belongs to this user");
    const live=await tx.execute(sql`select id from heartbeat_runs where company_id=${input.companyId} and agent_id=${snapshot.reviewerAgentId}
      and coalesce(native_issue_id,issue_id)=${input.issueId} and context_snapshot->>'nativeReviewInteractionId'=${scope.interactionId}
      and status in ('queued','running') limit 1 for share`);
    if(resultRows(live).length) throw conflict("The scoped Reviewer has not confirmed native Stop");
  } else {
    if(scope.state!=="pending" || snapshot.reviewerAgentId!==input.operation.reviewerAgentId || !scope.interactionId || !scope.sourceDecisionId
      || !budget.admissions.some(admission=>admission.id===snapshot.id && admission.kind==="scoped" && admission.scopeId===snapshot.id))
      throw conflict("No admitted scoped review is pending for this Reviewer");
    const reviewer=await tx.execute(sql`select id from heartbeat_runs where id=${input.operation.reviewerRunId} and company_id=${input.companyId}
      and agent_id=${snapshot.reviewerAgentId} and native_issue_id=${input.issueId} and runtime_mode='native' and status='running'
      and context_snapshot->>'nativeReviewInteractionId'=${scope.interactionId}
      and context_snapshot->>'nativeReviewDecisionId'=${scope.sourceDecisionId} for share`);
    if(resultRows(reviewer).length!==1) throw conflict("Scoped decision requires the admitted native Reviewer run");
  }
  return withBudgetCallback(tx,input,()=>work({tx,issue,budget:budget!,scope,duplicate}));
}

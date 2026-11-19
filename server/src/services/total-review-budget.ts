import { isDeepStrictEqual } from "node:util";
import {
  issueExecutionStateSchema,
  issueReviewCycleBudgetSchema,
  reviewCycleAllowanceRequestSchema,
  reviewCycleBudgetAvailable,
  reviewCycleSubmissionSchema,
  type IssueExecutionState,
  type IssueReviewCycleBudget,
  type ReviewCycleAllowanceRequest,
  type ReviewCycleSubmission,
} from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import type { TransitionInput, TransitionResult } from "./issue-execution-policy.js";

function state(value: unknown): IssueExecutionState | null {
  if (value == null) return null;
  const result = issueExecutionStateSchema.safeParse(value);
  if (!result.success) throw unprocessable("Malformed execution state cannot establish a review budget");
  return result.data;
}

export function createReviewCycleBudget(companyId: string, issueId: string): IssueReviewCycleBudget {
  return issueReviewCycleBudgetSchema.parse({ schemaVersion: 1, companyId, issueId, initialAllowance: 5, admissions: [], allowances: [] });
}

function sameSubmission(previous: IssueReviewCycleBudget["admissions"][number], next: ReviewCycleSubmission): boolean {
  const { admittedAt: _timestamp, ...receipt } = previous;
  return isDeepStrictEqual(receipt, next);
}

/** The caller must derive the receipt from the admitted task/candidate/run. */
export function admitReviewCycle(budgetInput: IssueReviewCycleBudget, submissionInput: ReviewCycleSubmission, now: string) {
  const budget = issueReviewCycleBudgetSchema.parse(budgetInput);
  const submission = reviewCycleSubmissionSchema.parse(submissionInput);
  if (submission.companyId !== budget.companyId || submission.issueId !== budget.issueId) throw unprocessable("Review submission belongs to another task");
  const previous = budget.admissions.find(admission => admission.id === submission.id);
  if (previous) {
    if (!sameSubmission(previous, submission)) throw unprocessable("Review submission receipt was reused for a different candidate");
    return { budget, duplicate: true };
  }
  if (reviewCycleBudgetAvailable(budget) <= 0) throw unprocessable("Review cycle allowance is exhausted; explicit human allowance is required", { code: "review_cycle_budget_exhausted" });
  const next = issueReviewCycleBudgetSchema.parse({ ...budget, admissions: [...budget.admissions, { ...submission, admittedAt: now }] });
  return { budget: next, duplicate: false };
}

/** Human identity/authority come from native authorization, never request fields. */
export function grantReviewCycles(budgetInput: IssueReviewCycleBudget, requestInput: ReviewCycleAllowanceRequest,
  actor: { userId?: string | null; agentId?: string | null }, authorized: boolean, now: string): IssueReviewCycleBudget {
  if (!authorized || actor.agentId || !actor.userId) throw unprocessable("Only an authorized human can grant additional review cycles");
  const budget = issueReviewCycleBudgetSchema.parse(budgetInput), request = reviewCycleAllowanceRequestSchema.parse(requestInput);
  const previous = budget.allowances.find(allowance => allowance.id === request.id);
  if (previous) {
    if (previous.grantedByUserId !== actor.userId || previous.additionalCycles !== request.additionalCycles || previous.reason !== request.reason) {
      throw unprocessable("Review allowance receipt was reused with different approval");
    }
    return budget;
  }
  return issueReviewCycleBudgetSchema.parse({ ...budget, allowances: [...budget.allowances,
    { ...request, grantedByUserId: actor.userId, grantedAt: now }] });
}

function projected(result: TransitionResult, budget: IssueReviewCycleBudget, previous: IssueExecutionState | null): TransitionResult {
  const current = result.patch.executionState === undefined ? previous : result.patch.executionState;
  if (current && typeof current === "object") result.patch.executionState = { ...current,
    totalReviewCyclesUsed: budget.admissions.length,
    totalReviewCycleAllowance: budget.admissions.length + reviewCycleBudgetAvailable(budget) };
  return { ...result, reviewCycleBudget: budget };
}

/** Wrap the actual native stage/monitor transition; persistence stays with its caller. */
export function applyTotalReviewBudgetTransition(input: TransitionInput, nativeTransition: (input: TransitionInput) => TransitionResult): TransitionResult {
  const enabled = input.policy?.totalReviewCycles === 5;
  if (enabled && input.reviewCycleBudget === undefined && !input.reviewCycleInitializationAuthorized) {
    throw unprocessable("This mutation path must use the task-wide review budget adapter", { code: "total_review_adapter_required" });
  }
  let budget = input.reviewCycleBudget == null ? null : issueReviewCycleBudgetSchema.parse(input.reviewCycleBudget);
  if (budget && (budget.companyId !== input.issue.companyId || budget.issueId !== input.issue.id)) throw unprocessable("Review budget belongs to another task");
  if (!enabled) {
    if (input.actor.agentId && (input.previousPolicy?.totalReviewCycles === 5
      || (input.issue.executionPolicy as { totalReviewCycles?: number } | null)?.totalReviewCycles === 5)) throw unprocessable("An agent cannot remove task-wide review budget enforcement");
    const result = nativeTransition(input);
    return { ...result, ...(budget ? { reviewCycleBudget: budget } : {}) };
  }
  const finalStage = input.policy!.stages.at(-1);
  const selectedApprover = finalStage?.type === "approval" ? finalStage.participants.find(participant => participant.type === "user")?.userId : null;
  if (!selectedApprover) throw unprocessable("Task-wide independent review requires a final configured human approver");
  const existing = state(input.issue.executionState);
  if (!input.issue.companyId || !input.issue.id) throw unprocessable("Task-wide review budget requires task identity");
  if (!budget) {
    if (!input.reviewCycleInitializationAuthorized) throw unprocessable("Initial review allowance requires native history reconciliation");
    if (existing && (existing.status !== "idle" || existing.lastDecisionId || existing.completedStageIds.length)) {
      throw unprocessable("Existing review history requires an explicitly reconciled budget; it cannot be reset to five");
    }
    budget = createReviewCycleBudget(input.issue.companyId, input.issue.id);
  }
  const now = input.reviewCycleNow ?? new Date().toISOString();
  if (input.reviewCycleAllowance) {
    const storedPolicy=input.previousPolicy??input.issue.executionPolicy;
    if(!isDeepStrictEqual(storedPolicy,input.policy) || input.reviewRequest!==undefined || input.monitorExplicitlyUpdated || input.commentBody?.trim())throw unprocessable("A review allowance cannot change the selected workflow or other task fields");
    if (input.requestedStatus !== undefined || Object.values(input.requestedAssigneePatch).some(value => value !== undefined)) {
      throw unprocessable("A review allowance is a separate explicit operation");
    }
    const selectedHuman = existing?.currentParticipant?.type === "user" ? existing.currentParticipant.userId
      : selectedApprover;
    if (input.actor.userId !== selectedHuman) throw unprocessable("Only the selected human can extend this review allowance");
    budget = grantReviewCycles(budget, input.reviewCycleAllowance.request, input.actor, input.reviewCycleAllowance.authorized, now);
    if (existing?.totalReviewBudgetHold && reviewCycleBudgetAvailable(budget) > 0) {
      if (!existing.returnAssignee) throw unprocessable("Review budget hold has no Builder to return to");
      return projected({ patch: { status: "in_progress", assigneeAgentId: existing.returnAssignee.agentId ?? null,
        assigneeUserId: existing.returnAssignee.userId ?? null,
        executionState: { ...existing, status: "changes_requested", totalReviewBudgetHold: false } },
        workflowControlledAssignment: true }, budget, existing);
    }
    return projected({ patch: {} }, budget, existing);
  }
  const submission = input.reviewCycleAdmission;
  if (submission) {
    if (submission.kind === "scoped") throw unprocessable("Scoped review must use its parent-linked partial-review transition");
    if (input.actor.agentId && (submission.builderAgentId !== input.actor.agentId || submission.builderRunId !== input.actor.runId)) {
      throw unprocessable("Review submission does not match the authenticated Builder run");
    }
    if (!input.actor.agentId && !input.reviewCycleHumanSubmissionAuthorized) throw unprocessable("Human review submission requires native candidate authorization");
    const last = budget.admissions.at(-1);
    if (existing?.status === "pending" && last?.id === submission.id && sameSubmission(last, submission)
      && (input.requestedStatus === "done" || input.requestedStatus === "in_review")) {
      return projected({ patch: { status: input.issue.status, assigneeAgentId: input.issue.assigneeAgentId ?? null,
        assigneeUserId: input.issue.assigneeUserId ?? null }, workflowControlledAssignment: true }, budget, existing);
    }
  }
  // A corrected candidate traverses the configured review chain from its start.
  // Previous decisions remain in native history; only current candidate markers reset.
  const freshReview = existing?.status === "changes_requested" && (input.requestedStatus === "done" || input.requestedStatus === "in_review");
  const nextInput: TransitionInput = { ...input,
    issue: freshReview ? { ...input.issue, executionState: { ...existing, currentStageId: null,
      currentStageIndex: null, currentStageType: null, currentParticipant: null, completedStageIds: [], totalReviewBudgetHold: false } } : input.issue };
  const result = nativeTransition(nextInput);
  const nextState = state(result.patch.executionState);
  const entersReview = existing?.status !== "pending" && nextState?.status === "pending";
  if (entersReview) {
    if (nextState?.currentParticipant?.type !== "agent" || nextState.currentStageType !== "review"
      || nextState.currentParticipant.agentId === nextState.returnAssignee?.agentId) throw unprocessable("Task-wide review requires an independent configured Reviewer");
    if (!submission) throw unprocessable("A trusted idempotent review submission receipt is required");
    if (nextState.returnAssignee?.type !== "agent" || nextState.returnAssignee.agentId !== submission.builderAgentId) throw unprocessable("Review submission does not match the return Builder");
    const admission = admitReviewCycle(budget, submission, now);
    if (admission.duplicate) throw unprocessable("A completed review submission cannot start another review cycle");
    budget = admission.budget;
  }
  if (result.decision?.outcome === "changes_requested" && reviewCycleBudgetAvailable(budget) === 0) {
    const human = selectedApprover;
    if (!human || !nextState) throw unprocessable("Exhausted review requires a configured human approver");
    result.patch = { ...result.patch, status: "in_review", assigneeAgentId: null, assigneeUserId: human,
      executionState: { ...nextState, status: "pending", currentParticipant: { type: "user", userId: human, agentId: null }, totalReviewBudgetHold: true } };
    result.workflowControlledAssignment = true;
  }
  return projected(result, budget, existing);
}

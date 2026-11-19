import { describe, expect, it } from "vitest";
import { applyIssueExecutionPolicyTransition, normalizeIssueExecutionPolicy, parseIssueExecutionState, type TransitionInput } from "../services/issue-execution-policy.js";
import { applyIssueExecutionPolicyTransition as baselineTransition } from "./fixtures/issue-execution-policy.1117-baseline.js";
import { admitReviewCycle, createReviewCycleBudget, grantReviewCycles } from "../services/total-review-budget.js";
import { reviewCycleBudgetAvailable, type IssueExecutionPolicy, type IssueReviewCycleBudget, type ReviewCycleSubmission } from "@paperclipai/shared";

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const companyId = id(1), issueId = id(2), builder = id(3), reviewer = id(4), owner = "selected-human";
const now = "2026-11-15T00:00:00.000Z";
function policy(): IssueExecutionPolicy {
  return normalizeIssueExecutionPolicy({ totalReviewCycles: 5, stages: [
    { id: id(5), type: "review", participants: [{ id: id(6), type: "agent", agentId: reviewer }] },
    { id: id(7), type: "approval", participants: [{ id: id(8), type: "user", userId: owner }] },
  ] })!;
}
function submission(n: number, kind: "normal" | "scoped" = "normal"): ReviewCycleSubmission {
  return { id: id(100 + n), companyId, issueId, builderAgentId: builder, builderRunId: id(200 + n), candidateId: `candidate-sha-${n}`, kind, scopeId: kind === "scoped" ? `artifact-${n}` : null };
}
function fixture() {
  let selected = policy();
  let issue: TransitionInput["issue"] = { id: issueId, companyId, status: "in_progress", assigneeAgentId: builder, assigneeUserId: null,
    responsibleUserId: "different-responsible-human", createdByUserId: "creator", executionPolicy: selected, executionState: null };
  let budget: IssueReviewCycleBudget | null = null;
  const decisions: unknown[] = [];
  function step(input: Partial<Omit<TransitionInput, "issue">>) {
    const full: TransitionInput = { issue, policy: selected, requestedAssigneePatch: {}, actor: {}, reviewCycleBudget: budget, reviewCycleInitializationAuthorized: budget === null, reviewCycleNow: now, ...input };
    const result = applyIssueExecutionPolicyTransition(full);
    if (result.decision) decisions.push(result.decision);
    budget = result.reviewCycleBudget ?? budget;
    issue = { ...issue, ...(full.requestedStatus ? { status: full.requestedStatus } : {}), ...full.requestedAssigneePatch, ...result.patch } as TransitionInput["issue"];
    return result;
  }
  const submit = (n: number) => step({ actor: { agentId: builder, runId: submission(n).builderRunId }, requestedStatus: "done", reviewCycleAdmission: submission(n) });
  const changes = () => step({ actor: { agentId: reviewer, runId: id(900) }, requestedStatus: "in_progress", commentBody: "Needs correction" });
  return { step, submit, changes, get issue() { return issue; }, get budget() { return budget!; }, get decisions() { return decisions; },
    setPolicy(next: IssueExecutionPolicy) { selected = next; issue = { ...issue, executionPolicy: next }; } };
}

describe("native transition with a single configured Reviewer and task-total budget", () => {
  it("counts the initial submission and returns to the same one Reviewer", () => {
    const f = fixture(); f.submit(1);
    expect(f.budget.admissions).toHaveLength(1);
    expect(f.issue.assigneeAgentId).toBe(reviewer);
    f.changes(); f.submit(2);
    expect(f.budget.admissions).toHaveLength(2);
    expect(f.issue.assigneeAgentId).toBe(reviewer);
  });
  it("admits exactly five initial-inclusive cycles and holds unresolved fifth for the configured human", () => {
    const f = fixture();
    for (let n = 1; n <= 5; n++) { f.submit(n); f.changes(); expect(f.budget.admissions).toHaveLength(n); }
    expect(f.issue.status).toBe("in_review");
    expect(f.issue.assigneeAgentId).toBeNull();
    expect(f.issue.assigneeUserId).toBe(owner);
    expect(parseIssueExecutionState(f.issue.executionState)?.totalReviewBudgetHold).toBe(true);
    expect(reviewCycleBudgetAvailable(f.budget)).toBe(0);
    expect(() => f.submit(6)).toThrow();
    expect(f.budget.admissions).toHaveLength(5);
    expect(f.decisions).toHaveLength(5);
  });
  it("can approve the fifth cycle normally without granting extra cycles", () => {
    const f = fixture();
    for (let n = 1; n < 5; n++) { f.submit(n); f.changes(); }
    f.submit(5);
    f.step({ actor: { agentId: reviewer }, requestedStatus: "done", commentBody: "Pass" });
    expect(f.issue.assigneeUserId).toBe(owner);
    f.step({ actor: { userId: owner }, requestedStatus: "done", commentBody: "Accepted" });
    expect(f.issue.status).toBe("done");
    expect(f.budget.admissions).toHaveLength(5);
    expect(f.budget.allowances).toHaveLength(0);
  });
  it("human changes require fresh configured review without resetting total history", () => {
    const f = fixture(); f.submit(1);
    f.step({ actor: { agentId: reviewer }, requestedStatus: "done", commentBody: "Review passed" });
    expect(parseIssueExecutionState(f.issue.executionState)?.completedStageIds).toContain(id(5));
    f.step({ actor: { userId: owner }, requestedStatus: "in_progress", commentBody: "Revise this candidate" });
    f.submit(2);
    expect(f.issue.assigneeAgentId).toBe(reviewer);
    expect(parseIssueExecutionState(f.issue.executionState)?.completedStageIds).toEqual([]);
    expect(f.budget.admissions.map(x => x.candidateId)).toEqual(["candidate-sha-1", "candidate-sha-2"]);
    expect(f.decisions).toHaveLength(2);
  });
  it("does not count another agent review stage as a new Builder cycle", () => {
    const f = fixture(), next = policy();
    next.stages.splice(1, 0, { id: id(30), type: "review", approvalsNeeded: 1, participants: [{ id: id(31), type: "agent", agentId: id(32) }] });
    f.setPolicy(next); f.submit(1);
    f.step({ actor: { agentId: reviewer }, requestedStatus: "done", commentBody: "Pass" });
    expect(f.issue.assigneeAgentId).toBe(id(32)); expect(f.budget.admissions).toHaveLength(1);
    f.step({ actor: { agentId: id(32) }, requestedStatus: "done", commentBody: "Pass" });
    expect(f.issue.assigneeUserId).toBe(owner); expect(f.budget.admissions).toHaveLength(1);
  });
  it("keeps the human hold sticky through unrelated patches and human changes without allowance", () => {
    const f = fixture(); for (let n = 1; n <= 5; n++) { f.submit(n); f.changes(); }
    f.step({ actor: { agentId: builder } }); expect(f.issue.assigneeUserId).toBe(owner);
    f.step({ actor: { userId: owner }, requestedStatus: "in_progress", commentBody: "Still needs work" });
    expect(f.issue.assigneeUserId).toBe(owner); expect(f.budget.admissions).toHaveLength(5);
  });
  it("records an explicit selected-human allowance and releases only that many additional cycles", () => {
    const f = fixture(); for (let n = 1; n <= 5; n++) { f.submit(n); f.changes(); }
    const allowance = { request: { id: id(500), additionalCycles: 1, reason: "One additional correction" }, authorized: true };
    f.step({ actor: { userId: owner }, reviewCycleAllowance: allowance });
    expect(f.issue.assigneeAgentId).toBe(builder); expect(f.budget.allowances).toHaveLength(1);
    expect(f.budget.admissions).toHaveLength(5);
    f.step({ actor: { userId: owner }, reviewCycleAllowance: allowance });
    expect(f.budget.allowances).toHaveLength(1);
    f.submit(6); f.changes(); expect(f.issue.assigneeUserId).toBe(owner);
    expect(f.budget.admissions).toHaveLength(6); expect(() => f.submit(7)).toThrow();
  });
  it("does not reintroduce a hidden resetting-stage cap after a large explicit human allowance", () => {
    const f = fixture(); for (let n = 1; n <= 5; n++) { f.submit(n); f.changes(); }
    f.step({ actor: { userId: owner }, reviewCycleAllowance: { request: { id: id(599), additionalCycles: 50, reason: "Explicit extended review budget" }, authorized: true } });
    for (let n = 6; n <= 55; n++) {
      f.submit(n); f.changes();
      expect(f.issue.assigneeAgentId).toBe(n < 55 ? builder : null);
    }
    expect(f.budget.admissions).toHaveLength(55); expect(f.issue.assigneeUserId).toBe(owner);
  });
  it.each([{ agentId: builder }, { userId: "unselected-human" }, { userId: owner, agentId: builder }])("refuses an unauthorized allowance actor %j", actor => {
    const f = fixture(); f.submit(1);
    expect(() => f.step({ actor, reviewCycleAllowance: { request: { id: id(501), additionalCycles: 1, reason: "More" }, authorized: true } })).toThrow();
    expect(f.budget.allowances).toHaveLength(0);
  });
  it("requires native human authorization and a standalone allowance operation", () => {
    const f = fixture(); f.submit(1);
    expect(() => f.step({ actor: { userId: owner }, reviewCycleAllowance: { request: { id: id(502), additionalCycles: 1, reason: "More" }, authorized: false } })).toThrow();
    expect(() => f.step({ actor: { userId: owner }, requestedStatus: "done", reviewCycleAllowance: { request: { id: id(502), additionalCycles: 1, reason: "More" }, authorized: true } })).toThrow("separate");
  });
  it("deduplicates a technical submission retry while review is pending", () => {
    const f = fixture(); f.submit(1); const before = structuredClone(f.issue);
    const duplicate = f.submit(1);
    expect(duplicate.patch.status).toBe("in_review"); expect(f.issue).toEqual(before); expect(f.budget.admissions).toHaveLength(1);
  });
  it("cannot reuse a completed submission to obtain free independent review", () => {
    const f = fixture(); f.submit(1); f.changes();
    expect(() => f.submit(1)).toThrow("completed review submission");
    expect(f.budget.admissions).toHaveLength(1);
  });
  it("refuses absent, foreign, or non-current-run admission receipts", () => {
    const f = fixture();
    expect(() => f.step({ actor: { agentId: builder }, requestedStatus: "done" })).toThrow("receipt");
    for (const patch of [{ companyId: id(700) }, { issueId: id(700) }, { builderRunId: id(700) }]) {
      expect(() => f.step({ actor: { agentId: builder, runId: submission(1).builderRunId }, requestedStatus: "done", reviewCycleAdmission: { ...submission(1), ...patch } })).toThrow();
    }
  });
  it("retains ledger through policy removal/re-enable and refuses agent disable", () => {
    const f = fixture(); f.submit(1);
    expect(() => f.step({ actor: { agentId: builder }, policy: null })).toThrow("cannot remove");
    f.step({ actor: { userId: owner }, policy: null, allowBoardOverride: true });
    expect(f.budget.admissions).toHaveLength(1);
    f.submit(2); expect(f.budget.admissions).toHaveLength(2);
  });
  it("refuses initialization over existing review history rather than resetting it", () => {
    const f = fixture(); f.submit(1);
    expect(() => f.step({ actor: { agentId: reviewer }, reviewCycleBudget: null })).toThrow(/reconcil/);
  });
  it("refuses scopes pretending to be native whole-task review", () => {
    const f = fixture();
    expect(() => f.step({ actor: { agentId: builder, runId: submission(1).builderRunId }, requestedStatus: "done", reviewCycleAdmission: submission(1, "scoped") })).toThrow("partial-review");
  });
  it("requires configured independent review and final human approval", () => {
    const f = fixture(), next = policy(); next.stages = next.stages.slice(0, 1); f.setPolicy(next);
    expect(() => f.submit(1)).toThrow("final configured human");
    const sameAgent = policy(); sameAgent.stages[0].participants[0].agentId = builder; f.setPolicy(sameAgent);
    expect(() => f.submit(1)).toThrow("independent");
  });
  it("preserves exact native behavior when total-budget feature is absent", () => {
    const selected = policy(); delete selected.totalReviewCycles;
    const input: TransitionInput = { issue: { status: "in_progress", assigneeAgentId: builder, executionState: null }, policy: selected,
      requestedStatus: "done", requestedAssigneePatch: {}, actor: { agentId: builder } };
    expect(applyIssueExecutionPolicyTransition(input)).toEqual(baselineTransition(input));
  });
});

describe("shared parent task accounting for normal and scoped review receipts", () => {
  it("shares one initial-inclusive allowance regardless of scope labels or reviewer count", () => {
    let budget = createReviewCycleBudget(companyId, issueId);
    for (let n = 1; n <= 5; n++) budget = admitReviewCycle(budget, submission(n, n % 2 ? "scoped" : "normal"), now).budget;
    expect(reviewCycleBudgetAvailable(budget)).toBe(0);
    expect(() => admitReviewCycle(budget, { ...submission(6, "scoped"), scopeId: "renamed-scope" }, now)).toThrow("exhausted");
    expect(budget.admissions).toHaveLength(5);
  });
  it("deduplicates receipts but rejects reuse for different candidates", () => {
    const first = admitReviewCycle(createReviewCycleBudget(companyId, issueId), submission(1), now).budget;
    expect(admitReviewCycle(first, submission(1), now).duplicate).toBe(true);
    expect(() => admitReviewCycle(first, { ...submission(1), candidateId: "different" }, now)).toThrow("reused");
  });
  it("records allowances without rewriting previous usage and rejects altered allowance reuse", () => {
    const original = admitReviewCycle(createReviewCycleBudget(companyId, issueId), submission(1), now).budget;
    const request = { id: id(600), additionalCycles: 2, reason: "Review approved extension" };
    const extended = grantReviewCycles(original, request, { userId: owner }, true, now);
    expect(extended.admissions).toEqual(original.admissions); expect(original.allowances).toHaveLength(0);
    expect(grantReviewCycles(extended, request, { userId: owner }, true, now)).toEqual(extended);
    expect(() => grantReviewCycles(extended, { ...request, additionalCycles: 3 }, { userId: owner }, true, now)).toThrow("reused");
  });
});

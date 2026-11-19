import { describe, expect, it, vi } from "vitest";
import { normalReviewCycleSubmission } from "../services/review-cycle-http.js";
import { assertReviewBudgetMutationTransaction } from "../services/review-cycle-budget-store.js";
const id = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const issue = { id: id(1), companyId: id(2), status: "in_progress", assigneeAgentId: id(3), assigneeUserId: null, executionState: null };

describe("normal PATCH review submission authority", () => {
  it("uses the authenticated Builder run ID instead of an agent-supplied idempotency key", async () => {
    const lookup = vi.fn();
    const receipt = await normalReviewCycleSubmission({ issue, requestedStatus: "done", actor: { agentId: id(3), runId: id(4) }, clientSubmissionId: id(999), findObservedBuilderRun: lookup });
    expect(receipt).toMatchObject({ id: id(4), builderAgentId: id(3), builderRunId: id(4), companyId: id(2), issueId: id(1), kind: "normal", candidateId: `run:${id(4)}` });
    expect(lookup).not.toHaveBeenCalled();
  });
  it.each([{ agentId: id(3) }, { agentId: id(9), runId: id(4) }])("rejects a missing or foreign Builder-run actor %j", async actor => {
    await expect(normalReviewCycleSubmission({ issue, requestedStatus: "done", actor, findObservedBuilderRun: async () => id(4) })).rejects.toThrow("authenticated Builder");
  });
  it("binds manual intent to its explicit key and the observed Builder run", async () => {
    const lookup = vi.fn().mockResolvedValue(id(4));
    const receipt = await normalReviewCycleSubmission({ issue, requestedStatus: "in_review", actor: { userId: "owner" }, clientSubmissionId: id(5), findObservedBuilderRun: lookup });
    expect(receipt).toMatchObject({ id: id(5), builderRunId: id(4), builderAgentId: id(3) });
    expect(lookup).toHaveBeenCalledExactlyOnceWith(id(3));
  });
  it("refuses manual submission without a key or actual Builder run", async () => {
    await expect(normalReviewCycleSubmission({ issue, requestedStatus: "done", actor: { userId: "owner" }, findObservedBuilderRun: async () => id(4) })).rejects.toThrow("idempotent");
    await expect(normalReviewCycleSubmission({ issue, requestedStatus: "done", actor: { userId: "owner" }, clientSubmissionId: id(5), findObservedBuilderRun: async () => null })).rejects.toThrow("Builder run must exist");
  });
  it("does not mint another admission for a pending Reviewer decision or unrelated patch", async () => {
    const lookup = vi.fn();
    expect(await normalReviewCycleSubmission({ issue, requestedStatus: undefined, actor: {}, findObservedBuilderRun: lookup })).toBeUndefined();
    expect(await normalReviewCycleSubmission({ issue: { ...issue, executionState: { status: "pending", currentStageId: id(6), currentStageIndex: 0,
      currentStageType: "review", currentParticipant: { type: "agent", agentId: id(7), userId: null },
      returnAssignee: { type: "agent", agentId: id(3), userId: null }, reviewRequest: null, completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null } },
      requestedStatus: "done", actor: { agentId: id(7), runId: id(8) }, findObservedBuilderRun: lookup })).toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe("unadapted native setters cannot bypass the total budget transaction", () => {
  const guarded = { ...issue, executionPolicy: { totalReviewCycles: 5 }, executionState: null };
  it.each([{ status: "done" }, { status: "in_review" }, { executionPolicy: null }, { assigneeAgentId: id(9) }, { executionState: { status: "completed" } }])("refuses workflow mutation outside the locked callback: %j", patch => {
    expect(() => assertReviewBudgetMutationTransaction({}, guarded, patch)).toThrow("locked task-wide");
  });
  it("does not intercept ordinary metadata, monitor-only changes or unselected tasks", () => {
    expect(() => assertReviewBudgetMutationTransaction({}, guarded, { title: "Edited" })).not.toThrow();
    expect(() => assertReviewBudgetMutationTransaction({}, { ...guarded, executionState: { status: "pending", monitor: null } }, { executionState: { status: "pending", monitor: { status: "cleared" } } })).not.toThrow();
    expect(() => assertReviewBudgetMutationTransaction({}, issue, { status: "done" })).not.toThrow();
  });
});

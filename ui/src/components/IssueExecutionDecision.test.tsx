// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Issue } from "@paperclipai/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issuesApi } from "../api/issues";
import { ApiError } from "../api/client";
import { IssueExecutionDecision } from "./IssueExecutionDecision";

vi.mock("../api/issues", () => ({ issuesApi: { get: vi.fn(), update: vi.fn() } }));
vi.mock("../api/client", () => ({
  ApiError: class ApiError extends Error {
    constructor(message: string, public status: number, public body: unknown) { super(message); }
  },
}));

function fixture(stage: "approval" | "review" = "approval"): Issue {
  return {
    id: "task-1", identifier: "TEST-1", companyId: "company-1", status: "in_review", statusVersion: 0,
    projectId: null, projectWorkspaceId: null, goalId: null, parentId: null,
    title: "Human approval test", description: null, workMode: "standard", priority: "medium",
    reviewPolicy: null, assigneeAgentId: null, assigneeUserId: "owner", responsibleUserId: "owner",
    checkoutRunId: null, executionRunId: null, executionAgentNameKey: null, executionLockedAt: null,
    createdByAgentId: null, createdByUserId: "owner", issueNumber: 18, requestDepth: 0,
    billingCode: null, assigneeAdapterOverrides: null,
    executionWorkspaceId: null, executionWorkspacePreference: null, executionWorkspaceSettings: null,
    startedAt: null, completedAt: null, cancelledAt: null, hiddenAt: null,
    createdAt: new Date("2026-10-27T00:00:00Z"), updatedAt: new Date("2026-10-27T00:00:00Z"),
    executionPolicy: { mode: "normal", commentRequired: true, stages: [{
      id: "stage-1", type: stage, approvalsNeeded: 1,
      participants: [{ id: "participant-1", type: "user", userId: "owner", agentId: null }],
    }] },
    executionState: {
      status: "pending", currentStageId: "stage-1", currentStageIndex: 0,
      currentStageType: stage, currentParticipant: { type: "user", userId: "owner", agentId: null },
      returnAssignee: { type: "agent", agentId: "builder", userId: null },
      reviewRequest: null, completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null,
    },
  } as Issue;
}

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
let task: Issue;

async function render(issue = task, userId: string | undefined = "owner") {
  await act(async () => root.render(
    <QueryClientProvider client={client}>
      <IssueExecutionDecision issue={issue} currentUserId={userId} />
    </QueryClientProvider>,
  ));
}
function button(label: string) {
  const found = [...container.querySelectorAll("button")].find((b) => b.textContent === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
async function type(value: string) {
  const input = container.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function click(label: string) { await act(async () => button(label).click()); }

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  task = fixture();
  vi.mocked(issuesApi.get).mockReset().mockImplementation(async () => task);
  vi.mocked(issuesApi.update).mockReset().mockResolvedValue({ ...task, status: "done" } as never);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  client.clear();
});

describe("human execution decisions", () => {
  it.each(["approval", "review"] as const)("shows controls for the current human %s participant", async (stage) => {
    await render(fixture(stage));
    expect(button("Approve").disabled).toBe(true);
    expect(button("Request changes").disabled).toBe(true);
    expect(container.querySelector("label")?.htmlFor).toBe(container.querySelector("textarea")?.id);
  });

  it.each(["other", undefined])("hides controls from a different or missing user (%s)", async (userId) => {
    await act(async () => root.render(<QueryClientProvider client={client}>
      <IssueExecutionDecision issue={task} currentUserId={userId} />
    </QueryClientProvider>));
    expect(container.querySelector("button")).toBeNull();
  });

  it("hides controls for an agent participant", async () => {
    task.executionState!.currentParticipant = { type: "agent", agentId: "owner", userId: null };
    await render();
    expect(container.querySelector("button")).toBeNull();
  });

  it.each(["done", "cancelled", "todo", "in_progress"] as const)("hides controls when task status is %s", async (status) => {
    await render({ ...task, status });
    expect(container.querySelector("button")).toBeNull();
  });

  it.each(["completed", "changes_requested"] as const)("hides controls when stage is %s", async (status) => {
    task.executionState!.status = status;
    await render();
    expect(container.querySelector("button")).toBeNull();
  });

  it("hides controls without execution state", async () => {
    await render({ ...task, executionState: null });
    expect(container.querySelector("button")).toBeNull();
  });

  it("hides controls if the pending stage has no matching policy", async () => {
    await render({ ...task, executionPolicy: null });
    expect(container.querySelector("button")).toBeNull();
    await render({ ...task, executionPolicy: { ...task.executionPolicy!, stages: [] } });
    expect(container.querySelector("button")).toBeNull();
  });

  it("rejects whitespace-only comments without making requests", async () => {
    await render();
    await type("  \n  ");
    await click("Approve");
    expect(button("Approve").disabled).toBe(true);
    expect(issuesApi.get).not.toHaveBeenCalled();
    expect(issuesApi.update).not.toHaveBeenCalled();
  });

  it.each([["Approve", "done"], ["Request changes", "in_progress"]])(
    "sends %s and its trimmed comment in one update", async (label, status) => {
      await render();
      const invalidate = vi.spyOn(client, "invalidateQueries");
      await type("  Owner decision.  ");
      await click(label);
      expect(issuesApi.get).toHaveBeenCalledWith("task-1", { cache: "no-store" });
      expect(issuesApi.update).toHaveBeenCalledExactlyOnceWith("task-1", { status, comment: "Owner decision.", expectedExecutionDecision: { statusVersion: task.statusVersion, executionPolicy: task.executionPolicy, executionState: task.executionState } });
      expect(container.querySelector('[role="status"]')?.textContent).toContain("decision was saved");
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["issues"] });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["attention", "company-1"] });
    },
  );

  it("waits for server confirmation and prevents duplicate submissions", async () => {
    let finish!: (value: never) => void;
    vi.mocked(issuesApi.update).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    await render();
    await type("Approved.");
    await click("Approve");
    expect(button("Saving…").disabled).toBe(true);
    expect(container.querySelector('[role="status"]')).toBeNull();
    await click("Saving…");
    expect(issuesApi.update).toHaveBeenCalledTimes(1);
    await act(async () => finish(task as never));
    expect(container.querySelector('[role="status"]')).not.toBeNull();
  });

  it("retains the draft after a server permission rejection", async () => {
    vi.mocked(issuesApi.update).mockRejectedValue(new ApiError("Permission denied", 403, {}));
    await render();
    await type("My approval.");
    await click("Approve");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Permission denied");
    expect(container.querySelector("textarea")?.value).toBe("My approval.");
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(button("Approve").disabled).toBe(false);
  });

  it("locks a server-side stale snapshot rejection without resubmitting", async () => {
    vi.mocked(issuesApi.update).mockRejectedValue(new ApiError("Stage changed", 409, {}));
    await render(); await type("For this stage only."); await click("Approve");
    expect(button("Approve").disabled).toBe(true);
    expect(container.querySelector("textarea")?.value).toBe("For this stage only.");
    await click("Approve"); expect(issuesApi.update).toHaveBeenCalledTimes(1);
  });

  it.each([{ assigneeAgentId: "agent-1" }, { assigneeUserId: "other" }])("hides controls for incoherent human assignment %j", async (assignment) => {
    await render({ ...task, ...assignment }); expect(container.querySelector("button")).toBeNull();
  });

  it.each([undefined, -1, NaN])("hides controls without an authoritative ownership version (%s)", async (statusVersion) => {
    await render({ ...task, statusVersion }); expect(container.querySelector("button")).toBeNull();
  });

  it("clears the draft between consecutive stages assigned to the same human", async () => {
    const stage = { ...task.executionPolicy!.stages[0], id: "stage-2" };
    const issue = { ...task, executionPolicy: { ...task.executionPolicy!, stages: [...task.executionPolicy!.stages, stage] } };
    await render(issue); await type("Only stage one.");
    await render({ ...issue,
      executionState: { ...task.executionState!, currentStageId: "stage-2", currentStageIndex: 1, completedStageIds: ["stage-1"] } });
    expect(container.querySelector("textarea")?.value).toBe("");
  });

  it("does not submit when the fresh read fails", async () => {
    vi.mocked(issuesApi.get).mockRejectedValue(new Error("Offline"));
    await render();
    await type("Approved.");
    await click("Approve");
    expect(issuesApi.update).not.toHaveBeenCalled();
    expect(container.querySelector("textarea")?.value).toBe("Approved.");
    expect(button("Approve").disabled).toBe(false);
  });

  it.each([new Error("Lost receipt"), new ApiError("Server error", 500, {})])(
    "blocks automatic resubmission after an uncertain result", async (error) => {
      vi.mocked(issuesApi.update).mockRejectedValue(error);
      await render();
      await type("Approved.");
      await click("Approve");
      expect(container.querySelector('[role="alert"]')?.textContent).toContain("check its activity");
      expect(container.querySelector("textarea")?.value).toBe("Approved.");
      expect(button("Approve").disabled).toBe(true);
      expect(issuesApi.update).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["stage", "ownership-version", "policy", "participant"])("refuses stale %s before sending a mutation", async (change) => {
    const latest = structuredClone(task);
    if (change === "stage") latest.executionState!.currentStageId = "stage-2";
    if (change === "ownership-version") latest.statusVersion = (latest.statusVersion ?? 0) + 1;
    if (change === "policy") latest.executionPolicy!.maxReviewRounds = 3;
    if (change === "participant") latest.executionState!.currentParticipant = { type: "user", userId: "other", agentId: null };
    vi.mocked(issuesApi.get).mockResolvedValue(latest);
    await render();
    await type("Approved.");
    await click("Approve");
    expect(issuesApi.update).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("stage changed");
    expect(button("Approve").disabled).toBe(true);
  });

  it("clears drafts when navigating to a different task", async () => {
    await render();
    await type("Only for task 1.");
    await render({ ...task, id: "task-2" });
    expect(container.querySelector("textarea")?.value).toBe("");
  });

  it("does not submit if navigation happens during the fresh read", async () => {
    let finish!: (value: Issue) => void;
    vi.mocked(issuesApi.get).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    await render();
    await type("Only for task 1.");
    await click("Approve");
    await render({ ...task, id: "task-2" });
    await act(async () => finish(task));
    expect(issuesApi.update).not.toHaveBeenCalled();
  });
});

function exhaustedBudgetTask(): Issue {
  const issue = fixture("review");
  issue.executionPolicy!.totalReviewCycles = 5;
  issue.executionPolicy!.stages[0].participants = [{ id: "one-reviewer", type: "agent", agentId: "reviewer", userId: null }];
  issue.executionPolicy!.stages.push({ id: "human-final", type: "approval", approvalsNeeded: 1,
    participants: [{ id: "human", type: "user", userId: "owner", agentId: null }] });
  Object.assign(issue.executionState!, { totalReviewBudgetHold: true, totalReviewCyclesUsed: 5, totalReviewCycleAllowance: 5 });
  return issue;
}

describe("explicit human allowance for one configured Reviewer", () => {
  it("shows usage and requires a reason before granting one additional cycle", async () => {
    task = exhaustedBudgetTask(); await render();
    expect(container.textContent).toContain("Review cycles: 5 of 5 used");
    expect(button("Allow one additional review cycle").disabled).toBe(true);
    await type("  One more correction is justified.  ");
    await click("Allow one additional review cycle");
    expect(issuesApi.update).toHaveBeenCalledTimes(1);
    const payload = vi.mocked(issuesApi.update).mock.calls[0][1];
    expect(payload).toEqual({ reviewCycleAllowance: { id: expect.stringMatching(/^[a-f0-9-]{36}$/), additionalCycles: 1, reason: "One more correction is justified." } });
    expect(container.querySelector('[role="status"]')?.textContent).toContain("earlier usage is retained");
  });
  it("does not expose allowance controls to an unrelated user", async () => {
    task = exhaustedBudgetTask(); await render(task, "other");
    expect(container.querySelector("button")).toBeNull();
  });
  it("locks a stale allowance conflict until the task is refreshed",async()=>{
    task=exhaustedBudgetTask();vi.mocked(issuesApi.update).mockRejectedValueOnce(new ApiError("Task changed",409,{}));
    await render();await type("One more cycle.");await click("Allow one additional review cycle");
    expect(button("Allow one additional review cycle").disabled).toBe(true);
    await click("Allow one additional review cycle");expect(issuesApi.update).toHaveBeenCalledTimes(1);
  });
  it("locks an uncertain grant and never repeats it blindly", async () => {
    task = exhaustedBudgetTask(); vi.mocked(issuesApi.update).mockRejectedValueOnce(new Error("Response lost"));
    await render(); await type("One more cycle."); await click("Allow one additional review cycle");
    expect(button("Allow one additional review cycle").disabled).toBe(true);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not confirm");
    await click("Allow one additional review cycle"); expect(issuesApi.update).toHaveBeenCalledTimes(1);
  });
  it("refuses a grant after the fresh read shows changed usage", async () => {
    task = exhaustedBudgetTask(); const changed = structuredClone(task);
    changed.executionState!.totalReviewCycleAllowance = 6;
    vi.mocked(issuesApi.get).mockResolvedValueOnce(changed);
    await render(); await type("One more cycle."); await click("Allow one additional review cycle");
    expect(issuesApi.update).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("changed");
  });
});

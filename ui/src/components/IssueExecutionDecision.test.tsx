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
    id: "task-1", identifier: "TEST-1", companyId: "company-1", status: "in_review",
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
      expect(issuesApi.update).toHaveBeenCalledExactlyOnceWith("task-1", { status, comment: "Owner decision." });
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

  it("refuses a stale stage before sending a mutation", async () => {
    vi.mocked(issuesApi.get).mockResolvedValue({ ...task, executionState: {
      ...task.executionState!, currentStageId: "stage-2",
    } });
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

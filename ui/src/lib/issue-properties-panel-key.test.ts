import { describe, expect, it } from "vitest";
import type { Issue } from "@paperclipai/shared";
import { buildIssuePropertiesPanelKey } from "./issue-properties-panel-key";

function createIssue(overrides: Partial<Issue> = {}) {
  return {
    id: "issue-1",
    status: "in_progress" as const,
    statusVersion: 0,
    priority: "medium" as const,
    assigneeAgentId: "agent-1",
    assigneeUserId: null,
    projectId: "project-1",
    projectWorkspaceId: null,
    parentId: null,
    createdByUserId: "user-1",
    hiddenAt: null,
    labelIds: ["label-1"],
    executionPolicy: null,
    executionState: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    currentExecutionWorkspace: null,
    blocks: [],
    blockedBy: [],
    ancestors: [],
    updatedAt: new Date("2026-04-12T12:00:00.000Z"),
    ...overrides,
  };
}

describe("buildIssuePropertiesPanelKey", () => {
  it("changes after ownership moves away and back to the same pending human", () => {
    expect(buildIssuePropertiesPanelKey(createIssue({ statusVersion: 2 }), [])).not.toBe(
      buildIssuePropertiesPanelKey(createIssue({ statusVersion: 0 }), []));
  });
  it("changes between consecutive stages for the same human and stage type", () => {
    const state: NonNullable<Issue["executionState"]> = { status: "pending", currentStageId: "stage-1", currentStageIndex: 0,
      currentStageType: "approval", currentParticipant: { type: "user", userId: "user-1", agentId: null },
      returnAssignee: null, reviewRequest: null, completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null };
    const first = buildIssuePropertiesPanelKey(createIssue({ executionState: state }), []);
    const second = buildIssuePropertiesPanelKey(createIssue({ executionState: { ...state, currentStageId: "stage-2", currentStageIndex: 1,
      completedStageIds: ["stage-1"], lastDecisionId: "decision-1", lastDecisionOutcome: "approved" } }), []);
    expect(second).not.toBe(first);
  });
  it("ignores plain updatedAt churn", () => {
    const first = buildIssuePropertiesPanelKey(createIssue(), []);
    const second = buildIssuePropertiesPanelKey(
      createIssue({ updatedAt: new Date("2026-04-12T12:05:00.000Z") }),
      [],
    );

    expect(second).toBe(first);
  });

  it("changes when a displayed property changes", () => {
    const first = buildIssuePropertiesPanelKey(createIssue(), []);
    const second = buildIssuePropertiesPanelKey(
      createIssue({ assigneeAgentId: "agent-2" }),
      [],
    );

    expect(second).not.toBe(first);
  });

  it("changes when watchdog configuration changes", () => {
    const first = buildIssuePropertiesPanelKey(createIssue({ watchdog: null }), []);
    const second = buildIssuePropertiesPanelKey(
      createIssue({
        watchdog: {
          id: "watchdog-1",
          companyId: "company-1",
          issueId: "issue-1",
          watchdogAgentId: "agent-1",
          instructions: "Keep the tree moving.",
          status: "active",
          watchdogIssueId: null,
          lastObservedFingerprint: null,
          lastReviewedFingerprint: null,
          lastTriggeredAt: null,
          lastCompletedAt: null,
          triggerCount: 0,
          createdAt: new Date("2026-04-12T12:01:00.000Z"),
          updatedAt: new Date("2026-04-12T12:01:00.000Z"),
        },
      }),
      [],
    );

    expect(second).not.toBe(first);
  });

  it("changes when workspace detail hydrates after opening from a cached issue", () => {
    const first = buildIssuePropertiesPanelKey(createIssue(), []);
    const second = buildIssuePropertiesPanelKey(
      createIssue({
        executionWorkspaceId: "workspace-1",
        executionWorkspacePreference: "reuse_existing",
        executionWorkspaceSettings: { mode: "isolated_workspace" },
        currentExecutionWorkspace: {
          id: "workspace-1",
          companyId: "company-1",
          projectId: "project-1",
          projectWorkspaceId: "project-workspace-1",
          sourceIssueId: "issue-1",
          mode: "isolated_workspace",
          strategyType: "git_worktree",
          name: "PAP-1 workspace",
          status: "active",
          deliveryState: "unknown",
          cwd: "/tmp/paperclip/PAP-1",
          repoUrl: null,
          baseRef: "master",
          branchName: "PAP-1-workspace",
          providerType: "git_worktree",
          providerRef: "/tmp/paperclip/PAP-1",
          derivedFromExecutionWorkspaceId: null,
          lastUsedAt: new Date("2026-04-12T12:01:00.000Z"),
          openedAt: new Date("2026-04-12T12:01:00.000Z"),
          closedAt: null,
          cleanupEligibleAt: null,
          cleanupReason: null,
          config: null,
          metadata: null,
          runtimeServices: [],
          createdAt: new Date("2026-04-12T12:01:00.000Z"),
          updatedAt: new Date("2026-04-12T12:01:00.000Z"),
        },
      }),
      [],
    );

    expect(second).not.toBe(first);
  });
});

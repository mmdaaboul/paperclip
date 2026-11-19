import { isDeepStrictEqual } from "node:util";
import type { UpdateIssue } from "@paperclipai/shared";
import { conflict, forbidden } from "../errors.js";
import { normalizeIssueExecutionPolicy, parseIssueExecutionState } from "./issue-execution-policy.js";

type DecisionIssue = {
  status: string;
  statusVersion: number;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  executionPolicy: unknown;
  executionState: unknown;
};

/** Call before request side effects, and again under the issue row lock in its decision transaction. */
export function assertHumanExecutionDecisionSnapshot(
  issue: DecisionIssue,
  expected: NonNullable<UpdateIssue["expectedExecutionDecision"]>,
  userId: string | null,
) {
  if (!userId) throw forbidden("Only the current human participant can submit this decision");
  const policy = normalizeIssueExecutionPolicy(issue.executionPolicy);
  const state = parseIssueExecutionState(issue.executionState);
  const changed = () => conflict("The task execution stage changed. Read its latest state before deciding.", {
    code: "execution_decision_changed",
  });
  if (issue.status !== "in_review" || issue.statusVersion !== expected.statusVersion || !policy || !state
    || !isDeepStrictEqual(policy, normalizeIssueExecutionPolicy(expected.executionPolicy))
    || !isDeepStrictEqual(state, parseIssueExecutionState(expected.executionState))) throw changed();
  if (state.currentParticipant?.type !== "user" || state.currentParticipant.userId !== userId) {
    throw forbidden("Only the current human participant can submit this decision");
  }
  // Native escalation may select a responsible human outside the configured participant list.
  if (state.status !== "pending" || !["review", "approval"].includes(state.currentStageType ?? "")
    || !policy.stages.some(stage => stage.id === state.currentStageId && stage.type === state.currentStageType)
    || issue.assigneeAgentId !== null || issue.assigneeUserId !== userId) throw changed();
}

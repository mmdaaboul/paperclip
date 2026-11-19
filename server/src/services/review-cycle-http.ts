import { reviewCycleSubmissionSchema, type ReviewCycleSubmission } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import { parseIssueExecutionState, type TransitionInput } from "./issue-execution-policy.js";

/** Normal accounting identifies the observed Builder run, not an artifact hash.
 * Scoped artifact integrity is a separate parent-linked admission contract.
 */
export async function normalReviewCycleSubmission(input: {
  issue: TransitionInput["issue"];
  requestedStatus: unknown;
  actor: TransitionInput["actor"];
  clientSubmissionId?: string;
  findObservedBuilderRun: (builderAgentId: string) => Promise<string | null>;
}): Promise<ReviewCycleSubmission | undefined> {
  const current = parseIssueExecutionState(input.issue.executionState);
  if (!["done", "in_review"].includes(String(input.requestedStatus)) || current?.status === "pending" || current?.status === "completed") return undefined;
  const builderAgentId = current?.returnAssignee?.type === "agent" ? current.returnAssignee.agentId : input.issue.assigneeAgentId;
  if (!builderAgentId || !input.issue.id || !input.issue.companyId) throw unprocessable("Review submission requires an assigned Builder and task identity");
  let builderRunId: string | null;
  let receiptId: string;
  if (input.actor.agentId) {
    if (input.actor.agentId !== builderAgentId || !input.actor.runId) throw unprocessable("Automated review submission requires the authenticated Builder run");
    builderRunId = input.actor.runId; receiptId = input.actor.runId;
  } else {
    if (!input.actor.userId || !input.clientSubmissionId) throw unprocessable("Manual review submission requires an idempotent submission ID");
    builderRunId = await input.findObservedBuilderRun(builderAgentId);
    if (!builderRunId) throw unprocessable("A Builder run must exist before this candidate can be submitted for independent review");
    receiptId = input.clientSubmissionId;
  }
  return reviewCycleSubmissionSchema.parse({ id: receiptId, companyId: input.issue.companyId, issueId: input.issue.id,
    builderAgentId, builderRunId, candidateId: `run:${builderRunId}`, kind: "normal", scopeId: null });
}

import type { Db } from "@paperclipai/db";
import { forbidden } from "../../errors.js";
import { reviewerActorRestricted } from "../reviewer-role.js";

/** Fresh persisted role restriction before *all* native-tool mutation shortcuts.
 * A missing controller catalog binding cannot become a write or connector grant.
 * Read tools and the narrow decision/action consumers retain their own complete
 * native authorization; this function adds restrictions and grants nothing.
 */
export async function assertReviewerNativeToolBoundary(db: Pick<Db, "select">, input: {
  companyId: string; agentId: string; runId: string; tool: string;
  nativeReview: boolean; nativeStageReview?: boolean; nativeReadTool: boolean; closedDiscussionTool: boolean;
}) {
  if (!await reviewerActorRestricted(db, input)) return;
  if (input.nativeReadTool || input.closedDiscussionTool || (input.nativeReview && input.tool === "resolve_review")
    || (input.nativeStageReview && input.tool === "resolve_stage_review")) return;
  throw forbidden("The Reviewer role cannot use generic native mutation, connector, approval or credential tools");
}

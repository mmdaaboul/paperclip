import { and, eq, or, sql } from "drizzle-orm";
import { issues, type Db } from "@paperclipai/db";
import { conflict } from "../../errors.js";

/** Current1117 completion reviews already have their native source owner.
 * Execution-stage/scoped authority is a separate F06 port. Never reinterpret
 * an existing manual stage or manufacture an accepted Builder source. */
export async function assertReviewerPendingStagesHaveNativeSource(db: Db, input: { companyId: string; agentId: string }) {
  const [pending] = await db.select({ id: issues.id }).from(issues).where(and(
    eq(issues.companyId, input.companyId), eq(issues.status, "in_review"),
    or(eq(issues.assigneeAgentId, input.agentId), sql`${issues.executionState}->'currentParticipant'->>'agentId' = ${input.agentId}`),
  )).limit(1);
  if (pending) throw conflict("An existing manual execution stage cannot acquire protected Reviewer authority. Finish or reconcile it through its native owner first.", {
    code: "reviewer_pending_stage_owner_unavailable",
  });
}

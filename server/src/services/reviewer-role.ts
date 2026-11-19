import { and, eq, sql } from "drizzle-orm";
import { agentReviewerPolicies, heartbeatRuns, type Db } from "@paperclipai/db";
import { forbidden } from "../errors.js";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** A dedicated operator-owned role applies to the selected agent, not an
 * agent-editable label. Project/repository scopes limit the closed actions;
 * choosing another job must not be an escape to raw credentials.
 */
export async function reviewerExecutionRestrictsCredentials(db: Pick<Db, "select">, input: {
  companyId: string;
  agentId: string;
  runnerProfileJson?: unknown;
}): Promise<boolean> {
  const retained = object(input.runnerProfileJson);
  // Retained admission keeps an active run restricted after operator removal.
  // A new unconfigured run has neither marker. A malformed marker denies too.
  if (Object.hasOwn(retained, "reviewerPolicy") || Object.hasOwn(retained, "reviewerGitHubScope")) return true;
  const [policy] = await db.select({ enabled: agentReviewerPolicies.enabled }).from(agentReviewerPolicies).where(and(
    eq(agentReviewerPolicies.companyId, input.companyId), eq(agentReviewerPolicies.agentId, input.agentId),
  ));
  return policy?.enabled === true;
}

/** Closed native Reviewer tools do not use generic external MCP credentials.
 * Enforce at invocation as well as discovery; native policy still runs for all
 * ordinary agents. No approval/replay flag can override this role boundary.
 */
export async function assertNoReviewerGenericGateway(db: Pick<Db, "select">, input: {
  companyId: string;
  agentId: string | null;
  runnerProfileJson?: unknown;
}) {
  if (input.agentId && await reviewerExecutionRestrictsCredentials(db, { ...input, agentId: input.agentId })) {
    throw forbidden("The Reviewer role uses only its assigned-PR discussion tools, not generic connector credentials");
  }
}

/** Resolve the retained profile from the server's run row, never from an HTTP
 * field or agent-editable configuration. All role boundaries use this query. */
export async function reviewerActorRestricted(db: Pick<Db, "select">, input: {
  companyId: string; agentId: string; runId?: string | null;
}): Promise<boolean> {
  if (input.runId) {
    // Never transfer the saved native input/checkpoint/output on the hot tool
    // path. Only marker presence is needed, including malformed/null markers.
    const [run] = await db.select({ retained: sql<boolean>`coalesce(${heartbeatRuns.runnerProfileJson} ? 'reviewerPolicy' or ${heartbeatRuns.runnerProfileJson} ? 'reviewerGitHubScope', false)` }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, input.agentId),
    ));
    if (run?.retained === true) return true;
  }
  return reviewerExecutionRestrictsCredentials(db, input);
}

/** Deny mutations before native scoped-key, CEO, self, or explicit-grant paths.
 * Read actions continue through the complete existing native privacy/RBAC
 * checks; this predicate never grants access or raw secret reads. */
export function reviewerAllowsNativeRead(action: string): boolean {
  return new Set(["agent:read", "company_scope:read", "decision_queue:read", "issue:read", "project:read"]).has(action);
}

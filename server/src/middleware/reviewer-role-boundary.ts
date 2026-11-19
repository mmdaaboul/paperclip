import type { RequestHandler } from "express";
import { and, eq } from "drizzle-orm";
import { heartbeatRuns } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { reviewerActorRestricted } from "../services/reviewer-role.js";
import { authorizationService, authorizationDeniedDetails } from "../services/authorization.js";
import { forbidden } from "../errors.js";

/** Additive agent-only control-plane write boundary, mounted immediately after
 * authentication and cloud-control actor replacement and before API routes.
 * Native routes are not uniformly authorizationService-backed, so denying only
 * the native tool catalog or PermissionKey grants leaves API-key/config escape
 * paths. Board operators retain their native authority. Reads still pass each
 * route's native company/privacy checks. No caller-controlled prefix bypass.
 */
export function reviewerRoleBoundary(db: Db): RequestHandler {
  return async (req, _res, next) => {
    try {
      if (req.actor.type !== "agent" || !req.actor.agentId || !req.actor.companyId) return next();
      if (!await reviewerActorRestricted(db, { companyId: req.actor.companyId, agentId: req.actor.agentId, runId: req.actor.runId })) return next();

      const uuid = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
      if (["GET", "HEAD"].includes(req.method)) {
        // Agent/self detail may expose configured environment bindings. Only
        // native privacy-checked reads of this run's own task are admitted.
        const read = new RegExp(`^/api/issues/(${uuid})(?:/(?:comments|interactions)(?:/${uuid})?)?$`).exec(req.path);
        if (!read || !req.actor.runId) throw forbidden("Reviewer API reads use only bound task routes");
        const [run] = await db.select({ nativeIssueId: heartbeatRuns.nativeIssueId }).from(heartbeatRuns).where(and(
          eq(heartbeatRuns.id, req.actor.runId), eq(heartbeatRuns.companyId, req.actor.companyId), eq(heartbeatRuns.agentId, req.actor.agentId),
        ));
        if (!run || run.nativeIssueId !== read[1]) throw forbidden("Reviewer API read is outside the bound task");
        const decision = await authorizationService(db).decide({ actor: req.actor, action: "issue:read",
          resource: { type: "issue", companyId: req.actor.companyId, issueId: read[1]! } });
        if (!decision.allowed) throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
        return next();
      }
      const match = new RegExp(`^/api/issues/(${uuid})/interactions/(${uuid})/(?:accept|reject)$`).exec(req.path);
      if (req.method === "POST" && match) {
        const decision = await authorizationService(db).decide({ actor: req.actor, action: "issue:resolve_assigned_review",
          resource: { type: "issue", companyId: req.actor.companyId, issueId: match[1]!, interactionId: match[2]! } });
        if (!decision.allowed) throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
        return next();
      }
      throw forbidden("The Reviewer role cannot mutate agent/company/runtime configuration or use generic control-plane write routes");
    } catch (error) { next(error); }
  };
}

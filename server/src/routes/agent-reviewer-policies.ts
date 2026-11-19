import type { Request, Response, Router } from "express";
import { and, eq, inArray, sql } from "drizzle-orm";
import { heartbeatRuns, type agents, type Db } from "@paperclipai/db";
import { updateAgentReviewerPolicySchema, type AgentReviewerScope } from "@paperclipai/shared";
import { assertBoard, getActorInfo } from "./authz.js";
import { validate } from "../middleware/validate.js";
import { agentReviewerPoliciesService } from "../services/agent-reviewer-policies.js";
import { HttpError } from "../errors.js";
import { resolveReviewerRepositorySchema } from "../services/reviewer-repository-scope.js";

/** Dedicated operator endpoint; generic agent/hire/rollback writes never own
 * this table. Required qualification ports have no permissive default. The
 * native configuration/project checks are still the route's existing owners.
 */
export function registerAgentReviewerPolicyRoutes(router: Router, dependencies: {
  db: Db;
  resolveAgent: (req: Request, res: Response) => Promise<typeof agents.$inferSelect | null>;
  assertCanConfigure: (req: Request, agent: typeof agents.$inferSelect, executor?: Db) => Promise<void>;
  assertProjectReadable: (req: Request, companyId: string, projectId: string, executor?: Db) => Promise<void>;
  assertSupportedAgent: (req: Request, agent: typeof agents.$inferSelect) => Promise<void>;
  assertRepositoryAccessible: (req: Request, companyId: string, scope: AgentReviewerScope) => Promise<void>;
  resolveRepository?: (req: Request, agent: typeof agents.$inferSelect, selection: { projectId: string; repository: string }) => Promise<AgentReviewerScope>;
}) {
  async function context(req: Request, res: Response) {
    assertBoard(req);
    const agent = await dependencies.resolveAgent(req, res);
    if (!agent) return null;
    await dependencies.assertCanConfigure(req, agent);
    const scope = { companyId: agent.companyId, agentId: agent.id };
    const actor = { type: "board" as const, userId: getActorInfo(req).actorId };
    const service = agentReviewerPoliciesService(dependencies.db, {
      assertCanConfigure: executor => dependencies.assertCanConfigure(req, agent, executor),
      assertSupportedAgent: current => dependencies.assertSupportedAgent(req, current),
      assertProjectReadable: (projectId, executor) => dependencies.assertProjectReadable(req, agent.companyId, projectId, executor),
      assertRepositoryAccessible: selected => dependencies.assertRepositoryAccessible(req, agent.companyId, selected),
    });
    return { scope, actor, service, agent };
  }
  router.get("/agents/:id/reviewer-policy", async (req, res) => {
    const selected = await context(req, res); if (!selected) return;
    const config = await selected.service.read(selected.scope, selected.actor);
    const [active] = await dependencies.db.select({ count: sql<number>`count(*)::integer` }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, selected.scope.companyId), eq(heartbeatRuns.agentId, selected.scope.agentId),
      inArray(heartbeatRuns.status, ["queued", "scheduled_retry", "running"])));
    let supported = true, reason: string | null = null;
    try { await dependencies.assertSupportedAgent(req, selected.agent); }
    catch (error) { if (!(error instanceof HttpError) || error.status !== 422) throw error; supported = false; reason = error.message; }
    res.json({ ...config, supported, reason, activeRunCount: active?.count ?? 0 });
  });
  router.put("/agents/:id/reviewer-policy", validate(updateAgentReviewerPolicySchema), async (req, res) => {
    const selected = await context(req, res); if (!selected) return;
    res.json(await selected.service.update(selected.scope, selected.actor, req.body));
  });
  if (dependencies.resolveRepository) router.post("/agents/:id/reviewer-policy/resolve-repository", validate(resolveReviewerRepositorySchema), async (req, res) => {
    const selected = await context(req, res); if (!selected) return;
    await dependencies.assertSupportedAgent(req, selected.agent);
    await dependencies.assertProjectReadable(req, selected.scope.companyId, req.body.projectId);
    res.json(await dependencies.resolveRepository!(req, selected.agent, req.body));
  });
}

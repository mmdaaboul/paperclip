import type { Request, Response, Router } from "express";
import { and, eq, sql } from "drizzle-orm";
import { agents, environments, heartbeatRuns, type Db } from "@paperclipai/db";
import { updateAgentReferenceFoldersSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { HttpError, unprocessable } from "../errors.js";
import { assertBoard, assertInstanceAdmin, getActorInfo } from "./authz.js";
import { agentReferenceFoldersService } from "../services/agent-reference-folders.js";
import { assertReferenceFolderProvider, validateReferenceFolderPath } from "../services/agent-reference-folder-paths.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { referenceFolderAdmissionSchema } from "../services/agent-reference-folder-admission.js";
import { boundRunIssueIdSql } from "../services/run-task-binding.js";

type ReferenceFolderAgent = Pick<typeof agents.$inferSelect, "id" | "companyId" | "adapterType" | "adapterConfig" | "defaultEnvironmentId">;

export function registerAgentReferenceFolderRoutes(router: Router, dependencies: {
  db: Db;
  resolveAgent: (req: Request, res: Response) => Promise<ReferenceFolderAgent | null>;
  assertCanConfigure: (req: Request, agent: ReferenceFolderAgent, executor?: Db) => Promise<void>;
  assertProjectReadable: (req: Request, companyId: string, projectId: string, executor?: Db) => Promise<void>;
  canReadRun: (req: Request, run: { companyId: string; scopeKind: "company" | "issue" | null; issueId: string | null }) => Promise<boolean>;
}) {
  const { db } = dependencies;
  async function context(req: Request, res: Response) {
    assertBoard(req);
    const agent = await dependencies.resolveAgent(req, res);
    if (!agent) return null;
    await dependencies.assertCanConfigure(req, agent);
    const scope = { companyId: agent.companyId, agentId: agent.id };
    const actor = { type: "board" as const, userId: getActorInfo(req).actorId };
    async function assertSupportedAgent(current: ReferenceFolderAgent) {
      const settings = instanceSettingsService(db);
      if ((await settings.getGeneral()).executionMode === "kubernetes") throw unprocessable("Reference folders are not yet qualified for the instance's required Kubernetes execution mode");
      const id = current.defaultEnvironmentId ?? (await settings.get()).defaultEnvironmentId;
      const [environment] = id ? await db.select({ driver: environments.driver, status: environments.status }).from(environments).where(eq(environments.id, id)) : [];
      if (id && (!environment || environment.status !== "active")) throw unprocessable("The configured execution environment is unavailable");
      assertReferenceFolderProvider(current, environment?.driver ?? "local");
    }
    const service = agentReferenceFoldersService(db, {
      assertCanConfigure: executor => dependencies.assertCanConfigure(req, agent, executor),
      assertCanGrantHostPaths: () => assertInstanceAdmin(req),
      assertProjectReadable: (projectId, executor) => dependencies.assertProjectReadable(req, agent.companyId, projectId, executor),
      validateDirectory: validateReferenceFolderPath,
      assertSupportedAgent,
    });
    return { agent, scope, actor, service, assertSupportedAgent };
  }
  router.get("/agents/:id/reference-folders", async (req, res) => {
    const current = await context(req, res); if (!current) return;
    const config = await current.service.read(current.scope, current.actor);
    const runs = await db.select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, scopeKind: heartbeatRuns.scopeKind, issueId: boundRunIssueIdSql(),
      admission: sql<unknown>`${heartbeatRuns.runnerProfileJson}->'referenceFolderAdmission'` }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, current.scope.companyId), eq(heartbeatRuns.agentId, current.scope.agentId), eq(heartbeatRuns.status, "running")));
    const readable = await Promise.all(runs.map(run => dependencies.canReadRun(req, run)));
    const activeRuns = [];
    for (const [index, run] of runs.entries()) {
      if (!readable[index]) continue;
      const parsed = referenceFolderAdmissionSchema.safeParse(run.admission);
      const admission = parsed.success ? parsed.data : null;
      if (admission && (admission.binding.companyId !== current.scope.companyId
        || admission.binding.agentId !== current.scope.agentId || admission.binding.runId !== run.id)) continue;
      // A task may have moved projects since admission. Current task access does
      // not grant access to the historical project's host-folder names.
      if (admission?.binding.projectId) {
        try { await dependencies.assertProjectReadable(req, current.scope.companyId, admission.binding.projectId); }
        catch (error) { if (error instanceof HttpError && [403, 404].includes(error.status)) continue; throw error; }
      }
      activeRuns.push({ runId: run.id, admission: admission ? {
        schema: admission.schema, binding: admission.binding, revision: admission.revision, paths: admission.paths,
      } : null });
    }
    let supported = true, reason: string | null = null;
    try { await current.assertSupportedAgent(current.agent); }
    catch (error) { if (!(error instanceof HttpError) || error.status !== 422) throw error; supported = false; reason = error.message; }
    res.json({ ...config, activeRuns, supported, reason,
      canGrantHostPaths: req.actor.source === "local_implicit" || req.actor.isInstanceAdmin === true });
  });
  router.put("/agents/:id/reference-folders", validate(updateAgentReferenceFoldersSchema), async (req, res) => {
    const current = await context(req, res); if (!current) return;
    res.json(await current.service.update(current.scope, current.actor, req.body));
  });
}

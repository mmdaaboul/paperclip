import { and, eq, inArray } from "drizzle-orm";
import { agents, agentReferenceFolderConfigs, projects, type Db } from "@paperclipai/db";
import { updateAgentReferenceFoldersSchema, type AgentReferenceFolder, type AgentReferenceFolderConfiguration, type UpdateAgentReferenceFolders } from "@paperclipai/shared";
import { conflict, forbidden, notFound, HttpError } from "../errors.js";
import { persistActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { logger } from "../middleware/logger.js";

type Actor = { type: "board" | "agent" | "none"; userId: string | null };
type Scope = { companyId: string; agentId: string };
type Row = typeof agentReferenceFolderConfigs.$inferSelect;
const entryKey = (entry: AgentReferenceFolder) => JSON.stringify([entry.projectId, entry.path]);

function view(row: Row | undefined): AgentReferenceFolderConfiguration {
  if (!row) return { revision: 0, entries: [], updatedAt: null };
  const entries = updateAgentReferenceFoldersSchema.shape.entries.parse(row.entries);
  return { revision: row.revision, entries, updatedAt: row.updatedAt.toISOString() };
}

function assertOperator(actor: Actor): string {
  if (actor.type !== "board" || !actor.userId?.trim()) throw forbidden("Only an authorized operator can configure reference folders");
  return actor.userId;
}

/** Native routes own authorization. This service owns scoped, atomic persistence.
 * Grants have their own table so agent-editable adapter/runtime JSON cannot add,
 * remove or roll back a reference restriction.
 */
export function agentReferenceFoldersService(db: Db, options: {
  assertCanConfigure: (executor: Db) => Promise<void>;
  assertCanGrantHostPaths: () => void | Promise<void>;
  validateDirectory: (value: string, budget: { entries: number }) => Promise<string>;
  assertSupportedAgent: (agent: typeof agents.$inferSelect) => Promise<void>;
  assertProjectReadable: (projectId: string, executor: Db) => Promise<void>;
}) {
  async function read(scope: Scope, actor: Actor): Promise<AgentReferenceFolderConfiguration & { hiddenEntryCount?: number }> {
    assertOperator(actor);
    await options.assertCanConfigure(db);
    const [agent] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, scope.companyId), eq(agents.id, scope.agentId)));
    if (!agent) throw notFound("Agent not found");
    const [row] = await db.select().from(agentReferenceFolderConfigs).where(and(eq(agentReferenceFolderConfigs.companyId, scope.companyId), eq(agentReferenceFolderConfigs.agentId, scope.agentId)));
    const current = view(row);
    const readable = new Set<string>();
    for (const projectId of new Set(current.entries.map(entry => entry.projectId))) {
      try { await options.assertProjectReadable(projectId, db); readable.add(projectId); }
      catch (error) { if (!(error instanceof HttpError) || ![403, 404].includes(error.status)) throw error; }
    }
    const entries = current.entries.filter(entry => readable.has(entry.projectId));
    const hiddenEntryCount = current.entries.length - entries.length;
    // Keep the CAS revision available for explicit full revocation without
    // disclosing folders or project identities the operator can no longer read.
    return hiddenEntryCount ? { ...current, entries, hiddenEntryCount } : current;
  }

  async function update(scope: Scope, actor: Actor, requested: UpdateAgentReferenceFolders): Promise<AgentReferenceFolderConfiguration> {
    const userId = assertOperator(actor);
    await options.assertCanConfigure(db);
    const input = updateAgentReferenceFoldersSchema.parse(requested);
    const [agent] = await db.select().from(agents).where(and(eq(agents.companyId, scope.companyId), eq(agents.id, scope.agentId)));
    if (!agent) throw notFound("Agent not found");
    // Read prior authority privately. Requiring visibility of removed projects
    // would make a lost project permission prevent revocation of its host grant.
    const [priorRow] = await db.select().from(agentReferenceFolderConfigs).where(and(eq(agentReferenceFolderConfigs.companyId, scope.companyId), eq(agentReferenceFolderConfigs.agentId, scope.agentId)));
    if ((priorRow?.revision ?? 0) !== input.expectedRevision) throw conflict("Reference folders changed; reload before saving");
    const previous = new Set((priorRow?.entries ?? []).map(entryKey));
    const additions = input.entries.filter(entry => !previous.has(entryKey(entry)));
    if (additions.length) {
      await options.assertCanGrantHostPaths();
      await options.assertSupportedAgent(agent);
    }
    const projectIds = [...new Set(additions.map(entry => entry.projectId))];
    if (projectIds.length) {
      const allowed = await db.select({ id: projects.id }).from(projects).where(and(eq(projects.companyId, scope.companyId), inArray(projects.id, projectIds)));
      if (allowed.length !== projectIds.length) throw notFound("A selected project is unavailable");
      for (const projectId of projectIds) await options.assertProjectReadable(projectId, db);
    }
    // Filesystem work precedes the transaction. It must not hold the agent row
    // lock while scanning an operator-selected folder or waiting on a filesystem.
    const budget = { entries: 10_000 };
    const entries: AgentReferenceFolder[] = [];
    for (const entry of input.entries) entries.push({ projectId: entry.projectId,
      path: previous.has(entryKey(entry)) ? entry.path : await options.validateDirectory(entry.path, budget) });
    entries.sort((a, b) => a.projectId.localeCompare(b.projectId) || a.path.localeCompare(b.path));
    if (new Set(entries.map(entryKey)).size !== entries.length) throw conflict("The same project folder is selected more than once");

    const publications: ActivityPublication[] = [];
    const saved = await db.transaction(async tx => {
      await options.assertCanConfigure(tx as unknown as Db);
      // The always-present agent row serializes initial creation and later saves.
      const [locked] = await tx.select().from(agents).where(and(eq(agents.companyId, scope.companyId), eq(agents.id, scope.agentId))).for("update");
      if (!locked) throw notFound("Agent not found");
      if (additions.length && (locked.adapterType !== agent.adapterType || JSON.stringify(locked.adapterConfig) !== JSON.stringify(agent.adapterConfig)
        || locked.defaultEnvironmentId !== agent.defaultEnvironmentId)) throw conflict("The execution configuration changed; reload before selecting reference folders");
      // Recheck project existence/company binding under the same commit boundary.
      if (projectIds.length) {
        const currentProjects = await tx.select({ id: projects.id }).from(projects).where(and(eq(projects.companyId, scope.companyId), inArray(projects.id, projectIds))).for("share");
        if (currentProjects.length !== projectIds.length) throw notFound("A selected project is unavailable");
        for (const projectId of projectIds) await options.assertProjectReadable(projectId, tx as unknown as Db);
      }
      const [current] = await tx.select().from(agentReferenceFolderConfigs).where(and(eq(agentReferenceFolderConfigs.companyId, scope.companyId), eq(agentReferenceFolderConfigs.agentId, scope.agentId))).for("update");
      if ((current?.revision ?? 0) !== input.expectedRevision) throw conflict("Reference folders changed; reload before saving");
      if (JSON.stringify((current?.entries ?? []).map(entryKey)) === JSON.stringify(entries.map(entryKey))) return view(current);
      const next = { ...scope, revision: (current?.revision ?? 0) + 1, entries, updatedByUserId: userId, updatedAt: new Date() };
      const [row] = await tx.insert(agentReferenceFolderConfigs).values(next).onConflictDoUpdate({ target: [agentReferenceFolderConfigs.companyId, agentReferenceFolderConfigs.agentId], set: next }).returning();
      const { publication } = await persistActivity(tx as unknown as Db, {
        companyId: scope.companyId, actorType: "user", actorId: userId,
        action: "agent.reference_folders_updated", entityType: "agent", entityId: scope.agentId,
        details: { revision: next.revision, folderCount: entries.length, addedFolderCount: additions.length },
      });
      publications.push(publication);
      return view(row);
    });
    for (const publication of publications) {
      try { publishActivity(publication); } catch (error) { logger.warn({ err: error }, "Reference folder change committed but realtime publication failed"); }
    }
    return saved;
  }

  return { read, update };
}

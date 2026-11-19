import { retireNativeReviewerExecutions, assertNativeReviewerRetirementCurrent, rethrowNativeReviewerPolicyBudgetFailure, nativeReviewerAgentConfigurationFingerprint } from "./native-runtime/reviewer-policy-retirement.js";
import { assertReviewerPendingStagesHaveNativeSource } from "./native-runtime/reviewer-policy-pending-stage.js";
import { and, eq, inArray, sql } from "drizzle-orm";
import { agents, agentReviewerPolicies, heartbeatRuns, projects, type Db } from "@paperclipai/db";
import { agentReviewerScopeSchema, updateAgentReviewerPolicySchema, type AgentReviewerPolicyConfiguration, type AgentReviewerScope, type UpdateAgentReviewerPolicy } from "@paperclipai/shared";
import { conflict, forbidden, notFound, HttpError } from "../errors.js";
import { persistActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { logger } from "../middleware/logger.js";

type Actor = { type: "board" | "agent" | "none"; userId: string | null };
type Scope = { companyId: string; agentId: string };
type Row = typeof agentReviewerPolicies.$inferSelect;

function operator(actor: Actor): string {
  if (actor.type !== "board" || !actor.userId?.trim()) throw forbidden("Only an authorized operator can configure the Reviewer role");
  return actor.userId;
}

function canonicalScopes(scopes: AgentReviewerScope[]): AgentReviewerScope[] {
  return scopes.map(scope => ({ projectId: scope.projectId, repositoryId: scope.repositoryId, repository: scope.repository.toLowerCase() }))
    .sort((a, b) => a.projectId.localeCompare(b.projectId) || a.repositoryId.localeCompare(b.repositoryId) || a.repository.localeCompare(b.repository));
}
const scopeKey = (scope: AgentReviewerScope) => JSON.stringify([scope.projectId, scope.repositoryId, scope.repository.toLowerCase()]);
const scopeIdentity = (scopes: AgentReviewerScope[]) => JSON.stringify(canonicalScopes(scopes).map(scope => [scope.projectId, scope.repositoryId, scope.repository]));
function qualifiedAgentIdentity(agent: typeof agents.$inferSelect) {
  return { adapterType: agent.adapterType, adapterConfig: agent.adapterConfig, runtimeConfig: agent.runtimeConfig,
    defaultEnvironmentId: agent.defaultEnvironmentId, permissions: agent.permissions, status: agent.status,
    lifecycleState: agent.lifecycleState, lifecycleVersion: agent.lifecycleVersion };
}

function view(row: Row | undefined): AgentReviewerPolicyConfiguration {
  if (!row) return { revision: 0, enabled: false, scopes: [], updatedAt: null };
  return { revision: row.revision, enabled: row.enabled, scopes: row.scopes.map(scope => agentReviewerScopeSchema.parse(scope)), updatedAt: row.updatedAt.toISOString() };
}

/** Native routes retain agent_config:update and project:read authority. This
 * service adds operator-only role persistence and the native transactional audit.
 */
export function agentReviewerPoliciesService(db: Db, options: {
  assertCanConfigure: (executor: Db) => Promise<void>;
  assertSupportedAgent: (agent: typeof agents.$inferSelect) => Promise<void>;
  assertProjectReadable: (projectId: string, executor: Db) => Promise<void>;
  assertRepositoryAccessible: (scope: AgentReviewerScope) => Promise<void>;
}) {
  async function read(scope: Scope, actor: Actor): Promise<AgentReviewerPolicyConfiguration & { hiddenScopeCount?: number }> {
    operator(actor);
    await options.assertCanConfigure(db);
    const [agent] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, scope.companyId), eq(agents.id, scope.agentId)));
    if (!agent) throw notFound("Agent not found");
    const [row] = await db.select().from(agentReviewerPolicies).where(and(eq(agentReviewerPolicies.companyId, scope.companyId), eq(agentReviewerPolicies.agentId, scope.agentId)));
    const config = view(row);
    const readable = new Set<string>();
    for (const projectId of new Set(config.scopes.map(scope => scope.projectId))) {
      try { await options.assertProjectReadable(projectId, db); readable.add(projectId); }
      catch (error) { if (!(error instanceof HttpError) || ![403, 404].includes(error.status)) throw error; }
    }
    const visibleScopes = config.scopes.filter(selected => readable.has(selected.projectId));
    const hiddenScopeCount = config.scopes.length - visibleScopes.length;
    // Configuration authority still permits revoking all access. Preserve the
    // CAS revision without disclosing inaccessible project/repository metadata.
    return hiddenScopeCount ? { ...config, scopes: visibleScopes, hiddenScopeCount } : config;
  }

  async function update(scope: Scope, actor: Actor, requested: UpdateAgentReviewerPolicy): Promise<AgentReviewerPolicyConfiguration> {
    const userId = operator(actor), input = updateAgentReviewerPolicySchema.parse(requested);
    await options.assertCanConfigure(db);
    const [agent] = await db.select().from(agents).where(and(eq(agents.companyId, scope.companyId), eq(agents.id, scope.agentId)));
    if (!agent) throw notFound("Agent not found");
    // Private delta inspection permits disabling/narrowing a scope after its
    // project becomes inaccessible, without disclosing old scope metadata.
    const [prior] = await db.select().from(agentReviewerPolicies).where(and(eq(agentReviewerPolicies.companyId, scope.companyId), eq(agentReviewerPolicies.agentId, scope.agentId)));
    if ((prior?.revision ?? 0) !== input.expectedRevision) throw conflict("Reviewer settings changed; reload before saving");
    const scopes = canonicalScopes(input.scopes);
    if (new Set(scopes.map(item => JSON.stringify([item.projectId, item.repositoryId]))).size !== scopes.length) throw conflict("The project/repository scope is selected more than once");
    const previousScopes = (prior?.scopes ?? []).map(item => agentReviewerScopeSchema.parse(item));
    const previous = new Set(previousScopes.map(scopeKey));
    const additions = scopes.filter(item => !previous.has(scopeKey(item)));
    const unchanged = (prior?.enabled ?? false) === input.enabled && scopeIdentity(previousScopes) === scopeIdentity(scopes);
    // Only operative scopes need provider qualification. An off policy is not
    // an execution grant; new inactive project metadata still needs native
    // same-company/project authority, while unchanged old scopes may be removed.
    const checkedScopes = input.enabled ? scopes : additions;
    const projectIds = [...new Set(checkedScopes.map(item => item.projectId))];
    if (input.enabled && !unchanged) await options.assertSupportedAgent(agent);
    if (!unchanged && projectIds.length) {
      const selected = await db.select({ id: projects.id }).from(projects).where(and(eq(projects.companyId, scope.companyId), inArray(projects.id, projectIds)));
      if (selected.length !== projectIds.length) throw notFound("A selected project is unavailable");
      for (const id of projectIds) await options.assertProjectReadable(id, db);
      if (input.enabled) for (const selectedScope of scopes) await options.assertRepositoryAccessible(selectedScope);
    }
    if (!unchanged && input.enabled && prior?.enabled !== true) await assertReviewerPendingStagesHaveNativeSource(db, scope);
    if (!unchanged && (prior?.enabled === true || input.enabled)) {
      const [beforeRetirement] = await db.select().from(agents).where(and(eq(agents.companyId, scope.companyId), eq(agents.id, scope.agentId)));
      if (!beforeRetirement || nativeReviewerAgentConfigurationFingerprint(beforeRetirement) !== nativeReviewerAgentConfigurationFingerprint(agent)) {
        throw conflict("Execution configuration changed after qualification; reload before changing Reviewer permissions");
      }
    }
    // Pure availability/provider checks above never stop a process. Only a
    // genuine operative permission change invokes its native retirement owner.
    const retirement = !unchanged && (prior?.enabled === true || input.enabled)
      ? await retireNativeReviewerExecutions(db, { ...scope, expectedRevision: input.expectedRevision }) : null;
    let qualifiedAgent = agent;
    if (retirement) {
      const [afterCollection] = await db.select().from(agents).where(and(eq(agents.companyId, scope.companyId), eq(agents.id, scope.agentId)));
      if (!afterCollection) throw notFound("Agent not found");
      // The actual native owner permits only a newly receipted managed
      // instruction binding. Never smooth unrelated model/runtime/home drift
      // by qualifying a different configuration a second time.
      if (retirement.configurationBeforeSha256 !== nativeReviewerAgentConfigurationFingerprint(agent)
        || retirement.configurationAfterSha256 !== nativeReviewerAgentConfigurationFingerprint(afterCollection)) {
        throw conflict("Execution configuration changed during native retirement; reload before changing Reviewer permissions");
      }
      qualifiedAgent = afterCollection;
    }
    const publications: ActivityPublication[] = [];
    const saved = await db.transaction(async tx => {
      // A policy transition must not wait indefinitely behind a controller's
      // agent lock. The history proof itself uses bounded DB-only keyset pages.
      await tx.execute(sql`select set_config('lock_timeout', '1500ms', true), set_config('statement_timeout', '2500ms', true)`);
      const [locked] = await tx.select().from(agents).where(and(eq(agents.companyId, scope.companyId), eq(agents.id, scope.agentId))).for("update");
      if (!locked) throw notFound("Agent not found");
      await options.assertCanConfigure(tx as unknown as Db);
      // Qualification can do provider/DB work only before the transaction.
      // Compare the exact agent state it qualified after acquiring the row.
      if (input.enabled && !unchanged && JSON.stringify(qualifiedAgentIdentity(locked)) !== JSON.stringify(qualifiedAgentIdentity(qualifiedAgent))) {
        throw conflict("The execution configuration changed; reload before enabling the Reviewer role");
      }
      if (!unchanged && projectIds.length) {
        const selected = await tx.select({ id: projects.id }).from(projects).where(and(eq(projects.companyId, scope.companyId), inArray(projects.id, projectIds))).for("share");
        if (selected.length !== projectIds.length) throw notFound("A selected project is unavailable");
        for (const id of projectIds) await options.assertProjectReadable(id, tx as unknown as Db);
      }
      const [current] = await tx.select().from(agentReviewerPolicies).where(and(eq(agentReviewerPolicies.companyId, scope.companyId), eq(agentReviewerPolicies.agentId, scope.agentId))).for("update");
      if ((current?.revision ?? 0) !== input.expectedRevision) throw conflict("Reviewer settings changed; reload before saving");
      if ((current?.enabled ?? false) === input.enabled && scopeIdentity((current?.scopes ?? []).map(item => agentReviewerScopeSchema.parse(item))) === scopeIdentity(scopes)) return view(current);
      if (current?.enabled === true || input.enabled) {
        if (!retirement) throw conflict("Native retirement evidence is missing; reload and recheck this permission change");
        await assertNativeReviewerRetirementCurrent(tx as unknown as Db, retirement, { ...scope, expectedRevision: input.expectedRevision });
      }
      if (input.enabled && current?.enabled !== true) await assertReviewerPendingStagesHaveNativeSource(tx as unknown as Db, scope);
      // Keep the active admission fence in addition to the real stopped-owner
      // receipt; a status check alone never claims to retire a warm process.
      const active = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, scope.companyId), eq(heartbeatRuns.agentId, scope.agentId),
        inArray(heartbeatRuns.status, ["queued", "scheduled_retry", "running"]),
      )).limit(1);
      if (active.length) throw conflict("Stop and retire active executions before changing the Reviewer role; active-run migration is not qualified");
      const next = { ...scope, revision: (current?.revision ?? 0) + 1, enabled: input.enabled, scopes, updatedByUserId: userId, updatedAt: new Date() };
      const [row] = await tx.insert(agentReviewerPolicies).values(next).onConflictDoUpdate({ target: [agentReviewerPolicies.companyId, agentReviewerPolicies.agentId], set: next }).returning();
      const { publication } = await persistActivity(tx as unknown as Db, { companyId: scope.companyId, actorType: "user", actorId: userId,
        action: "agent.reviewer_policy_updated", entityType: "agent", entityId: scope.agentId,
        details: { revision: next.revision, enabled: next.enabled, scopeCount: scopes.length, addedScopeCount: additions.length } });
      publications.push(publication); return view(row);
    }).catch(rethrowNativeReviewerPolicyBudgetFailure);
    for (const publication of publications) {
      try { publishActivity(publication); } catch (error) { logger.warn({ err: error }, "Reviewer policy committed but realtime publication failed"); }
    }
    return saved;
  }
  return { read, update };
}

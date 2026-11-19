import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agentReferenceFolderConfigs, agents, companies, createDb, projects, type Db } from "@paperclipai/db";
import { agentReferenceFoldersService } from "../services/agent-reference-folders.js";
import { forbidden, notFound, unprocessable } from "../errors.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("operator-owned reference configuration with real PostgreSQL", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const actor = { type: "board" as const, userId: "reference-test-owner" };
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-reference-policy-");
    // Authorization callbacks must use their passed transaction, never deadlock
    // behind the outer connection. Path/provider checks are explicit seams here;
    // actual filesystem/native launch enforcement is tested separately.
    db = createDb(temporary.connectionString, { maxConnections: 1 });
  });
  afterAll(async () => { await temporary?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Reference policy fixture", issuePrefix: `R${companyId.slice(0, 6)}` });
    const [agent] = await db.insert(agents).values({ companyId, name: "Reference agent", adapterType: "paperclip_runner", adapterConfig: { provider: "codex" } }).returning();
    const selected = await db.insert(projects).values([{ companyId, name: "Visible" }, { companyId, name: "Private" }]).returning();
    const readable = new Set(selected.map(project => project.id));
    let configure = true, grant = true, supported = true, validateCalls = 0;
    const service = agentReferenceFoldersService(db, {
      assertCanConfigure: async executor => { await executor.execute(sql`select 1`); if (!configure) throw forbidden("Configuration denied"); },
      assertCanGrantHostPaths: () => { if (!grant) throw forbidden("Host grant denied"); },
      assertSupportedAgent: async () => { if (!supported) throw unprocessable("Unsupported execution target"); },
      assertProjectReadable: async (projectId, executor) => { await executor.execute(sql`select 1`); if (!readable.has(projectId)) throw notFound("Project not found"); },
      validateDirectory: async value => { validateCalls++; return value; },
    });
    const scope = { companyId, agentId: agent!.id };
    const entries = selected.map((project, index) => ({ projectId: project.id, path: `/fixture/reference-${index}` }));
    const save = (value = entries, expectedRevision = 0) => service.update(scope, actor, { expectedRevision, entries: value });
    return { companyId, agent: agent!, scope, entries, readable, service, save,
      denyConfigure: () => { configure = false; }, denyGrant: () => { grant = false; },
      unsupported: () => { supported = false; }, validationCalls: () => validateCalls };
  }
  async function rows(f: Awaited<ReturnType<typeof fixture>>) {
    return { settings: await db.select().from(agentReferenceFolderConfigs).where(and(eq(agentReferenceFolderConfigs.companyId, f.companyId), eq(agentReferenceFolderConfigs.agentId, f.agent.id))),
      activity: await db.select().from(activityLog).where(and(eq(activityLog.companyId, f.companyId), eq(activityLog.action, "agent.reference_folders_updated"))) };
  }

  it("defaults off and GET does no validation, writes or provider resolution", async () => {
    const f = await fixture(); expect(await f.service.read(f.scope, actor)).toEqual({ revision: 0, entries: [], updatedAt: null });
    expect(f.validationCalls()).toBe(0); expect(await rows(f)).toEqual({ settings: [], activity: [] });
  });
  it("commits revisioned configuration and native audit together", async () => {
    const f = await fixture(); const saved = await f.save(); expect(saved.revision).toBe(1);
    expect(saved.entries).toEqual([...f.entries].sort((a, b) => a.projectId.localeCompare(b.projectId)));
    const actual = await rows(f); expect(actual.settings).toHaveLength(1); expect(actual.activity).toHaveLength(1);
    expect(actual.activity[0]!.details).toMatchObject({ revision: 1, folderCount: 2, addedFolderCount: 2 });
  });
  it("idempotent repeat neither revises nor repeats audit", async () => {
    const f = await fixture(); const first = await f.save(); expect(await f.save(f.entries, 1)).toEqual(first);
    expect((await rows(f)).activity).toHaveLength(1);
  });
  it("rejects agent self-grants before filesystem or persistence", async () => {
    const f = await fixture(); await expect(f.service.update(f.scope, { type: "agent", userId: null }, { expectedRevision: 0, entries: f.entries })).rejects.toMatchObject({ status: 403 });
    expect(f.validationCalls()).toBe(0); expect(await rows(f)).toEqual({ settings: [], activity: [] });
  });
  it("never lets a company scope address another company's agent", async () => {
    const f = await fixture(), other = await fixture();
    await expect(f.service.read({ companyId: other.companyId, agentId: f.agent.id }, actor)).rejects.toMatchObject({ status: 404 });
    await expect(f.service.update({ companyId: other.companyId, agentId: f.agent.id }, actor, { expectedRevision: 0, entries: [] })).rejects.toMatchObject({ status: 404 });
  });
  it("rejects a new host grant without instance-admin authority", async () => {
    const f = await fixture(); f.denyGrant(); await expect(f.save()).rejects.toMatchObject({ status: 403 });
    expect(f.validationCalls()).toBe(0); expect((await rows(f)).settings).toEqual([]);
  });
  it("retains revision while redacting inaccessible project identities and paths", async () => {
    const f = await fixture(); await f.save(); f.readable.delete(f.entries[1]!.projectId);
    const result = await f.service.read(f.scope, actor);
    expect(result).toMatchObject({ revision: 1, entries: [f.entries[0]], hiddenEntryCount: 1 });
    expect(JSON.stringify(result)).not.toContain(f.entries[1]!.path); expect(JSON.stringify(result)).not.toContain(f.entries[1]!.projectId);
  });
  it("can clear all after all project, admin and provider access is lost", async () => {
    const f = await fixture(); await f.save(); f.readable.clear(); f.denyGrant(); f.unsupported();
    const before = f.validationCalls(); const hidden = await f.service.read(f.scope, actor);
    expect(hidden).toMatchObject({ revision: 1, entries: [], hiddenEntryCount: 2 });
    expect(await f.save([], hidden.revision)).toMatchObject({ revision: 2, entries: [] });
    expect(f.validationCalls()).toBe(before); expect((await rows(f)).activity).toHaveLength(2);
  });
  it("denies revocation when native configuration authority itself is lost", async () => {
    const f = await fixture(); await f.save(); f.denyConfigure();
    await expect(f.save([], 1)).rejects.toMatchObject({ status: 403 }); expect((await rows(f)).settings[0]!.revision).toBe(1);
  });
  it("rejects stale compare-and-swap without mutating saved authority", async () => {
    const f = await fixture(); await f.save(); await expect(f.save([], 0)).rejects.toMatchObject({ status: 409 });
    const actual = await rows(f); expect(actual.settings[0]!.entries).toHaveLength(2); expect(actual.activity).toHaveLength(1);
  });
  it("rejects foreign-company project grants even when a read callback allows them", async () => {
    const f = await fixture(), other = await fixture(); f.readable.add(other.entries[0]!.projectId);
    await expect(f.save([other.entries[0]!])).rejects.toMatchObject({ status: 404 }); expect((await rows(f)).settings).toEqual([]);
  });
  it("rolls back configuration if native audit insertion fails", async () => {
    const f = await fixture();
    await db.execute(sql`create function reject_reference_policy_audit() returns trigger language plpgsql as $$ begin raise exception 'fixture audit refusal'; end $$`);
    await db.execute(sql`create trigger reject_reference_policy_audit before insert on activity_log for each row execute function reject_reference_policy_audit()`);
    try { await expect(f.save()).rejects.toThrow(); expect(await rows(f)).toEqual({ settings: [], activity: [] }); }
    finally { await db.execute(sql`drop trigger reject_reference_policy_audit on activity_log`); await db.execute(sql`drop function reject_reference_policy_audit()`); }
  });
});

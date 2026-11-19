import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyPendingMigrations, closeRegisteredClients, createDb, inspectMigrations, migratePostgresIfEmpty } from "./client.js";
import {
  agentReferenceFolderConfigs, agentReviewerPolicies, agents, companies,
  githubPushOperationReceipts, issueReviewCycleBudgets, issueScopedReviews,
  issues, reviewerGithubEvents, reviewerGithubOperations,
} from "./schema/index.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const customTables = [
  "agent_reference_folder_configs", "agent_reviewer_policies", "github_push_operation_receipts",
  "issue_review_cycle_budgets", "issue_scoped_reviews", "reviewer_github_events", "reviewer_github_operations",
];
const migrations = fileURLToPath(new URL("./migrations", import.meta.url));

// This is fresh-install storage qualification, not service-level authorization
// or an upgrade bridge for the old fork's different 0375–0377 migrations.
describe.skipIf(!support.supported)("custom workflow fresh database foundation", () => {
  let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let sql: ReturnType<typeof postgres>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    fixture = await startEmbeddedPostgresTestDatabase("pc1117-f02-");
    sql = postgres(fixture.connectionString, { max: 1, onnotice() {} });
    db = createDb(fixture.connectionString, { maxConnections: 1 });
  }, 90_000);

  afterAll(async () => {
    if (fixture) await closeRegisteredClients(fixture.connectionString, { scope: "database" });
    if (sql) await sql.end({ timeout: 2 });
    if (fixture) await fixture.cleanup();
  });

  async function seed() {
    const id = randomUUID();
    const [company] = await db.insert(companies).values({ name: "Fresh workflow fixture", issuePrefix: id }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Fixture agent", adapterType: "process" }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Synthetic schema acceptance" }).returning();
    return { company, agent, issue };
  }

  async function rejectCode(action: PromiseLike<unknown>, code: string) {
    let caught: unknown;
    try { await action; } catch (error) { caught = error; }
    const error = caught as { code?: string; cause?: { code?: string } } | undefined;
    expect(error?.cause?.code ?? error?.code).toBe(code);
  }

  function operation(s: Awaited<ReturnType<typeof seed>>) {
    return {
      id: randomUUID(), companyId: s.company.id, agentId: s.agent.id, runId: randomUUID(),
      issueId: s.issue.id, projectId: randomUUID(), repositoryId: "123", repository: "example/fixture",
      pullNumber: 1, headSha: "a".repeat(40), action: "comment", idempotencyKey: randomUUID(),
      requestHash: "b".repeat(64), agentName: "Fixture agent", status: "pending", requestPayload: {},
    };
  }

  it("bootstraps the full released history and all seven exported custom tables", async () => {
    const journal = JSON.parse(await readFile(join(migrations, "meta/_journal.json"), "utf8"));
    const snapshots = (await readdir(join(migrations, "meta"))).filter(x => /_snapshot\.json$/.test(x)).sort();
    const snapshot = JSON.parse(await readFile(join(migrations, "meta", snapshots.at(-1)!), "utf8"));
    const state = await inspectMigrations(fixture.connectionString);
    expect(state.status).toBe("upToDate");
    expect(state.appliedMigrations).toHaveLength(journal.entries.length);
    expect(state.journalEntryCount).toBe(journal.entries.length);
    expect(state.tableCount).toBe(Object.keys(snapshot.tables).length);
    for (const name of customTables) expect(snapshot.tables["public." + name]).toBeDefined();
    expect(snapshot.tables["public.agent_file_roots"]).toBeDefined();
    expect(snapshot.tables["public.controller_instances"]).toBeDefined();
  });

  it("repeats native migration and empty-startup admission without changing history or DDL", async () => {
    const before = await sql`SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`;
    const catalog = () => sql`SELECT c.oid, c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY c.oid`;
    const objects = await catalog();
    await applyPendingMigrations(fixture.connectionString);
    expect(await migratePostgresIfEmpty(fixture.connectionString)).toMatchObject({ migrated: false, reason: "already-migrated" });
    expect(await sql`SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`).toEqual(before);
    expect(await catalog()).toEqual(objects);
  });

  it("matches actual custom columns, types, nullability and primary keys to generated metadata", async () => {
    const files = (await readdir(join(migrations, "meta"))).filter(x => /_snapshot\.json$/.test(x)).sort();
    const snapshot = JSON.parse(await readFile(join(migrations, "meta", files.at(-1)!), "utf8"));
    for (const name of customTables) {
      const table = snapshot.tables["public." + name];
      const actual = await sql<{ name: string; type: string; notNull: boolean; defaultExpression: string | null }[]>`
        SELECT a.attname AS name, format_type(a.atttypid,a.atttypmod) AS type,
          a.attnotnull AS "notNull", pg_get_expr(d.adbin,d.adrelid) AS "defaultExpression"
        FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        WHERE a.attrelid=${"public." + name}::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`;
      expect(actual.map(x => x.name)).toEqual(Object.keys(table.columns));
      for (const column of actual) {
        const expected = table.columns[column.name];
        expect(column.type).toBe(expected.type === "bigserial" ? "bigint" : expected.type);
        expect(column.notNull).toBe(expected.notNull);
        if (expected.type === "bigserial") expect(column.defaultExpression).toContain("nextval(");
        else if (expected.default == null) expect(column.defaultExpression).toBeNull();
        else {
          expect(column.defaultExpression).not.toBeNull();
          // PostgreSQL adds casts to literal defaults; compare typed values,
          // rather than treating equivalent generated SQL spellings as drift.
          // Both expressions come from trusted schema/catalog metadata here.
          const [value] = await sql.unsafe<{ equivalent: boolean }[]>(
            `SELECT ((${column.defaultExpression})::${column.type}) IS NOT DISTINCT FROM ((${String(expected.default)})::${column.type}) AS equivalent`,
          );
          expect(value.equivalent).toBe(true);
        }
      }
      const pk = await sql<{ columns: string[] }[]>`SELECT array_agg(a.attname ORDER BY k.ordinality) AS columns
        FROM pg_constraint c CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY k(attnum,ordinality)
        JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum
        WHERE c.conrelid=${"public." + name}::regclass AND c.contype='p' GROUP BY c.oid`;
      const columns = Object.values(table.columns).filter((x: any) => x.primaryKey).map((x: any) => x.name);
      const composite = Object.values(table.compositePrimaryKeys).flatMap((x: any) => x.columns);
      expect(pk[0].columns).toEqual(columns.length ? columns : composite);
      const constraints = await sql<{ name: string; kind: string }[]>`SELECT conname AS name, contype AS kind
        FROM pg_constraint WHERE conrelid=${"public." + name}::regclass AND contype IN ('c','u') ORDER BY conname`;
      const expectedConstraints = [
        ...Object.keys(table.checkConstraints).map(x => ({ name: x.slice(0, 63), kind: "c" })),
        ...Object.keys(table.uniqueConstraints).map(x => ({ name: x.slice(0, 63), kind: "u" })),
      ].sort((a, b) => a.name.localeCompare(b.name));
      expect([...constraints].sort((a, b) => a.name.localeCompare(b.name))).toEqual(expectedConstraints);
      const foreignKeys = await sql<{ name: string; target: string; columns: string[]; referenced: string[]; deletion: string; update: string }[]>`
        SELECT c.conname AS name, r.relname AS target, c.confdeltype AS deletion, c.confupdtype AS update,
          ARRAY(SELECT a.attname FROM unnest(c.conkey) WITH ORDINALITY k(num,ord)
            JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.num ORDER BY k.ord) AS columns,
          ARRAY(SELECT a.attname FROM unnest(c.confkey) WITH ORDINALITY k(num,ord)
            JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.num ORDER BY k.ord) AS referenced
        FROM pg_constraint c JOIN pg_class r ON r.oid=c.confrelid
        WHERE c.conrelid=${"public." + name}::regclass AND c.contype='f' ORDER BY c.conname`;
      const actions: Record<string, string> = { a: "no action", r: "restrict", c: "cascade", n: "set null", d: "set default" };
      const actualForeignKeys = foreignKeys.map(x => ({ ...x, deletion: actions[x.deletion], update: actions[x.update] }));
      const expectedForeignKeys = Object.values(table.foreignKeys).map((x: any) => ({ name: x.name.slice(0, 63),
        target: x.tableTo, columns: x.columnsFrom, referenced: x.columnsTo, deletion: x.onDelete, update: x.onUpdate }));
      expect(actualForeignKeys.sort((a, b) => a.name.localeCompare(b.name)))
        .toEqual(expectedForeignKeys.sort((a, b) => a.name.localeCompare(b.name)));
      const indexes = await sql<{ name: string; unique: boolean; partial: boolean; columns: string[] }[]>`
        SELECT c.relname AS name, i.indisunique AS unique, i.indpred IS NOT NULL AS partial,
          ARRAY(SELECT pg_get_indexdef(i.indexrelid,k,false) FROM generate_series(1,i.indnkeyatts) k) AS columns
        FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
        WHERE i.indrelid=${"public." + name}::regclass
          AND NOT EXISTS(SELECT 1 FROM pg_constraint k WHERE k.conindid=i.indexrelid) ORDER BY c.relname`;
      const expectedIndexes = Object.values(table.indexes).map((x: any) => ({ name: x.name.slice(0, 63), unique: x.isUnique,
        partial: x.where != null, columns: x.columns.map((column: any) => column.expression) }));
      expect([...indexes].sort((a, b) => a.name.localeCompare(b.name)))
        .toEqual(expectedIndexes.sort((a, b) => a.name.localeCompare(b.name)));
    }
  });

  it("stores reference grants and Reviewer policy through the real ORM, with safe defaults", async () => {
    const s = await seed();
    const [references] = await db.insert(agentReferenceFolderConfigs).values({ companyId: s.company.id, agentId: s.agent.id, revision: 1, updatedByUserId: "fixture-owner" }).returning();
    const [policy] = await db.insert(agentReviewerPolicies).values({ companyId: s.company.id, agentId: s.agent.id, revision: 1, updatedByUserId: "fixture-owner" }).returning();
    expect(references.entries).toEqual([]);
    expect(policy.enabled).toBe(false);
    expect(policy.scopes).toEqual([]);
    expect(references.updatedAt).toBeInstanceOf(Date);
  });

  it("rejects cross-company agent grants and cascades only grants owned by the deleted agent", async () => {
    const a = await seed(), b = await seed();
    for (const table of [agentReferenceFolderConfigs, agentReviewerPolicies]) {
      await rejectCode(db.insert(table).values({ companyId: b.company.id, agentId: a.agent.id, revision: 1, updatedByUserId: "fixture-owner" }), "23503");
      await db.insert(table).values({ companyId: a.company.id, agentId: a.agent.id, revision: 1, updatedByUserId: "fixture-owner" });
      await db.insert(table).values({ companyId: b.company.id, agentId: b.agent.id, revision: 1, updatedByUserId: "fixture-owner" });
    }
    await db.delete(agents).where(eq(agents.id, a.agent.id));
    expect(await db.select().from(agentReferenceFolderConfigs).where(eq(agentReferenceFolderConfigs.agentId, a.agent.id))).toEqual([]);
    expect(await db.select().from(agentReviewerPolicies).where(eq(agentReviewerPolicies.agentId, a.agent.id))).toEqual([]);
    expect(await db.select().from(agentReferenceFolderConfigs).where(eq(agentReferenceFolderConfigs.agentId, b.agent.id))).toHaveLength(1);
  });

  it("preserves cycle-ledger revision, issue uniqueness and native foreign keys", async () => {
    const s = await seed();
    await rejectCode(db.insert(issueReviewCycleBudgets).values({ issueId: s.issue.id, companyId: s.company.id, revision: 0, ledger: {} }), "23514");
    await rejectCode(db.insert(issueReviewCycleBudgets).values({ issueId: randomUUID(), companyId: s.company.id, ledger: {} }), "23503");
    const [row] = await db.insert(issueReviewCycleBudgets).values({ issueId: s.issue.id, companyId: s.company.id, ledger: { used: 2, allowance: 5 } }).returning();
    expect(row.revision).toBe(1);
    expect(row.ledger).toEqual({ used: 2, allowance: 5 });
    await rejectCode(db.insert(issueReviewCycleBudgets).values({ issueId: s.issue.id, companyId: s.company.id, ledger: {} }), "23505");
  });

  it("enforces one active scoped review while allowing history and a fresh active review", async () => {
    const s = await seed();
    const first = { id: randomUUID(), companyId: s.company.id, issueId: s.issue.id, snapshot: {} as any };
    const [row] = await db.insert(issueScopedReviews).values(first).returning();
    expect(row.state).toBe("draft"); expect(row.version).toBe(0); expect(row.cancellation).toBeNull();
    await rejectCode(db.insert(issueScopedReviews).values({ ...first, id: randomUUID(), state: "pending" }), "23505");
    await db.update(issueScopedReviews).set({ state: "passed" }).where(eq(issueScopedReviews.id, row.id));
    const [active] = await db.insert(issueScopedReviews).values({ ...first, id: randomUUID(), state: "cancelling" }).returning();
    await rejectCode(db.insert(issueScopedReviews).values({ ...first, id: randomUUID() }), "23505");
    await db.update(issueScopedReviews).set({ state: "cancelled" }).where(eq(issueScopedReviews.id, active.id));
    await db.insert(issueScopedReviews).values({ ...first, id: randomUUID() });
    await rejectCode(db.insert(issueScopedReviews).values({ ...first, id: randomUUID(), issueId: randomUUID() }), "23503");
  });

  it("enforces push receipt bindings, closed outcomes and idempotency", async () => {
    const s = await seed(), runId = randomUUID();
    const receipt = () => {
      const key = randomUUID();
      return { id: randomUUID(), companyId: s.company.id, agentId: s.agent.id, runId, idempotencyKey: key,
        binding: { companyId: s.company.id, agentId: s.agent.id, runId }, request: { idempotencyKey: key },
        fingerprint: "a".repeat(64), state: "pending", createdAt: new Date() };
    };
    for (const bad of [
      { fingerprint: "invalid" }, { state: "invented" }, { binding: {} }, { request: {} },
      { state: "confirmed" }, { state: "pending", finishedAt: new Date() },
      { confirmationSource: "untrusted" },
    ]) await rejectCode(db.insert(githubPushOperationReceipts).values({ ...receipt(), ...bad }), "23514");
    const pending = receipt(); await db.insert(githubPushOperationReceipts).values(pending);
    await rejectCode(db.insert(githubPushOperationReceipts).values({ ...pending, id: randomUUID() }), "23505");
    const [confirmed] = await db.insert(githubPushOperationReceipts).values({ ...receipt(), state: "confirmed", confirmationSource: "git_receive_pack_status", finishedAt: new Date() }).returning();
    expect(confirmed.state).toBe("confirmed");
  });

  it("rejects unsafe Reviewer write/confirmation states and retains bound public receipts", async () => {
    const s = await seed();
    for (const bad of [{ pullNumber: 0 }, { action: "push" }, { status: "invented" }, { idempotencyKey: "" }, { status: "writing" }, { status: "confirmed", receipt: {} }]) {
      await rejectCode(db.insert(reviewerGithubOperations).values({ ...operation(s), ...bad }), "23514");
    }
    const writing = operation(s);
    await db.insert(reviewerGithubOperations).values({ ...writing, status: "writing", claimToken: randomUUID(), writeStartedAt: new Date() });
    const op = operation(s);
    const receipt = { operationId: op.id, action: op.action, companyId: op.companyId, agentId: op.agentId,
      runId: op.runId, issueId: op.issueId, projectId: op.projectId, repositoryId: op.repositoryId,
      repository: op.repository, pullNumber: op.pullNumber, headSha: op.headSha, agentNameAtTime: op.agentName, commentId: "123", findingKey: "fixture-finding" };
    const [row] = await db.insert(reviewerGithubOperations).values({ ...op, status: "confirmed", receipt, confirmedAt: new Date() }).returning();
    expect(row.receipt).toEqual(receipt);
    await rejectCode(db.insert(reviewerGithubOperations).values({ ...op, id: randomUUID() }), "23505");
  });

  it("preserves Reviewer event foreign keys, sequence and operation history", async () => {
    const s = await seed(), op = operation(s);
    await rejectCode(db.insert(reviewerGithubEvents).values({ operationId: op.id, event: "fixture" }), "23503");
    await db.insert(reviewerGithubOperations).values(op);
    const [first] = await db.insert(reviewerGithubEvents).values({ operationId: op.id, event: "fixture" }).returning();
    const [second] = await db.insert(reviewerGithubEvents).values({ operationId: op.id, event: "fixture-next" }).returning();
    expect(first.id).toBeGreaterThan(0); expect(second.id).toBeGreaterThan(first.id);
    await rejectCode(db.delete(reviewerGithubOperations).where(eq(reviewerGithubOperations.id, op.id)), "23503");
  });
});

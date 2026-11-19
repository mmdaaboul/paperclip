import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, companyMemberships, createDb, issueComments, issueExecutionDecisions, issues } from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.js";
import { issueService } from "../services/issues.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// The HTTP route, transaction, domain transition, issue/comment/decision services
// are real. Actor transport is injected below; provider wake execution is stubbed.
vi.mock("../services/heartbeat.js", async (original) => {
  const actual = await original<typeof import("../services/heartbeat.js")>();
  return { ...actual, heartbeatService: (...args: Parameters<typeof actual.heartbeatService>) => ({
    ...actual.heartbeatService(...args), wakeup: vi.fn(async () => null),
  }) };
});

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("guarded human execution decisions with real PostgreSQL", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-human-decision-");
    db = createDb(temporary.connectionString, { maxConnections: 4 });
  });
  afterAll(async () => { await temporary?.cleanup(); });

  function app(companyId: string, userId = "owner") {
    const server = express(); server.use(express.json());
    server.use((req, _res, next) => {
      req.actor = { type: "board", userId, companyIds: [companyId], isInstanceAdmin: true, source: "local_implicit" }; next();
    });
    server.use("/api", issueRoutes(db, {} as never)); server.use(errorHandler); return server;
  }
  async function fixture(type: "review" | "approval" = "approval", consecutive = false) {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Human decision test", issuePrefix: `H${companyId.slice(0, 6)}` });
    await db.insert(companyMemberships).values(["owner", "other-human"].map(principalId => ({ companyId,
      principalType: "user", principalId, status: "active", membershipRole: "member" })));
    const [builder] = await db.insert(agents).values({ companyId, name: "Paused builder", role: "engineer", adapterType: "process", status: "paused" }).returning();
    const policy = normalizeIssueExecutionPolicy({ stages: Array.from({ length: consecutive ? 2 : 1 }, () => ({ type,
      participants: [{ type: "user", userId: "owner" }] })) })!;
    const stage = policy.stages[0]!;
    const [issue] = await db.insert(issues).values({ companyId, title: "Decision transaction", status: "in_review",
      assigneeAgentId: null, assigneeUserId: "owner", responsibleUserId: "owner", createdByUserId: "owner",
      executionPolicy: { ...policy }, executionState: { status: "pending", currentStageId: stage.id, currentStageIndex: 0,
        currentStageType: stage.type, currentParticipant: { type: "user", userId: "owner", agentId: null },
        returnAssignee: { type: "agent", agentId: builder!.id, userId: null }, reviewRequest: null,
        completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null } }).returning();
    return { companyId, issue: issue!, policy, builder: builder!, server: app(companyId),
      expected: { statusVersion: issue!.statusVersion, executionPolicy: issue!.executionPolicy, executionState: issue!.executionState } };
  }
  async function rows(issueId: string) {
    return { issue: (await db.select().from(issues).where(eq(issues.id, issueId)))[0]!,
      comments: await db.select().from(issueComments).where(eq(issueComments.issueId, issueId)),
      decisions: await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, issueId)) };
  }
  function decide(f: Awaited<ReturnType<typeof fixture>>, status = "done", extra: Record<string, unknown> = {}) {
    return request(f.server).patch(`/api/issues/${f.issue.id}`).send({ status, comment: "Owner decision.", expectedExecutionDecision: f.expected, ...extra });
  }
  it.each(["review", "approval"] as const)("approves a %s stage with one durable comment and native decision", async (type) => {
    const f = await fixture(type); const response = await decide(f);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const saved = await rows(f.issue.id); expect(saved.issue.status).toBe("done");
    expect(saved.comments).toHaveLength(1); expect(saved.decisions).toHaveLength(1);
    expect(saved.comments[0]).toMatchObject({ body: "Owner decision.", authorUserId: "owner" });
    expect(saved.decisions[0]).toMatchObject({ stageId: f.policy.stages[0]!.id, stageType: type, outcome: "approved", body: "Owner decision." });
    expect(response.body.comment.id).toBe(saved.comments[0]!.id);
  });
  it("requests changes through the native return-assignee transition", async () => {
    const f = await fixture(); const response = await decide(f, "in_progress");
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const saved = await rows(f.issue.id); expect(saved.issue).toMatchObject({ status: "in_progress", assigneeAgentId: f.builder.id, assigneeUserId: null });
    expect(saved.comments).toHaveLength(1); expect(saved.decisions).toHaveLength(1);
    expect(saved.decisions[0]!.outcome).toBe("changes_requested");
  });
  it("preserves a native escalation to a human outside the configured agent participants", async () => {
    const f = await fixture("review");
    const policy = normalizeIssueExecutionPolicy({ ...f.policy, maxReviewRounds: 3, stages: f.policy.stages.map(stage => ({ ...stage,
      participants: [{ type: "agent", agentId: f.builder.id }] })) })!;
    const state = { ...f.issue.executionState!, changesRequestedCount: 3 };
    await db.update(issues).set({ executionPolicy: { ...policy }, executionState: state }).where(eq(issues.id, f.issue.id));
    f.expected.executionPolicy = { ...policy };
    f.expected.executionState = state;
    const response = await decide(f); expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect((await rows(f.issue.id)).decisions[0]).toMatchObject({ actorUserId: "owner", outcome: "approved" });
  });
  it("refuses a different human even when that user is an instance administrator", async () => {
    const f = await fixture(); f.server = app(f.companyId, "other-admin");
    const response = await decide(f); expect(response.status).toBe(403);
    const saved = await rows(f.issue.id); expect(saved.issue).toEqual(f.issue); expect(saved.comments).toEqual([]); expect(saved.decisions).toEqual([]);
  });
  it.each([{ comment: "   " }, { title: "Unrelated edit" }, { interrupt: true }, { status: "todo" }])("refuses a malformed/mixed guarded decision %j", async (extra) => {
    const f = await fixture(); const response = await decide(f, "done", extra);
    expect(response.status).toBe(422); const saved = await rows(f.issue.id);
    expect(saved.issue).toEqual(f.issue); expect(saved.comments).toEqual([]); expect(saved.decisions).toEqual([]);
  });
  it("refuses a stale sequential decision instead of approving the same human's next stage", async () => {
    const f = await fixture("approval", true); expect((await decide(f)).status).toBe(200);
    const duplicate = await decide(f); expect(duplicate.status).toBe(409);
    const saved = await rows(f.issue.id); expect(saved.issue.executionState).toMatchObject({ currentStageId: f.policy.stages[1]!.id, status: "pending" });
    expect(saved.comments).toHaveLength(1); expect(saved.decisions).toHaveLength(1);
  });
  it("rejects an old snapshot after native ownership changes away and back", async () => {
    const f = await fixture();
    await issueService(db).update(f.issue.id, { assigneeUserId: "other-human", actorUserId: "owner" });
    await issueService(db).update(f.issue.id, { assigneeUserId: "owner", actorUserId: "owner" });
    const before = await rows(f.issue.id);
    expect(before.issue.executionState).toEqual(f.issue.executionState);
    expect(before.issue.executionPolicy).toEqual(f.issue.executionPolicy);
    expect(before.issue.statusVersion).toBeGreaterThan(f.issue.statusVersion);
    expect((await decide(f)).status).toBe(409);
    const saved = await rows(f.issue.id); expect(saved.issue).toEqual(before.issue);
    expect(saved.comments).toEqual([]); expect(saved.decisions).toEqual([]);
  });
  async function withHeldIssue(f: Awaited<ReturnType<typeof fixture>>, action: () => Promise<void>, edit = false) {
    const editor = createDb(temporary.connectionString, { maxConnections: 1 });
    const probe = createDb(temporary.connectionString, { maxConnections: 1 });
    let release!: () => void, ready!: () => void, pid = 0;
    const gate = new Promise<void>(r => { release = r; }), locked = new Promise<void>(r => { ready = r; });
    const holding = editor.transaction(async tx => {
      await tx.execute(sql`select id from issues where id=${f.issue.id} for update`);
      if (edit) await tx.update(issues).set({ executionPolicy: { ...f.policy, maxReviewRounds: 3 } }).where(eq(issues.id, f.issue.id));
      pid = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`))[0]!.pid; ready(); await gate;
    });
    await locked; const pending = action();
    try {
      const deadline = Date.now() + 5000; let count = 0;
      while (Date.now() < deadline) {
        const [row] = await probe.execute<{ count: number }>(sql`with recursive waiting(pid) as (
          select pid from pg_stat_activity where datname=current_database() and wait_event_type='Lock'
            and ${pid}=any(pg_blocking_pids(pid))
          union
          select a.pid from pg_stat_activity a join waiting w on w.pid=any(pg_blocking_pids(a.pid))
            where a.datname=current_database() and a.wait_event_type='Lock'
        ) select count(*)::int as count from waiting`);
        count = row!.count; if (count >= (edit ? 1 : 2)) break;
        await new Promise(r => setTimeout(r, 20));
      }
      expect(count, "requests must reach the real row lock before it is released").toBeGreaterThanOrEqual(edit ? 1 : 2);
    } finally { release(); await holding; await pending; }
  }
  it("serializes two truly concurrent duplicate decisions under the PostgreSQL row lock", async () => {
    const f = await fixture("approval", true); let statuses: number[] = [];
    await withHeldIssue(f, async () => { statuses = (await Promise.all([decide(f), decide(f)])).map(r => r.status).sort(); });
    expect(statuses).toEqual([200, 409]); const saved = await rows(f.issue.id);
    expect(saved.issue.executionState).toMatchObject({ currentStageId: f.policy.stages[1]!.id, status: "pending" });
    expect(saved.comments).toHaveLength(1); expect(saved.decisions).toHaveLength(1);
  });
  it("rechecks the policy after an edit commits between the read and locked write", async () => {
    const f = await fixture(); let status = 0;
    await withHeldIssue(f, async () => { status = (await decide(f)).status; }, true);
    expect(status).toBe(409); const saved = await rows(f.issue.id);
    expect(saved.issue.executionPolicy).toEqual({ ...f.policy, maxReviewRounds: 3 }); expect(saved.comments).toEqual([]); expect(saved.decisions).toEqual([]);
  });
  it.each(["issue_comments", "issue_execution_decisions"])("rolls back issue, comment and decision when %s insertion fails", async (table) => {
    const f = await fixture();
    await db.execute(sql.raw("create function f04_reject_write() returns trigger language plpgsql as $$ begin raise exception 'synthetic transaction failure'; end $$"));
    await db.execute(sql.raw(`create trigger f04_write_failure before insert on ${table} for each row execute function f04_reject_write()`));
    try {
      expect((await decide(f)).status).toBe(500); const saved = await rows(f.issue.id);
      expect(saved.issue).toEqual(f.issue); expect(saved.comments).toEqual([]); expect(saved.decisions).toEqual([]);
    } finally {
      await db.execute(sql.raw(`drop trigger f04_write_failure on ${table}`));
      await db.execute(sql.raw("drop function f04_reject_write()"));
    }
  });
});

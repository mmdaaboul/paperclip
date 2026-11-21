import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, agentWakeupRequests, authUsers, companies, companyMemberships, createDb, heartbeatRuns,
  issueComments, issueReviewCycleBudgets, issues, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { issueRoutes } from "../routes/issues.js";
import { createHeartbeatQueue } from "../services/heartbeat/queue.js";
import { createHeartbeatQueueTestDependencies } from "./helpers/heartbeat-queue.js";
import { issueService } from "../services/issues.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { createReviewCycleBudget } from "../services/total-review-budget.js";
import { withQueuedCommentIdsInWakePayload } from "../services/issue-queued-comment-queue.js";
import { WORKSPACE_WORKTREE_REQUIRES_PROJECT_CODE } from "../services/execution-workspace-policy.js";

// Real HTTP route/queue admission, native explicit-continuation validator,
// migrated database, task setter, ledger and audit. Provider dispatch alone is
// controlled: no native process, model, Git or credential operation is run.
vi.mock("../services/issue-assignment-wakeup.js", () => ({ queueIssueAssignmentWakeup: vi.fn() }));
vi.mock("../services/heartbeat.js", async load => {
  const actual = await load<typeof import("../services/heartbeat.js")>();
  return { ...actual, heartbeatService: (...args: Parameters<typeof actual.heartbeatService>) => ({
    ...actual.heartbeatService(...args), wakeup: vi.fn(async () => null),
  }) };
});

type Db = ReturnType<typeof createDb>;
let db: Db, temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
beforeAll(async () => {
  const url = process.env.PAPERCLIP_NATIVE_OPERATIONAL_TEST_DATABASE_URL;
  if (url) {
    if (!/^pc_native_operational_[a-f0-9]+_test$/.test(new URL(url).pathname.slice(1))) throw Error("new_synthetic_database_required");
    db = createDb(url, { maxConnections: 4, applicationName: "native-comment-continuations-test" });
  } else { temporary = await startEmbeddedPostgresTestDatabase("native-comment-continuations-"); db = createDb(temporary.connectionString); }
}, 90_000);
afterAll(async () => { await db?.$client.end({ timeout: 5 }); if (temporary) await temporary.cleanup(); });

async function seed(total5 = true, status = "done") {
  const userId = `comment-owner-${randomUUID()}`, now = new Date();
  await db.insert(authUsers).values({ id: userId, name: "Synthetic owner", email: `${userId}@example.test`, createdAt: now, updatedAt: now });
  const [company] = await db.insert(companies).values({ name: "Synthetic comment continuation", issuePrefix: `CC${randomUUID().replaceAll("-", "").slice(0, 8)}` }).returning();
  await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: userId, status: "active", membershipRole: "owner" });
  const [builder, reviewer] = await db.insert(agents).values(["Builder", "Reviewer"].map(name => ({ companyId: company.id, name, role: "engineer",
    status: "idle", adapterType: "paperclip_runner", adapterConfig: { provider: "codex", homeMode: "isolated" },
    runtimeConfig: { heartbeat: { wakeOnDemand: true, enabled: false, maxConcurrentRuns: 1 } }, permissions: {} }))).returning();
  const policy = total5 ? { totalReviewCycles: 5, stages: [
    { id: randomUUID(), type: "review", participants: [{ id: randomUUID(), type: "agent", agentId: reviewer.id }] },
    { id: randomUUID(), type: "approval", participants: [{ id: randomUUID(), type: "user", userId }] },
  ] } : null;
  const [issue] = await db.insert(issues).values({ companyId: company.id, identifier: `${company.issuePrefix}-1`, issueNumber: 1,
    title: "Synthetic native comment task", status, assigneeAgentId: builder.id, responsibleUserId: userId, executionPolicy: policy }).returning();
  if (total5) await db.insert(issueReviewCycleBudgets).values({ companyId: company.id, issueId: issue.id, ledger: createReviewCycleBudget(company.id, issue.id) });
  const read = async () => (await db.select().from(issues).where(eq(issues.id, issue.id)))[0];
  const budget = async () => (await db.select().from(issueReviewCycleBudgets).where(eq(issueReviewCycleBudgets.issueId, issue.id)))[0];
  const comments = () => db.select().from(issueComments).where(eq(issueComments.issueId, issue.id));
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.actor = { type: "board", userId, companyIds: [company.id], source: "session", isInstanceAdmin: false }; next(); });
  app.use("/api", issueRoutes(db, {} as never));
  app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.status ?? 500).json({ error: error.message, details: error.details }));
  const deps = createHeartbeatQueueTestDependencies(db), service = issueService(db);
  deps.getAgent.mockImplementation(async id => (await db.select().from(agents).where(eq(agents.id, id)))[0] ?? null);
  deps.issuesSvc.getDependencyReadiness.mockImplementation(service.getDependencyReadiness);
  deps.issuesSvc.listDependencyReadiness.mockImplementation(service.listDependencyReadiness);
  deps.issuesSvc.updateForCompany.mockImplementation(service.updateForCompany);
  deps.instanceSettings.getExperimental.mockResolvedValue({ ...await instanceSettingsService(db).getExperimental(), enableIsolatedWorkspaces: true });
  const queue = createHeartbeatQueue(db, deps);
  return { company, userId, builder, reviewer, issue, app, read, budget, comments, queue, deps };
}

async function savedQueuedInput(f: Awaited<ReturnType<typeof seed>>, validActor = true) {
  const now = new Date(), finished = new Date(now.getTime() - 5_000);
  // Actual native pre-dispatch unused admission: no provider ever started.
  const [source] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.builder.id,
    issueId: f.issue.id, nativeIssueId: f.issue.id, scopeKind: "issue", runtimeMode: "native", status: "cancelled",
    errorCode: "execution_reconciliation_required", startedAt: null, finishedAt: finished, createdAt: finished,
    responsibleUserId: f.userId, contextSnapshot: { issueId: f.issue.id } }).returning();
  const [comment] = await db.insert(issueComments).values({ companyId: f.company.id, issueId: f.issue.id,
    authorType: "user", authorUserId: f.userId, body: "Synthetic saved new direction", createdAt: now }).returning();
  const [saved] = await db.insert(agentWakeupRequests).values({ companyId: f.company.id, agentId: f.builder.id,
    source: "on_demand", triggerDetail: "manual", reason: "issue_commented", status: "deferred_issue_execution",
    requestedByActorType: "user", requestedByActorId: f.userId,
    payload: withQueuedCommentIdsInWakePayload({ issueId: f.issue.id,
      queuedCommentInterrupt: { actorId: validActor ? f.userId : "synthetic-wrong-actor", requestedAt: now.toISOString(), targetRunId: source.id } }, [comment.id]),
  }).returning();
  return { source, comment, saved, opts: { source: "on_demand" as const, triggerDetail: "manual" as const,
    reason: "issue_commented", requestedByActorType: "user" as const, requestedByActorId: f.userId,
    queuedCommentInterruptId: saved.id, payload: { issueId: f.issue.id, commentId: comment.id },
    contextSnapshot: { issueId: f.issue.id, wakeCommentId: comment.id, wakeCommentIds: [comment.id], source: "issue.comment" } } };
}

describe("actual native comment continuation consumers", () => {
  it.each([true, false])("persists a real ordinary HTTP comment and reopens atomically with total-five=%s", async enabled => {
    const f = await seed(enabled), budget = await f.budget();
    const response = await request(f.app).post(`/api/issues/${f.issue.id}/comments`).send({ body: "Synthetic explicit follow-up", resume: true, clientRequestId: randomUUID() });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const comments = await f.comments(); expect(comments).toHaveLength(1); expect(comments[0].id).toBe(response.body.id);
    expect((await f.read()).status).toBe("todo");
    if (enabled) {
      expect((await f.budget()).ledger).toEqual(budget.ledger);
      const [audit] = await db.select().from(activityLog).where(and(eq(activityLog.entityId, f.issue.id), eq(activityLog.action, "issue.native_operational_projection")));
      expect(audit.details).toMatchObject({ operation: "continuation", receiptId: comments[0].id, reviewAdmissionCreated: false });
    }
  });

  it("rolls back the new HTTP comment when an active scoped review refuses its reopen", async () => {
    const f = await seed(true, "blocked"), scope = randomUUID();
    await db.execute(sql`insert into issue_scoped_reviews(id,company_id,issue_id,snapshot,state)
      values(${scope},${f.company.id},${f.issue.id},'{"syntheticDraft":true}'::jsonb,'draft')`);
    const before = await f.read(), budget = await f.budget();
    const response = await request(f.app).post(`/api/issues/${f.issue.id}/comments`).send({ body: "Synthetic resume while review is controlled", resume: true, clientRequestId: randomUUID() });
    expect(response.status, JSON.stringify(response.body)).toBe(409); expect(response.body.details?.code).toBe("native_operational_scope_pending");
    expect(await f.comments()).toEqual([]); expect(await f.read()).toEqual(before); expect(await f.budget()).toEqual(budget);
  });

  it("refuses invalid-worktree dispatch before run creation while preserving the selected task and ledger", async () => {
    const f = await seed(true, "todo");
    await db.update(issues).set({ executionWorkspaceSettings: { mode: "isolated_workspace", workspaceStrategy: { type: "git_worktree" } } }).where(eq(issues.id, f.issue.id));
    const before = await f.read(), budget = await f.budget();
    expect(await f.queue.enqueueWakeup(f.builder.id, { source: "assignment", triggerDetail: "system", reason: "issue_assigned", payload: { issueId: f.issue.id }, contextSnapshot: { issueId: f.issue.id } })).toBeNull();
    expect(await f.read()).toEqual(before); expect(await f.budget()).toEqual(budget);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.company.id))).toEqual([]);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.company.id));
    expect(wake).toMatchObject({ status: "skipped", reason: WORKSPACE_WORKTREE_REQUIRES_PROJECT_CODE });
    expect((await f.comments())[0].body).toContain("task and review state are preserved"); expect(f.deps.executeRun).not.toHaveBeenCalled();
  });

  it("admits actual saved native input before selected completed-task reopen through a controlled executor", async () => {
    const f = await seed(), input = await savedQueuedInput(f), budget = await f.budget();
    const result = await f.queue.enqueueWakeup(f.builder.id, input.opts, input.saved.id);
    expect(result).not.toBeNull(); expect((await f.read()).status).toBe("todo"); expect((await f.budget()).ledger).toEqual(budget.ledger);
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.company.id));
    expect(runs).toHaveLength(2); const successor = runs.find(row => row.id !== input.source.id)!;
    expect(successor.contextSnapshot?.explicitUserContinuation).toMatchObject({ previousRunId: input.source.id, commentId: input.comment.id });
    expect(f.deps.executeRun).toHaveBeenCalledExactlyOnceWith(successor.id);
  });

  it("preserves completed selected work and saved input when its native continuation workspace is unrunnable", async () => {
    const f = await seed(), input = await savedQueuedInput(f);
    await db.update(issues).set({ executionWorkspaceSettings: { mode: "isolated_workspace", workspaceStrategy: { type: "git_worktree" } } }).where(eq(issues.id, f.issue.id));
    const before = await f.read(), budget = await f.budget();
    expect(await f.queue.enqueueWakeup(f.builder.id, input.opts, input.saved.id)).toBeNull();
    expect(await f.read()).toEqual(before); expect(await f.budget()).toEqual(budget);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.company.id))).toHaveLength(1);
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.company.id));
    expect(wakes.some(row => row.status === "skipped" && row.reason === WORKSPACE_WORKTREE_REQUIRES_PROJECT_CODE)).toBe(true);
    expect(f.deps.executeRun).not.toHaveBeenCalled();
  });

  it("does not reopen selected completed work from a raw queued pointer with a wrong native actor", async () => {
    const f = await seed(), input = await savedQueuedInput(f, false), before = await f.read(), budget = await f.budget();
    const result = await f.queue.enqueueWakeup(f.builder.id, input.opts, input.saved.id);
    expect(result).toBeNull(); expect(await f.read()).toEqual(before); expect(await f.budget()).toEqual(budget);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.company.id))).toHaveLength(1);
    expect(f.deps.executeRun).not.toHaveBeenCalled();
  });

  it("rolls back queued native admission when its selected task has an active review scope", async () => {
    const f = await seed(), input = await savedQueuedInput(f), scope = randomUUID();
    // Adversarial retained-state fixture: even a qualifying new native user
    // turn may not dissolve a separate pending review owner.
    await db.execute(sql`insert into issue_scoped_reviews(id,company_id,issue_id,snapshot,state)
      values(${scope},${f.company.id},${f.issue.id},'{"syntheticDraft":true}'::jsonb,'draft')`);
    const before = await f.read(), budget = await f.budget();
    const [sourceBefore] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.source.id));
    await expect(f.queue.enqueueWakeup(f.builder.id, input.opts, input.saved.id)).rejects.toMatchObject({
      details: { code: "native_operational_scope_pending" },
    });
    expect(await f.read()).toEqual(before); expect(await f.budget()).toEqual(budget);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.source.id)))[0]).toEqual(sourceBefore);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.company.id))).toHaveLength(1);
    expect(f.deps.executeRun).not.toHaveBeenCalled();
  });
});

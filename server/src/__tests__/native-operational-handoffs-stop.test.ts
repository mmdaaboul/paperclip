import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, authUsers, companies, companyMemberships, applyPendingMigrations, createDb,
  heartbeatRuns, issueExecutionDecisions, issueReviewCycleBudgets, issues, issueTreeHolds, issueTreeHoldMembers, caseHandoffs } from "@paperclipai/db";
import { issueExecutionStateSchema } from "@paperclipai/shared";
import { createReviewCycleBudget } from "../services/total-review-budget.js";
import { issueTreeControlService } from "../services/issue-tree-control.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { caseHandoffService } from "../services/case-handoffs.js";
import { PaperclipRunnerToolAuthority } from "../services/native-runtime/paperclip-runner-tool-authority.js";

// Real caller/authorization/task/hold/receipt/ledger consumers. No provider or
// worker is started; assignment notification dispatch alone is controlled.
vi.mock("../services/issue-assignment-wakeup.js", () => ({ queueIssueAssignmentWakeup: vi.fn() }));
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
let db: ReturnType<typeof createDb>;
let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let failed = false;
afterEach(context => { if (context.task.result?.state === "fail") failed = true; });
beforeAll(async () => {
  const url = process.env.PAPERCLIP_CONTINUATION_TEST_DATABASE_URL;
  if (url) {
    if (!/^pc_continuation_[a-f0-9]+_test$/.test(new URL(url).pathname.slice(1))) throw new Error("dedicated_synthetic_database_required");
    await applyPendingMigrations(url); db = createDb(url, { maxConnections: 2 });
  } else {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-native-handoff-stop-");
    db = createDb(temporary.connectionString, { maxConnections: 2 });
  }
  await instanceSettingsService(db).updateExperimental({ enableCases: true });
});
afterAll(async () => {
  await db?.$client.end({ timeout: 5 });
  // Provided databases and failed synthetic state remain retained.
  if (temporary && !failed) await temporary.cleanup();
});

async function seed(selected = true, status = "in_progress") {
  const userId = `handoff-stop-${randomUUID()}`, now = new Date();
  await db.insert(authUsers).values({ id: userId, name: "Synthetic board", email: `${userId}@example.test`, createdAt: now, updatedAt: now });
  const [company] = await db.insert(companies).values({ name: "Synthetic handoff Stop", issueCounter: 1, issuePrefix: `HS${randomUUID().replaceAll("-", "").slice(0, 8)}` }).returning();
  await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: userId, status: "active", membershipRole: "owner" });
  const [owner, receiver, reviewer] = await db.insert(agents).values(["Owner", "Receiver", "Reviewer"].map((name, i) => ({ companyId: company.id,
    name, role: i === 0 ? "ceo" : "engineer", status: "active", adapterType: "process", adapterConfig: {}, runtimeConfig: { heartbeat: { enabled: false } } }))).returning();
  const policy = { totalReviewCycles: 5, stages: [
    { id: randomUUID(), type: "review", participants: [{ id: randomUUID(), type: "agent", agentId: reviewer.id }] },
    { id: randomUUID(), type: "approval", participants: [{ id: randomUUID(), type: "user", userId }] },
  ] };
  const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Synthetic ordinary work", identifier: `${company.issuePrefix}-1`,
    status, assigneeAgentId: owner.id, responsibleUserId: userId, executionPolicy: selected ? policy : null }).returning();
  if (selected) await db.insert(issueReviewCycleBudgets).values({ companyId: company.id, issueId: issue.id, ledger: createReviewCycleBudget(company.id, issue.id) });
  const read = async (id = issue.id) => (await db.select().from(issues).where(eq(issues.id, id)))[0];
  const ledger = async (id = issue.id) => (await db.select().from(issueReviewCycleBudgets).where(eq(issueReviewCycleBudgets.issueId, id)))[0]?.ledger;
  const wakes = () => db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, company.id));
  const decisions = () => db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.companyId, company.id));
  return { company, userId, owner, receiver, reviewer, policy, issue, read, ledger, wakes, decisions,
    actor: { actorType: "user" as const, actorId: userId, userId } };
}
type Fixture = Awaited<ReturnType<typeof seed>>;
async function fence(f: Fixture, kind: "pending" | "scope", id = f.issue.id) {
  if (kind === "scope") await db.execute(sql`insert into issue_scoped_reviews(id,company_id,issue_id,snapshot,state)
    values(${randomUUID()},${f.company.id},${id},'{"syntheticDraft":true}'::jsonb,'draft')`);
  else await db.update(issues).set({ executionState: issueExecutionStateSchema.parse({ status: "pending", currentStageId: f.policy.stages[1].id,
    currentStageIndex: 1, currentStageType: "approval", currentParticipant: { type: "user", userId: f.userId, agentId: null },
    returnAssignee: { type: "agent", agentId: f.owner.id, userId: null }, completedStageIds: [], lastDecisionId: null,
    lastDecisionOutcome: null, totalReviewBudgetHold: true, totalReviewCyclesUsed: 0, totalReviewCycleAllowance: 5 }) }).where(eq(issues.id, id));
}

describe("native subtree Stop and restore use owned operational transitions", () => {
  it.each([true, false])("cancels and resumes interrupted ordinary work with total5=%s", async selected => {
    const f = await seed(selected), svc = issueTreeControlService(db), ledger = await f.ledger();
    const cancellation = await svc.createHold(f.company.id, f.issue.id, { mode: "cancel", actor: f.actor });
    expect((await svc.cancelIssueStatusesForHold(f.company.id, f.issue.id, cancellation.hold.id)).updatedIssueIds).toEqual([f.issue.id]);
    expect((await f.read()).status).toBe("cancelled");
    const restore = await svc.createHold(f.company.id, f.issue.id, { mode: "restore", actor: f.actor });
    expect((await svc.restoreIssueStatusesForHold(f.company.id, f.issue.id, restore.hold.id, { actor: f.actor })).updatedIssueIds).toEqual([f.issue.id]);
    expect(await f.read()).toMatchObject({ status: "todo", cancelledAt: null, executionRunId: null, checkoutRunId: null });
    expect(await f.ledger()).toEqual(ledger); expect(await f.wakes()).toEqual([]); expect(await f.decisions()).toEqual([]);
  });
  it.each(["pending", "scope"] as const)("retains %s review authority instead of fabricating subtree cancellation", async kind => {
    const f = await seed(), svc = issueTreeControlService(db); await fence(f, kind); const before = await f.read(), ledger = await f.ledger();
    const h = await svc.createHold(f.company.id, f.issue.id, { mode: "cancel", actor: f.actor });
    await expect(svc.cancelIssueStatusesForHold(f.company.id, f.issue.id, h.hold.id)).rejects.toMatchObject({ details: { code: kind === "pending" ? "native_operational_review_pending" : "native_operational_scope_pending" } });
    expect(await f.read()).toEqual(before); expect(await f.ledger()).toEqual(ledger); expect(await f.wakes()).toEqual([]);
    expect((await db.select().from(issueTreeHolds).where(eq(issueTreeHolds.id, h.hold.id)))[0].status).toBe("active");
  });
  it("retains scoped cancellation/restoration holds when a new scope blocks resume", async () => {
    const f = await seed(), svc = issueTreeControlService(db), h = await svc.createHold(f.company.id, f.issue.id, { mode: "cancel", actor: f.actor });
    await svc.cancelIssueStatusesForHold(f.company.id, f.issue.id, h.hold.id); await fence(f, "scope");
    const restore = await svc.createHold(f.company.id, f.issue.id, { mode: "restore", actor: f.actor }), before = await f.read();
    await expect(svc.restoreIssueStatusesForHold(f.company.id, f.issue.id, restore.hold.id, { actor: f.actor })).rejects.toMatchObject({ details: { code: "native_operational_scope_pending" } });
    expect(await f.read()).toEqual(before); expect(await f.wakes()).toEqual([]);
    expect((await db.select().from(issueTreeHolds).where(and(eq(issueTreeHolds.id, h.hold.id))))[0].status).toBe("active");
    expect((await db.select().from(issueTreeHolds).where(and(eq(issueTreeHolds.id, restore.hold.id))))[0].status).toBe("active");
  });
  it("names unsupported selected backlog restoration and retains both holds", async () => {
    const f = await seed(true, "backlog"), svc = issueTreeControlService(db), h = await svc.createHold(f.company.id, f.issue.id, { mode: "cancel", actor: f.actor });
    await svc.cancelIssueStatusesForHold(f.company.id, f.issue.id, h.hold.id);
    const restore = await svc.createHold(f.company.id, f.issue.id, { mode: "restore", actor: f.actor }), before = await f.read();
    await expect(svc.restoreIssueStatusesForHold(f.company.id, f.issue.id, restore.hold.id, { actor: f.actor })).rejects.toMatchObject({ details: { code: "native_operational_review_transition_required" } });
    expect(await f.read()).toEqual(before); expect(await f.wakes()).toEqual([]);
  });
});

async function reassign(f: Fixture, taskId = f.issue.id, key = randomUUID(), stop = vi.fn()) {
  const [caller] = await db.insert(issues).values({ companyId: f.company.id, title: "Synthetic caller", status: "in_progress", assigneeAgentId: f.owner.id }).returning();
  const [run] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.owner.id, status: "running", runtimeMode: "native",
    nativeIssueId: caller.id, contextSnapshot: { issueId: caller.id }, responsibleUserId: f.userId }).returning();
  await db.update(issues).set({ executionRunId: run.id }).where(eq(issues.id, caller.id));
  const wakeup = vi.fn(async () => null), target = await f.read(taskId);
  const authority = new PaperclipRunnerToolAuthority(db, { companyId: f.company.id, agentId: f.owner.id, issueId: caller.id,
    runId: run.id, stopTaskForReassignment: stop, enqueueWakeup: wakeup } as never);
  const invoke = () => authority.execute({ tool: "reassign_task", callId: randomUUID(), arguments: { taskId, idempotencyKey: key,
    expectedAssigneeActorId: target.assigneeAgentId, expectedAssigneeUserId: target.assigneeUserId,
    expectedStatusVersion: target.statusVersion, assigneeActorId: f.receiver.id, reason: "Synthetic authorized transfer" } });
  return { invoke, wakeup, stop };
}
describe("actual native semantic reassignment", () => {
  it.each([true, false])("transfers selected ordinary task and repairs receipt replay with total5=%s", async selected => {
    const f = await seed(selected), ledger = await f.ledger(), tool = await reassign(f);
    const receipt = await tool.invoke(); expect(receipt).toMatchObject({ disposition: "applied" });
    const after = await f.read(); expect(after).toMatchObject({ assigneeAgentId: f.receiver.id, status: "todo" });
    expect(await tool.invoke()).toEqual(receipt); expect(await f.read()).toEqual(after); expect(await f.ledger()).toEqual(ledger);
    expect(await f.decisions()).toEqual([]); expect(tool.stop).toHaveBeenCalledOnce();
    expect(tool.stop).toHaveBeenCalledWith({ companyId: f.company.id, issueId: f.issue.id, agentId: f.owner.id, runId: null });
  });
  it.each(["scope", "backlog"] as const)("does not stop/wake or transfer a selected %s refusal", async mode => {
    const f = await seed(true, mode === "backlog" ? "backlog" : "in_progress"); if (mode === "scope") await fence(f, "scope");
    const before = await f.read(), ledger = await f.ledger(), tool = await reassign(f);
    await expect(tool.invoke()).rejects.toMatchObject({ details: { code: mode === "scope" ? "native_operational_scope_pending" : "native_operational_review_transition_required" } });
    expect(await f.read()).toEqual(before); expect(await f.ledger()).toEqual(ledger); expect(tool.stop).not.toHaveBeenCalled(); expect(tool.wakeup).not.toHaveBeenCalled();
  });
});

describe("actual case handoff mutation", () => {
  it.each([true, false])("preserves admitted case receipt on an ordinary transfer with total5=%s", async selected => {
    const f = await seed(false), service = caseHandoffService(db), board = { type: "board" as const, source: "local_implicit" as const };
    const first = await service.handoff(f.company.id, board, { idempotencyKey: randomUUID(), case: { create: { caseType: "work", title: "Synthetic case" } },
      toAgentId: f.owner.id, phase: "triage", instructions: "Synthetic preparation", workflow_document_text: "# Synthetic workflow" });
    // Use the actual operator cancellation owner to retire initial pending
    // delivery without starting a provider; then transfer the same case/task.
    await service.cancel(board, first.caseId, first.handoffId);
    if (selected) { await db.update(issues).set({ executionPolicy: f.policy }).where(eq(issues.id, first.taskId));
      await db.insert(issueReviewCycleBudgets).values({ companyId: f.company.id, issueId: first.taskId, ledger: createReviewCycleBudget(f.company.id, first.taskId) }); }
    const before = await f.read(first.taskId), ledger = await f.ledger(first.taskId);
    const receipt = await service.handoff(f.company.id, board, { idempotencyKey: randomUUID(), case: { id: first.caseId },
      expectedHandoffVersion: 1, expectedIssueStatusVersion: before.statusVersion, toAgentId: f.receiver.id, phase: "implementation", instructions: "Synthetic transfer" });
    expect(receipt.state).toBe("pending_dispatch");
    expect(await f.read(first.taskId)).toMatchObject({ assigneeAgentId: f.receiver.id, status: "todo", executionRunId: null, checkoutRunId: null });
    expect((await db.select().from(caseHandoffs).where(eq(caseHandoffs.id, receipt.handoffId)))[0]).toMatchObject({ state: "pending_dispatch", appliedIssueStatusVersion: (await f.read(first.taskId)).statusVersion });
    expect(await f.ledger(first.taskId)).toEqual(ledger); expect(await f.decisions()).toEqual([]); expect(await f.wakes()).toEqual([]);
  });
});


it("does not restore-wake the old owner when a scoped review arrives during native Stop", async () => {
  const f = await seed(), [run] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.owner.id,
    status: "running", runtimeMode: "native", nativeIssueId: f.issue.id, contextSnapshot: { issueId: f.issue.id } }).returning();
  await db.update(issues).set({ executionRunId: run.id }).where(eq(issues.id, f.issue.id));
  const before = await f.read(), ledger = await f.ledger();
  const stop = vi.fn(async () => {
    await db.update(heartbeatRuns).set({ status: "cancelled", errorCode: "issue_reassigned", finishedAt: new Date() }).where(eq(heartbeatRuns.id, run.id));
    await fence(f, "scope");
  });
  const tool = await reassign(f, f.issue.id, randomUUID(), stop);
  await expect(tool.invoke()).rejects.toMatchObject({ details: { code: "native_operational_scope_pending" } });
  expect(stop).toHaveBeenCalledOnce(); expect(tool.wakeup).not.toHaveBeenCalled();
  expect(await f.read()).toEqual(before); expect(await f.ledger()).toEqual(ledger); expect(await f.decisions()).toEqual([]);
});


describe("HC1 actual current cancel hold proof", () => {
  it("refuses an already released cancel hold without touching selected task or ledger", async () => {
    const f = await seed(), svc = issueTreeControlService(db), h = await svc.createHold(f.company.id, f.issue.id, { mode: "cancel", actor: f.actor });
    await db.update(issueTreeHolds).set({ status: "released", releasedAt: new Date() }).where(eq(issueTreeHolds.id, h.hold.id));
    const before = await f.read(), ledger = await f.ledger();
    await expect(svc.cancelIssueStatusesForHold(f.company.id, f.issue.id, h.hold.id)).rejects.toMatchObject({ details: { code: "native_operational_cancel_hold_changed" } });
    expect(await f.read()).toEqual(before); expect(await f.ledger()).toEqual(ledger); expect(await f.wakes()).toEqual([]); expect(await f.decisions()).toEqual([]);
  });
  it.each(["released", "member-skipped"] as const)("rechecks actual %s after pre-read and before the mutation transaction", async change => {
    const f = await seed(), svc = issueTreeControlService(db), h = await svc.createHold(f.company.id, f.issue.id, { mode: "cancel", actor: f.actor });
    const before = await f.read(), ledger = await f.ledger();
    let entered!: () => void, resume!: () => void;
    const atBoundary = new Promise<void>(resolve => { entered = resolve; }), proceed = new Promise<void>(resolve => { resume = resolve; });
    const nativeTransaction = db.transaction.bind(db);
    // Control only the asynchronous scheduling boundary; all reads, locks,
    // release/member writes and final mutation are actual PostgreSQL operations.
    const barrier = vi.spyOn(db, "transaction").mockImplementationOnce(async (...args: Parameters<typeof db.transaction>) => {
      entered(); await proceed; return nativeTransaction(...args);
    });
    try {
      const pending = svc.cancelIssueStatusesForHold(f.company.id, f.issue.id, h.hold.id);
      const outcome = pending.then(value => ({ value }), error => ({ error }));
      await atBoundary;
      if (change === "released") await db.update(issueTreeHolds).set({ status: "released", releasedAt: new Date() }).where(eq(issueTreeHolds.id, h.hold.id));
      else await db.update(issueTreeHoldMembers).set({ skipped: true, skipReason: "Synthetic superseding decision" }).where(eq(issueTreeHoldMembers.holdId, h.hold.id));
      resume();
      expect(await outcome).toMatchObject({ error: { details: { code: "native_operational_cancel_hold_changed" } } });
      expect(await f.read()).toEqual(before); expect(await f.ledger()).toEqual(ledger); expect(await f.wakes()).toEqual([]); expect(await f.decisions()).toEqual([]);
    } finally { resume(); barrier.mockRestore(); }
  });
});

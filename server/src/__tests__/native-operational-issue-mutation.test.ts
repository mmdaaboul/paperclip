import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, authUsers, cases, caseHandoffs, companies, companyMemberships, createDb, heartbeatRuns,
  issueExecutionDecisions, issueReviewCycleBudgets, issues, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { issueExecutionStateSchema } from "@paperclipai/shared";
import { mutateNativeOperationalIssue, nativeOperationalIssueSnapshot, type NativeOperationalIssueOperation } from "../services/native-operational-issue-mutation.js";
import { issueService } from "../services/issues.js";
import { admitReviewCycle, createReviewCycleBudget } from "../services/total-review-budget.js";

// Actual migrated PostgreSQL, ledger owner, native task setter and audit. No
// provider/worker is started; assignment dispatch alone is controlled.
vi.mock("../services/issue-assignment-wakeup.js", () => ({ queueIssueAssignmentWakeup: vi.fn() }));
type Db = ReturnType<typeof createDb>;
let db: Db;
let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let failed = false;

beforeAll(async () => {
  const supplied = process.env.PAPERCLIP_NATIVE_OPERATIONAL_TEST_DATABASE_URL;
  if (supplied) {
    if (!/^pc_native_operational_[a-f0-9]+_test$/.test(new URL(supplied).pathname.slice(1))) throw new Error("dedicated_synthetic_database_required");
    db = createDb(supplied, { maxConnections: 2, applicationName: "native-operational-issue-test" });
  } else {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-native-operational-");
    db = createDb(temporary.connectionString, { maxConnections: 2 });
  }
}, 90_000);
afterEach(context => { if (context.task.result?.state === "fail") failed = true; });
afterAll(async () => {
  await db?.$client.end({ timeout: 5 });
  // A caller-supplied NEW database is always retained. Failed synthetic state is
  // also retained; no existing operational/restore database is ever selected.
  if (temporary && !failed) await temporary.cleanup();
});

async function seed(total5 = true) {
  const now = new Date(), userId = `operational-human-${randomUUID()}`;
  await db.insert(authUsers).values({ id: userId, name: "Synthetic human", email: `${userId}@example.test`, createdAt: now, updatedAt: now });
  const [company] = await db.insert(companies).values({ name: "Synthetic operational adapter", issuePrefix: `OP${randomUUID().replaceAll("-", "").slice(0, 8)}` }).returning();
  await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: userId, status: "active", membershipRole: "owner" });
  const [builder, reviewer, recipient] = await db.insert(agents).values(["Builder", "Reviewer", "Recipient"].map(name => ({ companyId: company.id,
    name, role: "engineer", status: "active", adapterType: "process", adapterConfig: {}, runtimeConfig: { heartbeat: { enabled: false } } }))).returning();
  const policy = total5 ? { totalReviewCycles: 5, stages: [
    { id: randomUUID(), type: "review", participants: [{ id: randomUUID(), type: "agent", agentId: reviewer.id }] },
    { id: randomUUID(), type: "approval", participants: [{ id: randomUUID(), type: "user", userId }] },
  ] } : null;
  const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Synthetic operational task", identifier: `${company.issuePrefix}-1`,
    status: "in_progress", assigneeAgentId: builder.id, responsibleUserId: userId, executionPolicy: policy }).returning();
  const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: builder.id, issueId: issue.id, nativeIssueId: issue.id,
    scopeKind: "issue", status: "running", responsibleUserId: userId, startedAt: now, contextSnapshot: { issueId: issue.id } }).returning();
  await db.update(issues).set({ executionRunId: run.id, checkoutRunId: run.id }).where(eq(issues.id, issue.id));
  if (total5) await db.insert(issueReviewCycleBudgets).values({ companyId: company.id, issueId: issue.id, ledger: createReviewCycleBudget(company.id, issue.id) });
  const read = async () => (await db.select().from(issues).where(eq(issues.id, issue.id)))[0];
  const budget = async () => (await db.select().from(issueReviewCycleBudgets).where(eq(issueReviewCycleBudgets.issueId, issue.id)))[0];
  const audit = () => db.select().from(activityLog).where(and(eq(activityLog.entityId, issue.id), eq(activityLog.action, "issue.native_operational_projection")));
  const apply = async (operation: NativeOperationalIssueOperation, expected?: ReturnType<typeof nativeOperationalIssueSnapshot>) => {
    const observed = expected ?? nativeOperationalIssueSnapshot(await read());
    return db.transaction(tx => mutateNativeOperationalIssue(tx, { companyId: company.id, issueId: issue.id, expected: observed, operation }, [], []));
  };
  const block = (): NativeOperationalIssueOperation => ({ kind: "failure_block", runId: run.id, target: "blocked" });
  return { company, userId, builder, reviewer, recipient, issue, run, policy, read, budget, audit, apply, block };
}

function reviewState(f: Awaited<ReturnType<typeof seed>>, humanHold = false, completed = false) {
  return issueExecutionStateSchema.parse({ status: completed ? "completed" : "pending", currentStageId: f.policy!.stages[0].id,
    currentStageIndex: 0, currentStageType: "review", currentParticipant: humanHold ? { type: "user", agentId: null, userId: f.userId }
      : { type: "agent", agentId: f.reviewer.id, userId: null },
    returnAssignee: { type: "agent", agentId: f.builder.id, userId: null }, completedStageIds: completed ? f.policy!.stages.map(s => s.id) : [],
    lastDecisionId: null, lastDecisionOutcome: null, totalReviewBudgetHold: humanHold,
    totalReviewCyclesUsed: 0, totalReviewCycleAllowance: 5 });
}

describe("native operational task mutations use the actual locked review owner", () => {
  it("accepts the full native row as expected and explicitly returns effects to the outer commit owner", async () => {
    const f = await seed(), observed = await f.read(), publications: any[] = [], actions: any[] = [];
    const result = await db.transaction(tx => mutateNativeOperationalIssue(tx, { companyId: f.company.id,
      issueId: f.issue.id, expected: observed, operation: f.block() }, publications, actions));
    expect(result.kind).toBe("applied"); expect(publications.length).toBeGreaterThan(0); expect(actions).toEqual([]);
    const before = await f.read();
    await expect(db.transaction(tx => mutateNativeOperationalIssue(tx, { companyId: f.company.id, issueId: f.issue.id,
      expected: before, operation: { kind: "owned_resume", runId: f.run.id, target: "todo", receiptId: randomUUID() } }, undefined as never, [])))
      .rejects.toThrow("native_operational_outer_commit_effect_queues_required");
    expect(await f.read()).toEqual(before);
  });

  it("reproduces the old setter refusal and outer rollback that can mask a primary failure", async () => {
    const f = await seed();
    await expect(db.transaction(async tx => {
      await tx.update(heartbeatRuns).set({ status: "failed", error: "Synthetic original bootstrap failure" }).where(eq(heartbeatRuns.id, f.run.id));
      await issueService(tx as unknown as Db).update(f.issue.id, { status: "blocked" }, tx);
    })).rejects.toMatchObject({ details: { code: "total_review_adapter_required" } });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0].status).toBe("running");
  });

  it("commits the original failure and operational block without creating a review admission or verdict", async () => {
    const f = await seed(), before = await f.budget(), expected = nativeOperationalIssueSnapshot(await f.read());
    const result = await db.transaction(async tx => {
      await tx.update(heartbeatRuns).set({ status: "failed", error: "Synthetic original bootstrap failure" }).where(eq(heartbeatRuns.id, f.run.id));
      return mutateNativeOperationalIssue(tx, { companyId: f.company.id, issueId: f.issue.id, expected, operation: f.block() }, [], []);
    });
    expect(result.kind).toBe("applied"); expect((await f.read()).status).toBe("blocked");
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0].error).toBe("Synthetic original bootstrap failure");
    expect((await f.budget()).ledger).toEqual(before.ledger);
    expect(await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, f.issue.id))).toEqual([]);
    expect(await f.audit()).toHaveLength(1);
  });

  it.each([false, true])("defers pending review/human hold=%s while retaining the primary failure and exact review state", async human => {
    const f = await seed(), state = reviewState(f, human);
    await db.update(issues).set({ status: "in_review", executionState: state, assigneeAgentId: human ? null : f.reviewer.id,
      assigneeUserId: human ? f.userId : null }).where(eq(issues.id, f.issue.id));
    const before = await f.read(), budget = await f.budget();
    const result = await db.transaction(async tx => {
      await tx.update(heartbeatRuns).set({ status: "failed", error: "Synthetic provider error retained" }).where(eq(heartbeatRuns.id, f.run.id));
      return mutateNativeOperationalIssue(tx, { companyId: f.company.id, issueId: f.issue.id,
        expected: nativeOperationalIssueSnapshot(before), operation: f.block() }, [], []);
    });
    expect(result).toEqual({ kind: "deferred", code: "native_operational_review_pending" });
    expect(await f.read()).toEqual(before); expect(await f.budget()).toEqual(budget); expect(await f.audit()).toEqual([]);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0].error).toBe("Synthetic provider error retained");
  });

  it.each(["draft", "pending", "cancelling"])("preserves a real active scoped row (%s) and its ledger", async state => {
    const f = await seed(), scopeId = randomUUID();
    // Only the active-row fence is under test, not a fabricated scoped verdict.
    await db.execute(sql`insert into issue_scoped_reviews(id,company_id,issue_id,snapshot,state)
      values(${scopeId},${f.company.id},${f.issue.id},'{"syntheticDraft":true}'::jsonb,${state})`);
    const before = await f.read(), budget = await f.budget();
    expect(await f.apply(f.block())).toEqual({ kind: "deferred", code: "native_operational_scope_pending" });
    expect(await f.read()).toEqual(before); expect(await f.budget()).toEqual(budget);
    const scope = await db.execute(sql`select state,snapshot from issue_scoped_reviews where id=${scopeId}`);
    expect(scope[0]).toMatchObject({ state, snapshot: { syntheticDraft: true } });
  });

  it("defers native finalizer in_review fallback rather than submitting a fake candidate", async () => {
    const f = await seed(), before = await f.budget();
    expect(await f.apply({ kind: "failure_block", runId: f.run.id, target: "in_review" })).toEqual({ kind: "deferred", code: "native_operational_review_transition_required" });
    expect((await f.read()).status).toBe("in_progress"); expect(await f.budget()).toEqual(before);
  });

  it("rolls back an invalid recipient projection without rolling back the original failure or leaking publications", async () => {
    const f = await seed(), before = await f.budget(), publications: any[] = [], actions: any[] = [];
    const result = await db.transaction(async tx => {
      await tx.update(heartbeatRuns).set({ status: "failed", error: "Synthetic original failure" }).where(eq(heartbeatRuns.id, f.run.id));
      return mutateNativeOperationalIssue(tx, { companyId: f.company.id, issueId: f.issue.id,
        expected: nativeOperationalIssueSnapshot(await f.read()), operation: { kind: "handoff", receiptId: randomUUID(), assignee: { agentId: randomUUID() } } }, publications, actions);
    });
    expect(result.kind).toBe("projection_failed"); expect((await f.read()).status).toBe("in_progress");
    expect(await f.budget()).toEqual(before); expect(await f.audit()).toEqual([]); expect(publications).toEqual([]); expect(actions).toEqual([]);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0].error).toBe("Synthetic original failure");
  });

  it.each(["statusVersion", "assigneeAgentId", "executionRunId", "checkoutRunId"] as const)("refuses stale %s without partial ledger/audit writes", async key => {
    const f = await seed(), expected = nativeOperationalIssueSnapshot(await f.read()), budget = await f.budget();
    const wrong = { ...expected, [key]: key === "statusVersion" ? expected.statusVersion + 1 : randomUUID() };
    expect(await f.apply(f.block(), wrong)).toEqual({ kind: "deferred", code: "native_operational_issue_changed" });
    expect(await f.budget()).toEqual(budget); expect(await f.audit()).toEqual([]);
  });

  it("refuses a run different from the actual native execution owner", async () => {
    const f = await seed();
    expect(await f.apply({ kind: "failure_block", runId: randomUUID(), target: "blocked" })).toEqual({ kind: "deferred", code: "native_operational_issue_changed" });
  });

  it("supports caller-proven owned resume, exact native handoff and owned cancellation without resetting accounting", async () => {
    const f = await seed(), original = (await f.budget()).ledger;
    expect((await f.apply(f.block())).kind).toBe("applied");
    expect((await f.apply({ kind: "owned_resume", runId: f.run.id, receiptId: randomUUID(), target: "in_progress" })).kind).toBe("applied");
    // Actual native caller must settle the run before a handoff; no helper starts
    // or stops processes and this test explicitly clears only synthetic ownership.
    await db.update(issues).set({ executionRunId: null, checkoutRunId: null }).where(eq(issues.id, f.issue.id));
    expect((await f.apply({ kind: "handoff", receiptId: randomUUID(), assignee: { agentId: f.recipient.id } })).kind).toBe("applied");
    expect((await f.read()).assigneeAgentId).toBe(f.recipient.id);
    expect((await f.apply({ kind: "owned_cancel", receiptId: randomUUID() })).kind).toBe("applied");
    expect((await f.read()).status).toBe("cancelled"); expect((await f.budget()).ledger).toEqual(original);
  });

  it("preserves the native case handoff owner instead of cancelling its own pending receipt during assignment", async () => {
    const f = await seed();
    await db.update(issues).set({ executionRunId: null, checkoutRunId: null }).where(eq(issues.id, f.issue.id));
    const [record] = await db.insert(cases).values({ companyId: f.company.id, workIssueId: f.issue.id,
      caseNumber: 1, identifier: `${f.company.issuePrefix}-CASE`, caseType: "synthetic", title: "Synthetic handoff owner" }).returning();
    const [handoff] = await db.insert(caseHandoffs).values({ companyId: f.company.id, caseId: record.id, issueId: f.issue.id,
      version: 1, fromAgentId: f.builder.id, toAgentId: f.recipient.id, phase: "synthetic", instructions: "Synthetic handoff",
      actorType: "user", actorId: f.userId, sourceRunId: f.run.id, responsibleUserId: f.userId,
      wakeupRequestId: randomUUID(), idempotencyKey: randomUUID(), inputFingerprint: "synthetic", state: "awaiting_release" }).returning();
    expect((await f.apply({ kind: "handoff", receiptId: handoff.id, caseHandoffId: handoff.id, assignee: { agentId: f.recipient.id } })).kind).toBe("applied");
    expect((await f.read()).assigneeAgentId).toBe(f.recipient.id);
    expect((await db.select().from(caseHandoffs).where(eq(caseHandoffs.id, handoff.id)))[0].state).toBe("awaiting_release");
  });

  it("reopens a completed task through its native transition while retaining all historical usage", async () => {
    const f = await seed(), state = reviewState(f, false, true);
    const used = admitReviewCycle(createReviewCycleBudget(f.company.id, f.issue.id), { id: randomUUID(), companyId: f.company.id,
      issueId: f.issue.id, builderAgentId: f.builder.id, builderRunId: f.run.id, candidateId: "synthetic-historical-candidate", kind: "normal", scopeId: null }, new Date().toISOString()).budget;
    await db.update(issueReviewCycleBudgets).set({ ledger: used }).where(eq(issueReviewCycleBudgets.issueId, f.issue.id));
    await db.update(issues).set({ status: "done", executionState: state, executionRunId: null, checkoutRunId: null }).where(eq(issues.id, f.issue.id));
    expect((await f.apply({ kind: "continuation", receiptId: randomUUID() })).kind).toBe("applied");
    expect((await f.read()).status).toBe("todo"); expect((await f.read()).executionState).toBeNull();
    expect((await f.budget()).ledger).toEqual(used);
  });

  it("keeps the default-off native in_review projection available", async () => {
    const f = await seed(false);
    expect((await f.apply({ kind: "failure_block", runId: f.run.id, target: "in_review" })).kind).toBe("applied");
    expect((await f.read()).status).toBe("in_review"); expect(await f.budget()).toBeUndefined();
  });

  it("clears completed default-off execution state for native done/cancelled continuation", async () => {
    for (const status of ["done", "cancelled"]) {
      const f = await seed(false);
      const state = issueExecutionStateSchema.parse({ status: "completed", currentStageId: null, currentStageIndex: null,
        currentStageType: null, currentParticipant: null, returnAssignee: { type: "agent", agentId: f.builder.id, userId: null },
        completedStageIds: [randomUUID()], lastDecisionId: null, lastDecisionOutcome: "approved" });
      await db.update(issues).set({ status, executionState: state, executionRunId: null, checkoutRunId: null }).where(eq(issues.id, f.issue.id));
      expect((await f.apply({ kind: "continuation", receiptId: randomUUID() })).kind).toBe("applied");
      expect((await f.read()).status).toBe("todo"); expect((await f.read()).executionState).toBeNull();
      expect(await f.budget()).toBeUndefined();
    }
  });

  it.each([false, true])("restores legacy-owned in_review only outside total-five (enabled=%s)", async enabled => {
    const f = await seed(enabled);
    expect((await f.apply(f.block())).kind).toBe("applied");
    const before = await f.read(), budget = await f.budget();
    const result = await f.apply({ kind: "owned_resume", runId: f.run.id, receiptId: randomUUID(), target: "in_review" });
    if (enabled) {
      expect(result).toEqual({ kind: "deferred", code: "native_operational_review_transition_required" });
      expect(await f.read()).toEqual(before); expect(await f.budget()).toEqual(budget);
    } else {
      expect(result.kind).toBe("applied"); expect((await f.read()).status).toBe("in_review");
      expect(await f.budget()).toBeUndefined();
    }
  });

  it("does not export a callback capability or weaken the raw setter guard after success", async () => {
    const f = await seed();
    await db.transaction(async tx => {
      expect((await mutateNativeOperationalIssue(tx, { companyId: f.company.id, issueId: f.issue.id,
        expected: nativeOperationalIssueSnapshot(await f.read()), operation: f.block() }, [], [])).kind).toBe("applied");
      await expect(tx.transaction(async other => issueService(other as unknown as Db).update(f.issue.id, { status: "done" }, other)))
        .rejects.toMatchObject({ details: { code: "total_review_adapter_required" } });
    });
    expect((await f.read()).status).toBe("blocked");
  });

  it("rejects an untyped done or arbitrary policy request instead of treating it as an operational projection", async () => {
    const f = await seed(), before = await f.budget();
    for (const operation of [{ kind: "failure_block", runId: f.run.id, target: "done" }, { ...f.block(), executionPolicy: null }]) {
      expect((await f.apply(operation as NativeOperationalIssueOperation)).kind).toBe("projection_failed");
    }
    expect((await f.read()).status).toBe("in_progress"); expect(await f.budget()).toEqual(before);
  });

  it("serializes two contenders so only one exact source snapshot can mutate", async () => {
    const f = await seed(), expected = nativeOperationalIssueSnapshot(await f.read());
    const results = await Promise.all([f.apply(f.block(), expected), f.apply(f.block(), expected)]);
    expect(results.map(r => r.kind).sort()).toEqual(["applied", "deferred"]); expect(await f.audit()).toHaveLength(1);
  });
});

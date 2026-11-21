import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, agentWakeupRequests, authUsers, companies, companyMemberships, completionContracts,
  connectionIntentDeliveries, createDb, applyPendingMigrations, heartbeatRuns, issueComments, issueExecutionDecisions, issueRecoveryActions,
  issueReviewCycleBudgets, issueThreadInteractions, issues, nativeRunResults, statusDecisionEffects, statusDecisions, workAssessments } from "@paperclipai/db";
import { issueExecutionStateSchema } from "@paperclipai/shared";
import * as activityOwner from "../services/activity-log.js";
import * as issueOwner from "../services/issues.js";
import { createReviewCycleBudget } from "../services/total-review-budget.js";
import { saveUndeliveredUserComments } from "../services/work-intent-outbox.js";
import { LEGACY_RECOVERY_CAUSE, settleCancelledLegacyPreparation, settleInterruptedNativeBootstrap } from "../services/legacy-execution-recovery.js";
import { connectionIntentDeliveryService } from "../services/connection-intent-delivery.js";
import { dismissObsoleteNativePolicyReviews } from "../services/native-runtime/obsolete-policy-reviews.js";

// Actual native migrated PostgreSQL, real callers, task setter and locked ledger.
// Only external connection availability and assignment dispatch are controlled;
// no provider, worker, credential acquisition or replacement run is started.
vi.mock("../services/issue-assignment-wakeup.js", () => ({ queueIssueAssignmentWakeup: vi.fn() }));
vi.mock("../services/connection-intents.js", async importOriginal => ({
  ...await importOriginal<typeof import("../services/connection-intents.js")>(),
  connectionIntentService: () => ({ usableConnectionForAgent: async () => ({ id: "synthetic-available-connection" }) }),
}));
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
let db: ReturnType<typeof createDb>;
let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let failed = false;
afterEach(context => { if (context.task.result?.state === "fail") failed = true; });
beforeAll(async () => {
  const supplied = process.env.PAPERCLIP_CONTINUATION_TEST_DATABASE_URL;
  if (supplied) {
    if (!/^pc_continuation_[a-f0-9]+_test$/.test(new URL(supplied).pathname.slice(1))) throw new Error("dedicated_synthetic_database_required");
    await applyPendingMigrations(supplied);
    db = createDb(supplied, { maxConnections: 2, applicationName: "native-operational-continuations-test" });
  } else {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-native-continuations-");
    db = createDb(temporary.connectionString, { maxConnections: 2 });
  }
});
afterAll(async () => {
  await db?.$client.end({ timeout: 5 });
  // Provided databases and failed synthetic state remain retained.
  if (temporary && !failed) await temporary.cleanup();
});

async function seed(total5 = true, status = "blocked") {
  const now = new Date(), userId = `continuation-${randomUUID()}`;
  await db.insert(authUsers).values({ id: userId, name: "Synthetic human", email: `${userId}@example.test`, createdAt: now, updatedAt: now });
  const [company] = await db.insert(companies).values({ name: "Synthetic continuation", issuePrefix: `CT${randomUUID().replaceAll("-", "").slice(0, 8)}` }).returning();
  await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: userId, status: "active", membershipRole: "owner" });
  const [builder, reviewer] = await db.insert(agents).values(["Builder", "Reviewer"].map(name => ({ companyId: company.id,
    name, role: "engineer", status: "active", adapterType: "process", adapterConfig: {}, runtimeConfig: { heartbeat: { enabled: false } } }))).returning();
  const policy = total5 ? { totalReviewCycles: 5, stages: [
    { id: randomUUID(), type: "review", participants: [{ id: randomUUID(), type: "agent", agentId: reviewer.id }] },
    { id: randomUUID(), type: "approval", participants: [{ id: randomUUID(), type: "user", userId }] },
  ] } : null;
  const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Synthetic continuation", identifier: `${company.issuePrefix}-1`,
    status, assigneeAgentId: builder.id, responsibleUserId: userId, executionPolicy: policy }).returning();
  const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: builder.id, issueId: issue.id,
    scopeKind: "issue", status: "interrupted", responsibleUserId: userId, startedAt: now, finishedAt: now,
    executionStage: "preparing", runtimeMode: "legacy", errorCode: "server_shutdown_interrupted",
    runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" } }, contextSnapshot: { issueId: issue.id } }).returning();
  if (total5) await db.insert(issueReviewCycleBudgets).values({ companyId: company.id, issueId: issue.id, ledger: createReviewCycleBudget(company.id, issue.id) });
  const read = async () => (await db.select().from(issues).where(eq(issues.id, issue.id)))[0];
  const ledger = async () => (await db.select().from(issueReviewCycleBudgets).where(eq(issueReviewCycleBudgets.issueId, issue.id)))[0]?.ledger;
  const wakes = () => db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, company.id));
  const decisions = () => db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, issue.id));
  const runRead = async () => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0];
  return { company, builder, reviewer, userId, policy, issue, run, read, ledger, wakes, decisions, runRead };
}
type Fixture = Awaited<ReturnType<typeof seed>>;
async function fence(f: Fixture, kind: "pending" | "scope") {
  if (kind === "scope") await db.execute(sql`insert into issue_scoped_reviews(id,company_id,issue_id,snapshot,state)
    values(${randomUUID()},${f.company.id},${f.issue.id},'{"syntheticDraft":true}'::jsonb,'draft')`);
  else await db.update(issues).set({ executionState: issueExecutionStateSchema.parse({ status: "pending", currentStageId: f.policy!.stages[1].id,
    currentStageIndex: 1, currentStageType: "approval", currentParticipant: { type: "user", userId: f.userId, agentId: null },
    returnAssignee: { type: "agent", agentId: f.builder.id, userId: null }, completedStageIds: [], lastDecisionId: null,
    lastDecisionOutcome: null, totalReviewBudgetHold: true, totalReviewCyclesUsed: 0, totalReviewCycleAllowance: 5 }) }).where(eq(issues.id, f.issue.id));
}
async function hold(f: Fixture, kind: "interrupted" | "cancelled", previousStatus = "in_progress") {
  if (kind === "cancelled") await db.update(heartbeatRuns).set({ status: "cancelled", errorCode: "cancelled",
    resultJson: { cancellation: { source: "operator", expected: true, initiator: { type: "user", id: f.userId }, reason: "Synthetic Stop", recordedAt: new Date().toISOString() } } }).where(eq(heartbeatRuns.id, f.run.id));
  const [action] = await db.insert(issueRecoveryActions).values({ companyId: f.company.id, sourceIssueId: f.issue.id,
    kind: "active_run_watchdog", ownerType: "board", cause: LEGACY_RECOVERY_CAUSE, fingerprint: `legacy-execution:${f.run.id}`,
    nextAction: "Synthetic retained bootstrap", evidence: { runId: f.run.id,
      [kind === "cancelled" ? "legacyCancellationBlock" : "nativeBootstrapFailureBlock"]: { runId: f.run.id, statusVersion: f.issue.statusVersion, previousStatus } } }).returning();
  return { action, read: async () => (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id)))[0] };
}
async function settle(f: Fixture, kind: "interrupted" | "cancelled") {
  return kind === "interrupted" ? settleInterruptedNativeBootstrap(db, { run: await f.runRead(), providerDispatchStarted: false })
    : settleCancelledLegacyPreparation(db, { run: await f.runRead(), providerDispatchStarted: false });
}

describe("native continuation callers retain five-total workflow ownership", () => {
  it.each(["interrupted", "cancelled"] as const)("restores exact %s owned block without quota or review decisions", async kind => {
    const f = await seed(), h = await hold(f, kind), ledger = await f.ledger();
    expect(await settle(f, kind)).not.toBeNull();
    expect((await f.read()).status).toBe("in_progress");
    expect(await h.read()).toMatchObject({ status: "resolved", outcome: "false_positive" });
    expect((await f.runRead()).resultJson?.executionRecovery).toMatchObject({ kind: "bootstrap", providerWorkStarted: false });
    expect(await f.ledger()).toEqual(ledger); expect(await f.decisions()).toEqual([]); expect(await f.wakes()).toEqual([]);
  });
  it.each(["interrupted", "cancelled"] as const)("defers %s unknown claimed in_review without replay certificate or hold resolution", async kind => {
    const f = await seed(), h = await hold(f, kind, "in_review"), before = await f.read(), ledger = await f.ledger();
    expect(await settle(f, kind)).toBeNull();
    expect(await f.read()).toEqual(before); expect(await f.ledger()).toEqual(ledger); expect(await f.wakes()).toEqual([]);
    expect(await h.read()).toMatchObject({ status: "active", evidence: { nativeOperationalRestore: { kind: "deferred", code: "native_operational_review_transition_required" } } });
    expect((await f.runRead()).resultJson?.executionRecovery).toBeUndefined(); expect(await f.decisions()).toEqual([]);
  });
  it.each(["pending", "scope"] as const)("preserves exact interrupted hold and task behind %s", async kind => {
    const f = await seed(), h = await hold(f, "interrupted"); await fence(f, kind); const before = await f.read(), ledger = await f.ledger();
    expect(await settle(f, "interrupted")).toBeNull(); expect(await f.read()).toEqual(before); expect((await h.read()).status).toBe("active");
    expect(await f.ledger()).toEqual(ledger); expect(await f.wakes()).toEqual([]); expect((await f.runRead()).resultJson?.executionRecovery).toBeUndefined();
  });
  it("preserves default-off in_review restoration", async () => {
    const f = await seed(false), h = await hold(f, "interrupted", "in_review");
    expect(await settle(f, "interrupted")).not.toBeNull(); expect((await f.read()).status).toBe("in_review"); expect((await h.read()).status).toBe("resolved");
  });
  it.each(["none", "pending", "scope"] as const)("reopens agent-closed task for a real human comment only when %s permits", async kind => {
    const f = await seed(true, "done");
    await db.insert(activityLog).values({ companyId: f.company.id, actorType: "agent", actorId: f.builder.id,
      action: "issue.updated", entityType: "issue", entityId: f.issue.id, details: { toStatus: "done" } });
    const [comment] = await db.insert(issueComments).values({ companyId: f.company.id, issueId: f.issue.id, authorUserId: f.userId, body: "Synthetic continuation request" }).returning();
    if (kind !== "none") await fence(f, kind); const before = await f.read(), ledger = await f.ledger();
    const result = await saveUndeliveredUserComments(db, { companyId: f.company.id, issueId: f.issue.id, agentId: f.builder.id,
      commentIds: [comment.id], allowedStatuses: ["done"], reopenAgentClosedDone: true });
    if (kind === "none") { expect(result).toEqual(expect.any(String)); expect((await f.read()).status).toBe("todo");
      expect(await f.wakes()).toMatchObject([{ status: "deferred_issue_execution", payload: { commentId: comment.id } }]); }
    else { expect(result).toBeNull(); expect(await f.read()).toEqual(before); expect(await f.wakes()).toEqual([]); }
    expect(await f.ledger()).toEqual(ledger); expect(await f.decisions()).toEqual([]);
  });
  it.each(["none", "pending", "scope"] as const)("public connection delivery %s restores only an admitted AI configuration incident", async kind => {
    const f = await seed(); await db.update(heartbeatRuns).set({ status: "failed", errorCode: "configuration_incomplete",
      resultJson: { configurationIncomplete: { reason: "ai_connection_unavailable" } } }).where(eq(heartbeatRuns.id, f.run.id));
    const [recovery] = await db.insert(issueRecoveryActions).values({ companyId: f.company.id, sourceIssueId: f.issue.id,
      kind: "configuration", cause: "configuration_incomplete", fingerprint: randomUUID(), nextAction: "Repair synthetic connection", evidence: { latestRunId: f.run.id } }).returning();
    const [card] = await db.insert(issueThreadInteractions).values({ companyId: f.company.id, issueId: f.issue.id, kind: "connection_intent", status: "accepted",
      sourceRunId: f.run.id, addresseeUserId: f.userId, resolvedByUserId: f.userId, resolvedAt: new Date(),
      payload: { version: 1, requestingAgentId: f.builder.id, serviceSlug: "codex", purpose: "ai" } as never }).returning();
    await db.insert(connectionIntentDeliveries).values({ companyId: f.company.id, interactionId: card.id });
    if (kind !== "none") await fence(f, kind); const before = await f.read(), ledger = await f.ledger();
    // The only dispatch double persists the real native wake receipt, and reads
    // via another connection: it must see committed restoration and resolution.
    const wakeup = vi.fn(async (agentId: string, input: any) => {
      expect((await f.read()).status).toBe("in_progress");
      expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, recovery.id)))[0].status).toBe("resolved");
      await db.insert(agentWakeupRequests).values({ companyId: f.company.id, agentId, source: input.source, reason: input.reason,
        status: "queued", payload: input.payload, idempotencyKey: input.idempotencyKey });
      return null;
    });
    await connectionIntentDeliveryService(db, { wakeup } as never).deliver(card.id);
    if (kind === "none") { expect(wakeup).toHaveBeenCalledOnce(); expect((await f.read()).status).toBe("in_progress");
      expect((await db.select().from(connectionIntentDeliveries).where(eq(connectionIntentDeliveries.interactionId, card.id)))[0].deliveredAt).not.toBeNull(); }
    else { expect(wakeup).not.toHaveBeenCalled(); expect(await f.read()).toEqual(before);
      expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, recovery.id)))[0].status).toBe("active"); }
    expect(await f.ledger()).toEqual(ledger); expect(await f.decisions()).toEqual([]);
  });
});

async function obsolete(f: Fixture, fromStatus: string) {
  const contractId = randomUUID(), resultId = randomUUID(), assessmentId = randomUUID(), decisionId = randomUUID();
  await db.insert(completionContracts).values({ id: contractId, companyId: f.company.id, issueId: f.issue.id, revision: 1,
    schemaVersion: "paperclip.completion-contract.v1", policyVersion: "synthetic-obsolete", risk: "standard",
    completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal", contractJson: {},
    canonicalSha256: randomUUID(), createdByActorType: "system", createdByActorId: "synthetic-fixture" });
  await db.update(heartbeatRuns).set({ nativeIssueId: f.issue.id, completionContractId: contractId }).where(eq(heartbeatRuns.id, f.run.id));
  await db.insert(nativeRunResults).values({ id: resultId, companyId: f.company.id, issueId: f.issue.id, runId: f.run.id,
    completionContractId: contractId, serverFingerprint: randomUUID(), schemaStatus: "accepted", resultJson: {}, canonicalSha256: randomUUID() });
  await db.insert(workAssessments).values({ id: assessmentId, companyId: f.company.id, issueId: f.issue.id, runId: f.run.id,
    contractId, resultId, triggerKind: "native_result", triggerActorCompanyId: f.company.id, priorIssueStatus: fromStatus,
    priorStatusVersion: 0, policyVersion: "synthetic-obsolete", assessmentJson: {}, inputDigest: randomUUID() });
  const prompt = "Review the superseding native policy assessment.";
  const [decision] = await db.insert(statusDecisions).values({ id: decisionId, companyId: f.company.id, issueId: f.issue.id,
    runId: f.run.id, assessmentId, decisionVersion: 1, policyVersion: "synthetic-obsolete", fromStatus, toStatus: "in_review",
    reasonCode: "completion_review_required", decisionJson: { projectedStatusVersion: 0, effects: [
      { kind: "bind_reviewer", prompt, ownerUserId: null }, { kind: "append_superseding_assessment" }] },
    decisionDigest: randomUUID(), applicationState: "applied", appliedAt: new Date() }).returning();
  const [card] = await db.insert(issueThreadInteractions).values({ companyId: f.company.id, issueId: f.issue.id,
    kind: "request_confirmation", status: "pending", sourceRunId: f.run.id, idempotencyKey: `native-review:${decisionId}`,
    payload: { version: 1, prompt } }).returning();
  await db.insert(statusDecisionEffects).values({ companyId: f.company.id, issueId: f.issue.id, decisionId, ordinal: 0,
    effectKind: "bind_reviewer", targetType: "issue_thread_interaction", targetId: card.id, idempotencyKey: randomUUID(), payload: {} });
  await db.update(issues).set({ status: "in_review", lastStatusDecisionId: decisionId }).where(eq(issues.id, f.issue.id));
  return { decision, card, cardRead: async () => (await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, card.id)))[0] };
}

describe("obsolete policy cleanup retains actual workflow authority", () => {
  it.each([true, false])("restores obsolete in_progress with total5=%s and preserves original decision", async selected => {
    const f = await seed(selected, "in_review"), o = await obsolete(f, "in_progress"), ledger = await f.ledger();
    await dismissObsoleteNativePolicyReviews(db, [f.run.id]);
    expect((await o.cardRead()).status).toBe("cancelled"); expect(await f.read()).toMatchObject({ status: "in_progress", lastStatusDecisionId: null });
    expect((await db.select().from(statusDecisions).where(eq(statusDecisions.id, o.decision.id)))[0]).toEqual(o.decision);
    expect(await f.ledger()).toEqual(ledger); expect(await f.decisions()).toEqual([]); expect(await f.wakes()).toEqual([]);
  });
  it.each(["backlog", "blocked"])("names selected unsupported %s restoration without clearing decision metadata", async previous => {
    const f = await seed(true, "in_review"), o = await obsolete(f, previous), before = await f.read(), ledger = await f.ledger();
    await dismissObsoleteNativePolicyReviews(db, [f.run.id]);
    expect((await o.cardRead()).status).toBe("cancelled"); expect(await f.read()).toEqual(before);
    expect(await f.ledger()).toEqual(ledger); expect(await f.wakes()).toEqual([]); expect(await f.decisions()).toEqual([]);
    expect(await db.select().from(activityLog).where(and(eq(activityLog.entityId, f.issue.id), eq(activityLog.action, "issue.interaction_cancelled"))))
      .toMatchObject([{ details: { nativeOperationalRestore: "native_operational_review_transition_required", toStatus: "in_review" } }]);
  });
  it("retains pending scoped authority while withdrawing only the obsolete card", async () => {
    const f = await seed(true, "in_review"), o = await obsolete(f, "in_progress"); await fence(f, "scope"); const before = await f.read();
    await dismissObsoleteNativePolicyReviews(db, [f.run.id]);
    expect((await o.cardRead()).status).toBe("cancelled"); expect(await f.read()).toEqual(before); expect(await f.wakes()).toEqual([]);
  });
  it("preserves native feature-off blocked restoration", async () => {
    const f = await seed(false, "in_review"), o = await obsolete(f, "blocked");
    await dismissObsoleteNativePolicyReviews(db, [f.run.id]); expect((await o.cardRead()).status).toBe("cancelled");
    expect(await f.read()).toMatchObject({ status: "blocked", lastStatusDecisionId: null });
  });
});


it("drains actual native publication/actions only after the caller outer transaction commits", async () => {
  const f = await seed(), h = await hold(f, "interrupted");
  let outerActive = 0;
  const nativeTransaction = db.transaction.bind(db), nativePublish = activityOwner.publishActivity,
    nativePostCommit = issueOwner.executeIssuePostCommitActions;
  const publicationStates: number[] = [], actionStates: number[] = [];
  const transaction = vi.spyOn(db, "transaction").mockImplementation(async (...args: Parameters<typeof db.transaction>) => {
    outerActive++; try { return await nativeTransaction(...args); } finally { outerActive--; }
  });
  const publication = vi.spyOn(activityOwner, "publishActivity").mockImplementation(value => {
    publicationStates.push(outerActive); return nativePublish(value);
  });
  const actions = vi.spyOn(issueOwner, "executeIssuePostCommitActions").mockImplementation(async (...args) => {
    actionStates.push(outerActive); return nativePostCommit(...args);
  });
  try {
    expect(await settle(f, "interrupted")).not.toBeNull();
    expect((await h.read()).status).toBe("resolved");
    expect(publicationStates.length).toBeGreaterThan(0); expect(new Set(publicationStates)).toEqual(new Set([0]));
    expect(actionStates).toEqual([0]);
  } finally { transaction.mockRestore(); publication.mockRestore(); actions.mockRestore(); }
});

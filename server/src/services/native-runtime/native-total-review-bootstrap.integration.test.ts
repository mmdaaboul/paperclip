import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, authUsers, companyMemberships, completionContracts, executionWorkspaces,
  agentWakeupRequests, heartbeatRuns, issueRecoveryActions, issueReviewCycleBudgets, issues, nativeRunFinalizations } from "@paperclipai/db";
import { createReviewCycleBudget } from "../total-review-budget.js";
import { activeNativeExecutionRunIds } from "./native-active-runs.js";
import { buildNativeExecutionInput } from "./native-execution-input.js";
import { buildNativeCompletionContract } from "./completion-contracts.js";
import { executePaperclipNativeSession } from "./native-session-executor.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";
import { NativeProviderStateIncompatibleError, type NativeSessionBackend } from "../../vendor/paperclip-runner/index.js";
import { recordNativeFinalizationFailure } from "./native-run-finalizer.js";
import { claimNativeSessionResumptions } from "./native-finalization-reconciler.js";
import { createPostgresWakeQueueAdapter } from "../../modules/wake-queue/adapters/postgres.js";
import { nativeRestartFixture } from "../../__tests__/helpers/native-restart-fixture.js";

// Real native claim/failure transaction, real PostgreSQL and real issue setter.
// Only the provider backend is controlled: it fails before returning a session;
// no provider executable, credential, GitHub call or model request is involved.
// A supplied URL must be a NEW dedicated *_test database. Its rows are retained.
describe("first native startup with the task-wide review budget", () => {
  const dedicatedDatabaseUrl = process.env.PAPERCLIP_TOTAL5_REGRESSION_DATABASE_URL;
  const environment = nativeRestartFixture(dedicatedDatabaseUrl ? { dedicatedDatabaseUrl } : {});
  let reviewerId: string;
  let humanId: string;
  beforeAll(async () => {
    const { createDb } = await import("@paperclipai/db");
    const db = createDb(environment.current.temporary.connectionString, { maxConnections: 1 });
    try {
      const now = new Date(); humanId = `total5-human-${randomUUID()}`;
      await db.insert(authUsers).values({ id: humanId, name: "Synthetic human", email: `${humanId}@example.test`, createdAt: now, updatedAt: now });
      await db.insert(companyMemberships).values({ companyId: environment.current.companyId, principalType: "user", principalId: humanId, status: "active", membershipRole: "owner" });
      reviewerId = randomUUID();
      await db.insert(agents).values({ id: reviewerId, companyId: environment.current.companyId, name: "Independent synthetic Reviewer", role: "engineer", status: "active", adapterType: "paperclip_runner", adapterConfig: { provider: "codex", homeMode: "isolated" }, runtimeConfig: {}, permissions: {} });
      await db.update(agents).set({ adapterConfig: { provider: "codex", homeMode: "isolated", githubWriteMode: "native_controller" } }).where(eq(agents.id, environment.current.agentId));
    } finally { await db.$client.end(); }
  });

  async function ownedFailureFixture(label: string, enabled: boolean) {
    const fixture = await environment.seedRun(`${label}-${randomUUID()}`);
    const { db, issueId } = fixture;
    const policy = enabled ? { totalReviewCycles: 5, stages: [
      { id: randomUUID(), type: "review", participants: [{ id: randomUUID(), type: "agent", agentId: reviewerId }] },
      { id: randomUUID(), type: "approval", participants: [{ id: randomUUID(), type: "user", userId: humanId }] },
    ] } : null;
    await db.update(issues).set({ executionPolicy: policy, responsibleUserId: humanId }).where(eq(issues.id, issueId));
    const ledger = createReviewCycleBudget(environment.current.companyId, issueId);
    if (enabled) await db.insert(issueReviewCycleBudgets).values({ companyId: environment.current.companyId, issueId, ledger });
    return { ...fixture, policy, ledger };
  }

  it.each([false, true])("retains exhausted workspace failure through the actual finalizer, total-five=%s", async enabled => {
    const { db, issueId, runId, policy, ledger } = await ownedFailureFixture("FINALIZER", enabled);
    await recordNativeFinalizationFailure({ db, runId, error: new Error("native_workspace_controlled_failure"), failureScope: "workspace", permanent: true });
    const [task] = await db.select().from(issues).where(eq(issues.id, issueId));
    const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId));
    expect(task.status).toBe("blocked"); expect(task.executionPolicy).toEqual(policy);
    expect(coordinator.phase).toBe("terminal_failure");
    expect(coordinator.failureDetail?.message).toBe("native_workspace_controlled_failure");
    if (enabled) expect((await db.select().from(issueReviewCycleBudgets).where(eq(issueReviewCycleBudgets.issueId, issueId)))[0].ledger).toEqual(ledger);
  });

  it.each([false, true])("keeps ambiguous-session evidence through actual reconciliation, total-five=%s", async enabled => {
    const { db, issueId, runId, policy, ledger } = await ownedFailureFixture("RECONCILE", enabled);
    await db.update(heartbeatRuns).set({ status: "failed", errorCode: "original_bootstrap_failure", error: "Original controlled failure" }).where(eq(heartbeatRuns.id, runId));
    await db.update(nativeRunFinalizations).set({ phase: "retryable_failure", failureCode: "original_bootstrap_failure", failureDetail: { message: "Original controlled failure", originalFailureCode: "original_bootstrap_failure" } }).where(eq(nativeRunFinalizations.runId, runId));
    const errors: unknown[] = [];
    const claims = await claimNativeSessionResumptions({ db, runIds: [runId], runnerInstanceId: "controlled-reconciler", deferIneligible: false, onError: error => errors.push(error) });
    expect(errors).toEqual([]); expect(claims).toEqual([]);
    const [task] = await db.select().from(issues).where(eq(issues.id, issueId));
    const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId));
    expect(task.status).toBe("blocked"); expect(task.executionPolicy).toEqual(policy);
    expect(coordinator.phase).toBe("terminal_failure"); expect(coordinator.failureCode).toBe("original_bootstrap_failure");
    expect(coordinator.failureDetail?.message).toBe("Original controlled failure");
    expect(coordinator.failureDetail?.recoveryMode).toBe("ambiguous_state");
    if (enabled) expect((await db.select().from(issueReviewCycleBudgets).where(eq(issueReviewCycleBudgets.issueId, issueId)))[0].ledger).toEqual(ledger);
  });

  it.each([false, true])("settles actual failed-run wake release with its cleared bindings, total-five=%s", async enabled => {
    const { db, issueId, runId, policy, ledger } = await ownedFailureFixture("WAKE-FAILURE", enabled);
    await db.update(issues).set({ checkoutRunId: runId }).where(eq(issues.id, issueId));
    await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date(), errorCode: "adapter_failed" }).where(eq(heartbeatRuns.id, runId));
    const adapter = createPostgresWakeQueueAdapter(db, {
      resolveResponsibleUserId: async () => humanId,
      getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: humanId }),
      resolveSessionBeforeForWakeup: async () => null,
    });
    let queuePolicyCalls = 0;
    await adapter.withIssueExecutionLock({ companyId: environment.current.companyId, runId, now: new Date() }, async () => {
      queuePolicyCalls++; return { outcome: { kind: "released" }, postCommitEffects: [] };
    });
    expect(queuePolicyCalls).toBe(0);
    const [task] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(task.status).toBe("blocked"); expect(task.executionRunId).toBeNull(); expect(task.checkoutRunId).toBeNull();
    expect(task.executionPolicy).toEqual(policy);
    const actions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(actions).toHaveLength(1); expect(actions[0].ownerType).toBe("board");
    expect(actions[0].evidence.nativeFailureBlock).toEqual({ runId, statusVersion: task.statusVersion });
    if (enabled) expect((await db.select().from(issueReviewCycleBudgets).where(eq(issueReviewCycleBudgets.issueId, issueId)))[0].ledger).toEqual(ledger);
  });

  it.each([false, true])("reopens only its transactionally claimed deferred wake, total-five=%s", async enabled => {
    const { db, issueId, runId, policy, ledger } = await ownedFailureFixture("WAKE-REOPEN", enabled);
    await db.update(issues).set({ status: "done", executionState: null }).where(eq(issues.id, issueId));
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
    await db.update(nativeRunFinalizations).set({ phase: "committed" }).where(eq(nativeRunFinalizations.runId, runId));
    const wakeId = randomUUID();
    await db.insert(agentWakeupRequests).values({ id: wakeId, companyId: environment.current.companyId,
      agentId: environment.current.agentId, source: "on_demand", reason: "issue_reopened_via_comment", status: "deferred_issue_execution", payload: { issueId } });
    const adapter = createPostgresWakeQueueAdapter(db, {
      resolveResponsibleUserId: async () => humanId,
      getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: humanId }),
      resolveSessionBeforeForWakeup: async () => null,
    });
    await adapter.withIssueExecutionLock({ companyId: environment.current.companyId, runId, now: new Date() }, async (_locked, ports) => {
      expect(await ports.transaction.claimDeferredWakeForPromotion({ companyId: environment.current.companyId, wakeId, now: new Date() })).toBe(true);
      const restored = await ports.transaction.reopenIssue({ companyId: environment.current.companyId, issueId, runId });
      expect(restored?.status).toBe("todo");
      return { outcome: { kind: "released" }, postCommitEffects: [] };
    });
    const [task] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(task.status).toBe("todo"); expect(task.executionPolicy).toEqual(policy);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId)))[0].status).toBe("queued");
    if (enabled) expect((await db.select().from(issueReviewCycleBudgets).where(eq(issueReviewCycleBudgets.issueId, issueId)))[0].ledger).toEqual(ledger);
  });

  it("accepts the current assignee's exact wake after another native owner's acknowledged handoff", async () => {
    const { db, issueId, runId, ledger } = await ownedFailureFixture("WAKE-HANDOFF", true);
    await db.update(issues).set({ status: "done", executionState: null }).where(eq(issues.id, issueId));
    await db.update(heartbeatRuns).set({ agentId: reviewerId, status: "cancelled", finishedAt: new Date(),
      resultJson: { reassignmentStopRequested: true, nativeCancellation: {
        schema: "paperclip.native-cancellation.v1", runId, companyId: environment.current.companyId,
        issueId, scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged",
        dispatched: true, intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID(),
      } } }).where(eq(heartbeatRuns.id, runId));
    await db.update(nativeRunFinalizations).set({ phase: "committed" }).where(eq(nativeRunFinalizations.runId, runId));
    const wakeId = randomUUID();
    await db.insert(agentWakeupRequests).values({ id: wakeId, companyId: environment.current.companyId,
      agentId: environment.current.agentId, source: "on_demand", reason: "issue_reopened_via_comment",
      status: "deferred_issue_execution", payload: { issueId } });
    const adapter = createPostgresWakeQueueAdapter(db, {
      resolveResponsibleUserId: async () => humanId,
      getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: humanId }),
      resolveSessionBeforeForWakeup: async () => null,
    });
    let calls = 0;
    await adapter.withIssueExecutionLock({ companyId: environment.current.companyId, runId, now: new Date() }, async (_locked, ports) => {
      calls++;
      expect(await ports.transaction.claimDeferredWakeForPromotion({ companyId: environment.current.companyId, wakeId, now: new Date() })).toBe(true);
      expect((await ports.transaction.reopenIssue({ companyId: environment.current.companyId, issueId, runId }))?.status).toBe("todo");
      return { outcome: { kind: "released" }, postCommitEffects: [] };
    });
    expect(calls).toBe(1);
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0].assigneeAgentId).toBe(environment.current.agentId);
    expect((await db.select().from(issueReviewCycleBudgets).where(eq(issueReviewCycleBudgets.issueId, issueId)))[0].ledger).toEqual(ledger);
  });

  it.each(["other_task", "other_agent"] as const)("rolls back a mismatched claimed continuation (%s)", async mode => {
    const { db, issueId, runId, ledger } = await ownedFailureFixture("WAKE-WRONG-CLAIM", true);
    await db.update(issues).set({ status: "done", executionState: null }).where(eq(issues.id, issueId));
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
    const wakeId = randomUUID();
    await db.insert(agentWakeupRequests).values({ id: wakeId, companyId: environment.current.companyId,
      agentId: mode === "other_agent" ? reviewerId : environment.current.agentId,
      source: "on_demand", reason: "issue_reopened_via_comment", status: "deferred_issue_execution",
      payload: { issueId: mode === "other_task" ? randomUUID() : issueId } });
    const adapter = createPostgresWakeQueueAdapter(db, {
      resolveResponsibleUserId: async () => humanId,
      getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: humanId }),
      resolveSessionBeforeForWakeup: async () => null,
    });
    await expect(adapter.withIssueExecutionLock({ companyId: environment.current.companyId, runId, now: new Date() }, async (_locked, ports) => {
      expect(await ports.transaction.claimDeferredWakeForPromotion({ companyId: environment.current.companyId, wakeId, now: new Date() })).toBe(true);
      await ports.transaction.reopenIssue({ companyId: environment.current.companyId, issueId, runId });
      return { outcome: { kind: "released" }, postCommitEffects: [] };
    })).rejects.toThrow("native_continuation_claim_required");
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId)))[0].status).toBe("deferred_issue_execution");
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0].status).toBe("done");
    expect((await db.select().from(issueReviewCycleBudgets).where(eq(issueReviewCycleBudgets.issueId, issueId)))[0].ledger).toEqual(ledger);
  });

  it("refuses an unclaimed deferred continuation without changing terminal task or ledger", async () => {
    const { db, issueId, runId, ledger } = await ownedFailureFixture("WAKE-NO-CLAIM", true);
    await db.update(issues).set({ status: "done", executionState: null }).where(eq(issues.id, issueId));
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
    const adapter = createPostgresWakeQueueAdapter(db, {
      resolveResponsibleUserId: async () => humanId,
      getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: humanId }),
      resolveSessionBeforeForWakeup: async () => null,
    });
    await expect(adapter.withIssueExecutionLock({ companyId: environment.current.companyId, runId, now: new Date() }, async (_locked, ports) => {
      await ports.transaction.reopenIssue({ companyId: environment.current.companyId, issueId, runId });
      return { outcome: { kind: "released" }, postCommitEffects: [] };
    })).rejects.toThrow("native_continuation_claim_required");
    const [task] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(task.status).toBe("done"); expect(task.executionRunId).toBe(runId);
    expect((await db.select().from(issueReviewCycleBudgets).where(eq(issueReviewCycleBudgets.issueId, issueId)))[0].ledger).toEqual(ledger);
  });

  it.each([false, true])("preserves the original pre-provider failure with total-five=%s", async enabled => {
    const fixture = await environment.seedRun(`TOTAL5-FIRST-${enabled}-${randomUUID()}`);
    const { db, issueId, runId } = fixture;
    const { companyId, agentId, runtimeRoot } = environment.current;
    const workspaceId = randomUUID(), cwd = join(runtimeRoot, runId);
    await mkdir(cwd);
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, sourceIssueId: issueId,
      name: "First native task workspace", mode: "isolated_workspace", strategyType: "git_worktree", providerType: "git_worktree", status: "active", cwd });
    const policy = enabled ? { totalReviewCycles: 5, stages: [
      { id: randomUUID(), type: "review", participants: [{ id: randomUUID(), type: "agent", agentId: reviewerId }] },
      { id: randomUUID(), type: "approval", participants: [{ id: randomUUID(), type: "user", userId: humanId }] },
    ] } : null;
    await db.update(issues).set({ executionPolicy: policy, executionWorkspaceId: workspaceId, checkoutRunId: runId, responsibleUserId: humanId }).where(eq(issues.id, issueId));
    const ledger = createReviewCycleBudget(companyId, issueId);
    if (enabled) await db.insert(issueReviewCycleBudgets).values({ companyId, issueId, ledger });
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.issueId, issueId));
    const execution = buildNativeExecutionInput({ companyId, agentId, runId, issue,
      taskPrompt: "Exercise first native startup; never call a provider.", provider: "codex",
      workspace: { id: workspaceId, cwd, repoUrl: null, repoRef: null, branchName: null },
      normalizedSessionId: fixture.native.normalizedSessionId, runtimeContext: nativeRuntimeContextFixture(),
      completionContract: { id: contract.id, sha256: contract.canonicalSha256, schemaVersion: "paperclip.completion-contract.v1", contract: buildNativeCompletionContract(issue, { revision: contract.revision }) },
    });
    await db.update(heartbeatRuns).set({ responsibleUserId: humanId, runnerProfileJson: {
      ...fixture.preparedProfile, nativeExecutionInput: execution,
      nativeGithubWriteAdmission: { schema: "paperclip.native-github-write-admission.v1", mode: "native_controller", companyId, agentId, runId },
    } }).where(eq(heartbeatRuns.id, runId));
    const sentinel = new NativeProviderStateIncompatibleError("controlled_total5_first_bootstrap_failure");
    let openings = 0;
    const backend: NativeSessionBackend = {
      descriptor: async () => ({ kind: "mock", name: "controlled-provider-boundary", version: "1",
        capabilities: { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true },
        runtimeContextCapabilities: { instructions: "native", skills: "native", mcp: "native" } }),
      openSession: async () => { openings++; throw sentinel; },
    };
    const events: string[] = [];
    let error: unknown;
    try {
      await executePaperclipNativeSession({ db, execution, runnerInstanceId: fixture.native.runnerInstanceId, backend,
        onEvent: async event => { if (typeof event.payload?.span === "string") events.push(event.payload.span); } });
    } catch (failure) { error = failure; }
    // This is the regression assertion: D masks the sentinel with the locked
    // review-budget mutation refusal, despite an admitted coordinator claim.
    expect(openings).toBe(1);
    expect(events).toContain("native.coordinator.claim");
    expect(error).toBe(sentinel);
    const [after] = await db.select().from(issues).where(eq(issues.id, issueId));
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId));
    expect(after.status).toBe("blocked");
    expect(after.companyId).toBe(companyId); expect(after.assigneeAgentId).toBe(agentId);
    expect(after.executionWorkspaceId).toBe(workspaceId); expect(after.executionPolicy).toEqual(policy);
    expect(run.status).toBe("failed"); expect(run.error).toContain("controlled_total5_first_bootstrap_failure");
    expect(run.nativeIssueId).toBe(issueId); expect(run.agentId).toBe(agentId);
    expect(coordinator.phase).toBe("terminal_failure");
    expect(coordinator.failureDetail?.message).toContain("controlled_total5_first_bootstrap_failure");
    expect(coordinator.resultId).toBeNull(); expect(coordinator.leaseOwner).toBeNull();
    expect(activeNativeExecutionRunIds).not.toContain(runId);
    if (enabled) {
      const [budget] = await db.select().from(issueReviewCycleBudgets).where(eq(issueReviewCycleBudgets.issueId, issueId));
      expect(budget.ledger).toEqual(ledger);
      // The canonical locked adapter advances the optimistic row revision once
      // for this control mutation; allowance, admissions and history stay exact.
      expect(budget.revision).toBe(2);
    }
    const recovery = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(recovery).toHaveLength(1); expect(recovery[0].ownerType).toBe("board");
  }, 30_000);
});

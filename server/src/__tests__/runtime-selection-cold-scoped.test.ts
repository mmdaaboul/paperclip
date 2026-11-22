import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, authUsers, companyMemberships, principalPermissionGrants, companies, projects, issues, executionWorkspaces,
  heartbeatRuns, heartbeatRunEvents, nativeRunResults, nativeRunFinalizations, workAssessments, statusDecisions, environmentLeases,
  agentReferenceFolderConfigs, agentInstructionWorkingCopies, agentTaskSessions, githubPushOperationReceipts, reviewerGithubOperations,
  toolApplications, toolConnections, toolConnectionInstalls, toolProfiles, toolProfileEntries, toolProfileBindings, type Db,
} from "@paperclipai/db";
import { reviewerNativeTestDatabase } from "./helpers/reviewer-native-database.js";
import { resolveManagedInstructionsRoot } from "../services/agent-instructions.js";
import { agentInstructionWorkingCopyService } from "../services/agent-instruction-working-copies.js";
import { createHeartbeatInstructionWorkingCopy } from "../services/heartbeat/instruction-working-copy.js";
import { prepareAndSelectHeartbeatRuntime, type HeartbeatRuntimeSelectionInput } from "../services/heartbeat/runtime-selection.js";
import { resolveHeartbeatNativeRuntimeMode } from "../services/native-runtime/runtime-mode.js";
import { createCodexNativeSessionBackend } from "../../../packages/paperclip-runner/src/backends/codex-native-backend.js";
import { FakeCodexTransport } from "../../../packages/paperclip-runner/src/drivers/codex/codex-app-server-driver.test-support.js";
import { executePaperclipNativeSession, prepareNativeColdScopedContinuation, scopedRunnerdStateRoot } from "../services/native-runtime/native-session-executor.js";
import { nativeSha256 } from "../services/native-runtime/canonical.js";
import { currentProcessSpaceHash } from "../services/controller-process-identity.js";

/** Real PostgreSQL, instruction producer, MCP resolver and runtime selection.
 * The provider boundary is the SDK FakeCodexTransport; accepted-source records
 * and the stopped PRP projection are controlled persisted-state fixtures. */
describe("cold scoped runtime selection", () => {
  let connection: Awaited<ReturnType<typeof reviewerNativeTestDatabase>>, db: Db, base: string;
  beforeAll(async () => { connection = await reviewerNativeTestDatabase(); db = connection.db; base = await mkdtemp(join(tmpdir(), "cold-scoped-selection-")); });
  afterAll(async () => { vi.unstubAllEnvs(); await connection?.end(); });
  const read = async (id: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]!;
  async function fixture(lifecycleMode = "per_turn") {
    const home = join(base, randomUUID()); await mkdir(home, { mode: 0o700 });
    vi.stubEnv("PAPERCLIP_HOME", home); vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR", join(home, "durable"));
    const [company] = await db.insert(companies).values({ name: "Cold scoped fixture", issuePrefix: `C${randomUUID().slice(0, 6)}` }).returning();
    const userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Fixture operator", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    const [agent] = await db.insert(agents).values({ companyId: company!.id, name: "Cold fixture", status: "running", adapterType: "paperclip_runner",
      adapterConfig: { provider: "codex", model: "fixture-model", lifecycleMode } }).returning();
    const canonical = resolveManagedInstructionsRoot(agent!); await mkdir(canonical, { recursive: true });
    await writeFile(join(canonical, "AGENTS.md"), "Synthetic instructions; preserve the assigned work and history.\n");
    agent!.adapterConfig = { ...agent!.adapterConfig, instructionsBundleMode: "managed", instructionsRootPath: canonical, instructionsEntryFile: "AGENTS.md" };
    await db.update(agents).set({ adapterConfig: agent!.adapterConfig }).where(eq(agents.id, agent!.id));
    await db.insert(companyMemberships).values([{ companyId: company!.id, principalType: "user", principalId: userId, membershipRole: "operator" },
      { companyId: company!.id, principalType: "agent", principalId: agent!.id, membershipRole: "member" }]);
    await db.insert(principalPermissionGrants).values({ companyId: company!.id, principalType: "user", principalId: userId, permissionKey: "agents:configure", scope: { agentIds: [agent!.id] } });
    const [project] = await db.insert(projects).values({ companyId: company!.id, name: "Synthetic project" }).returning();
    const cwd = join(home, "task"), reference = join(home, "reference"); await mkdir(cwd); await mkdir(reference);
    await writeFile(join(reference, "README.txt"), "Read-only synthetic reference.\n");
    const [issue] = await db.insert(issues).values({ companyId: company!.id, projectId: project!.id, title: "Continue synthetic work", description: "Retain complete task history.", status: "in_progress", assigneeAgentId: agent!.id }).returning();
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId: company!.id, projectId: project!.id, sourceIssueId: issue!.id,
      mode: "task", strategyType: "local", name: "Synthetic workspace", cwd }).returning();
    await db.insert(agentReferenceFolderConfigs).values({ companyId: company!.id, agentId: agent!.id, revision: 1, updatedByUserId: userId,
      entries: [{ projectId: project!.id, path: reference }] });
    const [app] = await db.insert(toolApplications).values({ companyId: company!.id, applicationKey: `cold-${randomUUID()}`, name: "Offline assignment", type: "mcp_stdio", status: "active" }).returning();
    const [tool] = await db.insert(toolConnections).values({ companyId: company!.id, applicationId: app!.id, name: "Offline fixture", uid: `fixture/${randomUUID()}`,
      transport: "local_stdio", connectionPurpose: "tool", authKind: "none", credentialPolicy: "shared", status: "active", enabled: true, healthStatus: "healthy", config: {}, transportConfig: {} }).returning();
    await db.insert(toolConnectionInstalls).values({ companyId: company!.id, connectionId: tool!.id, targetType: "agent", targetId: agent!.id });
    const [profile] = await db.insert(toolProfiles).values({ companyId: company!.id, profileKey: `cold-${randomUUID()}`, name: "Offline fixture", status: "active", defaultAction: "deny" }).returning();
    await db.insert(toolProfileEntries).values({ companyId: company!.id, profileId: profile!.id, selectorType: "connection", effect: "include", connectionId: tool!.id });
    await db.insert(toolProfileBindings).values({ companyId: company!.id, profileId: profile!.id, targetType: "agent", targetId: agent!.id });
    const copies = agentInstructionWorkingCopyService(db);
    async function prepare(previous?: typeof heartbeatRuns.$inferSelect) {
      const [run] = await db.insert(heartbeatRuns).values({ companyId: company!.id, agentId: agent!.id, issueId: issue!.id,
        scopeKind: "issue", status: "running", responsibleUserId: userId, createdAt: new Date(Date.now() + (previous ? 1000 : 0)) }).returning();
      const [lease] = await db.insert(environmentLeases).values({ companyId: company!.id, heartbeatRunId: run!.id,
        executionWorkspaceId: workspace!.id, issueId: issue!.id, provider: "local", leasePolicy: "ephemeral", status: "active" }).returning();
      await db.update(issues).set({ executionRunId: run!.id, executionWorkspaceId: workspace!.id }).where(eq(issues.id, issue!.id));
      const [taskSession] = previous ? await db.insert(agentTaskSessions).values({ companyId: company!.id, agentId: agent!.id,
        adapterType: "paperclip_runner", taskKey: issue!.id, lastRunId: previous.id, sessionParamsJson: { sessionId: previous.nativeSessionId } }).returning() : [];
      const input: HeartbeatRuntimeSelectionInput = {
        run: run!, agent: agent!, nativeRuntimeResolution: resolveHeartbeatNativeRuntimeMode({ persisted: run!, enabled: true, runtimeConfig: {}, adapterConfig: agent!.adapterConfig, agent: agent!, issue: issue!, target: null, workspaceId: workspace!.id }),
        task: { issueRef: issue!, issueContext: { projectId: project!.id } as never, context: { paperclipTaskMarkdown: "Complete full synthetic task history; current owner feedback is the second turn." },
          executionContinuation: null, safeWakeComments: [], safeWakeCommentContext: null, paperclipWakePayload: null, acceptedPlanContinuationWake: false },
        session: { persistedNativeExecutionInput: null, persistedRunnerProfile: {}, taskSessionCredentialCompatible: true,
          taskSessionDecodedParams: previous ? { sessionId: previous.nativeSessionId } : null, taskSessionForRun: previous ? { lastRunId: previous.id } : null,
          isFailedChatRunRetry: false, getFreshSessionHandoff: vi.fn(async () => "Full earlier synthetic task history") },
        workspace: { persistedExecutionWorkspace: workspace!, executionWorkspace: { cwd, repoUrl: null, repoRef: null, branchName: null }, executionTarget: null,
          activeEnvironmentLease: { lease: { ...lease!, status: "active" as const, leasePolicy: "ephemeral" as const, provider: "local", cleanupStatus: null } }, isDotRun: false, projectRepositoryPaths: [] },
        config: { runtimeConfig: {}, runtimeSkillEntries: [], runScopedMentionedSkillKeys: [], instructionCopy: null, agentIdentity: undefined,
          issueAssigneeOverrides: null, resolvedConfig: {}, managedAiRuntime: undefined }, recovery: {}, trace: { providerTraceRequested: false, providerTraceCapture: null },
        issuesSvc: { addComment: vi.fn() }, runtimeEnv: {}, onAdapterEvent: vi.fn(async () => {}), onNativeLifecycleSelected: vi.fn(),
        onProviderResourceDisposition: vi.fn(), onNativeOwnershipHeld: vi.fn(), stopControllerLease: vi.fn(),
      };
      const controller = createHeartbeatInstructionWorkingCopy({ db, instructionCopies: copies, readRun: () => input.run, agent: agent!, context: input.task.context,
        session: { taskSession: taskSession ?? null, taskSessionForRun: previous ? { lastRunId: previous.id } : null, sessionConfigMetadata: {} as never },
        workspace: input.workspace, appendRunEvent: vi.fn(async () => {}) });
      const select = () => prepareAndSelectHeartbeatRuntime(db, input, { measure: async (_phase, work) => work(), prepareInstructions: async nativeLifecyclePolicy => {
        const runtimeConfig = await controller.prepare({ runtimeConfig: {}, nativeRuntimeResolution: input.nativeRuntimeResolution, hasInstructionFilesystem: true, nativeLifecyclePolicy });
        return { runtimeConfig, instructionCopy: controller.instructionCopy };
      } });
      return { input, controller, select, run: run! };
    }
    const first = await prepare(), selected = await first.select();
    if (!selected.selected || !selected.nativeExecution) throw new Error("Source did not select native execution");
    const execution = selected.nativeExecution, saved = await read(first.run.id), identity = { ...execution.binding, sessionId: execution.session.normalizedSessionId! };
    const transport = new FakeCodexTransport(), request = transport.request.bind(transport);
    vi.spyOn(transport, "request").mockImplementation(async (method, params) => {
      const response = await request(method, params);
      if (["thread/start", "thread/resume", "thread/read"].includes(method)) {
        const value = response as Record<string, unknown>;
        return { ...value, cwd, thread: { ...(value.thread as Record<string, unknown>), cwd } };
      }
      return response;
    });
    const backend = createCodexNativeSessionBackend(execution, { runnerInstanceId: saved.runnerInstanceId!, transportFactory: () => transport });
    const session = await backend.openSession({ identity, workingDirectory: cwd });
    const checkpoint = { ...await session.snapshot(), providerRecoveryPolicy: "allow_replacement_after_resume_failure" as const };
    await session.close({ reason: "synthetic predecessor settled" });
    await first.controller.collectStoppedInstructions();
    await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(), cleanupStatus: "success" }).where(eq(environmentLeases.heartbeatRunId, saved.id));
    const resultId = randomUUID(), assessmentId = randomUUID(), decisionId = randomUUID();
    await db.insert(nativeRunResults).values({ id: resultId, companyId: company!.id, issueId: issue!.id, runId: saved.id,
      completionContractId: saved.completionContractId!, schemaStatus: "accepted", serverFingerprint: "synthetic", canonicalSha256: "a".repeat(64),
      resultJson: { result: { reportedWorkDisposition: "blocked" }, terminal: { runTerminalState: "succeeded", turnTerminalState: "completed" } } });
    await db.insert(workAssessments).values({ id: assessmentId, companyId: company!.id, issueId: issue!.id, runId: saved.id,
      contractId: saved.completionContractId!, resultId, triggerKind: "native_result", triggerActorCompanyId: company!.id,
      priorIssueStatus: "in_progress", priorStatusVersion: 1, policyVersion: "synthetic", assessmentJson: {}, inputDigest: "b".repeat(64) });
    await db.insert(statusDecisions).values({ id: decisionId, companyId: company!.id, issueId: issue!.id, runId: saved.id, assessmentId,
      decisionVersion: 1, policyVersion: "synthetic", fromStatus: "in_progress", toStatus: "blocked", reasonCode: "synthetic_checkpoint",
      decisionJson: {}, decisionDigest: "c".repeat(64), applicationState: "applied", appliedAt: new Date() });
    await db.update(nativeRunFinalizations).set({ phase: "committed", resultId, assessmentId, decisionId, leaseOwner: null, leaseExpiresAt: null,
      recoveryState: null, failureCode: null, nextAttemptAt: null }).where(eq(nativeRunFinalizations.runId, saved.id));
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date(), processHostHash: currentProcessSpaceHash(),
      runnerProfileJson: { ...saved.runnerProfileJson, sessionCheckpoint: checkpoint } }).where(eq(heartbeatRuns.id, saved.id));
    const source = await read(saved.id), pid = 99_990_010, providerPid = pid + 1, time = new Date().toISOString();
    await db.insert(heartbeatRunEvents).values({ companyId: company!.id, agentId: agent!.id, runId: source.id, seq: 1,
      eventType: "native.process_identity_recorded", payload: { targetKind: "local", hostname: hostname(), processPid: pid, processGroupId: pid, processStartedAt: time } });
    const thread = checkpoint.providerSessionId ?? checkpoint.sessionId;
    const event = { schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceKind: "runner", sourceInstanceId: source.runnerInstanceId!,
      runId: source.id, normalizedSessionId: source.nativeSessionId!, sourceSeq: 1, sourceEventId: `${source.runnerInstanceId}:${source.id}:1`, priority: 0,
      emittedAt: time, eventType: "session.started", payload: { driverSessionId: thread, processId: providerPid } };
    await db.insert(heartbeatRunEvents).values({ companyId: company!.id, agentId: agent!.id, runId: source.id, seq: 2,
      eventType: event.eventType, sourceInstanceId: source.runnerInstanceId, sourceSeq: 1, sourceEventId: event.sourceEventId,
      sourcePayloadSha256: nativeSha256(event), payload: { prpEvent: event } });
    const root = scopedRunnerdStateRoot(execution), durableIdentity = { runId: source.id, normalizedSessionId: source.nativeSessionId!, runnerInstanceId: source.runnerInstanceId!, environmentLeaseId: workspace!.id, turnId: "fixture-turn", itemId: "fixture-item" };
    await mkdir(join(root, "control-plane"), { recursive: true, mode: 0o700 }); await mkdir(join(root, "runner"), { recursive: true, mode: 0o700 });
    const terminal = { ...event, eventType: "run.terminal", payload: {} };
    const control = { schema: "paperclip.runner.durable.control-plane-state.v1", identity: durableIdentity, commands: [], committedEvents: [{ eventType: "run.terminal", envelope: { ...durableIdentity, payload: terminal } }] };
    const runner = { schema: "paperclip.runner.durable.state.v1", ...durableIdentity, lifecycle: "suspended", outbox: [], pendingTerminalDelivery: null, pendingProviderCleanup: null };
    const provider = { schema: "paperclip.runner.codex-provider-state.v1", config: { provider: "codex", command: process.execPath, cwd }, threadId: thread,
      lifecycle: "prepared", pendingEvents: [], queuedEvents: [], startupAttempt: null, activeProviderTurnId: null, goal: null };
    for (const [name, value] of [["control-plane/control-plane-state.json", control], ["runner/runner-state.json", runner], ["runner/codex-provider-state.json", provider]] as const) await writeFile(join(root, name), JSON.stringify(value), { mode: 0o600 });
    const next = await prepare(source);
    return { first, next, source, execution, root, provider, control, company: company!, agent: agent!, issue: issue!, reference, event };
  }

  it.each(["per_turn", "warm"])("rebuilds full native context in a fresh session after real managed-copy and MCP preparation (%s)", async lifecycle => {
    const f = await fixture(lifecycle), before = await readFile(join(f.root, "control-plane/control-plane-state.json"));
    const selected = await f.next.select();
    if (!selected.selected || !selected.nativeExecution || !("runtimeContext" in selected.nativeExecution) || !("runtimeContext" in f.execution)) throw new Error("Native context missing");
    expect(selected.nativeExecution.runtimeContext.mcp.bindingId).toBe(`native-mcp:${f.next.run.id}`);
    expect(f.execution.runtimeContext.mcp.bindingId).toBe(`native-mcp:${f.source.id}`);
    expect(selected.nativeExecution.runtimeContext.mcp.assignmentSetId).toBe(f.execution.runtimeContext.mcp.assignmentSetId);
    expect(selected.nativeExecution.runtimeContext.aggregateDigest).toBe(f.execution.runtimeContext.aggregateDigest);
    expect(selected.nativeExecution.runtimeContext.instructions.workingCopy!.rootPath).not.toBe(f.execution.runtimeContext.instructions.workingCopy!.rootPath);
    expect(selected.nativeExecution.session.normalizedSessionId).not.toBe(f.source.nativeSessionId);
    expect(selected.nativeRunnerInstanceId).not.toBe(f.source.runnerInstanceId);
    expect(selected.nativeExecution.workspace).toEqual(f.execution.workspace);
    expect(selected.nativeExecution.task.prompt).toContain("Complete full synthetic task history");
    const saved = await read(f.next.run.id);
    expect(selected.nativeExecution.session.lifecyclePolicy?.mode).toBe(lifecycle);
    // A same-run restart reconstructs from the protected saved input and
    // freshly reobserves the native owners; the receipt alone grants nothing.
    const hint = saved.runnerProfileJson?.nativeColdScopedContinuation as Record<string, unknown>;
    const reconstructed = await prepareNativeColdScopedContinuation({ db, previous: f.execution, current: selected.nativeExecution,
      localScoped: true, expectedFingerprint: String(hint.sourceAuthoritySha256) });
    expect(reconstructed).not.toBeNull(); await reconstructed!.recheck(db);
    expect(reconstructed!.receiptFor(selected.nativeExecution)).toEqual(hint);
    expect(saved.runnerProfileJson?.sessionCheckpoint).toBeUndefined();
    expect(saved.runnerProfileJson?.nativeColdScopedContinuation).toMatchObject({ schema: "paperclip.scoped-cold-continuation.v1", sourceRunId: f.source.id, targetExecutionSha256: nativeSha256(selected.nativeExecution) });
    expect(await readFile(join(f.root, "control-plane/control-plane-state.json"))).toEqual(before);
    expect(await readFile(join(f.reference, "README.txt"), "utf8")).toBe("Read-only synthetic reference.\n");
  });

  it("rechecks persisted cold selection before dispatch and preserves same-run selection identity", async () => {
    const f = await fixture(), selected = await f.next.select();
    if (!selected.selected || !selected.nativeExecution || !selected.referenceFolderAccess?.workspaceAccess) throw new Error("Native scoped selection missing");
    const saved = await read(f.next.run.id);
    // The protected receipt is a restart hint, never a cached physical pass.
    await writeFile(join(f.root, "runner/codex-provider-state.json"), JSON.stringify({ ...f.provider, startupAttempt: { phase: "intent" } }));
    await expect(executePaperclipNativeSession({ db, execution: selected.nativeExecution, runnerInstanceId: saved.runnerInstanceId!,
      useRunnerd: true, workspaceAccess: selected.referenceFolderAccess.workspaceAccess })).rejects.toMatchObject({ name: "NativeProviderStateIncompatibleError" });
    const after = await read(f.next.run.id);
    expect(after.nativeSessionId).toBe(saved.nativeSessionId);
    expect(after.runnerInstanceId).toBe(saved.runnerInstanceId);
    expect(after.runnerProfileJson?.nativeExecutionInput).toEqual(saved.runnerProfileJson?.nativeExecutionInput);
    expect(after.processPid).toBeNull();
    const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.next.run.id));
    expect(events.some(event => event.eventType === "native.process_start_requested")).toBe(false);
  });

  it.each(["unfinished_goal", "pending_tool", "copy_cleanup", "live_provider", "foreign_owner", "commit_race", "uncertain_git", "uncertain_discussion"])("holds %s without selecting a new native session", async fault => {
    const f = await fixture();
    if (fault === "unfinished_goal" || fault === "pending_tool") {
      const profile = f.source.runnerProfileJson!;
      const checkpoint = { ...(profile.sessionCheckpoint as Record<string, unknown>), ...(fault === "unfinished_goal" ? { goal: { status: "blocked", objective: "Retain this goal" } } : { pendingRuntimeRequests: [{ id: "unsettled" }] }) };
      await db.update(heartbeatRuns).set({ runnerProfileJson: { ...profile, sessionCheckpoint: checkpoint } }).where(eq(heartbeatRuns.id, f.source.id));
    }
    if (fault === "uncertain_git") {
      const key = randomUUID();
      await db.insert(githubPushOperationReceipts).values({ id: randomUUID(), companyId: f.company.id, agentId: f.agent.id, runId: f.source.id,
        idempotencyKey: key, binding: { companyId: f.company.id, agentId: f.agent.id, runId: f.source.id }, request: { idempotencyKey: key },
        fingerprint: "d".repeat(64), state: "uncertain", createdAt: new Date(), finishedAt: new Date() });
    }
    if (fault === "uncertain_discussion") await db.insert(reviewerGithubOperations).values({ id: randomUUID(), companyId: f.company.id, agentId: f.agent.id,
      runId: f.source.id, issueId: f.issue.id, projectId: f.issue.projectId!, repositoryId: "fixture", repository: "fixture/offline", pullNumber: 1,
      headSha: "e".repeat(40), action: "comment", idempotencyKey: randomUUID(), requestHash: "f".repeat(64), agentName: f.agent.name, status: "uncertain", requestPayload: {} });
    if (fault === "copy_cleanup") await db.update(agentInstructionWorkingCopies).set({ receipt: { schema: "paperclip.agent-files.v1", cleanupPending: true } }).where(eq(agentInstructionWorkingCopies.runId, f.source.id));
    if (fault === "live_provider") { const event = { ...f.event, payload: { ...f.event.payload, processId: process.pid } };
      await db.update(heartbeatRunEvents).set({ payload: { prpEvent: event }, sourcePayloadSha256: nativeSha256(event) }).where(and(eq(heartbeatRunEvents.runId, f.source.id), eq(heartbeatRunEvents.seq, 2))); }
    if (fault === "foreign_owner") await writeFile(join(f.root, "control-plane/control-plane-state.json"), JSON.stringify({ ...f.control, identity: { ...f.control.identity, runId: randomUUID() } }));
    if (fault === "commit_race") f.next.input.beforeNativeRuntimeSelection = async () => { await writeFile(join(f.root, "runner/codex-provider-state.json"), JSON.stringify({ ...f.provider, startupAttempt: { phase: "intent" } })); };
    await expect(f.next.select()).rejects.toMatchObject({ name: "NativeProviderStateIncompatibleError" });
    expect((await read(f.next.run.id)).runnerProfileJson?.nativeExecutionInput).toBeUndefined();
    expect((await read(f.source.id)).status).toBe("succeeded");
  });
});

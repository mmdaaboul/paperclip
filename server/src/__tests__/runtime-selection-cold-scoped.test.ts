import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
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
import { executePaperclipNativeSession, prepareNativeColdScopedContinuation, inspectStoppedNativeReviewerOwners, scopedRunnerdStateRoot } from "../services/native-runtime/native-session-executor.js";
import { nativeSha256 } from "../services/native-runtime/canonical.js";
import { validatePrpEvent, type PrpEvent } from "../../../packages/paperclip-runner/src/protocol/replay-contract.js";
import type { CodexAppServerTransport } from "../../../packages/paperclip-runner/src/drivers/codex/app-server-transport.js";
import type { NativeSession } from "../../../packages/paperclip-runner/src/contracts/native-session-backend.js";
import { currentProcessSpaceHash } from "../services/controller-process-identity.js";

/** Real PostgreSQL, instruction producer, MCP resolver and runtime selection.
 * The provider boundary is the SDK FakeCodexTransport; accepted-source records
 * and the stopped PRP projection are controlled persisted-state fixtures. */
describe("cold scoped runtime selection", () => {
  let connection: Awaited<ReturnType<typeof reviewerNativeTestDatabase>>, db: Db, base: string;
  beforeAll(async () => { connection = await reviewerNativeTestDatabase(); db = connection.db; base = await mkdtemp(join(tmpdir(), "cold-scoped-selection-")); });
  afterAll(async () => { vi.unstubAllEnvs(); await connection?.end(); });
  const read = async (id: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]!;
  async function seedFixture(lifecycleMode = "per_turn") {
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
    let ordinal = 0; const createdBase = Date.now();
    async function prepare(previous?: typeof heartbeatRuns.$inferSelect, reuseRunId?: string) {
      const [run] = await db.insert(heartbeatRuns).values({ companyId: company!.id, agentId: agent!.id, issueId: issue!.id,
        scopeKind: "issue", status: "running", responsibleUserId: userId, createdAt: new Date(createdBase + ++ordinal * 1000) }).returning();
      const [lease] = await db.insert(environmentLeases).values({ companyId: company!.id, heartbeatRunId: run!.id,
        executionWorkspaceId: workspace!.id, issueId: issue!.id, provider: "local", leasePolicy: "ephemeral", status: "active" }).returning();
      await db.update(issues).set({ executionRunId: run!.id, executionWorkspaceId: workspace!.id }).where(eq(issues.id, issue!.id));
      const [taskSession] = previous ? await db.insert(agentTaskSessions).values({ companyId: company!.id, agentId: agent!.id,
        adapterType: "paperclip_runner", taskKey: issue!.id, lastRunId: previous.id, sessionParamsJson: { sessionId: previous.nativeSessionId } })
        .onConflictDoUpdate({ target: [agentTaskSessions.companyId, agentTaskSessions.agentId, agentTaskSessions.adapterType, agentTaskSessions.taskKey],
          set: { lastRunId: previous.id, sessionParamsJson: { sessionId: previous.nativeSessionId } } }).returning() : [];
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
        if (reuseRunId) {
          const copy = await copies.prepare({ companyId: company!.id, agentId: agent!.id, runId: run!.id, cwd, warm: true, reuseRunId });
          if (!copy) throw new Error("Warm copy missing");
          input.task.context.paperclipWorkspace = { agentHome: copy.executionRoot };
          return { runtimeConfig: { instructionsFilePath: join(copy.localRoot, copy.entryFile) }, instructionCopy: copy };
        }
        const runtimeConfig = await controller.prepare({ runtimeConfig: {}, nativeRuntimeResolution: input.nativeRuntimeResolution, hasInstructionFilesystem: true, nativeLifecyclePolicy });
        return { runtimeConfig, instructionCopy: controller.instructionCopy };
      } });
      return { input, controller, select, run: run! };
    }
    async function acceptSource(saved: typeof heartbeatRuns.$inferSelect, checkpoint: unknown, preserveHost = false) {
    await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(), cleanupStatus: "success" }).where(eq(environmentLeases.heartbeatRunId, saved.id));
    const resultId = randomUUID(), assessmentId = randomUUID(), decisionId = randomUUID();
    const decisionVersion = (await db.select({ id: statusDecisions.id }).from(statusDecisions).where(eq(statusDecisions.issueId, issue!.id))).length + 1;
    await db.insert(nativeRunResults).values({ id: resultId, companyId: company!.id, issueId: issue!.id, runId: saved.id,
      completionContractId: saved.completionContractId!, schemaStatus: "accepted", serverFingerprint: "synthetic", canonicalSha256: "a".repeat(64),
      resultJson: { result: { reportedWorkDisposition: "blocked" }, terminal: { runTerminalState: "succeeded", turnTerminalState: "completed" } } });
    await db.insert(workAssessments).values({ id: assessmentId, companyId: company!.id, issueId: issue!.id, runId: saved.id,
      contractId: saved.completionContractId!, resultId, triggerKind: "native_result", triggerActorCompanyId: company!.id,
      priorIssueStatus: "in_progress", priorStatusVersion: 1, policyVersion: "synthetic", assessmentJson: {}, inputDigest: nativeSha256({ runId: saved.id, checkpoint }) });
    await db.insert(statusDecisions).values({ id: decisionId, companyId: company!.id, issueId: issue!.id, runId: saved.id, assessmentId,
      decisionVersion, policyVersion: "synthetic", fromStatus: "in_progress", toStatus: "blocked", reasonCode: "synthetic_checkpoint",
      decisionJson: {}, decisionDigest: nativeSha256({ runId: saved.id, decisionVersion }), applicationState: "applied", appliedAt: new Date() });
    await db.update(nativeRunFinalizations).set({ phase: "committed", resultId, assessmentId, decisionId, leaseOwner: null, leaseExpiresAt: null,
      recoveryState: null, failureCode: null, nextAttemptAt: null }).where(eq(nativeRunFinalizations.runId, saved.id));
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date(), processHostHash: preserveHost ? saved.processHostHash : currentProcessSpaceHash(),
      runnerProfileJson: { ...saved.runnerProfileJson, sessionCheckpoint: checkpoint } }).where(eq(heartbeatRuns.id, saved.id));
    }
    async function persistPrp(run: typeof heartbeatRuns.$inferSelect, event: PrpEvent) {
      const rows = await db.select({seq:heartbeatRunEvents.seq}).from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId,run.id));
      await db.insert(heartbeatRunEvents).values({ companyId:run.companyId,agentId:run.agentId,runId:run.id,
        seq:Math.max(0,...rows.map(row=>row.seq))+1,eventType:event.eventType,sourceInstanceId:event.sourceInstanceId,
        sourceSeq:event.sourceSeq,sourceEventId:event.sourceEventId,sourcePayloadSha256:nativeSha256(event),payload:{prpEvent:event} });
    }
    async function recordControlledPhysicalOrigin(run: typeof heartbeatRuns.$inferSelect) {
      const pid=99_990_010,time=new Date().toISOString();
      await db.update(heartbeatRuns).set({processPid:pid,processGroupId:pid,processStartedAt:new Date(time),processHostHash:currentProcessSpaceHash()}).where(eq(heartbeatRuns.id,run.id));
      await db.insert(heartbeatRunEvents).values({companyId:run.companyId,agentId:run.agentId,runId:run.id,seq:1,
        eventType:"native.process_identity_recorded",payload:{targetKind:"local",hostname:hostname(),processPid:pid,processGroupId:pid,processStartedAt:time}});
    }
    async function writeControlledStoppedRunnerProjection(identity: DurableRecoveryIdentity, thread: string, account: string|null) {
      const root=scopedRunnerdStateRoot((await read(identity.runId)).runnerProfileJson!.nativeExecutionInput as never);
      await mkdir(join(root,"runner"),{recursive:true,mode:0o700});
      const runner={schema:"paperclip.runner.durable.state.v1",...identity,lifecycle:"suspended",outbox:[],pendingTerminalDelivery:null,pendingProviderCleanup:null};
      const provider={schema:"paperclip.runner.codex-provider-state.v1",config:{provider:"codex",command:process.execPath,cwd},
        threadId:thread,providerSessionId:account,lifecycle:"closed",pendingEvents:[],queuedEvents:[],startupAttempt:null,activeProviderTurnId:null,goal:null};
      await writeFile(join(root,"runner/runner-state.json"),JSON.stringify(runner),{mode:0o600});
      await writeFile(join(root,"runner/codex-provider-state.json"),JSON.stringify(provider),{mode:0o600});
    }
    return {prepare,copies,acceptSource,persistPrp,recordControlledPhysicalOrigin,writeControlledStoppedRunnerProjection,
      company:company!,agent:agent!,issue:issue!,workspace:workspace!,cwd,reference,read};
  }
  async function fixture(lifecycleMode = "per_turn") {
    const {prepare,copies,acceptSource,company,agent,issue,workspace,cwd,reference}=await seedFixture(lifecycleMode);
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
    await acceptSource(saved, checkpoint);
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

it.each(["none", "receipt_tamper", "origin_foreign", "origin_missing", "origin_host", "origin_birth", "origin_group",
  "attachment_missing", "attachment_hash", "attachment_false", "checkpoint_borrowed", "checkpoint_thread", "live_sidecar",
  "copy_origin", "copy_successor", "source_goal", "historical_uncertain_git", "foreign_history", "provider_generation",
  "pending_attach", "root_drift_commit", "historical_binding_commit", "saved_origin_drift", "history_overflow",
  "checkpoint_pending", "copy_directory_origin", "unknown_process_generation", "event_run_binding", "canonical_owner",
  "rust_forms", "rust_account_changed", "rust_reconciled_changed", "harness_forms", "harness_reconciled_account_changed"])(
  'selects cold D only after complete local A-B-C proof (%s)',async fault => {
  const f = await seedFixture('warm');
  const a = await f.prepare();
  const selectedA = await a.select();
  if (!selectedA.selected || !selectedA.nativeExecution) throw new Error('A native selection missing');
  const executionA = selectedA.nativeExecution;
  const savedA = await f.read(a.run.id);
  const root = scopedRunnerdStateRoot(executionA);
  await mkdir(join(root,'control-plane'),{recursive:true,mode:0o700});
  const origin = {runId:savedA.id, normalizedSessionId:savedA.nativeSessionId!,
    runnerInstanceId:savedA.runnerInstanceId!,environmentLeaseId:f.workspace.id,
    turnId:'authority-A',itemId:'authority-item-A'};
  const producer = await localWarmProducer(join(root,'control-plane'),origin,fault.startsWith('rust_')||fault.startsWith('harness_')?fault:undefined);
  let nextAuthority: DurableRecoveryIdentity | null = null;
    const transport = new FakeCodexTransport(), request = transport.request.bind(transport);
    vi.spyOn(transport, "request").mockImplementation(async (method, params) => {
      const response = await request(method, params);
      if (["thread/start", "thread/resume", "thread/read"].includes(method)) {
        const value = response as Record<string, unknown>;
        return { ...value, cwd: f.cwd, thread: { ...(value.thread as Record<string, unknown>), cwd: f.cwd } };
      }
      return response;
    });

  const attached: DurableRecoveryIdentity[] = [];
  (transport as CodexAppServerTransport).attachRun = async input => {
    if (!nextAuthority || input.runId !== nextAuthority.runId) throw new Error('attachment binding');
    // Actual harness generated turn/item IDs are the transport handoff IDs.
    nextAuthority = {...nextAuthority,turnId:input.turnId,itemId:input.itemId};
    await producer.attach(nextAuthority);
    attached.push(nextAuthority);
  };
  const backend = createCodexNativeSessionBackend(executionA,{
    runnerInstanceId:savedA.runnerInstanceId!,transportFactory:()=>transport});
  const session = await backend.openSession({identity:{...executionA.binding,
    sessionId:executionA.session.normalizedSessionId!},workingDirectory:f.cwd});
  // One controlled physical origin, only A; reuse original fixture's safe
  // absent PID/process namespace and PRIVATE event. Do not fabricate B/C rows.
  await f.recordControlledPhysicalOrigin(savedA);

  const turns = [];
  let active = a;
  let selected = selectedA;
  let saved = savedA;
  try {
    for (const label of ['A','B','C']) {
      const outcome = await settleHarnessTurn(session,transport,label,producer.publish,fault.startsWith("rust_")||fault.startsWith("harness_")?fault:undefined);
      await f.persistPrp(saved,outcome.published);
      if(outcome.reconciled)await f.persistPrp(saved,outcome.reconciled);
      await f.persistPrp(saved,outcome.terminal);
      await f.acceptSource(await f.read(saved.id),{...outcome.checkpoint,providerRecoveryPolicy:"allow_replacement_after_resume_failure"},true); // explicit accepted-result seam
      const warm = await f.copies.checkpointWarm({companyId:f.company.id,runId:saved.id});
      expect(warm?.state).toBe('warm_saved');
      turns.push({run:await f.read(saved.id),execution:selected.nativeExecution!,outcome});
      if (label === 'C') break;
      const successor = await f.prepare(await f.read(saved.id),saved.id);
      const picked = await successor.select();
      if (!picked.selected || !picked.nativeExecution) throw new Error('warm native selection missing');
      const next = await f.read(successor.run.id);
      expect(next.nativeSessionId).toBe(savedA.nativeSessionId);
      expect(next.runnerInstanceId).toBe(savedA.runnerInstanceId);
      const priorContext = selected.nativeExecution!.runtimeContext;
      const nextContext = picked.nativeExecution.runtimeContext;
      expect(nextContext.instructions.workingCopy!.rootPath).toBe(priorContext.instructions.workingCopy!.rootPath);
      expect(nextContext.mcp.bindingId).toBe(`native-mcp:${next.id}`);
      expect(nextContext.mcp.bindingId).not.toBe(priorContext.mcp.bindingId);
      expect(nextContext.mcp.assignmentSetId).toBe(priorContext.mcp.assignmentSetId);
      expect(nextContext.aggregateDigest).toBe(priorContext.aggregateDigest);
      nextAuthority = {...origin,runId:next.id};
      await session.attachRun!({identity:{...picked.nativeExecution.binding,
        sessionId:picked.nativeExecution.session.normalizedSessionId!}});
      active=successor; selected=picked; saved=next;
    }
    expect(attached.map(a=>a.runId)).toEqual(turns.slice(1).map(t=>t.run.id));
    for (const t of turns.slice(1)) {
      expect(t.outcome.events.some(e=>e.eventType==='run.attached')).toBe(true);
      expect(t.outcome.events.some(e=>['session.started','session.resumed'].includes(e.eventType))).toBe(false);
      const rows = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId,t.run.id));
      expect(rows.some(e=>e.eventType==='native.process_identity_recorded')).toBe(false);
    }
    // Real harness idle close, then real copy collector for latest C only.
    await session.close({reason:'controlled warm idle timeout'});
    await producer.close();
    const collected = await f.copies.collectStopped({companyId:f.company.id,runId:saved.id});
    expect(['saved','unchanged']).toContain(collected!.state);
    expect(collected!.receipt?.cleanupPending).toBe(false);
    expect(collected!.receipt?.materializationRunId).toBe(savedA.id);
    expect(collected!.receipt?.directoryRunId).toBe(savedA.id);
    expect(collected!.runId).toBe(saved.id);
    // Release all active local fixture leases, preserving native rows.
    for (const t of turns) await db.update(environmentLeases).set({status:'released',
      releasedAt:new Date(),cleanupStatus:'success'}).where(eq(environmentLeases.heartbeatRunId,t.run.id));
    await f.writeControlledStoppedRunnerProjection(producer.core.store.state.identity,
      turns.at(-1)!.outcome.checkpoint.sessionId,turns.at(-1)!.outcome.checkpoint.providerSessionId ?? null);
    const before = await readFile(join(root,'control-plane/control-plane-state.json'));
    expect(producer.core.store.state.identity.runId).toBe(saved.id);
    const d = await f.prepare(await f.read(saved.id)); // no reuse: actual cold controller
    const originRun=turns[0]!.run,middleRun=turns[1]!.run,latestRun=await f.read(saved.id);
    const events=await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.companyId,f.company.id));
    await expect(inspectStoppedNativeReviewerOwners({runs:[latestRun],processEvidence:events})).rejects.toThrow();
    const mutateProfile=async (runId:string,change:(checkpoint:Record<string,unknown>)=>Record<string,unknown>)=>{
      const row=await f.read(runId),profile=row.runnerProfileJson!;
      await db.update(heartbeatRuns).set({runnerProfileJson:{...profile,sessionCheckpoint:change(profile.sessionCheckpoint as Record<string,unknown>)}}).where(eq(heartbeatRuns.id,runId));
    };
    const mutateEvent=async (row:typeof events[number],change:(event:PrpEvent)=>PrpEvent,validHash=true)=>{
      const event=change(row.payload!.prpEvent as unknown as PrpEvent);
      await db.update(heartbeatRunEvents).set({payload:{prpEvent:event},sourcePayloadSha256:validHash?nativeSha256(event):"f".repeat(64)}).where(eq(heartbeatRunEvents.id,row.id));
    };
    const controlPath=join(root,"control-plane/control-plane-state.json");
    const mutateControl=async (change:(value:Frame)=>void)=>{const value=JSON.parse(await readFile(controlPath,"utf8"));change(value);await writeFile(controlPath,JSON.stringify(value));};
    if(fault==="receipt_tamper")await mutateControl(c=>{c.completedWarmTransition.receipt.resultDigest="sha256:"+"f".repeat(64)});
    if(fault==="origin_foreign")await mutateControl(c=>{c.bootstrapHistory.originIdentity.runnerInstanceId=randomUUID()});
    if(fault==="origin_missing")await mutateControl(c=>{delete c.bootstrapHistory});
    if(["origin_host","origin_birth","origin_group"].includes(fault)){
      const row=events.find(e=>e.runId===originRun.id&&e.eventType==="native.process_identity_recorded")!;
      await db.update(heartbeatRunEvents).set({payload:{...row.payload,...(fault==="origin_host"?{hostname:"foreign-fixture"}:fault==="origin_birth"?{processStartedAt:new Date(0).toISOString()}:{processGroupId:99_990_012})}}).where(eq(heartbeatRunEvents.id,row.id));
    }
    const attachment=events.find(e=>e.runId===middleRun.id&&e.eventType==="run.attached")!;
    if(fault==="attachment_missing")await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.id,attachment.id));
    if(fault==="attachment_hash")await mutateEvent(attachment,e=>e,false);
    if(fault==="event_run_binding")await mutateEvent(attachment,e=>({...e,normalizedSessionId:randomUUID()}));
    if(fault==="checkpoint_pending")await mutateProfile(middleRun.id,c=>({...c,pendingRuntimeRequests:[{id:"pending-fixture"}]}));
    if(fault==="unknown_process_generation")await db.update(heartbeatRuns).set({processPid:99_990_012}).where(eq(heartbeatRuns.id,middleRun.id));
    if(fault==="copy_directory_origin"){const copy=await f.copies.get(f.company.id,latestRun.id);await db.update(agentInstructionWorkingCopies).set({receipt:{...copy!.receipt,directoryRunId:latestRun.id}}).where(eq(agentInstructionWorkingCopies.runId,latestRun.id));}
    if(fault==="canonical_owner"){const path=join(root,"runner/runner-state.json"),v=JSON.parse(await readFile(path,"utf8"));v.runId=originRun.id;await writeFile(path,JSON.stringify(v));}
    if(fault==="attachment_false")await mutateEvent(attachment,e=>({...e,payload:{...e.payload,sameSession:false}}));
    if(fault==="checkpoint_borrowed")await mutateProfile(middleRun.id,c=>({...c,identity:{...(c.identity as object),runId:randomUUID()}}));
    if(fault==="checkpoint_thread")await mutateProfile(middleRun.id,c=>({...c,sessionId:"foreign-thread"}));
    if(fault==="live_sidecar")await mutateEvent(attachment,e=>({...e,payload:{...e.payload,sidecarPid:process.pid}}));
    if(fault==="copy_origin"||fault==="copy_successor"){
      const runId=fault==="copy_origin"?latestRun.id:middleRun.id;const copy=await f.copies.get(f.company.id,runId);
      await db.update(agentInstructionWorkingCopies).set({receipt:{...copy!.receipt,...(fault==="copy_origin"?{materializationRunId:randomUUID()}:{successorRunId:randomUUID()})}}).where(eq(agentInstructionWorkingCopies.runId,runId));
    }
    if(fault==="source_goal")await mutateProfile(latestRun.id,c=>({...c,goal:{status:"blocked",objective:"Retain"}}));
    if(fault==="historical_uncertain_git"){
      const key=randomUUID();await db.insert(githubPushOperationReceipts).values({id:randomUUID(),companyId:f.company.id,agentId:f.agent.id,runId:middleRun.id,
        idempotencyKey:key,binding:{companyId:f.company.id,agentId:f.agent.id,runId:middleRun.id},request:{idempotencyKey:key},fingerprint:"d".repeat(64),state:"uncertain",createdAt:new Date(),finishedAt:new Date()});
    }
    if(fault==="foreign_history"||fault==="history_overflow") {
      // A different agent is deliberately invisible to native's normal resume
      // selector, but must NOT disappear from the cold proof's session history.
      const [foreign]=await db.insert(agents).values({companyId:f.company.id,name:"Foreign history fixture",status:"idle",adapterType:"paperclip_runner"}).returning();
      await db.insert(heartbeatRuns).values(Array.from({length:fault==="history_overflow"?14:1},()=>({companyId:f.company.id,agentId:foreign!.id,issueId:f.issue.id,nativeIssueId:f.issue.id,
        status:"failed",nativeSessionId:latestRun.nativeSessionId,createdAt:new Date(Date.now()+60_000)})));
    }
    if(fault==="provider_generation"||fault==="root_drift_commit"){
      const change=async()=>{const file=join(root,"runner/codex-provider-state.json"),v=JSON.parse(await readFile(file,"utf8"));v.threadId="foreign-thread";await writeFile(file,JSON.stringify(v));};
      if(fault==="root_drift_commit")d.input.beforeNativeRuntimeSelection=change;else await change();
    }
    if(fault==="pending_attach")await mutateControl(c=>{c.warmTransition={phase:"prepared"}});
    if(fault==="historical_binding_commit")d.input.beforeNativeRuntimeSelection=()=>mutateProfile(middleRun.id,c=>({...c,identity:{...(c.identity as object),runId:randomUUID()}}));
    if(!["none","saved_origin_drift","rust_forms","harness_forms"].includes(fault)){
      await expect(d.select()).rejects.toMatchObject({name:"NativeProviderStateIncompatibleError"});
      expect((await f.read(d.run.id)).runnerProfileJson?.nativeExecutionInput).toBeUndefined();
      return;
    }
    const cold = await d.select();
    if (!cold.selected || !cold.nativeExecution) throw new Error('cold native selection missing');
    expect(cold.nativeExecution.session.normalizedSessionId).not.toBe(saved.nativeSessionId);
    expect(cold.nativeRunnerInstanceId).not.toBe(saved.runnerInstanceId);
    expect(cold.nativeExecution.runtimeContext.instructions.workingCopy!.rootPath)
      .not.toBe(selected.nativeExecution!.runtimeContext.instructions.workingCopy!.rootPath);
    expect(cold.nativeExecution.runtimeContext.mcp.bindingId).toBe(`native-mcp:${d.run.id}`);
    expect(cold.nativeExecution.task.prompt).toContain('Complete full synthetic task history');
    expect(await readFile(join(root,'control-plane/control-plane-state.json'))).toEqual(before);
    expect(await readFile(join(f.reference,'README.txt'),'utf8')).toBe('Read-only synthetic reference.\n');
    const hint=(await f.read(d.run.id)).runnerProfileJson!.nativeColdScopedContinuation as Record<string,unknown>;
    expect(hint.sourceWarmOriginSha256).toMatch(/^[a-f0-9]{64}$/);
    const rebuilt=await prepareNativeColdScopedContinuation({db,previous:selected.nativeExecution!,current:cold.nativeExecution,localScoped:true,
      expectedFingerprint:String(hint.sourceAuthoritySha256),expectedWarmOriginFingerprint:hint.sourceWarmOriginSha256});
    expect(rebuilt).not.toBeNull();await rebuilt!.recheck(db);
    if(fault==="saved_origin_drift"){
      await mutateProfile(middleRun.id,c=>({...c,identity:{...(c.identity as object),runId:randomUUID()}}));
      await expect(executePaperclipNativeSession({db,execution:cold.nativeExecution,runnerInstanceId:cold.nativeRunnerInstanceId!,useRunnerd:true,
        workspaceAccess:cold.referenceFolderAccess!.workspaceAccess!})).rejects.toMatchObject({name:"NativeProviderStateIncompatibleError"});
      const afterEvents=await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId,d.run.id));
      expect(afterEvents.some(e=>e.eventType==="native.process_start_requested")).toBe(false);
    }
    expect((await f.read(d.run.id)).processPid).toBeNull(); // stop before any cold backend
  } finally {
    await session.close({reason:'fixture finalizer'}).catch(()=>{});
    await producer.close().catch(()=>{});
  }
});


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

import { createHash, createHmac, createCipheriv, createDecipheriv } from "node:crypto";
import { DurablePrpControlPlane, captureLegacyDurablePrpCheckpoint, durableRecoveryInternals,
  type DurablePrpCheckpoint } from "../../../packages/paperclip-runner/src/control-plane/durable-prp-control-plane.js";
import type { DurableRecoveryIdentity } from "../../../packages/paperclip-runner/src/control-plane/prp-transport-types.js";

type Frame = Record<string, any>;
const version = "0.3.0", artifact = `sha256:${"a".repeat(64)}`;
function framed(domain: string, parts: Buffer[]) {
  const bytes: Buffer[] = [Buffer.from(domain), Buffer.from([0])];
  for (const part of parts) { const size = Buffer.alloc(8); size.writeBigUInt64BE(BigInt(part.length)); bytes.push(size, part); }
  return Buffer.concat(bytes);
}
const digest = (domain: string, parts: Buffer[]) => createHash("sha256").update(framed(domain, parts)).digest();
const mac = (key: Buffer, domain: string, parts: Buffer[]) => createHmac("sha256", key).update(framed(domain, parts)).digest();
function nonce(prefix: string, counter: number) { const n = Buffer.alloc(12); n.write(prefix,0,"ascii"); n.writeBigUInt64BE(BigInt(counter),4); return n; }
function frames() {
  const buffered: Frame[] = [], pending: Array<(frame: Frame) => void> = [];
  return {
    push(frame: Frame) { const waiter = pending.shift(); if (waiter) waiter(frame); else buffered.push(frame); },
    async next(): Promise<Frame> {
      if (buffered.length) return buffered.shift()!;
      return new Promise((resolve, reject) => {
        const deliver = (frame: Frame) => { clearTimeout(timer); resolve(frame); };
        const timer = setTimeout(() => { const i = pending.indexOf(deliver); if (i >= 0) pending.splice(i,1); reject(new Error("authenticated fixture frame timeout")); }, 3000);
        pending.push(deliver);
      });
    },
  };
}
async function authenticatedPeer(core: DurablePrpControlPlane, token: string,
  identity: DurableRecoveryIdentity, transitionId?: string) {
  const queue = frames();
  let deliver!: (frame: unknown) => void;
  let closed: ((detail?: any) => void) | undefined;
  let isClosed = false;
  const close = () => { if (!isClosed) { isClosed = true; closed?.({ message: "test peer closed" }); } };
  core.attachWireConnection({
    onJson(listener) { deliver = listener; }, onClose(listener) { closed = listener; },
    sendJson(value) { queue.push(value as Frame); }, close,
  });
  const credential = Buffer.from(token);
  const key = digest("paperclip-runner-auth-key-v1", [credential]);
  const credentialId = `sha256:${digest("paperclip-runner-credential-id-v1", [credential]).toString("hex")}`;
  deliver({ protocol: "paperclip.runner", version: 1, kind: "auth_hello", payload: {
    credentialId, clientNonce: "bounded-warm-origin-fixture", protocolMin: 1, protocolMax: 1,
    warmTransitionVersion: 1, recoveryCursorVersion: 1,
    resume: { ackedSourceSeq: 0, nextSourceEventSeq: 1 }, ...identity,
    runnerVersion: version, runnerDigest: artifact,
    ...(transitionId ? { warmTransitionId: transitionId } : {}),
  } });
  const challenge = (await queue.next()).payload;
  const { serverProof, ...fields } = challenge;
  const canonical = Buffer.from(durableRecoveryInternals.canonicalJson(fields));
  expect(serverProof).toBe(mac(key,"paperclip-runner-server-proof-v1",[canonical]).toString("hex"));
  const proof = mac(key,"paperclip-runner-client-proof-v1",[canonical,Buffer.from(serverProof)]).toString("hex");
  deliver({ protocol: "paperclip.runner", version: 1, kind: "auth_response", payload: {
    credentialId, clientNonce: challenge.clientNonce, serverNonce: challenge.serverNonce, clientProof: proof,
  } });
  const binding = digest("paperclip-runner-session-binding-v1",[canonical,Buffer.from(serverProof),Buffer.from(proof)]);
  const sessionId = `sha256:${binding.toString("hex")}`;
  let sent = 0, received = 0;
  const aad = (direction: string, counter: number) => Buffer.from(`paperclip.runner.secure-frame.v1\0${sessionId}\0${direction}\0${counter}`);
  const receive = async (): Promise<Frame> => {
    const frame = await queue.next(); expect(frame.counter).toBe(received);
    const bytes = Buffer.from(frame.ciphertext,"hex");
    const decipher = createDecipheriv("aes-256-gcm",mac(key,"paperclip-runner-core-to-client-key-v1",[binding]),nonce("P3S1",received));
    decipher.setAAD(aad("core_to_client",received++)); decipher.setAuthTag(bytes.subarray(-16));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(0,-16)),decipher.final()]).toString());
  };
  const send = (value: Frame) => {
    const counter = sent++;
    const cipher = createCipheriv("aes-256-gcm",mac(key,"paperclip-runner-client-to-core-key-v1",[binding]),nonce("P3C1",counter));
    cipher.setAAD(aad("client_to_core",counter));
    const sealed = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(value))),cipher.final(),cipher.getAuthTag()]);
    deliver({ schema: "paperclip.runner.secure-frame.v1", counter, ciphertext: sealed.toString("hex") });
  };
  const welcome = await receive(); expect(welcome.kind).toBe("welcome");
  // A lease-authenticated welcome does not mint another token.
  return { send, receive, close, token: typeof welcome.payload.connectionLeaseToken === "string" ? welcome.payload.connectionLeaseToken : token };
}

async function settleHarnessTurn(session: NativeSession, transport: FakeCodexTransport,
  label: string, publish: (event: PrpEvent) => Promise<PrpEvent>, form?: string) {
  const turnId = `controlled-turn-${label}`;
  transport.turnStartResponse = Promise.resolve({turn:{id:turnId,status:'inProgress',items:[]}});
  await session.startTurn({message:{role:'user',text:`Complete bounded turn ${label}.`}});
  transport.push('turn/completed', {threadId:transport.threadId,
    turn:{id:turnId,status:'completed',items:[]}});
  const events: PrpEvent[] = [];
  // Do not drain forever: the SDK event iterator is intentionally reusable.
  for await (const event of session.events()) {
    events.push(event);
    if (event.eventType === 'turn.completed') break;
  }
  const checkpoint = await session.snapshot();
  expect(checkpoint.activeTurnId).toBeNull();
  expect(checkpoint.pendingRuntimeRequests).toEqual([]);
  expect(checkpoint.goal).toBeNull();
  expect(checkpoint.terminal).toMatchObject({schema:'paperclip.prp.terminal.v1',
    runTerminalState:'succeeded',turnTerminalState:'completed'});
  // Publish actual harness run.attached for B/C; A must have session.started.
  const boundary = events.find(e => label === 'A'
    ? e.eventType === 'session.started' : e.eventType === 'run.attached');
  expect(boundary).toBeDefined();
  const published = await publish(boundary!);
  const reconciled=form?await publish({...published,eventType:"session.reconciled",priority:0,
    payload:form.startsWith("rust_")?{provider:"codex",providerSessionId:form==="rust_reconciled_changed"?"foreign-thread":checkpoint.sessionId,activeProviderTurnId:null}
      :{providerSessionId:form==="harness_reconciled_account_changed"?"foreign-account":checkpoint.providerSessionId,turnCount:0,activeTurnId:null}}):null;
  const terminal = await publish({...published,eventType:'run.terminal',priority:0,
    payload: structuredClone(checkpoint.terminal!) as unknown as Record<string,unknown>});
  return {checkpoint,events,published,terminal,reconciled};
}


// Diagnostic of the actual LOCAL file-backed producer, deliberately without
// setCheckpointPersistence: production enables that only for remote runners.
async function localWarmProducer(root: string, initial: DurableRecoveryIdentity, form?: string) {
  const core = new DurablePrpControlPlane({ stateDirectory: root, identity: initial,
    expectedRunnerVersion: version, expectedRunnerDigest: artifact });
  let peer = await authenticatedPeer(core, core.issueBootstrapTicket(), initial);
  const capture = async () => captureLegacyDurablePrpCheckpoint(await readFile(join(root, "control-plane-state.json"), "utf8"), core.store.state.identity);
  async function attach(next: DurableRecoveryIdentity) {
    const prior = structuredClone(core.store.state.identity);
    const template = { provider: { kind: "mock", run: next.runId }, authorizedTools: {} };
    const command = core.queueCommand("run.attach", { ...template,
      paperclipNextAuthority: { identity: next, connection: { mode: "connect", connectUrl: "ws://127.0.0.1:1/test-only" } },
    }, `attach_${next.runId}`, true);
    const request = await peer.receive(); expect(request.kind).toBe("command");
    expect(request.payload.commandId).toBe(command.commandId);
    peer.send({ protocol: "paperclip.runner", version: 1, kind: "command_result", payload: {
      commandId: command.commandId, commandType: command.type, controllerSeq: command.controllerSeq,
      status: "completed", result: { attached: true },
    } });
    const ack = await peer.receive(); expect(ack.kind).toBe("command_result_ack");
    const receipt = ack.payload.warmTransition;
    expect(receipt.oldIdentity).toEqual(prior); expect(receipt.newIdentity).toEqual(next);
    // The SDK's real authenticated handler creates and validates this receipt.
    core.rotateRunIdentity(next, template);
    const token = peer.token; peer.close();
    peer = await authenticatedPeer(core, token, next, receipt.transitionId);
    peer.send({ protocol: "paperclip.runner", version: 1, kind: "warm_transition_activated", payload: { transitionId: receipt.transitionId } });
    expect((await peer.receive()).kind).toBe("warm_transition_activated_ack");
    await vi.waitFor(() => expect(core.store.state.warmTransition).toBeUndefined());
    expect(core.store.state.completedWarmTransition?.receipt).toEqual(receipt);
    return receipt;
  }
  async function publish(input: PrpEvent) {
    const identity=core.store.state.identity,sourceSeq=core.store.state.ackedSourceSeq+1;
    const {runnerInstanceId,environmentLeaseId,...bound}=identity;
    const event={...input,...bound,sourceInstanceId:runnerInstanceId,sourceKind:"runner" as const,
      sourceSeq,sourceEventId:`${runnerInstanceId}:${identity.runId}:${sourceSeq}`,
      payload:input.eventType==="session.started"?(form?.startsWith("rust_")?{provider:"codex",providerSessionId:input.payload.driverSessionId,
        providerAccountSessionId:form==="rust_account_changed"?"foreign-account":input.payload.providerSessionId,processId:99_990_011}
        :{...input.payload,processId:99_990_011}):input.payload};
    const parsed=validatePrpEvent(event);expect(parsed.ok).toBe(true);if(!parsed.ok)throw new Error(JSON.stringify(parsed));
    peer.send({protocol:"paperclip.runner",version:1,kind:"event",...identity,payload:event});
    const ack=await peer.receive();expect(ack.kind).toBe("ack");expect(ack.payload.ackedSourceSeq).toBe(sourceSeq);
    await vi.waitFor(()=>expect(core.store.state.ackedSourceSeq).toBe(sourceSeq));
    return event;
  }
  return { core, capture, attach, publish, close: async () => { peer.close(); await core.stop(); await core.drainPendingConnectionProcessing(); } };
}

it("diagnoses actual local warm producer retention across two authenticated attachments", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-warm-producer-retention-"));
  const a: DurableRecoveryIdentity = { runId: randomUUID(), normalizedSessionId: randomUUID(), runnerInstanceId: randomUUID(),
    environmentLeaseId: randomUUID(), turnId: "turn-a", itemId: "item-a" };
  const b = { ...a, runId: randomUUID(), turnId: "turn-b", itemId: "item-b" };
  const c = { ...a, runId: randomUUID(), turnId: "turn-c", itemId: "item-c" };
  const producer = await localWarmProducer(root, a);
  try {
    producer.core.persistRunAttachTemplate({ provider: { kind: "mock", run: a.runId }, authorizedTools: {} });
    const ab = await producer.attach(b);
    const before = await producer.capture();
    expect(JSON.parse(before.records.get("header")!).state.completedWarmTransition.receipt).toEqual(ab);
    const bc = await producer.attach(c);
    const after = await producer.capture();
    const state = JSON.parse(after.records.get("header")!).state;
    expect(state.completedWarmTransition.receipt).toEqual(bc);
    expect(state.completedWarmTransition.receipt.oldIdentity).toEqual(b);
    // Important diagnostic, NOT successful cold-continuation acceptance:
    // after B->C, no authenticated A->B link remains in the local canonical
    // checkpoint. No producer created a per-run DB checkpoint or local archive.
    expect(JSON.stringify([...after.records])).not.toContain(ab.transitionId);
    expect(await readdir(root)).toEqual(["control-plane-state.json"]);
  } finally { await producer.close(); }
});

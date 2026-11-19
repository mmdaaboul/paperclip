import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, issues, heartbeatRuns, heartbeatRunEvents, agentReviewerPolicies, completionContracts, nativeRunResults, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { parseNativeExecutionInput } from "../vendor/paperclip-runner/index.js";
import { nativeSha256 } from "../services/native-runtime/canonical.js";
import { currentProcessSpaceHash } from "../services/controller-process-identity.js";
import { inspectStoppedNativeReviewerOwners, scopedRunnerdStateRoot } from "../services/native-runtime/native-session-executor.js";
import { readReviewerProcessEvidence, proveReviewerRecordedOwnerStopped } from "../services/native-runtime/reviewer-policy-process-proof.js";
import { retireNativeReviewerExecutions, assertNativeReviewerRetirementCurrent } from "../services/native-runtime/reviewer-policy-retirement.js";
import { reviewerNativeTestDatabase } from "./helpers/reviewer-native-database.js";

describe("Reviewer permission changes use native stopped-owner evidence", () => {
  let connection: Awaited<ReturnType<typeof reviewerNativeTestDatabase>>, db: Db, base: string;
  const originalRoot = process.env.PAPERCLIP_RUNNER_STATE_DIR;
  beforeAll(async () => { connection = await reviewerNativeTestDatabase(); db = connection.db; base = await mkdtemp(join(tmpdir(), "f05-retirement-")); process.env.PAPERCLIP_RUNNER_STATE_DIR = base; });
  afterAll(async () => { if (originalRoot === undefined) delete process.env.PAPERCLIP_RUNNER_STATE_DIR; else process.env.PAPERCLIP_RUNNER_STATE_DIR = originalRoot; await connection?.end(); await rm(base, { recursive: true, force: true }); });
  async function fixture(two = false) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), workspaceId = randomUUID(), nativeSessionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Stopped owner fixture", issuePrefix: `T${companyId.slice(0,6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Reviewer fixture", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Native owner fixture", status: "done" });
    const contractId = randomUUID();
    await db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: 1, schemaVersion: "fixture", policyVersion: "fixture", risk: "low", completionAuthority: "review", incompleteCriteriaPolicy: "reject", contractJson: {}, canonicalSha256: "a".repeat(64), createdByActorType: "user", createdByActorId: "fixture" });
    const runs: Array<{ run: typeof heartbeatRuns.$inferSelect; execution: ReturnType<typeof parseNativeExecutionInput>; event: Record<string, unknown>; pid: number; providerPid: number }> = [];
    for (let index = 0; index < (two ? 2 : 1); index++) {
      const id = randomUUID(), runnerInstanceId = randomUUID(), pid = 99_990_010 + index * 2, providerPid = pid + 1;
      const execution = parseNativeExecutionInput({ schema: "paperclip.native-execution-input.v1", provider: { kind: "codex", model: null },
        binding: { companyId, agentId, issueId, runId: id, executionWorkspaceId: workspaceId },
        task: { identifier: "TEST", title: "Proof", description: null, prompt: "Synthetic offline fixture", workMode: "standard" },
        workspace: { cwd: join(base, workspaceId), repoUrl: null, repoRef: null, branchName: null },
        session: { normalizedSessionId: nativeSessionId, driverKind: "codex_app_server", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
        completionContract: { id: "contract", sha256: "sha", schemaVersion: "paperclip.completion-contract.v1", contract: { revision: "1", objective: "Proof", criteria: [{ id: "test", requirement: "Proof" }] } },
        interactionResponses: [], credentialBindings: [] });
      const [run] = await db.insert(heartbeatRuns).values({ id, companyId, agentId, status: "succeeded", runtimeMode: "native", nativeIssueId: issueId, nativeSessionId, runnerInstanceId,
        driverKind: "codex_app_server", completionContractId: contractId, finishedAt: new Date(), processHostHash: currentProcessSpaceHash(),
        runnerProfileJson: { nativeExecutionInput: execution, sessionCheckpoint: { process: { providerPid } } } }).returning();
      const resultId = randomUUID();
      await db.insert(nativeRunResults).values({ id: resultId, companyId, issueId, runId: id, completionContractId: contractId, serverFingerprint: "fixture", schemaStatus: "accepted", resultJson: {}, canonicalSha256: "b".repeat(64) });
      await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId: id, phase: "committed", resultId });
      const started = new Date("2026-11-01T12:00:00Z").toISOString();
      await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId: id, seq: 1, eventType: "native.process_identity_recorded", payload: { targetKind: "local", hostname: hostname(), processPid: pid, processGroupId: pid, processStartedAt: started } });
      const event = { schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceKind: "runner", sourceInstanceId: runnerInstanceId,
        runId: id, normalizedSessionId: nativeSessionId, sourceSeq: 1, sourceEventId: `${runnerInstanceId}:${id}:1`, priority: 0, emittedAt: started,
        eventType: "session.started", payload: { providerSessionId: "fixture", processId: providerPid } };
      await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId: id, seq: 2, eventType: event.eventType, sourceInstanceId: runnerInstanceId, sourceSeq: 1, sourceEventId: event.sourceEventId, sourcePayloadSha256: nativeSha256(event), payload: { prpEvent: event } });
      runs.push({ run: run!, execution, event, pid, providerPid });
    }
    const last = runs.at(-1)!, root = scopedRunnerdStateRoot(last.execution);
    await mkdir(join(root, "control-plane"), { recursive: true, mode: 0o700 }); await mkdir(join(root, "runner"), { recursive: true, mode: 0o700 });
    const identity = { runId: last.run.id, normalizedSessionId: nativeSessionId, runnerInstanceId: last.run.runnerInstanceId!, environmentLeaseId: "fixture-lease", turnId: "turn", itemId: "item" };
    const terminal = { ...last.event, eventType: "run.terminal", payload: {} };
    const control = { schema: "paperclip.runner.durable.control-plane-state.v1", identity, commands: [], committedEvents: [{ eventType: "run.terminal", envelope: { ...identity, payload: terminal } }] };
    const runner = { schema: "paperclip.runner.durable.state.v1", ...identity, lifecycle: "suspended", outbox: [], pendingTerminalDelivery: null, pendingProviderCleanup: null };
    const provider = { schema: "paperclip.runner.codex-provider-state.v1", config: { provider: "codex", command: "codex", cwd: last.execution.workspace.cwd }, threadId: "fixture", lifecycle: "prepared", pendingEvents: [], queuedEvents: [], startupAttempt: null, activeProviderTurnId: null };
    for (const [name, value] of [["control-plane/control-plane-state.json", control], ["runner/runner-state.json", runner], ["runner/codex-provider-state.json", provider]] as const) await writeFile(join(root, name), JSON.stringify(value), { mode: 0o600 });
    const scope = { companyId, agentId, expectedRevision: 0 };
    const readRuns = async () => db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId)));
    const evidence = () => readReviewerProcessEvidence(db, companyId, runs.map(item => item.run.id));
    const inspect = async () => inspectStoppedNativeReviewerOwners({ runs: await readRuns(), processEvidence: await evidence() });
    return { companyId, agentId, scope, runs, root, control, runner, provider, evidence, readRuns, inspect };
  }
  it("qualifies a successful per-turn run with cleared PID columns and preserves files/history", async () => {
    const f = await fixture(), bytes = await readFile(join(f.root, "control-plane/control-plane-state.json"));
    const receipt = await retireNativeReviewerExecutions(db, f.scope); await assertNativeReviewerRetirementCurrent(db, receipt, f.scope);
    expect(await readFile(join(f.root, "control-plane/control-plane-state.json"))).toEqual(bytes);
    expect(await f.readRuns()).toHaveLength(1); expect(await db.select().from(agentReviewerPolicies).where(eq(agentReviewerPolicies.agentId, f.agentId))).toEqual([]);
  });
  it("proves two successive runs against only the newer current scope without inventing an old root", async () => {
    const f = await fixture(true); expect(scopedRunnerdStateRoot(f.runs[0]!.execution)).toBe(f.root);
    const proof = await f.inspect(); expect(await proof.recheck()).toBe(true); expect(await f.readRuns()).toHaveLength(2);
  });
  it("retains the older run's independent live-provider obligation", async () => {
    const f = await fixture(true), first = f.runs[0]!;
    await db.update(heartbeatRuns).set({ runnerProfileJson: { ...first.run.runnerProfileJson, sessionCheckpoint: { process: { providerPid: process.pid } } } }).where(eq(heartbeatRuns.id, first.run.id));
    await expect(f.inspect()).rejects.toMatchObject({ status: 409 });
  });
  it("refuses forged provider provenance even when every PID is absent", async () => {
    const f = await fixture(); await db.update(heartbeatRunEvents).set({ sourcePayloadSha256: "0".repeat(64) }).where(and(eq(heartbeatRunEvents.runId, f.runs[0]!.run.id), eq(heartbeatRunEvents.seq, 2)));
    await expect(f.inspect()).rejects.toMatchObject({ status: 409 });
  });
  it("ordinary output does not evict earlier process evidence", async () => {
    const f = await fixture(), run = f.runs[0]!.run;
    await db.insert(heartbeatRunEvents).values(Array.from({ length: 150 }, (_, i) => ({ companyId: f.companyId, agentId: f.agentId, runId: run.id, seq: i + 3, eventType: "provider.event", payload: { prpEvent: { payload: { text: "ordinary output" } } } })));
    expect(await f.evidence()).toHaveLength(2); expect(await (await f.inspect()).recheck()).toBe(true);
  });
  it("refuses a malformed independently recorded provider identity", async () => {
    const f = await fixture(), run = f.runs[0]!.run;
    await db.update(heartbeatRuns).set({ runnerProfileJson: { ...run.runnerProfileJson, sessionCheckpoint: { process: { sidecarPid: "unknown" } } } }).where(eq(heartbeatRuns.id, run.id));
    await expect(f.inspect()).rejects.toMatchObject({ status: 409 });
  });
  it("does not probe a remote/foreign process space", async () => {
    const f = await fixture(), run = f.runs[0]!.run;
    await db.update(heartbeatRuns).set({ processHostHash: "remote" }).where(eq(heartbeatRuns.id, run.id));
    await expect(f.inspect()).rejects.toMatchObject({ status: 409, details: { code: "reviewer_retirement_foreign_process_space" } });
  });
  it("refuses an unidentified later launch despite earlier stopped evidence", async () => {
    const f = await fixture(), run = f.runs[0]!.run;
    await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, agentId: f.agentId, runId: run.id, seq: 3, eventType: "native.process_start_requested", payload: { hostname: hostname() } });
    await expect(f.inspect()).rejects.toMatchObject({ status: 409 });
  });
  it("refuses a durable root owned by a foreign run", async () => {
    const f = await fixture(); await writeFile(join(f.root, "control-plane/control-plane-state.json"), JSON.stringify({ ...f.control, identity: { ...f.control.identity, runId: randomUUID() } }));
    await expect(f.inspect()).rejects.toThrow("reviewer_retirement_current_scope_owner_missing");
  });
  it("invalidates the observation after durable-state mutation", async () => {
    const f = await fixture(), proof = await f.inspect();
    await writeFile(join(f.root, "runner/codex-provider-state.json"), JSON.stringify({ ...f.provider, startupAttempt: { phase: "intent" } }));
    expect(await proof.recheck()).toBe(false);
  });
  it("refuses pending durable work without changing its bytes", async () => {
    const f = await fixture(), path = join(f.root, "runner/runner-state.json"), value = JSON.stringify({ ...f.runner, pendingProviderCleanup: { pending: true } });
    await writeFile(path, value); await expect(f.inspect()).rejects.toThrow("reviewer_retirement_current_scope_provider_unsettled"); expect(await readFile(path,"utf8")).toBe(value);
  });
  it("DB-only commit rejects drift and forged retirement receipts", async () => {
    const f = await fixture(), receipt = await retireNativeReviewerExecutions(db, f.scope);
    await expect(assertNativeReviewerRetirementCurrent(db, { ...receipt }, f.scope)).rejects.toMatchObject({ status: 409 });
    await db.update(agents).set({ adapterConfig: { model: "changed" } }).where(eq(agents.id, f.agentId));
    await expect(assertNativeReviewerRetirementCurrent(db, receipt, f.scope)).rejects.toMatchObject({ status: 409 });
  });
  it("refuses a native owner whose coordinator row is missing", async () => {
    const f = await fixture(); await db.delete(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runs[0]!.run.id));
    await expect(retireNativeReviewerExecutions(db, f.scope)).rejects.toMatchObject({ status: 409 });
  });
  it("rechecks the fixed physical observation at the policy commit boundary", async () => {
    const f = await fixture(), receipt = await retireNativeReviewerExecutions(db, f.scope);
    await writeFile(join(f.root,"runner/codex-provider-state.json"),JSON.stringify({...f.provider,threadId:"changed"}));
    await expect(assertNativeReviewerRetirementCurrent(db, receipt, f.scope)).rejects.toMatchObject({ status: 409 });
  });
  it("does not treat missing launch evidence and an absent root as never launched", async () => {
    const f = await fixture(); await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId,f.runs[0]!.run.id));
    await db.update(heartbeatRuns).set({runnerProfileJson:{nativeExecutionInput:f.runs[0]!.execution}}).where(eq(heartbeatRuns.id,f.runs[0]!.run.id));
    await rm(f.root,{recursive:true}); await expect(retireNativeReviewerExecutions(db,f.scope)).rejects.toMatchObject({status:409});
  });
  it.each(["cwd","threadId"])("refuses a provider-state copied from another scope: %s",async field=>{
    const f=await fixture();const provider=field==="cwd"?{...f.provider,config:{...f.provider.config,cwd:"/foreign"}}:{...f.provider,threadId:"foreign"};
    await writeFile(join(f.root,"runner/codex-provider-state.json"),JSON.stringify(provider));
    await expect(f.inspect()).rejects.toThrow("reviewer_retirement_current_provider_scope_mismatch");
  });

  it("accepts the native resolved absolute Codex command and a stopped ready projection",async()=>{
    const f=await fixture();expect(process.env.PAPERCLIP_TEST_CODEX_BINARY).toMatch(/^\//);
    await writeFile(join(f.root,"runner/codex-provider-state.json"),JSON.stringify({...f.provider,config:{...f.provider.config,command:process.env.PAPERCLIP_TEST_CODEX_BINARY}}));
    await writeFile(join(f.root,"runner/runner-state.json"),JSON.stringify({...f.runner,lifecycle:"ready"}));
    expect(await (await f.inspect()).recheck()).toBe(true);
  });
  it.each(["activeTurnId","providerExitUnconfirmed","pendingEvents","toolBridge"])("rejects contradictory native provider drain state: %s",async field=>{
    const f=await fixture();const value=field==="activeTurnId"?"active":field==="providerExitUnconfirmed"?true:field==="pendingEvents"?"malformed":{pending:{call:{id:"unanswered"}}};
    await writeFile(join(f.root,"runner/codex-provider-state.json"),JSON.stringify({...f.provider,[field]:value}));
    await expect(f.inspect()).rejects.toThrow("reviewer_retirement_current_scope_provider_unsettled");
  });

  it("keeps a normalized session receipt whose process identity is in the checkpoint",async()=>{
    const f=await fixture(),run=f.runs[0]!;const event={...run.event,payload:{driverSessionId:"fixture",providerSessionId:"account"}};
    await db.update(heartbeatRunEvents).set({payload:{prpEvent:event},sourcePayloadSha256:nativeSha256(event)}).where(and(eq(heartbeatRunEvents.runId,run.run.id),eq(heartbeatRunEvents.seq,2)));
    expect(await f.evidence()).toHaveLength(2);expect(await (await f.inspect()).recheck()).toBe(true);
  });

});

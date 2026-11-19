import { reviewerNativeTestDatabase } from "../__tests__/helpers/reviewer-native-database.js";
/** Actual migrated native PostgreSQL service/admission tests. No old DB, external
 * provider, credential lookup, Docker or VPS is used. Retain tiny DB evidence. */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { activityLog, agentReferenceFolderConfigs, agents, companies, createDb, executionWorkspaces, heartbeatRuns, issues, projects, type Db } from "@paperclipai/db";
import { agentReferenceFoldersService } from "./agent-reference-folders.js";
import { assertReferenceFoldersNativeTarget, prepareAgentReferenceFolderAdmission, validateAdmittedReferenceFolderAccess } from "./agent-reference-folder-admission.js";
import { forbidden, notFound, unprocessable } from "../errors.js";
import { createWorkspaceAccessSnapshot } from "../vendor/paperclip-runner/index.js";
import { buildNativeExecutionInput } from "./native-runtime/native-execution-input.js";
import { nativeRuntimeContextFixture } from "./native-runtime/runtime-context.test-fixture.js";
import express, { Router } from "express";
import request from "supertest";
import { registerAgentReferenceFolderRoutes } from "../routes/agent-reference-folders.js";
import { errorHandler } from "../middleware/error-handler.js";
import { createHeartbeatRunPreparation } from "./heartbeat/run-preparation.js";
import { selectHeartbeatRuntime, type HeartbeatRuntimeSelectionInput } from "./heartbeat/runtime-selection.js";
import { resolveHeartbeatNativeRuntimeMode } from "./native-runtime/runtime-mode.js";
import { buildNativeRuntimeContext } from "./native-runtime/runtime-context.js";
import { issueService } from "./issues.js";

const pool=await reviewerNativeTestDatabase(1),db=pool.db;
const actor = { type: "board" as const, userId: "reference-fixture-operator" };
let companyId: string, agent: typeof agents.$inferSelect, projectId: string, otherProjectId: string;
let root: string, workspaceDirectory: string, reference: string, secondReference: string;
let canConfigure: boolean, canGrant: boolean, supported: boolean, projectReadable: boolean, scanAllowed: boolean;
let scanCalls: number, authorizationExecutors: Set<Db>;
const roots: string[] = [];
const scope = () => ({ companyId, agentId: agent.id });
const service = () => agentReferenceFoldersService(db, {
  assertCanConfigure: async executor => { authorizationExecutors.add(executor); await executor.execute(sql`select 1`); if (!canConfigure) throw forbidden("Denied fixture operator"); },
  assertCanGrantHostPaths: () => { if (!canGrant) throw forbidden("Instance admin access required"); },
  assertSupportedAgent: async () => { if (!supported) throw unprocessable("Unsupported target"); },
  assertProjectReadable: async (id, executor) => { await executor.execute(sql`select 1`); if (!projectReadable || ![projectId, otherProjectId].includes(id)) throw notFound("Project not found"); },
  validateDirectory: async value => { scanCalls++; if (!scanAllowed) throw new Error("Retained directory must not be scanned during narrowing"); return realpathSync(value); },
});
const entry = (path = reference, selectedProject = projectId) => ({ projectId: selectedProject, path });
const save = (entries = [entry()], expectedRevision = 0) => service().update(scope(), actor, { expectedRevision, entries });

beforeEach(async () => {
  const parent = resolve(process.env.TMPDIR!,"reference-native"); mkdirSync(parent, { recursive: true });
  root = realpathSync(mkdtempSync(join(parent, "case-"))); roots.push(root);
  workspaceDirectory = join(root, "candidate"); reference = join(root, "reference"); secondReference = join(root, "reference-two");
  for (const path of [workspaceDirectory, reference, secondReference]) mkdirSync(path);
  writeFileSync(join(reference, "retained.txt"), "native reference\n");
  const [company] = await db.insert(companies).values({ name: "Reference folders native fixture", issuePrefix: `RF${randomUUID().replaceAll("-", "").slice(0, 12)}` }).returning(); companyId = company.id;
  [agent] = await db.insert(agents).values({ companyId, name: "Generic fixture agent", adapterType: "paperclip_runner", adapterConfig: { provider: "codex" } }).returning();
  const created = await db.insert(projects).values([{ companyId, name: "Reference project" }, { companyId, name: "Separate project" }]).returning();
  [projectId, otherProjectId] = created.map(project => project.id);
  canConfigure = canGrant = supported = projectReadable = scanAllowed = true; scanCalls = 0; authorizationExecutors = new Set();
});
afterAll(async () => { await pool.end(); for (const path of roots) rmSync(path, { recursive: true, force: true }); });

async function admittedFixture() {
  const [issue] = await db.insert(issues).values({ companyId, projectId, title: "Read reference", assigneeAgentId: agent.id }).returning();
  const [workspace] = await db.insert(executionWorkspaces).values({ companyId, projectId, mode: "isolated", strategyType: "git_worktree", name: "Native fixture workspace", cwd: workspaceDirectory }).returning();
  const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent.id, scopeKind: "issue", issueId: issue.id, status: "running", runtimeMode: "native" }).returning();
  const input = { agent, runId: run.id, issueId: issue.id, projectId, workspaceId: workspace.id, workspaceDirectory, executionDriver: "local" };
  const execution = buildNativeExecutionInput({ companyId, agentId: agent.id, runId: run.id, issue,
    taskPrompt: issue.title, workspace: { id: workspace.id, cwd: workspaceDirectory, repoUrl: null, repoRef: null, branchName: null },
    normalizedSessionId: null, provider: "codex", runtimeContext: nativeRuntimeContextFixture(),
    completionContract: { id: randomUUID(), sha256: `sha256:${"a".repeat(64)}`, schemaVersion: "paperclip.run-result.v1",
      contract: { revision: "1", objective: issue.title, criteria: [{ id: "reference", requirement: issue.title }] } },
  });
  return { issue, workspace, run, input, execution };
}

describe("immutable native reference-folder run admission", () => {
  it("binds an original revision and reuses it after config changes", async () => {
    await save(); const f = await admittedFixture(); const first = await prepareAgentReferenceFolderAdmission(db, f.input);
    if ("stopped" in first) throw new Error("Unexpected stopped fixture");
    expect(first.record).toMatchObject({ revision: 1, paths: [reference], workspaceDirectory }); expect(first.workspaceAccess).toBeDefined();
    await save([entry(secondReference)], 1);
    const recovered = await prepareAgentReferenceFolderAdmission(db, f.input); expect(recovered).toEqual(first);
    expect(await validateAdmittedReferenceFolderAccess(db, f.execution, first.workspaceAccess!)).toEqual(first.workspaceAccess);
  });
  it("does not expose another project's references", async () => {
    await save(); const f = await admittedFixture();
    await db.update(issues).set({ projectId: otherProjectId }).where(eq(issues.id, f.issue.id));
    const result = await prepareAgentReferenceFolderAdmission(db, { ...f.input, projectId: otherProjectId });
    expect(result).toMatchObject({ record: { paths: [] }, prompt: null }); expect(result).not.toHaveProperty("workspaceAccess");
  });
  it("refuses a same-ID workspace-directory change on recovery", async () => {
    await save(); const f = await admittedFixture(); await prepareAgentReferenceFolderAdmission(db, f.input);
    await expect(prepareAgentReferenceFolderAdmission(db, { ...f.input, workspaceDirectory: secondReference })).rejects.toThrow("workspace_changed");
  });
  it("rejects a project move before first admission", async () => {
    await save(); const f = await admittedFixture(); await db.update(issues).set({ projectId: otherProjectId }).where(eq(issues.id, f.issue.id));
    await expect(prepareAgentReferenceFolderAdmission(db, f.input)).rejects.toThrow("issue_project_changed");
  });
  it("rejects a mismatched durable workspace owner before admission", async () => {
    await save(); const f = await admittedFixture(); await db.update(executionWorkspaces).set({ cwd: secondReference }).where(eq(executionWorkspaces.id, f.workspace.id));
    await expect(prepareAgentReferenceFolderAdmission(db, f.input)).rejects.toThrow("workspace_owner_mismatch");
  });
  it("does not admit a stopped or cancelled run", async () => {
    await save(); const f = await admittedFixture(); await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, f.run.id));
    expect(await prepareAgentReferenceFolderAdmission(db, f.input)).toEqual({ stopped: true });
  });
  it("preserves a legacy pre-feature native input without adding a new grant", async () => {
    await save(); const f = await admittedFixture(); await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: f.execution } }).where(eq(heartbeatRuns.id, f.run.id));
    expect(await prepareAgentReferenceFolderAdmission(db, f.input)).toEqual({ record: null, prompt: null });
  });
  it("rejects a recomputed digest with unauthorized extra references at execution", async () => {
    await save(); const f = await admittedFixture(); const result = await prepareAgentReferenceFolderAdmission(db, f.input);
    if ("stopped" in result || !result.workspaceAccess) throw new Error("Missing admitted fixture policy");
    const forged = createWorkspaceAccessSnapshot(result.workspaceAccess.binding, { ...result.workspaceAccess.policy, referenceDirectories: [reference, secondReference] });
    await expect(validateAdmittedReferenceFolderAccess(db, f.execution, forged)).rejects.toThrow("policy_mismatch");
  });
  it("refuses legacy fallback only for the project with configured references", async () => {
    await save(); await expect(assertReferenceFoldersNativeTarget(db, { ...scope(), projectId, native: false })).rejects.toThrow("qualified_native_runner");
    await expect(assertReferenceFoldersNativeTarget(db, { ...scope(), projectId: otherProjectId, native: false })).resolves.toBeUndefined();
    await expect(assertReferenceFoldersNativeTarget(db, { ...scope(), projectId, native: true })).resolves.toBeUndefined();
  });
  it("keeps generic agent configuration separate from dedicated folder authority", async () => {
    await save(); await db.update(agents).set({ adapterConfig: { provider: "opencode", referenceFolders: [] } }).where(eq(agents.id, agent.id));
    const [row] = await db.select().from(agentReferenceFolderConfigs).where(eq(agentReferenceFolderConfigs.agentId, agent.id));
    expect(row.entries).toEqual([entry()]);
  });
  it("an empty admission permits native controller cwd restoration without granting access",async()=>{
    const f=await admittedFixture();const first=await prepareAgentReferenceFolderAdmission(db,f.input);expect(first).toMatchObject({record:{paths:[]},prompt:null});
    const recovered=await prepareAgentReferenceFolderAdmission(db,{...f.input,workspaceDirectory:secondReference});expect(recovered).toEqual(first);expect(recovered).not.toHaveProperty("workspaceAccess");
  });

});


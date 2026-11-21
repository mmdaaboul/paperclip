import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  agentReferenceFolderConfigs, agentReviewerPolicies, agents, companies, createDb,
  executionWorkspaces, heartbeatRuns, issues, projects, type Db,
} from "@paperclipai/db";
import { reviewerNativeTestDatabase } from "../../__tests__/helpers/reviewer-native-database.js";
import { createWorkspaceAccessSnapshot, parseNativeExecutionInput } from "../../vendor/paperclip-runner/index.js";
import { prepareAgentReferenceFolderAdmission } from "../agent-reference-folder-admission.js";
import { nativeControllerGitState, prepareNativeControllerGitAdmission } from "../github-controller-policy.js";
import { ensureNativeCompletionContract } from "./completion-contracts.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";
import { loadAdmittedNativeGitWorkspace } from "./native-attributed-git-admission.js";
import { createNativeControllerGitActions } from "./native-controller-github.js";
import { createNativeAttributedGitScope } from "./native-attributed-git-scope.js";

// Real PostgreSQL, No12 admission, loader, Git policy and Reviewer authority.
// Stop first-start at executable resolution, after admission but before any
// executable, runner, credential, provider or GitHub operation can be reached.
const boundary = vi.hoisted(() => ({
  installation: vi.fn(async () => "isolated-test-installation"),
  executable: vi.fn(async () => { throw new Error("test_native_git_executable_boundary"); }),
}));
vi.mock("./native-controller-installation.js", () => ({ nativeControllerInstallationIdentity: boundary.installation }));
vi.mock("./native-attributed-git-executables.js", () => ({ resolveNativeAttributedGitBinary: boundary.executable }));

let db: Db;
let close: (() => Promise<void>) | undefined;
let root: string;
beforeAll(async () => {
  const supplied = process.env.PAPERCLIP_NATIVE_GIT_ADMISSION_TEST_DATABASE_URL;
  if (supplied !== undefined) {
    const url = new URL(supplied);
    if (!/^postgres(?:ql)?:$/.test(url.protocol)
      || !/^pc_native_git_admission_[a-f0-9]+_test$/.test(url.pathname.slice(1))) {
      throw new Error("native_git_admission_test_database_not_isolated");
    }
    db = createDb(supplied, { maxConnections: 1, applicationName: "native-git-admission-regression" });
    close = () => db.$client.end({ timeout: 5 });
  } else {
    const fixture = await reviewerNativeTestDatabase(1);
    db = fixture.db;
    close = fixture.end;
  }
  root = await realpath(await mkdtemp(join(tmpdir(), "native-git-admission-")));
});
// An externally supplied fixture and all filesystem evidence are retained.
afterAll(async () => { await close?.(); });
beforeEach(() => { vi.clearAllMocks(); });

async function seed(providerType = "git_worktree", references = true) {
  const [company] = await db.insert(companies).values({ name: "Native Git admission fixture", issuePrefix: `GA${randomUUID().slice(0, 7)}` }).returning();
  const [project] = await db.insert(projects).values({ companyId: company.id, name: "Owned workspace" }).returning();
  const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Builder", role: "engineer", status: "active",
    adapterType: "paperclip_runner", adapterConfig: { provider: "codex", homeMode: "isolated", githubWriteMode: "native_controller" } }).returning();
  const [issue] = await db.insert(issues).values({ companyId: company.id, projectId: project.id, title: "Owned native task",
    status: "in_progress", assigneeAgentId: agent.id }).returning();
  const directory = join(root, randomUUID());
  const cwd = join(directory, ".paperclip", "worktrees", "qualification", "agent-acceptance");
  const reference = join(directory, "reference");
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  await mkdir(reference, { mode: 0o700 });
  const repoUrl = "https://github.com/fixture/native-admission";
  const [workspace] = await db.insert(executionWorkspaces).values({ companyId: company.id, projectId: project.id,
    sourceIssueId: issue.id, mode: "isolated", strategyType: "git_worktree", name: "Owned worktree", status: "active",
    providerType, providerRef: cwd, cwd, repoUrl, branchName: "qualification/agent-acceptance" }).returning();
  const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, issueId: issue.id,
    nativeIssueId: issue.id, runtimeMode: "native", status: "running", scopeKind: "issue", contextSnapshot: { issueId: issue.id } }).returning();
  await db.update(issues).set({ executionRunId: run.id }).where(eq(issues.id, issue.id));
  if (references) await db.insert(agentReferenceFolderConfigs).values({ companyId: company.id, agentId: agent.id,
    revision: 1, entries: [{ projectId: project.id, path: reference }], updatedByUserId: "test-owner" });
  const prepared = await prepareAgentReferenceFolderAdmission(db, { agent, runId: run.id, issueId: issue.id,
    projectId: project.id, workspaceId: workspace.id, workspaceDirectory: cwd, executionDriver: "local" });
  if ("stopped" in prepared || !prepared.record) throw new Error("test_reference_admission_missing");
  const binding = { companyId: company.id, agentId: agent.id, runId: run.id, issueId: issue.id, executionWorkspaceId: workspace.id };
  await prepareNativeControllerGitAdmission(db, binding, true);
  const contract = await ensureNativeCompletionContract({ db, companyId: company.id, issue, actorId: agent.id });
  const execution = parseNativeExecutionInput({
    schema: "paperclip.native-execution-input.v5", executionMode: "default", planningContext: null,
    runtimeContext: nativeRuntimeContextFixture(), binding,
    provider: { kind: "codex", model: "fixture-model", approvalPolicy: "never" },
    task: { identifier: "GA-1", title: issue.title, description: null, prompt: "Exercise native admission only.", workMode: "standard" },
    workspace: { cwd, repoUrl, repoRef: null, branchName: workspace.branchName },
    session: { normalizedSessionId: null, driverKind: "codex_app_server", protocolVersion: 1,
      lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
    completionContract: { id: contract.row.id, sha256: contract.row.canonicalSha256,
      schemaVersion: contract.row.schemaVersion, contract: contract.contract },
    interactionResponses: [], credentialBindings: [],
  });
  await db.update(heartbeatRuns).set({ runnerProfileJson: sql`coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb)
    || ${JSON.stringify({ nativeExecutionInput: execution })}::jsonb` }).where(eq(heartbeatRuns.id, run.id));
  const scope = createNativeAttributedGitScope();
  const input = { db, execution, workspaceAccess: prepared.workspaceAccess, targetKind: "local" as const, scope,
    runtimeDirectory: join(directory, "runtime"), protectedPaths: [], filesystemEnvironment: { PAPERCLIP_GIT_METADATA_ROOTS: undefined, PAPERCLIP_RUNNER_NETWORK_ACCESS: undefined, PAPERCLIP_RUNNER_NETWORK_ROOTS: undefined } };
  return { company, project, agent, issue, workspace, run, prepared, execution, input, reference };
}

async function persisted(f: Awaited<ReturnType<typeof seed>>) {
  const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id));
  const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspace.id));
  const [issue] = await db.select().from(issues).where(eq(issues.id, f.issue.id));
  return { run, workspace, issue };
}

describe("persisted native Git workspace admission", () => {
  it.each([
    ["git_worktree", true], ["local_fs", true], ["git_worktree", false], ["local_fs", false],
  ] as const)("admits owned %s with references=%s without rewriting retained state", async (providerType, references) => {
    const f = await seed(providerType, references), before = await persisted(f);
    const admitted = await loadAdmittedNativeGitWorkspace(db, f.execution, f.prepared.workspaceAccess);
    expect(admitted.policy).toMatchObject({ workspaceDirectory: f.workspace.cwd,
      referenceDirectories: references ? [f.reference] : [], readOnlyWorkspace: false });
    expect(admitted.binding).toMatchObject({ companyId: f.company.id, agentId: f.agent.id, runId: f.run.id,
      projectId: f.project.id, workspaceId: f.workspace.id });
    expect(await persisted(f)).toEqual(before);
  });

  it.each(["remote", "adapter_managed", "inactive", "closed", "owner", "project", "current run", "cwd", "repository"])(
    "refuses %s workspace authority drift without modifying saved state", async kind => {
      const f = await seed();
      const workspaceChange = kind === "remote" ? { providerType: "remote" }
        : kind === "adapter_managed" ? { providerType: "adapter_managed" }
          : kind === "inactive" ? { status: "closed" }
            : kind === "closed" ? { closedAt: new Date() }
              : kind === "project" ? { projectId: null }
                : kind === "cwd" ? { cwd: join(root, "different") }
                  : kind === "repository" ? { repoUrl: "https://github.com/fixture/other" } : null;
      if (workspaceChange) await db.update(executionWorkspaces).set(workspaceChange).where(eq(executionWorkspaces.id, f.workspace.id));
      if (kind === "owner") await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, f.issue.id));
      if (kind === "current run") await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, f.issue.id));
      const before = await persisted(f);
      await expect(loadAdmittedNativeGitWorkspace(db, f.execution, f.prepared.workspaceAccess))
        .rejects.toThrow("native_github_workspace_admission_incompatible");
      expect(await persisted(f)).toEqual(before);
    },
  );

  it.each(["reference paths", "readonly", "binding", "missing snapshot"])("retains No12 refusal for %s drift", async kind => {
    const f = await seed(), original = f.prepared.workspaceAccess!;
    const supplied = kind === "missing snapshot" ? undefined : createWorkspaceAccessSnapshot(
      { ...original.binding, ...(kind === "binding" ? { runId: randomUUID() } : {}) },
      { ...original.policy, ...(kind === "reference paths" ? { referenceDirectories: [] } : {}),
        ...(kind === "readonly" ? { readOnlyWorkspace: true, scratchDirectory: join(root, "scratch") } : {}) },
    );
    const before = await persisted(f);
    await expect(loadAdmittedNativeGitWorkspace(db, f.execution, supplied)).rejects.toThrow(
      kind === "missing snapshot" ? "native_github_workspace_admission_incompatible"
        : kind === "binding" ? "Workspace access snapshot binding mismatch" : "reference_folder_execution_policy_mismatch",
    );
    expect(await persisted(f)).toEqual(before);
  });

  it("first-start factory reaches the executable boundary through actual worktree admission", async () => {
    const f = await seed(), before = await persisted(f);
    expect(await nativeControllerGitState(db, f.execution.binding)).toMatchObject({ admitted: true });
    await expect(createNativeControllerGitActions(f.input)).rejects.toThrow("test_native_git_executable_boundary");
    expect(boundary.installation).toHaveBeenCalledTimes(2);
    expect(boundary.executable).toHaveBeenCalledExactlyOnceWith(f.input.runtimeDirectory);
    expect(await persisted(f)).toEqual(before);
    await f.input.scope.retire();
  });

  it.each(["disabled", "Reviewer", "remote target"])("factory keeps %s outside the executable boundary", async kind => {
    const f = await seed();
    if (kind === "disabled") await db.update(agents).set({ adapterConfig: { ...f.agent.adapterConfig, githubWriteMode: "native" } }).where(eq(agents.id, f.agent.id));
    if (kind === "Reviewer") await db.insert(agentReviewerPolicies).values({ companyId: f.company.id, agentId: f.agent.id,
      revision: 1, enabled: true, updatedByUserId: "test-owner" });
    if (kind === "remote target") await expect(createNativeControllerGitActions({ ...f.input, targetKind: "remote" })).rejects.toMatchObject({ status: 403 });
    else expect(await createNativeControllerGitActions(f.input)).toBeUndefined();
    expect(boundary.installation).not.toHaveBeenCalled();
    expect(boundary.executable).not.toHaveBeenCalled();
    await f.input.scope.retire();
  });
});

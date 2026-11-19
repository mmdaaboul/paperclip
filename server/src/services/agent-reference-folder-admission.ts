import { and, eq, sql } from "drizzle-orm";
import { agentReferenceFolderConfigs, executionWorkspaces, heartbeatRuns, issues, type Db, type agents } from "@paperclipai/db";
import { updateAgentReferenceFoldersSchema } from "@paperclipai/shared";
import { z } from "zod";
import { boundRunIssueIdSql } from "./run-task-binding.js";
import { assertReferenceFolderProvider, validateReferenceFolderPath } from "./agent-reference-folder-paths.js";
import { createWorkspaceAccessSnapshot, parseWorkspaceAccessSnapshot, type NativeExecutionInput, type WorkspaceAccessSnapshot } from "../vendor/paperclip-runner/index.js";

const bindingSchema = z.object({
  companyId: z.string().guid(), agentId: z.string().guid(), runId: z.string().guid(),
  projectId: z.string().guid().nullable(), workspaceId: z.string().guid(),
}).strict();
export const referenceFolderAdmissionSchema = z.object({
  schema: z.literal("paperclip.reference-folder-admission.v1"), binding: bindingSchema,
  workspaceDirectory: z.string().min(2).max(4096).refine(value => value.startsWith("/") && !/[\x00-\x1f\x7f]/.test(value)),
  revision: z.number().int().nonnegative(), paths: z.array(z.string().min(2).max(4096)).max(32),
}).strict();
export type ReferenceFolderAdmission = z.infer<typeof referenceFolderAdmissionSchema>;
export type PreparedReferenceFolderAccess = {
  record: ReferenceFolderAdmission | null;
  workspaceAccess?: WorkspaceAccessSnapshot;
  instructionFile?: { path: string; content: string };
  prompt: string | null;
};

const INSTRUCTION_PATH = ".paperclip/reference-folders.json";

/** Freeze at first run admission, not each recovery. No filesystem work or
 * provider effects occur while this short run-row transaction is held.
 */
export async function prepareAgentReferenceFolderAdmission(db: Db, input: {
  agent: typeof agents.$inferSelect; runId: string; issueId: string; projectId: string | null;
  workspaceId: string; workspaceDirectory: string; executionDriver: string;
}): Promise<PreparedReferenceFolderAccess | { stopped: true }> {
  const binding = bindingSchema.parse({ companyId: input.agent.companyId, agentId: input.agent.id, runId: input.runId,
    projectId: input.projectId, workspaceId: input.workspaceId });
  const record = await db.transaction(async tx => {
    const [run] = await tx.select({ id: heartbeatRuns.id, status: heartbeatRuns.status, scopeKind: heartbeatRuns.scopeKind,
      issueId: boundRunIssueIdSql(), cancellation: sql<unknown>`${heartbeatRuns.resultJson}->'startupCancellation'`,
      profileKind: sql<string>`coalesce(jsonb_typeof(${heartbeatRuns.runnerProfileJson}), 'object')`,
      hasAdmission: sql<boolean>`coalesce(${heartbeatRuns.runnerProfileJson} ? 'referenceFolderAdmission', false)`,
      admission: sql<unknown>`${heartbeatRuns.runnerProfileJson}->'referenceFolderAdmission'`,
      hasExecutionInput: sql<boolean>`coalesce(jsonb_typeof(${heartbeatRuns.runnerProfileJson}->'nativeExecutionInput') = 'object', false)` })
      .from(heartbeatRuns).where(and(eq(heartbeatRuns.id, binding.runId),
      eq(heartbeatRuns.companyId, binding.companyId), eq(heartbeatRuns.agentId, binding.agentId))).for("update");
    if (!run) throw new Error("reference_folder_run_binding_missing");
    if (run.status !== "running" || run.cancellation) return "stopped" as const;
    const issueId = run.issueId;
    if (issueId !== input.issueId && !(issueId === null && run.scopeKind === "company")) throw new Error("reference_folder_issue_binding_mismatch");
    if (run.profileKind !== "object") throw new Error("reference_folder_invalid_runner_profile");
    if (run.hasAdmission) {
      const saved = referenceFolderAdmissionSchema.parse(run.admission);
      if (JSON.stringify(saved.binding) !== JSON.stringify(binding)) throw new Error("reference_folder_admission_binding_mismatch");
      // An empty admission grants no filesystem access. Native API providers
      // may legitimately restore their historical binding under another local
      // controller cwd; keep that default-off behavior. Effective grants still
      // require the exact frozen workspace, including during recovery.
      if (saved.paths.length && saved.workspaceDirectory !== input.workspaceDirectory) throw new Error("reference_folder_admission_workspace_changed");
      return saved;
    }
    // An input admitted by an older release retains its original unscoped
    // permissions. Saving a setting must not reinterpret an existing run.
    if (run.hasExecutionInput) return null;
    const [configured] = await tx.select().from(agentReferenceFolderConfigs).where(and(
      eq(agentReferenceFolderConfigs.companyId, binding.companyId), eq(agentReferenceFolderConfigs.agentId, binding.agentId)));
    const entries = updateAgentReferenceFoldersSchema.shape.entries.parse(configured?.entries ?? []);
    const paths = entries.filter(entry => entry.projectId === binding.projectId).map(entry => entry.path).sort();
    if (paths.length) {
      const [issue] = await tx.select({ projectId: issues.projectId }).from(issues)
        .where(and(eq(issues.id, input.issueId), eq(issues.companyId, binding.companyId))).for("share");
      if (!issue || issue.projectId !== binding.projectId) throw new Error("reference_folder_issue_project_changed");
      if (binding.workspaceId !== binding.runId) {
        const [workspace] = await tx.select({ projectId: executionWorkspaces.projectId, cwd: executionWorkspaces.cwd,
          status: executionWorkspaces.status }).from(executionWorkspaces).where(and(eq(executionWorkspaces.id, binding.workspaceId),
          eq(executionWorkspaces.companyId, binding.companyId))).for("share");
        if (!workspace || workspace.status !== "active" || workspace.projectId !== binding.projectId
          || workspace.cwd !== input.workspaceDirectory) throw new Error("reference_folder_workspace_owner_mismatch");
      }
      // Native non-persisted workspace identity is explicitly the owned run ID;
      // its controller-realized path is frozen below before any provider launch.
    }
    const admitted = referenceFolderAdmissionSchema.parse({ schema: "paperclip.reference-folder-admission.v1", binding,
      workspaceDirectory: input.workspaceDirectory, revision: configured?.revision ?? 0, paths });
    await tx.update(heartbeatRuns).set({ runnerProfileJson: sql`coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb) || ${JSON.stringify({ referenceFolderAdmission: admitted })}::jsonb` })
      .where(eq(heartbeatRuns.id, binding.runId));
    return admitted;
  });
  if (record === "stopped") return { stopped: true };
  if (!record || record.paths.length === 0) return { record, prompt: null };
  assertReferenceFolderProvider(input.agent, input.executionDriver);
  const budget = { entries: 10_000 };
  for (const path of record.paths) {
    if (await validateReferenceFolderPath(path, budget) !== path) throw new Error("reference_folder_path_identity_changed");
  }
  if (!binding.projectId) throw new Error("reference_folder_project_binding_missing");
  const workspaceAccess = createWorkspaceAccessSnapshot({ ...binding, projectId: binding.projectId }, {
    workspaceDirectory: record.workspaceDirectory, referenceDirectories: record.paths, readOnlyWorkspace: false,
  });
  // A real server-owned context asset binds effective policy into the native
  // aggregateDigest, so existing warm/backup/recovery fences see grant changes.
  // This asset is context, never authorization; kernel policy is passed separately.
  const content = JSON.stringify({ schema: "paperclip.reference-folders.v1", projectId: binding.projectId, paths: record.paths });
  return { record, workspaceAccess, instructionFile: { path: INSTRUCTION_PATH, content },
    prompt: `## Read-only reference folders\nThese project-scoped folders are available for this run:\n${record.paths.map(path => `- ${JSON.stringify(path)}`).join("\n")}\nTheir contents are read-only. Use permitted writable locations for generated output.` };
}

/** A later generic adapter change cannot silently discard a dedicated grant. */
export async function assertReferenceFoldersNativeTarget(db: Db, input: {
  companyId: string; agentId: string; projectId: string | null; native: boolean;
}): Promise<void> {
  if (input.native || !input.projectId) return;
  const [configured] = await db.select({ entries: agentReferenceFolderConfigs.entries }).from(agentReferenceFolderConfigs)
    .where(and(eq(agentReferenceFolderConfigs.companyId, input.companyId), eq(agentReferenceFolderConfigs.agentId, input.agentId)));
  const entries = updateAgentReferenceFoldersSchema.shape.entries.parse(configured?.entries ?? []);
  if (entries.some(entry => entry.projectId === input.projectId)) throw new Error("reference_folders_require_qualified_native_runner");
}

/** Recheck controller origin at the execution boundary. A recomputed public
 * digest alone is not proof that a grant was authorized or admitted.
 */
export async function validateAdmittedReferenceFolderAccess(db: Db, execution: NativeExecutionInput,
  supplied: WorkspaceAccessSnapshot): Promise<WorkspaceAccessSnapshot> {
  const { companyId, agentId, runId, executionWorkspaceId } = execution.binding;
  const [run] = await db.select({ status: heartbeatRuns.status,
    admission: sql<unknown>`${heartbeatRuns.runnerProfileJson}->'referenceFolderAdmission'` }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId)));
  if (!run || run.status !== "running") throw new Error("reference_folder_execution_run_unavailable");
  const saved = referenceFolderAdmissionSchema.parse(run.admission);
  if (!saved.binding.projectId || saved.binding.companyId !== companyId || saved.binding.agentId !== agentId
    || saved.binding.runId !== runId || saved.binding.workspaceId !== executionWorkspaceId
    || saved.workspaceDirectory !== execution.workspace.cwd) throw new Error("reference_folder_execution_binding_mismatch");
  const snapshot = parseWorkspaceAccessSnapshot(supplied, { companyId, agentId, runId,
    projectId: saved.binding.projectId, workspaceId: executionWorkspaceId });
  if (snapshot.policy.workspaceDirectory !== saved.workspaceDirectory || snapshot.policy.readOnlyWorkspace
    || snapshot.policy.scratchDirectory !== undefined || JSON.stringify(snapshot.policy.referenceDirectories) !== JSON.stringify(saved.paths)) {
    throw new Error("reference_folder_execution_policy_mismatch");
  }
  return snapshot;
}

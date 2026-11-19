import { NativeProviderStateIncompatibleError } from "../../vendor/paperclip-runner/index.js";
import { and, eq, sql } from "drizzle-orm";
import { heartbeatRuns, issues, executionWorkspaces, type Db } from "@paperclipai/db";
import { createWorkspaceAccessSnapshot, type NativeExecutionInput, type WorkspaceAccessSnapshot } from "../../vendor/paperclip-runner/index.js";
import { referenceFolderAdmissionSchema, validateAdmittedReferenceFolderAccess } from "../agent-reference-folder-admission.js";

/** This is a database-owned admission loader, never a caller boolean or env bit.
 * Empty config is supported only with an actual matching persisted admission.
 * Root must call it before constructing the sandbox callback and on each Git
 * command, alongside native current push/credential authorization.
 */
async function readLoadAdmittedNativeGitWorkspace(db: Db, execution: NativeExecutionInput,
  controllerSnapshot?: WorkspaceAccessSnapshot): Promise<WorkspaceAccessSnapshot> {
  const binding = execution.binding;
  if (execution.provider.kind !== "codex" || execution.task.workMode !== "standard"
    || "homeMode" in execution && execution.homeMode === "preconfigured") throw new Error("native_git_execution_context_unsupported");
  const [run] = await db.select({ status: heartbeatRuns.status, runtimeMode: heartbeatRuns.runtimeMode,
    issueId: heartbeatRuns.nativeIssueId, startupCancellation: sql<unknown>`${heartbeatRuns.resultJson}->'startupCancellation'`,
    admission: sql<unknown>`${heartbeatRuns.runnerProfileJson}->'referenceFolderAdmission'` })
    .from(heartbeatRuns).where(and(eq(heartbeatRuns.id, binding.runId), eq(heartbeatRuns.companyId, binding.companyId),
      eq(heartbeatRuns.agentId, binding.agentId)));
  if (!run || run.status !== "running" || run.runtimeMode !== "native" || run.issueId !== binding.issueId || run.startupCancellation) {
    throw new Error("native_git_admission_run_unavailable");
  }
  // Parsing missing/null/unknown-field records fails closed for old/unwired runs.
  const saved = referenceFolderAdmissionSchema.parse(run.admission);
  if (!saved.binding.projectId) throw new Error("native_git_project_admission_required");
  if (!controllerSnapshot && saved.paths.length !== 0) throw new Error("native_git_controller_policy_missing");
  const proposed = controllerSnapshot ?? createWorkspaceAccessSnapshot({
    companyId: binding.companyId, agentId: binding.agentId, runId: binding.runId,
    projectId: saved.binding.projectId, workspaceId: binding.executionWorkspaceId,
  }, { workspaceDirectory: saved.workspaceDirectory, referenceDirectories: [], readOnlyWorkspace: false });
  // Reuse the No12 owner to compare all persisted/supplied identities and policy;
  // a recomputable digest is integrity only and cannot authorize this callback.
  const verified = await validateAdmittedReferenceFolderAccess(db, execution, proposed);
  const [current] = await db.select({ issue: issues, workspace: executionWorkspaces }).from(issues)
    .innerJoin(executionWorkspaces, and(eq(executionWorkspaces.id, binding.executionWorkspaceId),
      eq(executionWorkspaces.companyId, binding.companyId), eq(executionWorkspaces.projectId, saved.binding.projectId)))
    .where(and(eq(issues.id, binding.issueId), eq(issues.companyId, binding.companyId),
      eq(issues.projectId, saved.binding.projectId), eq(issues.assigneeAgentId, binding.agentId), eq(issues.executionRunId, binding.runId)));
  if (!current || current.workspace.providerType !== "local_fs" || current.workspace.status !== "active" || current.workspace.closedAt
    || current.workspace.cwd !== execution.workspace.cwd || current.workspace.repoUrl !== execution.workspace.repoUrl) {
    throw new Error("native_git_current_workspace_authority_unavailable");
  }
  return verified;
}

export async function loadAdmittedNativeGitWorkspace(...args:Parameters<typeof readLoadAdmittedNativeGitWorkspace>){
 try{return await readLoadAdmittedNativeGitWorkspace(...args);}catch(error){
  if(error instanceof Error && (error.message.startsWith("native_git_") || error.name==="ZodError"))throw new NativeProviderStateIncompatibleError("native_github_workspace_admission_incompatible");
  throw error;
 }
}

import { and, eq, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { ZodError } from "zod";
import { HttpError } from "../../errors.js";
import { createWorkspaceAccessSnapshot, NativeProviderStateIncompatibleError, type NativeExecutionInput, type WorkspaceAccessSnapshot } from "../../vendor/paperclip-runner/index.js";
import { referenceFolderAdmissionSchema, validateAdmittedReferenceFolderAccess } from "../agent-reference-folder-admission.js";
import { reviewerExecutionRestrictsCredentials } from "../reviewer-role.js";
import { parseReviewerWorkspaceAdmission } from "./reviewer-workspace-admission.js";
import { validateNativeReviewerExecution } from "./reviewer-runtime-admission.js";
import { nativeSha256 } from "./canonical.js";
import { readClaimedNativeStopRecovery } from "./native-cancellation-request.js";

function incompatible(reason: string): never {
  // Native permanent saved-state classification preserves the old run/session
  // and refuses same-run recovery. No generic retry or weaker policy fallback.
  throw new NativeProviderStateIncompatibleError(`workspace_policy_${reason}`);
}

/** Controller/database origin is authority. Reconstruct the SAME admitted policy
 * on recovery; a caller's recomputed digest, adapter JSON or environment is not
 * a grant. Ordinary old unscoped runs keep their original reference semantics.
 * Select only the small authority fields on the feature-absent hot path.
 */
export async function resolveNativeWorkspacePolicy(db: Db, execution: NativeExecutionInput,
  supplied?: WorkspaceAccessSnapshot): Promise<WorkspaceAccessSnapshot | undefined> {
  try { return await resolveExecutingPolicy(db, execution, supplied); }
  catch (error) {
    if (error instanceof NativeProviderStateIncompatibleError) throw error;
    if (error instanceof ZodError || error instanceof HttpError && [403, 422].includes(error.status)
      || error instanceof Error && /^Workspace access|^Invalid workspace access|^Unknown or missing workspace access|^Unsupported workspace access|^Read-only workspace/.test(error.message)) {
      incompatible("saved_admission_invalid");
    }
    throw error;
  }
}

async function resolveExecutingPolicy(db: Db, execution: NativeExecutionInput,
  supplied?: WorkspaceAccessSnapshot): Promise<WorkspaceAccessSnapshot | undefined> {
  const binding = execution.binding;
  const [stored] = await db.select({
    hasReviewer: sql<boolean>`coalesce(${heartbeatRuns.runnerProfileJson} ? 'reviewerPolicy', false)`,
    hasDiscussion: sql<boolean>`coalesce(${heartbeatRuns.runnerProfileJson} ? 'reviewerGitHubScope', false)`,
    reviewer: sql<unknown>`${heartbeatRuns.runnerProfileJson}->'reviewerPolicy'`,
    reference: sql<unknown>`${heartbeatRuns.runnerProfileJson}->'referenceFolderAdmission'`,
  }).from(heartbeatRuns).where(and(eq(heartbeatRuns.id, binding.runId), eq(heartbeatRuns.companyId, binding.companyId), eq(heartbeatRuns.agentId, binding.agentId)));
  const protectedReviewer = await reviewerExecutionRestrictsCredentials(db, { companyId: binding.companyId, agentId: binding.agentId,
    runnerProfileJson: { ...(stored?.hasReviewer ? { reviewerPolicy: stored.reviewer } : {}), ...(stored?.hasDiscussion ? { reviewerGitHubScope: true } : {}) } });
  let policy: WorkspaceAccessSnapshot | undefined;
  if (protectedReviewer) {
    if (!stored?.hasReviewer) incompatible("reviewer_admission_missing");
    const parsed = parseReviewerWorkspaceAdmission(stored.reviewer);
    policy = parsed.workspaceAccess;
    await validateNativeReviewerExecution(db, execution, policy);
  } else if (stored?.reference != null) {
    const admission = referenceFolderAdmissionSchema.parse(stored.reference);
    if (admission.paths.length) {
      if (!admission.binding.projectId) incompatible("reference_project_missing");
      policy = createWorkspaceAccessSnapshot({ ...admission.binding, projectId: admission.binding.projectId }, {
        workspaceDirectory: admission.workspaceDirectory, referenceDirectories: admission.paths, readOnlyWorkspace: false,
      });
      policy = await validateAdmittedReferenceFolderAccess(db, execution, policy);
    }
  }
  if (supplied && (!policy || nativeSha256(supplied) !== nativeSha256(policy))) incompatible("caller_snapshot_mismatch");
  return policy;
}

/** ONLY native's existing durable Stop claim can use this path. It retains the
 * original restriction, grants no review/PR tools and never authorizes a turn.
 * Revocation or completed assignment must not prevent owned retain-only Stop.
 */
export async function resolveNativeWorkspacePolicyForClaimedStop(db: Db, execution: NativeExecutionInput,
  leaseOwner: string, supplied?: WorkspaceAccessSnapshot): Promise<WorkspaceAccessSnapshot | undefined> {
  const binding = execution.binding;
  const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, binding.runId),
    eq(heartbeatRuns.companyId, binding.companyId), eq(heartbeatRuns.agentId, binding.agentId), eq(heartbeatRuns.nativeIssueId, binding.issueId)));
  if (!run || !await readClaimedNativeStopRecovery(db, run, leaseOwner)) incompatible("native_stop_claim_missing");
  const profile = run.runnerProfileJson ?? {};
  let policy: WorkspaceAccessSnapshot | undefined;
  try {
    if (Object.hasOwn(profile, "reviewerPolicy")) {
      const saved = parseReviewerWorkspaceAdmission(profile.reviewerPolicy);
      if (saved.binding.issueId !== binding.issueId) incompatible("stop_issue_mismatch");
      policy = saved.workspaceAccess;
    } else if (profile.referenceFolderAdmission != null) {
      const saved = referenceFolderAdmissionSchema.parse(profile.referenceFolderAdmission);
      if (saved.paths.length) {
        if (!saved.binding.projectId) incompatible("stop_reference_project_missing");
        policy = createWorkspaceAccessSnapshot({ ...saved.binding, projectId: saved.binding.projectId }, {
          workspaceDirectory: saved.workspaceDirectory, referenceDirectories: saved.paths, readOnlyWorkspace: false,
        });
      }
    }
    if (policy && (policy.binding.companyId !== binding.companyId || policy.binding.agentId !== binding.agentId
      || policy.binding.runId !== binding.runId || policy.binding.workspaceId !== binding.executionWorkspaceId
      || policy.policy.workspaceDirectory !== execution.workspace.cwd
      || nativeSha256(profile.nativeExecutionInput) !== nativeSha256(execution))) incompatible("stop_saved_binding_mismatch");
    if (supplied && (!policy || nativeSha256(supplied) !== nativeSha256(policy))) incompatible("stop_caller_snapshot_mismatch");
  } catch (error) {
    if (error instanceof NativeProviderStateIncompatibleError) throw error;
    incompatible("stop_saved_admission_invalid");
  }
  return policy;
}

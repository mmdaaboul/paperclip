import { createHash } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { agents, agentReviewerPolicies, executionWorkspaces, heartbeatRuns, issues, projects, type Db } from "@paperclipai/db";
import { z } from "zod";
import { agentReviewerScopeSchema } from "@paperclipai/shared";
import { resolvePaperclipInstanceRoot } from "../../home-paths.js";
import { forbidden } from "../../errors.js";
import { authorizationService } from "../authorization.js";
import { referenceFolderAdmissionSchema } from "../agent-reference-folder-admission.js";
import { assertReferenceFolderProvider, referenceFolderProtectedPaths } from "../agent-reference-folder-paths.js";
import { boundRunIssueId } from "../run-task-binding.js";
import { resolveCoreTrustPreset } from "../trust-preset-resolver.js";
import { createWorkspaceAccessSnapshot, parseWorkspaceAccessSnapshot, resolveCodexWorkspaceAccessPolicy, type WorkspaceAccessSnapshot } from "../../vendor/paperclip-runner/index.js";
import { nativeReviewerAssignmentRecordSchema, resolveNativeReviewerAssignment } from "./reviewer-native-assignment.js";

const uuid = z.string().guid();
const bindingSchema = z.object({ companyId: uuid, agentId: uuid, runId: uuid, issueId: uuid, projectId: uuid, workspaceId: uuid }).strict();
const assignmentSchema = nativeReviewerAssignmentRecordSchema;
export const reviewerWorkspaceAdmissionSchema = z.object({
  schema: z.literal("paperclip.reviewer-admission.v1"), binding: bindingSchema, revision: z.number().int().positive(),
  assignment: assignmentSchema, referenceRevision: z.number().int().nonnegative(),
  workspaceAccess: z.unknown(), scratchIdentity: z.object({ device: z.string(), inode: z.string(), owner: z.number().int().nonnegative() }).strict(),
}).strict();
export type ReviewerWorkspaceAdmission = z.infer<typeof reviewerWorkspaceAdmissionSchema> & { workspaceAccess: WorkspaceAccessSnapshot };
export const REVIEWER_CONTEXT_PATH = ".paperclip/reviewer-admission.json";
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const same = (left: unknown, right: unknown) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
export function reviewerAdmissionInstruction(record: ReviewerWorkspaceAdmission) {
  return { path: REVIEWER_CONTEXT_PATH, content: JSON.stringify({ schema: record.schema, binding: record.binding, revision: record.revision,
    assignment: record.assignment, referenceRevision: record.referenceRevision, policyDigest: record.workspaceAccess.digest }) };
}
export function reviewerAdmissionDigest(record: ReviewerWorkspaceAdmission) { return createHash("sha256").update(reviewerAdmissionInstruction(record).content).digest("hex"); }
export const reviewerWorkspaceBinding = (binding: ReviewerWorkspaceAdmission["binding"]) => ({ companyId: binding.companyId, agentId: binding.agentId, runId: binding.runId, projectId: binding.projectId, workspaceId: binding.workspaceId });
export function parseReviewerWorkspaceAdmission(value: unknown): ReviewerWorkspaceAdmission {
  const record = reviewerWorkspaceAdmissionSchema.parse(value);
  const snapshot = parseWorkspaceAccessSnapshot(record.workspaceAccess, reviewerWorkspaceBinding(record.binding));
  if (!snapshot.policy.readOnlyWorkspace || !snapshot.policy.scratchDirectory) throw forbidden("Reviewer admission has no read-only candidate and disjoint scratch");
  return { ...record, workspaceAccess: snapshot };
}

async function scratchFor(binding: z.infer<typeof bindingSchema>) {
  // Instance-owned namespace, never an adapter/env/model-selected output path.
  const instance = await fs.realpath(resolvePaperclipInstanceRoot());
  const parts = ["reviewer-scratch", binding.companyId, binding.agentId, binding.runId];
  let directory = instance;
  for (const part of parts) {
    directory = join(directory, part);
    await fs.mkdir(directory, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || typeof process.getuid !== "function" || stat.uid !== process.getuid()) {
      throw forbidden("Reviewer scratch must remain a private server-owned real directory");
    }
  }
  const handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { const stat = await handle.stat(); return { directory: await fs.realpath(directory), identity: { device: String(stat.dev), inode: String(stat.ino), owner: stat.uid } }; }
  finally { await handle.close(); }
}

/** Each review type brings its actual native owner proof. No agent name,
 * prompt, model hash or legacy/manual stage hint is assignment authority.
 * Root calls this after No12 admission, before the immutable native input/context.
 */
export async function prepareNativeReviewerWorkspaceAdmission(db: Db, input: {
  companyId: string; agentId: string; runId: string; issueId: string; workspaceId: string; workspaceDirectory: string; executionDriver: string;
}) {
  // Same agent lock as operator role changes, even while the role is off.
  // The run already exists; after this lock an enable transaction's active-run
  // check sees it, and an enable already in flight is observed before fallback.
  const { initialRun, initialRole } = await db.transaction(async tx => {
    const [agent] = await tx.select({ id: agents.id }).from(agents).where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId))).for("share");
    if (!agent) throw forbidden("Reviewer agent is unavailable");
    const [initialRun] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, input.agentId)));
    const [initialRole] = await tx.select().from(agentReviewerPolicies).where(and(eq(agentReviewerPolicies.companyId, input.companyId), eq(agentReviewerPolicies.agentId, input.agentId))).for("share");
    return { initialRun, initialRole };
  });
  const retained = object(initialRun?.runnerProfileJson);
  if (!initialRole?.enabled && !Object.hasOwn(retained, "reviewerPolicy")) return null;
  if (!initialRun || !initialRole?.enabled) throw forbidden("Reviewer policy changed; retire this run instead of restoring unrestricted access");
  const [initialIssue] = await db.select().from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)));
  if (!initialIssue?.projectId) throw forbidden("Reviewer admission requires an actual project task");
  const binding = bindingSchema.parse({ companyId: input.companyId, agentId: input.agentId, runId: input.runId, issueId: input.issueId, projectId: initialIssue.projectId, workspaceId: input.workspaceId });
  const scratch = await scratchFor(binding);
  const prepared = await db.transaction(async tx => {
    const [issue] = await tx.select().from(issues).where(and(eq(issues.id, binding.issueId), eq(issues.companyId, binding.companyId))).for("update");
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, binding.runId), eq(heartbeatRuns.companyId, binding.companyId), eq(heartbeatRuns.agentId, binding.agentId))).for("update");
    const [agent] = await tx.select().from(agents).where(and(eq(agents.id, binding.agentId), eq(agents.companyId, binding.companyId))).for("share");
    const [role] = await tx.select().from(agentReviewerPolicies).where(and(eq(agentReviewerPolicies.companyId, binding.companyId), eq(agentReviewerPolicies.agentId, binding.agentId))).for("share");
    const [project] = await tx.select().from(projects).where(and(eq(projects.id, binding.projectId), eq(projects.companyId, binding.companyId)));
    if (!issue || !run || !agent || !project || run.status !== "running" || run.resultJson?.startupCancellation
      || boundRunIssueId(run) !== binding.issueId || issue.projectId !== binding.projectId || issue.executionRunId !== binding.runId
      || !role?.enabled || role.revision !== initialRole.revision || !role.updatedByUserId) throw forbidden("Reviewer run/assignment/policy is no longer current");
    const scopes = role.scopes.map(scope => agentReviewerScopeSchema.parse(scope));
    if (!scopes.some(scope => scope.projectId === binding.projectId)) throw forbidden("This project is outside the operator-owned Reviewer policy");
    assertReferenceFolderProvider(agent, input.executionDriver);
    const trust = resolveCoreTrustPreset({ companyId: binding.companyId, agent, project, issue,
      run: { companyId: run.companyId, executionPolicy: run.contextSnapshot?.executionPolicy } });
    if (trust.kind !== "standard") throw forbidden("Native low-trust/delegated requirements cannot be replaced by the local Reviewer policy");
    const actor = { type: "agent" as const, ...binding, source: "agent_jwt" as const, onBehalfOfUserId: run.responsibleUserId };
    for (const resource of [{ type: "issue" as const, companyId: binding.companyId, issueId: binding.issueId }, { type: "project" as const, companyId: binding.companyId, projectId: binding.projectId }]) {
      const decision = await authorizationService(tx).decide({ actor, action: resource.type === "issue" ? "issue:read" : "project:read", resource });
      if (!decision.allowed) throw forbidden("Reviewer task/project access is no longer authorized");
    }
    if (binding.workspaceId !== binding.runId) {
      const [workspace] = await tx.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.id, binding.workspaceId), eq(executionWorkspaces.companyId, binding.companyId))).for("share");
      if (!workspace || workspace.status !== "active" || workspace.projectId !== binding.projectId || workspace.cwd !== input.workspaceDirectory) throw forbidden("Reviewer candidate must be the actual native-owned task workspace");
    }
    const assignment = await resolveNativeReviewerAssignment(tx as unknown as Db, { ...binding, contextSnapshot: run.contextSnapshot,
      ...(run.nativeIssueId ? { actingRunId: run.id } : {}), issueExecutionRunId: issue.executionRunId });
    if (!assignment) throw forbidden("This run has no actual current native completion, scoped or execution-stage Reviewer assignment");
    if (run.contextSnapshot?.sourceRunId !== undefined && run.contextSnapshot.sourceRunId !== assignment.sourceRun.id) throw forbidden("Reviewer source run context does not match the native review");
    const profile = object(run.runnerProfileJson);
    const reference = referenceFolderAdmissionSchema.parse(profile.referenceFolderAdmission);
    if (reference.binding.companyId !== binding.companyId || reference.binding.agentId !== binding.agentId || reference.binding.runId !== binding.runId
      || reference.binding.projectId !== binding.projectId || reference.binding.workspaceId !== binding.workspaceId || reference.workspaceDirectory !== input.workspaceDirectory) throw forbidden("Prepare the matching native reference admission before Reviewer admission");
    if (Object.hasOwn(profile, "reviewerPolicy")) {
      const previous = parseReviewerWorkspaceAdmission(profile.reviewerPolicy);
      if (!same(previous.binding, binding) || previous.revision !== role.revision || previous.workspaceAccess.policy.workspaceDirectory !== input.workspaceDirectory
        || !same(previous.assignment, assignment.record)
        || !same(previous.scratchIdentity, scratch.identity) || previous.referenceRevision !== reference.revision
        || !same(previous.workspaceAccess.policy.referenceDirectories, reference.paths)) throw forbidden("Reviewer recovery policy changed; a fresh process/run is required");
      return previous;
    }
    if (profile.nativeExecutionInput) throw forbidden("An already-admitted unscoped run cannot acquire Reviewer permissions");
    const record: ReviewerWorkspaceAdmission = { schema: "paperclip.reviewer-admission.v1", binding, revision: role.revision,
      assignment: assignment.record, referenceRevision: reference.revision,
      workspaceAccess: createWorkspaceAccessSnapshot(reviewerWorkspaceBinding(binding), { workspaceDirectory: input.workspaceDirectory, referenceDirectories: reference.paths, readOnlyWorkspace: true, scratchDirectory: scratch.directory }),
      scratchIdentity: scratch.identity };
    await tx.update(heartbeatRuns).set({ runnerProfileJson: sql`coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb) || ${JSON.stringify({ reviewerPolicy: record })}::jsonb` }).where(eq(heartbeatRuns.id, binding.runId));
    return record;
  });
  // Bounded actual filesystem preflight outside locks; it does not claim to
  // prevent later privileged host-tree mutation. Native launch rechecks again.
  resolveCodexWorkspaceAccessPolicy(prepared.workspaceAccess.policy, referenceFolderProtectedPaths());
  return { record: prepared, workspaceAccess: prepared.workspaceAccess, instructionFile: reviewerAdmissionInstruction(prepared),
    tmpdir: scratch.directory, requiresPolicyCompatibleProcess: true as const };
}

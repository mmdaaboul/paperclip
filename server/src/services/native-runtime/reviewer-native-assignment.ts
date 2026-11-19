import type { Db } from "@paperclipai/db";
import { z } from "zod";
import { getNativeReviewAssignment } from "./native-review-participant.js";

const uuid = z.string().guid(), sha = z.string().regex(/^[a-f0-9]{64}$/);
const source = { sourceDecisionId: uuid, sourceRunId: uuid, builderAgentId: uuid };
// Retain known saved shapes for explicit refusal/continuity. F06 must supply
// their actual authority before stage/scoped records can authorize execution.
export const nativeReviewerAssignmentRecordSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("native_completion_review"), interactionId: uuid, ...source }).strict(),
  z.object({ kind: z.literal("scoped_review"), interactionId: uuid, ...source, scopeId: uuid, scopeSnapshotDigest: sha }).strict(),
  z.object({ kind: z.literal("execution_stage_review"), stageId: uuid, admissionId: uuid, ...source,
    statusVersion: z.number().int().nonnegative(), workspaceBindingRevision: z.number().int().nonnegative(), policySha256: sha, executionSha256: sha }).strict(),
]);
export type NativeReviewerAssignmentRecord = z.infer<typeof nativeReviewerAssignmentRecordSchema>;
export function nativeReviewerAssignmentId(record: NativeReviewerAssignmentRecord) {
  return record.kind === "execution_stage_review" ? record.admissionId : record.interactionId;
}

/** Native assignment is the grant; model text, names and digests grant nothing.
 * The current release's completion-review owner already binds the accepted
 * Builder decision/run, assigned Reviewer, acting run and ownership version. */
export async function resolveNativeReviewerAssignment(db: Db, input: {
  companyId: string; issueId: string; agentId: string; contextSnapshot: unknown;
  actingRunId?: string; issueExecutionRunId?: string | null; allowResolvedByRunId?: string;
}) {
  const native = await getNativeReviewAssignment(db, input);
  if (!native) return null;
  const record = nativeReviewerAssignmentRecordSchema.parse({ kind: "native_completion_review",
    interactionId: native.interaction.id, sourceDecisionId: native.sourceDecision.id,
    sourceRunId: native.sourceRun.id, builderAgentId: native.sourceRun.agentId });
  return { record, sourceRun: native.sourceRun, sourceDecision: native.sourceDecision };
}

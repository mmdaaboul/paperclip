import { z } from "zod";

/** Scope selection supplies native identities; the server derives artifact integrity. */
export const createScopedReviewSchema = z.object({
  id: z.string().guid(),
  documentId: z.string().guid(),
  revisionId: z.string().guid(),
  executionWorkspaceId: z.string().guid(),
  expectedStatusVersion: z.number().int().nonnegative(),
  purpose: z.string().trim().min(1).max(2000),
  remainingWork: z.string().trim().min(1).max(12000),
}).strict();

export const scopedReviewSnapshotSchema = createScopedReviewSchema.extend({
  schemaVersion: z.literal(1),
  companyId: z.string().guid(),
  issueId: z.string().guid(),
  builderAgentId: z.string().guid(),
  builderRunId: z.string().guid(),
  reviewerAgentId: z.string().guid(),
  workspaceBindingRevision: z.number().int().nonnegative(),
  executionSha256: z.string().regex(/^[a-f0-9]{64}$/),
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  policySha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export const cancelScopedReviewSchema=z.object({requestId:z.string().guid(),expectedVersion:z.number().int().nonnegative(),reason:z.string().trim().min(1).max(2000)}).strict();
export type ScopedReviewCancellation=z.infer<typeof cancelScopedReviewSchema> & {requestedByUserId:string|null;requestedByAgentId:string|null;requestedAt:string;targetRunIds:string[]};
export type CancelScopedReview=z.infer<typeof cancelScopedReviewSchema>;

export type CreateScopedReview = z.infer<typeof createScopedReviewSchema>;
export type ScopedReviewSnapshot = z.infer<typeof scopedReviewSnapshotSchema>;
export type ScopedReviewState = "draft" | "pending" | "cancelling" | "passed" | "changes_requested" | "held" | "cancelled" | "stale";
export interface ScopedReview {
  id: string;
  companyId: string;
  issueId: string;
  snapshot: ScopedReviewSnapshot;
  state: ScopedReviewState;
  interactionId: string | null;
  sourceDecisionId: string | null;
  verdict: "passed" | "changes_requested" | null;
  verdictRunId: string | null;
  returnWakeupId: string | null;
  returnStatusVersion: number | null;
  cancellation: ScopedReviewCancellation | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ScopedReviewList { reviews:ScopedReview[]; budget:{used:number;allowance:number;remaining:number}|null; }

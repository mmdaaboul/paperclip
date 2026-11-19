import { z } from "zod";

export const reviewCycleSubmissionSchema = z.object({
  id: z.string().guid(),
  companyId: z.string().guid(),
  issueId: z.string().guid(),
  builderAgentId: z.string().guid(),
  builderRunId: z.string().guid(),
  candidateId: z.string().trim().min(1).max(512),
  kind: z.enum(["normal", "scoped"]),
  scopeId: z.string().trim().min(1).max(512).nullable(),
}).strict();

export const reviewCycleAdmissionSchema = reviewCycleSubmissionSchema.extend({
  admittedAt: z.string().datetime(),
});

export const reviewCycleAllowanceRequestSchema = z.object({
  id: z.string().guid(),
  additionalCycles: z.number().int().positive().max(50),
  reason: z.string().trim().min(1).max(2000),
}).strict();

export const reviewCycleAllowanceSchema = reviewCycleAllowanceRequestSchema.extend({
  grantedByUserId: z.string().trim().min(1).max(256),
  grantedAt: z.string().datetime(),
});

/** Kept in its own task-owned row, never inside resettable executionState. */
export const issueReviewCycleBudgetSchema = z.object({
  schemaVersion: z.literal(1),
  companyId: z.string().guid(),
  issueId: z.string().guid(),
  initialAllowance: z.literal(5),
  admissions: z.array(reviewCycleAdmissionSchema),
  allowances: z.array(reviewCycleAllowanceSchema),
}).strict().superRefine((value, ctx) => {
  for (const [key, records] of [["admissions", value.admissions], ["allowances", value.allowances]] as const) {
    if (new Set(records.map(record => record.id)).size !== records.length) ctx.addIssue({ code: "custom", path: [key], message: "Duplicate review budget receipt" });
  }
  if (value.admissions.some(admission => admission.companyId !== value.companyId || admission.issueId !== value.issueId)) {
    ctx.addIssue({ code: "custom", path: ["admissions"], message: "Foreign review budget receipt" });
  }
  const total = 5 + value.allowances.reduce((sum, allowance) => sum + allowance.additionalCycles, 0);
  if (!Number.isSafeInteger(total) || value.admissions.length > total) ctx.addIssue({ code: "custom", message: "Invalid review budget accounting" });
});

export type ReviewCycleSubmission = z.infer<typeof reviewCycleSubmissionSchema>;
export type ReviewCycleAllowanceRequest = z.infer<typeof reviewCycleAllowanceRequestSchema>;
export type IssueReviewCycleBudget = z.infer<typeof issueReviewCycleBudgetSchema>;

export function reviewCycleBudgetAvailable(budget: IssueReviewCycleBudget): number {
  return budget.initialAllowance + budget.allowances.reduce((sum, allowance) => sum + allowance.additionalCycles, 0) - budget.admissions.length;
}

export const nativeStageReviewDecisionSchema=z.object({id:z.string().uuid(),stageId:z.string().uuid(),admissionId:z.string().uuid(),sourceDecisionId:z.string().uuid(),
  expectedStatusVersion:z.number().int().nonnegative(),outcome:z.enum(["approved","changes_requested"]),body:z.string().trim().min(1).max(12000)}).strict();
export type NativeStageReviewDecisionRequest=z.infer<typeof nativeStageReviewDecisionSchema>;


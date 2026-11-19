import { z } from "zod";

export const agentReviewerScopeSchema = z.object({
  projectId: z.string().guid(),
  repositoryId: z.string().regex(/^[1-9][0-9]{0,19}$/),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
}).strict();

export const updateAgentReviewerPolicySchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  enabled: z.boolean(),
  scopes: z.array(agentReviewerScopeSchema).max(32),
}).strict().refine(value => !value.enabled || value.scopes.length > 0, { message: "Select at least one project/repository scope" });

export type AgentReviewerScope = z.infer<typeof agentReviewerScopeSchema>;
export type UpdateAgentReviewerPolicy = z.infer<typeof updateAgentReviewerPolicySchema>;
export interface AgentReviewerPolicyConfiguration {
  revision: number;
  enabled: boolean;
  scopes: AgentReviewerScope[];
  updatedAt: string | null;
}

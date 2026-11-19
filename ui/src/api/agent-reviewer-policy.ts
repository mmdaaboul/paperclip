import type { AgentReviewerPolicyConfiguration, AgentReviewerScope, UpdateAgentReviewerPolicy } from "@paperclipai/shared";
import { api } from "./client";

export interface ReviewerPolicySettings extends AgentReviewerPolicyConfiguration {
  supported?: boolean;
  reason?: string | null;
  activeRunCount: number;
  hiddenScopeCount?: number;
}
export const reviewerPolicyQueryKey = (companyId: string, agentId: string) => ["agent-reviewer-policy", companyId, agentId] as const;
const path = (agentId: string, companyId: string) => `/agents/${encodeURIComponent(agentId)}/reviewer-policy?companyId=${encodeURIComponent(companyId)}`;
export const agentReviewerPolicyApi = {
  get: (agentId: string, companyId: string) => api.get<ReviewerPolicySettings>(path(agentId, companyId)),
  update: (agentId: string, companyId: string, input: UpdateAgentReviewerPolicy) => api.put<AgentReviewerPolicyConfiguration>(path(agentId, companyId), input),
  resolveRepository: (agentId: string, companyId: string, selection: { projectId: string; repository: string }) =>
    api.post<AgentReviewerScope>(`/agents/${encodeURIComponent(agentId)}/reviewer-policy/resolve-repository?companyId=${encodeURIComponent(companyId)}`, selection),
};

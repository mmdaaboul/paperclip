import type { AgentReferenceFolderConfiguration, UpdateAgentReferenceFolders } from "@paperclipai/shared";
import { api } from "./client";

export interface ReferenceFolderAdmission {
  schema: "paperclip.reference-folder-admission.v1";
  binding: { companyId: string; agentId: string; runId: string; projectId: string | null; workspaceId: string };
  revision: number;
  paths: string[];
}

export interface AgentReferenceFolderSettings extends AgentReferenceFolderConfiguration {
  hiddenEntryCount?: number;
  activeRuns: Array<{ runId: string; admission: ReferenceFolderAdmission | null }>;
  /** Absence is unavailable, never an implicit grant on an older server. */
  canGrantHostPaths?: boolean;
  supported?: boolean;
  reason?: string | null;
}

export const referenceFolderQueryKey = (companyId: string, agentId: string) =>
  ["agent-reference-folders", companyId, agentId] as const;

function path(agentId: string, companyId: string) {
  return `/agents/${encodeURIComponent(agentId)}/reference-folders?companyId=${encodeURIComponent(companyId)}`;
}

export const agentReferenceFoldersApi = {
  get: (agentId: string, companyId: string) => api.get<AgentReferenceFolderSettings>(path(agentId, companyId)),
  update: (agentId: string, companyId: string, input: UpdateAgentReferenceFolders) =>
    api.put<AgentReferenceFolderConfiguration>(path(agentId, companyId), input),
};

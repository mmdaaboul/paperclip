import { z } from "zod";

export const agentReferenceFolderSchema = z.object({
  projectId: z.string().guid(),
  path: z.string().min(2).max(4096).refine(value => value.startsWith("/") && !/[\x00-\x1f\x7f]/.test(value), {
    message: "Use an absolute folder path in the execution environment",
  }),
}).strict();

export const updateAgentReferenceFoldersSchema = z.object({
  expectedRevision: z.number().int().min(0),
  entries: z.array(agentReferenceFolderSchema).max(32),
}).strict();

export type AgentReferenceFolder = z.infer<typeof agentReferenceFolderSchema>;
export type UpdateAgentReferenceFolders = z.infer<typeof updateAgentReferenceFoldersSchema>;

export interface AgentReferenceFolderConfiguration {
  revision: number;
  entries: AgentReferenceFolder[];
  updatedAt: string | null;
}

export interface AgentReferenceFolderRunAccess {
  runId: string;
  admission: {
    schema: "paperclip.reference-folder-admission.v1";
    binding: { companyId: string; agentId: string; runId: string; projectId: string | null; workspaceId: string };
    revision: number;
    paths: string[];
  } | null;
}

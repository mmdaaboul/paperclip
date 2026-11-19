import { createHash } from "node:crypto";

export interface WorkspaceAccessPolicy {
  workspaceDirectory: string;
  referenceDirectories: readonly string[];
  readOnlyWorkspace: boolean;
  scratchDirectory?: string;
}

export interface WorkspaceAccessBinding {
  companyId: string;
  agentId: string;
  projectId: string;
  runId: string;
  workspaceId: string;
}

export interface WorkspaceAccessSnapshot {
  schema: "paperclip.workspace-access.v1";
  binding: WorkspaceAccessBinding;
  policy: WorkspaceAccessPolicy;
  digest: string;
}

const bindingKeys = ["companyId", "agentId", "projectId", "runId", "workspaceId"] as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function record(value: unknown, allowed: readonly string[], required: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid workspace access snapshot");
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(result, key))) {
    throw new Error("Unknown or missing workspace access fields");
  }
  return result;
}

function canonicalDirectory(value: unknown): string {
  if (typeof value !== "string" || value.length > 4096 || !value.startsWith("/") || value === "/"
    || /[\x00-\x1f\x7f]/.test(value) || value.slice(1).split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error("Workspace access requires a canonical absolute directory");
  }
  return value;
}

function normalizeBinding(value: unknown): WorkspaceAccessBinding {
  const source = record(value, bindingKeys, bindingKeys);
  const result = {} as WorkspaceAccessBinding;
  for (const key of bindingKeys) {
    if (typeof source[key] !== "string" || !uuid.test(source[key])) throw new Error("Invalid workspace access identity");
    result[key] = source[key];
  }
  return result;
}

function normalizePolicy(value: unknown): WorkspaceAccessPolicy {
  const source = record(value, ["workspaceDirectory", "referenceDirectories", "readOnlyWorkspace", "scratchDirectory"],
    ["workspaceDirectory", "referenceDirectories", "readOnlyWorkspace"]);
  if (!Array.isArray(source.referenceDirectories) || source.referenceDirectories.length > 32 || typeof source.readOnlyWorkspace !== "boolean") {
    throw new Error("Invalid workspace access policy");
  }
  const referenceDirectories = source.referenceDirectories.map(canonicalDirectory).sort();
  if (new Set(referenceDirectories).size !== referenceDirectories.length) throw new Error("Duplicate reference grant");
  const scratchDirectory = source.scratchDirectory === undefined ? undefined : canonicalDirectory(source.scratchDirectory);
  if (source.readOnlyWorkspace && !scratchDirectory) throw new Error("Read-only workspace requires isolated scratch");
  return { workspaceDirectory: canonicalDirectory(source.workspaceDirectory), referenceDirectories,
    readOnlyWorkspace: source.readOnlyWorkspace, ...(scratchDirectory ? { scratchDirectory } : {}) };
}

function digest(binding: WorkspaceAccessBinding, policy: WorkspaceAccessPolicy): string {
  return `sha256:${createHash("sha256").update(JSON.stringify({ schema: "paperclip.workspace-access.v1", binding, policy })).digest("hex")}`;
}

/** Controller/database origin supplies authorization; a digest is integrity, not a grant. */
export function createWorkspaceAccessSnapshot(bindingInput: WorkspaceAccessBinding, policyInput: WorkspaceAccessPolicy): WorkspaceAccessSnapshot {
  const binding = normalizeBinding(bindingInput), policy = normalizePolicy(policyInput);
  Object.freeze(binding); Object.freeze(policy.referenceDirectories); Object.freeze(policy);
  return Object.freeze({ schema: "paperclip.workspace-access.v1", binding, policy, digest: digest(binding, policy) });
}

/** Recovery reuses its original immutable policy and verifies the complete run binding. */
export function parseWorkspaceAccessSnapshot(value: unknown, expected: WorkspaceAccessBinding): WorkspaceAccessSnapshot {
  const source = record(value, ["schema", "binding", "policy", "digest"], ["schema", "binding", "policy", "digest"]);
  if (source.schema !== "paperclip.workspace-access.v1") throw new Error("Unsupported workspace access schema");
  const snapshot = createWorkspaceAccessSnapshot(normalizeBinding(source.binding), normalizePolicy(source.policy));
  const expectedBinding = normalizeBinding(expected);
  if (bindingKeys.some(key => snapshot.binding[key] !== expectedBinding[key])) throw new Error("Workspace access snapshot binding mismatch");
  if (source.digest !== snapshot.digest) throw new Error("Workspace access snapshot digest mismatch");
  return snapshot;
}

/** A policy change needs a fresh provider process; never reuse old permissions. */
export function workspaceAccessSessionCompatible(previous: WorkspaceAccessSnapshot | undefined, next: WorkspaceAccessSnapshot | undefined): boolean {
  if (!previous || !next) return previous === next;
  // Run IDs normally change between turns; compare the effective scoped policy,
  // while keeping company/agent/project/workspace identity authoritative.
  return (["companyId", "agentId", "projectId", "workspaceId"] as const).every(key => previous.binding[key] === next.binding[key])
    && JSON.stringify(previous.policy) === JSON.stringify(next.policy);
}

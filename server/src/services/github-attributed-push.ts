import { createHash, randomUUID } from "node:crypto";

export interface GitPushBinding {
  companyId: string;
  agentId: string;
  runId: string;
  issueId: string;
  projectId: string;
  executionWorkspaceId: string;
  repositoryId: string;
  repositoryFullName: string;
  /** Captured by the controller, never read from the request/body/commit author. */
  nameAtTime: string;
}

export interface GitPushRequest {
  idempotencyKey: string;
  ref: string;
  expectedOldOid: string | null;
  newOid: string;
}

export type GitPushState = "pending" | "confirmed" | "no_change" | "failed" | "uncertain";
export type GitPushAuthorizationStage = "admission" | "preflight" | "write";
export interface GitPushReceipt {
  id: string;
  binding: GitPushBinding;
  request: GitPushRequest;
  fingerprint: string;
  state: GitPushState;
  reason: string | null;
  confirmationSource: "git_receive_pack_status" | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface GitPushReceiptStore {
  begin(receipt: GitPushReceipt): Promise<{ created: boolean; receipt: GitPushReceipt }>;
  finish(id: string, fingerprint: string, result: Pick<GitPushReceipt, "state" | "reason" | "confirmationSource" | "finishedAt">): Promise<GitPushReceipt>;
}

export interface GitPushTransport {
  verifyCandidate(oid: string): Promise<boolean>;
  readRemoteRef(ref: string): Promise<string | null>;
  isAncestor(oldOid: string, newOid: string): Promise<boolean>;
  /** The trusted adapter must obtain this result from its own Git process. */
  push(request: GitPushRequest): Promise<
    | { kind: "accepted"; ref: string; oid: string }
    | { kind: "no_change" }
    | { kind: "rejected" }
    | { kind: "unknown" }
  >;
}

export class GitPushAttributionError extends Error {
  constructor(public readonly code: string, public readonly status: number) { super(code); }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const oid = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

function validateBinding(input: GitPushBinding): GitPushBinding {
  for (const key of ["companyId", "agentId", "runId", "issueId", "projectId", "executionWorkspaceId"] as const) {
    if (!uuid.test(input[key])) throw new GitPushAttributionError("push_binding_invalid", 422);
  }
  if (!/^[1-9][0-9]*$/.test(input.repositoryId) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repositoryFullName)
    || !input.nameAtTime.trim() || /[\x00-\x1f\x7f]/.test(input.nameAtTime) || input.nameAtTime.length > 128) {
    throw new GitPushAttributionError("push_binding_invalid", 422);
  }
  return Object.freeze({ companyId: input.companyId, agentId: input.agentId, runId: input.runId, issueId: input.issueId,
    projectId: input.projectId, executionWorkspaceId: input.executionWorkspaceId, repositoryId: input.repositoryId,
    repositoryFullName: input.repositoryFullName, nameAtTime: input.nameAtTime });
}

export function parseGitPushRequest(value: unknown): GitPushRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GitPushAttributionError("push_request_invalid", 422);
  const record = value as Record<string, unknown>;
  const keys = ["idempotencyKey", "ref", "expectedOldOid", "newOid"];
  if (Object.keys(record).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(record, key))) throw new GitPushAttributionError("push_request_invalid", 422);
  if (typeof record.idempotencyKey !== "string" || !uuid.test(record.idempotencyKey) || typeof record.newOid !== "string"
    || !oid.test(record.newOid) || /^0+$/.test(record.newOid) || record.expectedOldOid !== null
    && (typeof record.expectedOldOid !== "string" || !oid.test(record.expectedOldOid) || /^0+$/.test(record.expectedOldOid)
      || record.expectedOldOid.length !== record.newOid.length)) throw new GitPushAttributionError("push_request_invalid", 422);
  if (typeof record.ref !== "string" || !record.ref.startsWith("refs/heads/") || record.ref.length > 1024
    || /[\x00-\x20\x7f~^:?*\[\\]/.test(record.ref) || record.ref.includes("..") || record.ref.includes("@{")
    || record.ref.split("/").some(part => !part || part.startsWith(".") || part.endsWith(".lock"))
    || record.ref.endsWith(".")) throw new GitPushAttributionError("push_ref_unsupported", 422);
  return Object.freeze({ idempotencyKey: record.idempotencyKey, ref: record.ref, expectedOldOid: record.expectedOldOid as string | null, newOid: record.newOid });
}

function requestFingerprint(binding: GitPushBinding, request: GitPushRequest): string {
  // Display name is historical presentation, not part of an operation's identity.
  const { nameAtTime: _name, ...scope } = binding;
  return createHash("sha256").update(JSON.stringify({ kind: "git_push", scope, request })).digest("hex");
}

/** Closed server-executed operation. A model-provided completion is never evidence.
 * This does not claim coverage for raw git/gh/SSH paths not routed through it.
 */
export async function executeAttributedGitPush(input: {
  binding: GitPushBinding;
  request: unknown;
  store: GitPushReceiptStore;
  authorizeCurrent: (binding: GitPushBinding, stage: GitPushAuthorizationStage) => Promise<boolean>;
  createTransport: (binding: GitPushBinding) => Promise<GitPushTransport>;
}): Promise<GitPushReceipt> {
  const binding = validateBinding(input.binding), request = parseGitPushRequest(input.request);
  if (!await input.authorizeCurrent(binding, "admission")) throw new GitPushAttributionError("push_not_authorized", 403);
  const fingerprint = requestFingerprint(binding, request);
  const staged = await input.store.begin({ id: randomUUID(), binding, request, fingerprint, state: "pending", reason: null,
    confirmationSource: null, createdAt: new Date().toISOString(), finishedAt: null });
  if (staged.receipt.fingerprint !== fingerprint) throw new GitPushAttributionError("push_idempotency_conflict", 409);
  // Pending/uncertain operations are never automatically replayed after a crash.
  if (!staged.created) return staged.receipt;
  const finish = (state: GitPushState, reason: string | null = null) => input.store.finish(staged.receipt.id, fingerprint, {
    state, reason, confirmationSource: state === "confirmed" ? "git_receive_pack_status" : null, finishedAt: new Date().toISOString(),
  });
  let writeAttempted = false;
  try {
    if (!await input.authorizeCurrent(binding, "preflight")) return await finish("failed", "authorization_revoked_before_write");
    const transport = await input.createTransport(binding);
    if (!await transport.verifyCandidate(request.newOid)) return await finish("failed", "candidate_not_available");
    const remote = await transport.readRemoteRef(request.ref);
    if (remote === request.newOid) return await finish("no_change", "already_at_target");
    if (remote !== request.expectedOldOid) return await finish("failed", "remote_ref_changed");
    if (remote && !await transport.isAncestor(remote, request.newOid)) return await finish("failed", "non_fast_forward_unsupported");
    if (!await input.authorizeCurrent(binding, "write")) return await finish("failed", "authorization_revoked_before_write");
    writeAttempted = true;
    const result = await transport.push(request);
    if (result.kind === "accepted" && result.ref === request.ref && result.oid === request.newOid) return await finish("confirmed");
    if (result.kind === "no_change") return await finish("no_change", "already_at_target");
    if (result.kind === "rejected") return await finish("failed", "remote_rejected");
    return await finish("uncertain", "push_result_unconfirmed");
  } catch {
    // No stderr/provider/token payload is persisted. Keep successful effects
    // uncertain if their acknowledgement or durable receipt cannot be proven.
    return await finish(writeAttempted ? "uncertain" : "failed", writeAttempted ? "push_result_unconfirmed" : "push_preflight_unavailable");
  }
}

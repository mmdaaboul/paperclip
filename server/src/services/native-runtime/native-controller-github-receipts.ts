import { createHash } from "node:crypto";
import { activityLog, type Db } from "@paperclipai/db";
import { forbidden } from "../../errors.js";
import { ghFetch } from "../github-fetch.js";
import { publishActivity, redactActivityDetails } from "../activity-log.js";
import type { GitPushReceipt } from "../github-attributed-push.js";

export const ATTRIBUTED_GIT_PUSH_TOOL = {
  name: "push_git_commit",
  description: "Push one exact local commit to the assigned GitHub repository branch and record the actual Paperclip pusher/run. Use the exact expected current remote SHA, or null only when creating a new branch. Only fast-forward single-branch pushes are supported; this does not rewrite commits, push tags, delete branches or authorize force. Repository-local URL/HTTP/credential/protocol or executable steering requires operator engineering and is refused. An uncertain/pending receipt must be reconciled, never retried with a new key. Raw git/gh/SSH push paths do not produce this confirmed receipt.",
  inputSchema: { type: "object", additionalProperties: false,
    properties: { idempotencyKey: { type: "string", format: "uuid" }, ref: { type: "string", pattern: "^refs/heads/" },
      expectedOldOid: { type: ["string", "null"] }, newOid: { type: "string", pattern: "^[0-9a-f]{40}([0-9a-f]{24})?$" } },
    required: ["idempotencyKey", "ref", "expectedOldOid", "newOid"] },
};

/** Normalize only the immutable native workspace's repository; no tool URL input. */
export function nativePushRepository(url: string): { fullName: string; httpsUrl: string } {
  const scp = /^git@github\.com:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(url);
  let name = scp?.[1];
  if (!name) {
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw forbidden("The admitted repository URL is unsupported for recorded push"); }
    const allowed = parsed.protocol === "https:" && !parsed.username || parsed.protocol === "ssh:" && parsed.username === "git";
    if (!allowed || parsed.hostname !== "github.com" || parsed.password || parsed.port || parsed.hash || parsed.search) throw forbidden("The admitted repository URL is unsupported for recorded push");
    name = parsed.pathname.replace(/^\//, "").replace(/\.git$/, "");
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(name) || name.split("/").some(part => part === "." || part === "..")) {
    throw forbidden("The admitted repository identity is unavailable");
  }
  return { fullName: name, httpsUrl: `https://github.com/${name}.git` };
}

export async function repositoryIdentity(fullName: string, token: string): Promise<{ id: string; fullName: string }> {
  const response = await ghFetch(`https://api.github.com/repos/${fullName}`, { method: "GET", redirect: "error", signal: AbortSignal.timeout(10_000),
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" } });
  if (!response.ok || !response.body) throw forbidden("The selected GitHub identity cannot access the assigned repository");
  const reader = response.body.getReader(); let bytes = 0; const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength; if (bytes > 64 * 1024) throw new Error("GitHub repository metadata exceeds bound"); chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!Number.isSafeInteger(value.id) || value.id < 1 || typeof value.full_name !== "string"
    || value.full_name.toLowerCase() !== fullName.toLowerCase() || value.permissions?.push === false) throw forbidden("The selected GitHub repository identity changed or cannot push");
  return { id: String(value.id), fullName: value.full_name };
}

function receiptActivityId(receipt: GitPushReceipt): string {
  const bytes = createHash("sha256").update(`github.push:${receipt.id}:${receipt.state}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 0x50; bytes[8] = (bytes[8] & 63) | 0x80;
  const hex = bytes.toString("hex"); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function publishReceipt(db: Db, receipt: GitPushReceipt, responsibleUserId: string | null) {
  const details = await redactActivityDetails(db, { receiptId: receipt.id, state: receipt.state, reason: receipt.reason,
    repositoryId: receipt.binding.repositoryId, repositoryFullName: receipt.binding.repositoryFullName,
    ref: receipt.request.ref, commitSha: receipt.request.newOid, pusherAgentId: receipt.binding.agentId,
    pusherRunId: receipt.binding.runId, nameAtTime: receipt.binding.nameAtTime, confirmationSource: receipt.confirmationSource });
  const inserted = await db.insert(activityLog).values({ id: receiptActivityId(receipt), companyId: receipt.binding.companyId,
    actorType: "agent", actorId: receipt.binding.agentId, agentId: receipt.binding.agentId, runId: receipt.binding.runId,
    responsibleUserId, action: "github.push_recorded", entityType: "issue", entityId: receipt.binding.issueId, details })
    .onConflictDoNothing().returning({ id: activityLog.id });
  if (inserted.length) publishActivity({ companyId: receipt.binding.companyId,
    payload: { issueId: receipt.binding.issueId, actorType: "agent", actorId: receipt.binding.agentId, agentId: receipt.binding.agentId,
      runId: receipt.binding.runId, responsibleUserId, action: "github.push_recorded", entityType: "issue", entityId: receipt.binding.issueId, details }, pluginEvent: null });
}


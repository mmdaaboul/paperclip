import { createHash } from "node:crypto";
import { badRequest, conflict, forbidden } from "../errors.js";
import { githubBotRequest } from "./chat-github-client.js";
import type { ReviewerGitHubOperation, ReviewerGitHubReceipt, ReviewerGitHubStore } from "./reviewer-github-store.js";

export interface ReviewerGitHubBinding {
  companyId: string;
  agentId: string;
  runId: string;
  issueId: string;
  projectId: string;
}

/** Returned only by the trusted current native assignment/configuration owner.
 * No route accepts this record from model arguments. The action service checks
 * it again before writing; filesystem/credential qualification is not inferred
 * from an agent's name or from a broad GitHub grant. */
export interface ReviewerGitHubAuthorization {
  binding: ReviewerGitHubBinding;
  agentName: string;
  role: { enabled: boolean; configuredBy: "board"; revision: string; projectIds: string[]; repositoryIds: string[] };
  assignment: { id: string; current: boolean; reviewerAgentId: string; builderAgentId: string;
    kind: "native_completion_review" | "scoped_review" | "execution_stage_review" };
  runtime: { filesystemQualified: boolean; rawCredentialExportDenied: boolean; hostCredentialFallbackDenied: boolean; trustKind: "standard" | "low_trust_review" | "denied" };
  repositoryId: string;
  repository: string;
  pullNumber: number;
  headSha: string;
}

export interface ReviewerFixVerification {
  id: string;
  binding: ReviewerGitHubBinding;
  findingOperationId: string;
  checkedHeadSha: string;
  artifactDigest: string;
  decision: "fixed";
}

export type ReviewerGitHubAction =
  | { action: "comment"; body: string; idempotencyKey: string; finding?: { key: string; path: string; line: number; side: "LEFT" | "RIGHT" } }
  | { action: "reply"; body: string; commentId: string; idempotencyKey: string }
  | { action: "resolve_own_finding"; findingOperationId: string; verificationEvidenceId: string; idempotencyKey: string };

type Pull = { number: number; node_id: string; html_url: string; head: { sha: string }; base: { repo: { id: number; full_name: string } } };
type Comment = { id: number; html_url: string; pull_request_url?: string; in_reply_to_id?: number; commit_id?: string };
type Thread = { id: string; isResolved: boolean; viewerCanResolve: boolean;
  pullRequest: { number: number; headRefOid: string; repository: { databaseId: number; nameWithOwner: string } };
  comments: { nodes: Array<{ databaseId: number }> } };

const ids = ["companyId", "agentId", "runId", "issueId", "projectId"] as const;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const sha = /^[a-f0-9]{40}$/;
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw badRequest("Invalid Reviewer action");
  return value as Record<string, unknown>;
};
const positiveId = (value: unknown): value is string => typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value);
const providerId = (value: unknown): string => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw conflict("Invalid provider identity");
  return String(value);
};
const keys = (value: Record<string, unknown>, allowed: string[]) => {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw badRequest("Unsupported Reviewer action field");
};
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max && !value.includes("\0");

export function parseReviewerGitHubAction(value: unknown): ReviewerGitHubAction {
  const source = record(value);
  if (!text(source.idempotencyKey, 200) || /[\x00-\x1f\x7f]/.test(source.idempotencyKey)) throw badRequest("An idempotency key is required");
  if (source.action === "comment") {
    keys(source, ["action", "body", "idempotencyKey", "finding"]);
    if (!text(source.body, 10_000)) throw badRequest("Comment body is required and bounded");
    let finding: Extract<ReviewerGitHubAction, { action: "comment" }>["finding"];
    if (source.finding !== undefined) {
      const f = record(source.finding); keys(f, ["key", "path", "line", "side"]);
      if (!text(f.key, 200) || !text(f.path, 1024) || f.path.startsWith("/") || /[\x00-\x1f\x7f\\]/.test(f.path)
        || f.path.split("/").some(part => !part || part === "." || part === "..")
        || !Number.isSafeInteger(f.line) || Number(f.line) < 1 || !["LEFT", "RIGHT"].includes(String(f.side))) throw badRequest("Invalid inline finding");
      finding = { key: f.key, path: f.path, line: Number(f.line), side: f.side as "LEFT" | "RIGHT" };
    }
    return { action: "comment", body: source.body, idempotencyKey: source.idempotencyKey, ...(finding ? { finding } : {}) };
  }
  if (source.action === "reply") {
    keys(source, ["action", "body", "idempotencyKey", "commentId"]);
    if (!text(source.body, 10_000) || !positiveId(source.commentId)) throw badRequest("Invalid PR reply");
    return { action: "reply", body: source.body, commentId: source.commentId, idempotencyKey: source.idempotencyKey };
  }
  if (source.action === "resolve_own_finding") {
    keys(source, ["action", "idempotencyKey", "findingOperationId", "verificationEvidenceId"]);
    if (typeof source.findingOperationId !== "string" || !uuid.test(source.findingOperationId)
      || typeof source.verificationEvidenceId !== "string" || !uuid.test(source.verificationEvidenceId)) throw badRequest("Finding and verification receipts are required");
    return { action: source.action, findingOperationId: source.findingOperationId, verificationEvidenceId: source.verificationEvidenceId, idempotencyKey: source.idempotencyKey };
  }
  throw forbidden("This Reviewer role cannot perform that GitHub operation");
}

function validateAuthorization(binding: ReviewerGitHubBinding, scope: ReviewerGitHubAuthorization) {
  if (ids.some(key => !uuid.test(binding[key]) || scope.binding[key] !== binding[key])) throw forbidden("Reviewer run binding mismatch");
  if (!scope.role.enabled || scope.role.configuredBy !== "board" || !scope.role.revision
    || !scope.role.projectIds.includes(binding.projectId) || !scope.role.repositoryIds.includes(scope.repositoryId)) throw forbidden("Reviewer scope was not authorized by its configurator");
  if (!scope.assignment.current || !uuid.test(scope.assignment.id) || scope.assignment.reviewerAgentId !== binding.agentId
    || !uuid.test(scope.assignment.builderAgentId) || scope.assignment.builderAgentId === binding.agentId
    || !["native_completion_review", "scoped_review", "execution_stage_review"].includes(scope.assignment.kind)) throw forbidden("A current distinct Reviewer assignment is required");
  if (!scope.runtime.filesystemQualified || !scope.runtime.rawCredentialExportDenied || !scope.runtime.hostCredentialFallbackDenied
    || scope.runtime.trustKind !== "standard") throw forbidden("This Reviewer runtime is not qualified for PR discussion");
  if (!positiveId(scope.repositoryId) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(scope.repository)
    || !Number.isSafeInteger(scope.pullNumber) || scope.pullNumber < 1 || !sha.test(scope.headSha)) throw forbidden("Incomplete bound PR candidate");
}

function scopeKey(scope: ReviewerGitHubAuthorization): string {
  return JSON.stringify([ids.map(key => scope.binding[key]), scope.role.revision, scope.assignment.id, scope.assignment.kind, scope.repositoryId, scope.repository.toLowerCase(), scope.pullNumber, scope.headSha]);
}

function outcome(operation: ReviewerGitHubOperation) {
  return { operationId: operation.id, status: operation.status, ...(operation.status === "confirmed" ? { receipt: operation.receipt } : {}),
    ...(operation.error_code ? { code: operation.error_code } : {}) };
}

function signature(scope: ReviewerGitHubAuthorization, nameAtTime: string) {
  const name = nameAtTime.replace(/[\x00-\x1f\x7f]/g, " ").replace(/[\\`*_{}[\]()<>]/g, character => `\\${character}`).slice(0, 120);
  return `Paperclip agent: ${name}\nAgent: \`${scope.binding.agentId}\` · Task: \`${scope.binding.issueId}\` · Run: \`${scope.binding.runId}\``;
}

const THREADS = `query ReviewerFindingThreads($pull:ID!,$after:String){node(id:$pull){... on PullRequest{reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{id isResolved viewerCanResolve pullRequest{number headRefOid repository{databaseId nameWithOwner}} comments(first:1){nodes{databaseId}}}}}}}`;
const RESOLVE = `mutation ReviewerResolveOwnFinding($thread:ID!){resolveReviewThread(input:{threadId:$thread}){thread{id isResolved pullRequest{number headRefOid repository{databaseId nameWithOwner}}}}}`;

export function createReviewerGitHubActions(options: {
  store: ReviewerGitHubStore;
  authorize: (binding: ReviewerGitHubBinding) => Promise<ReviewerGitHubAuthorization>;
  /** Existing selected native identity, privately resolved on the controller. */
  resolvePrivateToken: (scope: ReviewerGitHubAuthorization) => Promise<string>;
  loadVerifiedFix: (binding: ReviewerGitHubBinding, evidenceId: string) => Promise<ReviewerFixVerification | null>;
  fetchImpl?: typeof fetch;
}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    async read(binding: ReviewerGitHubBinding, argumentsValue: unknown) {
      const input = record(argumentsValue); keys(input, ["section", "page"]);
      if (!["metadata", "comments", "inline_comments", "own_findings"].includes(String(input.section))
        || (input.page !== undefined && (!Number.isSafeInteger(input.page) || Number(input.page) < 1 || Number(input.page) > 100))) throw badRequest("Invalid assigned-PR read request");
      const page = Number(input.page ?? 1);
      const scope = await options.authorize(binding); validateAuthorization(binding, scope);
      const identity = scopeKey(scope);
      let items: unknown;
      if (input.section === "own_findings") {
        items = (await options.store.listOwnFindings({ ...binding, repositoryId: scope.repositoryId, pullNumber: scope.pullNumber, offset: (page - 1) * 50 })).map(row => row.receipt);
      } else {
        const token = await options.resolvePrivateToken(scope);
        if (!token) throw forbidden("Selected GitHub identity is unavailable");
        const prefix = `/repos/${scope.repository.split("/").map(encodeURIComponent).join("/")}`;
        const pull = await githubBotRequest<Pull>(fetchImpl, token, `${prefix}/pulls/${scope.pullNumber}`);
        if (pull.number !== scope.pullNumber || providerId(pull.base.repo.id) !== scope.repositoryId || pull.base.repo.full_name.toLowerCase() !== scope.repository.toLowerCase()
          || pull.head.sha !== scope.headSha) throw conflict("Current PR differs from the admitted candidate");
        items = input.section === "metadata" ? pull : await githubBotRequest(fetchImpl, token, input.section === "comments"
          ? `${prefix}/issues/${scope.pullNumber}/comments?per_page=50&page=${page}` : `${prefix}/pulls/${scope.pullNumber}/comments?per_page=50&page=${page}`);
      }
      const current = await options.authorize(binding); validateAuthorization(binding, current);
      if (scopeKey(current) !== identity) throw forbidden("Reviewer scope changed during read");
      return { untrusted: true, source: input.section === "own_findings" ? "confirmed_receipts" : "provider", section: input.section, page, items,
        hasMore: Array.isArray(items) && items.length === 50, admittedHeadSha: scope.headSha };
    },
    async execute(binding: ReviewerGitHubBinding, argumentsValue: unknown) {
      const action = parseReviewerGitHubAction(argumentsValue);
      const scope = await options.authorize(binding); validateAuthorization(binding, scope);
      const scopeIdentity = scopeKey(scope);
      const assertCurrent = async () => {
        const current = await options.authorize(binding); validateAuthorization(binding, current);
        if (scopeKey(current) !== scopeIdentity) throw forbidden("Reviewer assignment or candidate changed");
      };
      const requestHash = createHash("sha256").update(JSON.stringify({ scope: scopeIdentity, action })).digest("hex");
      const staged = await options.store.stage({ company_id: binding.companyId, agent_id: binding.agentId, run_id: binding.runId,
        issue_id: binding.issueId, project_id: binding.projectId, repository_id: scope.repositoryId, repository: scope.repository,
        pull_number: scope.pullNumber, head_sha: scope.headSha, action: action.action, idempotency_key: action.idempotencyKey,
        request_hash: requestHash, agent_name: scope.agentName, request_payload: action as unknown as Record<string, unknown> });
      if (staged.request_hash !== requestHash) throw conflict("Idempotency key belongs to different Reviewer content or scope");
      if (staged.status !== "pending") return outcome(staged); // Never blindly repeat an uncertain write.
      let attempted = false;
      let claimToken: string | null = null;
      try {
        const token = await options.resolvePrivateToken(scope);
        if (!token) throw forbidden("Selected GitHub identity is unavailable");
        const request = <T>(path: string, settings?: { method?: string; body?: unknown }) => githubBotRequest<T>(fetchImpl, token, path, settings);
        const prefix = `/repos/${scope.repository.split("/").map(encodeURIComponent).join("/")}`;
        const pullPath = `${prefix}/pulls/${scope.pullNumber}`;
        const pull = async () => {
          const value = await request<Pull>(pullPath);
          if (value.number !== scope.pullNumber || providerId(value.base.repo.id) !== scope.repositoryId
            || value.base.repo.full_name.toLowerCase() !== scope.repository.toLowerCase() || value.head.sha !== scope.headSha
            || typeof value.node_id !== "string" || !value.node_id || value.node_id.length > 200) throw conflict("Current PR head or repository differs from the admitted candidate");
          return value;
        };
        const currentPull = await pull();
        let thread: Thread | undefined;
        if (action.action === "reply") {
          const parent = await request<Comment>(`${prefix}/pulls/comments/${action.commentId}`);
          if (providerId(parent.id) !== action.commentId || parent.pull_request_url !== `https://api.github.com${pullPath}`) throw forbidden("Reply is outside the assigned PR");
        }
        if (action.action === "resolve_own_finding") {
          const original = await options.store.get(action.findingOperationId, binding.companyId);
          if (!original || original.status !== "confirmed" || !original.receipt?.findingKey || !original.receipt.commentId
            || original.agent_id !== binding.agentId || original.issue_id !== binding.issueId || original.project_id !== binding.projectId
            || original.repository_id !== scope.repositoryId || original.repository.toLowerCase() !== scope.repository.toLowerCase()
            || original.pull_number !== scope.pullNumber) throw forbidden("Only this Paperclip agent's confirmed finding may be resolved");
          const evidence = await options.loadVerifiedFix(binding, action.verificationEvidenceId);
          if (!evidence || evidence.id !== action.verificationEvidenceId || evidence.decision !== "fixed"
            || ids.some(key => evidence.binding[key] !== binding[key]) || evidence.findingOperationId !== original.id
            || evidence.checkedHeadSha !== scope.headSha || !/^[a-f0-9]{64}$/.test(evidence.artifactDigest)) throw forbidden("Corresponding fix has not been verified for this exact candidate");
          let cursor: string | null = null;
          for (let page = 0; page < 20; page++) {
            const response: { data?: { node?: { reviewThreads?: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Thread[] } } }; errors?: unknown } =
              await request("/graphql", { method: "POST", body: { query: THREADS, variables: { pull: currentPull.node_id, after: cursor } } });
            const list = response.data?.node?.reviewThreads;
            if (response.errors || !list || !Array.isArray(list.nodes)) throw conflict("Finding thread lookup failed");
            const matches = list.nodes.filter(value => value.comments.nodes.some(comment => providerId(comment.databaseId) === original.receipt!.commentId));
            if (matches.length > 1 || (matches.length && thread)) throw conflict("Finding thread identity is ambiguous");
            if (matches[0]) thread = matches[0];
            if (!list.pageInfo.hasNextPage) break;
            if (!list.pageInfo.endCursor || page === 19) throw conflict("Finding thread lookup is incomplete");
            cursor = list.pageInfo.endCursor;
          }
          if (!thread || !thread.viewerCanResolve || thread.pullRequest.number !== scope.pullNumber
            || providerId(thread.pullRequest.repository.databaseId) !== scope.repositoryId
            || thread.pullRequest.repository.nameWithOwner.toLowerCase() !== scope.repository.toLowerCase()
            || thread.pullRequest.headRefOid !== scope.headSha) throw forbidden("Finding thread is outside the exact authorized candidate");
          if (thread.isResolved) throw conflict("Finding was already resolved outside this operation; inspect its existing receipt");
        }
        await assertCurrent(); await pull();
        const claimed = await options.store.claim(staged.id, binding.companyId);
        if (!claimed) return outcome((await options.store.get(staged.id, binding.companyId))!);
        claimToken = claimed.claim_token;
        await assertCurrent();
        const receipt: ReviewerGitHubReceipt = { operationId: staged.id, action: action.action, ...binding, agentNameAtTime: staged.agent_name,
          repositoryId: scope.repositoryId, repository: scope.repository, pullNumber: scope.pullNumber, headSha: scope.headSha, url: currentPull.html_url };
        attempted = true;
        if (action.action === "resolve_own_finding") {
          const response = await request<{ data?: { resolveReviewThread?: { thread: Omit<Thread, "comments" | "viewerCanResolve"> } }; errors?: unknown }>("/graphql", {
            method: "POST", body: { query: RESOLVE, variables: { thread: thread!.id } },
          });
          const resolved = response.data?.resolveReviewThread?.thread;
          if (response.errors || !resolved || resolved.id !== thread!.id || !resolved.isResolved || resolved.pullRequest.number !== scope.pullNumber
            || resolved.pullRequest.headRefOid !== scope.headSha || providerId(resolved.pullRequest.repository.databaseId) !== scope.repositoryId
            || resolved.pullRequest.repository.nameWithOwner.toLowerCase() !== scope.repository.toLowerCase()) throw conflict("Provider resolution identity could not be confirmed");
          receipt.threadId = resolved.id; receipt.verificationEvidenceId = action.verificationEvidenceId;
        } else {
          const body = `${action.body}\n\n---\n${signature(scope, staged.agent_name)}`;
          const posted = action.action === "reply"
            ? await request<Comment>(`${pullPath}/comments/${action.commentId}/replies`, { method: "POST", body: { body } })
            : action.finding
              ? await request<Comment>(`${pullPath}/comments`, { method: "POST", body: { body, commit_id: scope.headSha, path: action.finding.path, line: action.finding.line, side: action.finding.side } })
              : await request<Comment>(`${prefix}/issues/${scope.pullNumber}/comments`, { method: "POST", body: { body } });
          receipt.commentId = providerId(posted.id); receipt.url = posted.html_url;
          const url = new URL(posted.html_url);
          if (url.origin !== "https://github.com" || url.pathname !== `/${scope.repository}/pull/${scope.pullNumber}`
            || url.username || url.password || url.search) throw conflict("Provider comment target could not be confirmed");
          if (action.action === "reply" && providerId(posted.in_reply_to_id) !== action.commentId) throw conflict("Provider reply parent could not be confirmed");
          if (action.action === "comment" && action.finding) {
            if (posted.commit_id !== scope.headSha || posted.pull_request_url !== `https://api.github.com${pullPath}`) throw conflict("Provider finding candidate could not be confirmed");
            receipt.findingKey = action.finding.key;
          }
        }
        await pull(); // GraphQL resolution has no expected-head CAS: surface a race.
        const confirmed = await options.store.settle(staged.id, binding.companyId, "confirmed", receipt, null, claimToken);
        if (!confirmed) throw conflict("Reviewer receipt settlement was lost");
        return outcome(confirmed);
      } catch {
        // Provider and secret errors may contain credentials. Persist only a
        // fixed category; never claim that an uncertain mutation did not occur.
        const result = await options.store.settle(staged.id, binding.companyId, attempted ? "uncertain" : "rejected", null,
          attempted ? "github_write_outcome_uncertain" : "reviewer_preflight_rejected", claimToken);
        const retained = result ?? await options.store.get(staged.id, binding.companyId);
        if (!retained) throw conflict("Reviewer operation requires receipt reconciliation");
        return outcome(retained);
      }
    },
  };
}

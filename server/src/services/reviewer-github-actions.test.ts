import { createNativeReviewerGitHubStore } from "./reviewer-github-native-store.js";
import { reviewerNativeTestDatabase } from "../__tests__/helpers/reviewer-native-database.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { createReviewerGitHubActions, parseReviewerGitHubAction, type ReviewerFixVerification, type ReviewerGitHubAuthorization, type ReviewerGitHubBinding } from "./reviewer-github-actions.js";
import { reviewerGitHubReceiptSchema, type ReviewerGitHubStore } from "./reviewer-github-store.js";
import { createReviewerGitHubToolAdapter } from "./native-runtime/reviewer-github-tools.js";

const A = "a".repeat(40), B = "b".repeat(40), TOKEN = "fixture-private-token-not-a-credential";
const schema = `reviewer_actions_${process.pid}`;
const pool = await reviewerNativeTestDatabase();
const db = pool.db;
let store: ReviewerGitHubStore;
let server: Server;
let origin: string;
let authorization: ReviewerGitHubAuthorization;
let binding: ReviewerGitHubBinding;
let proof: ReviewerFixVerification | null;
let authorizations = 0, tokens = 0, writes = 0, nextComment = 1000, currentHead = A;
let comments: Array<{ id: number; html_url: string; body: string; pull_request_url?: string; commit_id?: string; in_reply_to_id?: number }>;
let resolvedThreads: Set<string>;
let mode: "normal" | "disconnect" | "wrong_identity" | "head_race";
let revokeAt = 0;
let mutationGate: Promise<void> | undefined, releaseMutation: (() => void) | undefined, mutationStarted: (() => void) | undefined;
let wrongThreadRepo = false;

function json(response: import("node:http").ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value));
}

beforeAll(async () => {
  await pool.query(`CREATE SCHEMA "${schema}"`);
  await pool.query(reviewerGitHubReceiptSchema(schema));
  store = createNativeReviewerGitHubStore(db, schema);
  server = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${TOKEN}`) return json(response, { error: "fixture authentication missing" }, 403);
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    const path = request.url!;
    const pull = { number: 7, node_id: "PR_fixture_7", html_url: "https://github.com/review-fixture/example/pull/7", head: { sha: currentHead }, base: { repo: { id: 99, full_name: "review-fixture/example" } } };
    if (request.method === "GET" && path === "/repos/review-fixture/example/pulls/7") return json(response, pull);
    if (request.method === "GET" && /^\/repos\/review-fixture\/example\/(issues|pulls)\/7\/comments\?per_page=50&page=\d+$/.test(path)) return json(response, comments);
    if (request.method === "GET" && /^\/repos\/review-fixture\/example\/pulls\/comments\/\d+$/.test(path)) {
      const comment = comments.find(item => String(item.id) === path.split("/").at(-1));
      return json(response, comment ?? {}, comment ? 200 : 404);
    }
    if (path === "/graphql" && body.query?.startsWith("query ReviewerFindingThreads")) {
      const nodes = comments.filter(comment => comment.commit_id).map(comment => ({ id: `PRRT_${comment.id}`, isResolved: resolvedThreads.has(`PRRT_${comment.id}`), viewerCanResolve: true,
        pullRequest: { number: 7, headRefOid: currentHead, repository: { databaseId: wrongThreadRepo ? 123 : 99, nameWithOwner: "review-fixture/example" } }, comments: { nodes: [{ databaseId: comment.id }] } }));
      return json(response, { data: { node: { reviewThreads: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } } });
    }
    if (request.method === "POST") {
      const restAllowed = path === "/repos/review-fixture/example/issues/7/comments" || path === "/repos/review-fixture/example/pulls/7/comments"
        || /^\/repos\/review-fixture\/example\/pulls\/7\/comments\/\d+\/replies$/.test(path);
      const resolveAllowed = path === "/graphql" && body.query?.startsWith("mutation ReviewerResolveOwnFinding");
      if (!restAllowed && !resolveAllowed) return json(response, { error: "unexpected fixture operation" }, 404);
      writes++; mutationStarted?.(); if (mutationGate) await mutationGate;
      if (resolveAllowed) {
        resolvedThreads.add(body.variables.thread);
        if (mode === "disconnect") { request.socket.destroy(); return; }
        if (mode === "head_race") currentHead = B;
        return json(response, { data: { resolveReviewThread: { thread: { id: body.variables.thread, isResolved: true,
          pullRequest: { number: 7, headRefOid: currentHead, repository: { databaseId: 99, nameWithOwner: "review-fixture/example" } } } } } });
      }
      const item = { id: nextComment++, html_url: `https://github.com/review-fixture/example/pull/7#discussion_${nextComment}`, body: body.body,
        ...(body.commit_id ? { commit_id: body.commit_id, pull_request_url: "https://api.github.com/repos/review-fixture/example/pulls/7" } : {}),
        ...(path.endsWith("/replies") ? { in_reply_to_id: Number(path.split("/").at(-2)), pull_request_url: "https://api.github.com/repos/review-fixture/example/pulls/7" } : {}) };
      comments.push(item);
      if (mode === "disconnect") { request.socket.destroy(); return; }
      if (mode === "head_race") currentHead = B;
      return json(response, mode === "wrong_identity" ? { ...item, html_url: "https://github.com/foreign/project/pull/8#issuecomment_1" } : item, 201);
    }
    return json(response, { error: "unexpected fixture request" }, 404);
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  origin = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
});
afterAll(async () => {
  // Native fixture cleanup drops only this newly owned disposable test database.
  server?.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await pool.end();
});
beforeEach(() => {
  binding = { companyId: randomUUID(), agentId: randomUUID(), runId: randomUUID(), issueId: randomUUID(), projectId: randomUUID() };
  authorization = { binding: { ...binding }, agentName: "Generic Reviewer", role: { enabled: true, configuredBy: "board", revision: "fixture-owner-selection-1", projectIds: [binding.projectId], repositoryIds: ["99"] },
    assignment: { id: randomUUID(), current: true, reviewerAgentId: binding.agentId, builderAgentId: randomUUID(), kind: "native_completion_review" },
    runtime: { filesystemQualified: true, rawCredentialExportDenied: true, hostCredentialFallbackDenied: true, trustKind: "standard" },
    repositoryId: "99", repository: "review-fixture/example", pullNumber: 7, headSha: A };
  proof = null; authorizations = 0; tokens = 0; writes = 0; nextComment = 1000; currentHead = A; comments = []; resolvedThreads = new Set(); mode = "normal";
  revokeAt = 0; mutationGate = undefined; releaseMutation = undefined; mutationStarted = undefined; wrongThreadRepo = false;
});

function service(alternateStore = store) {
  return createReviewerGitHubActions({ store: alternateStore,
    authorize: async () => { authorizations++; const value = structuredClone(authorization); if (revokeAt && authorizations >= revokeAt) value.role.enabled = false; return value; },
    resolvePrivateToken: async () => { tokens++; return TOKEN; }, loadVerifiedFix: async () => proof,
    fetchImpl: (async (url: string | URL | Request, settings?: RequestInit) => {
      const target = new URL(String(url)); expect(target.origin).toBe("https://api.github.com"); expect(settings?.redirect).toBe("error");
      return fetch(`${origin}${target.pathname}${target.search}`, settings);
    }) as typeof fetch,
  });
}
const comment = (key = "comment-1", body = "Review discussion") => ({ action: "comment", body, idempotencyKey: key });
async function ownFinding() {
  const result = await service().execute(binding, { ...comment("finding-1", "Please fix this finding"), finding: { key: "finding-key", path: "src/example.ts", line: 4, side: "RIGHT" } });
  expect(result.status).toBe("confirmed"); return result;
}
function verify(findingOperationId: string) {
  const id = randomUUID(); proof = { id, binding: { ...binding }, findingOperationId, checkedHeadSha: authorization.headSha, artifactDigest: "c".repeat(64), decision: "fixed" }; return id;
}

describe("closed Reviewer discussion service; real PostgreSQL18 and local HTTP, trusted authorizer port", () => {
  it("the native adapter exposes only closed bound-PR capabilities", async () => {
    const adapter = createReviewerGitHubToolAdapter(binding, service());
    expect(adapter.definitions().map(item => item.name)).toEqual(["reviewer_pr_read", "reviewer_pr_comment", "reviewer_pr_reply", "reviewer_resolve_own_finding"]);
    expect(adapter.has("push_git_commit")).toBe(false); expect(adapter.has("toString")).toBe(false);
    const result = await adapter.execute({ tool: "reviewer_pr_comment", arguments: { body: "Native adapter discussion", idempotencyKey: "adapter-comment" } });
    expect(result).toMatchObject({ status: "confirmed" }); expect(writes).toBe(1);
  });
  it("the adapter cannot switch action or namespace to gain another capability", () => {
    const adapter = createReviewerGitHubToolAdapter(binding, service());
    expect(() => adapter.execute({ tool: "reviewer_pr_comment", arguments: { action: "merge", body: "x", idempotencyKey: "x" } })).toThrow();
    expect(() => adapter.execute({ tool: "toString", arguments: {} })).toThrow(); expect(tokens).toBe(0);
    const visible = adapter.definitions(); visible[0].name = "mutated"; expect(adapter.has("mutated")).toBe(false); expect(adapter.definitions()[0].name).toBe("reviewer_pr_read");
  });
  it("reads only the admitted PR and marks provider content untrusted", async () => {
    const value = await service().read(binding, { section: "metadata" });
    expect(value).toMatchObject({ untrusted: true, source: "provider", admittedHeadSha: A, items: { number: 7 } }); expect(writes).toBe(0);
  });
  it("reads general and inline comments through fixed assigned-PR routes", async () => {
    await ownFinding();
    for (const section of ["comments", "inline_comments"]) {
      const value = await service().read(binding, { section, page: 1 }); expect(value.items).toHaveLength(1); expect(value.untrusted).toBe(true);
    }
  });
  it("returns only this agent's confirmed finding receipts, not a shared-account peer's", async () => {
    await ownFinding();
    expect((await service().read(binding, { section: "own_findings" })).items).toHaveLength(1);
    binding.agentId = randomUUID(); binding.runId = randomUUID(); authorization.binding = { ...binding }; authorization.assignment.reviewerAgentId = binding.agentId;
    expect((await service().read(binding, { section: "own_findings" })).items).toEqual([]);
  });
  it("refuses scope overrides and unbounded read pagination", async () => {
    await expect(service().read(binding, { section: "comments", repository: "foreign/target" })).rejects.toMatchObject({ status: 400 });
    await expect(service().read(binding, { section: "comments", page: 101 })).rejects.toMatchObject({ status: 400 }); expect(tokens).toBe(0);
  });
  it("publishes and persists only a confirmed assigned-PR comment with visible immutable attribution", async () => {
    const result = await service().execute(binding, comment());
    expect(result.status).toBe("confirmed"); expect(writes).toBe(1);
    expect(result.receipt).toMatchObject({ ...binding, agentNameAtTime: "Generic Reviewer", repositoryId: "99", pullNumber: 7, headSha: A, commentId: "1000" });
    expect(comments[0].body).toContain(`Agent: \`${binding.agentId}\``); expect(comments[0].body).toContain(`Run: \`${binding.runId}\``);
    const events = await pool.query(`SELECT event FROM "${schema}".reviewer_github_events WHERE operation_id=$1 ORDER BY id`, [result.operationId]);
    expect(events.rows.map(row => row.event)).toEqual(["staged", "write_reserved", "confirmed"]);
  });
  it.each(["native_completion_review", "scoped_review", "execution_stage_review"] as const)("uses the same selected Reviewer for %s", async kind => {
    authorization.assignment.kind = kind;
    const result = await service().execute(binding, comment()); expect(result.status).toBe("confirmed"); expect(result.receipt?.agentId).toBe(binding.agentId);
  });
  it("posts an inline finding on its exact admitted commit", async () => {
    const result = await ownFinding(); expect(result.receipt?.findingKey).toBe("finding-key"); expect(comments[0].commit_id).toBe(A);
  });
  it("replies only after checking the parent comment belongs to the assigned PR", async () => {
    await ownFinding(); const result = await service().execute(binding, { action: "reply", commentId: "1000", body: "Verified additional context", idempotencyKey: "reply-1" });
    expect(result.status).toBe("confirmed"); expect(result.receipt?.commentId).toBe("1001"); expect(comments[1].in_reply_to_id).toBe(1000);
  });
  it("rejects another PR's parent without publishing", async () => {
    comments.push({ id: 4000, html_url: "https://github.com/review-fixture/example/pull/8#discussion_4000", body: "foreign", pull_request_url: "https://api.github.com/repos/review-fixture/example/pulls/8" });
    const result = await service().execute(binding, { action: "reply", commentId: "4000", body: "Reply", idempotencyKey: "foreign-parent" });
    expect(result.status).toBe("rejected"); expect(writes).toBe(0);
  });
  it("resolves its own confirmed finding after corresponding current-head verification", async () => {
    const original = await ownFinding(); currentHead = B; authorization.headSha = B; binding.runId = randomUUID(); authorization.binding = { ...binding }; authorization.assignment.id = randomUUID();
    const result = await service().execute(binding, { action: "resolve_own_finding", findingOperationId: original.operationId, verificationEvidenceId: verify(original.operationId), idempotencyKey: "resolve-1" });
    expect(result.status).toBe("confirmed"); expect(result.receipt?.threadId).toBe("PRRT_1000"); expect(resolvedThreads.has("PRRT_1000")).toBe(true);
  });
  it("refuses another Paperclip agent's finding despite a shared GitHub account", async () => {
    const original = await ownFinding(); binding.agentId = randomUUID(); binding.runId = randomUUID(); authorization.binding = { ...binding }; authorization.assignment.reviewerAgentId = binding.agentId;
    const result = await service().execute(binding, { action: "resolve_own_finding", findingOperationId: original.operationId, verificationEvidenceId: verify(original.operationId), idempotencyKey: "foreign-owner" });
    expect(result.status).toBe("rejected"); expect(writes).toBe(1); expect(resolvedThreads.size).toBe(0);
  });
  it("preserves original attribution across an agent rename and idempotent replay", async () => {
    const first = await service().execute(binding, comment()); authorization.agentName = "Renamed Reviewer";
    const again = await service().execute(binding, comment()); expect(again.receipt?.agentNameAtTime).toBe("Generic Reviewer"); expect(again.operationId).toBe(first.operationId); expect(writes).toBe(1);
  });
  it.each(["role", "assignment", "same-builder", "filesystem", "raw-token", "host-fallback", "low-trust", "repository", "project"])("denies invalid %s before acquiring credentials", async kind => {
    if (kind === "role") authorization.role.enabled = false;
    if (kind === "assignment") authorization.assignment.current = false;
    if (kind === "same-builder") authorization.assignment.builderAgentId = binding.agentId;
    if (kind === "filesystem") authorization.runtime.filesystemQualified = false;
    if (kind === "raw-token") authorization.runtime.rawCredentialExportDenied = false;
    if (kind === "host-fallback") authorization.runtime.hostCredentialFallbackDenied = false;
    if (kind === "low-trust") authorization.runtime.trustKind = "low_trust_review";
    if (kind === "repository") authorization.role.repositoryIds = [];
    if (kind === "project") authorization.role.projectIds = [];
    await expect(service().execute(binding, comment())).rejects.toMatchObject({ status: 403 }); expect(tokens).toBe(0); expect(writes).toBe(0);
  });
  it.each(["companyId", "agentId", "runId", "issueId", "projectId"] as const)("denies substituted %s", async key => {
    await expect(service().execute({ ...binding, [key]: randomUUID() }, comment())).rejects.toMatchObject({ status: 403 }); expect(tokens).toBe(0);
  });
  it.each(["push", "merge", "approve", "request_changes", "admin", "graphql"])("has no %s operation", async action => {
    await expect(service().execute(binding, { action, idempotencyKey: "forbidden", body: "x" })).rejects.toMatchObject({ status: 403 }); expect(tokens).toBe(0);
  });
  it("does not accept caller-selected scope, token or GraphQL fields", () => {
    for (const extra of [{ repository: "foreign/project" }, { token: TOKEN }, { query: "mutation { mergePullRequest }" }]) {
      expect(() => parseReviewerGitHubAction({ ...comment(), ...extra })).toThrow("Unsupported");
    }
  });
  it("refuses a stale provider head before publication", async () => {
    currentHead = B; const result = await service().execute(binding, comment()); expect(result.status).toBe("rejected"); expect(writes).toBe(0);
  });
  it("rechecks revocation immediately before writing", async () => {
    revokeAt = 3; const result = await service().execute(binding, comment()); expect(result.status).toBe("rejected"); expect(writes).toBe(0);
  });
  it("serializes identical concurrent requests through the durable claim", async () => {
    const started = new Promise<void>(done => { mutationStarted = done; }); mutationGate = new Promise(done => { releaseMutation = done; });
    const first = service().execute(binding, comment()); await started;
    const second = await service().execute(binding, comment()); expect(second.status).toBe("writing"); releaseMutation!();
    const final = await first; expect(final.status).toBe("confirmed"); expect(writes).toBe(1);
    const rows = await pool.query(`SELECT count(*) FROM "${schema}".reviewer_github_operations WHERE company_id=$1`, [binding.companyId]); expect(rows.rows[0].count).toBe("1");
  });
  it("rejects idempotency reuse with different content", async () => {
    await service().execute(binding, comment()); await expect(service().execute(binding, comment("comment-1", "Different content"))).rejects.toMatchObject({ status: 409 }); expect(writes).toBe(1);
  });
  it("a new service/store instance recovers the PostgreSQL-confirmed receipt without reposting", async () => {
    const first = await service().execute(binding, comment()); const nextStore = createNativeReviewerGitHubStore(db, schema);
    const next = await service(nextStore).execute(binding, comment()); expect(next).toEqual(first); expect(writes).toBe(1);
  });
  it("retains uncertain timeout-after-write and never silently repeats it", async () => {
    mode = "disconnect"; const first = await service().execute(binding, comment()); expect(first.status).toBe("uncertain"); expect(first.receipt).toBeUndefined(); expect(comments).toHaveLength(1);
    mode = "normal"; const replay = await service().execute(binding, comment()); expect(replay.status).toBe("uncertain"); expect(writes).toBe(1);
  });
  it("does not confirm an unexpected provider comment target", async () => {
    mode = "wrong_identity"; const result = await service().execute(binding, comment()); expect(result.status).toBe("uncertain"); expect(result.receipt).toBeUndefined();
  });
  it("surfaces a head race after a write instead of declaring exact-candidate success", async () => {
    mode = "head_race"; const result = await service().execute(binding, comment()); expect(result.status).toBe("uncertain"); expect(writes).toBe(1);
  });
  it("requires corresponding verified-fix evidence for the exact current run/head", async () => {
    const original = await ownFinding(); verify(original.operationId); proof!.checkedHeadSha = B;
    const result = await service().execute(binding, { action: "resolve_own_finding", findingOperationId: original.operationId, verificationEvidenceId: proof!.id, idempotencyKey: "bad-proof" });
    expect(result.status).toBe("rejected"); expect(resolvedThreads.size).toBe(0);
  });
  it("validates provider thread repository rather than trusting only its ID", async () => {
    const original = await ownFinding(); wrongThreadRepo = true;
    const result = await service().execute(binding, { action: "resolve_own_finding", findingOperationId: original.operationId, verificationEvidenceId: verify(original.operationId), idempotencyKey: "foreign-thread" });
    expect(result.status).toBe("rejected"); expect(resolvedThreads.size).toBe(0);
  });
  it("guards receipt settlement against a foreign claimant and preserves confirmed rows", async () => {
    const result = await service().execute(binding, comment());
    expect(await store.get(result.operationId, randomUUID())).toBeNull();
    expect(await store.settle(result.operationId, binding.companyId, "uncertain", null, "wrong", randomUUID())).toBeNull();
    expect((await store.get(result.operationId, binding.companyId))!.status).toBe("confirmed");
  });
  it("never persists the private token in operations, receipts or audit events", async () => {
    await service().execute(binding, comment()); const rows = await pool.query<{ body: string }>(`SELECT row_to_json(o)::text AS body FROM "${schema}".reviewer_github_operations o`);
    expect(rows.rows.every(row => !row.body.includes(TOKEN))).toBe(true);
  });
});

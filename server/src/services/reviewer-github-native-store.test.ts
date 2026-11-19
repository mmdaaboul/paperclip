import { reviewerNativeTestDatabase } from "../__tests__/helpers/reviewer-native-database.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createNativeReviewerGitHubStore } from "./reviewer-github-native-store.js";
import { reviewerGitHubReceiptSchema, type ReviewerGitHubOperationInput, type ReviewerGitHubReceipt } from "./reviewer-github-store.js";

const schema = `reviewer_native_store_${process.pid}`;
const primary = await reviewerNativeTestDatabase(1), secondary = await reviewerNativeTestDatabase(1);
const db = primary.db;
const client = db.$client;
const store = createNativeReviewerGitHubStore(db, schema);
beforeAll(async () => { await client.unsafe(`CREATE SCHEMA "${schema}"`); await client.unsafe(reviewerGitHubReceiptSchema(schema)); });
afterAll(async () => { await Promise.all([primary.end(), secondary.end()]); }); // The native helper removes only this newly owned disposable database.

function operation(): ReviewerGitHubOperationInput {
  return { company_id: randomUUID(), agent_id: randomUUID(), run_id: randomUUID(), issue_id: randomUUID(), project_id: randomUUID(), repository_id: "99",
    repository: "review-fixture/example", pull_number: 7, head_sha: "a".repeat(40), action: "comment", idempotency_key: "native-driver-key", request_hash: "b".repeat(64),
    agent_name: "Generic Reviewer", request_payload: { action: "comment", body: "Native postgres-js parameterized fixture", nested: { retained: true } } };
}

describe("native postgres-js receipt adapter with real PostgreSQL18", () => {
  it("retains native JSON types and idempotent rows across driver instances", async () => {
    const input = operation(); const first = await store.stage(input);
    const other = createNativeReviewerGitHubStore(secondary.db, schema); const same = await other.stage(input);
    expect(same.id).toBe(first.id); expect(same.request_payload).toEqual(input.request_payload);
  });
  it("only one native concurrent claimant owns the write", async () => {
    const input = operation(), row = await store.stage(input);
    const results = await Promise.all([store.claim(row.id, input.company_id), createNativeReviewerGitHubStore(secondary.db, schema).claim(row.id, input.company_id)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await store.settle(row.id, input.company_id, "rejected", null, "foreign_claim", randomUUID())).toBeNull();
  });
  it("persists confirmed native receipts and refuses later mutation", async () => {
    const input = operation(), row = await store.stage(input), claimed = await store.claim(row.id, input.company_id);
    const receipt: ReviewerGitHubReceipt = { operationId: row.id, action: "comment", companyId: input.company_id, agentId: input.agent_id,
      agentNameAtTime: input.agent_name, runId: input.run_id, issueId: input.issue_id, projectId: input.project_id,
      repositoryId: input.repository_id, repository: input.repository, pullNumber: input.pull_number, headSha: input.head_sha,
      commentId: "1000", url: "https://github.com/review-fixture/example/pull/7#discussion_1000", findingKey: "native-finding" };
    const saved = await store.settle(row.id, input.company_id, "confirmed", receipt, null, claimed!.claim_token);
    expect(saved?.receipt).toEqual(receipt);
    expect(await store.settle(row.id, input.company_id, "uncertain", null, "rewrite", claimed!.claim_token)).toBeNull();
    expect((await store.listOwnFindings({ companyId: input.company_id, agentId: input.agent_id, issueId: input.issue_id, projectId: input.project_id,
      repositoryId: input.repository_id, pullNumber: input.pull_number, offset: 0 })).map(value => value.id)).toEqual([row.id]);
  });
  it("treats SQL-shaped argument text as data", async () => {
    const input = operation(); input.idempotency_key = "'); DROP TABLE reviewer_github_operations; --";
    const row = await store.stage(input); expect(row.idempotency_key).toBe(input.idempotency_key);
    expect((await store.get(row.id, input.company_id))?.request_payload).toEqual(input.request_payload);
  });
  it("the database refuses confirmation without a complete bound provider receipt", async () => {
    const input = operation(), row = await store.stage(input), claimed = await store.claim(row.id, input.company_id);
    await expect(store.settle(row.id, input.company_id, "confirmed", null, null, claimed!.claim_token)).rejects.toMatchObject({ code: "23514" });
    expect((await store.get(row.id, input.company_id))!.status).toBe("writing");
  });
});

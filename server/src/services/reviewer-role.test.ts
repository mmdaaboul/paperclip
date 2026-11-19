import { reviewerNativeTestDatabase } from "../__tests__/helpers/reviewer-native-database.js";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { assertNoReviewerGenericGateway, reviewerExecutionRestrictsCredentials } from "./reviewer-role.js";

const native = vi.hoisted(() => ({ run: {} as Record<string, unknown>, context: {} as Record<string, unknown>, secretCalls: 0, credentialCalls: 0, trustKind: "low_trust_review" }));
vi.mock("./run-identity.js", () => ({ captureRunIdentity: async () => ({ run: native.run, context: native.context }) }));
vi.mock("./git-credentials.js", () => ({ buildGitAuthInvocation: () => { throw new Error("Unexpected raw credential export"); },
  resolveManagedGitHubCredential: async () => { native.credentialCalls++; throw new Error("Unexpected native credential access"); } }));
vi.mock("./secrets.js", () => ({ secretService: () => { native.secretCalls++; throw new Error("Unexpected secret-store access"); } }));
vi.mock("./trust-preset-resolver.js", () => ({ resolveCoreTrustPreset: () => ({ kind: native.trustKind }) }));
vi.mock("./source-trust.js", () => ({ isLowTrustQuarantined: () => false }));
import { resolveGitHubOperationCredentials } from "./github-operation-credentials.js";

const pool = await reviewerNativeTestDatabase();
const db = pool.db;
let companyId: string, agentId: string, runId: string, contextId: string;

afterAll(async () => { await pool.end(); }); // Clean only the newly owned disposable component database.
beforeEach(async () => {
  companyId = randomUUID(); agentId = randomUUID(); runId = randomUUID(); contextId = randomUUID();
  native.run = { id: runId, companyId, agentId, nativeIssueId: null, contextSnapshot: {}, runnerProfileJson: {} };
  native.context = { id: contextId, revision: 1 }; native.secretCalls = 0; native.credentialCalls = 0; native.trustKind = "low_trust_review";
  await pool.query("INSERT INTO companies(id,name,issue_prefix) VALUES($1,'Native raw-export fixture',$2)", [companyId, `RV${randomUUID().replaceAll('-', '').slice(0,12)}`]);
  await pool.query("INSERT INTO agents(id,company_id,name,permissions) VALUES($1,$2,'One Reviewer','{}')", [agentId, companyId]);
  await pool.query("INSERT INTO heartbeat_runs(id,company_id,agent_id,status,runtime_mode) VALUES($1,$2,$3,'running','native')", [runId, companyId, agentId]);
  await pool.query("INSERT INTO run_identity_contexts(id,company_id,run_id,revision,cause,correlation_id,status) VALUES($1,$2,$3,1,'fixture',$4,'accepted')", [contextId, companyId, runId, randomUUID()]);
});
const role = async (enabled = true, company = companyId, agent = agentId) => {
  await pool.query("INSERT INTO agent_reviewer_policies(company_id,agent_id,enabled,revision,updated_by_user_id) VALUES($1,$2,$3,1,'fixture-board')", [company, agent, enabled]);
};

describe("actual dedicated-role query and native raw-export owner, PostgreSQL18", () => {
  it("has no effect when no operator-owned role or retained marker exists", async () => {
    expect(await reviewerExecutionRestrictsCredentials(db, { companyId, agentId })).toBe(false);
    await expect(assertNoReviewerGenericGateway(db, { companyId, agentId })).resolves.toBeUndefined();
  });
  it("uses a dedicated role row instead of agent-editable permissions JSON", async () => {
    await pool.query("UPDATE agents SET permissions=$1 WHERE id=$2", [{ reviewerRole: { enabled: true, configuredBy: "board" } }, agentId]);
    expect(await reviewerExecutionRestrictsCredentials(db, { companyId, agentId })).toBe(false);
    await role(); expect(await reviewerExecutionRestrictsCredentials(db, { companyId, agentId })).toBe(true);
  });
  it("keeps company and agent identities distinct", async () => {
    await role(); expect(await reviewerExecutionRestrictsCredentials(db, { companyId: randomUUID(), agentId })).toBe(false);
    expect(await reviewerExecutionRestrictsCredentials(db, { companyId, agentId: randomUUID() })).toBe(false);
  });
  it.each(["reviewerPolicy", "reviewerGitHubScope"])("retains restriction through %s after operator disables role", async key => {
    await role(false);
    expect(await reviewerExecutionRestrictsCredentials(db, { companyId, agentId, runnerProfileJson: { [key]: { revision: 1 } } })).toBe(true);
    expect(await reviewerExecutionRestrictsCredentials(db, { companyId, agentId })).toBe(false);
  });
  it("does not turn a malformed retained marker into a credential grant", async () => {
    expect(await reviewerExecutionRestrictsCredentials(db, { companyId, agentId, runnerProfileJson: { reviewerPolicy: null } })).toBe(true);
  });
  it("blocks generic gateway access for a configured Reviewer", async () => {
    await role(); await expect(assertNoReviewerGenericGateway(db, { companyId, agentId })).rejects.toMatchObject({ status: 403 });
  });
  it("does not restrict unrelated board/plugin sessions without an agent binding", async () => {
    await role(); await expect(assertNoReviewerGenericGateway(db, { companyId, agentId: null })).resolves.toBeUndefined();
  });
  it("the real native raw-export function rejects stored Reviewer before any secret resolution", async () => {
    await role(); native.trustKind = "standard";
    const result = await resolveGitHubOperationCredentials(db, { companyId, agentId, runId });
    expect(result.status).toBe("unavailable"); expect(result.env).toEqual({});
    expect(native.secretCalls).toBe(0); expect(native.credentialCalls).toBe(0);
    const saved = await pool.query<{ github: { status: string } }>("SELECT github FROM run_identity_contexts WHERE id=$1", [contextId]); expect(saved.rows[0].github.status).toBe("unavailable");
  });
  it("the real native raw-export function retains an active run's restriction after role removal", async () => {
    await role(false); native.run.runnerProfileJson = { reviewerPolicy: { revision: 1 } }; native.trustKind = "standard";
    const result = await resolveGitHubOperationCredentials(db, { companyId, agentId, runId });
    expect(result.status).toBe("unavailable"); expect(native.secretCalls).toBe(0); expect(native.credentialCalls).toBe(0);
  });
  it("preserves the original native low-trust refusal path without a new role", async () => {
    const result = await resolveGitHubOperationCredentials(db, { companyId, agentId, runId });
    expect(result.status).toBe("unavailable"); expect(native.secretCalls).toBe(0); expect(native.credentialCalls).toBe(0);
  });
});

import { randomUUID } from "node:crypto";

export interface ReviewerGitHubSql {
  query<T extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

export interface ReviewerGitHubReceipt {
  operationId: string;
  action: "comment" | "reply" | "resolve_own_finding";
  companyId: string;
  agentId: string;
  agentNameAtTime: string;
  runId: string;
  issueId: string;
  projectId: string;
  repositoryId: string;
  repository: string;
  pullNumber: number;
  headSha: string;
  commentId?: string;
  threadId?: string;
  url: string;
  findingKey?: string;
  verificationEvidenceId?: string;
}

export interface ReviewerGitHubOperation extends Record<string, unknown> {
  id: string;
  company_id: string;
  agent_id: string;
  run_id: string;
  issue_id: string;
  project_id: string;
  repository_id: string;
  repository: string;
  pull_number: number;
  head_sha: string;
  action: ReviewerGitHubReceipt["action"];
  idempotency_key: string;
  request_hash: string;
  agent_name: string;
  status: "pending" | "writing" | "confirmed" | "uncertain" | "rejected";
  request_payload: Record<string, unknown>;
  receipt: ReviewerGitHubReceipt | null;
  error_code: string | null;
  claim_token: string | null;
}

export type ReviewerGitHubOperationInput = Pick<ReviewerGitHubOperation,
  "company_id" | "agent_id" | "run_id" | "issue_id" | "project_id" | "repository_id" | "repository" | "pull_number" |
  "head_sha" | "action" | "idempotency_key" | "request_hash" | "agent_name" | "request_payload">;

/** Schema is supplied by the application migration. The fixture creates only
 * its separate disposable schema. No provider credential is persisted here. */
export function reviewerGitHubReceiptSchema(schema = "public"): string {
  const prefix = qualified(schema);
  return `CREATE TABLE ${prefix}.reviewer_github_operations (
    id uuid PRIMARY KEY, company_id uuid NOT NULL, agent_id uuid NOT NULL, run_id uuid NOT NULL,
    issue_id uuid NOT NULL, project_id uuid NOT NULL, repository_id text NOT NULL,
    repository text NOT NULL, pull_number integer NOT NULL CHECK(pull_number > 0), head_sha text NOT NULL,
    action text NOT NULL CHECK(action IN ('comment','reply','resolve_own_finding')),
    idempotency_key text NOT NULL, request_hash text NOT NULL, agent_name text NOT NULL,
    status text NOT NULL CHECK(status IN ('pending','writing','confirmed','uncertain','rejected')),
    request_payload jsonb NOT NULL, receipt jsonb, error_code text, claim_token uuid,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    write_started_at timestamptz, confirmed_at timestamptz,
    CHECK(char_length(idempotency_key) BETWEEN 1 AND 200),
    CHECK(status <> 'writing' OR (claim_token IS NOT NULL AND write_started_at IS NOT NULL)),
    CHECK(status <> 'confirmed' OR COALESCE(
      receipt IS NOT NULL AND jsonb_typeof(receipt)='object' AND confirmed_at IS NOT NULL
      AND receipt->>'operationId'=id::text AND receipt->>'action'=action
      AND receipt->>'companyId'=company_id::text AND receipt->>'agentId'=agent_id::text
      AND receipt->>'runId'=run_id::text AND receipt->>'issueId'=issue_id::text
      AND receipt->>'projectId'=project_id::text AND receipt->>'repositoryId'=repository_id
      AND receipt->>'repository'=repository AND receipt->>'pullNumber'=pull_number::text
      AND receipt->>'headSha'=head_sha AND receipt->>'agentNameAtTime'=agent_name
      AND (CASE WHEN action='resolve_own_finding' THEN receipt->>'threadId' IS NOT NULL
        ELSE receipt->>'commentId' ~ '^[1-9][0-9]*$' END), false)),
    UNIQUE(company_id, agent_id, run_id, idempotency_key)
  );
  CREATE INDEX reviewer_github_own_findings_idx ON ${prefix}.reviewer_github_operations
    (company_id,agent_id,issue_id,project_id,repository_id,pull_number,created_at,id)
    WHERE status='confirmed' AND action='comment' AND receipt->>'findingKey' IS NOT NULL;
  CREATE TABLE ${prefix}.reviewer_github_events (
    id bigserial PRIMARY KEY, operation_id uuid NOT NULL REFERENCES ${prefix}.reviewer_github_operations(id),
    event text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
  );`;
}

function qualified(schema: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw new Error("Invalid Reviewer receipt schema");
  return `"${schema}"`;
}

export function createReviewerGitHubStore(db: ReviewerGitHubSql, schema = "public") {
  const prefix = qualified(schema), operations = `${prefix}.reviewer_github_operations`, events = `${prefix}.reviewer_github_events`;
  const one = async (text: string, values: unknown[]) => (await db.query<ReviewerGitHubOperation>(text, values)).rows[0] ?? null;
  return {
    async stage(input: ReviewerGitHubOperationInput): Promise<ReviewerGitHubOperation> {
      const keys = ["company_id", "agent_id", "run_id", "issue_id", "project_id", "repository_id", "repository", "pull_number", "head_sha", "action", "idempotency_key", "request_hash", "agent_name", "request_payload"] as const;
      const values = [randomUUID(), ...keys.map(key => input[key])];
      const created = await one(`WITH created AS (
        INSERT INTO ${operations}(id,${keys.join(",")},status)
        VALUES (${values.map((_, index) => `$${index + 1}`).join(",")},'pending')
        ON CONFLICT(company_id,agent_id,run_id,idempotency_key) DO NOTHING RETURNING *
      ), audit AS (INSERT INTO ${events}(operation_id,event) SELECT id,'staged' FROM created)
      SELECT * FROM created`, values);
      if (created) return created;
      const existing = await one(`SELECT * FROM ${operations} WHERE company_id=$1 AND agent_id=$2 AND run_id=$3 AND idempotency_key=$4`,
        [input.company_id, input.agent_id, input.run_id, input.idempotency_key]);
      if (!existing) throw new Error("Reviewer operation disappeared");
      return existing;
    },
    get(id: string, companyId: string) { return one(`SELECT * FROM ${operations} WHERE id=$1 AND company_id=$2`, [id, companyId]); },
    async listOwnFindings(input: { companyId: string; agentId: string; issueId: string; projectId: string; repositoryId: string; pullNumber: number; offset: number }) {
      return (await db.query<ReviewerGitHubOperation>(`SELECT * FROM ${operations}
        WHERE company_id=$1 AND agent_id=$2 AND issue_id=$3 AND project_id=$4 AND repository_id=$5 AND pull_number=$6
          AND status='confirmed' AND action='comment' AND receipt->>'findingKey' IS NOT NULL
        ORDER BY created_at,id LIMIT 50 OFFSET $7`, [input.companyId, input.agentId, input.issueId, input.projectId, input.repositoryId, input.pullNumber, input.offset])).rows;
    },
    claim(id: string, companyId: string) {
      return one(`WITH changed AS (UPDATE ${operations} SET status='writing',write_started_at=now(),updated_at=now(),claim_token=$3
        WHERE id=$1 AND company_id=$2 AND status='pending' RETURNING *),
        audit AS (INSERT INTO ${events}(operation_id,event) SELECT id,'write_reserved' FROM changed)
        SELECT * FROM changed`, [id, companyId, randomUUID()]);
    },
    settle(id: string, companyId: string, status: "confirmed" | "uncertain" | "rejected", receipt: ReviewerGitHubReceipt | null, errorCode: string | null, claimToken: string | null = null) {
      return one(`WITH changed AS (UPDATE ${operations} SET status=$3,receipt=$4,error_code=$5,updated_at=now(),
          confirmed_at=CASE WHEN $3='confirmed' THEN now() ELSE NULL END
        WHERE id=$1 AND company_id=$2 AND ((status='pending' AND $6::uuid IS NULL) OR (status='writing' AND claim_token=$6::uuid)) RETURNING *),
        audit AS (INSERT INTO ${events}(operation_id,event) SELECT id,$3 FROM changed)
        SELECT * FROM changed`, [id, companyId, status, receipt, errorCode, claimToken]);
    },
  };
}

export type ReviewerGitHubStore = ReturnType<typeof createReviewerGitHubStore>;

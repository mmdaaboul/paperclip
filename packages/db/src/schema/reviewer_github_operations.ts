import { sql } from "drizzle-orm";
import { bigserial, check, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

/** Durable closed-action receipts contain public provider results, never tokens. */
export const reviewerGithubOperations = pgTable("reviewer_github_operations", {
  id: uuid("id").primaryKey(), companyId: uuid("company_id").notNull(), agentId: uuid("agent_id").notNull(), runId: uuid("run_id").notNull(),
  issueId: uuid("issue_id").notNull(), projectId: uuid("project_id").notNull(), repositoryId: text("repository_id").notNull(),
  repository: text("repository").notNull(), pullNumber: integer("pull_number").notNull(), headSha: text("head_sha").notNull(),
  action: text("action").notNull(), idempotencyKey: text("idempotency_key").notNull(), requestHash: text("request_hash").notNull(),
  agentName: text("agent_name").notNull(), status: text("status").notNull(), requestPayload: jsonb("request_payload").$type<Record<string, unknown>>().notNull(),
  receipt: jsonb("receipt").$type<Record<string, unknown>>(), errorCode: text("error_code"), claimToken: uuid("claim_token"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  writeStartedAt: timestamp("write_started_at", { withTimezone: true }), confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
}, table => [
  unique("reviewer_github_operations_run_key_unique").on(table.companyId, table.agentId, table.runId, table.idempotencyKey),
  check("reviewer_github_operations_pull_positive", sql`${table.pullNumber} > 0`),
  check("reviewer_github_operations_action_valid", sql`${table.action} in ('comment','reply','resolve_own_finding')`),
  check("reviewer_github_operations_status_valid", sql`${table.status} in ('pending','writing','confirmed','uncertain','rejected')`),
  check("reviewer_github_operations_key_bound", sql`char_length(${table.idempotencyKey}) between 1 and 200`),
  check("reviewer_github_operations_write_claim", sql`${table.status} <> 'writing' or (${table.claimToken} is not null and ${table.writeStartedAt} is not null)`),
  check("reviewer_github_operations_confirmed_binding", sql`${table.status} <> 'confirmed' or coalesce(
    ${table.receipt} is not null and jsonb_typeof(${table.receipt})='object' and ${table.confirmedAt} is not null
    and ${table.receipt}->>'operationId'=${table.id}::text and ${table.receipt}->>'action'=${table.action}
    and ${table.receipt}->>'companyId'=${table.companyId}::text and ${table.receipt}->>'agentId'=${table.agentId}::text
    and ${table.receipt}->>'runId'=${table.runId}::text and ${table.receipt}->>'issueId'=${table.issueId}::text
    and ${table.receipt}->>'projectId'=${table.projectId}::text and ${table.receipt}->>'repositoryId'=${table.repositoryId}
    and ${table.receipt}->>'repository'=${table.repository} and ${table.receipt}->>'pullNumber'=${table.pullNumber}::text
    and ${table.receipt}->>'headSha'=${table.headSha} and ${table.receipt}->>'agentNameAtTime'=${table.agentName}
    and (case when ${table.action}='resolve_own_finding' then ${table.receipt}->>'threadId' is not null
      else ${table.receipt}->>'commentId' ~ '^[1-9][0-9]*$' end), false)`),
  index("reviewer_github_own_findings_idx").on(table.companyId, table.agentId, table.issueId, table.projectId, table.repositoryId, table.pullNumber, table.createdAt, table.id)
    .where(sql`${table.status}='confirmed' and ${table.action}='comment' and ${table.receipt}->>'findingKey' is not null`),
]);

export const reviewerGithubEvents = pgTable("reviewer_github_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  operationId: uuid("operation_id").notNull().references(() => reviewerGithubOperations.id),
  event: text("event").notNull(), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

import { sql } from "drizzle-orm";
import { check, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

export const githubPushOperationReceipts = pgTable("github_push_operation_receipts", {
  id: uuid("id").primaryKey(), companyId: uuid("company_id").notNull(), agentId: uuid("agent_id").notNull(), runId: uuid("run_id").notNull(),
  idempotencyKey: uuid("idempotency_key").notNull(), binding: jsonb("binding").$type<Record<string, unknown>>().notNull(),
  request: jsonb("request").$type<Record<string, unknown>>().notNull(), fingerprint: text("fingerprint").notNull(),
  state: text("state").notNull(), reason: text("reason"), confirmationSource: text("confirmation_source"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(), finishedAt: timestamp("finished_at", { withTimezone: true }),
}, table => [
  unique("github_push_operation_receipts_run_key_unique").on(table.companyId, table.agentId, table.runId, table.idempotencyKey),
  check("github_push_operation_receipts_fingerprint_valid", sql`${table.fingerprint} ~ '^[a-f0-9]{64}$'`),
  check("github_push_operation_receipts_state_valid", sql`${table.state} in ('pending','confirmed','no_change','failed','uncertain')`),
  check("github_push_operation_receipts_source_valid", sql`${table.confirmationSource} is null or ${table.confirmationSource}='git_receive_pack_status'`),
  check("github_push_operation_receipts_actor_binding", sql`coalesce(jsonb_typeof(${table.binding})='object' and ${table.binding}->>'companyId'=${table.companyId}::text
    and ${table.binding}->>'agentId'=${table.agentId}::text and ${table.binding}->>'runId'=${table.runId}::text, false)`),
  check("github_push_operation_receipts_request_binding", sql`coalesce(jsonb_typeof(${table.request})='object' and ${table.request}->>'idempotencyKey'=${table.idempotencyKey}::text, false)`),
  check("github_push_operation_receipts_confirmation", sql`(${table.state}='confirmed')=(${table.confirmationSource} is not null)`),
  check("github_push_operation_receipts_finished", sql`(${table.state}='pending')=(${table.finishedAt} is null)`),
]);

import { sql } from "drizzle-orm";
import { pgTable, uuid, jsonb, text, bigint, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type { ScopedReviewSnapshot, ScopedReviewState, ScopedReviewCancellation } from "@paperclipai/shared";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { issueThreadInteractions } from "./issue_thread_interactions.js";
import { statusDecisions } from "./status_decisions.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { agentWakeupRequests } from "./agent_wakeup_requests.js";

/** Immutable snapshot plus CAS-controlled native request/return receipts. */
export const issueScopedReviews = pgTable("issue_scoped_reviews", {
  id: uuid("id").primaryKey(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  snapshot: jsonb("snapshot").$type<ScopedReviewSnapshot>().notNull(),
  state: text("state").$type<ScopedReviewState>().notNull().default("draft"),
  interactionId: uuid("interaction_id").references(() => issueThreadInteractions.id),
  sourceDecisionId: uuid("source_decision_id").references(() => statusDecisions.id),
  verdict: text("verdict").$type<"passed" | "changes_requested">(),
  verdictRunId: uuid("verdict_run_id").references(() => heartbeatRuns.id),
  returnWakeupId: uuid("return_wakeup_id").references(() => agentWakeupRequests.id),
  returnStatusVersion: bigint("return_status_version", {mode:"number"}),
  cancellation: jsonb("cancellation").$type<ScopedReviewCancellation>(),
  version: bigint("version", { mode: "number" }).notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  oneActivePerTask: uniqueIndex("issue_scoped_reviews_one_active_task_uq").on(table.companyId, table.issueId)
    .where(sql`${table.state} in ('draft', 'pending', 'cancelling')`),
}));

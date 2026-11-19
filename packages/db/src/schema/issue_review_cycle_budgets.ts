import { bigint, check, jsonb, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

export const issueReviewCycleBudgets = pgTable("issue_review_cycle_budgets", {
  issueId: uuid("issue_id").primaryKey().references(() => issues.id, { onDelete: "cascade" }),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  revision: bigint("revision", { mode: "number" }).notNull().default(1),
  ledger: jsonb("ledger").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [check("issue_review_cycle_budgets_revision_positive", sql`${table.revision} > 0`)]);

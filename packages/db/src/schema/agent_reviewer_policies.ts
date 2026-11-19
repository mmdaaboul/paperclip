import { boolean, foreignKey, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { AgentReviewerScope } from "@paperclipai/shared";
import { agents } from "./agents.js";

/** Operator-owned role authority; generic agent configuration cannot grant or remove it. */
export const agentReviewerPolicies = pgTable("agent_reviewer_policies", {
  companyId: uuid("company_id").notNull(),
  agentId: uuid("agent_id").notNull(),
  revision: integer("revision").notNull(),
  enabled: boolean("enabled").notNull().default(false),
  scopes: jsonb("scopes").$type<AgentReviewerScope[]>().notNull().default([]),
  updatedByUserId: text("updated_by_user_id").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  identity: primaryKey({ columns: [table.companyId, table.agentId] }),
  owner: foreignKey({ columns: [table.companyId, table.agentId], foreignColumns: [agents.companyId, agents.id] }).onDelete("cascade"),
}));

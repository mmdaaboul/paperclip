import { foreignKey, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { AgentReferenceFolder } from "@paperclipai/shared";
import { agents } from "./agents.js";

/** Dedicated operator-owned grants, independent of agent-editable runtime config. */
export const agentReferenceFolderConfigs = pgTable("agent_reference_folder_configs", {
  companyId: uuid("company_id").notNull(),
  agentId: uuid("agent_id").notNull(),
  revision: integer("revision").notNull(),
  entries: jsonb("entries").$type<AgentReferenceFolder[]>().notNull().default([]),
  updatedByUserId: text("updated_by_user_id").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  identity: primaryKey({ columns: [table.companyId, table.agentId] }),
  owner: foreignKey({ columns: [table.companyId, table.agentId], foreignColumns: [agents.companyId, agents.id] }).onDelete("cascade"),
}));

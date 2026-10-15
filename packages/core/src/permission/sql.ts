import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { Project } from "@opencode/schema/project"
import { Timestamps } from "../database/schema.sql.js"
import { ProjectTable } from "../project/sql.js"
import { SessionTable } from "../session/sql.js"
import type { Session } from "@opencode/schema/session"
import type { PermissionSaved } from "./saved.js"

export const PermissionTable = sqliteTable(
  "permission",
  {
    id: text().$type<PermissionSaved.ID>().primaryKey(),
    project_id: text()
      .$type<Project.ID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    action: text().notNull(),
    resource: text().notNull(),
    ...Timestamps,
  },
  (table) => [uniqueIndex("permission_project_action_resource_idx").on(table.project_id, table.action, table.resource)],
)

export const PermissionDecisionsTable = sqliteTable(
  "permission_decisions",
  {
    id: text().primaryKey(),
    session_id: text()
      .$type<Session.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    permission: text().notNull(),
    patterns: text({ mode: "json" }).$type<string[]>().notNull(),
    metadata: text({ mode: "json" }).$type<Record<string, unknown>>(),
    verdict: text().$type<"allow" | "deny" | "uncertain" | "fallback">().notNull(),
    reason: text(),
    prompt: text(),
    model: text().notNull(),
    latency_ms: integer().notNull(),
    created_at: integer().notNull(),
  },
  (table) => [index("permission_decisions_session_idx").on(table.session_id)],
)

export * as PermissionDecisionsStore from "./decisions-store.js"

import { asc, eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { ascending } from "@opencode/schema/identifier"
import type { Session } from "@opencode/schema/session"
import { Database } from "../database/database.js"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { PermissionDecisionsTable } from "./sql.js"

export const Verdict = Schema.Literals(["allow", "deny", "uncertain", "fallback"])
export type Verdict = typeof Verdict.Type

export interface Insert {
  readonly sessionID: Session.ID
  readonly permission: string
  readonly patterns: string[]
  readonly metadata?: Record<string, unknown>
  readonly verdict: Verdict
  readonly reason?: string
  readonly prompt?: string
  readonly model: string
  readonly latencyMs: number
}

export interface Info extends Insert {
  readonly id: string
  readonly createdAt: number
}

export interface Interface {
  readonly insert: (decision: Insert) => Effect.Effect<void>
  readonly listBySession: (sessionID: Session.ID) => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/PermissionDecisionsStore") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db

    const insert: Interface["insert"] = Effect.fn("PermissionDecisionsStore.insert")(function* (decision) {
      yield* db
        .insert(PermissionDecisionsTable)
        .values({
          id: "dec_" + ascending(),
          session_id: decision.sessionID,
          permission: decision.permission,
          patterns: decision.patterns,
          metadata: decision.metadata,
          verdict: decision.verdict,
          reason: decision.reason,
          prompt: decision.prompt,
          model: decision.model,
          latency_ms: decision.latencyMs,
          created_at: Date.now(),
        })
        .run()
        .pipe(Effect.orDie)
    })

    const listBySession: Interface["listBySession"] = Effect.fn("PermissionDecisionsStore.listBySession")(
      function* (sessionID) {
        const rows = yield* db
          .select()
          .from(PermissionDecisionsTable)
          .where(eq(PermissionDecisionsTable.session_id, sessionID))
          .orderBy(asc(PermissionDecisionsTable.created_at), asc(PermissionDecisionsTable.id))
          .all()
          .pipe(Effect.orDie)
        return rows.map((row) => ({
          id: row.id,
          sessionID: row.session_id,
          permission: row.permission,
          patterns: row.patterns,
          metadata: row.metadata ?? undefined,
          verdict: row.verdict,
          reason: row.reason ?? undefined,
          prompt: row.prompt ?? undefined,
          model: row.model,
          latencyMs: row.latency_ms,
          createdAt: row.created_at,
        }))
      },
    )

    return Service.of({ insert, listBySession })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })

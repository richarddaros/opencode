import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Database } from "@opencode/core/database/database"
import { PermissionDecisionsStore } from "@opencode/core/permission/decisions-store"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionTable } from "@opencode/core/session/sql"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([PermissionDecisionsStore.node, Database.node])))

describe("PermissionDecisionsStore", () => {
  it.effect("inserts and lists permission decisions ordered by arrival time", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const store = yield* PermissionDecisionsStore.Service

      const projectID = Project.ID.global
      const sessionID = Session.ID.make("ses_decision_test")

      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)

      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: projectID,
          slug: "test-slug",
          directory: "/project",
          title: "Test Session",
          version: "1.0",
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)

      yield* store.insert({
        sessionID,
        permission: "bash",
        patterns: ["ls -la"],
        metadata: { command: "ls -la" },
        verdict: "allow",
        model: "openai/gpt-4o-mini",
        latencyMs: 120,
      })

      yield* store.insert({
        sessionID,
        permission: "bash",
        patterns: ["cat .env"],
        metadata: { command: "cat .env" },
        verdict: "deny",
        reason: "reveals secrets",
        model: "openai/gpt-4o-mini",
        latencyMs: 95,
      })

      const decisions = yield* store.listBySession(sessionID)
      expect(decisions.length).toBe(2)

      expect(decisions[0]?.permission).toBe("bash")
      expect(decisions[0]?.patterns).toEqual(["ls -la"])
      expect(decisions[0]?.verdict).toBe("allow")
      expect(decisions[0]?.model).toBe("openai/gpt-4o-mini")

      expect(decisions[1]?.permission).toBe("bash")
      expect(decisions[1]?.patterns).toEqual(["cat .env"])
      expect(decisions[1]?.verdict).toBe("deny")
      expect(decisions[1]?.reason).toBe("reveals secrets")
    }),
  )
})

import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Location } from "@opencode/core/location"
import { Permission } from "@opencode/core/permission"
import { PermissionSaved } from "@opencode/core/permission/saved"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const current = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionStore.node, PermissionSaved.node, Agent.node, Permission.node]),
    [Location.node.replace(current)],
  ),
)

function setup(sessionID: Session.ID, rules: Permission.Ruleset = [{ action: "*", resource: "*", effect: "ask" }]) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const agents = yield* Agent.Service

    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)

    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "test-slug",
        directory: "/project",
        title: "Test Session",
        version: "1.0",
        agent: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)

    yield* agents.transform((editor) =>
      editor.update(Agent.ID.make("test"), (agent) => {
        agent.permissions = [...rules]
      }),
    )
  })
}

describe("Permission with validator interception", () => {
  it.effect("auto-allows when validator returns allow verdict", () =>
    Effect.gen(function* () {
      const permissions = yield* Permission.Service
      const sessionID = Session.ID.make("ses_auto_allow")

      yield* setup(sessionID)

      // Register validator that permits safe commands
      if (permissions.registerValidator) {
        yield* permissions.registerValidator((input) =>
          Effect.succeed(input.action === "bash" && input.resources.includes("ls") ? { verdict: "allow" } : undefined),
        )
      }

      // Assert safe command: should resolve immediately without opening a human ask
      yield* permissions.assert({
        sessionID,
        action: "bash",
        resources: ["ls"],
      })

      // Ensure no pending ask remains
      const pending = yield* permissions.list()
      expect(pending.length).toBe(0)
    }),
  )

  it.effect("rejects with CorrectedError when validator returns deny verdict", () =>
    Effect.gen(function* () {
      const permissions = yield* Permission.Service
      const sessionID = Session.ID.make("ses_auto_deny")

      yield* setup(sessionID)

      if (permissions.registerValidator) {
        yield* permissions.registerValidator((input) =>
          input.resources.includes("rm -rf /")
            ? Effect.fail(new Permission.CorrectedError({ feedback: "Deleting root is not allowed" }))
            : Effect.succeed(undefined),
        )
      }

      const result = yield* permissions
        .assert({
          sessionID,
          action: "bash",
          resources: ["rm -rf /"],
        })
        .pipe(
          Effect.flip,
          Effect.catch((err) => Effect.succeed(err)),
        )

      expect(result).toBeInstanceOf(Permission.CorrectedError)
      if (result instanceof Permission.CorrectedError) {
        expect(result.feedback).toBe("Deleting root is not allowed")
      }
    }),
  )
})

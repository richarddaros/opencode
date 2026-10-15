export * as PermissionValidator from "./validator.js"

import { LLMClient, Message, SystemPart } from "@opencode/ai"
import { Cause, Context, Deferred, Effect, Exit, Layer, Option } from "effect"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Agent } from "../agent.js"
import { llmClient } from "../effect/app-node-platform.js"
import { Model } from "../model.js"
import { ModelResolver } from "../model-resolver.js"
import { Permission } from "../permission.js"
import { SessionContext } from "../session/context.js"
import { SessionRunnerModel } from "../session/runner/model.js"
import { SessionStore } from "../session/store.js"
import { PermissionDecisionsStore } from "./decisions-store.js"
import { buildPrompt, parseVerdict, summarize } from "./verdict.js"

const VALIDATE_TIMEOUT = 15_000
const HEALTH_TIMEOUT = 10_000
const ASK_TIMEOUT = 45_000
const HEALTH_CACHE_TTL = 30_000

export { parseVerdict }

export interface Health {
  readonly ok: boolean
  readonly model?: string
  readonly reason?: string
}

export interface VerdictOutcome {
  readonly verdict: "allow" | "deny" | "uncertain" | "fallback"
  readonly reason?: string
  readonly model?: string
}

export interface Interface {
  readonly validate: (
    input: Permission.AssertInput,
  ) => Effect.Effect<VerdictOutcome | undefined, Permission.CorrectedError>
  readonly health: () => Effect.Effect<Health>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/PermissionValidator") {}

export interface Options {
  readonly askTimeout?: number
  readonly validateTimeout?: number
  readonly healthTimeout?: number
  readonly healthCacheTtl?: number
}

const make = (options?: Options) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const askTimeout = options?.askTimeout ?? ASK_TIMEOUT
      const validateTimeout = options?.validateTimeout ?? VALIDATE_TIMEOUT
      const healthTimeout = options?.healthTimeout ?? HEALTH_TIMEOUT
      const healthCacheTtl = options?.healthCacheTtl ?? HEALTH_CACHE_TTL

      const permission = yield* Permission.Service
      const agents = yield* Agent.Service
      const models = yield* Model.Service
      const resolver = yield* ModelResolver.Service
      const sessions = yield* SessionStore.Service
      const context = yield* SessionContext.Service
      const decisions = yield* PermissionDecisionsStore.Service
      const llm = yield* LLMClient.Service

      // Strict FIFO per session: parallel tool calls validate one at a time
      const tails = new Map<string, Effect.Effect<void>>()
      const serial = <A, E>(sessionID: string, work: Effect.Effect<A, E>) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const previous = tails.get(sessionID) ?? Effect.void
            const release = yield* Deferred.make<void>()
            const tail = Deferred.await(release)
            tails.set(sessionID, tail)
            return yield* restore(
              Effect.gen(function* () {
                yield* previous
                return yield* work
              }),
            ).pipe(
              Effect.ensuring(
                Effect.gen(function* () {
                  yield* Deferred.succeed(release, undefined)
                  if (tails.get(sessionID) === tail) tails.delete(sessionID)
                }),
              ),
            )
          }),
        )

      const audit = Effect.fn("PermissionValidator.audit")(function* (
        input: Permission.AssertInput,
        verdict: PermissionDecisionsStore.Verdict,
        modelName: string,
        latencyMs: number,
        reason?: string,
        promptText?: string,
      ) {
        const outcome = yield* decisions
          .insert({
            sessionID: input.sessionID,
            permission: input.action,
            patterns: [...input.resources],
            metadata: input.metadata ? summarize(input.metadata as Record<string, unknown>) : {},
            verdict,
            reason,
            prompt: promptText,
            model: modelName,
            latencyMs,
          })
          .pipe(Effect.exit)
        if (Exit.isFailure(outcome)) {
          if (Cause.hasInterruptsOnly(outcome.cause)) return yield* Effect.interrupt
          yield* Effect.logWarning("permission decision audit write failed", {
            cause: Cause.pretty(outcome.cause),
          })
          return false
        }
        return true
      })

      const resolveValidatorModel = Effect.fn("PermissionValidator.resolveValidatorModel")(function* (
        agent: Agent.Info,
        sessionModel?: SessionRunnerModel.Resolved,
      ) {
        if (agent.model) {
          const resolved = yield* resolver.resolve(agent.model).pipe(recover)
          if (resolved) return resolved
        }
        if (sessionModel) {
          const small = yield* models.small(sessionModel.ref.providerID).pipe(recover)
          if (small) {
            const resolvedSmall = yield* resolver.resolveModel(small).pipe(recover)
            if (resolvedSmall) return resolvedSmall
          }
          return sessionModel
        }
        const defaultModel = yield* models.default().pipe(recover)
        if (defaultModel) {
          const resolved = yield* resolver.resolveModel(defaultModel).pipe(recover)
          if (resolved) return resolved
        }
        return yield* resolver.resolve().pipe(recover)
      })

      const run = Effect.fn("PermissionValidator.run")(function* (input: Permission.AssertInput) {
        const started = Date.now()
        const session = yield* sessions.get(input.sessionID).pipe(recover)
        if (!session) return undefined

        const ag = yield* agents.get(Agent.ID.make("command-validator")).pipe(recover)
        if (!ag) {
          yield* audit(input, "fallback", "unknown", Date.now() - started, "command-validator agent missing")
          return { verdict: "fallback" as const, reason: "command-validator agent missing", model: "unknown" }
        }

        const sessionModel = yield* context.resolveModel(session).pipe(recover)
        const selectedModel = yield* resolveValidatorModel(ag, sessionModel)
        if (!selectedModel) {
          yield* audit(input, "fallback", "unknown", Date.now() - started, "model resolution failed")
          return { verdict: "fallback" as const, reason: "model resolution failed", model: "unknown" }
        }
        const modelName = `${selectedModel.ref.providerID}/${selectedModel.ref.id}`

        const contextMessages = yield* sessions.context(input.sessionID).pipe(Effect.orElseSucceed(() => []))
        const summary = contextMessages
          .slice(-4)
          .flatMap((m) => {
            if (m.type === "user") return [`User: ${m.text.slice(0, 500)}`]
            if (m.type === "assistant") {
              const txt = m.content
                .flatMap((p) => (p.type === "text" ? [p.text.slice(0, 300)] : []))
                .join(" ")
              return txt ? [`Assistant: ${txt}`] : []
            }
            return []
          })
          .join("\n")

        const prompt = buildPrompt(
          {
            permission: input.action,
            patterns: input.resources,
            metadata: (input.metadata ?? {}) as Record<string, unknown>,
          },
          summary || undefined,
        )

        if (prompt.truncated) {
          yield* audit(input, "uncertain", modelName, Date.now() - started, "payload truncated", prompt.text)
          return { verdict: "uncertain" as const, reason: "payload truncated", model: modelName }
        }

        const prepared = yield* context.request.generate({
          session,
          agent: ag.id,
          model: selectedModel,
          system: ag.system ? [SystemPart.make(ag.system)] : [],
          messages: [Message.user(prompt.text)],
        })

        const attempted = yield* llm
          .generate(prepared.request, prepared.options)
          .pipe(Effect.timeout(validateTimeout), Effect.exit)

        if (Exit.isFailure(attempted)) {
          if (Cause.hasInterruptsOnly(attempted.cause)) return yield* Effect.interrupt
          const reason = Cause.isTimeoutError(Cause.squash(attempted.cause)) ? "timeout" : "error"
          yield* audit(input, "fallback", modelName, Date.now() - started, reason, prompt.text)
          return { verdict: "fallback" as const, reason, model: modelName }
        }

        const parsed = parseVerdict(attempted.value.text)
        if (!parsed) {
          yield* audit(input, "fallback", modelName, Date.now() - started, "invalid", prompt.text)
          return { verdict: "fallback" as const, reason: "invalid", model: modelName }
        }

        if (parsed.verdict === "allow") {
          yield* audit(input, "allow", modelName, Date.now() - started, undefined, prompt.text)
          return { verdict: "allow" as const, model: modelName }
        }

        if (parsed.verdict === "deny") {
          yield* audit(input, "deny", modelName, Date.now() - started, parsed.reason, prompt.text)
          return yield* new Permission.CorrectedError({ feedback: parsed.reason ?? "Command denied by validator" })
        }

        yield* audit(input, "uncertain", modelName, Date.now() - started, parsed.reason, prompt.text)
        return { verdict: "uncertain" as const, reason: parsed.reason, model: modelName }
      })

      const validate: Interface["validate"] = (input) =>
        Effect.gen(function* () {
          const started = Date.now()
          const outcome = yield* serial(input.sessionID, run(input)).pipe(Effect.timeoutOption(askTimeout))
          if (Option.isSome(outcome)) return outcome.value
          yield* audit(input, "fallback", "unknown", Date.now() - started, "timeout")
          return { verdict: "fallback" as const, reason: "timeout", model: "unknown" }
        })

      const healthCache = new Map<string, { at: number; value: Health }>()
      const health = Effect.fn("PermissionValidator.health")(function* () {
        const ag = yield* agents.get(Agent.ID.make("command-validator")).pipe(recover)
        if (!ag) return { ok: false, reason: "command-validator agent not registered" }
        const selectedModel = yield* resolveValidatorModel(ag)
        if (!selectedModel) return { ok: false, reason: "could not resolve a model for command-validator" }
        const modelName = `${selectedModel.ref.providerID}/${selectedModel.ref.id}`
        const cached = healthCache.get(modelName)
        if (cached && Date.now() - cached.at < healthCacheTtl) return cached.value

        const testPrompt = buildPrompt(
          { permission: "bash", patterns: ["ls"], metadata: { command: "ls" } },
          "(health probe)",
        )
        const attempted = yield* llm
          .generate({
            model: selectedModel.model,
            tools: [],
            system: ag.system ? [SystemPart.make(ag.system)] : [],
            messages: [Message.user(testPrompt.text)],
          })
          .pipe(Effect.timeout(healthTimeout), Effect.exit)

        const value: Health = Exit.isFailure(attempted)
          ? { ok: false, model: modelName, reason: "call failed" }
          : parseVerdict(attempted.value.text)
            ? { ok: true, model: modelName }
            : { ok: false, model: modelName, reason: "unparseable verdict" }

        healthCache.set(modelName, { at: Date.now(), value })
        return value
      })

      yield* Effect.sync(() => {
        if (typeof permission.registerValidator === "function") {
          return permission.registerValidator(validate)
        }
        return Effect.void
      }).pipe(
        Effect.flatten,
        Effect.catchDefect((defect) => {
          if (defect instanceof Error && defect.name === "UnimplementedError") {
            return Effect.void
          }
          return Effect.die(defect)
        }),
        Effect.orElseSucceed(() => undefined),
      )
      return Service.of({ validate, health })
    }),
  )

function recover<A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A | undefined, never, R> {
  return self.pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
      return Effect.succeed(undefined)
    }),
  )
}

export const node = makeLocationNode({
  service: Service,
  layer: make(),
  deps: [
    Permission.node,
    Agent.node,
    Model.node,
    ModelResolver.node,
    SessionStore.node,
    SessionContext.node,
    PermissionDecisionsStore.node,
    llmClient,
  ],
})

export const nodeWith = (options: Options) =>
  makeLocationNode({
    service: Service,
    layer: make(options),
    deps: [
      Permission.node,
      Agent.node,
      Model.node,
      ModelResolver.node,
      SessionStore.node,
      SessionContext.node,
      PermissionDecisionsStore.node,
      llmClient,
    ],
  })

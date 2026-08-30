import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionDigest } from "@opencode-ai/schema/session-digest"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Session } from "./session"
import { SessionID } from "./schema"
import { SessionSummary } from "./summary"
import { Context, Effect, Layer, Option, Scope } from "effect"

const MAX_SUMMARY_LENGTH = 2000

type TerminalStatus = "completed" | "error" | "cancelled"
type TerminalInfo = BackgroundJob.Info & { status: TerminalStatus }

const isTerminal = (info: BackgroundJob.Info): info is TerminalInfo => info.status !== "running"

export interface Interface {
  /**
   * Runs a root session's work as a tracked job so the session gets the same
   * precise terminal-state "done" signal delegates have. Child sessions
   * (subagents) already run as jobs via the task/delegate tools, so they pass
   * through untracked.
   */
  readonly track: (input: {
    sessionID: SessionID
    work: Effect.Effect<SessionV1.WithParts>
  }) => Effect.Effect<SessionV1.WithParts>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionTracker") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    const sessions = yield* Session.Service
    const summary = yield* SessionSummary.Service
    const events = yield* EventV2Bridge.Service
    const scope = yield* Scope.Scope

    const lastAssistant = Effect.fn("SessionTracker.lastAssistant")(function* (sessionID: SessionID) {
      const match = yield* sessions.findMessage(sessionID, (m) => m.info.role !== "user").pipe(Effect.orDie)
      if (Option.isSome(match)) return match.value
      const msgs = yield* sessions.messages({ sessionID, limit: 1 }).pipe(Effect.orDie)
      if (msgs.length > 0) return msgs[0]
      throw new Error("Impossible")
    })

    const messageSummary = Effect.fn("SessionTracker.messageSummary")(function* (messages: SessionV1.WithParts[]) {
      const last = messages.findLast((m) => m.info.role !== "user")
      if (!last) return
      const text = last.parts
        .filter((p): p is SessionV1.TextPart => p.type === "text" && !p.synthetic)
        .map((p) => p.text)
        .join("\n")
        .trim()
      if (!text) return
      return text.length > MAX_SUMMARY_LENGTH ? text.slice(0, MAX_SUMMARY_LENGTH) + "..." : text
    })

    const emitDigest = Effect.fn("SessionTracker.emitDigest")(function* (input: {
      sessionID: SessionID
      job: TerminalInfo
    }) {
      const session = yield* sessions.get(input.sessionID).pipe(Effect.option)
      if (Option.isNone(session)) return
      const messages = yield* sessions.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)
      const [files, messageSummaryText] = yield* Effect.all([
        summary.computeDiff({ messages }),
        messageSummary(messages),
      ])
      yield* events.publish(SessionDigest.Digest, {
        sessionID: input.sessionID,
        digest: {
          sessionID: input.sessionID,
          title: session.value.title,
          status: input.job.status,
          directory: session.value.directory,
          files,
          messageSummary: messageSummaryText,
          cost: session.value.cost,
          tokens: session.value.tokens,
        },
      })
    })

    const track = Effect.fn("SessionTracker.track")(function* (input: {
      sessionID: SessionID
      work: Effect.Effect<SessionV1.WithParts>
    }) {
      const session = yield* sessions.get(input.sessionID).pipe(Effect.option)
      if (Option.isNone(session)) return yield* input.work
      if (session.value.parentID) return yield* input.work
      const job = yield* background.start({
        id: input.sessionID,
        type: "session",
        title: session.value.title,
        metadata: { sessionId: input.sessionID },
        run: input.work.pipe(
          Effect.map((msg) =>
            msg.parts
              .filter((p): p is SessionV1.TextPart => p.type === "text" && !p.synthetic)
              .map((p) => p.text)
              .join("\n"),
          ),
        ),
      })
      const waited = yield* background.wait({ id: job.id })
      const info = waited.info
      if (info && isTerminal(info) && info.started_at === job.started_at) {
        yield* emitDigest({ sessionID: input.sessionID, job: info }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("session digest failed", { sessionID: input.sessionID, cause }),
          ),
          Effect.forkIn(scope, { startImmediately: true }),
        )
      }
      if (info?.status === "error") return yield* Effect.die(new Error(info.error ?? "Session run failed"))
      if (info?.status === "cancelled") return yield* Effect.interrupt
      return yield* lastAssistant(input.sessionID)
    })

    return Service.of({ track })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [BackgroundJob.node, Session.node, SessionSummary.node, EventV2Bridge.node],
})

export * as SessionTracker from "./tracker"

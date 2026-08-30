import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionDigest } from "@opencode-ai/schema/session-digest"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Session } from "./session"
import { SessionPrompt } from "./prompt"
import { SessionID } from "./schema"
import { InstanceStore } from "@/project/instance-store"
import { WorkspaceRef } from "@/effect/instance-ref"
import { Context, Effect, Layer, Option, Scope, Stream } from "effect"

export interface Interface {
  /**
   * Finds the supervisor session for the current project, creating one (agent
   * "supervisor", title "Supervisor") if it does not exist yet.
   */
  readonly ensure: () => Effect.Effect<Session.Info>
  /**
   * Wakes the supervisor session with a structured wake-up message built from a
   * session digest, so it reviews the finished run and asks the user which
   * action to take. Runs in the current instance context.
   */
  readonly wake: (input: { sessionID: SessionID; digest: SessionDigest.Info }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Supervisor") {}

function wakeMessage(digest: SessionDigest.Info) {
  const files =
    digest.files && digest.files.length > 0
      ? digest.files
          .map((file) => {
            const status = file.status ? ` (${file.status})` : ""
            return `  - ${file.file ?? "?"}${status} +${file.additions}/-${file.deletions}`
          })
          .join("\n")
      : "  (no tracked file changes)"

  return [
    `A supervised session finished a run.`,
    ``,
    `Session "${digest.title ?? digest.sessionID}" finished with status ${digest.status}.`,
    ``,
    `Changed files:`,
    files,
    ``,
    `Summary: ${digest.messageSummary ?? "(none)"}`,
    ...(digest.cost !== undefined ? [`Cost: $${digest.cost.toFixed(4)}`] : []),
    ...(digest.tokens ? [`Tokens: ${digest.tokens.input} in / ${digest.tokens.output} out`] : []),
    ``,
    `Review the session's work against the rules in globalAGENTS.md, then come back`,
    `to the user and ask which action to take:`,
    `1. Commit — commit the session's branch into the primary branch, no push.`,
    `2. Commit and push — commit, then push to the remote.`,
    `3. Commit and restart the GUI — after committing, relaunch the app with the new code.`,
  ].join("\n")
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const prompt = yield* SessionPrompt.Service
    const events = yield* EventV2Bridge.Service
    const store = yield* InstanceStore.Service
    const scope = yield* Scope.Scope

    const ensure = Effect.fn("Supervisor.ensure")(function* () {
      const existing = yield* sessions.list({ limit: 100 })
      const supervisor = existing.find((session) => session.agent === "supervisor")
      if (supervisor) return supervisor
      return yield* sessions.create({ title: "Supervisor", agent: "supervisor" })
    })

    const wake = Effect.fn("Supervisor.wake")(function* (input: { sessionID: SessionID; digest: SessionDigest.Info }) {
      const supervisor = yield* ensure()
      yield* prompt
        .prompt({
          sessionID: supervisor.id,
          agent: "supervisor",
          parts: [{ type: "text", text: wakeMessage(input.digest) }],
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("supervisor wake prompt failed", { sessionID: supervisor.id, cause }),
          ),
        )
    })

    const handle = Effect.fn("Supervisor.handle")(function* (payload: {
      data: { sessionID: SessionID; digest: SessionDigest.Info }
    }) {
      const session = yield* sessions.get(payload.data.sessionID).pipe(Effect.option)
      if (Option.isNone(session)) return
      // Never wake for the supervisor's own runs — those are not tracked, but
      // guard against any supervisor-agent session reaching this handler.
      if (session.value.agent === "supervisor") return

      const wakeInInstance = wake({ sessionID: payload.data.sessionID, digest: payload.data.digest })
      const withRef = session.value.workspaceID
        ? Effect.provideService(wakeInInstance, WorkspaceRef, session.value.workspaceID)
        : wakeInInstance
      yield* store.provide({ directory: session.value.directory }, withRef)
    })

    yield* Stream.runForEach(
      events.subscribe(SessionDigest.Digest),
      (payload) =>
        handle(payload).pipe(
          Effect.catchCause((cause) => Effect.logWarning("supervisor wake failed", { cause })),
        ),
    ).pipe(Effect.forkIn(scope))

    return Service.of({ ensure, wake })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Session.node, SessionPrompt.node, EventV2Bridge.node, InstanceStore.node],
})

export * as Supervisor from "./supervisor"

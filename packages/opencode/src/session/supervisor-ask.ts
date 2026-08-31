import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionID } from "./schema"
import { ulid } from "ulid"
import { Context, Deferred, Duration, Effect, Layer, Queue, Stream } from "effect"

/**
 * An in-flight session→supervisor question. The tool offers one to the queue
 * and awaits the matching answer; the Supervisor service consumes the queue,
 * prompts the supervisor session, and completes the deferred. Routing through
 * a queue instead of a service dependency keeps the tool registry decoupled
 * from the supervisor's SessionPrompt dependency (the layer graph would cycle).
 */
export interface Request {
  readonly requestID: string
  readonly sessionID: SessionID
  readonly question: string
}

export interface Interface {
  readonly ask: (input: { sessionID: SessionID; question: string }) => Effect.Effect<string, Error>
  readonly answer: (input: { requestID: string; answer: string }) => Effect.Effect<void>
  readonly requests: Stream.Stream<Request>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SupervisorAsk") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<Request>()
    const pending = new Map<string, Deferred.Deferred<string, Error>>()

    const ask = Effect.fn("SupervisorAsk.ask")(function* (input: { sessionID: SessionID; question: string }) {
      const requestID = ulid()
      const deferred = yield* Deferred.make<string, Error>()
      pending.set(requestID, deferred)
      yield* Effect.sync(() => Queue.offerUnsafe(queue, { ...input, requestID }))
      return yield* Deferred.await(deferred).pipe(
        Effect.timeoutOrElse({
          duration: Duration.minutes(10),
          orElse: () => Effect.fail(new Error("The supervisor did not answer in time")),
        }),
        Effect.ensuring(Effect.sync(() => pending.delete(requestID))),
      )
    })

    const answer = Effect.fn("SupervisorAsk.answer")(function* (input: { requestID: string; answer: string }) {
      const deferred = pending.get(input.requestID)
      if (!deferred) return
      pending.delete(input.requestID)
      yield* Deferred.succeed(deferred, input.answer)
    })

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* Queue.shutdown(queue)
        for (const deferred of pending.values()) yield* Deferred.fail(deferred, new Error("Supervisor shutting down"))
        pending.clear()
      }),
    )

    return Service.of({ ask, answer, requests: Stream.fromQueue(queue) })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [] })

export * as SupervisorAsk from "./supervisor-ask"

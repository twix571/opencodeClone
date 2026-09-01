import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProactivePing } from "@opencode-ai/schema/proactive-ping"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionID } from "./schema"
import { Context, Effect, Layer } from "effect"

/**
 * Deterministic proactive enforcement. Tool calls that a permission rule
 * denies are streamed here as structured flags (tool, file, permission result);
 * each flag becomes a corrective ping that is drained into the session's next
 * provider turn, so the agent stops retrying the forbidden action. This is the
 * "supervisor" hot path: no LLM round-trip, no transcript reading — the model
 * is only involved when a flag needs investigation, which is a future step.
 */
export interface Interface {
  /**
   * Records a flagged tool call: publishes the structured `proactive.ping`
   * event and queues a corrective message for the session. Same (tool, file)
   * repeats collapse into one pending ping.
   */
  readonly flag: (flag: ProactivePing.Flag) => Effect.Effect<void>
  /**
   * Returns and clears the pending corrective messages for a session. The
   * session loop drains this between provider turns so pings land mid-run.
   */
  readonly drain: (sessionID: SessionID) => Effect.Effect<readonly string[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Proactive") {}

export function pingMessage(flag: ProactivePing.Flag) {
  const target = flag.file ? `\`${flag.tool}\` on ${flag.file}` : `\`${flag.tool}\``
  return [
    `[Supervisor correction] Your call to ${target} was denied by the permission rules.`,
    `Do not retry it. If the work needs permissions you lack, delegate it to a subagent or ask the user rather than attempting it again.`,
  ].join("\n")
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const pending = new Map<string, Map<string, string>>()

    const flag = Effect.fn("Proactive.flag")(function* (input: ProactivePing.Flag) {
      const perSession = pending.get(input.sessionID) ?? new Map<string, string>()
      const key = input.file ? `${input.tool}\u0000${input.file}` : input.tool
      perSession.set(key, pingMessage(input))
      pending.set(input.sessionID, perSession)
      yield* events.publish(ProactivePing.Ping, { sessionID: input.sessionID, flag: input })
    })

    const drain = Effect.fn("Proactive.drain")(function* (sessionID: SessionID) {
      const perSession = pending.get(sessionID)
      if (!perSession) return [] as readonly string[]
      pending.delete(sessionID)
      return Array.from(perSession.values())
    })

    return Service.of({ flag, drain })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [EventV2Bridge.node] })

export * as Proactive from "./proactive"

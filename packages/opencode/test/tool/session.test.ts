import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Database } from "@opencode-ai/core/database/database"
import { Cause, Effect, Exit, Layer } from "effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { disposeAllInstances, noopBootstrapLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Truncate } from "@/tool/truncate"
import { InstanceStore } from "@/project/instance-store"
import { SessionTool } from "../../src/tool/session"
import { Tool } from "@/tool/tool"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const layer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      BackgroundJob.node,
      EventV2Bridge.node,
      Session.node,
      SessionProjector.node,
      Truncate.node,
      Database.node,
      RuntimeFlags.node,
    ]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer(flags)],
      [InstanceStore.bootstrapNode, noopBootstrapLayer],
    ],
  )

const it = testEffect(layer())

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const seed = Effect.fn("SessionToolTest.seed")(function* (title = "Pinned", prompt = "hello world") {
  const session = yield* Session.Service
  const chat = yield* session.create({ title })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: user.id,
    sessionID: chat.id,
    type: "text",
    text: prompt,
  })
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    variant: "xhigh",
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: assistant.id,
    sessionID: chat.id,
    type: "text",
    text: "a response",
  })
  return { chat }
})

const run = Effect.fn("SessionToolTest.run")(function* (
  args: Tool.InferParameters<typeof SessionTool>,
  next: Tool.Context = ctx,
) {
  const tool = yield* SessionTool
  const def = yield* tool.init()
  return yield* def.execute(args, next)
})

const fail = Effect.fn("SessionToolTest.fail")(function* (
  args: Tool.InferParameters<typeof SessionTool>,
  next: Tool.Context = ctx,
) {
  const exit = yield* run(args, next).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected session tool to fail")
})

describe("tool.session list", () => {
  it.instance("lists sessions in the current project", () =>
    Effect.gen(function* () {
      const { chat } = yield* seed("Pinned session")

      const result = yield* run({ action: "list" })
      expect(result.output).toContain(chat.id)
      expect(result.output).toContain("Pinned session")
    }),
  )

  it.instance("lists sessions globally with a directory", () =>
    Effect.gen(function* () {
      const { chat } = yield* seed("Global session")

      const result = yield* run({ action: "list", scope: "global" })
      expect(result.output).toContain(chat.id)
      expect(result.output).toContain("Global session")
    }),
  )

  it.instance("returns no sessions when none exist", () =>
    Effect.gen(function* () {
      const result = yield* run({ action: "list" })
      expect(result.output).toContain("No sessions found")
    }),
  )
})

describe("tool.session get", () => {
  it.instance("renders the conversation as markdown", () =>
    Effect.gen(function* () {
      const { chat } = yield* seed("Pinned", "hello world")

      const result = yield* run({ action: "get", sessionID: chat.id })
      expect(result.output).toContain(`# session ${chat.id}`)
      expect(result.output).toContain("Pinned")
      expect(result.output).toContain("hello world")
      expect(result.output).toContain("a response")
    }),
  )

  it.instance("filters by role", () =>
    Effect.gen(function* () {
      const { chat } = yield* seed("Pinned", "only a prompt")

      const result = yield* run({ action: "get", sessionID: chat.id, role: "user" })
      expect(result.output).toContain("only a prompt")
      expect(result.output).not.toContain("a response")
    }),
  )

  it.instance("limits to the last N messages", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const chat = yield* session.create({ title: "Limited" })
      for (let i = 0; i < 3; i++) {
        const user = yield* session.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: chat.id,
          agent: "build",
          model: ref,
          time: { created: Date.now() + i },
        })
        yield* session.updatePart({
          id: PartID.ascending(),
          messageID: user.id,
          sessionID: chat.id,
          type: "text",
          text: `prompt${i}`,
        })
      }

      const result = yield* run({ action: "get", sessionID: chat.id, limit: 1 })
      expect(result.output).toContain("prompt2")
      expect(result.output).not.toContain("prompt0")
    }),
  )

  it.instance("fails for an unknown session id", () =>
    Effect.gen(function* () {
      const err = yield* fail({ action: "get", sessionID: "ses_missing" })
      expect(err.message).toContain("Session not found")
    }),
  )
})

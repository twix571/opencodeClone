import { SessionV1 } from "@opencode-ai/core/v1/session"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { EventV2Bridge } from "@/event-v2-bridge"
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Env } from "../../src/env"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"
import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionTracker } from "../../src/session/tracker"
import { Supervisor } from "../../src/session/supervisor"
import { SupervisorAsk } from "../../src/session/supervisor-ask"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { InstanceStore } from "@/project/instance-store"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Format } from "../../src/format"
import { noopBootstrapLayer, TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionDigest } from "@opencode-ai/schema/session-digest"

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    instructions: () => Effect.succeed([]),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    resourceTemplates: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth in supervisor tests"),
    authenticate: () => Effect.die("unexpected MCP auth in supervisor tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in supervisor tests"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const runtimeFlags = RuntimeFlags.layer({ experimentalEventSystem: true })

const testLLMServerNode = LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })

const supervisorRoot = LayerNode.group([
  Supervisor.node,
  SupervisorAsk.node,
  SessionTracker.node,
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  MessageV2.node,
  Snapshot.node,
  LLM.node,
  Env.node,
  AgentSvc.node,
  Command.node,
  Permission.node,
  Plugin.node,
  Config.node,
  ProviderSvc.node,
  LSP.node,
  MCP.node,
  FSUtil.node,
  BackgroundJob.node,
  SessionStatus.node,
  SessionRunState.node,
  InstanceStore.node,
  EventV2Bridge.node,
  Question.node,
  Todo.node,
  ToolRegistry.node,
  Skill.node,
  Git.node,
  Ripgrep.node,
  Format.node,
  Truncate.node,
  SessionProcessor.node,
  Image.node,
  SessionCompaction.node,
  SessionRevert.node,
  SessionSummary.node,
  Instruction.node,
  SystemPrompt.node,
  CrossSpawnSpawner.node,
  RuntimeFlags.node,
  testLLMServerNode,
])

const testLayer = LayerNode.compile(supervisorRoot, [
  [SessionSummary.node, summary],
  [LSP.node, lsp],
  [MCP.node, mcp],
  [RuntimeFlags.node, runtimeFlags],
  [InstanceStore.bootstrapNode, noopBootstrapLayer],
])

const it = testEffect(testLayer)

function cfg(url: string) {
  return {
    provider: {
      test: {
        name: "Test",
        id: "test",
        env: [],
        npm: "@ai-sdk/openai-compatible",
        models: {
          "test-model": {
            id: "test-model",
            name: "Test Model",
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: "2025-01-01",
            limit: { context: 100000, output: 10000 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
        options: {
          apiKey: "test-key",
          baseURL: url,
        },
      },
    },
  }
}

const useServerConfig = Effect.fn("supervisor.useServerConfig")(function* () {
  const { directory } = yield* TestInstance
  const llm = yield* TestLLMServer
  yield* Effect.promise(() =>
    Bun.write(
      path.join(directory, "opencode.json"),
      JSON.stringify({ $schema: "https://opencode.ai/config.json", ...cfg(llm.url) }),
    ),
  )
  return { directory, llm }
})

const promptSession = Effect.fn("supervisor.promptSession")(function* (sessionID: SessionID) {
  const prompt = yield* SessionPrompt.Service
  return yield* prompt.prompt({ sessionID, parts: [{ type: "text", text: "hello" }] })
})

const supervisorMessages = Effect.fn("supervisor.messages")(function* () {
  const sessions = yield* Session.Service
  const supervisor = (yield* sessions.list({ limit: 100 })).find((session) => session.agent === "supervisor")
  if (!supervisor) return undefined
  const messages = yield* sessions.messages({ sessionID: supervisor.id })
  return messages.length > 0 ? messages : undefined
})

it.instance("ensure creates the supervisor session and is idempotent", () =>
  Effect.gen(function* () {
    const supervisor = yield* Supervisor.Service
    const sessions = yield* Session.Service

    const first = yield* supervisor.ensure()
    expect(first.agent).toBe("supervisor")
    expect(first.title).toBe("Supervisor")

    const second = yield* supervisor.ensure()
    expect(second.id).toBe(first.id)

    const info = yield* sessions.get(first.id)
    expect(info.agent).toBe("supervisor")
  }),
)

it.instance("ensure reuses an existing supervisor session", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const created = yield* sessions.create({ title: "Supervisor", agent: "supervisor" })

    const supervisor = yield* Supervisor.Service
    const ensured = yield* supervisor.ensure()
    expect(ensured.id).toBe(created.id)
  }),
)

it.instance("wake prompts the supervisor session with a digest", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig()
    const sessions = yield* Session.Service
    const supervisor = yield* Supervisor.Service

    const finished = yield* sessions.create({ title: "Task session", agent: "build" })
    yield* llm.text("wrap up")

    yield* supervisor.wake({
      sessionID: finished.id,
      digest: {
        sessionID: finished.id,
        title: "Task session",
        status: "completed",
        files: [{ file: "src/a.ts", additions: 2, deletions: 1, status: "modified" }],
        messageSummary: "Added a feature.",
      },
    })

    const messages = yield* pollWithTimeout(
      supervisorMessages(),
      "supervisor never got woken",
    )
    expect(messages).toBeDefined()
    const userMsg = messages!.findLast((m) => m.info.role === "user")
    const text = userMsg?.parts
      .filter((p): p is SessionV1.TextPart => p.type === "text")
      .map((p) => p.text)
      .join("\n")
    expect(text).toContain('Session "Task session" finished with status completed')
    expect(text).toContain("src/a.ts")
    expect(text).toContain("Commit and push")
    expect(messages!.some((m) => m.info.role === "assistant")).toBe(true)
  }),
)

it.instance("a finished session wakes the supervisor automatically", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig()
    const sessions = yield* Session.Service

    const chat = yield* sessions.create({ title: "Worker", agent: "build" })
    yield* llm.text("world")
    yield* llm.text("acknowledged")
    yield* promptSession(chat.id)

    const messages = yield* pollWithTimeout(
      supervisorMessages(),
      "supervisor was not woken by the finished session",
    )
    expect(messages).toBeDefined()
    expect(messages!.some((m) => m.info.role === "assistant")).toBe(true)
    const userMsg = messages!.findLast((m) => m.info.role === "user")
    const text = userMsg?.parts
      .filter((p): p is SessionV1.TextPart => p.type === "text")
      .map((p) => p.text)
      .join("\n")
    expect(text).toContain('Session "Worker" finished with status completed')
  }),
)

it.instance("a digest for the supervisor session itself is not re-woken", () =>
  Effect.gen(function* () {
    const { directory, llm } = yield* useServerConfig()
    const sessions = yield* Session.Service
    const events = yield* EventV2Bridge.Service

    const supervisorSession = yield* sessions.create({ title: "Supervisor", agent: "supervisor" })
    yield* llm.text("ok")

    yield* events.publish(SessionDigest.Digest, {
      sessionID: supervisorSession.id,
      digest: {
        sessionID: supervisorSession.id,
        title: "Supervisor",
        status: "completed",
      },
    })

    yield* Effect.sleep("300 millis")
    const messages = yield* sessions.messages({ sessionID: supervisorSession.id })
    // The supervisor session itself must not be prompted by its own digest.
    expect(messages.filter((m) => m.info.role === "user")).toHaveLength(0)
    void directory
  }),
)

it.instance("supervisor_ask answers a question through the channel", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig()
    const sessions = yield* Session.Service
    const supervisorAsk = yield* SupervisorAsk.Service

    const chat = yield* sessions.create({ title: "Worker", agent: "build" })
    yield* llm.text("Yes, that path is allowed with review.")
    const answer = yield* supervisorAsk.ask({
      sessionID: chat.id,
      question: "Is touching src/foo.ts allowed?",
    })
    expect(answer).toContain("Yes, that path is allowed")
  }),
)

it.instance("a session can call the supervisor_ask tool mid-run", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig()
    const sessions = yield* Session.Service

    const chat = yield* sessions.create({ title: "Worker", agent: "build" })
    yield* llm.tool("supervisor_ask", { question: "Is touching src/foo.ts allowed?" })
    yield* llm.text("Yes, it is allowed.")
    yield* llm.text("great")
    yield* promptSession(chat.id)

    const msgs = yield* sessions.messages({ sessionID: chat.id })
    const last = msgs.findLast((m) => m.info.role === "assistant")
    const text = last?.parts
      .filter((p): p is SessionV1.TextPart => p.type === "text")
      .map((p) => p.text)
      .join("\n")
    expect(text).toContain("great")

    const supervisor = (yield* sessions.list({ limit: 100 })).find((s) => s.agent === "supervisor")
    expect(supervisor).toBeDefined()
    const supMessages = yield* sessions.messages({ sessionID: supervisor!.id })
    const supText = supMessages
      .flatMap((m) => m.parts.filter((p): p is SessionV1.TextPart => p.type === "text").map((p) => p.text))
      .join("\n")
    expect(supText).toContain("Is touching src/foo.ts allowed?")
  }),
)

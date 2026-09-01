import { SessionV1 } from "@opencode-ai/core/v1/session"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { EventV2Bridge } from "@/event-v2-bridge"
import { describe, expect, test } from "bun:test"
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
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

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
    startAuth: () => Effect.die("unexpected MCP auth in read-only tests"),
    authenticate: () => Effect.die("unexpected MCP auth in read-only tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in read-only tests"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const runtimeFlags = RuntimeFlags.layer({ experimentalEventSystem: true })
const testLLMServerNode = LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })

const readOnlyRoot = LayerNode.group([
  SessionPrompt.node,
  SessionTracker.node,
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

const testLayer = LayerNode.compile(readOnlyRoot, [
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

const useServerConfig = Effect.fn("readOnly.useServerConfig")(function* () {
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

const promptSession = Effect.fn("readOnly.promptSession")(function* (sessionID: SessionID) {
  const prompt = yield* SessionPrompt.Service
  return yield* prompt.prompt({ sessionID, parts: [{ type: "text", text: "hello" }] })
})

describe("read-only sessions", () => {
  test("readOnlyRules deny mutating tools and allow observation", () => {
    const ruleset = Permission.merge(Permission.fromConfig({ "*": "allow" }), Session.readOnlyRules)
    const action = (permission: string) => Permission.evaluate(permission, "*", ruleset).action

    for (const allowed of [
      "read",
      "grep",
      "glob",
      "list",
      "delegate",
      "task",
      "question",
      "session",
      "supervisor_ask",
      "websearch",
      "webfetch",
      "skill",
      "todo",
      "lsp",
    ]) {
      expect(action(allowed)).toBe("allow")
    }
    for (const denied of ["edit", "write", "bash", "apply_patch", "worktree", "session_wrapup", "plan_enter", "doom_loop"]) {
      expect(action(denied)).toBe("deny")
    }
  })

  it.instance("readOnly is persisted and toggleable", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "RO", agent: "build", readOnly: true })
      expect((yield* sessions.get(session.id)).readOnly).toBe(true)

      yield* sessions.setReadOnly({ sessionID: session.id, readOnly: false })
      expect((yield* sessions.get(session.id)).readOnly).toBe(false)

      yield* sessions.setReadOnly({ sessionID: session.id, readOnly: true })
      expect((yield* sessions.get(session.id)).readOnly).toBe(true)
    }),
  )

  it.instance("a read-only session's edit/write tool call is denied", () =>
    Effect.gen(function* () {
      const { directory, llm } = yield* useServerConfig()
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "ReadOnly", agent: "build", readOnly: true })

      yield* llm.tool("write", { filePath: path.join(directory, "notes.txt"), content: "should not land" })
      yield* llm.text("done")
      yield* promptSession(chat.id)

      const messages = yield* sessions.messages({ sessionID: chat.id })
      const writeCall = messages
        .flatMap((m) => m.parts)
        .find((p): p is SessionV1.ToolPart => p.type === "tool" && p.tool === "write")
      expect(writeCall).toBeDefined()
      const state = writeCall!.state
      expect(state.status).toBe("error")
      expect(String(state.status === "error" ? state.error : "")).toContain("prevents you")
    }),
  )
})

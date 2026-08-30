import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import * as fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { Session } from "@/session/session"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageV2 } from "../../src/session/message-v2"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionSummary } from "../../src/session/summary"
import { BackgroundJob } from "@/background/job"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { Git } from "@/git"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { disposeAllInstances, provideTmpdirServer } from "../fixture/fixture"
import { testEffect, pollWithTimeout, awaitWithTimeout } from "../lib/effect"
import { TestLLMServer, reply, raw } from "../lib/llm-server"
import { SessionID } from "../../src/session/schema"

const callChunk = (delta: Record<string, unknown>) => ({
  id: "chatcmpl-test",
  object: "chat.completion.chunk",
  choices: [{ delta }],
})

const finishChunk = (reason: string) => ({
  id: "chatcmpl-test",
  object: "chat.completion.chunk",
  choices: [{ delta: {}, finish_reason: reason }],
})

const parallelDelegates = (a: { input: unknown }, b: { input: unknown }) =>
  raw({
    chunks: [
      callChunk({
        role: "assistant",
        tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "delegate", arguments: "" } }],
      }),
      callChunk({
        tool_calls: [{ index: 0, function: { arguments: JSON.stringify(a.input) } }],
      }),
      callChunk({
        tool_calls: [{ index: 1, id: "call_2", type: "function", function: { name: "delegate", arguments: "" } }],
      }),
      callChunk({
        tool_calls: [{ index: 1, function: { arguments: JSON.stringify(b.input) } }],
      }),
      finishChunk("tool_calls"),
    ],
  })

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
    startAuth: () => Effect.die("unexpected MCP auth"),
    authenticate: () => Effect.die("unexpected MCP auth"),
    finishAuth: () => Effect.die("unexpected MCP auth"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
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

const root = LayerNode.group([
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  SessionSummary.node,
  Database.node,
  BackgroundJob.node,
  CrossSpawnSpawner.node,
  Git.node,
  LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
])
const it = testEffect(
  LayerNode.compile(root, [
    [InstanceStore.bootstrapNode, InstanceBootstrap.node],
    [MCP.node, mcp],
    [LSP.node, lsp],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
  ]),
)

afterEach(() => disposeAllInstances())

const providerCfg = (url: string) => ({
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
})

const body = (input: unknown) => JSON.stringify(input)

const delegateInput = (overrides: { description: string; prompt: string; worktree?: boolean }) => ({
  description: overrides.description,
  prompt: overrides.prompt,
  subagent_type: "build",
  ...(overrides.worktree === undefined ? {} : { worktree: overrides.worktree }),
})

const injectedTaskResult = (text: string) => {
  const match = text.match(/<task id="([^"]+)" state="completed" worktree="([^"]+)" branch="([^"]+)">/)
  return match ? { sessionID: match[1], worktree: match[2], branch: match[3] } : undefined
}

describe("tool.delegate", () => {
  it.live(
    "delegates a subagent into its own worktree while the parent keeps running",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ dir, llm }) {
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const jobs = yield* BackgroundJob.Service
          const gitSvc = yield* Git.Service

          const session = yield* sessions.create({
            title: "delegate test",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })

          yield* gitSvc.run(["add", "-A"], { cwd: dir })
          yield* gitSvc.run(["commit", "-m", "fixture config"], { cwd: dir })

          let releaseChild: () => void = () => {}
          const childGate = new Promise<void>((resolve) => {
            releaseChild = resolve
          })

          yield* llm.toolMatch(
            (hit) => body(hit.body).includes("delegate the work"),
            "delegate",
            delegateInput({
              description: "write child file",
              prompt: "create the file child-output.txt with content hello",
              worktree: true,
            }),
          )
          yield* llm.textMatch((hit) => body(hit.body).includes('state=\\"running\\"'), "ack")
          yield* llm.pushMatch(
            (hit) => body(hit.body).includes("child-output") && !body(hit.body).includes('state=\\"running\\"'),
            reply().tool("write", { filePath: "child-output.txt", content: "hello" }).wait(childGate).item(),
          )
          yield* llm.textMatch(
            (hit) => body(hit.body).includes("child-output") && !body(hit.body).includes('state=\\"running\\"'),
            "child done",
          )
          yield* llm.textMatch((hit) => body(hit.body).includes("continue working"), "parent continues")
          yield* llm.textMatch((hit) => body(hit.body).includes('state=\\"completed\\"'), "merge the branch")

          yield* prompt.prompt({
            sessionID: session.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "delegate the work" }],
          })
          const first = yield* prompt.loop({ sessionID: session.id })
          expect(first.info.role).toBe("assistant")
          expect(first.parts.some((part) => part.type === "text" && part.text === "ack")).toBe(true)

          const job = yield* pollWithTimeout(
            jobs.list().pipe(
              Effect.map((list) => list.find((item) => item.metadata?.worktree)),
            ),
            "delegate job not found",
          )
          const worktree = job.metadata?.worktree as { directory: string; branch: string }
          expect(worktree.directory).toBeDefined()
          expect(worktree.branch).toMatch(/^opencode\//)

          const child = yield* sessions.get(SessionID.make(String(job.metadata?.sessionId)))
          const real = (input: string) => Effect.promise(() => fs.realpath(input))
          expect(yield* real(child.directory)).toBe(yield* real(worktree.directory))

          yield* awaitWithTimeout(
            llm.wait(3),
            "child request did not reach the server",
            "10 seconds",
          )
          expect(job.metadata?.worktree).toBeDefined()

          const second = yield* prompt.prompt({
            sessionID: session.id,
            parts: [{ type: "text", text: "continue working" }],
          })
          expect(second.info.role).toBe("assistant")
          expect(second.parts.some((part) => part.type === "text" && part.text === "parent continues")).toBe(true)

          yield* Effect.sync(() => releaseChild())

          const injected = yield* pollWithTimeout(
            MessageV2.filterCompactedEffect(session.id).pipe(
              Effect.map((msgs) =>
                msgs
                  .filter((msg) => msg.info.role === "user")
                  .flatMap((msg) => msg.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])))
                  .map((text) => injectedTaskResult(text))
                  .find((result) => result?.branch === worktree.branch),
              ),
            ),
            "delegate result not injected",
            "10 seconds",
          )
          expect(injected?.worktree).toBe(worktree.directory)
          expect(injected?.sessionID).toBe(child.id)

          expect(
            yield* Effect.promise(() =>
              fs.access(path.join(worktree.directory, "child-output.txt")).then(() => true).catch(() => false),
            ),
          ).toBe(true)

          const merged = yield* gitSvc.run(["merge", worktree.branch], { cwd: dir })
          expect(merged.exitCode).toBe(0)
          expect(
            yield* Effect.promise(() =>
              fs.access(path.join(dir, "child-output.txt")).then(() => true).catch(() => false),
            ),
          ).toBe(true)

          const done = yield* awaitWithTimeout(
            jobs.wait({ id: job.id }),
            "delegate job did not complete",
            "30 seconds",
          )
          expect(done.info?.status).toBe("completed")
        }),
        { git: true, config: providerCfg },
      ),
    30_000,
  )

  it.live(
    "runs two delegates in parallel worktrees and merges both branches",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ dir, llm }) {
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const jobs = yield* BackgroundJob.Service
          const gitSvc = yield* Git.Service

          const session = yield* sessions.create({
            title: "parallel delegate test",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })

          yield* gitSvc.run(["add", "-A"], { cwd: dir })
          yield* gitSvc.run(["commit", "-m", "fixture config"], { cwd: dir })

          yield* llm.pushMatch(
            (hit) => body(hit.body).includes("delegate two pieces"),
            parallelDelegates(
              {
                input: delegateInput({
                  description: "parallel a",
                  prompt: "create the file parallel-a-output.txt with content A",
                  worktree: true,
                }),
              },
              {
                input: delegateInput({
                  description: "parallel b",
                  prompt: "create the file parallel-b-output.txt with content B",
                  worktree: true,
                }),
              },
            ),
          )
          yield* llm.textMatch((hit) => body(hit.body).includes('state=\\"running\\"'), "ack")

          let releaseA: () => void = () => {}
          const gateA = new Promise<void>((resolve) => {
            releaseA = resolve
          })
          let releaseB: () => void = () => {}
          const gateB = new Promise<void>((resolve) => {
            releaseB = resolve
          })

          yield* llm.pushMatch(
            (hit) => body(hit.body).includes("parallel-a-output") && !body(hit.body).includes('state=\\"running\\"'),
            reply().tool("write", { filePath: "parallel-a-output.txt", content: "A" }).wait(gateA).item(),
          )
          yield* llm.pushMatch(
            (hit) => body(hit.body).includes("parallel-b-output") && !body(hit.body).includes('state=\\"running\\"'),
            reply().tool("write", { filePath: "parallel-b-output.txt", content: "B" }).wait(gateB).item(),
          )
          yield* llm.textMatch(
            (hit) => body(hit.body).includes("parallel-a-output") && !body(hit.body).includes('state=\\"running\\"'),
            "a done",
          )
          yield* llm.textMatch(
            (hit) => body(hit.body).includes("parallel-b-output") && !body(hit.body).includes('state=\\"running\\"'),
            "b done",
          )
          yield* llm.textMatch((hit) => body(hit.body).includes('state=\\"completed\\"'), "merge a")
          yield* llm.textMatch((hit) => body(hit.body).includes('state=\\"completed\\"'), "merge b")
          yield* llm.textMatch((hit) => body(hit.body).includes('state=\\"completed\\"'), "merge c")

          yield* prompt.prompt({
            sessionID: session.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "delegate two pieces" }],
          })
          const first = yield* prompt.loop({ sessionID: session.id })
          expect(first.parts.some((part) => part.type === "text" && part.text === "ack")).toBe(true)

          const running = yield* pollWithTimeout(
            jobs.list().pipe(
              Effect.map((list) => list.filter((item) => item.metadata?.worktree && item.status === "running")),
            ),
            "delegate jobs not found",
          )
          expect(running).toHaveLength(2)
          const branches = running.map((job) => (job.metadata?.worktree as { branch: string }).branch)
          expect(new Set(branches).size).toBe(2)

          yield* awaitWithTimeout(
            llm.wait(4),
            "both child requests did not reach the server",
            "10 seconds",
          )
          yield* Effect.sync(() => {
            releaseA()
            releaseB()
          })

          const injected = yield* pollWithTimeout(
            MessageV2.filterCompactedEffect(session.id).pipe(
              Effect.map((msgs) => {
                const results = msgs
                  .filter((msg) => msg.info.role === "user")
                  .flatMap((msg) => msg.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])))
                  .map((text) => injectedTaskResult(text))
                  .filter((result): result is NonNullable<typeof result> => result !== undefined)
                return results.length >= 2 ? results : undefined
              }),
            ),
            "both delegate results not injected",
            "15 seconds",
          )
          expect(injected.map((result) => result.branch).sort()).toEqual(branches.sort())
          expect(new Set(injected.map((result) => result.worktree)).size).toBe(2)

          for (const result of injected) {
            const file = result.branch.includes("parallel-a") ? "parallel-a-output.txt" : "parallel-b-output.txt"
            expect(
              yield* Effect.promise(() =>
                fs.access(path.join(result.worktree, file)).then(() => true).catch(() => false),
              ),
            ).toBe(true)
          }

          for (const branch of branches) {
            const merged = yield* gitSvc.run(["merge", branch], { cwd: dir })
            expect(merged.exitCode).toBe(0)
          }
          expect(
            yield* Effect.promise(() =>
              fs.access(path.join(dir, "parallel-a-output.txt")).then(() => true).catch(() => false),
            ),
          ).toBe(true)
          expect(
            yield* Effect.promise(() =>
              fs.access(path.join(dir, "parallel-b-output.txt")).then(() => true).catch(() => false),
            ),
          ).toBe(true)

          for (const job of running) {
            const done = yield* awaitWithTimeout(
              jobs.wait({ id: job.id }),
              "delegate job did not complete",
              "30 seconds",
            )
            expect(done.info?.status).toBe("completed")
          }
        }),
        { git: true, config: providerCfg },
      ),
    30_000,
  )
})

// LLM benchmark harness: drives the REAL V1 session loop (prompt admission ->
// provider stream -> tool loop) against the mock LLM server, using the
// deepseek/deepseek-v4-flash model configuration from the models fixture.
//
// Usage: bun run script/bench-llm.ts [scenario ...]
//   - no args: run all scenarios
//   - e.g. "bun run script/bench-llm.ts chat-simple": run only that scenario
//
// Emits METRIC bench_llm_<scenario>_<name> <value> lines, one per metric.
// Usage tokens are scripted on the mock; est_cost_usd comes from the session's
// own getUsage() accounting (real deepseek-v4-flash cost constants).
// Per-turn input growth is measured from the actual request bodies the loop
// projects, estimated at ~4 chars/token (the same heuristic compaction uses).
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Effect, Layer, Scope } from "effect"
import fs from "fs/promises"
import path from "path"
import { LSP } from "../src/lsp/lsp"
import { MCP } from "../src/mcp"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionPrompt } from "../src/session/prompt"
import { Session } from "../src/session/session"
import { SessionSummary } from "../src/session/summary"
import { MessageV2 } from "../src/session/message-v2"
import { SessionID } from "../src/session/schema"
import { Token } from "@/util/token"
import { TestLLMServer, reply } from "../test/lib/llm-server"
import { provideTmpdirServer } from "../test/fixture/fixture"

const PROVIDER_ID = "deepseek"
const MODEL_ID = "deepseek-v4-flash"
const modelRef = {
  providerID: ProviderV2.ID.make(PROVIDER_ID),
  modelID: ModelV2.ID.make(MODEL_ID),
}

const MODELS_FIXTURE = JSON.parse(
  await Bun.file(path.join(import.meta.dir, "../test/tool/fixtures/models-api.json")).text(),
) as Record<string, ModelsDev.Provider>
const providerFixture = MODELS_FIXTURE[PROVIDER_ID]
if (!providerFixture) throw new Error(`missing provider ${PROVIDER_ID} in models fixture`)
const modelFixture = providerFixture.models[MODEL_ID]
if (!modelFixture) throw new Error(`missing model ${MODEL_ID} in models fixture`)

type ConfigModel = NonNullable<NonNullable<ConfigV1.Info["provider"]>[string]["models"]>[string]

function configModel(model: ModelsDev.Model) {
  return {
    id: model.id,
    name: model.name,
    family: model.family,
    release_date: model.release_date,
    attachment: model.attachment,
    reasoning: model.reasoning,
    temperature: model.temperature,
    tool_call: model.tool_call,
    interleaved: model.interleaved,
    cost: model.cost ? { ...model.cost, tiers: undefined } : undefined,
    limit: model.limit,
    modalities: model.modalities,
    status: model.status,
    provider: model.provider,
  }
}

function providerCfg(url: string): Partial<ConfigV1.Info> {
  return {
    enabled_providers: [PROVIDER_ID],
    provider: {
      [PROVIDER_ID]: {
        name: "DeepSeek",
        id: PROVIDER_ID,
        env: [],
        npm: "@ai-sdk/openai-compatible",
        models: { [MODEL_ID]: configModel(modelFixture) as ConfigModel },
        options: { apiKey: "bench-key", baseURL: url },
      },
    },
  }
}

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
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
    startAuth: () => Effect.die("unexpected MCP auth in bench"),
    authenticate: () => Effect.die("unexpected MCP auth in bench"),
    finishAuth: () => Effect.die("unexpected MCP auth in bench"),
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
  EventV2Bridge.node,
  CrossSpawnSpawner.node,
  LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
])
const env = LayerNode.compile(root, [
  [MCP.node, mcp],
  [LSP.node, lsp],
  [SessionSummary.node, summary],
  [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
])

const ALLOW = [{ permission: "*" as const, pattern: "*" as const, action: "allow" as const }]

let metrics: Array<{ name: string; value: string }> = []

function emit(scenario: string, name: string, value: number | string) {
  const formatted = typeof value === "number" ? (Number.isInteger(value) ? String(value) : value.toFixed(6)) : value
  metrics.push({ name: `bench_llm_${scenario}_${name}`, value: formatted })
}

function isTitleRequest(body: Record<string, unknown>) {
  return JSON.stringify(body).includes("Generate a title for this conversation")
}

function sumTokens(msgs: SessionV1.WithParts[]) {
  const tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  for (const msg of msgs) {
    if (msg.info.role !== "assistant") continue
    tokens.input += msg.info.tokens.input
    tokens.output += msg.info.tokens.output
    tokens.reasoning += msg.info.tokens.reasoning
    tokens.cacheRead += msg.info.tokens.cache.read
    tokens.cacheWrite += msg.info.tokens.cache.write
    tokens.total += msg.info.tokens.total ?? 0
  }
  return tokens
}

function sumCost(msgs: SessionV1.WithParts[]) {
  let cost = 0
  for (const msg of msgs) {
    if (msg.info.role !== "assistant") continue
    cost += msg.info.cost
  }
  return cost
}

const readMessages = (sessionID: SessionID) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    return yield* MessageV2.filterCompactedEffect(sessionID).pipe(
      Effect.provideService(Database.Service, database),
      Effect.orDie,
    )
  })

type Scenario = (input: { dir: string; llm: TestLLMServer["Service"] }) => Effect.Effect<void, unknown, unknown>

const chatSimple = Effect.fn("bench.chat-simple")(function* ({ llm }: { dir: string; llm: TestLLMServer["Service"] }) {
  yield* llm.reset
  const prompt = yield* SessionPrompt.Service
  const sessions = yield* Session.Service
  const events = yield* EventV2Bridge.Service

  const session = yield* sessions.create({ title: "bench chat-simple", permission: ALLOW })

  let ttft: number | undefined
  const off = yield* events.listen((evt) => {
    if (evt.type !== MessageV2.Event.PartDelta.type) return Effect.void
    const data = evt.data as { sessionID?: string }
    if (data.sessionID !== session.id) return Effect.void
    ttft ??= performance.now()
    return Effect.void
  })
  yield* Effect.addFinalizer(() => off)

  yield* llm.text("Hello from the mock LLM", { usage: { input: 2500, output: 50 } })

  const start = performance.now()
  yield* prompt.prompt({
    sessionID: session.id,
    agent: "build",
    model: modelRef,
    parts: [{ type: "text", text: "Say hello" }],
  })
  const wall = performance.now() - start

  const msgs = yield* readMessages(session.id)
  const tokens = sumTokens(msgs)
  const turns = (yield* llm.inputs).filter((body) => !isTitleRequest(body))

  emit("chat-simple", "turns", turns.length)
  emit("chat-simple", "input_tokens", tokens.input)
  emit("chat-simple", "output_tokens", tokens.output)
  emit("chat-simple", "cache_read_tokens", tokens.cacheRead)
  emit("chat-simple", "cache_write_tokens", tokens.cacheWrite)
  emit("chat-simple", "total_tokens", tokens.total)
  emit("chat-simple", "est_cost_usd", sumCost(msgs).toFixed(6))
  emit("chat-simple", "wall_ms", wall.toFixed(1))
  if (ttft !== undefined) emit("chat-simple", "ttft_ms", (ttft - start).toFixed(1))
})

const toolLoop = Effect.fn("bench.tool-loop")(function* ({ dir, llm }: { dir: string; llm: TestLLMServer["Service"] }) {
  yield* llm.reset
  const prompt = yield* SessionPrompt.Service
  const sessions = yield* Session.Service

  const target = path.join(dir, "a.txt")
  yield* Effect.promise(() => fs.writeFile(target, "hello world content from file a"))
  yield* Effect.promise(() => fs.writeFile(path.join(dir, "b.txt"), "second file content"))

  const session = yield* sessions.create({ title: "bench tool-loop", permission: ALLOW })

  // Tool-call turns report usage too (real providers do): script values close
  // to the measured projection so per-turn token accounting is complete.
  yield* llm.pushMatch(
    (hit) => JSON.stringify(hit.body).includes("find the file"),
    reply().tool("glob", { pattern: "**/*.txt", path: dir }).usage({ input: 2500, output: 30 }).item(),
  )
  yield* llm.pushMatch(
    (hit) => JSON.stringify(hit.body).includes("a.txt"),
    reply().tool("read", { filePath: target }).usage({ input: 2600, output: 30 }).item(),
  )
  yield* llm.textMatch(
    (hit) => JSON.stringify(hit.body).includes("hello world content"),
    "Found the file and read it.",
    { usage: { input: 2700, output: 24 } },
  )

  const start = performance.now()
  yield* prompt.prompt({
    sessionID: session.id,
    agent: "build",
    model: modelRef,
    parts: [{ type: "text", text: "find the file and read it" }],
  })
  const wall = performance.now() - start

  const msgs = yield* readMessages(session.id)
  const tokens = sumTokens(msgs)
  const turns = (yield* llm.inputs).filter((body) => !isTitleRequest(body))

  emit("tool-loop", "turns", turns.length)
  for (const [index, body] of turns.entries()) {
    const projected = JSON.stringify(body["messages"] ?? {})
    emit("tool-loop", `turn_${index + 1}_input_chars`, projected.length)
    emit("tool-loop", `turn_${index + 1}_input_est_tokens`, Token.estimate(projected))
  }
  const assistants = msgs.filter((msg): msg is SessionV1.WithParts & { info: SessionV1.Assistant } =>
    msg.info.role === "assistant",
  )
  for (const [index, msg] of assistants.entries()) {
    emit("tool-loop", `turn_${index + 1}_input_tokens`, msg.info.tokens.input)
    emit("tool-loop", `turn_${index + 1}_output_tokens`, msg.info.tokens.output)
  }
  emit("tool-loop", "input_tokens", tokens.input)
  emit("tool-loop", "output_tokens", tokens.output)
  emit("tool-loop", "cache_read_tokens", tokens.cacheRead)
  emit("tool-loop", "cache_write_tokens", tokens.cacheWrite)
  emit("tool-loop", "total_tokens", tokens.total)
  emit("tool-loop", "est_cost_usd", sumCost(msgs).toFixed(6))
  emit("tool-loop", "wall_ms", wall.toFixed(1))
})

const longContext = Effect.fn("bench.long-context")(function* ({ llm }: { dir: string; llm: TestLLMServer["Service"] }) {
  yield* llm.reset
  const prompt = yield* SessionPrompt.Service
  const sessions = yield* Session.Service

  const seed = "seed ".repeat(12_000)
  const session = yield* sessions.create({ title: "bench long-context", permission: ALLOW })

  yield* prompt.prompt({
    sessionID: session.id,
    agent: "build",
    model: modelRef,
    noReply: true,
    parts: [{ type: "text", text: seed }],
  })

  // Follow-up turn overflows the deepseek context budget (usable = 1M - 20k
  // reserved), so the loop must auto-compact before continuing.
  yield* llm.textMatch(
    (hit) => JSON.stringify(hit.body).includes("Summarize the key points"),
    "Here is a summary of the conversation so far.",
    { usage: { input: 960_000, output: 40_000 } },
  )
  yield* llm.textMatch(
    (hit) => JSON.stringify(hit.body).includes("Here is the conversation so far"),
    "The seed text repeats the word seed many times.",
    { usage: { input: 60_000, output: 200 } },
  )
  yield* llm.textMatch(
    (hit) => JSON.stringify(hit.body).includes("Continue if you have next steps"),
    "All done.",
    { usage: { input: 1_500, output: 30 } },
  )

  const start = performance.now()
  yield* prompt.prompt({
    sessionID: session.id,
    agent: "build",
    model: modelRef,
    parts: [{ type: "text", text: "Summarize the key points" }],
  })
  const wall = performance.now() - start

  const msgs = yield* readMessages(session.id)
  const tokens = sumTokens(msgs)
  const turns = (yield* llm.inputs).filter((body) => !isTitleRequest(body))
  const compacted = msgs.some((msg) => msg.info.role === "assistant" && msg.info.summary === true)

  emit("long-context", "seed_chars", seed.length)
  emit("long-context", "compaction_triggered", compacted ? 1 : 0)
  emit("long-context", "turns", turns.length)
  for (const [index, body] of turns.entries()) {
    const projected = JSON.stringify(body["messages"] ?? {})
    emit("long-context", `turn_${index + 1}_input_chars`, projected.length)
    emit("long-context", `turn_${index + 1}_input_est_tokens`, Token.estimate(projected))
  }
  emit("long-context", "input_tokens", tokens.input)
  emit("long-context", "output_tokens", tokens.output)
  emit("long-context", "cache_read_tokens", tokens.cacheRead)
  emit("long-context", "cache_write_tokens", tokens.cacheWrite)
  emit("long-context", "total_tokens", tokens.total)
  emit("long-context", "est_cost_usd", sumCost(msgs).toFixed(6))
  emit("long-context", "wall_ms", wall.toFixed(1))
})

function scenarioInput(name: string, input: { dir: string; llm: TestLLMServer["Service"] }) {
  if (name === "tool-loop") return toolLoop(input)
  if (name === "long-context") return longContext(input)
  return chatSimple(input)
}

// Mirrors the test runner in test/lib/effect.ts: the layer type is generic so
// provide() can reduce the effect's requirements to never even when individual
// scenario effects carry an opaque requirement set.
const runWithEnv = <A, E, R, E2>(value: Effect.Effect<A, E, R | Scope.Scope>, layer: Layer.Layer<R, E2>) =>
  Effect.runPromise(
    value.pipe(
      Effect.scoped,
      Effect.provide(layer),
    ),
  )

export async function main(argv: string[]) {
  const known = ["chat-simple", "tool-loop", "long-context"]
  const invalid = argv.filter((arg) => !known.includes(arg))
  if (invalid.length > 0) {
    console.error(`[bench-llm] unknown scenario${invalid.length > 1 ? "s" : ""}: ${invalid.join(", ")}`)
    console.error(`[bench-llm] known scenarios: ${known.join(", ")}`)
    process.exit(1)
  }
  const selected = argv.filter((arg) => known.includes(arg))
  const names = selected.length > 0 ? selected : known

  const run = Effect.gen(function* () {
    for (const name of names) {
      console.log(`[bench-llm] ${name}`)
      metrics = []
      yield* provideTmpdirServer(({ dir, llm }) => scenarioInput(name, { dir, llm }), {
        git: true,
        config: providerCfg,
      })
      for (const metric of metrics) console.log(`METRIC ${metric.name} ${metric.value}`)
    }
  })

  try {
    await runWithEnv(run, env)
    // The session stack leaves open handles (watchers, HTTP server, LSP);
    // exit explicitly so `bun run bench:llm` terminates deterministically.
    process.exit(0)
  } catch (error) {
    console.error("[bench-llm] failed:", error)
    process.exit(1)
  }
}

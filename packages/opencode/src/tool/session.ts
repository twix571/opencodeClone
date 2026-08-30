import { Effect, Option, Schema } from "effect"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import * as Tool from "./tool"
import DESCRIPTION from "./session.txt"
import { Session } from "@/session/session"
import { SessionID } from "../session/schema"

const TOOL_OUTPUT_LEN = 800

const ListParams = Schema.Struct({
  action: Schema.Literals(["list"]).annotate({ description: "List recent sessions" }),
  scope: Schema.optional(Schema.Literals(["project", "global"])).annotate({
    description:
      '"project" lists sessions in the current project (default); "global" lists sessions across every project on this server.',
  }),
  directory: Schema.optional(Schema.String).annotate({
    description: 'Filter by project directory. Only used with scope "global".',
  }),
  limit: Schema.optional(NonNegativeInt).annotate({
    description: "Maximum number of sessions to return (default 20).",
  }),
})

const GetParams = Schema.Struct({
  action: Schema.Literals(["get"]).annotate({ description: "Read a session's conversation" }),
  sessionID: Schema.String.annotate({ description: "The session ID to read." }),
  limit: Schema.optional(NonNegativeInt).annotate({
    description: "Only include the last N messages of the conversation.",
  }),
  role: Schema.optional(Schema.Literals(["user", "assistant"])).annotate({
    description: 'Only include messages of this role ("user" skims just the prompts).',
  }),
  toolOutput: Schema.optional(Schema.Boolean).annotate({
    description: "Include tool inputs and outputs (default true, truncated).",
  }),
  reasoning: Schema.optional(Schema.Boolean).annotate({
    description: "Include reasoning parts (default false).",
  }),
})

export const Parameters = Schema.Union([ListParams, GetParams])

type GetOpts = {
  limit?: number
  role?: "user" | "assistant"
  toolOutput: boolean
  reasoning: boolean
}

function truncate(value: string, len: number) {
  if (value.length <= len) return value
  return `${value.slice(0, len)}…`
}

function fmtTime(t?: number) {
  if (!t) return ""
  return new Date(t).toISOString()
}

function fmtModel(model?: Session.Info["model"]) {
  if (!model) return ""
  return `${model.providerID}/${model.id}`
}

function sessionRow(info: Session.Info) {
  return [
    `- ${info.id} · ${info.title} · agent: ${info.agent ?? "-"}`,
    `  ${info.directory} · updated: ${fmtTime(info.time.updated)}${info.parentID ? ` · parent: ${info.parentID}` : ""}`,
  ].join("\n")
}

function renderParts(parts: SessionV1.Part[], opts: GetOpts) {
  const lines: string[] = []
  for (const part of parts) {
    switch (part.type) {
      case "text":
        if (part.text) lines.push(part.text)
        break
      case "reasoning":
        if (opts.reasoning) lines.push(`_reasoning:_ ${truncate(part.text, 400)}`)
        break
      case "tool": {
        const state = part.state
        const title = "title" in state && state.title ? ` · ${state.title}` : ""
        lines.push(`tool: ${part.tool} [${state.status}]${title}`)
        if (!opts.toolOutput) break
        const input = truncate(JSON.stringify(state.input ?? {}), TOOL_OUTPUT_LEN)
        if (input) lines.push(`  input: ${input}`)
        if (state.status === "completed") {
          const output = truncate(state.output ?? "(no output)", TOOL_OUTPUT_LEN)
          lines.push(`  output: ${output}`)
        } else if (state.status === "error") {
          lines.push(`  error: ${truncate(state.error, TOOL_OUTPUT_LEN)}`)
        }
        break
      }
      case "step-finish": {
        const tokens = part.tokens
        lines.push(
          `_step: cost $${part.cost.toFixed(4)}${tokens ? ` tokens in ${tokens.input}/out ${tokens.output}` : ""}_`,
        )
        break
      }
      case "file":
        lines.push(`[file: ${part.filename ?? "attachment"}${part.mime ? ` (${part.mime})` : ""}]`)
        break
      case "compaction":
        lines.push("_compacted context_")
        break
      case "subtask":
        lines.push(`_subtask: ${part.description}_`)
        break
      case "agent":
        lines.push(`[agent: ${part.name}]`)
        break
      default:
        break
    }
  }
  return lines
}

function renderMessage(message: SessionV1.WithParts, opts: GetOpts) {
  const info = message.info
  const lines =
    info.role === "user"
      ? [`## user${info.agent ? ` · ${info.agent}` : ""} · ${fmtTime(info.time.created)}`]
      : [`## assistant · ${info.providerID}/${info.modelID} · ${fmtTime(info.time.created)}`]
  return lines.concat(renderParts(message.parts, opts))
}

export const SessionTool = Tool.define<typeof Parameters, { count?: number }, Session.Service>(
  "session",
  Effect.gen(function* () {
    const sessions = yield* Session.Service

    const list = Effect.fn("SessionTool.list")(function* (
      params: Schema.Schema.Type<typeof ListParams>,
      ctx: Tool.Context,
    ) {
      yield* ctx.ask({
        permission: "session",
        patterns: ["list"],
        always: ["*"],
        metadata: { action: "list", scope: params.scope ?? "project" },
      })

      if (params.scope === "global") {
        const items = yield* sessions.listGlobal({
          ...(params.directory ? { directory: params.directory } : {}),
          limit: params.limit ?? 20,
        })
        const rows = items.map((item) => {
          const project = item.project?.name ? ` · project: ${item.project.name}` : ""
          return sessionRow(item) + project
        })
        return {
          title: `sessions (${rows.length})`,
          metadata: { count: rows.length },
          output:
            rows.length === 0
              ? "No sessions found."
              : [`${rows.length} session${rows.length === 1 ? "" : "s"}`, "", ...rows].join("\n"),
        }
      }

      const items = yield* sessions.list({ limit: params.limit ?? 20 })
      return {
        title: `sessions (${items.length})`,
        metadata: { count: items.length },
        output:
          items.length === 0
            ? "No sessions found in the current project."
            : [`${items.length} session${items.length === 1 ? "" : "s"} in the current project`, "", ...items.map(sessionRow)].join(
                "\n",
              ),
      }
    })

    const get = Effect.fn("SessionTool.get")(function* (params: Schema.Schema.Type<typeof GetParams>, ctx: Tool.Context) {
      yield* ctx.ask({
        permission: "session",
        patterns: [`get:${params.sessionID}`],
        always: ["*"],
        metadata: { action: "get", sessionID: params.sessionID },
      })

      const sessionID = yield* Schema.decodeUnknownOption(SessionID)(params.sessionID).pipe(
        Option.match({
          onNone: () => Effect.fail(new Error(`Invalid session ID: ${params.sessionID}`)),
          onSome: (id) => Effect.succeed(id),
        }),
      )
      const info = yield* sessions.get(sessionID).pipe(
        Effect.catch(() => Effect.fail(new Error(`Session not found: ${params.sessionID}`))),
      )
      const opts: GetOpts = {
        limit: params.limit,
        role: params.role,
        toolOutput: params.toolOutput ?? true,
        reasoning: params.reasoning ?? false,
      }
      const messages = yield* sessions.messages({ sessionID: info.id, limit: opts.limit }).pipe(
        Effect.catch(() => Effect.fail(new Error(`Failed to read session: ${params.sessionID}`))),
      )
      const filtered = opts.role ? messages.filter((message) => message.info.role === opts.role) : messages

      const header = [
        `# session ${info.id}`,
        info.title,
        `${info.directory} · agent: ${info.agent ?? "-"} · model: ${fmtModel(info.model) || "-"} · updated: ${fmtTime(info.time.updated)}`,
        "",
      ].join("\n")
      const body = filtered.flatMap((message) => renderMessage(message, opts))
      return {
        title: info.title,
        metadata: { count: filtered.length },
        output: `${header}${body.join("\n")}`,
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        (params.action === "list" ? list(params, ctx) : get(params, ctx)).pipe(Effect.orDie),
    }
  }),
)

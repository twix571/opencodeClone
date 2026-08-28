import * as Tool from "./tool"
import DESCRIPTION from "./task.txt"
import { ToolJsonSchema } from "./json-schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import type { SessionPrompt } from "../session/prompt"
import { Config } from "@/config/config"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Effect, Exit, Schema, Scope } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Database } from "@opencode-ai/core/database/database"

export interface TaskPromptOps {
  cancel(sessionID: SessionID): Effect.Effect<void>
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<SessionV1.WithParts>
}

const id = "task"
const BACKGROUND_DESCRIPTION = [
  "Background mode: background=true launches the subagent asynchronously and returns immediately.",
  "Foreground is the default; use it when you need the result before continuing.",
  "Use background only for independent work that can run while you continue elsewhere.",
  "You will be notified automatically when it finishes.",
].join(" ")
const BACKGROUND_STARTED = [
  "The task is working in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
].join("\n")
const BACKGROUND_UPDATED = [
  "Additional context sent to the running background task.",
  "The task is still working in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "Work on non-overlapping tasks, or briefly tell the user what you sent and end your response.",
].join("\n")

const BaseParameterFields = {
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
  task_id: Schema.optional(Schema.String).annotate({
    description:
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
  }),
  command: Schema.optional(Schema.String).annotate({ description: "The command that triggered this task" }),
}

const BaseParameters = Schema.Struct(BaseParameterFields)

export type TaskParams = Schema.Schema.Type<typeof BaseParameters>

export const Parameters = Schema.Struct({
  ...BaseParameterFields,
  background: Schema.optional(Schema.Boolean).annotate({
    description:
      "Run the agent in the background. You will be notified when it completes. DO NOT sleep, poll, or proactively check on its progress",
  }),
})

export function renderOutput(input: {
  sessionID: SessionID
  state: "running" | "completed" | "error"
  summary?: string
  text: string
  worktree?: { directory: string; branch?: string }
}) {
  const tag = input.state === "error" ? "task_error" : "task_result"
  const attrs = input.worktree
    ? ` worktree="${input.worktree.directory}"${input.worktree.branch ? ` branch="${input.worktree.branch}"` : ""}`
    : ""
  return [
    `<task id="${input.sessionID}" state="${input.state}"${attrs}>`,
    ...(input.summary ? [`<summary>${input.summary}</summary>`] : []),
    `<${tag}>`,
    input.text,
    `</${tag}>`,
    "</task>",
  ].join("\n")
}

export const setupTaskSession = Effect.fn("Task.setupTaskSession")(function* (input: {
  ctx: Tool.Context
  params: { description: string; subagent_type: string; task_id?: string }
  skipAsk?: boolean
  agent: Agent.Interface
  config: Config.Interface
  sessions: Session.Interface
  database: Database.Interface
}) {
  const parent = yield* input.sessions.get(input.ctx.sessionID)
  let current = parent
  let depth = 0
  while (current.parentID) {
    depth++
    current = yield* input.sessions.get(current.parentID)
  }
  const cfg = yield* input.config.get()
  if (depth >= (cfg.subagent_depth ?? 1)) {
    return yield* Effect.fail(
      new Error(
        `Subagent depth limit reached (${cfg.subagent_depth ?? 1}). Increase "subagent_depth" to allow nested subagents.`,
      ),
    )
  }

  if (!input.skipAsk && !input.ctx.extra?.bypassAgentCheck) {
    yield* input.ctx.ask({
      permission: id,
      patterns: [input.params.subagent_type],
      always: ["*"],
      metadata: {
        description: input.params.description,
        subagent_type: input.params.subagent_type,
      },
    })
  }

  const next = yield* input.agent.get(input.params.subagent_type)
  if (!next) {
    return yield* Effect.fail(new Error(`Unknown agent type: ${input.params.subagent_type} is not a valid agent type`))
  }

  const session = input.params.task_id
    ? yield* input.sessions
        .get(SessionID.make(input.params.task_id))
        .pipe(Effect.catchCause(() => Effect.succeed(undefined)))
    : undefined
  const childPermission = deriveSubagentSessionPermission({
    parentSessionPermission: parent.permission ?? [],
    subagent: next,
  })
  const childToolDenies = [
    ...(next.permission.some((rule) => rule.permission === "todowrite")
      ? []
      : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
    ...(next.permission.some((rule) => rule.permission === id)
      ? []
      : [{ permission: id, pattern: "*" as const, action: "deny" as const }]),
    ...(cfg.experimental?.primary_tools?.map((permission) => ({
      permission,
      pattern: "*" as const,
      action: "deny" as const,
    })) ?? []),
  ]
  const nextSession =
    session ??
    (yield* input.sessions.create({
      parentID: input.ctx.sessionID,
      title: input.params.description + ` (@${next.name} subagent)`,
      agent: next.name,
      permission: [
        ...childPermission,
        ...childToolDenies.filter(
          (deny) =>
            !childPermission.some(
              (rule) =>
                rule.permission === deny.permission && rule.pattern === deny.pattern && rule.action === deny.action,
            ),
        ),
      ],
    }))

  const msg = yield* MessageV2.get({ sessionID: input.ctx.sessionID, messageID: input.ctx.messageID }).pipe(
    Effect.provideService(Database.Service, input.database),
    Effect.orDie,
  )
  if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))
  const variant = msg.info.variant

  const model = next.model ?? {
    modelID: msg.info.modelID,
    providerID: msg.info.providerID,
  }

  return { parent, next, nextSession, model, variant }
})

export const runTaskPrompt = Effect.fn("Task.runTaskPrompt")(function* (input: {
  ops: TaskPromptOps
  sessionID: SessionID
  model: { modelID: ModelV2.ID; providerID: ProviderV2.ID }
  variant: string | undefined
  agent: string
  prompt: string
  description: string
}) {
  const parts = yield* input.ops.resolvePromptParts(input.prompt)
  const result = yield* input.ops.prompt({
    messageID: MessageID.ascending(),
    sessionID: input.sessionID,
    model: {
      modelID: input.model.modelID,
      providerID: input.model.providerID,
    },
    variant: input.variant,
    agent: input.agent,
    parts,
  })
  if (result.info.role === "assistant" && result.info.error) {
    const message =
      "message" in result.info.error.data && typeof result.info.error.data.message === "string"
        ? result.info.error.data.message
        : result.info.error.name
    return yield* Effect.fail(new Error(`Subagent failed (task_id: ${input.sessionID}): ${message}`))
  }
  const failed = result.parts.findLast((item) => item.type === "tool" && item.state.status === "error")
  if (failed?.type === "tool" && failed.state.status === "error") {
    return yield* Effect.fail(new Error(`Subagent failed (task_id: ${input.sessionID}): ${failed.state.error}`))
  }
  return result.parts.findLast((item) => item.type === "text")?.text ?? ""
})

export const injectTaskResult = Effect.fn("Task.injectTaskResult")(function* (input: {
  ctx: Tool.Context
  ops: TaskPromptOps
  sessionID: SessionID
  agent: string
  variant: string | undefined
  state: "completed" | "error"
  description: string
  text: string
  worktree?: { directory: string; branch?: string }
  sessions: Session.Interface
  scope: Scope.Scope
}) {
  const currentParent = yield* input.sessions.get(input.ctx.sessionID)
  yield* input.ops
    .prompt({
      sessionID: input.ctx.sessionID,
      agent: currentParent.agent ?? input.agent,
      variant: input.variant,
      parts: [
        {
          type: "text",
          synthetic: true,
          text: renderOutput({
            sessionID: input.sessionID,
            state: input.state,
            summary:
              input.state === "completed"
                ? `Background task completed: ${input.description}`
                : `Background task failed: ${input.description}`,
            text: input.text,
            worktree: input.worktree,
          }),
        },
      ],
    })
    .pipe(Effect.ignore, Effect.forkIn(input.scope, { startImmediately: true }))
})

export const TaskTool = Tool.define(
  id,
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    const scope = yield* Scope.Scope
    const flags = yield* RuntimeFlags.Service
    const agent = yield* Agent.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const database = yield* Database.Service

    const run = Effect.fn("TaskTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const runInBackground = params.background === true
      if (runInBackground && !flags.experimentalBackgroundSubagents) {
        return yield* Effect.fail(
          new Error("Background subagents require OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true"),
        )
      }

      const { next, nextSession, model, variant } = yield* setupTaskSession({
        ctx,
        params,
        agent,
        config,
        sessions,
        database,
      })

      const metadata = {
        parentSessionId: ctx.sessionID,
        sessionId: nextSession.id,
        model,
        ...(runInBackground ? { background: true } : {}),
      }

      yield* ctx.metadata({
        title: params.description,
        metadata,
      })

      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) return yield* Effect.fail(new Error("TaskTool requires promptOps in ctx.extra"))

      const runTask = Effect.fn("TaskTool.runTask")(function* () {
        return yield* runTaskPrompt({
          ops,
          sessionID: nextSession.id,
          model,
          variant: next.model ? undefined : variant,
          agent: next.name,
          prompt: params.prompt,
          description: params.description,
        })
      })

      const inject = Effect.fn("TaskTool.injectBackgroundResult")(function* (
        state: "completed" | "error",
        text: string,
      ) {
        return yield* injectTaskResult({
          ctx,
          ops,
          sessionID: nextSession.id,
          agent: ctx.agent,
          variant,
          state,
          description: params.description,
          text,
          sessions,
          scope,
        })
      })

      const notify = Effect.fn("TaskTool.notifyBackgroundResult")(function* (jobID: string) {
        yield* background.wait({ id: jobID }).pipe(
          Effect.flatMap((result) => {
            if (result.info?.status === "completed") return inject("completed", result.info.output ?? "")
            if (result.info?.status === "error") return inject("error", result.info.error ?? "")
            return Effect.void
          }),
          Effect.forkIn(scope, { startImmediately: true }),
        )
      })

      if (yield* background.extend({ id: nextSession.id, run: runTask() })) {
        return {
          title: params.description,
          metadata: {
            ...metadata,
            background: true,
            jobId: nextSession.id,
          },
          output: renderOutput({
            sessionID: nextSession.id,
            state: "running",
            summary: "Background task updated",
            text: BACKGROUND_UPDATED,
          }),
        }
      }

      const info = yield* background.start({
        id: nextSession.id,
        type: id,
        title: params.description,
        metadata,
        onPromote: Effect.all([
          ctx.metadata({
            title: params.description,
            metadata: { ...metadata, background: true, jobId: nextSession.id },
          }),
          notify(nextSession.id),
        ]),
        run: runTask().pipe(Effect.onInterrupt(() => ops.cancel(nextSession.id))),
      })

      function backgroundResult() {
        return {
          title: params.description,
          metadata: {
            ...metadata,
            background: true,
            jobId: info.id,
          },
          output: renderOutput({
            sessionID: nextSession.id,
            state: "running",
            summary: "Background task started",
            text: BACKGROUND_STARTED,
          }),
        }
      }

      if (runInBackground) {
        yield* notify(info.id)
        return backgroundResult()
      }

      const runCancel = yield* EffectBridge.make()
      const cancel = ops.cancel(nextSession.id)

      function onAbort() {
        runCancel.fork(cancel)
      }

      return yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          ctx.abort.addEventListener("abort", onAbort)
        }),
        () =>
          Effect.gen(function* () {
            const result = yield* Effect.raceFirst(
              background.wait({ id: nextSession.id }).pipe(Effect.map((waited) => waited.info)),
              background.waitForPromotion(nextSession.id),
            )
            if (result?.metadata?.background === true) return backgroundResult()
            if (result?.status === "error") return yield* Effect.fail(new Error(result.error ?? "Task failed"))
            if (result?.status === "cancelled") return yield* Effect.fail(new Error("Task cancelled"))
            return {
              title: params.description,
              metadata,
              output: renderOutput({ sessionID: nextSession.id, state: "completed", text: result?.output ?? "" }),
            }
          }),
        (_, exit) =>
          Effect.gen(function* () {
            if (Exit.hasInterrupts(exit))
              yield* Effect.all([cancel, background.cancel(nextSession.id)], { discard: true })
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                ctx.abort.removeEventListener("abort", onAbort)
              }),
            ),
          ),
      )
    })

    return {
      description: flags.experimentalBackgroundSubagents
        ? [DESCRIPTION, BACKGROUND_DESCRIPTION].join("\n\n")
        : DESCRIPTION,
      parameters: Parameters,
      jsonSchema: flags.experimentalBackgroundSubagents ? undefined : ToolJsonSchema.fromSchema(BaseParameters),
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)

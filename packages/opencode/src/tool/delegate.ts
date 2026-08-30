import * as Tool from "./tool"
import DESCRIPTION from "./delegate.txt"
import { ToolJsonSchema } from "./json-schema"
import { injectTaskResult, renderOutput, runTaskPrompt, setupTaskSession, type TaskPromptOps } from "./task"
import { BackgroundJob } from "@/background/job"
import { Worktree } from "@/worktree"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { Git } from "@/git"
import { Database } from "@opencode-ai/core/database/database"
import { Effect, Schema, Scope } from "effect"

const id = "delegate"

const Parameters = Schema.Struct({
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
  worktree: Schema.optional(Schema.Boolean).annotate({
    description:
      "Run the task in a fresh git worktree so it cannot conflict with your own edits. Defaults to true. Set to false to run in the current directory.",
  }),
  task_id: Schema.optional(Schema.String).annotate({
    description:
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
  }),
})

const STARTED = [
  "The task is working in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
].join("\n")

const STARTED_WORKTREE = [
  "The task is working in the background in its own git worktree.",
  "You will be notified automatically when it finishes; the result will include the worktree branch to merge.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
].join("\n")

const UPDATED = [
  "Additional context sent to the running background task.",
  "The task is still working in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "Work on non-overlapping tasks, or briefly tell the user what you sent and end your response.",
].join("\n")

const WORKTREE_ORCHESTRATION_GUARD = [
  "",
  "IMPORTANT — orchestration contract: You are running inside an isolated git worktree managed by your parent session.",
  "Do NOT call worktree_create or worktree_delete. Do NOT merge or push branches. Do NOT remove your working directory.",
  "Just do the task, verify your work, and report your final result. Your parent merges your branch and handles cleanup.",
  "If you add a dependency to package.json, run bun install --frozen-lockfile in the worktree before typechecking.",
].join("\n")

export const DelegateTool = Tool.define(
  id,
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    const scope = yield* Scope.Scope
    const worktreeSvc = yield* Worktree.Service
    const store = yield* InstanceStore.Service
    const git = yield* Git.Service
    const sessions = yield* Session.Service
    const agent = yield* Agent.Service
    const config = yield* Config.Service
    const database = yield* Database.Service

    const run = Effect.fn("DelegateTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const useWorktree = params.worktree !== false

      if (!ctx.extra?.bypassAgentCheck) {
        yield* ctx.ask({
          permission: "task",
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
          },
        })
        if (useWorktree) {
          yield* ctx.ask({
            permission: "worktree",
            patterns: ["create"],
            always: ["*"],
            metadata: { description: params.description },
          })
        }
      }

      const created = useWorktree
        ? yield* worktreeSvc.create({ name: params.description }).pipe(
            Effect.catch((error) => Effect.fail(new Error(`Failed to create worktree: ${error.message}`))),
          )
        : undefined
      const info = created
        ? { directory: created.directory, ...(created.branch ? { branch: created.branch } : {}) }
        : undefined

      if (created) {
        yield* Worktree.waitReady(created.directory).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              yield* worktreeSvc.remove({ directory: created.directory }).pipe(Effect.ignore)
              return yield* Effect.fail(error)
            }),
          ),
        )
      }

      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) {
        if (created) yield* worktreeSvc.remove({ directory: created.directory }).pipe(Effect.ignore)
        return yield* Effect.fail(new Error("DelegateTool requires promptOps in ctx.extra"))
      }

      const setup = yield* (created
        ? store.provide(
            { directory: created.directory },
            setupTaskSession({ ctx, params, skipAsk: true, agent, config, sessions, database }),
          )
        : setupTaskSession({ ctx, params, skipAsk: true, agent, config, sessions, database }))
      const { next, nextSession, model, variant } = setup

      const metadata = {
        parentSessionId: ctx.sessionID,
        sessionId: nextSession.id,
        model,
        background: true,
        ...(info ? { worktree: info } : {}),
      }
      yield* ctx.metadata({
        title: params.description,
        metadata,
      })

      const runTask = Effect.fn("DelegateTool.runTask")(function* () {
        const childPrompt = created ? `${params.prompt}${WORKTREE_ORCHESTRATION_GUARD}` : params.prompt
        const child = runTaskPrompt({
          ops,
          sessionID: nextSession.id,
          model,
          variant: next.model ? undefined : variant,
          agent: next.name,
          prompt: childPrompt,
          description: params.description,
        })
        const result = yield* (created ? store.provide({ directory: created.directory }, child) : child)
        if (created) {
          yield* git.run(["add", "-A"], { cwd: created.directory })
          const commit = yield* git.run(["commit", "-m", `delegated: ${params.description}`], {
            cwd: created.directory,
          })
          if (commit.exitCode !== 0 && !/nothing to commit/i.test(commit.stderr.toString("utf8"))) {
            yield* Effect.logWarning("delegate auto-commit failed", {
              directory: created.directory,
              message: commit.stderr.toString("utf8"),
            })
          }
        }
        return result
      })

      const inject = Effect.fn("DelegateTool.inject")(function* (state: "completed" | "error", text: string) {
        yield* injectTaskResult({
          ctx,
          ops,
          sessionID: nextSession.id,
          agent: ctx.agent,
          variant,
          state,
          description: params.description,
          text,
          worktree: info,
          sessions,
          scope,
        })
      })

      const notify = Effect.fn("DelegateTool.notify")(function* (jobID: string) {
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
            text: UPDATED,
            worktree: info,
          }),
        }
      }

      const job = yield* background.start({
        id: nextSession.id,
        type: id,
        title: params.description,
        metadata,
        onPromote: ctx.metadata({
          title: params.description,
          metadata: { ...metadata, background: true, jobId: nextSession.id },
        }),
        run: runTask().pipe(Effect.onInterrupt(() => ops.cancel(nextSession.id))),
      })
      yield* notify(job.id)

      return {
        title: params.description,
        metadata: {
          ...metadata,
          jobId: job.id,
        },
        output: renderOutput({
          sessionID: nextSession.id,
          state: "running",
          summary: created ? "Task started in worktree" : "Background task started",
          text: created ? STARTED_WORKTREE : STARTED,
          worktree: info,
        }),
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      jsonSchema: ToolJsonSchema.fromSchema(Parameters),
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) => run(params, ctx).pipe(Effect.orDie),
    }
  }),
)

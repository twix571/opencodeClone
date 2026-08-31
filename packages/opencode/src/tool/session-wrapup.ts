import { Effect, Option, Schema } from "effect"
import { SessionWrapup } from "@opencode-ai/schema/session-wrapup"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Git } from "@/git"
import { InstanceState } from "@/effect/instance-state"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { Worktree } from "@/worktree"
import * as Tool from "./tool"
import DESCRIPTION from "./session-wrapup.txt"

const Action = Schema.Literals(["commit", "commit_push", "commit_restart"])

export const Parameters = Schema.Struct({
  sessionID: Schema.String.annotate({ description: "The session ID to wrap up." }),
  action: Action.annotate({
    description:
      '"commit" commits the session\'s worktree and merges it into the primary branch. "commit_push" also pushes to the remote. "commit_restart" commits, merges, and requests a GUI relaunch.',
  }),
})

export const SessionWrapupTool = Tool.define<
  typeof Parameters,
  { success?: boolean },
  Session.Service | Worktree.Service | Git.Service | EventV2Bridge.Service
>(
  "session_wrapup",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const worktree = yield* Worktree.Service
    const git = yield* Git.Service
    const events = yield* EventV2Bridge.Service

    const execute = Effect.fn("SessionWrapupTool.execute")(
      function* (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) {
        yield* ctx.ask({
          permission: "session_wrapup",
          patterns: [params.sessionID],
          always: ["*"],
          metadata: { action: params.action, sessionID: params.sessionID },
        })

        const sessionID = yield* Schema.decodeUnknownOption(SessionID)(params.sessionID).pipe(
          Option.match({
            onNone: () => Effect.fail(new Error(`Invalid session ID: ${params.sessionID}`)),
            onSome: (id) => Effect.succeed(id),
          }),
        )
        const session = yield* sessions.get(sessionID).pipe(
          Effect.catch(() => Effect.fail(new Error(`Session not found: ${params.sessionID}`))),
        )
        if (session.agent === "supervisor") {
          return yield* Effect.fail(new Error("The supervisor session itself cannot be wrapped up"))
        }

        const entry = (yield* worktree.list()).find((item) => item.directory === session.directory)
        if (!entry?.branch) {
          return yield* Effect.fail(
            new Error(`Session ${params.sessionID} is not running in a git worktree; nothing to commit or merge`),
          )
        }

        const primary = yield* InstanceState.context

        const added = yield* git.run(["add", "-A"], { cwd: session.directory })
        if (added.exitCode !== 0) {
          return yield* Effect.fail(new Error(`git add failed in worktree: ${added.stderr}`))
        }
        const committed = yield* git.run(["commit", "-m", session.title], { cwd: session.directory })
        const hasChanges = committed.exitCode === 0
        if (committed.exitCode !== 0 && !committed.stderr.includes("nothing to commit")) {
          return yield* Effect.fail(new Error(`git commit failed in worktree: ${committed.stderr}`))
        }

        const merged = yield* git.run(["merge", "--no-ff", "--no-edit", entry.branch], { cwd: primary.worktree })
        if (merged.exitCode !== 0) {
          return yield* Effect.fail(
            new Error(`git merge of ${entry.branch} into the primary branch failed: ${merged.stderr}`),
          )
        }

        const push = params.action === "commit_push"
        let pushed = "no push requested"
        if (push) {
          const pushedResult = yield* git.run(["push", "origin", "HEAD"], { cwd: primary.worktree })
          if (pushedResult.exitCode !== 0) {
            return yield* Effect.fail(new Error(`git push failed: ${pushedResult.stderr}`))
          }
          pushed = "pushed to origin"
        }

        yield* worktree.remove({ directory: session.directory })

        yield* events.publish(SessionWrapup.Wrapup, {
          sessionID: session.id,
          info: {
            sessionID: session.id,
            action: params.action,
            branch: entry.branch,
            mergeTarget: primary.worktree,
            success: true,
          },
        })

        const output = [
          `Session "${session.title}" wrapped up.`,
          `Branch ${entry.branch} merged into the primary branch.`,
          `Committed: ${hasChanges ? "yes" : "nothing new to commit"}.`,
          `Pushed: ${pushed}.`,
          `Worktree cleaned up.`,
        ].join("\n")
        return { title: `Wrapped up ${session.title}`, metadata: { success: true }, output }
      },
      (effect) => effect.pipe(Effect.orDie),
    )

    return { description: DESCRIPTION, parameters: Parameters, execute }
  }),
)

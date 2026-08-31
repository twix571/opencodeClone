import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import * as fs from "fs/promises"
import path from "path"
import { Effect, Queue, Cause, Exit } from "effect"
import * as Stream from "effect/Stream"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { EventV2 } from "@opencode-ai/core/event"
import { Database } from "@opencode-ai/core/database/database"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { Worktree } from "../../src/worktree"
import { Session } from "../../src/session/session"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { SessionWrapupTool } from "../../src/tool/session-wrapup"
import { SessionWrapup } from "@opencode-ai/schema/session-wrapup"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionID, MessageID } from "../../src/session/schema"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Git } from "@/git"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Session.node,
      SessionProjector.node,
      Worktree.node,
      Git.node,
      EventV2Bridge.node,
      EventV2.node,
      Database.node,
      Truncate.node,
      Agent.node,
    ]),
    [[InstanceStore.bootstrapNode, InstanceBootstrap.node]],
  ),
)

afterEach(() => disposeAllInstances())

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  agent: "build",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const git = Effect.fn("WrapupToolTest.git")(function* (cwd: string, args: string[]) {
  const service = yield* Git.Service
  const result = yield* service.run(args, { cwd })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`)
  return result.text()
})

const createWorktreeSession = Effect.fn("WrapupToolTest.createWorktreeSession")(function* () {
  const sessions = yield* Session.Service
  const store = yield* InstanceStore.Service
  const wt = yield* Worktree.Service
  const info = yield* wt.create({ runStart: false })
  const session = yield* store.provide({ directory: info.directory }, sessions.create({ title: "Worker" }))
  return { info, session }
})

describe("tool.session_wrapup", () => {
  it.instance(
    "commits a session's worktree and merges it into the primary branch",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const { info, session } = yield* createWorktreeSession()
        yield* Effect.promise(() => fs.writeFile(path.join(info.directory, "work.txt"), "session work"))

        const tool = yield* SessionWrapupTool
        const def = yield* tool.init()
        const result = yield* def.execute({ sessionID: session.id, action: "commit" }, ctx)

        expect(result.output).toContain("merged")
        expect(result.output).toContain("Committed: yes")
        expect(result.output).toContain("no push requested")

        const merged = yield* git(test.directory, ["log", "--oneline", "--all"])
        expect(merged).toContain("Worker")
        expect(yield* Effect.promise(() => fs.readFile(path.join(test.directory, "work.txt"), "utf8"))).toBe(
          "session work",
        )
        expect(yield* Effect.promise(() => fs.access(info.directory).then(() => true).catch(() => false))).toBe(false)
        const branches = yield* git(test.directory, ["branch", "--list", info.branch!])
        expect(branches.trim()).toBe("")
      }),
    { git: true },
  )

  it.instance(
    "fails when the session is not running in a git worktree",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "Primary" })

        const tool = yield* SessionWrapupTool
        const def = yield* tool.init()
        const exit = yield* def.execute({ sessionID: session.id, action: "commit" }, ctx).pipe(Effect.exit)

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const message = Cause.prettyErrors(exit.cause).join("\n")
          expect(message).toContain("not running in a git worktree")
        }
      }),
    { git: true },
  )

  it.instance(
    "commit_restart publishes a session.wrapup event without pushing",
    () =>
      Effect.gen(function* () {
        const events = yield* EventV2Bridge.Service
        const queue = yield* Queue.unbounded<{ sessionID: string; info: SessionWrapup.Info }>()
        yield* Stream.runForEach(events.subscribe(SessionWrapup.Wrapup), (payload) =>
          Effect.sync(() => Queue.offerUnsafe(queue, payload.data)),
        ).pipe(Effect.forkScoped)

        const { info, session } = yield* createWorktreeSession()
        yield* Effect.promise(() => fs.writeFile(path.join(info.directory, "work.txt"), "session work"))

        const tool = yield* SessionWrapupTool
        const def = yield* tool.init()
        const result = yield* def.execute({ sessionID: session.id, action: "commit_restart" }, ctx)

        expect(result.output).toContain("no push requested")
        const payload = yield* Queue.take(queue).pipe(
          Effect.timeoutOrElse({
            duration: "5 seconds",
            orElse: () => Effect.fail(new Error("no session.wrapup event published")),
          }),
        )
        expect(payload.sessionID).toBe(session.id)
        expect(payload.info.action).toBe("commit_restart")
        expect(payload.info.success).toBe(true)
        expect(payload.info.branch).toBe(info.branch)
      }),
    { git: true },
  )
})

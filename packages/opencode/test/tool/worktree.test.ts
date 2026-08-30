import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import * as fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { Worktree } from "../../src/worktree"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { WorktreeCreateTool } from "../../src/tool/worktree-create"
import { WorktreeDeleteTool } from "../../src/tool/worktree-delete"
import { SessionID, MessageID } from "../../src/session/schema"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Git } from "@/git"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([Worktree.node, Truncate.node, Agent.node, Git.node]),
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

const git = Effect.fn("WorktreeToolTest.git")(function* (cwd: string, args: string[]) {
  const service = yield* Git.Service
  const result = yield* service.run(args, { cwd })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`)
  return result.text()
})

describe("tool.worktree", () => {
  it.instance(
    "creates a worktree with a slugified name and waits for it to boot",
    () =>
      Effect.gen(function* () {
        const tool = yield* WorktreeCreateTool
        const def = yield* tool.init()
        const asks: unknown[] = []

        const result = yield* def.execute(
          { name: "My Feature Work" },
          { ...ctx, ask: (input) => Effect.sync(() => asks.push(input)) },
        )

        expect(asks).toHaveLength(1)
        expect(asks[0]).toEqual({
          permission: "worktree",
          patterns: ["create"],
          always: ["*"],
          metadata: { name: "My Feature Work" },
        })
        expect(result.output).toContain("Branch: opencode/my-feature-work")
        expect(result.output).toContain("Directory:")

        const svc = yield* Worktree.Service
        const list = yield* svc.list()
        expect(list).toContainEqual(
          expect.objectContaining({ name: "my-feature-work", branch: "opencode/my-feature-work" }),
        )
      }),
    { git: true },
  )

  it.instance(
    "delete auto-commits uncommitted changes and removes the worktree and branch",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const tool = yield* WorktreeCreateTool
        const def = yield* tool.init()
        const created = yield* def.execute({ name: "cleanup-me" }, ctx)

        const directory = created.output.match(/Directory: (.+)/)?.[1]
        if (!directory) throw new Error("expected directory in output")

        yield* Effect.promise(() => fs.writeFile(path.join(directory, "notes.txt"), "uncommitted work"))

        const del = yield* WorktreeDeleteTool
        const delDef = yield* del.init()
        const result = yield* delDef.execute({ directory, reason: "cleanup test work" }, ctx)

        expect(result.output).toContain("Deleted worktree")
        expect(yield* Effect.promise(() => fs.access(directory).then(() => true).catch(() => false))).toBe(false)

        const branches = yield* git(test.directory, ["branch", "--list", "opencode/cleanup-me"])
        expect(branches.trim()).toBe("")

        const svc = yield* Worktree.Service
        const list = yield* svc.list()
        expect(list).not.toContainEqual(expect.objectContaining({ name: "cleanup-me" }))
      }),
    { git: true },
  )

  it.instance(
    "delete removes a clean worktree without treating 'nothing to commit' as an error",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const tool = yield* WorktreeCreateTool
        const def = yield* tool.init()
        const created = yield* def.execute({ name: "clean-remove" }, ctx)

        const directory = created.output.match(/Directory: (.+)/)?.[1]
        if (!directory) throw new Error("expected directory in output")

        const del = yield* WorktreeDeleteTool
        const delDef = yield* del.init()
        const result = yield* delDef.execute({ directory, reason: "cleanup test work" }, ctx)

        expect(result.output).toContain("Deleted worktree")
        expect(yield* Effect.promise(() => fs.access(directory).then(() => true).catch(() => false))).toBe(false)

        const svc = yield* Worktree.Service
        const list = yield* svc.list()
        expect(list).not.toContainEqual(expect.objectContaining({ name: "clean-remove" }))
      }),
    { git: true },
  )
})

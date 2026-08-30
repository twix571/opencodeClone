import * as Tool from "./tool"
import DESCRIPTION from "./worktree-delete.txt"
import { ToolJsonSchema } from "./json-schema"
import { Git } from "@/git"
import { Worktree } from "@/worktree"
import { Effect, Schema } from "effect"

const id = "worktree_delete"

const Parameters = Schema.Struct({
  directory: Schema.String.annotate({ description: "The worktree directory to delete" }),
  reason: Schema.String.annotate({ description: "Reason for the automatic commit of any uncommitted changes" }),
})

export const WorktreeDeleteTool = Tool.define(
  id,
  Effect.gen(function* () {
    const git = yield* Git.Service
    const worktree = yield* Worktree.Service

    const run = Effect.fn("WorktreeDeleteTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      yield* ctx.ask({
        permission: "worktree",
        patterns: [params.directory],
        always: ["*"],
        metadata: { directory: params.directory },
      })

      const add = yield* git.run(["add", "-A"], { cwd: params.directory })
      if (add.exitCode !== 0) {
        return yield* Effect.fail(
          new Error(`git add failed in ${params.directory}: ${add.stderr.toString("utf8")}`),
        )
      }
      const commit = yield* git.run(["commit", "-m", params.reason], { cwd: params.directory })
      const nothingToCommit =
        commit.exitCode !== 0 &&
        (/nothing to commit/i.test(commit.stderr.toString("utf8")) ||
          /nothing to commit/i.test(commit.stdout.toString("utf8")))
      if (commit.exitCode !== 0 && !nothingToCommit) {
        return yield* Effect.fail(
          new Error(`git commit failed in ${params.directory}: ${commit.stderr.toString("utf8")}`),
        )
      }

      yield* worktree.remove({ directory: params.directory })

      return {
        title: `Deleted worktree ${params.directory}`,
        metadata: { worktree: { directory: params.directory } },
        output: `Deleted worktree ${params.directory} and removed its branch.`,
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

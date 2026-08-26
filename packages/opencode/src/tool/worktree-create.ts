import * as Tool from "./tool"
import DESCRIPTION from "./worktree-create.txt"
import { ToolJsonSchema } from "./json-schema"
import { Worktree } from "@/worktree"
import { Effect, Schema } from "effect"

const id = "worktree_create"

const Parameters = Schema.Struct({
  name: Schema.optional(Schema.String).annotate({
    description: "A short name for the worktree. Used as the base for the branch name. A random name is generated when omitted.",
  }),
})

export const WorktreeCreateTool = Tool.define(
  id,
  Effect.gen(function* () {
    const worktree = yield* Worktree.Service

    const run = Effect.fn("WorktreeCreateTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      yield* ctx.ask({
        permission: "worktree",
        patterns: ["create"],
        always: ["*"],
        metadata: { name: params.name },
      })

      const info = yield* worktree.create({ name: params.name })
      yield* Worktree.waitReady(info.directory)

      return {
        title: `Created worktree ${info.name}`,
        metadata: { worktree: info },
        output: [
          `Created worktree "${info.name}".`,
          ...(info.branch ? [`Branch: ${info.branch}`] : []),
          `Directory: ${info.directory}`,
          "Make changes inside the directory and commit them there.",
          "When done, merge the branch into your current branch and delete the worktree with worktree_delete.",
        ].join("\n"),
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

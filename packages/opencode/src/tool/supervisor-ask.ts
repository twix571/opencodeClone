import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { SupervisorAsk } from "@/session/supervisor-ask"
import DESCRIPTION from "./supervisor-ask.txt"

export const Parameters = Schema.Struct({
  question: Schema.String.annotate({ description: "The question for the workspace supervisor." }),
})

export const SupervisorAskTool = Tool.define<typeof Parameters, { count?: number }, SupervisorAsk.Service>(
  "supervisor_ask",
  Effect.gen(function* () {
    const supervisorAsk = yield* SupervisorAsk.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "supervisor_ask",
            patterns: ["*"],
            always: ["*"],
            metadata: { question: params.question },
          })
          const answer = yield* supervisorAsk.ask({ sessionID: ctx.sessionID, question: params.question })
          return { title: "Supervisor", output: answer, metadata: {} }
        }).pipe(Effect.orDie),
    }
  }),
)

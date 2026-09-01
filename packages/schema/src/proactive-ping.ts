export * as ProactivePing from "./proactive-ping"

import { Schema } from "effect"
import { optional } from "./schema"
import { Event } from "./event"
import { SessionID } from "./session-id"

/**
 * Structured metadata for a session tool call that a rule check flagged. The
 * enforcement layer turns a flagged call into a corrective ping delivered to
 * the session mid-run, so the agent stops retrying a forbidden action instead
 * of learning about it only from the tool's own error result.
 */
export const Flag = Schema.Struct({
  sessionID: SessionID,
  tool: Schema.String,
  file: optional(Schema.String),
  permission: Schema.String,
  action: Schema.Literal("deny"),
  reason: optional(Schema.String),
}).annotate({ identifier: "ProactivePing.Flag" })
export type Flag = Schema.Schema.Type<typeof Flag>

export const Ping = Event.define({
  type: "proactive.ping",
  schema: {
    sessionID: SessionID,
    flag: Flag,
  },
})

export const Definitions = Event.inventory(Ping)

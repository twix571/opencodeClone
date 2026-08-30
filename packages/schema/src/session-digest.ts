export * as SessionDigest from "./session-digest"

import { Schema } from "effect"
import { optional } from "./schema"
import { Event } from "./event"
import { SessionID } from "./session-id"
import { FileDiff } from "./file-diff"

/**
 * Structured digest of a completed session run. Emitted at the terminal state
 * of a session's tracked job (completed/error/cancelled) so a supervisor agent
 * can review what a session did without reading its raw transcript.
 */
export const Info = Schema.Struct({
  sessionID: SessionID,
  title: optional(Schema.String),
  status: Schema.Literals(["completed", "error", "cancelled"]),
  branch: optional(Schema.String),
  directory: optional(Schema.String),
  files: optional(Schema.Array(FileDiff.Info)),
  messageSummary: optional(Schema.String),
  cost: optional(Schema.Finite),
  tokens: optional(
    Schema.Struct({
      input: Schema.Finite,
      output: Schema.Finite,
      reasoning: Schema.Finite,
      cache: Schema.Struct({
        read: Schema.Finite,
        write: Schema.Finite,
      }),
    }),
  ),
}).annotate({ identifier: "SessionDigest" })
export type Info = Schema.Schema.Type<typeof Info>

export const Digest = Event.define({
  type: "session.digest",
  schema: {
    sessionID: SessionID,
    digest: Info,
  },
})

export const Definitions = Event.inventory(Digest)

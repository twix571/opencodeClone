export * as SessionWrapup from "./session-wrapup"

import { Schema } from "effect"
import { Event } from "./event"
import { SessionID } from "./session-id"

/**
 * Result of a supervisor-initiated wrap-up: the finished session's worktree was
 * committed, merged into the primary branch, optionally pushed and followed by a
 * GUI relaunch. Published so clients (notably the desktop renderer) can react —
 * for example relaunch the app when the user picked the "restart GUI" action.
 */
export const Action = Schema.Literals(["commit", "commit_push", "commit_restart"])

export const Info = Schema.Struct({
  sessionID: SessionID,
  action: Action,
  branch: Schema.optional(Schema.String),
  mergeTarget: Schema.optional(Schema.String),
  success: Schema.Boolean,
  message: Schema.optional(Schema.String),
}).annotate({ identifier: "SessionWrapup" })
export type Info = Schema.Schema.Type<typeof Info>

export const Wrapup = Event.define({
  type: "session.wrapup",
  schema: {
    sessionID: SessionID,
    info: Info,
  },
})

export const Definitions = Event.inventory(Wrapup)

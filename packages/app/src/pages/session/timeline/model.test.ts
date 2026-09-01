import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Message, UserMessage } from "@opencode-ai/sdk/v2"
import {
  isTimelineReady,
  loadOlderTimeline,
  selectRolledSnapshot,
  selectUserMessages,
  selectVisibleUserMessages,
} from "./model"

const user = (id: string) => ({ id, role: "user" }) as UserMessage
const assistant = (id: string) => ({ id, role: "assistant" }) as AssistantMessage

describe("timeline model", () => {
  test("selects users and applies the revert boundary", () => {
    const messages: Message[] = [user("msg_z"), assistant("msg_a"), user("msg_b"), user("msg_c")]
    const users = selectUserMessages(messages)

    expect(users.map((message) => message.id)).toEqual(["msg_z", "msg_b", "msg_c"])
    expect(selectVisibleUserMessages(users, "msg_b").map((message) => message.id)).toEqual(["msg_z"])
    expect(selectVisibleUserMessages(users)).toBe(users)
  })

  test("waits for an assistant-only load to hydrate its user root", () => {
    expect(isTimelineReady([assistant("msg_2")], true)).toBe(false)
    expect(isTimelineReady([user("msg_1"), assistant("msg_2")], true)).toBe(true)
    expect(isTimelineReady([], false)).toBe(true)
  })

  test("snapshots the rolled messages when a revert is staged", () => {
    const messages = [user("msg_1"), user("msg_2"), user("msg_3")]
    const snapshot = selectRolledSnapshot(undefined, "msg_1", messages)
    expect(snapshot).toEqual({ boundary: "msg_1", ids: new Set(["msg_1", "msg_2", "msg_3"]) })
    expect(selectRolledSnapshot(undefined, "msg_missing", messages)).toBeUndefined()
    expect(selectRolledSnapshot(undefined, undefined, messages)).toBeUndefined()
  })

  test("keeps the staged snapshot so a new send is not rolled back", () => {
    const staged = [user("msg_1"), user("msg_2"), user("msg_3")]
    const snapshot = selectRolledSnapshot(undefined, "msg_1", staged)!

    const afterSend = [...staged, user("msg_4")]
    const kept = selectRolledSnapshot(snapshot, "msg_1", afterSend)
    expect(kept).toBe(snapshot)
    expect([...kept!.ids].sort()).toEqual(["msg_1", "msg_2", "msg_3"])
  })

  test("re-snapshots when the revert moves to another message", () => {
    const messages = [user("msg_1"), user("msg_2"), user("msg_3")]
    const snapshot = selectRolledSnapshot(undefined, "msg_1", messages)!
    const moved = selectRolledSnapshot(snapshot, "msg_2", messages)
    expect(moved).toEqual({ boundary: "msg_2", ids: new Set(["msg_2", "msg_3"]) })
  })

  test("clears the snapshot once the revert is cleared", () => {
    const snapshot = selectRolledSnapshot(undefined, "msg_1", [user("msg_1"), user("msg_2")])
    expect(selectRolledSnapshot(snapshot, undefined, [user("msg_1"), user("msg_2")])).toBeUndefined()
  })

  test("loads exactly one opaque cursor page", async () => {
    let calls = 0
    const anchors: Array<string | boolean> = []

    await loadOlderTimeline({
      sessionID: () => "ses_test",
      more: () => true,
      loading: () => false,
      loadMore: async () => {
        calls += 1
      },
      before: () => anchors.push("before"),
      after: (done) => anchors.push("after", done),
    })

    expect(calls).toBe(1)
    expect(anchors).toEqual(["before", "after", true])
  })

  test("stops when a page adds no raw messages", async () => {
    let calls = 0
    await loadOlderTimeline({
      sessionID: () => "ses_test",
      more: () => true,
      loading: () => false,
      loadMore: async () => {
        calls += 1
      },
    })

    expect(calls).toBe(1)
  })

  test("does not restore an anchor after the session changes", async () => {
    let sessionID = "ses_old"
    let restore = 0

    await loadOlderTimeline({
      sessionID: () => sessionID,
      more: () => true,
      loading: () => false,
      loadMore: async () => {
        sessionID = "ses_new"
      },
      after: () => {
        restore += 1
      },
    })

    expect(restore).toBe(0)
  })

  test("releases the anchor when loading history fails", async () => {
    let restore = 0

    await expect(
      loadOlderTimeline({
        sessionID: () => "ses_test",
        more: () => true,
        loading: () => false,
        loadMore: async () => {
          throw new Error("history failed")
        },
        after: () => {
          restore += 1
        },
      }),
    ).rejects.toThrow("history failed")

    expect(restore).toBe(1)
  })
})

import { describe, expect, test } from "bun:test"
import {
  normalizeNewSessionWorktree,
  resolveNewSessionBranch,
  resolveNewSessionWorktree,
} from "./new-session-workspace-controller"

describe("new session workspace selection", () => {
  test("uses main when the workspace bar is unavailable", () => {
    expect(resolveNewSessionWorktree({ enabled: false, selected: "/project/feature" })).toBe("main")
  })

  test("defaults to a new worktree when nothing is selected", () => {
    expect(resolveNewSessionWorktree({ enabled: true })).toBe("create")
    expect(resolveNewSessionWorktree({ enabled: true, busy: () => true })).toBe("create")
  })

  test("does not reuse a busy explicitly selected worktree", () => {
    const busy = (worktree: string) => worktree === "/project/feature"
    expect(resolveNewSessionWorktree({ enabled: true, selected: "/project/feature", busy })).toBe("create")
  })

  test("keeps a non-busy explicitly selected worktree", () => {
    expect(resolveNewSessionWorktree({ enabled: true, selected: "/project/feature", busy: () => false })).toBe(
      "/project/feature",
    )
  })

  test("normalizes main to the project root outside the main worktree", () => {
    expect(normalizeNewSessionWorktree("main", "/project/feature", "/project")).toBe("/project")
    expect(normalizeNewSessionWorktree("main", "/project", "/project")).toBe("main")
  })

  test("falls back to the local branch for main, create, and unknown worktrees", () => {
    const branch = (worktree: string) => (worktree === "/project/feature" ? "feature" : undefined)
    expect(resolveNewSessionBranch({ worktree: "main", local: "dev", worktreeBranch: branch })).toBe("dev")
    expect(resolveNewSessionBranch({ worktree: "create", local: "dev", worktreeBranch: branch })).toBe("dev")
    expect(resolveNewSessionBranch({ worktree: "/project/feature", local: "dev", worktreeBranch: branch })).toBe(
      "feature",
    )
    expect(resolveNewSessionBranch({ worktree: "/missing", local: "dev", worktreeBranch: branch })).toBe("dev")
  })
})

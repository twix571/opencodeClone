import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { Agent } from "./agent"

/**
 * Build the `permission` ruleset for a subagent's session when it's spawned
 * via the task or delegate tool. Combines:
 *
 * 1. The subagent's own ruleset with every `ask` resolved to `allow`. Headless
 *    child sessions have no interactive responder, so a permission that would
 *    otherwise block on an unanswered `ask` (e.g. `external_directory` writes
 *    to /tmp) would leave the subagent's tool call `running` forever and the
 *    parent would never get a completion. Mirroring the subagent's own rules
 *    with `ask` → `allow` keeps its configured allow/deny behavior intact
 *    (pattern-specific denies still win within the mirrored ruleset) while
 *    making every permission decision deterministic.
 * 2. The parent session's deny rules, which act as hard runtime ceilings
 *    (e.g. Plan Mode blocks edit). Parent agent restrictions only govern that
 *    agent; the subagent's own permissions determine its capabilities.
 * 3. Default `todowrite` and `task` denies if the subagent's own ruleset
 *    doesn't already permit them.
 */
export function deriveSubagentSessionPermission(input: {
  parentSessionPermission: PermissionV1.Ruleset
  subagent: Agent.Info
}): PermissionV1.Ruleset {
  const canTask = input.subagent.permission.some((rule) => rule.permission === "task")
  const canTodo = input.subagent.permission.some((rule) => rule.permission === "todowrite")
  return [
    ...input.subagent.permission.map((rule): PermissionV1.Rule =>
      rule.action === "ask" ? { permission: rule.permission, pattern: rule.pattern, action: "allow" } : rule,
    ),
    ...input.parentSessionPermission.filter((rule) => rule.action === "deny"),
    ...(canTodo ? [] : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
    ...(canTask ? [] : [{ permission: "task" as const, pattern: "*" as const, action: "deny" as const }]),
  ]
}

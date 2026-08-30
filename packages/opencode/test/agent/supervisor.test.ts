import { afterEach, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Agent } from "../../src/agent/agent"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { Skill } from "../../src/skill"

const agentLayer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  LayerNode.compile(
    LayerNode.group([Agent.node, Plugin.node, Provider.node, Auth.node, Config.node, Skill.node, RuntimeFlags.node]),
    [[RuntimeFlags.node, RuntimeFlags.layer(flags)]],
  )

const it = testEffect(agentLayer())

function load<A>(fn: (svc: Agent.Interface) => Effect.Effect<A>) {
  return Agent.Service.use(fn)
}

function rule(agent: Agent.Info | undefined, permission: string, pattern: string) {
  return Permission.evaluate(permission, pattern, agent!.permission).action
}

afterEach(async () => {
  await disposeAllInstances()
})

it.instance("supervisor agent is hidden, primary, native, and has a prompt", () =>
  Effect.gen(function* () {
    const names = (yield* load((svc) => svc.list())).map((a) => a.name)
    expect(names).toContain("supervisor")

    const supervisor = yield* load((svc) => svc.get("supervisor"))
    expect(supervisor).toBeDefined()
    expect(supervisor?.mode).toBe("primary")
    expect(supervisor?.hidden).toBe(true)
    expect(supervisor?.native).toBe(true)
    expect(supervisor?.prompt).toBeTruthy()
  }),
)

it.instance("supervisor is never the default agent", () =>
  Effect.gen(function* () {
    const agent = yield* load((svc) => svc.defaultAgent())
    expect(agent).not.toBe("supervisor")
  }),
)

it.instance("normal agents cannot read globalAGENTS.md", () =>
  Effect.gen(function* () {
    const build = yield* load((svc) => svc.get("build"))
    expect(rule(build, "read", "globalAGENTS.md")).toBe("deny")
    expect(rule(build, "read", "src/globalAGENTS.md")).toBe("deny")
    expect(rule(build, "read", "../../other/globalAGENTS.md")).toBe("deny")
    expect(rule(build, "read", "src/foo.ts")).toBe("allow")
  }),
)

it.instance("normal agents cannot write, edit, grep, glob, or shell out to globalAGENTS.md", () =>
  Effect.gen(function* () {
    const build = yield* load((svc) => svc.get("build"))
    expect(rule(build, "write", "globalAGENTS.md")).toBe("deny")
    expect(rule(build, "edit", "globalAGENTS.md")).toBe("deny")
    expect(rule(build, "grep", "globalAGENTS.md")).toBe("deny")
    expect(rule(build, "glob", "**/globalAGENTS.md")).toBe("deny")
    expect(rule(build, "bash", "cat globalAGENTS.md")).toBe("deny")
  }),
)

it.instance("supervisor agent may read globalAGENTS.md and ask the user", () =>
  Effect.gen(function* () {
    const supervisor = yield* load((svc) => svc.get("supervisor"))
    expect(rule(supervisor, "read", "globalAGENTS.md")).toBe("allow")
    expect(rule(supervisor, "bash", "cat globalAGENTS.md")).toBe("allow")
    expect(rule(supervisor, "write", "globalAGENTS.md")).toBe("allow")
    expect(rule(supervisor, "edit", "src/foo.ts")).toBe("allow")
    expect(rule(supervisor, "question", "*")).toBe("allow")
    expect(rule(supervisor, "session", "*")).toBe("allow")
  }),
)

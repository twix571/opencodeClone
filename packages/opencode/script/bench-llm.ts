// Entry point for the LLM benchmark harness. Sets up an isolated environment
// (temp XDG dirs, models fixture, in-memory DB) BEFORE any src/ module is
// imported — xdg-basedir and Flag read env vars at module evaluation time.
import path from "node:path"
import os from "node:os"
import fs from "node:fs/promises"

const root = path.join(os.tmpdir(), `opencode-bench-llm-${process.pid}`)
await fs.mkdir(path.join(root, "home"), { recursive: true })
await fs.mkdir(path.join(root, "cache", "opencode"), { recursive: true })
await fs.writeFile(path.join(root, "cache", "opencode", "version"), "14")

process.env["XDG_DATA_HOME"] = path.join(root, "data")
process.env["XDG_CONFIG_HOME"] = path.join(root, "config")
process.env["XDG_STATE_HOME"] = path.join(root, "state")
process.env["XDG_CACHE_HOME"] = path.join(root, "cache")
process.env["OPENCODE_TEST_HOME"] = path.join(root, "home")
process.env["OPENCODE_MODELS_PATH"] = path.join(import.meta.dir, "../test/tool/fixtures/models-api.json")
process.env["OPENCODE_DB"] = ":memory:"

const { main } = await import("./bench-llm-run")
await main(process.argv.slice(2))

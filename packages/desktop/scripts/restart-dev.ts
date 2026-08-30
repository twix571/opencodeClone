import { $ } from "bun"
import { spawn } from "node:child_process"
import { openSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, "..", "..", "..")
const LOG = join(process.env.TMPDIR ?? "/tmp", "opencode-desktop.log")

const DEV_PATTERNS = [
  /node_modules\/\.bun\/electron@/,
  /ai\.opencode\.desktop\.dev/,
  /electron-vite dev/,
  /bun run dev:desktop(\s|$)/,
  /bun --cwd packages\/desktop dev(\s|$)/,
]

async function findPids(): Promise<number[]> {
  const out = await $`ps -axo pid=,command=`.text()
  const pids: number[] = []
  for (const line of out.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (!match) continue
    if (Number(match[1]) === process.pid) continue
    if (DEV_PATTERNS.some((pattern) => pattern.test(match[2]))) pids.push(Number(match[1]))
  }
  return pids
}

async function waitForExit(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const remaining = await findPids()
    if (remaining.length === 0) return true
    await Bun.sleep(200)
  }
  return false
}

async function stopDevProcesses() {
  const pids = await findPids()
  if (pids.length === 0) {
    console.log("no dev desktop processes are running")
    return
  }
  console.log(`stopping dev desktop processes: ${pids.join(", ")}`)
  await $`kill ${pids}`.quiet().nothrow()
  if (await waitForExit(10_000)) return
  const survivors = await findPids()
  if (survivors.length === 0) return
  await $`kill -9 ${survivors}`.quiet().nothrow()
  await waitForExit(5_000)
  const remaining = await findPids()
  if (remaining.length > 0) console.warn(`processes still running: ${remaining.join(", ")}`)
}

async function waitForReady(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const content = await Bun.file(LOG).text()
    if (content.includes("server ready")) return true
    await Bun.sleep(1_000)
  }
  return false
}

await stopDevProcesses()

await Bun.write(LOG, "")
console.log("launching dev desktop...")
const out = openSync(LOG, "w")
const child = spawn(process.execPath, ["run", "dev:desktop"], {
  cwd: REPO,
  detached: true,
  stdio: ["ignore", out, out],
})
child.unref()
child.on("error", (error) => {
  console.error(`failed to launch dev desktop: ${error.message}`)
  process.exit(1)
})

if (await waitForReady(180_000)) {
  console.log(`dev desktop is ready; logs at ${LOG}`)
} else {
  console.error(`timed out waiting for the dev desktop to come up; see ${LOG}`)
  process.exit(1)
}

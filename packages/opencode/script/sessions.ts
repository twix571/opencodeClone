import { Database } from "bun:sqlite"
import { homedir } from "os"
import { existsSync, readdirSync } from "fs"
import { join } from "path"

interface SessionRow {
  id: string
  parent_id: string | null
  directory: string
  title: string
  agent: string | null
  model: { id: string; providerID: string } | null
  cost: number | null
  tokens_input: number | null
  tokens_output: number | null
  tokens_reasoning: number | null
  tokens_cache_read: number | null
  tokens_cache_write: number | null
  time_created: number
  time_updated: number
  time_archived: number | null
}

interface MsgData {
  role: string
  time?: { created?: number }
  agent?: string
  modelID?: string
  providerID?: string
  finish?: string
  error?: { name?: string; message?: string }
}

interface PartData {
  type: string
  text?: string
  tool?: string
  state?: {
    status: string
    input?: Record<string, unknown>
    output?: string
    error?: string
    title?: string
  }
  mime?: string
  filename?: string
  description?: string
  cost?: number
  tokens?: { input?: number; output?: number }
}

interface ListOpts {
  dir?: string
  agent?: string
  db?: string
  limit: number
}

interface GetOpts {
  last?: number
  role?: string
  db?: string
  reasoning: boolean
  noToolOutput: boolean
  toolOutputLen: number
  children: boolean
}

const dataDir = process.env.XDG_DATA_HOME
  ? join(process.env.XDG_DATA_HOME, "opencode")
  : join(homedir(), ".local", "share", "opencode")

function dbCandidates() {
  const result: string[] = []
  const seen = new Set<string>()
  const push = (p: string) => {
    if (seen.has(p) || !existsSync(p)) return
    seen.add(p)
    result.push(p)
  }
  if (process.env.OPENCODE_DB) {
    push(process.env.OPENCODE_DB.includes("/") ? process.env.OPENCODE_DB : join(dataDir, process.env.OPENCODE_DB))
  }
  if (existsSync(dataDir)) {
    for (const name of readdirSync(dataDir)) {
      if (name.endsWith(".db") && !name.includes("-wal") && !name.includes("-shm")) push(join(dataDir, name))
    }
  }
  const base = join(dataDir, "opencode.db")
  return result.sort((a, b) => (a === base ? -1 : b === base ? 1 : a.localeCompare(b)))
}

function openDb(path: string) {
  const db = new Database(path, { readonly: true })
  db.exec("PRAGMA busy_timeout = 5000")
  return db
}

function hasSessions(db: Database) {
  try {
    db.query("SELECT 1 FROM session LIMIT 1").get()
    return true
  } catch {
    return false
  }
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function fmtTime(t: number | undefined) {
  if (!t) return ""
  const ms = t < 1e11 ? t * 1000 : t
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16)
}

function shortId(id: string) {
  return id.length > 18 ? id.slice(0, 18) : id
}

function truncate(value: string, len: number) {
  if (value.length <= len) return value
  return `${value.slice(0, len)}…`
}

function fmtModel(model: unknown) {
  if (!model) return "-"
  const m =
    typeof model === "string"
      ? (JSON.parse(model) as { id?: string; providerID?: string })
      : (model as { id?: string; providerID?: string })
  return `${m.providerID ?? "?"}/${m.id ?? "?"}`
}

const SESSION_COLS = `id, parent_id, directory, title, agent, model, cost, tokens_input, tokens_output, tokens_reasoning,
                      tokens_cache_read, tokens_cache_write, time_created, time_updated, time_archived`

function cmdList(opts: ListOpts) {
  const dbs = opts.db ? [opts.db] : dbCandidates()
  let found = false
  for (const dbPath of dbs) {
    if (!existsSync(dbPath)) continue
    let db: Database
    try {
      db = openDb(dbPath)
    } catch {
      continue
    }
    if (!hasSessions(db)) continue
    const where: string[] = []
    const params: (string | number)[] = []
    if (opts.dir) {
      const dir = opts.dir.replace(/\/+$/, "")
      where.push("(directory = ? OR directory = ?)")
      params.push(dir, `${dir}/`)
    }
    if (opts.agent) {
      where.push("agent = ?")
      params.push(opts.agent)
    }
    let rows: unknown[] = []
    try {
      rows = db
        .query(
          `SELECT ${SESSION_COLS} FROM session ${where.length ? "WHERE " + where.join(" AND ") : ""}
           ORDER BY time_updated DESC LIMIT ?`,
        )
        .all(...params, opts.limit)
    } catch (e) {
      console.error(`query failed on ${dbPath}: ${(e as Error).message}`)
      continue
    }
    if (rows.length === 0) continue
    found = true
    console.log(`# ${dbPath}`)
    for (const raw of rows) {
      const r = raw as unknown as SessionRow
      const model = fmtModel(r.model)
      console.log(`${fmtTime(r.time_updated)}  ${shortId(r.id)}  ${r.agent ?? "-"}  ${model}  $${(r.cost ?? 0).toFixed(2)}  ${r.directory}`)
      console.log(`    ${truncate(r.title, 120)}${r.parent_id ? `\n    parent: ${r.parent_id}` : ""}`)
    }
    if (opts.db) return
  }
  if (!opts.db && !found) console.error(`no opencode database with sessions found under ${dataDir} (pass --db to point at one)`)
}

function renderMessage(indent: string, data: MsgData, parts: PartData[], opts: GetOpts) {
  const pad = `${indent}  `
  const time = fmtTime(data.time?.created)
  if (data.role === "user") {
    console.log(`\n${indent}> **user**${data.agent ? ` · ${data.agent}` : ""} · ${time}`)
    for (const p of parts) {
      if (p.type === "text" && p.text) console.log(`${pad}${p.text.replace(/\n/g, `\n${pad}`)}`)
      else if (p.type === "file") console.log(`${pad}[file: ${p.filename ?? "attachment"}${p.mime ? ` (${p.mime})` : ""}]`)
      else if (p.type === "compaction") console.log(`${pad}_compacted context_`)
      else if (p.type === "subtask") console.log(`${pad}_subtask: ${p.description ?? ""}_`)
    }
    return
  }
  const model = data.providerID ? `${data.providerID}/${data.modelID ?? ""}` : "-"
  console.log(`\n${indent}> **assistant** · ${model}${data.finish ? ` · ${data.finish}` : ""}${data.error ? " · ERROR" : ""} · ${time}`)
  if (data.error) console.log(`${pad}error: ${data.error.name ?? "Error"}: ${data.error.message ?? JSON.stringify(data.error)}`)
  for (const p of parts) {
    if (p.type === "text") {
      if (p.text) console.log(`${pad}${p.text.replace(/\n/g, `\n${pad}`)}`)
    } else if (p.type === "reasoning") {
      if (!opts.reasoning) continue
      const text = p.text ?? ""
      console.log(`${pad}_reasoning:_ ${truncate(text, 400)}`)
    } else if (p.type === "tool") {
      const state = p.state ?? { status: "unknown" }
      const input = state.input ? truncate(JSON.stringify(state.input), opts.toolOutputLen) : ""
      console.log(`${pad}tool: ${p.tool} [${state.status}]${state.title ? ` · ${state.title}` : ""}`)
      if (input) console.log(`${pad}  input: ${input}`)
      if (!opts.noToolOutput) {
        if (state.status === "completed") console.log(`${pad}  output: ${truncate(state.output ?? "(no output)", opts.toolOutputLen).replace(/\n/g, `\n${pad}  `)}`)
        else if (state.status === "error") console.log(`${pad}  error: ${truncate(state.error ?? "", opts.toolOutputLen)}`)
      }
    } else if (p.type === "step-finish") {
      const tokens = p.tokens
      console.log(`${pad}_step: cost $${(p.cost ?? 0).toFixed(4)}${tokens ? ` tokens in ${tokens.input ?? 0}/out ${tokens.output ?? 0}` : ""}_`)
    } else if (p.type === "compaction") {
      console.log(`${pad}_compacted context_`)
    } else if (p.type === "subtask") {
      console.log(`${pad}_subtask: ${p.description ?? ""}_`)
    }
  }
}

function renderSession(db: Database, id: string, opts: GetOpts, depth = 0) {
  const session = db
    .query(`SELECT ${SESSION_COLS} FROM session WHERE id = ?`)
    .get(id) as unknown as SessionRow | undefined
  if (!session) return false
  const indent = "  ".repeat(depth)
  const model = fmtModel(session.model)
  console.log(`\n# session ${session.id} · ${session.agent ?? "-"} · ${model}`)
  console.log(`  ${session.title}`)
  console.log(`  ${session.directory}`)
  console.log(
    `  ${fmtTime(session.time_created)} → ${fmtTime(session.time_updated)}  cost $${(session.cost ?? 0).toFixed(4)}  tokens in ${session.tokens_input ?? 0}/out ${session.tokens_output ?? 0}/rsn ${session.tokens_reasoning ?? 0}`,
  )
  let rows = db
    .query("SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC")
    .all(id) as unknown as Array<{ id: string; data: unknown }>
  if (opts.role) rows = rows.filter((m) => (parseJson(m.data) as MsgData).role === opts.role)
  if (opts.last) rows = rows.slice(-opts.last)
  const partRows = db
    .query("SELECT message_id, data FROM part WHERE session_id = ? ORDER BY message_id ASC, id ASC")
    .all(id) as unknown as Array<{ message_id: string; data: unknown }>
  const partsByMessage = new Map<string, PartData[]>()
  for (const p of partRows) {
    const data = parseJson(p.data) as PartData
    const list = partsByMessage.get(p.message_id)
    if (list) list.push(data)
    else partsByMessage.set(p.message_id, [data])
  }
  for (const m of rows) {
    const data = parseJson(m.data) as MsgData
    const parts = partsByMessage.get(m.id) ?? []
    renderMessage(indent, data, parts, opts)
  }
  if (opts.children) {
    const children = db
      .query("SELECT id, title, agent, time_updated FROM session WHERE parent_id = ? ORDER BY time_updated ASC")
      .all(id) as unknown as Array<{ id: string; title: string; agent: string | null; time_updated: number }>
    for (const child of children) {
      console.log(`\n${indent}## child session ${child.id} ${child.agent ?? "-"} · ${fmtTime(child.time_updated)}`)
      renderSession(db, child.id, opts, depth + 1)
    }
  }
  return true
}

function flagValue(args: string[], name: string) {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

function parseList(args: string[]) {
  const limit = Number(flagValue(args, "--limit") ?? "30")
  return {
    dir: flagValue(args, "--dir") ?? flagValue(args, "--directory"),
    agent: flagValue(args, "--agent"),
    db: flagValue(args, "--db"),
    limit: Number.isFinite(limit) && limit > 0 ? limit : 30,
  } satisfies ListOpts
}

function parseGet(args: string[]) {
  const toolOutputLen = Number(flagValue(args, "--tool-output-len") ?? "800")
  const last = Number(flagValue(args, "--last") ?? "0")
  return {
    last: last > 0 ? last : undefined,
    role: flagValue(args, "--role"),
    db: flagValue(args, "--db"),
    reasoning: args.includes("--reasoning"),
    noToolOutput: args.includes("--no-tool-output"),
    children: args.includes("--children"),
    toolOutputLen: Number.isFinite(toolOutputLen) && toolOutputLen > 0 ? toolOutputLen : 800,
  } satisfies GetOpts
}

function usage() {
  console.log(`sessions — read opencode session data from the SQLite database

usage:
  bun run script/sessions.ts list [--dir <path>] [--limit N] [--agent <name>] [--db <path>]
  bun run script/sessions.ts get <sessionID> [--last N] [--role user|assistant] [--reasoning] [--no-tool-output] [--tool-output-len N] [--children] [--db <path>]
  bun run script/sessions.ts dbs
`)
}

const args = process.argv.slice(2)
const cmd = args[0]

if (cmd === "dbs") {
  for (const dbPath of dbCandidates()) {
    let db: Database | undefined
    try {
      db = openDb(dbPath)
    } catch {
      continue
    }
    if (!hasSessions(db)) {
      console.log(`${dbPath} (no session table)`)
      continue
    }
    const count = (db.query("SELECT COUNT(*) AS n FROM session").get() as { n: number }).n
    console.log(`${dbPath} sessions=${count}`)
  }
  process.exit(0)
}

if (cmd === "list") {
  cmdList(parseList(args.slice(1)))
  process.exit(0)
}

if (cmd === "get") {
  const id = args[1]
  if (!id) {
    usage()
    process.exit(1)
  }
  const opts = parseGet(args.slice(2))
  const dbs = opts.db ? [opts.db] : dbCandidates()
  for (const dbPath of dbs) {
    if (!existsSync(dbPath)) continue
    let db: Database
    try {
      db = openDb(dbPath)
    } catch {
      continue
    }
    if (!hasSessions(db)) continue
    if (renderSession(db, id, opts)) process.exit(0)
  }
  console.error(`session not found: ${id}`)
  process.exit(1)
}

usage()
process.exit(1)

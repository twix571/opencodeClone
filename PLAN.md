# The Plan: Supervisor Agent + Per-Session Worktrees (Technical)

This is the exact, detailed version. Every part maps to real code that exists or
a concrete change we will make. Nothing is vague here.

## 1. The problem, precisely

Two desktop sessions pointed at the same project directory (`/Users/julian/Documents/opencodeClone`)
share one git working tree and one git index. When a session's agent runs
`git add -A && git commit`, it stages EVERY modified file in the repo,
including the other session's uncommitted work. There is no per-session
tracking today (`session_diff` is populated only by revert, session/revert.ts:77,
and is empty in practice). Fixing this with tracking is a soft, leaky fix.

**Decision: real isolation via one git worktree per session.** Two sessions
cannot touch the same file because they have separate directories, separate
indexes, separate branches. The mixing bug becomes impossible, and per-session
commits become trivial (one branch = one session's work).

## 2. Per-session worktree placement (server side)

When the desktop creates a session (today: `tabs.newDraft({ server, directory })`
→ server `session.create` with that directory), the server instead does:

1. Check `ctx.project.vcs === "git"` — otherwise fail with `WorktreeNotGitError`
   (worktree/index.ts:242). Non-git projects keep the shared directory.
2. `Worktree.create({ name: <session title>, runStart: false })` which:
   - Generates a unique slugged name and branch `opencode/<name>` (worktree/index.ts:221).
   - Directory = `Global.Path.data/worktree/<projectID>/<name>` (worktree/index.ts:246).
   - Runs `git worktree add --no-checkout -b opencode/<name> <dir>` from the primary worktree (worktree/index.ts:256).
   - Registers it via `project.addSandbox(projectID, directory)` (worktree/index.ts:266).
   - Boots async: `git reset --hard`, `provisionNodeModules` (symlink `node_modules`
     from primary so no reinstall — worktree/index.ts:288, 348), `InstanceStore.load`,
     then emits `WorktreeEvent.Ready` on the GlobalBus (worktree/index.ts:308).
   - Waits for `Ready`/`Failed` via `Worktree.waitReady` (worktree/index.ts:121).
3. The session's `directory` becomes the worktree path; `Session.Info` gains a new
   optional `worktree: { directory, branch }` field (like delegate metadata at
   tool/delegate.ts:137).

Everything already gets scoped per directory once the session points there:
`SessionRunner`, model resolution, tool registry, permissions, filesystem —
all Location-scoped per AGENTS.md. So the worktree change is mostly "point the
session at the worktree at creation time."

**Delegates inherit the session's worktree (delegate worktrees removed).**
Delegates no longer create their own worktrees (the current default
`worktree: true` in tool/delegate.ts:21 is removed). A delegate runs inside the
session's directory/branch, so its edits and its auto-commit land on the
session's branch. Wrap-up merges that one branch — no nested worktrees to
reconcile, and a delegate can never collide with a *different* session.

**Read-only session mode (optional, default OFF).** A per-session toggle that
restricts the session agent to `read`/`grep`/`glob`/`delegate` only — no editing
tools, no shell writes. When locked, all actual changes happen in delegates, which
run inside the session's worktree anyway. Default stays editable.

**Result:** each session edits its own files (or only delegates, if the session is
locked read-only) on its own branch. Sessions are forbidden (system prompt +
permission rules) from running `commit`/`push`.

## 3. Session-end trigger ("done" = BackgroundJob completion, not idle)

`SessionStatusEvent.Idle` is a poor "done" signal: it fires after EVERY turn
(session/status.ts:41-43), meaning "not busy right now," not "finished." A
session can sit idle for an hour and resume. So the supervisor does NOT key
wrap-up off idle.

The delegation machinery already has the precise signal: `BackgroundJob` tracks
a **terminal** state — `running | completed | error | cancelled` with
`started_at`/`completed_at` (core/src/background-job.ts:7-19, :146-163). A
delegate job flips to `completed` only when the whole `run` effect resolves —
`runTaskPrompt` → `ops.prompt(...)` (task.ts:186-219), which awaits the full
provider loop (every model call + tool call) and returns the final assistant
message. The parent is notified via `background.wait()` → `injectTaskResult`
(delegate.ts:187-196). That is "this work unit is truly done," unlike idle.

**Change:** run each supervised session's work the same way — a tracked job whose
terminal state is the "done" trigger — so top-level sessions get the same precise
completion signal delegates have. When a session's job reaches a terminal state,
the supervisor composes a `SessionDigest`:
- Calls `SessionSummary.diff` / `computeDiff` (session/summary.ts:82-100) to get
  `Snapshot.FileDiff[]` (already computed from `step-start`/`step-finish` snapshots).
- Reads the session's cost/tokens, title, agent, model from `Session.Info`.
- Reads the session's `worktree.branch`.
- **New schema:** `SessionDigest`:
  `{ sessionID, title, branch, files: FileDiff[], messageSummary, cost, tokens, ruleCheck, jobStatus }`.

This digest — not raw history — is what the supervisor reads. Cheap and structured.

**Caveat:** the job registry is process-local and non-durable
(core/src/background-job.ts:113-119) — restart loses it. Use it as a live trigger,
and pair it with a user-defined "done" rule (e.g. user marks the session done, or
no queued input + not resumed for X) for the durable half.

## 4. The supervisor (global agent)

A special session type, one per open desktop workspace, e.g. agent id
`"supervisor"`. It runs at workspace scope and can act across the workspace's
projects/repos (committing per repo).

- **Entry point:** the system prompt for the supervisor is a fixed agent config.
- **Wake-up:** an event handler — a new `supervisor` tool (modeled on the `session`
  tool at src/tool/session.ts) that fires when a supervised session's tracked job
  reaches a terminal state (`completed`/`error`/`cancelled` — see section 3), not
  on idle. The backend auto-feeds it the `SessionDigest` + the session's worktree
  diff, so it does not need to go hunting.
- **What it does NOT see:** not every response. The supervisor only gets structured
  signals — the digest, the diff, and rule-check flags — plus whatever specific
  messages it chooses to fetch on demand via the `session` tool. It never
  mirrors a session's full transcript in real time.
- **Answering session questions:** session agents can ask the supervisor questions
  through a dedicated channel (a `supervisor_ask` tool/event — e.g. "is touching
  this path allowed?" or "how should I handle this?"). The supervisor answers from
  rules + its memory without having to read the session transcript. This is a
  direct session→supervisor back-channel, separate from the digest stream.
- **Escalation to the user:** when the supervisor is NOT confident — about a rule
  decision, a session's question, a commit grouping, or a merge conflict — it asks
  the USER directly (a question dialog) rather than guessing. Same mechanism as the
  wrap-up question.
- **What it does on wake-up:** reviews the digest against rules, checks the worktree
  diff, then comes back to the USER and asks which action to take. This is surfaced
  in the desktop as a notification/dialog with three buttons:
  1. **Commit** — commit the session's branch into the primary branch, no push.
  2. **Commit and push** — same, then push to the remote.
  3. **Restart GUI with these changes** — after committing, trigger the app relaunch
     so the dev GUI rebuilds with the new code.

## 5. Rules: globalAGENTS.md

- One rules file per workspace (location TBD — workspace root or config dir).
- Naming it `globalAGENTS.md` (not `AGENTS.md`) means the auto-loader never feeds
  it to normal agents. The supervisor's system prompt explicitly includes it.
- **Enforce secrecy in the permission layer:** the permission system already
  supports `deny` rules with wildcards (permission/index.ts:75, `evaluate` at :28).
  We add deny rules so `read`/`grep`/`glob`/`shell` calls matching
  `**/globalAGENTS.md` are rejected for all non-supervisor sessions. Even if a
  session agent is told to read it, it cannot.
- **Memory:** the supervisor also keeps a persisted list of "lessons learned"
  from past wrap-ups (stored in its own session metadata), on top of the file.

## 6. Proactive enforcement

Rule checks run on **structured tool-call metadata** (tool name, file path,
permission result) streamed from sessions — not on LLM text responses, and not by
reading every message. When a check flags a violation, the supervisor sends the
session a corrective "ping" mid-run via the normal message API. The supervisor
reads an actual response only when a flag needs investigation, and if it is unsure
whether something is actually a violation, it asks the USER rather than guessing.

## 7. Wrap-up commit flow (per-session scoped commits)

Because each session — and every delegate that ran for it — lives on that one
session's branch, "scoped commits" are automatic:

1. **Commit the worktree:** in the session's worktree run `git add -A` +
   `git commit -m "<session title>"`. Safe — the worktree contains only that
   session's files (including anything its delegates wrote), so nothing else can
   be swept in (the original bug).
2. **Merge to primary:** `git merge opencode/<session-branch>` (or cherry-pick)
   into the primary branch. The supervisor resolves conflicts deliberately and
   reports them to the user rather than guessing.
3. **Push:** only on user choice #2.
4. **Restart GUI:** the desktop main process already exposes `relaunch`
   (packages/desktop/src/main/ipc.ts:274 → `app.relaunch()`). For the dev loop,
   this maps to the existing `dev:desktop:restart` flow (rebuild server bundle,
   kill stale processes, relaunch, wait for `server ready`). The supervisor
   requests the relaunch via a new IPC after the merge is committed.
5. **Cleanup:** once merged, `Worktree.remove({ directory })` (worktree/index.ts:474)
   deletes the worktree, its `opencode/<name>` branch, and its `node_modules` links.

## 8. Side panel (I/O observability)

A panel per session showing everything the agent receives and sends:
raw model request/response, full context sent, and every tool call/result.
All of this already flows through `SessionV1` parts (tool parts, text parts,
reasoning parts) and is present in the client store — this is a UI feature, not
new backend plumbing.

## 9. Auto-compaction (deterministic, not rewrite)

Reuse the existing machinery, do NOT add an LLM that rewrites live context:
- `session/compaction.ts` already prunes old turns deterministically
  (PRUNE_MINIMUM=20k, PRUNE_PROTECT=40k, recent tokens preserved).
- `SessionSummary.summarize`/`computeDiff` already produce per-turn file diffs.
- **New:** a "digest writer" that runs when a session's tracked job reaches a
  terminal state (section 3) and writes the `SessionDigest` to storage. The
  supervisor reads digests only.

## 10. New schema / contracts to add

- `SessionDigest` (section 3): schema + event definition in `packages/schema`.
- `Session.Info.worktree?: { directory, branch }`.
- Session run tracking: top-level sessions run as `BackgroundJob`-style tracked
  jobs (reuse `BackgroundJob`, or a durable variant given it is process-local).
- New tool `supervisor` (or `session_wrapup`) + its tool description.
- New tool `supervisor_ask`: the session→supervisor question channel (section 4).
- Read-only session flag: per-session config/toggle (default OFF).
- New permission rule set: deny reads of `**/globalAGENTS.md` for non-supervisors.
- New desktop IPC: `session-wrapup` (options + result), and reuse `relaunch`.

## 11. Build order

1. **Worktree per session on create** (server) + `Session.Info.worktree` + forbid
   commit/push in session prompts + **remove delegate worktrees** (delegates inherit
   the session's worktree).
2. **Track sessions as jobs**: run each session's turn as a tracked job with a
   terminal state (mirroring `BackgroundJob`), the "done" trigger for the supervisor.
3. **SessionDigest writer** at job completion (reuse summary/compaction).
4. **Supervisor session** + `globalAGENTS.md` + deny-read permission rules.
5. **Session-end tool** → supervisor auto-prompt with the 3 options (commit /
   commit+push / restart GUI).
6. **Supervisor Q&A**: `supervisor_ask` back-channel + escalation to the user when
   unsure.
7. **Wrap-up execution**: worktree commit, merge, push, relaunch IPC, worktree cleanup.
8. **Read-only session toggle** (default OFF).
9. **Side panel** I/O observability.
10. **Proactive pings** (structured tool-call rule checks).

## 12. Open decisions to nail down before building

- **"Done" durable half:** the job-completion trigger is precise but process-local;
   pair it with a user-defined rule (user marks session done, or no queued input +
   not resumed for X) so it survives restarts.
- Where exactly `globalAGENTS.md` lives per workspace.
- Merge target: directly to the primary branch vs. a staging branch the user reviews.
- Worktree lifecycle when a session is closed mid-task.
- Multi-project workspace: supervisor scope and per-repo commits.
- Perf: each worktree boot = checkout + node_modules symlinks + start script; verify
   acceptable for the opencode repo.

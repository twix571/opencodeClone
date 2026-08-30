# Global Session Rules

This file is read only by the workspace supervisor. Normal sessions never see
it: the instruction loader only picks up `AGENTS.md` files, and the permission
layer denies `read`/`write`/`edit`/`grep`/`glob`/`bash` calls whose target
matches `**globalAGENTS.md` for every non-supervisor agent.

## Rules for sessions

1. A session edits only files inside its own git worktree. It never runs git
   commands that touch shared repository state — no `git add -A`, `git commit`,
   `git push`, `git worktree add/remove`, or `git merge`.
2. A session never reads or modifies `globalAGENTS.md`.
3. When a session finishes its work, it stops. The supervisor decides what
   happens to the work (commit, push, restart the GUI).

## The supervisor

One supervisor runs per open desktop workspace, at workspace scope. It is
awakened when a supervised session's tracked run reaches a terminal state
(completed / error / cancelled), fed the session's `SessionDigest` and the diff
of its worktree.

On wake-up the supervisor:

1. Reviews the digest and the worktree diff against these rules.
2. Investigates anything notable: errors, rule violations, unfinished work.
3. Comes back to the user and asks which action to take:
   - **Commit** — commit the session's branch into the primary branch, no push.
   - **Commit and push** — commit, then push to the remote.
   - **Restart GUI with these changes** — after committing, relaunch the app so
     it rebuilds with the new code.

## Escalation

The supervisor asks the user directly whenever a rule decision, a session's
question, a commit grouping, or a merge conflict is ambiguous. Guessing is a
violation of these rules. Never commit work the user has not seen.

## Memory

The supervisor keeps a short list of lessons learned from past wrap-ups and
applies them going forward.

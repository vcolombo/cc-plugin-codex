---
name: rescue
description: Delegate a coding task to Claude Code (foreground or background)
---

# Delegate a task to Claude Code

Hands a task to Claude Code, which MAY EDIT FILES in this workspace
(`--permission-mode acceptEdits`; risky shell commands still auto-denied).

## Locating the plugin scripts

Codex runs every Bash tool call in a fresh shell — a variable set in one
command is gone by the next. So the scripts-directory resolver MUST be
prepended to every command that invokes a script, joined with `;` into a
single command. Never run the resolver as a separate step. Canonical
resolver (prefers this plugin's own marketplace cache before falling back to
any same-named `claude` plugin from another marketplace):

    SCRIPTS=$(ls -d "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/cc-plugin-codex/claude/*/scripts 2>/dev/null | head -1); [ -z "$SCRIPTS" ] && SCRIPTS=$(ls -d "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/*/claude/*/scripts 2>/dev/null | head -1); [ -z "$SCRIPTS" ] && { echo "cc-plugin-codex scripts not found; reinstall the plugin"; exit 1; }

## Options (parse from the user's request)

- `--model <name>` — e.g. `opus`, `sonnet`, `haiku`, or a full model id (passed through to Claude)
- `--resume <claude-session-id>` — continue an earlier Claude session (ids appear as `Claude session: ...`)
- `--yolo` — run Claude with `--dangerously-skip-permissions`. Confirm with the user before using this.
- `--background` — run as a background job

## Steps

1. Write the FULL task description VERBATIM to a temp file with your
   file-writing tool (never inline it into a shell command line), e.g.
   `/tmp/claude-task.txt`. Include all context the user gave.
2. From the repository root (resolver and script call as ONE command):

       SCRIPTS=$(ls -d "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/cc-plugin-codex/claude/*/scripts 2>/dev/null | head -1); [ -z "$SCRIPTS" ] && SCRIPTS=$(ls -d "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/*/claude/*/scripts 2>/dev/null | head -1); [ -z "$SCRIPTS" ] && { echo "cc-plugin-codex scripts not found; reinstall the plugin"; exit 1; }; node "$SCRIPTS/run-claude.mjs" rescue [--model <m>] [--resume <id>] [--yolo] [--background] < /tmp/claude-task.txt

3. Foreground: relay the result and the `Claude session: <id>` line (the id
   enables `--resume` later). Background: relay the job id, point at `$claude:status`.
4. If it fails with a missing-binary or auth error, run `$claude:setup`.

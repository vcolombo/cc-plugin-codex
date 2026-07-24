---
name: cancel
description: Cancel a running background Claude Code job
---

# Cancel a Claude job

## Locating the plugin scripts

Codex runs every Bash tool call in a fresh shell — a variable set in one
command is gone by the next. So the scripts-directory resolver MUST be
prepended to every command that invokes a script, joined with `;` into a
single command. Never run the resolver as a separate step. Canonical
resolver (prefers this plugin's own marketplace cache before falling back to
any same-named `claude` plugin from another marketplace):

    SCRIPTS=$(ls -d "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/cc-plugin-codex/claude/*/scripts 2>/dev/null | sort -V | tail -1); [ -z "$SCRIPTS" ] && SCRIPTS=$(ls -d "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/*/claude/*/scripts 2>/dev/null | sort -V | tail -1); [ -z "$SCRIPTS" ] && { echo "cc-plugin-codex scripts not found; reinstall the plugin"; exit 1; }

## Steps

1. Determine the job id (from the user, or run, as ONE command:
   `SCRIPTS=$(ls -d "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/cc-plugin-codex/claude/*/scripts 2>/dev/null | sort -V | tail -1); [ -z "$SCRIPTS" ] && SCRIPTS=$(ls -d "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/*/claude/*/scripts 2>/dev/null | sort -V | tail -1); [ -z "$SCRIPTS" ] && { echo "cc-plugin-codex scripts not found; reinstall the plugin"; exit 1; }; node "$SCRIPTS/jobs.mjs" list`).
2. Run, as ONE command:

       SCRIPTS=$(ls -d "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/cc-plugin-codex/claude/*/scripts 2>/dev/null | sort -V | tail -1); [ -z "$SCRIPTS" ] && SCRIPTS=$(ls -d "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/*/claude/*/scripts 2>/dev/null | sort -V | tail -1); [ -z "$SCRIPTS" ] && { echo "cc-plugin-codex scripts not found; reinstall the plugin"; exit 1; }; node "$SCRIPTS/jobs.mjs" cancel <id>

3. The supervisor finalizes the record as `cancelled`; confirm via `$claude:status`.

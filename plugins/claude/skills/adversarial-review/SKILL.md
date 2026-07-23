---
name: adversarial-review
description: Steerable adversarial Claude Code review that challenges design choices and risk areas
---

# Adversarial Claude Code review

Like `$claude:review`, but Claude is told to challenge design decisions,
tradeoffs, and risk areas, with an optional user-supplied focus. Read-only.

## Locating the plugin scripts

Codex runs every Bash tool call in a fresh shell — a variable set in one
command is gone by the next. So the scripts-directory resolver MUST be
prepended to every command that invokes a script, joined with `;` into a
single command. Never run the resolver as a separate step. Canonical
resolver (prefers this plugin's own marketplace cache before falling back to
any same-named `claude` plugin from another marketplace):

    SCRIPTS=$(ls -d "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/cc-plugin-codex/claude/*/scripts 2>/dev/null | sort -V | tail -1); [ -z "$SCRIPTS" ] && SCRIPTS=$(ls -d "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/*/claude/*/scripts 2>/dev/null | sort -V | tail -1); [ -z "$SCRIPTS" ] && { echo "cc-plugin-codex scripts not found; reinstall the plugin"; exit 1; }

## Options (parse from the user's request)

- Focus text: whatever the user wants scrutinized (may be empty)
- `--base <ref>`, `--background` — same as `$claude:review`

## Steps

1. If the user gave focus text, write it VERBATIM to a temp file with your
   file-writing tool (never inline it into a shell command line), e.g.
   `/tmp/claude-focus.txt`.
2. From the repository root (resolver and script call as ONE command):

       SCRIPTS=$(ls -d "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/cc-plugin-codex/claude/*/scripts 2>/dev/null | sort -V | tail -1); [ -z "$SCRIPTS" ] && SCRIPTS=$(ls -d "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/*/claude/*/scripts 2>/dev/null | sort -V | tail -1); [ -z "$SCRIPTS" ] && { echo "cc-plugin-codex scripts not found; reinstall the plugin"; exit 1; }; node "$SCRIPTS/run-claude.mjs" review --adversarial [--base <ref>] [--background] < /tmp/claude-focus.txt

   (use `< /dev/null` when there is no focus text)
3. Relay findings verbatim. (Review runs are not resumable, so no
   `Claude session:` line is printed.)

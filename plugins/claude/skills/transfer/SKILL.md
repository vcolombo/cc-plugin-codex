---
name: transfer
description: Hand this Codex session off to an interactive Claude Code session
---

# Transfer session to Claude Code

Builds a handoff document from this session and gives the user a command that
starts interactive Claude Code with it. You compose the narrative; the script
only extracts bounded, redacted evidence and handles files safely.

## Locating the plugin scripts

Codex runs every Bash tool call in a fresh shell — a variable set in one
command is gone by the next. So the scripts-directory resolver MUST be
prepended to every command that invokes a script, joined with `;` into a
single command. Never run the resolver as a separate step. Canonical
resolver (prefers this plugin's own marketplace cache before falling back to
any same-named `claude` plugin from another marketplace):

    SCRIPTS=$(ls -d "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/cc-plugin-codex/claude/*/scripts 2>/dev/null | sort -V | tail -1); [ -z "$SCRIPTS" ] && SCRIPTS=$(ls -d "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/*/claude/*/scripts 2>/dev/null | sort -V | tail -1); [ -z "$SCRIPTS" ] && { echo "cc-plugin-codex scripts not found; reinstall the plugin"; exit 1; }

## Steps

1. Run, as ONE command:

       SCRIPTS=$(ls -d "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/cc-plugin-codex/claude/*/scripts 2>/dev/null | sort -V | tail -1); [ -z "$SCRIPTS" ] && SCRIPTS=$(ls -d "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/*/claude/*/scripts 2>/dev/null | sort -V | tail -1); [ -z "$SCRIPTS" ] && { echo "cc-plugin-codex scripts not found; reinstall the plugin"; exit 1; }; node "$SCRIPTS/transfer.mjs" extract < /dev/null
   - Exit 2 with candidate transcripts listed: ask the user which one, then
     re-run the same command but with the chosen path as an argument —
     `node "$SCRIPTS/transfer.mjs" extract "<chosen-path>" < /dev/null`.
   - Output is JSON: `goals`, `recent` (last exchanges), `filesTouched`.
2. Compose the handoff narrative from the evidence AND your own knowledge of
   this session. Sections: Goal, Key decisions, Files touched, Current state,
   Next steps. Do not include secrets. Start it with `# Handoff from Codex`.
3. Write the narrative VERBATIM to a temp file with your file-writing tool,
   then run (resolver and script call as ONE command):

       SCRIPTS=$(ls -d "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/cc-plugin-codex/claude/*/scripts 2>/dev/null | sort -V | tail -1); [ -z "$SCRIPTS" ] && SCRIPTS=$(ls -d "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/*/claude/*/scripts 2>/dev/null | sort -V | tail -1); [ -z "$SCRIPTS" ] && { echo "cc-plugin-codex scripts not found; reinstall the plugin"; exit 1; }; node "$SCRIPTS/transfer.mjs" write-handoff < /tmp/claude-handoff.txt

4. Relay the printed handoff path and launch command to the user. DO NOT run
   the launch command yourself — it starts an interactive TUI the user must own.

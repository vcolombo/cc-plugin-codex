---
name: result
description: Fetch the result of a background Claude Code job
---

# Claude job result

## Locating the plugin scripts

Resolve the scripts directory once (single glob match expected):

    SCRIPTS=$(ls -d "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/*/claude/*/scripts 2>/dev/null | head -1)

If `$SCRIPTS` is empty the plugin install is broken — tell the user to reinstall the plugin.

## Steps

1. Determine the job id (from the user, or `node "$SCRIPTS/jobs.mjs" list`).
2. Run: `node "$SCRIPTS/jobs.mjs" result <id>`
3. Relay the result, including any `Claude session:` line (usable with
   `$claude:rescue --resume <id>`).

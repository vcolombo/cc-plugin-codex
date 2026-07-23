---
name: status
description: List background Claude Code jobs for this workspace
---

# Claude job status

## Locating the plugin scripts

Resolve the scripts directory once (single glob match expected):

    SCRIPTS=$(ls -d ~/.codex/plugins/cache/*/claude/*/scripts 2>/dev/null | head -1)

If `$SCRIPTS` is empty the plugin install is broken — tell the user to reinstall the plugin.

## Steps

1. From the repository root: `node "$SCRIPTS/jobs.mjs" list`
2. Relay the table. Statuses: starting, running, done, failed, cancelled, died.

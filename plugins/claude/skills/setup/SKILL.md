---
name: setup
description: Check Claude Code install/auth for this plugin and toggle the Stop review gate
---

# Claude plugin setup

## Locating the plugin scripts

Resolve the scripts directory once (single glob match expected):

    SCRIPTS=$(ls -d "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/*/claude/*/scripts 2>/dev/null | head -1)

If `$SCRIPTS` is empty the plugin install is broken — tell the user to reinstall the plugin.

## Steps

1. Run: `node "$SCRIPTS/setup.mjs" status < /dev/null` and interpret the JSON:
   - `claude.found: false` — offer `npm install -g @anthropic-ai/claude-code`.
     Run it ONLY after the user explicitly confirms.
   - `auth` shows logged out — tell the user to run `claude` once and log in
     (do not handle credentials yourself).
   - `sessionRecorded: false` — plugin hooks not trusted yet or session predates
     install; suggest approving hooks and starting a fresh Codex session.
   - Relay the `notes` about sandbox/network requirements.
2. Gate toggle on request:
   - Enable: `node "$SCRIPTS/setup.mjs" gate on` — WARN: every stop triggers a
     Claude review; token cost, possible loops, and the hook runs outside the
     Codex sandbox.
   - Disable: `node "$SCRIPTS/setup.mjs" gate off`

---
name: adversarial-review
description: Steerable adversarial Claude Code review that challenges design choices and risk areas
---

# Adversarial Claude Code review

Like `$claude:review`, but Claude is told to challenge design decisions,
tradeoffs, and risk areas, with an optional user-supplied focus. Read-only.

## Locating the plugin scripts

Resolve the scripts directory once (single glob match expected):

    SCRIPTS=$(ls -d "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/*/claude/*/scripts 2>/dev/null | head -1)

If `$SCRIPTS` is empty the plugin install is broken — tell the user to reinstall the plugin.

## Options (parse from the user's request)

- Focus text: whatever the user wants scrutinized (may be empty)
- `--base <ref>`, `--background` — same as `$claude:review`

## Steps

1. If the user gave focus text, write it VERBATIM to a temp file with your
   file-writing tool (never inline it into a shell command line), e.g.
   `/tmp/claude-focus.txt`.
2. From the repository root:

       node "$SCRIPTS/run-claude.mjs" review --adversarial [--base <ref>] [--background] < /tmp/claude-focus.txt

   (use `< /dev/null` when there is no focus text)
3. Relay findings verbatim, including the `Claude session:` line.

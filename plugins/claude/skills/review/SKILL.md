---
name: review
description: Read-only Claude Code review of uncommitted changes, optionally against a base branch
---

# Claude Code review

Runs Claude Code in a locked-down read-only mode over precomputed git evidence
(status, staged/unstaged diffs, untracked files). It never modifies the repository.

## Locating the plugin scripts

Resolve the scripts directory once (single glob match expected):

    SCRIPTS=$(ls -d "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/*/claude/*/scripts 2>/dev/null | head -1)

If `$SCRIPTS` is empty the plugin install is broken — tell the user to reinstall the plugin.

## Options (parse from the user's request)

- `--base <ref>` — also review commits since the merge-base with `<ref>`
- `--background` — run as a background job instead of waiting

## Steps

1. From the repository root, run exactly:

       node "$SCRIPTS/run-claude.mjs" review [--base <ref>] [--background] < /dev/null

2. Foreground: relay Claude's findings verbatim, including the trailing
   `Claude session: <id>` line. Background: relay the printed job id and point
   the user at `$claude:status`.
3. If it fails with a missing-binary or auth error, run `$claude:setup`.

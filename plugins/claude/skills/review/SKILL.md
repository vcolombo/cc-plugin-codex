---
name: review
description: Read-only Claude Code review of uncommitted changes, optionally against a base branch
---

# Claude Code review

Runs Claude Code in a locked-down read-only mode over precomputed git evidence
(status, staged/unstaged diffs, untracked files). It never modifies the repository.

## Locating the plugin scripts

Codex runs every Bash tool call in a fresh shell — a variable set in one
command is gone by the next. So the scripts-directory resolver MUST be
prepended to every command that invokes a script, joined with `;` into a
single command. Never run the resolver as a separate step. Canonical
resolver (prefers this plugin's own marketplace cache before falling back to
any same-named `claude` plugin from another marketplace):

    SCRIPTS=$(ls -d "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/cc-plugin-codex/claude/*/scripts 2>/dev/null | head -1); [ -z "$SCRIPTS" ] && SCRIPTS=$(ls -d "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/*/claude/*/scripts 2>/dev/null | head -1); [ -z "$SCRIPTS" ] && { echo "cc-plugin-codex scripts not found; reinstall the plugin"; exit 1; }

## Options (parse from the user's request)

- `--base <ref>` — also review commits since the merge-base with `<ref>`
- `--background` — run as a background job instead of waiting

## Steps

1. From the repository root, run exactly (resolver and script call as ONE command):

       SCRIPTS=$(ls -d "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/cc-plugin-codex/claude/*/scripts 2>/dev/null | head -1); [ -z "$SCRIPTS" ] && SCRIPTS=$(ls -d "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/*/claude/*/scripts 2>/dev/null | head -1); [ -z "$SCRIPTS" ] && { echo "cc-plugin-codex scripts not found; reinstall the plugin"; exit 1; }; node "$SCRIPTS/run-claude.mjs" review [--base <ref>] [--background] < /dev/null

2. Foreground: relay Claude's findings verbatim. Background: relay the printed
   job id and point the user at `$claude:status`. (Review runs are not
   resumable, so no `Claude session:` line is printed.)
3. If it fails with a missing-binary or auth error, run `$claude:setup`.

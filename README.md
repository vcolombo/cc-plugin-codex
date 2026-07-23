# cc-plugin-codex

A Codex plugin that lets you drive [Claude Code](https://github.com/anthropics/claude-code) from inside a Codex session — code review, task delegation, background jobs, and session handoff. It is the mirror image of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) (which lets Claude Code drive Codex): same shape, opposite direction.

## What it is

Once installed, Codex gains eight skills, each backed by a script that shells out to the `claude` CLI:

| Skill | What it does |
| --- | --- |
| `$claude:review` | Read-only Claude Code review of your uncommitted changes (status, diffs, untracked files). Never writes to the repo. |
| `$claude:adversarial-review` | Same evidence as `review`, but Claude is instructed to push back on design choices and risk areas, with an optional focus you supply. |
| `$claude:rescue` | Hand a coding task to Claude Code, which may edit files in the workspace (foreground or `--background`). |
| `$claude:status` | List background Claude Code jobs for the current workspace. |
| `$claude:result` | Fetch the result (output, exit status, Claude session id) of a background job. |
| `$claude:cancel` | Cancel a running background job. |
| `$claude:transfer` | Build a handoff document from the current Codex session and print a command that opens it in interactive Claude Code. |
| `$claude:setup` | Check that Claude Code is installed and authenticated, verify the plugin's hooks are wired up, and toggle the Stop review gate. |

All of this runs against your own Claude Code install — the plugin has no server component and stores no plugin-specific credentials.

## Requirements

- **Codex CLI ≥ 0.117** — this is the first version with plugin support.
- **Claude Code installed and logged in**: `npm install -g @anthropic-ai/claude-code`, then `claude auth login` (or however you normally authenticate).
- **Node ≥ 18.18** on `PATH` (used both to run the plugin's own scripts and by the `claude` CLI itself).
- **macOS or Linux.** Windows is not supported in this version — background job management relies on POSIX process-group signaling.

## Install

```bash
# From a git source:
codex plugin marketplace add <owner>/cc-plugin-codex

# Or from a local checkout of this repo:
codex plugin marketplace add /path/to/cc-plugin-codex
```

Then install the plugin itself:

```bash
codex plugin add claude@cc-plugin-codex
```

**Start a brand-new Codex session after installing.** Codex only wires up a plugin's hooks for sessions started after install, and it will prompt you to approve the plugin's hooks the first time they'd run — approve them, or `$claude:setup` and the Stop review gate will not function.

Run `$claude:setup` in the new session to confirm Claude Code is on `PATH`, authenticated, and that the SessionStart hook actually recorded the session.

## Sandbox and approval requirements

Skill-launched scripts (`review`, `rescue`, `transfer`, etc.) run as ordinary Codex tool calls, subject to whatever sandbox and approval policy your Codex session is using. The nested `claude` process they launch needs:

- **Network access**, to talk to Anthropic's API.
- **Write access to `~/.claude`**, Claude Code's own config/credentials directory.
- **Write access to `~/.codex/plugins/data/claude-cc-plugin-codex`**, where this plugin keeps its own state (job records, transfer handoffs, session records).

If your Codex session is running with a read-only sandbox, a restrictive approval policy, or no network, expect to see approval prompts or outright failures from these skills — that's expected and by design, not a bug. The skills try to detect the common failure signatures (missing binary, no network, denied write) and explain what's needed rather than failing silently.

## Review gate (off by default)

`$claude:setup` can turn on a Stop review gate: once enabled, every time your Codex agent loop is about to stop, this plugin's Stop hook runs a locked-down, read-only Claude Code review of the turn (`--safe-mode`, no tools) and can block the stop with feedback if it finds a problem. A few things to know before turning it on:

- **It costs tokens.** Every stop triggers a full Claude Code invocation against your Claude plan — on a chatty session this adds up quickly.
- **It has a loop guard.** The hook checks `stop_hook_active` and never re-triggers itself, so a blocked stop can't spin forever.
- **It fails open.** If the reviewer errors, times out, or returns something the hook can't parse, the stop is *not* blocked — infrastructure problems never trap you in a stuck session.
- **Security note: this hook runs outside the Codex tool sandbox.** Codex spawns trusted plugin hooks directly, not as sandboxed tool calls, so the Stop gate is a real security boundary, not a sandboxed script. Only enable it if you trust this plugin's hook code, and be aware the nested Claude Code call it makes is locked down (`--safe-mode --tools ""`) precisely because of that.

## Costs

Every Claude Code invocation this plugin makes — reviews, rescues, the review gate — runs against your own Claude plan (API usage or subscription, whichever you're logged in with). The plugin does not proxy usage or add its own billing.

## Development

No external dependencies; tests use Node's built-in test runner.

```bash
npm test
```

## Manual smoke checklist

1. `codex plugin marketplace add /path/to/cc-plugin-codex`
2. Install plugin `claude` from the `cc-plugin-codex` marketplace; start a NEW Codex session; approve hooks.
3. `$claude:setup` — verify install/auth/sessionRecorded all healthy.
4. Dirty a repo, `$claude:review` — findings arrive; `git status` snapshot before/after is identical (zero writes).
5. `$claude:review --base main` on a feature branch — committed changes included.
6. `$claude:rescue` with a trivial edit task — edit lands, `Claude session:` id printed.
7. `$claude:rescue --resume <id>` — continues the same Claude session.
8. `$claude:rescue --background`, then `$claude:status` (running → done), `$claude:result` (result + session id), and on a second run `$claude:cancel` mid-flight — record ends `cancelled`.
9. `$claude:transfer` — handoff file written; launch command starts interactive Claude with the handoff.
10. `$claude:setup` gate on → make Codex produce a sloppy claim → verify block with reason; forced reviewer failure (temporarily set `CLAUDE_BIN=/nonexistent` in the hook env) → stop is NOT blocked (fail-open).
11. Repeat 4 and 6 under a restrictive sandbox/approval mode — failures are explained, not silent.

## License

Apache-2.0

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

### Security model

`$claude:review` and `$claude:adversarial-review` run untrusted diff/repo content through Claude with Read/Glob/Grep available. Prompt wording is **not** a security boundary — a malicious changed file could instruct Claude to read other files in the workspace and echo them back into the review output, and everything sent to Claude for review is also sent to Anthropic. The real boundary is the Codex sandbox/approval policy the launcher runs under: run Codex read-only or with a restrictive approval policy when reviewing untrusted code. This mirrors how the [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) reference plugin relies on the host sandbox to contain its reviewer, not on prompt text.

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
- **Access to your Claude Code credentials** (see below).

### Authentication under the sandbox (important)

If you log into Claude Code with a claude.ai / Claude Max account, the token is stored in the **macOS Keychain**, and Codex's sandbox blocks Keychain access for the processes it spawns. The practical effect: even when you are logged in at the machine level, a skill running under a restricted sandbox sees `claude auth status` as **logged out**, and nested `claude` fails with `Not logged in`. `$claude:setup` will flag this.

**The easy path:** run `$claude:setup` and choose a method — it walks you through the steps below, scaffolds `~/.codex/.env`, and tells you exactly what to add. (For security it never handles the secret itself: you paste your token/key into `~/.codex/.env` directly, never into the chat.)

Three ways to make Claude auth reachable from inside Codex (any one works; the plugin's scripts pass your environment straight through to nested `claude`, and Codex loads `~/.codex/.env` into every session — including sandboxed skill calls):

- **OAuth token via `CLAUDE_CODE_OAUTH_TOKEN` (recommended for claude.ai / Max / Pro).** Run `claude setup-token` once — it mints a long-lived OAuth token tied to your Claude *subscription* (not API billing) — then export it as `CLAUDE_CODE_OAUTH_TOKEN` in the environment your Codex session inherits. It's read from the env, never the Keychain, so it works under the sandbox while still billing against your subscription.
- **`ANTHROPIC_API_KEY`.** An API key is read directly from the env and never touches the Keychain, so it also works under the sandbox. This bills as API usage rather than your subscription.
- **Run Codex with elevated access for Claude skills.** A full-access / sandbox-bypass profile (or an approval mode that permits Keychain) lets nested `claude` reach the Keychain token directly. Verified: nested `claude -p` works under full access and fails under `workspace-write`.

If your Codex session is running with a read-only sandbox, a restrictive approval policy, or no network, expect to see approval prompts or outright failures from these skills — that's expected and by design, not a bug. The skills detect a missing `claude` binary and point you at `$claude:setup`; other sandbox failures (no network, denied write, blocked Keychain) surface as the underlying command's own error.

## Review gate (off by default)

`$claude:setup` can turn on a Stop review gate: once enabled, every time your Codex agent loop is about to stop, this plugin's Stop hook runs a locked-down, read-only Claude Code review of the turn (`--safe-mode`, no tools) and can block the stop with feedback if it finds a problem. A few things to know before turning it on:

- **It costs tokens.** Every stop triggers a full Claude Code invocation against your Claude plan — on a chatty session this adds up quickly.
- **It has a loop guard.** The hook checks `stop_hook_active` and never re-triggers itself, so a blocked stop can't spin forever.
- **It fails open.** If the reviewer errors, times out, or returns something the hook can't parse, the stop is *not* blocked — infrastructure problems never trap you in a stuck session.
- **Security note: this hook runs outside the Codex tool sandbox.** Codex spawns trusted plugin hooks directly, not as sandboxed tool calls, so the Stop gate is a real security boundary, not a sandboxed script. Only enable it if you trust this plugin's hook code, and be aware the nested Claude Code call it makes is locked down (`--safe-mode --tools ""`) precisely because of that.
- **Its verdict is heuristic, not verified.** The gate only ever sees the last assistant message — it has no access to tool-call history, so it cannot actually confirm claims like "tests pass"; it can only judge how the final message reads.
- **Its feedback is fixed and locally authored, never model prose.** On a block, something is written back into the conversation, which would otherwise make the reviewer's free-form text an attacker-influenced channel (a prompt injected earlier in the reviewed turn could shape what the reviewer writes). To close that off, the reviewer may only pick one of a handful of allowlisted category codes (e.g. "unverified tests", "incomplete work"); the hook then emits a fixed, locally-authored feedback string for that code and never forwards anything the reviewer wrote itself.

## Costs

Every Claude Code invocation this plugin makes — reviews, rescues, the review gate — runs against your own Claude plan (API usage or subscription, whichever you're logged in with). The plugin does not proxy usage or add its own billing.

## Development

No external dependencies; tests use Node's built-in test runner.

```bash
npm test
```

### Manual smoke checklist

For maintainers re-validating a change (the automated suite can't reach the real Codex/Claude runtime). Run against a real Codex 0.145+ and Claude Code install:

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

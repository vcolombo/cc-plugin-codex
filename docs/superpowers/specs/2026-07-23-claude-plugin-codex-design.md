# claude-plugin-codex — Claude Code plugin for Codex CLI

## Context

openai/codex-plugin-cc lets Claude Code users invoke Codex (review, delegate, session transfer). Goal: the exact reverse — a **Codex plugin** that invokes **Claude Code** from inside Codex CLI. Repo `/Users/colombov/git/cc-plugin-codex` is greenfield.

Codex CLI 0.145.0 plugin system: `.codex-plugin/plugin.json` manifest, `skills/<name>/SKILL.md` (namespaced, explicitly invoked as `$claude:review`; `@claude` mentions the plugin generally), convention-discovered `hooks/hooks.json` (Claude-shaped command-hook JSON; prompt/agent/async hooks unsupported), marketplace catalogs, `codex plugin marketplace add`. Spec reviewed twice by Codex against codex-rs source and installed binaries (Codex 0.145.0, Claude Code 2.1.218); all findings incorporated.

## Decisions (user-confirmed)

- **Scope:** full mirror of codex-plugin-cc features
- **Runtime:** Node.js ≥18.18, zero npm dependencies, `.mjs` scripts
- **Transfer:** summary handoff from bounded transcript extraction, NOT transcript-format conversion
- **Permissions:** delegated tasks default `--permission-mode acceptEdits`; `--yolo` flag opts into `--dangerously-skip-permissions`; reviews locked down (below)
- **Architecture:** skills + CLI scripts wrapping local `claude` binary; no MCP server

## Hard constraints (verified against codex-rs + installed binaries)

1. **Plugin data dir is `CODEX_HOME/plugins/data/<plugin>-<marketplace>`** — for this catalog: `~/.codex/plugins/data/claude-cc-plugin-codex`. Codex injects `PLUGIN_DATA`/`PLUGIN_ROOT` **only into hook processes**; skill-launched scripts get neither, and the hook environment does not propagate. Shared resolver (`scripts/lib/state.mjs`): hooks use `$PLUGIN_DATA` when present; scripts derive the same path (marketplace component derived from the installed cache path, canonical marketplace name `cc-plugin-codex` as fallback) and create it if missing (`0700`). State partitioned by workspace path hash + session id. A mismatch between hook-written and script-read stores breaks transfer and the gate flag — contract test required.
2. **Skill invocation:** explicit form is `$claude:review`, `$claude:rescue`, etc. No `$ARGUMENTS` interpolation — SKILL.md instructs the model to extract user flags/text and pass them as script argv. Each SKILL.md documents exact argv contract. Prompts and handoff text pass via **stdin or files, never shell interpolation or argv**.
3. **Manifest:** omit `hooks` field (validator rejects; runtime discovers `hooks/hooks.json`). Validator-required metadata: `name`, strict-semver `version`, `description`, `author`, `interface` with `displayName`, `shortDescription`, `longDescription`, `developerName`, `defaultPrompt`, `category`, `capabilities`.
4. **Blocking Stop hooks:** block via exit `0` + stdout `{"decision":"block","reason":"..."}` or exit `2` + stderr. Other non-zero = hook failure, does NOT block. Must check `stop_hook_active` to prevent loops. Hook stdin fields `transcript_path` and `last_assistant_message` are **nullable**. Plugin hooks untrusted until user approves.
5. **Sandbox split:** skill-launched scripts run as ordinary Codex tool calls **inside** the Codex sandbox — they need approval for network, `~/.claude`, and writes to their own `~/.codex/plugins/data/...`. `--yolo` affects only nested Claude, never the Codex sandbox. **Trusted hooks run OUTSIDE the tool sandbox** (spawned directly) — the Stop gate is a real security boundary: README warning + Claude-side lockdown mandatory.
6. **`claude -p --output-format stream-json` requires `--verbose`** (hard error otherwise on 2.1.218).
7. **Auth check:** `claude auth status --json` exists (2.1.218); returns JSON on stdout even when logged out with non-zero exit — parse stdout regardless of exit code.
8. **macOS/Linux only** for v1 (process-group management). Declare in README.

## Repo layout

```
cc-plugin-codex/
  .agents/plugins/marketplace.json
  plugins/claude/
    .codex-plugin/plugin.json
    skills/
      review/SKILL.md
      adversarial-review/SKILL.md
      rescue/SKILL.md
      transfer/SKILL.md
      status/SKILL.md
      result/SKILL.md
      cancel/SKILL.md
      setup/SKILL.md
    hooks/
      hooks.json
      session_start.mjs
      stop_review_gate.mjs
    scripts/
      run-claude.mjs        # launcher (foreground + background via supervisor)
      supervisor.mjs        # detached wrapper: runs claude, finalizes job record atomically
      jobs.mjs              # status / result / cancel
      transfer.mjs          # transcript extraction → handoff evidence
      setup.mjs
      lib/state.mjs         # data-dir resolver, atomic symlink-safe writes (0600), locking, retention
      lib/stream.mjs        # stream-json parsing (result, session id)
  tests/
  package.json              # test script only, no deps
  README.md
  LICENSE (Apache-2.0)
```

## Skills

1. **review** — read-only review of uncommitted changes or `--base <ref>`. Script precomputes ALL evidence outside Claude into a temp file — semantics: staged + unstaged diffs, untracked file contents (text only), `--base` uses merge-base; binaries/submodules listed by name only; per-file and total size caps with truncation markers. Claude runs `claude -p --safe-mode --tools "Read,Glob,Grep" --no-session-persistence` over the evidence file (`--tools` restricts inventory; `--allowedTools` alone does NOT remove tools). `--wait` (default) / `--background`.
2. **adversarial-review** — same mechanics; accepts focus text; prompt challenges design choices/tradeoffs/risks.
3. **rescue** — delegate task. Flags: `--model <opus|sonnet|haiku|fable|full-id>`, `--resume <claude-session-id>`, `--fresh`, `--yolo`, `--background`. Runs `claude -p --permission-mode acceptEdits --output-format stream-json --verbose`, task text via stdin. Surfaces Claude session id for later `--resume`.
4. **transfer** — `transfer.mjs` resolves transcript by **session id** recorded by SessionStart hook (cwd-match only as last resort — concurrent sessions in one repo would otherwise pick the wrong transcript). Extracts bounded evidence: user goal messages, files touched (tool calls), git state, last N exchanges — size limits + secret redaction. SKILL.md has **Codex itself** compose the handoff narrative from that evidence, write it via script (stdin) to state dir; script prints a safely-quoted launch command reading the file (no `$(cat ...)` interpolation, leading-dash safe).
5. **status / result / cancel** — `jobs.mjs` over per-workspace job dir. Liveness = pid + start-time match (guards pid reuse). Cancel = SIGTERM to supervisor (see lifecycle below).
6. **setup** — check `claude` on PATH (offer `npm i -g @anthropic-ai/claude-code`, confirm first), auth via `claude auth status --json`, verify SessionStart hook actually ran/trusted (probe state store), explain sandbox requirements (constraint 5), toggle review gate (flag file).

## Background jobs

`run-claude.mjs --background` spawns detached `supervisor.mjs` (own process group). Supervisor runs `claude`, streams to `<id>.log` (bounded size; logs may contain prompts/source — `0600`), atomically finalizes `<id>.json` (exit code, result, Claude session id, timestamps). **Cancellation lifecycle:** supervisor traps SIGTERM → forwards to Claude child → waits (bounded) → writes final record `status:"cancelled"` → exits. Job records store argv summary only, never prompt text. Retention: prune finished jobs >7 days on each `jobs.mjs` run.

## Hooks (`hooks/hooks.json`, convention-discovered)

- **SessionStart** → `session_start.mjs`: key state by hook-stdin `session_id` (equals scripts' `CODEX_THREAD_ID` — contract-tested); record transcript path (nullable), cwd.
- **Stop review gate (off by default)** → `stop_review_gate.mjs`: if gate flag enabled and `stop_hook_active` false, run locked-down reviewer (`--safe-mode --tools ""`, evidence precomputed, structured JSON verdict) with own timeout well under Codex's 10-min hook default, plus output caps. **Fail-open** on auth failure, timeout, or unparseable verdict — never block on infrastructure errors. On findings: exit 0 + `{"decision":"block","reason":"<feedback>"}`. README: token-drain + runs-outside-sandbox warnings.

## Error handling

- `claude` missing → scripts exit non-zero pointing to `$claude:setup`.
- Auth missing → surface login instructions verbatim.
- Codex sandbox denial (network / `~/.claude` / state-dir writes) → detect common failure signatures, explain requirement.
- Background job dies → supervisor records exit code; `result` shows stderr tail.
- Transfer with no matching session → list candidates for user choice.

## Verification

1. `npm test` (node:test): state resolver (hook-env vs derived path equality, partitioning, atomic + symlink-safe writes, perms); jobs lifecycle with fake-claude fixture (argv assertions incl. `--verbose`, stream-json fixtures); supervisor finalization incl. SIGTERM-cancel path; transfer extraction from fixture Codex JSONL (redaction, caps, session-id resolution); pid-reuse guard; session_id ↔ `CODEX_THREAD_ID` correlation contract test.
2. Official plugin validation (`$plugin-creator` / `validate_plugin.py`) passes.
3. Manual smoke: `codex plugin marketplace add /Users/colombov/git/cc-plugin-codex`, `codex plugin add claude@cc-plugin-codex`, **new session**, approve hooks. Then: `$claude:setup`; `$claude:review` on dirty repo — zero workspace writes (before/after snapshot); `$claude:rescue` trivial edit; background job + `$claude:status`/`result`/`cancel` (verify cancelled record finalized); `$claude:transfer` → run emitted command; gate on → confirm block + no loop + fail-open on forced timeout. Repeat key paths under read-only vs workspace-write sandbox modes and with approval denied; verify supervisor survives launcher exit and Codex exit.

## Marketplace entry

```json
{
  "name": "cc-plugin-codex",
  "interface": { "displayName": "Claude Code for Codex" },
  "plugins": [{
    "name": "claude",
    "source": { "source": "local", "path": "./plugins/claude" },
    "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
    "category": "Productivity"
  }]
}
```

(Git source consumers use `codex plugin marketplace add <owner>/cc-plugin-codex`.)

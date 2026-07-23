# claude-plugin-codex — Claude Code plugin for Codex CLI

## Context

openai/codex-plugin-cc lets Claude Code users invoke Codex (review, delegate, session transfer). Goal: the exact reverse — a **Codex plugin** that invokes **Claude Code** from inside Codex CLI. Repo `/Users/colombov/git/cc-plugin-codex` is empty; greenfield.

Codex CLI 0.145.0 plugin system: `.codex-plugin/plugin.json` manifest, `skills/<name>/SKILL.md` (namespaced `claude:review`, invoked via `@` mentions), convention-discovered `hooks/hooks.json` (Claude-shaped command-hook JSON; prompt/agent/async hooks unsupported), marketplace catalogs, `codex plugin marketplace add`. Plan reviewed by Codex against codex-rs source; corrections incorporated below.

## Decisions (user-confirmed)

- **Scope:** full mirror of codex-plugin-cc features
- **Runtime:** Node.js ≥18.18, zero npm dependencies, `.mjs` scripts
- **Transfer:** summary handoff from bounded transcript extraction, NOT transcript-format conversion
- **Permissions:** delegated tasks default `--permission-mode acceptEdits`; `--yolo` flag opts into `--dangerously-skip-permissions`; reviews locked down (below)
- **Architecture:** skills + CLI scripts wrapping local `claude` binary; no MCP server

## Hard constraints (from Codex review, verified against codex-rs)

1. **`PLUGIN_DATA`/`PLUGIN_ROOT` env vars are injected ONLY into hook processes**, not skill-launched scripts. Scripts get a shared state resolver (`scripts/lib/state.mjs`): derive data dir from Codex home (`~/.codex/plugins/data/claude/` or equivalent), partition by workspace path hash + `CODEX_THREAD_ID`.
2. **Skill invocation is namespaced:** `@claude:review`, `@claude:rescue`, etc. No `$ARGUMENTS` interpolation in Codex skills — SKILL.md instructs the model to extract user flags/text and pass them as script argv. Each SKILL.md documents exact argv contract.
3. **Manifest:** omit `hooks` field (official validator rejects it; runtime discovers `hooks/hooks.json` by convention). Include all validator-required metadata: `name`, strict-semver `version`, `description`, `author`, `interface` (displayName, shortDescription, category, capabilities).
4. **Blocking Stop hooks supported** on 0.145.0: block via exit `0` + stdout `{"decision":"block","reason":"..."}` or exit `2` + stderr. Other non-zero = hook failure, does NOT block. Hook must check `stop_hook_active` to prevent loops. Plugin hooks are untrusted until user approves them.
5. **Parent Codex sandbox applies to everything.** Nested `claude` needs network + writes to `~/.claude`. Document as runtime requirement; `@claude:setup` detects and explains when Codex approval policy blocks this.
6. **macOS/Linux only** for v1 (process-group management). Declare in README.

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
      lib/state.mjs         # state dir resolver, atomic JSON writes, locking, retention
      lib/stream.mjs        # stream-json parsing (result, session id)
  tests/
  package.json              # test script only, no deps
  README.md
  LICENSE (Apache-2.0)
```

## Skills

1. **review** — read-only review of uncommitted changes or `--base <ref>`. Script precomputes diff outside Claude (`git status --porcelain`, `git diff`, untracked files) into a temp file; runs `claude -p` with review prompt over that evidence, `--safe-mode`-equivalent lockdown: `--allowedTools "Read,Glob,Grep"`, **no Bash**, `--no-session-persistence`. `--wait` (default) / `--background`.
2. **adversarial-review** — same mechanics; accepts focus text; prompt challenges design choices/tradeoffs/risks.
3. **rescue** — delegate task. Flags: `--model <opus|sonnet|haiku|fable|full-id>`, `--resume <claude-session-id>`, `--fresh`, `--yolo`, `--background`. `claude -p "<task>" --permission-mode acceptEdits --output-format stream-json`. Surfaces Claude session id for later `--resume`.
4. **transfer** — `transfer.mjs` reads transcript path captured by SessionStart hook (fallback: newest session JSONL in `~/.codex/sessions` matching cwd). Extracts bounded evidence: user goal messages, files touched (tool calls), git state, last N exchanges — with size limits and secret redaction. SKILL.md then has **Codex itself** compose the handoff summary from that evidence, write it via script to state dir, and print ready-to-run `claude "$(cat <path>)"`. (Deterministic parsing extracts evidence; the model writes the narrative — parser can't infer "key decisions".)
5. **status / result / cancel** — `jobs.mjs` over per-workspace job dir. Liveness = pid + start-time match (guards pid reuse). Cancel = SIGTERM to process group.
6. **setup** — check `claude` on PATH (offer `npm i -g @anthropic-ai/claude-code`, confirm before install), check auth (`claude auth status --json` if available — verify subcommand at impl time, else cheap `claude -p` probe), verify hooks trusted/ran, explain parent-sandbox requirements, toggle review gate (flag file).

## Background jobs

`run-claude.mjs --background` spawns detached `supervisor.mjs` (own process group). Supervisor runs `claude`, streams to `<id>.log`, and atomically finalizes `<id>.json` (exit code, result text, Claude session id, timestamps) even after launcher exits. Job records store argv summary, never full prompt text. Retention: prune finished jobs >7 days on each `jobs.mjs` run.

## Hooks (`hooks/hooks.json`, convention-discovered)

- **SessionStart** → `session_start.mjs`: record transcript path + cwd + thread id into `$PLUGIN_DATA` (hooks DO get the env var), keyed by thread.
- **Stop review gate (off by default)** → `stop_review_gate.mjs`: if gate flag enabled and `stop_hook_active` false, run locked-down `claude -p` review of Codex's last output; on findings emit `{"decision":"block","reason":"<feedback>"}` exit 0. README warns about review-loop token drain (mirrors original's warning).

## Error handling

- `claude` missing → scripts exit non-zero with pointer to `@claude:setup`.
- Auth missing → surface login instructions verbatim.
- Codex sandbox denial (network/home writes) → detect common failure signatures, explain requirement.
- Background job dies → supervisor records exit code; `result` shows stderr tail.
- Transfer with no matching session → list candidates for user choice.

## Verification

1. `npm test` (node:test): state resolver partitioning + atomic writes; jobs lifecycle with fake-claude fixture (argv assertions, stream-json fixtures); supervisor finalization + cancel; transfer extraction from fixture Codex JSONL (incl. redaction, size caps); pid-reuse guard.
2. Official plugin validation (plugin-creator `validate_plugin.py` / `@plugin-creator` skill) passes on manifest + layout.
3. Manual smoke: `codex plugin marketplace add /Users/colombov/git/cc-plugin-codex`, `codex plugin add claude@<marketplace>`, **new session**, approve hooks, then: `@claude:setup`; `@claude:review` on dirty repo — confirm zero workspace writes (snapshot before/after); `@claude:rescue` trivial edit; background job + `@claude:status`/`result`/`cancel`; `@claude:transfer` → run emitted command; enable gate, confirm block + no infinite loop.

## Marketplace entry

```json
{
  "name": "cc-plugin-codex",
  "interface": { "displayName": "Claude Code for Codex" },
  "plugins": [{
    "name": "claude",
    "source": { "source": "local", "path": "./plugins/claude" },
    "policy": { "installation": "AVAILABLE" },
    "category": "Productivity"
  }]
}
```

(Git source consumers use `codex plugin marketplace add <owner>/cc-plugin-codex`.)

## Open items (resolve at implementation time)

- Confirm exact Codex plugin data-dir convention for the state resolver (`~/.codex/plugins/data/<plugin>/` assumed; verify against codex-rs loader).
- Confirm whether `claude auth status --json` exists in the installed Claude Code version; otherwise use a cheap `claude -p` probe for the auth check in `@claude:setup`.

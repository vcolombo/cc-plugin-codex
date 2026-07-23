# claude-plugin-codex Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Codex CLI plugin ("claude") that invokes Claude Code from inside Codex: read-only reviews, task delegation, background jobs, session transfer, setup, and an optional Stop review gate.

**Architecture:** Skills (`$claude:<name>`) instruct Codex to run bundled Node scripts that wrap the local `claude` binary via `claude -p`. Background jobs run under a detached supervisor that finalizes a job record atomically. Hooks (SessionStart, Stop) get `PLUGIN_DATA` from Codex; skill-launched scripts derive the identical data dir themselves.

**Tech Stack:** Node.js ≥18.18 ESM (`.mjs`), zero npm dependencies, `node:test`. Spec: `docs/superpowers/specs/2026-07-23-claude-plugin-codex-design.md` — read it before starting; it is the authority on constraints.

## Global Constraints

- Node ≥18.18, **zero npm dependencies**, ESM `.mjs` only.
- Every spawn of Claude uses `process.env.CLAUDE_BIN || 'claude'` (testability).
- Plugin data dir: `CODEX_HOME/plugins/data/<plugin>-<marketplace>` → canonical `~/.codex/plugins/data/claude-cc-plugin-codex`. Hooks use `$PLUGIN_DATA` when present; scripts derive the same path. Scripts create it (`0700` dirs, `0600` files).
- `claude -p` with `--output-format stream-json` REQUIRES `--verbose` (hard error without).
- Review lockdown: `--safe-mode --tools "Read,Glob,Grep" --no-session-persistence` (`--tools` restricts inventory; `--allowedTools` does not).
- Prompts/handoffs pass via **stdin or files, never argv/shell interpolation**.
- Skill invocation syntax in docs/skills: `$claude:<skill>`.
- Manifest: NO `hooks` field (validator rejects; `hooks/hooks.json` discovered by convention).
- macOS/Linux only (uses `ps -o lstart=`).
- Plugin name `claude`, marketplace name `cc-plugin-codex`, plugin version `0.1.0`.
- Commits: plain messages, **no AI attribution of any kind**.

---

### Task 1: Repo scaffolding and metadata

**Files:**
- Create: `package.json`, `LICENSE`, `.agents/plugins/marketplace.json`, `plugins/claude/.codex-plugin/plugin.json`
- Test: `tests/metadata.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces: metadata files later tasks live inside; `npm test` harness (`node --test tests/`)

- [ ] **Step 1: Write package.json**

```json
{
  "name": "cc-plugin-codex",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "engines": { "node": ">=18.18" },
  "scripts": { "test": "node --test tests/" }
}
```

- [ ] **Step 2: Fetch Apache-2.0 license**

Run: `curl -fsSL https://www.apache.org/licenses/LICENSE-2.0.txt -o LICENSE`

- [ ] **Step 3: Write `.agents/plugins/marketplace.json`**

```json
{
  "name": "cc-plugin-codex",
  "interface": { "displayName": "Claude Code for Codex" },
  "plugins": [
    {
      "name": "claude",
      "source": { "source": "local", "path": "./plugins/claude" },
      "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
      "category": "Productivity"
    }
  ]
}
```

Note: marketplace root is the repo root (where `.agents/` lives), so `source.path` is `./plugins/claude` relative to repo root.

- [ ] **Step 4: Write `plugins/claude/.codex-plugin/plugin.json`**

```json
{
  "name": "claude",
  "version": "0.1.0",
  "description": "Use Claude Code from within Codex: code reviews, task delegation, background jobs, and session transfer.",
  "author": { "name": "colombov", "email": "vcolombo@gmail.com" },
  "license": "Apache-2.0",
  "skills": "./skills/",
  "interface": {
    "displayName": "Claude Code for Codex",
    "shortDescription": "Invoke Claude Code from inside Codex",
    "longDescription": "Mirror of openai/codex-plugin-cc in the opposite direction: run read-only Claude Code reviews of your changes, delegate tasks to Claude Code in the foreground or as background jobs, manage those jobs, and hand a Codex session off to an interactive Claude Code session.",
    "developerName": "colombov",
    "defaultPrompt": "Use $claude:setup to check that Claude Code is installed and authenticated.",
    "category": "Productivity",
    "capabilities": ["skills", "hooks"]
  }
}
```

- [ ] **Step 5: Write the test**

`tests/metadata.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'));

test('package.json is valid and dependency-free', () => {
  const pkg = read('package.json');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
});

test('marketplace.json has required policy', () => {
  const mkt = read('.agents/plugins/marketplace.json');
  assert.equal(mkt.name, 'cc-plugin-codex');
  const p = mkt.plugins[0];
  assert.equal(p.name, 'claude');
  assert.equal(p.source.path, './plugins/claude');
  assert.equal(p.policy.installation, 'AVAILABLE');
  assert.equal(p.policy.authentication, 'ON_INSTALL');
});

test('plugin manifest has validator-required fields and no hooks key', () => {
  const m = read('plugins/claude/.codex-plugin/plugin.json');
  assert.equal(m.name, 'claude');
  assert.match(m.version, /^\d+\.\d+\.\d+$/);
  assert.ok(m.description);
  assert.ok(m.author?.name);
  for (const f of ['displayName', 'shortDescription', 'longDescription', 'developerName', 'defaultPrompt', 'category', 'capabilities']) {
    assert.ok(m.interface?.[f], `interface.${f} missing`);
  }
  assert.equal(m.hooks, undefined, 'manifest must not declare hooks (validator rejects it)');
});
```

- [ ] **Step 6: Run tests, verify pass**

Run: `npm test`
Expected: 3 pass.

- [ ] **Step 7: Commit**

```bash
git add package.json LICENSE .agents plugins tests
git commit -m "feat: scaffold Codex plugin metadata and test harness"
```

---

### Task 2: State library (data-dir resolver, atomic JSON I/O)

**Files:**
- Create: `plugins/claude/scripts/lib/state.mjs`
- Test: `tests/state.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces (used by every later task):
  - `codexHome(env = process.env) -> string`
  - `resolveDataDir({ env = process.env, scriptPath = '' } = {}) -> string` (PLUGIN_DATA > cache-path derivation > canonical fallback; does NOT create the dir)
  - `ensureDir(path) -> path` (recursive, mode 0700)
  - `workspaceKey(cwd) -> string` (16 hex chars)
  - `jobsDir(dataDir, cwd) -> string` (created), `sessionsDir(dataDir) -> string` (created), `handoffsDir(dataDir) -> string` (created)
  - `gateFlagPath(dataDir) -> string`
  - `writeJsonAtomic(path, obj) -> void` (0600, tmp+rename, symlink-safe)
  - `readJson(path) -> object | null`

- [ ] **Step 1: Write the failing tests**

`tests/state.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveDataDir, workspaceKey, writeJsonAtomic, readJson, jobsDir,
} from '../plugins/claude/scripts/lib/state.mjs';

test('resolveDataDir prefers PLUGIN_DATA', () => {
  assert.equal(resolveDataDir({ env: { PLUGIN_DATA: '/x' } }), '/x');
});

test('resolveDataDir derives <plugin>-<marketplace> from cache path', () => {
  const p = resolveDataDir({
    env: { CODEX_HOME: '/home/u/.codex' },
    scriptPath: '/home/u/.codex/plugins/cache/cc-plugin-codex/claude/0.1.0/scripts/run-claude.mjs',
  });
  assert.equal(p, join('/home/u/.codex', 'plugins', 'data', 'claude-cc-plugin-codex'));
});

test('resolveDataDir falls back to canonical slug', () => {
  const p = resolveDataDir({ env: { CODEX_HOME: '/h/.codex' }, scriptPath: '/somewhere/else.mjs' });
  assert.equal(p, join('/h/.codex', 'plugins', 'data', 'claude-cc-plugin-codex'));
});

test('workspaceKey is stable 16-hex and cwd-sensitive', () => {
  const k = workspaceKey('/repo/a');
  assert.match(k, /^[0-9a-f]{16}$/);
  assert.equal(k, workspaceKey('/repo/a'));
  assert.notEqual(k, workspaceKey('/repo/b'));
});

test('writeJsonAtomic creates 0700 dirs, 0600 file, round-trips', () => {
  const dir = mkdtempSync(join(tmpdir(), 'state-'));
  const p = join(dir, 'sub', 'r.json');
  writeJsonAtomic(p, { a: 1 });
  assert.deepEqual(readJson(p), { a: 1 });
  assert.equal(statSync(p).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, 'sub')).mode & 0o777, 0o700);
});

test('readJson returns null on missing or invalid', () => {
  assert.equal(readJson('/nope/nothing.json'), null);
});

test('jobsDir partitions by workspace', () => {
  const dir = mkdtempSync(join(tmpdir(), 'state-'));
  const a = jobsDir(dir, '/repo/a');
  const b = jobsDir(dir, '/repo/b');
  assert.notEqual(a, b);
  assert.ok(a.startsWith(join(dir, 'jobs')));
  assert.equal(statSync(a).mode & 0o777, 0o700);
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npm test`
Expected: state tests FAIL (module not found).

- [ ] **Step 3: Implement `plugins/claude/scripts/lib/state.mjs`**

```js
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const FALLBACK_SLUG = 'claude-cc-plugin-codex';

export function codexHome(env = process.env) {
  return env.CODEX_HOME || join(homedir(), '.codex');
}

// Codex injects PLUGIN_DATA only into hook processes. Skill-launched scripts
// derive the identical dir: cache layout is
// <codexHome>/plugins/cache/<marketplace>/<plugin>/<version>/..., and the data
// dir is <codexHome>/plugins/data/<plugin>-<marketplace>.
export function resolveDataDir({ env = process.env, scriptPath = '' } = {}) {
  if (env.PLUGIN_DATA) return env.PLUGIN_DATA;
  const m = scriptPath.match(/[/\\]plugins[/\\]cache[/\\]([^/\\]+)[/\\]([^/\\]+)[/\\]/);
  const slug = m ? `${m[2]}-${m[1]}` : FALLBACK_SLUG;
  return join(codexHome(env), 'plugins', 'data', slug);
}

export function ensureDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

export function workspaceKey(cwd) {
  return createHash('sha256').update(cwd).digest('hex').slice(0, 16);
}

export function jobsDir(dataDir, cwd) {
  return ensureDir(join(dataDir, 'jobs', workspaceKey(cwd)));
}

export function sessionsDir(dataDir) {
  return ensureDir(join(dataDir, 'sessions'));
}

export function handoffsDir(dataDir) {
  return ensureDir(join(dataDir, 'handoffs'));
}

export function gateFlagPath(dataDir) {
  return join(dataDir, 'review-gate-enabled');
}

// Atomic + symlink-safe: 'wx' refuses to follow an existing symlink for the
// temp file; rename() replaces the destination entry without following it.
export function writeJsonAtomic(path, obj) {
  ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add plugins/claude/scripts/lib/state.mjs tests/state.test.mjs
git commit -m "feat: state library with data-dir resolver and atomic JSON writes"
```

---

### Task 3: Stream and process libraries

**Files:**
- Create: `plugins/claude/scripts/lib/stream.mjs`, `plugins/claude/scripts/lib/proc.mjs`
- Test: `tests/stream.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `extractFromStream(text) -> { sessionId: string|null, result: string|null, isError: boolean }` — parses `claude --output-format stream-json` line events; last `type:"result"` event wins
  - `psStart(pid) -> string` — `ps -o lstart=` output, `''` on failure
  - `isAlive(record) -> boolean` — pid signal-0 check AND `psStart(pid) === record.psStart` (guards pid reuse)

- [ ] **Step 1: Write the failing tests**

`tests/stream.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractFromStream } from '../plugins/claude/scripts/lib/stream.mjs';
import { psStart, isAlive } from '../plugins/claude/scripts/lib/proc.mjs';

test('extractFromStream pulls session id and final result', () => {
  const text = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's-1' }),
    'not json at all',
    JSON.stringify({ type: 'assistant', message: {} }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'DONE', session_id: 's-1' }),
  ].join('\n');
  assert.deepEqual(extractFromStream(text), { sessionId: 's-1', result: 'DONE', isError: false });
});

test('extractFromStream handles empty input', () => {
  assert.deepEqual(extractFromStream(''), { sessionId: null, result: null, isError: false });
});

test('extractFromStream reports errors', () => {
  const text = JSON.stringify({ type: 'result', is_error: true, result: 'boom', session_id: 's-2' });
  const out = extractFromStream(text);
  assert.equal(out.isError, true);
  assert.equal(out.result, 'boom');
});

test('psStart returns non-empty for own pid, empty for absurd pid', () => {
  assert.notEqual(psStart(process.pid), '');
  assert.equal(psStart(99999999), '');
});

test('isAlive rejects dead pid and psStart mismatch', () => {
  assert.equal(isAlive({ pid: 99999999, psStart: 'x' }), false);
  assert.equal(isAlive({ pid: process.pid, psStart: 'bogus' }), false);
  assert.equal(isAlive({ pid: process.pid, psStart: psStart(process.pid) }), true);
  assert.equal(isAlive(null), false);
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npm test` — new tests FAIL (modules not found).

- [ ] **Step 3: Implement `plugins/claude/scripts/lib/stream.mjs`**

```js
export function extractFromStream(text) {
  let sessionId = null;
  let result = null;
  let isError = false;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let ev;
    try {
      ev = JSON.parse(t);
    } catch {
      continue;
    }
    if (ev.session_id) sessionId = ev.session_id;
    if (ev.type === 'result') {
      result = ev.result ?? null;
      isError = Boolean(ev.is_error);
    }
  }
  return { sessionId, result, isError };
}
```

- [ ] **Step 4: Implement `plugins/claude/scripts/lib/proc.mjs`**

```js
import { execFileSync } from 'node:child_process';

export function psStart(pid) {
  try {
    return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

// Liveness = pid still signalable AND same process start time as recorded
// (a recycled pid has a different start time).
export function isAlive(record) {
  if (!record?.pid) return false;
  try {
    process.kill(record.pid, 0);
  } catch {
    return false;
  }
  const s = psStart(record.pid);
  return s !== '' && s === record.psStart;
}
```

- [ ] **Step 5: Run tests, verify pass**

Run: `npm test` — all pass.

- [ ] **Step 6: Commit**

```bash
git add plugins/claude/scripts/lib/stream.mjs plugins/claude/scripts/lib/proc.mjs tests/stream.test.mjs
git commit -m "feat: stream-json extraction and pid-reuse-safe liveness"
```

---

### Task 4: Review evidence builder

**Files:**
- Create: `plugins/claude/scripts/lib/evidence.mjs`
- Test: `tests/evidence.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `buildReviewEvidence({ cwd, base = null }) -> string` — markdown evidence: git status, optional `<base>...HEAD` diff (merge-base semantics), staged diff, unstaged diff, untracked text-file contents; binaries noted by name only; capped
  - `PER_FILE_CAP = 100000`, `TOTAL_CAP = 400000` (chars)

- [ ] **Step 1: Write the failing tests**

`tests/evidence.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReviewEvidence, PER_FILE_CAP } from '../plugins/claude/scripts/lib/evidence.mjs';

function initRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'ev-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  g('add', '.');
  g('commit', '-qm', 'init');
  return { dir, g };
}

test('captures staged, unstaged, untracked, binary', () => {
  const { dir, g } = initRepo();
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n');          // unstaged
  writeFileSync(join(dir, 'b.txt'), 'staged content\n');
  g('add', 'b.txt');                                         // staged
  writeFileSync(join(dir, 'c.txt'), 'untracked text\n');     // untracked text
  writeFileSync(join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 0]));  // untracked binary
  const ev = buildReviewEvidence({ cwd: dir });
  assert.match(ev, /## Staged changes[\s\S]*staged content/);
  assert.match(ev, /## Unstaged changes[\s\S]*\+two/);
  assert.match(ev, /## Untracked: c\.txt[\s\S]*untracked text/);
  assert.match(ev, /## Untracked: blob\.bin[\s\S]*binary file, contents omitted/);
});

test('base ref uses merge-base (three-dot) diff', () => {
  const { dir, g } = initRepo();
  const baseSha = g('rev-parse', 'HEAD').trim();
  writeFileSync(join(dir, 'a.txt'), 'committed change\n');
  g('commit', '-aqm', 'change');
  const ev = buildReviewEvidence({ cwd: dir, base: baseSha });
  assert.match(ev, /## Committed changes vs /);
  assert.match(ev, /\+committed change/);
});

test('caps oversized untracked files with truncation marker', () => {
  const { dir } = initRepo();
  writeFileSync(join(dir, 'big.txt'), 'x'.repeat(PER_FILE_CAP + 1000));
  const ev = buildReviewEvidence({ cwd: dir });
  assert.match(ev, /truncated at /);
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npm test` — evidence tests FAIL (module not found).

- [ ] **Step 3: Implement `plugins/claude/scripts/lib/evidence.mjs`**

```js
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const PER_FILE_CAP = 100_000;
export const TOTAL_CAP = 400_000;

function git(cwd, ...args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    return err.stdout?.toString?.() ?? '';
  }
}

function cap(text, limit) {
  return text.length > limit
    ? `${text.slice(0, limit)}\n[... truncated at ${limit} chars]\n`
    : text;
}

function isProbablyText(buf) {
  return !buf.subarray(0, 8192).includes(0);
}

export function buildReviewEvidence({ cwd, base = null }) {
  const sections = [`# Review evidence\n\nRepository: ${cwd}\n`];
  sections.push(`## git status\n\n\`\`\`\n${git(cwd, 'status', '--porcelain')}\`\`\`\n`);
  if (base) {
    sections.push(`## Committed changes vs ${base} (merge-base)\n\n\`\`\`diff\n${cap(git(cwd, 'diff', `${base}...HEAD`), TOTAL_CAP / 2)}\`\`\`\n`);
  }
  sections.push(`## Staged changes\n\n\`\`\`diff\n${cap(git(cwd, 'diff', '--cached'), TOTAL_CAP / 4)}\`\`\`\n`);
  sections.push(`## Unstaged changes\n\n\`\`\`diff\n${cap(git(cwd, 'diff'), TOTAL_CAP / 4)}\`\`\`\n`);
  const untracked = git(cwd, 'ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean);
  for (const rel of untracked) {
    let body;
    try {
      const buf = readFileSync(join(cwd, rel));
      body = isProbablyText(buf)
        ? `\`\`\`\n${cap(buf.toString('utf8'), PER_FILE_CAP)}\`\`\``
        : '(binary file, contents omitted)';
    } catch {
      body = '(unreadable)';
    }
    sections.push(`## Untracked: ${rel}\n\n${body}\n`);
  }
  return cap(sections.join('\n'), TOTAL_CAP);
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test` — all pass.

- [ ] **Step 5: Commit**

```bash
git add plugins/claude/scripts/lib/evidence.mjs tests/evidence.test.mjs
git commit -m "feat: precomputed git evidence builder for reviews"
```

---

### Task 5: Fake-claude fixture and foreground launcher

**Files:**
- Create: `tests/fixtures/fake-claude.mjs`, `plugins/claude/scripts/run-claude.mjs`
- Test: `tests/run-claude.test.mjs`

**Interfaces:**
- Consumes: `state.mjs` (`resolveDataDir`, `jobsDir`, `writeJsonAtomic`), `stream.mjs` (`extractFromStream`), `evidence.mjs` (`buildReviewEvidence`)
- Produces:
  - `buildClaudeArgs(mode, opts = {}) -> string[]` — mode `'review' | 'rescue'`; opts `{ yolo, model, resume }`
  - `REVIEW_PROMPT: string`, `ADVERSARIAL_PROMPT: string`
  - CLI: `node run-claude.mjs review [--base <ref>] [--adversarial] [--background]` (adversarial focus text on stdin, optional) and `node run-claude.mjs rescue [--model <m>] [--resume <id>] [--yolo] [--background]` (task text on stdin, required)
  - Foreground exit: prints Claude result to stdout plus a final line `Claude session: <id>`; exits with the child's code
  - Background (implemented in Task 7; this task exits with error "background not yet implemented" so the flag parses)
  - Fake claude behavior (env-driven): `FAKE_CLAUDE_CAPTURE` (file gets `{argv, stdin}` JSON), `FAKE_CLAUDE_SLEEP_MS`, `FAKE_CLAUDE_EXIT`, `FAKE_CLAUDE_PLAIN` (print this verbatim instead of stream-json — for the Stop-gate verdict tests); `--version` and `auth` argv short-circuits for setup tests

- [ ] **Step 1: Write `tests/fixtures/fake-claude.mjs`** (test infrastructure, not a test)

```js
#!/usr/bin/env node
// Stand-in for the `claude` binary. See run-claude.test.mjs for the contract.
import { writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);

if (argv.includes('--version')) {
  console.log('fake-claude 1.0.0');
  process.exit(0);
}
if (argv[0] === 'auth') {
  console.log(JSON.stringify({ loggedIn: true, method: 'fake' }));
  process.exit(0);
}

let stdin = '';
process.stdin.on('data', (d) => { stdin += d; });
process.stdin.on('end', async () => {
  if (process.env.FAKE_CLAUDE_CAPTURE) {
    writeFileSync(process.env.FAKE_CLAUDE_CAPTURE, JSON.stringify({ argv, stdin }));
  }
  if (process.env.FAKE_CLAUDE_PLAIN) {
    console.log(process.env.FAKE_CLAUDE_PLAIN);
    process.exit(Number(process.env.FAKE_CLAUDE_EXIT || 0));
  }
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-fake-123' }));
  const sleep = Number(process.env.FAKE_CLAUDE_SLEEP_MS || 0);
  if (sleep) await new Promise((r) => setTimeout(r, sleep));
  console.log(JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, result: 'FAKE RESULT', session_id: 'sess-fake-123',
  }));
  process.exit(Number(process.env.FAKE_CLAUDE_EXIT || 0));
});
```

Run: `chmod +x tests/fixtures/fake-claude.mjs`

- [ ] **Step 2: Write the failing tests**

`tests/run-claude.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildClaudeArgs } from '../plugins/claude/scripts/run-claude.mjs';

const SCRIPT = fileURLToPath(new URL('../plugins/claude/scripts/run-claude.mjs', import.meta.url));
const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));

test('buildClaudeArgs review is locked down', () => {
  assert.deepEqual(buildClaudeArgs('review'), [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--safe-mode', '--tools', 'Read,Glob,Grep', '--no-session-persistence',
  ]);
});

test('buildClaudeArgs rescue defaults to acceptEdits', () => {
  assert.deepEqual(buildClaudeArgs('rescue'), [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'acceptEdits',
  ]);
});

test('buildClaudeArgs rescue honors yolo, model, resume', () => {
  const args = buildClaudeArgs('rescue', { yolo: true, model: 'opus', resume: 'sid-9' });
  assert.ok(args.includes('--dangerously-skip-permissions'));
  assert.ok(!args.includes('--permission-mode'));
  assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), ['--model', 'opus']);
  assert.deepEqual(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2), ['--resume', 'sid-9']);
});

test('buildClaudeArgs rejects unknown mode', () => {
  assert.throws(() => buildClaudeArgs('nope'));
});

test('foreground rescue pipes task via stdin and surfaces result + session', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rc-'));
  const capture = join(dir, 'cap.json');
  const out = execFileSync('node', [SCRIPT, 'rescue'], {
    cwd: dir,
    input: 'fix the widget',
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_BIN: FAKE,
      FAKE_CLAUDE_CAPTURE: capture,
      CODEX_HOME: join(dir, '.codex'),
    },
  });
  assert.match(out, /FAKE RESULT/);
  assert.match(out, /Claude session: sess-fake-123/);
  const cap = JSON.parse(readFileSync(capture, 'utf8'));
  assert.ok(cap.argv.includes('--verbose'), 'stream-json requires --verbose');
  assert.ok(cap.stdin.includes('fix the widget'));
});

test('foreground review includes precomputed evidence in the prompt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rc-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  writeFileSync(join(dir, 'n.txt'), 'new file\n');
  const capture = join(dir, 'cap.json');
  execFileSync('node', [SCRIPT, 'review'], {
    cwd: dir,
    input: '',
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_BIN: FAKE, FAKE_CLAUDE_CAPTURE: capture, CODEX_HOME: join(dir, '.codex') },
  });
  const cap = JSON.parse(readFileSync(capture, 'utf8'));
  assert.ok(cap.argv.includes('--safe-mode'));
  assert.match(cap.stdin, /read-only code review/);
  assert.match(cap.stdin, /Untracked: n\.txt/);
});
```

- [ ] **Step 3: Run tests, verify they fail**

Run: `npm test` — run-claude tests FAIL (module not found).

- [ ] **Step 4: Implement `plugins/claude/scripts/run-claude.mjs`**

```js
#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildReviewEvidence } from './lib/evidence.mjs';
import { extractFromStream } from './lib/stream.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);

export const REVIEW_PROMPT = `You are performing a strictly read-only code review from inside another agent's workflow.
Evidence (git status, diffs, untracked files) is included below. You may use Read, Glob,
and Grep for surrounding context. Never modify anything.

Review for: correctness bugs, security issues, missing error handling, and test gaps.
For each finding give: file, location (from the diff hunks), the problem, and a concrete fix.
Order findings by severity. If nothing significant is wrong, say so briefly.`;

export const ADVERSARIAL_PROMPT = `${REVIEW_PROMPT}

Additionally, be adversarial: challenge design choices, question tradeoffs, and probe
risk areas even where the code "works". If a focus area is given below, prioritize it.`;

export function buildClaudeArgs(mode, opts = {}) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (mode === 'review') {
    args.push('--safe-mode', '--tools', 'Read,Glob,Grep', '--no-session-persistence');
  } else if (mode === 'rescue') {
    if (opts.yolo) args.push('--dangerously-skip-permissions');
    else args.push('--permission-mode', 'acceptEdits');
    if (opts.model) args.push('--model', opts.model);
    if (opts.resume) args.push('--resume', opts.resume);
  } else {
    throw new Error(`unknown mode: ${mode}`);
  }
  return args;
}

function parseArgv(argv) {
  const [mode, ...rest] = argv;
  const opts = { mode };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--base') opts.base = rest[++i];
    else if (a === '--model') opts.model = rest[++i];
    else if (a === '--resume') opts.resume = rest[++i];
    else if (a === '--adversarial') opts.adversarial = true;
    else if (a === '--yolo') opts.yolo = true;
    else if (a === '--background') opts.background = true;
    else throw new Error(`unknown flag: ${a}`);
  }
  return opts;
}

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

export function buildPrompt(opts, stdinText) {
  if (opts.mode === 'review') {
    const evidence = buildReviewEvidence({ cwd: process.cwd(), base: opts.base ?? null });
    const header = opts.adversarial ? ADVERSARIAL_PROMPT : REVIEW_PROMPT;
    const focus = opts.adversarial && stdinText.trim() ? `\n\n## Focus area\n\n${stdinText.trim()}\n` : '';
    return `${header}${focus}\n\n${evidence}`;
  }
  if (!stdinText.trim()) throw new Error('rescue requires the task text on stdin');
  return stdinText;
}

function runForeground(claudeArgs, prompt) {
  const child = spawn(process.env.CLAUDE_BIN || 'claude', claudeArgs, {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  child.stdin.end(prompt);
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.on('close', (code) => {
    const { sessionId, result, isError } = extractFromStream(out);
    if (result) process.stdout.write(`${result}\n`);
    if (sessionId) process.stdout.write(`\nClaude session: ${sessionId}\n`);
    process.exit(isError && code === 0 ? 1 : code ?? 1);
  });
  child.on('error', (err) => {
    process.stderr.write(`Failed to launch Claude Code (${err.message}). Run $claude:setup.\n`);
    process.exit(127);
  });
}

async function main() {
  const opts = parseArgv(process.argv.slice(2));
  const stdinText = await readStdin();
  const prompt = buildPrompt(opts, stdinText);
  const claudeArgs = buildClaudeArgs(opts.mode, opts);
  if (opts.background) {
    const { launchBackground } = await import('./background.mjs');
    launchBackground({ mode: opts.mode, claudeArgs, prompt, scriptPath: SCRIPT_PATH, scriptDir: dirname(SCRIPT_PATH) });
    return;
  }
  runForeground(claudeArgs, prompt);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  });
}
```

Note: `./background.mjs` does not exist yet — Task 7 creates it. Foreground paths never import it, so this task's tests pass.

- [ ] **Step 5: Run tests, verify pass**

Run: `npm test` — all pass.

- [ ] **Step 6: Commit**

```bash
git add tests/fixtures/fake-claude.mjs plugins/claude/scripts/run-claude.mjs tests/run-claude.test.mjs
git commit -m "feat: foreground Claude launcher with locked-down review mode"
```

---

### Task 6: Background supervisor

**Files:**
- Create: `plugins/claude/scripts/supervisor.mjs`
- Test: `tests/supervisor.test.mjs`

**Interfaces:**
- Consumes: `state.mjs` (`readJson`, `writeJsonAtomic`), `stream.mjs`, `proc.mjs` (`psStart`)
- Produces:
  - CLI: `node supervisor.mjs <specPath>` — spec JSON `{ id, claudeArgs: string[], promptPath, cwd, logPath, recordPath }`
  - Job record lifecycle: launcher writes `{ id, mode, startedAt, status: 'starting' }`; supervisor updates to `status:'running', pid, psStart`; on child close finalizes `{ status: 'done'|'failed'|'cancelled', exitCode, sessionId, result (≤10000 chars), endedAt }`
  - SIGTERM to the supervisor = cancel: forwards SIGTERM to Claude child, SIGKILL after 10s, still finalizes the record with `status:'cancelled'`

- [ ] **Step 1: Write the failing tests**

`tests/supervisor.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJsonAtomic } from '../plugins/claude/scripts/lib/state.mjs';

const SUP = fileURLToPath(new URL('../plugins/claude/scripts/supervisor.mjs', import.meta.url));
const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));

function makeSpec(dir, extraEnv = {}) {
  const spec = {
    id: 'job-1',
    claudeArgs: ['-p', '--output-format', 'stream-json', '--verbose'],
    promptPath: join(dir, 'job-1.prompt'),
    cwd: dir,
    logPath: join(dir, 'job-1.log'),
    recordPath: join(dir, 'job-1.json'),
  };
  writeFileSync(spec.promptPath, 'do the thing', { mode: 0o600 });
  writeJsonAtomic(spec.recordPath, { id: 'job-1', mode: 'rescue', startedAt: new Date().toISOString(), status: 'starting' });
  const specPath = join(dir, 'job-1.spec.json');
  writeJsonAtomic(specPath, spec);
  return { spec, specPath, env: { ...process.env, CLAUDE_BIN: FAKE, ...extraEnv } };
}

test('supervisor finalizes a successful job', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sup-'));
  const { spec, specPath, env } = makeSpec(dir);
  execFileSync('node', [SUP, specPath], { env });
  const rec = readJson(spec.recordPath);
  assert.equal(rec.status, 'done');
  assert.equal(rec.exitCode, 0);
  assert.equal(rec.sessionId, 'sess-fake-123');
  assert.equal(rec.result, 'FAKE RESULT');
  assert.ok(rec.endedAt);
  assert.ok(existsSync(spec.logPath));
});

test('supervisor marks non-zero exit as failed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sup-'));
  const { spec, specPath, env } = makeSpec(dir, { FAKE_CLAUDE_EXIT: '3' });
  execFileSync('node', [SUP, specPath], { env });
  assert.equal(readJson(spec.recordPath).status, 'failed');
});

test('SIGTERM cancels and still finalizes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sup-'));
  const { spec, specPath, env } = makeSpec(dir, { FAKE_CLAUDE_SLEEP_MS: '15000' });
  const sup = spawn('node', [SUP, specPath], { env });
  await new Promise((resolve) => {
    const t = setInterval(() => {
      if (readJson(spec.recordPath)?.status === 'running') { clearInterval(t); resolve(); }
    }, 100);
  });
  sup.kill('SIGTERM');
  await new Promise((resolve) => sup.on('close', resolve));
  const rec = readJson(spec.recordPath);
  assert.equal(rec.status, 'cancelled');
  assert.ok(rec.endedAt);
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npm test` — supervisor tests FAIL.

- [ ] **Step 3: Implement `plugins/claude/scripts/supervisor.mjs`**

```js
#!/usr/bin/env node
// Detached wrapper around one background Claude run. Owns the job record:
// whatever happens to the child (success, failure, cancel), the record gets
// a terminal status. SIGTERM here means "cancel the job".
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { psStart } from './lib/proc.mjs';
import { readJson, writeJsonAtomic } from './lib/state.mjs';
import { extractFromStream } from './lib/stream.mjs';

const LOG_CAP = 5 * 1024 * 1024;
const TAIL_CAP = 2 * 1024 * 1024;
const RESULT_CAP = 10_000;

const spec = readJson(process.argv[2]);
if (!spec) {
  process.stderr.write('supervisor: unreadable spec\n');
  process.exit(2);
}

const child = spawn(process.env.CLAUDE_BIN || 'claude', spec.claudeArgs, {
  cwd: spec.cwd,
  stdio: ['pipe', 'pipe', 'pipe'],
});
child.stdin.end(readFileSync(spec.promptPath, 'utf8'));

writeJsonAtomic(spec.recordPath, {
  ...readJson(spec.recordPath),
  status: 'running',
  pid: process.pid,
  psStart: psStart(process.pid),
});

let logged = 0;
let tail = '';
function sink(chunk) {
  const s = chunk.toString();
  tail = (tail + s).slice(-TAIL_CAP); // result event arrives last; only the tail matters
  if (logged < LOG_CAP) {
    appendFileSync(spec.logPath, s, { mode: 0o600 });
    logged += s.length;
  }
}
child.stdout.on('data', sink);
child.stderr.on('data', sink);

let cancelled = false;
process.on('SIGTERM', () => {
  cancelled = true;
  child.kill('SIGTERM');
  setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
});

child.on('close', (code) => {
  const { sessionId, result, isError } = extractFromStream(tail);
  writeJsonAtomic(spec.recordPath, {
    ...readJson(spec.recordPath),
    status: cancelled ? 'cancelled' : code === 0 && !isError ? 'done' : 'failed',
    exitCode: code,
    sessionId,
    result: result ? result.slice(0, RESULT_CAP) : null,
    endedAt: new Date().toISOString(),
  });
  process.exit(0);
});
child.on('error', () => {
  writeJsonAtomic(spec.recordPath, {
    ...readJson(spec.recordPath),
    status: 'failed',
    exitCode: 127,
    endedAt: new Date().toISOString(),
  });
  process.exit(0);
});
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test` — all pass.

- [ ] **Step 5: Commit**

```bash
git add plugins/claude/scripts/supervisor.mjs tests/supervisor.test.mjs
git commit -m "feat: background job supervisor with cancel-safe finalization"
```

---

### Task 7: Background launch and job management

**Files:**
- Create: `plugins/claude/scripts/background.mjs`, `plugins/claude/scripts/jobs.mjs`
- Test: `tests/jobs.test.mjs`

**Interfaces:**
- Consumes: `state.mjs`, `proc.mjs` (`isAlive`, `psStart`), `supervisor.mjs` (spawned as detached child), `run-claude.mjs` (dynamic-imports `./background.mjs` — created here, signature below must match Task 5's call)
- Produces:
  - `launchBackground({ mode, claudeArgs, prompt, scriptPath, scriptDir }) -> void` — writes prompt file (0600), spec, initial record `status:'starting'`; spawns detached supervisor; prints job id
  - `listJobs(dir) -> record[]` — sorted by `startedAt` desc; a record with `status:'running'` whose supervisor is not alive is reported as `status:'died'`
  - `pruneJobs(dir, now = Date.now()) -> void` — deletes `<id>.json/.log/.prompt/.spec.json` for terminal jobs (`done|failed|cancelled|died`) older than 7 days (`endedAt`)
  - CLI: `node jobs.mjs list` | `node jobs.mjs result <id>` | `node jobs.mjs cancel <id>` (operates on current cwd's workspace partition; every invocation prunes first)

- [ ] **Step 1: Write the failing tests**

`tests/jobs.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jobsDir, readJson, writeJsonAtomic, resolveDataDir } from '../plugins/claude/scripts/lib/state.mjs';
import { psStart } from '../plugins/claude/scripts/lib/proc.mjs';
import { listJobs, pruneJobs } from '../plugins/claude/scripts/jobs.mjs';

const JOBS = fileURLToPath(new URL('../plugins/claude/scripts/jobs.mjs', import.meta.url));
const RUN = fileURLToPath(new URL('../plugins/claude/scripts/run-claude.mjs', import.meta.url));
const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));

test('listJobs flags dead running jobs as died', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jobs-'));
  writeJsonAtomic(join(dir, 'j1.json'), {
    id: 'j1', status: 'running', pid: 99999999, psStart: 'x', startedAt: '2026-01-01T00:00:00Z',
  });
  const [rec] = listJobs(dir);
  assert.equal(rec.status, 'died');
});

test('pruneJobs removes old terminal jobs, keeps recent and running', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jobs-'));
  const old = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
  writeJsonAtomic(join(dir, 'old.json'), { id: 'old', status: 'done', startedAt: old, endedAt: old });
  writeFileSync(join(dir, 'old.log'), 'x');
  writeJsonAtomic(join(dir, 'new.json'), { id: 'new', status: 'done', startedAt: old, endedAt: new Date().toISOString() });
  pruneJobs(dir);
  assert.equal(existsSync(join(dir, 'old.json')), false);
  assert.equal(existsSync(join(dir, 'old.log')), false);
  assert.equal(existsSync(join(dir, 'new.json')), true);
});

test('cancel sends SIGTERM to a live supervisor pid', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jobs-'));
  const codexHome = join(dir, '.codex');
  const env = { ...process.env, CODEX_HOME: codexHome, CODEX_THREAD_ID: 't-1' };
  const victim = spawn('node', ['-e', 'setInterval(() => {}, 1000)']);
  const jdir = jobsDir(resolveDataDir({ env }), dir);
  writeJsonAtomic(join(jdir, 'v1.json'), {
    id: 'v1', status: 'running', pid: victim.pid, psStart: psStart(victim.pid), startedAt: new Date().toISOString(),
  });
  execFileSync('node', [JOBS, 'cancel', 'v1'], { cwd: dir, env, encoding: 'utf8' });
  await new Promise((resolve) => victim.on('close', resolve));
  assert.equal(victim.exitCode === null, true); // killed by signal
});

test('end-to-end: run-claude --background produces a finished job visible to jobs list/result', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jobs-'));
  const env = { ...process.env, CLAUDE_BIN: FAKE, CODEX_HOME: join(dir, '.codex') };
  const out = execFileSync('node', [RUN, 'rescue', '--background'], { cwd: dir, input: 'do it', env, encoding: 'utf8' });
  const id = out.match(/job (\S+)/)[1].replace(/[.,]$/, '');
  const jdir = jobsDir(resolveDataDir({ env }), dir);
  await new Promise((resolve, reject) => {
    const started = Date.now();
    const t = setInterval(() => {
      const rec = readJson(join(jdir, `${id}.json`));
      if (rec?.status === 'done') { clearInterval(t); resolve(); }
      if (Date.now() - started > 10_000) { clearInterval(t); reject(new Error(`job stuck: ${JSON.stringify(rec)}`)); }
    }, 150);
  });
  const listed = execFileSync('node', [JOBS, 'list'], { cwd: dir, env, encoding: 'utf8' });
  assert.match(listed, new RegExp(id));
  const result = execFileSync('node', [JOBS, 'result', id], { cwd: dir, env, encoding: 'utf8' });
  assert.match(result, /FAKE RESULT/);
  assert.match(result, /sess-fake-123/);
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npm test` — jobs tests FAIL.

- [ ] **Step 3: Implement `plugins/claude/scripts/background.mjs`**

```js
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { jobsDir, resolveDataDir, writeJsonAtomic } from './lib/state.mjs';

export function launchBackground({ mode, claudeArgs, prompt, scriptPath, scriptDir }) {
  const dataDir = resolveDataDir({ scriptPath });
  const dir = jobsDir(dataDir, process.cwd());
  const id = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  const promptPath = join(dir, `${id}.prompt`);
  writeFileSync(promptPath, prompt, { mode: 0o600 });
  const spec = {
    id,
    claudeArgs,
    promptPath,
    cwd: process.cwd(),
    logPath: join(dir, `${id}.log`),
    recordPath: join(dir, `${id}.json`),
  };
  const specPath = join(dir, `${id}.spec.json`);
  writeJsonAtomic(specPath, spec);
  writeJsonAtomic(spec.recordPath, { id, mode, startedAt: new Date().toISOString(), status: 'starting' });
  const sup = spawn(process.execPath, [join(scriptDir, 'supervisor.mjs'), specPath], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  sup.unref();
  process.stdout.write(`Started background Claude job ${id} (mode: ${mode}).\nUse $claude:status to check it and $claude:result to fetch the outcome.\n`);
}
```

- [ ] **Step 4: Implement `plugins/claude/scripts/jobs.mjs`**

```js
#!/usr/bin/env node
import { readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isAlive } from './lib/proc.mjs';
import { jobsDir, readJson, resolveDataDir } from './lib/state.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const RETENTION_MS = 7 * 24 * 3600 * 1000;
const TERMINAL = new Set(['done', 'failed', 'cancelled', 'died']);

function recordFiles(dir, id) {
  return [`${id}.json`, `${id}.log`, `${id}.prompt`, `${id}.spec.json`].map((f) => join(dir, f));
}

export function listJobs(dir) {
  const records = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json') || f.endsWith('.spec.json')) continue;
    const rec = readJson(join(dir, f));
    if (!rec?.id) continue;
    if (rec.status === 'running' && !isAlive(rec)) rec.status = 'died';
    records.push(rec);
  }
  return records.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

export function pruneJobs(dir, now = Date.now()) {
  for (const rec of listJobs(dir)) {
    if (!TERMINAL.has(rec.status)) continue;
    const ended = Date.parse(rec.endedAt ?? rec.startedAt ?? '');
    if (Number.isNaN(ended) || now - ended < RETENTION_MS) continue;
    for (const p of recordFiles(dir, rec.id)) {
      try { unlinkSync(p); } catch { /* already gone */ }
    }
  }
}

function main() {
  const [cmd, id] = process.argv.slice(2);
  const dir = jobsDir(resolveDataDir({ scriptPath: SCRIPT_PATH }), process.cwd());
  pruneJobs(dir);
  if (cmd === 'list') {
    const jobs = listJobs(dir);
    if (!jobs.length) { process.stdout.write('No Claude jobs for this workspace.\n'); return; }
    for (const j of jobs) {
      process.stdout.write(`${j.id}  ${j.status}  mode=${j.mode ?? '?'}  started=${j.startedAt}${j.sessionId ? `  session=${j.sessionId}` : ''}\n`);
    }
    return;
  }
  const rec = id ? readJson(join(dir, `${id}.json`)) : null;
  if (cmd === 'result') {
    if (!rec) { process.stderr.write(`No such job: ${id}\n`); process.exit(1); }
    process.stdout.write(`Job ${rec.id}: ${rec.status}\n`);
    if (rec.result) process.stdout.write(`\n${rec.result}\n`);
    if (rec.sessionId) process.stdout.write(`\nClaude session: ${rec.sessionId}\n`);
    if (rec.status === 'failed' || rec.status === 'died') {
      let logTail = '';
      try { logTail = readFileSync(join(dir, `${rec.id}.log`), 'utf8').slice(-2000); } catch { /* no log */ }
      if (logTail) process.stdout.write(`\nLog tail:\n${logTail}\n`);
    }
    return;
  }
  if (cmd === 'cancel') {
    if (!rec) { process.stderr.write(`No such job: ${id}\n`); process.exit(1); }
    if (!isAlive(rec)) { process.stdout.write(`Job ${id} is not running (status: ${rec.status}).\n`); return; }
    process.kill(rec.pid, 'SIGTERM'); // supervisor traps this, forwards to Claude, finalizes the record
    process.stdout.write(`Sent cancel to job ${id}. Check $claude:status shortly.\n`);
    return;
  }
  process.stderr.write('Usage: jobs.mjs list | result <id> | cancel <id>\n');
  process.exit(2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
```

- [ ] **Step 5: Run tests, verify pass**

Run: `npm test` — all pass (end-to-end test exercises run-claude → background → supervisor → jobs).

- [ ] **Step 6: Commit**

```bash
git add plugins/claude/scripts/background.mjs plugins/claude/scripts/jobs.mjs tests/jobs.test.mjs
git commit -m "feat: background job launch, listing, result, cancel, retention"
```

---

### Task 8: Session transfer

**Files:**
- Create: `plugins/claude/scripts/transfer.mjs`
- Test: `tests/transfer.test.mjs`

**Interfaces:**
- Consumes: `state.mjs` (`resolveDataDir`, `sessionsDir`, `handoffsDir`, `readJson`, `codexHome`)
- Produces:
  - `redact(text) -> string` — replaces AWS keys, private-key blocks, long token-ish strings, JWTs with `[REDACTED]`
  - `extractEvidence(jsonlText) -> { goals: {role,text}[], recent: {role,text}[], filesTouched: string[] }` — bounded (4000 chars/message, 20 recent messages, 150000 chars total, 100 files), redacted
  - CLI:
    - `node transfer.mjs extract` — resolves transcript (SessionStart record for `$CODEX_THREAD_ID` first; fallback scans `~/.codex/sessions` for the newest JSONL containing cwd; ambiguity prints candidates and exits 2), prints evidence JSON to stdout
    - `node transfer.mjs write-handoff` — narrative on stdin; prepends `# Handoff from Codex` header if absent (leading-dash guard); writes 0600 file into handoffs dir; prints path and the exact launch command
    - `node transfer.mjs launch <path>` — reads file, spawns interactive Claude with the content as a single argv element (no shell), `stdio: 'inherit'`

- [ ] **Step 1: Write the failing tests**

`tests/transfer.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractEvidence, redact } from '../plugins/claude/scripts/transfer.mjs';
import { resolveDataDir, sessionsDir, writeJsonAtomic } from '../plugins/claude/scripts/lib/state.mjs';

const SCRIPT = fileURLToPath(new URL('../plugins/claude/scripts/transfer.mjs', import.meta.url));
const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));

test('redact scrubs common secrets', () => {
  const s = redact([
    'aws AKIAIOSFODNN7EXAMPLE ok',
    '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----',
    'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9P',
  ].join('\n'));
  assert.ok(!s.includes('AKIAIOSFODNN7EXAMPLE'));
  assert.ok(!s.includes('BEGIN RSA'));
  assert.ok(!s.includes('eyJhbGciOiJIUzI1NiJ9'));
  assert.match(s, /\[REDACTED\]/);
});

test('extractEvidence pulls goals, recent messages, touched files', () => {
  const lines = [
    JSON.stringify({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'build the widget' }] }),
    JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'working on it' }] }),
    JSON.stringify({ payload: { type: 'tool_call', arguments: { file_path: '/repo/src/widget.js' } } }),
    'garbage line',
  ].join('\n');
  const ev = extractEvidence(lines);
  assert.equal(ev.goals[0].text, 'build the widget');
  assert.equal(ev.recent.at(-1).text, 'working on it');
  assert.deepEqual(ev.filesTouched, ['/repo/src/widget.js']);
});

test('extractEvidence caps message and total size', () => {
  const big = JSON.stringify({ type: 'message', role: 'user', content: 'x'.repeat(50_000) });
  const ev = extractEvidence(big);
  assert.ok(ev.goals[0].text.length <= 4000);
});

test('extract resolves transcript via SessionStart record', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-'));
  const transcript = join(dir, 'session.jsonl');
  writeFileSync(transcript, JSON.stringify({ type: 'message', role: 'user', content: 'the goal' }) + '\n');
  const env = { ...process.env, CODEX_HOME: join(dir, '.codex'), CODEX_THREAD_ID: 'th-1' };
  // write the record the SessionStart hook would have written (same shape as Task 10)
  const dataDir = resolveDataDir({ env });
  writeJsonAtomic(join(sessionsDir(dataDir), 'th-1.json'),
    { sessionId: 'th-1', transcriptPath: transcript, cwd: dir });
  const out = execFileSync('node', [SCRIPT, 'extract'], { cwd: dir, env, encoding: 'utf8' });
  const ev = JSON.parse(out);
  assert.equal(ev.sessionId, 'th-1');
  assert.equal(ev.goals[0].text, 'the goal');
});

test('write-handoff prepends header and prints launch command; launch passes content as argv', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-'));
  const env = { ...process.env, CODEX_HOME: join(dir, '.codex') };
  const out = execFileSync('node', [SCRIPT, 'write-handoff'], {
    cwd: dir, env, encoding: 'utf8', input: 'Take over from Codex. Goal: finish widget.',
  });
  const path = out.match(/Handoff written: (\S+)/)[1];
  const content = readFileSync(path, 'utf8');
  assert.ok(content.startsWith('# Handoff from Codex'));
  assert.match(out, /launch/);
  const capture = join(dir, 'cap.json');
  execFileSync('node', [SCRIPT, 'launch', path], {
    cwd: dir, encoding: 'utf8', input: '',
    env: { ...env, CLAUDE_BIN: FAKE, FAKE_CLAUDE_CAPTURE: capture },
  });
  const cap = JSON.parse(readFileSync(capture, 'utf8'));
  assert.equal(cap.argv.length, 1);
  assert.ok(cap.argv[0].startsWith('# Handoff from Codex'));
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npm test` — transfer tests FAIL.

- [ ] **Step 3: Implement `plugins/claude/scripts/transfer.mjs`**

```js
#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  codexHome, handoffsDir, readJson, resolveDataDir, sessionsDir,
} from './lib/state.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const MSG_CAP = 4000;
const MAX_RECENT = 20;
const TOTAL_CAP = 150_000;
const MAX_FILES = 100;

const REDACT_PATTERNS = [
  /AKIA[0-9A-Z]{16}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
  /\b(?:sk|pk|api|token|key|secret|bearer)[-_][A-Za-z0-9_-]{20,}\b/gi,
];

export function redact(text) {
  return REDACT_PATTERNS.reduce((t, re) => t.replace(re, '[REDACTED]'), text);
}

function flattenText(node) {
  const c = node?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((i) => (typeof i === 'string' ? i : i?.text ?? '')).join('');
  if (typeof node?.text === 'string') return node.text;
  return '';
}

const PATH_KEYS = new Set(['path', 'file_path', 'filePath']);
function findPaths(node, out, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return;
  for (const [k, v] of Object.entries(node)) {
    if (PATH_KEYS.has(k) && typeof v === 'string') out.add(v);
    else if (v && typeof v === 'object') findPaths(v, out, depth + 1);
  }
}

export function extractEvidence(jsonlText) {
  const msgs = [];
  const files = new Set();
  for (const line of jsonlText.split('\n')) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const node = e.payload ?? e;
    findPaths(node, files);
    const role = node.role;
    const text = flattenText(node);
    if (!text || (role !== 'user' && role !== 'assistant')) continue;
    msgs.push({ role, text: redact(text).slice(0, MSG_CAP) });
  }
  const evidence = {
    goals: msgs.filter((m) => m.role === 'user').slice(0, 3),
    recent: msgs.slice(-MAX_RECENT),
    filesTouched: [...files].slice(0, MAX_FILES),
  };
  while (JSON.stringify(evidence).length > TOTAL_CAP && evidence.recent.length > 1) {
    evidence.recent.shift();
  }
  return evidence;
}

function walkJsonl(root, out = []) {
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(root, e.name);
    if (e.isDirectory()) walkJsonl(p, out);
    else if (e.name.endsWith('.jsonl')) out.push({ path: p, mtime: statSync(p).mtimeMs });
  }
  return out;
}

function resolveTranscript(env = process.env) {
  const dataDir = resolveDataDir({ env, scriptPath: SCRIPT_PATH });
  const sessionId = env.CODEX_THREAD_ID ?? null;
  if (sessionId) {
    const rec = readJson(join(sessionsDir(dataDir), `${sessionId}.json`));
    if (rec?.transcriptPath && existsSync(rec.transcriptPath)) {
      return { transcriptPath: rec.transcriptPath, sessionId };
    }
  }
  const cwd = process.cwd();
  const matches = walkJsonl(join(codexHome(env), 'sessions'))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 20)
    .filter((c) => {
      try { return readFileSync(c.path, 'utf8').includes(cwd); } catch { return false; }
    });
  if (matches.length === 1) return { transcriptPath: matches[0].path, sessionId };
  return { candidates: matches.map((m) => m.path), sessionId };
}

function cmdExtract() {
  const res = resolveTranscript();
  if (!res.transcriptPath) {
    process.stderr.write('Could not resolve the current Codex transcript.\n');
    if (res.candidates?.length) {
      process.stderr.write(`Candidates (ask the user which one):\n${res.candidates.join('\n')}\n`);
    }
    process.exit(2);
  }
  const evidence = extractEvidence(readFileSync(res.transcriptPath, 'utf8'));
  process.stdout.write(JSON.stringify({
    sessionId: res.sessionId, transcriptPath: res.transcriptPath, ...evidence,
  }, null, 2) + '\n');
}

async function cmdWriteHandoff() {
  let narrative = '';
  for await (const chunk of process.stdin) narrative += chunk;
  narrative = narrative.trim();
  if (!narrative) { process.stderr.write('write-handoff requires the narrative on stdin\n'); process.exit(2); }
  if (!narrative.startsWith('# Handoff from Codex')) {
    narrative = `# Handoff from Codex\n\n${narrative}`;
  }
  const dir = handoffsDir(resolveDataDir({ scriptPath: SCRIPT_PATH }));
  const path = join(dir, `handoff-${Date.now()}.md`);
  writeFileSync(path, `${narrative}\n`, { mode: 0o600 });
  process.stdout.write(`Handoff written: ${path}\n`);
  process.stdout.write(`To start Claude Code with it, run:\n  node "${SCRIPT_PATH}" launch "${path}"\n`);
}

function cmdLaunch(path) {
  const content = readFileSync(path, 'utf8');
  // Content as a single argv element: no shell, no interpolation. The fixed
  // "# Handoff from Codex" header guarantees it cannot start with a dash.
  const res = spawnSync(process.env.CLAUDE_BIN || 'claude', [content], { stdio: 'inherit' });
  process.exit(res.status ?? 1);
}

const [cmd, arg] = process.argv.slice(2);
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (cmd === 'extract') cmdExtract();
  else if (cmd === 'write-handoff') await cmdWriteHandoff();
  else if (cmd === 'launch' && arg) cmdLaunch(arg);
  else { process.stderr.write('Usage: transfer.mjs extract | write-handoff | launch <path>\n'); process.exit(2); }
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test` — all pass.

- [ ] **Step 5: Commit**

```bash
git add plugins/claude/scripts/transfer.mjs tests/transfer.test.mjs
git commit -m "feat: session transfer with bounded redacted evidence and safe launch"
```

---

### Task 9: Setup script

**Files:**
- Create: `plugins/claude/scripts/setup.mjs`
- Test: `tests/setup.test.mjs`

**Interfaces:**
- Consumes: `state.mjs` (`resolveDataDir`, `sessionsDir`, `gateFlagPath`, `readJson`)
- Produces CLI:
  - `node setup.mjs status` — prints JSON: `{ claude: { found, version }, auth, dataDir, sessionRecorded, gateEnabled, notes: string[] }`. Auth = parsed stdout of `claude auth status --json` **regardless of exit code** (it exits non-zero when logged out but still prints JSON). `notes` explains sandbox requirements when relevant.
  - `node setup.mjs gate on` / `node setup.mjs gate off` — creates/removes the gate flag file
  - Install is NOT automated by the script: the SKILL.md tells Codex to run `npm install -g @anthropic-ai/claude-code` only after the user confirms

- [ ] **Step 1: Write the failing tests**

`tests/setup.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gateFlagPath, resolveDataDir } from '../plugins/claude/scripts/lib/state.mjs';

const SCRIPT = fileURLToPath(new URL('../plugins/claude/scripts/setup.mjs', import.meta.url));
const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));

function envFor(dir) {
  return { ...process.env, CLAUDE_BIN: FAKE, CODEX_HOME: join(dir, '.codex'), CODEX_THREAD_ID: 'th-x' };
}

test('status reports claude version and auth', () => {
  const dir = mkdtempSync(join(tmpdir(), 'setup-'));
  const out = JSON.parse(execFileSync('node', [SCRIPT, 'status'], { cwd: dir, env: envFor(dir), encoding: 'utf8' }));
  assert.equal(out.claude.found, true);
  assert.match(out.claude.version, /fake-claude/);
  assert.equal(out.auth.loggedIn, true);
  assert.equal(out.gateEnabled, false);
  assert.equal(out.sessionRecorded, false);
});

test('status reports missing binary gracefully', () => {
  const dir = mkdtempSync(join(tmpdir(), 'setup-'));
  const env = { ...envFor(dir), CLAUDE_BIN: '/nonexistent/claude' };
  const out = JSON.parse(execFileSync('node', [SCRIPT, 'status'], { cwd: dir, env, encoding: 'utf8' }));
  assert.equal(out.claude.found, false);
});

test('gate on/off toggles the flag file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'setup-'));
  const env = envFor(dir);
  execFileSync('node', [SCRIPT, 'gate', 'on'], { cwd: dir, env });
  assert.equal(existsSync(gateFlagPath(resolveDataDir({ env }))), true);
  execFileSync('node', [SCRIPT, 'gate', 'off'], { cwd: dir, env });
  assert.equal(existsSync(gateFlagPath(resolveDataDir({ env }))), false);
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npm test` — setup tests FAIL.

- [ ] **Step 3: Implement `plugins/claude/scripts/setup.mjs`**

```js
#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ensureDir, gateFlagPath, resolveDataDir, sessionsDir,
} from './lib/state.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);

function bin() {
  return process.env.CLAUDE_BIN || 'claude';
}

function cmdStatus() {
  const dataDir = resolveDataDir({ scriptPath: SCRIPT_PATH });
  ensureDir(dataDir);
  const notes = [];
  const version = spawnSync(bin(), ['--version'], { encoding: 'utf8', input: '' });
  const found = !version.error && version.status === 0;
  let auth = null;
  if (found) {
    // Exits non-zero when logged out but still prints JSON: always parse stdout.
    const res = spawnSync(bin(), ['auth', 'status', '--json'], { encoding: 'utf8', input: '' });
    try { auth = JSON.parse(res.stdout.trim()); } catch { auth = { error: 'unparseable auth output' }; }
  } else {
    notes.push('Claude Code not found. Install with: npm install -g @anthropic-ai/claude-code (ask the user first).');
  }
  const sessionId = process.env.CODEX_THREAD_ID;
  const sessionRecorded = Boolean(sessionId && existsSync(join(sessionsDir(dataDir), `${sessionId}.json`)));
  if (!sessionRecorded) {
    notes.push('SessionStart hook has not recorded this session — plugin hooks may not be trusted yet, or the plugin needs a fresh Codex session. $claude:transfer will fall back to transcript scanning.');
  }
  notes.push('Nested Claude needs network access and writes to ~/.claude and ' + dataDir + '. A restrictive Codex sandbox/approval policy must allow these.');
  process.stdout.write(JSON.stringify({
    claude: { found, version: found ? version.stdout.trim() : null },
    auth,
    dataDir,
    sessionRecorded,
    gateEnabled: existsSync(gateFlagPath(dataDir)),
    notes,
  }, null, 2) + '\n');
}

function cmdGate(state) {
  const dataDir = resolveDataDir({ scriptPath: SCRIPT_PATH });
  ensureDir(dataDir);
  const flag = gateFlagPath(dataDir);
  if (state === 'on') {
    writeFileSync(flag, 'on\n', { mode: 0o600 });
    process.stdout.write('Review gate enabled. Warning: every Codex stop now triggers a Claude review — this costs tokens and can loop with long turns.\n');
  } else if (state === 'off') {
    rmSync(flag, { force: true });
    process.stdout.write('Review gate disabled.\n');
  } else {
    process.stderr.write('Usage: setup.mjs gate on|off\n');
    process.exit(2);
  }
}

const [cmd, arg] = process.argv.slice(2);
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (cmd === 'status') cmdStatus();
  else if (cmd === 'gate') cmdGate(arg);
  else { process.stderr.write('Usage: setup.mjs status | gate on|off\n'); process.exit(2); }
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test` — all pass.

- [ ] **Step 5: Commit**

```bash
git add plugins/claude/scripts/setup.mjs tests/setup.test.mjs
git commit -m "feat: setup status checks and review-gate toggle"
```

---

### Task 10: Hooks — SessionStart and Stop review gate

**Files:**
- Create: `plugins/claude/hooks/hooks.json`, `plugins/claude/hooks/session_start.mjs`, `plugins/claude/hooks/stop_review_gate.mjs`
- Test: `tests/hooks.test.mjs`

**Interfaces:**
- Consumes: `../scripts/lib/state.mjs` (hooks live in `plugins/claude/hooks/`, so the relative import is `../scripts/lib/state.mjs`)
- Produces:
  - `session_start.mjs` — stdin JSON `{ session_id, transcript_path?, cwd? }` → writes `<dataDir>/sessions/<session_id>.json` `{ sessionId, transcriptPath: string|null, cwd, recordedAt }`; exits 0 always; no `session_id` → no write
  - `stop_review_gate.mjs` — stdin JSON `{ session_id, stop_hook_active, last_assistant_message?, transcript_path? }`. Blocks ONLY via exit 0 + stdout `{"decision":"block","reason":"..."}`. Fail-open (silent exit 0) when: gate flag absent, `stop_hook_active` true, message null, Claude spawn error/non-zero/timeout, unparseable verdict
  - Hooks receive `PLUGIN_DATA`/`PLUGIN_ROOT` from Codex — they use `resolveDataDir({ env: process.env })` which honors `PLUGIN_DATA` first

- [ ] **Step 1: Write `plugins/claude/hooks/hooks.json`**

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${PLUGIN_ROOT}/hooks/session_start.mjs\"",
            "statusMessage": "Recording session for Claude Code plugin"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${PLUGIN_ROOT}/hooks/stop_review_gate.mjs\""
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 2: Write the failing tests**

`tests/hooks.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gateFlagPath, readJson, sessionsDir } from '../plugins/claude/scripts/lib/state.mjs';

const START = fileURLToPath(new URL('../plugins/claude/hooks/session_start.mjs', import.meta.url));
const GATE = fileURLToPath(new URL('../plugins/claude/hooks/stop_review_gate.mjs', import.meta.url));
const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));

function run(script, event, extraEnv = {}) {
  const dataDir = extraEnv.PLUGIN_DATA;
  return execFileSync('node', [script], {
    input: JSON.stringify(event),
    encoding: 'utf8',
    env: { ...process.env, PLUGIN_DATA: dataDir, ...extraEnv },
  });
}

test('session_start records session keyed by session_id', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hook-'));
  run(START, { session_id: 's9', transcript_path: '/t/x.jsonl', cwd: '/w' }, { PLUGIN_DATA: dataDir });
  const rec = readJson(join(sessionsDir(dataDir), 's9.json'));
  assert.equal(rec.sessionId, 's9');
  assert.equal(rec.transcriptPath, '/t/x.jsonl');
  assert.equal(rec.cwd, '/w');
});

test('session_start tolerates missing session_id and null transcript', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hook-'));
  run(START, { transcript_path: null }, { PLUGIN_DATA: dataDir }); // must not throw
  run(START, { session_id: 's10', transcript_path: null }, { PLUGIN_DATA: dataDir });
  assert.equal(readJson(join(sessionsDir(dataDir), 's10.json')).transcriptPath, null);
});

test('gate is silent when flag is off', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hook-'));
  const out = run(GATE, { session_id: 's1', stop_hook_active: false, last_assistant_message: 'hi' }, { PLUGIN_DATA: dataDir });
  assert.equal(out.trim(), '');
});

test('gate is silent when stop_hook_active or message is null', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hook-'));
  writeFileSync(gateFlagPath(dataDir), 'on\n');
  const env = { PLUGIN_DATA: dataDir, CLAUDE_BIN: FAKE };
  assert.equal(run(GATE, { stop_hook_active: true, last_assistant_message: 'hi' }, env).trim(), '');
  assert.equal(run(GATE, { stop_hook_active: false, last_assistant_message: null }, env).trim(), '');
});

test('gate blocks on failing verdict', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hook-'));
  writeFileSync(gateFlagPath(dataDir), 'on\n');
  const out = run(GATE, { stop_hook_active: false, last_assistant_message: 'I did the thing' }, {
    PLUGIN_DATA: dataDir,
    CLAUDE_BIN: FAKE,
    FAKE_CLAUDE_PLAIN: '{"pass": false, "reason": "tests were never run"}',
  });
  const verdict = JSON.parse(out);
  assert.equal(verdict.decision, 'block');
  assert.match(verdict.reason, /tests were never run/);
});

test('gate fails open on reviewer crash and passing verdict', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hook-'));
  writeFileSync(gateFlagPath(dataDir), 'on\n');
  const crash = run(GATE, { stop_hook_active: false, last_assistant_message: 'x' }, {
    PLUGIN_DATA: dataDir, CLAUDE_BIN: FAKE, FAKE_CLAUDE_PLAIN: 'garbage', FAKE_CLAUDE_EXIT: '1',
  });
  assert.equal(crash.trim(), '');
  const pass = run(GATE, { stop_hook_active: false, last_assistant_message: 'x' }, {
    PLUGIN_DATA: dataDir, CLAUDE_BIN: FAKE, FAKE_CLAUDE_PLAIN: '{"pass": true, "reason": "fine"}',
  });
  assert.equal(pass.trim(), '');
});
```

- [ ] **Step 3: Run tests, verify they fail**

Run: `npm test` — hooks tests FAIL.

- [ ] **Step 4: Implement `plugins/claude/hooks/session_start.mjs`**

```js
#!/usr/bin/env node
import { join } from 'node:path';
import { resolveDataDir, sessionsDir, writeJsonAtomic } from '../scripts/lib/state.mjs';

let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  let evt = {};
  try { evt = JSON.parse(input); } catch { /* fail-open */ }
  if (!evt.session_id) process.exit(0);
  const dataDir = resolveDataDir({ env: process.env });
  writeJsonAtomic(join(sessionsDir(dataDir), `${evt.session_id}.json`), {
    sessionId: evt.session_id,
    transcriptPath: evt.transcript_path ?? null,
    cwd: evt.cwd ?? process.cwd(),
    recordedAt: new Date().toISOString(),
  });
  process.exit(0);
});
```

- [ ] **Step 5: Implement `plugins/claude/hooks/stop_review_gate.mjs`**

```js
#!/usr/bin/env node
// Optional Stop gate: Claude reviews Codex's last turn. SECURITY NOTE: trusted
// hooks run OUTSIDE the Codex tool sandbox — the reviewer is therefore run with
// Claude's own inventory emptied (--tools "") and a hard timeout, and every
// infrastructure failure fails OPEN (never blocks the user on a broken reviewer).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { gateFlagPath, resolveDataDir } from '../scripts/lib/state.mjs';

const TIMEOUT_MS = 180_000; // well under Codex's 10-minute hook default
const MAX_INPUT = 50_000;
const MAX_REASON = 2_000;

let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  try {
    main(JSON.parse(input));
  } catch {
    process.exit(0); // fail-open
  }
});

function main(evt) {
  const dataDir = resolveDataDir({ env: process.env });
  if (!existsSync(gateFlagPath(dataDir))) process.exit(0);
  if (evt.stop_hook_active) process.exit(0); // prevent review loops
  const message = evt.last_assistant_message;
  if (!message) process.exit(0); // nullable per Codex hook contract

  const prompt = [
    'You are a strict review gate for another coding agent. Assess the agent turn',
    'below for: incorrect claims, unfinished work presented as done, or missing',
    'verification (e.g. "tests pass" without running them).',
    'Respond with ONLY a JSON object: {"pass": boolean, "reason": string}.',
    '',
    '--- AGENT TURN ---',
    String(message).slice(0, MAX_INPUT),
  ].join('\n');

  const res = spawnSync(
    process.env.CLAUDE_BIN || 'claude',
    ['-p', '--safe-mode', '--tools', '', '--no-session-persistence'],
    { input: prompt, encoding: 'utf8', timeout: TIMEOUT_MS },
  );
  if (res.error || res.status !== 0) process.exit(0); // fail-open

  let verdict;
  try {
    verdict = JSON.parse(res.stdout.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    process.exit(0); // fail-open
  }
  if (verdict.pass === false && verdict.reason) {
    process.stdout.write(JSON.stringify({
      decision: 'block',
      reason: String(verdict.reason).slice(0, MAX_REASON),
    }));
  }
  process.exit(0);
}
```

- [ ] **Step 6: Run tests, verify pass**

Run: `npm test` — all pass.

- [ ] **Step 7: Commit**

```bash
git add plugins/claude/hooks tests/hooks.test.mjs
git commit -m "feat: SessionStart recorder and fail-open Stop review gate"
```

---

### Task 11: Skills

**Files:**
- Create: `plugins/claude/skills/review/SKILL.md`, `plugins/claude/skills/adversarial-review/SKILL.md`, `plugins/claude/skills/rescue/SKILL.md`, `plugins/claude/skills/transfer/SKILL.md`, `plugins/claude/skills/status/SKILL.md`, `plugins/claude/skills/result/SKILL.md`, `plugins/claude/skills/cancel/SKILL.md`, `plugins/claude/skills/setup/SKILL.md`
- Test: `tests/skills.test.mjs`

**Interfaces:**
- Consumes: script CLIs from Tasks 5–9 (exact argv contracts repeated inside each SKILL.md)
- Produces: the 8 user-facing `$claude:<name>` skills

Every SKILL.md starts with this shared "locating" block after its intro (repeat it verbatim in each file — skills are read in isolation):

```markdown
## Locating the plugin scripts

Resolve the scripts directory once (single glob match expected):

    SCRIPTS=$(ls -d ~/.codex/plugins/cache/*/claude/*/scripts 2>/dev/null | head -1)

If `$SCRIPTS` is empty the plugin install is broken — tell the user to reinstall the plugin.
```

- [ ] **Step 1: Write the frontmatter test**

`tests/skills.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const SKILLS = fileURLToPath(new URL('../plugins/claude/skills', import.meta.url));
const EXPECTED = ['adversarial-review', 'cancel', 'rescue', 'result', 'review', 'setup', 'status', 'transfer'];

test('all eight skills exist with matching frontmatter', () => {
  assert.deepEqual(readdirSync(SKILLS).sort(), EXPECTED);
  for (const name of EXPECTED) {
    const md = readFileSync(join(SKILLS, name, 'SKILL.md'), 'utf8');
    const fm = md.match(/^---\n([\s\S]*?)\n---/);
    assert.ok(fm, `${name}: missing frontmatter`);
    assert.match(fm[1], new RegExp(`^name: ${name}$`, 'm'));
    assert.match(fm[1], /^description: .+$/m);
    assert.match(md, /Locating the plugin scripts/, `${name}: missing script-locating block`);
  }
});
```

Run: `npm test` — FAILS (no skills yet).

- [ ] **Step 2: Write `skills/review/SKILL.md`**

```markdown
---
name: review
description: Read-only Claude Code review of uncommitted changes, optionally against a base branch
---

# Claude Code review

Runs Claude Code in a locked-down read-only mode over precomputed git evidence
(status, staged/unstaged diffs, untracked files). It never modifies the repository.

## Locating the plugin scripts

Resolve the scripts directory once (single glob match expected):

    SCRIPTS=$(ls -d ~/.codex/plugins/cache/*/claude/*/scripts 2>/dev/null | head -1)

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
```

- [ ] **Step 3: Write `skills/adversarial-review/SKILL.md`**

```markdown
---
name: adversarial-review
description: Steerable adversarial Claude Code review that challenges design choices and risk areas
---

# Adversarial Claude Code review

Like `$claude:review`, but Claude is told to challenge design decisions,
tradeoffs, and risk areas, with an optional user-supplied focus. Read-only.

## Locating the plugin scripts

Resolve the scripts directory once (single glob match expected):

    SCRIPTS=$(ls -d ~/.codex/plugins/cache/*/claude/*/scripts 2>/dev/null | head -1)

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
```

- [ ] **Step 4: Write `skills/rescue/SKILL.md`**

```markdown
---
name: rescue
description: Delegate a coding task to Claude Code (foreground or background)
---

# Delegate a task to Claude Code

Hands a task to Claude Code, which MAY EDIT FILES in this workspace
(`--permission-mode acceptEdits`; risky shell commands still auto-denied).

## Locating the plugin scripts

Resolve the scripts directory once (single glob match expected):

    SCRIPTS=$(ls -d ~/.codex/plugins/cache/*/claude/*/scripts 2>/dev/null | head -1)

If `$SCRIPTS` is empty the plugin install is broken — tell the user to reinstall the plugin.

## Options (parse from the user's request)

- `--model <name>` — e.g. `opus`, `sonnet`, `haiku`, or a full model id (passed through to Claude)
- `--resume <claude-session-id>` — continue an earlier Claude session (ids appear as `Claude session: ...`)
- `--yolo` — run Claude with `--dangerously-skip-permissions`. Confirm with the user before using this.
- `--background` — run as a background job

## Steps

1. Write the FULL task description VERBATIM to a temp file with your
   file-writing tool (never inline it into a shell command line), e.g.
   `/tmp/claude-task.txt`. Include all context the user gave.
2. From the repository root:

       node "$SCRIPTS/run-claude.mjs" rescue [--model <m>] [--resume <id>] [--yolo] [--background] < /tmp/claude-task.txt

3. Foreground: relay the result and the `Claude session: <id>` line (the id
   enables `--resume` later). Background: relay the job id, point at `$claude:status`.
4. If it fails with a missing-binary or auth error, run `$claude:setup`.
```

- [ ] **Step 5: Write `skills/transfer/SKILL.md`**

```markdown
---
name: transfer
description: Hand this Codex session off to an interactive Claude Code session
---

# Transfer session to Claude Code

Builds a handoff document from this session and gives the user a command that
starts interactive Claude Code with it. You compose the narrative; the script
only extracts bounded, redacted evidence and handles files safely.

## Locating the plugin scripts

Resolve the scripts directory once (single glob match expected):

    SCRIPTS=$(ls -d ~/.codex/plugins/cache/*/claude/*/scripts 2>/dev/null | head -1)

If `$SCRIPTS` is empty the plugin install is broken — tell the user to reinstall the plugin.

## Steps

1. Run: `node "$SCRIPTS/transfer.mjs" extract < /dev/null`
   - Exit 2 with candidate transcripts listed: ask the user which one, then
     re-run with `CODEX_THREAD_ID` unset is NOT the fix — instead pass the
     chosen file by extracting evidence yourself from that path in step 2.
   - Output is JSON: `goals`, `recent` (last exchanges), `filesTouched`.
2. Compose the handoff narrative from the evidence AND your own knowledge of
   this session. Sections: Goal, Key decisions, Files touched, Current state,
   Next steps. Do not include secrets. Start it with `# Handoff from Codex`.
3. Write the narrative VERBATIM to a temp file with your file-writing tool,
   then run:

       node "$SCRIPTS/transfer.mjs" write-handoff < /tmp/claude-handoff.txt

4. Relay the printed handoff path and launch command to the user. DO NOT run
   the launch command yourself — it starts an interactive TUI the user must own.
```

- [ ] **Step 6: Write `skills/status/SKILL.md`, `skills/result/SKILL.md`, `skills/cancel/SKILL.md`**

`skills/status/SKILL.md`:

```markdown
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
```

`skills/result/SKILL.md`:

```markdown
---
name: result
description: Fetch the result of a background Claude Code job
---

# Claude job result

## Locating the plugin scripts

Resolve the scripts directory once (single glob match expected):

    SCRIPTS=$(ls -d ~/.codex/plugins/cache/*/claude/*/scripts 2>/dev/null | head -1)

If `$SCRIPTS` is empty the plugin install is broken — tell the user to reinstall the plugin.

## Steps

1. Determine the job id (from the user, or `node "$SCRIPTS/jobs.mjs" list`).
2. Run: `node "$SCRIPTS/jobs.mjs" result <id>`
3. Relay the result, including any `Claude session:` line (usable with
   `$claude:rescue --resume <id>`).
```

`skills/cancel/SKILL.md`:

```markdown
---
name: cancel
description: Cancel a running background Claude Code job
---

# Cancel a Claude job

## Locating the plugin scripts

Resolve the scripts directory once (single glob match expected):

    SCRIPTS=$(ls -d ~/.codex/plugins/cache/*/claude/*/scripts 2>/dev/null | head -1)

If `$SCRIPTS` is empty the plugin install is broken — tell the user to reinstall the plugin.

## Steps

1. Determine the job id (from the user, or `node "$SCRIPTS/jobs.mjs" list`).
2. Run: `node "$SCRIPTS/jobs.mjs" cancel <id>`
3. The supervisor finalizes the record as `cancelled`; confirm via `$claude:status`.
```

- [ ] **Step 7: Write `skills/setup/SKILL.md`**

```markdown
---
name: setup
description: Check Claude Code install/auth for this plugin and toggle the Stop review gate
---

# Claude plugin setup

## Locating the plugin scripts

Resolve the scripts directory once (single glob match expected):

    SCRIPTS=$(ls -d ~/.codex/plugins/cache/*/claude/*/scripts 2>/dev/null | head -1)

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
```

- [ ] **Step 8: Run tests, verify pass**

Run: `npm test` — all pass.

- [ ] **Step 9: Commit**

```bash
git add plugins/claude/skills tests/skills.test.mjs
git commit -m "feat: eight user-facing skills with exact script contracts"
```

---

### Task 12: README, validation, manual smoke

**Files:**
- Create: `README.md`
- Modify: nothing else

**Interfaces:**
- Consumes: everything
- Produces: user documentation + verified installable plugin

- [ ] **Step 1: Write `README.md`**

Content requirements (write real prose, not this outline):
- What it is: mirror of openai/codex-plugin-cc — use Claude Code from inside Codex. Feature table: `$claude:review`, `$claude:adversarial-review`, `$claude:rescue`, `$claude:transfer`, `$claude:status`, `$claude:result`, `$claude:cancel`, `$claude:setup`.
- Requirements: Codex CLI ≥0.117 (plugins), Claude Code installed (`npm install -g @anthropic-ai/claude-code`) and logged in, Node ≥18.18, macOS/Linux only.
- Install: `codex plugin marketplace add <owner>/cc-plugin-codex` (or a local path), install plugin `claude`, start a NEW Codex session, approve the plugin's hooks when prompted.
- Sandbox requirements: nested Claude needs network access and writes to `~/.claude` and `~/.codex/plugins/data/claude-cc-plugin-codex`; restrictive approval policies will surface prompts or failures — this is expected.
- Review gate section: off by default; enabling means Claude reviews every Codex stop (token drain warning, loop guard via `stop_hook_active`, fail-open on errors); SECURITY: trusted hooks run outside the Codex tool sandbox.
- Usage costs: runs against the user's Claude plan.
- Development: `npm test`; smoke checklist (copy the list below verbatim into the README):

```markdown
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
```

- [ ] **Step 2: Run the official plugin validator if available**

Run: `ls ~/.codex/plugins/cache/*/plugin-creator/*/scripts/validate_plugin.py 2>/dev/null`
- If found: `python3 <that path> plugins/claude` — fix anything it reports.
- If not found: run `codex plugin marketplace add "$(pwd)"` and confirm the plugin lists without errors, then `codex plugin marketplace remove cc-plugin-codex`.

- [ ] **Step 3: Full test suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: README with install, sandbox requirements, and smoke checklist"
```

- [ ] **Step 5: Execute the manual smoke checklist** (human-in-the-loop; requires real `codex` + `claude` binaries and consumes Claude usage — coordinate with the user before running steps 6–10)

---

## Deviations and notes for the executor

- If Codex's real cache layout differs from `plugins/cache/<marketplace>/<plugin>/<version>` on the installed version, fix `resolveDataDir`'s regex AND its test together — the invariant that matters is: hook-provided `PLUGIN_DATA` and script-derived path MUST be equal for an installed plugin (smoke step 3 catches this via `sessionRecorded`).
- If `claude --safe-mode` or `--tools` flags are named differently in the installed Claude Code version, check `claude --help` and update `buildClaudeArgs` + tests together. Do not silently drop the lockdown.
- If the Stop hook JSON contract differs at smoke time (field names), adjust `stop_review_gate.mjs` reading side only; the block-output contract (`{"decision":"block","reason":...}`, exit 0) is verified against codex-rs.




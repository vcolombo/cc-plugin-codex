import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
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
  assert.match(verdict.reason, /^\[automated review-gate feedback/);
  assert.match(verdict.reason, /tests were never run/);
});

test('gate collapses newlines/control chars in the emitted reason', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hook-'));
  writeFileSync(gateFlagPath(dataDir), 'on\n');
  const out = run(GATE, { stop_hook_active: false, last_assistant_message: 'I did the thing' }, {
    PLUGIN_DATA: dataDir,
    CLAUDE_BIN: FAKE,
    FAKE_CLAUDE_PLAIN: '{"pass": false, "reason": "line one\\nline\\ttwo\\u0007bell"}',
  });
  const verdict = JSON.parse(out);
  assert.equal(verdict.decision, 'block');
  assert.doesNotMatch(verdict.reason, /[\x00-\x1f\x7f]/);
  assert.match(verdict.reason, /line one line two bell/);
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

test('gate caps an oversized event and fails open without crashing', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hook-'));
  writeFileSync(gateFlagPath(dataDir), 'on\n');
  // A ~3MB event that would be valid JSON if untruncated; the cap slices it,
  // parse then fails, and the hook fails open (exit 0, no block).
  const payload = `{"stop_hook_active": false, "last_assistant_message": "${'x'.repeat(3_000_000)}"}`;
  const res = spawnSync('node', [GATE], {
    input: payload,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, PLUGIN_DATA: dataDir, CLAUDE_BIN: FAKE },
  });
  assert.equal(res.status, 0);
  assert.equal(res.stdout.trim(), '');
});

test('session_start exits 0 even when the data dir is unwritable', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hook-'));
  const blocker = join(dataDir, 'sessions');
  writeFileSync(blocker, 'not a directory'); // sessionsDir() mkdir will fail
  const res = spawnSync('node', [START], {
    input: JSON.stringify({ session_id: 's-err' }),
    encoding: 'utf8',
    env: { ...process.env, PLUGIN_DATA: dataDir },
  });
  assert.equal(res.status, 0);
});

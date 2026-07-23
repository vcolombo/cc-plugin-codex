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

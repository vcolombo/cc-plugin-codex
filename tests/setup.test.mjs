import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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

test('status reports a clean error when the data dir cannot be created', () => {
  const dir = mkdtempSync(join(tmpdir(), 'setup-'));
  // Put a regular file where CODEX_HOME/plugins would need to be a directory.
  const codexHome = join(dir, '.codex');
  mkdirSync(join(codexHome, 'plugins', 'data'), { recursive: true });
  writeFileSync(join(codexHome, 'plugins', 'data', 'claude-cc-plugin-codex'), 'not a dir');
  const res = spawnSync('node', [SCRIPT, 'status'], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, CLAUDE_BIN: FAKE, CODEX_HOME: codexHome },
  });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /Cannot create plugin data dir/);
  assert.doesNotMatch(res.stderr, /at cmdStatus|node:internal/);
});

test('status does not create the sessions dir just to check sessionRecorded', () => {
  const dir = mkdtempSync(join(tmpdir(), 'setup-'));
  const env = { ...process.env, CLAUDE_BIN: FAKE, CODEX_HOME: join(dir, '.codex'), CODEX_THREAD_ID: 'th-x' };
  execFileSync('node', [SCRIPT, 'status'], { cwd: dir, env, encoding: 'utf8' });
  const dataDir = resolveDataDir({ env });
  assert.equal(existsSync(join(dataDir, 'sessions')), false, 'status must not mkdir the sessions subdir');
});

test('status explains the sandbox/Keychain cause when claude reports logged out', () => {
  const dir = mkdtempSync(join(tmpdir(), 'setup-'));
  const env = { ...process.env, CLAUDE_BIN: FAKE, CODEX_HOME: join(dir, '.codex'), FAKE_CLAUDE_LOGGED_OUT: '1' };
  delete env.ANTHROPIC_API_KEY;
  const out = JSON.parse(execFileSync('node', [SCRIPT, 'status'], { cwd: dir, env, encoding: 'utf8' }));
  assert.equal(out.auth.loggedIn, false);
  // Note must explain the Keychain cause and point at the guided flow + env vars.
  assert.ok(out.notes.some((n) => /Keychain/.test(n) && /\$claude:setup/.test(n) && /CLAUDE_CODE_OAUTH_TOKEN/.test(n) && /ANTHROPIC_API_KEY/.test(n) && /\.codex\/\.env/.test(n)), 'expected a Keychain note pointing at the guided auth flow');
});

test('env-help scaffolds ~/.codex/.env and never emits a secret', () => {
  const dir = mkdtempSync(join(tmpdir(), 'setup-'));
  const codexHomeDir = join(dir, '.codex');
  const env = { ...process.env, CODEX_HOME: codexHomeDir };
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  const out = JSON.parse(execFileSync('node', [SCRIPT, 'env-help', 'oauth'], { cwd: dir, env, encoding: 'utf8' }));
  assert.equal(out.varName, 'CLAUDE_CODE_OAUTH_TOKEN');
  assert.equal(out.envPath, join(codexHomeDir, '.env'));
  assert.equal(out.envFileCreated, true);
  assert.equal(out.alreadyPresentInFile, false);
  assert.equal(out.alreadyPresentInEnv, false);
  assert.ok(out.steps.some((s) => /claude setup-token/.test(s)));
  // the created file is empty (no secret written) and 0600
  assert.equal(readFileSync(join(codexHomeDir, '.env'), 'utf8'), '');
  assert.equal(statSync(join(codexHomeDir, '.env')).mode & 0o777, 0o600);
});

test('env-help apikey detects an already-present var and does not clobber the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'setup-'));
  const codexHomeDir = join(dir, '.codex');
  mkdirSync(codexHomeDir, { recursive: true });
  writeFileSync(join(codexHomeDir, '.env'), 'ANTHROPIC_API_KEY=already\nFOO=bar\n');
  const out = JSON.parse(execFileSync('node', [SCRIPT, 'env-help', 'apikey'], {
    cwd: dir, env: { ...process.env, CODEX_HOME: codexHomeDir }, encoding: 'utf8',
  }));
  assert.equal(out.varName, 'ANTHROPIC_API_KEY');
  assert.equal(out.envFileCreated, false);
  assert.equal(out.alreadyPresentInFile, true);
  assert.equal(readFileSync(join(codexHomeDir, '.env'), 'utf8'), 'ANTHROPIC_API_KEY=already\nFOO=bar\n'); // untouched
});

test('status does not add the logged-out note when an auth env var is set', () => {
  const base = { ...process.env, CLAUDE_BIN: FAKE, FAKE_CLAUDE_LOGGED_OUT: '1' };
  delete base.ANTHROPIC_API_KEY;
  delete base.CLAUDE_CODE_OAUTH_TOKEN;
  for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) {
    const dir = mkdtempSync(join(tmpdir(), 'setup-'));
    const env = { ...base, CODEX_HOME: join(dir, '.codex'), [key]: 'x-test' };
    const out = JSON.parse(execFileSync('node', [SCRIPT, 'status'], { cwd: dir, env, encoding: 'utf8' }));
    assert.ok(!out.notes.some((n) => /Keychain/.test(n)), `no Keychain note when ${key} is set`);
  }
});

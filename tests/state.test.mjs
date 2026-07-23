import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, symlinkSync } from 'node:fs';
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

test('workspaceKey resolves symlinks to the same key as the real path', () => {
  const real = mkdtempSync(join(tmpdir(), 'state-real-'));
  const link = join(mkdtempSync(join(tmpdir(), 'state-link-')), 'alias');
  symlinkSync(real, link);
  assert.equal(workspaceKey(link), workspaceKey(real));
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

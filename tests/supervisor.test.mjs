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

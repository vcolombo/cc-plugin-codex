import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
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

// Bounded poll so a supervisor that never starts fails the test with a clear
// timeout instead of hanging the whole suite.
function waitForStatus(recordPath, status, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const t = setInterval(() => {
      if (readJson(recordPath)?.status === status) { clearInterval(t); resolve(); }
      else if (Date.now() - started > timeoutMs) { clearInterval(t); reject(new Error(`timed out waiting for status '${status}'`)); }
    }, 50);
  });
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
  await waitForStatus(spec.recordPath, 'running');
  sup.kill('SIGTERM');
  await new Promise((resolve) => sup.on('close', resolve));
  const rec = readJson(spec.recordPath);
  assert.equal(rec.status, 'cancelled');
  assert.ok(rec.endedAt);
});

test('SIGTERM cancels the whole process group, killing grandchildren', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sup-'));
  const { spec, specPath, env } = makeSpec(dir, {
    FAKE_CLAUDE_SPAWN_GRANDCHILD: '1',
    FAKE_CLAUDE_SLEEP_MS: '15000',
  });
  const sup = spawn('node', [SUP, specPath], { env });
  await waitForStatus(spec.recordPath, 'running');
  let gpid;
  await new Promise((resolve, reject) => {
    const started = Date.now();
    const t = setInterval(() => {
      const log = existsSync(spec.logPath) ? readFileSync(spec.logPath, 'utf8') : '';
      const m = log.match(/"type":"grandchild","pid":(\d+)/);
      if (m) { gpid = Number(m[1]); clearInterval(t); resolve(); }
      else if (Date.now() - started > 5000) { clearInterval(t); reject(new Error('grandchild pid never appeared in log')); }
    }, 50);
  });
  sup.kill('SIGTERM');
  await new Promise((resolve) => sup.on('close', resolve));
  assert.equal(readJson(spec.recordPath).status, 'cancelled');
  await new Promise((resolve) => setTimeout(resolve, 500)); // let SIGTERM finish propagating
  assert.throws(() => process.kill(gpid, 0), /ESRCH/);
});

test('SIGTERM cancel SIGKILLs a SIGTERM-resistant grandchild before the supervisor exits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sup-'));
  const { spec, specPath, env } = makeSpec(dir, {
    FAKE_CLAUDE_SPAWN_GRANDCHILD: '1',
    FAKE_CLAUDE_GRANDCHILD_IGNORE_SIGTERM: '1',
    FAKE_CLAUDE_SLEEP_MS: '15000',
  });
  const sup = spawn('node', [SUP, specPath], { env });
  await waitForStatus(spec.recordPath, 'running');
  let gpid;
  await new Promise((resolve, reject) => {
    const started = Date.now();
    const t = setInterval(() => {
      const log = existsSync(spec.logPath) ? readFileSync(spec.logPath, 'utf8') : '';
      const m = log.match(/"type":"grandchild","pid":(\d+)/);
      if (m) { gpid = Number(m[1]); clearInterval(t); resolve(); }
      else if (Date.now() - started > 5000) { clearInterval(t); reject(new Error('grandchild pid never appeared in log')); }
    }, 50);
  });
  // Give the freshly-spawned grandchild time to install its SIGTERM
  // listener before we cancel - otherwise the signal can race the
  // interpreter's own startup and kill it the "normal" way, masking the bug.
  await new Promise((resolve) => setTimeout(resolve, 200));
  sup.kill('SIGTERM');
  await new Promise((resolve) => sup.on('close', resolve));
  assert.equal(readJson(spec.recordPath).status, 'cancelled');
  await new Promise((resolve) => setTimeout(resolve, 500)); // let the SIGKILL sweep finish
  assert.throws(() => process.kill(gpid, 0), /ESRCH/);
});

test('a multibyte char split across stdout chunks is decoded intact', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sup-'));
  const { spec, specPath, env } = makeSpec(dir, { FAKE_CLAUDE_SPLIT_UTF8: '1' });
  execFileSync('node', [SUP, specPath], { env });
  const rec = readJson(spec.recordPath);
  assert.equal(rec.status, 'done');
  assert.equal(rec.result, 'café');
  assert.equal(rec.sessionId, 'sess-fake-123');
});

test('interleaved stderr between split stdout chunks does not corrupt the result', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sup-'));
  const { spec, specPath, env } = makeSpec(dir, { FAKE_CLAUDE_SPLIT_RESULT: '1' });
  execFileSync('node', [SUP, specPath], { env });
  const rec = readJson(spec.recordPath);
  assert.equal(rec.status, 'done');
  assert.equal(rec.result, 'FAKE RESULT');
  assert.equal(rec.sessionId, 'sess-fake-123');
});

test('missing prompt file still finalizes the record as failed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sup-'));
  const { spec, specPath, env } = makeSpec(dir);
  rmSync(spec.promptPath);
  const res = spawnSync('node', [SUP, specPath], { env, encoding: 'utf8' });
  const rec = readJson(spec.recordPath);
  assert.equal(rec.status, 'failed');
  assert.ok(rec.endedAt);
  assert.match(rec.error, /ENOENT|no such file/i);
});

test('a log-write failure mid-run still finalizes the record instead of crashing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sup-'));
  const { spec, specPath, env } = makeSpec(dir, { FAKE_CLAUDE_SLEEP_MS: '300' });
  const sup = spawn('node', [SUP, specPath], { env });
  await waitForStatus(spec.recordPath, 'running');
  // Swap the log file for a directory mid-run: the next appendFileSync in the
  // stdout/stderr 'data' handlers throws EISDIR, outside the setup try/catch.
  rmSync(spec.logPath);
  mkdirSync(spec.logPath);
  await new Promise((resolve) => sup.on('close', resolve));
  const rec = readJson(spec.recordPath);
  assert.notEqual(rec.status, 'running');
  assert.ok(rec.endedAt);
  // Best-effort logging should swallow the write failure rather than crash
  // the supervisor, so the job still finalizes 'done' with its result.
  assert.equal(rec.status, 'done');
  assert.equal(rec.result, 'FAKE RESULT');
  assert.equal(rec.sessionId, 'sess-fake-123');
});

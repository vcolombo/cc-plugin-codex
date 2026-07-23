import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
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

test('result detects a died supervisor and shows the log tail', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jobs-'));
  const env = { ...process.env, CODEX_HOME: join(dir, '.codex') };
  const jdir = jobsDir(resolveDataDir({ env }), dir);
  writeJsonAtomic(join(jdir, 'd1.json'), {
    id: 'd1', status: 'running', pid: 99999999, psStart: 'x', startedAt: new Date().toISOString(),
  });
  writeFileSync(join(jdir, 'd1.log'), 'last words from claude');
  const out = execFileSync('node', [JOBS, 'result', 'd1'], { cwd: dir, env, encoding: 'utf8' });
  assert.match(out, /died/);
  assert.match(out, /last words from claude/);
});

test('result prints a resumable session id for rescue jobs but not review jobs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jobs-'));
  const env = { ...process.env, CODEX_HOME: join(dir, '.codex') };
  const jdir = jobsDir(resolveDataDir({ env }), dir);
  const base = { status: 'done', startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), sessionId: 'sess-x', result: 'ok' };
  writeJsonAtomic(join(jdir, 'resc.json'), { ...base, id: 'resc', mode: 'rescue' });
  writeJsonAtomic(join(jdir, 'rev.json'), { ...base, id: 'rev', mode: 'review' });
  assert.match(execFileSync('node', [JOBS, 'result', 'resc'], { cwd: dir, env, encoding: 'utf8' }), /Claude session: sess-x/);
  assert.doesNotMatch(execFileSync('node', [JOBS, 'result', 'rev'], { cwd: dir, env, encoding: 'utf8' }), /Claude session:/);
});

test('listJobs flags stale starting jobs as died, keeps fresh ones starting', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jobs-'));
  const stale = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  writeJsonAtomic(join(dir, 'stale.json'), { id: 'stale', status: 'starting', startedAt: stale });
  writeJsonAtomic(join(dir, 'fresh.json'), { id: 'fresh', status: 'starting', startedAt: new Date().toISOString() });
  const [freshRec, staleRec] = listJobs(dir).sort((a, b) => a.id.localeCompare(b.id));
  assert.equal(freshRec.status, 'starting');
  assert.equal(staleRec.status, 'died');
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

test('listJobs skips records whose id is unsafe (path traversal)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jobs-'));
  writeJsonAtomic(join(dir, 'evil.json'), { id: '../../escape', status: 'done', startedAt: new Date().toISOString(), endedAt: new Date().toISOString() });
  writeJsonAtomic(join(dir, 'ok.json'), { id: 'ok', status: 'done', startedAt: new Date().toISOString() });
  const ids = listJobs(dir).map((r) => r.id);
  assert.deepEqual(ids, ['ok']);
});

test('cancel/result reject an unsafe argv id before touching the filesystem', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jobs-'));
  const env = { ...process.env, CODEX_HOME: join(dir, '.codex') };
  const res = spawnSync('node', [JOBS, 'result', '../../etc/passwd'], { cwd: dir, env, encoding: 'utf8' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Invalid job id/);
});

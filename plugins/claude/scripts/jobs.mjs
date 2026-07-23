#!/usr/bin/env node
import { readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isAlive } from './lib/proc.mjs';
import { jobsDir, readJson, resolveDataDir } from './lib/state.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const RETENTION_MS = 7 * 24 * 3600 * 1000;
const STARTING_STALE_MS = 3600_000;
const TERMINAL = new Set(['done', 'failed', 'cancelled', 'died']);
// Job ids are generated from base36 time + hex random, so they never contain
// path separators. Validate before any id reaches a filesystem path, so a
// corrupted/hand-planted record (or a crafted argv id) can't traverse out of
// the jobs dir when files are deleted or read.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function recordFiles(dir, id) {
  return [`${id}.json`, `${id}.log`, `${id}.prompt`, `${id}.spec.json`].map((f) => join(dir, f));
}

function markDiedIfDead(rec) {
  if (rec.status === 'running' && !isAlive(rec)) rec.status = 'died';
  else if (rec.status === 'starting' && Date.now() - Date.parse(rec.startedAt ?? '') > STARTING_STALE_MS) rec.status = 'died';
}

export function listJobs(dir) {
  const records = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json') || f.endsWith('.spec.json')) continue;
    const rec = readJson(join(dir, f));
    if (!rec?.id || !SAFE_ID.test(rec.id)) continue;
    markDiedIfDead(rec);
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
  if (id && !SAFE_ID.test(id)) { process.stderr.write(`Invalid job id: ${id}\n`); process.exit(1); }
  const rec = id ? readJson(join(dir, `${id}.json`)) : null;
  if (rec) markDiedIfDead(rec);
  if (cmd === 'result') {
    if (!rec) { process.stderr.write(`No such job: ${id}\n`); process.exit(1); }
    process.stdout.write(`Job ${rec.id}: ${rec.status}\n`);
    if (rec.result) process.stdout.write(`\n${rec.result}\n`);
    // Only rescue sessions are resumable; review runs use --no-session-persistence.
    if (rec.sessionId && rec.mode === 'rescue') process.stdout.write(`\nClaude session: ${rec.sessionId}\n`);
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
    try {
      process.kill(rec.pid, 'SIGTERM'); // supervisor traps this, forwards to Claude, finalizes the record
    } catch {
      // Supervisor exited between the isAlive() check and here (TOCTOU) — the job is already ending.
      process.stdout.write(`Job ${id} already stopped.\n`);
      return;
    }
    process.stdout.write(`Sent cancel to job ${id}. Check $claude:status shortly.\n`);
    return;
  }
  process.stderr.write('Usage: jobs.mjs list | result <id> | cancel <id>\n');
  process.exit(2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

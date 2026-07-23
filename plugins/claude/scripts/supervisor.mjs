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

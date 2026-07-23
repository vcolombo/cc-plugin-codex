#!/usr/bin/env node
// Detached wrapper around one background Claude run. Owns the job record:
// whatever happens to the child (success, failure, cancel), the record gets
// a terminal status. SIGTERM here means "cancel the job".
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
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

// Negative pid = signal the whole process group (see process.kill(2)). Falls
// back to signalling just the child if the group is already gone.
function killGroup(pid, signal) {
  try { process.kill(-pid, signal); }
  catch { try { process.kill(pid, signal); } catch { /* already gone */ } }
}

// Safety net for throws that happen outside the setup try/catch below - e.g.
// inside the async stdout/stderr 'data' callbacks (a log-write EIO, the log
// path replaced by a directory, disk full). Without this the record could be
// stuck 'running' forever. Only finalizes if nothing else already did.
function finalizeOnCrash(err) {
  try {
    const rec = readJson(spec.recordPath);
    if (rec && (rec.status === 'starting' || rec.status === 'running')) {
      writeJsonAtomic(spec.recordPath, {
        ...rec,
        status: 'failed',
        error: String(err?.message ?? err).slice(0, 500),
        endedAt: new Date().toISOString(),
      });
    }
  } catch { /* best effort - the process is exiting either way */ }
  process.exit(1);
}
process.on('uncaughtException', finalizeOnCrash);
process.on('unhandledRejection', finalizeOnCrash);

try {
  writeFileSync(spec.logPath, '', { flag: 'wx', mode: 0o600 });

  // detached: true makes the child its own process-group leader (child.pid
  // doubles as the group id), so cancel can reach Bash grandchildren too.
  const child = spawn(process.env.CLAUDE_BIN || 'claude', spec.claudeArgs, {
    cwd: spec.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  // Decode as text at the stream level so a multibyte char split across two
  // Buffer chunks is reassembled correctly instead of yielding U+FFFD.
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  // Installed before the 'running' record is written: a cancel racing the
  // supervisor startup must still forward to the child and still land a
  // 'cancelled' terminal record via the close handler below.
  let cancelled = false;
  process.on('SIGTERM', () => {
    cancelled = true;
    if (!child.pid) return;
    killGroup(child.pid, 'SIGTERM');
    setTimeout(() => killGroup(child.pid, 'SIGKILL'), 10_000).unref();
  });

  child.stdin.on('error', () => {}); // e.g. EPIPE if Claude exits before reading the prompt
  child.stdin.end(readFileSync(spec.promptPath, 'utf8'));

  writeJsonAtomic(spec.recordPath, {
    ...readJson(spec.recordPath),
    status: 'running',
    pid: process.pid,
    psStart: psStart(process.pid),
  });

  let logged = 0;
  let stdoutTail = ''; // result event arrives last; only the tail matters. stdout-only so an
  // interleaved stderr chunk can't corrupt a multi-chunk stream-json event.
  function writeLog(chunk) {
    // chunk is already a decoded string (setEncoding('utf8') above).
    if (logged < LOG_CAP) {
      // Best-effort: logging is a convenience, not the job outcome. A write
      // failure here (EIO, disk full, log path replaced by a directory)
      // must not take down the supervisor with the record stuck 'running'.
      try {
        appendFileSync(spec.logPath, chunk, { mode: 0o600 });
        logged += chunk.length;
      } catch { /* swallowed - see finalizeOnCrash for the remaining safety net */ }
    }
    return chunk;
  }
  child.stdout.on('data', (chunk) => {
    stdoutTail = (stdoutTail + writeLog(chunk)).slice(-TAIL_CAP);
  });
  child.stderr.on('data', writeLog);

  child.on('close', (code) => {
    // The direct child closing doesn't mean the group is empty: a
    // SIGTERM-resistant grandchild (e.g. ignoring SIGTERM) can outlive it.
    // Sweep with SIGKILL now, synchronously, before this process exits -
    // don't rely solely on the 10s escalation timer below, which never
    // fires once process.exit() runs.
    if (cancelled) killGroup(child.pid, 'SIGKILL');
    const { sessionId, result, isError } = extractFromStream(stdoutTail);
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
  child.on('error', (err) => {
    writeJsonAtomic(spec.recordPath, {
      ...readJson(spec.recordPath),
      status: 'failed',
      exitCode: 127,
      error: String(err?.message ?? err).slice(0, 500),
      endedAt: new Date().toISOString(),
    });
    process.exit(0);
  });
} catch (err) {
  writeJsonAtomic(spec.recordPath, {
    ...readJson(spec.recordPath),
    status: 'failed',
    exitCode: 127,
    error: String(err?.message ?? err).slice(0, 500),
    endedAt: new Date().toISOString(),
  });
  process.exit(0);
}

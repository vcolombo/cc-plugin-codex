#!/usr/bin/env node
import { join } from 'node:path';
import { resolveDataDir, sessionsDir, writeJsonAtomic } from '../scripts/lib/state.mjs';

const MAX_EVENT = 1_000_000;
let input = '';
process.stdin.setEncoding('utf8'); // decode as text so the cap and slice are in the same units (chars) and never split a multibyte char
process.stdin.on('data', (d) => {
  const room = MAX_EVENT - input.length;
  if (room > 0) input += d.length > room ? d.slice(0, room) : d;
});
process.stdin.on('end', () => {
  try {
    let evt = {};
    try { evt = JSON.parse(input); } catch { /* fail-open */ }
    if (evt.session_id) {
      const dataDir = resolveDataDir({ env: process.env });
      writeJsonAtomic(join(sessionsDir(dataDir), `${evt.session_id}.json`), {
        sessionId: evt.session_id,
        transcriptPath: evt.transcript_path ?? null,
        cwd: evt.cwd ?? process.cwd(),
        recordedAt: new Date().toISOString(),
      });
    }
  } catch { /* fail-open: recording is best-effort */ }
  // Codex validates SessionStart hook stdout against this exact schema; empty,
  // plain text, or a bare {} are all rejected as "invalid session start JSON
  // output". additionalContext is empty so we inject nothing into the session.
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '' },
  })}\n`);
  process.exit(0);
});

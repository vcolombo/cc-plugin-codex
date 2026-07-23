#!/usr/bin/env node
import { join } from 'node:path';
import { resolveDataDir, sessionsDir, writeJsonAtomic } from '../scripts/lib/state.mjs';

let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  try {
    let evt = {};
    try { evt = JSON.parse(input); } catch { /* fail-open */ }
    if (!evt.session_id) process.exit(0);
    const dataDir = resolveDataDir({ env: process.env });
    writeJsonAtomic(join(sessionsDir(dataDir), `${evt.session_id}.json`), {
      sessionId: evt.session_id,
      transcriptPath: evt.transcript_path ?? null,
      cwd: evt.cwd ?? process.cwd(),
      recordedAt: new Date().toISOString(),
    });
  } catch { /* fail-open: recording is best-effort */ }
  process.exit(0);
});

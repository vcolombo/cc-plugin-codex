#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ensureDir, gateFlagPath, resolveDataDir,
} from './lib/state.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);

function bin() {
  return process.env.CLAUDE_BIN || 'claude';
}

function ensureDataDirOrExit(dataDir) {
  try {
    ensureDir(dataDir);
  } catch (err) {
    process.stderr.write(`Cannot create plugin data dir ${dataDir}: ${err.message}\nThe Codex sandbox/approval policy must allow writes there.\n`);
    process.exit(1);
  }
}

function cmdStatus() {
  const dataDir = resolveDataDir({ scriptPath: SCRIPT_PATH });
  ensureDataDirOrExit(dataDir);
  const notes = [];
  const version = spawnSync(bin(), ['--version'], { encoding: 'utf8', input: '' });
  const found = !version.error && version.status === 0;
  let auth = null;
  if (found) {
    // Exits non-zero when logged out but still prints JSON: always parse stdout.
    const res = spawnSync(bin(), ['auth', 'status', '--json'], { encoding: 'utf8', input: '' });
    try { auth = JSON.parse(res.stdout.trim()); } catch { auth = { error: 'unparseable auth output' }; }
  } else {
    notes.push('Claude Code not found. Install with: npm install -g @anthropic-ai/claude-code (ask the user first).');
  }
  const sessionId = process.env.CODEX_THREAD_ID;
  // Check the path directly — don't mkdir the sessions subdir just to test for a
  // file, which would EPERM under a restrictive Codex sandbox.
  const sessionRecorded = Boolean(sessionId && existsSync(join(dataDir, 'sessions', `${sessionId}.json`)));
  if (!sessionRecorded) {
    notes.push('SessionStart hook has not recorded this session — plugin hooks may not be trusted yet, or the plugin needs a fresh Codex session. $claude:transfer will fall back to transcript scanning.');
  }
  notes.push('Nested Claude needs network access and writes to ~/.claude and ' + dataDir + '. A restrictive Codex sandbox/approval policy must allow these.');
  process.stdout.write(JSON.stringify({
    claude: { found, version: found ? version.stdout.trim() : null },
    auth,
    dataDir,
    sessionRecorded,
    gateEnabled: existsSync(gateFlagPath(dataDir)),
    notes,
  }, null, 2) + '\n');
}

function cmdGate(state) {
  const dataDir = resolveDataDir({ scriptPath: SCRIPT_PATH });
  ensureDataDirOrExit(dataDir);
  const flag = gateFlagPath(dataDir);
  if (state === 'on') {
    writeFileSync(flag, 'on\n', { mode: 0o600 });
    process.stdout.write('Review gate enabled. Warning: every Codex stop now triggers a Claude review — this costs tokens and can loop with long turns.\n');
  } else if (state === 'off') {
    rmSync(flag, { force: true });
    process.stdout.write('Review gate disabled.\n');
  } else {
    process.stderr.write('Usage: setup.mjs gate on|off\n');
    process.exit(2);
  }
}

const [cmd, arg] = process.argv.slice(2);
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (cmd === 'status') cmdStatus();
    else if (cmd === 'gate') cmdGate(arg);
    else { process.stderr.write('Usage: setup.mjs status | gate on|off\n'); process.exit(2); }
  } catch (err) {
    process.stderr.write(`setup failed: ${err.message}\nA restrictive Codex sandbox/approval policy may be blocking writes to the plugin data dir.\n`);
    process.exit(1);
  }
}

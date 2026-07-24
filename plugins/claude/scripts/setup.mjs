#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  codexHome, ensureDir, gateFlagPath, resolveDataDir,
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
    if (!auth?.loggedIn && !process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
      notes.push('Claude reports logged out. Under the Codex sandbox the macOS Keychain is blocked, so a machine that IS logged in (claude.ai/Max) still reads as logged out. Run `$claude:setup` and choose an auth method — it will walk you through putting a CLAUDE_CODE_OAUTH_TOKEN (subscription, recommended) or ANTHROPIC_API_KEY into ~/.codex/.env, which Codex loads into sessions. Or run Codex with elevated/full access so nested claude can reach the Keychain directly.');
    }
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
    // Drop any existing entry first, then create with 'wx' so the write can't
    // follow a symlink planted at the flag path (matches the plugin's other
    // credential/state writes).
    rmSync(flag, { force: true });
    writeFileSync(flag, 'on\n', { flag: 'wx', mode: 0o600 });
    process.stdout.write('Review gate enabled. Warning: every Codex stop now triggers a Claude review — this costs tokens and can loop with long turns.\n');
  } else if (state === 'off') {
    rmSync(flag, { force: true });
    process.stdout.write('Review gate disabled.\n');
  } else {
    process.stderr.write('Usage: setup.mjs gate on|off\n');
    process.exit(2);
  }
}

// Scaffolds ~/.codex/.env (Codex loads it at startup and injects the vars into
// sessions, including sandboxed skill calls) and prints where/what to add — but
// NEVER handles the secret itself. The token goes from the user's terminal
// straight into the file; it must never pass through this script's output, the
// model, or the transcript. (Codex auth best practice: authenticate host-side,
// keep credentials out of command output.)
function cmdEnvHelp(method) {
  if (method !== 'oauth' && method !== 'apikey') {
    process.stderr.write('Usage: setup.mjs env-help oauth|apikey\n');
    process.exit(2);
  }
  const envPath = join(codexHome(), '.env');
  let created = false;
  if (!existsSync(envPath)) {
    ensureDir(codexHome());
    writeFileSync(envPath, '', { flag: 'wx', mode: 0o600 });
    created = true;
  }
  const varName = method === 'oauth' ? 'CLAUDE_CODE_OAUTH_TOKEN' : 'ANTHROPIC_API_KEY';
  let inFile = false;
  try { inFile = new RegExp(`^\\s*${varName}=`, 'm').test(readFileSync(envPath, 'utf8')); } catch { /* unreadable */ }
  const steps = method === 'oauth'
    ? [
      'In your OWN terminal (not inside Codex), run: claude setup-token — it opens a browser, logs into your Claude subscription, and prints a long-lived OAuth token (no API billing).',
      `Add a line to ${envPath} — do NOT paste the token into this chat: ${varName}=<paste-the-token>`,
      'Start a NEW Codex session so it loads ~/.codex/.env, then run $claude:setup to confirm loggedIn is true.',
    ]
    : [
      'Create an API key at https://console.anthropic.com/settings/keys (bills as API usage, not your subscription).',
      `Add a line to ${envPath} — do NOT paste the key into this chat: ${varName}=<paste-the-key>`,
      'Start a NEW Codex session so it loads ~/.codex/.env, then run $claude:setup to confirm loggedIn is true.',
    ];
  process.stdout.write(JSON.stringify({
    method, varName, envPath, envFileCreated: created, alreadyPresentInFile: inFile, alreadyPresentInEnv: Boolean(process.env[varName]), steps,
  }, null, 2) + '\n');
}

const [cmd, arg] = process.argv.slice(2);
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (cmd === 'status') cmdStatus();
    else if (cmd === 'gate') cmdGate(arg);
    else if (cmd === 'env-help') cmdEnvHelp(arg);
    else { process.stderr.write('Usage: setup.mjs status | gate on|off | env-help oauth|apikey\n'); process.exit(2); }
  } catch (err) {
    process.stderr.write(`setup failed: ${err.message}\nA restrictive Codex sandbox/approval policy may be blocking writes to the plugin data dir.\n`);
    process.exit(1);
  }
}

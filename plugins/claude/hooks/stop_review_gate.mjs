#!/usr/bin/env node
// Optional Stop gate: Claude reviews Codex's last turn. SECURITY NOTE: trusted
// hooks run OUTSIDE the Codex tool sandbox — the reviewer is therefore run with
// Claude's own inventory emptied (--tools "") and a hard timeout, and every
// infrastructure failure fails OPEN (never blocks the user on a broken reviewer).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { gateFlagPath, resolveDataDir } from '../scripts/lib/state.mjs';

const TIMEOUT_MS = 180_000; // well under Codex's 10-minute hook default
const MAX_INPUT = 50_000;
const MAX_REASON = 2_000;

let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  try {
    main(JSON.parse(input));
  } catch {
    process.exit(0); // fail-open
  }
});

function main(evt) {
  const dataDir = resolveDataDir({ env: process.env });
  if (!existsSync(gateFlagPath(dataDir))) process.exit(0);
  if (evt.stop_hook_active) process.exit(0); // prevent review loops
  const message = evt.last_assistant_message;
  if (!message) process.exit(0); // nullable per Codex hook contract

  const prompt = [
    'You are a strict review gate for another coding agent. Assess the agent turn',
    'below for: incorrect claims, unfinished work presented as done, or missing',
    'verification (e.g. "tests pass" without running them).',
    'Respond with ONLY a JSON object: {"pass": boolean, "reason": string}.',
    '',
    '--- AGENT TURN ---',
    String(message).slice(0, MAX_INPUT),
  ].join('\n');

  const res = spawnSync(
    process.env.CLAUDE_BIN || 'claude',
    ['-p', '--safe-mode', '--tools', '', '--no-session-persistence'],
    { input: prompt, encoding: 'utf8', timeout: TIMEOUT_MS },
  );
  if (res.error || res.status !== 0) process.exit(0); // fail-open

  let verdict;
  try {
    verdict = JSON.parse(res.stdout.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    process.exit(0); // fail-open
  }
  if (verdict.pass === false && verdict.reason) {
    process.stdout.write(JSON.stringify({
      decision: 'block',
      reason: String(verdict.reason).slice(0, MAX_REASON),
    }));
  }
  process.exit(0);
}

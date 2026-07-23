#!/usr/bin/env node
// Optional Stop gate: Claude reviews Codex's last turn. SECURITY NOTE: trusted
// hooks run OUTSIDE the Codex tool sandbox — the reviewer is therefore run with
// Claude's own inventory emptied (--tools "") and a hard timeout, and every
// infrastructure failure fails OPEN (never blocks the user on a broken reviewer).
//
// LIMITATION: the gate only ever sees `last_assistant_message` — it has no
// access to tool-call history, so it cannot actually verify claims like
// "tests pass"; its verdict is a heuristic read of the final message's
// wording, not a real check. On a block, `reason` is written back into the
// conversation, which would otherwise make it an attacker-influenced
// cross-model bridge (an injected instruction in the reviewed turn could
// shape free-form reviewer prose). To close that off, the reviewer's own
// text is NEVER forwarded: it may only choose one of a fixed set of
// allowlisted category codes, and the gate emits a locally-authored,
// fixed feedback string for that code. No model prose crosses the boundary.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { gateFlagPath, resolveDataDir } from '../scripts/lib/state.mjs';

const TIMEOUT_MS = 180_000; // well under Codex's 10-minute hook default
const MAX_INPUT = 50_000;
const MAX_EVENT = 1_000_000;

const REASONS = {
  unverified_tests: 'Review gate: the last turn claimed success without shown verification (e.g. tests not run). Verify before stopping.',
  incomplete_work: 'Review gate: the last turn appears to present incomplete work as done. Confirm completion before stopping.',
  incorrect_claim: 'Review gate: the last turn may contain an incorrect claim. Re-check before stopping.',
  other: 'Review gate: a concern was flagged with the last turn. Re-check before stopping.',
};

let input = '';
process.stdin.on('data', (d) => {
  const room = MAX_EVENT - input.length;
  if (room > 0) input += d.length > room ? d.slice(0, room) : d;
});
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
    'Respond with ONLY a JSON object, no prose: {"pass": boolean, "category": string}.',
    'If pass is false, category must be exactly one of:',
    '"unverified_tests", "incomplete_work", "incorrect_claim", "other".',
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
  if (verdict.pass === false && Object.hasOwn(REASONS, verdict.category)) {
    process.stdout.write(JSON.stringify({
      decision: 'block',
      reason: REASONS[verdict.category],
    }));
  }
  process.exit(0);
}

#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildReviewEvidence } from './lib/evidence.mjs';
import { extractFromStream } from './lib/stream.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const TAIL_CAP = 2 * 1024 * 1024;

export const REVIEW_PROMPT = `You are performing a strictly read-only code review from inside another agent's workflow.
Evidence (git status, diffs, untracked files) is included below. You may use Read, Glob,
and Grep for surrounding context. Never modify anything.

Review for: correctness bugs, security issues, missing error handling, and test gaps.
For each finding give: file, location (from the diff hunks), the problem, and a concrete fix.
Order findings by severity. If nothing significant is wrong, say so briefly.`;

export const ADVERSARIAL_PROMPT = `${REVIEW_PROMPT}

Additionally, be adversarial: challenge design choices, question tradeoffs, and probe
risk areas even where the code "works". If a focus area is given below, prioritize it.`;

export function buildClaudeArgs(mode, opts = {}) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (mode === 'review') {
    args.push('--safe-mode', '--tools', 'Read,Glob,Grep', '--no-session-persistence');
  } else if (mode === 'rescue') {
    if (opts.yolo) args.push('--dangerously-skip-permissions');
    else args.push('--permission-mode', 'acceptEdits');
    if (opts.model) args.push('--model', opts.model);
    if (opts.resume) args.push('--resume', opts.resume);
  } else {
    throw new Error(`unknown mode: ${mode}`);
  }
  return args;
}

function parseArgv(argv) {
  const [mode, ...rest] = argv;
  const opts = { mode };
  let i = 0;
  const takeValue = (flag) => {
    const v = rest[++i];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} requires a value`);
    return v;
  };
  for (; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--base') opts.base = takeValue(a);
    else if (a === '--model') opts.model = takeValue(a);
    else if (a === '--resume') opts.resume = takeValue(a);
    else if (a === '--adversarial') opts.adversarial = true;
    else if (a === '--yolo') opts.yolo = true;
    else if (a === '--background') opts.background = true;
    else throw new Error(`unknown flag: ${a}`);
  }
  return opts;
}

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

export function buildPrompt(opts, stdinText) {
  if (opts.mode === 'review') {
    const evidence = buildReviewEvidence({ cwd: process.cwd(), base: opts.base ?? null });
    const header = opts.adversarial ? ADVERSARIAL_PROMPT : REVIEW_PROMPT;
    const focus = opts.adversarial && stdinText.trim() ? `\n\n## Focus area\n\n${stdinText.trim()}\n` : '';
    return `${header}${focus}\n\n${evidence}`;
  }
  if (!stdinText.trim()) throw new Error('rescue requires the task text on stdin');
  return stdinText;
}

function runForeground(claudeArgs, prompt, mode) {
  const child = spawn(process.env.CLAUDE_BIN || 'claude', claudeArgs, {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  child.stdin.on('error', () => {});
  child.stdin.end(prompt);
  let out = '';
  child.stdout.setEncoding('utf8'); // decode across chunk boundaries so a split multibyte char isn't corrupted
  child.stdout.on('data', (d) => { out = (out + d).slice(-TAIL_CAP); }); // result event arrives last; only the tail matters
  child.on('close', (code) => {
    const { sessionId, result, isError } = extractFromStream(out);
    if (result) process.stdout.write(`${result}\n`);
    if (sessionId && mode === 'rescue') process.stdout.write(`\nClaude session: ${sessionId}\n`);
    process.exit(isError && code === 0 ? 1 : code ?? 1);
  });
  child.on('error', (err) => {
    process.stderr.write(`Failed to launch Claude Code (${err.message}). Run $claude:setup.\n`);
    process.exit(127);
  });
}

async function main() {
  const opts = parseArgv(process.argv.slice(2));
  const stdinText = await readStdin();
  const prompt = buildPrompt(opts, stdinText);
  const claudeArgs = buildClaudeArgs(opts.mode, opts);
  if (opts.background) {
    const { launchBackground } = await import('./background.mjs');
    launchBackground({ mode: opts.mode, claudeArgs, prompt, scriptPath: SCRIPT_PATH, scriptDir: dirname(SCRIPT_PATH) });
    return;
  }
  runForeground(claudeArgs, prompt, opts.mode);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  });
}

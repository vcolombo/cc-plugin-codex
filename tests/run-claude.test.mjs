import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildClaudeArgs } from '../plugins/claude/scripts/run-claude.mjs';

const SCRIPT = fileURLToPath(new URL('../plugins/claude/scripts/run-claude.mjs', import.meta.url));
const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));

test('buildClaudeArgs review is locked down', () => {
  assert.deepEqual(buildClaudeArgs('review'), [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--safe-mode', '--tools', 'Read,Glob,Grep', '--no-session-persistence',
  ]);
});

test('buildClaudeArgs rescue defaults to acceptEdits', () => {
  assert.deepEqual(buildClaudeArgs('rescue'), [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'acceptEdits',
  ]);
});

test('buildClaudeArgs rescue honors yolo, model, resume', () => {
  const args = buildClaudeArgs('rescue', { yolo: true, model: 'opus', resume: 'sid-9' });
  assert.ok(args.includes('--dangerously-skip-permissions'));
  assert.ok(!args.includes('--permission-mode'));
  assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), ['--model', 'opus']);
  assert.deepEqual(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2), ['--resume', 'sid-9']);
});

test('buildClaudeArgs rejects unknown mode', () => {
  assert.throws(() => buildClaudeArgs('nope'));
});

test('CLI rejects --base with a missing value', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rc-'));
  assert.throws(
    () => execFileSync('node', [SCRIPT, 'review', '--base', '--background'], {
      cwd: dir, input: '', encoding: 'utf8',
      env: { ...process.env, CLAUDE_BIN: FAKE, CODEX_HOME: join(dir, '.codex') },
    }),
    /--base requires a value/,
  );
});

test('foreground rescue pipes task via stdin and surfaces result + session', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rc-'));
  const capture = join(dir, 'cap.json');
  const out = execFileSync('node', [SCRIPT, 'rescue'], {
    cwd: dir,
    input: 'fix the widget',
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_BIN: FAKE,
      FAKE_CLAUDE_CAPTURE: capture,
      CODEX_HOME: join(dir, '.codex'),
    },
  });
  assert.match(out, /FAKE RESULT/);
  assert.match(out, /Claude session: sess-fake-123/);
  const cap = JSON.parse(readFileSync(capture, 'utf8'));
  assert.ok(cap.argv.includes('--verbose'), 'stream-json requires --verbose');
  assert.ok(cap.stdin.includes('fix the widget'));
});

test('foreground review includes precomputed evidence in the prompt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rc-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  writeFileSync(join(dir, 'n.txt'), 'new file\n');
  const capture = join(dir, 'cap.json');
  execFileSync('node', [SCRIPT, 'review'], {
    cwd: dir,
    input: '',
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_BIN: FAKE, FAKE_CLAUDE_CAPTURE: capture, CODEX_HOME: join(dir, '.codex') },
  });
  const cap = JSON.parse(readFileSync(capture, 'utf8'));
  assert.ok(cap.argv.includes('--safe-mode'));
  assert.match(cap.stdin, /read-only code review/);
  assert.match(cap.stdin, /Untracked: n\.txt/);
});

test('foreground review does not surface session id', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rc-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  const capture = join(dir, 'cap.json');
  const out = execFileSync('node', [SCRIPT, 'review'], {
    cwd: dir,
    input: '',
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_BIN: FAKE, FAKE_CLAUDE_CAPTURE: capture, CODEX_HOME: join(dir, '.codex') },
  });
  assert.match(out, /FAKE RESULT/);
  assert.ok(!out.match(/Claude session:/), 'review mode should not print session id');
});

test('foreground decodes UTF-8 split across stdout chunks without corruption', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rc-'));
  const out = execFileSync('node', [SCRIPT, 'rescue'], {
    cwd: dir, input: 'do it', encoding: 'utf8',
    env: { ...process.env, CLAUDE_BIN: FAKE, FAKE_CLAUDE_SPLIT_UTF8: '1', CODEX_HOME: join(dir, '.codex') },
  });
  assert.match(out, /café/);
  assert.doesNotMatch(out, /�/); // no replacement chars
});

test('unknown mode errors immediately with a clear message (exit 2), no stdin hang', () => {
  const res = spawnSync('node', [SCRIPT, 'bogus'], {
    input: '', encoding: 'utf8', env: { ...process.env },
  });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /unknown mode: bogus/);
});

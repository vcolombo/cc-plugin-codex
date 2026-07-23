import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractEvidence, redact } from '../plugins/claude/scripts/transfer.mjs';
import { resolveDataDir, sessionsDir, writeJsonAtomic } from '../plugins/claude/scripts/lib/state.mjs';

const SCRIPT = fileURLToPath(new URL('../plugins/claude/scripts/transfer.mjs', import.meta.url));
const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));

test('redact scrubs common secrets', () => {
  const s = redact([
    'aws AKIAIOSFODNN7EXAMPLE ok',
    '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----',
    'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9P',
  ].join('\n'));
  assert.ok(!s.includes('AKIAIOSFODNN7EXAMPLE'));
  assert.ok(!s.includes('BEGIN RSA'));
  assert.ok(!s.includes('eyJhbGciOiJIUzI1NiJ9'));
  assert.match(s, /\[REDACTED\]/);
});

test('extractEvidence pulls goals, recent messages, touched files', () => {
  const lines = [
    JSON.stringify({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'build the widget' }] }),
    JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'working on it' }] }),
    JSON.stringify({ payload: { type: 'tool_call', arguments: { file_path: '/repo/src/widget.js' } } }),
    'garbage line',
  ].join('\n');
  const ev = extractEvidence(lines);
  assert.equal(ev.goals[0].text, 'build the widget');
  assert.equal(ev.recent.at(-1).text, 'working on it');
  assert.deepEqual(ev.filesTouched, ['/repo/src/widget.js']);
});

test('extractEvidence caps message and total size', () => {
  const big = JSON.stringify({ type: 'message', role: 'user', content: 'x'.repeat(50_000) });
  const ev = extractEvidence(big);
  assert.ok(ev.goals[0].text.length <= 4000);
});

test('extract resolves transcript via SessionStart record', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-'));
  const transcript = join(dir, 'session.jsonl');
  writeFileSync(transcript, JSON.stringify({ type: 'message', role: 'user', content: 'the goal' }) + '\n');
  const env = { ...process.env, CODEX_HOME: join(dir, '.codex'), CODEX_THREAD_ID: 'th-1' };
  // write the record the SessionStart hook would have written (same shape as Task 10)
  const dataDir = resolveDataDir({ env });
  writeJsonAtomic(join(sessionsDir(dataDir), 'th-1.json'),
    { sessionId: 'th-1', transcriptPath: transcript, cwd: dir });
  const out = execFileSync('node', [SCRIPT, 'extract'], { cwd: dir, env, encoding: 'utf8' });
  const ev = JSON.parse(out);
  assert.equal(ev.sessionId, 'th-1');
  assert.equal(ev.goals[0].text, 'the goal');
});

test('write-handoff prepends header and prints launch command; launch passes content as argv', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-'));
  const env = { ...process.env, CODEX_HOME: join(dir, '.codex') };
  const out = execFileSync('node', [SCRIPT, 'write-handoff'], {
    cwd: dir, env, encoding: 'utf8', input: 'Take over from Codex. Goal: finish widget.',
  });
  const path = out.match(/Handoff written: (\S+)/)[1];
  const content = readFileSync(path, 'utf8');
  assert.ok(content.startsWith('# Handoff from Codex'));
  assert.match(out, /launch/);
  const capture = join(dir, 'cap.json');
  execFileSync('node', [SCRIPT, 'launch', path], {
    cwd: dir, encoding: 'utf8', input: '',
    env: { ...env, CLAUDE_BIN: FAKE, FAKE_CLAUDE_CAPTURE: capture },
  });
  const cap = JSON.parse(readFileSync(capture, 'utf8'));
  assert.equal(cap.argv.length, 1);
  assert.ok(cap.argv[0].startsWith('# Handoff from Codex'));
});

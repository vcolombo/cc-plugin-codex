import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, utimesSync, realpathSync, symlinkSync } from 'node:fs';
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

test('launch guards arbitrary file content that starts with a dash', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-'));
  const path = join(dir, 'evil.txt');
  writeFileSync(path, '--dangerously-skip-permissions and then some\n');
  const capture = join(dir, 'cap.json');
  execFileSync('node', [SCRIPT, 'launch', path], {
    cwd: dir, encoding: 'utf8', input: '',
    env: { ...process.env, CLAUDE_BIN: FAKE, FAKE_CLAUDE_CAPTURE: capture },
  });
  const cap = JSON.parse(readFileSync(capture, 'utf8'));
  assert.equal(cap.argv.length, 1);
  assert.ok(cap.argv[0].startsWith('# Handoff from Codex'));
});

test('launch surfaces spawn errors (missing CLAUDE_BIN) with exit 127', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-'));
  const env = { ...process.env, CODEX_HOME: join(dir, '.codex') };
  const out = execFileSync('node', [SCRIPT, 'write-handoff'], {
    cwd: dir, env, encoding: 'utf8', input: 'Take over from Codex. Goal: finish widget.',
  });
  const path = out.match(/Handoff written: (\S+)/)[1];
  const res = spawnSync('node', [SCRIPT, 'launch', path], {
    cwd: dir, encoding: 'utf8', input: '',
    env: { ...env, CLAUDE_BIN: '/nonexistent/claude' },
  });
  assert.equal(res.status, 127);
  assert.match(res.stderr, /setup/);
});

test('launch reports a clean error on an unreadable handoff path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-'));
  const res = spawnSync('node', [SCRIPT, 'launch', join(dir, 'does-not-exist.md')], {
    cwd: dir, encoding: 'utf8', input: '',
    env: { ...process.env, CODEX_HOME: join(dir, '.codex'), CLAUDE_BIN: '/nonexistent/claude' },
  });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Cannot read handoff file/);
  assert.doesNotMatch(res.stderr, /at cmdLaunch|at Object|node:internal/); // no stack trace
});

test('redact scrubs vendor tokens and high-entropy runs but keeps git SHAs', () => {
  const s = redact([
    'github ghp_ABCdefGHIjklMNOpqrSTUvwxYZ0123456789',
    'slack xoxb-1234567890-abcdefghij',
    'npm npm_ABCdef0123456789ABCdef0123456789XYZ',
    'entropy Xy9Zw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0Fe9Dc8Ba7Xy9Zw8V',
    'sha 3f786850e387550fdab836ed7e6dc881de23001b',
  ].join('\n'));
  assert.ok(!s.includes('ghp_'));
  assert.ok(!s.includes('xoxb-'));
  assert.ok(!s.includes('npm_ABC'));
  assert.ok(!s.includes('Xy9Zw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0Fe9Dc8Ba7'));
  assert.ok(s.includes('3f786850e387550fdab836ed7e6dc881de23001b'), 'git SHAs must survive');
});

test('redact scrubs Google API keys, GitLab PATs, key=value secrets, and auth headers', () => {
  const s = redact([
    'google AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY',
    'gitlab glpat-abcdefghijklmnopqrst',
    'config password=hunter2',
    'header Authorization: Bearer abcDEF012345.ghiJKL',
  ].join('\n'));
  assert.ok(!s.includes('AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY'));
  assert.ok(!s.includes('glpat-abcdefghijklmnopqrst'));
  assert.ok(!s.includes('hunter2'));
  assert.ok(!s.includes('abcDEF012345.ghiJKL'));
  assert.match(s, /\[REDACTED\]/);
});

test('redact consumes the whole secret value, not just one token', () => {
  const s = redact([
    'Authorization: Basic dXNlcjpwYXNz',
    'Authorization: Digest username="u", response="abcd1234"',
    'password="correct horse battery staple"',
    'auth bearer AbC123.def-456_GHI',
  ].join('\n'));
  assert.ok(!s.includes('dXNlcjpwYXNz'));
  assert.ok(!s.includes('username="u"'));
  assert.ok(!s.includes('abcd1234'));
  assert.ok(!s.includes('correct horse battery staple'));
  assert.ok(!s.includes('AbC123.def-456_GHI'));
});

test('fallback scan matches cwd beyond the 20 newest sessions', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tr-')));
  const home = join(dir, '.codex');
  const sess = join(home, 'sessions');
  mkdirSync(sess, { recursive: true });
  for (let i = 0; i < 25; i++) writeFileSync(join(sess, `other-${i}.jsonl`), JSON.stringify({ role: 'user', content: `unrelated ${i}` }) + '\n');
  // target written FIRST so it is the oldest by mtime
  const target = join(sess, 'target.jsonl');
  writeFileSync(target, JSON.stringify({ role: 'user', content: `work in ${dir}` }) + '\n');
  const past = new Date(Date.now() - 60_000);
  utimesSync(target, past, past);
  const env = { ...process.env, CODEX_HOME: home };
  delete env.CODEX_THREAD_ID;
  const out = execFileSync('node', [SCRIPT, 'extract'], { cwd: dir, env, encoding: 'utf8' });
  assert.equal(JSON.parse(out).transcriptPath, target);
});

test('write-handoff redacts secrets in the narrative before writing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-'));
  const env = { ...process.env, CODEX_HOME: join(dir, '.codex') };
  const secret = 'AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY';
  const out = execFileSync('node', [SCRIPT, 'write-handoff'], {
    cwd: dir, env, encoding: 'utf8', input: `Take over. Use key ${secret} to auth.`,
  });
  const path = out.match(/Handoff written: (\S+)/)[1];
  const content = readFileSync(path, 'utf8');
  assert.ok(content.startsWith('# Handoff from Codex'));
  assert.ok(!content.includes(secret));
  assert.match(content, /\[REDACTED\]/);
});

test('extractEvidence finds apply_patch file paths inside a serialized string tool call', () => {
  const line = JSON.stringify({
    payload: {
      type: 'custom_tool_call',
      arguments: '*** Begin Patch\n*** Update File: src/secret.js\n@@\n-old\n+new\n*** End Patch',
    },
  });
  const ev = extractEvidence(line);
  assert.ok(ev.filesTouched.includes('src/secret.js'));
});

test('extractEvidence captures both source and destination of an apply_patch rename', () => {
  const line = JSON.stringify({
    payload: {
      type: 'custom_tool_call',
      arguments: '*** Begin Patch\n*** Update File: old/name.js\n*** Move to: new/name.js\n*** End Patch',
    },
  });
  const ev = extractEvidence(line);
  assert.ok(ev.filesTouched.includes('old/name.js'));
  assert.ok(ev.filesTouched.includes('new/name.js'));
});

test('broken symlink named *.jsonl does not crash the walk', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tr-')));
  const home = join(dir, '.codex');
  const sess = join(home, 'sessions');
  mkdirSync(sess, { recursive: true });
  symlinkSync(join(sess, 'does-not-exist'), join(sess, 'dead.jsonl'));
  const target = join(sess, 'valid.jsonl');
  writeFileSync(target, JSON.stringify({ role: 'user', content: `work in ${dir}` }) + '\n');
  const env = { ...process.env, CODEX_HOME: home };
  delete env.CODEX_THREAD_ID;
  const out = execFileSync('node', [SCRIPT, 'extract'], { cwd: dir, env, encoding: 'utf8' });
  assert.equal(JSON.parse(out).transcriptPath, target);
});

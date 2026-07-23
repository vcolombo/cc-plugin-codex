import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReviewEvidence, PER_FILE_CAP } from '../plugins/claude/scripts/lib/evidence.mjs';

function initRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'ev-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  g('add', '.');
  g('commit', '-qm', 'init');
  return { dir, g };
}

test('captures staged, unstaged, untracked, binary', () => {
  const { dir, g } = initRepo();
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n');          // unstaged
  writeFileSync(join(dir, 'b.txt'), 'staged content\n');
  g('add', 'b.txt');                                         // staged
  writeFileSync(join(dir, 'c.txt'), 'untracked text\n');     // untracked text
  writeFileSync(join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 0]));  // untracked binary
  const ev = buildReviewEvidence({ cwd: dir });
  assert.match(ev, /## Staged changes[\s\S]*staged content/);
  assert.match(ev, /## Unstaged changes[\s\S]*\+two/);
  assert.match(ev, /## Untracked: c\.txt[\s\S]*untracked text/);
  assert.match(ev, /## Untracked: blob\.bin[\s\S]*binary file, contents omitted/);
});

test('base ref uses merge-base (three-dot) diff', () => {
  const { dir, g } = initRepo();
  const baseSha = g('rev-parse', 'HEAD').trim();
  writeFileSync(join(dir, 'a.txt'), 'committed change\n');
  g('commit', '-aqm', 'change');
  const ev = buildReviewEvidence({ cwd: dir, base: baseSha });
  assert.match(ev, /## Committed changes vs /);
  assert.match(ev, /\+committed change/);
});

test('caps oversized untracked files with truncation marker', () => {
  const { dir } = initRepo();
  writeFileSync(join(dir, 'big.txt'), 'x'.repeat(PER_FILE_CAP + 1000));
  const ev = buildReviewEvidence({ cwd: dir });
  assert.match(ev, /truncated at /);
});

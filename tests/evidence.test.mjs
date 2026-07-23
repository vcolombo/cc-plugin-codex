import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReviewEvidence, PER_FILE_CAP, MAX_UNTRACKED_READ } from '../plugins/claude/scripts/lib/evidence.mjs';

function initRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'ev-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  g('config', 'commit.gpgsign', 'false'); // tests must not depend on the dev's commit-signing setup
  g('config', 'tag.gpgsign', 'false');
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

test('non-git cwd throws instead of returning empty evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ev-notrepo-'));
  assert.throws(() => buildReviewEvidence({ cwd: dir }), /Not a git repository/);
});

test('--base ref that does not exist throws', () => {
  const { dir } = initRepo();
  assert.throws(() => buildReviewEvidence({ cwd: dir, base: 'no-such-ref' }), /--base ref not found/);
});

test('untracked symlinks are not dereferenced', () => {
  const { dir } = initRepo();
  writeFileSync(join(dir, 'secret-target.txt'), 'SECRET-CONTENT\n');
  execFileSync('git', ['add', 'secret-target.txt'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'target'], { cwd: dir });
  symlinkSync(join(dir, 'secret-target.txt'), join(dir, 'link.txt'));
  const ev = buildReviewEvidence({ cwd: dir });
  assert.match(ev, /## Untracked: link\.txt[\s\S]*not a regular file/);
});

test('binary check does not require reading the whole file', () => {
  const { dir } = initRepo();
  const big = Buffer.alloc(9000, 0x61); // 'a'
  big[0] = 0; // NUL in first 8KB → binary
  writeFileSync(join(dir, 'big.bin'), big);
  const ev = buildReviewEvidence({ cwd: dir });
  assert.match(ev, /## Untracked: big\.bin[\s\S]*binary file, contents omitted/);
});

test('caps how many untracked files are read; lists the rest by name', () => {
  const { dir } = initRepo();
  const n = MAX_UNTRACKED_READ + 5;
  for (let i = 0; i < n; i++) writeFileSync(join(dir, `u${i}.txt`), `content ${i}\n`);
  const ev = buildReviewEvidence({ cwd: dir });
  const readSections = (ev.match(/## Untracked: /g) || []).length;
  assert.equal(readSections, MAX_UNTRACKED_READ);
  assert.match(ev, new RegExp(`Additional untracked files \\(5, contents omitted\\)`));
});

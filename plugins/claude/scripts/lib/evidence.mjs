import { execFileSync } from 'node:child_process';
import { lstatSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';

export const PER_FILE_CAP = 100_000;
export const TOTAL_CAP = 400_000;

function git(cwd, ...args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    return err.stdout?.toString?.() ?? '';
  }
}

function cap(text, limit) {
  return text.length > limit
    ? `${text.slice(0, limit)}\n[... truncated at ${limit} chars]\n`
    : text;
}

export function buildReviewEvidence({ cwd, base = null }) {
  if (base) {
    try {
      execFileSync('git', ['rev-parse', '--verify', '--quiet', `${base}^{commit}`], { cwd, encoding: 'utf8' });
    } catch {
      throw new Error(`--base ref not found: ${base}`);
    }
  }
  const sections = [`# Review evidence\n\nRepository: ${cwd}\n`];
  sections.push(`## git status\n\n\`\`\`\n${git(cwd, 'status', '--porcelain')}\`\`\`\n`);
  if (base) {
    sections.push(`## Committed changes vs ${base} (merge-base)\n\n\`\`\`diff\n${cap(git(cwd, 'diff', `${base}...HEAD`), TOTAL_CAP / 2)}\`\`\`\n`);
  }
  sections.push(`## Staged changes\n\n\`\`\`diff\n${cap(git(cwd, 'diff', '--cached'), TOTAL_CAP / 4)}\`\`\`\n`);
  sections.push(`## Unstaged changes\n\n\`\`\`diff\n${cap(git(cwd, 'diff'), TOTAL_CAP / 4)}\`\`\`\n`);
  const untracked = git(cwd, 'ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean);
  for (const rel of untracked) {
    let body;
    try {
      const st = lstatSync(join(cwd, rel));
      if (!st.isFile()) {
        body = '(not a regular file, contents omitted)';
      } else {
        const fd = openSync(join(cwd, rel), 'r');
        try {
          const head = Buffer.alloc(8192);
          const headLen = readSync(fd, head, 0, 8192, 0);
          if (head.subarray(0, headLen).includes(0)) {
            body = '(binary file, contents omitted)';
          } else {
            const buf = Buffer.alloc(PER_FILE_CAP + 1);
            const len = readSync(fd, buf, 0, PER_FILE_CAP + 1, 0);
            body = `\`\`\`\n${cap(buf.subarray(0, len).toString('utf8'), PER_FILE_CAP)}\`\`\``;
          }
        } finally {
          closeSync(fd);
        }
      }
    } catch {
      body = '(unreadable)';
    }
    sections.push(`## Untracked: ${rel}\n\n${body}\n`);
  }
  return cap(sections.join('\n'), TOTAL_CAP);
}

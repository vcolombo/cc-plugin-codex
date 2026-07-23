import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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

function isProbablyText(buf) {
  return !buf.subarray(0, 8192).includes(0);
}

export function buildReviewEvidence({ cwd, base = null }) {
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
      const buf = readFileSync(join(cwd, rel));
      body = isProbablyText(buf)
        ? `\`\`\`\n${cap(buf.toString('utf8'), PER_FILE_CAP)}\`\`\``
        : '(binary file, contents omitted)';
    } catch {
      body = '(unreadable)';
    }
    sections.push(`## Untracked: ${rel}\n\n${body}\n`);
  }
  return cap(sections.join('\n'), TOTAL_CAP);
}

#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  closeSync, existsSync, lstatSync, openSync, readFileSync, readdirSync, readSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  codexHome, handoffsDir, readJson, resolveDataDir, sessionsDir,
} from './lib/state.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const MSG_CAP = 4000;
const MAX_RECENT = 20;
const TOTAL_CAP = 150_000;
const MAX_FILES = 100;
const CWD_SCAN_CAP = 262_144;

const REDACT_PATTERNS = [
  /AKIA[0-9A-Z]{16}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
  /\b(?:sk|pk|api|token|key|secret|bearer)[-_][A-Za-z0-9_-]{20,}\b/gi,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g,
  /\bnpm_[A-Za-z0-9]{30,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bglpat-[0-9A-Za-z_-]{20,}\b/g,
  /\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)\s*[=:]\s*\S+/gi,
  // Bearer must run before the Authorization line pattern below, otherwise
  // the latter consumes just the "Bearer" word and strands the token.
  /\bBearer\s+[A-Za-z0-9._~+/-]{10,}=*/g,
  /\bAuthorization\s*:\s*\S+/gi,
  /\b(?=[A-Za-z0-9+/_=-]*[A-Z])(?=[A-Za-z0-9+/_=-]*[a-z])(?=[A-Za-z0-9+/_=-]*\d)[A-Za-z0-9+/=_-]{40,}\b/g,
];

export function redact(text) {
  return REDACT_PATTERNS.reduce((t, re) => t.replace(re, '[REDACTED]'), text);
}

function flattenText(node) {
  const c = node?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((i) => (typeof i === 'string' ? i : i?.text ?? '')).join('');
  if (typeof node?.text === 'string') return node.text;
  return '';
}

const PATH_KEYS = new Set(['path', 'file_path', 'filePath']);
const PATCH_PATH_RE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
// Real Codex rollouts serialize apply_patch/custom_tool_call tool input as a
// string (e.g. the "arguments" field), with paths embedded as patch markers
// rather than as structured path fields.
function extractPatchPaths(str) {
  const paths = [];
  for (const m of str.matchAll(PATCH_PATH_RE)) paths.push(m[1].trim());
  return paths;
}

function findPaths(node, out, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return;
  for (const [k, v] of Object.entries(node)) {
    if (PATH_KEYS.has(k) && typeof v === 'string') out.add(v);
    else if (typeof v === 'string') { for (const p of extractPatchPaths(v)) out.add(p); }
    else if (v && typeof v === 'object') findPaths(v, out, depth + 1);
  }
}

export function extractEvidence(jsonlText) {
  const msgs = [];
  const files = new Set();
  for (const line of jsonlText.split('\n')) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const node = e.payload ?? e;
    findPaths(node, files);
    const role = node.role;
    const text = flattenText(node);
    if (!text || (role !== 'user' && role !== 'assistant')) continue;
    msgs.push({ role, text: redact(text).slice(0, MSG_CAP) });
  }
  const evidence = {
    goals: msgs.filter((m) => m.role === 'user').slice(0, 3),
    recent: msgs.slice(-MAX_RECENT),
    filesTouched: [...files].slice(0, MAX_FILES),
  };
  while (JSON.stringify(evidence).length > TOTAL_CAP && evidence.recent.length > 1) {
    evidence.recent.shift();
  }
  return evidence;
}

function walkJsonl(root, out = []) {
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(root, e.name);
    if (e.isDirectory()) walkJsonl(p, out);
    else if (e.name.endsWith('.jsonl')) {
      try {
        const st = lstatSync(p);
        if (st.isFile()) out.push({ path: p, mtime: st.mtimeMs });
      } catch { /* skip unreadable entries (e.g. broken symlinks) */ }
    }
  }
  return out;
}

// Reads at most CWD_SCAN_CAP bytes of a file's head; Codex session metadata
// (cwd) appears near the top, so a full read isn't needed to check for it.
function headContains(path, needle) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(CWD_SCAN_CAP);
    const bytesRead = readSync(fd, buf, 0, CWD_SCAN_CAP, 0);
    return buf.toString('utf8', 0, bytesRead).includes(needle);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
  }
}

function resolveTranscript(env = process.env) {
  const dataDir = resolveDataDir({ env, scriptPath: SCRIPT_PATH });
  const sessionId = env.CODEX_THREAD_ID ?? null;
  if (sessionId) {
    const rec = readJson(join(sessionsDir(dataDir), `${sessionId}.json`));
    if (rec?.transcriptPath && existsSync(rec.transcriptPath)) {
      return { transcriptPath: rec.transcriptPath, sessionId };
    }
  }
  const cwd = process.cwd();
  const matches = walkJsonl(join(codexHome(env), 'sessions'))
    .sort((a, b) => b.mtime - a.mtime)
    .filter((c) => headContains(c.path, cwd));
  if (matches.length === 1) return { transcriptPath: matches[0].path, sessionId };
  return { candidates: matches.slice(0, 20).map((m) => m.path), sessionId };
}

function cmdExtract() {
  const res = resolveTranscript();
  if (!res.transcriptPath) {
    process.stderr.write('Could not resolve the current Codex transcript.\n');
    if (res.candidates?.length) {
      process.stderr.write(`Candidates (ask the user which one):\n${res.candidates.join('\n')}\n`);
    }
    process.exit(2);
  }
  const evidence = extractEvidence(readFileSync(res.transcriptPath, 'utf8'));
  process.stdout.write(JSON.stringify({
    sessionId: res.sessionId, transcriptPath: res.transcriptPath, ...evidence,
  }, null, 2) + '\n');
}

async function cmdWriteHandoff() {
  let narrative = '';
  for await (const chunk of process.stdin) narrative += chunk;
  narrative = redact(narrative.trim());
  if (!narrative) { process.stderr.write('write-handoff requires the narrative on stdin\n'); process.exit(2); }
  if (!narrative.startsWith('# Handoff from Codex')) {
    narrative = `# Handoff from Codex\n\n${narrative}`;
  }
  const dir = handoffsDir(resolveDataDir({ scriptPath: SCRIPT_PATH }));
  const path = join(dir, `handoff-${Date.now()}-${randomBytes(4).toString('hex')}.md`);
  writeFileSync(path, `${narrative}\n`, { flag: 'wx', mode: 0o600 });
  process.stdout.write(`Handoff written: ${path}\n`);
  process.stdout.write(`To start Claude Code with it, run:\n  node "${SCRIPT_PATH}" launch "${path}"\n`);
}

function cmdLaunch(path) {
  let content;
  try {
    content = readFileSync(path, 'utf8');
  } catch (err) {
    process.stderr.write(`Cannot read handoff file ${path}: ${err.message}\n`);
    process.exit(1);
  }
  // Content as a single argv element: no shell, no interpolation. Force the
  // "# Handoff from Codex" header so content can't start with a dash and be
  // parsed as a claude CLI flag (path is arbitrary, not necessarily our own
  // write-handoff output).
  if (!content.startsWith('# Handoff from Codex')) {
    content = `# Handoff from Codex\n\n${content}`;
  }
  const res = spawnSync(process.env.CLAUDE_BIN || 'claude', [content], { stdio: 'inherit' });
  if (res.error) {
    process.stderr.write(`Failed to launch Claude Code (${res.error.message}). Run $claude:setup.\n`);
    process.exit(127);
  }
  process.exit(res.status ?? 1);
}

const [cmd, arg] = process.argv.slice(2);
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (cmd === 'extract') cmdExtract();
  else if (cmd === 'write-handoff') await cmdWriteHandoff();
  else if (cmd === 'launch' && arg) cmdLaunch(arg);
  else { process.stderr.write('Usage: transfer.mjs extract | write-handoff | launch <path>\n'); process.exit(2); }
}

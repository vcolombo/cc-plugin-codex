#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  closeSync, createReadStream, existsSync, lstatSync, openSync, readFileSync, readdirSync,
  readSync, writeFileSync,
} from 'node:fs';
import { createInterface } from 'node:readline';
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
const PATH_CAP = 1024;
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
  /\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)[ \t]*[=:][ \t]*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+)/gi,
  // Authorization line must run before the bare-Bearer pattern below, so a
  // "Bearer ..." token inside a header line is consumed by the whole-line
  // rule instead of leaking whatever the narrower Bearer rule leaves behind.
  // Separators are horizontal-only ([ \t]) so a match can't cross a newline
  // and redact an unrelated following line.
  /\bAuthorization[ \t]*:[ \t]*.+/gi,
  /\bBearer[ \t]+[A-Za-z0-9._~+/=-]+/gi,
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
const PATCH_MOVE_RE = /^\*\*\* Move to: (.+)$/gm;
// Real Codex rollouts serialize apply_patch/custom_tool_call tool input as a
// string (e.g. the "arguments" field), with paths embedded as patch markers
// rather than as structured path fields. Renames emit "*** Update File: old"
// followed by "*** Move to: new" — the affected path is the destination, so
// both source and destination are captured.
function extractPatchPaths(str) {
  const paths = [];
  for (const m of str.matchAll(PATCH_PATH_RE)) paths.push(m[1].trim());
  for (const m of str.matchAll(PATCH_MOVE_RE)) paths.push(m[1].trim());
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

// Bounded accumulator: holds only the first 3 user messages (goals), a ring
// buffer of the last MAX_RECENT messages, and up to MAX_FILES paths — never
// the whole transcript — so a huge rollout can be streamed line-by-line
// without loading it into memory.
export function makeEvidenceAccumulator() {
  const goals = [];
  const recent = [];
  const files = new Set();

  function pushLine(line) {
    let e;
    try { e = JSON.parse(line); } catch { return; }
    const node = e.payload ?? e;
    if (files.size < MAX_FILES) findPaths(node, files);
    const role = node.role;
    const text = flattenText(node);
    if (!text || (role !== 'user' && role !== 'assistant')) return;
    const msg = { role, text: redact(text).slice(0, MSG_CAP) };
    if (role === 'user' && goals.length < 3) goals.push(msg);
    recent.push(msg);
    if (recent.length > MAX_RECENT) recent.shift();
  }

  function finalize() {
    const capPath = (p) => (p.length > PATH_CAP ? `${p.slice(0, PATH_CAP)}…` : p);
    const evidence = { goals, recent, filesTouched: [...files].slice(0, MAX_FILES).map(capPath) };
    const over = () => JSON.stringify(evidence).length > TOTAL_CAP;
    // Trim every component, not just recent, so an adversarial transcript full of
    // huge paths or long goals can't defeat the cap. Order: drop recent, then
    // files, then extra goals; a single surviving goal is already MSG_CAP-bounded.
    while (over() && evidence.recent.length > 1) evidence.recent.shift();
    while (over() && evidence.filesTouched.length) evidence.filesTouched.pop();
    while (over() && evidence.goals.length > 1) evidence.goals.pop();
    return evidence;
  }

  return { pushLine, finalize };
}

export function extractEvidence(jsonlText) {
  const acc = makeEvidenceAccumulator();
  for (const line of jsonlText.split('\n')) acc.pushLine(line);
  return acc.finalize();
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
// (cwd) appears near the top, so a full read isn't needed to inspect it.
function readHead(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(CWD_SCAN_CAP);
    const bytesRead = readSync(fd, buf, 0, CWD_SCAN_CAP, 0);
    return buf.toString('utf8', 0, bytesRead);
  } catch {
    return '';
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
  }
}

function hasCwdEqual(node, cwd, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return false;
  if (node.cwd === cwd) return true;
  for (const v of Object.values(node)) {
    if (v && typeof v === 'object' && hasCwdEqual(v, cwd, depth + 1)) return true;
  }
  return false;
}

// Match the transcript's own `cwd` metadata field EXACTLY — never a substring
// of the file — so a workspace like /repo/app can't select an unrelated
// session whose cwd is /repo/app-copy and leak its content into the handoff.
function headHasCwd(path, cwd) {
  for (const line of readHead(path).split('\n').slice(0, 50)) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; } // truncated/last partial line is skipped
    if (hasCwdEqual(obj, cwd)) return true;
  }
  return false;
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
    .filter((c) => headHasCwd(c.path, cwd));
  if (matches.length === 1) return { transcriptPath: matches[0].path, sessionId };
  return { candidates: matches.slice(0, 20).map((m) => m.path), sessionId };
}

async function streamEvidence(transcriptPath) {
  const acc = makeEvidenceAccumulator();
  const rl = createInterface({
    input: createReadStream(transcriptPath, { encoding: 'utf8' }), crlfDelay: Infinity,
  });
  for await (const line of rl) acc.pushLine(line);
  return acc.finalize();
}

// `extract` with no arg auto-resolves the current transcript; on ambiguity it
// prints candidate paths and exits 2. `extract <path>` extracts that specific
// transcript — the actionable follow-up after the user picks a candidate.
async function cmdExtract(explicitPath) {
  let transcriptPath;
  let sessionId;
  if (explicitPath) {
    if (!existsSync(explicitPath)) {
      process.stderr.write(`No such transcript: ${explicitPath}\n`);
      process.exit(2);
    }
    transcriptPath = explicitPath;
    sessionId = process.env.CODEX_THREAD_ID ?? null;
  } else {
    const res = resolveTranscript();
    if (!res.transcriptPath) {
      process.stderr.write('Could not resolve the current Codex transcript.\n');
      if (res.candidates?.length) {
        process.stderr.write(`Candidates (ask the user which one, then re-run: extract <path>):\n${res.candidates.join('\n')}\n`);
      }
      process.exit(2);
    }
    transcriptPath = res.transcriptPath;
    sessionId = res.sessionId;
  }
  let evidence;
  try {
    evidence = await streamEvidence(transcriptPath);
  } catch (err) {
    process.stderr.write(`Cannot read transcript ${transcriptPath}: ${err.message}\n`);
    process.exit(2);
  }
  process.stdout.write(JSON.stringify({ sessionId, transcriptPath, ...evidence }, null, 2) + '\n');
}

async function cmdWriteHandoff() {
  let narrative = '';
  process.stdin.setEncoding('utf8'); // preserve multibyte chars split across chunks
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
    if (res.error.code === 'E2BIG') {
      process.stderr.write(`Handoff too large to pass on the command line (${content.length} chars). Shorten the handoff narrative and retry.\n`);
      process.exit(1);
    }
    process.stderr.write(`Failed to launch Claude Code (${res.error.message}). Run $claude:setup.\n`);
    process.exit(127);
  }
  process.exit(res.status ?? 1);
}

const [cmd, arg] = process.argv.slice(2);
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (cmd === 'extract') await cmdExtract(arg);
  else if (cmd === 'write-handoff') await cmdWriteHandoff();
  else if (cmd === 'launch' && arg) cmdLaunch(arg);
  else { process.stderr.write('Usage: transfer.mjs extract [<path>] | write-handoff | launch <path>\n'); process.exit(2); }
}

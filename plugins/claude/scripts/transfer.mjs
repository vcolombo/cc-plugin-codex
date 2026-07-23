#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
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

const REDACT_PATTERNS = [
  /AKIA[0-9A-Z]{16}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
  /\b(?:sk|pk|api|token|key|secret|bearer)[-_][A-Za-z0-9_-]{20,}\b/gi,
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
function findPaths(node, out, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return;
  for (const [k, v] of Object.entries(node)) {
    if (PATH_KEYS.has(k) && typeof v === 'string') out.add(v);
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
    else if (e.name.endsWith('.jsonl')) out.push({ path: p, mtime: statSync(p).mtimeMs });
  }
  return out;
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
    .slice(0, 20)
    .filter((c) => {
      try { return readFileSync(c.path, 'utf8').includes(cwd); } catch { return false; }
    });
  if (matches.length === 1) return { transcriptPath: matches[0].path, sessionId };
  return { candidates: matches.map((m) => m.path), sessionId };
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
  narrative = narrative.trim();
  if (!narrative) { process.stderr.write('write-handoff requires the narrative on stdin\n'); process.exit(2); }
  if (!narrative.startsWith('# Handoff from Codex')) {
    narrative = `# Handoff from Codex\n\n${narrative}`;
  }
  const dir = handoffsDir(resolveDataDir({ scriptPath: SCRIPT_PATH }));
  const path = join(dir, `handoff-${Date.now()}.md`);
  writeFileSync(path, `${narrative}\n`, { mode: 0o600 });
  process.stdout.write(`Handoff written: ${path}\n`);
  process.stdout.write(`To start Claude Code with it, run:\n  node "${SCRIPT_PATH}" launch "${path}"\n`);
}

function cmdLaunch(path) {
  const content = readFileSync(path, 'utf8');
  // Content as a single argv element: no shell, no interpolation. The fixed
  // "# Handoff from Codex" header guarantees it cannot start with a dash.
  const res = spawnSync(process.env.CLAUDE_BIN || 'claude', [content], { stdio: 'inherit' });
  process.exit(res.status ?? 1);
}

const [cmd, arg] = process.argv.slice(2);
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (cmd === 'extract') cmdExtract();
  else if (cmd === 'write-handoff') await cmdWriteHandoff();
  else if (cmd === 'launch' && arg) cmdLaunch(arg);
  else { process.stderr.write('Usage: transfer.mjs extract | write-handoff | launch <path>\n'); process.exit(2); }
}

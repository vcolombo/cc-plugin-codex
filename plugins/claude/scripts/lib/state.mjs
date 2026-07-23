import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const FALLBACK_SLUG = 'claude-cc-plugin-codex';

export function codexHome(env = process.env) {
  return env.CODEX_HOME || join(homedir(), '.codex');
}

// Codex injects PLUGIN_DATA only into hook processes. Skill-launched scripts
// derive the identical dir: cache layout is
// <codexHome>/plugins/cache/<marketplace>/<plugin>/<version>/..., and the data
// dir is <codexHome>/plugins/data/<plugin>-<marketplace>.
export function resolveDataDir({ env = process.env, scriptPath = '' } = {}) {
  if (env.PLUGIN_DATA) return env.PLUGIN_DATA;
  const m = scriptPath.match(/[/\\]plugins[/\\]cache[/\\]([^/\\]+)[/\\]([^/\\]+)[/\\]/);
  const slug = m ? `${m[2]}-${m[1]}` : FALLBACK_SLUG;
  return join(codexHome(env), 'plugins', 'data', slug);
}

export function ensureDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

export function workspaceKey(cwd) {
  // Normalize paths to handle symlinks (e.g., /var -> /private/var on macOS)
  let normalized = cwd;
  try { normalized = realpathSync(cwd); } catch { /* keep original if realpath fails */ }
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

export function jobsDir(dataDir, cwd) {
  return ensureDir(join(dataDir, 'jobs', workspaceKey(cwd)));
}

export function sessionsDir(dataDir) {
  return ensureDir(join(dataDir, 'sessions'));
}

export function handoffsDir(dataDir) {
  return ensureDir(join(dataDir, 'handoffs'));
}

export function gateFlagPath(dataDir) {
  return join(dataDir, 'review-gate-enabled');
}

// Atomic + symlink-safe: 'wx' refuses to follow an existing symlink for the
// temp file; rename() replaces the destination entry without following it.
export function writeJsonAtomic(path, obj) {
  ensureDir(dirname(path));
  // Unpredictable temp name: 'wx' is symlink-safe, and randomness means a stale
  // temp left by a crash (or a reused pid) can never collide and block writes.
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { jobsDir, resolveDataDir, writeJsonAtomic } from './lib/state.mjs';

export function launchBackground({ mode, claudeArgs, prompt, scriptPath, scriptDir }) {
  const dataDir = resolveDataDir({ scriptPath });
  const dir = jobsDir(dataDir, process.cwd());
  const id = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  const promptPath = join(dir, `${id}.prompt`);
  writeFileSync(promptPath, prompt, { mode: 0o600 });
  const spec = {
    id,
    claudeArgs,
    promptPath,
    cwd: process.cwd(),
    logPath: join(dir, `${id}.log`),
    recordPath: join(dir, `${id}.json`),
  };
  const specPath = join(dir, `${id}.spec.json`);
  writeJsonAtomic(specPath, spec);
  writeJsonAtomic(spec.recordPath, { id, mode, startedAt: new Date().toISOString(), status: 'starting' });
  const sup = spawn(process.execPath, [join(scriptDir, 'supervisor.mjs'), specPath], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  sup.unref();
  process.stdout.write(`Started background Claude job ${id} (mode: ${mode}).\nUse $claude:status to check it and $claude:result to fetch the outcome.\n`);
}

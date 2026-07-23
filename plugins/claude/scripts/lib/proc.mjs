import { execFileSync } from 'node:child_process';

export function psStart(pid) {
  try {
    return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

// Liveness = pid still signalable AND same process start time as recorded
// (a recycled pid has a different start time).
export function isAlive(record) {
  if (!record?.pid) return false;
  try {
    process.kill(record.pid, 0);
  } catch {
    return false;
  }
  const s = psStart(record.pid);
  return s !== '' && s === record.psStart;
}

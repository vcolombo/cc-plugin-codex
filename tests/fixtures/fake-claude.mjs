#!/usr/bin/env node
// Stand-in for the `claude` binary. See run-claude.test.mjs for the contract.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);

if (argv.includes('--version')) {
  console.log('fake-claude 1.0.0');
  process.exit(0);
}
if (argv[0] === 'auth') {
  console.log(JSON.stringify({ loggedIn: true, method: 'fake' }));
  process.exit(0);
}

let stdin = '';
process.stdin.on('data', (d) => { stdin += d; });
process.stdin.on('end', async () => {
  if (process.env.FAKE_CLAUDE_CAPTURE) {
    writeFileSync(process.env.FAKE_CLAUDE_CAPTURE, JSON.stringify({ argv, stdin }));
  }
  if (process.env.FAKE_CLAUDE_PLAIN) {
    console.log(process.env.FAKE_CLAUDE_PLAIN);
    process.exit(Number(process.env.FAKE_CLAUDE_EXIT || 0));
  }
  if (process.env.FAKE_CLAUDE_SPAWN_GRANDCHILD) {
    // Not detached: it stays in this process's group, like a real Bash-tool
    // subprocess, so a process-group cancel should reach it too.
    const gc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    gc.unref();
    console.log(JSON.stringify({ type: 'grandchild', pid: gc.pid }));
  }
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-fake-123' }));
  const sleep = Number(process.env.FAKE_CLAUDE_SLEEP_MS || 0);
  if (sleep) await new Promise((r) => setTimeout(r, sleep));
  console.log(JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, result: 'FAKE RESULT', session_id: 'sess-fake-123',
  }));
  process.exit(Number(process.env.FAKE_CLAUDE_EXIT || 0));
});

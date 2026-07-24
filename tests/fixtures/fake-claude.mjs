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
  if (process.env.FAKE_CLAUDE_LOGGED_OUT) {
    console.log(JSON.stringify({ loggedIn: false, authMethod: 'none' }));
    process.exit(1); // real claude exits non-zero when logged out but still prints JSON
  }
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
    const gcCode = process.env.FAKE_CLAUDE_GRANDCHILD_IGNORE_SIGTERM
      ? "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"
      : 'setInterval(() => {}, 1000)';
    const gc = spawn(process.execPath, ['-e', gcCode], { stdio: 'ignore' });
    gc.unref();
    console.log(JSON.stringify({ type: 'grandchild', pid: gc.pid }));
  }
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-fake-123' }));
  const sleep = Number(process.env.FAKE_CLAUDE_SLEEP_MS || 0);
  if (sleep) await new Promise((r) => setTimeout(r, sleep));

  if (process.env.FAKE_CLAUDE_SPLIT_RESULT) {
    const full = JSON.stringify({
      type: 'result', subtype: 'success', is_error: false, result: 'FAKE RESULT', session_id: 'sess-fake-123',
    });
    const mid = Math.floor(full.length / 2);
    process.stdout.write(full.slice(0, mid));
    await new Promise((r) => setTimeout(r, 20));
    process.stderr.write('warning: noisy stderr line\n');
    await new Promise((r) => setTimeout(r, 20));
    process.stdout.write(`${full.slice(mid)}\n`);
    process.exit(Number(process.env.FAKE_CLAUDE_EXIT || 0));
  }

  if (process.env.FAKE_CLAUDE_SPLIT_UTF8) {
    // Raw Buffer writes (bypassing console.log's own string handling) so the
    // multibyte char 'é' (UTF-8 bytes 0xC3 0xA9) lands split across two
    // separate stdout chunks.
    const full = Buffer.from(`${JSON.stringify({
      type: 'result', subtype: 'success', is_error: false, result: 'café', session_id: 'sess-fake-123',
    })}\n`, 'utf8');
    const splitAt = full.indexOf(Buffer.from('é', 'utf8')) + 1; // mid-character
    process.stdout.write(full.subarray(0, splitAt));
    await new Promise((r) => setTimeout(r, 20));
    process.stdout.write(full.subarray(splitAt));
    process.exit(Number(process.env.FAKE_CLAUDE_EXIT || 0));
  }

  console.log(JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, result: 'FAKE RESULT', session_id: 'sess-fake-123',
  }));
  process.exit(Number(process.env.FAKE_CLAUDE_EXIT || 0));
});

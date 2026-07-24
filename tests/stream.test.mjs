import test from 'node:test';
import assert from 'node:assert/strict';
import { extractFromStream } from '../plugins/claude/scripts/lib/stream.mjs';
import { psStart, isAlive } from '../plugins/claude/scripts/lib/proc.mjs';

test('extractFromStream pulls session id and final result', () => {
  const text = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's-1' }),
    'not json at all',
    JSON.stringify({ type: 'assistant', message: {} }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'DONE', session_id: 's-1' }),
  ].join('\n');
  assert.deepEqual(extractFromStream(text), { sessionId: 's-1', result: 'DONE', isError: false });
});

test('extractFromStream handles empty input', () => {
  assert.deepEqual(extractFromStream(''), { sessionId: null, result: null, isError: false });
});

test('extractFromStream reports errors', () => {
  const text = JSON.stringify({ type: 'result', is_error: true, result: 'boom', session_id: 's-2' });
  const out = extractFromStream(text);
  assert.equal(out.isError, true);
  assert.equal(out.result, 'boom');
});

test('psStart returns non-empty for own pid, empty for absurd pid', () => {
  assert.notEqual(psStart(process.pid), '');
  assert.equal(psStart(99999999), '');
});

test('isAlive rejects dead pid and psStart mismatch', () => {
  assert.equal(isAlive({ pid: 99999999, psStart: 'x' }), false);
  assert.equal(isAlive({ pid: process.pid, psStart: 'bogus' }), false);
  assert.equal(isAlive({ pid: process.pid, psStart: psStart(process.pid) }), true);
  assert.equal(isAlive(null), false);
});

test('extractFromStream tolerates non-object JSON lines', () => {
  const text = ['null', 'true', '42', '[1,2]', JSON.stringify({ type: 'result', result: 'ok', session_id: 's-3' })].join('\n');
  assert.deepEqual(extractFromStream(text), { sessionId: 's-3', result: 'ok', isError: false });
});

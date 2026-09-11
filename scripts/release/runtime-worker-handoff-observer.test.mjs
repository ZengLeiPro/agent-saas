import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { collectWorkerHandoff } from '../../server/scripts/runtime-worker-handoff-observer.mjs';

const envelope = (type) => ({ data: { type } });
const receive = (ws, type) => ws.emit('message', Buffer.from(JSON.stringify(envelope(type))));
function clean(ws) {
  for (const name of ['message', 'close', 'error']) assert.equal(ws.listenerCount(name), 0, name);
}
test('honors a tool_input already received with the session and triggers once', async () => {
  const ws = new EventEmitter();
  let calls = 0;
  const result = collectWorkerHandoff(ws, {
    first: [envelope('tool_input')],
    triggerHandoff: () => {
      calls += 1;
    },
  });
  receive(ws, 'tool_input');
  receive(ws, 'tool_result');
  receive(ws, 'done');
  const events = await result;
  assert.equal(calls, 1);
  assert.equal(events.filter((e) => e.data.type === 'done').length, 1);
  clean(ws);
});
test('terminal response cannot hide a failed candidate or signal acknowledgement', async () => {
  const ws = new EventEmitter();
  const result = collectWorkerHandoff(ws, {
    triggerHandoff: async () => {
      throw new Error('candidate failed');
    },
  });
  const failed = assert.rejects(result, /candidate failed/);
  receive(ws, 'tool_input');
  receive(ws, 'done');
  await failed;
  clean(ws);
});
for (const event of ['close', 'error', 'malformed', 'runtime-error', 'early-done', 'timeout']) {
  test(`rejects ${event} and removes all observation listeners`, async () => {
    const ws = new EventEmitter();
    const result = collectWorkerHandoff(ws, { triggerHandoff: async () => {}, timeoutMs: 10 });
    const failed = assert.rejects(result);
    if (event === 'close') ws.emit('close');
    if (event === 'error') ws.emit('error', new Error('socket failure'));
    if (event === 'malformed') ws.emit('message', Buffer.from('{'));
    if (event === 'runtime-error') receive(ws, 'error');
    if (event === 'early-done') receive(ws, 'done');
    await failed;
    clean(ws);
  });
}

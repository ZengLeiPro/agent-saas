import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { collectStreamingReplay, createFakeOpenAI } from '../../server/scripts/runtime-multiprocess-stream-fixture.mjs';

class Socket extends EventEmitter {
  sent = [];
  send(raw) { this.sent.push(JSON.parse(raw)); this.onSend?.(); }
  receive(data) { this.emit('message', Buffer.from(JSON.stringify({ data }))); }
}
const active = { type: 'active_stream', active: true, runId: 'run-1' };
const text = (content) => ({ type: 'text', content });
const done = { type: 'done' };
const observe = (ws, options = {}) => collectStreamingReplay(ws, {
  sessionId: 'session-1', runId: 'run-1', acknowledgeFirstText: () => {}, timeoutMs: 1_000, ...options,
});
function assertClean(ws) {
  for (const event of ['message', 'close', 'error']) assert.equal(ws.listenerCount(event), 0, event);
}
async function finalResponse(provider) {
  const port = await provider.listen(0);
  return await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST', body: JSON.stringify({ messages: [{ role: 'tool', content: 'MP_E2E_1' }] }),
  });
}
async function readPrefix(reader) {
  let result = '';
  while (!result.includes('MULTIPROCESS_')) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false, 'stream ended before prefix');
    result += Buffer.from(chunk.value).toString();
  }
  return result;
}

test('observer is installed before resume and keeps synchronous replay/live bursts', async () => {
  const ws = new Socket();
  let acknowledgements = 0;
  ws.onSend = () => {
    ws.receive(active);
    ws.receive({ type: 'tool_result', content: 'MP_E2E_1' });
    ws.receive(text('MULTIPROCESS_'));
  };
  const events = await observe(ws, { acknowledgeFirstText: () => {
    acknowledgements += 1;
    ws.receive(text('DONE'));
    ws.receive(done);
  } });
  assert.equal(acknowledgements, 1);
  assert.deepEqual(ws.sent, [{ action: 'resume', sessionId: 'session-1', lastEventId: 0, lastEventCursor: '', skipReplay: false }]);
  assert.deepEqual(events.map(({ data }) => data.type), ['active_stream', 'tool_result', 'text', 'text', 'done']);
  assertClean(ws);
});

test('allows transport chunk boundaries and prefix replay before active marker', async () => {
  const ws = new Socket();
  let acknowledgements = 0;
  const result = observe(ws, { acknowledgeFirstText: () => { acknowledgements += 1; } });
  ws.receive(text('MULTI'));
  ws.receive(text('PROCESS_'));
  assert.equal(acknowledgements, 0);
  ws.receive(active);
  ws.receive(active);
  assert.equal(acknowledgements, 1);
  ws.receive(text('D'));
  ws.receive(text('ONE'));
  ws.receive(done);
  await result;
  assertClean(ws);
});

for (const [label, messages, expected] of [
  ['terminal-only aggregate', [active, text('MULTIPROCESS_DONE'), done], /aggregate before first-text/],
  ['premature terminal', [active, done], /assistant text before model completion/],
  ['missing tail', [active, text('MULTIPROCESS_'), done], /complete assistant text/],
  ['duplicate text', [active, text('MULTIPROCESS_'), text('MULTIPROCESS_')], /duplicate replay text/],
  ['out-of-order text', [active, text('DONE')], /unexpected or duplicate/],
  ['wrong run binding', [{ ...active, runId: 'other' }, done], /bind the active durable run/],
  ['error event', [{ type: 'error', error: 'failed fixture' }], /failed fixture/],
  ['terminal error', [{ type: 'done', error: 'terminal failure' }], /terminal failure/],
]) {
  test(`observer rejects ${label} and removes listeners`, async () => {
    const ws = new Socket();
    const result = observe(ws);
    const rejection = assert.rejects(result, expected);
    for (const message of messages) ws.receive(message);
    await rejection;
    assertClean(ws);
  });
}

test('timeout reports the missing stream stage and cleans up', async () => {
  const ws = new Socket();
  const result = observe(ws, { timeoutMs: 10 });
  ws.receive(active);
  await assert.rejects(result, /active=true acknowledged=false/);
  assertClean(ws);
});

for (const event of ['close', 'error', 'malformed', 'send']) {
  test(`observer rejects ${event} failure without leaving listeners`, async () => {
    const ws = new Socket();
    if (event === 'send') ws.send = () => { throw new Error('send failed'); };
    const rejection = assert.rejects(observe(ws));
    if (event === 'close') ws.emit('close');
    if (event === 'error') ws.emit('error', new Error('transport failed'));
    if (event === 'malformed') ws.emit('message', Buffer.from('{'));
    await rejection;
    assertClean(ws);
  });
}

test('fake provider cannot send the suffix or complete until the observer ACKs', { timeout: 5_000 }, async (t) => {
  const provider = createFakeOpenAI({ gateFinalText: true });
  t.after(() => provider.close());
  const response = await finalResponse(provider);
  const reader = response.body.getReader();
  const prefix = await readPrefix(reader);
  assert.equal(prefix.includes('"content":"DONE"'), false);
  let tailSettled = false;
  const tail = (async () => {
    let output = '';
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return output;
      output += Buffer.from(chunk.value).toString();
    }
  })();
  void tail.then(() => { tailSettled = true; }, () => { tailSettled = true; });
  // Deliberately exceed the old 150ms fixture delay; only an ACK may unlock it.
  await sleep(250);
  assert.equal(tailSettled, false);
  const ws = new Socket();
  const result = observe(ws, { acknowledgeFirstText: () => provider.acknowledgeFirstText() });
  ws.receive(active);
  ws.receive(text('MULTIPROCESS_'));
  const suffix = await tail;
  assert.match(suffix, /"content":"DONE"/);
  assert.match(suffix, /data: \[DONE\]/);
  ws.receive(text('DONE'));
  ws.receive(done);
  await result;
  assert.equal(provider.requestCount(), 1);
});

test('other scenarios retain an ungated fake provider', { timeout: 5_000 }, async (t) => {
  const provider = createFakeOpenAI();
  t.after(() => provider.close());
  const response = await finalResponse(provider);
  const body = await response.text();
  assert.match(body, /MULTIPROCESS_/);
  assert.match(body, /"content":"DONE"/);
  assert.match(body, /data: \[DONE\]/);
});

test('missing ACK aborts the fake stream rather than generating a terminal fallback', { timeout: 5_000 }, async (t) => {
  const provider = createFakeOpenAI({ gateFinalText: true, firstTextTimeoutMs: 500 });
  t.after(() => provider.close());
  const response = await finalResponse(provider);
  const reader = response.body.getReader();
  await readPrefix(reader);
  await assert.rejects(reader.read());
});

test('teardown closes a provider still waiting for the observer', { timeout: 5_000 }, async () => {
  const provider = createFakeOpenAI({ gateFinalText: true });
  try {
    const response = await finalResponse(provider);
    const reader = response.body.getReader();
    await readPrefix(reader);
    const rejection = assert.rejects(reader.read());
    await provider.close();
    await rejection;
  } finally {
    await provider.close();
  }
});

test('multiprocess E2E uses the gated provider and continuous observer', async () => {
  const source = await readFile(new URL('../../server/scripts/verify-runtime-multiprocess-e2e.mts', import.meta.url), 'utf8');
  assert.match(source, /createFakeOpenAI\(\{ gateFinalText: scenario === 'e2e' \}\)/);
  assert.match(source, /await collectStreamingReplay\(replayWs/);
  assert.match(source, /acknowledgeFirstText: \(\) => fakeModel!\.acknowledgeFirstText\(\)/);
  assert.doesNotMatch(source, /const replayActive = await collectUntil/);
});

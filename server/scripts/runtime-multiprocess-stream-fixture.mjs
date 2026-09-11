import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

const FIRST_TEXT = 'MULTIPROCESS_';
const FINAL_TEXT = `${FIRST_TEXT}DONE`;

/** Fake provider used only by the multiprocess smoke tests. */
export function createFakeOpenAI({ gateFinalText = false, firstTextTimeoutMs = 10_000, toolCommand, toolTimeoutMs = 15_000 } = {}) {
  let count = 0;
  let closed = false;
  let gateFailed = false;
  let acknowledgeFirstText;
  const firstTextReceived = new Promise((resolve) => { acknowledgeFirstText = resolve; });

  const handleRequest = async (req, res) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404).end('not found');
      return;
    }
    count += 1;
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    const hasToolOutput = body.messages?.some((message) => message.role === 'tool') ?? false;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    if (!hasToolOutput) {
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call-${randomUUID()}`, type: 'function', function: { name: 'Shell', arguments: JSON.stringify({ command: toolCommand ?? 'for i in 1 2 3; do echo MP_E2E_$i; sleep 1; done', timeoutMs: toolTimeoutMs }) } }] } }] });
      send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
      res.end('data: [DONE]\n\n');
      return;
    }
    if (gateFailed) throw new Error('multiprocess first-text acknowledgement already timed out');
    if (!gateFinalText) await sleep(150);
    send({ choices: [{ delta: { content: FIRST_TEXT } }] });
    if (gateFinalText) {
      // A provider-side sleep does not prove that a worker/PG/WS flush happened.
      // Do not produce the suffix or terminal aggregate until the WS observer ACKs.
      let timer;
      try {
        await Promise.race([
          firstTextReceived,
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              gateFailed = true;
              reject(new Error('multiprocess first text was not acknowledged before model completion'));
            }, firstTextTimeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    } else {
      await sleep(150);
    }
    if (closed || res.destroyed) return;
    send({ choices: [{ delta: { content: 'DONE' } }] });
    send({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } });
    res.end('data: [DONE]\n\n');
  };
  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((error) => res.destroy(error));
  });
  return {
    listen: (port) => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve(server.address().port);
      });
    }),
    acknowledgeFirstText: () => acknowledgeFirstText(),
    close: () => {
      closed = true;
      acknowledgeFirstText();
      // Failed assertions must not leave an HTTP handler waiting for an ACK.
      return new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
    },
    requestCount: () => count,
  };
}

/** Observe the whole resume exchange with one listener, installed before send(). */
export function collectStreamingReplay(ws, { sessionId, runId, acknowledgeFirstText, timeoutMs = 30_000 }) {
  const events = [];
  let active = false;
  let acknowledged = false;
  let text = '';
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('close', onClose);
      ws.off('error', onError);
    };
    const fail = (error) => { cleanup(); reject(error); };
    const onClose = () => fail(new Error('websocket closed before streaming replay completed'));
    const onError = (error) => fail(error);
    const onMessage = (raw) => {
      try {
        const envelope = JSON.parse(raw.toString());
        events.push(envelope);
        const data = envelope.data ?? {};
        if (data.type === 'error' || (data.type === 'done' && data.error)) {
          throw new Error(`streaming replay failed: ${String(data.error ?? data.message ?? 'runtime error')}`);
        }
        if (data.type === 'active_stream' && data.active === true && data.runId === runId) active = true;
        if (data.type === 'text') {
          text += String(data.content ?? '');
          assert.ok(FINAL_TEXT.startsWith(text), `unexpected or duplicate replay text: ${JSON.stringify(text)}`);
          assert.ok(acknowledged || FIRST_TEXT.startsWith(text), 'received final aggregate before first-text acknowledgement');
        }
        // Replay may deliver the prefix before active_stream; require both facts.
        if (!acknowledged && active && text === FIRST_TEXT) {
          acknowledged = true;
          acknowledgeFirstText();
        }
        if (data.type === 'done') {
          assert.ok(active, 'expected reconnect replay to bind the active durable run');
          assert.ok(acknowledged, 'expected assistant text before model completion, not only a terminal aggregate');
          assert.equal(text, FINAL_TEXT, 'expected complete assistant text without loss or duplication');
          cleanup();
          resolve(events);
        }
      } catch (error) { fail(error); }
    };
    const timer = setTimeout(() => fail(new Error(
      `streaming replay timed out; active=${active} acknowledged=${acknowledged} text=${JSON.stringify(text)} events=${JSON.stringify(events.slice(-20).map((event) => event.data?.type))}`,
    )), timeoutMs);
    ws.on('message', onMessage);
    ws.once('close', onClose);
    ws.once('error', onError);
    try {
      ws.send(JSON.stringify({ action: 'resume', sessionId, lastEventId: 0, lastEventCursor: '', skipReplay: false }));
    } catch (error) { fail(error); }
  });
}

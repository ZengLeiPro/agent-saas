import WebSocket from 'ws';

const url = process.argv[2];
const timeoutMs = Number(process.argv[3] ?? 4000);

if (!url || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  console.error('usage: node zero-downtime-ws-probe.mjs <wss-url> [timeout-ms]');
  process.exit(1);
}

let settled = false;
let ws;

const finish = (code, status, detail = '') => {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  if (ws && ws.readyState !== WebSocket.CLOSED) {
    try {
      ws.terminate();
    } catch {
      // The process exits below; termination is only best-effort cleanup.
    }
  }
  const output = detail ? `${status} ${detail}` : status;
  process.stdout.write(`${output}\n`, () => process.exit(code));
};

const timer = setTimeout(() => finish(1, 'failed', 'timeout'), timeoutMs);

try {
  ws = new WebSocket(url, { handshakeTimeout: timeoutMs });
} catch (err) {
  finish(1, 'failed', err instanceof Error ? err.message : String(err));
}

ws?.once('unexpected-response', (_request, response) => {
  response.resume();
  if (response.statusCode === 401) {
    finish(2, 'legacy-auth');
    return;
  }
  finish(1, 'failed', `http-${response.statusCode ?? 'unknown'}`);
});

ws?.once('message', (data) => {
  try {
    const payload = JSON.parse(data.toString());
    if (payload?.data?.type === 'pong' && payload?.data?.probe === true) {
      finish(0, 'ok');
      return;
    }
    finish(1, 'failed', 'unexpected-payload');
  } catch {
    finish(1, 'failed', 'invalid-json');
  }
});

ws?.once('error', (err) => finish(1, 'failed', err.message));
ws?.once('close', () => finish(1, 'failed', 'closed-before-pong'));

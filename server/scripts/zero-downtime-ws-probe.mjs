import WebSocket from 'ws';

const url = process.argv[2];
const timeoutMs = Number(process.argv[3] ?? 4000);

if (!url || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  console.error('usage: node zero-downtime-ws-probe.mjs <wss-url> [timeout-ms]');
  process.exit(1);
}

const probeOnce = () => new Promise((resolve) => {
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
        // The attempt has settled; termination is only best-effort cleanup.
      }
    }
    resolve({ code, status, detail });
  };

  // code=3 仅在脚本内部表示 DNS/TCP/TLS/timeout 等传输层失败，允许即时重试一次。
  // HTTP 状态、payload 等应用层失败仍用 code=1，禁止重试。
  const timer = setTimeout(() => finish(3, 'transport-failed', 'timeout'), timeoutMs);

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

  ws?.once('error', (err) => finish(3, 'transport-failed', err.message));
  ws?.once('close', () => finish(1, 'failed', 'closed-before-pong'));
});

let result;
for (let attempt = 1; attempt <= 2; attempt += 1) {
  result = await probeOnce();
  if (result.code !== 3) break;
}

const output = result.detail ? `${result.status} ${result.detail}` : result.status;
process.stdout.write(`${output}\n`, () => process.exit(result.code === 3 ? 1 : result.code));

import http from 'http';
import { mkdtemp, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { ClientDaemonRunner } from '../runtime/clientDaemonRunner.js';
import { parseClientDaemonMessage, serializeClientDaemonMessage, type ClientDaemonMessage } from '../runtime/clientDaemonProtocol.js';

async function withFakePlatform<T>(fn: (args: { url: string; sent: ClientDaemonMessage[]; ws: () => WebSocket | undefined }) => Promise<T>): Promise<T> {
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  const sent: ClientDaemonMessage[] = [];
  let active: WebSocket | undefined;
  server.on('upgrade', (req, socket, head) => {
    if (!req.url?.startsWith('/daemon')) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  wss.on('connection', (ws) => {
    active = ws;
    ws.on('message', (raw) => {
      const msg = parseClientDaemonMessage(raw.toString());
      sent.push(msg);
      if (msg.type === 'daemon_hello') {
        ws.send(serializeClientDaemonMessage({ type: 'daemon_registered', protocolVersion: 1, daemonId: msg.daemonId, handId: msg.handId ?? `client-${msg.daemonId}` }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing port');
  try {
    return await fn({ url: `ws://127.0.0.1:${address.port}/daemon`, sent, ws: () => active });
  } finally {
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function waitForMessage(sent: ClientDaemonMessage[], predicate: (message: ClientDaemonMessage) => boolean): Promise<ClientDaemonMessage> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const found = sent.find(predicate);
      if (found) {
        clearInterval(timer);
        resolve(found);
      } else if (Date.now() - started > 5_000) {
        clearInterval(timer);
        reject(new Error('timed out waiting for daemon message'));
      }
    }, 10);
  });
}

describe('ClientDaemonRunner', () => {
  it('registers, executes workspace tools, and returns streamed shell output', async () => {
    await withFakePlatform(async ({ url, sent, ws }) => {
      const root = await mkdtemp(join(tmpdir(), 'client-daemon-runner-'));
      const runner = new ClientDaemonRunner({
        url,
        daemonId: 'daemon-test',
        handId: 'hand-test',
        workspaceRoot: root,
        heartbeatIntervalMs: 50,
        reconnectDelayMs: 50,
      });
      const run = runner.runForever();
      await waitForMessage(sent, (msg) => msg.type === 'daemon_hello');
      ws()?.send(serializeClientDaemonMessage({
        type: 'invoke_request',
        protocolVersion: 1,
        requestId: 'write-1',
        invocationId: 'inv-write',
        request: {
          toolName: 'Write',
          input: { path: 'out.txt', content: 'hello daemon' },
          context: { workspace: { id: 'remote-w', root: '/ignored', executionTarget: 'client' } },
        },
      }));
      const writeDone = await waitForMessage(sent, (msg) => msg.type === 'invoke_completed' && msg.requestId === 'write-1');
      expect(writeDone).toMatchObject({ type: 'invoke_completed', response: { status: 'success' } });
      await expect(readFile(join(root, 'out.txt'), 'utf8')).resolves.toBe('hello daemon');

      ws()?.send(serializeClientDaemonMessage({
        type: 'invoke_request',
        protocolVersion: 1,
        requestId: 'shell-1',
        invocationId: 'inv-shell',
        request: {
          toolName: 'Shell',
          input: { command: 'printf streamed' },
          context: { workspace: { id: 'remote-w', root: '/ignored', executionTarget: 'client' } },
        },
      }));
      await waitForMessage(sent, (msg) => msg.type === 'invoke_chunk' && msg.requestId === 'shell-1' && msg.chunk.type === 'output');
      const shellDone = await waitForMessage(sent, (msg) => msg.type === 'invoke_completed' && msg.requestId === 'shell-1');
      expect(shellDone).toMatchObject({ type: 'invoke_completed', response: { status: 'success' } });
      await runner.stop();
      await run;
    });
  });

  it('acknowledges cancel requests and aborts an active shell invocation', async () => {
    await withFakePlatform(async ({ url, sent, ws }) => {
      const root = await mkdtemp(join(tmpdir(), 'client-daemon-cancel-'));
      const runner = new ClientDaemonRunner({ url, daemonId: 'daemon-cancel', handId: 'hand-cancel', workspaceRoot: root, reconnectDelayMs: 50 });
      const run = runner.runForever();
      await waitForMessage(sent, (msg) => msg.type === 'daemon_hello');
      ws()?.send(serializeClientDaemonMessage({
        type: 'invoke_request',
        protocolVersion: 1,
        requestId: 'shell-cancel',
        invocationId: 'inv-cancel',
        request: {
          toolName: 'Shell',
          input: { command: 'sleep 10', timeoutMs: 30_000 },
          context: { workspace: { id: 'remote-w', root: '/ignored', executionTarget: 'client' } },
        },
      }));
      await new Promise((resolve) => setTimeout(resolve, 100));
      ws()?.send(serializeClientDaemonMessage({ type: 'cancel_request', protocolVersion: 1, requestId: 'cancel-1', invocationId: 'inv-cancel', reason: 'test_cancel' }));
      const ack = await waitForMessage(sent, (msg) => msg.type === 'cancel_ack' && msg.requestId === 'cancel-1');
      expect(ack).toMatchObject({ type: 'cancel_ack', accepted: true });
      const done = await waitForMessage(sent, (msg) => msg.type === 'invoke_completed' && msg.requestId === 'shell-cancel');
      expect(done).toMatchObject({ type: 'invoke_completed', response: { status: 'error' } });
      await runner.stop();
      await run;
    });
  });
});

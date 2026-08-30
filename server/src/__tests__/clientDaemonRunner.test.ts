import http from 'http';
import { mkdtemp, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { ClientDaemonRunner } from '../runtime/clientDaemonRunner.js';
import { getInvocationCorrelation } from '../runtime/invocationCorrelation.js';
import { parseClientDaemonMessage, serializeClientDaemonMessage, type ClientDaemonMessage } from '../runtime/clientDaemonProtocol.js';
import type { ToolInvocationRequest, ToolInvocationResponse } from '../runtime/handProtocol.js';

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

function waitForCondition(predicate: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > 5_000) {
        clearInterval(timer);
        reject(new Error('timed out waiting for condition'));
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

  it('stops consuming a provider stream after the terminal completed chunk', async () => {
    await withFakePlatform(async ({ url, sent, ws }) => {
      let pulledAfterCompleted = false;
      let finalized = 0;
      const provider = {
        execute: vi.fn(async () => ({ status: 'error' as const, error: 'stream only' })),
        executeStream: vi.fn(async function* () {
          try {
            yield { type: 'completed' as const, response: { status: 'success' as const, content: 'done' } };
            pulledAfterCompleted = true;
            yield { type: 'output' as const, channel: 'stdout' as const, content: 'late' };
          } finally {
            finalized += 1;
            throw new Error('provider cleanup failed after terminal');
          }
        }),
        listInternalTools: () => [],
      };
      const runner = new ClientDaemonRunner({
        url,
        daemonId: 'daemon-terminal-stream',
        workspaceRoot: await mkdtemp(join(tmpdir(), 'client-daemon-terminal-stream-')),
        reconnectDelayMs: 50,
        provider,
      });
      const run = runner.runForever();
      await waitForMessage(sent, (msg) => msg.type === 'daemon_hello');
      const invoke = (requestId: string) => ws()?.send(serializeClientDaemonMessage({
        type: 'invoke_request', protocolVersion: 1, requestId, invocationId: 'logical-terminal',
        request: {
          toolName: 'Write', input: {},
          context: {
            correlation: { version: 1, invocationId: 'logical-terminal' },
            workspace: { id: 'remote-w', root: '/ignored', executionTarget: 'client' },
          },
        },
      }));

      invoke('terminal-first');
      expect(await waitForMessage(sent, (msg) => msg.type === 'invoke_completed' && msg.requestId === 'terminal-first'))
        .toMatchObject({ response: { status: 'success', content: 'done' } });
      await waitForCondition(() => finalized === 1);
      expect(pulledAfterCompleted).toBe(false);
      expect(sent.some((msg) => msg.type === 'invoke_chunk' && msg.requestId === 'terminal-first')).toBe(false);
      expect(sent.filter((msg) => msg.type === 'invoke_completed' && msg.requestId === 'terminal-first')).toHaveLength(1);

      invoke('terminal-second');
      expect(await waitForMessage(sent, (msg) => msg.type === 'invoke_completed' && msg.requestId === 'terminal-second'))
        .toMatchObject({ response: { status: 'success', content: 'done' } });
      await waitForCondition(() => finalized === 2);
      expect(provider.executeStream).toHaveBeenCalledTimes(2);
      expect(sent.filter((msg) => msg.type === 'invoke_completed' && msg.requestId === 'terminal-second')).toHaveLength(1);

      await runner.stop();
      await run;
    });
  });

  it('normalizes legacy-only and envelope-only invocation identity for provider and ALS', async () => {
    await withFakePlatform(async ({ url, sent, ws }) => {
      const observed: Array<{ correlation: unknown; ambient: unknown }> = [];
      const provider = {
        execute: vi.fn(async (request: ToolInvocationRequest) => {
          observed.push({
            correlation: request.context.correlation,
            ambient: getInvocationCorrelation(),
          });
          return { status: 'success' as const, content: 'ok' };
        }),
        listInternalTools: () => [],
      };
      const runner = new ClientDaemonRunner({
        url,
        daemonId: 'daemon-normalize-correlation',
        workspaceRoot: await mkdtemp(join(tmpdir(), 'client-daemon-normalize-correlation-')),
        reconnectDelayMs: 50,
        provider,
      });
      const run = runner.runForever();
      await waitForMessage(sent, (msg) => msg.type === 'daemon_hello');

      const sendInvoke = (requestId: string, invocationId: string, includeLegacy: boolean) =>
        ws()?.send(serializeClientDaemonMessage({
          type: 'invoke_request', protocolVersion: 1, requestId, invocationId,
          request: {
            toolName: 'Write', input: {},
            context: {
              ...(includeLegacy ? { invocationId } : {}),
              workspace: { id: 'remote-w', root: '/ignored', executionTarget: 'client' },
            },
          },
        }));

      sendInvoke('legacy-only', 'legacy-i1', true);
      await waitForMessage(sent, (msg) => msg.type === 'invoke_completed' && msg.requestId === 'legacy-only');
      sendInvoke('envelope-only', 'envelope-i2', false);
      await waitForMessage(sent, (msg) => msg.type === 'invoke_completed' && msg.requestId === 'envelope-only');

      expect(observed).toEqual([
        {
          correlation: { version: 1, invocationId: 'legacy-i1' },
          ambient: { version: 1, invocationId: 'legacy-i1' },
        },
        {
          correlation: { version: 1, invocationId: 'envelope-i2' },
          ambient: { version: 1, invocationId: 'envelope-i2' },
        },
      ]);

      await runner.stop();
      await run;
    });
  });

  it('does not echo malformed protocol content into daemon logs', async () => {
    await withFakePlatform(async ({ url, sent, ws }) => {
      const warnings: string[] = [];
      let warningReceived: (() => void) | undefined;
      const waitForWarning = () => new Promise<void>((resolve) => { warningReceived = resolve; });
      const runner = new ClientDaemonRunner({
        url,
        daemonId: 'daemon-safe-log',
        workspaceRoot: await mkdtemp(join(tmpdir(), 'client-daemon-safe-log-')),
        reconnectDelayMs: 50,
        logger: { warn: (message) => { warnings.push(message); warningReceived?.(); warningReceived = undefined; } },
      });
      const run = runner.runForever();
      await waitForMessage(sent, (msg) => msg.type === 'daemon_hello');

      const secret = 'secret-token\n[FORGED]';
      const rejectedMessage = waitForWarning();
      ws()?.send(JSON.stringify({
        type: 'invoke_request', protocolVersion: 1, requestId: 'malformed-1', invocationId: 'logical-1',
        request: {
          toolName: 'Read', input: {},
          context: { correlation: { version: 1, [secret]: 'value' }, workspace: {} },
        },
      }));
      await rejectedMessage;
      const daemonErrorReceived = waitForWarning();
      ws()?.send(serializeClientDaemonMessage({
        type: 'daemon_error', protocolVersion: 1, message: secret,
      }));
      await daemonErrorReceived;
      expect(warnings).toEqual(['client daemon message rejected', 'platform daemon_error received']);
      expect(JSON.stringify(warnings)).not.toContain(secret);

      await runner.stop();
      await run;
    });
  });

  it('rejects a concurrent duplicate logical invocation without losing cancel ownership', async () => {
    await withFakePlatform(async ({ url, sent, ws }) => {
      const executions: Array<{
        signal: AbortSignal;
        resolve: (response: ToolInvocationResponse) => void;
      }> = [];
      let started: (() => void) | undefined;
      const provider = {
        execute: vi.fn(async (request: ToolInvocationRequest) =>
          new Promise<ToolInvocationResponse>((resolve) => {
            const signal = request.context.signal!;
            executions.push({ signal, resolve });
            signal.addEventListener('abort', () => resolve({ status: 'error', error: 'cancelled' }), { once: true });
            started?.();
          })),
        listInternalTools: () => [],
      };
      const runner = new ClientDaemonRunner({
        url,
        daemonId: 'daemon-single-flight',
        handId: 'hand-single-flight',
        workspaceRoot: await mkdtemp(join(tmpdir(), 'client-daemon-single-flight-')),
        reconnectDelayMs: 50,
        provider,
      });
      const run = runner.runForever();
      await waitForMessage(sent, (msg) => msg.type === 'daemon_hello');

      const sendInvoke = (requestId: string, attemptId: string) => ws()?.send(serializeClientDaemonMessage({
        type: 'invoke_request', protocolVersion: 1, requestId, invocationId: 'logical-1',
        request: {
          toolName: 'Write', input: {},
          context: {
            correlation: { version: 1, invocationId: 'logical-1', attemptId },
            workspace: { id: 'remote-w', root: '/ignored', executionTarget: 'client' },
          },
        },
      }));

      const firstStarted = new Promise<void>((resolve) => { started = resolve; });
      sendInvoke('invoke-first', 'attempt-1');
      await firstStarted;
      sendInvoke('invoke-duplicate', 'attempt-2');
      const duplicate = await waitForMessage(sent, (msg) => msg.type === 'invoke_completed' && msg.requestId === 'invoke-duplicate');
      expect(duplicate).toMatchObject({ response: { status: 'error', error: 'client daemon invocation already running' } });
      expect(provider.execute).toHaveBeenCalledTimes(1);

      ws()?.send(serializeClientDaemonMessage({
        type: 'cancel_request', protocolVersion: 1, requestId: 'cancel-first', invocationId: 'logical-1', reason: 'test_cancel',
      }));
      expect(await waitForMessage(sent, (msg) => msg.type === 'cancel_ack' && msg.requestId === 'cancel-first'))
        .toMatchObject({ accepted: true });
      await waitForMessage(sent, (msg) => msg.type === 'invoke_completed' && msg.requestId === 'invoke-first');
      expect(executions[0]?.signal.aborted).toBe(true);

      const nextStarted = new Promise<void>((resolve) => { started = resolve; });
      sendInvoke('invoke-next', 'attempt-3');
      await nextStarted;
      expect(provider.execute).toHaveBeenCalledTimes(2);
      executions[1]?.resolve({ status: 'success', content: 'next-ok' });
      expect(await waitForMessage(sent, (msg) => msg.type === 'invoke_completed' && msg.requestId === 'invoke-next'))
        .toMatchObject({ response: { status: 'success', content: 'next-ok' } });

      await runner.stop();
      await run;
    });
  });

  it('does not accept a late invocation after stop has started', async () => {
    await withFakePlatform(async ({ url, sent, ws }) => {
      let resolveExecution: ((response: ToolInvocationResponse) => void) | undefined;
      let executionSignal: AbortSignal | undefined;
      const provider = {
        execute: vi.fn(async (request: ToolInvocationRequest) => new Promise<ToolInvocationResponse>((resolve) => {
          executionSignal = request.context.signal;
          resolveExecution = resolve;
        })),
        listInternalTools: () => [],
      };
      const runner = new ClientDaemonRunner({
        url,
        daemonId: 'daemon-stop-single-flight',
        workspaceRoot: await mkdtemp(join(tmpdir(), 'client-daemon-stop-single-flight-')),
        reconnectDelayMs: 20,
        provider,
      });
      const run = runner.runForever();
      await waitForMessage(sent, (msg) => msg.type === 'daemon_hello');
      const request: Extract<ClientDaemonMessage, { type: 'invoke_request' }> = {
        type: 'invoke_request', protocolVersion: 1, requestId: 'invoke-before-stop', invocationId: 'logical-stop',
        request: {
          toolName: 'Write', input: {},
          context: {
            correlation: { version: 1, invocationId: 'logical-stop', attemptId: 'attempt-1' },
            workspace: { id: 'remote-w', root: '/ignored', executionTarget: 'client' },
          },
        },
      };
      ws()?.send(serializeClientDaemonMessage(request));
      await waitForCondition(() => provider.execute.mock.calls.length === 1);

      let stopped = false;
      const stopping = runner.stop().then(() => { stopped = true; });
      const internal = runner as unknown as {
        ws?: WebSocket;
        handleInvoke(socket: WebSocket, message: Extract<ClientDaemonMessage, { type: 'invoke_request' }>): Promise<void>;
      };
      await internal.handleInvoke(internal.ws!, {
        ...request,
        requestId: 'invoke-after-stop',
        request: {
          ...request.request,
          context: {
            ...request.request.context,
            correlation: { version: 1, invocationId: 'logical-stop', attemptId: 'attempt-2' },
          },
        },
      });
      expect(provider.execute).toHaveBeenCalledTimes(1);
      expect(executionSignal?.aborted).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(stopped).toBe(false);

      resolveExecution?.({ status: 'success', content: 'finished-after-stop' });
      await stopping;
      expect(stopped).toBe(true);
      await run;
    });
  });

  it('ignores a stale socket close after a new connection is active', async () => {
    await withFakePlatform(async ({ url, sent, ws }) => {
      const executions: Array<{
        signal: AbortSignal;
        resolve: (response: ToolInvocationResponse) => void;
      }> = [];
      const provider = {
        execute: vi.fn(async (request: ToolInvocationRequest) => new Promise<ToolInvocationResponse>((resolve) => {
          executions.push({ signal: request.context.signal!, resolve });
        })),
        listInternalTools: () => [],
      };
      const runner = new ClientDaemonRunner({
        url,
        daemonId: 'daemon-stale-close',
        workspaceRoot: await mkdtemp(join(tmpdir(), 'client-daemon-stale-close-')),
        reconnectDelayMs: 20,
        heartbeatIntervalMs: 20,
        provider,
      });
      const run = runner.runForever();
      await waitForMessage(sent, (msg) => msg.type === 'daemon_hello');
      const internal = runner as unknown as { ws?: WebSocket };
      const staleSocket = internal.ws!;
      const request = (requestId: string, invocationId: string, attemptId: string) => serializeClientDaemonMessage({
        type: 'invoke_request', protocolVersion: 1, requestId, invocationId,
        request: {
          toolName: 'Write', input: {},
          context: {
            correlation: { version: 1, invocationId, attemptId },
            workspace: { id: 'remote-w', root: '/ignored', executionTarget: 'client' },
          },
        },
      });

      ws()?.send(request('invoke-stale-old', 'logical-stale-old', 'attempt-old'));
      await waitForCondition(() => provider.execute.mock.calls.length === 1);
      staleSocket.emit('error', new Error('synthetic old socket error'));
      await waitForCondition(() => sent.filter((msg) => msg.type === 'daemon_hello').length >= 2);
      expect(executions[0]?.signal.aborted).toBe(true);

      ws()?.send(request('invoke-stale-new', 'logical-stale-new', 'attempt-new'));
      await waitForCondition(() => provider.execute.mock.calls.length === 2);
      const heartbeatsBefore = sent.filter((msg) => msg.type === 'daemon_heartbeat').length;
      staleSocket.emit('close', 1006, Buffer.alloc(0));
      await waitForCondition(() => sent.filter((msg) => msg.type === 'daemon_heartbeat').length > heartbeatsBefore);
      expect(executions[1]?.signal.aborted).toBe(false);

      staleSocket.terminate();
      executions[0]?.resolve({ status: 'error', error: 'old-aborted' });
      executions[1]?.resolve({ status: 'success', content: 'new-finished' });
      expect(await waitForMessage(sent, (msg) => msg.type === 'invoke_completed' && msg.requestId === 'invoke-stale-new'))
        .toMatchObject({ response: { status: 'success', content: 'new-finished' } });
      await runner.stop();
      await run;
    });
  });

  it('keeps single-flight ownership while an aborted provider survives a websocket reconnect', async () => {
    await withFakePlatform(async ({ url, sent, ws }) => {
      const executions: Array<{
        signal: AbortSignal;
        resolve: (response: ToolInvocationResponse) => void;
      }> = [];
      const provider = {
        execute: vi.fn(async (request: ToolInvocationRequest) => new Promise<ToolInvocationResponse>((resolve) => {
          executions.push({ signal: request.context.signal!, resolve });
        })),
        listInternalTools: () => [],
      };
      const runner = new ClientDaemonRunner({
        url,
        daemonId: 'daemon-reconnect-single-flight',
        workspaceRoot: await mkdtemp(join(tmpdir(), 'client-daemon-reconnect-single-flight-')),
        reconnectDelayMs: 20,
        provider,
      });
      const run = runner.runForever();
      await waitForMessage(sent, (msg) => msg.type === 'daemon_hello');
      const request = (requestId: string, attemptId: string) => serializeClientDaemonMessage({
        type: 'invoke_request', protocolVersion: 1, requestId, invocationId: 'logical-reconnect',
        request: {
          toolName: 'Write', input: {},
          context: {
            correlation: { version: 1, invocationId: 'logical-reconnect', attemptId },
            workspace: { id: 'remote-w', root: '/ignored', executionTarget: 'client' },
          },
        },
      });

      ws()?.send(request('invoke-before-disconnect', 'attempt-1'));
      await waitForCondition(() => provider.execute.mock.calls.length === 1);
      ws()?.terminate();
      await waitForCondition(() => sent.filter((msg) => msg.type === 'daemon_hello').length >= 2);
      expect(executions[0]?.signal.aborted).toBe(true);

      ws()?.send(request('invoke-after-reconnect-duplicate', 'attempt-2'));
      expect(await waitForMessage(sent, (msg) => msg.type === 'invoke_completed' && msg.requestId === 'invoke-after-reconnect-duplicate'))
        .toMatchObject({ response: { status: 'error', error: 'client daemon invocation already running' } });
      expect(provider.execute).toHaveBeenCalledTimes(1);

      executions[0]?.resolve({ status: 'success', content: 'old-finished' });
      expect(await waitForMessage(sent, (msg) => msg.type === 'invoke_completed' && msg.requestId === 'invoke-before-disconnect'))
        .toMatchObject({ response: { status: 'success', content: 'old-finished' } });
      ws()?.send(request('invoke-after-original-finished', 'attempt-3'));
      await waitForCondition(() => provider.execute.mock.calls.length === 2);
      executions[1]?.resolve({ status: 'success', content: 'new-finished' });
      expect(await waitForMessage(sent, (msg) => msg.type === 'invoke_completed' && msg.requestId === 'invoke-after-original-finished'))
        .toMatchObject({ response: { status: 'success', content: 'new-finished' } });

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

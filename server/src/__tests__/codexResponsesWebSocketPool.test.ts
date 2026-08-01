import { describe, expect, it, vi } from 'vitest';

import type {
  EgressWebSocket,
  EgressWebSocketConnector,
} from '../runtime/egressDispatcher.js';
import {
  CodexResponsesWebSocketPool,
  CodexWebSocketUnavailableError,
} from '../runtime/responses/codexResponsesWebSocketPool.js';

class FakeWebSocket extends EventTarget {
  readyState = 1;
  binaryType: 'blob' | 'arraybuffer' = 'arraybuffer';
  readonly sent: string[] = [];

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('socket closed');
    this.sent.push(data);
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(eventWith('close', { code, reason, wasClean: true }));
  }

  emit(payload: unknown): void {
    this.dispatchEvent(eventWith('message', { data: JSON.stringify(payload) }));
  }

  fail(error: Error): void {
    this.dispatchEvent(eventWith('error', { error, message: error.message }));
  }
}

function eventWith(type: string, values: Record<string, unknown>): Event {
  const event = new Event(type);
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(event, key, { configurable: true, value });
  }
  return event;
}

function connectorFor(...sockets: FakeWebSocket[]): EgressWebSocketConnector & ReturnType<typeof vi.fn> {
  const mock = vi.fn();
  for (const socket of sockets) {
    mock.mockResolvedValueOnce(socket as unknown as EgressWebSocket);
  }
  return mock as EgressWebSocketConnector & ReturnType<typeof vi.fn>;
}

function body(input: unknown[], overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    model: 'gpt-5.6-sol',
    instructions: '你是企业 Agent。',
    input,
    tools: [{ type: 'function', name: 'Shell', parameters: { type: 'object' } }],
    tool_choice: 'auto',
    parallel_tool_calls: true,
    store: false,
    stream: true,
    prompt_cache_key: 'session-1',
    ...overrides,
  });
}

function request(serializedBody: string, signal?: AbortSignal) {
  return {
    endpoint: 'https://chatgpt.com/backend-api/codex/responses',
    accessToken: 'access-token',
    accountId: 'acct-1',
    accountBindingHash: 'binding-1',
    originator: 'codex-tui',
    serializedBody,
    tenantId: 'kaiyan',
    sessionId: 'session-1',
    clientRequestId: 'request-1',
    ...(signal ? { signal } : {}),
  };
}

async function waitForSend(socket: FakeWebSocket, count = 1): Promise<void> {
  await vi.waitFor(() => expect(socket.sent).toHaveLength(count));
}

function complete(socket: FakeWebSocket, responseId: string, output: unknown[] | null = []): void {
  socket.emit({
    type: 'response.completed',
    response: {
      id: responseId,
      model: 'gpt-5.6-sol',
      status: 'completed',
      output,
      usage: { input_tokens: 100, output_tokens: 5 },
    },
  });
}

async function establish(
  pool: CodexResponsesWebSocketPool,
  socket: FakeWebSocket,
  input: unknown[],
  responseId = 'resp-1',
  outputItems: unknown[] = [],
): Promise<void> {
  const pending = pool.execute(request(body(input)));
  await waitForSend(socket);
  socket.emit({ type: 'response.created', response: { id: responseId } });
  const result = await pending;
  outputItems.forEach((item, outputIndex) => socket.emit({
    type: 'response.output_item.done',
    output_index: outputIndex,
    item,
  }));
  complete(socket, responseId, outputItems.length > 0 ? null : []);
  await result.response.text();
}

describe('CodexResponsesWebSocketPool', () => {
  it('首轮发全量，严格追加时在同一 socket 只发 suffix + previous_response_id', async () => {
    const socket = new FakeWebSocket();
    const connector = connectorFor(socket);
    const pool = new CodexResponsesWebSocketPool(connector);
    const firstInput = [{ type: 'message', role: 'user', content: '检查工作区' }];
    const functionCall = {
      type: 'function_call',
      call_id: 'call-1',
      name: 'Shell',
      arguments: '{"command":"pwd"}',
    };
    const reasoning = {
      type: 'reasoning',
      encrypted_content: 'opaque-reasoning',
      summary: [{ type: 'summary_text', text: '需要读取目录' }],
    };
    await establish(pool, socket, firstInput, 'resp-1', [
      { id: 'reasoning-server-id', status: 'completed', ...reasoning },
      { id: 'fc-server-id', status: 'completed', ...functionCall },
    ]);
    expect(connector).toHaveBeenCalledWith(expect.objectContaining({
      headers: expect.objectContaining({
        'openai-beta': 'responses_websockets=2026-02-06',
      }),
    }));

    const appended = [
      ...firstInput,
      reasoning,
      functionCall,
      { type: 'function_call_output', call_id: 'call-1', output: '/workspace' },
    ];
    const pending = pool.execute(request(body(appended)));
    await waitForSend(socket, 2);
    const frame = JSON.parse(socket.sent[1] ?? '{}');
    expect(frame).toMatchObject({
      type: 'response.create',
      previous_response_id: 'resp-1',
      input: appended.slice(3),
    });
    expect(frame.input).toHaveLength(1);

    socket.emit({ type: 'response.created', response: { id: 'resp-2' } });
    const result = await pending;
    complete(socket, 'resp-2');
    await result.response.text();
    expect(result.wireMode).toBe('websocket_relay');
    expect(result.wireRequestBodyBytes).toBeLessThan(Buffer.byteLength(body(appended), 'utf8'));
    expect(connector).toHaveBeenCalledTimes(1);
    pool.close();
  });

  it('模型请求属性变化时不猜测接力，直接在现有 socket 发完整历史重新锚定', async () => {
    const socket = new FakeWebSocket();
    const pool = new CodexResponsesWebSocketPool(connectorFor(socket));
    const firstInput = [{ type: 'message', role: 'user', content: 'first' }];
    await establish(pool, socket, firstInput);

    const nextInput = [
      ...firstInput,
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
      { type: 'message', role: 'user', content: 'next' },
    ];
    const pending = pool.execute(request(body(nextInput, { tool_choice: 'none' })));
    await waitForSend(socket, 2);
    const frame = JSON.parse(socket.sent[1] ?? '{}');
    expect(frame.previous_response_id).toBeUndefined();
    expect(frame.input).toEqual(nextInput);

    socket.emit({ type: 'response.created', response: { id: 'resp-2' } });
    const result = await pending;
    complete(socket, 'resp-2');
    await result.response.text();
    expect(result.wireMode).toBe('websocket_full');
    pool.close();
  });

  it('previous_response_not_found 时丢弃旧连接，并在新连接用全量历史重试一次', async () => {
    const firstSocket = new FakeWebSocket();
    const replacement = new FakeWebSocket();
    const connector = connectorFor(firstSocket, replacement);
    const pool = new CodexResponsesWebSocketPool(connector);
    const firstInput = [{ type: 'message', role: 'user', content: 'first' }];
    await establish(pool, firstSocket, firstInput, 'resp-1', [{
      type: 'message',
      id: 'msg-server-id',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'done', annotations: [] }],
    }]);

    const nextInput = [
      ...firstInput,
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
      { type: 'message', role: 'user', content: 'next' },
    ];
    const pending = pool.execute(request(body(nextInput)));
    await waitForSend(firstSocket, 2);
    firstSocket.emit({
      type: 'error',
      status: 400,
      error: {
        code: 'previous_response_not_found',
        message: 'previous response not found',
      },
    });

    await waitForSend(replacement);
    const retryFrame = JSON.parse(replacement.sent[0] ?? '{}');
    expect(retryFrame.previous_response_id).toBeUndefined();
    expect(retryFrame.input).toEqual(nextInput);
    replacement.emit({ type: 'response.created', response: { id: 'resp-2' } });
    const result = await pending;
    complete(replacement, 'resp-2');
    await result.response.text();

    expect(result.wireMode).toBe('websocket_fallback_full');
    expect(firstSocket.readyState).toBe(3);
    expect(connector).toHaveBeenCalledTimes(2);
    pool.close();
  });

  it('连接达到 60 分钟上限时丢弃旧连接，并在新连接用全量历史重试一次', async () => {
    const firstSocket = new FakeWebSocket();
    const replacement = new FakeWebSocket();
    const connector = connectorFor(firstSocket, replacement);
    const pool = new CodexResponsesWebSocketPool(connector);
    const firstInput = [{ type: 'message', role: 'user', content: 'first' }];
    await establish(pool, firstSocket, firstInput, 'resp-1', [{
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'done' }],
    }]);

    const nextInput = [
      ...firstInput,
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
      { type: 'message', role: 'user', content: 'after-limit' },
    ];
    const pending = pool.execute(request(body(nextInput)));
    await waitForSend(firstSocket, 2);
    firstSocket.emit({
      type: 'error',
      status: 409,
      error: {
        code: 'websocket_connection_limit_reached',
        message: 'connection reached maximum lifetime',
      },
    });

    await waitForSend(replacement);
    const retryFrame = JSON.parse(replacement.sent[0] ?? '{}');
    expect(retryFrame.previous_response_id).toBeUndefined();
    expect(retryFrame.input).toEqual(nextInput);
    replacement.emit({ type: 'response.created', response: { id: 'resp-2' } });
    const result = await pending;
    complete(replacement, 'resp-2');
    await result.response.text();

    expect(result.wireMode).toBe('websocket_fallback_full');
    expect(firstSocket.readyState).toBe(3);
    expect(connector).toHaveBeenCalledTimes(2);
    pool.close();
  });

  it('流中断后清除 anchor，下一次请求必须新连接全量发送', async () => {
    const firstSocket = new FakeWebSocket();
    const replacement = new FakeWebSocket();
    const connector = connectorFor(firstSocket, replacement);
    const pool = new CodexResponsesWebSocketPool(connector);
    const firstInput = [{ type: 'message', role: 'user', content: 'first' }];
    await establish(pool, firstSocket, firstInput, 'resp-1', [{
      type: 'message',
      id: 'msg-server-id',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'done', annotations: [] }],
    }]);

    const interruptedInput = [
      ...firstInput,
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
      { type: 'message', role: 'user', content: 'continue' },
    ];
    const interruptedPending = pool.execute(request(body(interruptedInput)));
    await waitForSend(firstSocket, 2);
    firstSocket.emit({ type: 'response.created', response: { id: 'resp-partial' } });
    const interrupted = await interruptedPending;
    firstSocket.emit({ type: 'response.output_text.delta', delta: '部分' });
    firstSocket.close(1006, 'network lost');
    await expect(interrupted.response.text()).rejects.toThrow(/closed before terminal/);

    const nextInput = [...interruptedInput, { type: 'message', role: 'user', content: 'retry' }];
    const pending = pool.execute(request(body(nextInput)));
    await waitForSend(replacement);
    const frame = JSON.parse(replacement.sent[0] ?? '{}');
    expect(frame.previous_response_id).toBeUndefined();
    expect(frame.input).toEqual(nextInput);
    replacement.emit({ type: 'response.created', response: { id: 'resp-recovered' } });
    const recovered = await pending;
    complete(replacement, 'resp-recovered');
    await recovered.response.text();
    expect(recovered.wireMode).toBe('websocket_full');
    pool.close();
  });

  it('同一会话在途请求不复用同一 socket，明确要求上层回退 SSE', async () => {
    const socket = new FakeWebSocket();
    const pool = new CodexResponsesWebSocketPool(connectorFor(socket));
    const first = pool.execute(request(body([{ type: 'message', role: 'user', content: 'first' }])));
    await waitForSend(socket);

    await expect(pool.execute(request(body([
      { type: 'message', role: 'user', content: 'second' },
    ])))).rejects.toMatchObject({
      reason: 'connection_busy',
    } satisfies Partial<CodexWebSocketUnavailableError>);

    socket.emit({ type: 'response.created', response: { id: 'resp-1' } });
    const result = await first;
    complete(socket, 'resp-1');
    await result.response.text();

    const afterConcurrentFallback = pool.execute(request(body([
      { type: 'message', role: 'user', content: 'first' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
      { type: 'message', role: 'user', content: 'after concurrent fallback' },
    ])));
    await waitForSend(socket, 2);
    const frame = JSON.parse(socket.sent[1] ?? '{}');
    expect(frame.previous_response_id).toBeUndefined();
    socket.emit({ type: 'response.created', response: { id: 'resp-2' } });
    const afterResult = await afterConcurrentFallback;
    complete(socket, 'resp-2');
    await afterResult.response.text();
    expect(afterResult.wireMode).toBe('websocket_full');
    pool.close();
  });

  it('首个响应事件前 send 失败时标记为可安全回退 HTTP/SSE', async () => {
    const socket = new FakeWebSocket();
    socket.send = () => { throw new Error('write failed'); };
    const pool = new CodexResponsesWebSocketPool(connectorFor(socket));

    await expect(pool.execute(request(body([
      { type: 'message', role: 'user', content: 'first' },
    ])))).rejects.toMatchObject({ reason: 'send_failed' });
    expect(socket.readyState).toBe(3);
    pool.close();
  });

  it('首次握手偶发失败时原出口重试一次，成功后仍走 WebSocket', async () => {
    const socket = new FakeWebSocket();
    const connector = vi.fn()
      .mockRejectedValueOnce(new Error('WebSocket connection failed before open (empty ErrorEvent)'))
      .mockResolvedValueOnce(socket as unknown as EgressWebSocket) as unknown as
      EgressWebSocketConnector & ReturnType<typeof vi.fn>;
    const pool = new CodexResponsesWebSocketPool(connector);
    const pending = pool.execute(request(body([
      { type: 'message', role: 'user', content: 'first' },
    ])));
    await waitForSend(socket);
    socket.emit({ type: 'response.created', response: { id: 'resp-1' } });
    const result = await pending;
    complete(socket, 'resp-1');
    await result.response.text();

    expect(result.wireMode).toBe('websocket_full');
    expect(connector).toHaveBeenCalledTimes(2);
    pool.close();
  });

  it('status_code=401 的 WebSocket 包装错误进入 OAuth/HTTP 回退，不暴露为模型流', async () => {
    const socket = new FakeWebSocket();
    const pool = new CodexResponsesWebSocketPool(connectorFor(socket));
    const pending = pool.execute(request(body([
      { type: 'message', role: 'user', content: 'first' },
    ])));
    await waitForSend(socket);
    socket.emit({
      type: 'error',
      status_code: 401,
      error: { code: 'invalid_token', message: 'expired' },
    });

    await expect(pending).rejects.toMatchObject({ reason: 'authentication_failed' });
    expect(socket.readyState).toBe(3);
    pool.close();
  });

  it('连续建连失败采用 30 秒、2 分钟、15 分钟退避，期间直接回退 SSE', async () => {
    let now = 1_000;
    const connector = vi.fn().mockRejectedValue(new Error('proxy handshake failed')) as unknown as
      EgressWebSocketConnector & ReturnType<typeof vi.fn>;
    const pool = new CodexResponsesWebSocketPool(connector, {
      now: () => now,
      connectAttempts: 1,
    });
    const input = request(body([{ type: 'message', role: 'user', content: 'first' }]));

    await expect(pool.execute(input)).rejects.toMatchObject({ reason: 'connect_failed' });
    await expect(pool.execute(input)).rejects.toMatchObject({ reason: 'connect_cooldown' });
    expect(connector).toHaveBeenCalledTimes(1);

    now += 30_001;
    await expect(pool.execute(input)).rejects.toMatchObject({ reason: 'connect_failed' });
    now += 30_001;
    await expect(pool.execute(input)).rejects.toMatchObject({ reason: 'connect_cooldown' });
    expect(connector).toHaveBeenCalledTimes(2);

    now += 90_000;
    await expect(pool.execute(input)).rejects.toMatchObject({ reason: 'connect_failed' });
    now += 2 * 60_000;
    await expect(pool.execute(input)).rejects.toMatchObject({ reason: 'connect_cooldown' });
    expect(connector).toHaveBeenCalledTimes(3);
    pool.close();
  });
});

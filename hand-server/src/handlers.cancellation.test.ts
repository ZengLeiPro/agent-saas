import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { handleCancelInvocation, handleExecute, handleGetInvocationResult, type HandlerDeps } from './handlers.js';

function responseCapture() {
  let statusCode = 0;
  let body = '';
  const response = Object.assign(new EventEmitter(), {
    writableEnded: false,
    destroyed: false,
    writeHead: vi.fn((status: number) => { statusCode = status; }),
    end: vi.fn((value?: string) => {
      body = value ?? '';
      response.writableEnded = true;
    }),
  });
  return {
    response: response as any,
    result: () => ({ statusCode, body: body ? JSON.parse(body) : undefined }),
  };
}

function deps(): HandlerDeps {
  return {
    config: { authToken: 'token-1' } as any,
    invocations: new Map(),
    invocationResults: new Map(),
    workspaceResolver: { resolveAndEnsure: vi.fn(async () => '/tmp/workspace') } as any,
    provider: { execute: vi.fn(async () => ({ status: 'success', content: 'executed' })) } as any,
    internalExecutionTarget: 'server-local',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

describe('hand invocation cancellation tombstone', () => {
  it('DELETE 先于 POST 时保留 tombstone，后续请求不得执行外部工具', async () => {
    const handlerDeps = deps();
    const cancelled = responseCapture();
    await handleCancelInvocation({
      method: 'DELETE',
      headers: { authorization: 'Bearer token-1' },
    } as any, cancelled.response, handlerDeps, 'invocation-late');

    expect(cancelled.result()).toEqual({
      statusCode: 200,
      body: { status: 'ok', invocationId: 'invocation-late', cancelled: true },
    });
    expect(handlerDeps.invocations?.get('invocation-late')?.signal.aborted).toBe(true);

    const request = Readable.from([Buffer.from(JSON.stringify({
      toolName: 'Shell',
      input: { command: 'echo should-not-run' },
      context: { invocationId: 'invocation-late', workspace: { id: 'workspace-1' } },
    }))]);
    Object.assign(request, {
      method: 'POST',
      headers: { authorization: 'Bearer token-1' },
      socket: { remoteAddress: '127.0.0.1' },
    });
    const executed = responseCapture();
    await handleExecute(request as any, executed.response, handlerDeps);

    expect(executed.result()).toEqual({
      statusCode: 409,
      body: { status: 'error', error: 'invocation cancelled before start', invocationId: 'invocation-late' },
    });
    expect(handlerDeps.provider.execute).not.toHaveBeenCalled();
  });

  it('保存执行结果并允许客户端在流断开后查询最终结果', async () => {
    const handlerDeps = deps();
    const request = Readable.from([Buffer.from(JSON.stringify({
      toolName: 'Shell',
      input: { command: 'echo ok' },
      context: { invocationId: 'invocation-result', workspace: { id: 'workspace-1' } },
    }))]);
    Object.assign(request, {
      method: 'POST',
      headers: { authorization: 'Bearer token-1' },
      socket: { remoteAddress: '127.0.0.1' },
    });
    const executed = responseCapture();

    await handleExecute(request as any, executed.response, handlerDeps);

    const queried = responseCapture();
    await handleGetInvocationResult({
      method: 'GET',
      headers: { authorization: 'Bearer token-1' },
    } as any, queried.response, handlerDeps, 'invocation-result');

    expect(queried.result()).toEqual({
      statusCode: 200,
      body: {
        status: 'ok',
        invocationId: 'invocation-result',
        completed: true,
        response: { status: 'success', content: 'executed' },
        createdAt: expect.any(Number),
      },
    });
  });

  it('正常读取完请求体不会因 IncomingMessage close 误取消 invocation', async () => {
    const handlerDeps = deps();
    let signal: AbortSignal | undefined;
    vi.mocked(handlerDeps.provider.execute).mockImplementation(async (toolRequest) => {
      signal = toolRequest.context.signal;
      return { status: 'success', content: 'executed' };
    });
    const request = Readable.from([Buffer.from(JSON.stringify({
      toolName: 'Shell',
      input: { command: 'echo ok' },
      context: { invocationId: 'invocation-normal', workspace: { id: 'workspace-1' } },
    }))]);
    Object.assign(request, {
      method: 'POST',
      headers: { authorization: 'Bearer token-1' },
      socket: { remoteAddress: '127.0.0.1' },
    });
    const response = responseCapture();

    await handleExecute(request as any, response.response, handlerDeps);

    expect(response.result()).toEqual({
      statusCode: 200,
      body: { status: 'success', content: 'executed' },
    });
    expect(signal?.aborted).toBe(false);
    expect(handlerDeps.invocations?.has('invocation-normal')).toBe(false);
  });
});

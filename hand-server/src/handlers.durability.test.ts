import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ToolInvocationResponse } from 'server/runtime/handProtocol.js';

import {
  handleCancelInvocation,
  handleExecute,
  handleExecuteStream,
  handleGetInvocationResult,
  type HandlerDeps,
} from './handlers.js';
import { FileHandInvocationStore, type HandInvocationStore } from './invocationStore.js';

/**
 * Durable Tool Invocation（TASK-316）行为测试：
 * 模拟"Hand 重启"= 全新 HandlerDeps（内存 Map 清空）+ 同一磁盘 journal。
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hand-durability-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function responseCapture() {
  let statusCode = 0;
  let body = '';
  const response = Object.assign(new EventEmitter(), {
    writableEnded: false,
    destroyed: false,
    writeHead: vi.fn((status: number) => {
      statusCode = status;
    }),
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

function sseCapture() {
  const chunks: string[] = [];
  const response = Object.assign(new EventEmitter(), {
    writableEnded: false,
    destroyed: false,
    writeHead: vi.fn(),
    write: vi.fn((chunk: string) => {
      chunks.push(chunk);
      return true;
    }),
    end: vi.fn((value?: string) => {
      if (value) chunks.push(value);
      response.writableEnded = true;
    }),
  });
  return {
    response: response as any,
    frames: () =>
      chunks
        .join('')
        .split('\n\n')
        .filter(Boolean)
        .map((frame) => JSON.parse(frame.replace(/^data: /, '')) as Record<string, unknown>),
  };
}

function deps(store?: HandInvocationStore, overrides?: Partial<HandlerDeps>): HandlerDeps {
  return {
    config: { authToken: 'token-1' } as any,
    invocations: new Map(),
    invocationResults: new Map(),
    ...(store ? { invocationStore: store } : {}),
    workspaceResolver: { resolveAndEnsure: vi.fn(async () => '/tmp/workspace') } as any,
    provider: { execute: vi.fn(async () => ({ status: 'success', content: 'executed' })) } as any,
    internalExecutionTarget: 'server-local',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...overrides,
  };
}

function executeRequest(invocationId?: string) {
  const request = Readable.from([
    Buffer.from(
      JSON.stringify({
        toolName: 'Shell',
        input: { command: 'echo ok' },
        context: { ...(invocationId ? { invocationId } : {}), workspace: { id: 'workspace-1' } },
      }),
    ),
  ]);
  Object.assign(request, {
    method: 'POST',
    headers: { authorization: 'Bearer token-1' },
    socket: { remoteAddress: '127.0.0.1' },
  });
  return request as any;
}

function controlRequest(method: 'GET' | 'DELETE') {
  return {
    method,
    headers: { authorization: 'Bearer token-1' },
  } as any;
}

describe('durable tool invocation replay', () => {
  it('重启后重复派发同一 invocationId 重放持久化结果，不二次执行副作用', async () => {
    const store = new FileHandInvocationStore(dir);
    const first = deps(store);
    const executedOnce = responseCapture();
    await handleExecute(executeRequest('inv-replay'), executedOnce.response, first);
    expect(executedOnce.result().body).toEqual({ status: 'success', content: 'executed' });
    expect(first.provider.execute).toHaveBeenCalledTimes(1);

    // 模拟重启：全新内存态 + 同一 journal
    const second = deps(new FileHandInvocationStore(dir));
    const executedTwice = responseCapture();
    await handleExecute(executeRequest('inv-replay'), executedTwice.response, second);

    expect(second.provider.execute).not.toHaveBeenCalled();
    expect(executedTwice.result()).toEqual({
      statusCode: 200,
      body: { status: 'success', content: 'executed', metadata: { durableReplay: true } },
    });
  });

  it('重启后 execute-stream 重复派发以 SSE 重放终态', async () => {
    const store = new FileHandInvocationStore(dir);
    const first = deps(store);
    const executedOnce = responseCapture();
    await handleExecute(executeRequest('inv-stream-replay'), executedOnce.response, first);

    const second = deps(new FileHandInvocationStore(dir));
    const sse = sseCapture();
    await handleExecuteStream(executeRequest('inv-stream-replay'), sse.response, second);

    expect(second.provider.execute).not.toHaveBeenCalled();
    const frames = sse.frames();
    const completed = frames.find((frame) => frame.type === 'completed') as
      { response: ToolInvocationResponse } | undefined;
    expect(completed?.response).toEqual({
      status: 'success',
      content: 'executed',
      metadata: { durableReplay: true },
    });
  });
});

describe('durable cancel tombstone', () => {
  it('重启后 cancel-before-start 语义保留：DELETE 落盘，重复派发被拒绝', async () => {
    const store = new FileHandInvocationStore(dir);
    // 模拟重启后的进程：内存无 invocation，DELETE 仍要落盘 tombstone
    const restarted = deps(new FileHandInvocationStore(dir));
    const cancelled = responseCapture();
    await handleCancelInvocation(
      controlRequest('DELETE'),
      cancelled.response,
      restarted,
      'inv-late-restart',
    );

    expect(cancelled.result()).toEqual({
      statusCode: 200,
      body: { status: 'ok', invocationId: 'inv-late-restart', cancelled: true },
    });

    const executed = responseCapture();
    await handleExecute(executeRequest('inv-late-restart'), executed.response, restarted);
    expect(executed.result()).toEqual({
      statusCode: 409,
      body: {
        status: 'error',
        error: 'invocation cancelled before start',
        invocationId: 'inv-late-restart',
      },
    });
    expect(restarted.provider.execute).not.toHaveBeenCalled();
  });

  it('GET 在重启后能对账 cancel tombstone', async () => {
    const store = new FileHandInvocationStore(dir);
    await store.markCancelled('inv-tombstone');

    const restarted = deps(new FileHandInvocationStore(dir));
    const queried = responseCapture();
    await handleGetInvocationResult(
      controlRequest('GET'),
      queried.response,
      restarted,
      'inv-tombstone',
    );
    expect(queried.result()).toEqual({
      statusCode: 200,
      body: { status: 'ok', invocationId: 'inv-tombstone', completed: false, cancelled: true },
    });
  });
});

describe('durable result reconciliation', () => {
  it('重启后 GET 查询已完成 invocation 返回持久化结果', async () => {
    const store = new FileHandInvocationStore(dir);
    const first = deps(store);
    const executed = responseCapture();
    await handleExecute(executeRequest('inv-result-restart'), executed.response, first);

    const restarted = deps(new FileHandInvocationStore(dir));
    const queried = responseCapture();
    await handleGetInvocationResult(
      controlRequest('GET'),
      queried.response,
      restarted,
      'inv-result-restart',
    );

    expect(queried.result().statusCode).toBe(200);
    expect(queried.result().body.completed).toBe(true);
    expect(queried.result().body.response).toEqual({ status: 'success', content: 'executed' });
  });

  it('重启对账后 interrupted invocation 返回 indeterminate 终态而不是 404', async () => {
    const store = new FileHandInvocationStore(dir);
    // 模拟崩溃现场：running 记录已落盘，但进程死亡前未写终态
    await store.registerRunning('inv-crashed');

    const restarted = deps(new FileHandInvocationStore(dir));
    const before = responseCapture();
    await handleGetInvocationResult(
      controlRequest('GET'),
      before.response,
      restarted,
      'inv-crashed',
    );
    expect(before.result().body).toMatchObject({ completed: false, cancelled: false });

    await store.reconcileStartup();
    const after = responseCapture();
    const queriedAgain = deps(new FileHandInvocationStore(dir));
    await handleGetInvocationResult(
      controlRequest('GET'),
      after.response,
      queriedAgain,
      'inv-crashed',
    );
    expect(after.result().body.completed).toBe(true);
    expect(after.result().body.interrupted).toBe(true);
    expect(after.result().body.response.metadata).toEqual({
      interrupted: true,
      indeterminate: true,
      interruptedAt: expect.any(String),
    });
  });

  it('journal 未知 invocation 仍返回 404（与既有契约一致）', async () => {
    const restarted = deps(new FileHandInvocationStore(dir));
    const queried = responseCapture();
    await handleGetInvocationResult(
      controlRequest('GET'),
      queried.response,
      restarted,
      'inv-unknown',
    );
    expect(queried.result().statusCode).toBe(404);
  });
});

describe('drain 与失败路径', () => {
  it('draining 期间新 invocation 返回 503 且不触碰 provider', async () => {
    const handlerDeps = deps(new FileHandInvocationStore(dir), { draining: true });
    const executed = responseCapture();
    await handleExecute(executeRequest('inv-drain'), executed.response, handlerDeps);
    expect(executed.result()).toEqual({
      statusCode: 503,
      body: { status: 'error', error: 'hand-server draining; retry after restart' },
    });
    expect(handlerDeps.provider.execute).not.toHaveBeenCalled();
  });

  it('journal 登记失败时 fail closed（503）并回滚内存占位', async () => {
    const handlerDeps = deps({
      registerRunning: vi.fn(async () => {
        throw new Error('EIO');
      }),
    } as unknown as HandInvocationStore);
    const executed = responseCapture();
    await handleExecute(executeRequest('inv-store-error'), executed.response, handlerDeps);
    expect(executed.result().statusCode).toBe(503);
    expect(handlerDeps.provider.execute).not.toHaveBeenCalled();
    expect(handlerDeps.invocations?.has('inv-store-error')).toBe(false);
    expect(handlerDeps.logger.error).toHaveBeenCalled();
  });

  it('journal 完成落盘失败不吞掉已算出的执行结果', async () => {
    const handlerDeps = deps({
      registerRunning: vi.fn(async () => ({
        outcome: 'created',
        record: {
          invocationId: 'inv-persist-error',
          state: 'running' as const,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      })),
      complete: vi.fn(async () => {
        throw new Error('ENOSPC');
      }),
    } as unknown as HandInvocationStore);
    const executed = responseCapture();
    await handleExecute(executeRequest('inv-persist-error'), executed.response, handlerDeps);
    expect(executed.result()).toEqual({
      statusCode: 200,
      body: { status: 'success', content: 'executed' },
    });
    expect(handlerDeps.logger.error).toHaveBeenCalled();
  });

  it('在途 invocation 进入/离开 activeInvocations 跟踪（drain 等待依据）', async () => {
    let resolveExecution: (response: ToolInvocationResponse) => void = () => {};
    const execution = new Promise<ToolInvocationResponse>((resolve) => {
      resolveExecution = resolve;
    });
    const handlerDeps = deps(new FileHandInvocationStore(dir), {
      provider: { execute: vi.fn(() => execution) } as any,
      activeInvocations: new Set<string>(),
    });

    const pending = handleExecute(
      executeRequest('inv-active'),
      responseCapture().response,
      handlerDeps,
    );
    // 等 provider 真正被调用，确保 tracking key 已登记
    await vi.waitFor(() => expect(handlerDeps.provider.execute).toHaveBeenCalled());
    expect(handlerDeps.activeInvocations?.size).toBe(1);

    resolveExecution({ status: 'success', content: 'done' });
    await pending;
    expect(handlerDeps.activeInvocations?.size).toBe(0);
  });

  it('未配置 journal 时保持纯内存行为（可执行、可查询、无重放）', async () => {
    const handlerDeps = deps();
    const executed = responseCapture();
    await handleExecute(executeRequest('inv-memory'), executed.response, handlerDeps);
    expect(executed.result().body).toEqual({ status: 'success', content: 'executed' });

    const queried = responseCapture();
    await handleGetInvocationResult(
      controlRequest('GET'),
      queried.response,
      handlerDeps,
      'inv-memory',
    );
    expect(queried.result().body.completed).toBe(true);
  });
});

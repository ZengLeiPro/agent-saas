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
import {
  FileHandInvocationStore,
  type HandInvocationStore,
  type RegisterRunningOutcome,
} from './invocationStore.js';

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

  it('日志仅记录缩短后的长 invocationId', async () => {
    const invocationId = `inv-${'a'.repeat(252)}`;
    const first = deps(new FileHandInvocationStore(dir));
    await handleExecute(executeRequest(invocationId), responseCapture().response, first);

    const second = deps(new FileHandInvocationStore(dir));
    await handleExecute(executeRequest(invocationId), responseCapture().response, second);
    const logs = JSON.stringify((second.logger.info as ReturnType<typeof vi.fn>).mock.calls);
    expect(logs).toContain(`${invocationId.slice(0, 12)}…${invocationId.slice(-8)}`);
    expect(logs).not.toContain(invocationId);
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

  it('journal 完成落盘失败（ENOSPC）：结果仍返回但显式标记 durablePersistFailed，不确认 durable 成功', async () => {
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
        const err = new Error('ENOSPC: no space left on device');
        (err as NodeJS.ErrnoException).code = 'ENOSPC';
        throw err;
      }),
    } as unknown as HandInvocationStore);
    const executed = responseCapture();
    await handleExecute(executeRequest('inv-persist-error'), executed.response, handlerDeps);
    expect(executed.result()).toEqual({
      statusCode: 200,
      body: {
        status: 'success',
        content: 'executed',
        metadata: { durablePersistFailed: true },
      },
    });
    expect(handlerDeps.logger.error).toHaveBeenCalled();
  });

  it('complete 落盘失败后 GET 对账仍保留 durablePersistFailed（不误报 durable success）', async () => {
    const handlerDeps = deps({
      registerRunning: vi.fn(async () => ({
        outcome: 'created',
        record: {
          invocationId: 'inv-persist-get',
          state: 'running' as const,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      })),
      complete: vi.fn(async () => {
        const err = new Error('ENOSPC: no space left on device');
        (err as NodeJS.ErrnoException).code = 'ENOSPC';
        throw err;
      }),
    } as unknown as HandInvocationStore);
    const executed = responseCapture();
    await handleExecute(executeRequest('inv-persist-get'), executed.response, handlerDeps);
    expect(executed.result().body.metadata).toEqual({ durablePersistFailed: true });

    // 网络丢包后 Brain 走 GET 恢复：必须看到同一份带标记的结果
    const queried = responseCapture();
    await handleGetInvocationResult(
      controlRequest('GET'),
      queried.response,
      handlerDeps,
      'inv-persist-get',
    );
    expect(queried.result().statusCode).toBe(200);
    expect(queried.result().body.completed).toBe(true);
    expect(queried.result().body.response).toEqual({
      status: 'success',
      content: 'executed',
      metadata: { durablePersistFailed: true },
    });
  });

  it('SSE 路径 complete 落盘失败：completed 帧与 GET 对账同源保留 durablePersistFailed', async () => {
    const handlerDeps = deps({
      registerRunning: vi.fn(async () => ({
        outcome: 'created',
        record: {
          invocationId: 'inv-sse-persist-error',
          state: 'running' as const,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      })),
      complete: vi.fn(async () => {
        throw new Error('EIO');
      }),
    } as unknown as HandInvocationStore);
    handlerDeps.provider = {
      executeStream: async function* () {
        yield { type: 'progress' as const, message: 'running' };
        yield {
          type: 'completed' as const,
          response: { status: 'success' as const, content: 'streamed' },
        };
      },
    } as any;

    const sse = sseCapture();
    await handleExecuteStream(executeRequest('inv-sse-persist-error'), sse.response, handlerDeps);
    const frames = sse.frames();
    const completed = frames.find((frame) => frame.type === 'completed') as
      { response: ToolInvocationResponse } | undefined;
    expect(completed?.response).toEqual({
      status: 'success',
      content: 'streamed',
      metadata: { durablePersistFailed: true },
    });

    const queried = responseCapture();
    await handleGetInvocationResult(
      controlRequest('GET'),
      queried.response,
      handlerDeps,
      'inv-sse-persist-error',
    );
    expect(queried.result().body.response).toEqual({
      status: 'success',
      content: 'streamed',
      metadata: { durablePersistFailed: true },
    });
  });

  it('complete 落盘失败后同进程重派：从内存重放（不二次执行、不 409 卡死）', async () => {
    let registerCalls = 0;
    const handlerDeps = deps({
      registerRunning: vi.fn(async (): Promise<RegisterRunningOutcome> => {
        registerCalls += 1;
        const record = {
          invocationId: 'inv-stuck-running',
          state: 'running' as const,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        return registerCalls === 1
          ? { outcome: 'created' as const, record }
          : { outcome: 'already_running' as const, record };
      }),
      complete: vi.fn(async () => {
        throw new Error('EIO');
      }),
    } as unknown as HandInvocationStore);
    const first = responseCapture();
    await handleExecute(executeRequest('inv-stuck-running'), first.response, handlerDeps);
    expect(first.result().body).toEqual({
      status: 'success',
      content: 'executed',
      metadata: { durablePersistFailed: true },
    });

    const second = responseCapture();
    await handleExecute(executeRequest('inv-stuck-running'), second.response, handlerDeps);
    expect(handlerDeps.provider.execute).toHaveBeenCalledTimes(1);
    expect(second.result()).toEqual({
      statusCode: 200,
      body: {
        status: 'success',
        content: 'executed',
        metadata: { durablePersistFailed: true, durableReplay: true },
      },
    });
  });

  it('markCancelled 落盘失败（EIO）：返回 503 而不是确认 cancelled:true', async () => {
    const handlerDeps = deps({
      markCancelled: vi.fn(async () => {
        const err = new Error('EIO');
        (err as NodeJS.ErrnoException).code = 'EIO';
        throw err;
      }),
    } as unknown as HandInvocationStore);
    const cancelled = responseCapture();
    await handleCancelInvocation(
      controlRequest('DELETE'),
      cancelled.response,
      handlerDeps,
      'inv-cancel-persist-error',
    );
    expect(cancelled.result().statusCode).toBe(503);
    expect(cancelled.result().body.status).toBe('error');
    expect(cancelled.result().body.error).toContain('tombstone write failed');
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

  it('prepare 阶段（body 未读完）收到 SIGTERM：请求全程被跟踪，二次门禁在副作用前拒绝', async () => {
    const handlerDeps = deps(new FileHandInvocationStore(dir), {
      activeInvocations: new Set<string>(),
    });
    // 不结束的请求流：handleExecute 停在 readBody
    const request = new Readable({ read() {} });
    Object.assign(request, {
      method: 'POST',
      headers: { authorization: 'Bearer token-1' },
      socket: { remoteAddress: '127.0.0.1' },
    });
    const executed = responseCapture();
    const pending = handleExecute(request as any, executed.response, handlerDeps);

    // 请求已接受但 body 未到：必须在 activeInvocations 中，
    // 否则 drain poll 会把它当作"无在途"提前 exit 杀掉。
    expect(handlerDeps.activeInvocations?.size).toBe(1);

    // SIGTERM 在 prepare 窗口内置 draining
    handlerDeps.draining = true;
    request.push(
      Buffer.from(
        JSON.stringify({
          toolName: 'Shell',
          input: { command: 'echo ok' },
          context: { invocationId: 'inv-prepare-drain', workspace: { id: 'workspace-1' } },
        }),
      ),
    );
    request.push(null);
    await pending;

    expect(executed.result()).toEqual({
      statusCode: 503,
      body: { status: 'error', error: 'hand-server draining; retry after restart' },
    });
    // 拒绝发生在 journal 登记与 provider 副作用之前，可安全重试
    expect(handlerDeps.provider.execute).not.toHaveBeenCalled();
    expect(handlerDeps.invocations?.has('inv-prepare-drain')).toBe(false);
    expect(handlerDeps.activeInvocations?.size).toBe(0);
  });

  it('连接断开但 provider 未收尾：drain 跟踪保留到结果持久化完成', async () => {
    let resolveExecution: (response: ToolInvocationResponse) => void = () => {};
    const execution = new Promise<ToolInvocationResponse>((resolve) => {
      resolveExecution = resolve;
    });
    const handlerDeps = deps(new FileHandInvocationStore(dir), {
      provider: { execute: vi.fn(() => execution) } as any,
      activeInvocations: new Set<string>(),
    });
    const executed = responseCapture();
    const pending = handleExecute(
      executeRequest('inv-closed-provider'),
      executed.response,
      handlerDeps,
    );
    await vi.waitFor(() => expect(handlerDeps.provider.execute).toHaveBeenCalled());

    // 客户端断开：abort 信号发出，但 provider 仍在执行、结果尚未持久化
    executed.response.emit('close');
    expect(handlerDeps.activeInvocations?.size).toBe(1);

    resolveExecution({ status: 'success', content: 'late' });
    await pending;
    expect(handlerDeps.activeInvocations?.size).toBe(0);
    // provider 的真实结果仍完整落盘（重启后可对账，不因断连丢失）
    const stored = await new FileHandInvocationStore(dir).get('inv-closed-provider');
    expect(stored?.response).toEqual({ status: 'success', content: 'late' });
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

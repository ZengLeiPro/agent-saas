/**
 * BackgroundTask 单工具（2026-08-03 工具面收敛批次）provider 层测试：
 * action 分发、task_id 必填校验、output 参数映射（camelCase 转换）。
 * service 层的 hand 协议透传（BashOutput/KillBash）在 backgroundTask.test.ts 覆盖。
 */
import { describe, expect, it, vi } from 'vitest';

import type { ToolCallContext } from '../agent/toolRuntime.js';
import type { BackgroundTaskRuntime } from '../runtime/background/backgroundTaskRuntime.js';
import { BackgroundTaskToolProvider, backgroundTaskToolDescriptor } from '../runtime/background/backgroundTaskToolProvider.js';
import type { RunRecord } from '../runtime/runStore.js';

const context = {} as ToolCallContext;

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: 'task-1',
    sessionId: 'session-1',
    status: 'running',
    model: 'mock',
    requestedAt: '2026-08-03T00:00:00.000Z',
    metadata: { backgroundTask: true, backgroundTaskType: 'command', description: 'sleep 60' },
    ...overrides,
  } as RunRecord;
}

function makeRuntime(overrides: Partial<BackgroundTaskRuntime> = {}): BackgroundTaskRuntime {
  return {
    list: vi.fn(async () => [record()]),
    get: vi.fn(async () => record()),
    cancel: vi.fn(async () => record({ status: 'cancelled' })),
    readCommandOutput: vi.fn(async () => ({ content: '{"status":"running"}' })),
    ...overrides,
  } as unknown as BackgroundTaskRuntime;
}

function call(input: unknown) {
  return { toolId: 'BackgroundTask', input, authorization: { approved: true as const, source: 'policy_auto' as const } };
}

describe('BackgroundTaskToolProvider（单工具 action 分发）', () => {
  it('list() 只暴露 BackgroundTask 一个 descriptor，safe/never', () => {
    const provider = new BackgroundTaskToolProvider(makeRuntime());
    expect(provider.list().map((d) => d.id)).toEqual(['BackgroundTask']);
    expect(backgroundTaskToolDescriptor.risk).toBe('safe');
    expect(backgroundTaskToolDescriptor.approvalMode).toBe('never');
  });

  it('action=list 走 runtime.list，默认 limit=20', async () => {
    const runtime = makeRuntime();
    const provider = new BackgroundTaskToolProvider(runtime);
    const result = await provider.invoke(call({ action: 'list' }), context);
    expect(runtime.list).toHaveBeenCalledWith(context, 20);
    expect(JSON.parse(result!.content).tasks).toHaveLength(1);
  });

  it('策略拒绝状态视图不泄露 provider 错误', async () => {
    const rawError = 'Responses API HTTP 400: cyber_policy request_id=req-secret';
    const runtime = makeRuntime({
      get: vi.fn(async () => record({
        status: 'failed',
        statusReason: rawError,
        metadata: {
          backgroundTask: true,
          backgroundTaskType: 'agent',
          description: 'policy task',
          backgroundResult: {
            status: 'failed',
            text: '已保留正文',
            errorMessage: rawError,
            failureKind: 'policy_rejection',
            recoveryAction: 'switch_model',
          },
        },
      })),
    });
    const result = await new BackgroundTaskToolProvider(runtime)
      .invoke(call({ action: 'status', task_id: 'task-1' }), context);
    const view = JSON.parse(result!.content);

    expect(view.statusReason).toBe('当前模型受策略限制，请切换其他模型继续。');
    expect(view.result.errorMessage).toBe('当前模型受策略限制，请切换其他模型继续。');
    expect(result!.content).toContain('已保留正文');
    expect(result!.content).not.toContain('cyber_policy');
    expect(result!.content).not.toContain('req-secret');
  });

  it('status/output/cancel 缺 task_id 时给明确错误', async () => {
    const provider = new BackgroundTaskToolProvider(makeRuntime());
    for (const action of ['status', 'output', 'cancel']) {
      await expect(provider.invoke(call({ action }), context)).rejects.toThrow(/需要 task_id/);
    }
  });

  it('action=output 把 snake_case 参数映射为 runtime camelCase 请求', async () => {
    const runtime = makeRuntime();
    const provider = new BackgroundTaskToolProvider(runtime);
    await provider.invoke(call({
      action: 'output', task_id: 'task-1', stdout_offset: 10, stderr_offset: 5, limit_bytes: 1024, wait_ms: 500,
    }), context);
    expect(runtime.readCommandOutput).toHaveBeenCalledWith(context, {
      taskId: 'task-1', stdoutOffset: 10, stderrOffset: 5, limitBytes: 1024, waitMs: 500,
    });
  });

  it('action=cancel 走 runtime.cancel 并返回终态视图', async () => {
    const runtime = makeRuntime();
    const provider = new BackgroundTaskToolProvider(runtime);
    const result = await provider.invoke(call({ action: 'cancel', task_id: 'task-1' }), context);
    expect(runtime.cancel).toHaveBeenCalledWith(context, 'task-1');
    expect(JSON.parse(result!.content).status).toBe('cancelled');
  });

  it('未知 toolId 透传 undefined（provider 链协议）', async () => {
    const provider = new BackgroundTaskToolProvider(makeRuntime());
    expect(await provider.invoke({ ...call({ action: 'list' }), toolId: 'Other' }, context)).toBeUndefined();
  });
});

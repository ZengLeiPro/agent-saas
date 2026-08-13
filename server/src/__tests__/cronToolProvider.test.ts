import { describe, expect, it, beforeEach, vi } from 'vitest';

import { CronToolProvider } from '../agent/cronToolProvider.js';
import type { AuthorizedToolCall, ToolCallContext } from '../agent/toolRuntime.js';
import { CronService } from '../cron/service.js';
import type { CronJob } from '../cron/types.js';
import type { UserIdentity } from '../types/index.js';
import type { TaskboardService } from '../taskboard/types.js';

const OWNER: UserIdentity = { id: 'u-owner', username: 'owner', role: 'user', tenantId: 'kaiyan' };
const OTHER: UserIdentity = { id: 'u-other', username: 'other', role: 'user', tenantId: 'kaiyan' };

function makeService(initial: CronJob[] = []): CronService {
  return new CronService({
    nowMs: () => 1_783_000_000_000,
    loadJobs: async () => initial,
    saveJobs: async () => {},
    executeJob: async () => ({ status: 'ok' as const, output: 'done' }),
    appendRunLog: async () => {},
  });
}

function context(user: UserIdentity): ToolCallContext {
  return {
    channelContext: { channel: 'web', sessionOwner: user },
    workspace: { root: '/tmp/cron-tool-test', executionTarget: 'server-local' },
    sessionId: 'session-1',
    runId: 'run-1',
  };
}

function call(toolId: string, input: unknown): AuthorizedToolCall {
  return { toolId, input, authorization: { source: 'auto', reason: 'test' } as never };
}

const CREATE_INPUT = {
  action: 'create',
  name: '每日测试提醒',
  schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Shanghai' },
  payload: { kind: 'agentTurn', message: '请提醒用户' },
  notify: { enabled: true, channel: 'web' },
};

describe('CronToolProvider', () => {
  let provider: CronToolProvider;
  let service: CronService;

  beforeEach(() => {
    service = makeService();
    provider = new CronToolProvider({ service: () => service });
  });

  it('有会话身份时暴露 CronManage，无身份或服务未启用时隐藏', () => {
    expect(provider.list(context(OWNER)).map((t) => t.id)).toEqual(['CronManage']);
    expect(provider.list({ ...context(OWNER), channelContext: { channel: 'web' } })).toEqual([]);
    const disabled = new CronToolProvider({ service: () => undefined });
    expect(disabled.list(context(OWNER))).toEqual([]);
  });

  it('create 自动注入 owner 并返回详情', async () => {
    const result = await provider.invoke(call('CronManage', CREATE_INPUT), context(OWNER));
    const parsed = JSON.parse(result!.content) as { created: boolean; job: { id: string; name: string } };
    expect(parsed.created).toBe(true);
    expect(parsed.job.name).toBe('每日测试提醒');
    const stored = await service.get(parsed.job.id);
    expect(stored?.owner).toBe(OWNER.id);
    expect(stored?.ownerName).toBe(OWNER.username);
  });

  it('action=list 只返回自己的任务；他人任务详情不可见', async () => {
    const created = await provider.invoke(call('CronManage', CREATE_INPUT), context(OWNER));
    const jobId = (JSON.parse(created!.content) as { job: { id: string } }).job.id;

    const mine = JSON.parse((await provider.invoke(call('CronManage', { action: 'list' }), context(OWNER)))!.content) as { count: number };
    expect(mine.count).toBe(1);

    const others = JSON.parse((await provider.invoke(call('CronManage', { action: 'list' }), context(OTHER)))!.content) as { count: number };
    expect(others.count).toBe(0);

    await expect(provider.invoke(call('CronManage', { action: 'list', id: jobId }), context(OTHER))).rejects.toThrow(/不存在/);
  });

  it('update/delete/run 拒绝非本人任务，本人可正常操作', async () => {
    const created = await provider.invoke(call('CronManage', CREATE_INPUT), context(OWNER));
    const jobId = (JSON.parse(created!.content) as { job: { id: string } }).job.id;

    await expect(
      provider.invoke(call('CronManage', { action: 'update', id: jobId, enabled: false }), context(OTHER)),
    ).rejects.toThrow(/不存在/);
    await expect(
      provider.invoke(call('CronManage', { action: 'delete', id: jobId }), context(OTHER)),
    ).rejects.toThrow(/不存在/);

    const updated = await provider.invoke(
      call('CronManage', { action: 'update', id: jobId, enabled: false }),
      context(OWNER),
    );
    expect((JSON.parse(updated!.content) as { job: { enabled: boolean } }).job.enabled).toBe(false);

    const ran = await provider.invoke(call('CronManage', { action: 'run', id: jobId }), context(OWNER));
    expect((JSON.parse(ran!.content) as { ran: boolean }).ran).toBe(true);

    const deleted = await provider.invoke(call('CronManage', { action: 'delete', id: jobId }), context(OWNER));
    expect((JSON.parse(deleted!.content) as { deleted: boolean }).deleted).toBe(true);
  });

  it('target=taskboard 仅允许看板 Execution 回写当前任务', async () => {
    const task = {
      id: 'task-1',
      boardId: 'board-1',
      identifier: 'TASK-1',
      title: '实现功能',
      description: '',
      status: 'in_progress' as const,
      priority: 'none' as const,
      labels: [],
      sortOrder: 1_024,
      commentCount: 0,
      version: 3,
      createdAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:00:00.000Z',
    };
    const updateTask = vi.fn(async (_identity, _id, input) => ({
      ...task,
      branch: input.branch ?? undefined,
      version: task.version + 1,
    }));
    const taskboard = {
      getTask: vi.fn(async () => task),
      updateTask,
    } as unknown as TaskboardService;
    provider = new CronToolProvider({
      service: () => undefined,
      taskboard: { service: () => taskboard },
    });

    expect(provider.list(context(OWNER)).map((item) => item.id)).toEqual(['CronManage']);
    const taskboardContext = { ...context(OWNER), runId: 'taskboard-run-1' };
    await expect(provider.invoke(call('CronManage', {
      target: 'taskboard', action: 'update', id: task.id, branch: 'unsafe',
    }), taskboardContext)).rejects.toThrow('执行上下文服务未启用');
    await expect(provider.invoke(call('CronManage', CREATE_INPUT), taskboardContext))
      .rejects.toThrow('只能使用 target=taskboard');
    await expect(provider.invoke(call('CronManage', {
      target: 'taskboard', action: 'update', id: task.id, branch: 'unsafe',
    }), context(OWNER))).rejects.toThrow('只允许任务看板 Agent Execution');

    const execution = {
      id: 'execution-1', taskId: task.id, runId: taskboardContext.runId, sessionId: 'session-1',
      status: 'running' as const, purpose: 'review' as const, requestedBy: OWNER.id,
      createdAt: task.createdAt, updatedAt: task.updatedAt,
    };
    const getExecutionContextByRunId = vi.fn(async () => ({
      identity: { tenantId: OWNER.tenantId!, ownerUserId: OWNER.id, username: OWNER.username },
      task,
      boardPrompt: '',
      comments: [],
      execution,
    }));
    provider = new CronToolProvider({
      service: () => undefined,
      taskboard: {
        service: () => taskboard,
        executionStore: () => ({
          getExecutionContextByRunId,
          moveTaskFromExecution: vi.fn(),
        }),
      },
    });
    await provider.invoke(call('CronManage', {
      target: 'taskboard', action: 'update', id: task.id, branch: 'task/TASK-1-feature',
    }), taskboardContext);

    expect(getExecutionContextByRunId).toHaveBeenCalledWith(taskboardContext.runId);
    expect(updateTask).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: OWNER.tenantId,
      ownerUserId: OWNER.id,
    }), task.id, { branch: 'task/TASK-1-feature', expectedVersion: task.version });
  });

  it('create 缺必填字段或非法 cron 表达式时报错', async () => {
    await expect(
      provider.invoke(call('CronManage', { action: 'create', name: 'x' }), context(OWNER)),
    ).rejects.toThrow();
    await expect(
      provider.invoke(
        call('CronManage', { ...CREATE_INPUT, schedule: { kind: 'cron', expr: 'not-a-cron' } }),
        context(OWNER),
      ),
    ).rejects.toThrow(/无效的 cron 表达式/);
    await expect(
      provider.invoke(call('CronManage', { action: 'update' }), context(OWNER)),
    ).rejects.toThrow(/需要提供 id/);
  });
});

import { describe, expect, it, beforeEach, vi } from 'vitest';

import { CronToolProvider, cronManageToolDescriptor } from '../agent/cronToolProvider.js';
import { createExecutionAuditRecorder, type AuthorizedToolCall, type ToolCallContext } from '../agent/toolRuntime.js';
import { CronService } from '../cron/service.js';
import type { CronJob } from '../cron/types.js';
import type { UserIdentity } from '../types/index.js';
import type {
  TaskboardExecutionContext,
  TaskboardExecutionService,
  TaskboardService,
} from '../taskboard/types.js';

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
    expect(stored?.orgAgentId).toBeUndefined();
  });

  it('create 只从匹配 owner/tenant 的可信 Session 固化企业专家绑定', async () => {
    const get = vi.fn(async () => ({
      sessionId: 'session-1', userId: OWNER.id, username: OWNER.username,
      tenantId: OWNER.tenantId, orgAgentId: 'agent-a', channel: 'web',
    }));
    provider = new CronToolProvider({
      service: () => service,
      sessionCatalog: { get } as never,
    });

    await expect(provider.invoke(call('CronManage', {
      ...CREATE_INPUT,
      orgAgentId: 'spoofed-agent',
    }), context(OWNER))).rejects.toThrow();

    const result = await provider.invoke(call('CronManage', CREATE_INPUT), context(OWNER));
    const parsed = JSON.parse(result!.content) as {
      job: { id: string; orgAgentId?: string };
    };
    expect(parsed.job.orgAgentId).toBe('agent-a');
    await expect(service.get(parsed.job.id)).resolves.toMatchObject({ orgAgentId: 'agent-a' });

    get.mockResolvedValueOnce({
      sessionId: 'session-1', userId: OTHER.id, username: OTHER.username,
      tenantId: OWNER.tenantId, orgAgentId: 'agent-b', channel: 'web',
    });
    const wrongOwner = await provider.invoke(call('CronManage', CREATE_INPUT), context(OWNER));
    const wrongOwnerId = (JSON.parse(wrongOwner!.content) as { job: { id: string } }).job.id;
    expect((await service.get(wrongOwnerId))?.orgAgentId).toBeUndefined();

    get.mockResolvedValueOnce({
      sessionId: 'session-1', userId: OWNER.id, username: OWNER.username,
      tenantId: 'other-tenant', orgAgentId: 'agent-c', channel: 'web',
    });
    const wrongTenant = await provider.invoke(call('CronManage', CREATE_INPUT), context(OWNER));
    const wrongTenantId = (JSON.parse(wrongTenant!.content) as { job: { id: string } }).job.id;
    expect((await service.get(wrongTenantId))?.orgAgentId).toBeUndefined();

    get.mockResolvedValueOnce({
      sessionId: 'session-1', userId: OWNER.id, username: OWNER.username,
      tenantId: OWNER.tenantId, orgAgentId: 'agent-a', channel: 'web',
    });
    const systemEvent = await provider.invoke(call('CronManage', {
      ...CREATE_INPUT,
      payload: { kind: 'systemEvent', text: '发送普通提醒' },
    }), context(OWNER));
    const systemEventId = (JSON.parse(systemEvent!.content) as { job: { id: string } }).job.id;
    expect((await service.get(systemEventId))?.orgAgentId).toBeUndefined();
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

  it('target=taskboard 允许普通会话管理，同时保留看板 Execution fencing', async () => {
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
    const board = {
      id: task.boardId,
      ownerUserId: OWNER.id,
      name: '迭代看板',
      visibility: 'personal' as const,
      role: 'owner' as const,
      canManage: true,
      prompt: '',
      version: 1,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    };
    const taskboard = {
      getBoard: vi.fn(async () => board),
      getTask: vi.fn(async () => task),
      createTask: vi.fn(async (_identity, _boardId, input) => ({
        ...task, id: 'task-new', title: input.title, status: 'todo' as const, version: 1,
      })),
      updateTask,
    } as unknown as TaskboardService;
    const executionService = {
      listExecutions: vi.fn(async () => []),
      searchExecutions: vi.fn(async () => ({ items: [], page: 1, pageSize: 20, total: 0, hasMore: false })),
      startExecution: vi.fn(async () => { throw new Error('默认模型不可用'); }),
    } satisfies TaskboardExecutionService;
    provider = new CronToolProvider({
      service: () => undefined,
      taskboard: { service: () => taskboard, executionService: () => executionService },
    });

    expect(provider.list(context(OWNER)).map((item) => item.id)).toEqual(['CronManage']);
    const taskboardContext = { ...context(OWNER), runId: 'taskboard-run-1' };
    const missingStoreContext = { ...taskboardContext, executionAudit: createExecutionAuditRecorder() };
    await expect(provider.invoke(call('CronManage', {
      target: 'taskboard', action: 'update', id: task.id, branch: 'unsafe',
    }), missingStoreContext)).rejects.toThrow('执行上下文服务未启用');
    expect(missingStoreContext.executionAudit.records).toEqual([
      expect.objectContaining({ operation: 'update', resultStatus: 'error', status: 'error' }),
    ]);
    await expect(provider.invoke(call('CronManage', CREATE_INPUT), taskboardContext))
      .rejects.toThrow('只能使用 target=taskboard');
    await expect(provider.invoke(call('CronManage', {
      target: 'taskboard', action: 'task.update', taskId: task.id,
      branch: 'task/TASK-1-normal-session', expectedVersion: task.version,
    }), context(OWNER))).resolves.toBeDefined();
    expect(updateTask).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: OWNER.tenantId,
      ownerUserId: OWNER.id,
    }), task.id, { branch: 'task/TASK-1-normal-session', expectedVersion: task.version });
    updateTask.mockClear();

    const delegatedContext = context(OWNER);
    delegatedContext.channelContext.user = OTHER;
    delegatedContext.executionAudit = createExecutionAuditRecorder();
    await provider.invoke(call('CronManage', {
      target: 'taskboard', action: 'task.update', taskId: task.id,
      branch: 'task/TASK-1-current-caller', expectedVersion: task.version,
    }), delegatedContext);
    expect(updateTask).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: OTHER.tenantId,
      ownerUserId: OTHER.id,
    }), task.id, { branch: 'task/TASK-1-current-caller', expectedVersion: task.version });
    expect(delegatedContext.executionAudit.records).toEqual([
      expect.objectContaining({
        operation: 'task.update',
        actorUserId: OTHER.id,
        tenantId: OTHER.tenantId,
        sessionId: delegatedContext.sessionId,
        runId: delegatedContext.runId,
        objectType: 'task',
        objectId: task.id,
        contextKind: 'normal_session',
        resultStatus: 'success',
        status: 'success',
      }),
    ]);
    updateTask.mockClear();

    const partialContext = context(OWNER);
    partialContext.toolCallId = 'tool-call-1';
    partialContext.invocationId = 'invocation-1';
    partialContext.executionAudit = createExecutionAuditRecorder();
    const partialResult = await provider.invoke(call('CronManage', {
      target: 'taskboard', action: 'task.create', boardId: board.id,
      title: '派发失败但已创建', dispatch: true,
    }), partialContext);
    expect(JSON.parse(partialResult!.content)).toMatchObject({
      created: true, dispatched: false, task: { id: 'task-new' },
      dispatchError: { message: '默认模型不可用' },
    });
    expect(partialContext.executionAudit.records).toEqual([
      expect.objectContaining({
        operation: 'task.create', actorUserId: OWNER.id, objectId: 'task-new',
        toolCallId: partialContext.toolCallId, invocationId: partialContext.invocationId,
        resultStatus: 'partial_success', recordedAt: expect.any(String),
        status: 'error', error: '默认模型不可用',
      }),
    ]);

    const execution = {
      id: 'execution-1', taskId: task.id, runId: taskboardContext.runId, sessionId: 'taskboard-session-1',
      status: 'running' as const, purpose: 'work' as const, requestedBy: OWNER.id,
      createdAt: task.createdAt, updatedAt: task.updatedAt,
    };
    const executionContext: TaskboardExecutionContext = {
      identity: { tenantId: OWNER.tenantId!, ownerUserId: OWNER.id, username: OWNER.username },
      task,
      boardPrompt: '',
      comments: [],
      execution,
    };
    const getExecutionContextByRunId = vi.fn(async () => executionContext);
    const getExecutionContextBySessionId = vi.fn(async () => executionContext);
    const updateTaskBranchFromExecution = vi.fn(async (_identity, _runId, branch) => ({
      ...task, branch: branch ?? undefined, version: task.version + 1,
    }));
    provider = new CronToolProvider({
      service: () => undefined,
      taskboard: {
        service: () => taskboard,
        executionStore: () => ({
          getExecutionContextByRunId,
          getExecutionContextBySessionId,
          updateTaskBranchFromExecution,
          createTaskFromExecution: vi.fn(),
          createTaskFromExecutionWithResult: vi.fn(),
          moveTaskFromExecution: vi.fn(),
        }),
      },
    });
    await provider.invoke(call('CronManage', {
      target: 'taskboard', action: 'update', id: task.id, branch: 'task/TASK-1-feature',
    }), taskboardContext);

    expect(getExecutionContextByRunId).toHaveBeenCalledWith(taskboardContext.runId);
    expect(updateTask).not.toHaveBeenCalled();
    expect(updateTaskBranchFromExecution).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: OWNER.tenantId,
      ownerUserId: OWNER.id,
    }), taskboardContext.runId, 'task/TASK-1-feature');

    updateTaskBranchFromExecution.mockClear();
    const resumedExecutionContext = {
      ...taskboardContext,
      channelContext: { ...taskboardContext.channelContext, user: OTHER },
      executionAudit: createExecutionAuditRecorder(),
    };
    await provider.invoke(call('CronManage', {
      target: 'taskboard', action: 'update', id: task.id, branch: 'task/TASK-1-resumed',
    }), resumedExecutionContext);
    expect(updateTaskBranchFromExecution).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: OWNER.tenantId,
      ownerUserId: OWNER.id,
    }), taskboardContext.runId, 'task/TASK-1-resumed');
    expect(resumedExecutionContext.executionAudit.records).toEqual([
      expect.objectContaining({
        operation: 'update', actorUserId: OWNER.id, contextKind: 'taskboard_execution', status: 'success',
      }),
    ]);

    const derivedExecutionContext = {
      ...context(OWNER),
      sessionId: 'sub-session-1',
      runId: 'derived-run-1',
      workspace: {
        ...context(OWNER).workspace,
        topLevelSessionId: execution.sessionId,
      },
      channelContext: { ...context(OWNER).channelContext, user: OTHER },
      executionAudit: createExecutionAuditRecorder(),
    };
    await expect(provider.invoke(call('CronManage', {
      target: 'taskboard', action: 'task.update', taskId: task.id,
      branch: 'task/TASK-1-bypass', expectedVersion: task.version,
    }), derivedExecutionContext)).rejects.toThrow('不能进入普通会话管理域');
    expect(getExecutionContextBySessionId).toHaveBeenCalledWith(execution.sessionId);
    expect(updateTask).not.toHaveBeenCalled();

    await provider.invoke(call('CronManage', {
      target: 'taskboard', action: 'update', id: task.id, branch: 'task/TASK-1-derived',
    }), derivedExecutionContext);
    expect(updateTaskBranchFromExecution).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: OWNER.tenantId,
      ownerUserId: OWNER.id,
    }), execution.runId, 'task/TASK-1-derived');
    await expect(provider.invoke(call('CronManage', CREATE_INPUT), derivedExecutionContext))
      .rejects.toThrow('只能使用 target=taskboard');
    expect(derivedExecutionContext.executionAudit.records).toEqual([
      expect.objectContaining({
        operation: 'task.update', actorUserId: OWNER.id,
        contextKind: 'taskboard_execution', resultStatus: 'error', status: 'error',
      }),
      expect.objectContaining({
        operation: 'update', actorUserId: OWNER.id,
        contextKind: 'taskboard_execution', resultStatus: 'success', status: 'success',
      }),
    ]);

    const sessionFallbackContext = {
      ...context(OWNER),
      sessionId: execution.sessionId,
      runId: 'continued-run-1',
    };
    getExecutionContextBySessionId.mockResolvedValueOnce({
      ...executionContext,
      identity: { tenantId: 'other-tenant', ownerUserId: OTHER.id, username: OTHER.username },
    });
    await expect(provider.invoke(call('CronManage', {
      target: 'taskboard', action: 'update', id: task.id, branch: 'task/TASK-1-cross-tenant',
    }), sessionFallbackContext)).rejects.toThrow('执行身份不匹配');

    getExecutionContextBySessionId.mockResolvedValueOnce({
      ...executionContext,
      execution: { ...execution, status: 'succeeded' },
    });
    await expect(provider.invoke(call('CronManage', {
      target: 'taskboard', action: 'update', id: task.id, branch: 'task/TASK-1-terminal',
    }), sessionFallbackContext)).rejects.toThrow('执行已终止');
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

  it('Taskboard 附件参数只允许当前会话 attachmentId，不接受 relativePath', () => {
    const attachmentId = '11111111-1111-4111-8111-111111111111';
    expect(() => cronManageToolDescriptor.schema.parse({
      target: 'taskboard', action: 'comment.create', taskId: 'task-1',
      attachments: [{ attachmentId }],
    })).not.toThrow();
    expect(() => cronManageToolDescriptor.schema.parse({
      target: 'taskboard', action: 'comment.create', taskId: 'task-1',
      attachments: [{ attachmentId, relativePath: 'uploads/evidence.png' }],
    })).toThrow();
  });
});

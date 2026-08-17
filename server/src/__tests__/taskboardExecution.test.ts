import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { RunCreateConflictError } from '../runtime/runStore.js';
import type { PlatformEvent } from '../runtime/types.js';
import { TaskboardValidationError, type TaskboardIdentity } from '../taskboard/types.js';

import { comment, execution, identity, makeRig, task } from './taskboardExecutionTestRig.js';

describe('TaskboardExecutionCoordinator', () => {
  it('先原子认领，再创建独立会话并进入 durable scheduler', async () => {
    const rig = makeRig();
    const result = await rig.coordinator.startExecution(identity, task.id, { expectedVersion: task.version });

    expect(rig.writeSessionTitle).toHaveBeenCalledWith(expect.objectContaining({ sessionId: result.execution.sessionId }));
    expect(result.task.status).toBe('in_progress');
    expect(rig.store.claimExecution).toHaveBeenCalledWith(identity, task.id, expect.objectContaining({
      expectedVersion: task.version,
      executionId: expect.any(String),
      runId: expect.any(String),
      sessionId: expect.any(String),
    }));
    expect(rig.sessionCatalog.upsert).toHaveBeenCalledWith(expect.objectContaining({
      userId: identity.ownerUserId,
      tenantId: identity.tenantId,
      modelRef: 'model-default',
      executionTarget: 'server-remote',
      workspaceId: `ws_${identity.tenantId}__${identity.ownerUserId}`,
    }));
    expect(rig.scheduler.enqueueCreateOnly).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'web',
      userId: identity.ownerUserId,
      tenantId: identity.tenantId,
      metadata: expect.objectContaining({
        taskboardExecution: true,
        outputTransactionMode: 'terminal_buffered',
        schedulerState: 'staged',
      }),
    }));
  });

  it('在 durable Runtime Run 创建后把会话加入以看板名称命名的系统分组', async () => {
    const groupTaskboardSession = vi.fn(async () => ({ id: 'taskboard:board-1' }));
    const onSessionGrouped = vi.fn(async () => undefined);
    const rig = makeRig(
      {
        getExecutionModelContext: vi.fn(async () => ({
          boardOwnerUserId: identity.ownerUserId,
          boardId: task.boardId,
          boardName: '研发交付',
        })),
      },
      { groupTaskboardSession, onSessionGrouped },
    );

    const result = await rig.coordinator.startExecution(identity, task.id, { expectedVersion: task.version });

    expect(groupTaskboardSession).toHaveBeenCalledWith({
      boardId: task.boardId,
      boardName: '研发交付',
      sessionId: result.execution.sessionId,
      owner: identity.ownerUserId,
    });
    expect(onSessionGrouped).toHaveBeenCalledWith(expect.objectContaining({
      groupId: 'taskboard:board-1',
      sessionId: result.execution.sessionId,
      userId: identity.ownerUserId,
    }));
    expect(rig.scheduler.enqueueCreateOnly.mock.invocationCallOrder[0]).toBeLessThan(
      groupTaskboardSession.mock.invocationCallOrder[0]!,
    );
  });

  it('session upsert 阻塞期间保持 staged，不会提前激活', async () => {
    let releaseUpsert!: () => void;
    const upsertGate = new Promise<void>((resolve) => { releaseUpsert = resolve; });
    const rig = makeRig();
    rig.sessionCatalog.upsert.mockImplementationOnce(async () => {
      await upsertGate;
      return undefined;
    });

    const starting = rig.coordinator.startExecution(identity, task.id, { expectedVersion: task.version });
    await vi.waitFor(() => expect(rig.scheduler.enqueueCreateOnly).toHaveBeenCalledTimes(1));

    expect(rig.scheduler.activateCreatedRun).not.toHaveBeenCalled();
    expect(rig.store.markExecutionDispatchSucceeded).not.toHaveBeenCalled();

    releaseUpsert();
    await starting;
    expect(rig.scheduler.activateCreatedRun).toHaveBeenCalledTimes(1);
    expect(rig.store.markExecutionDispatchSucceeded).toHaveBeenCalledTimes(1);
  });

  it('分组首次失败时先保有 durable Runtime Run，不留下缺少 Run 的 running Session', async () => {
    const groupTaskboardSession = vi.fn()
      .mockRejectedValueOnce(new Error('group unavailable'))
      .mockResolvedValue({ id: 'taskboard:board-1' });
    const rig = makeRig(
      {
        getExecutionModelContext: vi.fn(async () => ({
          boardOwnerUserId: identity.ownerUserId,
          boardId: task.boardId,
          boardName: '研发交付',
        })),
      },
      { groupTaskboardSession },
    );

    await expect(rig.coordinator.startExecution(identity, task.id, { expectedVersion: task.version }))
      .resolves.toMatchObject({ execution: { status: 'queued' } });

    expect(rig.scheduler.enqueueCreateOnly).toHaveBeenCalledTimes(1);
    expect(rig.scheduler.enqueueCreateOnly.mock.invocationCallOrder[0]).toBeLessThan(
      rig.sessionCatalog.upsert.mock.invocationCallOrder[0]!,
    );
    expect(rig.store.retryExecutionDispatch).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      'Agent 派发重试中：group unavailable',
      1_000,
    );
    expect(rig.scheduler.activateCreatedRun).not.toHaveBeenCalled();
    expect(rig.store.markExecutionDispatchSucceeded).not.toHaveBeenCalled();

    await rig.coordinator.reconcile();

    expect(rig.scheduler.enqueueCreateOnly).toHaveBeenCalledTimes(2);
    expect(groupTaskboardSession).toHaveBeenCalledTimes(2);
    expect(rig.scheduler.activateCreatedRun).toHaveBeenCalledTimes(1);
    expect(rig.store.markExecutionDispatchSucceeded).toHaveBeenCalledTimes(1);
  });

  it('标题首次失败时先保有 durable Runtime Run，重试可幂等完成派发', async () => {
    const writeSessionTitle = vi.fn()
      .mockRejectedValueOnce(new Error('title unavailable'))
      .mockResolvedValue(null);
    const rig = makeRig({}, { writeSessionTitle });

    await expect(rig.coordinator.startExecution(identity, task.id, { expectedVersion: task.version }))
      .resolves.toMatchObject({ execution: { status: 'queued' } });

    expect(rig.scheduler.enqueueCreateOnly).toHaveBeenCalledTimes(1);
    expect(rig.scheduler.enqueueCreateOnly.mock.invocationCallOrder[0]).toBeLessThan(
      rig.sessionCatalog.upsert.mock.invocationCallOrder[0]!,
    );
    expect(rig.store.retryExecutionDispatch).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      'Agent 派发重试中：title unavailable',
      1_000,
    );

    await rig.coordinator.reconcile();

    expect(rig.scheduler.enqueueCreateOnly).toHaveBeenCalledTimes(2);
    expect(writeSessionTitle).toHaveBeenCalledTimes(2);
    expect(rig.scheduler.activateCreatedRun).toHaveBeenCalledTimes(1);
    expect(rig.store.markExecutionDispatchSucceeded).toHaveBeenCalledTimes(1);
  });

  it('Runtime Run 入队后 dispatch 标记失败时可用同一 Run 幂等重试', async () => {
    const rig = makeRig();
    vi.mocked(rig.store.markExecutionDispatchSucceeded)
      .mockRejectedValueOnce(new Error('outbox mark unavailable'));

    await rig.coordinator.startExecution(identity, task.id, { expectedVersion: task.version });
    await rig.coordinator.reconcile();

    expect(rig.scheduler.enqueueCreateOnly).toHaveBeenCalledTimes(2);
    expect(rig.scheduler.activateCreatedRun).toHaveBeenCalledTimes(1);
    expect(rig.sessionCatalog.upsert).toHaveBeenCalledTimes(1);
    expect(rig.writeSessionTitle).toHaveBeenCalledTimes(1);
    expect(rig.store.markExecutionDispatchSucceeded).toHaveBeenCalledTimes(2);
    expect(rig.store.retryExecutionDispatch).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      'Agent 派发重试中：outbox mark unavailable',
      1_000,
    );
    expect(rig.store.completeExecution).not.toHaveBeenCalled();
  });

  it('部署前 legacy pending Run 会先原子 staged，再完成 setup 与 activation', async () => {
    const writeSessionTitle = vi.fn()
      .mockRejectedValueOnce(new Error('title unavailable'))
      .mockResolvedValue(null);
    const rig = makeRig({}, { writeSessionTitle });

    await rig.coordinator.startExecution(identity, task.id, { expectedVersion: task.version });
    const [runId, existing] = [...rig.schedulerRecords.entries()][0]!;
    const { schedulerState: _schedulerState, ...legacyMetadata } = existing.metadata;
    rig.schedulerRecords.set(runId, { ...existing, metadata: legacyMetadata });

    await rig.coordinator.reconcile();

    expect(rig.scheduler.stagePendingRun).toHaveBeenCalledWith(runId);
    expect(rig.scheduler.activateCreatedRun).toHaveBeenCalledTimes(1);
    expect(rig.store.markExecutionDispatchSucceeded).toHaveBeenCalledTimes(1);
    expect(rig.store.completeExecution).not.toHaveBeenCalled();
  });

  it('legacy pending staging CAS 遇并发 running 后仅补 dispatch marker', async () => {
    const writeSessionTitle = vi.fn()
      .mockRejectedValueOnce(new Error('title unavailable'));
    const rig = makeRig({}, { writeSessionTitle });

    await rig.coordinator.startExecution(identity, task.id, { expectedVersion: task.version });
    const [runId, existing] = [...rig.schedulerRecords.entries()][0]!;
    const { schedulerState: _schedulerState, ...legacyMetadata } = existing.metadata;
    rig.schedulerRecords.set(runId, { ...existing, metadata: legacyMetadata });
    rig.scheduler.stagePendingRun.mockImplementationOnce(async () => {
      const { wakeMessage: _wakeMessage, ...consumedMetadata } = legacyMetadata;
      const running = {
        ...existing,
        status: 'running' as const,
        workerId: 'other-worker',
        metadata: consumedMetadata,
      };
      rig.schedulerRecords.set(runId, running);
      return running;
    });

    await rig.coordinator.reconcile();

    expect(rig.scheduler.stagePendingRun).toHaveBeenCalledWith(runId);
    expect(writeSessionTitle).toHaveBeenCalledTimes(1);
    expect(rig.scheduler.activateCreatedRun).not.toHaveBeenCalled();
    expect(rig.store.markExecutionDispatchSucceeded).toHaveBeenCalledTimes(1);
    expect(rig.store.completeExecution).not.toHaveBeenCalled();
  });

  it.each(['running', 'completed'] as const)(
    'dispatch marker 重试接受已 %s 且 wakeMessage 已清的稳定关联 Run',
    async (status) => {
      const rig = makeRig();
      vi.mocked(rig.store.markExecutionDispatchSucceeded)
        .mockRejectedValueOnce(new Error('outbox mark unavailable'));
      await rig.coordinator.startExecution(identity, task.id, { expectedVersion: task.version });

      rig.scheduler.enqueueCreateOnly.mockImplementationOnce(async (input) => {
        const { wakeMessage: _wakeMessage, ...metadata } = input.metadata ?? {};
        return {
          ...input,
          status,
          requestedAt: '2026-08-01T00:00:00.000Z',
          updatedAt: '2026-08-01T00:01:00.000Z',
          metadata: { ...metadata, schedulerState: 'ready' },
        };
      });
      await rig.coordinator.reconcile();

      expect(rig.store.completeExecution).not.toHaveBeenCalled();
      expect(rig.scheduler.activateCreatedRun).toHaveBeenCalledTimes(1);
      expect(rig.sessionCatalog.upsert).toHaveBeenCalledTimes(1);
      expect(rig.writeSessionTitle).toHaveBeenCalledTimes(1);
      expect(rig.store.markExecutionDispatchSucceeded).toHaveBeenCalledTimes(2);
    },
  );

  it('同一任务已有活跃 Execution 时拒绝再次派发且不创建第二个 Run', async () => {
    const rig = makeRig();
    const first = await rig.coordinator.startExecution(identity, task.id, {
      expectedVersion: task.version,
    });
    vi.mocked(rig.store.claimExecution).mockRejectedValueOnce(new TaskboardValidationError(
      'Task already has an active Agent execution',
      'TASKBOARD_EXECUTION_ACTIVE',
    ));

    await expect(rig.coordinator.startExecution(identity, task.id, {
      expectedVersion: first.task.version,
    })).rejects.toMatchObject({ code: 'TASKBOARD_EXECUTION_ACTIVE' });

    expect(rig.store.claimExecution).toHaveBeenCalledTimes(2);
    expect(rig.scheduler.enqueueCreateOnly).toHaveBeenCalledTimes(1);
  });

  it('有执行权限的组织成员可以触发，并继续使用看板创建者运行身份', async () => {
    const member: TaskboardIdentity = {
      tenantId: identity.tenantId,
      ownerUserId: 'user-2',
      username: 'bob',
      userRole: 'user',
    };
    const resolveOwnerIdentity = vi.fn(() => identity);
    const rig = makeRig({
      getExecutionModelContext: vi.fn(async () => ({ boardOwnerUserId: identity.ownerUserId })),
    }, { resolveOwnerIdentity });

    await expect(rig.coordinator.startExecution(
      member,
      task.id,
      { expectedVersion: task.version },
    )).resolves.toMatchObject({ task: { id: task.id } });
    expect(resolveOwnerIdentity).toHaveBeenCalledWith(identity.ownerUserId);
    expect(rig.store.claimExecution).toHaveBeenCalledOnce();
    expect(rig.sessionCatalog.upsert).toHaveBeenCalledOnce();
  });

  it('viewer 在创建 Runtime Session 前即被拒绝触发', async () => {
    const viewer: TaskboardIdentity = {
      tenantId: identity.tenantId,
      ownerUserId: 'viewer-1',
      username: 'viewer',
    };
    const rig = makeRig({
      getExecutionModelContext: vi.fn(async () => ({
        boardOwnerUserId: identity.ownerUserId,
        allowedActions: ['board.read' as const],
      })),
    }, { resolveOwnerIdentity: () => identity });

    await expect(rig.coordinator.startExecution(viewer, task.id, {
      expectedVersion: task.version,
    })).rejects.toMatchObject({ code: 'TASKBOARD_PERMISSION_DENIED' });
    expect(rig.sessionCatalog.upsert).not.toHaveBeenCalled();
    expect(rig.store.claimExecution).not.toHaveBeenCalled();
  });

  it('wake 前重读最新任务和评论并生成执行提示词', async () => {
    const rig = makeRig({}, {
      resolveUserDisplayName: () => '爱丽丝 @alice',
      timezone: 'Asia/Shanghai',
    });
    const prepared = await rig.coordinator.prepareWake({
      runId: 'run-1',
      sessionId: 'session-1',
      status: 'pending',
      requestedAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      metadata: { taskboardExecution: true, taskboardExecutionId: 'execution-1' },
    });

    expect(rig.store.getExecutionContextByRunId).toHaveBeenCalledWith('run-1');
    expect(rig.store.setExecutionStatus).toHaveBeenCalledWith('run-1', 'running');
    expect(prepared.metadata.wakeMessage).toMatchObject({
      content: expect.stringMatching(/taskId: task-1[\s\S]*executionId: execution-1/),
    });
    const content = (prepared.metadata.wakeMessage as { content: string }).content;
    expect(content).not.toContain(task.title);
    expect(content).not.toContain(comment.body);
    expect(content).not.toContain('task/TASK-1-feature');
    expect(content).toContain('读取该任务的最新上下文');
    expect(content).not.toContain('执行前输入已从服务端重新读取');
    expect(content).not.toContain('2026-08-01T01:00:00.000Z');
  });

  it('wake 时显式模型已被组织禁用则拒绝启动', async () => {
    const resolveModel = vi.fn(() => null);
    const rig = makeRig({}, { resolveModel });

    await expect(rig.coordinator.prepareWake({
      runId: 'run-1',
      sessionId: 'session-1',
      model: 'group-a/model-disabled',
      status: 'pending',
      requestedAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      metadata: { taskboardExecution: true, taskboardExecutionId: 'execution-1' },
    })).rejects.toThrow('指定模型不可用：group-a/model-disabled');
    expect(resolveModel).toHaveBeenCalledWith('group-a/model-disabled', identity.tenantId);
    expect(rig.store.setExecutionStatus).not.toHaveBeenCalled();
  });

  it('wake 竞争到终态后立即停止，不再启动 Agent', async () => {
    const rig = makeRig({ setExecutionStatus: vi.fn(async () => null) });

    await expect(rig.coordinator.prepareWake({
      runId: 'run-1',
      sessionId: 'session-1',
      status: 'pending',
      requestedAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      metadata: { taskboardExecution: true, taskboardExecutionId: 'execution-1' },
    })).rejects.toThrow('任务看板执行已终止');
  });

  it('任务级模型优先于看板模型，看板模型优先于组织默认模型', async () => {
    const resolveModel = vi.fn((ref: string) => ({ ref }));
    const rig = makeRig(
      {
        getExecutionModelContext: vi.fn(async () => ({
          taskModel: 'group-a/model-task',
          boardModel: 'group-a/model-board',
          boardOwnerUserId: identity.ownerUserId,
        })),
      },
      { resolveModel },
    );
    await rig.coordinator.startExecution(identity, task.id, { expectedVersion: task.version });
    expect(rig.store.claimExecution).toHaveBeenCalledWith(
      identity,
      task.id,
      expect.objectContaining({ configuredModelRef: 'group-a/model-task' }),
    );
    expect(rig.sessionCatalog.upsert).toHaveBeenCalledWith(expect.objectContaining({
      modelRef: 'group-a/model-task',
    }));

    const boardOnlyRig = makeRig(
      {
        getExecutionModelContext: vi.fn(async () => ({
          boardModel: 'group-a/model-board',
          boardOwnerUserId: identity.ownerUserId,
        })),
      },
      { resolveModel },
    );
    await boardOnlyRig.coordinator.startExecution(identity, task.id, { expectedVersion: task.version });
    expect(boardOnlyRig.sessionCatalog.upsert).toHaveBeenCalledWith(expect.objectContaining({
      modelRef: 'group-a/model-board',
    }));
  });

  it('未指定模型时使用组织默认，显式模型不可用时拒绝执行', async () => {
    const defaultRig = makeRig();
    await defaultRig.coordinator.startExecution(identity, task.id, { expectedVersion: task.version });
    expect(defaultRig.sessionCatalog.upsert).toHaveBeenCalledWith(expect.objectContaining({
      modelRef: 'model-default',
    }));

    const withoutResolver = makeRig({
      getExecutionModelContext: vi.fn(async () => ({
          boardModel: 'group-a/model-board',
          boardOwnerUserId: identity.ownerUserId,
        })),
    });
    await expect(withoutResolver.coordinator.startExecution(
      identity,
      task.id,
      { expectedVersion: task.version },
    )).rejects.toThrow('指定模型不可用：group-a/model-board');

    const resolveModel = vi.fn(() => null);
    const rejectedRig = makeRig(
      {
        getExecutionModelContext: vi.fn(async () => ({
          boardModel: 'group-a/model-board',
          boardOwnerUserId: identity.ownerUserId,
        })),
      },
      { resolveModel },
    );
    await expect(rejectedRig.coordinator.startExecution(
      identity,
      task.id,
      { expectedVersion: task.version },
    )).rejects.toThrow('指定模型不可用：group-a/model-board');
    expect(resolveModel).toHaveBeenCalledWith('group-a/model-board', identity.tenantId);
    expect(rejectedRig.sessionCatalog.upsert).not.toHaveBeenCalled();
  });

  it('成功终态提取最终 assistant_message 作为复核中交付回执', async () => {
    const completeExecution = vi.fn(async () => ({
      task: { ...task, status: 'in_review' as const },
      execution: execution({ status: 'succeeded' }),
    }));
    const rig = makeRig({ completeExecution });
    vi.mocked(rig.eventStore.listByRun!).mockResolvedValue([
      {
        id: 'event-1',
        timestamp: '2026-08-01T03:00:00.000Z',
        type: 'assistant_message',
        runId: 'run-1',
        sessionId: 'session-1',
        content: '已实现并完成自验',
      } as PlatformEvent,
      {
        id: 'event-foreign',
        timestamp: '2026-08-01T03:00:30.000Z',
        type: 'assistant_message',
        runId: 'run-1',
        sessionId: 'other-session',
        content: '不应串入的交付',
      } as PlatformEvent,
    ]);

    await rig.coordinator.handleRuntimeEvent({
      id: 'event-2',
      timestamp: '2026-08-01T03:01:00.000Z',
      type: 'run_finished',
      runId: 'run-1',
      sessionId: 'session-1',
      subtype: 'success',
      numTurns: 2,
    } as PlatformEvent);

    expect(completeExecution).toHaveBeenCalledWith('run-1', expect.objectContaining({
      status: 'succeeded',
      commentBody: 'Agent 交付\n\n已实现并完成自验',
    }));
  });

  it('Agent 交付中的文件卡会成为 Agent 评论附件', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskboard-attachments-'));
    const userCwd = join(root, identity.tenantId, identity.ownerUserId);
    await mkdir(join(userCwd, 'assets'), { recursive: true });
    await writeFile(join(userCwd, 'assets', '交付报告.pdf'), 'report');
    try {
      const completeExecution = vi.fn(async () => ({
        task: { ...task, status: 'in_review' as const },
        execution: execution({ status: 'succeeded' }),
      }));
      const rig = makeRig({ completeExecution }, { agentCwd: root });
      vi.mocked(rig.eventStore.listByRun!).mockResolvedValue([{
        id: 'event-file',
        timestamp: '2026-08-01T03:00:00.000Z',
        type: 'assistant_message',
        runId: 'run-1',
        sessionId: 'session-1',
        content: '请查收。\n[FILE]{"filePath":"assets/交付报告.pdf"}[/FILE]',
      } as PlatformEvent]);

      await rig.coordinator.handleRuntimeEvent({
        id: 'event-finished',
        timestamp: '2026-08-01T03:01:00.000Z',
        type: 'run_finished',
        runId: 'run-1',
        sessionId: 'session-1',
        subtype: 'success',
        numTurns: 2,
      } as PlatformEvent);

      expect(completeExecution).toHaveBeenCalledWith('run-1', expect.objectContaining({
        status: 'succeeded',
        commentBody: 'Agent 交付\n\n请查收。',
        attachments: [{
          originalName: '交付报告.pdf',
          relativePath: 'assets/交付报告.pdf',
          size: 6,
          mimeType: 'application/pdf',
          isImage: false,
        }],
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('入队失败时保留 queued 执行并登记 outbox 重试，不提前写失败终态', async () => {
    const rig = makeRig();
    rig.scheduler.enqueueCreateOnly.mockRejectedValueOnce(new Error('scheduler unavailable'));

    await expect(rig.coordinator.startExecution(identity, task.id, { expectedVersion: task.version }))
      .resolves.toMatchObject({ execution: { status: 'queued' } });
    expect(rig.store.retryExecutionDispatch).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      'Agent 派发重试中：scheduler unavailable',
      1_000,
    );
    expect(rig.sessionCatalog.upsert).not.toHaveBeenCalled();
    expect(rig.writeSessionTitle).not.toHaveBeenCalled();
    expect(rig.store.completeExecution).not.toHaveBeenCalled();
  });

  it('毒 outbox payload 会终止 Execution，不进入永久重试', async () => {
    const claimExecutionDispatch = vi.fn()
      .mockResolvedValueOnce({
        runId: 'poison-run',
        executionId: 'poison-execution',
        payload: { version: 2 } as never,
        attemptCount: 1,
        leaseId: 'poison-lease',
      })
      .mockResolvedValue(null);
    const rig = makeRig({ claimExecutionDispatch });

    await rig.coordinator.reconcile();

    expect(rig.scheduler.enqueueCreateOnly).not.toHaveBeenCalled();
    expect(rig.store.completeExecution).toHaveBeenCalledWith('poison-run', expect.objectContaining({
      status: 'failed',
      error: expect.stringContaining('payload'),
    }));
    expect(rig.store.retryExecutionDispatch).not.toHaveBeenCalled();
  });

  it.each([undefined, 'staged'] as const)(
    '毒 payload 会先取消关联的 %s pending Run，再终止 Execution',
    async (schedulerState) => {
      const claimExecutionDispatch = vi.fn()
        .mockResolvedValueOnce({
          runId: 'poison-associated-run',
          executionId: 'poison-associated-execution',
          payload: { version: 2 } as never,
          attemptCount: 1,
          leaseId: 'poison-associated-lease',
        })
        .mockResolvedValue(null);
      const rig = makeRig({ claimExecutionDispatch });
      rig.schedulerRecords.set('poison-associated-run', {
        runId: 'poison-associated-run',
        sessionId: 'poison-associated-session',
        status: 'pending',
        requestedAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
        metadata: {
          taskboardExecution: true,
          ...(schedulerState ? { schedulerState } : {}),
          wakeMessage: { channel: 'web' },
        },
      });

      await rig.coordinator.reconcile();

      expect(rig.scheduler.cancelPendingTaskboardRun).toHaveBeenCalledWith(
        'poison-associated-run',
        'taskboard_dispatch_poison',
      );
      expect(rig.scheduler.cancelPendingTaskboardRun.mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(rig.store.completeExecution).mock.invocationCallOrder[0]!,
      );
      expect(rig.schedulerRecords.get('poison-associated-run')).toMatchObject({
        status: 'cancelled',
        statusReason: 'taskboard_dispatch_poison',
        metadata: expect.not.objectContaining({ wakeMessage: expect.anything() }),
      });
      expect(rig.store.retryExecutionDispatch).not.toHaveBeenCalled();
    },
  );

  it('poison Run 已被 worker 领取时保留 outbox 重试，不提前终止 Execution', async () => {
    const rig = makeRig();
    rig.scheduler.cancelPendingTaskboardRun.mockResolvedValueOnce({
      runId: 'running-poison-run',
      sessionId: 'running-poison-session',
      status: 'running',
      requestedAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:01:00.000Z',
      metadata: { taskboardExecution: true },
    });
    rig.scheduler.enqueueCreateOnly.mockImplementationOnce(async (input) => ({
      ...input,
      status: 'running',
      requestedAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:01:00.000Z',
      metadata: { ...input.metadata, taskboardTaskId: 'other-task' },
    }));

    await rig.coordinator.startExecution(identity, task.id, { expectedVersion: task.version });

    expect(rig.store.completeExecution).not.toHaveBeenCalled();
    expect(rig.store.retryExecutionDispatch).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.stringContaining('既有 Runtime Run'),
      1_000,
    );
  });

  it('poison Run 取消持久化失败时保留 outbox 重试，不提前终止 Execution', async () => {
    const rig = makeRig();
    rig.scheduler.cancelPendingTaskboardRun.mockRejectedValueOnce(new Error('cancel unavailable'));
    rig.scheduler.enqueueCreateOnly.mockImplementationOnce(async (input) => ({
      ...input,
      status: 'completed',
      requestedAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:01:00.000Z',
      metadata: { ...input.metadata, taskboardTaskId: 'other-task' },
    }));

    await rig.coordinator.startExecution(identity, task.id, { expectedVersion: task.version });

    expect(rig.store.completeExecution).not.toHaveBeenCalled();
    expect(rig.store.retryExecutionDispatch).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.stringContaining('既有 Runtime Run'),
      1_000,
    );
  });

  it('合法外形 payload 的特权扩展字段不会进入 Session 或 Runtime Run', async () => {
    const seed = makeRig();
    await seed.coordinator.startExecution(identity, task.id, { expectedVersion: task.version });
    const claimedInput = vi.mocked(seed.store.claimExecution).mock.calls[0]![2];
    const poisonedPayload = {
      ...claimedInput.dispatch,
      session: {
        ...claimedInput.dispatch.session,
        kind: 'subagent',
        orgAgentId: 'forged-org-agent',
        profileId: 'forged-profile',
      },
      run: {
        ...claimedInput.dispatch.run,
        sandboxScopeId: 'forged-sandbox',
        metadata: {
          ...claimedInput.dispatch.run.metadata,
          backgroundTask: true,
          outputTransactionMode: 'replaceable_draft',
          toolProfile: 'forged-tool-profile',
          approvalPolicy: 'allow-all',
        },
      },
    } as never;
    const claimExecutionDispatch = vi.fn()
      .mockResolvedValueOnce({
        runId: claimedInput.runId,
        executionId: claimedInput.executionId,
        outboxExecutionId: claimedInput.executionId,
        taskId: task.id,
        sessionId: claimedInput.sessionId,
        tenantId: identity.tenantId,
        ownerUserId: identity.ownerUserId,
        payload: poisonedPayload,
        attemptCount: 1,
        leaseId: 'lease-canonical',
      })
      .mockResolvedValue(null);
    const rig = makeRig({ claimExecutionDispatch });

    await rig.coordinator.reconcile();

    expect(rig.sessionCatalog.upsert).toHaveBeenCalledWith(expect.not.objectContaining({
      kind: 'subagent',
      orgAgentId: 'forged-org-agent',
      profileId: 'forged-profile',
    }));
    expect(rig.scheduler.enqueueCreateOnly).toHaveBeenCalledWith(expect.not.objectContaining({
      sandboxScopeId: 'forged-sandbox',
    }));
    expect(rig.scheduler.enqueueCreateOnly).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ outputTransactionMode: 'terminal_buffered' }),
    }));
    expect(rig.scheduler.enqueueCreateOnly).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.not.objectContaining({
        backgroundTask: true,
        outputTransactionMode: 'replaceable_draft',
        toolProfile: 'forged-tool-profile',
        approvalPolicy: 'allow-all',
      }),
    }));
  });

  it('create-only 命中关联污染的既有 Run 时失败收口，不标记 dispatched', async () => {
    const rig = makeRig();
    rig.scheduler.enqueueCreateOnly.mockImplementationOnce(async (input) => {
      const { wakeMessage: _wakeMessage, ...metadata } = input.metadata ?? {};
      return {
        ...input,
        status: 'completed',
        requestedAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:01:00.000Z',
        metadata: { ...metadata, taskboardTaskId: 'other-task', schedulerState: 'ready' },
      };
    });

    await rig.coordinator.startExecution(identity, task.id, { expectedVersion: task.version });

    expect(rig.store.completeExecution).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      status: 'failed',
      error: expect.stringContaining('既有 Runtime Run'),
    }));
    expect(rig.store.markExecutionDispatchSucceeded).not.toHaveBeenCalled();
  });

  it('create-only 幂等键永久冲突会失败收口，不进入瞬时重试', async () => {
    const rig = makeRig();
    rig.scheduler.enqueueCreateOnly.mockRejectedValueOnce(
      new RunCreateConflictError('Run create-only idempotency conflict'),
    );

    await rig.coordinator.startExecution(identity, task.id, { expectedVersion: task.version });

    expect(rig.store.completeExecution).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      status: 'failed',
      error: expect.stringContaining('idempotency conflict'),
    }));
    expect(rig.store.retryExecutionDispatch).not.toHaveBeenCalled();
  });

  it('后台对账使用 single-flight，不阻塞或叠加 Scheduler tick', async () => {
    let resolveCandidates!: (value: []) => void;
    const candidates = new Promise<[]>((resolve) => { resolveCandidates = resolve; });
    const rig = makeRig({
      claimExecutionReconcileCandidates: vi.fn(() => candidates),
    });

    rig.coordinator.wakeReconciliation();
    rig.coordinator.wakeReconciliation();
    await vi.waitFor(() => {
      expect(rig.store.claimExecutionReconcileCandidates).toHaveBeenCalledTimes(1);
    });
    resolveCandidates([]);
    await rig.coordinator.stop();

    expect(rig.store.claimExecutionReconcileCandidates).toHaveBeenCalledTimes(1);
  });

  it('Runtime 终态 session 不匹配时拒绝读取回执或完成 Execution', async () => {
    const rig = makeRig();

    await expect(rig.coordinator.handleRuntimeEvent({
      id: 'event-mismatch',
      timestamp: '2026-08-01T03:01:00.000Z',
      type: 'run_finished',
      runId: 'run-1',
      sessionId: 'other-session',
      subtype: 'success',
      numTurns: 2,
    } as PlatformEvent)).rejects.toThrow('session');

    expect(rig.eventStore.listByRun).not.toHaveBeenCalled();
    expect(rig.store.completeExecution).not.toHaveBeenCalled();
  });

  it('定时对账会补写遗漏的 Runtime 成功终态', async () => {
    const rig = makeRig();
    vi.mocked(rig.store.claimExecutionReconcileCandidates).mockResolvedValue([{
      runId: 'run-1',
      executionId: 'execution-1',
      sessionId: 'session-1',
      executionStatus: 'running',
      dispatchStatus: 'dispatched',
      leaseId: 'reconcile-lease',
    }]);
    rig.runStore.get.mockResolvedValue({
      runId: 'run-1',
      sessionId: 'session-1',
      status: 'completed',
      requestedAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:01:00.000Z',
      completedAt: '2026-08-01T00:01:00.000Z',
      metadata: { taskboardExecution: true, taskboardExecutionId: 'execution-1' },
    });
    vi.mocked(rig.eventStore.listByRun!).mockResolvedValue([{
      id: 'event-1',
      timestamp: '2026-08-01T00:01:00.000Z',
      type: 'assistant_message',
      runId: 'run-1',
      sessionId: 'session-1',
      content: '漏事件后的交付结果',
    } as PlatformEvent]);

    await rig.coordinator.reconcile();

    expect(rig.store.completeExecutionFromReconcile).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({
        status: 'succeeded',
        commentBody: 'Agent 交付\n\n漏事件后的交付结果',
        reviewExecution: expect.objectContaining({ purpose: 'review' }),
      }),
      'reconcile-lease',
    );
  });

  it('对账发现 Run metadata 与 Execution 不匹配时按失败收口且不读取回执', async () => {
    const rig = makeRig();
    vi.mocked(rig.store.claimExecutionReconcileCandidates).mockResolvedValue([{
      runId: 'run-1',
      executionId: 'execution-1',
      sessionId: 'session-1',
      executionStatus: 'running',
      dispatchStatus: 'dispatched',
      leaseId: 'reconcile-lease',
    }]);
    rig.runStore.get.mockResolvedValue({
      runId: 'run-1',
      sessionId: 'session-1',
      status: 'completed',
      requestedAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:01:00.000Z',
      completedAt: '2026-08-01T00:01:00.000Z',
      metadata: { taskboardExecution: true, taskboardExecutionId: 'other-execution' },
    });

    await rig.coordinator.reconcile();

    expect(rig.eventStore.listByRun).not.toHaveBeenCalled();
    expect(rig.store.completeExecutionFromReconcile).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({
        status: 'failed',
        error: 'Runtime Run 与任务看板 Execution 关联校验失败',
      }),
      'reconcile-lease',
    );
  });

  it('刚进入终态的 Run 保留 live 事件宽限期，不抢先写无文本回执', async () => {
    const rig = makeRig();
    vi.mocked(rig.store.claimExecutionReconcileCandidates).mockResolvedValue([{
      runId: 'run-fresh',
      executionId: 'execution-1',
      sessionId: 'session-fresh',
      executionStatus: 'running',
      dispatchStatus: 'dispatched',
      leaseId: 'reconcile-lease',
    }]);
    rig.runStore.get.mockResolvedValue({
      runId: 'run-fresh',
      sessionId: 'session-fresh',
      status: 'completed',
      requestedAt: new Date(Date.now() - 60_000).toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      metadata: { taskboardExecution: true, taskboardExecutionId: 'execution-1' },
    });

    await rig.coordinator.reconcile();

    expect(rig.eventStore.listByRun).not.toHaveBeenCalled();
    expect(rig.store.completeExecution).not.toHaveBeenCalled();
    expect(rig.store.completeExecutionFromReconcile).not.toHaveBeenCalled();
  });

  it('旧活跃执行同时缺少 outbox 与 Runtime Run 时自动阻塞，不再永久卡住', async () => {
    const rig = makeRig();
    vi.mocked(rig.store.claimExecutionReconcileCandidates).mockResolvedValue([{
      runId: 'legacy-run',
      executionId: 'legacy-execution',
      sessionId: 'legacy-session',
      executionStatus: 'queued',
      leaseId: 'reconcile-lease',
    }]);

    await rig.coordinator.reconcile();

    expect(rig.store.completeExecutionFromReconcile).toHaveBeenCalledWith(
      'legacy-run',
      expect.objectContaining({
        status: 'failed',
        error: '执行派发记录缺失，已停止该次 Agent 执行',
      }),
      'reconcile-lease',
    );
  });
});

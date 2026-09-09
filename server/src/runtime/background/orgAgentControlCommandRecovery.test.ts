import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MemoryEventStore } from '../../__tests__/runtimeScheduler.testHelpers.js';
import type {
  OrgAgentWorkAttempt,
  OrgAgentWorkOrder,
  OrgGroupAgentStore,
} from '../../data/orgGroupAgents/index.js';
import type { RunRecord, RunStore } from '../runStore.js';
import type { RawRuntimeRunDispatchConfig } from '../rawRuntimeRunDispatch.js';
import type { SessionCatalog } from '../sessionCatalog.js';
import { buildPausedAttemptContext } from './orgAgentContinuation.js';
import { OrgAgentBackgroundWorkCoordinator } from './orgAgentBackgroundWork.js';
import { OrgAgentControlCommandUnsettledError } from './orgAgentControlCommandSettlement.js';
import {
  durableOrgAgentAttemptFixture as durableAttempt,
  liveOrgAgentBindingFixture as liveBinding,
  orgAgentChannelFixture as orgChannel,
} from './orgAgentExecutionContext.testFixtures.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('组织 Agent 控制命令阶段恢复', () => {
  it('暂停 prepared 事务因租约失效回滚时不触碰运行任务', async () => {
    const source = previousRun('tenant-1/.agent-agent-1/shared/binding-1/wc-1');
    source.status = 'running';
    const markStatusIfCurrent = vi.fn();
    const pauseWorkOrder = vi
      .fn()
      .mockRejectedValue(new Error('ORG_AGENT_FAST_CONTROL_LEASE_LOST'));
    const store = {
      getWorkOrder: vi.fn(async () => workOrder('running')),
      listWorkAttempts: vi.fn(async () => [
        durableAttempt({ status: 'running' }) as unknown as OrgAgentWorkAttempt,
      ]),
      pauseWorkOrder,
    } as unknown as OrgGroupAgentStore;
    const coordinator = new OrgAgentBackgroundWorkCoordinator({
      orgGroupAgentStore: store,
      runStore: { get: vi.fn(async () => source), markStatusIfCurrent },
    } as unknown as RawRuntimeRunDispatchConfig);

    await expect(
      coordinator.pause('tenant-1', 'work-1', 4, receipt('owner', 1, '已暂停')),
    ).rejects.toThrow('ORG_AGENT_FAST_CONTROL_LEASE_LOST');
    expect(pauseWorkOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        controlLease: expect.objectContaining({ inboxId: 'inbox-resume' }),
      }),
    );
    expect(markStatusIfCurrent).not.toHaveBeenCalled();
  });

  it('暂停 prepared 已提交后 stop 失败会固化失败命令', async () => {
    const source = previousRun('tenant-1/.agent-agent-1/shared/binding-1/wc-1');
    source.status = 'running';
    let work = workOrder('running');
    const failControlCommand = vi.fn(async () => {
      work = {
        ...work,
        control: {
          ...work.control,
          command: { ...work.control.command!, phase: 'failed', error: 'SESSION_MISSING' },
        },
      };
      return work;
    });
    const store = {
      getWorkOrder: vi.fn(async () => work),
      listWorkAttempts: vi.fn(async () => [
        durableAttempt({ status: 'running' }) as unknown as OrgAgentWorkAttempt,
      ]),
      pauseWorkOrder: vi.fn(async (input) => {
        work = { ...work, state: 'paused', version: 5, control: input.control! };
        return work;
      }),
      failControlCommand,
    } as unknown as OrgGroupAgentStore;
    const coordinator = new OrgAgentBackgroundWorkCoordinator({
      orgGroupAgentStore: store,
      runStore: { get: vi.fn(async () => source) },
      sessionCatalog: { get: vi.fn(async () => null) },
    } as unknown as RawRuntimeRunDispatchConfig);

    await expect(
      coordinator.pause('tenant-1', 'work-1', 4, receipt('owner', 1, '已暂停')),
    ).rejects.toThrow('后台任务 session 不存在');
    expect(failControlCommand).toHaveBeenCalledOnce();
    expect(work.control.command?.phase).toBe('failed');
  });

  it('暂停失败结算再次失败时保持可重领，并由新 fence 完成失败结算', async () => {
    const source = previousRun('tenant-1/.agent-agent-1/shared/binding-1/wc-1');
    source.status = 'running';
    let work = workOrder('running');
    const failControlCommand = vi
      .fn()
      .mockRejectedValueOnce(new Error('INJECTED_SETTLEMENT_FAILURE'))
      .mockImplementation(async () => {
        work = {
          ...work,
          control: {
            ...work.control,
            command: { ...work.control.command!, phase: 'failed', error: 'SESSION_MISSING' },
          },
        };
        return work;
      });
    const store = {
      getWorkOrder: vi.fn(async () => work),
      listWorkAttempts: vi.fn(async () => [
        durableAttempt({ status: 'running' }) as unknown as OrgAgentWorkAttempt,
      ]),
      pauseWorkOrder: vi.fn(async (input) => {
        work = { ...work, state: 'paused', version: 5, control: input.control! };
        return work;
      }),
      failControlCommand,
    } as unknown as OrgGroupAgentStore;
    const coordinator = new OrgAgentBackgroundWorkCoordinator({
      orgGroupAgentStore: store,
      runStore: { get: vi.fn(async () => source) },
      sessionCatalog: { get: vi.fn(async () => null) },
    } as unknown as RawRuntimeRunDispatchConfig);

    const first = coordinator.pause('tenant-1', 'work-1', 4, receipt('owner', 1, '已暂停'));
    await expect(first).rejects.toBeInstanceOf(OrgAgentControlCommandUnsettledError);
    expect(work.control.command?.phase).toBe('prepared');

    await expect(
      coordinator.pause('tenant-1', 'work-1', 5, receipt('owner', 2, '已暂停')),
    ).rejects.toThrow('后台任务 session 不存在');
    expect(failControlCommand).toHaveBeenCalledTimes(2);
    expect(work.control.command?.phase).toBe('failed');
  });

  it('activation 完成后才提交成功回执', async () => {
    const success = await retryRig();
    await expect(
      success.coordinator.retry('tenant-1', 'work-1', 4, success.options),
    ).resolves.toMatchObject({ metadata: { backgroundTaskReady: true } });
    expect(success.order).toEqual(['queue', 'session', 'attempt', 'run', 'activate', 'receipt']);
    expect(success.completeControlCommand).toHaveBeenCalledOnce();
  });

  it.each(['session', 'attempt', 'run', 'activation'] as const)(
    '%s 创建失败不会产生成功回执并固化失败命令',
    async (failAt) => {
      const failed = await retryRig(failAt);
      await expect(
        failed.coordinator.retry('tenant-1', 'work-1', 4, failed.options),
      ).rejects.toThrow(
        failAt === 'activation'
          ? 'ORG_AGENT_WORK_ORDER_RETRY_ACTIVATION_FAILED'
          : `INJECTED_${failAt.toUpperCase()}_FAILURE`,
      );
      expect(failed.completeControlCommand).not.toHaveBeenCalled();
      expect(failed.failControlCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          inboxReceipt: expect.objectContaining({ inboxId: 'inbox-resume' }),
        }),
      );
    },
  );

  it('failSetup 自身失败也不会跳过命令失败结算', async () => {
    const failed = await retryRig('run');
    vi.spyOn(failed.coordinator, 'failSetup').mockRejectedValue(
      new Error('INJECTED_CLEANUP_FAILURE'),
    );

    await expect(failed.coordinator.retry('tenant-1', 'work-1', 4, failed.options)).rejects.toThrow(
      'INJECTED_RUN_FAILURE',
    );
    expect(failed.failControlCommand).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'INJECTED_CLEANUP_FAILURE' }),
    );
    expect(failed.workOrder().control.command?.phase).toBe('failed');
  });

  it('amend 在最终回执丢失后按同一 inbox 恢复且不重复取消、建 run 或追加要求', async () => {
    const root = await mkdtemp(join(tmpdir(), 'org-agent-command-replay-'));
    roots.push(root);
    const shared = 'tenant-1/.agent-agent-1/shared/binding-1/wc-1';
    const source = previousRun(shared);
    source.status = 'running';
    const runs = new Map<string, RunRecord>([[source.runId, source]]);
    const supplement = {
      text: '补充风险清单',
      actorOpenId: 'admin-1',
      createdAt: '2026-09-09T00:00:00.000Z',
      kind: 'supplement' as const,
    };
    const command = {
      inboxId: 'inbox-amend',
      action: 'amend' as const,
      phase: 'prepared' as const,
      sourceAttemptNo: 1,
      targetAttemptNo: 2,
    };
    let work = workOrder('running');
    const attempts: OrgAgentWorkAttempt[] = [
      durableAttempt({
        status: 'running',
        checkpoint: undefined,
      }) as unknown as OrgAgentWorkAttempt,
    ];
    const queue = vi.fn(async (input) => {
      const paused = buildPausedAttemptContext(source.runId, String(source.metadata.cwd));
      attempts[0] = { ...attempts[0], status: 'cancelled', publishState: 'rejected', ...paused };
      work = { ...work, state: 'queued', version: 5, control: input.control! };
      return work;
    });
    const create = vi.fn(async (input) => {
      const existing = attempts.find((item) => item.runtimeRunId === input.runtimeRunId);
      if (existing) return existing;
      const next = durableAttempt({
        attemptId: input.attemptId,
        attemptNo: 2,
        runtimeRunId: input.runtimeRunId,
        status: 'queued',
        parentAttemptId: attempts[0].attemptId,
        taskWorkspaceId: input.taskWorkspaceId,
        sandboxScopeId: input.sandboxScopeId,
        mountSubPath: input.mountSubPath,
        sharedReadOnlySubPath: input.sharedReadOnlySubPath,
      }) as unknown as OrgAgentWorkAttempt;
      attempts.push(next);
      work = { ...work, currentAttemptNo: 2, version: work.version + 1 };
      return next;
    });
    let receiptAttempt = 0;
    const complete = vi.fn(async () => {
      receiptAttempt += 1;
      if (receiptAttempt === 1) throw new Error('ORG_AGENT_FAST_CONTROL_LEASE_LOST');
      work = { ...work, control: { ...work.control, command: { ...command, phase: 'completed' } } };
      return work;
    });
    const stopCalls = vi.fn();
    const runStore = runStoreFor(runs, undefined, stopCalls);
    const store = {
      getWorkOrder: vi.fn(async () => work),
      getBindingById: vi.fn(async () => liveBinding()),
      listWorkAttempts: vi.fn(async () => attempts),
      queueWorkOrderAttempt: queue,
      createWorkAttempt: create,
      transitionWorkAttempt: vi.fn(async () => null),
      transitionWorkOrder: vi.fn(),
      completeControlCommand: complete,
      failControlCommand: vi.fn(),
    } as unknown as OrgGroupAgentStore;
    const coordinator = coordinatorFor(root, store, runStore);
    const control = {
      revision: 2,
      workerType: 'general' as const,
      supplements: [supplement],
      command,
    };
    const firstReceipt = receipt('old-owner', 1, '已补充');
    await expect(
      coordinator.retry('tenant-1', 'work-1', 4, {
        control,
        supersedeActiveAttempt: true,
        supersedePendingCompletion: true,
        inboxReceipt: firstReceipt,
      }),
    ).rejects.toBeInstanceOf(OrgAgentControlCommandUnsettledError);
    await expect(
      coordinator.retry('tenant-1', 'work-1', work.version, {
        control: work.control,
        supersedePendingCompletion: true,
        inboxReceipt: receipt('new-owner', 2, '已补充'),
      }),
    ).resolves.toMatchObject({ metadata: { backgroundTaskReady: true } });

    expect(queue).toHaveBeenCalledOnce();
    expect(stopCalls).toHaveBeenCalledOnce();
    expect(runStore.upsertPending).toHaveBeenCalledOnce();
    expect(runStore.activateStagedOrgAgentBackgroundTask).toHaveBeenCalledOnce();
    expect(attempts).toHaveLength(2);
    expect(work.control.supplements).toEqual([supplement]);
    expect(work.control.command?.phase).toBe('completed');
  });
});

async function retryRig(failAt?: 'session' | 'attempt' | 'run' | 'activation') {
  const root = await mkdtemp(join(tmpdir(), 'org-agent-command-order-'));
  roots.push(root);
  const source = previousRun('tenant-1/.agent-agent-1/shared/binding-1/wc-1');
  const runs = new Map<string, RunRecord>([[source.runId, source]]);
  let work = workOrder('failed');
  const attempts: OrgAgentWorkAttempt[] = [durableAttempt() as unknown as OrgAgentWorkAttempt];
  const order: string[] = [];
  const completeControlCommand = vi.fn(async () => {
    order.push('receipt');
    return work;
  });
  const failControlCommand = vi.fn(async (input) => {
    work = {
      ...work,
      control: {
        ...work.control,
        command: { ...work.control.command!, phase: 'failed', error: input.error },
      },
    };
    return work;
  });
  const store = {
    getWorkOrder: vi.fn(async () => work),
    getBindingById: vi.fn(async () => liveBinding()),
    listWorkAttempts: vi.fn(async () => attempts),
    queueWorkOrderAttempt: vi.fn(async (input) => {
      order.push('queue');
      work = { ...work, state: 'queued', version: 5, control: input.control! };
      return work;
    }),
    createWorkAttempt: vi.fn(async (input) => {
      order.push('attempt');
      if (failAt === 'attempt') throw new Error('INJECTED_ATTEMPT_FAILURE');
      const next = durableAttempt({
        attemptId: input.attemptId,
        attemptNo: 2,
        runtimeRunId: input.runtimeRunId,
        status: 'queued',
      });
      const typedNext = next as unknown as OrgAgentWorkAttempt;
      attempts.push(typedNext);
      work = { ...work, currentAttemptNo: 2, version: 6 };
      return typedNext;
    }),
    transitionWorkAttempt: vi.fn(async () => attempts[1] ?? null),
    transitionWorkOrder: vi.fn(async (input) => (work = { ...work, state: input.state })),
    completeControlCommand,
    failControlCommand,
  } as unknown as OrgGroupAgentStore;
  const runStore = runStoreFor(runs, failAt, vi.fn(), order);
  const coordinator = coordinatorFor(root, store, runStore, order, failAt === 'session');
  const command = {
    inboxId: 'inbox-resume',
    action: 'resume' as const,
    phase: 'prepared' as const,
    sourceAttemptNo: 1,
    targetAttemptNo: 2,
  };
  return {
    coordinator,
    order,
    completeControlCommand,
    failControlCommand,
    workOrder: () => work,
    options: {
      control: { revision: 1, workerType: 'general' as const, supplements: [], command },
      inboxReceipt: receipt('owner', 1, '已恢复'),
    },
  };
}

function workOrder(state: 'running' | 'failed'): OrgAgentWorkOrder {
  return {
    workOrderId: 'work-1',
    shortId: 'W-123456ABCDEF',
    tenantId: 'tenant-1',
    agentId: 'agent-1',
    bindingId: 'binding-1',
    workConversationId: 'wc-1',
    idempotencyKey: 'key',
    title: '任务',
    state,
    currentAttemptNo: 1,
    visibility: 'conversation',
    createdByActor: orgChannel.externalActor,
    policySnapshot: {},
    cancelPolicy: {},
    control: { revision: 1, supplements: [], workerType: 'general' },
    version: 4,
    createdAt: now(),
    updatedAt: now(),
  };
}

function previousRun(sharedReadOnlySubPath: string): RunRecord {
  return {
    runId: 'run-1',
    sessionId: 'session-1',
    userId: 'service-user',
    tenantId: 'tenant-1',
    model: 'model-1',
    channel: 'background_task',
    status: 'failed',
    executionTarget: 'server-container',
    requestedAt: now(),
    updatedAt: now(),
    metadata: {
      backgroundTask: true,
      backgroundTaskType: 'agent',
      parentRunId: 'parent-run',
      parentSessionId: 'parent-session',
      parentToolCallId: 'tool-1',
      description: '整理异常',
      prompt: '执行',
      agentType: 'general',
      modelRef: 'models/model-1',
      cwd: '/old-task',
      workspaceId: 'old-workspace',
      workOrderId: 'work-1',
      attemptId: 'attempt-1',
      attemptNo: 1,
      sharedReadOnlySubPath,
      orgAgentChannel: orgChannel,
    },
  } as RunRecord;
}

function runStoreFor(
  runs: Map<string, RunRecord>,
  failAt: 'session' | 'attempt' | 'run' | 'activation' | undefined,
  stopCalls: () => void,
  order: string[] = [],
): RunStore {
  return {
    get: vi.fn(async (id) => runs.get(id) ?? null),
    upsertPending: vi.fn(async (input) => {
      if (failAt === 'run') throw new Error('INJECTED_RUN_FAILURE');
      order.push('run');
      const run = { ...input, status: 'pending', updatedAt: now() } as RunRecord;
      runs.set(run.runId, run);
      return run;
    }),
    activateStagedOrgAgentBackgroundTask: vi.fn(async (id) => {
      order.push('activate');
      if (failAt === 'activation') return null;
      const run = runs.get(id)!;
      const active = { ...run, metadata: { ...run.metadata, backgroundTaskReady: true } };
      runs.set(id, active);
      return active;
    }),
    markStatusIfCurrent: vi.fn(async (id, _from, status, reason, patch) => {
      stopCalls();
      const run = runs.get(id)!;
      const stopped = {
        ...run,
        status,
        statusReason: reason,
        metadata: { ...run.metadata, ...patch },
        updatedAt: now(),
      } as RunRecord;
      runs.set(id, stopped);
      return stopped;
    }),
  } as unknown as RunStore;
}

function coordinatorFor(
  root: string,
  store: OrgGroupAgentStore,
  runStore: RunStore,
  order: string[] = [],
  failSession = false,
): OrgAgentBackgroundWorkCoordinator {
  const session = {
    sessionId: 'session-1',
    userId: 'service-user',
    username: 'agent-dws:agent-1',
    userRole: 'user' as const,
    tenantId: 'tenant-1',
    channel: 'dingtalk',
    cwd: '/old-task',
    modelRef: 'models/model-1',
    executionTarget: 'server-container' as const,
    workspaceId: 'old-workspace',
    status: 'running' as const,
    createdAt: now(),
    updatedAt: now(),
    orgAgentId: 'agent-1',
    orgAgentSnapshot: {} as never,
    principal: orgChannel.agentPrincipal,
  };
  const catalog = {
    get: vi.fn(async () => session),
    upsert: vi.fn(async () => {
      if (failSession) throw new Error('INJECTED_SESSION_FAILURE');
      order.push('session');
    }),
    markStatus: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionCatalog;
  const config = {
    agentCwd: root,
    orgGroupAgentStore: store,
    runStore,
    sessionCatalog: catalog,
    eventStoreFactory: () => new MemoryEventStore(),
  };
  return new OrgAgentBackgroundWorkCoordinator(config as unknown as RawRuntimeRunDispatchConfig);
}

function receipt(owner: string, leaseFence: number, responseText: string) {
  return {
    inboxId: owner === 'owner' ? 'inbox-resume' : 'inbox-amend',
    leaseOwner: owner,
    leaseFence,
    responseText,
  };
}

function now(): string {
  return '2026-09-09T00:00:00.000Z';
}

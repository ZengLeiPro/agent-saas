import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OrgGroupAgentStore } from '../../data/orgGroupAgents/index.js';
import type { RunRecord, RunStore } from '../runStore.js';
import type { RawRuntimeRunDispatchConfig } from '../rawRuntimeRunDispatch.js';
import type { SessionCatalog } from '../sessionCatalog.js';
import { isOrgTaskVisible, OrgAgentBackgroundWorkCoordinator } from './orgAgentBackgroundWork.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const orgChannel = {
  bindingId: 'binding-1',
  accountId: 'account-1',
  agentId: 'agent-1',
  conversationSpaceId: 'space-1',
  workConversationId: 'wc-1',
  policyRevision: 3,
  agentPrincipal: {
    kind: 'org_agent' as const,
    tenantId: 'tenant-1',
    agentId: 'agent-1',
    accountId: 'account-1',
    workspaceId: 'ws_tenant-1__agent_agent-1',
  },
  externalActorAssurance: 'mapped' as const,
  allowedToolNames: ['Agent'],
  allowedSourceIds: [],
  contextEnabled: false,
  externalActor: {
    kind: 'external_user' as const,
    provider: 'dingtalk' as const,
    corpId: 'corp-1',
    openId: 'caller-1',
    assurance: 'mapped' as const,
    mappedUserId: 'user-1',
  },
  channelPrincipal: {
    provider: 'dingtalk' as const,
    accountId: 'account-1',
    conversationId: 'group-1',
    kind: 'group' as const,
  },
};

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

describe('OrgAgentBackgroundWorkCoordinator', () => {
  it('creates a distinct retry attempt, session, workspace and pending runtime run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'org-agent-retry-'));
    roots.push(root);
    const previous = previousRun('tenant-1/.agent-agent-1');
    const work = {
      workOrderId: 'work-1',
      tenantId: 'tenant-1',
      agentId: 'agent-1',
      bindingId: 'binding-1',
      workConversationId: 'wc-1',
      idempotencyKey: 'key',
      title: '整理异常',
      state: 'failed' as const,
      currentAttemptNo: 1,
      visibility: 'conversation' as const,
      createdByActor: orgChannel.externalActor,
      policySnapshot: {},
      cancelPolicy: {},
      version: 4,
      createdAt: previous.requestedAt,
      updatedAt: previous.updatedAt,
    };
    const store = {
      getWorkOrder: vi.fn().mockResolvedValue(work),
      listWorkAttempts: vi
        .fn()
        .mockResolvedValue([{ attemptId: 'attempt-1', runtimeRunId: 'run-1' }]),
      reopenWorkOrder: vi.fn().mockResolvedValue({ ...work, state: 'queued', version: 5 }),
      createWorkAttempt: vi.fn().mockResolvedValue(undefined),
      transitionWorkAttempt: vi.fn(),
      transitionWorkOrder: vi.fn(),
    } as unknown as OrgGroupAgentStore;
    const upsertPending = vi
      .fn()
      .mockImplementation(async (value) => ({
        ...value,
        status: 'pending',
        createdAt: new Date(),
        updatedAt: new Date(),
      }));
    const runStore = {
      get: vi.fn().mockResolvedValue(previous),
      upsertPending,
    } as unknown as RunStore;
    const upsertSession = vi.fn();
    const sessionCatalog = {
      get: vi
        .fn()
        .mockResolvedValue({
          sessionId: 'session-1',
          userId: 'service-user',
          username: 'agent-dws:agent-1',
          userRole: 'user',
          tenantId: 'tenant-1',
          channel: 'dingtalk',
          cwd: '/old-task',
          modelRef: 'models/model-1',
          executionTarget: 'server-container',
          workspaceId: 'old-workspace',
          status: 'error',
          principal: orgChannel.agentPrincipal,
        }),
      upsert: upsertSession,
    } as unknown as SessionCatalog;
    const coordinator = new OrgAgentBackgroundWorkCoordinator({
      agentCwd: root,
      orgGroupAgentStore: store,
      runStore,
      sessionCatalog,
    } as unknown as RawRuntimeRunDispatchConfig);

    const retried = await coordinator.retry('tenant-1', 'work-1', 4);

    expect(store.reopenWorkOrder).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      workOrderId: 'work-1',
      expectedVersion: 4,
    });
    expect(store.createWorkAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        parentAttemptId: 'attempt-1',
        workOrderId: 'work-1',
        mountSubPath: expect.stringContaining('attempt-2'),
        sharedReadOnlySubPath: 'tenant-1/.agent-agent-1',
      }),
    );
    expect(upsertSession).toHaveBeenCalledWith(
      expect.objectContaining({
        principal: orgChannel.agentPrincipal,
        workspaceId: expect.stringContaining('__task_'),
      }),
    );
    expect(retried.runId).not.toBe(previous.runId);
    expect(retried.metadata).toMatchObject({
      workOrderId: 'work-1',
      attemptNo: 2,
      sharedReadOnlySubPath: 'tenant-1/.agent-agent-1',
    });
  });

  it('keeps unmapped guest task visibility creator-only within the same WorkConversation', () => {
    const task = previousRun('tenant-1/.agent-agent-1');
    const unmappedChannel = {
      ...orgChannel,
      externalActorAssurance: 'unmapped' as const,
      externalActor: {
        ...orgChannel.externalActor,
        assurance: 'unmapped' as const,
        mappedUserId: undefined,
      },
    };
    task.metadata.orgAgentChannel = unmappedChannel;
    const sameGuest = {
      channelContext: { orgAgentChannel: unmappedChannel },
      workspace: {},
    } as never;
    const anotherGuest = {
      channelContext: {
        orgAgentChannel: {
          ...unmappedChannel,
          externalActor: { ...unmappedChannel.externalActor, openId: 'caller-2' },
        },
      },
      workspace: {},
    } as never;
    expect(isOrgTaskVisible(task, sameGuest)).toBe(true);
    expect(isOrgTaskVisible(task, anotherGuest)).toBe(false);
  });
});

function now(): string {
  return '2026-09-04T00:00:00.000Z';
}

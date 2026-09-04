import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../security/trustedFile.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../security/trustedFile.js')>();
  const [{ readFile }, { join: joinPath }] = await Promise.all([
    import('node:fs/promises'),
    import('node:path'),
  ]);
  return {
    ...actual,
    readTrustedFile: async (root: string, path: string) => await readFile(joinPath(root, path)),
  };
});

import { MemoryEventStore } from '../../__tests__/runtimeScheduler.testHelpers.js';
import type { OrgAgentWorkOrder, OrgGroupAgentStore } from '../../data/orgGroupAgents/index.js';
import type { RunRecord, RunStore } from '../runStore.js';
import type { RawRuntimeRunDispatchConfig } from '../rawRuntimeRunDispatch.js';
import type { SessionCatalog } from '../sessionCatalog.js';
import {
  isOrgTaskVisible,
  OrgAgentBackgroundWorkCoordinator,
  prepareOrgAgentBackgroundWork,
} from './orgAgentBackgroundWork.js';
import { verifyOrgAgentContinuationArtifacts } from './orgAgentContinuation.js';

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
  allowedSkillIds: [],
  allowedSourceIds: [],
  contextEnabled: false,
  taskVisibility: 'conversation' as const,
  actorRole: 'member' as const,
  triggerRoles: [],
  approvalRoles: [],
  externalActor: {
    kind: 'external_user' as const,
    provider: 'dingtalk' as const,
    corpId: 'corp-1',
    openId: 'caller-1',
    assurance: 'mapped' as const,
    mappedUserId: 'user-1',
    role: 'member' as const,
  },
  channelPrincipal: {
    provider: 'dingtalk' as const,
    accountId: 'account-1',
    conversationId: 'group-1',
    kind: 'group' as const,
  },
};

function liveBinding() {
  return {
    bindingId: 'binding-1',
    tenantId: 'tenant-1',
    accountId: 'account-1',
    agentId: 'agent-1',
    workspaceId: 'ws_tenant-1__agent_agent-1',
    revision: 3,
    effectiveConfig: {
      identity: {},
      instructions: { system: '' },
      knowledge: { contextEnabled: false, sourceIds: [] },
      capabilities: { skillIds: [], toolNames: [], dwsResourceIds: [] },
      memory: { readAgent: true, readConversation: true, adminWriteConversation: true },
      access: { triggerRoles: [], approvalRoles: [] },
      speech: { proactive: false, requireMention: true },
    },
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

function durableAttempt(overrides: Record<string, unknown> = {}) {
  return {
    attemptId: 'attempt-1',
    runtimeRunId: 'run-1',
    attemptNo: 1,
    status: 'failed',
    publishState: 'rejected',
    checkpoint: { runtimeRunId: 'run-1', status: 'failed', finishedAt: now() },
    resultEnvelope: {
      status: 'failed',
      summary: '上一轮已定位异常行',
      facts: [{ key: 'checkedRows', value: '120' }],
      artifacts: [],
      writeScope: ['/old-task'],
    },
    ...overrides,
  };
}

describe('OrgAgentBackgroundWorkCoordinator', () => {
  it('derives an isolated task mount beside the exact read-only shared topic view', async () => {
    const root = await mkdtemp(join(tmpdir(), 'org-agent-layout-'));
    roots.push(root);
    const shared = 'tenant-1/.agent-agent-1/shared/binding-1/wc-1';
    const createdWork = { workOrderId: 'work-1' };
    const result = await prepareOrgAgentBackgroundWork({
      config: {
        agentCwd: root,
        orgGroupAgentStore: {
          getBindingById: vi.fn().mockResolvedValue(liveBinding()),
          createWorkOrder: vi.fn().mockResolvedValue(createdWork),
        },
      } as never,
      context: {
        runId: 'parent-run', toolCallId: 'tool-1',
        workspace: { root, mountSubPath: shared },
        channelContext: { orgAgentChannel: orgChannel },
      } as never,
      request: { description: '整理异常', prompt: '执行', agentType: 'general',
        includeCompanyInfo: false },
      parentRunId: 'parent-run', toolCallId: 'tool-1', taskId: 'task-1',
    });

    expect(result.workOrder).toBe(createdWork);
    expect(result.taskLayout).toMatchObject({
      sharedReadOnlySubPath: shared,
      mountSubPath: expect.stringMatching(/tenant-1\/\.agent-agent-1\/work\/task-1\/attempt-1$/),
    });
    expect(result.taskLayout!.mountSubPath).not.toContain('/shared/');
    expect(result.taskLayout!.taskRoot).toContain('/.agent-agent-1/work/task-1/attempt-1');
  });

  it('creates a distinct retry attempt, session, workspace and pending runtime run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'org-agent-retry-'));
    roots.push(root);
    const previous = previousRun('tenant-1/.agent-agent-1/shared/binding-1/wc-1');
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
      getBindingById: vi.fn().mockResolvedValue(liveBinding()),
      listWorkAttempts: vi.fn().mockResolvedValue([durableAttempt()]),
      queueWorkOrderAttempt: vi
        .fn()
        .mockResolvedValue({
          ...work,
          state: 'queued',
          version: 5,
          shortId: 'W-123456ABCDEF',
          control: { revision: 1, supplements: [], workerType: 'general' },
        }),
      createWorkAttempt: vi.fn().mockResolvedValue(undefined),
      transitionWorkAttempt: vi.fn(),
      transitionWorkOrder: vi.fn(),
    } as unknown as OrgGroupAgentStore;
    let stagedRunRecord: RunRecord | undefined;
    const upsertPending = vi
      .fn()
      .mockImplementation(async (value) => (stagedRunRecord = {
        ...value as RunRecord,
        status: 'pending',
        updatedAt: now(),
      }));
    const runStore = {
      get: vi.fn().mockResolvedValue(previous),
      upsertPending,
      activateStagedOrgAgentBackgroundTask: vi.fn().mockImplementation(async (runId, _reason, metadata) => {
        if (!stagedRunRecord) throw new Error('staged run missing');
        stagedRunRecord = {
          ...stagedRunRecord,
          runId,
          metadata: { ...stagedRunRecord.metadata, ...metadata, backgroundTaskReady: true },
        };
        return stagedRunRecord;
      }),
      markStatus: vi.fn().mockImplementation(async (runId, status, _reason, metadata) => {
        if (!stagedRunRecord) throw new Error('staged run missing');
        stagedRunRecord = {
          ...stagedRunRecord,
          runId,
          status,
          metadata: { ...stagedRunRecord.metadata, ...metadata },
        };
        return stagedRunRecord;
      }),
    } as unknown as RunStore;
    const upsertSession = vi.fn();
    const sessionCatalog = {
      get: vi.fn().mockResolvedValue({
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
        orgAgentId: 'agent-1',
        orgAgentSnapshot: {} as never,
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

    expect(store.queueWorkOrderAttempt).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      workOrderId: 'work-1',
      expectedVersion: 4,
    });
    expect(store.createWorkAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        parentAttemptId: 'attempt-1',
        workOrderId: 'work-1',
        mountSubPath: expect.stringContaining('attempt-2'),
        sharedReadOnlySubPath: 'tenant-1/.agent-agent-1/shared/binding-1/wc-1',
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
      sharedReadOnlySubPath: 'tenant-1/.agent-agent-1/shared/binding-1/wc-1',
    });
  });

  it('rejects retry metadata that points at another tenant or workspace before queueing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'org-agent-retry-scope-'));
    roots.push(root);
    const work = {
      workOrderId: 'work-1',
      tenantId: 'tenant-1',
      agentId: 'agent-1',
      bindingId: 'binding-1',
      workConversationId: 'wc-1',
      state: 'failed',
      currentAttemptNo: 1,
      version: 4,
    } as unknown as OrgAgentWorkOrder;
    for (const scenario of ['foreign_mount', 'foreign_principal', 'foreign_session_workspace']) {
      const previous = previousRun(
        scenario === 'foreign_mount'
          ? 'tenant-b/.agent-agent-b/shared/binding-1/wc-1'
          : 'tenant-1/.agent-agent-1/shared/binding-1/wc-1',
      );
      if (scenario === 'foreign_principal') {
        previous.metadata.orgAgentChannel = {
          ...orgChannel,
          agentPrincipal: { ...orgChannel.agentPrincipal, tenantId: 'tenant-b' },
        };
      }
      const queueWorkOrderAttempt = vi.fn();
      const coordinator = new OrgAgentBackgroundWorkCoordinator({
        agentCwd: root,
        orgGroupAgentStore: {
          getWorkOrder: vi.fn().mockResolvedValue(work),
          getBindingById: vi.fn().mockResolvedValue(liveBinding()),
          listWorkAttempts: vi.fn().mockResolvedValue([durableAttempt()]),
          queueWorkOrderAttempt,
        },
        runStore: { get: vi.fn().mockResolvedValue(previous), upsertPending: vi.fn() },
        sessionCatalog: {
          get: vi.fn().mockResolvedValue({
            sessionId: 'session-1',
            userId: 'service-user',
            username: 'agent-dws:agent-1',
            tenantId: 'tenant-1',
            channel: 'dingtalk',
            cwd: '/old-task',
            orgAgentId: 'agent-1',
            orgAgentSnapshot: {} as never,
            principal:
              scenario === 'foreign_session_workspace'
                ? { ...orgChannel.agentPrincipal, workspaceId: 'ws_tenant-b__agent_agent-b' }
                : orgChannel.agentPrincipal,
          }),
          upsert: vi.fn(),
        },
      } as never);
      await expect(coordinator.retry('tenant-1', 'work-1', 4)).rejects.toThrow(
        scenario === 'foreign_mount'
          ? 'ORG_AGENT_WORK_ORDER_SHARED_ROOT_MISMATCH'
          : 'ORG_AGENT_WORK_ORDER_IDENTITY_MISMATCH',
      );
      expect(queueWorkOrderAttempt).not.toHaveBeenCalled();
    }
  });

  it('rebuilds every attempt from one immutable base prompt without accumulating continuations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'org-agent-prompt-'));
    roots.push(root);
    const sharedReadOnlySubPath = 'tenant-1/.agent-agent-1/shared/binding-1/wc-1';
    const first = previousRun(sharedReadOnlySubPath);
    first.metadata.prompt = 'P';
    delete first.metadata.basePrompt;
    const runs = new Map<string, RunRecord>([[first.runId, first]]);
    const attempts = [durableAttempt({ runtimeRunId: first.runId })];
    let work: OrgAgentWorkOrder = {
      workOrderId: 'work-1', tenantId: 'tenant-1', agentId: 'agent-1', bindingId: 'binding-1',
      workConversationId: 'wc-1', idempotencyKey: 'key', title: '整理异常', state: 'failed' as const,
      currentAttemptNo: 1, visibility: 'conversation' as const, createdByActor: orgChannel.externalActor,
      policySnapshot: {}, cancelPolicy: {}, version: 1, createdAt: now(), updatedAt: now(),
      shortId: 'W-123456ABCDEF',
      control: { revision: 1, supplements: [], workerType: 'general' as const },
    };
    const store = {
      getWorkOrder: vi.fn().mockImplementation(async () => work),
      getBindingById: vi.fn().mockResolvedValue(liveBinding()),
      listWorkAttempts: vi.fn().mockImplementation(async () => [...attempts]),
      queueWorkOrderAttempt: vi.fn().mockImplementation(async (input) => {
        work = {
          ...work,
          state: 'queued' as const,
          currentAttemptNo: work.currentAttemptNo + 1,
          version: work.version + 1,
          control: input.control ?? work.control,
        };
        return work;
      }),
      createWorkAttempt: vi.fn().mockImplementation(async (input) => {
        attempts.push({
          attemptId: input.attemptId,
          runtimeRunId: input.runtimeRunId,
          attemptNo: work.currentAttemptNo,
          status: 'failed',
          publishState: 'rejected',
          checkpoint: { runtimeRunId: input.runtimeRunId, status: 'failed', finishedAt: now() },
          resultEnvelope: {
            status: 'failed',
            summary: `attempt ${work.currentAttemptNo}`,
            facts: [],
            artifacts: [],
            writeScope: [],
          },
        });
      }),
      transitionWorkAttempt: vi.fn(),
      transitionWorkOrder: vi.fn(),
    } as unknown as OrgGroupAgentStore;
    const runStore = {
      get: vi.fn().mockImplementation(async (runId) => runs.get(runId) ?? null),
      upsertPending: vi.fn().mockImplementation(async (value) => {
        const run = { ...value, status: 'pending', updatedAt: now() } as RunRecord;
        runs.set(run.runId, run);
        return run;
      }),
      activateStagedOrgAgentBackgroundTask: vi.fn().mockImplementation(async (runId, _reason, patch) => {
        const run = runs.get(runId);
        if (!run) return null;
        const activated = { ...run, metadata: { ...run.metadata, ...patch } };
        runs.set(runId, activated);
        return activated;
      }),
    } as unknown as RunStore;
    const sessionCatalog = {
      get: vi.fn().mockResolvedValue({
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
        orgAgentId: 'agent-1',
        orgAgentSnapshot: {} as never,
        principal: orgChannel.agentPrincipal,
      }),
      upsert: vi.fn(),
    } as unknown as SessionCatalog;
    const coordinator = new OrgAgentBackgroundWorkCoordinator({
      agentCwd: root, orgGroupAgentStore: store, runStore, sessionCatalog,
    } as unknown as RawRuntimeRunDispatchConfig);
    const supplement = (text: string) => ({
      text, actorOpenId: 'admin-1', createdAt: now(), kind: 'supplement' as const,
    });

    const second = await coordinator.retry('tenant-1', 'work-1', 1, {
      control: { revision: 2, workerType: 'general', supplements: [supplement('A')] },
    });
    const third = await coordinator.retry('tenant-1', 'work-1', 2, {
      control: {
        revision: 3, workerType: 'general', supplements: [supplement('A'), supplement('B')],
      },
    });
    const fourth = await coordinator.retry('tenant-1', 'work-1', 3, {
      control: { revision: 4, workerType: 'general', supplements: [supplement('B')] },
    });

    expect(second.metadata).toMatchObject({ basePrompt: 'P', attemptNo: 2 });
    expect(second.metadata.prompt).toContain('P\n\n<work-order-prior-attempt');
    expect(second.metadata.prompt).toContain('上一轮已定位异常行');
    expect(second.metadata.prompt).toContain(
      '<work-order-continuation revision="2">\n1. [补充要求] A\n</work-order-continuation>',
    );
    expect(third.metadata).toMatchObject({ basePrompt: 'P', attemptNo: 3 });
    expect(third.metadata.prompt).toContain(
      '<work-order-continuation revision="3">\n1. [补充要求] A\n2. [补充要求] B\n</work-order-continuation>',
    );
    expect(third.metadata.prompt).not.toContain('revision=\"2\"');
    expect(fourth.metadata).toMatchObject({ basePrompt: 'P', attemptNo: 4 });
    expect(fourth.metadata.prompt).toContain(
      '<work-order-continuation revision="4">\n1. [补充要求] B\n</work-order-continuation>',
    );
    expect(fourth.metadata.prompt).not.toContain('revision=\"3\"');
  });

  it('injects the previous result and published artifacts as an explicit read-only continuation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'org-agent-published-continuation-'));
    roots.push(root);
    const previous = previousRun('tenant-1/.agent-agent-1/shared/binding-1/wc-1');
    previous.status = 'completed';
    const work = {
      workOrderId: 'work-1',
      tenantId: 'tenant-1',
      agentId: 'agent-1',
      bindingId: 'binding-1',
      workConversationId: 'wc-1',
      state: 'completed',
      currentAttemptNo: 1,
      version: 2,
      control: { revision: 1, supplements: [], workerType: 'general' },
    } as unknown as OrgAgentWorkOrder;
    const publishedContent = Buffer.from('x'.repeat(12));
    const publishedDigest = `sha256:${createHash('sha256').update(publishedContent).digest('hex')}`;
    const attempt = durableAttempt({
      status: 'completed',
      publishState: 'published',
      resultEnvelope: {
        status: 'completed',
        summary: '完成初稿',
        facts: [],
        artifacts: [{ path: '报告.md', digest: publishedDigest, size: 12 }],
        writeScope: ['/old-task'],
      },
      artifactManifest: {
        version: 1,
        files: [{ path: '报告.md', digest: publishedDigest, size: 12 }],
        totalBytes: 12,
        capturedAt: now(),
        publishedRoot: 'published/work-1/attempt-1',
      },
    });
    const publishedRoot = join(
      root,
      'tenant-1',
      '.agent-agent-1',
      'shared',
      'binding-1',
      'wc-1',
      'published',
      'work-1',
      'attempt-1',
    );
    await mkdir(publishedRoot, { recursive: true });
    await writeFile(join(publishedRoot, '报告.md'), publishedContent);
    let staged: RunRecord | undefined;
    const store = {
      getWorkOrder: vi.fn().mockResolvedValue(work),
      getBindingById: vi.fn().mockResolvedValue(liveBinding()),
      listWorkAttempts: vi.fn().mockResolvedValue([attempt]),
      queueWorkOrderAttempt: vi.fn().mockResolvedValue({ ...work, state: 'queued', version: 3 }),
      createWorkAttempt: vi.fn(),
      transitionWorkAttempt: vi.fn(),
      transitionWorkOrder: vi.fn(),
    } as unknown as OrgGroupAgentStore;
    const runStore = {
      get: vi.fn().mockResolvedValue(previous),
      upsertPending: vi.fn().mockImplementation(async (value) => {
        staged = { ...value, status: 'pending', updatedAt: now() } as RunRecord;
        return staged;
      }),
      activateStagedOrgAgentBackgroundTask: vi
        .fn()
        .mockImplementation(async (_id, _reason, patch) => {
          staged = { ...staged!, metadata: { ...staged!.metadata, ...patch } };
          return staged;
        }),
    } as unknown as RunStore;
    const sessionCatalog = {
      get: vi.fn().mockResolvedValue({
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
        status: 'idle',
        orgAgentId: 'agent-1',
        orgAgentSnapshot: {} as never,
        principal: orgChannel.agentPrincipal,
      }),
      upsert: vi.fn(),
    } as unknown as SessionCatalog;

    const retried = await new OrgAgentBackgroundWorkCoordinator({
      agentCwd: root,
      orgGroupAgentStore: store,
      runStore,
      sessionCatalog,
    } as unknown as RawRuntimeRunDispatchConfig).retry('tenant-1', 'work-1', 2);

    expect(retried.metadata.basePrompt).toBe('执行');
    expect(retried.metadata.prompt).toContain('完成初稿');
    expect(retried.metadata.prompt).toContain('报告.md');
    expect(retried.metadata.prompt).toContain('/agent-shared/published/work-1/attempt-1');
    expect(retried.metadata.continuationSource).toMatchObject({
      attemptId: 'attempt-1',
      artifactCount: 1,
      publishedArtifactsRoot: '/agent-shared/published/work-1/attempt-1',
    });
    expect(retried.metadata.mountSubPath).not.toBe(previous.metadata.mountSubPath);
  });

  it('requires a completed attempt artifact decision before opening a retry', async () => {
    const store = {
      getWorkOrder: vi.fn().mockResolvedValue({
        workOrderId: 'work-1', tenantId: 'tenant-1', state: 'completed', currentAttemptNo: 1,
      }),
      listWorkAttempts: vi.fn().mockResolvedValue([{
        attemptId: 'attempt-1', runtimeRunId: 'run-1', status: 'completed', publishState: 'pending',
      }]),
      reopenWorkOrder: vi.fn(),
    } as unknown as OrgGroupAgentStore;
    const coordinator = new OrgAgentBackgroundWorkCoordinator({
      agentCwd: '/tmp', orgGroupAgentStore: store, runStore: { upsertPending: vi.fn() },
    } as unknown as RawRuntimeRunDispatchConfig);

    await expect(coordinator.retry('tenant-1', 'work-1', 1))
      .rejects.toThrow('ORG_AGENT_ARTIFACT_PUBLISH_REQUIRED_BEFORE_RETRY');
    expect(store.reopenWorkOrder).not.toHaveBeenCalled();
  });

  it('keeps unmapped guest task visibility creator-only within the same WorkConversation', () => {
    const task = previousRun('tenant-1/.agent-agent-1');
    const unmappedChannel = {
      ...orgChannel,
      externalActorAssurance: 'unmapped' as const,
      actorRole: undefined,
      externalActor: {
        ...orgChannel.externalActor,
        assurance: 'unmapped' as const,
        mappedUserId: undefined,
        role: undefined,
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

  it('preserves a completed runtime run when cancel races before WorkOrder terminal sync', async () => {
    const work = { workOrderId: 'work-1', tenantId: 'tenant-1', state: 'running' as const,
      currentAttemptNo: 1, version: 3 };
    const attempt = { attemptId: 'attempt-1', workOrderId: 'work-1', runtimeRunId: 'run-1',
      attemptNo: 1, status: 'running' as const };
    const store = {
      getWorkOrder: vi.fn().mockResolvedValue(work),
      listWorkAttempts: vi.fn().mockResolvedValue([attempt]),
      transitionWorkAttempt: vi.fn().mockResolvedValue({ ...attempt, status: 'completed' }),
      transitionWorkOrder: vi.fn().mockResolvedValue({ ...work, state: 'completed' }),
    } as unknown as OrgGroupAgentStore;
    const completed = previousRun('tenant-1/.agent-agent-1/shared/binding-1/wc-1');
    completed.status = 'completed';
    completed.metadata.backgroundResult = {
      status: 'completed', text: '完成', totalTokens: 1, toolUseCount: 0, turnCount: 1,
      durationMs: 10,
    };
    const coordinator = new OrgAgentBackgroundWorkCoordinator({
      orgGroupAgentStore: store,
      runStore: { get: vi.fn().mockResolvedValue(completed) },
    } as never);

    await expect(coordinator.cancel('tenant-1', 'work-1', 3)).resolves.toBe(completed);
    expect(store.transitionWorkOrder).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'completed' }),
    );
    expect(store.transitionWorkAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed' }),
    );
  });

  it('marks the runtime attempt superseded before durably pausing the WorkOrder', async () => {
    const work = { workOrderId: 'work-1', tenantId: 'tenant-1', state: 'running' as const,
      currentAttemptNo: 1, version: 3 };
    const attempt = { attemptId: 'attempt-1', workOrderId: 'work-1', runtimeRunId: 'run-1',
      attemptNo: 1, status: 'running' as const };
    const task = previousRun('tenant-1/.agent-agent-1/shared/binding-1/wc-1');
    task.status = 'running';
    const runStore = {
      get: vi.fn().mockResolvedValue(task),
      markStatusIfCurrent: vi.fn().mockImplementation(async (_runId, _from, status, reason, patch) => ({
        ...task,
        status,
        statusReason: reason,
        metadata: { ...task.metadata, ...patch },
      })),
    } as unknown as RunStore;
    const store = {
      getWorkOrder: vi.fn().mockResolvedValue(work),
      listWorkAttempts: vi.fn().mockResolvedValue([attempt]),
      pauseWorkOrder: vi.fn().mockResolvedValue({ ...work, state: 'paused', version: 4 }),
      transitionWorkAttempt: vi.fn().mockResolvedValue({
        ...attempt,
        status: 'cancelled',
        workOrderId: 'work-1',
      }),
    } as unknown as OrgGroupAgentStore;
    const coordinator = new OrgAgentBackgroundWorkCoordinator({
      agentCwd: '/tmp', orgGroupAgentStore: store, runStore,
      sessionCatalog: {
        get: vi.fn().mockResolvedValue({
          sessionId: task.sessionId, userId: 'user-1', username: 'user-1', channel: 'web',
          cwd: '/tmp', transcriptPath: '/tmp/org-agent-background-test.jsonl', status: 'running',
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        }),
        markStatus: vi.fn().mockResolvedValue(undefined),
      },
      eventStoreFactory: () => new MemoryEventStore(),
    } as never);

    await expect(coordinator.pause('tenant-1', 'work-1', 3)).resolves.toMatchObject({ runId: 'run-1' });

    expect(runStore.markStatusIfCurrent).toHaveBeenCalledWith(
      'run-1', ['pending', 'running'], 'cancelled', '组织群任务已暂停',
      expect.objectContaining({ orgAgentAttemptSuperseded: true, orgAgentPauseAttemptNo: 1 }),
      undefined,
    );
    expect(store.pauseWorkOrder).toHaveBeenCalledWith({
      tenantId: 'tenant-1', workOrderId: 'work-1', expectedVersion: 3,
    });
    expect(store.transitionWorkAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeRunId: 'run-1',
        status: 'cancelled',
        checkpoint: expect.objectContaining({
          continuationAllowed: true,
          reason: 'paused_by_operator',
        }),
      }),
    );
  });

  it('does not falsely report a pause when the current attempt has already become terminal', async () => {
    const work = { workOrderId: 'work-1', tenantId: 'tenant-1', state: 'running' as const,
      currentAttemptNo: 1, version: 3 };
    const attempt = { attemptId: 'attempt-1', workOrderId: 'work-1', runtimeRunId: 'run-1',
      attemptNo: 1, status: 'running' as const };
    const task = previousRun('tenant-1/.agent-agent-1/shared/binding-1/wc-1');
    task.status = 'completed';
    task.metadata.backgroundResult = {
      status: 'completed', text: '已完成', totalTokens: 1, toolUseCount: 0, turnCount: 1, durationMs: 1,
    };
    const store = {
      getWorkOrder: vi.fn().mockResolvedValue(work),
      listWorkAttempts: vi.fn().mockResolvedValue([attempt]),
      transitionWorkAttempt: vi.fn().mockResolvedValue({ ...attempt, status: 'completed' }),
      transitionWorkOrder: vi.fn().mockResolvedValue({ ...work, state: 'completed' }),
      pauseWorkOrder: vi.fn(),
    } as unknown as OrgGroupAgentStore;
    const coordinator = new OrgAgentBackgroundWorkCoordinator({
      orgGroupAgentStore: store,
      runStore: { get: vi.fn().mockResolvedValue(task) },
    } as never);

    await expect(coordinator.pause('tenant-1', 'work-1', 3))
      .rejects.toThrow('ORG_AGENT_WORK_ORDER_PAUSE_TERMINAL_RACE');

    expect(store.transitionWorkOrder).toHaveBeenCalledWith(expect.objectContaining({ state: 'completed' }));
    expect(store.pauseWorkOrder).not.toHaveBeenCalled();
  });

  it('leaves a superseded wake pending when durable pause reconciliation fails', async () => {
    const work = { workOrderId: 'work-1', tenantId: 'tenant-1', state: 'running' as const,
      currentAttemptNo: 1, version: 3 };
    const attempt = { attemptId: 'attempt-1', workOrderId: 'work-1', runtimeRunId: 'run-1',
      attemptNo: 1, status: 'cancelled' as const };
    const task = previousRun('tenant-1/.agent-agent-1/shared/binding-1/wc-1');
    task.status = 'cancelled';
    task.metadata.orgAgentAttemptSuperseded = true;
    const store = {
      getWorkOrder: vi.fn().mockResolvedValue(work),
      listWorkAttempts: vi.fn().mockResolvedValue([attempt]),
      pauseWorkOrder: vi.fn().mockRejectedValue(new Error('transient database failure')),
    } as unknown as OrgGroupAgentStore;
    const coordinator = new OrgAgentBackgroundWorkCoordinator({ orgGroupAgentStore: store } as never);

    await expect(coordinator.reconcileSuperseded(task)).rejects.toThrow('transient database failure');
    expect(store.pauseWorkOrder).toHaveBeenCalledWith({
      tenantId: 'tenant-1', workOrderId: 'work-1', expectedVersion: 3,
    });
  });
});

function now(): string {
  return '2026-09-04T00:00:00.000Z';
}

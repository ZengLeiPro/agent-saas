import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDefaultExecutionTransportRegistry } from '../agent/toolRuntime.js';
import { createRuntimeSessionRecord } from '../runtime/sessionCatalog.js';
import { AgentToolProvider } from '../runtime/subagent/agentToolProvider.js';
import { runSubagent, type SubagentOutcome } from '../runtime/subagent/subagentRunner.js';
import { createTenantRemoteHandAuthTokenResolver } from '../runtime/tenantRemoteHandResolver.js';
import { makeFixture, type SubagentFixture } from './helpers/subagentTestFixture.js';

const cleanupDirs = new Set<string>();

afterEach(async () => {
  for (const dir of cleanupDirs) await rm(dir, { recursive: true, force: true });
  cleanupDirs.clear();
});

function fakeOutcome(
  fixture: SubagentFixture,
  overrides: Partial<SubagentOutcome> = {},
): SubagentOutcome {
  return {
    status: 'completed',
    text: '结论文本',
    totalTokens: 100,
    toolUseCount: 3,
    turnCount: 4,
    durationMs: 1200,
    childSessionId: `sub-${randomUUID()}`,
    childRunId: `${Date.now()}-${randomUUID()}`,
    model: 'mock-model',
    effort: 'high',
    ...overrides,
  };
}

function makeProvider(fixture: SubagentFixture, impl?: typeof runSubagent): AgentToolProvider {
  return new AgentToolProvider({
    config: fixture.config,
    executionTransportRegistry: createDefaultExecutionTransportRegistry(),
    tenantHandResolver: createTenantRemoteHandAuthTokenResolver({}),
    parentProviders: [],
    runSubagentImpl:
      impl ??
      (async (params) => {
        const outcome = fakeOutcome(fixture);
        await params.onChildRunCreated?.({
          childSessionId: outcome.childSessionId,
          childRunId: outcome.childRunId,
          model: outcome.model,
          effort: outcome.effort,
          agentId: params.request.agentId,
        });
        return { ...outcome, agentId: params.request.agentId };
      }),
  });
}

describe('AgentToolProvider stable continuation', () => {
  it('按当前租户和策略动态注入脱敏模型/effort 目录', async () => {
    const fixture = await makeFixture({ cleanupDirs });
    const getSubagentModelCatalog = vi.fn((tenantId?: string) =>
      tenantId === fixture.tenantId
        ? {
            defaultRef: 'safe/default',
            models: [
              {
                ref: 'safe/default',
                name: '默认模型',
                effort: {
                  support: 'supported' as const,
                  values: ['low', 'high'],
                  defaultValue: 'low',
                  source: 'configured' as const,
                },
              },
              { ref: 'safe/other', name: '备用模型', effort: { support: 'unknown' as const } },
            ],
          }
        : { defaultRef: 'other/private', models: [{ ref: 'other/private', name: '其他租户模型' }] },
    );
    fixture.config.getSubagentModelCatalog = getSubagentModelCatalog;
    const provider = makeProvider(fixture);

    const description = provider.list(fixture.parentContext)[0]!.description;

    expect(getSubagentModelCatalog).toHaveBeenCalledWith(fixture.tenantId);
    expect(description).toContain('safe/default');
    expect(description).toContain('effort=low|high（默认 low）');
    expect(description).toContain('safe/other');
    expect(description).not.toContain('other/private');
    expect(description).not.toMatch(/api[_ -]?key|baseurl|credential/i);
  });

  it('active resume 只持久化 steering 消息并返回 accepted，不新建物理 run', async () => {
    const fixture = await makeFixture({ cleanupDirs });
    const agentId = 'agent-active-1';
    const enqueueUserMessage = vi.fn(async (input) => ({
      ...input,
      status: 'pending',
      requestedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {
        ...input.metadata,
        steeringTargetRunId: 'child-run-active',
        steeringState: 'pending',
      },
    }));
    const cancelPendingUserMessage = vi.fn();
    fixture.config.runStore = {
      listSubagentRunsByAgentId: vi.fn(async () => [
        {
          runId: 'child-run-active',
          sessionId: 'child-session-active',
          userId: 'user-1',
          tenantId: fixture.tenantId,
          status: 'running',
          model: 'mock-model',
          channel: 'web',
          requestedAt: '2026-09-12T09:00:00.000Z',
          updatedAt: '2026-09-12T09:00:01.000Z',
          metadata: {
            subagent: true,
            subagentAgentId: agentId,
            subagentContinuationProtocolVersion: 1,
            parentSessionId: fixture.parentSessionId,
            agentType: 'general',
            subagentMode: 'foreground',
            description: '持续调研',
            modelRef: 'mock/group-model',
            includeCompanyInfo: false,
          },
        },
      ]),
      enqueueUserMessage,
      cancelPendingUserMessage,
    } as never;
    const foreground = vi.fn();
    const provider = makeProvider(fixture, foreground as typeof runSubagent);

    const result = await provider.invoke(
      {
        toolId: 'Agent',
        input: { resume: agentId, prompt: '补充检查失败分支' },
        authorization: { approved: true, source: 'policy_auto' },
      },
      fixture.parentContext,
    );

    expect(JSON.parse(result!.content)).toMatchObject({
      agent_id: agentId,
      run_id: 'child-run-active',
      delivery: 'accepted',
      status: 'running',
    });
    expect(enqueueUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'child-session-active' }),
      'steer',
    );
    expect(cancelPendingUserMessage).not.toHaveBeenCalled();
    expect(foreground).not.toHaveBeenCalled();
  });

  it('idle resume 复用原 child session 与 Profile pin，并为新 run 原子占位', async () => {
    const fixture = await makeFixture({ cleanupDirs });
    const agentId = 'agent-idle-1';
    const childSessionId = randomUUID();
    const childSession = createRuntimeSessionRecord({
      sessionId: childSessionId,
      userId: 'user-1',
      username: 'alice',
      userRole: 'user',
      tenantId: fixture.tenantId,
      channel: 'web',
      cwd: fixture.tmp,
      modelRef: 'mock/group-model',
      executionTarget: 'server-local',
      status: 'idle',
      kind: 'subagent',
    });
    childSession.profileId = 'profile-explore';
    childSession.profileVersionId = 'profile-explore-v3';
    childSession.profileConfigDigest = 'digest-v3';
    await fixture.config.sessionCatalog!.upsert(childSession);
    const previous = {
      runId: 'child-run-completed',
      sessionId: childSessionId,
      userId: 'user-1',
      tenantId: fixture.tenantId,
      status: 'completed' as const,
      model: 'mock-model',
      channel: 'web' as const,
      requestedAt: '2026-09-12T09:00:00.000Z',
      updatedAt: '2026-09-12T09:00:01.000Z',
      metadata: {
        subagent: true,
        subagentAgentId: agentId,
        subagentContinuationProtocolVersion: 1,
        parentSessionId: fixture.parentSessionId,
        parentRunId: fixture.parentRunId,
        agentType: 'explore',
        subagentMode: 'foreground',
        description: '持续调研',
        modelRef: 'mock/group-model',
        effort: 'high',
        includeCompanyInfo: false,
      },
    };
    const reserveSubagentContinuation = vi.fn(async (input) => ({
      state: 'reserved' as const,
      record: {
        ...input,
        status: 'pending' as const,
        requestedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    }));
    fixture.config.runStore = {
      listSubagentRunsByAgentId: vi.fn(async () => [previous]),
      reserveSubagentContinuation,
      markStatus: vi.fn(async () => previous),
    } as never;
    const foreground = vi.fn(async (params) => {
      expect(params.continuationChildSessionId).toBe(childSessionId);
      expect(params.profileSourceSession).toMatchObject({
        profileId: 'profile-explore',
        profileVersionId: 'profile-explore-v3',
        profileConfigDigest: 'digest-v3',
      });
      expect(params.request).toMatchObject({
        agentId,
        description: '持续调研',
        prompt: '补齐失败分支',
        model: 'mock/group-model',
        effort: 'high',
        continuation: {
          previousRunId: 'child-run-completed',
          previousSessionId: childSessionId,
          sequence: 1,
        },
      });
      const childRunId = params.preparedChildIdentity!.childRunId;
      await params.onChildRunCreated?.({
        childSessionId,
        childRunId,
        model: 'mock-model',
        effort: 'high',
        agentId,
      });
      return fakeOutcome(fixture, {
        childSessionId,
        childRunId,
        model: 'mock-model',
        effort: 'high',
        agentId,
      });
    });
    const provider = makeProvider(fixture, foreground as typeof runSubagent);

    const result = await provider.invoke(
      {
        toolId: 'Agent',
        input: { resume: agentId, prompt: '补齐失败分支' },
        authorization: { approved: true, source: 'policy_auto' },
      },
      fixture.parentContext,
    );

    expect(result!.content).toContain(`agent_id=${agentId}`);
    expect(result!.content).toContain(`child_session_id=${childSessionId}`);
    expect(reserveSubagentContinuation).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: childSessionId,
        agentId,
        metadata: expect.objectContaining({
          subagentContinuationClaim: true,
          subagentContinuation: expect.objectContaining({ previousRunId: 'child-run-completed' }),
        }),
      }),
    );
    expect(foreground).toHaveBeenCalledOnce();
  });

  it('resume 拒绝角色漂移、mode 漂移和公司信息扩权', async () => {
    const fixture = await makeFixture({ cleanupDirs });
    const agentId = 'agent-fields-1';
    fixture.config.runStore = {
      listSubagentRunsByAgentId: vi.fn(async () => [
        {
          runId: 'child-run-fields',
          sessionId: 'child-session-fields',
          userId: 'user-1',
          tenantId: fixture.tenantId,
          status: 'completed',
          model: 'mock-model',
          channel: 'web',
          requestedAt: '2026-09-12T09:00:00.000Z',
          updatedAt: '2026-09-12T09:00:01.000Z',
          metadata: {
            subagent: true,
            subagentAgentId: agentId,
            subagentContinuationProtocolVersion: 1,
            parentSessionId: fixture.parentSessionId,
            agentType: 'explore',
            subagentMode: 'foreground',
            description: '字段约束',
            modelRef: 'mock/group-model',
            includeCompanyInfo: false,
          },
        },
      ]),
    } as never;
    const provider = makeProvider(fixture, vi.fn() as typeof runSubagent);
    const invoke = (input: Record<string, unknown>) =>
      provider.invoke(
        {
          toolId: 'Agent',
          input: { resume: agentId, prompt: '继续', ...input },
          authorization: { approved: true, source: 'policy_auto' },
        },
        fixture.parentContext,
      );

    await expect(invoke({ agent_type: 'general' })).rejects.toThrow(/agent_type 与原身份冲突/);
    await expect(invoke({ mode: 'background' })).rejects.toThrow(/mode 与原身份冲突/);
    await expect(invoke({ include_company_info: true })).rejects.toThrow(/不允许.*扩权/);
  });

  it('background child 创建前的 resume 进入 durable deferred queue', async () => {
    const fixture = await makeFixture({ cleanupDirs });
    const agentId = 'agent-background-deferred';
    const queueSubagentDeferredMessage = vi.fn(async () => ({ state: 'accepted' as const }));
    fixture.config.runStore = {
      listSubagentRunsByAgentId: vi.fn(async () => [
        {
          runId: 'background-wrapper',
          sessionId: fixture.parentSessionId,
          userId: 'user-1',
          tenantId: fixture.tenantId,
          status: 'pending',
          model: 'mock-model',
          channel: 'web',
          requestedAt: '2026-09-12T09:00:00.000Z',
          updatedAt: '2026-09-12T09:00:01.000Z',
          metadata: {
            subagent: true,
            backgroundTask: true,
            subagentAgentId: agentId,
            subagentContinuationProtocolVersion: 1,
            parentSessionId: fixture.parentSessionId,
            parentRunId: fixture.parentRunId,
            agentType: 'explore',
            subagentMode: 'background',
            description: '后台调研',
            modelRef: 'mock/group-model',
            includeCompanyInfo: false,
          },
        },
      ]),
      queueSubagentDeferredMessage,
    } as never;
    const foreground = vi.fn();
    const provider = makeProvider(fixture, foreground as typeof runSubagent);

    const result = await provider.invoke(
      {
        toolId: 'Agent',
        input: { resume: agentId, prompt: '补充输出验收表' },
        authorization: { approved: true, source: 'policy_auto' },
      },
      fixture.parentContext,
    );

    expect(JSON.parse(result!.content)).toMatchObject({
      agent_id: agentId,
      taskId: 'background-wrapper',
      status: 'pending',
      delivery: 'accepted',
      resumable: true,
    });
    expect(queueSubagentDeferredMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        taskRunId: 'background-wrapper',
        agentId,
        message: expect.objectContaining({ prompt: '补充输出验收表' }),
      }),
    );
    expect(foreground).not.toHaveBeenCalled();
  });
});

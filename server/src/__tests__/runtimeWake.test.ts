import { describe, expect, it, vi } from 'vitest';

import {
  HIDDEN_WAKE_CONTINUE_PROMPT,
  INTERJECTION_FALLBACK_PROMPT,
  RunStateTrackingEventStore,
  WAKE_EVENT_LIST_TYPES,
  resolveSessionOwnerTenantId,
  resolveWakeSessionOwner,
  releaseWakeLeaseForDrainHandoff,
  resolveWakePrompt,
  wakeRuntimeSession,
  type RawRuntimeRunDispatchConfig,
  type RuntimeWakeLease,
} from '../runtime/rawRuntimeRunDispatch.js';
import type { RunRecord, RunStatus, RunStore } from '../runtime/runStore.js';
import type { RuntimeSessionRecord, SessionCatalog } from '../runtime/sessionCatalog.js';
import type { PlatformEvent, PlatformEventInput } from '../runtime/types.js';
import { MemoryEventStore, MemorySessionCatalog } from './runtimeWake.testHelpers.js';

const TENANT_ID = 'pantheon';

describe('wakeRuntimeSession', () => {
  it('replays the original user message when it was not persisted as user_message yet', async () => {
    const session: RuntimeSessionRecord = {
      sessionId: 'session-replay-original',
      userId: 'user-1',
      username: 'alice',
      channel: 'web',
      cwd: '/tmp/alice',
      transcriptPath: '/tmp/alice/session.jsonl',
      modelRef: 'gpt-5.4-mini',
      executionTarget: 'server-local',
      workspaceId: 'workspace-1',
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const run: RunRecord = {
      runId: 'run-replay-original',
      sessionId: 'session-replay-original',
      userId: 'user-1',
      status: 'pending',
      model: 'gpt-5.4-mini',
      channel: 'web',
      requestedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      executionTarget: 'server-local',
      workspaceId: 'workspace-1',
      metadata: { wakeMessage: { chatId: 'session-replay-original', content: 'inspect disk usage' } },
    };
    const eventStore = new MemoryEventStore();
    await eventStore.append({
      type: 'user_message_submitted',
      sessionId: 'session-replay-original',
      runId: 'run-replay-original',
      content: 'inspect disk usage',
    }, { tenantId: TENANT_ID });

    const decision = resolveWakePrompt(run, await eventStore.list(TENANT_ID, session.sessionId), session);

    expect(decision.recordUserMessage).toBe(true);
    expect(decision.message.content).toBe('inspect disk usage');
  });

  it('uses a hidden continuation prompt when the run user_message is already persisted', async () => {
    const session: RuntimeSessionRecord = {
      sessionId: 'session-hidden-continue',
      userId: 'user-1',
      username: 'alice',
      channel: 'web',
      cwd: '/tmp/alice',
      transcriptPath: '/tmp/alice/session.jsonl',
      modelRef: 'gpt-5.4-mini',
      executionTarget: 'server-local',
      workspaceId: 'workspace-1',
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const run: RunRecord = {
      runId: 'run-hidden-continue',
      sessionId: 'session-hidden-continue',
      userId: 'user-1',
      status: 'running',
      model: 'gpt-5.4-mini',
      channel: 'web',
      requestedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      executionTarget: 'server-local',
      workspaceId: 'workspace-1',
      metadata: { wakeMessage: { chatId: 'session-hidden-continue', content: 'inspect container boundary' } },
    };
    const eventStore = new MemoryEventStore();
    await eventStore.append({
      type: 'user_message',
      sessionId: 'session-hidden-continue',
      runId: 'run-hidden-continue',
      content: 'inspect container boundary',
    }, { tenantId: TENANT_ID });

    const decision = resolveWakePrompt(run, await eventStore.list(TENANT_ID, session.sessionId), session);

    expect(decision.recordUserMessage).toBe(false);
    expect(decision.message.content).toBe(HIDDEN_WAKE_CONTINUE_PROMPT);
    expect(decision.message.metadata).toMatchObject({
      schedulerWake: true,
      originalRunId: 'run-hidden-continue',
      hiddenContinuation: true,
    });
  });

  it('keeps user_message visible through the wake includeTypes filter (regression: b58e63d duplicate replay after drain handoff)', async () => {
    const session: RuntimeSessionRecord = {
      sessionId: 'session-wake-filter',
      userId: 'user-1',
      username: 'alice',
      channel: 'web',
      cwd: '/tmp/alice',
      transcriptPath: '/tmp/alice/session.jsonl',
      modelRef: 'gpt-5.4-mini',
      executionTarget: 'server-local',
      workspaceId: 'workspace-1',
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const run: RunRecord = {
      runId: 'run-wake-filter',
      sessionId: session.sessionId,
      userId: session.userId,
      status: 'running',
      model: 'gpt-5.4-mini',
      channel: 'web',
      requestedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      executionTarget: session.executionTarget,
      workspaceId: session.workspaceId,
      metadata: { wakeMessage: { chatId: session.sessionId, content: '继续处理长会话优化' } },
    };
    const eventStore = new MemoryEventStore();
    await eventStore.append({
      type: 'user_message_submitted',
      sessionId: session.sessionId,
      runId: run.runId,
      content: '继续处理长会话优化',
    }, { tenantId: TENANT_ID });
    await eventStore.append({
      type: 'user_message',
      sessionId: session.sessionId,
      runId: run.runId,
      content: '继续处理长会话优化',
    }, { tenantId: TENANT_ID });
    // 一个体积大、与 wake 判断无关的事件：includeTypes 过滤应把它挡在 Node 之外
    await eventStore.append({
      type: 'tool_result',
      sessionId: session.sessionId,
      runId: run.runId,
      toolCallId: 'call-big',
      content: 'x'.repeat(1024),
    } as PlatformEventInput, { tenantId: TENANT_ID });

    // 与生产 wake 路径完全一致的加载方式（带 includeTypes 过滤）
    const events = await eventStore.list(TENANT_ID, session.sessionId, { includeTypes: [...WAKE_EVENT_LIST_TYPES] });

    expect(events.some((event) => event.type === 'tool_result')).toBe(false);
    // resolveWakePrompt 必须仍能看到已持久化的 user_message，否则 drain handoff 后会重复重放
    expect(events.some((event) => event.type === 'user_message')).toBe(true);
    expect(events.some((event) => event.type === 'user_message_submitted')).toBe(true);

    const decision = resolveWakePrompt(run, events, session);
    expect(decision.recordUserMessage).toBe(false);
    expect(decision.message.content).toBe(HIDDEN_WAKE_CONTINUE_PROMPT);
  });

  it('does not duplicate a steering message already persisted by the target run', async () => {
    const session: RuntimeSessionRecord = {
      sessionId: 'session-steering-fallback',
      userId: 'user-1',
      username: 'alice',
      channel: 'web',
      cwd: '/tmp/alice',
      transcriptPath: '/tmp/alice/session.jsonl',
      modelRef: 'gpt-5.4-mini',
      executionTarget: 'server-local',
      workspaceId: 'workspace-1',
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const run: RunRecord = {
      runId: 'source-steering-fallback',
      sessionId: session.sessionId,
      userId: 'user-1',
      status: 'pending',
      model: 'gpt-5.4-mini',
      channel: 'web',
      requestedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      executionTarget: 'server-local',
      workspaceId: 'workspace-1',
      metadata: { wakeMessage: { chatId: session.sessionId, content: '插话消息' } },
    };
    const eventStore = new MemoryEventStore();
    await eventStore.append({
      type: 'user_message',
      sessionId: session.sessionId,
      runId: 'target-run',
      content: '插话消息',
      interjectionSourceRunId: run.runId,
    }, { tenantId: TENANT_ID });

    const decision = resolveWakePrompt(run, await eventStore.list(TENANT_ID, session.sessionId), session);

    expect(decision.recordUserMessage).toBe(false);
    // 2026-08-04 BUG-4：插话回退 run（user_message 已 drain 但未 claim）不再用
    // 「继续被中断的运行」提示——目标 run 多半是用户主动取消的，那个提示会让模型
    // 接着做刚被取消的任务。改用明确指令：响应上下文中最后那条用户消息本身。
    expect(decision.message.content).toBe(INTERJECTION_FALLBACK_PROMPT);
    expect(decision.message.metadata).toMatchObject({
      schedulerWake: true,
      originalRunId: run.runId,
      hiddenContinuation: true,
      interjectionFallback: true,
    });
  });


  it('keeps transient steering recovery handoffs recoverable below the retry limit', async () => {
    const now = new Date().toISOString();
    let current: RunRecord = {
      runId: 'target-steering-retry',
      sessionId: 'session-steering-retry',
      tenantId: TENANT_ID,
      status: 'running',
      requestedAt: now,
      updatedAt: now,
      metadata: {},
    };
    const runStore = {
      get: vi.fn(async () => current),
      markStatus: vi.fn(async (_runId: string, status: RunStatus, reason?: string, metadata = {}) => {
        current = { ...current, status, statusReason: reason, metadata: { ...current.metadata, ...metadata } };
        return current;
      }),
    } as unknown as RunStore;
    const eventStore = new MemoryEventStore();
    const markSessionStatus = vi.fn(async () => undefined);
    const renewLease = vi.fn(async () => undefined);
    const releases: Array<{ status?: RunStatus; reason?: string }> = [];

    await releaseWakeLeaseForDrainHandoff({
      config: { agentCwd: '/tmp', runStore } as RawRuntimeRunDispatchConfig,
      eventStore,
      sessionCatalog: { markStatus: markSessionStatus } as unknown as SessionCatalog,
      run: current,
      lease: {
        runId: current.runId,
        workerId: 'worker-1',
        renew: renewLease,
        release: async (status, reason) => { releases.push({ status, reason }); },
      },
      drainHandoff: { requested: true, reason: 'steering_reserved_apply_failed' },
    });

    expect(renewLease).toHaveBeenCalledOnce();
    expect(current).toMatchObject({ status: 'running', metadata: { drainHandoffAttempts: 1 } });
    expect(eventStore.events.map((event) => event.type)).toEqual(['run_state_changed']);
    expect(markSessionStatus).toHaveBeenCalledWith('session-steering-retry', 'running');
    expect(releases).toEqual([{ status: undefined, reason: 'steering_reserved_apply_failed' }]);
  });

  it('terminalizes the target and surfaces an error after repeated steering recovery failures', async () => {
    const now = new Date().toISOString();
    let current: RunRecord = {
      runId: 'target-steering-recovery',
      sessionId: 'session-steering-recovery',
      userId: 'user-1',
      tenantId: TENANT_ID,
      status: 'running',
      requestedAt: now,
      updatedAt: now,
      metadata: { drainHandoffAttempts: 2 },
    };
    const runStore = {
      get: vi.fn(async () => current),
      markStatus: vi.fn(async (_runId: string, status: RunStatus, reason?: string, metadata = {}) => {
        current = {
          ...current,
          status,
          statusReason: reason,
          updatedAt: new Date().toISOString(),
          metadata: { ...current.metadata, ...metadata },
        };
        return current;
      }),
    } as unknown as RunStore;
    const innerEventStore = new MemoryEventStore();
    const eventStore = new RunStateTrackingEventStore(innerEventStore, runStore, TENANT_ID);
    const markSessionStatus = vi.fn(async () => undefined);
    const releases: Array<{ status?: RunStatus; reason?: string }> = [];
    const outbound: string[] = [];

    await expect(releaseWakeLeaseForDrainHandoff({
      config: { agentCwd: '/tmp', runStore } as RawRuntimeRunDispatchConfig,
      eventStore,
      sessionCatalog: { markStatus: markSessionStatus } as unknown as SessionCatalog,
      run: current,
      lease: {
        runId: current.runId,
        workerId: 'worker-1',
        renew: async () => undefined,
        release: async (status, reason) => { releases.push({ status, reason }); },
      },
      drainHandoff: { requested: true, reason: 'steering_reserved_apply_failed' },
      onOutboundEvent: async (event) => { outbound.push(event.type); },
    })).resolves.toBe(true);

    expect(current).toMatchObject({
      status: 'failed',
      statusReason: '会话恢复连续失败，本次运行已结束，请重试。',
      metadata: { drainHandoffAttempts: 3 },
    });
    expect(innerEventStore.events.map((event) => event.type)).toEqual([
      'run_state_changed',
      'run_finished',
      'run_state_changed',
    ]);
    expect(innerEventStore.events.at(-1)).toMatchObject({
      type: 'run_state_changed',
      runId: 'target-steering-recovery',
      status: 'failed',
    });
    expect(markSessionStatus).toHaveBeenCalledWith('session-steering-recovery', 'error');
    expect(outbound).toEqual(['error']);
    expect(releases).toEqual([{
      status: 'failed',
      reason: '会话恢复连续失败，本次运行已结束，请重试。',
    }]);
  });

  it('restores durable context far enough to honor cancel commands before model wake', async () => {
    const session: RuntimeSessionRecord = {
      sessionId: 'session-1',
      userId: 'user-1',
      username: 'alice',
      tenantId: 'wain-test',
      channel: 'web',
      cwd: '/tmp/alice',
      transcriptPath: '/tmp/alice/session.jsonl',
      modelRef: 'gpt-5.4-mini',
      executionTarget: 'server-local',
      workspaceId: 'workspace-1',
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const eventStore = new MemoryEventStore();
    await eventStore.append({
      type: 'run_cancel_requested',
      sessionId: 'session-1',
      runId: 'run-1',
      reason: 'test_cancel',
    }, { tenantId: 'wain-test' });
    const releases: Array<{ status?: RunStatus; reason?: string }> = [];
    const lease: RuntimeWakeLease = {
      runId: 'run-1',
      renew: async () => {},
      release: async (status, reason) => {
        releases.push({ status, reason });
      },
    };
    const run: RunRecord = {
      runId: 'run-1',
      sessionId: 'session-1',
      userId: 'user-1',
      tenantId: 'wain-test',
      status: 'running',
      model: 'gpt-5.4-mini',
      channel: 'web',
      requestedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      executionTarget: 'server-local',
      workspaceId: 'workspace-1',
      metadata: { wakeMessage: { chatId: 'session-1', content: 'hello' } },
    };

    await wakeRuntimeSession({
      agentCwd: '/tmp',
      sharedDir: '/tmp',
      sessionCatalog: new MemorySessionCatalog(session),
      eventStoreFactory: () => eventStore,
    }, run, { lease });

    expect(releases).toEqual([{ status: 'cancelled', reason: 'cancel_requested_before_wake' }]);
    expect(eventStore.events.map((event) => event.type)).toEqual([
      'run_cancel_requested',
      'run_state_changed',
    ]);
    expect(eventStore.appendContexts.map((ctx) => ctx?.tenantId)).toEqual([
      'wain-test',
      'wain-test',
    ]);
  });

  // 修 P0 BUG #2（2026-06-21）回归测试：
  //
  // PR 8 enqueue-only + scheduler wake 路径完全绕过了 engine/dispatch.ts 的
  // ensureUserWorkspace 调用。fix 是在 wake 调 dispatch 之前调用
  // workspaceProvisioner 回调（由 app/runtime.ts 装配，内部走 ensureUserWorkspace）。
  //
  // 下面两个测试覆盖：
  //   (a) provisioner 抛错时 wake release 为 failed 并写 run_state_changed；
  //   (b) 早返回分支（cancel）不调 provisioner — 它放在 cancel/waiting 早返回**之后**。
  it('releases run as failed when workspaceProvisioner throws', async () => {
    const session: RuntimeSessionRecord = {
      sessionId: 'session-prov-fail',
      userId: 'user-1',
      username: 'alice',
      channel: 'web',
      cwd: '/tmp/alice',
      transcriptPath: '/tmp/alice/session.jsonl',
      modelRef: 'gpt-5.4-mini',
      executionTarget: 'server-local',
      workspaceId: 'workspace-1',
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const eventStore = new MemoryEventStore();
    const releases: Array<{ status?: RunStatus; reason?: string }> = [];
    const lease: RuntimeWakeLease = {
      runId: 'run-prov',
      renew: async () => {},
      release: async (status, reason) => {
        releases.push({ status, reason });
      },
    };
    const run: RunRecord = {
      runId: 'run-prov',
      sessionId: 'session-prov-fail',
      userId: 'user-1',
      status: 'pending',
      model: 'gpt-5.4-mini',
      channel: 'web',
      requestedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      executionTarget: 'server-local',
      workspaceId: 'workspace-1',
      metadata: { wakeMessage: { chatId: 'session-prov-fail', content: 'hi' } },
    };
    const provisionerCalls: Array<{ userId?: string; username?: string }> = [];

    await wakeRuntimeSession({
      agentCwd: '/tmp',
      sharedDir: '/tmp',
      sessionCatalog: new MemorySessionCatalog(session),
      eventStoreFactory: () => eventStore,
      workspaceProvisioner: async (input) => {
        provisionerCalls.push(input);
        throw new Error('mkdir EACCES');
      },
    }, run, { lease });

    // provisioner 一定被调用，且收到 session 的 userId / username
    expect(provisionerCalls).toEqual([{ userId: 'user-1', username: 'alice' }]);
    // release 应为 failed，reason 含 provisioner 抛的错误信息
    expect(releases).toHaveLength(1);
    expect(releases[0]!.status).toBe('failed');
    expect(releases[0]!.reason).toContain('workspace_provision_failed');
    expect(releases[0]!.reason).toContain('mkdir EACCES');
    // 应写入 run_state_changed 让外部观察到 failed
    const stateChanges = eventStore.events.filter((event) => event.type === 'run_state_changed');
    expect(stateChanges).toHaveLength(1);
    expect((stateChanges[0]! as Extract<PlatformEvent, { type: 'run_state_changed' }>).status).toBe('failed');
  });

  it('skips workspaceProvisioner on early-return branches (cancel)', async () => {
    const session: RuntimeSessionRecord = {
      sessionId: 'session-cancel-prov',
      userId: 'user-1',
      username: 'alice',
      channel: 'web',
      cwd: '/tmp/alice',
      transcriptPath: '/tmp/alice/session.jsonl',
      modelRef: 'gpt-5.4-mini',
      executionTarget: 'server-local',
      workspaceId: 'workspace-1',
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const eventStore = new MemoryEventStore();
    await eventStore.append({
      type: 'run_cancel_requested',
      sessionId: 'session-cancel-prov',
      runId: 'run-cancel',
      reason: 'test_cancel',
    }, { tenantId: TENANT_ID });
    const lease: RuntimeWakeLease = {
      runId: 'run-cancel',
      renew: async () => {},
      release: async () => {},
    };
    const run: RunRecord = {
      runId: 'run-cancel',
      sessionId: 'session-cancel-prov',
      userId: 'user-1',
      status: 'running',
      model: 'gpt-5.4-mini',
      channel: 'web',
      requestedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      executionTarget: 'server-local',
      workspaceId: 'workspace-1',
      metadata: {},
    };
    const provisionerCalls: Array<{ userId?: string; username?: string }> = [];

    await wakeRuntimeSession({
      agentCwd: '/tmp',
      sharedDir: '/tmp',
      sessionCatalog: new MemorySessionCatalog(session),
      eventStoreFactory: () => eventStore,
      workspaceProvisioner: async (input) => {
        provisionerCalls.push(input);
      },
    }, run, { lease });

    // cancel 早返回，不应付 provisioning 成本
    expect(provisionerCalls).toEqual([]);
  });

  it('defers wake when durable AskUserQuestion is still pending', async () => {
    const session: RuntimeSessionRecord = {
      sessionId: 'session-ask',
      userId: 'user-1',
      username: 'alice',
      channel: 'web',
      cwd: '/tmp/alice',
      transcriptPath: '/tmp/alice/session.jsonl',
      modelRef: 'gpt-5.4-mini',
      executionTarget: 'server-local',
      workspaceId: 'workspace-1',
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const eventStore = new MemoryEventStore();
    await eventStore.append({
      type: 'interaction_requested',
      sessionId: 'session-ask',
      runId: 'run-ask',
      toolCallId: 'call-ask',
      invocationId: 'run-ask:call-ask',
      interactionId: 'ask-1',
      interactionType: 'ask_user',
      userId: 'user-1',
      toolId: 'AskUserQuestion',
      toolName: 'AskUserQuestion',
      questions: [{ question: 'Pick one', header: 'Choice', options: [], multiSelect: false }],
    }, { tenantId: TENANT_ID });
    const releases: Array<{ status?: RunStatus; reason?: string }> = [];
    const lease: RuntimeWakeLease = {
      runId: 'run-ask',
      renew: async () => {},
      release: async (status, reason) => {
        releases.push({ status, reason });
      },
    };
    const run: RunRecord = {
      runId: 'run-ask',
      sessionId: 'session-ask',
      userId: 'user-1',
      status: 'running',
      model: 'gpt-5.4-mini',
      channel: 'web',
      requestedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      executionTarget: 'server-local',
      workspaceId: 'workspace-1',
      metadata: { wakeMessage: { chatId: 'session-ask', content: 'hello' } },
    };

    await wakeRuntimeSession({
      agentCwd: '/tmp',
      sharedDir: '/tmp',
      sessionCatalog: new MemorySessionCatalog(session),
      eventStoreFactory: () => eventStore,
    }, run, { lease });

    expect(releases).toEqual([{ status: 'waiting_user', reason: 'wake_deferred_pending_ask_user' }]);
  });

  it('does not treat a later approval resume as consumed by an earlier approval in the same run', async () => {
    const session: RuntimeSessionRecord = {
      sessionId: 'session-approval-2',
      userId: 'user-1',
      username: 'alice',
      channel: 'web',
      cwd: '/tmp/alice',
      transcriptPath: '/tmp/alice/session.jsonl',
      modelRef: 'gpt-5.4-mini',
      executionTarget: 'server-local',
      workspaceId: 'workspace-1',
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const eventStore = new MemoryEventStore();
    await eventStore.append({
      type: 'approval_requested',
      sessionId: 'session-approval-2',
      runId: 'run-approval-2',
      approvalId: 'approval-2',
      toolCallId: 'call-2',
      toolId: 'Shell',
      toolName: 'Shell',
      displayName: 'Run Shell',
      input: { command: 'pwd' },
      executionTarget: 'server-local',
    }, { tenantId: TENANT_ID });
    await eventStore.append({
      type: 'interaction_resolved',
      sessionId: 'session-approval-2',
      runId: 'run-approval-2',
      interactionId: 'approval-2',
      interactionType: 'approval',
      userId: 'user-1',
      response: { allow: true },
    }, { tenantId: TENANT_ID });
    const releases: Array<{ status?: RunStatus; reason?: string }> = [];
    const lease: RuntimeWakeLease = {
      runId: 'run-approval-2',
      renew: async () => {},
      release: async (status, reason) => {
        releases.push({ status, reason });
      },
    };
    const run: RunRecord = {
      runId: 'run-approval-2',
      sessionId: 'session-approval-2',
      userId: 'user-1',
      status: 'pending',
      model: 'gpt-5.4-mini',
      channel: 'web',
      requestedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      executionTarget: 'server-local',
      workspaceId: 'workspace-1',
      metadata: {
        resumeApproval: {
          approvalId: 'approval-2',
          response: { allow: true },
        },
        resumeApprovalConsumedAt: '2026-06-27T01:14:00.000Z',
        resumeApprovalConsumedId: 'approval-1',
      },
    };

    const oldApiKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      await expect(wakeRuntimeSession({
        agentCwd: '/tmp',
        sharedDir: '/tmp',
        sessionCatalog: new MemorySessionCatalog(session),
        eventStoreFactory: () => eventStore,
      }, run, { lease })).rejects.toThrow(/Raw approval resume 缺少 OPENAI_API_KEY/);
    } finally {
      if (oldApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = oldApiKey;
    }

    expect(releases).toEqual([]);
  });

  it('does not wake hidden consolidation outside the engine lock and ledger boundary', async () => {
    const now = new Date().toISOString();
    const hidden: RuntimeSessionRecord = {
      sessionId: 'memory-consolidation-hidden', userId: 'user-1', username: 'alice', tenantId: 'kaiyan',
      channel: 'web', cwd: '/tmp/alice', transcriptPath: '/tmp/alice/hidden.jsonl',
      modelRef: 'gpt-5.4', executionTarget: 'server-local', workspaceId: 'workspace-1',
      status: 'running', createdAt: now, updatedAt: now,
    };
    const source: RuntimeSessionRecord = {
      ...hidden,
      sessionId: 'source-session',
      transcriptPath: '/tmp/alice/source.jsonl',
      status: 'running',
    };
    const run: RunRecord = {
      runId: 'run-memory-wake', sessionId: hidden.sessionId, userId: hidden.userId,
      tenantId: hidden.tenantId, status: 'running', model: 'gpt-5.4', channel: 'web',
      requestedAt: now, updatedAt: now, executionTarget: hidden.executionTarget,
      workspaceId: hidden.workspaceId,
      metadata: {
        memoryConsolidationSourceSessionId: source.sessionId,
        forceFullContextReplay: true,
        wakeMessage: { channel: 'web', chatId: hidden.sessionId, content: '开始记忆审查' },
      },
    };
    const releases: Array<{ status?: RunStatus; reason?: string }> = [];
    const lease: RuntimeWakeLease = {
      runId: run.runId,
      renew: async () => {},
      release: async (status, reason) => { releases.push({ status, reason }); },
    };

    await wakeRuntimeSession({
      agentCwd: '/tmp', sharedDir: '/tmp',
      sessionCatalog: new MemorySessionCatalog([hidden, source]),
      eventStoreFactory: () => new MemoryEventStore(),
      runStore: { get: async () => run } as unknown as RunStore,
    }, run, { lease });
    expect(releases).toEqual([{
      status: 'failed', reason: 'memory_consolidation_run_not_recoverable',
    }]);
  });

  it('keeps the lease held when the normal wake dispatch reports an error', async () => {
    const session: RuntimeSessionRecord = {
      sessionId: 'session-wake-error',
      userId: 'user-1',
      username: 'alice',
      tenantId: 'kaiyan',
      channel: 'cron',
      cwd: '/tmp/alice',
      transcriptPath: '/tmp/alice/session.jsonl',
      modelRef: 'kaiyan-llm/gpt56-sol-medium',
      executionTarget: 'server-container',
      workspaceId: 'workspace-1',
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const run: RunRecord = {
      runId: 'run-wake-error',
      sessionId: session.sessionId,
      userId: session.userId,
      tenantId: session.tenantId,
      status: 'running',
      model: 'gpt-5.6-sol',
      channel: 'cron',
      requestedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      executionTarget: session.executionTarget,
      workspaceId: session.workspaceId,
      metadata: {
        wakeMessage: {
          channel: 'cron',
          chatId: session.sessionId,
          content: '继续执行定时任务',
        },
      },
    };
    const eventStore = new MemoryEventStore();
    const releases: Array<{ status?: RunStatus; reason?: string }> = [];
    const lease: RuntimeWakeLease = {
      runId: run.runId,
      renew: async () => {},
      release: async (status, reason) => {
        releases.push({ status, reason });
      },
    };
    const runStore = {
      get: async () => run,
    } as unknown as RunStore;
    const connectorEnvRequests: Array<{ username: string; tenantId: string }> = [];

    const oldApiKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      await expect(wakeRuntimeSession({
        agentCwd: '/tmp',
        sharedDir: '/tmp',
        sessionCatalog: new MemorySessionCatalog(session),
        eventStoreFactory: () => eventStore,
        runStore,
        resolveUserTenantId: () => 'kaiyan',
        resolveConnectorRuntimeEnv: async (identity) => {
          connectorEnvRequests.push(identity);
          return { GH_TOKEN: 'connector-token-alice' };
        },
      }, run, { lease })).rejects.toThrow(/Raw runtime 缺少 OPENAI_API_KEY/);
    } finally {
      if (oldApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = oldApiKey;
    }

    expect(connectorEnvRequests).toEqual([{ userId: 'user-1', username: 'alice', tenantId: 'kaiyan' }]);
    expect(releases).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';

import {
  HIDDEN_WAKE_CONTINUE_PROMPT,
  resolveSessionOwnerTenantId,
  resolveWakeSessionOwner,
  resolveWakePrompt,
  wakeRuntimeSession,
  type RawRuntimeRunDispatchConfig,
  type RuntimeWakeLease,
} from '../runtime/rawRuntimeRunDispatch.js';
import type { RunRecord, RunStatus } from '../runtime/runStore.js';
import type { RuntimeSessionRecord, SessionCatalog } from '../runtime/sessionCatalog.js';
import type { EventStore, PlatformEvent, PlatformEventInput } from '../runtime/types.js';

class MemorySessionCatalog implements SessionCatalog {
  constructor(private readonly session: RuntimeSessionRecord) {}
  async upsert(): Promise<void> {}
  async get(sessionId: string): Promise<RuntimeSessionRecord | null> {
    return sessionId === this.session.sessionId ? this.session : null;
  }
  async markStatus(): Promise<void> {}
  async findTranscriptPath(sessionId: string): Promise<string | null> {
    return sessionId === this.session.sessionId ? this.session.transcriptPath : null;
  }
}

class MemoryEventStore implements EventStore {
  events: PlatformEvent[] = [];
  appendContexts: Array<Parameters<EventStore['append']>[1]> = [];
  async append(event: PlatformEventInput, ctx?: Parameters<EventStore['append']>[1]): Promise<PlatformEvent> {
    const full = { ...event, id: `e${this.events.length + 1}`, timestamp: new Date().toISOString() } as PlatformEvent;
    this.appendContexts.push(ctx);
    this.events.push(full);
    return full;
  }
  async list(sessionId: string): Promise<PlatformEvent[]> {
    return this.events.filter((event) => !('sessionId' in event) || event.sessionId === sessionId);
  }
}

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
    });

    const decision = resolveWakePrompt(run, await eventStore.list(session.sessionId), session);

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
    });

    const decision = resolveWakePrompt(run, await eventStore.list(session.sessionId), session);

    expect(decision.recordUserMessage).toBe(false);
    expect(decision.message.content).toBe(HIDDEN_WAKE_CONTINUE_PROMPT);
    expect(decision.message.metadata).toMatchObject({
      schedulerWake: true,
      originalRunId: 'run-hidden-continue',
      hiddenContinuation: true,
    });
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
    });
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
      undefined,
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
    });
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
    });
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
    });
    await eventStore.append({
      type: 'interaction_resolved',
      sessionId: 'session-approval-2',
      runId: 'run-approval-2',
      interactionId: 'approval-2',
      interactionType: 'approval',
      userId: 'user-1',
      response: { allow: true },
    });
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
});

describe('resolveWakeSessionOwner', () => {
  const session: RuntimeSessionRecord = {
    sessionId: 'session-real-name',
    userId: 'user-zenglei',
    username: 'zenglei',
    userRole: 'admin',
    channel: 'web',
    cwd: '/tmp/zenglei',
    transcriptPath: '/tmp/zenglei/session.jsonl',
    modelRef: 'gpt-5.4-mini',
    executionTarget: 'server-local',
    workspaceId: 'workspace-zenglei',
    status: 'running',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  function makeConfig(overrides: Partial<RawRuntimeRunDispatchConfig> = {}): RawRuntimeRunDispatchConfig {
    return {
      agentCwd: '/tmp',
      sharedDir: '/tmp',
      ...overrides,
    } as RawRuntimeRunDispatchConfig;
  }

  it('restores the account full name instead of using the username on scheduler wake', () => {
    const seen: Array<{ userId?: string; username?: string }> = [];
    const owner = resolveWakeSessionOwner(makeConfig({
      resolveUserRealName: (identity) => {
        seen.push(identity);
        return '曾磊';
      },
      resolveUserTenantId: () => 'kaiyan',
    }), session);

    expect(seen).toEqual([{ userId: 'user-zenglei', username: 'zenglei' }]);
    expect(owner).toEqual({
      id: 'user-zenglei',
      username: 'zenglei',
      role: 'admin',
      tenantId: 'kaiyan',
      realName: '曾磊',
    });
  });

  it('keeps username fallback behavior when the account has no full name', () => {
    const owner = resolveWakeSessionOwner(makeConfig({
      resolveUserRealName: () => undefined,
    }), session);

    expect(owner.username).toBe('zenglei');
    expect(owner).not.toHaveProperty('realName');
  });
});

// 疑点 3 加固（2026-06-22）：sessionOwner.tenantId 是 A+C execution routing
// 主防御的关键身份字段。runStore.Shell gate 用 `isPlatformAdmin = role==='admin'
// && tenantId === DEFAULT_TENANT_ID` 判定，若 tenantId 在 wake 路径上被静默
// 回填为默认 'kaiyan'，组织 admin 会被误判为平台 admin → 可在 server-local 跑
// Shell → 跨组织读取宿主文件复发。这里把 `resolveSessionOwnerTenantId`
// helper 的 4 个分支锁死，确保任何回归会立刻被门禁拦下。
describe('resolveSessionOwnerTenantId', () => {
  const baseSession: RuntimeSessionRecord = {
    sessionId: 'session-tenant',
    userId: 'user-wain-admin',
    username: 'wain_admin',
    channel: 'web',
    cwd: '/tmp/wain_admin',
    transcriptPath: '/tmp/wain_admin/session.jsonl',
    modelRef: 'doubao-seed-2.0-pro',
    executionTarget: 'server-container',
    workspaceId: 'workspace-wain',
    status: 'running',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  // 最小可用 config（只放本 helper 真消费的字段）
  function makeConfig(overrides: Partial<RawRuntimeRunDispatchConfig> = {}): RawRuntimeRunDispatchConfig {
    return {
      agentCwd: '/tmp',
      sharedDir: '/tmp',
      ...overrides,
    } as RawRuntimeRunDispatchConfig;
  }

  it('returns the resolver value verbatim when resolveUserTenantId returns a valid tenant slug', () => {
    const seen: Array<{ userId?: string; username?: string }> = [];
    const config = makeConfig({
      resolveUserTenantId: (input) => {
        seen.push(input);
        return 'wain-test';
      },
    });

    const tenantId = resolveSessionOwnerTenantId(config, baseSession);

    expect(tenantId).toBe('wain-test');
    // 确认查表用的是 session 自带的 userId + username（不是默认值或猜测）
    expect(seen).toEqual([{ userId: 'user-wain-admin', username: 'wain_admin' }]);
  });

  it('returns undefined (not the default tenant) when resolveUserTenantId is not configured', () => {
    const config = makeConfig({ resolveUserTenantId: undefined });
    expect(resolveSessionOwnerTenantId(config, baseSession)).toBeUndefined();
  });

  it('returns undefined verbatim when resolveUserTenantId resolves to undefined (no silent fallback to DEFAULT_TENANT_ID)', () => {
    // 模拟：用户已删 / UserStore.findById 找不到 → 返回 undefined。
    // 关键不变量：这种情况下绝不能静默回填为 'kaiyan'，否则组织 admin 被误判为
    // 平台 admin（isPlatformAdmin = role==='admin' && tenantId===DEFAULT_TENANT_ID）。
    const config = makeConfig({ resolveUserTenantId: () => undefined });
    expect(resolveSessionOwnerTenantId(config, baseSession)).toBeUndefined();
  });

  it('fail-safe to undefined (not throw upward) when resolveUserTenantId throws', () => {
    // UserStore 故障（DB 临时不可用 / 文件读 IO 错）不应让一次 wake 全栈 throw，
    // 否则 scheduler 会把 run 标记为 failed，用户体验等同 brain 崩溃。
    // 设计：catch + warn log + 返回 undefined → 下游 `isPlatformAdmin=false` 自然 fail-closed。
    const config = makeConfig({
      resolveUserTenantId: () => {
        throw new Error('UserStore unavailable');
      },
    });

    let returnedValue: string | undefined;
    expect(() => {
      returnedValue = resolveSessionOwnerTenantId(config, baseSession);
    }).not.toThrow();
    expect(returnedValue).toBeUndefined();
  });
});

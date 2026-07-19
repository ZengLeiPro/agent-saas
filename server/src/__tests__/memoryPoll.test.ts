/**
 * 每日记忆轮询批次测试（2026-07-14）
 *
 * 覆盖：
 *  - toolProfiles：memory_poll 白名单过滤 + Write/Edit 记忆路径 guard
 *  - UserActivityService：channel 过滤 / 会话排除 / 时间窗 / 降级
 *  - reconcileMemoryPollJobs：预置 / 启停 / 去重 / owner 消失 / 租户灰度
 *  - isMemoryPollSessionMeta：systemKind 真源 + 名称后缀兼容
 *  - cron executor memory_poll 分支：无活动跳过 / 预检 fail-closed / 锁互斥 /
 *    受限 options 注入 + 版本化提示语
 *  - CronService：系统任务 update/remove guard + applySystemJobs
 *  - memoryHook：身份必需 / per-user 冷却隔离 / 失败如实 + 短重试冷却 / 受限 options
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { applyToolProfile } from '../runtime/toolProfiles.js';
import { UserActivityService } from '../runtime/userActivityService.js';
import {
  buildMemoryPollPrompt,
  hashSlot,
  buildMemoryPollSchedule,
  isMemoryPollJob,
  MEMORY_POLL_JOB_NAME,
  reconcileMemoryPollJobs,
} from '../cron/memoryPoll.js';
import {
  canExposeSessionToUser,
  hidesMemoryPollFrom,
  isMemoryPollSessionMeta,
  isPlatformAdminUser,
  type SessionAccessUser,
} from '../data/sessions/access.js';
import { executeJob } from '../cron/executor.js';
import { CronService } from '../cron/service.js';
import { createMemoryMaintenanceHook } from '../engine/memoryHook.js';
import {
  resetMemoryMaintenanceLocks,
  tryAcquireMemoryMaintenance,
} from '../memory/maintenanceLock.js';
import type { CronJob } from '../cron/types.js';
import type { ToolCallContext, ToolDescriptor, ToolRuntime } from '../agent/toolRuntime.js';
import type { PlatformEvent } from '../runtime/types.js';

// ============================================
// helpers
// ============================================

function descriptor(name: string, risk: 'safe' | 'workspace_write' | 'dangerous' = 'safe'): ToolDescriptor {
  return {
    id: name,
    name,
    displayName: name,
    description: name,
    schema: {} as ToolDescriptor['schema'],
    risk,
    approvalMode: 'never',
    auditCategory: 'test',
  };
}

const ALL_TOOLS = [
  descriptor('Read'), descriptor('List'), descriptor('Glob'), descriptor('Grep'),
  descriptor('MemorySearch'), descriptor('MemoryList'), descriptor('UserActivityList'),
  descriptor('Write', 'workspace_write'), descriptor('Edit', 'workspace_write'),
  descriptor('WaitForWorkspaceReady'),
  descriptor('Shell', 'dangerous'), descriptor('CronManage', 'dangerous'),
  descriptor('Agent'), descriptor('WebSearch'), descriptor('Skill'), descriptor('CreateArtifact', 'workspace_write'),
];

function fakeToolRuntime(invokeSpy = vi.fn(async () => ({ content: 'ok' }))): ToolRuntime {
  return {
    list: () => ALL_TOOLS,
    invoke: invokeSpy as unknown as ToolRuntime['invoke'],
  };
}

function toolContext(root = '/ws/tenant/user'): ToolCallContext {
  return {
    channelContext: { channel: 'cron' },
    workspace: { root, executionTarget: 'server-local' },
  } as ToolCallContext;
}

// ============================================
// toolProfiles
// ============================================

describe('memory_poll tool profile', () => {
  it('无 profile 时原样返回 runtime', () => {
    const inner = fakeToolRuntime();
    expect(applyToolProfile(inner, undefined)).toBe(inner);
  });

  it('白名单过滤：模型只看得到受限工具集', () => {
    const runtime = applyToolProfile(fakeToolRuntime(), 'memory_poll');
    const names = runtime.list(toolContext()).map((tool) => tool.name).sort();
    expect(names).toEqual([
      'Edit', 'Glob', 'Grep', 'List', 'MemoryList', 'MemorySearch',
      'Read', 'UserActivityList', 'WaitForWorkspaceReady', 'Write',
    ]);
    expect(names).not.toContain('Shell');
    expect(names).not.toContain('CronManage');
    expect(names).not.toContain('Agent');
  });

  it('invoke 拦截白名单外工具', async () => {
    const runtime = applyToolProfile(fakeToolRuntime(), 'memory_poll');
    await expect(
      runtime.invoke({ toolId: 'Shell', input: { command: 'ls' } } as never, toolContext()),
    ).rejects.toThrow(/不在 memory_poll profile/);
  });

  it.each([
    ['MEMORY.md'],
    ['memory/2026-07-14.md'],
    ['memory/topics/co-strategy.md'],
    ['/ws/tenant/user/memory/2026-07-14.md'],
  ])('Write 允许记忆路径 %s', async (path) => {
    const invokeSpy = vi.fn(async () => ({ content: 'ok' }));
    const runtime = applyToolProfile(fakeToolRuntime(invokeSpy), 'memory_poll');
    await runtime.invoke({ toolId: 'Write', input: { path, content: 'x' } } as never, toolContext());
    expect(invokeSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['assets/20260714/report.md'],
    ['memory/notes.txt'],
    ['../other-user/MEMORY.md'],
    ['/etc/passwd'],
    ['code.ts'],
    ['memory-fake/x.md'],
  ])('Write 拒绝非记忆路径 %s', async (path) => {
    const runtime = applyToolProfile(fakeToolRuntime(), 'memory_poll');
    await expect(
      runtime.invoke({ toolId: 'Write', input: { path, content: 'x' } } as never, toolContext()),
    ).rejects.toThrow(/memory_poll 工具约束/);
  });

  it('Edit 使用 file_path 参数并同样受路径 guard', async () => {
    const invokeSpy = vi.fn(async () => ({ content: 'ok' }));
    const runtime = applyToolProfile(fakeToolRuntime(invokeSpy), 'memory_poll');
    await runtime.invoke(
      { toolId: 'Edit', input: { file_path: 'memory/2026-07-14.md', old_string: 'a', new_string: 'b' } } as never,
      toolContext(),
    );
    expect(invokeSpy).toHaveBeenCalledTimes(1);
    await expect(
      runtime.invoke(
        { toolId: 'Edit', input: { file_path: 'assets/x.md', old_string: 'a', new_string: 'b' } } as never,
        toolContext(),
      ),
    ).rejects.toThrow(/memory_poll 工具约束/);
  });

  it('只读白名单工具不受路径 guard 影响', async () => {
    const invokeSpy = vi.fn(async () => ({ content: 'ok' }));
    const runtime = applyToolProfile(fakeToolRuntime(invokeSpy), 'memory_poll');
    await runtime.invoke({ toolId: 'Read', input: { path: 'assets/20260714/report.md' } } as never, toolContext());
    expect(invokeSpy).toHaveBeenCalledTimes(1);
  });
});

// ============================================
// UserActivityService
// ============================================

function makeEvent(partial: Partial<PlatformEvent> & { type: PlatformEvent['type'] }): PlatformEvent {
  return { id: `evt-${Math.random()}`, timestamp: '2026-07-14T02:00:00.000Z', ...partial } as PlatformEvent;
}

describe('UserActivityService', () => {
  const sessionRecord = (overrides: Record<string, unknown> = {}) => ({
    sessionId: 's1',
    tenantId: 'kaiyan',
    userId: 'u1',
    kind: 'user' as const,
    updatedAt: '2026-07-14T03:00:00.000Z',
    metaJson: { userId: 'u1', username: 'u1', channel: 'web', createdAt: '2026-07-14T00:00:00.000Z' },
    ...overrides,
  });

  function makeService(sessions: unknown[], eventsBySession: Record<string, PlatformEvent[]>) {
    const projection = {
      list: vi.fn(async () => ({ items: sessions })),
    };
    const eventStore = {
      append: vi.fn(),
      list: vi.fn(async (sessionId: string) => eventsBySession[sessionId] ?? []),
    };
    return new UserActivityService({
      sessionProjection: projection as never,
      eventStore: eventStore as never,
    });
  }

  it('只保留 web/dingtalk 发起 run 的 user_message（cron prompt 排除）', async () => {
    const service = makeService([sessionRecord()], {
      s1: [
        makeEvent({ type: 'run_started', runId: 'r-web', sessionId: 's1', model: 'm', channel: 'web' }),
        makeEvent({ type: 'run_started', runId: 'r-cron', sessionId: 's1', model: 'm', channel: 'cron' }),
        makeEvent({ type: 'run_started', runId: 'r-dt', sessionId: 's1', model: 'm', channel: 'dingtalk' }),
        makeEvent({ type: 'user_message', runId: 'r-web', sessionId: 's1', content: '来自 web' }),
        makeEvent({ type: 'user_message', runId: 'r-cron', sessionId: 's1', content: '来自 cron 自动 prompt' }),
        makeEvent({ type: 'user_message', runId: 'r-dt', sessionId: 's1', content: '来自钉钉' }),
      ],
    });
    const result = await service.listActivity({
      tenantId: 'kaiyan', userId: 'u1', sinceIso: '2026-07-13T00:00:00.000Z',
    });
    const contents = result.sessions.flatMap((session) => session.messages.map((message) => message.content));
    expect(contents).toEqual(['来自 web', '来自钉钉']);
  });

  it('后台任务完成通知不计为用户主动活动', async () => {
    const service = makeService([sessionRecord()], {
      s1: [
        makeEvent({ type: 'run_started', runId: 'r-bg', sessionId: 's1', model: 'm', channel: 'web' }),
        makeEvent({
          type: 'user_message',
          runId: 'r-bg',
          sessionId: 's1',
          content: '<task-notification>\n<task-id>bg-1</task-id>\n<status>completed</status>\n<summary>完成</summary>\n</task-notification>',
        }),
      ],
    });
    const result = await service.listActivity({
      tenantId: 'kaiyan', userId: 'u1', sinceIso: '2026-07-13T00:00:00.000Z',
    });
    expect(result.sessions).toEqual([]);
  });

  it('排除记忆轮询会话（cronSystemKind 真源）', async () => {
    const service = makeService(
      [
        sessionRecord(),
        sessionRecord({
          sessionId: 's2',
          metaJson: { userId: 'u1', username: 'u1', channel: 'cron', createdAt: 'x', cronSystemKind: 'memory_poll', cronJobName: '记忆轮询' },
        }),
      ],
      {
        s1: [
          makeEvent({ type: 'run_started', runId: 'r1', sessionId: 's1', model: 'm', channel: 'web' }),
          makeEvent({ type: 'user_message', runId: 'r1', sessionId: 's1', content: 'hello' }),
        ],
        s2: [
          makeEvent({ type: 'run_started', runId: 'r2', sessionId: 's2', model: 'm', channel: 'web' }),
          makeEvent({ type: 'user_message', runId: 'r2', sessionId: 's2', content: '轮询会话里的消息' }),
        ],
      },
    );
    const result = await service.listActivity({ tenantId: 'kaiyan', userId: 'u1', sinceIso: '2026-07-13T00:00:00.000Z' });
    expect(result.sessions.map((session) => session.sessionId)).toEqual(['s1']);
  });

  it('时间窗过滤：窗口外的消息不计', async () => {
    const service = makeService([sessionRecord()], {
      s1: [
        makeEvent({ type: 'run_started', runId: 'r1', sessionId: 's1', model: 'm', channel: 'web' }),
        makeEvent({ type: 'user_message', runId: 'r1', sessionId: 's1', content: '旧消息', timestamp: '2026-07-10T00:00:00.000Z' }),
        makeEvent({ type: 'user_message', runId: 'r1', sessionId: 's1', content: '新消息', timestamp: '2026-07-14T02:00:00.000Z' }),
      ],
    });
    const result = await service.listActivity({ tenantId: 'kaiyan', userId: 'u1', sinceIso: '2026-07-13T00:00:00.000Z' });
    expect(result.sessions[0]!.messages.map((message) => message.content)).toEqual(['新消息']);
  });

  it('hasActivity：有消息 true / 无消息 false / 数据源缺失 null', async () => {
    const withActivity = makeService([sessionRecord()], {
      s1: [
        makeEvent({ type: 'run_started', runId: 'r1', sessionId: 's1', model: 'm', channel: 'web' }),
        makeEvent({ type: 'user_message', runId: 'r1', sessionId: 's1', content: 'hi' }),
      ],
    });
    await expect(withActivity.hasActivity({ tenantId: 'kaiyan', userId: 'u1', sinceIso: '2026-07-13T00:00:00.000Z' })).resolves.toBe(true);

    const noActivity = makeService([sessionRecord()], { s1: [] });
    await expect(noActivity.hasActivity({ tenantId: 'kaiyan', userId: 'u1', sinceIso: '2026-07-13T00:00:00.000Z' })).resolves.toBe(false);

    const unavailable = new UserActivityService({ sessionProjection: null, eventStore: null });
    expect(unavailable.available).toBe(false);
    await expect(unavailable.hasActivity({ tenantId: 'kaiyan', userId: 'u1', sinceIso: 'x' })).resolves.toBeNull();
  });

  it('projection 查询强制带调用方身份与 kind=user', async () => {
    const projection = { list: vi.fn(async () => ({ items: [] })) };
    const service = new UserActivityService({
      sessionProjection: projection as never,
      eventStore: { append: vi.fn(), list: vi.fn(async () => []) } as never,
    });
    await service.listActivity({ tenantId: 'kaiyan', userId: 'u1', sinceIso: '2026-07-13T00:00:00.000Z' });
    expect(projection.list).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'kaiyan',
      userId: 'u1',
      kind: 'user',
      includeDeleted: false,
    }));
  });
});

// ============================================
// reconcile
// ============================================

describe('reconcileMemoryPollJobs', () => {
  const tenantStore = {
    getSettings: vi.fn((tenantId: string) => ({
      features: { memoryPollingEnabled: tenantId === 'kaiyan' },
    })),
  };
  const user = (id: string, overrides: Record<string, unknown> = {}) => ({
    id, username: id, role: 'user' as const, tenantId: 'kaiyan', ...overrides,
  });
  const systemJob = (owner: string, enabled = true, createdAtMs = 1_000): CronJob => ({
    id: `job-${owner}-${createdAtMs}`,
    name: MEMORY_POLL_JOB_NAME,
    enabled,
    systemKind: 'memory_poll',
    // 用当前散列结果生成，避免"幂等测试"被 drift 检测误判为需要 reschedule
    schedule: buildMemoryPollSchedule(owner, 4, 4, 'Asia/Shanghai'),
    payload: { kind: 'agentTurn', message: 'placeholder' },
    owner,
    createdAtMs,
    updatedAtMs: createdAtMs,
    state: {},
  });

  it('灰度租户缺任务 → 创建（默认 4h 窗口，按 userId 散列到 hour+minute）', () => {
    const plan = reconcileMemoryPollJobs({
      users: [user('u1'), user('u2', { tenantId: 'wain' })],
      existingJobs: [],
      tenantStore: tenantStore as never,
      enabled: true,
      nowMs: 5_000,
    });
    expect(plan.toCreate).toHaveLength(1);
    const job = plan.toCreate[0]!;
    expect(job.owner).toBe('u1');
    expect(job.systemKind).toBe('memory_poll');
    expect(job.schedule).toEqual(buildMemoryPollSchedule('u1', 4, 4, 'Asia/Shanghai'));
    // 期望：hour ∈ [4, 8)，minute ∈ [0, 60)，散列稳定
    const slot = hashSlot('u1', 4);
    expect(slot.hourOffset).toBeGreaterThanOrEqual(0);
    expect(slot.hourOffset).toBeLessThan(4);
    expect(slot.minute).toBeGreaterThanOrEqual(0);
    expect(slot.minute).toBeLessThan(60);
    expect(hashSlot('u1', 4)).toEqual(hashSlot('u1', 4)); // 稳定
  });

  it('hashSlot 均匀性：不同 userId 分布到不同槽', () => {
    const buckets = new Map<string, number>();
    for (let i = 0; i < 100; i++) {
      const slot = hashSlot(`user-${i}`, 4);
      const key = `${slot.hourOffset}:${slot.minute}`;
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }
    // 100 用户散到 240 槽，大多数槽 ≤1 人；最大并发槽 ≤3（Poisson 上分位）
    const maxPerBucket = Math.max(...buckets.values());
    expect(maxPerBucket).toBeLessThanOrEqual(3);
    // 覆盖率：至少 60 个不同槽
    expect(buckets.size).toBeGreaterThan(60);
  });

  it('配置变更后 reconcile 检测 schedule drift 并重排（保留 job.id）', () => {
    // 存量任务：旧 60 槽实现（hour=4 固定）
    const legacy = systemJob('u1', true);
    legacy.schedule = { kind: 'cron', expr: '7 4 * * *', tz: 'Asia/Shanghai' };
    const plan = reconcileMemoryPollJobs({
      users: [user('u1')],
      existingJobs: [legacy],
      tenantStore: tenantStore as never,
      enabled: true,
      hour: 4,
      hoursSpan: 4,
      nowMs: 5_000,
    });
    // 只要新散列结果不是 04:07（大概率），就应触发 reschedule
    const expected = buildMemoryPollSchedule('u1', 4, 4, 'Asia/Shanghai');
    if (expected.expr === '7 4 * * *') {
      // 罕见：散列恰好命中旧槽，跳过本 case
      return;
    }
    expect(plan.stats.rescheduled).toBe(1);
    expect(plan.toUpdate).toHaveLength(1);
    expect(plan.toUpdate[0]!.id).toBe(legacy.id); // job.id 稳定
    expect(plan.toUpdate[0]!.schedule).toEqual(expected);
    expect(plan.toUpdate[0]!.enabled).toBe(true);
  });

  it('平台开关关闭 → 存量系统任务禁用、不创建新任务', () => {
    const plan = reconcileMemoryPollJobs({
      users: [user('u1'), user('u2')],
      existingJobs: [systemJob('u1', true)],
      tenantStore: tenantStore as never,
      enabled: false,
      nowMs: 5_000,
    });
    expect(plan.toCreate).toHaveLength(0);
    expect(plan.toUpdate).toHaveLength(1);
    expect(plan.toUpdate[0]!.enabled).toBe(false);
  });

  it('用户禁用 → 任务禁用；重新启用 → 任务恢复', () => {
    const disabledPlan = reconcileMemoryPollJobs({
      users: [user('u1', { disabled: true })],
      existingJobs: [systemJob('u1', true)],
      tenantStore: tenantStore as never,
      enabled: true,
      nowMs: 5_000,
    });
    expect(disabledPlan.toUpdate[0]!.enabled).toBe(false);

    const enabledPlan = reconcileMemoryPollJobs({
      users: [user('u1')],
      existingJobs: [systemJob('u1', false)],
      tenantStore: tenantStore as never,
      enabled: true,
      nowMs: 5_000,
    });
    expect(enabledPlan.toUpdate[0]!.enabled).toBe(true);
  });

  it('同一用户多条系统任务 → 保留最早，其余禁用', () => {
    const plan = reconcileMemoryPollJobs({
      users: [user('u1')],
      existingJobs: [systemJob('u1', true, 2_000), systemJob('u1', true, 1_000)],
      tenantStore: tenantStore as never,
      enabled: true,
      nowMs: 5_000,
    });
    expect(plan.stats.duplicatesDisabled).toBe(1);
    expect(plan.toUpdate[0]!.createdAtMs).toBe(2_000); // 晚创建的被禁
  });

  it('owner 已不存在 → 任务禁用', () => {
    const plan = reconcileMemoryPollJobs({
      users: [],
      existingJobs: [systemJob('ghost', true)],
      tenantStore: tenantStore as never,
      enabled: true,
      nowMs: 5_000,
    });
    expect(plan.toUpdate).toHaveLength(1);
    expect(plan.toUpdate[0]!.enabled).toBe(false);
  });

  it('幂等：目标态一致时无任何变更', () => {
    const plan = reconcileMemoryPollJobs({
      users: [user('u1')],
      existingJobs: [systemJob('u1', true)],
      tenantStore: tenantStore as never,
      enabled: true,
      nowMs: 5_000,
    });
    expect(plan.toCreate).toHaveLength(0);
    expect(plan.toUpdate).toHaveLength(0);
  });
});

// ============================================
// session meta 隐藏判断
// ============================================

describe('isMemoryPollSessionMeta / isMemoryPollJob', () => {
  it('cronSystemKind 是真源', () => {
    expect(isMemoryPollSessionMeta({ cronSystemKind: 'memory_poll', cronJobName: '随便什么名字' } as never)).toBe(true);
  });
  it('名称后缀兼容存量任务', () => {
    expect(isMemoryPollSessionMeta({ cronJobName: 'admin记忆轮询' } as never)).toBe(true);
    expect(isMemoryPollSessionMeta({ cronJobName: 'xx心跳轮询' } as never)).toBe(true);
    expect(isMemoryPollSessionMeta({ cronJobName: '普通任务' } as never)).toBe(false);
  });
  it('isMemoryPollJob 与会话判断对齐', () => {
    expect(isMemoryPollJob({ systemKind: 'memory_poll', name: 'x' })).toBe(true);
    expect(isMemoryPollJob({ name: '每日记忆轮询' })).toBe(true);
    expect(isMemoryPollJob({ name: '普通任务' })).toBe(false);
  });
});

// ============================================
// 记忆轮询会话可见性（B 方案：只 platform admin 能看，2026-07-14）
// ============================================

describe('memory poll visibility — platform admin only', () => {
  const memoryPollMeta = {
    userId: 'u1',
    username: 'u1',
    channel: 'cron',
    createdAt: '2026-07-14T00:00:00.000Z',
    cronSystemKind: 'memory_poll' as const,
    cronJobName: '记忆轮询',
  };
  const normalMeta = {
    userId: 'u1',
    username: 'u1',
    channel: 'web',
    createdAt: '2026-07-14T00:00:00.000Z',
  };

  const platformAdmin: SessionAccessUser = { sub: 'u1', username: 'u1', role: 'admin', tenantId: 'pantheon' };
  const orgAdmin: SessionAccessUser = { sub: 'u1', username: 'u1', role: 'admin', tenantId: 'kaiyan' };
  const orgUser: SessionAccessUser = { sub: 'u1', username: 'u1', role: 'user', tenantId: 'kaiyan' };

  it('isPlatformAdminUser：pantheon+admin 才通过', () => {
    expect(isPlatformAdminUser(platformAdmin)).toBe(true);
    expect(isPlatformAdminUser(orgAdmin)).toBe(false); // 组织 admin 不算
    expect(isPlatformAdminUser(orgUser)).toBe(false);
    expect(isPlatformAdminUser(undefined)).toBe(false);
  });

  it('hidesMemoryPollFrom：普通会话对任何人都不隐藏', () => {
    expect(hidesMemoryPollFrom(platformAdmin, normalMeta as never)).toBe(false);
    expect(hidesMemoryPollFrom(orgAdmin, normalMeta as never)).toBe(false);
    expect(hidesMemoryPollFrom(orgUser, normalMeta as never)).toBe(false);
  });

  it('hidesMemoryPollFrom：记忆轮询会话只对 platform admin 不隐藏', () => {
    expect(hidesMemoryPollFrom(platformAdmin, memoryPollMeta as never)).toBe(false);
    expect(hidesMemoryPollFrom(orgAdmin, memoryPollMeta as never)).toBe(true);  // 关键：组织 admin 被隐藏
    expect(hidesMemoryPollFrom(orgUser, memoryPollMeta as never)).toBe(true);
    expect(hidesMemoryPollFrom(undefined, memoryPollMeta as never)).toBe(true);
  });

  it('canExposeSessionToUser：组织 admin 看不到自己的记忆轮询（B 方案核心）', () => {
    expect(canExposeSessionToUser(platformAdmin, memoryPollMeta as never)).toBe(true);
    expect(canExposeSessionToUser(orgAdmin, memoryPollMeta as never)).toBe(false);
    expect(canExposeSessionToUser(orgUser, memoryPollMeta as never)).toBe(false);
    // 但组织 admin 看得到自己的普通会话（其他行为不变）
    expect(canExposeSessionToUser(orgAdmin, normalMeta as never)).toBe(true);
  });

  it('存量心跳轮询会话沿用同一收紧规则', () => {
    const heartbeat = { ...normalMeta, cronJobName: '心跳轮询' };
    expect(hidesMemoryPollFrom(orgAdmin, heartbeat as never)).toBe(true);
    expect(hidesMemoryPollFrom(platformAdmin, heartbeat as never)).toBe(false);
  });
});

// ============================================
// executor memory_poll 分支
// ============================================

describe('executor memory_poll', () => {
  beforeEach(() => resetMemoryMaintenanceLocks());

  const memoryPollJob = (): CronJob => ({
    id: 'job-mp',
    name: MEMORY_POLL_JOB_NAME,
    enabled: true,
    systemKind: 'memory_poll',
    schedule: { kind: 'cron', expr: '7 4 * * *', tz: 'Asia/Shanghai' },
    payload: { kind: 'agentTurn', message: 'placeholder' },
    owner: 'u1',
    createdAtMs: 1,
    updatedAtMs: 1,
    state: {},
  });
  const userStore = {
    findById: vi.fn((id: string) => (id === 'u1'
      ? { id: 'u1', username: 'alice', role: 'user' as const, tenantId: 'kaiyan' }
      : undefined)),
  };
  const activity = (hasActivity: boolean | null, available = true) => ({
    available,
    hasActivity: vi.fn(async () => hasActivity),
  });

  it('48h 无活动 → skipped 且不起 run', async () => {
    const runAgent = vi.fn();
    const result = await executeJob(memoryPollJob(), {
      runAgent: runAgent as never,
      agentCwd: '/tmp',
      sharedDir: '/tmp/.shared',
      userStore,
      userActivityService: activity(false) as never,
    });
    expect(result.status).toBe('skipped');
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('预检数据源不可用 → skipped（fail-closed 不空跑）', async () => {
    const runAgent = vi.fn();
    const result = await executeJob(memoryPollJob(), {
      runAgent: runAgent as never,
      agentCwd: '/tmp',
      sharedDir: '/tmp/.shared',
      userStore,
      userActivityService: activity(null, false) as never,
    });
    expect(result.status).toBe('skipped');
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('维护锁被占 → skipped', async () => {
    expect(tryAcquireMemoryMaintenance('kaiyan', 'u1')).toBe(true);
    const runAgent = vi.fn();
    const result = await executeJob(memoryPollJob(), {
      runAgent: runAgent as never,
      agentCwd: '/tmp',
      sharedDir: '/tmp/.shared',
      userStore,
      userActivityService: activity(true) as never,
    });
    expect(result.status).toBe('skipped');
    expect(result.output).toMatch(/已有记忆维护任务/);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('有活动 → 以受限 options + 版本化提示语起 run，并写 cronSystemKind meta', async () => {
    let capturedOptions: Record<string, unknown> | undefined;
    let capturedMessage: { content: string } | undefined;
    const runAgent = vi.fn((message: never, _context: never, options: never, hooks: { onSessionStart?: (a: string, b?: string) => unknown }) => (async function* () {
      capturedMessage = message;
      capturedOptions = options;
      await hooks?.onSessionStart?.('session-mp', '/tmp/session-mp.jsonl');
      yield { type: 'text_delta', content: '本次无记忆增量' };
      yield { type: 'done' };
    })());

    const result = await executeJob(memoryPollJob(), {
      runAgent: runAgent as never,
      agentCwd: '/tmp',
      sharedDir: '/tmp/.shared',
      userStore,
      userActivityService: activity(true) as never,
      memoryPoll: { lookbackHours: 48 },
    });

    expect(result.status).toBe('ok');
    expect(capturedMessage!.content).toBe(buildMemoryPollPrompt({ lookbackHours: 48 }));
    expect(capturedMessage!.content).toContain('UserActivityList');
    expect(capturedOptions).toMatchObject({
      toolProfile: 'memory_poll',
      approvalPolicy: { autoApproveTools: true },
      executionTarget: 'server-local',
      skipPersona: true,
      skipMemory: true,
    });
  });

  it('run 结束后释放维护锁', async () => {
    const runAgent = vi.fn(() => (async function* () {
      yield { type: 'done' };
    })());
    await executeJob(memoryPollJob(), {
      runAgent: runAgent as never,
      agentCwd: '/tmp',
      sharedDir: '/tmp/.shared',
      userStore,
      userActivityService: activity(true) as never,
    });
    expect(tryAcquireMemoryMaintenance('kaiyan', 'u1')).toBe(true); // 锁已释放
  });
});

// ============================================
// CronService 系统任务 guard
// ============================================

describe('CronService system job guard', () => {
  function makeService(initialJobs: CronJob[]) {
    let saved: CronJob[] = initialJobs;
    const service = new CronService({
      nowMs: () => 10_000,
      loadJobs: async () => initialJobs,
      saveJobs: async (jobs: CronJob[]) => { saved = jobs; },
      executeJob: vi.fn(async () => ({ status: 'ok' as const })),
      appendRunLog: vi.fn(),
    } as never);
    return { service, getSaved: () => saved };
  }
  const sysJob: CronJob = {
    id: 'sys-1',
    name: MEMORY_POLL_JOB_NAME,
    enabled: true,
    systemKind: 'memory_poll',
    schedule: { kind: 'cron', expr: '7 4 * * *', tz: 'Asia/Shanghai' },
    payload: { kind: 'agentTurn', message: 'placeholder' },
    owner: 'u1',
    createdAtMs: 1,
    updatedAtMs: 1,
    state: {},
  };

  it('update/remove 系统任务被拒绝', async () => {
    const { service } = makeService([{ ...sysJob, state: {} }]);
    await expect(service.update('sys-1', { enabled: false })).rejects.toThrow(/系统任务/);
    await expect(service.remove('sys-1')).rejects.toThrow(/系统任务/);
  });

  it('applySystemJobs：创建 + 启停 + 幂等', async () => {
    const { service } = makeService([]);
    await service.applySystemJobs({ toCreate: [{ ...sysJob, state: {} }], toUpdate: [] });
    const created = await service.get('sys-1');
    expect(created?.systemKind).toBe('memory_poll');
    expect(created?.state.nextRunAtMs).toBeGreaterThan(0);

    // 重复创建不生效
    await service.applySystemJobs({ toCreate: [{ ...sysJob, state: {} }], toUpdate: [] });
    expect((await service.list({ includeDisabled: true })).filter((job) => job.id === 'sys-1')).toHaveLength(1);

    // 禁用
    await service.applySystemJobs({ toCreate: [], toUpdate: [{ ...sysJob, enabled: false, updatedAtMs: 11_000 }] });
    const disabled = await service.get('sys-1');
    expect(disabled?.enabled).toBe(false);
    expect(disabled?.state.nextRunAtMs).toBeUndefined();
  });

  it('applySystemJobs 拒绝非系统任务混入', async () => {
    const { service } = makeService([]);
    await service.applySystemJobs({
      toCreate: [{ ...sysJob, id: 'normal-1', systemKind: undefined, state: {} } as CronJob],
      toUpdate: [],
    });
    expect(await service.get('normal-1')).toBeUndefined();
  });
});

// ============================================
// memoryHook
// ============================================

describe('memory maintenance hook（完整修复）', () => {
  beforeEach(() => resetMemoryMaintenanceLocks());

  const baseResult = { finalText: 'x'.repeat(600), hasError: false, hasTools: true };
  const message = { channel: 'web', chatId: 'chat-1', content: '今天做了个决定' };
  const contextFor = (userId: string) => ({
    channel: 'web',
    user: { id: userId, username: userId, role: 'user', tenantId: 'kaiyan' },
  });

  function makeHook(dispatchImpl?: () => AsyncGenerator<unknown>) {
    const calls: Array<{ context: unknown; options: unknown }> = [];
    const dispatch = vi.fn((_message: unknown, context: unknown, options: unknown) => {
      calls.push({ context, options });
      return (dispatchImpl ?? (async function* () { yield { type: 'done' }; }))();
    });
    const hook = createMemoryMaintenanceHook({
      agentCwd: '/tmp/agent',
      config: { enabled: true, minTextLength: 500, cooldownMinutes: 60 },
      maintenanceDispatch: dispatch as never,
    });
    return { hook, dispatch, calls };
  }

  it('无身份不触发（旧实现会空跑然后被 raw runtime 拒绝）', async () => {
    const { hook, dispatch } = makeHook();
    await hook.afterRun(baseResult, message as never, { channel: 'web' } as never);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('透传身份 + 受限 options', async () => {
    const { hook, calls } = makeHook();
    await hook.afterRun(baseResult, message as never, contextFor('u1') as never);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.context).toMatchObject({
      channel: 'web',
      user: { id: 'u1', tenantId: 'kaiyan' },
    });
    expect(calls[0]!.options).toMatchObject({
      toolProfile: 'memory_poll',
      approvalPolicy: { autoApproveTools: true },
      executionTarget: 'server-local',
      persistSession: false,
    });
  });

  it('冷却按用户隔离：u1 成功后 u2 仍可触发，u1 冷却期内不重复', async () => {
    const { hook, dispatch } = makeHook();
    await hook.afterRun(baseResult, message as never, contextFor('u1') as never);
    await hook.afterRun(baseResult, message as never, contextFor('u1') as never);
    expect(dispatch).toHaveBeenCalledTimes(1); // u1 第二次被冷却挡住
    await hook.afterRun(baseResult, message as never, contextFor('u2') as never);
    expect(dispatch).toHaveBeenCalledTimes(2); // u2 不受 u1 冷却影响
  });

  it('error 事件 → 失败如实 + 短重试冷却（不烧成功冷却窗口）', async () => {
    const { hook, dispatch } = makeHook(async function* () {
      yield { type: 'error', error: 'raw runtime 拒绝匿名访问' };
    });
    await hook.afterRun(baseResult, message as never, contextFor('u1') as never);
    expect(dispatch).toHaveBeenCalledTimes(1);
    // 失败后立即重试被 5 分钟重试冷却挡住
    await hook.afterRun(baseResult, message as never, contextFor('u1') as never);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('维护锁被占（如记忆轮询进行中）→ 跳过', async () => {
    expect(tryAcquireMemoryMaintenance('kaiyan', 'u1')).toBe(true);
    const { hook, dispatch } = makeHook();
    await hook.afterRun(baseResult, message as never, contextFor('u1') as never);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('提示语只写当日文件、声明不改 MEMORY.md', async () => {
    const captured: string[] = [];
    const dispatch = vi.fn((msg: { content: string }) => {
      captured.push(msg.content);
      return (async function* () { yield { type: 'done' }; })();
    });
    const hook = createMemoryMaintenanceHook({
      agentCwd: '/tmp/agent',
      config: { enabled: true, minTextLength: 500, cooldownMinutes: 60 },
      maintenanceDispatch: dispatch as never,
    });
    await hook.afterRun(baseResult, message as never, contextFor('u1') as never);
    expect(captured[0]).toContain('不要改 MEMORY.md');
  });
});

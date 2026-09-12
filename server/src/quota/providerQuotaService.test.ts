import type { ProviderQuotaSnapshot } from '@agent/shared';
import { describe, expect, it, vi } from 'vitest';

import type { AppConfig } from '../app/config.js';
import { InMemorySecretVault } from '../security/secretVault.js';
import { ProviderQuotaService } from './providerQuotaService.js';
import type { PgProviderQuotaSnapshotStore } from './providerQuotaSnapshotStore.js';

class FakeStore {
  edits: Array<{ key: string; endTime: string | null; userId: string }> = [];
  notes = new Map<string, string | null>();
  async planExpiryOverrides(keys: string[]) {
    return new Map(this.edits.filter((edit) => keys.includes(edit.key)).map((edit) => [edit.key, edit.endTime]));
  }
  async setPlanExpiry(key: string, endTime: string | null, userId: string) {
    this.edits.push({ key, endTime, userId });
  }
  async planNotes(keys: string[]) {
    return new Map([...this.notes.entries()].filter(([key]) => keys.includes(key)));
  }
  async setPlanNote(key: string, note: string | null) {
    this.notes.set(key, note);
  }

  rows: ProviderQuotaSnapshot[] = [];
  lockAvailable = true;
  pruned: number[] = [];
  async append(snapshots: readonly ProviderQuotaSnapshot[]) {
    this.rows.push(...snapshots);
  }
  async latest() {
    return this.pick(() => true);
  }
  async latestSuccessful() {
    return this.pick((row) => row.ok);
  }
  async history(hours: number) {
    return this.rows.map((row) => ({
      accountKey: row.accountKey,
      collectedAt: row.collectedAt,
      ok: row.ok,
      windows: row.windows.map((w) => ({ id: w.id, usedPercent: w.usedPercent })),
      hours,
    }));
  }
  async prune(days: number) {
    this.pruned.push(days);
    return 0;
  }
  async pushedAccounts(sourceKind: string) {
    return this.pick((row) => row.sourceKind === sourceKind).map((row) => ({
      accountKey: row.accountKey,
      accountLabel: row.accountLabel,
    }));
  }
  async tryAcquireCollectorLock() {
    return this.lockAvailable
      ? async () => {
          this.lockAvailable = true;
        }
      : null;
  }
  private pick(filter: (row: ProviderQuotaSnapshot) => boolean) {
    const byKey = new Map<string, ProviderQuotaSnapshot>();
    for (const row of this.rows) {
      if (!filter(row)) continue;
      const existing = byKey.get(row.accountKey);
      if (!existing || existing.collectedAt <= row.collectedAt) byKey.set(row.accountKey, row);
    }
    return [...byKey.values()];
  }
}

const afpResult = {
  PlanType: 'max',
  AFPFiveHour: { Quota: 50000, Used: 250, ResetTime: 1788605522000 },
  AFPWeekly: { Quota: 175000, Used: 37965, ResetTime: 1788710400000 },
};
const codexUsage = {
  email: 'a@example.com',
  plan_type: 'pro',
  rate_limit: {
    limit_reached: false,
    primary_window: { used_percent: 68, limit_window_seconds: 604800, reset_at: 1789109685 },
  },
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function routedFetch(overrides: Partial<Record<'afp' | 'plan' | 'codex', () => Response>> = {}) {
  return vi.fn(async (url: string | URL | Request) => {
    const href = String(url);
    if (href.includes('wham/usage')) return (overrides.codex ?? (() => json(codexUsage)))();
    const action = new URL(href).searchParams.get('Action');
    if (action === 'GetAFPUsage')
      return (overrides.afp ?? (() => json({ ResponseMetadata: {}, Result: afpResult })))();
    return (
      overrides.plan ??
      (() =>
        json({
          ResponseMetadata: {},
          Result: {
            PlanType: 'Max',
            Status: 'Running',
            EndTime: '2026-09-09T15:59:59Z',
            AutoRenew: false,
          },
        }))
    )();
  }) as unknown as typeof fetch;
}

async function makeModels(vault: InMemorySecretVault): Promise<NonNullable<AppConfig['models']>> {
  const ref = await vault.putSecret(
    '__global__',
    'models',
    'SK-SECRET',
    { actor: 'system', userId: 'models_config_admin', scopes: ['secret:models:write'] },
    { purpose: 'quota-source' },
  );
  return {
    default: 'ark/glm',
    allowCrossGroupSwitch: true,
    groups: [
      {
        id: 'ark',
        name: '火山 Agent Plan',
        baseUrl: 'https://ark.example',
        models: [{ id: 'glm', name: 'GLM', value: 'glm' }],
        quotaSource: {
          provider: 'volcengine_ark_plan',
          accessKeyId: 'AK',
          secretAccessKeyRef: ref.id,
          region: 'cn-beijing',
        },
      },
      { id: 'plain', name: '无套餐', models: [{ id: 'm', name: 'M', value: 'm' }] },
    ] as NonNullable<AppConfig['models']>['groups'],
  };
}

const statusAvailability: Record<string, 'available' | 'quota_cooldown' | 'auth_unavailable'> = {};

function codexManager(refs: string[], enabled = true) {
  return {
    getConfiguration: () => ({ enabled, credentialRefs: refs }) as never,
    getCredentialRefs: () => refs,
    getStatuses: async () =>
      refs.map((ref, index) => ({
        id: ref,
        priority: index + 1,
        configured: true,
        connected: true,
        email: `${ref}@mail`,
        expiresAt: '2026-09-14T06:22:10.000Z',
        availability: statusAvailability[ref] ?? ('available' as const),
        ...(statusAvailability[ref] === 'quota_cooldown'
          ? { cooldownUntil: '2026-09-05T07:30:00.000Z', lastFailureCode: 'usage_limit_reached' }
          : {}),
      })),
    getCredentialsForCredential: async (ref: string) => ({
      accessToken: `tok-${ref}`,
      accountId: `acct-${ref}`,
      refreshToken: 'r',
      expiresAt: 'x',
      generation: 1,
    }),
  };
}

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
let clock = 0;
const now = () => new Date(Date.UTC(2026, 8, 5, 6, clock++, 0));

describe('ProviderQuotaService', () => {
  it('按规范化邮箱继承手动到期，采集不覆盖，清除回退供应商时间且保留审计', async () => {
    const store = new FakeStore();
    const refs = ['old'];
    let email = ' Shared@Example.com ';
    const manager = codexManager(refs);
    manager.getStatuses = async () => refs.map((id) => ({ id, email, configured: true, connected: true, priority: 1, expiresAt: '', availability: 'available' as const }));
    const service = new ProviderQuotaService({ store: store as unknown as PgProviderQuotaSnapshotStore, getModelsConfig: () => undefined, codexCredentialManager: manager, enableCollector: false, fetchImpl: routedFetch(), now, logger });
    await service.refresh();
    await service.setPlanExpiry('codex:old', '2026-10-01T15:59:00Z', 'admin-1');
    refs.splice(0, 1, 'new');
    email = 'shared@example.com';
    await service.refresh();
    expect((await service.overview()).items[0]?.planExpiry).toMatchObject({ editable: true, manualEndTime: '2026-10-01T15:59:00Z' });
    expect(store.edits[0]).toEqual({ key: 'codex-email:shared@example.com', endTime: '2026-10-01T15:59:00Z', userId: 'admin-1' });
    await service.setPlanExpiry('codex:new', null, 'admin-2');
    expect((await service.overview()).items[0]?.planExpiry?.endTime).toBeUndefined();
    expect(store.edits).toHaveLength(2);
    email = 'different@example.com';
    expect((await service.overview()).items[0]?.planExpiry?.manualEndTime).toBeUndefined();
    await expect(service.setPlanExpiry('codex:old', null, 'admin')).rejects.toThrow('账号不存在');
    email = '';
    expect((await service.overview()).items[0]?.planExpiry?.editable).toBe(false);
    await expect(service.setPlanExpiry('codex:new', null, 'admin')).rejects.toThrow('邮箱');
    await expect(service.setPlanNote('codex:new', '备注', 'admin')).rejects.toThrow('邮箱');
  });

  it('Claude 订阅：首次上报即出现在看板，采集轮跳过，点名刷新明确拒绝', async () => {
    const store = new FakeStore();
    const pushed: ProviderQuotaSnapshot = {
      sourceKind: 'claude_subscription',
      accountKey: 'claude:kaiyankeji.5@gmail.com',
      accountLabel: 'kaiyankeji.5@gmail.com',
      windows: [
        { id: 'five_hour', label: '5 小时', windowSeconds: 18_000, usedPercent: 22, resetAt: '2026-09-07T15:20:00.000Z' },
        { id: 'seven_day', label: '7 天', windowSeconds: 604_800, usedPercent: 37, resetAt: '2026-09-13T00:00:00.000Z' },
      ],
      limitReached: false,
      ok: true,
      collectedAt: '2026-09-05T06:00:00.000Z',
    };
    // 采集端直接写快照表，平台侧没有任何配置。
    await store.append([pushed]);
    const service = new ProviderQuotaService({ store: store as unknown as PgProviderQuotaSnapshotStore, getModelsConfig: () => undefined, enableCollector: false, fetchImpl: routedFetch(), now, logger });

    const discovered = (await service.overview()).items;
    expect(discovered).toHaveLength(1);
    expect(discovered[0]).toMatchObject({ accountKey: 'claude:kaiyankeji.5@gmail.com', sourceKind: 'claude_subscription', ok: true });
    expect(discovered[0]?.windows.map((window) => window.usedPercent)).toEqual([22, 37]);
    // 邮箱可解析 ⇒ 支持手动登记套餐到期。
    expect(discovered[0]?.planExpiry?.editable).toBe(true);

    // 全量刷新：不去取数、不写入新快照。
    await service.refresh();
    expect(store.rows).toHaveLength(1);
    // 点名刷新：明确拒绝，而不是报「账号不存在」或假装采过。
    await expect(service.refresh('claude:kaiyankeji.5@gmail.com')).rejects.toThrow('由采集端主动上报');
    expect(store.rows).toHaveLength(1);

    // 历史曲线照常包含推送型账号。
    expect((await service.history(24)).points.map((point) => point.accountKey)).toEqual(['claude:kaiyankeji.5@gmail.com']);
  });

  it('火山按分组存储，清除手动设置后显示供应商到期，不改变快照', async () => {
    const store = new FakeStore();
    const vault = new InMemorySecretVault();
    const models = await makeModels(vault);
    const service = new ProviderQuotaService({ store: store as unknown as PgProviderQuotaSnapshotStore, getModelsConfig: () => models, secretVault: vault, enableCollector: false, fetchImpl: routedFetch(), now, logger });
    await service.refresh();
    await service.setPlanExpiry('volcengine:ark', '2026-12-01T00:00:00Z', 'admin');
    await service.refresh();
    let item = (await service.overview()).items[0]!;
    expect(item.planExpiry).toMatchObject({ endTime: '2026-12-01T00:00:00Z', providerEndTime: '2026-09-09T15:59:59Z' });
    expect(item.plan?.endTime).toBe('2026-09-09T15:59:59Z');
    await service.setPlanExpiry('volcengine:ark', null, 'admin');
    item = (await service.overview()).items[0]!;
    expect(item.planExpiry?.endTime).toBe(item.plan?.endTime);
    expect(store.edits[0]?.key).toBe('volcengine:ark');
  });

  it('按模型分组 quotaSource 与 Codex 授权账号枚举数据源并落快照', async () => {
    const vault = new InMemorySecretVault();
    const models = await makeModels(vault);
    const store = new FakeStore();
    const fetchImpl = routedFetch();
    const service = new ProviderQuotaService({
      store: store as unknown as PgProviderQuotaSnapshotStore,
      getModelsConfig: () => models,
      secretVault: vault,
      codexCredentialManager: codexManager(['c1', 'c2']),
      enableCollector: true,
      fetchImpl,
      now,
      logger,
    });
    const snapshots = await service.runOnce();
    expect(snapshots.map((s) => [s.accountKey, s.ok])).toEqual([
      ['volcengine:ark', true],
      ['codex:c1', true],
      ['codex:c2', true],
    ]);
    const ark = snapshots[0]!;
    expect(ark.accountLabel).toBe('火山 Agent Plan');
    expect(ark.plan).toMatchObject({ type: 'Max', status: 'Running' });
    expect(ark.windows.map((w) => w.id)).toEqual(['five_hour', 'weekly']);
    expect(snapshots[1]!.accountLabel).toBe('a@example.com');
    expect(snapshots[1]!.plan).toEqual({ type: 'pro' });
    expect(store.rows).toHaveLength(3);
    expect(store.pruned).toEqual([30]);
    const codexCall = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.find((call) =>
      String(call[0]).includes('wham'),
    )!;
    expect((codexCall[1] as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer tok-c1',
      'ChatGPT-Account-Id': 'acct-c1',
    });
  });

  it('拿不到集群单例锁时跳过本轮；Codex transport 未启用时不采 Codex', async () => {
    const vault = new InMemorySecretVault();
    const models = await makeModels(vault);
    const store = new FakeStore();
    store.lockAvailable = false;
    const service = new ProviderQuotaService({
      store: store as unknown as PgProviderQuotaSnapshotStore,
      getModelsConfig: () => models,
      secretVault: vault,
      codexCredentialManager: codexManager(['c1'], false),
      enableCollector: true,
      fetchImpl: routedFetch(),
      now,
      logger,
    });
    expect(await service.runOnce()).toEqual([]);
    expect(store.rows).toHaveLength(0);
    store.lockAvailable = true;
    const snapshots = await service.runOnce();
    expect(snapshots.map((s) => s.accountKey)).toEqual(['volcengine:ark']);
  });

  it('单账号失败只影响该账号，overview 保留其上一次成功用量并附错误', async () => {
    const vault = new InMemorySecretVault();
    const models = await makeModels(vault);
    const store = new FakeStore();
    let failCodex = false;
    const fetchImpl = routedFetch({
      codex: () =>
        failCodex ? new Response('{"detail":"Unauthorized"}', { status: 401 }) : json(codexUsage),
    });
    const service = new ProviderQuotaService({
      store: store as unknown as PgProviderQuotaSnapshotStore,
      getModelsConfig: () => models,
      secretVault: vault,
      codexCredentialManager: codexManager(['c1']),
      enableCollector: false,
      fetchImpl,
      now,
      logger,
    });
    await service.refresh();
    failCodex = true;
    const second = await service.refresh();
    expect(second.find((s) => s.accountKey === 'codex:c1')).toMatchObject({
      ok: false,
      windows: [],
    });
    expect(second.find((s) => s.accountKey === 'codex:c1')!.error).toMatch(/HTTP 401/u);
    const overview = await service.overview();
    const codex = overview.items.find((s) => s.accountKey === 'codex:c1')!;
    expect(codex.ok).toBe(false);
    expect(codex.windows).toHaveLength(1);
    expect(codex.extra?.lastSuccessAt).toBeTypeOf('string');
    expect(codex.collectedAt).toBe(codex.extra?.lastSuccessAt);
    expect(codex.collectedAt).not.toBe(second.find((s) => s.accountKey === 'codex:c1')!.collectedAt);
    expect(overview.collector).toMatchObject({ enabled: false, intervalMs: 300_000 });
    // 失败时拿不到 usage 邮箱，回落到凭据状态里的邮箱
    expect(overview.collector.lastError).toMatch(/c1@mail: Codex usage HTTP 401/u);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('overview/history 只返回当前配置里仍存在的账号', async () => {
    const vault = new InMemorySecretVault();
    const models = await makeModels(vault);
    const store = new FakeStore();
    let refs = ['c1', 'c2'];
    const manager = {
      ...codexManager(['c1', 'c2']),
      getCredentialRefs: () => refs,
      getConfiguration: () => ({ enabled: true, credentialRefs: refs }) as never,
    };
    const service = new ProviderQuotaService({
      store: store as unknown as PgProviderQuotaSnapshotStore,
      getModelsConfig: () => models,
      secretVault: vault,
      codexCredentialManager: manager,
      enableCollector: false,
      fetchImpl: routedFetch(),
      now,
      logger,
    });
    await service.refresh();
    refs = ['c1'];
    const overview = await service.overview();
    expect(overview.items.map((s) => s.accountKey).sort()).toEqual(['codex:c1', 'volcengine:ark']);
    const history = await service.history(48);
    expect(history.hours).toBe(48);
    expect(history.points.map((p) => p.accountKey).sort()).toEqual(['codex:c1', 'volcengine:ark']);
  });

  it('test()：Secret 留空时读取分组已保存的 vault ref；缺 Secret 直接报错', async () => {
    const vault = new InMemorySecretVault();
    const models = await makeModels(vault);
    const fetchImpl = routedFetch();
    const service = new ProviderQuotaService({
      store: new FakeStore() as unknown as PgProviderQuotaSnapshotStore,
      getModelsConfig: () => models,
      secretVault: vault,
      enableCollector: false,
      fetchImpl,
      now,
      logger,
    });
    const result = await service.test({
      provider: 'volcengine_ark_plan',
      accessKeyId: 'AK',
      groupId: 'ark',
    });
    expect(result.plan?.type).toBe('Max');
    expect(result.windows).toHaveLength(2);
    await expect(
      service.test({ provider: 'volcengine_ark_plan', accessKeyId: 'AK', groupId: 'plain' }),
    ).rejects.toThrow(/缺少 Secret Access Key/u);
    await expect(
      service.test({
        provider: 'volcengine_ark_plan',
        accessKeyId: 'AK',
        secretAccessKey: 'direct',
      }),
    ).resolves.toMatchObject({ limitReached: false });
  });

  it('Codex 快照带重置券与凭据状态，overview 叠加实时凭据状态；refresh 可按账号单采', async () => {
    const vault = new InMemorySecretVault();
    const models = await makeModels(vault);
    const store = new FakeStore();
    const fetchImpl = routedFetch({
      codex: () => json({ ...codexUsage, rate_limit_reset_credits: { available_count: 2 } }),
    });
    const service = new ProviderQuotaService({
      store: store as unknown as PgProviderQuotaSnapshotStore,
      getModelsConfig: () => models,
      secretVault: vault,
      codexCredentialManager: codexManager(['c1']),
      enableCollector: false,
      fetchImpl,
      now,
      logger,
    });
    const first = await service.refresh('codex:c1');
    expect(first.map((s) => s.accountKey)).toEqual(['codex:c1']);
    expect(first[0]!.resetCredits).toBe(2);
    expect(first[0]!.credential).toEqual({
      expiresAt: '2026-09-14T06:22:10.000Z',
      availability: 'available',
    });
    await expect(service.refresh('codex:nope')).rejects.toThrow(/账号不存在/u);

    statusAvailability.c1 = 'quota_cooldown';
    try {
      const overview = await service.overview();
      const codex = overview.items.find((s) => s.accountKey === 'codex:c1')!;
      expect(codex.credential).toMatchObject({
        availability: 'quota_cooldown',
        cooldownUntil: '2026-09-05T07:30:00.000Z',
        lastFailureCode: 'usage_limit_reached',
      });
      // 火山账号只在配置里、尚未采集过，不在 overview 中
      expect(overview.items.map((s) => s.accountKey)).toEqual(['codex:c1']);
    } finally {
      delete statusAvailability.c1;
    }
  });

  it('start 只在 enableCollector=true 时安排定时器，stop 可重复调用', () => {
    vi.useFakeTimers();
    try {
      const store = new FakeStore();
      const disabled = new ProviderQuotaService({
        store: store as unknown as PgProviderQuotaSnapshotStore,
        getModelsConfig: () => undefined,
        enableCollector: false,
        logger,
      });
      disabled.start();
      expect(vi.getTimerCount()).toBe(0);
      const enabled = new ProviderQuotaService({
        store: store as unknown as PgProviderQuotaSnapshotStore,
        getModelsConfig: () => undefined,
        enableCollector: true,
        logger,
        intervalMs: 60_000,
      });
      enabled.start();
      expect(vi.getTimerCount()).toBe(1);
      enabled.stop();
      enabled.stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

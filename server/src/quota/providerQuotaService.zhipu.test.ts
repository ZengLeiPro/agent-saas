import { isZhipuCodingPlanGroup, type ProviderQuotaSnapshot } from '@agent/shared';
import { describe, expect, it, vi } from 'vitest';

import type { AppConfig } from '../app/config.js';
import { InMemorySecretVault } from '../security/secretVault.js';
import { ProviderQuotaService } from './providerQuotaService.js';
import type { PgProviderQuotaSnapshotStore } from './providerQuotaSnapshotStore.js';
import { ZHIPU_CODING_PLAN_QUOTA_URL } from './zhipuCodingPlanQuota.js';

type Models = NonNullable<AppConfig['models']>;

function models(groups: Array<Record<string, unknown>>): Models {
  return {
    default: 'zhipu/glm', allowCrossGroupSwitch: true,
    groups: groups.map((group) => ({
      id: 'zhipu', name: '智谱个人套餐',
      baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
      models: [{ id: 'glm', name: 'GLM', value: 'glm-5' }],
      ...group,
    })) as Models['groups'],
  };
}

function storeFixture() {
  const rows: ProviderQuotaSnapshot[] = [];
  const latest = (onlyOk: boolean) => [...new Map(rows.filter((row) => !onlyOk || row.ok)
    .map((row) => [row.accountKey, row])).values()];
  return {
    rows,
    append: vi.fn(async (snapshots: readonly ProviderQuotaSnapshot[]) => { rows.push(...snapshots); }),
    latest: vi.fn(async () => latest(false)),
    latestSuccessful: vi.fn(async () => latest(true)),
    history: vi.fn(async () => rows.map((row) => ({
      accountKey: row.accountKey, collectedAt: row.collectedAt, ok: row.ok,
      windows: row.windows.map(({ id, usedPercent }) => ({ id, usedPercent })),
    }))),
    planExpiryOverrides: vi.fn(async () => new Map<string, string | null>()),
    setPlanExpiry: vi.fn(async () => undefined),
    planNotes: vi.fn(async () => new Map<string, string | null>()),
    setPlanNote: vi.fn(async () => undefined),
    pushedAccounts: vi.fn(async () => []),
    prune: vi.fn(async () => 0),
    tryAcquireCollectorLock: vi.fn(async () => async () => undefined),
  };
}

const jsonQuota = () => new Response(JSON.stringify({
  code: 200, data: { limits: [
    { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 100, currentValue: 30, percentage: 30 },
    { type: 'CREDIT_LIMIT', unit: 6, number: 1, percentage: 75 },
  ] },
}));

function fixture(config: Models) {
  const store = storeFixture();
  const vault = new InMemorySecretVault();
  const fetchImpl = vi.fn(async () => jsonQuota());
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  let current = new Date('2026-09-11T08:00:00Z');
  const service = new ProviderQuotaService({
    store: store as unknown as PgProviderQuotaSnapshotStore,
    getModelsConfig: () => config,
    secretVault: vault,
    enableCollector: false,
    fetchImpl: fetchImpl as typeof fetch,
    now: () => current,
    logger,
  });
  return { store, vault, fetchImpl, logger, service, advance: () => {
    current = new Date(current.getTime() + 300_000);
  } };
}

describe('Zhipu source discovery', () => {
  it.each([
    'https://open.bigmodel.cn/api/coding/paas/v4',
    'https://open.bigmodel.cn/api/anthropic',
    'https://open.bigmodel.cn:443/api/paas/v4',
  ])('recognizes an existing official group: %s', (baseUrl) => {
    expect(isZhipuCodingPlanGroup({ baseUrl })).toBe(true);
  });

  it.each([
    undefined, '', 'not-a-url', 'http://open.bigmodel.cn/api/coding/paas/v4',
    'https://open.bigmodel.cn.evil.example', 'https://evil.example/open.bigmodel.cn',
    'https://open.bigmodel.cn@evil.example', 'https://u:p@open.bigmodel.cn',
    'https://open.bigmodel.cn:8443', 'https://api.z.ai/api/coding/paas/v4',
  ])('does not automatically recognize untrusted or other-region URLs: %s', (baseUrl) => {
    expect(isZhipuCodingPlanGroup({ baseUrl })).toBe(false);
  });

  it('honors explicit selection and explicit opt-out over automatic detection', () => {
    expect(isZhipuCodingPlanGroup({ baseUrl: 'https://proxy.example', quotaSource: { provider: 'zhipu_coding_plan' } })).toBe(true);
    expect(isZhipuCodingPlanGroup({ baseUrl: 'https://open.bigmodel.cn', quotaSource: { provider: 'none' } })).toBe(false);
    expect(isZhipuCodingPlanGroup({ baseUrl: 'https://open.bigmodel.cn', quotaSource: { provider: 'volcengine_ark_plan' } })).toBe(false);
  });
});

describe('Zhipu ProviderQuotaService integration', () => {
  it('reuses the saved Vault Key, persists account-scoped snapshots and uses the existing collector', async () => {
    const config = models([{}]);
    const { service, store, vault, fetchImpl } = fixture(config);
    const ref = await vault.putSecret('__global__', 'models', 'private-vault-key',
      { actor: 'system', userId: 'models_config_admin', scopes: ['secret:models:write'] });
    config.groups[0]!.apiKeyRef = ref.id;
    const snapshots = await service.runOnce();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      sourceKind: 'zhipu_coding_plan', accountKey: 'zhipu:zhipu', groupId: 'zhipu', ok: true,
      extra: { quotaScope: 'account', attribution: 'shared_across_keys' },
    });
    expect(fetchImpl).toHaveBeenCalledWith(ZHIPU_CODING_PLAN_QUOTA_URL,
      expect.objectContaining({ headers: { Authorization: 'private-vault-key', Accept: 'application/json' } }));
    expect(store.prune).toHaveBeenCalledWith(30);
    expect((await service.overview()).items[0]?.planExpiry?.editable).toBe(true);
    expect((await service.history(24)).points).toHaveLength(1);
    expect(JSON.stringify(store.rows)).not.toContain('private-vault-key');
    expect(JSON.stringify(store.rows)).not.toContain(ref.id);
  });

  it('queries separate groups without adding their potentially shared quota and skips opt-out groups', async () => {
    const config = models([
      { id: 'a', apiKey: 'same-account-key' },
      { id: 'b', apiKey: 'another-key', baseUrl: 'https://proxy.example', quotaSource: { provider: 'zhipu_coding_plan' } },
      { id: 'disabled', apiKey: 'not-used', quotaSource: { provider: 'none' } },
      { id: 'other', apiKey: 'not-used', baseUrl: 'https://open.bigmodel.cn.evil.example' },
    ]);
    const { service, fetchImpl, store } = fixture(config);
    await service.refresh('zhipu:a');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(store.rows[0]?.accountKey).toBe('zhipu:a');
    fetchImpl.mockClear();
    const snapshots = await service.refresh();
    expect(snapshots.map((row) => row.accountKey)).toEqual(['zhipu:a', 'zhipu:b']);
    expect(snapshots.map((row) => row.windows[0]?.usedPercent)).toEqual([30, 30]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(fetchImpl as typeof fetch).mock.calls) {
      expect(call[0]).toBe(ZHIPU_CODING_PLAN_QUOTA_URL);
    }
    await expect(service.refresh('zhipu:disabled')).rejects.toThrow('不存在');
  });

  it('keeps last successful windows on failure and hides disabled groups from overview and history', async () => {
    const config = models([{ apiKey: 'test-key' }]);
    const { service, fetchImpl, store, logger, advance } = fixture(config);
    await service.refresh();
    const firstTime = store.rows[0]!.collectedAt;
    advance();
    fetchImpl.mockResolvedValueOnce(new Response('test-key', { status: 429 }));
    await service.refresh();
    const item = (await service.overview()).items[0]!;
    expect(item.ok).toBe(false);
    expect(item.error).toContain('429');
    expect(item.extra?.lastSuccessAt).toBe(firstTime);
    expect(item.windows[0]?.usedPercent).toBe(30);
    expect(JSON.stringify(item)).not.toContain('test-key');
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('test-key');
    config.groups[0]!.quotaSource = { provider: 'none' };
    expect((await service.overview()).items).toEqual([]);
    expect((await service.history(24)).points).toEqual([]);
  });

  it('tests draft and saved credentials without persisting a snapshot', async () => {
    const { service, store, fetchImpl } = fixture(models([{ apiKey: 'saved-key' }]));
    await service.test({ provider: 'zhipu_coding_plan', groupId: 'zhipu' });
    expect(fetchImpl).toHaveBeenLastCalledWith(ZHIPU_CODING_PLAN_QUOTA_URL,
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'saved-key' }) }));
    await service.test({ provider: 'zhipu_coding_plan', groupId: 'zhipu', apiKey: 'draft-key' });
    expect(fetchImpl).toHaveBeenLastCalledWith(ZHIPU_CODING_PLAN_QUOTA_URL,
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'draft-key' }) }));
    expect(store.append).not.toHaveBeenCalled();
  });

  it('reports missing or inaccessible keys without leaking Vault exceptions', async () => {
    const config = models([{}]);
    const { service, fetchImpl, vault, logger } = fixture(config);
    expect((await service.refresh())[0]).toMatchObject({ ok: false, windows: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(service.test({ provider: 'zhipu_coding_plan', groupId: 'zhipu' })).rejects.toThrow('缺少智谱 API Key');
    config.groups[0]!.apiKeyRef = 'private-ref';
    vi.spyOn(vault, 'getSecret').mockRejectedValue(new Error('private-ref private-key'));
    const snapshot = (await service.refresh())[0]!;
    expect(snapshot.error).toContain('无法读取');
    expect(JSON.stringify(snapshot)).not.toContain('private-');
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('private-');
    await expect(service.test({ provider: 'zhipu_coding_plan', groupId: 'missing' })).rejects.toThrow('不存在');
  });
});

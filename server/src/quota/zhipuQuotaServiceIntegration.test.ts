import { describe, expect, it, vi } from 'vitest';
import type { ProviderQuotaSnapshot } from '@agent/shared';
import type { AppConfig } from '../app/config.js';
import { InMemorySecretVault } from '../security/secretVault.js';
import { ProviderQuotaService } from './providerQuotaService.js';
import type { PgProviderQuotaSnapshotStore } from './providerQuotaSnapshotStore.js';
import { ZHIPU_CODING_PLAN_QUOTA_URL } from './zhipuCodingPlanQuota.js';

type Models = NonNullable<AppConfig['models']>;
type Group = Models['groups'][number];

class MemoryStore {
  rows: ProviderQuotaSnapshot[] = [];
  overrides = new Map<string, string | null>();
  notes = new Map<string, string | null>();
  async append(rows: readonly ProviderQuotaSnapshot[]) { this.rows.push(...rows); }
  private select(successOnly = false) {
    const selected = new Map<string, ProviderQuotaSnapshot>();
    for (const row of this.rows) if (!successOnly || row.ok) selected.set(row.accountKey, row);
    return [...selected.values()];
  }
  async latest() { return this.select(); }
  async latestSuccessful() { return this.select(true); }
  async pushedAccounts() { return []; }
  async planExpiryOverrides() { return this.overrides; }
  async setPlanExpiry(key: string, endTime: string | null) { this.overrides.set(key, endTime); }
  async planNotes() { return this.notes; }
  async setPlanNote(key: string, note: string | null) { this.notes.set(key, note); }
  async history() {
    return this.rows.map((row) => ({
      accountKey: row.accountKey, collectedAt: row.collectedAt, ok: row.ok,
      windows: row.windows.map(({ id, usedPercent }) => ({ id, usedPercent })),
    }));
  }
  async tryAcquireCollectorLock() { return async () => {}; }
  async prune() { return 0; }
}

function group(patch: Partial<Group> = {}): Group {
  return {
    id: 'glm', name: '智谱测试分组', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
    apiKey: 'dummy-group-key', models: [{ id: 'glm', name: 'GLM', value: 'glm' }], ...patch,
  } as Group;
}

function setup(groups: Group[], vault?: InMemorySecretVault) {
  const models: Models = { default: 'glm/glm', allowCrossGroupSwitch: true, groups };
  const store = new MemoryStore();
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
    success: true, code: 200, data: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 30 }] },
  })));
  let tick = 0;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const service = new ProviderQuotaService({
    store: store as unknown as PgProviderQuotaSnapshotStore,
    getModelsConfig: () => models, secretVault: vault, enableCollector: false,
    fetchImpl: fetchImpl as typeof fetch,
    now: () => new Date(Date.UTC(2026, 8, 11, 8, tick++)), logger,
  });
  return { service, models, store, fetchImpl, logger };
}

describe('Zhipu ProviderQuotaService integration', () => {
  it('auto-discovers existing official groups without migration and keeps account/shared scope explicit', async () => {
    const { service, fetchImpl } = setup([
      group(), group({ id: 'glm-secondary', name: '另一个 Key 分组' }),
      group({ id: 'other', baseUrl: 'https://other.example' }),
    ]);
    const rows = await service.refresh();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.accountKey)).toEqual(['zhipu:glm', 'zhipu:glm-secondary']);
    expect(rows.every((row) => row.ok && row.extra?.quotaScope === 'account')).toBe(true);
    expect(rows.map((row) => row.windows[0]?.usedPercent)).toEqual([30, 30]);
    expect(JSON.stringify(rows)).not.toContain('dummy-group-key');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect((await service.overview()).items).toHaveLength(2);
    expect((await service.history(24)).points).toHaveLength(2);
  });

  it('reuses the saved API Key ref without storing another quota secret', async () => {
    const vault = new InMemorySecretVault();
    const ref = await vault.putSecret('__global__', 'models', 'dummy-vault-key', {
      actor: 'system', userId: 'models_config_admin', scopes: ['secret:models:write'],
    });
    const { service, fetchImpl, store } = setup([group({ apiKey: undefined, apiKeyRef: ref.id })], vault);
    await service.refresh('zhipu:glm');
    expect(fetchImpl).toHaveBeenCalledWith(ZHIPU_CODING_PLAN_QUOTA_URL, expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'dummy-vault-key' }),
    }));
    expect(store.rows[0]?.ok).toBe(true);
    expect(JSON.stringify(store.rows)).not.toContain(ref.id);
    expect(JSON.stringify(store.rows)).not.toContain('dummy-vault-key');
  });

  it('honors explicit opt-out and removes disabled groups from overview and history', async () => {
    const { service, models, fetchImpl } = setup([group()]);
    await service.refresh();
    models.groups[0]!.quotaSource = { provider: 'none' };
    expect(await service.refresh()).toEqual([]);
    expect((await service.overview()).items).toEqual([]);
    expect((await service.history(24)).points).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(service.refresh('zhipu:glm')).rejects.toThrow('账号不存在');
  });

  it('never uses a model proxy address as the quota destination and reads updated configuration', async () => {
    const { service, models, fetchImpl } = setup([group({
      baseUrl: 'https://proxy.example/v1', quotaSource: { provider: 'zhipu_coding_plan' },
    })]);
    await service.refresh();
    models.groups[0]!.apiKey = 'dummy-new-key';
    await service.refresh();
    expect(fetchImpl).toHaveBeenLastCalledWith(ZHIPU_CODING_PLAN_QUOTA_URL, expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'dummy-new-key' }),
    }));
  });

  it('persists sanitized failure and preserves last known quota instead of showing zero', async () => {
    const { service, store, fetchImpl, logger } = setup([group()]);
    await service.refresh();
    const successAt = store.rows[0]!.collectedAt;
    fetchImpl.mockImplementationOnce(async () => new Response('dummy-group-key', { status: 429 }));
    await service.refresh();
    expect(store.rows[1]).toMatchObject({ ok: false, windows: [] });
    const snapshot = (await service.overview()).items[0]!;
    expect(snapshot).toMatchObject({
      ok: false, collectedAt: successAt, extra: { lastSuccessAt: successAt },
      windows: [expect.objectContaining({ usedPercent: 30 })],
    });
    expect(snapshot.error).toContain('429');
    expect(JSON.stringify([store.rows, logger.warn.mock.calls])).not.toContain('dummy-group-key');
  });

  it('tests a supplied or saved key without persisting snapshots and rejects missing credentials', async () => {
    const { service, store, fetchImpl } = setup([group()]);
    await service.test({ provider: 'zhipu_coding_plan', groupId: 'glm' });
    await service.test({ provider: 'zhipu_coding_plan', groupId: 'unsaved', apiKey: 'dummy-draft-key' });
    expect(fetchImpl).toHaveBeenLastCalledWith(ZHIPU_CODING_PLAN_QUOTA_URL, expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'dummy-draft-key' }),
    }));
    expect(store.rows).toEqual([]);
    await expect(service.test({ provider: 'zhipu_coding_plan' })).rejects.toThrow('API Key');
    await expect(service.test({ provider: 'zhipu_coding_plan', groupId: 'missing' })).rejects.toThrow('不存在');
  });

  it('does not invent plan metadata and supports the existing manual expiry override separately', async () => {
    const { service } = setup([group()]);
    const rows = await service.refresh();
    expect(rows[0]?.plan).toBeUndefined();
    await service.setPlanExpiry('zhipu:glm', '2026-10-11T15:59:00Z', 'admin');
    const snapshot = (await service.overview()).items[0]!;
    expect(snapshot.planExpiry).toMatchObject({ editable: true, manualEndTime: '2026-10-11T15:59:00Z' });
    expect(snapshot.plan).toBeUndefined();
  });

  it('records missing credentials as a collection failure without calling the provider', async () => {
    const { service, fetchImpl } = setup([group({ apiKey: undefined })]);
    const rows = await service.refresh();
    expect(rows[0]).toMatchObject({ ok: false, windows: [] });
    expect(rows[0]?.error).toContain('API Key');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

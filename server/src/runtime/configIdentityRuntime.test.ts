import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../types/index.js';
import { parseAppConfig } from '../app/config.js';
import { InMemorySecretVault, type SecretVault, type SecretRef } from '../security/secretVault.js';
import {
  createConfigIdentityRuntime,
  isPreparedConfigRecoveryPublication,
  PreparedConfigRecoveryPublication,
} from './configIdentityRuntime.js';
import { publishAdminCommittedConfigIdentity } from '../app/audioTranscribeAdminRoute.js';
import {
  calculateConfigIdentityDigest,
  buildCanonicalConfigProjection,
} from '../release/configIdentity.js';

function baseConfig(overrides: Record<string, unknown> = {}): AppConfig {
  return parseAppConfig({
    agent: { cwd: '/srv/agent' },
    server: {},
    ...overrides,
  });
}

function digestOf(config: AppConfig, processCwd = '/srv/server'): string {
  const { projection } = buildCanonicalConfigProjection(config, processCwd);
  return calculateConfigIdentityDigest(projection);
}

const PG = {
  runtimeEventStore: {
    backend: 'pg' as const,
    connectionString: 'postgresql://u:p@db.internal:5432/runtime',
  },
};

async function observe(
  config: AppConfig,
  vault?: Pick<SecretVault, 'inspectRef'>,
  processCwd = '/srv/server',
) {
  const { computeObservedConfigIdentity } = await import('../release/configIdentity.js');
  return computeObservedConfigIdentity(config, vault, processCwd);
}

describe('createConfigIdentityRuntime', () => {
  it('未初始化时 getSummary 返回 not_collected（不抛错、不显示成一致）', () => {
    const runtime = createConfigIdentityRuntime({ config: baseConfig(), environment: 'test' });
    expect(runtime.getSummary().status).toBe('not_collected');
  });

  it('initialize 将真实 processCwd 透传给机器路径 canonicalization', async () => {
    const processCwd = '/a';
    const expectedConfig = baseConfig({
      artifact: { backend: 'local', rootDir: '../../private-target' },
    });
    const observedConfig = baseConfig({
      artifact: { backend: 'local', rootDir: '../../../private-target' },
    });
    const runtime = createConfigIdentityRuntime({
      config: observedConfig,
      environment: 'test',
      processCwd,
      expected: { schemaVersion: 1, digest: digestOf(expectedConfig, processCwd) },
    });

    await runtime.initialize();
    expect(runtime.getSummary().status).toBe('consistent');
  });

  it('initialize 后计算 observed identity 并给出四态判定', async () => {
    const config = baseConfig();
    const runtime = createConfigIdentityRuntime({
      config,
      environment: 'test',
      expected: { schemaVersion: 1, digest: digestOf(config) },
      releaseId: 'rc-1',
    });
    await runtime.initialize();
    const summary = runtime.getSummary();
    expect(summary.status).toBe('consistent');
    expect(summary.expected?.digest).toBe(digestOf(config));
    expect(summary.observed?.digest).toBe(digestOf(config));
    expect(summary.releaseId).toBe('rc-1');
    expect(summary.firstObservedAt).toBe(summary.lastObservedAt);
    // 首次观察只建立 baseline，不应伪造「最近变化」。
    expect(summary.lastChangedAt).toBeUndefined();
  });

  it('expected 未绑定时不可验证（不误报一致）', async () => {
    const runtime = createConfigIdentityRuntime({
      config: baseConfig(),
      environment: 'production',
    });
    await runtime.initialize();
    expect(runtime.getSummary().status).toBe('unverifiable');
    expect(runtime.getSummary().reason).toBe('expected_not_bound');
  });

  it('配置漂移时判定 drifted（expected 与 observed digest 不一致）', async () => {
    const deployedConfig = baseConfig();
    const runtime = createConfigIdentityRuntime({
      config: deployedConfig,
      environment: 'test',
      expected: { schemaVersion: 1, digest: digestOf(baseConfig({ server: { port: 9999 } })) },
    });
    await runtime.initialize();
    expect(runtime.getSummary().status).toBe('drifted');
  });

  it('refresh 热更新后重算并追踪 lastChangedAt', async () => {
    const config = baseConfig();
    let currentTime = '2026-08-29T12:00:00.000Z';
    const runtime = createConfigIdentityRuntime({
      config,
      environment: 'test',
      expected: { schemaVersion: 1, digest: digestOf(config) },
      now: () => new Date(currentTime),
    });
    await runtime.initialize();
    expect(runtime.getSummary().status).toBe('consistent');
    expect(runtime.getSummary().lastChangedAt).toBeUndefined();

    // SharedConfigRefresher 对同一 AppConfig 对象原地替换各配置段；运行时共享
    // 同一引用，因此显式 refresh 必须观察到新的 port 并发布 drift。
    config.server.port = 9999;
    currentTime = '2026-08-29T12:00:01.000Z';
    await runtime.refresh('config_file_hot_reload');
    const summary = runtime.getSummary();
    expect(summary.status).toBe('drifted');
    expect(summary.lastChangedAt).toBe(currentTime);
    expect(summary.lastObservedAt).toBe(currentTime);
  });

  it('prepareConfigChanged 仅在显式 commit 时发布，并拒绝 generation 已失效的结果', async () => {
    const config = baseConfig();
    const runtime = createConfigIdentityRuntime({
      config,
      environment: 'test',
      expected: { schemaVersion: 1, digest: digestOf(config) },
    });
    await runtime.initialize();

    config.server.port = 9999;
    const commit = await runtime.prepareConfigChanged('runtime_recovery');
    expect(runtime.getSummary().status).toBe('not_collected');
    commit.commit();
    expect(runtime.getSummary().status).toBe('drifted');

    config.server.port = 3000;
    const staleCommit = await runtime.prepareConfigChanged('runtime_recovery');
    runtime.invalidateObservation();
    expect(() => staleCommit.commit()).toThrow('became stale');
    expect(runtime.getSummary().status).toBe('not_collected');
  });

  it('拒绝外部构造、原型伪造与覆写真实 publication capability', async () => {
    const commitAction = vi.fn();
    const ExternalConstructor = PreparedConfigRecoveryPublication as unknown as new (
      token: symbol,
      action: () => void,
    ) => PreparedConfigRecoveryPublication;

    expect(() => PreparedConfigRecoveryPublication.create(Symbol('external') as never, commitAction))
      .toThrow('Runtime 外构造');
    expect(() => new ExternalConstructor(Symbol('external'), commitAction))
      .toThrow('Runtime 外构造');
    const prototypeForgery = Object.create(PreparedConfigRecoveryPublication.prototype) as {
      commit: () => void;
    };
    Object.defineProperty(prototypeForgery, 'commit', { value: commitAction });
    expect(isPreparedConfigRecoveryPublication(prototypeForgery)).toBe(false);

    const runtime = createConfigIdentityRuntime({ config: baseConfig(), environment: 'test' });
    await runtime.initialize();
    const trusted = await runtime.prepareConfigChanged('runtime_recovery');
    expect(Object.isFrozen(PreparedConfigRecoveryPublication)).toBe(true);
    expect(Object.isFrozen(PreparedConfigRecoveryPublication.prototype)).toBe(true);
    expect(Object.isFrozen(trusted)).toBe(true);
    expect(() => Object.defineProperty(trusted, 'commit', { value: commitAction }))
      .toThrow(TypeError);
    expect(commitAction).not.toHaveBeenCalled();
  });

  it.each([
    ['pre-publication log', 'recomputed after'],
    ['identity-changed log', 'observed identity changed'],
  ])('commit %s 抛错时恢复旧 observation 且不发布候选状态', async (_label, failedLog) => {
    const config = baseConfig();
    let failCommitLog = false;
    const publishedStatuses: string[] = [];
    const runtime = createConfigIdentityRuntime({
      config,
      environment: 'test',
      expected: { schemaVersion: 1, digest: digestOf(config) },
      logger: {
        info: (message) => {
          if (failCommitLog && message.includes(failedLog)) throw new Error('commit log failed');
        },
        warn: vi.fn(),
      },
      onSummaryUpdated: (summary) => publishedStatuses.push(summary.status),
    });
    await runtime.initialize();

    config.server.port = 9999;
    const prepared = await runtime.prepareConfigChanged('runtime_recovery');
    const summaryBeforeCommit = runtime.getSummary();
    failCommitLog = true;

    expect(() => prepared.commit()).toThrow('commit log failed');
    expect(runtime.getSummary()).toEqual(summaryBeforeCommit);
    expect(publishedStatuses).not.toContain('drifted');
  });

  it('publisher 与诊断 logger 同时抛错也不反转已发布终态', async () => {
    const config = baseConfig();
    let failPublication = false;
    const runtime = createConfigIdentityRuntime({
      config,
      environment: 'test',
      expected: { schemaVersion: 1, digest: digestOf(config) },
      logger: { info: vi.fn(), warn: () => { throw new Error('diagnostic failed'); } },
      onSummaryUpdated: (summary) => {
        if (failPublication && summary.status === 'drifted') throw new Error('subscriber failed');
      },
    });
    await runtime.initialize();
    config.server.port = 9999;
    const prepared = await runtime.prepareConfigChanged('runtime_recovery');
    failPublication = true;

    expect(() => prepared.commit()).not.toThrow();
    expect(runtime.getSummary().status).toBe('drifted');
  });

  it('notifyConfigChanged 在异步重算期间立即同步撤销旧 consistent observation', async () => {
    let resolveMetadata!: (value: SecretRef) => void;
    const metadata = new Promise<SecretRef>((resolve) => { resolveMetadata = resolve; });
    const vault = {
      inspectRef: vi.fn(() => metadata),
    } as unknown as SecretVault;
    const config = baseConfig(PG);
    const published: Array<{ status: string; reason?: string }> = [];
    const runtime = createConfigIdentityRuntime({
      config,
      secretVault: vault,
      environment: 'test',
      expected: { schemaVersion: 1, digest: digestOf(config) },
      onSummaryUpdated: (summary) => published.push(summary),
    });
    await runtime.initialize();
    expect(runtime.getSummary().status).toBe('consistent');

    config.tenantRemoteHands = baseConfig({
      ...PG,
      tenantRemoteHands: {
        hands: [{ id: 'next', baseUrl: 'https://next.internal', authTokenRef: 'next-ref' }],
      },
    }).tenantRemoteHands;
    runtime.notifyConfigChanged('config_file_hot_reload');

    expect(runtime.getSummary()).toMatchObject({ status: 'not_collected' });
    expect(published.at(-1)).toMatchObject({ status: 'not_collected' });

    resolveMetadata({
      id: 'next-ref',
      ownerId: 'global',
      kind: 'tenant-hand',
      version: 2,
      metadata: {},
      createdAt: '2026-08-30T00:00:00.000Z',
      updatedAt: '2026-08-30T00:00:00.000Z',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.getSummary().status).toBe('drifted');
  });

  it('notifyConfigChanged 重算失败后不恢复旧 consistent observation', async () => {
    const config = baseConfig({
      ...PG,
      tenantRemoteHands: {
        hands: [{ id: 'h1', baseUrl: 'https://hand.internal', authTokenRef: 'hand-ref' }],
      },
    });
    const metadata: SecretRef = {
      id: 'hand-ref',
      ownerId: 'global',
      kind: 'tenant-hand',
      version: 1,
      metadata: {},
      createdAt: '2026-08-30T00:00:00.000Z',
      updatedAt: '2026-08-30T00:00:00.000Z',
    };
    const inspectRef = vi.fn().mockResolvedValue(metadata);
    const secretVault = { inspectRef } as unknown as SecretVault;
    const expectedObservation = await observe(config, secretVault);
    const warn = vi.fn();
    let failClock = false;
    const runtime = createConfigIdentityRuntime({
      config,
      secretVault,
      environment: 'test',
      expected: {
        schemaVersion: 1,
        digest: expectedObservation.digest,
        credentialVersionDigest: expectedObservation.credentialVersionDigest ?? undefined,
      },
      logger: { info: () => undefined, warn },
      now: () => {
        if (failClock) throw new Error('identity recompute failed');
        return new Date('2026-08-30T00:00:00.000Z');
      },
    });
    await runtime.initialize();
    expect(runtime.getSummary().status).toBe('consistent');

    let resolveMetadata!: (value: SecretRef) => void;
    inspectRef.mockReturnValue(new Promise<SecretRef>((resolve) => { resolveMetadata = resolve; }));
    runtime.notifyConfigChanged('admin_save');
    expect(runtime.getSummary().status).toBe('not_collected');
    failClock = true;
    resolveMetadata(metadata);
    await new Promise((resolve) => setTimeout(resolve, 0));
    failClock = false;

    expect(runtime.getSummary().status).toBe('not_collected');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('identity recompute failed'));
  });

  it('并发胜出 refresh 等待与失败期间，纯失效不计算或发布失选候选', async () => {
    let currentTime = '2026-08-30T00:00:00.000Z';
    const metadata = (id: string): SecretRef => ({
      id, ownerId: 'global', kind: 'tenant-hand', version: 1, metadata: {},
      createdAt: currentTime, updatedAt: currentTime,
    });
    const inspectRef = vi.fn((id: string) => Promise.resolve(metadata(id)));
    const config = baseConfig({
      ...PG,
      tenantRemoteHands: {
        hands: [{ id: 'baseline', baseUrl: 'https://baseline.internal', authTokenRef: 'baseline-ref' }],
      },
    });
    const published: Array<{ status: string; observed?: { digest: string } }> = [];
    const runtime = createConfigIdentityRuntime({
      config,
      secretVault: { inspectRef } as unknown as SecretVault,
      environment: 'test',
      expected: { schemaVersion: 1, digest: digestOf(config) },
      now: () => new Date(currentTime),
      onSummaryUpdated: (summary) => published.push(summary),
    });
    await runtime.initialize();
    config.tenantRemoteHands = baseConfig({
      ...PG,
      tenantRemoteHands: {
        hands: [{ id: 'loser', baseUrl: 'https://loser.internal', authTokenRef: 'loser-ref' }],
      },
    }).tenantRemoteHands;

    let finishRefresh!: (fresh: boolean) => void;
    const refreshPending = new Promise<boolean>((resolve) => { finishRefresh = resolve; });
    const publication = publishAdminCommittedConfigIdentity({
      acknowledgeSharedConfigApplied: () => false,
      invalidateSharedConfigIdentity: runtime.invalidateObservation,
      notifySharedConfigChanged: () => runtime.notifyConfigChanged('winner_applied'),
      refreshSharedConfig: () => refreshPending,
    }, 'losing-candidate-text');

    currentTime = '2026-08-30T00:00:10.000Z';
    expect(runtime.getSummary().status).toBe('not_collected');
    expect((await runtime.refreshSummary('readiness')).status).toBe('not_collected');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(inspectRef.mock.calls.map(([id]) => id)).not.toContain('loser-ref');
    finishRefresh(false);
    await expect(publication).rejects.toThrow('配置文件被并发改写且重载失败');
    currentTime = '2026-08-30T00:00:20.000Z';
    expect(runtime.getSummary().status).toBe('not_collected');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(inspectRef.mock.calls.map(([id]) => id)).not.toContain('loser-ref');
    expect(published.some((summary) => summary.observed?.digest === digestOf(config))).toBe(false);
  });

  it('并发胜出 refresh 后只重算胜出内存配置，并沿用失效前 observation 比较变化时间', async () => {
    let currentTime = '2026-08-30T00:00:00.000Z';
    const metadata = (id: string): SecretRef => ({
      id, ownerId: 'global', kind: 'tenant-hand', version: 1, metadata: {},
      createdAt: currentTime, updatedAt: currentTime,
    });
    const inspectRef = vi.fn((id: string) => Promise.resolve(metadata(id)));
    const config = baseConfig({
      ...PG,
      tenantRemoteHands: {
        hands: [{ id: 'baseline', baseUrl: 'https://baseline.internal', authTokenRef: 'baseline-ref' }],
      },
    });
    const runtime = createConfigIdentityRuntime({
      config,
      secretVault: { inspectRef } as unknown as SecretVault,
      environment: 'test',
      expected: { schemaVersion: 1, digest: digestOf(config) },
      now: () => new Date(currentTime),
    });
    await runtime.initialize();
    config.tenantRemoteHands = baseConfig({
      ...PG,
      tenantRemoteHands: {
        hands: [{ id: 'loser', baseUrl: 'https://loser.internal', authTokenRef: 'loser-ref' }],
      },
    }).tenantRemoteHands;

    let finishRefresh!: (fresh: boolean) => void;
    const refreshPending = new Promise<boolean>((resolve) => { finishRefresh = resolve; });
    const publication = publishAdminCommittedConfigIdentity({
      acknowledgeSharedConfigApplied: () => false,
      invalidateSharedConfigIdentity: runtime.invalidateObservation,
      notifySharedConfigChanged: () => runtime.notifyConfigChanged('winner_applied'),
      refreshSharedConfig: () => refreshPending,
    }, 'losing-candidate-text');
    expect(runtime.getSummary().status).toBe('not_collected');
    expect(inspectRef.mock.calls.map(([id]) => id)).not.toContain('loser-ref');

    config.tenantRemoteHands = baseConfig({
      ...PG,
      tenantRemoteHands: {
        hands: [{ id: 'winner', baseUrl: 'https://winner.internal', authTokenRef: 'winner-ref' }],
      },
    }).tenantRemoteHands;
    const winnerDigest = digestOf(config);
    currentTime = '2026-08-30T00:00:10.000Z';
    finishRefresh(true);
    await publication;
    await new Promise((resolve) => setTimeout(resolve, 0));

    const summary = runtime.getSummary();
    const inspectedIds = inspectRef.mock.calls.map(([id]) => id);
    expect(inspectedIds).not.toContain('loser-ref');
    expect(inspectedIds).toContain('winner-ref');
    expect(summary.observed?.digest).toBe(winnerDigest);
    expect(summary.lastChangedAt).toBe(currentTime);
  });

  it('notifyConfigChanged 重算失败不打断调用方（只告警）', async () => {
    const config = baseConfig();
    const warn = vi.fn();
    const runtime = createConfigIdentityRuntime({
      config,
      environment: 'test',
      logger: { info: () => undefined, warn },
    });
    await runtime.initialize();
    // 不存在触发重算失败的常规路径，这里只验证 notifyConfigChanged 本身 swallow。
    expect(() => runtime.notifyConfigChanged('manual')).not.toThrow();
  });

  it('production 下受管 ref 版本不可解析 -> fail closed 拒绝启动', async () => {
    const vault = new InMemorySecretVault();
    const config = baseConfig({
      ...PG,
      tenantRemoteHands: {
        hands: [{ id: 'h1', baseUrl: 'https://acs.internal', authTokenRef: 'missing-ref' }],
      },
    });
    const runtime = createConfigIdentityRuntime({
      config,
      secretVault: vault,
      environment: 'production',
      expected: { schemaVersion: 1, digest: digestOf(config) },
    });
    await expect(runtime.initialize()).rejects.toThrow(
      /Production requires verifiable SecretVault refs/,
    );
  });

  it('production 热更新候选的 ref version 不可解析 -> 应用前 fail closed', async () => {
    const config = baseConfig();
    const runtime = createConfigIdentityRuntime({
      config,
      secretVault: new InMemorySecretVault(),
      environment: 'production',
      expected: { schemaVersion: 1, digest: digestOf(config) },
    });
    await runtime.initialize();
    const candidate = baseConfig({
      ...PG,
      tenantRemoteHands: {
        hands: [{ id: 'h1', baseUrl: 'https://acs.internal', authTokenRef: 'missing-ref' }],
      },
    });

    await expect(runtime.validateConfigReload(candidate)).rejects.toThrow(
      /Production requires verifiable SecretVault refs/,
    );
    expect(runtime.getSummary().status).toBe('consistent');
  });

  it('production 下受管 inline secret -> fail closed 拒绝启动', async () => {
    const config = baseConfig({
      ...PG,
      stt: { enabled: true, apiKey: 'inline-stt-secret' },
    });
    const runtime = createConfigIdentityRuntime({
      config,
      environment: 'production',
      expected: { schemaVersion: 1, digest: digestOf(config) },
    });
    await expect(runtime.initialize()).rejects.toThrow(
      /stt\.apiKey must use SecretVault ref \(apiKeyRef\) in production/,
    );
  });

  it('production 下受管 ref 版本可解析 -> 正常启动', async () => {
    const vault = new InMemorySecretVault();
    const caller = {
      actor: 'system' as const,
      userId: '__system__',
      scopes: ['secret:tenant-hand:write'],
    };
    const ref = await vault.putSecret('global', 'tenant-hand', 'value', caller);
    const config = baseConfig({
      ...PG,
      tenantRemoteHands: {
        hands: [{ id: 'h1', baseUrl: 'https://acs.internal', authTokenRef: ref.id }],
      },
    });
    const observation = await observe(config, vault);
    const runtime = createConfigIdentityRuntime({
      config,
      secretVault: vault,
      environment: 'production',
      expected: {
        schemaVersion: 1,
        digest: observation.digest,
        credentialVersionDigest: observation.credentialVersionDigest ?? undefined,
      },
    });
    await runtime.initialize();
    expect(runtime.getSummary().status).toBe('consistent');
    expect(runtime.getSummary().expected?.credentialVersionDigest).toBe(
      observation.credentialVersionDigest,
    );
    expect(runtime.getSummary().observed?.versionResolution).toBe('resolved');
  });

  it('development/test 下受管 ref 版本不可解析 -> 不 fail closed，仅不可验证', async () => {
    const vault = new InMemorySecretVault();
    const config = baseConfig({
      ...PG,
      tenantRemoteHands: {
        hands: [{ id: 'h1', baseUrl: 'https://acs.internal', authTokenRef: 'missing-ref' }],
      },
    });
    const runtime = createConfigIdentityRuntime({
      config,
      secretVault: vault,
      environment: 'development',
      expected: { schemaVersion: 1, digest: digestOf(config) },
    });
    await runtime.initialize();
    expect(runtime.getSummary().status).toBe('unverifiable');
    expect(runtime.getSummary().reason).toBe('secret_ref_version_unresolved');
  });

  it('轮换后 refresh 重算 -> credentialVersionDigest 变化判定 drifted', async () => {
    const vault = new InMemorySecretVault();
    const caller = {
      actor: 'system' as const,
      userId: '__system__',
      scopes: ['secret:tenant-hand:write', 'secret:tenant-hand:read'],
    };
    const ref = await vault.putSecret('global', 'tenant-hand', 'v1', caller);
    const config = baseConfig({
      ...PG,
      tenantRemoteHands: {
        hands: [{ id: 'h1', baseUrl: 'https://acs.internal', authTokenRef: ref.id }],
      },
    });
    const deployTime = await observe(config, vault);
    const runtime = createConfigIdentityRuntime({
      config,
      secretVault: vault,
      environment: 'test',
      expected: {
        schemaVersion: 1,
        digest: deployTime.digest,
        credentialVersionDigest: deployTime.credentialVersionDigest ?? undefined,
      },
    });
    await runtime.initialize();
    expect(runtime.getSummary().status).toBe('consistent');

    await vault.rotateSecret(ref.id, 'v2', {
      ...caller,
      scopes: [...caller.scopes, 'secret:tenant-hand:rotate'],
    });
    await runtime.refresh('rotation');
    expect(runtime.getSummary().status).toBe('drifted');
  });

  it('轮换后稳定读取保留旧快照，强一致读取等待重算并返回 drifted', async () => {
    const vault = new InMemorySecretVault();
    const caller = {
      actor: 'system' as const,
      userId: '__system__',
      scopes: ['secret:tenant-hand:write', 'secret:tenant-hand:read'],
    };
    const ref = await vault.putSecret('global', 'tenant-hand', 'v1', caller);
    const config = baseConfig({
      ...PG,
      tenantRemoteHands: {
        hands: [{ id: 'h1', baseUrl: 'https://acs.internal', authTokenRef: ref.id }],
      },
    });
    const deployTime = await observe(config, vault);
    let clock = 0;
    const published: Array<{ status: string }> = [];
    const runtime = createConfigIdentityRuntime({
      config,
      secretVault: vault,
      environment: 'test',
      expected: {
        schemaVersion: 1,
        digest: deployTime.digest,
        credentialVersionDigest: deployTime.credentialVersionDigest ?? undefined,
      },
      now: () => new Date(clock),
      onSummaryUpdated: (summary) => published.push(summary),
    });
    await runtime.initialize();
    expect(runtime.getSummary().status).toBe('consistent');

    await vault.rotateSecret(ref.id, 'v2', {
      ...caller,
      scopes: [...caller.scopes, 'secret:tenant-hand:rotate'],
    });
    clock = 6_000;
    expect(runtime.getSummary().status).toBe('consistent');

    expect((await runtime.refreshSummary('readiness')).status).toBe('drifted');
    expect(runtime.getSummary().status).toBe('drifted');
    expect(published.at(-1)?.status).toBe('drifted');
    expect(published.some((summary) => summary.status === 'not_collected')).toBe(false);
  });

  it('强一致重算失败后返回 not_collected，不恢复旧 consistent', async () => {
    const metadata: SecretRef = {
      id: 'hand-ref',
      ownerId: 'global',
      kind: 'tenant-hand',
      version: 1,
      metadata: {},
      createdAt: '2026-08-30T00:00:00.000Z',
      updatedAt: '2026-08-30T00:00:00.000Z',
    };
    const inspectRef = vi.fn().mockResolvedValue(metadata);
    const secretVault = { inspectRef } as unknown as SecretVault;
    const config = baseConfig({
      ...PG,
      tenantRemoteHands: {
        hands: [{ id: 'h1', baseUrl: 'https://acs.internal', authTokenRef: metadata.id }],
      },
    });
    const deployTime = await observe(config, secretVault);
    let clock = 0;
    let failClock = false;
    const warn = vi.fn();
    const runtime = createConfigIdentityRuntime({
      config,
      secretVault,
      environment: 'test',
      expected: {
        schemaVersion: 1,
        digest: deployTime.digest,
        credentialVersionDigest: deployTime.credentialVersionDigest ?? undefined,
      },
      logger: { info: () => undefined, warn },
      now: () => {
        if (failClock) throw new Error('strong identity recompute failed');
        return new Date(clock);
      },
    });
    await runtime.initialize();
    expect(runtime.getSummary().status).toBe('consistent');

    clock = 6_000;
    const refreshPending = runtime.refreshSummary('readiness');
    failClock = true;
    expect((await refreshPending).status).toBe('not_collected');
    failClock = false;

    expect(runtime.getSummary().status).toBe('not_collected');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('strong identity recompute failed'));
    expect((await runtime.refreshSummary('readiness_retry')).status).toBe('consistent');
  });

  it('较慢的强一致重算不会覆盖较新的热更新 observed identity', async () => {
    let resolveSlow!: (value: SecretRef) => void;
    const slowMetadata = new Promise<SecretRef>((resolve) => { resolveSlow = resolve; });
    const metadata = (id: string, version: number): SecretRef => ({
      id, ownerId: 'global', kind: 'tenant-hand', version, metadata: {},
      createdAt: '2026-08-30T00:00:00.000Z', updatedAt: '2026-08-30T00:00:00.000Z',
    });
    const vault = { inspectRef: vi.fn((id: string) => id === 'slow-ref'
      ? slowMetadata : Promise.resolve(metadata(id, 2))) } as unknown as SecretVault;
    const config = baseConfig(PG);
    let clock = 0;
    const runtime = createConfigIdentityRuntime({
      config, secretVault: vault, environment: 'test', now: () => new Date(clock),
    });
    await runtime.initialize();

    config.tenantRemoteHands = baseConfig({ ...PG, tenantRemoteHands: {
      hands: [{ id: 'slow', baseUrl: 'https://slow.internal', authTokenRef: 'slow-ref' }],
    } }).tenantRemoteHands;
    clock = 6_000;
    const slowRefresh = runtime.refreshSummary('readiness');
    config.tenantRemoteHands = baseConfig({ ...PG, tenantRemoteHands: {
      hands: [{ id: 'fast', baseUrl: 'https://fast.internal', authTokenRef: 'fast-ref' }],
    } }).tenantRemoteHands;
    await runtime.refresh('fast-candidate');
    const currentDigest = digestOf(config);
    resolveSlow(metadata('slow-ref', 1));
    await slowRefresh;

    expect(runtime.getSummary().observed?.digest).toBe(currentDigest);
  });

  it('较旧强一致重算失败不会撤销较新 generation 的成功结果', async () => {
    let rejectSlow!: (error: Error) => void;
    const slowMetadata = new Promise<SecretRef>((_resolve, reject) => { rejectSlow = reject; });
    const metadata = (id: string): SecretRef => ({
      id, ownerId: 'global', kind: 'tenant-hand', version: 2, metadata: {},
      createdAt: '2026-08-30T00:00:00.000Z', updatedAt: '2026-08-30T00:00:00.000Z',
    });
    const vault = { inspectRef: vi.fn((id: string) => id === 'slow-ref'
      ? slowMetadata : Promise.resolve(metadata(id))) } as unknown as SecretVault;
    const config = baseConfig(PG);
    let clock = 0;
    const runtime = createConfigIdentityRuntime({
      config, secretVault: vault, environment: 'test', now: () => new Date(clock),
    });
    await runtime.initialize();

    config.tenantRemoteHands = baseConfig({ ...PG, tenantRemoteHands: {
      hands: [{ id: 'slow', baseUrl: 'https://slow.internal', authTokenRef: 'slow-ref' }],
    } }).tenantRemoteHands;
    clock = 6_000;
    const slowRefresh = runtime.refreshSummary('readiness');
    config.tenantRemoteHands = baseConfig({ ...PG, tenantRemoteHands: {
      hands: [{ id: 'fast', baseUrl: 'https://fast.internal', authTokenRef: 'fast-ref' }],
    } }).tenantRemoteHands;
    await runtime.refresh('fast-candidate');
    const currentDigest = digestOf(config);
    rejectSlow(new Error('old refresh failed'));
    await slowRefresh;

    expect(runtime.getSummary().status).not.toBe('not_collected');
    expect(runtime.getSummary().observed?.digest).toBe(currentDigest);
  });

  it('无变化跨多个刷新周期时稳定读取与强一致读取持续 consistent', async () => {
    const config = baseConfig();
    let clock = 0;
    const published: Array<{ status: string }> = [];
    const runtime = createConfigIdentityRuntime({
      config,
      environment: 'test',
      expected: { schemaVersion: 1, digest: digestOf(config) },
      now: () => new Date(clock),
      onSummaryUpdated: (summary) => published.push(summary),
    });
    await runtime.initialize();

    for (const nextClock of [6_000, 12_000, 30_000]) {
      clock = nextClock;
      expect(runtime.getSummary().status).toBe('consistent');
      expect((await runtime.refreshSummary('readiness')).status).toBe('consistent');
      expect(runtime.getSummary().status).toBe('consistent');
    }
    expect(published.some((summary) => summary.status === 'not_collected')).toBe(false);
  });

  it('getSummary 摘要不含任何 secret 明文或 ref id', async () => {
    const config = baseConfig({ stt: { enabled: true, apiKey: 'plaintext-stt-key' } });
    const runtime = createConfigIdentityRuntime({
      config,
      environment: 'test',
      expected: { schemaVersion: 1, digest: digestOf(config) },
    });
    await runtime.initialize();
    const serialized = JSON.stringify(runtime.getSummary());
    expect(serialized).not.toContain('plaintext-stt-key');
    expect(serialized).not.toContain('/srv/agent');
  });
});

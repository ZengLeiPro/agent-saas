import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../types/index.js';
import { parseAppConfig } from '../app/config.js';
import { InMemorySecretVault, type SecretVault, type SecretRef } from '../security/secretVault.js';
import { createConfigIdentityRuntime } from './configIdentityRuntime.js';
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

function digestOf(config: AppConfig): string {
  const { projection } = buildCanonicalConfigProjection(config);
  return calculateConfigIdentityDigest(projection);
}

const PG = {
  runtimeEventStore: {
    backend: 'pg' as const,
    connectionString: 'postgresql://u:p@db.internal:5432/runtime',
  },
};

async function observe(config: AppConfig, vault?: InMemorySecretVault) {
  const { computeObservedConfigIdentity } = await import('../release/configIdentity.js');
  return computeObservedConfigIdentity(config, vault);
}

describe('createConfigIdentityRuntime', () => {
  it('未初始化时 getSummary 返回 not_collected（不抛错、不显示成一致）', () => {
    const runtime = createConfigIdentityRuntime({ config: baseConfig(), environment: 'test' });
    expect(runtime.getSummary().status).toBe('not_collected');
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

  it('notifyConfigChanged 热更新后重算并追踪 lastChangedAt', async () => {
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

    // SharedConfigRefresher 对同一 AppConfig 对象原地替换各配置段；运行时持有
    // 同一引用，因此显式 refresh 必须观察到新的 port 并发布 drift。
    config.server.port = 9999;
    currentTime = '2026-08-29T12:00:01.000Z';
    await runtime.refresh('config_file_hot_reload');
    const summary = runtime.getSummary();
    expect(summary.status).toBe('drifted');
    expect(summary.lastChangedAt).toBe(currentTime);
    expect(summary.lastObservedAt).toBe(currentTime);
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
      expected: { schemaVersion: 1, digest: observation.digest },
    });
    await runtime.initialize();
    expect(runtime.getSummary().status).toBe('consistent');
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

  it('较慢的周期重算不会覆盖较新的热更新 observed identity', async () => {
    let resolveSlow!: (value: SecretRef) => void;
    const slowMetadata = new Promise<SecretRef>((resolve) => { resolveSlow = resolve; });
    const metadata = (id: string, version: number): SecretRef => ({
      id,
      ownerId: 'global',
      kind: 'tenant-hand',
      version,
      metadata: {},
      createdAt: '2026-08-30T00:00:00.000Z',
      updatedAt: '2026-08-30T00:00:00.000Z',
    });
    const vault = {
      inspectRef: vi.fn((id: string) => id === 'slow-ref'
        ? slowMetadata
        : Promise.resolve(metadata(id, 2))),
    } as unknown as SecretVault;
    const config = baseConfig(PG);
    let clock = 0;
    const runtime = createConfigIdentityRuntime({
      config,
      secretVault: vault,
      environment: 'test',
      now: () => new Date(clock),
    });
    await runtime.initialize();

    config.tenantRemoteHands = baseConfig({
      ...PG,
      tenantRemoteHands: {
        hands: [{ id: 'slow', baseUrl: 'https://slow.internal', authTokenRef: 'slow-ref' }],
      },
    }).tenantRemoteHands;
    clock = 6_000;
    runtime.getSummary();
    config.tenantRemoteHands = baseConfig({
      ...PG,
      tenantRemoteHands: {
        hands: [{ id: 'fast', baseUrl: 'https://fast.internal', authTokenRef: 'fast-ref' }],
      },
    }).tenantRemoteHands;
    await runtime.refresh('fast-candidate');
    const currentDigest = digestOf(config);
    resolveSlow(metadata('slow-ref', 1));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(runtime.getSummary().observed?.digest).toBe(currentDigest);
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

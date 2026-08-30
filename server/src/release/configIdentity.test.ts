import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parse as parseJsonc } from 'jsonc-parser';

import type { AppConfig } from '../app/config.js';
import { parseAppConfig } from '../app/config.js';
import { InMemorySecretVault } from '../security/secretVault.js';
import type { VaultCaller } from '../security/secretVault.js';
import { parseConfigIdentitySummary } from '@agent/shared';
import {
  buildCanonicalConfigProjection,
  calculateConfigIdentityDigest,
  collectManagedSecretRefs,
  computeObservedConfigIdentity,
  evaluateConfigIdentityStatus,
  readExpectedConfigIdentity,
  resolveSecretRefVersions,
  secretRefIdentity,
  type ExpectedConfigIdentity,
} from './configIdentity.js';
import { readRuntimeIdentity } from './runtimeIdentity.js';

const SYSTEM_CALLER: VaultCaller = {
  actor: 'system',
  userId: '__system__',
  scopes: ['secret:tenant-hand:write', 'secret:tenant-hand:read', 'secret:tenant-hand:rotate'],
};
const REVOKE_CALLER: VaultCaller = {
  actor: 'connector_proxy',
  scopes: ['secret:tenant-hand:revoke'],
};

// rotate 在 InMemory vault 里要求 infrastructure allowlist 授权的
// kind + rotate 组合；tenant_hand 已在 allowlist 内。
const ROTATE_CALLER: VaultCaller = {
  actor: 'system',
  userId: '__system__',
  scopes: ['secret:tenant-hand:read', 'secret:tenant-hand:rotate'],
};

function parseRawConfig(raw: string | Record<string, unknown>): AppConfig {
  const parsed = typeof raw === 'string' ? parseJsonc(raw) : raw;
  return parseAppConfig(parsed);
}

/** 基础配置：只有必填段 + 无受管凭据。 */
const BASE_RAW: Record<string, unknown> = {
  agent: { cwd: '/srv/agent', permissionMode: 'default' },
  server: { port: 3001, timezone: 'Asia/Shanghai' },
};

function baseConfig(overrides: Record<string, unknown> = {}): AppConfig {
  return parseRawConfig({ ...BASE_RAW, ...overrides });
}

function digestOf(config: AppConfig): string {
  const { projection } = buildCanonicalConfigProjection(config);
  return calculateConfigIdentityDigest(projection);
}

describe('canonical projection：注释 / 键顺序 / 等价默认值不影响 identity', () => {
  it('JSONC 注释与原始文本排版不进入 identity', () => {
    const withComments = parseRawConfig(`{
      // 部署注释：这些注释不应影响配置身份
      "agent": { "cwd": "/srv/agent", /* 块注释 */ "permissionMode": "default" },
      "server": { "port": 3001, "timezone": "Asia/Shanghai" }
    }`);
    expect(digestOf(withComments)).toBe(digestOf(baseConfig()));
  });

  it('任意 payload、URL 凭据与语义路径只以脱敏形态进入投影', () => {
    const sensitive = baseConfig({
      dispatch: {
        env: { API_TOKEN: 'dispatch-plaintext-secret' },
        sandbox: {
          allowWrite: ['/home/alice/private-worktree'],
          denyRead: ['/home/alice/.ssh'],
        },
      },
      models: {
        default: 'primary/model-a',
        groups: [
          {
            id: 'primary',
            name: 'Primary',
            apiKey: 'model-plaintext-secret',
            baseUrl: 'https://alice:model-password@models.example.com/v1?token=query-secret',
            extraBody: { nestedToken: 'extra-body-secret' },
            models: [
              {
                id: 'model-a',
                name: 'Model A',
                value: 'model-a',
                thinking: { command: '/home/alice/private-reasoner' },
              },
            ],
          },
        ],
      },
      serverRemote: {
        baseUrl: 'https://hand.example.com',
        authTokenRef: 'hand-token-ref',
        recipe: {
          mountSubPath: '/customer/private/repository',
          repo: { url: 'https://oauth:repo-token@git.example.com/private.git' },
          files: [
            {
              artifactId: 'artifact-1',
              path: '/home/alice/private.txt',
              signedUrl: 'https://objects.example.com/file?signature=signed-secret',
            },
          ],
          setupCommands: ['export TOKEN=command-secret && ./bootstrap'],
        },
      },
      egress: {
        server: {
          enabled: true,
          proxyUrl: 'https://proxy-user:proxy-password@proxy.example.com:8443?token=proxy-query',
          matchDomains: [],
          bypassDomains: [],
          timeoutMs: 20_000,
          failOpen: true,
        },
        sandbox: {
          enabled: true,
          proxyUrl: 'https://sandbox-user:sandbox-password@proxy.example.com',
          noProxy: [],
        },
        packageMirrors: {
          enabled: true,
          pipIndexUrl: 'https://pip-user:pip-password@packages.example.com/simple?token=pip-query',
          pipTrustedHost: 'packages.example.com',
          npmRegistry: 'https://npm-user:npm-password@packages.example.com/npm?token=npm-query',
        },
      },
    });

    const projection = buildCanonicalConfigProjection(sensitive).projection;
    const serialized = JSON.stringify(projection);
    for (const probe of [
      'dispatch-plaintext-secret',
      'model-plaintext-secret',
      'model-password',
      'query-secret',
      'extra-body-secret',
      '/home/alice',
      'repo-token',
      'signed-secret',
      'command-secret',
      'proxy-password',
      'proxy-query',
      'sandbox-password',
      'pip-password',
      'pip-query',
      'npm-password',
      'npm-query',
    ]) {
      expect(serialized).not.toContain(probe);
    }
    expect(serialized).toContain('models.example.com');
    expect(serialized).toContain('proxy.example.com');
    expect(serialized).toContain('__opaqueDigest__');

    const changed = structuredClone(sensitive);
    changed.serverRemote!.recipe!.setupCommands = ['export TOKEN=different-secret && ./bootstrap'];
    expect(digestOf(changed)).not.toBe(digestOf(sensitive));
  });

  it('对象键顺序不影响 identity', () => {
    const reordered = parseRawConfig({
      server: { timezone: 'Asia/Shanghai', port: 3001 },
      agent: { permissionMode: 'default', cwd: '/srv/agent' },
    });
    expect(digestOf(reordered)).toBe(digestOf(baseConfig()));
  });

  it('等价默认值（显式写默认值 vs 依赖 parse-time 默认）得到相同 identity', () => {
    const implicit = parseRawConfig({
      agent: { cwd: '/x' },
      server: {},
      webPush: {},
    });
    const explicit = parseRawConfig({
      agent: { cwd: '/x' },
      server: {},
      webPush: { enabled: false },
    });
    // webPush.enabled 的 schema 默认是 false；显式写出与依赖 parse-time
    // 默认会生成相同有效 AppConfig，因此 identity 必须相同。
    expect(digestOf(explicit)).toBe(digestOf(implicit));
  });

  it('绝对路径不进入 identity：同语义配置在不同主机目录得到相同 digest', () => {
    const hostA = parseRawConfig({
      ...BASE_RAW,
      agent: { cwd: '/srv/host-a', permissionMode: 'default' },
    });
    const hostB = parseRawConfig({
      ...BASE_RAW,
      agent: { cwd: '/srv/host-b', permissionMode: 'default' },
    });
    expect(digestOf(hostA)).toBe(digestOf(hostB));
  });
});

describe('digest 敏感性：真实行为配置变化必然改变 identity', () => {
  it('非敏感有效配置变化改变 digest', () => {
    expect(digestOf(baseConfig({ server: { port: 4001 } }))).not.toBe(digestOf(baseConfig()));
    expect(
      digestOf(baseConfig({ agent: { cwd: '/srv/agent', permissionMode: 'acceptEdits' } })),
    ).not.toBe(digestOf(baseConfig()));
  });

  it('inline secret 值本身的变化不改变 digest（明文不进投影）', () => {
    const withKeyA = digestOf(baseConfig({ stt: { enabled: true, apiKey: 'inline-key-A' } }));
    const withKeyB = digestOf(baseConfig({ stt: { enabled: true, apiKey: 'inline-key-B' } }));
    expect(withKeyA).toBe(withKeyB);
  });

  it('inline -> ref 形态变化改变 digest（同一字段的安全方案切换是行为变化）', () => {
    const inline = digestOf(baseConfig({ stt: { enabled: true, apiKey: 'inline-key-A' } }));
    const ref = digestOf(baseConfig({ stt: { enabled: true, apiKeyRef: 'tenant-hand/abc' } }));
    expect(inline).not.toBe(ref);
  });

  it('受管 ref id 变化改变 digest（经不可逆 ref identity）', () => {
    const refA = digestOf(baseConfig({ stt: { enabled: true, apiKeyRef: 'ref-id-a' } }));
    const refB = digestOf(baseConfig({ stt: { enabled: true, apiKeyRef: 'ref-id-b' } }));
    expect(refA).not.toBe(refB);
  });

  it('回滚 fixture：配置改回旧值后 digest 回到旧值（单调可复现）', () => {
    const original = digestOf(baseConfig());
    const changed = digestOf(baseConfig({ server: { port: 4001 } }));
    const rolledBack = digestOf(baseConfig());
    expect(changed).not.toBe(original);
    expect(rolledBack).toBe(original);
  });
});

describe('脱敏：secret 明文与敏感值绝不进入投影', () => {
  const PLANTED_SECRETS = [
    'sk-inline-wetools-key',
    'inline-bearer-token-123',
    'jwt-secret-value-32-chars-long!!',
    'supersecret-signing-key',
    'oss-access-key-secret-value',
    'doubao-tts-api-key-value',
    'webpush-private-key-value',
    'db-password-s3cr3t',
    'dingtalk-app-secret-value',
    'embedding-api-key-value',
    'model-group-api-key-value',
  ];

  it('所有注册 secret 字段种植明文后，投影与摘要输入均不含明文', () => {
    const config = baseConfig({
      auth: { enabled: true, jwtSecret: 'jwt-secret-value-32-chars-long!!' },
      artifact: {
        backend: 'oss',
        accessKeyId: 'oss-id',
        accessKeySecret: 'oss-access-key-secret-value',
        bucket: 'bucket',
        region: 'cn-shenzhen',
        signedUrlSecret: 'supersecret-signing-key',
      },
      dingtalk: {
        enabled: true,
        robots: {
          'robot-1': { name: 'r1', appKey: 'app-key', appSecret: 'dingtalk-app-secret-value' },
        },
      },
      alerting: {
        dingtalkWebhook: 'https://oapi.dingtalk.com/robot/send?access_token=tok-123',
        dingtalkRobot: {
          appKey: 'ak',
          appSecret: 'dingtalk-app-secret-value',
          receiverUserIds: ['u1'],
        },
      },
      tts: { doubaoAppId: 'app', doubaoApiKey: 'doubao-tts-api-key-value' },
      webPush: {
        enabled: true,
        publicKey: 'pub',
        privateKey: 'webpush-private-key-value',
        subject: 'mailto:a@b.c',
      },
      memory: {
        index: {
          embedding: {
            baseUrl: 'https://e',
            apiKey: 'embedding-api-key-value',
            model: 'm',
            dimensions: 8,
          },
        },
      },
      models: {
        groups: [
          {
            id: 'g',
            name: 'g',
            apiKey: 'model-group-api-key-value',
            models: [{ id: 'm', name: 'm', value: 'm' }],
          },
        ],
        default: 'g/m',
      },
      tenantRemoteHands: {
        hands: [{ id: 'h1', baseUrl: 'https://acs.internal', authTokenRef: 'placeholder-ref' }],
      },
      runtimeEventStore: {
        backend: 'pg',
        connectionString: 'postgresql://user:db-password-s3cr3t@db.internal:5432/runtime',
      },
      stt: { enabled: true, apiKey: 'sk-inline-wetools-key' },
      serverRemote: { baseUrl: 'http://127.0.0.1:3300', authToken: 'inline-bearer-token-123' },
      webTools: { search: { enabled: true, provider: 'tavily', apiKey: 'sk-inline-wetools-key' } },
    });
    const { projection } = buildCanonicalConfigProjection(config);
    const serialized = JSON.stringify(projection);
    for (const secret of PLANTED_SECRETS) {
      expect(serialized).not.toContain(secret);
    }
    // 连接串：保留 host/database，剥离 password 与 query。
    expect(serialized).toContain('db.internal');
    expect(serialized).not.toContain('s3cr3t');
    // webhook：query 中的 access_token 被剥掉，host+path 保留。
    expect(serialized).toContain('oapi.dingtalk.com');
    expect(serialized).not.toContain('tok-123');
  });

  it('signedUrl 的路径型 token 整值只进入 opaque digest', () => {
    const withSignedUrl = (token: string) => baseConfig({
      serverRemote: {
        baseUrl: 'https://hand.example.com',
        authTokenRef: 'hand-ref',
        recipe: {
          repo: { url: 'https://git.example.com/repo.git' },
          files: [{ artifactId: 'a1', path: '/tmp/a', signedUrl: `https://objects.example.com/download/${token}` }],
        },
      },
    });
    const first = withSignedUrl('path-bearer-token-one');
    const second = withSignedUrl('path-bearer-token-two');
    const serialized = JSON.stringify(buildCanonicalConfigProjection(first).projection);

    expect(serialized).not.toContain('path-bearer-token-one');
    expect(serialized).not.toContain('/download/');
    expect(serialized).toContain('https://objects.example.com');
    expect(digestOf(first)).toBe(digestOf(second));
  });

  it('数据库行为字段安全进入投影：等价默认端口稳定，port/protocol/options 变化改变 identity', () => {
    const connection = (connectionString: string) => baseConfig({
      runtimeEventStore: { backend: 'pg' as const, connectionString },
    });
    const implicitDefault = connection('postgres://user:secret@db.internal/runtime?sslmode=require&connect_timeout=5&token=query-secret-one');
    const explicitDefault = connection('postgresql://user:other-secret@db.internal:5432/runtime?connect_timeout=5&sslmode=require&token=query-secret-two');
    const pooler = connection('postgresql://user:secret@db.internal:6432/runtime?sslmode=require&connect_timeout=5');
    const differentTls = connection('postgresql://user:secret@db.internal:5432/runtime?sslmode=verify-full&connect_timeout=5');
    const differentChannelBinding = connection('postgresql://user:secret@db.internal:5432/runtime?sslmode=require&connect_timeout=5&channel_binding=require');
    const serialized = JSON.stringify(buildCanonicalConfigProjection(implicitDefault).projection);

    expect(digestOf(implicitDefault)).toBe(digestOf(explicitDefault));
    expect(digestOf(implicitDefault)).not.toBe(digestOf(pooler));
    expect(digestOf(implicitDefault)).not.toBe(digestOf(differentTls));
    expect(digestOf(implicitDefault)).not.toBe(digestOf(differentChannelBinding));
    expect(serialized).toContain('postgresql');
    expect(serialized).toContain('5432');
    expect(serialized).not.toContain('secret');
    expect(serialized).toContain('sslmode');
    expect(serialized).toContain('require');
    expect(serialized).not.toContain('query-secret');
  });

  it('受管 ref id 本身不进投影（只保留不可逆摘要）', () => {
    const refId = 'tenant-hand/exact-ref-id-should-not-appear';
    const { projection } = buildCanonicalConfigProjection(
      baseConfig({ stt: { enabled: true, apiKeyRef: refId } }),
    );
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain(refId);
    expect(serialized).toContain(secretRefIdentity(refId).slice(7, 31));
  });

  it('dispatch.env / proxy 值脱敏但键与行为变化信号保留', () => {
    const first = baseConfig({
      dispatch: { env: { SOME_API_TOKEN: 'token-value-xyz' } },
      proxy: { HTTP_PROXY: 'http://user:pass@proxy.internal:8080' },
    });
    const second = baseConfig({
      dispatch: { env: { SOME_API_TOKEN: 'token-value-changed' } },
      proxy: { HTTP_PROXY: 'http://user:pass@proxy.internal:8080' },
    });
    const { projection } = buildCanonicalConfigProjection(first);
    const serialized = JSON.stringify(projection);
    expect(serialized).toContain('SOME_API_TOKEN');
    expect(serialized).not.toContain('token-value-xyz');
    expect(serialized).not.toContain('user:pass');
    expect(digestOf(first)).not.toBe(digestOf(second));
  });
});

describe('Secret ref 版本与轮换（明文不可见时改变 identity）', () => {
  it('inspectRef 只返回元数据，不返回明文', async () => {
    const vault = new InMemorySecretVault();
    const ref = await vault.putSecret('global', 'tenant-hand', 'plaintext-value', SYSTEM_CALLER);
    const inspected = await vault.inspectRef!(ref.id, SYSTEM_CALLER);
    expect(inspected).toBeDefined();
    expect(JSON.stringify(inspected)).not.toContain('plaintext-value');
    expect(inspected?.version).toBe(1);
  });

  it('rotate 递增 opaque version，credentialVersionDigest 随之改变', async () => {
    const vault = new InMemorySecretVault();
    const ref = await vault.putSecret('global', 'tenant-hand', 'v1-value', SYSTEM_CALLER);
    const config = baseConfig({
      tenantRemoteHands: {
        hands: [{ id: 'h1', baseUrl: 'https://acs.internal', authTokenRef: ref.id }],
      },
      runtimeEventStore: {
        backend: 'pg' as const,
        connectionString: 'postgresql://u:p@db.internal:5432/runtime',
      },
    });
    const before = await computeObservedConfigIdentity(config, vault);
    expect(before.versionResolution).toBe('resolved');
    expect(before.secretRefCount).toBe(1);
    expect(before.credentialVersionDigest).not.toBeNull();

    await vault.rotateSecret(ref.id, 'v2-value', ROTATE_CALLER);
    const after = await computeObservedConfigIdentity(config, vault);
    // 配置语义 digest 不变（config 文件没变），但轮换改变了身份。
    expect(after.digest).toBe(before.digest);
    expect(after.credentialVersionDigest).not.toBe(before.credentialVersionDigest);
    expect(after.schemaVersion).toBe(before.schemaVersion);
  });

  it('revoke 后不再把 ref 判为 resolved/consistent', async () => {
    const vault = new InMemorySecretVault();
    const ref = await vault.putSecret('global', 'tenant-hand', 'v1-value', SYSTEM_CALLER);
    const config = baseConfig({
      tenantRemoteHands: {
        hands: [{ id: 'h1', baseUrl: 'https://acs.internal', authTokenRef: ref.id }],
      },
      runtimeEventStore: {
        backend: 'pg' as const,
        connectionString: 'postgresql://u:p@db.internal:5432/runtime',
      },
    });
    const before = await computeObservedConfigIdentity(config, vault);
    await vault.revokeSecret(ref.id, REVOKE_CALLER);
    const after = await computeObservedConfigIdentity(config, vault);

    expect(after.digest).toBe(before.digest);
    expect(after.versionResolution).toBe('unavailable');
    expect(after.credentialVersionDigest).toBeNull();
    expect(after.unresolvedRefPaths).toContain('tenantRemoteHands.hands.*.authTokenRef');
    expect(
      evaluateConfigIdentityStatus(
        {
          schemaVersion: before.schemaVersion,
          digest: before.digest,
          credentialVersionDigest: before.credentialVersionDigest ?? undefined,
        },
        after,
      ),
    ).toEqual({ status: 'unverifiable', reason: 'secret_ref_version_unresolved' });
  });

  it('vault 不支持 inspectRef 时版本不可验证（不伪造）', async () => {
    const config = baseConfig({
      tenantRemoteHands: {
        hands: [{ id: 'h1', baseUrl: 'https://acs.internal', authTokenRef: 'some-ref' }],
      },
      runtimeEventStore: {
        backend: 'pg' as const,
        connectionString: 'postgresql://u:p@db.internal:5432/runtime',
      },
    });
    const observation = await computeObservedConfigIdentity(config, undefined);
    expect(observation.versionResolution).toBe('unavailable');
    expect(observation.credentialVersionDigest).toBeNull();
    expect(observation.unresolvedRefPaths).toContain('tenantRemoteHands.hands.*.authTokenRef');
  });

  it('ref 缺失（vault 里查不到）时版本不可验证', async () => {
    const vault = new InMemorySecretVault();
    const config = baseConfig({
      tenantRemoteHands: {
        hands: [{ id: 'h1', baseUrl: 'https://acs.internal', authTokenRef: 'missing-ref' }],
      },
      runtimeEventStore: {
        backend: 'pg' as const,
        connectionString: 'postgresql://u:p@db.internal:5432/runtime',
      },
    });
    const observation = await computeObservedConfigIdentity(config, vault);
    expect(observation.versionResolution).not.toBe('resolved');
  });

  it('多组件/多字段 ref 语义一致（codex credentialRefs 数组同样进入版本摘要）', async () => {
    const vault = new InMemorySecretVault();
    const refA = await vault.putSecret('global', 'tenant-hand', 'a', SYSTEM_CALLER);
    const refB = await vault.putSecret('global', 'tenant-hand', 'b', SYSTEM_CALLER);
    const config = baseConfig({
      tenantRemoteHands: {
        hands: [{ id: 'h1', baseUrl: 'https://acs.internal', authTokenRef: refA.id }],
      },
      runtimeEventStore: {
        backend: 'pg' as const,
        connectionString: 'postgresql://u:p@db.internal:5432/runtime',
      },
      codexSubscription: { enabled: true, credentialRefs: [refB.id] },
    });
    const refs = collectManagedSecretRefs(config);
    expect(refs).toHaveLength(2);
    const versions = await resolveSecretRefVersions(refs, vault);
    expect(versions.resolution).toBe('resolved');
  });
});

describe('expected identity 读取（env 绑定）', () => {
  const VALID_DIGEST = `sha256:${'e'.repeat(64)}`;

  it('读取合法 expected identity（schema version 缺省为 1）', () => {
    expect(readExpectedConfigIdentity({ AGENT_SAAS_CONFIG_IDENTITY_DIGEST: VALID_DIGEST })).toEqual(
      { schemaVersion: 1, digest: VALID_DIGEST },
    );
    expect(
      readExpectedConfigIdentity({
        AGENT_SAAS_CONFIG_IDENTITY_DIGEST: VALID_DIGEST,
        AGENT_SAAS_CONFIG_IDENTITY_SCHEMA_VERSION: '1',
        AGENT_SAAS_CONFIG_IDENTITY_CREDENTIAL_VERSION_DIGEST: `sha256:${'f'.repeat(64)}`,
      }),
    ).toMatchObject({ schemaVersion: 1, credentialVersionDigest: `sha256:${'f'.repeat(64)}` });
  });

  it('缺失时返回 undefined；残缺配置 fail closed', () => {
    expect(readExpectedConfigIdentity({})).toBeUndefined();
    expect(() =>
      readExpectedConfigIdentity({ AGENT_SAAS_CONFIG_IDENTITY_SCHEMA_VERSION: '1' }),
    ).toThrow(/without/);
    expect(() => readExpectedConfigIdentity({ AGENT_SAAS_CONFIG_IDENTITY_DIGEST: 'nope' })).toThrow(
      /sha256 digest/,
    );
  });

  it('旧 release env（无 config identity）仍能读出 RuntimeIdentity（显式兼容）', () => {
    const identity = readRuntimeIdentity({ AGENT_SAAS_ENVIRONMENT: 'production' });
    expect(identity.environment).toBe('production');
    expect(identity.expectedConfigIdentity).toBeUndefined();
  });

  it('staging 拒绝缺失或版本不支持的 expected identity', () => {
    const base = {
      AGENT_SAAS_ENVIRONMENT: 'staging',
      AGENT_SAAS_RELEASE_ID: 'rc-20260829-01',
      AGENT_SAAS_RELEASE_SHA: 'a'.repeat(40),
      AGENT_SAAS_SERVER_DIGEST: VALID_DIGEST,
      AGENT_SAAS_WEB_DIGEST: VALID_DIGEST,
      AGENT_SAAS_ACS_ORCHESTRATOR_DIGEST: VALID_DIGEST,
      AGENT_SAAS_ACS_SANDBOX_IMAGE_DIGEST: VALID_DIGEST,
    } as Record<string, string>;
    expect(() => readRuntimeIdentity(base)).toThrow(/config identity/);
    expect(() =>
      readRuntimeIdentity({
        ...base,
        AGENT_SAAS_CONFIG_IDENTITY_DIGEST: VALID_DIGEST,
        AGENT_SAAS_CONFIG_IDENTITY_SCHEMA_VERSION: '2',
      }),
    ).toThrow(/schema version/);
    expect(
      readRuntimeIdentity({
        ...base,
        AGENT_SAAS_CONFIG_IDENTITY_DIGEST: VALID_DIGEST,
      }),
    ).toMatchObject({
      expectedConfigIdentity: { schemaVersion: 1, digest: VALID_DIGEST },
    });
  });
});

describe('四态判定', () => {
  const digest = `sha256:${'1'.repeat(64)}`;
  const other = `sha256:${'2'.repeat(64)}`;
  const versions = `sha256:${'3'.repeat(64)}`;
  const otherVersions = `sha256:${'4'.repeat(64)}`;
  const expected: ExpectedConfigIdentity = { schemaVersion: 1, digest };
  const observedBase = {
    schemaVersion: 1,
    digest,
    credentialVersionDigest: versions as string | null,
    versionResolution: 'resolved' as const,
  };

  it('未采集：observed 缺失', () => {
    expect(evaluateConfigIdentityStatus(expected, undefined)).toEqual({ status: 'not_collected' });
    expect(evaluateConfigIdentityStatus(undefined, undefined)).toEqual({ status: 'not_collected' });
  });

  it('不可验证：expected 未绑定 / 版本未解析 / schema 不支持', () => {
    expect(evaluateConfigIdentityStatus(undefined, observedBase)).toEqual({
      status: 'unverifiable',
      reason: 'expected_not_bound',
    });
    expect(
      evaluateConfigIdentityStatus(expected, { ...observedBase, versionResolution: 'partial' }),
    ).toEqual({ status: 'unverifiable', reason: 'secret_ref_version_unresolved' });
    expect(evaluateConfigIdentityStatus({ ...expected, schemaVersion: 2 }, observedBase)).toEqual({
      status: 'unverifiable',
      reason: 'schema_version_unsupported',
    });
  });

  it('漂移：配置 digest 不一致，或轮换后的版本摘要不一致', () => {
    expect(evaluateConfigIdentityStatus(expected, { ...observedBase, digest: other })).toEqual({
      status: 'drifted',
    });
    expect(
      evaluateConfigIdentityStatus(expected, {
        ...observedBase,
        digest: other,
        versionResolution: 'partial',
      }),
    ).toEqual({ status: 'drifted' });
    expect(
      evaluateConfigIdentityStatus(
        { ...expected, credentialVersionDigest: versions },
        { ...observedBase, credentialVersionDigest: otherVersions },
      ),
    ).toEqual({ status: 'drifted' });
    expect(
      evaluateConfigIdentityStatus(
        { ...expected, credentialVersionDigest: versions },
        { ...observedBase, credentialVersionDigest: null },
      ),
    ).toEqual({ status: 'drifted' });
  });

  it('一致：digest 相同且版本可验证；expected 未固定版本时也判定一致（部署期无 vault 访问）', () => {
    expect(evaluateConfigIdentityStatus(expected, observedBase)).toEqual({ status: 'consistent' });
    expect(
      evaluateConfigIdentityStatus(
        { ...expected, credentialVersionDigest: versions },
        observedBase,
      ),
    ).toEqual({ status: 'consistent' });
  });
});

describe('跨组件 wire 契约（shared schema）', () => {
  it('合法 summary 可解析；旧 schema / 缺字段及矛盾状态数据被拒绝', () => {
    const valid = {
      schemaVersion: 1,
      status: 'drifted',
      expected: { schemaVersion: 1, digest: `sha256:${'a'.repeat(64)}` },
      observed: {
        schemaVersion: 1,
        digest: `sha256:${'b'.repeat(64)}`,
        credentialVersionDigest: null,
        versionResolution: 'unavailable',
        secretRefCount: 2,
      },
      lastObservedAt: '2026-08-29T12:00:00.000Z',
    };
    expect(parseConfigIdentitySummary(valid)).toEqual(valid);
    expect(parseConfigIdentitySummary({ ...valid, schemaVersion: 0 })).toBeNull();
    expect(parseConfigIdentitySummary({ ...valid, status: 'unknown' })).toBeNull();
    expect(parseConfigIdentitySummary(undefined)).toBeNull();
    expect(
      parseConfigIdentitySummary({
        ...valid,
        observed: { ...valid.observed, digest: 'leaked-plaintext' },
      }),
    ).toBeNull();
    expect(
      parseConfigIdentitySummary({ ...valid, plaintextSecret: 'must-not-pass-wire-schema' }),
    ).toBeNull();
    expect(
      parseConfigIdentitySummary({
        ...valid,
        status: 'consistent',
        observed: {
          ...valid.observed,
          digest: valid.expected.digest,
          versionResolution: 'unavailable',
        },
      }),
    ).toBeNull();
    expect(parseConfigIdentitySummary({ schemaVersion: 1, status: 'consistent' })).toBeNull();
    expect(parseConfigIdentitySummary({ schemaVersion: 1, status: 'unverifiable' })).toBeNull();
    expect(
      parseConfigIdentitySummary({
        ...valid,
        status: 'unverifiable',
        reason: 'expected_not_bound',
      }),
    ).toBeNull();
    expect(
      parseConfigIdentitySummary({
        schemaVersion: 1,
        status: 'not_collected',
        observed: valid.observed,
      }),
    ).toBeNull();
  });

  it('secret_ref_version_unresolved 仅接受已绑定、schema 可比且 config digest 相同', () => {
    const digestA = `sha256:${'a'.repeat(64)}`;
    const digestB = `sha256:${'b'.repeat(64)}`;
    const observed = {
      schemaVersion: 1,
      digest: digestA,
      credentialVersionDigest: null,
      versionResolution: 'unavailable' as const,
      secretRefCount: 1,
    };
    const unresolved = {
      schemaVersion: 1 as const,
      status: 'unverifiable' as const,
      reason: 'secret_ref_version_unresolved' as const,
      expected: { schemaVersion: 1, digest: digestA },
      observed,
    };

    expect(parseConfigIdentitySummary(unresolved)).toEqual(unresolved);
    expect(
      parseConfigIdentitySummary({
        ...unresolved,
        expected: { ...unresolved.expected, digest: digestB },
      }),
    ).toBeNull();
    expect(
      parseConfigIdentitySummary({
        ...unresolved,
        expected: { ...unresolved.expected, schemaVersion: 2 },
      }),
    ).toBeNull();
    const { expected: _expected, ...withoutExpected } = unresolved;
    expect(parseConfigIdentitySummary(withoutExpected)).toBeNull();

    expect(
      parseConfigIdentitySummary({
        ...unresolved,
        status: 'drifted',
        reason: undefined,
        expected: { ...unresolved.expected, digest: digestB },
      }),
    ).not.toBeNull();
    expect(
      parseConfigIdentitySummary({
        ...unresolved,
        reason: 'schema_version_unsupported',
        expected: { ...unresolved.expected, schemaVersion: 2 },
      }),
    ).not.toBeNull();
    expect(
      parseConfigIdentitySummary({
        ...withoutExpected,
        reason: 'expected_not_bound',
      }),
    ).not.toBeNull();
  });
});

describe('domain separation：config identity digest 与 Manifest/制品 digest 不可混用', () => {
  it('digest 使用独立 domain separator，与裸 sha256(config) 不同', () => {
    const { projection } = buildCanonicalConfigProjection(baseConfig());
    const bare = `sha256:${createHash('sha256').update(JSON.stringify(projection)).digest('hex')}`;
    expect(digestOf(baseConfig())).not.toBe(bare);
  });
});

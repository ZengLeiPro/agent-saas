import { describe, expect, it } from 'vitest';
import { parse as parseJsonc } from 'jsonc-parser';

import type { AppConfig } from '../app/config.js';
import { parseAppConfig } from '../app/config.js';
import {
  buildCanonicalConfigProjection,
  calculateConfigIdentityDigest,
} from './configIdentity.js';

function parseRawConfig(raw: string | Record<string, unknown>): AppConfig {
  const parsed = typeof raw === 'string' ? parseJsonc(raw) : raw;
  return parseAppConfig(parsed);
}

const BASE_RAW: Record<string, unknown> = {
  agent: { cwd: '/srv/agent', permissionMode: 'default' },
  server: { port: 3001, timezone: 'Asia/Shanghai' },
};

function baseConfig(overrides: Record<string, unknown> = {}): AppConfig {
  return parseRawConfig({ ...BASE_RAW, ...overrides });
}

function digestOf(config: AppConfig, processCwd = '/srv/server'): string {
  const { projection } = buildCanonicalConfigProjection(config, processCwd);
  return calculateConfigIdentityDigest(projection);
}

describe('canonical projection：注释、键顺序与等价默认值不影响 identity', () => {
  it('JSONC 注释与原始排版不进入 identity', () => {
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
      runtimeEventStore: { backend: 'pg', connectionString: 'postgresql://runtime@db/runtime' },
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

describe('URL query canonicalization 与数组字段语义', () => {
  it('模型 baseUrl 与普通 endpoint 的 query 变化改变 digest，但 query 明文不进入投影', () => {
    const withModelQuery = (query: string) =>
      baseConfig({
        models: {
          default: 'primary/model-a',
          groups: [
            {
              id: 'primary',
              name: 'Primary',
              apiKey: 'model-secret',
              baseUrl: `https://models.example.com/v1?api-version=${query}`,
              models: [{ id: 'model-a', name: 'Model A', value: 'model-a' }],
            },
          ],
        },
      });
    const withEndpointQuery = (query: string) =>
      baseConfig({
        server: {
          port: 3001,
          timezone: 'Asia/Shanghai',
          webBaseUrl: `https://agent.example.com/app?tenant=${query}`,
        },
      });

    expect(digestOf(withModelQuery('2025-01-01'))).not.toBe(digestOf(withModelQuery('2026-01-01')));
    expect(digestOf(withEndpointQuery('tenant-a'))).not.toBe(
      digestOf(withEndpointQuery('tenant-b')),
    );
    const serialized = JSON.stringify(
      buildCanonicalConfigProjection(withModelQuery('private-version')).projection,
    );
    expect(serialized).not.toContain('api-version');
    expect(serialized).not.toContain('private-version');
    expect(serialized).toContain('__query__');
    expect(serialized).toContain('__opaqueDigest__');
  });

  it('不同 key 的 query 参数重排等价，同 key 值顺序与重复项保持行为信号，且投影不泄露明文', () => {
    const withQuery = (query: string) =>
      baseConfig({
        models: {
          default: 'primary/model-a',
          groups: [
            {
              id: 'primary',
              name: 'Primary',
              apiKey: 'model-secret',
              baseUrl: `https://models.example.com/v1?${query}`,
              models: [{ id: 'model-a', name: 'Model A', value: 'model-a' }],
            },
          ],
        },
      });
    const original = withQuery(
      'private-route-key=route-blue&private-duplicate-key=secret-two&private-duplicate-key=secret-one',
    );
    const reordered = withQuery(
      'private-duplicate-key=secret-two&private-duplicate-key=secret-one&private-route-key=route-blue',
    );
    const duplicateOrderChanged = withQuery(
      'private-duplicate-key=secret-one&private-duplicate-key=secret-two&private-route-key=route-blue',
    );
    const changed = withQuery(
      'private-duplicate-key=secret-one&private-route-key=route-blue&private-duplicate-key=secret-three',
    );
    const identicalDuplicate = withQuery(
      'private-route-key=route-blue&private-duplicate-key=secret-one&private-duplicate-key=secret-one',
    );
    const singleEntry = withQuery(
      'private-route-key=route-blue&private-duplicate-key=secret-one',
    );

    expect(digestOf(reordered)).toBe(digestOf(original));
    expect(digestOf(duplicateOrderChanged)).not.toBe(digestOf(original));
    expect(digestOf(changed)).not.toBe(digestOf(original));
    expect(digestOf(identicalDuplicate)).not.toBe(digestOf(singleEntry));

    const serialized = JSON.stringify(buildCanonicalConfigProjection(original).projection);
    for (const plaintext of [
      'private-route-key',
      'route-blue',
      'private-duplicate-key',
      'secret-one',
      'secret-two',
    ]) {
      expect(serialized).not.toContain(plaintext);
    }
    expect(serialized).toContain('__query__');
    expect(serialized).toContain('__opaqueDigest__');
  });

  it('CORS 与 egress 域名列表按集合排序去重，而顺序敏感数组保持原序', () => {
    const cors = (corsOrigins: string[]) =>
      baseConfig({ server: { port: 3001, timezone: 'Asia/Shanghai', corsOrigins } });
    expect(
      digestOf(cors(['https://b.example.com', 'https://a.example.com', 'https://a.example.com'])),
    ).toBe(digestOf(cors(['https://a.example.com', 'https://b.example.com'])));

    const egressDomains = (matchDomains: string[], bypassDomains: string[]) =>
      baseConfig({
        egress: {
          server: {
            enabled: true,
            matchDomains,
            bypassDomains,
            timeoutMs: 20_000,
            failOpen: true,
          },
        },
      });
    expect(digestOf(egressDomains(['b.example.com', 'a.example.com'], ['local', 'local']))).toBe(
      digestOf(egressDomains(['a.example.com', 'b.example.com'], ['local'])),
    );

    const settingSources = (items: Array<'user' | 'project'>) =>
      baseConfig({
        agent: { cwd: '/srv/agent', permissionMode: 'default', settingSources: items },
      });
    expect(digestOf(settingSources(['user', 'project']))).not.toBe(
      digestOf(settingSources(['project', 'user'])),
    );
  });
});

import express from 'express';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseAppConfig } from '../app/config.js';
import { EgressConfigStore } from '../data/egressConfig.js';
import { createEgressConfigAdminRouter } from '../routes/egressConfigAdmin.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import { EncryptedFileSecretVault } from '../security/secretVault.js';
import type { EgressConfig } from '../runtime/egressPolicy.js';

const servers: Array<{ close: () => void }> = [];
const roots: string[] = [];

function baseRawConfig() {
  return {
    agent: { cwd: '/tmp/agent' },
    server: { port: 3200 },
  };
}

function fullConfig(overrides: Partial<EgressConfig> = {}): EgressConfig {
  return {
    server: {
      enabled: false,
      proxyUrl: '',
      matchDomains: [],
      bypassDomains: [],
      timeoutMs: 20_000,
      failOpen: true,
    },
    sandbox: { enabled: false, proxyUrl: '', noProxy: [] },
    packageMirrors: {
      enabled: false,
      pipIndexUrl: 'https://mirrors.aliyun.com/pypi/simple/',
      pipTrustedHost: 'mirrors.aliyun.com',
      npmRegistry: 'https://registry.npmmirror.com',
    },
    ...overrides,
  };
}

interface HarnessArgs {
  baseUrl: string;
  storePath: string;
  store: EgressConfigStore;
  orchestratorCalls: Array<{ path: string; body: unknown }>;
  refreshProxyCredential: ReturnType<typeof vi.fn>;
}

async function withApp<T>(
  fn: (args: HarnessArgs) => Promise<T>,
  options: {
    role?: string;
    tenantId?: string;
    orchestratorStatus?: number;
    withVault?: boolean;
  } = {},
): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'egress-admin-'));
  roots.push(root);
  const storePath = join(root, 'data', 'egress-config.json');
  const store = new EgressConfigStore(storePath);
  const runtimeConfig = parseAppConfig({
    ...baseRawConfig(),
    tenantRemoteHands: {
      hands: [
        {
          id: 'agent-saas-acs',
          name: 'ACS',
          baseUrl: 'http://127.0.0.1:65535',
          authToken: 'test-token',
          backend: 'acs',
        },
      ],
    },
    runtimeEventStore: { backend: 'pg', connectionString: 'postgres://localhost/test' },
  } as Record<string, unknown>);

  const orchestratorCalls: Array<{ path: string; body: unknown }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    orchestratorCalls.push({
      path: url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const status = options.orchestratorStatus ?? 200;
    return new Response(JSON.stringify(status === 200 ? { ok: true } : { error: 'boom' }), {
      status,
    });
  }) as unknown as typeof fetch;

  const refreshProxyCredential = vi.fn(async () => undefined);
  const secretVault = options.withVault
    ? new EncryptedFileSecretVault(join(root, 'secrets.enc'), 'local-dev-key')
    : undefined;

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = {
      sub: 'admin',
      username: 'admin',
      role: options.role ?? 'admin',
      tenantId: options.tenantId ?? DEFAULT_TENANT_ID,
    };
    next();
  });
  app.use(
    '/api/admin/egress-config',
    createEgressConfigAdminRouter({
      config: runtimeConfig,
      store,
      secretVault,
      refreshProxyCredential,
      fetchImpl,
      loopbackFetchImpl: fetchImpl,
    }),
  );
  const server = app.listen(0);
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind test server');
  return fn({
    baseUrl: `http://127.0.0.1:${address.port}`,
    storePath,
    store,
    orchestratorCalls,
    refreshProxyCredential,
  });
}

afterEach(() => {
  while (servers.length > 0) servers.pop()?.close();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('staging egress config store', () => {
  const safe = () =>
    fullConfig({
      server: {
        enabled: true,
        proxyUrl: 'http://proxy.staging.internal:7890',
        matchDomains: [],
        bypassDomains: [],
        timeoutMs: 20_000,
        failOpen: false,
      },
    });

  it('rejects unsafe seed and hot updates', async () => {
    expect(() => new EgressConfigStore('/unused', fullConfig(), 'staging')).toThrow(
      /staging egress/u,
    );
    const store = new EgressConfigStore('/unused', safe(), 'staging');
    await expect(store.update(fullConfig(), { actor: 'admin' })).rejects.toThrow(/staging egress/u);
    expect(store.getConfig().server.enabled).toBe(true);
  });
});

describe('egress config admin router', () => {
  it('默认返回全关配置，不暴露凭据明文', async () => {
    await withApp(async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/admin/egress-config`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as any;
      expect(body.config.server.enabled).toBe(false);
      expect(body.config.sandbox.enabled).toBe(false);
      expect(body.proxyCredentialConfigured).toBe(false);
      expect(JSON.stringify(body)).not.toContain('password');
      expect(body.updatedAt).toBeNull();
    });
  });

  it('非平台管理员一律 403', async () => {
    await withApp(
      async ({ baseUrl }) => {
        const response = await fetch(`${baseUrl}/api/admin/egress-config`);
        expect(response.status).toBe(403);
      },
      { role: 'user' },
    );

    await withApp(
      async ({ baseUrl }) => {
        const response = await fetch(`${baseUrl}/api/admin/egress-config`);
        expect(response.status).toBe(403);
      },
      { tenantId: 'some-other-tenant' },
    );
  });

  it('保存后落盘（0600）并下发 orchestrator', async () => {
    await withApp(async ({ baseUrl, storePath, orchestratorCalls, refreshProxyCredential }) => {
      const response = await fetch(`${baseUrl}/api/admin/egress-config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          config: fullConfig({
            server: {
              enabled: true,
              proxyUrl: 'http://172.16.177.77:7890',
              matchDomains: ['openai.com'],
              bypassDomains: [],
              timeoutMs: 20_000,
              failOpen: true,
            },
            sandbox: { enabled: true, proxyUrl: 'http://172.16.177.77:7890', noProxy: [] },
          }),
        }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as any;
      expect(body.config.server.matchDomains).toEqual(['openai.com']);
      expect(body.sandboxSync.ok).toBe(true);

      // 落盘且权限收紧
      const persisted = JSON.parse(readFileSync(storePath, 'utf-8'));
      expect(persisted.config.server.proxyUrl).toBe('http://172.16.177.77:7890');
      expect(persisted.configVersion).toBe(1);
      expect(statSync(storePath).mode & 0o777).toBe(0o600);

      // 只把 sandbox / packageMirrors 段下发给 orchestrator，server 段不下发
      expect(orchestratorCalls).toHaveLength(1);
      expect(orchestratorCalls[0]!.path).toContain('/runtime-config');
      const sent = orchestratorCalls[0]!.body as any;
      expect(sent.egress.proxy.proxyUrl).toBe('http://172.16.177.77:7890');
      expect(sent.egress).not.toHaveProperty('server');
      expect(refreshProxyCredential).toHaveBeenCalled();
    });
  });

  it('orchestrator 下发失败不回滚配置，只标记 sandboxSync', async () => {
    await withApp(
      async ({ baseUrl, store }) => {
        const response = await fetch(`${baseUrl}/api/admin/egress-config`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            config: fullConfig({
              sandbox: { enabled: true, proxyUrl: 'http://10.0.0.1:8080', noProxy: [] },
            }),
          }),
        });
        expect(response.status).toBe(200);
        const body = (await response.json()) as any;
        expect(body.sandboxSync.ok).toBe(false);
        expect(body.sandboxSync.error).toContain('500');
        // 配置本身仍是期望态
        expect(store.getConfig().sandbox.proxyUrl).toBe('http://10.0.0.1:8080');
      },
      { orchestratorStatus: 500 },
    );
  });

  it('启用但地址非法时 400，且不写盘', async () => {
    await withApp(async ({ baseUrl, store }) => {
      for (const bad of ['', '172.16.177.77:7890', 'ftp://p.example.com']) {
        const response = await fetch(`${baseUrl}/api/admin/egress-config`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            config: fullConfig({
              server: {
                enabled: true,
                proxyUrl: bad,
                matchDomains: [],
                bypassDomains: [],
                timeoutMs: 20_000,
                failOpen: true,
              },
            }),
          }),
        });
        expect(response.status).toBe(400);
      }
      expect(store.getConfigVersion()).toBe(0);
    });
  });

  it('server 段拒绝 socks 代理（undici ProxyAgent 只支持 HTTP CONNECT）', async () => {
    await withApp(async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/admin/egress-config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          config: fullConfig({
            server: {
              enabled: true,
              proxyUrl: 'socks5://127.0.0.1:1080',
              matchDomains: [],
              bypassDomains: [],
              timeoutMs: 20_000,
              failOpen: true,
            },
          }),
        }),
      });
      expect(response.status).toBe(400);
      expect(((await response.json()) as any).error).toContain('socks');
    });
  });

  it('sandbox 段允许 socks（容器内 curl 支持）', async () => {
    await withApp(async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/admin/egress-config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          config: fullConfig({
            sandbox: { enabled: true, proxyUrl: 'socks5://172.16.177.77:7891', noProxy: [] },
          }),
        }),
      });
      expect(response.status).toBe(200);
    });
  });

  it('代理凭据写 vault 并只回显布尔标记', async () => {
    await withApp(
      async ({ baseUrl, storePath }) => {
        const response = await fetch(`${baseUrl}/api/admin/egress-config`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            config: fullConfig(),
            proxyCredential: 'alice:super-secret',
          }),
        });
        expect(response.status).toBe(200);
        const body = (await response.json()) as any;
        expect(body.proxyCredentialConfigured).toBe(true);
        expect(JSON.stringify(body)).not.toContain('super-secret');

        const raw = readFileSync(storePath, 'utf-8');
        expect(raw).not.toContain('super-secret');
        expect(JSON.parse(raw).proxyCredentialRef).toBeTruthy();
      },
      { withVault: true },
    );
  });

  it('未启用 vault 时拒绝保存凭据而不是静默丢弃', async () => {
    await withApp(async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/admin/egress-config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ config: fullConfig(), proxyCredential: 'alice:pw' }),
      });
      expect(response.status).toBe(400);
      expect(((await response.json()) as any).error).toContain('secretVault');
    });
  });

  it('probe 拒绝非法代理地址', async () => {
    await withApp(async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/admin/egress-config/probe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ proxyUrl: 'not-a-url' }),
      });
      expect(response.status).toBe(400);
    });
  });
});

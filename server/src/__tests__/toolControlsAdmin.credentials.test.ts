import { createHash } from 'node:crypto';
import express from 'express';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadAppConfig, parseAppConfig } from '../app/config.js';
import { createToolControlsAdminRouter } from '../routes/toolControlsAdmin.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import { InMemorySecretVault } from '../security/secretVault.js';

const servers: Array<{ close: () => void }> = [];

function baseRawConfig() {
  return {
    agent: { cwd: '/tmp/agent' },
    server: { port: 3200 },
    toolControls: {
      tools: {
        Shell: { enabled: false },
        Grep: { enabled: false },
      },
    },
    webTools: {
      enabled: true,
      search: {
        provider: 'brave',
        apiKey: 'brave-secret-123',
        timeoutMs: 8000,
        maxResults: 5,
      },
      fetch: {
        enabled: true,
        timeoutMs: 10000,
        maxChars: 20000,
      },
      egress: {
        allowPrivateNetworks: false,
      },
    },
  };
}

function makeWorkspace(rawConfig: ReturnType<typeof baseRawConfig> | Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), 'tool-controls-admin-'));
  const processCwd = join(root, 'server');
  mkdirSync(processCwd, { recursive: true });
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify(rawConfig, null, 2), 'utf-8');
  return { processCwd, configPath };
}

async function withApp<T>(
  rawConfig: ReturnType<typeof baseRawConfig> | Record<string, unknown>,
  fn: (args: { baseUrl: string; configPath: string; processCwd: string; runtimeConfig: ReturnType<typeof parseAppConfig> }) => Promise<T>,
  opts: Partial<Parameters<typeof createToolControlsAdminRouter>[0]> = {},
): Promise<T> {
  const { processCwd, configPath } = makeWorkspace(rawConfig);
  const runtimeConfig = parseAppConfig(rawConfig);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { sub: 'admin', username: 'admin', role: 'admin', tenantId: DEFAULT_TENANT_ID };
    next();
  });
  app.use('/api/admin/tool-controls', createToolControlsAdminRouter({
    processCwd,
    config: runtimeConfig,
    ...opts,
  }));
  const server = app.listen(0);
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind test server');
  return fn({ baseUrl: `http://127.0.0.1:${address.port}`, configPath, processCwd, runtimeConfig });
}

async function readJson(response: Response) {
  return response.json() as Promise<any>;
}

function revision(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('tool controls admin WebSearch credential lifecycle', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('AGENT_SAAS_ALLOW_UNIDENTIFIED_ENVIRONMENT', '1');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    while (servers.length > 0) servers.pop()?.close();
  });

  it('保存豆包两源排队设置，经 schema、凭据解析与热更新后仍保留', async () => {
    const secretVault = new InMemorySecretVault();
    const onToolSettingsUpdated = vi.fn(async () => undefined);
    await withApp(baseRawConfig(), async ({ baseUrl, configPath, runtimeConfig }) => {
      const response = await fetch(`${baseUrl}/api/admin/tool-controls`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ toolControls: {}, webTools: { enabled: true, search: {
          provider: 'volcengine', apiKey: 'new-plan-key', enableWaiting: true, maxWaitTimeMs: 7000,
          global: { provider: 'volcengine', apiKey: 'global-plan-key', enableWaiting: false, maxWaitTimeMs: 3000, searchEngine: 'search_std' },
        } } }),
      });
      const body = await readJson(response);
      expect(response.status, JSON.stringify(body)).toBe(200);
      expect(body.webTools.search).toMatchObject({ enableWaiting: true, maxWaitTimeMs: 7000,
        global: { enableWaiting: false, maxWaitTimeMs: 3000, searchEngine: 'search_std' } });
      expect(JSON.stringify(body)).not.toContain('plan-key');
      const written = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(written.webTools.search.apiKey).toBeUndefined();
      expect(runtimeConfig.webTools?.search?.maxWaitTimeMs).toBe(7000);
      expect(onToolSettingsUpdated).toHaveBeenCalled();
    }, { secretVault, onToolSettingsUpdated });
  });

  it('does not expose a legacy inline global WebSearch apiKey', async () => {
    const raw: any = baseRawConfig();
    raw.webTools.search.global = { provider: 'tavily', apiKey: 'global-legacy-secret' };
    await withApp(raw, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/admin/tool-controls`);
      expect(response.status).toBe(200);
      const body = await readJson(response);
      expect(body.webTools.search.global).toMatchObject({ provider: 'tavily', hasApiKey: true });
      expect(body.webTools.search.global.apiKey).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain('global-legacy-secret');
    });
  });


  it('rejects a main WebSearch inline key when SecretVault is unavailable without side effects or leaks', async () => {
    const validateToolSettingsConfig = vi.fn(async () => undefined);
    const onToolSettingsUpdated = vi.fn(async () => undefined);
    const onConfigReloaded = vi.fn(async () => undefined);
    await withApp({ agent: { cwd: '/tmp/agent' }, server: { port: 3200 } }, async ({ baseUrl, configPath, runtimeConfig }) => {
      const before = readFileSync(configPath, 'utf-8');
      const runtimeBefore = structuredClone(runtimeConfig);
      const response = await fetch(`${baseUrl}/api/admin/tool-controls`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ toolControls: {}, webTools: { enabled: true, search: {
          provider: 'zhipu', apiKey: 'main-no-vault-secret',
        } } }),
      });

      expect(response.status).toBe(400);
      const responseText = await response.text();
      expect(responseText).not.toContain('main-no-vault-secret');
      expect(JSON.parse(responseText).error).toContain('SecretVault');
      expect(readFileSync(configPath, 'utf-8')).toBe(before);
      expect(runtimeConfig).toEqual(runtimeBefore);
      expect(validateToolSettingsConfig).not.toHaveBeenCalled();
      expect(onToolSettingsUpdated).not.toHaveBeenCalled();
      expect(onConfigReloaded).not.toHaveBeenCalled();
    }, { validateToolSettingsConfig, onToolSettingsUpdated, onConfigReloaded });
  });

  it('rejects a global WebSearch inline key when SecretVault is unavailable without side effects or leaks', async () => {
    const validateToolSettingsConfig = vi.fn(async () => undefined);
    const onToolSettingsUpdated = vi.fn(async () => undefined);
    const onConfigReloaded = vi.fn(async () => undefined);
    await withApp({ agent: { cwd: '/tmp/agent' }, server: { port: 3200 } }, async ({ baseUrl, configPath, runtimeConfig }) => {
      const before = readFileSync(configPath, 'utf-8');
      const runtimeBefore = structuredClone(runtimeConfig);
      const response = await fetch(`${baseUrl}/api/admin/tool-controls`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ toolControls: {}, webTools: { enabled: true, search: {
          provider: 'zhipu', apiKeyRef: 'existing-main-ref',
          global: { provider: 'tavily', apiKey: 'global-no-vault-secret' },
        } } }),
      });

      expect(response.status).toBe(400);
      const responseText = await response.text();
      expect(responseText).not.toContain('global-no-vault-secret');
      expect(JSON.parse(responseText).error).toContain('SecretVault');
      expect(readFileSync(configPath, 'utf-8')).toBe(before);
      expect(runtimeConfig).toEqual(runtimeBefore);
      expect(validateToolSettingsConfig).not.toHaveBeenCalled();
      expect(onToolSettingsUpdated).not.toHaveBeenCalled();
      expect(onConfigReloaded).not.toHaveBeenCalled();
    }, { validateToolSettingsConfig, onToolSettingsUpdated, onConfigReloaded });
  });

  it('revokes the first WebSearch ref when the global credential put fails', async () => {
    const secretVault = new InMemorySecretVault();
    const originalPut = secretVault.putSecret.bind(secretVault);
    const created: string[] = [];
    let puts = 0;
    vi.spyOn(secretVault, 'putSecret').mockImplementation(async (...args) => {
      puts += 1;
      if (puts === 2) throw new Error('global vault put failed');
      const ref = await originalPut(...args);
      created.push(ref.id);
      return ref;
    });
    await withApp({ agent: { cwd: '/tmp/agent' }, server: { port: 3200 } }, async ({ baseUrl, configPath }) => {
      const before = readFileSync(configPath, 'utf-8');
      const response = await fetch(`${baseUrl}/api/admin/tool-controls`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ toolControls: {}, webTools: { enabled: true, search: {
          provider: 'zhipu', apiKey: 'main-put-secret',
          global: { provider: 'tavily', apiKey: 'global-put-secret' },
        } } }),
      });

      expect(response.status).toBe(400);
      expect(readFileSync(configPath, 'utf-8')).toBe(before);
      expect(created).toHaveLength(1);
      await expect(secretVault.getSecret(created[0]!, {
        actor: 'system', userId: '__system__', scopes: ['secret:web_tools:read'],
      })).rejects.toThrow('secret revoked');
    }, { secretVault });
  });

  it('post-ref validation sees both WebSearch refs and revokes them on failure without leaks', async () => {
    const secretVault = new InMemorySecretVault();
    const created: string[] = [];
    const originalPut = secretVault.putSecret.bind(secretVault);
    vi.spyOn(secretVault, 'putSecret').mockImplementation(async (...args) => {
      const ref = await originalPut(...args);
      created.push(ref.id);
      return ref;
    });
    const validateToolSettingsConfig = vi.fn(async (settings: Pick<ReturnType<typeof parseAppConfig>, 'toolControls' | 'webTools'>) => {
      expect(settings.webTools?.search?.apiKey).toBeUndefined();
      expect(settings.webTools?.search?.global?.apiKey).toBeUndefined();
      expect(settings.webTools?.search?.apiKeyRef).toBe(created[0]);
      expect(settings.webTools?.search?.global?.apiKeyRef).toBe(created[1]);
      throw new Error(`invalid refs ${created.join(' ')} main-validation-secret global-validation-secret`);
    });
    await withApp({ agent: { cwd: '/tmp/agent' }, server: { port: 3200 } }, async ({ baseUrl, configPath }) => {
      const before = readFileSync(configPath, 'utf-8');
      const response = await fetch(`${baseUrl}/api/admin/tool-controls`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ toolControls: {}, webTools: { enabled: true, search: {
          provider: 'zhipu', apiKey: 'main-validation-secret',
          global: { provider: 'tavily', apiKey: 'global-validation-secret' },
        } } }),
      });

      expect(response.status).toBe(400);
      const responseText = await response.text();
      expect(responseText).not.toMatch(/main-validation-secret|global-validation-secret/);
      expect(created).toHaveLength(2);
      for (const ref of created) {
        expect(responseText).not.toContain(ref);
        await expect(secretVault.getSecret(ref, {
          actor: 'system', userId: '__system__', scopes: ['secret:web_tools:read'],
        })).rejects.toThrow('secret revoked');
      }
      expect(readFileSync(configPath, 'utf-8')).toBe(before);
    }, { secretVault, validateToolSettingsConfig });
  });

  it('CAS conflict revokes the staged WebSearch refs', async () => {
    const secretVault = new InMemorySecretVault();
    const originalPut = secretVault.putSecret.bind(secretVault);
    const created: string[] = [];
    vi.spyOn(secretVault, 'putSecret').mockImplementation(async (...args) => {
      const ref = await originalPut(...args);
      created.push(ref.id);
      return ref;
    });
    const validateToolSettingsConfig = vi.fn();
    await withApp(baseRawConfig(), async ({ baseUrl, configPath }) => {
      validateToolSettingsConfig.mockImplementation(async () => {
        writeFileSync(configPath, JSON.stringify({ ...baseRawConfig(), concurrentWinner: true }), 'utf-8');
      });
      const response = await fetch(`${baseUrl}/api/admin/tool-controls`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ toolControls: {}, webTools: { enabled: true, search: {
          provider: 'brave', apiKey: 'cas-loser-secret',
          global: { provider: 'tavily', apiKey: 'cas-global-loser-secret' },
        } } }),
      });

      expect(response.status).toBe(409);
      expect(created).toHaveLength(2);
      for (const ref of created) {
        await expect(secretVault.getSecret(ref, {
          actor: 'system', userId: '__system__', scopes: ['secret:web_tools:read'],
        })).rejects.toThrow('secret revoked');
      }
    }, { secretVault, validateToolSettingsConfig });
  });

  it('runtime apply failure with complete restore revokes WebSearch candidate refs', async () => {
    const secretVault = new InMemorySecretVault();
    const originalPut = secretVault.putSecret.bind(secretVault);
    const created: string[] = [];
    vi.spyOn(secretVault, 'putSecret').mockImplementation(async (...args) => {
      const ref = await originalPut(...args);
      created.push(ref.id);
      return ref;
    });
    const onToolSettingsUpdated = vi.fn(async (settings: Pick<ReturnType<typeof parseAppConfig>, 'toolControls' | 'webTools'>) => {
      if (settings.webTools?.search?.apiKeyRef) {
        throw new Error(`candidate runtime rejected ${settings.webTools.search.apiKeyRef} runtime-rejected-secret`);
      }
    });
    await withApp({ agent: { cwd: '/tmp/agent' }, server: { port: 3200 } }, async ({ baseUrl, configPath }) => {
      const before = readFileSync(configPath, 'utf-8');
      const response = await fetch(`${baseUrl}/api/admin/tool-controls`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ toolControls: {}, webTools: { enabled: true, search: {
          provider: 'brave', apiKey: 'runtime-rejected-secret',
          global: { provider: 'tavily', apiKey: 'global-runtime-rejected-secret' },
        } } }),
      });

      expect(response.status).toBe(500);
      const responseText = await response.text();
      expect(responseText).not.toContain('runtime-rejected-secret');
      expect(responseText).not.toContain(created[0]);
      expect(readFileSync(configPath, 'utf-8')).toBe(before);
      expect(onToolSettingsUpdated).toHaveBeenCalledTimes(2);
      expect(created).toHaveLength(2);
      for (const ref of created) {
        await expect(secretVault.getSecret(ref, {
          actor: 'system', userId: '__system__', scopes: ['secret:web_tools:read'],
        })).rejects.toThrow('secret revoked');
      }
    }, { secretVault, onToolSettingsUpdated });
  });

  it('RuntimeRestoreFailedError conservatively retains WebSearch candidate refs', async () => {
    const secretVault = new InMemorySecretVault();
    const originalPut = secretVault.putSecret.bind(secretVault);
    const created: string[] = [];
    vi.spyOn(secretVault, 'putSecret').mockImplementation(async (...args) => {
      const ref = await originalPut(...args);
      created.push(ref.id);
      return ref;
    });
    const onToolSettingsUpdated = vi.fn().mockRejectedValue(new Error('runtime restore failed'));
    await withApp({ agent: { cwd: '/tmp/agent' }, server: { port: 3200 } }, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/admin/tool-controls`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ toolControls: {}, webTools: { enabled: true, search: {
          provider: 'brave', apiKey: 'retain-web-secret',
          global: { provider: 'tavily', apiKey: 'retain-global-web-secret' },
        } } }),
      });

      expect(response.status).toBe(500);
      expect(onToolSettingsUpdated).toHaveBeenCalledTimes(2);
      expect(created).toHaveLength(2);
      const reader = { actor: 'system' as const, userId: '__system__', scopes: ['secret:web_tools:read'] };
      await expect(secretVault.getSecret(created[0]!, reader)).resolves.toBe('retain-web-secret');
      await expect(secretVault.getSecret(created[1]!, reader)).resolves.toBe('retain-global-web-secret');
      const responseText = JSON.stringify(await readJson(response));
      expect(responseText).not.toMatch(/retain-web-secret|retain-global-web-secret/);
      for (const ref of created) expect(responseText).not.toContain(ref);
    }, { secretVault, onToolSettingsUpdated });
  });

  it('successful WebSearch replacement revokes only old refs no longer referenced', async () => {
    const secretVault = new InMemorySecretVault();
    const seedCaller = { actor: 'system' as const, userId: 'tool_controls_admin', scopes: ['secret:web_tools:write'] };
    const oldMain = await secretVault.putSecret('global', 'web_tools', 'old-main', seedCaller);
    const oldGlobal = await secretVault.putSecret('global', 'web_tools', 'old-global', seedCaller);
    const raw = {
      agent: { cwd: '/tmp/agent' }, server: { port: 3200 },
      webTools: { enabled: true, search: {
        provider: 'zhipu', apiKeyRef: oldMain.id,
        global: { provider: 'tavily', apiKeyRef: oldGlobal.id },
      } },
    };
    await withApp(raw, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/admin/tool-controls`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ toolControls: {}, webTools: { enabled: true, search: {
          provider: 'zhipu', apiKey: 'new-main',
          global: { provider: 'tavily', apiKey: 'new-global' },
        } } }),
      });

      expect(response.status).toBe(200);
      const reader = { actor: 'system' as const, userId: '__system__', scopes: ['secret:web_tools:read'] };
      await expect(secretVault.getSecret(oldMain.id, reader)).rejects.toThrow('secret revoked');
      await expect(secretVault.getSecret(oldGlobal.id, reader)).rejects.toThrow('secret revoked');
    }, { secretVault });
  });

  it('ConfigIdentity failure keeps committed WebSearch ref, reclaims replaced ref, and preserves unchanged ref', async () => {
    const secretVault = new InMemorySecretVault();
    const seedCaller = { actor: 'system' as const, userId: 'tool_controls_admin', scopes: ['secret:web_tools:write'] };
    const oldMain = await secretVault.putSecret('global', 'web_tools', 'old-main', seedCaller);
    const oldGlobal = await secretVault.putSecret('global', 'web_tools', 'old-global', seedCaller);
    const raw = {
      agent: { cwd: '/tmp/agent' }, server: { port: 3200 },
      webTools: { enabled: true, search: {
        provider: 'zhipu', apiKeyRef: oldMain.id,
        global: { provider: 'tavily', apiKeyRef: oldGlobal.id },
      } },
    };
    let committedRef = '';
    const onConfigReloaded = vi.fn(async (text: string) => {
      committedRef = parseAppConfig(JSON.parse(text)).webTools?.search?.global?.apiKeyRef ?? '';
      throw new Error(`publish failed ${committedRef} committed-global-secret`);
    });
    await withApp(raw, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/admin/tool-controls`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ toolControls: {}, webTools: { enabled: true, search: {
          provider: 'zhipu', apiKeyRef: oldMain.id,
          global: { provider: 'tavily', apiKey: 'committed-global-secret' },
        } } }),
      });

      expect(response.status).toBe(500);
      const responseText = await response.text();
      expect(responseText).not.toContain('committed-global-secret');
      expect(responseText).not.toContain(committedRef);
      const reader = { actor: 'system' as const, userId: '__system__', scopes: ['secret:web_tools:read'] };
      await expect(secretVault.getSecret(committedRef, reader)).resolves.toBe('committed-global-secret');
      await expect(secretVault.getSecret(oldGlobal.id, reader)).rejects.toThrow('secret revoked');
      await expect(secretVault.getSecret(oldMain.id, reader)).resolves.toBe('old-main');
      expect(onConfigReloaded).toHaveBeenCalledOnce();
    }, { secretVault, onConfigReloaded });
  });

  it('rejects enabled WebSearch without credentials before writing config.json', async () => {
    await withApp({
      agent: { cwd: '/tmp/agent' },
      server: { port: 3200 },
    }, async ({ baseUrl, configPath }) => {
      const before = readFileSync(configPath, 'utf-8');
      const response = await fetch(`${baseUrl}/api/admin/tool-controls`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          toolControls: { tools: {} },
          webTools: {
            enabled: true,
            search: {
              enabled: true,
              provider: 'brave',
            },
            fetch: {
              enabled: true,
            },
          },
        }),
      });
      expect(response.status).toBe(400);
      const body = await readJson(response);
      expect(body.error).toContain('one of apiKey or apiKeyRef is required');
      expect(readFileSync(configPath, 'utf-8')).toBe(before);
    });
  });

  it('migrates existing main/global inline WebSearch keys when the UI omits global settings', async () => {
    const secretVault = new InMemorySecretVault();
    const raw: any = baseRawConfig();
    raw.webTools.search.global = { provider: 'tavily', apiKey: 'tavily-existing-secret' };
    await withApp(raw, async ({ baseUrl, configPath, runtimeConfig }) => {
      const response = await fetch(`${baseUrl}/api/admin/tool-controls`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          toolControls: {
            tools: {
              Shell: { enabled: false },
            },
          },
          webTools: {
            enabled: true,
            search: {
              enabled: true,
              provider: 'brave',
              hasApiKey: true,
              maxResults: 7,
            },
            fetch: {
              enabled: false,
            },
            egress: {
              allowPrivateNetworks: false,
            },
          },
        }),
      });
      expect(response.status).toBe(200);
      const body = await readJson(response);
      expect(body.effectiveWebTools).toEqual(['WebSearch']);
      expect(body.webTools.search.hasApiKey).toBe(true);
      expect(body.webTools.search.apiKey).toBeUndefined();
      expect(body.webTools.search.apiKeyRef).toEqual(expect.any(String));
      expect(body.webTools.search.global).toMatchObject({ provider: 'tavily', hasApiKey: true });
      expect(body.webTools.search.global.apiKey).toBeUndefined();
      expect(body.webTools.search.global.apiKeyRef).toEqual(expect.any(String));

      const written = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(written.webTools.search.apiKey).toBeUndefined();
      expect(written.webTools.search.apiKeyRef).toBe(body.webTools.search.apiKeyRef);
      expect(written.webTools.search.hasApiKey).toBeUndefined();
      expect(written.webTools.search.global.apiKey).toBeUndefined();
      expect(written.webTools.search.global.apiKeyRef).toBe(body.webTools.search.global.apiKeyRef);
      expect(runtimeConfig.webTools?.search?.apiKey).toBeUndefined();
      expect(runtimeConfig.webTools?.search?.apiKeyRef).toBe(body.webTools.search.apiKeyRef);
      expect(runtimeConfig.webTools?.search?.global?.apiKeyRef).toBe(body.webTools.search.global.apiKeyRef);
      expect(runtimeConfig.webTools?.fetch?.enabled).toBe(false);
      await expect(secretVault.getSecret(body.webTools.search.apiKeyRef, {
        actor: 'system', userId: '__system__', scopes: ['secret:web_tools:read'],
      })).resolves.toBe('brave-secret-123');
      await expect(secretVault.getSecret(body.webTools.search.global.apiKeyRef, {
        actor: 'system', userId: '__system__', scopes: ['secret:web_tools:read'],
      })).resolves.toBe('tavily-existing-secret');
    }, { secretVault });
  });

  it('rejects reusing an existing WebSearch key across provider or endpoint changes', async () => {
    const cases = [
      {
        name: '主源 provider',
        raw: baseRawConfig(),
        search: { enabled: true, provider: 'zhipu', hasApiKey: true },
      },
      {
        name: '主源 endpoint',
        raw: baseRawConfig(),
        search: {
          enabled: true,
          provider: 'brave',
          endpoint: 'https://search.example.com/v2',
          hasApiKey: true,
        },
      },
      {
        name: '主源回传旧 ref',
        raw: (() => {
          const raw: any = baseRawConfig();
          delete raw.webTools.search.apiKey;
          raw.webTools.search.apiKeyRef = 'old-web-search-ref';
          return raw;
        })(),
        search: {
          enabled: true,
          provider: 'zhipu',
          apiKeyRef: 'old-web-search-ref',
        },
      },
      {
        name: '境外源 provider',
        raw: (() => {
          const raw: any = baseRawConfig();
          raw.webTools.search.global = { provider: 'tavily', apiKey: 'global-secret' };
          return raw;
        })(),
        search: {
          enabled: true,
          provider: 'brave',
          hasApiKey: true,
          global: { provider: 'brave', hasApiKey: true },
        },
      },
    ];

    for (const testCase of cases) {
      await withApp(testCase.raw, async ({ baseUrl, configPath }) => {
        const before = readFileSync(configPath, 'utf-8');
        const response = await fetch(`${baseUrl}/api/admin/tool-controls`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            toolControls: { tools: {} },
            webTools: {
              enabled: true,
              search: testCase.search,
              fetch: { enabled: true },
              egress: { allowPrivateNetworks: false },
            },
          }),
        });
        expect(response.status, testCase.name).toBe(400);
        expect((await readJson(response)).error).toContain('必须重新提供 API Key');
        expect(readFileSync(configPath, 'utf-8')).toBe(before);
      });
    }
  });

  it('redacts a submitted WebSearch ref from validation errors', async () => {
    const submittedRef = 'submitted-web-search-ref';
    const validateToolSettingsConfig = vi.fn(async (settings: Pick<ReturnType<typeof parseAppConfig>, 'toolControls' | 'webTools'>) => {
      throw new Error(`failed to resolve ${settings.webTools?.search?.apiKeyRef}`);
    });
    await withApp(baseRawConfig(), async ({ baseUrl, configPath }) => {
      const before = readFileSync(configPath, 'utf-8');
      const response = await fetch(`${baseUrl}/api/admin/tool-controls`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          toolControls: { tools: {} },
          webTools: {
            enabled: true,
            search: { enabled: true, provider: 'brave', apiKeyRef: submittedRef },
            fetch: { enabled: true },
          },
        }),
      });
      expect(response.status).toBe(400);
      const responseText = await response.text();
      expect(responseText).toContain('[REDACTED]');
      expect(responseText).not.toContain(submittedRef);
      expect(readFileSync(configPath, 'utf-8')).toBe(before);
    }, { validateToolSettingsConfig });
  });

  it('allows an explicit null global search config to remove and revoke its credential', async () => {
    const secretVault = new InMemorySecretVault();
    const caller = { actor: 'system' as const, userId: 'tool_controls_admin', scopes: ['secret:web_tools:write'] };
    const reader = { actor: 'system' as const, userId: '__system__', scopes: ['secret:web_tools:read'] };
    const main = await secretVault.putSecret('global', 'web_tools', 'main-secret', caller);
    const global = await secretVault.putSecret('global', 'web_tools', 'global-secret', caller);
    const raw: any = baseRawConfig();
    delete raw.webTools.search.apiKey;
    raw.webTools.search.apiKeyRef = main.id;
    raw.webTools.search.global = { provider: 'tavily', apiKeyRef: global.id };

    await withApp(raw, async ({ baseUrl, configPath }) => {
      const response = await fetch(`${baseUrl}/api/admin/tool-controls`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          toolControls: { tools: {} },
          webTools: {
            enabled: true,
            search: { enabled: true, provider: 'brave', hasApiKey: true, global: null },
            fetch: { enabled: true },
            egress: { allowPrivateNetworks: false },
          },
        }),
      });
      expect(response.status).toBe(200);
      expect((await readJson(response)).webTools.search.global).toBeUndefined();
      const written = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(written.webTools.search.apiKeyRef).toBe(main.id);
      expect(written.webTools.search.global).toBeUndefined();
      await expect(secretVault.getSecret(main.id, reader)).resolves.toBe('main-secret');
      await expect(secretVault.getSecret(global.id, reader)).rejects.toThrow('secret revoked');
    }, { secretVault });
  });

});

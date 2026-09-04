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

describe('tool controls admin router', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('AGENT_SAAS_ALLOW_UNIDENTIFIED_ENVIRONMENT', '1');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    while (servers.length > 0) servers.pop()?.close();
  });

  it('returns all builtin tool switches without leaking inline WebSearch apiKey', async () => {
    await withApp(baseRawConfig(), async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/admin/tool-controls`);
      expect(response.status).toBe(200);
      const body = await readJson(response);
      expect(body.tools.map((tool: { id: string }) => tool.id)).toEqual(expect.arrayContaining([
        'WaitForWorkspaceReady',
        'Read',
        'Write',
        'Edit',
        'Artifact',
        'Shell',
        'MemorySearch',
        'MemoryList',
        'UserActivityList',
        'CompanyInfo',
        'Skill',
        'TodoWrite',
        'AskUserQuestion',
        'SessionContext',
        'WebSearch',
        'WebFetch',
        'GenerateImage',
        'CronManage',
      ]));
      expect(body.tools.map((tool: { id: string }) => tool.id)).not.toEqual(expect.arrayContaining(['List', 'Glob', 'Grep', 'BashOutput', 'KillBash', 'CronList', 'ReadCompanyInfo', 'UpdateCompanyInfo', 'SessionGetEvents', 'SessionSearchEvents', 'SessionGetToolTrace']));
      expect(body.toolControls.tools?.Grep).toBeUndefined();
      expect(body.tools.find((tool: { id: string }) => tool.id === 'Shell').enabled).toBe(false);
      expect(body.tools.find((tool: { id: string }) => tool.id === 'Read').enabled).toBe(true);
      // 新增字段：description / effectiveDescription / inputSchema / risk / approvalMode /
      // auditCategory / category / label / sourceModule 都要出现在 catalog 视图里。
      const read = body.tools.find((tool: { id: string }) => tool.id === 'Read');
      expect(read).toMatchObject({
        displayName: expect.any(String),
        description: expect.stringContaining('工作区'),
        effectiveDescription: expect.stringContaining('工作区'),
        risk: 'safe',
        approvalMode: 'never',
        auditCategory: 'filesystem.read',
        category: 'workspace',
        label: expect.any(String),
        sourceModule: expect.stringContaining('toolRuntime.ts'),
      });
      expect(read.inputSchema).toBeDefined();
      expect(read.inputSchema.type).toBe('object');
      expect(read.inputSchema.properties).toBeDefined();
      // Shell 是 dangerous 且 approvalMode='web'，UI 靠这两个字段渲染警示。
      const shell = body.tools.find((tool: { id: string }) => tool.id === 'Shell');
      expect(shell).toMatchObject({ risk: 'dangerous', approvalMode: 'web' });
      expect(body.effectiveWebTools).toEqual(['WebSearch', 'WebFetch']);
      expect(body.webTools.search).toMatchObject({
        provider: 'brave',
        hasApiKey: true,
        maxResults: 5,
      });
      expect(body.webTools.search.apiKey).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain('brave-secret-123');
    });
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

  it('updates tool switches and web tools in one config write', async () => {
    const validateToolSettingsConfig = vi.fn(async () => undefined);
    const onToolSettingsUpdated = vi.fn(async () => undefined);
    const onConfigReloaded = vi.fn(async () => undefined);
    await withApp({
      agent: { cwd: '/tmp/agent' },
      server: { port: 3200 },
    }, async ({ baseUrl, configPath, runtimeConfig }) => {
      const response = await fetch(`${baseUrl}/api/admin/tool-controls`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          toolControls: {
            tools: {
              Shell: { enabled: false },
              WebFetch: { enabled: false },
            },
          },
          webTools: {
            enabled: true,
            search: {
              enabled: true,
              provider: 'brave',
              apiKeyRef: 'brave-search-api-key',
              maxResults: 3,
            },
            fetch: {
              enabled: true,
              maxChars: 12000,
            },
            egress: {
              allowPrivateNetworks: false,
              blockedHosts: ['169.254.169.254'],
            },
          },
        }),
      });
      expect(response.status).toBe(200);
      const body = await readJson(response);
      expect(body.tools.find((tool: { id: string }) => tool.id === 'Shell').enabled).toBe(false);
      expect(body.tools.find((tool: { id: string }) => tool.id === 'WebFetch').enabled).toBe(false);
      expect(body.effectiveWebTools).toEqual(['WebSearch']);
      expect(validateToolSettingsConfig).toHaveBeenCalledWith({
        toolControls: runtimeConfig.toolControls,
        webTools: runtimeConfig.webTools,
      });
      expect(onToolSettingsUpdated).toHaveBeenCalledWith({
        toolControls: runtimeConfig.toolControls,
        webTools: runtimeConfig.webTools,
      });

      const writtenText = readFileSync(configPath, 'utf-8');
      const written = JSON.parse(writtenText);
      expect(written.toolControls.tools.Shell.enabled).toBe(false);
      expect(written.toolControls.tools.WebFetch.enabled).toBe(false);
      expect(written.webTools.search.apiKeyRef).toBe('brave-search-api-key');
      expect(written.webTools.search.apiKey).toBeUndefined();
      expect(onConfigReloaded).toHaveBeenCalledWith(writtenText);
    }, { validateToolSettingsConfig, onToolSettingsUpdated, onConfigReloaded });
  });

  it('stores a newly submitted WebSearch apiKey in the secret vault and persists only its ref', async () => {
    const secretVault = new InMemorySecretVault();
    await withApp({
      agent: { cwd: '/tmp/agent' },
      server: { port: 3200 },
    }, async ({ baseUrl, configPath, runtimeConfig }) => {
      const response = await fetch(`${baseUrl}/api/admin/tool-controls`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          toolControls: { tools: {} },
          webTools: {
            enabled: true,
            search: {
              enabled: true,
              provider: 'tencent_wsa',
              apiKey: 'tencent-wsa-secret',
              maxResults: 5,
            },
          },
        }),
      });

      expect(response.status).toBe(200);
      const body = await readJson(response);
      expect(body.webTools.search.hasApiKey).toBe(true);
      expect(body.webTools.search.apiKey).toBeUndefined();
      expect(body.webTools.search.apiKeyRef).toEqual(expect.any(String));

      const written = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(written.webTools.search.apiKey).toBeUndefined();
      expect(written.webTools.search.apiKeyRef).toBe(body.webTools.search.apiKeyRef);
      expect(runtimeConfig.webTools?.search?.apiKey).toBeUndefined();
      expect(runtimeConfig.webTools?.search?.apiKeyRef).toBe(body.webTools.search.apiKeyRef);
      await expect(secretVault.getSecret(body.webTools.search.apiKeyRef, {
        actor: 'system',
        userId: '__system__',
        scopes: ['secret:web_tools:read'],
      })).resolves.toBe('tencent-wsa-secret');
    }, { secretVault });
  });

  /**
   * 回归：2026-08-16 首次配置境外源时，主源 key 正确入库，但 search.global.apiKey
   * 以明文落进了生产 config.json，并被管理 API 原样回显。
   */
  it('stores the global (overseas) WebSearch apiKey in the vault too', async () => {
    const secretVault = new InMemorySecretVault();
    await withApp({
      agent: { cwd: '/tmp/agent' },
      server: { port: 3200 },
    }, async ({ baseUrl, configPath, runtimeConfig }) => {
      const response = await fetch(`${baseUrl}/api/admin/tool-controls`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          toolControls: { tools: {} },
          webTools: {
            enabled: true,
            search: {
              enabled: true,
              provider: 'zhipu',
              apiKey: 'zhipu-secret',
              searchEngine: 'search_std',
              global: { provider: 'tavily', apiKey: 'tavily-secret' },
            },
          },
        }),
      });

      expect(response.status, await response.clone().text()).toBe(200);
      const body = await readJson(response);
      const globalRef = body.webTools.search.global.apiKeyRef;
      expect(body.webTools.search.global.apiKey).toBeUndefined();
      expect(globalRef).toEqual(expect.any(String));
      expect(globalRef).not.toBe(body.webTools.search.apiKeyRef);

      const written = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(written.webTools.search.global.apiKey).toBeUndefined();
      expect(written.webTools.search.global.apiKeyRef).toBe(globalRef);
      expect(runtimeConfig.webTools?.search?.global?.apiKey).toBeUndefined();
      expect(runtimeConfig.webTools?.search?.global?.apiKeyRef).toBe(globalRef);
      await expect(secretVault.getSecret(globalRef, {
        actor: 'system',
        userId: '__system__',
        scopes: ['secret:web_tools:read'],
      })).resolves.toBe('tavily-secret');
    }, { secretVault });
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

  it('persists descriptionOverride via bulk PUT and reflects it in effectiveDescription', async () => {
    await withApp({
      agent: { cwd: '/tmp/agent' },
      server: { port: 3200 },
    }, async ({ baseUrl, configPath, runtimeConfig }) => {
      const response = await fetch(`${baseUrl}/api/admin/tool-controls`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          toolControls: {
            tools: {
              Shell: {
                descriptionOverride: {
                  mode: 'append',
                  text: '本平台补充说明：任何 rm 前必须先给完整清单等待用户点头。',
                },
              },
            },
          },
          webTools: null,
        }),
      });
      expect(response.status).toBe(200);
      const body = await readJson(response);
      const shell = body.tools.find((tool: { id: string }) => tool.id === 'Shell');
      expect(shell.descriptionOverride).toEqual({
        mode: 'append',
        text: '本平台补充说明：任何 rm 前必须先给完整清单等待用户点头。',
      });
      expect(shell.description).not.toContain('rm 前必须先给完整清单');
      expect(shell.effectiveDescription).toContain('rm 前必须先给完整清单');
      expect(shell.effectiveDescription.startsWith(shell.description)).toBe(true);

      const written = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(written.toolControls.tools.Shell.descriptionOverride).toEqual({
        mode: 'append',
        text: '本平台补充说明：任何 rm 前必须先给完整清单等待用户点头。',
      });
      expect(runtimeConfig.toolControls?.tools?.Shell?.descriptionOverride?.mode).toBe('append');
    });
  });

  // 2026-07-25：descriptionOverride 是运行时热更的，CI 的 drift guard 守不到它。
  // 这组用例守的是「后台改坏描述会被当场拒绝」——没有这道闸门，管理员用
  // mode:'replace' 抹掉 Read 的字节上限或 Shell 的 rg 优先级，模型会按错误契约行动。
  describe('descriptionInvariants 保存闸门', () => {
    it('replace 抹掉运行时契约片段时拒绝保存并指出缺了什么', async () => {
      await withApp(baseRawConfig(), async ({ baseUrl, configPath, runtimeConfig }) => {
        const response = await fetch(`${baseUrl}/api/admin/tool-controls/Read`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            descriptionOverride: { mode: 'replace', text: '读文件。' },
          }),
        });
        expect(response.status).toBe(400);
        const body = await readJson(response);
        expect(body.error).toContain('Read');
        expect(body.error).toContain('131072');

        // 拒绝必须是原子的：不落盘、不热更
        const written = JSON.parse(readFileSync(configPath, 'utf-8'));
        expect(written.toolControls?.tools?.Read).toBeUndefined();
        expect(runtimeConfig.toolControls?.tools?.Read).toBeUndefined();
      });
    });

    it('replace 保留全部片段时正常保存', async () => {
      await withApp(baseRawConfig(), async ({ baseUrl, runtimeConfig }) => {
        const text = '读取工作区 UTF-8 文本文件，支持 Unicode 路径；超过 131072 字节时返回前 131072 字节，'
          + '可用 offset/limit 读取指定行区间，limit 最多 2000 行；超长单行建议 sed | head。';
        const response = await fetch(`${baseUrl}/api/admin/tool-controls/Read`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ descriptionOverride: { mode: 'replace', text } }),
        });
        expect(response.status).toBe(200);
        expect(runtimeConfig.toolControls?.tools?.Read?.descriptionOverride?.mode).toBe('replace');
      });
    });

    it('append 不会触发闸门（原描述整体保留）', async () => {
      await withApp(baseRawConfig(), async ({ baseUrl }) => {
        const response = await fetch(`${baseUrl}/api/admin/tool-controls/Read`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            descriptionOverride: { mode: 'append', text: '本组织仅允许读取 docs/ 下的文件。' },
          }),
        });
        expect(response.status).toBe(200);
      });
    });

    it('未声明 invariants 的工具不受影响', async () => {
      await withApp(baseRawConfig(), async ({ baseUrl }) => {
        const response = await fetch(`${baseUrl}/api/admin/tool-controls/WaitForWorkspaceReady`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            descriptionOverride: { mode: 'replace', text: '检查工作区是否已经就绪。' },
          }),
        });
        expect(response.status).toBe(200);
      });
    });
  });

  it('single-tool PUT can set / clear descriptionOverride without touching other tools', async () => {
    await withApp(baseRawConfig(), async ({ baseUrl, configPath, runtimeConfig }) => {
      // 1) 设置 override
      const setRes = await fetch(`${baseUrl}/api/admin/tool-controls/Write`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          descriptionOverride: { mode: 'replace', text: '仅用于生成客户交付文档；写入采用原子提交、同路径串行、fsync 与 rename。' },
        }),
      });
      expect(setRes.status).toBe(200);
      const setBody = await readJson(setRes);
      const write = setBody.tools.find((tool: { id: string }) => tool.id === 'Write');
      expect(write.descriptionOverride).toEqual({ mode: 'replace', text: '仅用于生成客户交付文档；写入采用原子提交、同路径串行、fsync 与 rename。' });
      // replace 模式：effective == override text
      expect(write.effectiveDescription).toBe('仅用于生成客户交付文档；写入采用原子提交、同路径串行、fsync 与 rename。');
      // Shell 原本 enabled=false 保持不变，未被单工具 PUT 波及
      const shellAfterSet = setBody.tools.find((tool: { id: string }) => tool.id === 'Shell');
      expect(shellAfterSet.enabled).toBe(false);

      // 2) 清除 override
      const clearRes = await fetch(`${baseUrl}/api/admin/tool-controls/Write`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ descriptionOverride: null }),
      });
      expect(clearRes.status).toBe(200);
      const clearBody = await readJson(clearRes);
      const writeAfterClear = clearBody.tools.find((tool: { id: string }) => tool.id === 'Write');
      expect(writeAfterClear.descriptionOverride).toBeUndefined();
      expect(writeAfterClear.effectiveDescription).toBe(writeAfterClear.description);
      // config.json 里 Write 的 tools 条目应该被完全删除（无 enabled + 无 override）
      const written = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(written.toolControls.tools?.Write).toBeUndefined();
      expect(written.toolControls.tools?.Grep).toBeUndefined();
      expect(written.toolControls.tools?.Shell?.enabled).toBe(false);
      expect(runtimeConfig.toolControls?.tools?.Write?.descriptionOverride).toBeUndefined();
    });
  });

  it('保留 replace descriptionOverride 到服务重启后的新配置实例', async () => {
    await withApp(baseRawConfig(), async ({ baseUrl, processCwd }) => {
      const override = { mode: 'replace' as const, text: '仅用于生成客户交付文档；写入采用原子提交、同路径串行、fsync 与 rename。' };
      const saveResponse = await fetch(`${baseUrl}/api/admin/tool-controls/Write`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ descriptionOverride: override }),
      });
      expect(saveResponse.status).toBe(200);

      // 模拟服务进程重启：必须从刚刚写入的 config.json 创建全新的 AppConfig，
      // 而不是复用保存请求所在进程的内存对象。
      const restartedConfig = loadAppConfig(processCwd);
      expect(restartedConfig.toolControls?.tools?.Write?.descriptionOverride).toEqual(override);

      const restartedApp = express();
      restartedApp.use((req, _res, next) => {
        (req as any).user = { sub: 'admin', username: 'admin', role: 'admin', tenantId: DEFAULT_TENANT_ID };
        next();
      });
      restartedApp.use('/api/admin/tool-controls', createToolControlsAdminRouter({
        processCwd,
        config: restartedConfig,
      }));
      const restartedServer = restartedApp.listen(0);
      servers.push(restartedServer);
      const address = restartedServer.address();
      if (!address || typeof address === 'string') throw new Error('failed to bind restarted test server');

      const restartResponse = await fetch(`http://127.0.0.1:${address.port}/api/admin/tool-controls`);
      expect(restartResponse.status).toBe(200);
      const restartBody = await readJson(restartResponse);
      const write = restartBody.tools.find((tool: { id: string }) => tool.id === 'Write');
      expect(write.descriptionOverride).toEqual(override);
      expect(write.effectiveDescription).toBe(override.text);
    });
  });

  it('single-tool PUT 以磁盘快照合并，避免旧进程覆盖其他已保存的 descriptionOverride', async () => {
    const diskConfig = baseRawConfig();
    const existingOverride = { mode: 'replace' as const, text: '仅用于生成客户交付文档；写入采用原子提交、同路径串行、fsync 与 rename。' };
    (diskConfig.toolControls.tools as Record<string, { enabled?: boolean; descriptionOverride?: typeof existingOverride }>).Write = {
      descriptionOverride: existingOverride,
    };
    const staleRuntimeConfig = parseAppConfig(baseRawConfig());

    await withApp(diskConfig, async ({ baseUrl, processCwd }) => {
      const response = await fetch(`${baseUrl}/api/admin/tool-controls/TodoWrite`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          descriptionOverride: { mode: 'append', text: '用于提交任务进度。' },
        }),
      });
      expect(response.status).toBe(200);

      const persisted = loadAppConfig(processCwd);
      expect(persisted.toolControls?.tools?.Write?.descriptionOverride).toEqual(existingOverride);
      expect(persisted.toolControls?.tools?.TodoWrite?.descriptionOverride).toEqual({
        mode: 'append',
        text: '用于提交任务进度。',
      });
    }, { config: staleRuntimeConfig });
  });

  it('连续两次保存均返回 raw config revision，并支持 expectedRevision/If-Match 接力', async () => {
    await withApp(baseRawConfig(), async ({ baseUrl, configPath }) => {
      const loadedResponse = await fetch(`${baseUrl}/api/admin/tool-controls`); const loaded = await readJson(loadedResponse);
      expect(loaded.revision).toBe(revision(readFileSync(configPath, 'utf-8')));
      expect(loadedResponse.headers.get('etag')).toBe(`"${loaded.revision}"`);

      const normalizedResponse = await fetch(`${baseUrl}/api/admin/tool-controls/Shell`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false, expectedRevision: loaded.revision }) });
      expect(normalizedResponse.status).toBe(200); const normalized = await readJson(normalizedResponse); const normalizedText = readFileSync(configPath, 'utf-8');
      expect(normalized.revision).toBe(revision(normalizedText));

      const noOpResponse = await fetch(`${baseUrl}/api/admin/tool-controls/Shell`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false, expectedRevision: normalized.revision }) });
      expect(noOpResponse.status).toBe(200); const noOp = await readJson(noOpResponse);
      expect(noOp.revision).toBe(normalized.revision); expect(noOpResponse.headers.get('etag')).toBe(`"${normalized.revision}"`);
      expect(readFileSync(configPath, 'utf-8')).toBe(normalizedText);
      const firstResponse = await fetch(`${baseUrl}/api/admin/tool-controls/Read`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false, expectedRevision: noOp.revision }),
      });
      expect(firstResponse.status).toBe(200);
      const first = await readJson(firstResponse);
      expect(first.revision).toBe(revision(readFileSync(configPath, 'utf-8')));
      expect(firstResponse.headers.get('etag')).toBe(`"${first.revision}"`);

      const secondResponse = await fetch(`${baseUrl}/api/admin/tool-controls/Edit`, {
        method: 'PUT', headers: { 'content-type': 'application/json', 'if-match': `"${first.revision}"` }, body: JSON.stringify({ enabled: false }),
      });
      expect(secondResponse.status).toBe(200);
      const second = await readJson(secondResponse);
      expect(second.revision).toBe(revision(readFileSync(configPath, 'utf-8')));
      expect(secondResponse.headers.get('etag')).toBe(`"${second.revision}"`);
      expect(second.revision).not.toBe(first.revision);
    }, { requireRevision: true });
  });

  it('single-tool PUT can flip enabled without editing webTools payload', async () => {
    await withApp(baseRawConfig(), async ({ baseUrl, configPath, runtimeConfig }) => {
      const res = await fetch(`${baseUrl}/api/admin/tool-controls/Edit`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      });
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.tools.find((tool: { id: string }) => tool.id === 'Edit').enabled).toBe(false);
      // webTools 保持原状
      expect(body.webTools.search).toMatchObject({ provider: 'brave', hasApiKey: true });
      expect(runtimeConfig.toolControls?.tools?.Edit?.enabled).toBe(false);
      const written = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(written.toolControls.tools.Edit.enabled).toBe(false);
      expect(written.toolControls.tools.Grep).toBeUndefined();
      // 原有的 Shell 关闭仍在
      expect(written.toolControls.tools.Shell.enabled).toBe(false);
    });
  });

  it('migrates legacy CreateArtifact disabled state to Artifact when saving settings', async () => {
    await withApp(baseRawConfig(), async ({ baseUrl, configPath }) => {
      const response = await fetch(`${baseUrl}/api/admin/tool-controls`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          toolControls: { tools: {
            Artifact: { enabled: true, descriptionOverride: { mode: 'append', text: 'keep me' } },
            CreateArtifact: { enabled: false },
          } },
          webTools: null,
        }),
      });
      expect(response.status).toBe(200);
      const body = await readJson(response);
      expect(body.tools.find((tool: { id: string }) => tool.id === 'Artifact').enabled).toBe(false);
      const written = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(written.toolControls.tools.Artifact.enabled).toBe(false);
      expect(written.toolControls.tools.Artifact.descriptionOverride).toEqual({ mode: 'append', text: 'keep me' });
      expect(written.toolControls.tools.CreateArtifact).toBeUndefined();
    });
  });

  it('single-tool PUT 404s on a retired toolId without touching config.json', async () => {
    await withApp(baseRawConfig(), async ({ baseUrl, configPath }) => {
      const before = readFileSync(configPath, 'utf-8');
      const res = await fetch(`${baseUrl}/api/admin/tool-controls/Grep`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      });
      expect(res.status).toBe(404);
      expect(readFileSync(configPath, 'utf-8')).toBe(before);
    });
  });

  it('removes toolControls and webTools when the UI sends null payloads', async () => {
    await withApp(baseRawConfig(), async ({ baseUrl, configPath, runtimeConfig }) => {
      const response = await fetch(`${baseUrl}/api/admin/tool-controls`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          toolControls: null,
          webTools: null,
        }),
      });
      expect(response.status).toBe(200);
      const body = await readJson(response);
      expect(body.toolControls).toBeNull();
      expect(body.webTools).toBeNull();
      expect(body.effectiveWebTools).toEqual([]);
      expect(runtimeConfig.toolControls).toBeUndefined();
      expect(runtimeConfig.webTools).toBeUndefined();
      const written = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(written.toolControls).toBeUndefined();
      expect(written.webTools).toBeUndefined();
    });
  });

  it('CAS 冲突不推进 ConfigIdentity，且不覆盖并发胜出版本', async () => {
    const validateToolSettingsConfig = vi.fn();
    const onToolSettingsUpdated = vi.fn();
    const onConfigReloaded = vi.fn();
    await withApp(baseRawConfig(), async ({ baseUrl, configPath, runtimeConfig }) => {
      validateToolSettingsConfig.mockImplementation(async () => {
        writeFileSync(configPath, JSON.stringify({ ...baseRawConfig(), concurrentWinner: true }), 'utf-8');
      });

      const response = await fetch(`${baseUrl}/api/admin/tool-controls/Read`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      });

      expect(response.status).toBe(409);
      const winnerText = readFileSync(configPath, 'utf-8'); const conflict = await readJson(response);
      expect(JSON.parse(winnerText).concurrentWinner).toBe(true);
      expect(conflict.revision).toBe(revision(winnerText));
      expect(response.headers.get('etag')).toBe(`"${conflict.revision}"`);
      expect(runtimeConfig.toolControls?.tools?.Read).toBeUndefined();
      expect(onToolSettingsUpdated).not.toHaveBeenCalled();
      expect(onConfigReloaded).not.toHaveBeenCalled();
    }, { validateToolSettingsConfig, onToolSettingsUpdated, onConfigReloaded });
  });

  it('single-tool callback 失败时回滚执行侧且不提交磁盘或 AppConfig', async () => {
    const onToolSettingsUpdated = vi.fn();
    await withApp(baseRawConfig(), async ({ baseUrl, configPath, runtimeConfig }) => {
      const before = readFileSync(configPath, 'utf-8');
      let executionSettings = {
        toolControls: structuredClone(runtimeConfig.toolControls),
        webTools: structuredClone(runtimeConfig.webTools),
      };
      onToolSettingsUpdated.mockImplementation(async (next) => {
        executionSettings = structuredClone(next);
        if (next.toolControls?.tools?.Read?.enabled === false) {
          throw new Error('tool runtime callback failed');
        }
      });

      const response = await fetch(`${baseUrl}/api/admin/tool-controls/Read`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      });

      expect(response.status).toBe(500);
      expect(readFileSync(configPath, 'utf-8')).toBe(before);
      expect(runtimeConfig.toolControls?.tools?.Read).toBeUndefined();
      expect(executionSettings.toolControls?.tools?.Read).toBeUndefined();
      expect(onToolSettingsUpdated).toHaveBeenCalledTimes(2);
    }, { onToolSettingsUpdated });
  });

  it('两个管理员交错保存时锁内 callback 未完成前拒绝另一写入', async () => {
    const onToolSettingsUpdated = vi.fn();
    await withApp(baseRawConfig(), async ({ baseUrl, configPath, runtimeConfig }) => {
      const firstBlocked = deferred();
      const firstEntered = deferred();
      onToolSettingsUpdated.mockImplementation(async (next) => {
        if (next.toolControls?.tools?.Read?.enabled === false) {
          firstEntered.resolve();
          await firstBlocked.promise;
        }
      });

      const firstRequest = fetch(`${baseUrl}/api/admin/tool-controls/Read`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      });
      await firstEntered.promise;
      const secondResponse = await fetch(`${baseUrl}/api/admin/tool-controls/Edit`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      });
      expect(secondResponse.status).toBe(409);

      firstBlocked.resolve();
      expect((await firstRequest).status).toBe(200);
      const written = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(written.toolControls.tools.Read.enabled).toBe(false);
      expect(written.toolControls.tools.Edit).toBeUndefined();
      expect(runtimeConfig.toolControls?.tools?.Read?.enabled).toBe(false);
      expect(runtimeConfig.toolControls?.tools?.Edit).toBeUndefined();
    }, { onToolSettingsUpdated });
  });
});

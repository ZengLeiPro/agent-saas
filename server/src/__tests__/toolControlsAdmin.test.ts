import express from 'express';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseAppConfig } from '../app/config.js';
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
  fn: (args: { baseUrl: string; configPath: string; runtimeConfig: ReturnType<typeof parseAppConfig> }) => Promise<T>,
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
  return fn({ baseUrl: `http://127.0.0.1:${address.port}`, configPath, runtimeConfig });
}

async function readJson(response: Response) {
  return response.json() as Promise<any>;
}

describe('tool controls admin router', () => {
  afterEach(() => {
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
        'List',
        'Edit',
        'Glob',
        'Grep',
        'CreateArtifact',
        'Shell',
        'MemorySearch',
        'MemoryList',
        'Skill',
        'TodoWrite',
        'AskUserQuestion',
        'SessionGetEvents',
        'SessionSearchEvents',
        'SessionGetToolTrace',
        'WebSearch',
        'WebFetch',
        'GenerateImage',
      ]));
      expect(body.tools.find((tool: { id: string }) => tool.id === 'Shell').enabled).toBe(false);
      expect(body.tools.find((tool: { id: string }) => tool.id === 'Read').enabled).toBe(true);
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

  it('updates tool switches and web tools in one config write', async () => {
    const validateToolSettingsConfig = vi.fn(async () => undefined);
    const onToolSettingsUpdated = vi.fn(async () => undefined);
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

      const written = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(written.toolControls.tools.Shell.enabled).toBe(false);
      expect(written.toolControls.tools.WebFetch.enabled).toBe(false);
      expect(written.webTools.search.apiKeyRef).toBe('brave-search-api-key');
      expect(written.webTools.search.apiKey).toBeUndefined();
    }, { validateToolSettingsConfig, onToolSettingsUpdated });
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
      await expect(secretVault.getSecret(body.webTools.search.apiKeyRef, { actor: 'system' }))
        .resolves.toBe('tencent-wsa-secret');
    }, { secretVault });
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

  it('preserves existing inline WebSearch apiKey when the UI sends only hasApiKey', async () => {
    await withApp(baseRawConfig(), async ({ baseUrl, configPath, runtimeConfig }) => {
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

      const written = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(written.webTools.search.apiKey).toBe('brave-secret-123');
      expect(written.webTools.search.hasApiKey).toBeUndefined();
      expect(runtimeConfig.webTools?.search?.apiKey).toBe('brave-secret-123');
      expect(runtimeConfig.webTools?.fetch?.enabled).toBe(false);
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
});

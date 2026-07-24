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
        'Edit',
        'CreateArtifact',
        'Shell',
        'MemorySearch',
        'MemoryList',
        'UserActivityList',
        'ReadCompanyInfo',
        'UpdateCompanyInfo',
        'Skill',
        'TodoWrite',
        'AskUserQuestion',
        'SessionGetEvents',
        'SessionSearchEvents',
        'SessionGetToolTrace',
        'WebSearch',
        'WebFetch',
        'GenerateImage',
        'CronList',
        'CronManage',
      ]));
      expect(body.tools.map((tool: { id: string }) => tool.id)).not.toEqual(expect.arrayContaining(['List', 'Glob', 'Grep']));
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

  it('single-tool PUT can set / clear descriptionOverride without touching other tools', async () => {
    await withApp(baseRawConfig(), async ({ baseUrl, configPath, runtimeConfig }) => {
      // 1) 设置 override
      const setRes = await fetch(`${baseUrl}/api/admin/tool-controls/Write`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          descriptionOverride: { mode: 'replace', text: '仅用于生成客户交付文档。' },
        }),
      });
      expect(setRes.status).toBe(200);
      const setBody = await readJson(setRes);
      const write = setBody.tools.find((tool: { id: string }) => tool.id === 'Write');
      expect(write.descriptionOverride).toEqual({ mode: 'replace', text: '仅用于生成客户交付文档。' });
      // replace 模式：effective == override text
      expect(write.effectiveDescription).toBe('仅用于生成客户交付文档。');
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
});

import { createHash } from 'node:crypto';
import express from 'express';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TITLE_SYSTEM_PROMPT } from '../agent/titleGenerator.js';
import { parseAppConfig } from '../app/config.js';
import { createModelsAdminRouter } from '../routes/modelsAdmin.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import { GLOBAL_OWNER_ID, InMemorySecretVault } from '../security/secretVault.js';
import { resolveModelsConfig } from '../app/runtimeGovernanceCredentials.js';

const servers: Array<{ close: () => void }> = [];

function baseRawConfig() {
  return {
    agent: { cwd: '/tmp/agent' },
    server: { port: 3200 },
    models: {
      default: 'main/gpt',
      allowCrossGroupSwitch: false,
      groups: [{
        id: 'main',
        name: 'Main',
        apiKey: 'sk-main',
        baseUrl: 'https://llm.example.invalid/v1',
        models: [{ id: 'gpt', name: 'GPT', value: 'gpt-5' }],
      }],
    },
    memory: {
      enabled: true,
      injectContext: { enabled: true, maxLines: 120 },
      index: {
        enabled: false,
        dbDir: 'data/memory-index',
        embedding: {
          baseUrl: 'https://old-embedding.example.invalid',
          apiKey: 'old-embedding-key',
          model: 'old-embedding-model',
          dimensions: 1024,
        },
        chunking: { tokens: 200, overlap: 40 },
        search: { vectorWeight: 0.7, textWeight: 0.3, maxResults: 10, minScore: 0.3 },
        temporalDecay: { enabled: false, halfLifeDays: 30 },
        sync: { debounceMs: 1500 },
      },
    },
  };
}

function makeWorkspace(rawConfig: ReturnType<typeof baseRawConfig> | Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), 'models-admin-'));
  const processCwd = join(root, 'server');
  mkdirSync(processCwd, { recursive: true });
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify(rawConfig, null, 2), 'utf-8');
  return { processCwd, configPath };
}

async function withApp<T>(
  rawConfig: ReturnType<typeof baseRawConfig> | Record<string, unknown>,
  fn: (args: { baseUrl: string; configPath: string; runtimeConfig: ReturnType<typeof parseAppConfig> }) => Promise<T>,
  opts: Partial<Parameters<typeof createModelsAdminRouter>[0]> = {},
): Promise<T> {
  const { processCwd, configPath } = makeWorkspace(rawConfig);
  const runtimeConfig = parseAppConfig(rawConfig);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { sub: 'admin', username: 'admin', role: 'admin', tenantId: DEFAULT_TENANT_ID };
    next();
  });
  app.use('/api/admin/models', createModelsAdminRouter({
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

function revision(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

async function installModelApiKeyRef(
  rawConfig: ReturnType<typeof baseRawConfig>,
  secretVault: InMemorySecretVault,
  apiKey: string,
): Promise<string> {
  const secret = await secretVault.putSecret(
    GLOBAL_OWNER_ID,
    'models',
    apiKey,
    { actor: 'system', userId: 'models_config_admin', scopes: ['secret:models:write'] },
  );
  const group = rawConfig.models.groups[0] as { apiKey?: string; apiKeyRef?: string };
  delete group.apiKey;
  group.apiKeyRef = secret.id;
  return secret.id;
}

function readModelSecret(secretVault: InMemorySecretVault, ref: string): Promise<string> {
  return secretVault.getSecret(ref, {
    actor: 'system',
    userId: '__system__',
    scopes: ['secret:models:read'],
  });
}

// PUT 必须先验证完整候选，再允许 config.json 与运行态一起前进。
describe('models admin router', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('AGENT_SAAS_ALLOW_UNIDENTIFIED_ENVIRONMENT', '1');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    while (servers.length > 0) servers.pop()?.close();
  });

  it('returns configured memory index embedding settings with model settings', async () => {
    await withApp(baseRawConfig(), async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/admin/models`);
      expect(response.status).toBe(200);
      const body = await readJson(response);

      expect(body.models.default).toBe('main/gpt');
      expect(body.titleGenerator).toEqual({ model: 'main/gpt', fallbackModels: [] });
      expect(body.titleSystemPrompt).toEqual({
        content: TITLE_SYSTEM_PROMPT,
        defaultContent: TITLE_SYSTEM_PROMPT,
        overridden: false,
      });
      // 2026-07-18 凭据脱敏：GET 不再返回明文 apiKey，只返回 hasApiKey
      expect(body.memoryIndex.embedding).toEqual({
        baseUrl: 'https://old-embedding.example.invalid',
        model: 'old-embedding-model',
        dimensions: 1024,
        hasApiKey: true,
      });
      expect(body.models.groups[0].apiKey).toBeUndefined();
      expect(body.models.groups[0].hasApiKey).toBe(true);
    });
  });

  it('keeps existing secrets when PUT omits or blanks apiKey fields', async () => {
    await withApp(baseRawConfig(), async ({ baseUrl, configPath, runtimeConfig }) => {
      const response = await fetch(`${baseUrl}/api/admin/models`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          models: {
            default: 'main/gpt',
            allowCrossGroupSwitch: false,
            groups: [{
              id: 'main',
              name: 'Main',
              // apiKey 留空 → 应保留 sk-main；hasApiKey 是 GET 回显字段应被剥离
              apiKey: '',
              hasApiKey: true,
              baseUrl: 'https://llm.example.invalid/v1',
              models: [{ id: 'gpt', name: 'GPT', value: 'gpt-5' }],
            }],
          },
          memoryIndex: {
            enabled: false,
            dbDir: 'data/memory-index',
            // embedding.apiKey 缺失 → 应保留 old-embedding-key
            embedding: {
              baseUrl: 'https://old-embedding.example.invalid',
              model: 'old-embedding-model',
              dimensions: 1024,
              hasApiKey: true,
            },
            chunking: { tokens: 200, overlap: 40 },
            search: { vectorWeight: 0.7, textWeight: 0.3, maxResults: 10, minScore: 0.3 },
            temporalDecay: { enabled: false, halfLifeDays: 30 },
            sync: { debounceMs: 1500 },
          },
        }),
      });

      expect(response.status).toBe(200);
      const body = await readJson(response);
      // 响应也保持脱敏口径
      expect(body.models.groups[0].apiKey).toBeUndefined();
      expect(body.models.groups[0].hasApiKey).toBe(true);
      expect(body.memoryIndex.embedding.apiKey).toBeUndefined();

      const written = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(written.models.groups[0].apiKey).toBe('sk-main');
      expect(written.models.groups[0].hasApiKey).toBeUndefined();
      expect(written.memory.index.embedding.apiKey).toBe('old-embedding-key');
      expect(runtimeConfig.models?.groups[0]?.apiKey).toBe('sk-main');
      expect(runtimeConfig.memory?.index?.embedding.apiKey).toBe('old-embedding-key');
    });
  });

  it('stores a newly submitted model API key in SecretVault and resolves it only for runtime', async () => {
    const secretVault = new InMemorySecretVault();
    await withApp(baseRawConfig(), async ({ baseUrl, configPath }) => {
      const source = baseRawConfig();
      source.models.groups[0]!.apiKey = 'sk-rotated';
      const response = await fetch(`${baseUrl}/api/admin/models`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ models: source.models }),
      });
      expect(response.status).toBe(200);
      const written = JSON.parse(readFileSync(configPath, 'utf8'));
      expect(written.models.groups[0].apiKey).toBeUndefined();
      expect(written.models.groups[0].apiKeyRef).toEqual(expect.any(String));
      expect(JSON.stringify(await readJson(response))).not.toContain('sk-rotated');

      const resolved = await resolveModelsConfig(parseAppConfig(written).models, secretVault);
      expect(resolved?.groups[0]?.apiKey).toBe('sk-rotated');
      expect(resolved?.groups[0]?.apiKeyRef).toBe(written.models.groups[0].apiKeyRef);
    }, { secretVault });
  });

  it('does not revoke a replaced ref while another committed model group still references it', async () => {
    const secretVault = new InMemorySecretVault();
    const rawConfig = baseRawConfig();
    const sharedRef = await installModelApiKeyRef(rawConfig, secretVault, 'sk-shared-before-update');
    rawConfig.models.groups.push({
      id: 'backup',
      name: 'Backup',
      apiKeyRef: sharedRef,
      baseUrl: 'https://backup.example.invalid/v1',
      models: [{ id: 'gpt', name: 'Backup GPT', value: 'gpt-5' }],
    } as never);
    const revokeSecret = vi.spyOn(secretVault, 'revokeSecret');

    await withApp(rawConfig, async ({ baseUrl, configPath }) => {
      const source = structuredClone(rawConfig);
      source.models.groups[0]!.apiKey = 'sk-main-after-update';
      delete (source.models.groups[0] as { apiKeyRef?: string }).apiKeyRef;
      const response = await fetch(`${baseUrl}/api/admin/models`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ models: source.models }),
      });

      expect(response.status).toBe(200);
      const written = JSON.parse(readFileSync(configPath, 'utf8'));
      expect(written.models.groups[1].apiKeyRef).toBe(sharedRef);
      expect(written.models.groups[0].apiKeyRef).not.toBe(sharedRef);
      expect(revokeSecret).not.toHaveBeenCalledWith(sharedRef, expect.any(Object));
      await expect(readModelSecret(secretVault, sharedRef)).resolves.toBe('sk-shared-before-update');
    }, { secretVault });
  });

  it('waits for earlier model Secret writes before rolling them back when a later write fails', async () => {
    const secretVault = new InMemorySecretVault();
    const originalPutSecret = secretVault.putSecret.bind(secretVault);
    vi.spyOn(secretVault, 'putSecret')
      .mockImplementationOnce(async (...args) => {
        await new Promise(resolve => setTimeout(resolve, 20));
        return originalPutSecret(...args);
      })
      .mockRejectedValueOnce(new Error('models SecretVault forced failure'));
    const revokeSecret = vi.spyOn(secretVault, 'revokeSecret');

    await withApp(baseRawConfig(), async ({ baseUrl, configPath }) => {
      const source = baseRawConfig();
      source.models.groups[0]!.apiKey = 'sk-first-created';
      source.models.groups.push({
        id: 'backup',
        name: 'Backup',
        apiKey: 'sk-second-fails',
        baseUrl: 'https://backup.example.invalid/v1',
        models: [{ id: 'gpt', name: 'Backup GPT', value: 'gpt-5' }],
      });
      const response = await fetch(`${baseUrl}/api/admin/models`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ models: source.models }),
      });

      expect(response.ok).toBe(false);
      expect(JSON.parse(readFileSync(configPath, 'utf8')).models.groups).toHaveLength(1);
      expect(revokeSecret).toHaveBeenCalledOnce();
      const createdRef = revokeSecret.mock.calls[0]?.[0];
      expect(createdRef).toEqual(expect.any(String));
      await expect(readModelSecret(secretVault, createdRef as string)).rejects.toThrow('secret revoked');
    }, { secretVault });
  });

  it('keeps the new model Secret and revokes the replaced Secret when committed publication fails', async () => {
    const secretVault = new InMemorySecretVault();
    const rawConfig = baseRawConfig();
    const oldRef = await installModelApiKeyRef(rawConfig, secretVault, 'sk-before-committed-failure');
    const revokeSecret = vi.spyOn(secretVault, 'revokeSecret');
    const publicationError = new Error('forced model publication failure');
    const onConfigReloaded = vi.fn().mockRejectedValue(publicationError);

    await withApp(rawConfig, async ({ baseUrl, configPath, runtimeConfig }) => {
      const source = baseRawConfig();
      source.models.groups[0]!.apiKey = 'sk-committed-publication-failed';
      const response = await fetch(`${baseUrl}/api/admin/models`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ models: source.models }),
      });

      expect(response.status).toBe(500);
      expect((await readJson(response)).error).toBe(publicationError.message);
      const written = JSON.parse(readFileSync(configPath, 'utf8'));
      const createdRef = written.models.groups[0].apiKeyRef;
      expect(createdRef).toEqual(expect.any(String));
      expect(runtimeConfig.models?.groups[0]?.apiKeyRef).toBe(createdRef);
      expect(revokeSecret).toHaveBeenCalledOnce();
      expect(revokeSecret).toHaveBeenCalledWith(oldRef, expect.any(Object));
      const resolved = await resolveModelsConfig(runtimeConfig.models, secretVault);
      expect(resolved?.groups[0]?.apiKey).toBe('sk-committed-publication-failed');
      await expect(readModelSecret(secretVault, oldRef)).rejects.toThrow(`secret revoked: ${oldRef}`);
    }, { secretVault, onConfigReloaded });
  });

  it('reports post-commit unreferenced Secret prune failure without revoking the committed Secret', async () => {
    const secretVault = new InMemorySecretVault();
    const rawConfig = baseRawConfig();
    const oldRef = await installModelApiKeyRef(rawConfig, secretVault, 'sk-before-prune-failure');
    const originalRevokeSecret = secretVault.revokeSecret.bind(secretVault);
    const revokeSecret = vi.spyOn(secretVault, 'revokeSecret').mockImplementation(async (ref, caller) => {
      if (ref === oldRef) throw new Error('forced old Secret prune failure');
      return originalRevokeSecret(ref, caller);
    });

    await withApp(rawConfig, async ({ baseUrl, configPath, runtimeConfig }) => {
      const source = baseRawConfig();
      source.models.groups[0]!.apiKey = 'sk-committed-after-prune-failure';
      const response = await fetch(`${baseUrl}/api/admin/models`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ models: source.models }),
      });

      expect(response.status).toBe(500);
      expect((await readJson(response)).error).toBe('配置已提交，但旧模型凭据撤销失败');
      const written = JSON.parse(readFileSync(configPath, 'utf8'));
      const createdRef = written.models.groups[0].apiKeyRef;
      expect(runtimeConfig.models?.groups[0]?.apiKeyRef).toBe(createdRef);
      await expect(readModelSecret(secretVault, createdRef)).resolves.toBe('sk-committed-after-prune-failure');
      await expect(readModelSecret(secretVault, oldRef)).resolves.toBe('sk-before-prune-failure');
      expect(revokeSecret).toHaveBeenCalledWith(oldRef, expect.any(Object));
      expect(revokeSecret).not.toHaveBeenCalledWith(createdRef, expect.any(Object));
    }, { secretVault });
  });

  it('keeps both model Secrets when applyRuntime rollback fails', async () => {
    const secretVault = new InMemorySecretVault();
    const rawConfig = baseRawConfig();
    const oldRef = await installModelApiKeyRef(rawConfig, secretVault, 'sk-before-runtime-restore-failed');
    const revokeSecret = vi.spyOn(secretVault, 'revokeSecret');
    const commitPreparedConfig = vi.fn();
    let prepareCalls = 0;
    const rollbackError = new Error('forced runtime rollback failure');
    const prepareConfigUpdate = vi.fn(() => {
      prepareCalls += 1;
      if (prepareCalls === 2) throw rollbackError;
      return commitPreparedConfig;
    });
    const onMemoryIndexUpdated = vi.fn().mockRejectedValueOnce(
      new Error('forced runtime apply failure'),
    );

    await withApp(rawConfig, async ({ baseUrl, configPath, runtimeConfig }) => {
      const source = baseRawConfig();
      source.models.groups[0]!.apiKey = 'sk-runtime-restore-failed';
      const response = await fetch(`${baseUrl}/api/admin/models`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ models: source.models }),
      });

      expect(response.ok).toBe(false);
      expect(prepareConfigUpdate).toHaveBeenCalledTimes(2);
      expect(commitPreparedConfig).toHaveBeenCalledOnce();
      expect(JSON.parse(readFileSync(configPath, 'utf8')).models.groups[0].apiKeyRef).toBe(oldRef);
      const runtimeRef = runtimeConfig.models?.groups[0]?.apiKeyRef;
      expect(runtimeRef).toEqual(expect.any(String));
      expect(revokeSecret).not.toHaveBeenCalled();
      const resolved = await resolveModelsConfig(runtimeConfig.models, secretVault);
      expect(resolved?.groups[0]?.apiKey).toBe('sk-runtime-restore-failed');
      await expect(readModelSecret(secretVault, oldRef)).resolves.toBe('sk-before-runtime-restore-failed');
    }, { secretVault, prepareConfigUpdate, onMemoryIndexUpdated });
  });

  it('updates models and memory index embedding settings in one config write', async () => {
    const onModelsUpdated = vi.fn();
    const onMemoryIndexUpdated = vi.fn(async () => undefined);
    const secretVault = new InMemorySecretVault();

    await withApp(baseRawConfig(), async ({ baseUrl, configPath, runtimeConfig }) => {
      const response = await fetch(`${baseUrl}/api/admin/models`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          models: {
            default: 'main/gpt',
            allowCrossGroupSwitch: true,
            groups: [{
              id: 'main',
              name: 'Main',
              apiKey: 'sk-main',
              baseUrl: 'https://llm.example.invalid/v1',
                models: [
                  { id: 'mini', name: 'Mini', value: 'gpt-5-mini' },
                  {
                    id: 'gpt',
                    name: 'GPT',
                    value: 'gpt-5.5',
                    context_window: 372_000,
                    auto_compact_threshold: 0.65,
                  },
                ],
            }],
          },
          memoryIndex: {
            enabled: true,
            dbDir: 'data/memory-index',
            embedding: {
              baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode',
              apiKey: 'new-embedding-key',
              model: 'text-embedding-v3',
              dimensions: 1024,
            },
            chunking: { tokens: 200, overlap: 40 },
            search: { vectorWeight: 0.7, textWeight: 0.3, maxResults: 10, minScore: 0.3 },
            temporalDecay: { enabled: false, halfLifeDays: 30 },
            sync: { debounceMs: 1500 },
          },
        }),
      });

      expect(response.status).toBe(200);
      const body = await readJson(response);
      expect(body.models.allowCrossGroupSwitch).toBe(true);
        expect(body.models.groups[0].models.map((model: { id: string }) => model.id)).toEqual(['mini', 'gpt']);
        expect(body.publicModelList.groups[0].models.map((model: { id: string }) => model.id)).toEqual(['mini', 'gpt']);
        expect(body.models.groups[0].models[1]).toMatchObject({
          context_window: 372_000,
          auto_compact_threshold: 0.65,
        });
        expect(body.memoryIndex.embedding.model).toBe('text-embedding-v3');
        expect(runtimeConfig.models?.groups[0]?.models.map((model) => model.id)).toEqual(['mini', 'gpt']);
        expect(runtimeConfig.models?.groups[0]?.models[1]?.value).toBe('gpt-5.5');
        expect(runtimeConfig.models?.groups[0]?.models[1]?.context_window).toBe(372_000);
        expect(runtimeConfig.models?.groups[0]?.models[1]?.auto_compact_threshold).toBe(0.65);
      expect(runtimeConfig.memory?.index?.embedding.apiKey).toBeUndefined();
      expect(runtimeConfig.memory?.index?.embedding.apiKeyRef).toEqual(expect.any(String));
      expect(onModelsUpdated).toHaveBeenCalledWith(runtimeConfig.models);
      expect(onMemoryIndexUpdated).toHaveBeenCalledWith(runtimeConfig.memory?.index);

      const written = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(written.memory.injectContext).toEqual({ enabled: true, maxLines: 120 });
      expect(written.memory.index.embedding.apiKey).toBeUndefined();
      expect(written.memory.index.embedding.apiKeyRef).toEqual(expect.any(String));
        expect(written.models.groups[0].models.map((model: { id: string }) => model.id)).toEqual(['mini', 'gpt']);
        expect(written.models.groups[0].models[1].value).toBe('gpt-5.5');
        expect(written.models.groups[0].models[1].context_window).toBe(372_000);
        expect(written.models.groups[0].models[1].auto_compact_threshold).toBe(0.65);
    }, { onModelsUpdated, onMemoryIndexUpdated, secretVault });
  });

  it('creates memory.index when only models existed before', async () => {
    const rawConfig = baseRawConfig();
    delete (rawConfig as any).memory;
    const secretVault = new InMemorySecretVault();

    await withApp(rawConfig, async ({ baseUrl, configPath }) => {
      const response = await fetch(`${baseUrl}/api/admin/models`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          models: rawConfig.models,
          memoryIndex: {
            enabled: false,
            embedding: {
              baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode',
              apiKey: 'embedding-key',
              model: 'text-embedding-v3',
              dimensions: 1024,
            },
          },
        }),
      });

      expect(response.status).toBe(200);
      const written = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(written.memory.index.embedding.apiKey).toBeUndefined();
      expect(written.memory.index.embedding.apiKeyRef).toEqual(expect.any(String));
    }, { secretVault });
  });

  it('rejects an automatic compaction threshold outside 0~1', async () => {
    const rawConfig = baseRawConfig();
    (rawConfig.models.groups[0]!.models[0] as Record<string, unknown>).auto_compact_threshold = 1;

    await withApp(baseRawConfig(), async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/admin/models`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ models: rawConfig.models }),
      });
      expect(response.status).toBe(400);
      expect((await readJson(response)).error).toContain('auto_compact_threshold');
    });
  });

  it('在写盘前拒绝会使门禁 fallback 引用失效的 models 更新', async () => {
    const rawConfig = { ...baseRawConfig(), guardrail: { model: 'main/gpt', fallbackModels: ['main/mini'] } };
    rawConfig.models.groups[0]!.models.push({ id: 'mini', name: 'Mini', value: 'gpt-5-mini' });
    const replacementModels = structuredClone(rawConfig.models);
    replacementModels.groups[0]!.models = replacementModels.groups[0]!.models.filter((model) => model.id !== 'mini');

    await withApp(rawConfig, async ({ baseUrl, configPath, runtimeConfig }) => {
      const response = await fetch(`${baseUrl}/api/admin/models`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ models: replacementModels }),
      });

      expect(response.status).toBe(400);
      expect((await readJson(response)).error).toContain('门禁模型引用不存在：main/mini');
      expect(JSON.parse(readFileSync(configPath, 'utf-8')).models.groups[0].models).toHaveLength(2);
      expect(runtimeConfig.models?.groups[0]?.models).toHaveLength(2);
    });
  });

  it('连续两次保存均返回 raw config revision，并支持 expectedRevision/If-Match 接力', async () => {
    const rawConfig = baseRawConfig();
    await withApp(rawConfig, async ({ baseUrl, configPath }) => {
      const loadedResponse = await fetch(`${baseUrl}/api/admin/models`); const loaded = await readJson(loadedResponse);
      const loadedText = readFileSync(configPath, 'utf-8');
      expect(loaded.revision).toBe(revision(loadedText));
      expect(loadedResponse.headers.get('etag')).toBe(`"${loaded.revision}"`);

      const noOpResponse = await fetch(`${baseUrl}/api/admin/models`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ models: rawConfig.models, expectedRevision: loaded.revision }),
      });
      expect(noOpResponse.status).toBe(200);
      const noOp = await readJson(noOpResponse);
      expect(noOp.revision).toBe(loaded.revision);
      expect(noOpResponse.headers.get('etag')).toBe(`"${loaded.revision}"`);
      expect(readFileSync(configPath, 'utf-8')).toBe(loadedText);

      const firstModels = structuredClone(rawConfig.models); firstModels.groups[0]!.name = 'First';
      const firstResponse = await fetch(`${baseUrl}/api/admin/models`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ models: firstModels, expectedRevision: noOp.revision }),
      });
      expect(firstResponse.status).toBe(200);
      const first = await readJson(firstResponse);
      expect(first.revision).toBe(revision(readFileSync(configPath, 'utf-8')));
      expect(firstResponse.headers.get('etag')).toBe(`"${first.revision}"`);

      const secondModels = structuredClone(firstModels); secondModels.groups[0]!.name = 'Second';
      const secondResponse = await fetch(`${baseUrl}/api/admin/models`, {
        method: 'PUT', headers: { 'content-type': 'application/json', 'if-match': `"${first.revision}"` }, body: JSON.stringify({ models: secondModels }),
      });
      expect(secondResponse.status).toBe(200);
      const second = await readJson(secondResponse);
      expect(second.revision).toBe(revision(readFileSync(configPath, 'utf-8')));
      expect(secondResponse.headers.get('etag')).toBe(`"${second.revision}"`);
      expect(second.revision).not.toBe(first.revision);
    }, { requireRevision: true });
  });

  it('拒绝旧页面携带的过期 revision，不让后提交覆盖先提交', async () => {
    const rawConfig = baseRawConfig();
    await withApp(rawConfig, async ({ baseUrl, configPath }) => {
      const loaded = await readJson(await fetch(`${baseUrl}/api/admin/models`));
      writeFileSync(configPath, JSON.stringify({ ...rawConfig, concurrentWinner: true }), 'utf-8');
      const response = await fetch(`${baseUrl}/api/admin/models`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ models: rawConfig.models, expectedRevision: loaded.revision }),
      });
      expect(response.status).toBe(409);
      const winnerText = readFileSync(configPath, 'utf-8'); const conflict = await readJson(response);
      expect(JSON.parse(winnerText).concurrentWinner).toBe(true);
      expect(conflict.revision).toBe(revision(winnerText));
      expect(response.headers.get('etag')).toBe(`"${conflict.revision}"`);
    }, { requireRevision: true });
  });

  it('异步校验期间服务端基线被修改时返回 409，不覆盖胜出版本', async () => {
    const rawConfig = baseRawConfig(); let configPath = '';
    const validateConfigReload = vi.fn(async () => { writeFileSync(configPath, JSON.stringify({ ...rawConfig, concurrentWinner: true }), 'utf-8'); });
    await withApp(rawConfig, async ({ baseUrl, configPath: path }) => {
      configPath = path;
      const response = await fetch(`${baseUrl}/api/admin/models`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ models: rawConfig.models }),
      });
      expect(response.status).toBe(409);
      expect(JSON.parse(readFileSync(path, 'utf-8')).concurrentWinner).toBe(true);
    }, { validateConfigReload });
  });

  it('Production 安全门禁拒绝候选时不写盘、不提交运行态与 identity 回调', async () => {
    const rawConfig = baseRawConfig();
    const before = JSON.stringify(rawConfig, null, 2);
    const validateConfigReload = vi.fn().mockRejectedValue(new Error('inline model secret is forbidden'));
    const secretVault = new InMemorySecretVault();
    const revokeSecret = vi.spyOn(secretVault, 'revokeSecret');
    const commit = vi.fn(); const prepareConfigUpdate = vi.fn(() => commit); const onConfigReloaded = vi.fn();
    await withApp(rawConfig, async ({ baseUrl, configPath, runtimeConfig }) => {
      const models = structuredClone(rawConfig.models); models.groups[0]!.apiKey = 'new-inline-secret';
      const response = await fetch(`${baseUrl}/api/admin/models`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ models }),
      });
      expect(response.status).toBe(500);
      expect(readFileSync(configPath, 'utf-8')).toBe(before);
      expect(runtimeConfig.models?.groups[0]?.apiKey).toBe('sk-main');
      expect(prepareConfigUpdate).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled(); expect(onConfigReloaded).not.toHaveBeenCalled();
      expect(revokeSecret).toHaveBeenCalledOnce();
      const createdRef = revokeSecret.mock.calls[0]?.[0];
      expect(createdRef).toEqual(expect.any(String));
      await expect(readModelSecret(secretVault, createdRef as string)).rejects.toThrow('secret revoked');
    }, { validateConfigReload, prepareConfigUpdate, onConfigReloaded, secretVault });
  });

  it('persists title model order and title prompt in one commit', async () => {
    const rawConfig = baseRawConfig();
    rawConfig.models.groups[0]!.models.push({ id: 'mini', name: 'Mini', value: 'gpt-5-mini' });
    const onModelsUpdated = vi.fn();
    const onSystemPromptOverridesUpdated = vi.fn();

    await withApp(rawConfig, async ({ baseUrl, configPath, runtimeConfig }) => {
      const response = await fetch(`${baseUrl}/api/admin/models`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          models: rawConfig.models,
          titleGenerator: { model: 'main/gpt', fallbackModels: ['main/mini'] },
          titleSystemPrompt: '只输出一个准确的短标题',
        }),
      });

      expect(response.status).toBe(200);
      const body = await readJson(response);
      expect(body.titleGenerator).toEqual({ model: 'main/gpt', fallbackModels: ['main/mini'] });
      expect(body.titleSystemPrompt).toMatchObject({
        content: '只输出一个准确的短标题',
        overridden: true,
      });

      const written = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(written.titleGenerator).toEqual({ model: 'main/gpt', fallbackModels: ['main/mini'] });
      expect(written.systemPrompts['utility.title']).toBe('只输出一个准确的短标题');
      expect(runtimeConfig.titleGenerator).toEqual(written.titleGenerator);
      expect(runtimeConfig.systemPrompts?.['utility.title']).toBe('只输出一个准确的短标题');
      expect(onModelsUpdated).toHaveBeenCalledOnce();
      expect(onSystemPromptOverridesUpdated).toHaveBeenCalledWith({
        'utility.title': '只输出一个准确的短标题',
      });
    }, { onModelsUpdated, onSystemPromptOverridesUpdated });
  });

  it('restores the built-in title prompt by removing only its override', async () => {
    const rawConfig = {
      ...baseRawConfig(),
      systemPrompts: {
        'utility.title': '旧标题提示语',
        'utility.guardrail': '保留的门禁提示语',
      },
    };

    await withApp(rawConfig, async ({ baseUrl, configPath }) => {
      const response = await fetch(`${baseUrl}/api/admin/models`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          models: rawConfig.models,
          titleGenerator: { model: 'main/gpt', fallbackModels: [] },
          titleSystemPrompt: TITLE_SYSTEM_PROMPT,
        }),
      });

      expect(response.status).toBe(200);
      const written = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(written.systemPrompts['utility.title']).toBeUndefined();
      expect(written.systemPrompts['utility.guardrail']).toBe('保留的门禁提示语');
      expect((await readJson(response)).titleSystemPrompt.overridden).toBe(false);
    });
  });

  it('rejects duplicate or missing title model references', async () => {
    await withApp(baseRawConfig(), async ({ baseUrl }) => {
      const duplicate = await fetch(`${baseUrl}/api/admin/models`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          models: baseRawConfig().models,
          titleGenerator: { model: 'main/gpt', fallbackModels: ['main/gpt'] },
        }),
      });
      expect(duplicate.status).toBe(400);
      expect((await readJson(duplicate)).error).toContain('不能包含重复模型');

      const missing = await fetch(`${baseUrl}/api/admin/models`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          models: baseRawConfig().models,
          titleGenerator: { model: 'main/missing', fallbackModels: [] },
        }),
      });
      expect(missing.status).toBe(400);
      expect((await readJson(missing)).error).toContain('main/missing');
    });
  });
});

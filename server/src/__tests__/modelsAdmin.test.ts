import express from 'express';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseAppConfig } from '../app/config.js';
import { createModelsAdminRouter } from '../routes/modelsAdmin.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';

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

describe('models admin router', () => {
  afterEach(() => {
    while (servers.length > 0) servers.pop()?.close();
  });

  it('returns configured memory index embedding settings with model settings', async () => {
    await withApp(baseRawConfig(), async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/admin/models`);
      expect(response.status).toBe(200);
      const body = await readJson(response);

      expect(body.models.default).toBe('main/gpt');
      expect(body.memoryIndex.embedding).toEqual({
        baseUrl: 'https://old-embedding.example.invalid',
        apiKey: 'old-embedding-key',
        model: 'old-embedding-model',
        dimensions: 1024,
      });
    });
  });

  it('updates models and memory index embedding settings in one config write', async () => {
    const onModelsUpdated = vi.fn();
    const onMemoryIndexUpdated = vi.fn(async () => undefined);

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
              models: [{
                id: 'gpt',
                name: 'GPT',
                value: 'gpt-5.5',
                context_window: 372_000,
                auto_compact_threshold: 0.65,
              }],
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
      expect(body.models.groups[0].models[0]).toMatchObject({
        context_window: 372_000,
        auto_compact_threshold: 0.65,
      });
      expect(body.memoryIndex.embedding.model).toBe('text-embedding-v3');
      expect(runtimeConfig.models?.groups[0]?.models[0]?.value).toBe('gpt-5.5');
      expect(runtimeConfig.models?.groups[0]?.models[0]?.context_window).toBe(372_000);
      expect(runtimeConfig.models?.groups[0]?.models[0]?.auto_compact_threshold).toBe(0.65);
      expect(runtimeConfig.memory?.index?.embedding.apiKey).toBe('new-embedding-key');
      expect(onModelsUpdated).toHaveBeenCalledWith(runtimeConfig.models);
      expect(onMemoryIndexUpdated).toHaveBeenCalledWith(runtimeConfig.memory?.index);

      const written = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(written.memory.injectContext).toEqual({ enabled: true, maxLines: 120 });
      expect(written.memory.index.embedding.apiKey).toBe('new-embedding-key');
      expect(written.models.groups[0].models[0].value).toBe('gpt-5.5');
      expect(written.models.groups[0].models[0].context_window).toBe(372_000);
      expect(written.models.groups[0].models[0].auto_compact_threshold).toBe(0.65);
    }, { onModelsUpdated, onMemoryIndexUpdated });
  });

  it('creates memory.index when only models existed before', async () => {
    const rawConfig = baseRawConfig();
    delete (rawConfig as any).memory;

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
      expect(written.memory.index.embedding.apiKey).toBe('embedding-key');
    });
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
});

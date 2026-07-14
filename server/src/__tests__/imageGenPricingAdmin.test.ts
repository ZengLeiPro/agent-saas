import express from 'express';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseAppConfig } from '../app/config.js';
import { createImageGenPricingAdminRouter } from '../routes/imageGenPricingAdmin.js';
import {
  DEFAULT_IMAGE_GEN_PRICING,
  configureImageGenPricing,
  getImageGenEnginePricing,
} from '../data/usage/imageGenPricing.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';

const servers: Array<{ close: () => void }> = [];

function baseRawConfig() {
  return {
    agent: { cwd: '/tmp/agent' },
    server: { port: 3200 },
    imageGenTools: {
      enabled: true,
      gptImage2: {
        baseUrl: 'https://proxy.example/v1',
        apiKeyRef: 'image-gen-cliproxy-key',
      },
      pricing: {
        'gpt-image-2': { creditsPerImage: 400, costYuanPerImage: 1.5 },
      },
    },
  };
}

function makeWorkspace(rawConfig: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), 'image-gen-pricing-admin-'));
  const processCwd = join(root, 'server');
  mkdirSync(processCwd, { recursive: true });
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify(rawConfig, null, 2), 'utf-8');
  return { processCwd, configPath };
}

async function withApp<T>(
  rawConfig: Record<string, unknown>,
  fn: (args: {
    baseUrl: string;
    configPath: string;
    runtimeConfig: ReturnType<typeof parseAppConfig>;
    onPricingUpdated: ReturnType<typeof vi.fn>;
  }) => Promise<T>,
): Promise<T> {
  const { processCwd, configPath } = makeWorkspace(rawConfig);
  const runtimeConfig = parseAppConfig(rawConfig);
  const onPricingUpdated = vi.fn((pricing) => configureImageGenPricing(pricing));
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { sub: 'admin', username: 'admin', role: 'admin', tenantId: DEFAULT_TENANT_ID };
    next();
  });
  app.use('/api/admin/image-gen-pricing', createImageGenPricingAdminRouter({
    processCwd,
    config: runtimeConfig,
    onPricingUpdated,
  }));
  const server = app.listen(0);
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind test server');
  return fn({ baseUrl: `http://127.0.0.1:${address.port}`, configPath, runtimeConfig, onPricingUpdated });
}

async function readJson(response: Response) {
  return response.json() as Promise<any>;
}

describe('image gen pricing admin router', () => {
  beforeEach(() => {
    configureImageGenPricing(undefined);
  });

  afterEach(() => {
    configureImageGenPricing(undefined);
    while (servers.length > 0) servers.pop()?.close();
  });

  it('returns effective pricing merged with builtin defaults', async () => {
    await withApp(baseRawConfig(), async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/admin/image-gen-pricing`);
      expect(response.status).toBe(200);
      const body = await readJson(response);
      expect(body.defaults).toEqual(DEFAULT_IMAGE_GEN_PRICING);
      expect(body.configured).toEqual({ 'gpt-image-2': { creditsPerImage: 400, costYuanPerImage: 1.5 } });
      // seedream 未显式配置 → 生效视图回退内置默认
      expect(body.pricing.seedream).toEqual(DEFAULT_IMAGE_GEN_PRICING.seedream);
    });
  });

  it('PUT round-trips: config.json, in-process config, callback and charge-path getter all update', async () => {
    await withApp(baseRawConfig(), async ({ baseUrl, configPath, runtimeConfig, onPricingUpdated }) => {
      const nextPricing = {
        'gpt-image-2': { creditsPerImage: 320, costYuanPerImage: 1.2 },
        seedream: { creditsPerImage: 80, costYuanPerImage: 0.3 },
      };
      const response = await fetch(`${baseUrl}/api/admin/image-gen-pricing`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pricing: nextPricing }),
      });
      expect(response.status).toBe(200);
      const body = await readJson(response);
      expect(body.configured).toEqual(nextPricing);

      // ① 落盘 config.json（jsonc 局部回写，engine 凭据段保留原样）
      const onDisk = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(onDisk.imageGenTools.pricing).toEqual(nextPricing);
      expect(onDisk.imageGenTools.gptImage2.apiKeyRef).toBe('image-gen-cliproxy-key');
      // ② 进程内 config 对象
      expect(runtimeConfig.imageGenTools?.pricing).toEqual(nextPricing);
      // ③ 热更回调 + 扣费点 getter 即时生效
      expect(onPricingUpdated).toHaveBeenCalledTimes(1);
      expect(getImageGenEnginePricing('gpt-image-2')).toEqual({ creditsPerImage: 320, costYuanPerImage: 1.2 });
      expect(getImageGenEnginePricing('seedream')).toEqual({ creditsPerImage: 80, costYuanPerImage: 0.3 });
    });
  });

  it('creates the imageGenTools section when the config file lacks it', async () => {
    await withApp({ agent: { cwd: '/tmp/agent' }, server: { port: 3200 } }, async ({ baseUrl, configPath }) => {
      const response = await fetch(`${baseUrl}/api/admin/image-gen-pricing`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pricing: { seedream: { creditsPerImage: 120, costYuanPerImage: 0.5 } } }),
      });
      expect(response.status).toBe(200);
      const onDisk = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(onDisk.imageGenTools.pricing.seedream).toEqual({ creditsPerImage: 120, costYuanPerImage: 0.5 });
    });
  });

  it('rejects invalid pricing values with a 400 carrying the field path', async () => {
    await withApp(baseRawConfig(), async ({ baseUrl, configPath }) => {
      const before = readFileSync(configPath, 'utf-8');
      const response = await fetch(`${baseUrl}/api/admin/image-gen-pricing`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pricing: { seedream: { creditsPerImage: -1, costYuanPerImage: 0.3 } } }),
      });
      expect(response.status).toBe(400);
      const body = await readJson(response);
      expect(body.error).toContain('creditsPerImage');
      // 校验失败不落盘
      expect(readFileSync(configPath, 'utf-8')).toBe(before);
    });
  });
});

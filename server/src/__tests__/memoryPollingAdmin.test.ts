import express from 'express';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseAppConfig } from '../app/config.js';
import { createMemoryPollingAdminRouter } from '../routes/memoryPollingAdmin.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';

const servers: Array<{ close: () => void }> = [];
const roots: string[] = [];

function baseRawConfig() {
  return {
    agent: { cwd: '/tmp/agent' },
    server: { port: 3200 },
    memory: {
      injectContext: { enabled: true, maxLines: 160 },
      maintenance: { enabled: true, minTextLength: 500, cooldownMinutes: 30 },
      polling: {
        enabled: true,
        hour: 4,
        hoursSpan: 4,
        timezone: 'Asia/Shanghai',
        lookbackHours: 48,
        maxTurns: 30,
        timeoutSeconds: 900,
      },
    },
    models: {
      default: 'kaiyan-llm/gpt-5.5',
      groups: [{
        id: 'kaiyan-llm',
        name: '开沿模型',
        baseUrl: 'https://llm.example/v1',
        apiKey: 'test',
        models: [{ id: 'gpt-5.5', name: 'GPT-5.5', value: 'gpt-5.5' }],
      }],
    },
  };
}

async function withApp<T>(
  rawConfig: Record<string, unknown>,
  fn: (args: {
    baseUrl: string;
    configPath: string;
    runtimeConfig: ReturnType<typeof parseAppConfig>;
    onPollingUpdated: ReturnType<typeof vi.fn>;
  }) => Promise<T>,
): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'memory-polling-admin-'));
  roots.push(root);
  const processCwd = join(root, 'server');
  mkdirSync(processCwd, { recursive: true });
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify(rawConfig, null, 2), 'utf-8');
  const runtimeConfig = parseAppConfig(rawConfig);
  const onPollingUpdated = vi.fn();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = {
      sub: 'admin',
      username: 'admin',
      role: 'admin',
      tenantId: DEFAULT_TENANT_ID,
    };
    next();
  });
  app.use('/api/admin/memory-polling', createMemoryPollingAdminRouter({
    processCwd,
    config: runtimeConfig,
    onPollingUpdated,
  }));
  const server = app.listen(0);
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind test server');
  return fn({
    baseUrl: `http://127.0.0.1:${address.port}`,
    configPath,
    runtimeConfig,
    onPollingUpdated,
  });
}

async function readJson(response: Response) {
  return response.json() as Promise<any>;
}

afterEach(() => {
  while (servers.length > 0) servers.pop()?.close();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('memory polling admin router', () => {
  it('returns the complete effective polling config', async () => {
    await withApp(baseRawConfig(), async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/admin/memory-polling`);
      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toMatchObject({
        configured: true,
        defaultModel: 'kaiyan-llm/gpt-5.5',
        polling: {
          enabled: true,
          hour: 4,
          hoursSpan: 4,
          timezone: 'Asia/Shanghai',
          lookbackHours: 48,
          maxTurns: 30,
          timeoutSeconds: 900,
          model: null,
        },
      });
    });
  });

  it('PUT persists config, preserves other memory settings and triggers hot update', async () => {
    await withApp(baseRawConfig(), async ({
      baseUrl,
      configPath,
      runtimeConfig,
      onPollingUpdated,
    }) => {
      const polling = {
        enabled: false,
        hour: 2,
        hoursSpan: 6,
        timezone: 'Asia/Shanghai',
        lookbackHours: 72,
        maxTurns: 45,
        timeoutSeconds: 1200,
        model: 'kaiyan-llm/gpt-5.5',
      };
      const response = await fetch(`${baseUrl}/api/admin/memory-polling`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ polling }),
      });
      expect(response.status).toBe(200);
      expect((await readJson(response)).polling).toEqual(polling);

      const onDisk = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(onDisk.memory.polling).toEqual(polling);
      expect(onDisk.memory.injectContext).toEqual({ enabled: true, maxLines: 160 });
      expect(onDisk.memory.maintenance).toEqual({ enabled: true, minTextLength: 500, cooldownMinutes: 30 });
      expect(runtimeConfig.memory?.polling).toEqual(polling);
      expect(onPollingUpdated).toHaveBeenCalledWith(polling);
    });
  });

  it('creates memory.polling when the config has no memory section', async () => {
    await withApp({ agent: { cwd: '/tmp/agent' }, server: { port: 3200 } }, async ({
      baseUrl,
      configPath,
    }) => {
      const response = await fetch(`${baseUrl}/api/admin/memory-polling`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          polling: {
            enabled: false,
            hour: 4,
            hoursSpan: 4,
            timezone: 'Asia/Shanghai',
            lookbackHours: 48,
            maxTurns: 30,
            timeoutSeconds: 900,
          },
        }),
      });
      expect(response.status).toBe(200);
      const onDisk = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(onDisk.memory.polling.enabled).toBe(false);
    });
  });

  it('rejects cross-day windows, invalid timezones and unknown models without writing', async () => {
    await withApp(baseRawConfig(), async ({ baseUrl, configPath }) => {
      const before = readFileSync(configPath, 'utf-8');
      const invalidPolling = {
        enabled: true,
        hour: 23,
        hoursSpan: 4,
        timezone: 'Asia/Shanghai',
        lookbackHours: 48,
        maxTurns: 30,
        timeoutSeconds: 900,
      };
      for (const polling of [
        invalidPolling,
        { ...invalidPolling, hour: 4, timezone: 'Mars/Olympus' },
        { ...invalidPolling, hour: 4, hoursSpan: 4, model: 'missing/model' },
      ]) {
        const response = await fetch(`${baseUrl}/api/admin/memory-polling`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ polling }),
        });
        expect(response.status).toBe(400);
      }
      expect(readFileSync(configPath, 'utf-8')).toBe(before);
    });
  });
});

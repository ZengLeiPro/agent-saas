import express from 'express';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { parseAppConfig } from '../app/config.js';
import { createModelsAdminRouter } from '../routes/modelsAdmin.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import { baseRawConfig } from './helpers/modelsAdminFixture.js';

const servers: Array<{ close: () => void }> = [];

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('AGENT_SAAS_ALLOW_UNIDENTIFIED_ENVIRONMENT', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
  while (servers.length > 0) servers.pop()?.close();
});

it('允许显式清除没有兼容候选的存量门禁配置', async () => {
  const rawConfig = { ...baseRawConfig(), guardrail: { model: 'main/gpt', timeoutMs: 6000 } };
  rawConfig.models.groups = rawConfig.models.groups.map((group) => ({
    ...group,
    protocol: 'responses' as const,
  }));
  const root = mkdtempSync(join(tmpdir(), 'models-admin-guardrail-disable-'));
  const processCwd = join(root, 'server');
  const configPath = join(root, 'config.json');
  mkdirSync(processCwd, { recursive: true });
  writeFileSync(configPath, JSON.stringify(rawConfig, null, 2), 'utf-8');
  const runtimeConfig = parseAppConfig(rawConfig);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as typeof req & { user: unknown }).user = {
      sub: 'admin',
      username: 'admin',
      role: 'admin',
      tenantId: DEFAULT_TENANT_ID,
    };
    next();
  });
  app.use('/api/admin/models', createModelsAdminRouter({ processCwd, config: runtimeConfig }));
  const server = app.listen(0);
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind test server');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const response = await fetch(`${baseUrl}/api/admin/models`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ models: rawConfig.models, guardrail: null }),
  });

  expect(response.status).toBe(200);
  expect(((await response.json()) as { guardrail: unknown }).guardrail).toBeNull();
  expect(runtimeConfig.guardrail).toBeUndefined();
  expect(JSON.parse(readFileSync(configPath, 'utf-8'))).not.toHaveProperty('guardrail');
  const saved = await fetch(`${baseUrl}/api/admin/models`);
  expect(((await saved.json()) as { guardrail: unknown }).guardrail).toBeNull();
});

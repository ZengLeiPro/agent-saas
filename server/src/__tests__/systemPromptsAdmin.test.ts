import express from 'express';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { parseAppConfig } from '../app/config.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import { createSystemPromptsAdminRouter } from '../routes/systemPromptsAdmin.js';
import { SystemPromptRegistry } from '../runtime/systemPrompts.js';

const SHARED_DIR = resolve(import.meta.dirname, '../../../workspace-shared');
const servers: Array<{ close: () => void }> = [];

async function withApp(
  username: string,
  run: (context: { baseUrl: string; configPath: string; registry: SystemPromptRegistry }) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'system-prompts-admin-'));
  const processCwd = join(root, 'server');
  mkdirSync(processCwd, { recursive: true });
  const configPath = join(root, 'config.json');
  const rawConfig = { agent: {}, server: {} };
  writeFileSync(configPath, JSON.stringify(rawConfig, null, 2), 'utf-8');
  const config = parseAppConfig(rawConfig);
  const registry = new SystemPromptRegistry(SHARED_DIR, config.systemPrompts);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = {
      sub: username,
      username,
      role: 'admin',
      tenantId: DEFAULT_TENANT_ID,
    };
    next();
  });
  app.use('/api/admin/system-prompts', createSystemPromptsAdminRouter({
    processCwd,
    config,
    registry,
  }));
  const server = app.listen(0);
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind test server');
  await run({ baseUrl: `http://127.0.0.1:${address.port}`, configPath, registry });
}

describe('system prompts admin router', () => {
  afterEach(() => {
    while (servers.length > 0) servers.pop()?.close();
  });

  it('persists an override, hot-updates the registry, and resets to the built-in default', async () => {
    await withApp('admin', async ({ baseUrl, configPath, registry }) => {
      const listResponse = await fetch(`${baseUrl}/api/admin/system-prompts`);
      expect(listResponse.status).toBe(200);
      expect(((await listResponse.json()) as any).prompts).toHaveLength(10);

      const updateResponse = await fetch(`${baseUrl}/api/admin/system-prompts/main.static`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '运行时新提示语' }),
      });
      expect(updateResponse.status, await updateResponse.clone().text()).toBe(200);
      expect(registry.get('main.static')).toBe('运行时新提示语');
      expect(JSON.parse(readFileSync(configPath, 'utf-8')).systemPrompts['main.static'])
        .toBe('运行时新提示语');

      const resetResponse = await fetch(`${baseUrl}/api/admin/system-prompts/main.static`, {
        method: 'DELETE',
      });
      expect(resetResponse.status).toBe(200);
      expect(registry.get('main.static')).toContain('开沿科技');
      expect(JSON.parse(readFileSync(configPath, 'utf-8')).systemPrompts).toBeUndefined();
    });
  });

  it('allows delegated platform admins to read but not modify prompts', async () => {
    await withApp('operator', async ({ baseUrl }) => {
      expect((await fetch(`${baseUrl}/api/admin/system-prompts`)).status).toBe(200);
      const response = await fetch(`${baseUrl}/api/admin/system-prompts/main.static`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '不应生效' }),
      });
      expect(response.status).toBe(403);
      expect((await response.json() as any).code).toBe('SUPER_ADMIN_REQUIRED');
    });
  });
});

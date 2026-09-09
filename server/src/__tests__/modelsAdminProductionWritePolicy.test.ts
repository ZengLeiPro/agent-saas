import express from 'express';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { getConfigWritePolicy, type ConfigEnvironment } from '@agent/shared/configWritePolicy';
import { parseAppConfig } from '../app/config.js';
import { AdminConfigMutationService } from '../config/adminConfigMutationService.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import { createModelsAdminRouter } from '../routes/modelsAdmin.js';
import { InMemorySecretVault } from '../security/secretVault.js';
import { baseRawConfig } from './helpers/modelsAdminFixture.js';

async function withServer(
  environment: ConfigEnvironment,
  run: (fixture: {
    url: string;
    before: string;
    configPath: string;
    processCwd: string;
    raw: ReturnType<typeof baseRawConfig>;
    service: AdminConfigMutationService;
    vault: InMemorySecretVault;
    onModelsUpdated: ReturnType<typeof vi.fn>;
  }) => Promise<void>,
  authenticated = true,
) {
  const root = mkdtempSync(join(tmpdir(), 'model-write-policy-'));
  const processCwd = join(root, 'server');
  mkdirSync(processCwd);
  const configPath = join(root, 'config.json');
  const raw = baseRawConfig();
  const before = JSON.stringify(raw, null, 2);
  writeFileSync(configPath, before);
  const vault = new InMemorySecretVault();
  const onModelsUpdated = vi.fn();
  const service = new AdminConfigMutationService({
    configPath,
    processCwd,
    environment,
    processRole: 'all',
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (authenticated)
      Object.assign(req, {
        user: { sub: 'admin', username: 'admin', role: 'admin', tenantId: DEFAULT_TENANT_ID },
      });
    next();
  });
  app.use(
    '/api/admin/models',
    createModelsAdminRouter({
      processCwd,
      config: parseAppConfig(raw),
      configMutationService: service,
      secretVault: vault,
      onModelsUpdated,
    }),
  );
  const server = app.listen(0);
  await new Promise<void>((resolve) => {
    server.once('listening', resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing test address');
    await run({
      url: `http://127.0.0.1:${address.port}/api/admin/models`,
      before,
      configPath,
      processCwd,
      raw,
      service,
      vault,
      onModelsUpdated,
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    rmSync(root, { recursive: true, force: true });
  }
}

describe('models production write policy', () => {
  it('GET advertises the actual service policy without changing config or credentials', async () => {
    await withServer('production', async ({ url, before, configPath, vault, service }) => {
      const put = vi.spyOn(vault, 'putSecret');
      const response = await fetch(url);
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.writePolicy).toEqual(service.getWritePolicy());
      expect(data.writePolicy).toEqual(getConfigWritePolicy('production'));
      expect(response.headers.get('etag')).toBe(`"${data.revision}"`);
      expect(data.models.groups[0].apiKey).toBeUndefined();
      expect(data.memoryIndex.embedding.apiKey).toBeUndefined();
      expect(readFileSync(configPath, 'utf8')).toBe(before);
      expect(put).not.toHaveBeenCalled();
    });
  });

  it.each([false, true])(
    'PUT preserves 409 + stable code, even with invalid candidate=%s',
    async (invalid) => {
      await withServer(
        'production',
        async ({ url, before, configPath, raw, vault, onModelsUpdated }) => {
          const put = vi.spyOn(vault, 'putSecret');
          const revoke = vi.spyOn(vault, 'revokeSecret');
          const current = await (await fetch(url)).json();
          const response = await fetch(url, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              models: invalid ? null : raw.models,
              expectedRevision: current.revision,
              environment: 'development',
              allowProductionMutation: true,
              writePolicy: { environment: 'development', mode: 'online', canSave: true },
            }),
          });
          expect(response.status).toBe(409);
          expect(await response.json()).toEqual({
            error: '生产配置不能直接在线保存，请通过受控配置发布流程变更',
            code: 'PRODUCTION_CONFIG_PUBLISH_REQUIRED',
            writePolicy: getConfigWritePolicy('production'),
          });
          expect(readFileSync(configPath, 'utf8')).toBe(before);
          expect(put).not.toHaveBeenCalled();
          expect(revoke).not.toHaveBeenCalled();
          expect(onModelsUpdated).not.toHaveBeenCalled();
        },
      );
    },
  );

  it.each(['staging', 'development', 'test'] as const)(
    '%s advertises writable without weakening server authority',
    async (environment) => {
      await withServer(environment, async ({ url }) => {
        const data = await (await fetch(url)).json();
        expect(data.writePolicy).toEqual(getConfigWritePolicy(environment));
      });
    },
  );

  it('non-production saves still apply and return the policy alongside a new revision', async () => {
    await withServer('test', async ({ url, raw, configPath, onModelsUpdated }) => {
      const current = await (await fetch(url)).json();
      const response = await fetch(url, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedRevision: current.revision,
          models: { ...raw.models, allowCrossGroupSwitch: !raw.models.allowCrossGroupSwitch },
        }),
      });
      expect(response.status).toBe(200);
      const saved = await response.json();
      expect(saved.writePolicy).toEqual(getConfigWritePolicy('test'));
      expect(saved.revision).not.toBe(current.revision);
      expect(JSON.parse(readFileSync(configPath, 'utf8')).models.allowCrossGroupSwitch).toBe(
        !raw.models.allowCrossGroupSwitch,
      );
      expect(onModelsUpdated).toHaveBeenCalledOnce();
    });
  });

  it('unauthenticated requests cannot use the policy endpoint to read model configuration', async () => {
    await withServer(
      'production',
      async ({ url }) => {
        const response = await fetch(url);
        expect([401, 403]).toContain(response.status);
        const body = await response.json();
        expect(body.models).toBeUndefined();
        expect(body.writePolicy).toBeUndefined();
      },
      false,
    );
  });
});

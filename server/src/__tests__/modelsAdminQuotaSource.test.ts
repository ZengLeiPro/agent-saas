import express from 'express';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseAppConfig } from '../app/config.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import { createModelsAdminRouter } from '../routes/modelsAdmin.js';
import { InMemorySecretVault } from '../security/secretVault.js';

const servers: Array<{ close: () => void }> = [];

function rawConfig() {
  return {
    agent: { cwd: '/tmp/agent' },
    server: { port: 3200 },
    models: {
      default: 'ark/glm',
      allowCrossGroupSwitch: false,
      groups: [
        {
          id: 'ark',
          name: '火山 Agent Plan',
          apiKey: 'ark-key',
          baseUrl: 'https://ark.example/api/plan/v3',
          models: [{ id: 'glm', name: 'GLM', value: 'glm-5.3' }],
        },
      ],
    },
  };
}

async function withApp<T>(
  fn: (args: { baseUrl: string; configPath: string; vault: InMemorySecretVault }) => Promise<T>,
): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'models-admin-quota-'));
  const processCwd = join(root, 'server');
  mkdirSync(processCwd, { recursive: true });
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify(rawConfig(), null, 2), 'utf-8');
  const vault = new InMemorySecretVault();
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
  app.use(
    '/api/admin/models',
    createModelsAdminRouter({
      processCwd,
      config: parseAppConfig(rawConfig()),
      secretVault: vault,
    }),
  );
  const server = app.listen(0);
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('bind failed');
  return fn({ baseUrl: `http://127.0.0.1:${address.port}/api/admin/models`, configPath, vault });
}

function groupBody(quotaSource: Record<string, unknown> | undefined) {
  return {
    models: {
      default: 'ark/glm',
      allowCrossGroupSwitch: false,
      groups: [
        {
          id: 'ark',
          name: '火山 Agent Plan',
          apiKey: '',
          hasApiKey: true,
          baseUrl: 'https://ark.example/api/plan/v3',
          models: [{ id: 'glm', name: 'GLM', value: 'glm-5.3' }],
          ...(quotaSource ? { quotaSource } : {}),
        },
      ],
    },
  };
}

async function put(baseUrl: string, body: unknown) {
  return fetch(baseUrl, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('models admin router · quotaSource', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('AGENT_SAAS_ALLOW_UNIDENTIFIED_ENVIRONMENT', '1');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    while (servers.length > 0) servers.pop()?.close();
  });

  it('新 Secret 进 vault、config 只落 ref；GET 只回 hasQuotaSecret；留空保留；移除时回收 ref', async () => {
    await withApp(async ({ baseUrl, configPath, vault }) => {
      const created = await put(
        baseUrl,
        groupBody({
          provider: 'volcengine_ark_plan',
          accessKeyId: 'AKID',
          secretAccessKey: 'SK-PLAIN',
        }),
      );
      expect(created.status).toBe(200);
      const createdBody = (await created.json()) as any;
      expect(createdBody.models.groups[0].quotaSource).toEqual({
        provider: 'volcengine_ark_plan',
        accessKeyId: 'AKID',
        region: 'cn-beijing',
        hasQuotaSecret: true,
      });

      const persisted = JSON.parse(readFileSync(configPath, 'utf-8'));
      const source = persisted.models.groups[0].quotaSource;
      expect(source.secretAccessKey).toBeUndefined();
      expect(source.secretAccessKeyRef).toMatch(/\S/u);
      expect(source.accessKeyId).toBe('AKID');
      expect(persisted.models.groups[0].apiKey).toBe('ark-key');
      await expect(
        vault.getSecret(source.secretAccessKeyRef, {
          actor: 'system',
          userId: '__system__',
          scopes: ['secret:models:read'],
        }),
      ).resolves.toBe('SK-PLAIN');

      const listed = await fetch(baseUrl);
      expect(((await listed.json()) as any).models.groups[0].quotaSource).toEqual({
        provider: 'volcengine_ark_plan',
        accessKeyId: 'AKID',
        region: 'cn-beijing',
        hasQuotaSecret: true,
      });

      // 留空 Secret + 改 AK：ref 保留不变
      const kept = await put(
        baseUrl,
        groupBody({
          provider: 'volcengine_ark_plan',
          accessKeyId: 'AKID-2',
          secretAccessKey: '',
          hasQuotaSecret: true,
          region: 'cn-beijing',
        }),
      );
      expect(kept.status).toBe(200);
      const keptPersisted = JSON.parse(readFileSync(configPath, 'utf-8')).models.groups[0]
        .quotaSource;
      expect(keptPersisted).toEqual({
        provider: 'volcengine_ark_plan',
        accessKeyId: 'AKID-2',
        region: 'cn-beijing',
        secretAccessKeyRef: source.secretAccessKeyRef,
      });

      // 换新 Secret：旧 ref 被回收
      const rotated = await put(
        baseUrl,
        groupBody({
          provider: 'volcengine_ark_plan',
          accessKeyId: 'AKID-2',
          secretAccessKey: 'SK-NEW',
        }),
      );
      expect(rotated.status).toBe(200);
      const rotatedRef = JSON.parse(readFileSync(configPath, 'utf-8')).models.groups[0].quotaSource
        .secretAccessKeyRef;
      expect(rotatedRef).not.toBe(source.secretAccessKeyRef);
      await expect(
        vault.getSecret(source.secretAccessKeyRef, {
          actor: 'system',
          userId: '__system__',
          scopes: ['secret:models:read'],
        }),
      ).rejects.toThrow();

      // 移除 quotaSource：config 不再有该字段，ref 回收
      const removed = await put(baseUrl, groupBody(undefined));
      expect(removed.status).toBe(200);
      expect(
        JSON.parse(readFileSync(configPath, 'utf-8')).models.groups[0].quotaSource,
      ).toBeUndefined();
      await expect(
        vault.getSecret(rotatedRef, {
          actor: 'system',
          userId: '__system__',
          scopes: ['secret:models:read'],
        }),
      ).rejects.toThrow();
    });
  });

  it('首次配置未提供 Secret 时 400，且不写配置', async () => {
    await withApp(async ({ baseUrl, configPath }) => {
      const response = await put(
        baseUrl,
        groupBody({ provider: 'volcengine_ark_plan', accessKeyId: 'AKID' }),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: expect.stringContaining('缺少 Secret Access Key'),
      });
      expect(
        JSON.parse(readFileSync(configPath, 'utf-8')).models.groups[0].quotaSource,
      ).toBeUndefined();
    });
  });
});

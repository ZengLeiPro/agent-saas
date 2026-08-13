import express from 'express';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseAppConfig } from '../app/config.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import { createAudioTranscribeAdminRouter } from '../routes/audioTranscribeAdmin.js';
import { InMemorySecretVault } from '../security/secretVault.js';

const servers: Array<{ close: () => void }> = [];
const roots: string[] = [];

function baseRawConfig() {
  return {
    agent: { cwd: '/tmp/agent' },
    server: { port: 3200 },
    stt: {
      enabled: true,
      apiKeyRef: 'dashscope-ref',
      ossAccessKeyIdRef: 'oss-id-ref',
      ossAccessKeySecretRef: 'oss-secret-ref',
      model: 'fun-asr',
      ossBucket: 'audio-bucket',
      ossEndpoint: 'https://oss-cn-hangzhou.aliyuncs.com',
      pricing: { creditsPerCall: 12, costYuanPerCall: 0.08 },
      audioTranscribeTenantIds: ['legacy-tenant'],
    },
  };
}

async function withApp<T>(
  rawConfig: Record<string, unknown>,
  fn: (args: {
    baseUrl: string;
    configPath: string;
    runtimeConfig: ReturnType<typeof parseAppConfig>;
    secretVault: InMemorySecretVault;
    validate: ReturnType<typeof vi.fn>;
    onUpdated: ReturnType<typeof vi.fn>;
  }) => Promise<T>,
): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'audio-transcribe-admin-'));
  roots.push(root);
  const processCwd = join(root, 'server');
  mkdirSync(processCwd, { recursive: true });
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, `// keep this comment\n${JSON.stringify(rawConfig, null, 2)}\n`, 'utf-8');

  const runtimeConfig = parseAppConfig(rawConfig);
  const secretVault = new InMemorySecretVault();
  const validate = vi.fn(async () => undefined);
  const onUpdated = vi.fn(async () => undefined);
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
  app.use('/api/admin/audio-transcribe', createAudioTranscribeAdminRouter({
    processCwd,
    config: runtimeConfig,
    secretVault,
    validate,
    onUpdated,
  }));

  const server = app.listen(0);
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind test server');
  return fn({
    baseUrl: `http://127.0.0.1:${address.port}`,
    configPath,
    runtimeConfig,
    secretVault,
    validate,
    onUpdated,
  });
}

async function readJson(response: Response) {
  return response.json() as Promise<any>;
}

afterEach(() => {
  while (servers.length > 0) servers.pop()?.close();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('audio transcribe admin router', () => {
  it('GET returns only configured booleans for secrets plus pricing and status', async () => {
    await withApp(baseRawConfig(), async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/admin/audio-transcribe`);
      expect(response.status).toBe(200);
      const body = await readJson(response);
      expect(body).toEqual({
        config: {
          enabled: true,
          model: 'fun-asr',
          ossBucket: 'audio-bucket',
          ossEndpoint: 'https://oss-cn-hangzhou.aliyuncs.com',
          apiKeyConfigured: true,
          ossAccessKeyIdConfigured: true,
          ossAccessKeySecretConfigured: true,
        },
        pricing: { creditsPerCall: 12, costYuanPerCall: 0.08 },
        status: {
          available: true,
          platformEnabled: true,
          toolEnabled: true,
          credentialsConfigured: true,
        },
      });
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain('dashscope-ref');
      expect(serialized).not.toContain('oss-id-ref');
      expect(serialized).not.toContain('oss-secret-ref');
      expect(serialized).not.toContain('apiKeyRef');
    });
  });

  it('PUT stores all new secrets in SecretVault, persists refs and hot-updates runtime', async () => {
    await withApp(baseRawConfig(), async ({
      baseUrl,
      configPath,
      runtimeConfig,
      secretVault,
      validate,
      onUpdated,
    }) => {
      const response = await fetch(`${baseUrl}/api/admin/audio-transcribe`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: {
            enabled: true,
            model: 'fun-asr-realtime',
            apiKey: 'dashscope-new',
            ossAccessKeyId: 'oss-id-new',
            ossAccessKeySecret: 'oss-secret-new',
            ossBucket: 'new-bucket',
            ossEndpoint: 'https://oss-cn-shanghai.aliyuncs.com',
          },
          pricing: { creditsPerCall: 20, costYuanPerCall: 0.12 },
        }),
      });
      expect(response.status).toBe(200);
      const body = await readJson(response);
      expect(JSON.stringify(body)).not.toMatch(/dashscope-new|oss-id-new|oss-secret-new/);

      const text = readFileSync(configPath, 'utf-8');
      expect(text).toContain('// keep this comment');
      expect(text).not.toMatch(/dashscope-new|oss-id-new|oss-secret-new/);
      const onDisk = parseAppConfig((await import('jsonc-parser')).parse(text));
      expect(onDisk.stt).toMatchObject({
        enabled: true,
        model: 'fun-asr-realtime',
        ossBucket: 'new-bucket',
        ossEndpoint: 'https://oss-cn-shanghai.aliyuncs.com',
        pricing: { creditsPerCall: 20, costYuanPerCall: 0.12 },
        audioTranscribeTenantIds: ['legacy-tenant'],
      });
      expect(onDisk.stt?.apiKey).toBeUndefined();
      expect(onDisk.stt?.ossAccessKeyId).toBeUndefined();
      expect(onDisk.stt?.ossAccessKeySecret).toBeUndefined();

      const reader = { actor: 'system' as const, userId: '__system__', scopes: ['secret:stt:read'] };
      await expect(secretVault.getSecret(onDisk.stt!.apiKeyRef!, reader)).resolves.toBe('dashscope-new');
      await expect(secretVault.getSecret(onDisk.stt!.ossAccessKeyIdRef!, reader)).resolves.toBe('oss-id-new');
      await expect(secretVault.getSecret(onDisk.stt!.ossAccessKeySecretRef!, reader)).resolves.toBe('oss-secret-new');
      expect(runtimeConfig.stt).toEqual(onDisk.stt);
      expect(validate).toHaveBeenCalledWith(runtimeConfig.stt);
      expect(onUpdated).toHaveBeenCalledWith(runtimeConfig.stt);
    });
  });

  it('empty strings preserve old refs and explicit null clears the selected secret', async () => {
    await withApp(baseRawConfig(), async ({ baseUrl, configPath, secretVault }) => {
      const putSecret = vi.spyOn(secretVault, 'putSecret');
      const response = await fetch(`${baseUrl}/api/admin/audio-transcribe`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: {
            enabled: false,
            DASHSCOPE_API_KEY: '',
            OSS_ACCESS_KEY_ID: null,
            OSS_ACCESS_KEY_SECRET: '',
            OSS_BUCKET: 'audio-bucket',
            OSS_ENDPOINT: 'https://oss-cn-hangzhou.aliyuncs.com',
          },
          pricing: { creditsPerCall: 12, costYuanPerCall: 0.08 },
        }),
      });
      expect(response.status).toBe(200);
      const body = await readJson(response);
      expect(body.config.apiKeyConfigured).toBe(true);
      expect(body.config.ossAccessKeyIdConfigured).toBe(false);
      expect(body.config.ossAccessKeySecretConfigured).toBe(true);
      const onDisk = (await import('jsonc-parser')).parse(readFileSync(configPath, 'utf-8')) as any;
      expect(onDisk.stt.apiKeyRef).toBe('dashscope-ref');
      expect(onDisk.stt.ossAccessKeyIdRef).toBeUndefined();
      expect(onDisk.stt.ossAccessKeySecretRef).toBe('oss-secret-ref');
      expect(putSecret).not.toHaveBeenCalled();
    });
  });

  it('rejects enabling the tool with incomplete credentials before writing secrets', async () => {
    await withApp({ agent: { cwd: '/tmp/agent' }, server: { port: 3200 } }, async ({
      baseUrl,
      configPath,
      secretVault,
      validate,
      onUpdated,
    }) => {
      const before = readFileSync(configPath, 'utf-8');
      const putSecret = vi.spyOn(secretVault, 'putSecret');
      const response = await fetch(`${baseUrl}/api/admin/audio-transcribe`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: { enabled: true, apiKey: 'only-one-secret' },
          pricing: { creditsPerCall: 10, costYuanPerCall: 0.08 },
        }),
      });
      expect(response.status).toBe(400);
      expect((await readJson(response)).error).toContain('OSS_ACCESS_KEY_ID');
      expect(readFileSync(configPath, 'utf-8')).toBe(before);
      expect(putSecret).not.toHaveBeenCalled();
      expect(validate).not.toHaveBeenCalled();
      expect(onUpdated).not.toHaveBeenCalled();
    });
  });

  it('rejects negative fixed pricing before writing config or secrets', async () => {
    await withApp(baseRawConfig(), async ({ baseUrl, configPath, secretVault, validate, onUpdated }) => {
      const before = readFileSync(configPath, 'utf-8');
      const putSecret = vi.spyOn(secretVault, 'putSecret');
      const response = await fetch(`${baseUrl}/api/admin/audio-transcribe`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: {
            DASHSCOPE_API_KEY: 'must-not-save',
          },
          pricing: { creditsPerCall: -1, costYuanPerCall: 0.08 },
        }),
      });
      expect(response.status).toBe(400);
      expect((await readJson(response)).error).toContain('creditsPerCall');
      expect(readFileSync(configPath, 'utf-8')).toBe(before);
      expect(putSecret).not.toHaveBeenCalled();
      expect(validate).not.toHaveBeenCalled();
      expect(onUpdated).not.toHaveBeenCalled();
    });
  });
});

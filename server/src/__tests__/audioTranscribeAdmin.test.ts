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
    onConfigReloaded: ReturnType<typeof vi.fn>;
  }) => Promise<T>,
  opts: Partial<Parameters<typeof createAudioTranscribeAdminRouter>[0]> = {},
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
  const onConfigReloaded = vi.fn(async () => undefined);
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
    onConfigReloaded,
    ...opts,
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
    onConfigReloaded,
  });
}

async function readJson(response: Response) {
  return response.json() as Promise<any>;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => {
  while (servers.length > 0) servers.pop()?.close();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('audio transcribe admin router', () => {
  it('GET returns only configured booleans for secrets, pricing, and status', async () => {
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
      onConfigReloaded,
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
      expect(onConfigReloaded).toHaveBeenCalledWith(text);
    });
  });

  it('force full baseline preserves an unloaded field and publishes identity from complete runtime config', async () => {
    const diskConfig: Record<string, unknown> = {
      ...baseRawConfig(),
      toolControls: { tools: { Shell: { enabled: false } } },
    };
    const staleRuntimeConfig = parseAppConfig(baseRawConfig());
    let identityToolControls: unknown;
    const ensureConfigBaselineApplied = vi.fn(async (expectedText: string) => {
      Object.assign(staleRuntimeConfig, parseAppConfig((await import('jsonc-parser')).parse(expectedText)));
      return true;
    });
    const onConfigReloaded = vi.fn(async () => {
      identityToolControls = structuredClone(staleRuntimeConfig.toolControls);
    });

    await withApp(diskConfig, async ({ baseUrl, configPath }) => {
      const before = readFileSync(configPath, 'utf-8');
      const response = await fetch(`${baseUrl}/api/admin/audio-transcribe`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: { model: 'baseline-aware-stt' } }),
      });

      expect(response.status).toBe(200);
      expect(ensureConfigBaselineApplied).toHaveBeenCalledWith(before);
      expect(parseAppConfig((await import('jsonc-parser')).parse(
        readFileSync(configPath, 'utf-8'),
      )).toolControls?.tools?.Shell?.enabled).toBe(false);
      expect(staleRuntimeConfig.toolControls?.tools?.Shell?.enabled).toBe(false);
      expect(identityToolControls).toEqual(staleRuntimeConfig.toolControls);
    }, { config: staleRuntimeConfig, ensureConfigBaselineApplied, onConfigReloaded });
  });

  it('baseline false rejects before secret, validation, runtime, disk, or identity side effects', async () => {
    const staleRuntimeConfig = parseAppConfig(baseRawConfig());
    const secretVault = new InMemorySecretVault();
    const putSecret = vi.spyOn(secretVault, 'putSecret');
    const validate = vi.fn();
    const onUpdated = vi.fn();
    const onConfigReloaded = vi.fn();
    const ensureConfigBaselineApplied = vi.fn(async () => false);

    await withApp(baseRawConfig(), async ({ baseUrl, configPath }) => {
      const before = readFileSync(configPath, 'utf-8');
      const response = await fetch(`${baseUrl}/api/admin/audio-transcribe`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: { model: 'rejected-stt', apiKey: 'must-not-store' } }),
      });

      expect(response.status).toBe(400);
      expect(readFileSync(configPath, 'utf-8')).toBe(before);
      expect(staleRuntimeConfig.stt?.model).toBe('fun-asr');
      expect(putSecret).not.toHaveBeenCalled();
      expect(validate).not.toHaveBeenCalled();
      expect(onUpdated).not.toHaveBeenCalled();
      expect(onConfigReloaded).not.toHaveBeenCalled();
    }, {
      config: staleRuntimeConfig, secretVault, validate, onUpdated,
      onConfigReloaded, ensureConfigBaselineApplied,
    });
  });

  it('file change during baseline returns 409 before secret or callbacks', async () => {
    const secretVault = new InMemorySecretVault();
    const putSecret = vi.spyOn(secretVault, 'putSecret');
    const validate = vi.fn();
    const onUpdated = vi.fn();
    const onConfigReloaded = vi.fn();
    let configPathForBaseline = '';
    const ensureConfigBaselineApplied = vi.fn(async () => {
      writeFileSync(configPathForBaseline, JSON.stringify({ ...baseRawConfig(), concurrentWinner: true }), 'utf-8');
      return true;
    });

    await withApp(baseRawConfig(), async ({ baseUrl, configPath, runtimeConfig }) => {
      configPathForBaseline = configPath;
      const response = await fetch(`${baseUrl}/api/admin/audio-transcribe`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: { model: 'loser-stt', apiKey: 'must-not-store' } }),
      });

      expect(response.status).toBe(409);
      expect(JSON.parse(readFileSync(configPath, 'utf-8')).concurrentWinner).toBe(true);
      expect(runtimeConfig.stt?.model).toBe('fun-asr');
      expect(putSecret).not.toHaveBeenCalled();
      expect(validate).not.toHaveBeenCalled();
      expect(onUpdated).not.toHaveBeenCalled();
      expect(onConfigReloaded).not.toHaveBeenCalled();
    }, { secretVault, validate, onUpdated, onConfigReloaded, ensureConfigBaselineApplied });
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

  it('callback 失败时回滚执行侧且不提交磁盘或 AppConfig', async () => {
    await withApp(baseRawConfig(), async ({ baseUrl, configPath, runtimeConfig, onUpdated }) => {
      const before = readFileSync(configPath, 'utf-8');
      let executionStt = structuredClone(runtimeConfig.stt);
      onUpdated.mockImplementation(async (next) => {
        executionStt = structuredClone(next);
        if (next?.model === 'candidate-that-fails') throw new Error('STT runtime callback failed');
      });

      const response = await fetch(`${baseUrl}/api/admin/audio-transcribe`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: { model: 'candidate-that-fails' } }),
      });

      expect(response.status).toBe(500);
      expect(readFileSync(configPath, 'utf-8')).toBe(before);
      expect(runtimeConfig.stt?.model).toBe('fun-asr');
      expect(executionStt?.model).toBe('fun-asr');
      expect(onUpdated).toHaveBeenCalledTimes(2);
    });
  });

  it('SecretVault 第二次解析失败时不发布候选 STT', async () => {
    const rawConfig = baseRawConfig();
    rawConfig.stt = {
      ...rawConfig.stt,
      apiKey: 'old-dashscope',
      ossAccessKeyId: 'old-oss-id',
      ossAccessKeySecret: 'old-oss-secret',
    } as typeof rawConfig.stt & Record<string, unknown>;
    delete (rawConfig.stt as Record<string, unknown>).apiKeyRef;
    delete (rawConfig.stt as Record<string, unknown>).ossAccessKeyIdRef;
    delete (rawConfig.stt as Record<string, unknown>).ossAccessKeySecretRef;

    await withApp(rawConfig, async ({
      baseUrl, configPath, runtimeConfig, secretVault, validate, onUpdated,
    }) => {
      const before = readFileSync(configPath, 'utf-8');
      const originalGetSecret = secretVault.getSecret.bind(secretVault);
      let secretReads = 0;
      vi.spyOn(secretVault, 'getSecret').mockImplementation(async (secretId, context) => {
        secretReads += 1;
        if (secretReads === 4) throw new Error('SecretVault second resolution failed');
        return originalGetSecret(secretId, context);
      });
      const resolveRefs = async (next: typeof runtimeConfig.stt) => {
        for (const ref of [next?.apiKeyRef, next?.ossAccessKeyIdRef, next?.ossAccessKeySecretRef]) {
          if (ref) await secretVault.getSecret(ref, {
            actor: 'system', userId: '__system__', scopes: ['secret:stt:read'],
          });
        }
      };
      validate.mockImplementation(resolveRefs);
      onUpdated.mockImplementation(resolveRefs);

      const response = await fetch(`${baseUrl}/api/admin/audio-transcribe`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: {
            model: 'new-stt-model',
            apiKey: 'new-dashscope',
            ossAccessKeyId: 'new-oss-id',
            ossAccessKeySecret: 'new-oss-secret',
          },
        }),
      });

      expect(response.status).toBe(500);
      expect(readFileSync(configPath, 'utf-8')).toBe(before);
      expect(runtimeConfig.stt?.model).toBe('fun-asr');
      expect(validate).toHaveBeenCalledOnce();
      expect(onUpdated).toHaveBeenCalledTimes(2);
    });
  });

  it('CAS 冲突不推进 ConfigIdentity，且不覆盖并发胜出版本', async () => {
    await withApp(baseRawConfig(), async ({
      baseUrl, configPath, runtimeConfig, validate, onUpdated, onConfigReloaded,
    }) => {
      validate.mockImplementation(async () => {
        writeFileSync(configPath, JSON.stringify({ ...baseRawConfig(), concurrentWinner: true }), 'utf-8');
      });

      const response = await fetch(`${baseUrl}/api/admin/audio-transcribe`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: { model: 'losing-stt-candidate' } }),
      });

      expect(response.status).toBe(409);
      expect(JSON.parse(readFileSync(configPath, 'utf-8')).concurrentWinner).toBe(true);
      expect(runtimeConfig.stt?.model).toBe('fun-asr');
      expect(onUpdated).not.toHaveBeenCalled();
      expect(onConfigReloaded).not.toHaveBeenCalled();
    });
  });

  it('ConfigIdentity 发布失败时响应 fail closed，但 durable commit 保持可刷新', async () => {
    const onConfigReloaded = vi.fn(async () => {
      throw new Error('配置文件被并发改写且重载失败');
    });
    await withApp(baseRawConfig(), async ({ baseUrl, configPath }) => {
      const response = await fetch(`${baseUrl}/api/admin/audio-transcribe`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: { model: 'durably-committed-stt' } }),
      });

      expect(response.status).toBe(500);
      expect(parseAppConfig((await import('jsonc-parser')).parse(
        readFileSync(configPath, 'utf-8'),
      )).stt?.model).toBe('durably-committed-stt');
      expect(onConfigReloaded).toHaveBeenCalledOnce();
    }, { onConfigReloaded });
  });

  it('两个管理员交错保存时锁内 callback 未完成前拒绝另一写入', async () => {
    await withApp(baseRawConfig(), async ({ baseUrl, configPath, runtimeConfig, onUpdated }) => {
      const firstBlocked = deferred();
      const firstEntered = deferred();
      onUpdated.mockImplementation(async (next) => {
        if (next?.model === 'admin-a-model') {
          firstEntered.resolve();
          await firstBlocked.promise;
        }
      });

      const firstRequest = fetch(`${baseUrl}/api/admin/audio-transcribe`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: { model: 'admin-a-model' } }),
      });
      await firstEntered.promise;
      const secondResponse = await fetch(`${baseUrl}/api/admin/audio-transcribe`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: { model: 'admin-b-model' } }),
      });
      expect(secondResponse.status).toBe(409);

      firstBlocked.resolve();
      expect((await firstRequest).status).toBe(200);
      expect(parseAppConfig((await import('jsonc-parser')).parse(readFileSync(configPath, 'utf-8'))).stt?.model)
        .toBe('admin-a-model');
      expect(runtimeConfig.stt?.model).toBe('admin-a-model');
    });
  });
});

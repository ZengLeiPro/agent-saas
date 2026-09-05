import express from 'express';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

// 用于精确卡住 runtime 或 Secret ref 回收阶段，验证配置锁边界。
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => {
  vi.unstubAllEnvs();
  while (servers.length > 0) servers.pop()?.close();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('audio transcribe admin router', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('AGENT_SAAS_ALLOW_UNIDENTIFIED_ENVIRONMENT', '1');
  });

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

  it('PUT stores new secrets, hot-updates runtime, and reclaims replaced refs', async () => {
    await withApp(baseRawConfig(), async ({
      baseUrl,
      configPath,
      runtimeConfig,
      secretVault,
      validate,
      onUpdated,
      onConfigReloaded,
    }) => {
      const revokeSecret = vi.spyOn(secretVault, 'revokeSecret');
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
      expect(revokeSecret).toHaveBeenCalledWith('dashscope-ref', expect.any(Object));
      expect(revokeSecret).toHaveBeenCalledWith('oss-id-ref', expect.any(Object));
      expect(revokeSecret).toHaveBeenCalledWith('oss-secret-ref', expect.any(Object));
    });
  });

  it('revokes the first staged STT ref when a later vault put fails', async () => {
    await withApp(baseRawConfig(), async ({ baseUrl, configPath, secretVault, validate, onUpdated }) => {
      const before = readFileSync(configPath, 'utf-8');
      const originalPut = secretVault.putSecret.bind(secretVault);
      const created: string[] = [];
      let puts = 0;
      vi.spyOn(secretVault, 'putSecret').mockImplementation(async (...args) => {
        puts += 1;
        if (puts === 2) throw new Error('second STT vault put failed');
        const ref = await originalPut(...args);
        created.push(ref.id);
        return ref;
      });

      const response = await fetch(`${baseUrl}/api/admin/audio-transcribe`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: {
          apiKey: 'new-stt-key',
          ossAccessKeyId: 'new-oss-id',
          ossAccessKeySecret: 'new-oss-secret',
        } }),
      });

      expect(response.status).toBe(400);
      expect(readFileSync(configPath, 'utf-8')).toBe(before);
      expect(validate).not.toHaveBeenCalled();
      expect(onUpdated).not.toHaveBeenCalled();
      expect(created).toHaveLength(1);
      await expect(secretVault.getSecret(created[0]!, {
        actor: 'system', userId: '__system__', scopes: ['secret:stt:read'],
      })).rejects.toThrow('secret revoked');
    });
  });

  it('revokes staged STT refs when post-ref validation fails without leaking them', async () => {
    await withApp(baseRawConfig(), async ({ baseUrl, secretVault, validate, onUpdated }) => {
      const originalPut = secretVault.putSecret.bind(secretVault);
      const created: string[] = [];
      vi.spyOn(secretVault, 'putSecret').mockImplementation(async (...args) => {
        const ref = await originalPut(...args);
        created.push(ref.id);
        return ref;
      });
      validate.mockRejectedValue(new Error('candidate ref validation failed'));

      const response = await fetch(`${baseUrl}/api/admin/audio-transcribe`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: { apiKey: 'validation-secret' } }),
      });

      expect(response.status).toBe(400);
      expect(onUpdated).not.toHaveBeenCalled();
      expect(created).toHaveLength(1);
      const responseText = await response.text();
      expect(responseText).not.toContain(created[0]);
      expect(responseText).not.toContain('validation-secret');
      await expect(secretVault.getSecret(created[0]!, {
        actor: 'system', userId: '__system__', scopes: ['secret:stt:read'],
      })).rejects.toThrow('secret revoked');
    });
  });

  it('no-op save reconciles refs and response from the mutation result instead of stale runtime config', async () => {
    const staleRuntimeConfig = parseAppConfig(baseRawConfig());
    if (staleRuntimeConfig.stt) staleRuntimeConfig.stt.apiKeyRef = undefined;
    const secretVault = new InMemorySecretVault();
    const revokeSecret = vi.spyOn(secretVault, 'revokeSecret');
    const onUpdated = vi.fn();

    await withApp(baseRawConfig(), async ({ baseUrl, configPath }) => {
      const before = readFileSync(configPath, 'utf-8');
      const response = await fetch(`${baseUrl}/api/admin/audio-transcribe`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: { model: 'fun-asr' } }),
      });

      expect(response.status).toBe(200);
      expect(readFileSync(configPath, 'utf-8')).toBe(before);
      expect(onUpdated).not.toHaveBeenCalled();
      expect(revokeSecret).not.toHaveBeenCalled();
      expect((await readJson(response)).config.apiKeyConfigured).toBe(true);
    }, { config: staleRuntimeConfig, secretVault, onUpdated });
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

  it('empty strings preserve old refs and explicit null reclaims only the cleared secret', async () => {
    await withApp(baseRawConfig(), async ({ baseUrl, configPath, secretVault }) => {
      const putSecret = vi.spyOn(secretVault, 'putSecret');
      const revokeSecret = vi.spyOn(secretVault, 'revokeSecret');
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
      expect(revokeSecret).toHaveBeenCalledOnce();
      expect(revokeSecret).toHaveBeenCalledWith('oss-id-ref', expect.any(Object));
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

  it('callback 失败且完整恢复时撤销候选 ref，并回滚执行侧、磁盘与 AppConfig', async () => {
    await withApp(baseRawConfig(), async ({ baseUrl, configPath, runtimeConfig, secretVault, onUpdated }) => {
      const before = readFileSync(configPath, 'utf-8');
      const originalPut = secretVault.putSecret.bind(secretVault);
      const created: string[] = [];
      vi.spyOn(secretVault, 'putSecret').mockImplementation(async (...args) => {
        const ref = await originalPut(...args);
        created.push(ref.id);
        return ref;
      });
      let executionStt = structuredClone(runtimeConfig.stt);
      onUpdated.mockImplementation(async (next) => {
        executionStt = structuredClone(next);
        if (next?.model === 'candidate-that-fails') throw new Error('STT runtime callback failed');
      });

      const response = await fetch(`${baseUrl}/api/admin/audio-transcribe`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: { model: 'candidate-that-fails', apiKey: 'candidate-stt-secret' } }),
      });

      expect(response.status).toBe(500);
      expect(readFileSync(configPath, 'utf-8')).toBe(before);
      expect(runtimeConfig.stt?.model).toBe('fun-asr');
      expect(executionStt?.model).toBe('fun-asr');
      expect(onUpdated).toHaveBeenCalledTimes(2);
      expect(created).toHaveLength(1);
      await expect(secretVault.getSecret(created[0]!, {
        actor: 'system', userId: '__system__', scopes: ['secret:stt:read'],
      })).rejects.toThrow('secret revoked');
    });
  });

  it('RuntimeRestoreFailedError 时保守保留可能仍在运行的 STT 候选 ref', async () => {
    await withApp(baseRawConfig(), async ({ baseUrl, secretVault, onUpdated }) => {
      const originalPut = secretVault.putSecret.bind(secretVault);
      const created: string[] = [];
      vi.spyOn(secretVault, 'putSecret').mockImplementation(async (...args) => {
        const ref = await originalPut(...args);
        created.push(ref.id);
        return ref;
      });
      onUpdated.mockRejectedValue(new Error('runtime apply and restore both fail'));

      const response = await fetch(`${baseUrl}/api/admin/audio-transcribe`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: { model: 'unsafe-runtime', apiKey: 'retain-stt-secret' } }),
      });

      expect(response.status).toBe(500);
      expect(onUpdated).toHaveBeenCalledTimes(2);
      expect(created).toHaveLength(1);
      await expect(secretVault.getSecret(created[0]!, {
        actor: 'system', userId: '__system__', scopes: ['secret:stt:read'],
      })).resolves.toBe('retain-stt-secret');
      expect(JSON.stringify(await readJson(response))).not.toContain(created[0]);
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

  it('CAS 冲突撤销候选 ref，不推进 ConfigIdentity 且不覆盖并发胜出版本', async () => {
    await withApp(baseRawConfig(), async ({
      baseUrl, configPath, runtimeConfig, secretVault, validate, onUpdated, onConfigReloaded,
    }) => {
      const originalPut = secretVault.putSecret.bind(secretVault);
      const created: string[] = [];
      vi.spyOn(secretVault, 'putSecret').mockImplementation(async (...args) => {
        const ref = await originalPut(...args);
        created.push(ref.id);
        return ref;
      });
      validate.mockImplementation(async () => {
        writeFileSync(configPath, JSON.stringify({ ...baseRawConfig(), concurrentWinner: true }), 'utf-8');
      });

      const response = await fetch(`${baseUrl}/api/admin/audio-transcribe`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: { model: 'losing-stt-candidate', apiKey: 'losing-stt-secret' } }),
      });

      expect(response.status).toBe(409);
      expect(JSON.parse(readFileSync(configPath, 'utf-8')).concurrentWinner).toBe(true);
      expect(runtimeConfig.stt?.model).toBe('fun-asr');
      expect(onUpdated).not.toHaveBeenCalled();
      expect(onConfigReloaded).not.toHaveBeenCalled();
      expect(created).toHaveLength(1);
      await expect(secretVault.getSecret(created[0]!, {
        actor: 'system', userId: '__system__', scopes: ['secret:stt:read'],
      })).rejects.toThrow('secret revoked');
    });
  });

  it('ConfigIdentity 发布失败时按 committed 契约保留新 ref 并只回收已替换旧 ref', async () => {
    let committedRef = '';
    const onConfigReloaded = vi.fn(async (text: string) => {
      committedRef = parseAppConfig((await import('jsonc-parser')).parse(text)).stt?.apiKeyRef ?? '';
      throw new Error(`配置发布失败 ${committedRef} durably-committed-secret`);
    });
    await withApp(baseRawConfig(), async ({ baseUrl, configPath, secretVault }) => {
      const revokeSecret = vi.spyOn(secretVault, 'revokeSecret');
      const response = await fetch(`${baseUrl}/api/admin/audio-transcribe`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: { model: 'durably-committed-stt', apiKey: 'durably-committed-secret' },
        }),
      });

      expect(response.status).toBe(500);
      const responseText = await response.text();
      expect(responseText).not.toContain('durably-committed-secret');
      expect(responseText).not.toContain(committedRef);
      const onDisk = parseAppConfig((await import('jsonc-parser')).parse(
        readFileSync(configPath, 'utf-8'),
      ));
      expect(onDisk.stt?.model).toBe('durably-committed-stt');
      expect(onDisk.stt?.apiKeyRef).toBe(committedRef);
      await expect(secretVault.getSecret(committedRef, {
        actor: 'system', userId: '__system__', scopes: ['secret:stt:read'],
      })).resolves.toBe('durably-committed-secret');
      expect(revokeSecret).toHaveBeenCalledOnce();
      expect(revokeSecret).toHaveBeenCalledWith('dashscope-ref', expect.any(Object));
      expect(onConfigReloaded).toHaveBeenCalledOnce();
    }, { onConfigReloaded });
  });

  it('旧 STT ref 成功回收完成前持续持有配置锁，拒绝并发重新引用窗口', async () => {
    await withApp(baseRawConfig(), async ({ baseUrl, configPath, secretVault }) => {
      const revokeEntered = deferred();
      const releaseRevoke = deferred();
      const revokeSecret = secretVault.revokeSecret.bind(secretVault);
      vi.spyOn(secretVault, 'revokeSecret').mockImplementation(async (ref, caller) => {
        if (ref === 'dashscope-ref') {
          revokeEntered.resolve();
          await releaseRevoke.promise;
        }
        if (ref === 'dashscope-ref') return;
        return revokeSecret(ref, caller);
      });

      const firstRequest = fetch(`${baseUrl}/api/admin/audio-transcribe`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: { apiKey: 'replacement-stt-secret' } }),
      });
      await revokeEntered.promise;

      const concurrentResponse = await fetch(`${baseUrl}/api/admin/audio-transcribe`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: { model: 'concurrent-model' } }),
      });
      expect(concurrentResponse.status).toBe(409);

      releaseRevoke.resolve();
      expect((await firstRequest).status).toBe(200);
      const committed = parseAppConfig((await import('jsonc-parser')).parse(
        readFileSync(configPath, 'utf-8'),
      ));
      expect(committed.stt?.apiKeyRef).toBeTruthy();
      expect(committed.stt?.apiKeyRef).not.toBe('dashscope-ref');
      expect(committed.stt?.model).toBe('fun-asr');
    });
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

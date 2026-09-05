import { describe, expect, it, vi } from 'vitest';

import { appConfigSchema } from '../app/config.js';
import { resolveSttRuntimeConfig } from '../runtime/sttRuntimeConfig.js';
import { InMemorySecretVault, tenantOwnerId } from '../security/secretVault.js';

describe('resolveSttRuntimeConfig', () => {
  it('只向显式允许的租户注入 audio-transcribe 环境变量', async () => {
    const vault = new InMemorySecretVault();
    const resolved = await resolveSttRuntimeConfig({
      apiKey: 'dashscope-key',
      ossAccessKeyId: 'oss-ak',
      ossAccessKeySecret: 'oss-sk',
      ossBucket: 'audio-bucket',
      audioTranscribeTenantIds: ['kaiyan', 'kaiyan'],
    }, vault);

    expect(resolved.sttConfig).toMatchObject({
      apiKey: 'dashscope-key',
      ossAccessKeyId: 'oss-ak',
      ossAccessKeySecret: 'oss-sk',
      ossBucket: 'audio-bucket',
    });
    expect(resolved.audioTranscribeEnvByTenant.get('kaiyan')).toEqual({
      DASHSCOPE_API_KEY: 'dashscope-key',
      OSS_ACCESS_KEY_ID: 'oss-ak',
      OSS_ACCESS_KEY_SECRET: 'oss-sk',
      OSS_BUCKET: 'audio-bucket',
      OSS_ENDPOINT: 'https://oss-cn-shenzhen.aliyuncs.com',
    });
    expect(resolved.audioTranscribeEnvByTenant.get('customer-a')).toBeUndefined();
    expect(resolved.audioTranscribeEnvByTenant.size).toBe(1);
    // 旧配置未显式开启直连工具，Web sttConfig 与旧租户注入仍保持兼容。
    expect(resolved.audioTranscribeConfig).toEqual({
      enabled: false,
      sttConfig: resolved.sttConfig,
      pricing: { creditsPerCall: 0, costYuanPerCall: 0 },
    });
  });

  it('从 SecretVault ref 解析三项凭据', async () => {
    const vault = new InMemorySecretVault();
    const owner = tenantOwnerId('kaiyan');
    const writer = { actor: 'system' as const, userId: '__system__', scopes: ['secret:stt:write'] };
    const dashscope = await vault.putSecret(owner, 'stt', 'dashscope-secret', writer);
    const accessKeyId = await vault.putSecret(owner, 'stt', 'oss-id-secret', writer);
    const accessKeySecret = await vault.putSecret(owner, 'stt', 'oss-key-secret', writer);

    const resolved = await resolveSttRuntimeConfig({
      apiKeyRef: dashscope.id,
      ossAccessKeyIdRef: accessKeyId.id,
      ossAccessKeySecretRef: accessKeySecret.id,
      audioTranscribeTenantIds: ['kaiyan'],
    }, vault);

    expect(resolved.audioTranscribeEnvByTenant.get('kaiyan')).toMatchObject({
      DASHSCOPE_API_KEY: 'dashscope-secret',
      OSS_ACCESS_KEY_ID: 'oss-id-secret',
      OSS_ACCESS_KEY_SECRET: 'oss-key-secret',
    });
  });

  it('SecretVault 二次解析失败只暴露稳定字段，不泄漏 ref 或底层错误', async () => {
    const vault = new InMemorySecretVault();
    const secretRef = 'vault://stt/ref-sensitive';
    const vaultDetail = 'upstream leaked credential detail';
    vi.spyOn(vault, 'getSecret').mockRejectedValue(new Error(vaultDetail));

    const error = await resolveSttRuntimeConfig({
      apiKeyRef: secretRef,
      ossAccessKeyId: 'inline-id',
      ossAccessKeySecret: 'inline-secret',
    }, vault).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: 'CredentialResolutionError',
      code: 'CREDENTIAL_RESOLUTION_FAILED',
      field: 'stt.apiKeyRef',
    });
    expect(String(error)).not.toContain(secretRef);
    expect(String(error)).not.toContain(vaultDetail);
  });

  it('直连工具配置不依赖旧 audioTranscribeTenantIds，并返回固定按次价格', async () => {
    const resolved = await resolveSttRuntimeConfig({
      enabled: true,
      apiKey: 'dashscope-key',
      ossAccessKeyId: 'oss-ak',
      ossAccessKeySecret: 'oss-sk',
      pricing: { creditsPerCall: 15, costYuanPerCall: 0.1 },
    }, new InMemorySecretVault());

    expect(resolved.audioTranscribeEnvByTenant.size).toBe(0);
    expect(resolved.audioTranscribeConfig).toEqual({
      enabled: true,
      sttConfig: resolved.sttConfig,
      pricing: { creditsPerCall: 15, costYuanPerCall: 0.1 },
    });
  });

  it('无配置时禁用且不报错，显式启用或旧租户注入缺凭据时 fail-fast', async () => {
    await expect(resolveSttRuntimeConfig(undefined, new InMemorySecretVault())).resolves.toEqual({
      audioTranscribeEnvByTenant: new Map(),
    });
    await expect(resolveSttRuntimeConfig({}, new InMemorySecretVault())).resolves.toEqual({
      audioTranscribeEnvByTenant: new Map(),
    });
    await expect(resolveSttRuntimeConfig({ apiKey: 'partially-cleared' }, new InMemorySecretVault())).resolves.toEqual({
      audioTranscribeEnvByTenant: new Map(),
    });
    await expect(resolveSttRuntimeConfig({ enabled: true }, new InMemorySecretVault()))
      .rejects.toThrow(/enabled=true.*凭据为空/);
    await expect(resolveSttRuntimeConfig({
      audioTranscribeTenantIds: ['kaiyan'],
    }, new InMemorySecretVault())).rejects.toThrow(/凭据为空/);
  });

  it('schema 拒绝 inline 凭据与 ref 同时出现及负数价格', () => {
    const parsed = appConfigSchema.safeParse({
      agent: {},
      server: {},
      stt: {
        apiKey: 'inline',
        apiKeyRef: 'vault-ref-id',
        ossAccessKeyId: 'id',
        ossAccessKeySecret: 'secret',
      },
    });

    expect(parsed.success).toBe(false);

    const invalidPricing = appConfigSchema.safeParse({
      agent: {},
      server: {},
      stt: {
        pricing: { creditsPerCall: -1, costYuanPerCall: 0 },
      },
    });
    expect(invalidPricing.success).toBe(false);
  });
});

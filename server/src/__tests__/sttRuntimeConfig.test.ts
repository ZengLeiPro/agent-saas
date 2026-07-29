import { describe, expect, it } from 'vitest';

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
  });

  it('从 SecretVault ref 解析三项凭据', async () => {
    const vault = new InMemorySecretVault();
    const owner = tenantOwnerId('kaiyan');
    const dashscope = await vault.putSecret(owner, 'stt', 'dashscope-secret');
    const accessKeyId = await vault.putSecret(owner, 'stt', 'oss-id-secret');
    const accessKeySecret = await vault.putSecret(owner, 'stt', 'oss-key-secret');

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

  it('配置了租户注入但缺凭据时 fail-fast', async () => {
    await expect(resolveSttRuntimeConfig({
      audioTranscribeTenantIds: ['kaiyan'],
    }, new InMemorySecretVault())).rejects.toThrow(/凭据为空/);
  });

  it('schema 拒绝 inline 凭据与 ref 同时出现', () => {
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
  });
});

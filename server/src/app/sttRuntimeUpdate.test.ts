import { describe, expect, it } from 'vitest';
import { InMemorySecretVault } from '../security/secretVault.js';
import { createSttRuntimeUpdatePreparer, type SttRuntimeUpdateTarget } from './sttRuntimeUpdate.js';

const CALLER = {
  actor: 'system' as const,
  userId: '__system__',
  scopes: ['secret:stt:write', 'secret:stt:read'],
};

describe('createSttRuntimeUpdatePreparer', () => {
  it('SecretVault 解析完成前无副作用，commit 后才替换执行侧配置', async () => {
    const vault = new InMemorySecretVault();
    const [apiKey, accessKeyId, accessKeySecret] = await Promise.all([
      vault.putSecret('global', 'stt', 'api-key', CALLER),
      vault.putSecret('global', 'stt', 'access-id', CALLER),
      vault.putSecret('global', 'stt', 'access-secret', CALLER),
    ]);
    const target: SttRuntimeUpdateTarget = {};
    const prepare = createSttRuntimeUpdatePreparer({ target, secretVault: vault });

    const commit = await prepare({
      enabled: true,
      apiKeyRef: apiKey.id,
      ossAccessKeyIdRef: accessKeyId.id,
      ossAccessKeySecretRef: accessKeySecret.id,
      pricing: { creditsPerCall: 3, costYuanPerCall: 0.08 },
    });
    expect(target.audioTranscribeTools).toBeUndefined();

    commit();
    expect(target.audioTranscribeTools?.enabled).toBe(true);
    expect(target.audioTranscribeTools?.sttConfig.apiKey).toBe('api-key');
  });

  it('SecretVault 解析失败时不返回 commit，也不修改执行侧配置', async () => {
    const target: SttRuntimeUpdateTarget = {};
    const prepare = createSttRuntimeUpdatePreparer({
      target,
      secretVault: new InMemorySecretVault(),
    });

    await expect(
      prepare({
        enabled: true,
        apiKeyRef: 'missing-api-key',
        ossAccessKeyIdRef: 'missing-access-id',
        ossAccessKeySecretRef: 'missing-access-secret',
      }),
    ).rejects.toThrow(/解析失败/u);
    expect(target.audioTranscribeTools).toBeUndefined();
  });
});

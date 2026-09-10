import { describe, expect, it } from 'vitest';

import { getImageGenEnginePricing } from '../data/usage/imageGenPricing.js';
import { InMemorySecretVault } from '../security/secretVault.js';
import { createImageGenRuntimeUpdatePreparer } from './imageGenRuntimeUpdate.js';

describe('image gen runtime update', () => {
  it('prepare 不改执行对象，commit 同时切换客户端凭据与真实价格 getter', async () => {
    const vault = new InMemorySecretVault();
    const ref = await vault.putSecret('global', 'image_gen_tools', 'candidate-key', {
      actor: 'system',
      userId: 'image_gen_config_admin',
      scopes: ['secret:image_gen_tools:write'],
    });
    const target = { imageGenTools: { enabled: true, seedream: { apiKey: 'old-key' } } };
    const prepare = createImageGenRuntimeUpdatePreparer({ target, secretVault: vault });
    const commit = await prepare({
      enabled: true,
      seedream: { enabled: true, apiKeyRef: ref.id },
      pricing: { seedream: { creditsPerImage: 77, costYuanPerImage: 0.22 } },
    });
    expect(target.imageGenTools.seedream?.apiKey).toBe('old-key');
    commit();
    expect(target.imageGenTools.seedream?.apiKey).toBe('candidate-key');
    expect(getImageGenEnginePricing('seedream')).toEqual({
      creditsPerImage: 77,
      costYuanPerImage: 0.22,
    });
  });
});

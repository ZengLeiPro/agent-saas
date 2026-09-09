import { describe, expect, it } from 'vitest';

import { GLOBAL_OWNER_ID, InMemorySecretVault } from '../security/secretVault.js';
import type { AppConfig } from './config.js';
import { resolveImageUnderstandingModelConfigs } from './imageUnderstandingModelConfigs.js';
import { assembleRuntimeModels } from './runtimeModelAssembly.js';

const vaultCaller = {
  actor: 'system' as const,
  userId: 'models_config_admin',
  scopes: ['secret:models:write'],
};

describe('assembleRuntimeModels', () => {
  it('用同一份 SecretVault 已解析快照装配主模型和公共辅助模型链', async () => {
    const secretVault = new InMemorySecretVault();
    const secret = await secretVault.putSecret(
      GLOBAL_OWNER_ID,
      'models',
      'sk-vault-model',
      vaultCaller,
    );
    const config = {
      agent: { cwd: './workspace' },
      server: { port: 3200 },
      models: {
        default: 'ark/glm',
        allowCrossGroupSwitch: true,
        groups: [
          {
            id: 'ark',
            name: 'Ark',
            apiKeyRef: secret.id,
            baseUrl: 'https://example.invalid/v3',
            protocol: 'responses',
            models: [
              { id: 'glm', name: 'GLM', value: 'glm-5.3' },
              { id: 'guard', name: 'Guard', value: 'guard-model' },
              { id: 'vision', name: 'Vision', value: 'vision-model' },
            ],
          },
        ],
        imageUnderstanding: { model: 'ark/vision', fallbackModels: [] },
      },
      titleGenerator: { model: 'ark/glm', fallbackModels: [] },
      guardrail: { model: 'ark/guard', fallbackModels: [] },
    } as AppConfig;

    const assembly = await assembleRuntimeModels({ config, secretVault });

    expect(config.models?.groups[0]?.apiKey).toBeUndefined();
    expect(assembly.resolvedModels?.groups[0]?.apiKey).toBe('sk-vault-model');
    expect(assembly.titleGeneratorConfigs[0]?.connection).toEqual({
      apiKey: 'sk-vault-model',
      baseUrl: 'https://example.invalid/v3',
    });
    expect(assembly.guardrailModelConfigs[0]?.connection).toEqual({
      apiKey: 'sk-vault-model',
      baseUrl: 'https://example.invalid/v3',
    });
    expect(resolveImageUnderstandingModelConfigs(assembly.resolvedModels)[0]?.connection).toEqual({
      apiKey: 'sk-vault-model',
      baseUrl: 'https://example.invalid/v3',
    });
  });

  it('SecretVault 引用无法解析时启动装配失败，不产生无密钥辅助链', async () => {
    const config = {
      agent: { cwd: './workspace' },
      server: { port: 3200 },
      models: {
        default: 'ark/glm',
        allowCrossGroupSwitch: true,
        groups: [
          {
            id: 'ark',
            name: 'Ark',
            apiKeyRef: 'missing-ref',
            baseUrl: 'https://example.invalid/v3',
            protocol: 'responses',
            models: [{ id: 'glm', name: 'GLM', value: 'glm-5.3' }],
          },
        ],
      },
      titleGenerator: { model: 'ark/glm', fallbackModels: [] },
    } as AppConfig;

    await expect(
      assembleRuntimeModels({
        config,
        secretVault: new InMemorySecretVault(),
      }),
    ).rejects.toThrow('models.groups[].apiKeyRef 凭据解析失败');
  });
});

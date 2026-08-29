import type { ConfigIdentitySummary } from '@agent/shared';

import type { SecretVault } from '../security/secretVault.js';
import { readRuntimeIdentity } from '../release/runtimeIdentity.js';
import { createConfigIdentityRuntime } from '../runtime/configIdentityRuntime.js';
import type { AppConfig } from './config.js';

export interface RuntimeConfigIdentityAssembly {
  modelResolverHooks: {
    validateConfigReload?: (next: AppConfig) => Promise<void>;
    onConfigReloaded: () => void;
  };
  getSummary: () => ConfigIdentitySummary;
}

/**
 * TASK-318 在 Runtime 装配层的窄接口：集中 expected/observed 初始化、
 * Production 热更新门禁与只读摘要，避免继续膨胀 runtime.ts。
 */
export async function initializeRuntimeConfigIdentityAssembly(options: {
  config: AppConfig;
  secretVault: SecretVault;
  logger: { info: (message: string) => void; warn: (message: string) => void };
}): Promise<RuntimeConfigIdentityAssembly> {
  const runtimeIdentity = readRuntimeIdentity(process.env);
  const runtime = createConfigIdentityRuntime({
    config: options.config,
    secretVault: options.secretVault,
    ...(runtimeIdentity.expectedConfigIdentity
      ? { expected: runtimeIdentity.expectedConfigIdentity }
      : {}),
    environment: runtimeIdentity.environment,
    ...(runtimeIdentity.releaseId ? { releaseId: runtimeIdentity.releaseId } : {}),
    logger: options.logger,
  });
  await runtime.initialize();
  return {
    modelResolverHooks: {
      ...(runtimeIdentity.environment === 'production'
        ? { validateConfigReload: (next: AppConfig) => runtime.validateConfigReload(next) }
        : {}),
      onConfigReloaded: () => runtime.notifyConfigChanged('config_file_hot_reload'),
    },
    getSummary: () => runtime.getSummary(),
  };
}

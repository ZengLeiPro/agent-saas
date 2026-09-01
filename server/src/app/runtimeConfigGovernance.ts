import { AdminConfigMutationService } from '../config/adminConfigMutationService.js';
import { buildEffectiveConfigStatus } from '../config/effectiveConfigStatus.js';
import { readRuntimeIdentity } from '../release/runtimeIdentity.js';
import type { AppConfig } from '../types/index.js';
import { getAppConfigPath } from './config.js';
import type { AppRuntimeProcessRole } from './runtimeContracts.js';

export function createRuntimeConfigGovernance(options: {
  config: AppConfig;
  processCwd: string;
  processRole: AppRuntimeProcessRole;
}) {
  const runtimeIdentity = readRuntimeIdentity();
  const appliedAt = new Date().toISOString();
  return {
    configMutationService: new AdminConfigMutationService({
      configPath: getAppConfigPath(options.processCwd),
      processCwd: options.processCwd,
      environment: runtimeIdentity.environment,
      processRole: options.processRole,
    }),
    getEffectiveConfigStatus: () =>
      buildEffectiveConfigStatus({
        config: options.config,
        environment: runtimeIdentity.environment,
        processRole: options.processRole,
        appliedAt,
      }),
  };
}

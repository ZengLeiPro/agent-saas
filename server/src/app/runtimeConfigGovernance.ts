import { AdminConfigMutationService } from '../config/adminConfigMutationService.js';
import type {
  ConfigRuntimeRecoveryGate,
  ConfigRuntimeRecoveryPermit,
} from '../config/runtimeRecoveryGate.js';
import { buildEffectiveConfigStatus } from '../config/effectiveConfigStatus.js';
import { readRuntimeIdentity } from '../release/runtimeIdentity.js';
import type { AppConfig } from '../types/index.js';
import { getAppConfigPath } from './config.js';
import type { AppRuntimeProcessRole } from './runtimeContracts.js';

export function createRuntimeConfigGovernance(options: {
  config: AppConfig;
  processCwd: string;
  processRole: AppRuntimeProcessRole;
  recoveryGate: ConfigRuntimeRecoveryGate;
  onConfigCommitted?: (
    candidateText: string,
    recoveryPermit?: ConfigRuntimeRecoveryPermit,
  ) => void | Promise<void>;
  onConfigInvalidated?: () => void;
}) {
  const runtimeIdentity = readRuntimeIdentity();
  const appliedAt = new Date().toISOString();
  return {
    configMutationService: new AdminConfigMutationService({
      configPath: getAppConfigPath(options.processCwd),
      processCwd: options.processCwd,
      environment: runtimeIdentity.environment,
      processRole: options.processRole,
      recoveryGate: options.recoveryGate,
      ...(options.onConfigCommitted ? { onCommitted: options.onConfigCommitted } : {}),
      ...(options.onConfigInvalidated ? { onRuntimeDirty: options.onConfigInvalidated } : {}),
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

import { AdminConfigMutationService } from '../config/adminConfigMutationService.js';
import type {
  ConfigRuntimeRecoveryGate,
  ConfigRuntimeRecoveryPermit,
} from '../config/runtimeRecoveryGate.js';
import { buildEffectiveConfigStatus } from '../config/effectiveConfigStatus.js';
import { readRuntimeIdentity } from '../release/runtimeIdentity.js';
import type { AppConfig } from '../types/index.js';
import type { PreparedConfigRecoveryPublication } from '../runtime/configIdentityRuntime.js';
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
  ) => void | PreparedConfigRecoveryPublication
    | Promise<void | PreparedConfigRecoveryPublication>;
  /** 在恢复事务进入后置阶段前同步撤销旧 observation。 */
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

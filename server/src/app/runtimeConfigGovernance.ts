import { AdminConfigMutationService } from '../config/adminConfigMutationService.js';
import type { CapabilityFingerprintReadback } from '../config/capabilityEnableTransaction.js';
import { CapabilityValidationJournal } from '../config/capabilityValidationJournal.js';
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
  const capabilityValidationJournal = new CapabilityValidationJournal({
    processCwd: options.processCwd,
  });
  const getEffectiveConfigStatus = () =>
    buildEffectiveConfigStatus({
      config: options.config,
      environment: runtimeIdentity.environment,
      processRole: options.processRole,
      appliedAt,
      validations: capabilityValidationJournal,
    });
  return {
    configMutationService: new AdminConfigMutationService({
      configPath: getAppConfigPath(options.processCwd),
      processCwd: options.processCwd,
      environment: runtimeIdentity.environment,
      processRole: options.processRole,
    }),
    capabilityValidationJournal,
    getEffectiveConfigStatus,
    /**
     * 本进程的配置读回。读的是热更新后的进程内配置对象，能验出「文件写了但
     * 运行时没跟上」；Runtime Worker 的读回随执行环境批次接入。
     */
    readEffectiveFingerprints: async (): Promise<CapabilityFingerprintReadback[]> => [
      {
        source: `api:${options.processRole}`,
        fingerprint: getEffectiveConfigStatus().effectiveConfigFingerprint,
      },
    ],
  };
}

import type { ConfigIdentitySummary } from '@agent/shared';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  ConfigRuntimeRecoveryGate,
  type ConfigRuntimeRecoveryPermit,
} from '../config/runtimeRecoveryGate.js';
import type { SecretVault } from '../security/secretVault.js';
import { readRuntimeIdentity } from '../release/runtimeIdentity.js';
import {
  createConfigIdentityRuntime,
  type PreparedConfigRecoveryPublication,
} from '../runtime/configIdentityRuntime.js';
import { getAppConfigPath, type AppConfig } from './config.js';
import { createProductionConfigIdentityView } from './productionConfigIdentity.js';

export function createPrivateSummaryPublisher(
  snapshotPath: string,
  logger: { warn: (message: string) => void },
): (summary: ConfigIdentitySummary) => void {
  const tempPath = `${snapshotPath}.${process.pid}.tmp`;
  return (summary) => {
    try {
      mkdirSync(dirname(snapshotPath), { recursive: true });
      writeFileSync(tempPath, `${JSON.stringify(summary)}\n`, { mode: 0o600 });
      renameSync(tempPath, snapshotPath);
    } catch (error) {
      try { rmSync(tempPath, { force: true }); } catch {}
      try { rmSync(snapshotPath, { force: true }); } catch {}
      logger.warn(`[ConfigIdentity] private snapshot publish failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}

export interface RuntimeConfigIdentityAssembly {
  recoveryGate: ConfigRuntimeRecoveryGate;
  modelResolverHooks: {
    validateConfigReload?: (next: AppConfig) => Promise<void>;
    isConfigAdmissionAllowed?: () => boolean;
    onConfigReloaded: () => void;
  };
  /** Validation of an authorized, not-yet-published candidate (not disk adoption). */
  validateCandidate?: (next: AppConfig) => Promise<void>;
  isExecutionAllowed: () => boolean;
  prepareRecoveryPublication: (
    recoveryPermit: ConfigRuntimeRecoveryPermit,
  ) => Promise<PreparedConfigRecoveryPublication>;
  invalidate: () => void;
  getSummary: () => ConfigIdentitySummary;
  refreshSummary: () => Promise<ConfigIdentitySummary>;
  isPrivateSummaryCurrent: () => boolean;
  getRefreshFailure: () => 'config_refresh_timeout' | 'config_refresh_failed' | undefined;
}

/** Release code identity remains immutable; online config has a signed authority. */
export async function initializeRuntimeConfigIdentityAssembly(options: {
  config: AppConfig;
  secretVault: SecretVault;
  processCwd: string;
  logger: { info: (message: string) => void; warn: (message: string) => void };
  onSummaryUpdated?: (summary: ConfigIdentitySummary) => void;
}): Promise<RuntimeConfigIdentityAssembly> {
  const recoveryGate = new ConfigRuntimeRecoveryGate();
  const runtimeIdentity = readRuntimeIdentity(process.env);
  const snapshotPath = process.env.AGENT_SAAS_CONFIG_IDENTITY_PATH?.trim();
  const privatePublisher = snapshotPath ? createPrivateSummaryPublisher(snapshotPath, options.logger) : undefined;
  const view = createProductionConfigIdentityView({
    environment: runtimeIdentity.environment, configPath: getAppConfigPath(options.processCwd),
    releaseId: runtimeIdentity.releaseId, expected: runtimeIdentity.expectedConfigIdentity,
    processCwd: options.processCwd, secretVault: options.secretVault,
  });
  const runtime = createConfigIdentityRuntime({
    config: options.config,
    secretVault: options.secretVault,
    ...(runtimeIdentity.expectedConfigIdentity ? { expected: runtimeIdentity.expectedConfigIdentity } : {}),
    environment: runtimeIdentity.environment,
    processCwd: options.processCwd,
    ...(runtimeIdentity.releaseId ? { releaseId: runtimeIdentity.releaseId } : {}),
    logger: options.logger,
    ...(privatePublisher || options.onSummaryUpdated ? {
      onSummaryUpdated: (summary: ConfigIdentitySummary) => {
        const mapped = view.mapSummary(summary);
        privatePublisher?.(mapped);
        options.onSummaryUpdated?.(mapped);
      },
    } : {}),
  });
  await runtime.initialize();
  const getSummary = () => view.mapSummary(runtime.getSummary());
  const isExecutionAllowed = () => !recoveryGate.isDirty() && view.isExecutionAllowed()
    && (runtimeIdentity.environment !== 'production' || !runtimeIdentity.expectedConfigIdentity || getSummary().status === 'consistent');
  return {
    recoveryGate,
    isExecutionAllowed,
    ...(runtimeIdentity.environment === 'production'
      ? { validateCandidate: (next: AppConfig) => runtime.validateConfigReload(next) } : {}),
    modelResolverHooks: {
      ...(runtimeIdentity.environment === 'production' ? {
        validateConfigReload: async (next: AppConfig) => {
          await runtime.validateConfigReload(next);
          await view.validatePublishedReload(next);
        },
        isConfigAdmissionAllowed: isExecutionAllowed,
      } : {}),
      onConfigReloaded: () => {
        if (recoveryGate.isDirty()) runtime.invalidateObservation();
        else runtime.notifyConfigChanged('config_file_hot_reload');
      },
    },
    prepareRecoveryPublication: async (recoveryPermit) => {
      if (!recoveryGate.allowsRecoveryCompletion(recoveryPermit)) throw new Error('运行时配置恢复许可无效');
      return await runtime.prepareConfigChanged('config_runtime_recovery');
    },
    invalidate: () => runtime.invalidateObservation(),
    getSummary,
    refreshSummary: async () => {
      await runtime.refreshSummary('readiness_or_overview');
      const summary = getSummary();
      // Authority can change without a config-byte change (commit or rollback).
      // Publish the mapped state even when observed recomputation was throttled.
      privatePublisher?.(summary);
      return summary;
    },
    getRefreshFailure: runtime.getRefreshFailure,
    isPrivateSummaryCurrent: () => {
      if (!snapshotPath) return false;
      try { return readFileSync(snapshotPath, 'utf8') === `${JSON.stringify(getSummary())}\n`; }
      catch { return false; }
    },
  };
}

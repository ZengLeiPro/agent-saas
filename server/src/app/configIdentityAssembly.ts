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
import type { AppConfig } from './config.js';

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
      // 私有观察面写失败时删除旧快照，宁可阻断 Evidence 也不能伪装旧 consistent。
      try { rmSync(tempPath, { force: true }); } catch {}
      try { rmSync(snapshotPath, { force: true }); } catch {}
      logger.warn(
        `[ConfigIdentity] private snapshot publish failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };
}

export interface RuntimeConfigIdentityAssembly {
  recoveryGate: ConfigRuntimeRecoveryGate;
  modelResolverHooks: {
    validateConfigReload?: (next: AppConfig) => Promise<void>;
    onConfigReloaded: () => void;
  };
  prepareRecoveryPublication: (
    recoveryPermit: ConfigRuntimeRecoveryPermit,
  ) => Promise<PreparedConfigRecoveryPublication>;
  invalidate: () => void;
  getSummary: () => ConfigIdentitySummary;
  refreshSummary: () => Promise<ConfigIdentitySummary>;
  isPrivateSummaryCurrent: () => boolean;
}

/**
 * TASK-318 在 Runtime 装配层的窄接口：集中 expected/observed 初始化、
 * Production 热更新门禁与只读摘要，避免继续膨胀 runtime.ts。
 */
export async function initializeRuntimeConfigIdentityAssembly(options: {
  config: AppConfig;
  secretVault: SecretVault;
  processCwd: string;
  logger: { info: (message: string) => void; warn: (message: string) => void };
  /** 测试/内部订阅者观察完整状态序列；私有 snapshot publisher 仍独立执行。 */
  onSummaryUpdated?: (summary: ConfigIdentitySummary) => void;
}): Promise<RuntimeConfigIdentityAssembly> {
  const recoveryGate = new ConfigRuntimeRecoveryGate();
  const runtimeIdentity = readRuntimeIdentity(process.env);
  const snapshotPath = process.env.AGENT_SAAS_CONFIG_IDENTITY_PATH?.trim();
  const privatePublisher = snapshotPath
    ? createPrivateSummaryPublisher(snapshotPath, options.logger)
    : undefined;
  const runtime = createConfigIdentityRuntime({
    config: options.config,
    secretVault: options.secretVault,
    ...(runtimeIdentity.expectedConfigIdentity
      ? { expected: runtimeIdentity.expectedConfigIdentity }
      : {}),
    environment: runtimeIdentity.environment,
    processCwd: options.processCwd,
    ...(runtimeIdentity.releaseId ? { releaseId: runtimeIdentity.releaseId } : {}),
    logger: options.logger,
    ...(privatePublisher || options.onSummaryUpdated
      ? { onSummaryUpdated: (summary: ConfigIdentitySummary) => {
        privatePublisher?.(summary);
        options.onSummaryUpdated?.(summary);
      } }
      : {}),
  });
  await runtime.initialize();
  return {
    recoveryGate,
    modelResolverHooks: {
      ...(runtimeIdentity.environment === 'production'
        ? { validateConfigReload: (next: AppConfig) => runtime.validateConfigReload(next) }
        : {}),
      onConfigReloaded: () => {
        if (recoveryGate.isDirty()) runtime.invalidateObservation();
        else runtime.notifyConfigChanged('config_file_hot_reload');
      },
    },
    prepareRecoveryPublication: async (recoveryPermit) => {
      if (!recoveryGate.allowsRecoveryCompletion(recoveryPermit)) {
        throw new Error('运行时配置恢复许可无效');
      }
      return await runtime.prepareConfigChanged('config_runtime_recovery');
    },
    invalidate: () => runtime.invalidateObservation(),
    getSummary: () => runtime.getSummary(),
    refreshSummary: () => runtime.refreshSummary('readiness_or_overview'),
    isPrivateSummaryCurrent: () => {
      if (!snapshotPath) return false;
      try {
        return readFileSync(snapshotPath, 'utf8') === `${JSON.stringify(runtime.getSummary())}\n`;
      } catch {
        return false;
      }
    },
  };
}

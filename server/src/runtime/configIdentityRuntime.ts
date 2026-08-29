/**
 * Runtime observed config identity 服务（TASK-318）。
 *
 * 职责：
 * - 启动时计算 observed identity；Production 下受管 SecretVault ref 缺失或
 *   不可验证 -> fail closed（抛错拒绝启动）。
 * - 受支持的配置热更新成功后重新计算并「发布」observed identity（health /
 *   overview / attention 都读同一份状态）。
 * - 提供只读、脱敏的 ConfigIdentitySummary（四态判定 + 安全摘要）。
 *
 * 非目标：不修改配置、不接受漂移、不做发布/回滚（UI 也只读）。
 */
import type { AppConfig } from '../types/index.js';
import type { SecretVault } from '../security/secretVault.js';
import type { ExpectedConfigIdentity } from '../release/configIdentity.js';
import {
  assertProductionManagedCredentialSafety,
  computeObservedConfigIdentity,
  evaluateConfigIdentityStatus,
  type ConfigIdentityObservation,
} from '../release/configIdentity.js';
import { CONFIG_IDENTITY_SCHEMA_VERSION, type ConfigIdentitySummary } from '@agent/shared';

export interface ConfigIdentityRuntimeOptions {
  config: AppConfig;
  secretVault?: SecretVault;
  expected?: ExpectedConfigIdentity;
  environment: 'staging' | 'production' | 'development' | 'test';
  releaseId?: string;
  logger?: {
    info: (message: string) => void;
    warn: (message: string) => void;
  };
  /** 注入时钟（测试）。 */
  now?: () => Date;
}

/** 摘要读取节流：15s 轮询的 overview 不应每次都解密 vault 文件。 */
const SUMMARY_RECOMPUTE_MIN_INTERVAL_MS = 5_000;

export interface ConfigIdentityRuntime {
  /** 启动计算 + Production fail-closed 校验。 */
  initialize(): Promise<void>;
  /** Production 热更新应用前异步校验 inline secret 与 ref version。 */
  validateConfigReload(nextConfig: AppConfig): Promise<void>;
  /** 配置热更新成功后重算（内部捕获异常，绝不打断热更新主流程）。 */
  notifyConfigChanged(reason: string): void;
  /** 同步等待一次重算（测试与显式刷新用）。 */
  refresh(reason?: string): Promise<void>;
  /** 只读脱敏摘要；未初始化时返回 not_collected。 */
  getSummary(): ConfigIdentitySummary;
}

export function createConfigIdentityRuntime(
  options: ConfigIdentityRuntimeOptions,
): ConfigIdentityRuntime {
  const { config, secretVault, expected, environment, releaseId, logger } = options;
  const now = options.now ?? (() => new Date());

  let observation: ConfigIdentityObservation | undefined;
  let firstObservedAt: string | undefined;
  let lastObservedAt: string | undefined;
  let lastChangedAt: string | undefined;
  let lastComputedAtMs = 0;

  function applyObservation(next: ConfigIdentityObservation): void {
    const previous = observation;
    const identityChanged =
      previous !== undefined &&
      (previous.digest !== next.digest ||
        previous.credentialVersionDigest !== next.credentialVersionDigest);
    observation = next;
    if (!firstObservedAt) firstObservedAt = next.computedAt;
    lastObservedAt = next.computedAt;
    // 首次采集建立 baseline，不算「发生变化」；只有和上一份 observed identity
    // 相比 digest/credentialVersionDigest 改变时才更新时间。
    if (identityChanged) lastChangedAt = next.computedAt;
    if (identityChanged) {
      logger?.info(
        `[ConfigIdentity] observed identity changed: ${next.digest.slice(0, 19)}… ` +
          `(credentialVersions=${next.credentialVersionDigest?.slice(0, 19) ?? 'none'})`,
      );
    }
  }

  async function compute(): Promise<ConfigIdentityObservation> {
    const next = await computeObservedConfigIdentity(config, secretVault, now);
    if (next.unresolvedRefPaths.length > 0) {
      logger?.warn(
        `[ConfigIdentity] managed secret ref versions unresolved: ${next.unresolvedRefPaths.join(', ')}`,
      );
    }
    return next;
  }

  function assertProductionObservation(next: ConfigIdentityObservation): void {
    if (
      environment !== 'production' ||
      next.secretRefCount === 0 ||
      next.versionResolution === 'resolved'
    )
      return;
    const missing = next.unresolvedRefPaths;
    throw new Error(
      'Production requires verifiable SecretVault refs for managed credentials; ' +
        `unresolved: ${missing.length > 0 ? missing.join(', ') : 'vault metadata unavailable'}`,
    );
  }

  async function validateConfigReload(nextConfig: AppConfig): Promise<void> {
    if (environment !== 'production') return;
    assertProductionManagedCredentialSafety(nextConfig);
    const next = await computeObservedConfigIdentity(nextConfig, secretVault, now);
    assertProductionObservation(next);
  }

  async function initialize(): Promise<void> {
    if (environment === 'production') assertProductionManagedCredentialSafety(config);
    const next = await compute();
    assertProductionObservation(next);
    applyObservation(next);
    lastComputedAtMs = now().getTime();
    logger?.info(`[ConfigIdentity] observed identity computed: ${next.digest.slice(0, 19)}…`);
  }

  async function refresh(reason: string): Promise<void> {
    const next = await compute();
    applyObservation(next);
    lastComputedAtMs = now().getTime();
    logger?.info(`[ConfigIdentity] recomputed after ${reason}: ${next.digest.slice(0, 19)}…`);
  }

  function notifyConfigChanged(reason: string): void {
    // 热更新成功后的重算是「发布新 observed identity」；失败保留上一份并告警，
    // 不能让身份重算的异常打断配置热更新本身。
    void refresh(reason).catch((error) => {
      logger?.warn(
        `[ConfigIdentity] recompute after ${reason} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
    lastComputedAtMs = now().getTime();
  }

  function buildSummary(): ConfigIdentitySummary {
    const evaluation = evaluateConfigIdentityStatus(expected, observation);
    return {
      schemaVersion: CONFIG_IDENTITY_SCHEMA_VERSION,
      status: evaluation.status,
      ...(evaluation.reason ? { reason: evaluation.reason } : {}),
      ...(expected
        ? {
            expected: {
              schemaVersion: expected.schemaVersion,
              digest: expected.digest,
              ...(expected.credentialVersionDigest
                ? { credentialVersionDigest: expected.credentialVersionDigest }
                : {}),
            },
          }
        : {}),
      ...(observation
        ? {
            observed: {
              schemaVersion: observation.schemaVersion,
              digest: observation.digest,
              credentialVersionDigest: observation.credentialVersionDigest,
              versionResolution: observation.versionResolution,
              secretRefCount: observation.secretRefCount,
            },
          }
        : {}),
      ...(releaseId ? { releaseId } : {}),
      ...(firstObservedAt ? { firstObservedAt } : {}),
      ...(lastObservedAt ? { lastObservedAt } : {}),
      ...(lastChangedAt ? { lastChangedAt } : {}),
    };
  }

  return {
    initialize,
    validateConfigReload,
    notifyConfigChanged,
    refresh: (reason = 'explicit') => refresh(reason),
    getSummary(): ConfigIdentitySummary {
      const currentMs = now().getTime();
      // 轻量节流：summary 读取最多每 5s 触发一次全量重算；显式热更新通知不受限。
      if (currentMs - lastComputedAtMs >= SUMMARY_RECOMPUTE_MIN_INTERVAL_MS) {
        lastComputedAtMs = currentMs;
        void compute()
          .then((next) => applyObservation(next))
          .catch((error) => {
            logger?.warn(
              `[ConfigIdentity] periodic recompute failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          });
      }
      return buildSummary();
    },
  };
}

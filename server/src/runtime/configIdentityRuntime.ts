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
  CONFIG_IDENTITY_SCHEMA_VERSION,
  type ConfigIdentitySummary,
} from '@agent/shared/schemas/configIdentity';
import {
  assertProductionManagedCredentialSafety,
  computeObservedConfigIdentity,
  evaluateConfigIdentityStatus,
  type ConfigIdentityObservation,
} from '../release/configIdentity.js';


const PREPARED_PUBLICATION_CREATION_TOKEN = Symbol('prepared-config-recovery-publication');
const TRUSTED_PREPARED_PUBLICATIONS = new WeakSet<object>();

/** 只能由本 Runtime 私有令牌创建的已计算、未发布 observation。 */
export class PreparedConfigRecoveryPublication {
  #committed = false;
  readonly #commitAction: () => void;

  private constructor(
    token: typeof PREPARED_PUBLICATION_CREATION_TOKEN,
    commitAction: () => void,
  ) {
    if (token !== PREPARED_PUBLICATION_CREATION_TOKEN) {
      throw new Error('禁止在 ConfigIdentity Runtime 外构造 prepared publication capability');
    }
    this.#commitAction = commitAction;
    TRUSTED_PREPARED_PUBLICATIONS.add(this);
    Object.freeze(this);
  }

  static create(
    token: typeof PREPARED_PUBLICATION_CREATION_TOKEN,
    commitAction: () => void,
  ): PreparedConfigRecoveryPublication {
    return new PreparedConfigRecoveryPublication(token, commitAction);
  }

  commit(): void {
    if (this.#committed) throw new Error('恢复 observation 已提交');
    this.#committed = true;
    this.#commitAction();
  }
}

Object.freeze(PreparedConfigRecoveryPublication.prototype);
Object.freeze(PreparedConfigRecoveryPublication);

export function isPreparedConfigRecoveryPublication(
  value: unknown,
): value is PreparedConfigRecoveryPublication {
  return typeof value === 'object' && value !== null && TRUSTED_PREPARED_PUBLICATIONS.has(value);
}

export interface ConfigIdentityRuntimeOptions {
  config: AppConfig;
  secretVault?: SecretVault;
  expected?: ExpectedConfigIdentity;
  environment: 'staging' | 'production' | 'development' | 'test';
  /** 运行进程的真实 cwd；机器相对路径 canonicalization 必须复刻运行期解析。 */
  processCwd?: string;
  releaseId?: string;
  logger?: {
    info: (message: string) => void;
    warn: (message: string) => void;
  };
  /** 将严格摘要同步发布到进程外私有观察面；不得暴露到匿名 health API。 */
  onSummaryUpdated?: (summary: ConfigIdentitySummary) => void;
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
  /** 纯同步撤销 observation、取消在途计算并发布 not_collected；不启动重算。 */
  invalidateObservation(): void;
  /** 为恢复事务计算但不发布 observation；返回同步 commit，供 audit 成功后调用。 */
  prepareConfigChanged(reason: string): Promise<PreparedConfigRecoveryPublication>;
  /** 配置热更新成功后先失效再重算（内部捕获异常，绝不打断热更新主流程）。 */
  notifyConfigChanged(reason: string): void;
  /** 同步等待一次重算（测试与显式刷新用）。 */
  refresh(reason?: string): Promise<void>;
  /** 强一致读取：过期或时钟异常时等待重算，失败则撤销旧 observation。 */
  refreshSummary(reason?: string): Promise<ConfigIdentitySummary>;
  /** 稳定只读脱敏摘要；不会因读取本身制造瞬时 not_collected。 */
  getSummary(): ConfigIdentitySummary;
}

export function createConfigIdentityRuntime(
  options: ConfigIdentityRuntimeOptions,
): ConfigIdentityRuntime {
  const { config, secretVault, expected, environment, releaseId, logger, onSummaryUpdated } = options;
  const processCwd = options.processCwd ?? process.cwd();
  const now = options.now ?? (() => new Date());

  let observation: ConfigIdentityObservation | undefined;
  let firstObservedAt: string | undefined;
  let lastObservedAt: string | undefined;
  let lastChangedAt: string | undefined;
  let lastComputedAtMs = 0;
  let computeGeneration = 0;
  let observationInvalidated = false;
  let invalidatedComparisonObservation: ConfigIdentityObservation | undefined;
  let strongRetryAllowedAfterInvalidation = false;
  let activeRefresh: { generation: number; promise: Promise<void> } | undefined;

  function applyObservation(
    next: ConfigIdentityObservation,
    comparisonObservation: ConfigIdentityObservation | undefined = observation,
  ): void {
    const previous = comparisonObservation;
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
    try {
      onSummaryUpdated?.(buildSummary());
    } catch (error) {
      try {
        logger?.warn(`[ConfigIdentity] summary publisher failed: ${error instanceof Error ? error.message : String(error)}`);
      } catch {
        // 发布者异常已隔离；诊断 logger 也不得把已发布终态反转成 commit 失败。
      }
    }
  }

  async function compute(): Promise<ConfigIdentityObservation> {
    const next = await computeObservedConfigIdentity(config, secretVault, processCwd, now);
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
    const next = await computeObservedConfigIdentity(nextConfig, secretVault, processCwd, now);
    assertProductionObservation(next);
  }

  async function initialize(): Promise<void> {
    if (environment === 'production') assertProductionManagedCredentialSafety(config);
    const generation = ++computeGeneration;
    const next = await compute();
    assertProductionObservation(next);
    if (generation !== computeGeneration) return;
    applyObservation(next);
    lastComputedAtMs = now().getTime();
    logger?.info(`[ConfigIdentity] observed identity computed: ${next.digest.slice(0, 19)}…`);
  }

  async function prepareRefresh(reason: string): Promise<() => void> {
    const comparisonObservation = observationInvalidated
      ? invalidatedComparisonObservation
      : observation;
    const generation = ++computeGeneration;
    const next = await compute();
    return () => {
      if (generation !== computeGeneration) {
        throw new Error(`ConfigIdentity recompute became stale after ${reason}`);
      }
      const computedAtMs = now().getTime();
      const previousState = {
        observation,
        firstObservedAt,
        lastObservedAt,
        lastChangedAt,
        lastComputedAtMs,
        observationInvalidated,
        invalidatedComparisonObservation,
        strongRetryAllowedAfterInvalidation,
      };
      try {
        logger?.info(`[ConfigIdentity] recomputed after ${reason}: ${next.digest.slice(0, 19)}…`);
        observationInvalidated = false;
        invalidatedComparisonObservation = undefined;
        strongRetryAllowedAfterInvalidation = false;
        applyObservation(next, comparisonObservation);
        lastComputedAtMs = computedAtMs;
      } catch (error) {
        observation = previousState.observation;
        firstObservedAt = previousState.firstObservedAt;
        lastObservedAt = previousState.lastObservedAt;
        lastChangedAt = previousState.lastChangedAt;
        lastComputedAtMs = previousState.lastComputedAtMs;
        observationInvalidated = previousState.observationInvalidated;
        invalidatedComparisonObservation = previousState.invalidatedComparisonObservation;
        strongRetryAllowedAfterInvalidation = previousState.strongRetryAllowedAfterInvalidation;
        throw error;
      }
    };
  }

  async function runRefresh(reason: string): Promise<void> {
    const commit = await prepareRefresh(reason);
    try {
      commit();
    } catch (error) {
      logger?.info(`[ConfigIdentity] discarded stale recompute after ${reason}`);
      if (!(error instanceof Error) || !error.message.includes('became stale')) throw error;
    }
  }

  function refresh(reason: string): Promise<void> {
    const generation = computeGeneration + 1;
    const promise = runRefresh(reason);
    const running = { generation, promise };
    activeRefresh = running;
    void promise.then(
      () => { if (activeRefresh === running) activeRefresh = undefined; },
      () => { if (activeRefresh === running) activeRefresh = undefined; },
    );
    return promise;
  }

  async function prepareConfigChanged(reason: string): Promise<PreparedConfigRecoveryPublication> {
    invalidateObservation();
    return PreparedConfigRecoveryPublication.create(
      PREPARED_PUBLICATION_CREATION_TOKEN,
      await prepareRefresh(reason),
    );
  }

  function invalidateObservation(allowStrongRetry = false): void {
    ++computeGeneration;
    if (!observationInvalidated) invalidatedComparisonObservation = observation;
    observationInvalidated = true;
    strongRetryAllowedAfterInvalidation = allowStrongRetry;
    observation = undefined;
    try {
      lastComputedAtMs = now().getTime();
    } catch {
      // 时钟读取异常也不得阻止失效；保留 0 使下一次强一致读取立即重试。
      lastComputedAtMs = 0;
    }
    try {
      onSummaryUpdated?.(buildSummary());
    } catch (error) {
      try {
        logger?.warn(`[ConfigIdentity] summary publisher failed: ${error instanceof Error ? error.message : String(error)}`);
      } catch {
        // 发布者异常已隔离；诊断 logger 也不得把已发布终态反转成 commit 失败。
      }
    }
  }

  function notifyConfigChanged(reason: string): void {
    // 先纯同步失效，避免异步重算窗口及失败场景保留旧 consistent；成功结果
    // 仍与失效前 observation 比较，以正确推进 lastChangedAt。
    invalidateObservation();
    const pending = refresh(reason);
    const generation = activeRefresh?.generation;
    void pending.catch((error) => {
      if (generation === computeGeneration && observationInvalidated) {
        strongRetryAllowedAfterInvalidation = true;
      }
      logger?.warn(
        `[ConfigIdentity] recompute after ${reason} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

  function warnStrongRefreshFailure(error: unknown): void {
    try {
      logger?.warn(
        `[ConfigIdentity] strong recompute failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } catch {
      // 诊断 logger 不得改变 fail-closed 结果。
    }
  }

  async function awaitStrongRefresh(
    running: { generation: number; promise: Promise<void> },
  ): Promise<boolean> {
    try {
      await running.promise;
      return true;
    } catch (error) {
      // 仅当前 generation 的失败能撤销 observation；旧失败不得覆盖更新的成功结果。
      const failedCurrentGeneration = computeGeneration === running.generation;
      if (failedCurrentGeneration) invalidateObservation(true);
      warnStrongRefreshFailure(error);
      return !failedCurrentGeneration;
    }
  }

  async function refreshSummary(reason = 'strong_summary_read'): Promise<ConfigIdentitySummary> {
    let currentMs: number;
    try {
      currentMs = now().getTime();
    } catch (error) {
      invalidateObservation(true);
      warnStrongRefreshFailure(error);
      return buildSummary();
    }

    const currentRefresh = activeRefresh?.generation === computeGeneration
      ? activeRefresh
      : undefined;
    if (currentRefresh) {
      if (!await awaitStrongRefresh(currentRefresh)) return buildSummary();
      return refreshSummary(reason);
    }
    // 管理端候选只完成纯失效、尚未确认胜出时，不得重算可能失选的内存配置。
    // 已应用配置或 Vault 的瞬时刷新失败则允许下一次强一致读取自动恢复。
    if (observationInvalidated && !strongRetryAllowedAfterInvalidation) return buildSummary();

    const elapsedMs = currentMs - lastComputedAtMs;
    const isFresh =
      observation !== undefined &&
      Number.isFinite(elapsedMs) &&
      elapsedMs >= 0 &&
      elapsedMs < SUMMARY_RECOMPUTE_MIN_INTERVAL_MS;
    if (isFresh) return buildSummary();

    const promise = refresh(reason);
    const running = activeRefresh ?? { generation: computeGeneration, promise };
    if (!await awaitStrongRefresh(running)) return buildSummary();
    return refreshSummary(reason);
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
    invalidateObservation,
    prepareConfigChanged,
    notifyConfigChanged,
    refresh: (reason = 'explicit') => refresh(reason),
    refreshSummary,
    getSummary: buildSummary,
  };
}

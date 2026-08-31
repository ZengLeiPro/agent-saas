/**
 * 跨进程共享配置的按需刷新器。
 *
 * 为什么需要（2026-08-09 千问故障）：ws-only 进程负责平台管理写配置，
 * runtime-worker 进程负责执行 run，两者各持一份内存副本。平台管理页保存
 * 只更新写入方进程，执行方要等重启才认识新配置——表现为模型「能选、一发就废」。
 *
 * 同类补丁在 skill/user store（runtime.ts ensureReady）与 memory polling
 * （runtime.ts isExecutionEnabled 直接 loadAppConfig）里已各自存在，本模块把
 * 「模型配置 + 组织白名单」这条同样需要跨进程新鲜度的路径补齐。
 *
 * 设计取舍：
 *   - 安全入口以稳定 stat + SHA-256 内容版本判定，避免同尺寸/时间戳覆盖与 TOCTOU；
 *   - 首轮强制对齐磁盘，后续可节流；安全敏感入口使用 force；
 *   - 解析失败保留旧配置并告警，绝不因为一次坏写入把正在服务的进程打挂。
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { parse as parseJsonc } from 'jsonc-parser';
import type { AppConfig } from './config.js';
import { getAppConfigPath, parseAppConfig } from './config.js';
import type { TenantStore } from '../data/tenants/store.js';
import {
  prepareModelsHotUpdate,
  type ModelsHotUpdateCommit,
  type ModelsHotUpdateTarget,
} from './modelsHotUpdate.js';
import type { WebToolsRuntimeUpdateCommit } from './webToolsRuntimeUpdate.js';
import type { SttRuntimeUpdateCommit } from './sttRuntimeUpdate.js';
import {
  finalizeSharedConfigTransaction,
  type SharedConfigCommitStep,
} from './sharedConfigTransaction.js';

/** 非安全入口的最小检查间隔；模型、消息等安全入口会用 force 绕过。 */
const DEFAULT_MIN_STAT_INTERVAL_MS = 1000;

interface FileStamp {
  mtimeMs: number;
  size: number;
  digest: string;
  stable: boolean;
}

interface FileSnapshot {
  stamp: FileStamp;
  text: string;
}

type MaybePromise<T> = T | Promise<T>;

type ConfigChanges = {
  models: boolean;
  titleGenerator: boolean;
  guardrail: boolean;
  systemPrompts: boolean;
  toolControls: boolean;
  codexSubscription: boolean;
  stt: boolean;
  webTools: boolean;
};
type ConfigChangeKey = keyof ConfigChanges;
type PreparationOutcome<T> = { ok: true; value: T } | { ok: false; error: unknown };
type ControlledPreparation<T> = PreparationOutcome<T> | Promise<PreparationOutcome<T>>;
type PreparationResults = [
  PreparationOutcome<void | undefined>,
  PreparationOutcome<ModelsHotUpdateCommit | undefined>,
  PreparationOutcome<ModelsHotUpdateCommit | undefined>,
  PreparationOutcome<WebToolsRuntimeUpdateCommit | undefined>,
  PreparationOutcome<WebToolsRuntimeUpdateCommit | undefined>,
  PreparationOutcome<SttRuntimeUpdateCommit | undefined>,
  PreparationOutcome<SttRuntimeUpdateCommit | undefined>,
];

const MODEL_CHANGE_KEYS: ConfigChangeKey[] = ['models', 'titleGenerator', 'guardrail'];
const CHANGE_LABELS: Record<ConfigChangeKey, string> = {
  models: 'models/title/guardrail/pricing',
  titleGenerator: 'models/title/guardrail/pricing',
  guardrail: 'models/title/guardrail/pricing',
  systemPrompts: 'systemPrompt',
  toolControls: 'toolControls',
  codexSubscription: 'codexSubscription',
  stt: 'STT',
  webTools: 'WebTools',
};

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as Promise<unknown>).then === 'function'
  );
}

/** Promise 一经产生便安装 rejection handler；后续同步 prepare 抛错也不会留下悬空 rejection。 */
function startControlledPreparation<T>(start: () => MaybePromise<T>): ControlledPreparation<T> {
  try {
    const value = start();
    if (!isPromiseLike(value)) return { ok: true, value };
    return Promise.resolve(value).then(
      (resolved) => ({ ok: true as const, value: resolved }),
      (error) => ({ ok: false as const, error }),
    );
  } catch (error) {
    return { ok: false, error };
  }
}

function readSnapshot(filePath: string): FileSnapshot | undefined {
  try {
    const before = statSync(filePath);
    const content = readFileSync(filePath);
    const after = statSync(filePath);
    return {
      text: content.toString('utf-8'),
      stamp: {
        mtimeMs: after.mtimeMs,
        size: after.size,
        digest: createHash('sha256').update(content).digest('hex'),
        stable: before.mtimeMs === after.mtimeMs && before.size === after.size,
      },
    };
  } catch {
    return undefined;
  }
}

function readStamp(filePath: string): FileStamp | undefined {
  return readSnapshot(filePath)?.stamp;
}

function sameStamp(a: FileStamp | undefined, b: FileStamp | undefined): boolean {
  if (!a || !b) return a === b;
  return (
    a.stable && b.stable && a.mtimeMs === b.mtimeMs && a.size === b.size && a.digest === b.digest
  );
}

export interface SharedConfigRefresher {
  /**
   * 若磁盘上的 config.json / tenants.json 已被其他进程改写，则重新加载并应用。
   * 幂等、可高频调用；普通入口受节流保护，force 会读取稳定内容摘要以强校验。
   * 返回 false 表示磁盘候选未安全提交，安全敏感调用方应 fail closed。
   */
  refreshIfChanged(force?: boolean): boolean | Promise<boolean>;
  /** 管理端提交后仅在稳定磁盘快照仍是本次精确文本时推进指纹。 */
  acknowledgeConfigApplied(expectedConfigText: string): boolean;
  /** 供测试与诊断：返回已应用的磁盘指纹（不包含待修复的脏执行切面）。 */
  getAppliedStamps(): { config?: FileStamp; tenants?: FileStamp };
}

export function createSharedConfigRefresher(params: {
  config: AppConfig;
  processCwd: string;
  target: ModelsHotUpdateTarget;
  /** 系统提示语先完成纯校验/规范化，再返回只做同步赋值的 commit。 */
  prepareSystemPromptOverridesUpdate?: (
    next: NonNullable<AppConfig['systemPrompts']>,
  ) => () => void;
  /**
   * webTools 两阶段更新：先异步解析凭据并返回无副作用的 commit；仅当候选文件仍
   * 是最新版且所有门禁成功时，才与 AppConfig / observed identity 同步提交。
   */
  prepareWebToolsUpdate?: (
    next: AppConfig['webTools'],
  ) => WebToolsRuntimeUpdateCommit | Promise<WebToolsRuntimeUpdateCommit>;
  /** STT 两阶段更新：SecretVault 解析成功后返回无副作用的执行侧 commit。 */
  prepareSttUpdate?: (
    next: AppConfig['stt'],
  ) => SttRuntimeUpdateCommit | Promise<SttRuntimeUpdateCommit>;
  /** 模型候选变化后异步解析 SecretRef，再返回无失败的执行快照提交。 */
  onModelsUpdated?: (
    nextConfig: AppConfig,
  ) => ModelsHotUpdateCommit | Promise<ModelsHotUpdateCommit>;
  /** config 文件解析成功并应用后的回调（TASK-318：重算 observed identity）。 */
  onConfigReloaded?: () => void;
  /** 应用新配置前的门禁；支持异步校验，失败时保留旧内存配置。 */
  validateConfigReload?: (next: AppConfig) => void | Promise<void>;
  tenantStore?: TenantStore;
  tenantsFilePath?: string;
  logger?: { info: (msg: string) => void; warn: (msg: string) => void };
  minStatIntervalMs?: number;
  /** 注入时钟便于测试；默认 Date.now。 */
  now?: () => number;
}): SharedConfigRefresher {
  const {
    config,
    processCwd,
    target,
    prepareSystemPromptOverridesUpdate,
    prepareWebToolsUpdate,
    prepareSttUpdate,
    onModelsUpdated,
    onConfigReloaded,
    validateConfigReload,
    tenantStore,
    tenantsFilePath,
    logger,
    minStatIntervalMs = DEFAULT_MIN_STAT_INTERVAL_MS,
    now = Date.now,
  } = params;

  const configPath = getAppConfigPath(processCwd);
  // config/tenant 内存快照早于本刷新器装配；不能把构造时磁盘指纹冒充已应用版本，
  // 否则启动窗口内的跨进程写入会被永久漏掉。首轮调用必须重新加载确认。
  let appliedConfigStamp: FileStamp | undefined;
  let pendingConfigStamp: FileStamp | undefined;
  let pendingConfigRefresh: Promise<boolean> | undefined;
  let configRefreshNeedsRetry = false;
  const dirtyConfigChanges = new Set<ConfigChangeKey>();
  let appliedTenantsStamp: FileStamp | undefined;
  let tenantRefreshNeedsRetry = false;
  let lastCheckedAtMs = 0;

  function warnConfigReload(error: unknown): void {
    configRefreshNeedsRetry = true;
    // 别人正写到一半、写坏了，或未通过 Production 安全门禁：拒绝推进指纹并重试
    // 内存配置，且不推进 appliedConfigStamp，修好后可立刻重新拾取。
    logger?.warn(
      `[SharedConfig] config.json 已变化但解析失败或安全校验失败，继续使用当前内存配置：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  function getConfigChanges(nextConfig: AppConfig): ConfigChanges {
    const changes: ConfigChanges = {
      models:
        Boolean(nextConfig.models) &&
        JSON.stringify(config.models ?? null) !== JSON.stringify(nextConfig.models),
      titleGenerator:
        JSON.stringify(config.titleGenerator ?? null) !==
        JSON.stringify(nextConfig.titleGenerator ?? null),
      guardrail:
        JSON.stringify(config.guardrail ?? null) !== JSON.stringify(nextConfig.guardrail ?? null),
      systemPrompts:
        JSON.stringify(config.systemPrompts ?? null) !==
        JSON.stringify(nextConfig.systemPrompts ?? null),
      toolControls:
        JSON.stringify(config.toolControls ?? null) !==
        JSON.stringify(nextConfig.toolControls ?? null),
      codexSubscription:
        JSON.stringify(config.codexSubscription ?? null) !==
        JSON.stringify(nextConfig.codexSubscription ?? null),
      stt: JSON.stringify(config.stt ?? null) !== JSON.stringify(nextConfig.stt ?? null),
      webTools:
        JSON.stringify(config.webTools ?? null) !== JSON.stringify(nextConfig.webTools ?? null),
    };
    for (const key of dirtyConfigChanges) changes[key] = true;
    return changes;
  }

  function dirtyChangeLabels(): string[] {
    return [...new Set([...dirtyConfigChanges].map((key) => CHANGE_LABELS[key]))];
  }

  function markDirtyRollback(label: string, changes: ConfigChanges): void {
    if (label === 'models/title/guardrail/pricing') {
      for (const key of MODEL_CHANGE_KEYS) dirtyConfigChanges.add(key);
    } else if (label === 'system prompts') dirtyConfigChanges.add('systemPrompts');
    else if (label === 'stt') dirtyConfigChanges.add('stt');
    else if (label === 'web tools') dirtyConfigChanges.add('webTools');
    else if (label === 'AppConfig') {
      for (const key of Object.keys(changes) as ConfigChangeKey[]) {
        if (changes[key]) dirtyConfigChanges.add(key);
      }
    }
  }

  function applyConfigSlices(source: AppConfig, changes: ConfigChanges): void {
    if (changes.models) {
      if (source.models) config.models = source.models;
      else delete config.models;
    }
    if (changes.titleGenerator) {
      if (source.titleGenerator) config.titleGenerator = source.titleGenerator;
      else delete config.titleGenerator;
    }
    if (changes.guardrail) {
      if (source.guardrail) config.guardrail = source.guardrail;
      else delete config.guardrail;
    }
    if (changes.systemPrompts) {
      if (source.systemPrompts) config.systemPrompts = source.systemPrompts;
      else delete config.systemPrompts;
    }
    if (changes.toolControls) {
      if (source.toolControls) config.toolControls = source.toolControls;
      else delete config.toolControls;
    }
    if (changes.codexSubscription) {
      if (source.codexSubscription) config.codexSubscription = source.codexSubscription;
      else delete config.codexSubscription;
    }
    if (changes.stt) {
      if (source.stt) config.stt = source.stt;
      else delete config.stt;
    }
    if (changes.webTools) {
      if (source.webTools) config.webTools = source.webTools;
      else delete config.webTools;
    }
  }

  function publishConfigFile(
    nextConfig: AppConfig,
    stamp: FileStamp,
    changes: ConfigChanges,
  ): void {
    if ((changes.models || changes.titleGenerator || changes.guardrail) && nextConfig.models) {
      logger?.info(
        `[SharedConfig] 已从磁盘热更新模型及辅助模型配置：${nextConfig.models.groups.length} 组 / ` +
          `${nextConfig.models.groups.reduce((n, g) => n + g.models.length, 0)} 个模型`,
      );
    }
    if (changes.systemPrompts) logger?.info('[SharedConfig] 已从磁盘热更新系统提示语配置');
    if (changes.toolControls) logger?.info('[SharedConfig] 已从磁盘热更新工具开关与描述覆盖配置');
    if (changes.codexSubscription) {
      const refs = nextConfig.codexSubscription?.credentialRefs?.length
        ? nextConfig.codexSubscription.credentialRefs
        : nextConfig.codexSubscription?.credentialRef
          ? [nextConfig.codexSubscription.credentialRef]
          : [];
      logger?.info(
        `[SharedConfig] 已从磁盘热更新 Codex 订阅配置：enabled=${nextConfig.codexSubscription?.enabled === true} / ` +
          `websocketEnabled=${nextConfig.codexSubscription?.websocketEnabled === true} / ` +
          `credentialCount=${new Set(refs).size}`,
      );
    }
    if (changes.stt) {
      logger?.info(
        `[SharedConfig] 已从磁盘热更新语音转写配置：enabled=${nextConfig.stt?.enabled === true}`,
      );
    }
    if (changes.webTools) {
      logger?.info(
        `[SharedConfig] 已从磁盘热更新 Web 工具配置：search provider=${nextConfig.webTools?.search?.provider ?? 'none'}`,
      );
    }

    const repairedDirtyChanges = dirtyChangeLabels();
    dirtyConfigChanges.clear();
    appliedConfigStamp = stamp;
    configRefreshNeedsRetry = false;
    if (repairedDirtyChanges.length > 0) {
      logger?.info(
        `[SharedConfig] 脏执行切面已随完整 post-check 成功清理：${repairedDirtyChanges.join(', ')}`,
      );
    }
    try {
      onConfigReloaded?.();
    } catch (error) {
      logger?.warn(
        `[SharedConfig] config identity 回调执行失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  function finalizeConfigFile(params: {
    nextConfig: AppConfig;
    previousConfig: AppConfig;
    stamp: FileStamp;
    changes: ConfigChanges;
    candidateModels?: ModelsHotUpdateCommit;
    rollbackModels?: ModelsHotUpdateCommit;
    candidateSystemPrompts?: () => void;
    rollbackSystemPrompts?: () => void;
    candidateStt?: SttRuntimeUpdateCommit;
    rollbackStt?: SttRuntimeUpdateCommit;
    candidateWebTools?: WebToolsRuntimeUpdateCommit;
    rollbackWebTools?: WebToolsRuntimeUpdateCommit;
  }): boolean {
    const steps: SharedConfigCommitStep[] = [];
    const addStep = (label: string, commit?: () => void, rollback?: () => void): void => {
      if (commit && rollback) steps.push({ label, commit, rollback });
    };
    addStep('models/title/guardrail/pricing', params.candidateModels, params.rollbackModels);
    addStep('system prompts', params.candidateSystemPrompts, params.rollbackSystemPrompts);
    addStep('stt', params.candidateStt, params.rollbackStt);
    addStep('web tools', params.candidateWebTools, params.rollbackWebTools);
    steps.push({
      label: 'AppConfig',
      commit: () => applyConfigSlices(params.nextConfig, params.changes),
      rollback: () => applyConfigSlices(params.previousConfig, params.changes),
    });

    return finalizeSharedConfigTransaction({
      steps,
      isCandidateCurrent: () => sameStamp(readStamp(configPath), params.stamp),
      publish: () => publishConfigFile(params.nextConfig, params.stamp, params.changes),
      onFailure: ({ error, rollbackErrors }) => {
        configRefreshNeedsRetry = true;
        for (const rollbackError of rollbackErrors)
          markDirtyRollback(rollbackError.label, params.changes);
        const rollbackMessage =
          rollbackErrors.length > 0
            ? `；回滚失败：${rollbackErrors
                .map(
                  ({ label, error: rollbackError }) =>
                    `${label}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
                )
                .join('；')}`
            : '';
        const dirtyMessage =
          dirtyConfigChanges.size > 0
            ? `；脏执行切面（下一轮强制重放）：${dirtyChangeLabels().join(', ')}`
            : '';
        warnConfigReload(
          new Error(
            `${error instanceof Error ? error.message : String(error)}${rollbackMessage}${dirtyMessage}`,
          ),
        );
      },
    });
  }

  function refreshConfigFile(): boolean | Promise<boolean> {
    const snapshot = readSnapshot(configPath);
    const observedStamp = snapshot?.stamp;
    if (observedStamp && !configRefreshNeedsRetry && sameStamp(observedStamp, appliedConfigStamp)) {
      configRefreshNeedsRetry = false;
      return true;
    }
    if (pendingConfigStamp !== undefined && sameStamp(observedStamp, pendingConfigStamp)) {
      return pendingConfigRefresh ?? false;
    }
    if (!snapshot) {
      warnConfigReload(new Error(`配置文件不可读取：${configPath}`));
      return false;
    }

    const stamp = snapshot.stamp;
    let nextConfig: AppConfig;
    let previousConfig: AppConfig;
    let changes: ConfigChanges;
    let candidateModels: ModelsHotUpdateCommit | undefined;
    let rollbackModels: ModelsHotUpdateCommit | undefined;
    let candidateSystemPrompts: (() => void) | undefined;
    let rollbackSystemPrompts: (() => void) | undefined;
    try {
      nextConfig = parseAppConfig(parseJsonc(snapshot.text));
      if (config.models && !nextConfig.models) {
        throw new Error('运行中移除 models 需要重启，拒绝推进共享配置指纹');
      }
      previousConfig = { ...config } as AppConfig;
      changes = getConfigChanges(nextConfig);
      if (dirtyConfigChanges.size > 0) {
        logger?.info(
          `[SharedConfig] 检测到脏执行切面，强制重放：${dirtyChangeLabels().join(', ')}`,
        );
      }

      if (changes.models || changes.titleGenerator || changes.guardrail) {
        if (!nextConfig.models || !previousConfig.models) {
          throw new Error('模型执行侧缺少可回滚的提交前快照，拒绝热更新');
        }
        // 最新 main 的模型凭据使用 SecretRef；装配层提供异步 prepare 时，必须先解析
        // 候选与回滚快照，不能把持久化 ref 配置直接发布给执行 resolver。
        if (!onModelsUpdated) {
          candidateModels = prepareModelsHotUpdate({
            config: nextConfig,
            target,
            models: nextConfig.models,
          });
          rollbackModels = prepareModelsHotUpdate({
            config: previousConfig,
            target,
            models: previousConfig.models,
          });
        }
      }
      if (changes.systemPrompts && prepareSystemPromptOverridesUpdate) {
        candidateSystemPrompts = prepareSystemPromptOverridesUpdate(nextConfig.systemPrompts ?? {});
        rollbackSystemPrompts = prepareSystemPromptOverridesUpdate(
          previousConfig.systemPrompts ?? {},
        );
      }
    } catch (error) {
      warnConfigReload(error);
      return false;
    }

    const finalize = (
      resolvedCandidateModels?: ModelsHotUpdateCommit,
      resolvedRollbackModels?: ModelsHotUpdateCommit,
      resolvedCandidateWebTools?: WebToolsRuntimeUpdateCommit,
      resolvedRollbackWebTools?: WebToolsRuntimeUpdateCommit,
      resolvedCandidateStt?: SttRuntimeUpdateCommit,
      resolvedRollbackStt?: SttRuntimeUpdateCommit,
    ): boolean => {
      // prepare/SecretVault 期间已被覆盖时，候选尚无副作用，直接丢弃。
      if (!sameStamp(readStamp(configPath), stamp)) {
        configRefreshNeedsRetry = true;
        return false;
      }
      return finalizeConfigFile({
        nextConfig,
        previousConfig,
        stamp,
        changes,
        candidateModels: resolvedCandidateModels ?? candidateModels,
        rollbackModels: resolvedRollbackModels ?? rollbackModels,
        candidateSystemPrompts,
        rollbackSystemPrompts,
        candidateWebTools: resolvedCandidateWebTools,
        rollbackWebTools: resolvedRollbackWebTools,
        candidateStt: resolvedCandidateStt,
        rollbackStt: resolvedRollbackStt,
      });
    };

    // 所有纯同步 prepare 已完成后，才启动可能返回 Promise 的门禁与 SecretVault prepare。
    // 每个 Promise 在启动当下即转为永不 reject 的 outcome，随后统一汇合，避免后续同步
    // 抛错或兄弟 Promise 提前失败时留下 unhandled rejection。
    const preparations = [
      validateConfigReload
        ? startControlledPreparation(() => validateConfigReload(nextConfig))
        : { ok: true as const, value: undefined },
      (changes.models || changes.titleGenerator || changes.guardrail) && onModelsUpdated
        ? startControlledPreparation(() => onModelsUpdated(nextConfig))
        : { ok: true as const, value: undefined },
      (changes.models || changes.titleGenerator || changes.guardrail) && onModelsUpdated
        ? startControlledPreparation(() => onModelsUpdated(previousConfig))
        : { ok: true as const, value: undefined },
      changes.webTools && prepareWebToolsUpdate
        ? startControlledPreparation(() => prepareWebToolsUpdate(nextConfig.webTools))
        : { ok: true as const, value: undefined },
      changes.webTools && prepareWebToolsUpdate
        ? startControlledPreparation(() => prepareWebToolsUpdate(previousConfig.webTools))
        : { ok: true as const, value: undefined },
      changes.stt && prepareSttUpdate
        ? startControlledPreparation(() => prepareSttUpdate(nextConfig.stt))
        : { ok: true as const, value: undefined },
      changes.stt && prepareSttUpdate
        ? startControlledPreparation(() => prepareSttUpdate(previousConfig.stt))
        : { ok: true as const, value: undefined },
    ] as const;
    const completePreparations = (results: PreparationResults): boolean => {
      const failed = results.find((result) => !result.ok);
      if (failed && !failed.ok) {
        warnConfigReload(failed.error);
        return false;
      }
      return finalize(
        results[1].ok ? results[1].value : undefined,
        results[2].ok ? results[2].value : undefined,
        results[3].ok ? results[3].value : undefined,
        results[4].ok ? results[4].value : undefined,
        results[5].ok ? results[5].value : undefined,
        results[6].ok ? results[6].value : undefined,
      );
    };

    if (preparations.some(isPromiseLike)) {
      pendingConfigStamp = stamp;
      pendingConfigRefresh = Promise.all(preparations)
        .then((results) => completePreparations(results as PreparationResults))
        .catch((error) => {
          warnConfigReload(error);
          return false;
        })
        .finally(() => {
          pendingConfigStamp = undefined;
          pendingConfigRefresh = undefined;
        });
      return pendingConfigRefresh;
    }

    return completePreparations(preparations as PreparationResults);
  }

  function refreshTenantsFile(): boolean {
    if (!tenantStore || !tenantsFilePath) return true;
    const snapshot = readSnapshot(tenantsFilePath);
    const stamp = snapshot?.stamp;
    if (sameStamp(stamp, appliedTenantsStamp)) {
      tenantRefreshNeedsRetry = false;
      return true;
    }
    try {
      const prepared = snapshot ? tenantStore.prepareReloadSnapshot(snapshot.text) : undefined;
      if (!sameStamp(stamp, readStamp(tenantsFilePath))) {
        tenantRefreshNeedsRetry = true;
        return false;
      }
      if (prepared) prepared.commit();
      else tenantStore.reload();
      const afterReload = readStamp(tenantsFilePath);
      if (!sameStamp(stamp, afterReload)) {
        prepared?.rollback();
        tenantRefreshNeedsRetry = true;
        return false;
      }
      appliedTenantsStamp = afterReload;
      tenantRefreshNeedsRetry = false;
      logger?.info('[SharedConfig] 已两阶段提交组织配置快照（模型白名单/功能开关）');
      return true;
    } catch (error) {
      tenantRefreshNeedsRetry = true;
      logger?.warn(
        `[SharedConfig] 组织配置读取失败，保留现有白名单并拒绝本次解析：${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  return {
    refreshIfChanged(force = false): boolean | Promise<boolean> {
      if (pendingConfigRefresh) {
        const tenantsFresh = refreshTenantsFile();
        return pendingConfigRefresh.then((configFresh) => configFresh && tenantsFresh);
      }
      const ts = now();
      if (
        !force &&
        !configRefreshNeedsRetry &&
        !tenantRefreshNeedsRetry &&
        ts - lastCheckedAtMs < minStatIntervalMs
      )
        return true;
      lastCheckedAtMs = ts;
      const configFresh = refreshConfigFile();
      const tenantsFresh = refreshTenantsFile();
      return configFresh instanceof Promise
        ? configFresh.then((fresh) => fresh && tenantsFresh)
        : configFresh && tenantsFresh;
    },
    acknowledgeConfigApplied(expectedConfigText) {
      const snapshot = readSnapshot(configPath);
      if (dirtyConfigChanges.size > 0) {
        configRefreshNeedsRetry = true;
        logger?.warn(
          `[SharedConfig] 存在脏执行切面，拒绝仅推进配置指纹：${dirtyChangeLabels().join(', ')}`,
        );
        return false;
      }
      if (!snapshot?.stamp.stable || snapshot.text !== expectedConfigText) {
        configRefreshNeedsRetry = true;
        appliedConfigStamp = undefined;
        return false;
      }
      appliedConfigStamp = snapshot.stamp;
      configRefreshNeedsRetry = false;
      lastCheckedAtMs = now();
      return true;
    },
    getAppliedStamps() {
      return { config: appliedConfigStamp, tenants: appliedTenantsStamp };
    },
  };
}

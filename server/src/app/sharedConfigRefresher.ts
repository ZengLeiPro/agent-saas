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

/** 非安全入口的最小检查间隔；模型、消息等安全入口会用 force 绕过。 */
const DEFAULT_MIN_STAT_INTERVAL_MS = 1000;

interface FileStamp {
  mtimeMs: number;
  size: number;
  digest: string;
  stable: boolean;
}

interface FileSnapshot { stamp: FileStamp; text: string }

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
  return a.stable && b.stable && a.mtimeMs === b.mtimeMs && a.size === b.size && a.digest === b.digest;
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
  /** 供测试与诊断：返回已应用的磁盘指纹。 */
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

  function applyConfigFile(
    nextConfig: AppConfig,
    stamp: FileStamp | undefined,
    commitModelsUpdate?: ModelsHotUpdateCommit,
    commitSystemPromptOverridesUpdate?: () => void,
    commitWebToolsUpdate?: WebToolsRuntimeUpdateCommit,
    commitSttUpdate?: SttRuntimeUpdateCommit,
  ): void {
    const webToolsChanged = JSON.stringify(config.webTools ?? null)
      !== JSON.stringify(nextConfig.webTools ?? null);
    const modelsChanged = Boolean(nextConfig.models)
      && JSON.stringify(config.models ?? null) !== JSON.stringify(nextConfig.models);
    const titleGeneratorChanged = JSON.stringify(config.titleGenerator ?? null)
      !== JSON.stringify(nextConfig.titleGenerator ?? null);
    const guardrailChanged = JSON.stringify(config.guardrail ?? null)
      !== JSON.stringify(nextConfig.guardrail ?? null);
    const systemPromptsChanged = JSON.stringify(config.systemPrompts ?? null)
      !== JSON.stringify(nextConfig.systemPrompts ?? null);
    const toolControlsChanged = JSON.stringify(config.toolControls ?? null)
      !== JSON.stringify(nextConfig.toolControls ?? null);
    const codexSubscriptionChanged = JSON.stringify(config.codexSubscription ?? null)
      !== JSON.stringify(nextConfig.codexSubscription ?? null);
    const sttChanged = JSON.stringify(config.stt ?? null)
      !== JSON.stringify(nextConfig.stt ?? null);

    // 所有可失败的解析、校验与 SecretVault 读取均已在 prepare 阶段完成。
    // 以下 commit 只允许同步赋值；同一 JS 调用栈内发布执行侧与 AppConfig。
    commitModelsUpdate?.();
    commitSystemPromptOverridesUpdate?.();
    commitSttUpdate?.();
    commitWebToolsUpdate?.();

    if (modelsChanged) config.models = nextConfig.models;
    if (titleGeneratorChanged) {
      if (nextConfig.titleGenerator) config.titleGenerator = nextConfig.titleGenerator;
      else delete config.titleGenerator;
    }
    if (guardrailChanged) {
      if (nextConfig.guardrail) config.guardrail = nextConfig.guardrail;
      else delete config.guardrail;
    }

    if (systemPromptsChanged) {
      if (nextConfig.systemPrompts) config.systemPrompts = nextConfig.systemPrompts;
      else delete config.systemPrompts;
    }
    if (toolControlsChanged) {
      if (nextConfig.toolControls) config.toolControls = nextConfig.toolControls;
      else delete config.toolControls;
    }
    if (codexSubscriptionChanged) {
      if (nextConfig.codexSubscription) config.codexSubscription = nextConfig.codexSubscription;
      else delete config.codexSubscription;
    }
    if (sttChanged) {
      if (nextConfig.stt) config.stt = nextConfig.stt;
      else delete config.stt;
    }
    if (webToolsChanged) {
      if (nextConfig.webTools) config.webTools = nextConfig.webTools;
      else delete config.webTools;
    }

    if ((modelsChanged || titleGeneratorChanged || guardrailChanged) && nextConfig.models) {
      logger?.info(
        `[SharedConfig] 已从磁盘热更新模型及辅助模型配置：${nextConfig.models.groups.length} 组 / ` +
          `${nextConfig.models.groups.reduce((n, g) => n + g.models.length, 0)} 个模型`,
      );
    }
    if (systemPromptsChanged) logger?.info('[SharedConfig] 已从磁盘热更新系统提示语配置');
    if (toolControlsChanged) logger?.info('[SharedConfig] 已从磁盘热更新工具开关与描述覆盖配置');
    if (codexSubscriptionChanged) {
      const refs = nextConfig.codexSubscription?.credentialRefs?.length
        ? nextConfig.codexSubscription.credentialRefs
        : nextConfig.codexSubscription?.credentialRef
          ? [nextConfig.codexSubscription.credentialRef]
          : [];
      logger?.info(
        `[SharedConfig] 已从磁盘热更新 Codex 订阅配置：enabled=${nextConfig.codexSubscription?.enabled === true} / `
          + `websocketEnabled=${nextConfig.codexSubscription?.websocketEnabled === true} / `
          + `credentialCount=${new Set(refs).size}`,
      );
    }
    if (sttChanged) {
      logger?.info(
        `[SharedConfig] 已从磁盘热更新语音转写配置：enabled=${nextConfig.stt?.enabled === true}`,
      );
    }
    if (webToolsChanged) {
      logger?.info(
        `[SharedConfig] 已从磁盘热更新 Web 工具配置：search provider=${nextConfig.webTools?.search?.provider ?? 'none'}`,
      );
    }

    appliedConfigStamp = stamp;
    configRefreshNeedsRetry = false;
    try {
      // 整体重载成功：即便逐段都没命中，身份层也需要重算。
      onConfigReloaded?.();
    } catch (error) {
      logger?.warn(
        `[SharedConfig] config identity 回调执行失败：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  function refreshConfigFile(): boolean | Promise<boolean> {
    const snapshot = readSnapshot(configPath);
    const stamp = snapshot?.stamp;
    if (stamp && !configRefreshNeedsRetry && sameStamp(stamp, appliedConfigStamp)) { configRefreshNeedsRetry = false; return true; }
    if (pendingConfigStamp !== undefined && sameStamp(stamp, pendingConfigStamp)) {
      return pendingConfigRefresh ?? false;
    }

    let nextConfig: AppConfig;
    let validation: void | Promise<void>;
    let modelsPreparation: ModelsHotUpdateCommit | Promise<ModelsHotUpdateCommit> | undefined;
    let systemPromptPreparation: (() => void) | undefined;
    let webToolsPreparation: WebToolsRuntimeUpdateCommit | Promise<WebToolsRuntimeUpdateCommit> | undefined;
    let sttPreparation: SttRuntimeUpdateCommit | Promise<SttRuntimeUpdateCommit> | undefined;
    try {
      if (!snapshot) throw new Error(`配置文件不可读取：${configPath}`);
      nextConfig = parseAppConfig(parseJsonc(snapshot.text));
      if (config.models && !nextConfig.models) {
        throw new Error('运行中移除 models 需要重启，拒绝推进共享配置指纹');
      }
      validation = validateConfigReload?.(nextConfig);
      const modelsChanged = Boolean(nextConfig.models)
        && JSON.stringify(config.models ?? null) !== JSON.stringify(nextConfig.models);
      const titleGeneratorChanged = JSON.stringify(config.titleGenerator ?? null)
        !== JSON.stringify(nextConfig.titleGenerator ?? null);
      const guardrailChanged = JSON.stringify(config.guardrail ?? null)
        !== JSON.stringify(nextConfig.guardrail ?? null);
      modelsPreparation = (modelsChanged || titleGeneratorChanged || guardrailChanged)
        && nextConfig.models
        ? onModelsUpdated?.(nextConfig)
          ?? prepareModelsHotUpdate({ config: nextConfig, target, models: nextConfig.models })
        : undefined;
      const systemPromptsChanged = JSON.stringify(config.systemPrompts ?? null)
        !== JSON.stringify(nextConfig.systemPrompts ?? null);
      systemPromptPreparation = systemPromptsChanged
        ? prepareSystemPromptOverridesUpdate?.(nextConfig.systemPrompts ?? {})
        : undefined;
      const webToolsChanged = JSON.stringify(config.webTools ?? null)
        !== JSON.stringify(nextConfig.webTools ?? null);
      webToolsPreparation = webToolsChanged
        ? prepareWebToolsUpdate?.(nextConfig.webTools)
        : undefined;
      const sttChanged = JSON.stringify(config.stt ?? null)
        !== JSON.stringify(nextConfig.stt ?? null);
      sttPreparation = sttChanged ? prepareSttUpdate?.(nextConfig.stt) : undefined;
    } catch (error) {
      warnConfigReload(error);
      return false;
    }

    const validationAsync = validation && typeof validation.then === 'function';
    const modelsPreparationAsync = modelsPreparation
      && typeof (modelsPreparation as Promise<ModelsHotUpdateCommit>).then === 'function';
    const webToolsPreparationAsync = webToolsPreparation
      && typeof (webToolsPreparation as Promise<WebToolsRuntimeUpdateCommit>).then === 'function';
    const sttPreparationAsync = sttPreparation
      && typeof (sttPreparation as Promise<SttRuntimeUpdateCommit>).then === 'function';
    if (validationAsync || modelsPreparationAsync || webToolsPreparationAsync || sttPreparationAsync) {
      pendingConfigStamp = stamp;
      pendingConfigRefresh = Promise.all([
        Promise.resolve(validation),
        Promise.resolve(modelsPreparation),
        Promise.resolve(webToolsPreparation),
        Promise.resolve(sttPreparation),
      ])
        .then(([, commitModelsUpdate, commitWebToolsUpdate, commitSttUpdate]) => {
          // 校验/凭据解析期间文件若再次变化，丢弃无副作用候选并让当前请求 fail closed。
          if (!sameStamp(readStamp(configPath), stamp)) { configRefreshNeedsRetry = true; return false; }
          applyConfigFile(
            nextConfig,
            stamp,
            commitModelsUpdate,
            systemPromptPreparation,
            commitWebToolsUpdate,
            commitSttUpdate,
          );
          if (!sameStamp(readStamp(configPath), stamp)) { configRefreshNeedsRetry = true; appliedConfigStamp = undefined; return false; }
          return true;
        })
        .catch((error) => { warnConfigReload(error); return false; })
        .finally(() => {
          pendingConfigStamp = undefined;
          pendingConfigRefresh = undefined;
        });
      return pendingConfigRefresh;
    }
    try {
      if (!sameStamp(readStamp(configPath), stamp)) { configRefreshNeedsRetry = true; return false; }
      applyConfigFile(
        nextConfig,
        stamp,
        modelsPreparation as ModelsHotUpdateCommit | undefined,
        systemPromptPreparation,
        webToolsPreparation as WebToolsRuntimeUpdateCommit | undefined,
        sttPreparation as SttRuntimeUpdateCommit | undefined,
      );
      if (!sameStamp(readStamp(configPath), stamp)) { configRefreshNeedsRetry = true; appliedConfigStamp = undefined; return false; }
      return true;
    } catch (error) {
      warnConfigReload(error);
      return false;
    }
  }

  function refreshTenantsFile(): boolean {
    if (!tenantStore || !tenantsFilePath) return true;
    const snapshot = readSnapshot(tenantsFilePath);
    const stamp = snapshot?.stamp;
    if (sameStamp(stamp, appliedTenantsStamp)) { tenantRefreshNeedsRetry = false; return true; }
    try {
      const prepared = snapshot ? tenantStore.prepareReloadSnapshot(snapshot.text) : undefined;
      if (!sameStamp(stamp, readStamp(tenantsFilePath))) { tenantRefreshNeedsRetry = true; return false; }
      if (prepared) prepared.commit();
      else tenantStore.reload();
      const afterReload = readStamp(tenantsFilePath);
      if (!sameStamp(stamp, afterReload)) { prepared?.rollback(); tenantRefreshNeedsRetry = true; return false; }
      appliedTenantsStamp = afterReload;
      tenantRefreshNeedsRetry = false;
      logger?.info('[SharedConfig] 已两阶段提交组织配置快照（模型白名单/功能开关）');
      return true;
    } catch (error) {
      tenantRefreshNeedsRetry = true;
      logger?.warn(`[SharedConfig] 组织配置读取失败，保留现有白名单并拒绝本次解析：${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  return {
    refreshIfChanged(force = false): boolean | Promise<boolean> {
      if (pendingConfigRefresh) { const tenantsFresh = refreshTenantsFile(); return pendingConfigRefresh.then((configFresh) => configFresh && tenantsFresh); }
      const ts = now();
      if (!force && !configRefreshNeedsRetry && !tenantRefreshNeedsRetry && ts - lastCheckedAtMs < minStatIntervalMs) return true;
      lastCheckedAtMs = ts;
      const configFresh = refreshConfigFile();
      const tenantsFresh = refreshTenantsFile();
      return configFresh instanceof Promise
        ? configFresh.then((fresh) => fresh && tenantsFresh)
        : configFresh && tenantsFresh;
    },
    acknowledgeConfigApplied(expectedConfigText) {
      const snapshot = readSnapshot(configPath);
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

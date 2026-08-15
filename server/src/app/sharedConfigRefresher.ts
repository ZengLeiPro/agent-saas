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
 *   - 用 statSync 的 mtimeMs+size 做变更判据，未变化时零解析开销；
 *   - 带最小间隔节流，避免热路径高频 stat；
 *   - 解析失败保留旧配置并告警，绝不因为一次坏写入把正在服务的进程打挂。
 */
import { statSync } from 'node:fs';
import type { AppConfig } from './config.js';
import { getAppConfigPath, loadAppConfig } from './config.js';
import type { TenantStore } from '../data/tenants/store.js';
import { applyModelsHotUpdate, type ModelsHotUpdateTarget } from './modelsHotUpdate.js';

/** 同一文件两次 stat 的最小间隔，避免 resolver 热路径打满 IO。 */
const DEFAULT_MIN_STAT_INTERVAL_MS = 1000;

interface FileStamp {
  mtimeMs: number;
  size: number;
}

function readStamp(filePath: string): FileStamp | undefined {
  try {
    const st = statSync(filePath);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return undefined;
  }
}

function sameStamp(a: FileStamp | undefined, b: FileStamp | undefined): boolean {
  if (!a || !b) return a === b;
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

export interface SharedConfigRefresher {
  /**
   * 若磁盘上的 config.json / tenants.json 已被其他进程改写，则重新加载并应用。
   * 幂等、可高频调用；未发生变化时开销为一次 statSync（受节流保护）。
   */
  refreshIfChanged(): void;
  /** 供测试与诊断：返回已应用的磁盘指纹。 */
  getAppliedStamps(): { config?: FileStamp; tenants?: FileStamp };
}

export function createSharedConfigRefresher(params: {
  config: AppConfig;
  processCwd: string;
  target: ModelsHotUpdateTarget;
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
    tenantStore,
    tenantsFilePath,
    logger,
    minStatIntervalMs = DEFAULT_MIN_STAT_INTERVAL_MS,
    now = Date.now,
  } = params;

  const configPath = getAppConfigPath(processCwd);
  // 进程启动时已经读过一次盘，把当时的指纹作为基线，避免首次调用做无谓重载。
  let appliedConfigStamp = readStamp(configPath);
  let appliedTenantsStamp = tenantsFilePath ? readStamp(tenantsFilePath) : undefined;
  let lastCheckedAtMs = 0;

  function refreshConfigFile(): void {
    const stamp = readStamp(configPath);
    if (sameStamp(stamp, appliedConfigStamp)) return;

    let nextConfig: AppConfig;
    try {
      nextConfig = loadAppConfig(processCwd);
    } catch (error) {
      // 别人正写到一半、或写坏了：保留当前内存配置，等下一次变更再试。
      // 不推进 appliedConfigStamp，这样修好之后能立刻被重新拾起。
      logger?.warn(
        `[SharedConfig] config.json 已变化但解析失败，继续使用当前内存配置：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }

    const modelsChanged = Boolean(nextConfig.models)
      && JSON.stringify(config.models ?? null) !== JSON.stringify(nextConfig.models);
    const titleChanged = JSON.stringify(config.titleGenerator ?? null)
      !== JSON.stringify(nextConfig.titleGenerator ?? null);
    const guardrailChanged = JSON.stringify(config.guardrail ?? null)
      !== JSON.stringify(nextConfig.guardrail ?? null);

    if (modelsChanged) config.models = nextConfig.models;
    if (titleChanged) {
      if (nextConfig.titleGenerator) config.titleGenerator = nextConfig.titleGenerator;
      else delete config.titleGenerator;
    }
    if (guardrailChanged) {
      if (nextConfig.guardrail) config.guardrail = nextConfig.guardrail;
      else delete config.guardrail;
    }

    if ((modelsChanged || titleChanged || guardrailChanged) && config.models) {
      applyModelsHotUpdate({ config, target, models: config.models });
      logger?.info(
        `[SharedConfig] 已从磁盘热更新模型及辅助模型配置：${config.models.groups.length} 组 / ` +
          `${config.models.groups.reduce((n, g) => n + g.models.length, 0)} 个模型`,
      );
    }

    appliedConfigStamp = stamp;
  }

  function refreshTenantsFile(): void {
    if (!tenantStore || !tenantsFilePath) return;
    const stamp = readStamp(tenantsFilePath);
    if (sameStamp(stamp, appliedTenantsStamp)) return;
    tenantStore.reload();
    appliedTenantsStamp = stamp;
    logger?.info('[SharedConfig] 已从磁盘重载组织配置（模型白名单/功能开关）');
  }

  return {
    refreshIfChanged(): void {
      const ts = now();
      if (ts - lastCheckedAtMs < minStatIntervalMs) return;
      lastCheckedAtMs = ts;
      refreshConfigFile();
      refreshTenantsFile();
    },
    getAppliedStamps() {
      return { config: appliedConfigStamp, tenants: appliedTenantsStamp };
    },
  };
}

import { createHash } from 'node:crypto';
import type {
  SandboxLifecycleDecisionName,
  SandboxLifecycleState,
  SandboxWorkloadClass,
  SandboxWorkloadDescriptor,
} from './sandboxLifecyclePolicy.js';

/**
 * Sandbox 的状态模型与纯判定函数。
 *
 * 从 `sandboxManager.ts` 抽出：这些是不依赖 SandboxManager 实例、也不触碰
 * kubectl/网络的纯函数（CR 解析、状态判定、命名与路径校验），单独成文件后
 * 既便于直接单测，也让 sandboxManager 只留编排逻辑。
 */

export interface SandboxStatus {
  phase?: string;
  raw?: Record<string, unknown>;
}

export interface ManagedSandbox extends SandboxLifecycleState {
  name: string;
  workspaceId?: string;
  sessionId?: string;
  sandboxScopeId?: string;
  mountSubPath?: string;
  phase?: string;
  deletionTimestamp?: string;
  networkCleanupFinalizer?: boolean;
  brokenReason?: string;
  /**
   * status.conditions 里 SandboxPaused condition 的 lastTransitionTime。
   * 用于 broken 态回收宽限判定：condition 卡在 False/ImageChanged 超过宽限期才回收，
   * 避免误伤正常 pause/resume 过程中的瞬态。
   */
  pausedConditionChangedAt?: string;
  createdAt?: string;
  lastActiveAt?: string;
  /** 后台 Shell 仍可能运行的最晚时间；生命周期在此之前不得 pause/delete/recreate。 */
  backgroundShellProtectedUntil?: string;
  /**
   * 当前 Sandbox spec 里 podTemplate 主容器的 image tag，用于 image drift 判定。
   */
  image?: string;
  cpuRequest?: string;
  cpuLimit?: string;
  memoryRequest?: string;
  memoryLimit?: string;
}

export interface ManagedSandboxInventory extends ManagedSandbox {
  busy: boolean;
  workloadClass: SandboxWorkloadClass;
  workloadDescriptor: SandboxWorkloadDescriptor;
  lifecycleDecision: SandboxLifecycleDecisionName;
  lifecycleDecisionReason: string;
  lifecycleDeadlineAt?: string;
  terminalDeadlineAt?: string;
  imageStale: boolean;
  idleMs?: number;
  ttlRemainingMs?: number;
  effectiveTtlMs?: number;
}

export const BACKGROUND_SHELL_PROTECTED_UNTIL_ANNOTATION = 'agent-saas.kaiyan.net/background-shell-protected-until';

export function labelValue(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 40);
}

/**
 * 由容器内存 limit 推导 Node 堆上限（MiB），留 25% 给非堆内存。
 * 解析失败或未配置时返回 undefined（不注入 NODE_OPTIONS，保持既有行为）。
 */
export function nodeHeapLimitMb(memoryLimit: string | undefined): number | undefined {
  if (!memoryLimit) return undefined;
  const m = /^(\d+(?:\.\d+)?)(Gi|Mi|G|M)?$/.exec(memoryLimit.trim());
  if (!m) return undefined;
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const unit = m[2] ?? 'Mi';
  const mib = unit === 'Gi' ? value * 1024
    : unit === 'G' ? (value * 1_000_000_000) / (1024 * 1024)
    : unit === 'M' ? (value * 1_000_000) / (1024 * 1024)
    : value;
  const heap = Math.floor(mib * 0.75);
  return heap >= 256 ? heap : undefined;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

export function optionalString<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  return value === undefined ? {} : { [key]: value } as Partial<Record<K, string>>;
}

export function normalizeMountSubPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('mountSubPath must not be empty');
  if (trimmed.startsWith('/') || trimmed.includes('\\')) throw new Error('mountSubPath must be a relative POSIX path');
  const parts = trimmed.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error('mountSubPath must not contain empty segments, . or ..');
  }
  return parts.join('/');
}

export function parseDateMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function isBackgroundShellProtected(sandbox: Pick<ManagedSandbox, 'backgroundShellProtectedUntil'>, nowMs: number): boolean {
  const protectedUntilMs = parseDateMs(sandbox.backgroundShellProtectedUntil);
  return protectedUntilMs !== undefined && protectedUntilMs > nowMs;
}

export function backgroundShellProtectionFromStatus(status: SandboxStatus, nowMs = Date.now()): string | undefined {
  const raw = status.raw ?? {};
  const metadata = raw.metadata && typeof raw.metadata === 'object' ? raw.metadata as Record<string, unknown> : {};
  const annotations = metadata.annotations && typeof metadata.annotations === 'object'
    ? metadata.annotations as Record<string, unknown>
    : {};
  const protectedUntil = stringValue(annotations[BACKGROUND_SHELL_PROTECTED_UNTIL_ANNOTATION]);
  const parsed = parseDateMs(protectedUntil);
  return parsed !== undefined && parsed > nowMs ? protectedUntil : undefined;
}

export function brokenSandboxStateReason(status: SandboxStatus): string | undefined {
  const raw = status.raw ?? {};
  const spec = raw.spec && typeof raw.spec === 'object' ? raw.spec as Record<string, unknown> : {};
  const statusBody = raw.status && typeof raw.status === 'object' ? raw.status as Record<string, unknown> : {};
  const podInfo = statusBody.podInfo && typeof statusBody.podInfo === 'object' ? statusBody.podInfo as Record<string, unknown> : {};
  const podAnnotations = podInfo.annotations && typeof podInfo.annotations === 'object' ? podInfo.annotations as Record<string, unknown> : {};
  const conditions = Array.isArray(statusBody.conditions) ? statusBody.conditions : [];
  const pausedCondition = conditions.find((condition): condition is Record<string, unknown> => (
    Boolean(condition)
    && typeof condition === 'object'
    && (condition as Record<string, unknown>).type === 'SandboxPaused'
  ));
  const pausedReason = stringValue(pausedCondition?.reason);
  const pausedStatus = stringValue(pausedCondition?.status);
  const recreating = stringValue(podAnnotations['ops.alibabacloud.com/recreating']) === 'true';
  const requestedRunning = spec.paused === false;
  const message = stringValue(statusBody.message);

  if (status.phase === 'Failed') {
    if (message && /pod not found/i.test(message)) return 'failed_pod_not_found';
    if (recreating) return 'failed_recreating';
    return 'failed';
  }

  if (status.phase !== 'Paused') return undefined;

  if (pausedReason === 'ImageChanged' && pausedStatus === 'False') return 'image_changed';
  // 2026-07-31 收窄：`ops.alibabacloud.com/recreating=true` 单独不构成 broken。
  // 生产实测该 annotation 是 ACS 常态标记（全部 8 个 sandbox 包括 Running 中的
  // 都带着），把它当 broken 导致 resume 快路径 7 天 0 命中、每次唤醒都删除重建
  // （P50 35.8s）。生产实验证实 Paused+recreating 直接 patch spec.paused=false
  // 可正常恢复：冷 resume ~20s、热 resume ~2s，exec/workspace 均正常。
  // 07-06 的真实故障场景（prewarm 后立即 pause 留下的半状态）由上面的
  // image_changed 与下面的 requested_running 两条判定继续兜住。
  if (requestedRunning) return 'requested_running';
  return undefined;
}

export function brokenPausedStateReason(status: SandboxStatus): string | undefined {
  if (status.phase !== 'Paused') return undefined;
  return brokenSandboxStateReason(status);
}

/** 从 Sandbox CR item 里取 SandboxPaused condition 的 lastTransitionTime（用于 broken 回收宽限判定）。 */
export function pausedConditionLastTransition(item: Record<string, unknown>): string | undefined {
  const statusBody = item.status && typeof item.status === 'object' ? item.status as Record<string, unknown> : {};
  const conditions = Array.isArray(statusBody.conditions) ? statusBody.conditions : [];
  const pausedCondition = conditions.find((condition): condition is Record<string, unknown> => (
    Boolean(condition)
    && typeof condition === 'object'
    && (condition as Record<string, unknown>).type === 'SandboxPaused'
  ));
  return stringValue(pausedCondition?.lastTransitionTime);
}

export function acsNetworkPolicyMode(mode: string): string {
  return mode === 'isolated' ? 'network-policy' : 'traffic-policy';
}

/** ensureRunning 各阶段的计时/留证句柄。 */
export interface EnsureTiming {
  step<T>(stepName: string, fn: () => Promise<T>): Promise<T>;
  finish(path: string, status: 'ok' | 'error'): void;
}

interface EnsureTimingLogger {
  info(message: string): void;
  warn(message: string): void;
}

/**
 * 创建一次 ensureRunning 的计时器。只依赖 logger，不依赖 SandboxManager 状态。
 *
 * 失败分支除了记 `step:error:ms`，还必须留下异常原因：2026-08-11 生产 provision
 * 失败时 journal 里只有 `ensureCapacity:error:884`、没有任何 reason，导致根因完全
 * 无法定位（ACS run 31440440098）。异常照常上抛，这里只补一条可检索的日志。
 */
export function createEnsureTiming(name: string, logger: EnsureTimingLogger): EnsureTiming {
  const startedAt = Date.now();
  const steps: string[] = [];
  return {
    step: async <T>(stepName: string, fn: () => Promise<T>): Promise<T> => {
      const stepStartedAt = Date.now();
      try {
        const result = await fn();
        steps.push(`${stepName}:${Date.now() - stepStartedAt}`);
        return result;
      } catch (err) {
        steps.push(`${stepName}:error:${Date.now() - stepStartedAt}`);
        logger.warn(
          `sandbox_ensure_step_failed sandbox=${name} step=${stepName} `
          + `reason=${err instanceof Error ? err.message : String(err)}`,
        );
        throw err;
      }
    },
    finish: (path: string, status: 'ok' | 'error') => {
      logger.info(`sandbox_ensure_timing sandbox=${name} path=${path} status=${status} totalMs=${Date.now() - startedAt} steps=${steps.join(',')}`);
    },
  };
}

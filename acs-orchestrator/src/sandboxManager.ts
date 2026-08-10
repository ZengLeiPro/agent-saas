import { chmod, chown, mkdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { AcsOrchestratorConfig } from './config.js';
import type { ActiveSandboxRegistry } from './activeSandboxRegistry.js';
import { Kubectl } from './kubectl.js';
import type { KubeApi } from './kubeApi.js';
import { AcsNetworkPolicyManager, type NetworkPolicyProbeDetails } from './networkPolicyManager.js';
import { sandboxNameFor, validateSessionId, validateWorkspaceId } from './sandboxName.js';
import {
  type ManagedSandbox,
  type ManagedSandboxInventory,
  type SandboxStatus,
  type EnsureTiming,
  BACKGROUND_SHELL_PROTECTED_UNTIL_ANNOTATION,
  acsNetworkPolicyMode,
  createEnsureTiming,
  backgroundShellProtectionFromStatus,
  brokenPausedStateReason,
  brokenSandboxStateReason,
  isBackgroundShellProtected,
  isCiSandboxName,
  isRunningCostPhase,
  labelValue,
  nodeHeapLimitMb,
  normalizeMountSubPath,
  optionalString,
  parseDateMs,
  pausedConditionLastTransition,
  stringValue,
} from './sandboxState.js';
import { SnatManager, type SnatCleanupReport, type SnatStatus } from './snatManager.js';
import type { NetworkPolicyStatus } from 'server/runtime/networkPolicy.js';
import {
  buildPackageMirrorEnv,
  buildSandboxProxyEnv,
  egressSandboxFingerprint,
} from 'server/runtime/egressPolicy.js';

// 状态模型与纯判定函数已迁至 ./sandboxState.ts，这里按既有 import 路径继续对外转发。
export type { ManagedSandbox, ManagedSandboxInventory, SandboxStatus } from './sandboxState.js';
export {
  brokenPausedStateReason,
  brokenSandboxStateReason,
  isCiSandboxName,
  nodeHeapLimitMb,
  pausedConditionLastTransition,
} from './sandboxState.js';

/**
 * 单个 Sandbox 的规格覆盖（2026-08-10，A 方案批次 3）。
 * 未指定的字段回落到全局 env 默认值，因此可以只覆盖其中一项。
 * 该对象参与 provision 指纹，改规格会触发 pod 重建——正是期望行为。
 */
export interface SandboxResourceOverride {
  cpuRequest?: string;
  memoryRequest?: string;
  cpuLimit?: string;
  memoryLimit?: string;
}

export interface SandboxRef {
  name: string;
  workspaceId: string;
  sessionId: string;
  sandboxScopeId: string;
  mountSubPath: string;
  /** per-tenant/workspace 规格覆盖；缺省时用全局默认。 */
  resources?: SandboxResourceOverride;
}

export interface SandboxCleanupReport {
  checked: number;
  paused: string[];
  deleted: string[];
  /**
   * 2026-08-01：矛盾态自愈回收的 sandbox。phase=Paused 但 broken（SandboxPaused
   * condition 卡 False/ImageChanged、或 spec.paused=false 半状态）超过宽限期，
   * ACS 对这种「假暂停」持续按运行态计费；巡检删除 CR 止损，NAS workspace 保留，
   * 下次访问自动重建。07-22 事故 21 个、08-01 复发 6 个的兜底修复。
   */
  brokenRecycled: string[];
  skippedBusy: string[];
  snatDeleted: string[];
  snatUnexpected: number;
  runningCount: number;
  totalCount: number;
}

export interface SandboxStaleImagePrewarmReport {
  checked: number;
  queued: string[];
  /**
   * 2026-08-01 语义变更：旧 prewarm（原地 applySandbox 换镜像 + 保持 Running 等
   * idle pause）在 ACS 侧不可靠——07-22/08-01 两轮事故实证：apply 失败无回滚会留
   * 半状态；apply「成功」后续 pause 仍卡 SandboxPaused=False/ImageChanged，均持续
   * 计费。stale Paused sandbox 改为直接删除 CR（retired），NAS workspace 不动，
   * 用户下次访问按新镜像走 create 冷启动。对照实证：recreate 路径 pause 正常。
   */
  retired: string[];
  adopted: string[];
  skipped: string[];
  skippedBusy: string[];
  failed: Array<{ name: string; error: string }>;
}

export interface SandboxInventorySummary {
  totalCount: number;
  phaseCounts: Record<string, number>;
  runningCount: number;
  pausedCount: number;
  oldestCreatedAt?: string;
  newestLastActiveAt?: string;
}

export class SandboxBusyError extends Error {
  readonly statusCode = 409;
}

export class SandboxNotFoundError extends Error {
  readonly statusCode = 404;
}

export class SandboxInvalidStateError extends Error {
  readonly statusCode = 400;
}

const MANAGED_BY_LABEL = 'agent-saas-acs-orchestrator';
const APP_LABEL = 'agent-saas-coding-hand';
const WORKSPACE_LABEL = 'agent-saas.kaiyan.net/workspace-id';
const SANDBOX_SCOPE_LABEL = 'agent-saas.kaiyan.net/sandbox-scope-id';
const SESSION_LABEL = 'agent-saas.kaiyan.net/session-id';
const NETWORK_POLICY_MODE_LABEL = 'agent-saas.kaiyan.net/network-policy-mode';
const WORKSPACE_ANNOTATION = 'agent-saas.kaiyan.net/workspace-id';
const SANDBOX_SCOPE_ANNOTATION = 'agent-saas.kaiyan.net/sandbox-scope-id';
const SESSION_ANNOTATION = 'agent-saas.kaiyan.net/session-id';
const MOUNT_SUBPATH_ANNOTATION = 'agent-saas.kaiyan.net/mount-subpath';
const CREATED_AT_ANNOTATION = 'agent-saas.kaiyan.net/created-at';
const LAST_ACTIVE_AT_ANNOTATION = 'agent-saas.kaiyan.net/last-active-at';
const NETWORK_POLICY_MODE_ANNOTATION = 'agent-saas.kaiyan.net/network-policy-mode';
const NETWORK_POLICY_DENY_PRIVATE_ANNOTATION = 'agent-saas.kaiyan.net/network-policy-deny-private';
const ACS_NETWORK_POLICY_AGENT_ANNOTATION = 'network.alibabacloud.com/enable-network-policy-agent';
const ACS_NETWORK_POLICY_MODE_ANNOTATION = 'network.alibabacloud.com/network-policy-mode';
const EGRESS_FINGERPRINT_ANNOTATION = 'agent-saas.kaiyan.net/egress-fingerprint';
const SANDBOX_TIMEZONE = 'Asia/Shanghai';

/**
 * already_running 快路径缓存 TTL（2026-07-31 冷启动治理批次）。
 * ensureRunning 每次工具调用都会跑 networkPolicy reconcile（~0.5s）+ SNAT
 * ensure（~0.6s），生产 P50 1.4s/次纯 kubectl/CLI 开销。完整校验成功后 5 分钟内
 * 直接信任缓存（getStatus 仍每次真查，Running 由它兜底），把高频路径压到 ~0.4s。
 * 失效点：pause / delete / 重建（invalidateEnsureFastPath）。
 */
const ENSURE_FAST_PATH_TTL_MS = 5 * 60_000;
/** touch（lastActiveAt annotation patch，~0.2s）节流窗口；idle 判定为小时级，60s 精度足够。 */
const TOUCH_THROTTLE_MS = 60_000;

export class SandboxManager {
  private readonly networkPolicyManager: AcsNetworkPolicyManager;
  private readonly snatManager: SnatManager;
  private readonly prewarmInFlight = new Map<string, Promise<void>>();
  /** 同名 Sandbox 并发 ensureRunning 合流：后到者 join 先行者的 promise（消除 warmup/execute 并发 create 竞态与重复开销）。 */
  private readonly ensureInFlight = new Map<string, Promise<SandboxRef>>();
  /** already_running 快路径缓存：完整校验（networkPolicy+SNAT）通过时间与最近 touch 时间。 */
  private readonly ensureFastPath = new Map<string, { verifiedAt: number; touchedAt: number }>();

  constructor(
    private readonly config: AcsOrchestratorConfig,
    private readonly kubectl: Kubectl,
    private readonly logger: { info(msg: string): void; warn(msg: string): void; error(msg: string): void },
    private readonly activeRegistry?: ActiveSandboxRegistry,
    private readonly kubeApi?: KubeApi | null,
  ) {
    this.networkPolicyManager = new AcsNetworkPolicyManager(config, kubectl, logger);
    this.snatManager = new SnatManager(config, kubectl, logger, kubeApi);
  }

  ref(input: {
    workspaceId: string;
    sessionId: string;
    sandboxScopeId?: string;
    mountSubPath?: string;
    resources?: SandboxResourceOverride;
  }): SandboxRef {
    const workspaceId = validateWorkspaceId(input.workspaceId);
    const sessionId = validateSessionId(input.sessionId);
    const sandboxScopeId = validateWorkspaceId(input.sandboxScopeId ?? workspaceId);
    const mountSubPath = normalizeMountSubPath(input.mountSubPath ?? workspaceId);
    return {
      name: sandboxNameFor({ workspaceId, sessionId, sandboxScopeId }),
      workspaceId,
      sessionId,
      sandboxScopeId,
      mountSubPath,
      ...(input.resources && Object.keys(input.resources).length ? { resources: input.resources } : {}),
    };
  }

  async ensureRunning(
    input: {
      workspaceId: string;
      sessionId: string;
      sandboxScopeId?: string;
      mountSubPath?: string;
      resources?: SandboxResourceOverride;
    },
    options: { busySandboxNames?: Set<string>; skipCapacityManagement?: boolean; activeKey?: string } = {},
  ): Promise<SandboxRef> {
    const ref = this.ref(input);
    const inFlight = this.ensureInFlight.get(ref.name);
    if (inFlight) {
      // join 语义：忽略本次 options，等 leader 把 Sandbox 带到 Running 即可。
      // 后到者不执行 recreate/capacity 分支，busy 断言由 leader 自己的 activeKey 保障。
      this.logger.info(`sandbox_ensure_join name=${ref.name}`);
      return await inFlight;
    }
    const promise = this.ensureRunningExclusive(ref, options);
    this.ensureInFlight.set(ref.name, promise);
    try {
      return await promise;
    } finally {
      if (this.ensureInFlight.get(ref.name) === promise) this.ensureInFlight.delete(ref.name);
    }
  }

  private async ensureRunningExclusive(
    ref: SandboxRef,
    options: { busySandboxNames?: Set<string>; skipCapacityManagement?: boolean; activeKey?: string } = {},
  ): Promise<SandboxRef> {
    const timing = createEnsureTiming(ref.name, this.logger);
    let path = 'unknown';
    let status: 'ok' | 'error' = 'error';
    try {
      await timing.step('waitPrewarm', () => this.waitForPrewarm(ref.name));
      await timing.step('ensureHostWorkspace', () => this.ensureHostWorkspace(ref));
      let existing = await timing.step('getStatus', () => this.getStatus(ref.name));
      const brokenState = existing ? brokenSandboxStateReason(existing) : undefined;
      if (existing && brokenState) {
        path = `recreate_broken_${brokenState}`;
        this.assertNotBusyForRecreate(ref, options.busySandboxNames, brokenState, options.activeKey);
        this.logger.warn(
          `sandbox_broken_state name=${ref.name} reason=${brokenState} phase=${existing.phase ?? 'unknown'}`,
        );
        await timing.step('deleteBrokenState', () => this.delete(ref, { activeKey: options.activeKey }));
        existing = null;
      }
      if (existing && this.existingMountSubPath(existing, ref) !== ref.mountSubPath) {
        path = 'recreate_mount_subpath_changed';
        this.assertNotBusyForRecreate(ref, options.busySandboxNames, 'mountSubPath changed', options.activeKey);
        this.logger.warn(
          `sandbox_mount_subpath_changed name=${ref.name} workspaceId=${ref.workspaceId} old=${this.existingMountSubPath(existing, ref)} new=${ref.mountSubPath}`,
        );
        await timing.step('delete', () => this.delete(ref, { activeKey: options.activeKey }));
        existing = null;
      }
      if (
        existing
        && this.existingImage(existing) !== this.config.sandboxImage
        && !backgroundShellProtectionFromStatus(existing)
      ) {
        path = existing.phase === 'Paused' ? 'refresh_paused_image' : 'recreate_image_changed';
        this.assertNotBusyForRecreate(ref, options.busySandboxNames, 'image changed', options.activeKey);
        this.logger.warn(
          `sandbox_image_changed name=${ref.name} workspaceId=${ref.workspaceId} old=${this.existingImage(existing) ?? 'unknown'} new=${this.config.sandboxImage}`,
        );
        if (existing.phase === 'Paused') {
          if (!options.skipCapacityManagement) await timing.step('ensureCapacity', () => this.ensureCapacity(ref.name, options.busySandboxNames));
          await timing.step('networkPolicy', () => this.networkPolicyManager.reconcile(ref));
          await timing.step('applySandbox', () => this.applySandbox(ref));
          await this.waitForRunningAndEnsureSnat(ref, timing);
          this.markEnsureFastPathVerified(ref.name);
          await timing.step('touch', () => this.touchThrottled(ref.name));
          status = 'ok';
          return ref;
        }
        await timing.step('delete', () => this.delete(ref, { activeKey: options.activeKey }));
        existing = null;
      }
      if (!existing) {
        path = path === 'unknown' ? 'create' : path;
        if (!options.skipCapacityManagement) await timing.step('ensureCapacity', () => this.ensureCapacity(ref.name, options.busySandboxNames));
        await timing.step('networkPolicy', () => this.networkPolicyManager.reconcile(ref));
        await timing.step('applySandbox', () => this.applySandbox(ref));
        await this.waitForRunningAndEnsureSnat(ref, timing);
        this.markEnsureFastPathVerified(ref.name);
        await timing.step('touch', () => this.touchThrottled(ref.name));
        status = 'ok';
        return ref;
      }
      // already_running 快路径：5 分钟内完整校验过 networkPolicy+SNAT 的 Running
      // Sandbox，跳过两项 reconcile（合计 ~1.1s/次 kubectl/CLI 开销）。getStatus
      // 上面已真查过 phase，Running 事实不依赖缓存。
      if (existing.phase === 'Running' && this.isEnsureFastPathFresh(ref.name)) {
        path = 'already_running_fast';
        await timing.step('touch', () => this.touchThrottled(ref.name));
        status = 'ok';
        return ref;
      }
      await timing.step('networkPolicy', () => this.networkPolicyManager.reconcile(ref));
      if (existing.phase === 'Paused') {
        path = 'resume_paused';
        if (!options.skipCapacityManagement) await timing.step('ensureCapacity', () => this.ensureCapacity(ref.name, options.busySandboxNames));
        await timing.step('patchUnpause', () => this.patchPaused(ref.name, false));
        await this.waitForRunningAndEnsureSnat(ref, timing);
      } else if (existing.phase !== 'Running') {
        path = 'wait_non_running';
        if (!options.skipCapacityManagement) await timing.step('ensureCapacity', () => this.ensureCapacity(ref.name, options.busySandboxNames));
        await this.waitForRunningAndEnsureSnat(ref, timing);
      } else {
        path = 'already_running';
        await timing.step('ensureSnat', () => this.snatManager.ensureForSandbox(ref));
      }
      this.markEnsureFastPathVerified(ref.name);
      await timing.step('touch', () => this.touchThrottled(ref.name));
      status = 'ok';
      return ref;
    } finally {
      timing.finish(path, status);
    }
  }

  async delete(ref: SandboxRef, options: { activeKey?: string } = {}): Promise<void> {
    this.assertIdle(ref.name, 'delete', options.activeKey);
    this.invalidateEnsureFastPath(ref.name);
    await this.kubectl.run(['delete', this.resourceName(ref.name), '--ignore-not-found=true'], {
      timeoutMs: this.config.sandboxWaitTimeoutMs,
    });
    await this.networkPolicyManager.deleteForSandboxName(ref.name);
    await this.snatManager.deleteForSandboxName(ref.name);
  }

  async deleteByWorkspaceId(workspaceId: string, input: { busySandboxNames?: Set<string> } = {}): Promise<{ names: string[]; skippedBusy: string[] }> {
    const id = validateWorkspaceId(workspaceId);
    const sandboxes = (await this.listManagedSandboxes())
      .filter((sandbox) => sandbox.workspaceId === id);
    const names = sandboxes.map((sandbox) => sandbox.name);
    const skippedBusy: string[] = [];
    for (const sandbox of sandboxes) {
      if (this.isBusy(sandbox.name, input.busySandboxNames) || isBackgroundShellProtected(sandbox, Date.now())) {
        skippedBusy.push(sandbox.name);
        continue;
      }
      await this.kubectl.run(['delete', this.resourceName(sandbox.name), '--ignore-not-found=true'], {
        timeoutMs: this.config.sandboxWaitTimeoutMs,
      });
      await this.networkPolicyManager.deleteForSandboxName(sandbox.name);
      await this.snatManager.deleteForSandboxName(sandbox.name);
    }
    return { names: names.filter((name) => !skippedBusy.includes(name)), skippedBusy };
  }

  networkPolicyStatus(): NetworkPolicyStatus {
    return this.networkPolicyManager.currentStatus();
  }

  async probeNetworkPolicy(): Promise<NetworkPolicyStatus & { probe: NetworkPolicyProbeDetails }> {
    const probeId = `probe-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const input = {
      workspaceId: 'network-probe',
      sessionId: probeId,
      sandboxScopeId: `network-probe-${probeId}`,
    };
    const plannedRef = this.ref(input);
    const activeKey = `probe:${probeId}`;
    const releaseActive = this.activeRegistry?.acquire(plannedRef.name, activeKey);
    try {
      const ref = await this.ensureRunning(input, {
        skipCapacityManagement: true,
        activeKey,
      });
      try {
        await this.snatManager.ensureForProbe(ref);
        return await this.networkPolicyManager.probe(ref);
      } finally {
        await this.delete(ref, { activeKey });
      }
    } finally {
      releaseActive?.();
    }
  }

  private snatStatusCache: { at: number; value: SnatStatus } | null = null;

  async snatStatus(): Promise<SnatStatus> {
    // 2026-08-03 CPU 治理 P2：展示型 SNAT 状态查询缓存（aliyun CLI fork 实测
    // 单次峰值 75% CPU）。ensure/delete/cleanupOrphans 路径不经过本方法，不受影响。
    const ttl = this.config.snat.statusCacheMs;
    if (this.snatStatusCache && ttl > 0 && Date.now() - this.snatStatusCache.at < ttl) {
      return this.snatStatusCache.value;
    }
    const activeCidrs = this.snatManager.isEnabled()
      ? await this.snatManager.activeManagedPodCidrs()
      : undefined;
    const value = await this.snatManager.status(activeCidrs);
    this.snatStatusCache = { at: Date.now(), value };
    return value;
  }

  async cleanupOrphanSnat(): Promise<SnatCleanupReport> {
    if (!this.snatManager.isEnabled()) {
      return { enabled: false, checked: 0, deleted: [], orphanCidrs: [], unexpected: [] };
    }
    const retainedEntryNames = new Set(
      (await this.listManagedSandboxes())
        .filter((sandbox) => ['Running', 'Paused'].includes(sandbox.phase ?? ''))
        .map((sandbox) => this.snatManager.entryNameForSandboxName(sandbox.name)),
    );
    const activeCidrs = await this.snatManager.activeManagedPodCidrs();
    return await this.snatManager.cleanupOrphans(activeCidrs, { retainedEntryNames });
  }

  async listManagedSandboxes(): Promise<ManagedSandbox[]> {
    const labelSelector = `app.kubernetes.io/managed-by=${MANAGED_BY_LABEL}`;
    // 2026-08-03 CPU 治理 P3b：优先 REST 直连（keepalive 连接池，零 fork）；
    // API 层失败（null）回退 kubectl，行为最坏等于改造前。
    let items = await this.kubeApi?.listSandboxItems(labelSelector) ?? null;
    if (items === null) {
      const result = await this.kubectl.run([
        'get',
        this.config.sandboxKind.toLowerCase(),
        '-l',
        labelSelector,
        '-o',
        'json',
      ], { timeoutMs: this.config.sandboxWaitTimeoutMs });
      if (result.exitCode !== 0) throw new Error(`list managed Sandbox 失败: ${result.stderr || result.stdout}`);
      const body = JSON.parse(result.stdout || '{}') as { items?: Array<Record<string, unknown>> };
      items = body.items ?? [];
    }
    return items.map((item) => {
      const metadata = item.metadata && typeof item.metadata === 'object' ? item.metadata as Record<string, unknown> : {};
      const annotations = metadata.annotations && typeof metadata.annotations === 'object' ? metadata.annotations as Record<string, unknown> : {};
      const labels = metadata.labels && typeof metadata.labels === 'object' ? metadata.labels as Record<string, unknown> : {};
      const status = item.status && typeof item.status === 'object' ? item.status as Record<string, unknown> : {};
      const phase = stringValue(status.phase);
      // 从 spec.template.spec.containers[主容器].image 里抽出 image tag，
      // 用于 Paused 旧镜像预热和 inventory 统计。找不到主容器时留 undefined。
      const spec = item.spec && typeof item.spec === 'object' ? item.spec as Record<string, unknown> : {};
      const template = spec.template && typeof spec.template === 'object' ? spec.template as Record<string, unknown> : {};
      const podSpec = template.spec && typeof template.spec === 'object' ? template.spec as Record<string, unknown> : {};
      const containers = Array.isArray(podSpec.containers) ? podSpec.containers : [];
      const primaryContainer = containers.find((c): c is Record<string, unknown> => (
        Boolean(c)
        && typeof c === 'object'
        && (!('name' in c) || c.name === this.config.sandboxContainerName)
      ));
      return {
        name: typeof metadata.name === 'string' ? metadata.name : '',
        workspaceId: stringValue(annotations[WORKSPACE_ANNOTATION]) ?? stringValue(labels[WORKSPACE_LABEL]),
        sessionId: stringValue(annotations[SESSION_ANNOTATION]) ?? stringValue(labels[SESSION_LABEL]),
        sandboxScopeId: stringValue(annotations[SANDBOX_SCOPE_ANNOTATION]) ?? stringValue(labels[SANDBOX_SCOPE_LABEL]),
        mountSubPath: stringValue(annotations[MOUNT_SUBPATH_ANNOTATION]),
        phase,
        ...optionalString('brokenReason', brokenSandboxStateReason({ phase, raw: item })),
        ...optionalString('pausedConditionChangedAt', pausedConditionLastTransition(item)),
        createdAt: stringValue(annotations[CREATED_AT_ANNOTATION]) ?? stringValue(metadata.creationTimestamp),
        lastActiveAt: stringValue(annotations[LAST_ACTIVE_AT_ANNOTATION]) ?? stringValue(annotations[CREATED_AT_ANNOTATION]) ?? stringValue(metadata.creationTimestamp),
        backgroundShellProtectedUntil: stringValue(annotations[BACKGROUND_SHELL_PROTECTED_UNTIL_ANNOTATION]),
        image: primaryContainer ? stringValue(primaryContainer.image) : undefined,
      };
    }).filter((sandbox) => sandbox.name);
  }

  async listSandboxInventory(input: {
    busySandboxNames?: Set<string>;
    now?: Date;
  } = {}): Promise<ManagedSandboxInventory[]> {
    const nowMs = (input.now ?? new Date()).getTime();
    return (await this.listManagedSandboxes()).map((sandbox) => {
      const lastActiveAtMs = parseDateMs(sandbox.lastActiveAt);
      const idleMs = lastActiveAtMs === undefined ? undefined : Math.max(0, nowMs - lastActiveAtMs);
      const effectiveTtlMs = this.effectiveTtlMs(sandbox.name);
      const ttlRemainingMs = idleMs === undefined || effectiveTtlMs <= 0
        ? undefined
        : Math.max(0, effectiveTtlMs - idleMs);
      return {
        ...sandbox,
        busy: this.isBusy(sandbox.name, input.busySandboxNames) || isBackgroundShellProtected(sandbox, nowMs),
        imageStale: Boolean(sandbox.image && sandbox.image !== this.config.sandboxImage),
        ...(idleMs === undefined ? {} : { idleMs }),
        ...(effectiveTtlMs > 0 ? { effectiveTtlMs } : {}),
        ...(ttlRemainingMs === undefined ? {} : { ttlRemainingMs }),
      };
    });
  }

  async pauseByName(name: string, input: { busySandboxNames?: Set<string> } = {}): Promise<void> {
    this.assertIdleByName(name, 'pause', input.busySandboxNames);
    await this.assertNotBackgroundShellProtected(name, 'pause');
    await this.patchPaused(name, true);
  }

  async resumeByName(name: string, input: { busySandboxNames?: Set<string> } = {}): Promise<SandboxRef> {
    this.assertIdleByName(name, 'resume', input.busySandboxNames);
    const status = await this.getStatus(name);
    if (!status) throw new SandboxNotFoundError(`ACS Sandbox ${name} not found`);
    const ref = this.refFromStatus(name, status);
    return await this.ensureRunning({
      workspaceId: ref.workspaceId,
      sessionId: ref.sessionId,
      sandboxScopeId: ref.sandboxScopeId,
      mountSubPath: ref.mountSubPath,
    }, { busySandboxNames: input.busySandboxNames });
  }

  async deleteByName(name: string, input: { busySandboxNames?: Set<string> } = {}): Promise<void> {
    this.assertIdleByName(name, 'delete', input.busySandboxNames);
    await this.assertNotBackgroundShellProtected(name, 'delete');
    this.invalidateEnsureFastPath(name);
    await this.kubectl.run(['delete', this.resourceName(name), '--ignore-not-found=true'], {
      timeoutMs: this.config.sandboxWaitTimeoutMs,
    });
    await this.networkPolicyManager.deleteForSandboxName(name);
    await this.snatManager.deleteForSandboxName(name);
  }

  async prewarmStaleImagePausedSandboxes(input: {
    busySandboxNames?: Set<string>;
  } = {}): Promise<SandboxStaleImagePrewarmReport> {
    const busySandboxNames = input.busySandboxNames ?? new Set<string>();
    const currentImage = this.config.sandboxImage;
    const sandboxes = await this.listManagedSandboxes();
    const queued: string[] = [];
    const retired: string[] = [];
    const adopted: string[] = [];
    const skipped: string[] = [];
    const skippedBusy: string[] = [];
    const failed: Array<{ name: string; error: string }> = [];
    const candidates: SandboxRef[] = [];
    for (const sandbox of sandboxes) {
      if (sandbox.phase !== 'Paused') continue;
      if (!sandbox.image) { skipped.push(sandbox.name); continue; }
      if (sandbox.image === currentImage) continue;
      if (!sandbox.workspaceId || !sandbox.sessionId) { skipped.push(sandbox.name); continue; }
      if (this.isBusy(sandbox.name, busySandboxNames) || isBackgroundShellProtected(sandbox, Date.now())) {
        skippedBusy.push(sandbox.name);
        continue;
      }
      let ref: SandboxRef;
      try {
        ref = this.ref({
          workspaceId: sandbox.workspaceId,
          sessionId: sandbox.sessionId,
          sandboxScopeId: sandbox.sandboxScopeId,
          mountSubPath: sandbox.mountSubPath,
        });
      } catch (err) {
        skipped.push(sandbox.name);
        this.logger.warn(`sandbox_stale_image_prewarm_skip name=${sandbox.name} reason=${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (ref.name !== sandbox.name) {
        skipped.push(sandbox.name);
        this.logger.warn(`sandbox_stale_image_prewarm_skip name=${sandbox.name} reason=ref_name_mismatch expected=${ref.name}`);
        continue;
      }
      queued.push(sandbox.name);
      candidates.push(ref);
    }

    // retire 是轻量删除操作（kubectl delete + 网络清理），不再占用运行槽位，
    // 固定小并发即可，避免对 apiserver 的瞬时压力。
    const concurrency = Math.min(candidates.length, 4);
    let cursor = 0;
    const worker = async () => {
      while (cursor < candidates.length) {
        const ref = candidates[cursor++]!;
        await this.runRetireCandidate(ref, retired, adopted, skipped, failed);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return { checked: sandboxes.length, queued, retired, adopted, skipped, skippedBusy, failed };
  }

  private async runRetireCandidate(
    ref: SandboxRef,
    retired: string[],
    adopted: string[],
    skipped: string[],
    failed: Array<{ name: string; error: string }>,
  ): Promise<void> {
    try {
      const result = await this.startPrewarm(ref);
      if (result === 'retired') retired.push(ref.name);
      else if (result === 'adopted') adopted.push(ref.name);
      else skipped.push(ref.name);
    } catch (err) {
      failed.push({ name: ref.name, error: err instanceof Error ? err.message : String(err) });
    }
  }

  async inventorySummary(): Promise<SandboxInventorySummary> {
    const sandboxes = await this.listManagedSandboxes();
    const phaseCounts: Record<string, number> = {};
    let oldestCreatedAt: string | undefined;
    let newestLastActiveAt: string | undefined;
    for (const sandbox of sandboxes) {
      const phase = sandbox.phase ?? 'Unknown';
      phaseCounts[phase] = (phaseCounts[phase] ?? 0) + 1;
      if (sandbox.createdAt && (!oldestCreatedAt || Date.parse(sandbox.createdAt) < Date.parse(oldestCreatedAt))) {
        oldestCreatedAt = sandbox.createdAt;
      }
      if (sandbox.lastActiveAt && (!newestLastActiveAt || Date.parse(sandbox.lastActiveAt) > Date.parse(newestLastActiveAt))) {
        newestLastActiveAt = sandbox.lastActiveAt;
      }
    }
    return {
      totalCount: sandboxes.length,
      phaseCounts,
      runningCount: sandboxes.filter((sandbox) => isRunningCostPhase(sandbox.phase)).length,
      pausedCount: phaseCounts.Paused ?? 0,
      ...(oldestCreatedAt ? { oldestCreatedAt } : {}),
      ...(newestLastActiveAt ? { newestLastActiveAt } : {}),
    };
  }

  async cleanupSandboxes(input: { busySandboxNames?: Set<string>; now?: Date } = {}): Promise<SandboxCleanupReport> {
    const now = input.now ?? new Date();
    const nowMs = now.getTime();
    const busySandboxNames = input.busySandboxNames ?? new Set<string>();
    const sandboxes = await this.listManagedSandboxes();
    const paused: string[] = [];
    const deleted: string[] = [];
    const brokenRecycled: string[] = [];
    const skippedBusy: string[] = [];
    const snatDeleted: string[] = [];

    for (const sandbox of sandboxes) {
      if (this.isBusy(sandbox.name, busySandboxNames) || isBackgroundShellProtected(sandbox, nowMs)) {
        skippedBusy.push(sandbox.name);
        continue;
      }
      const phase = sandbox.phase ?? 'Unknown';
      const createdAtMs = parseDateMs(sandbox.createdAt);
      const lastActiveAtMs = parseDateMs(sandbox.lastActiveAt) ?? createdAtMs;
      const ageMs = createdAtMs === undefined ? 0 : nowMs - createdAtMs;
      const idleMs = lastActiveAtMs === undefined ? 0 : nowMs - lastActiveAtMs;
      // 2026-08-01 矛盾态自愈：phase=Paused 但 broken（SandboxPaused 卡 False/ImageChanged
      // 或 spec.paused=false 半状态）时 ACS 未完成休眠、持续按运行态计费，且旧逻辑只看
      // phase 会把它当「已暂停」永久跳过（07-22 事故 21 个 / 08-01 复发 6 个，最长滞留
      // 10 天）。宽限期取 condition 翻转、最后活跃、创建三个时间戳的最近者，全部超过
      // 宽限才回收，避免误伤正常 pause/resume 的瞬态（正常流程另有 busy 保护）。
      if (sandbox.brokenReason && this.config.sandboxBrokenRecycleGraceMs > 0) {
        const brokenSinceMs = Math.max(
          parseDateMs(sandbox.pausedConditionChangedAt) ?? 0,
          lastActiveAtMs ?? 0,
          createdAtMs ?? 0,
        );
        if (brokenSinceMs > 0 && nowMs - brokenSinceMs >= this.config.sandboxBrokenRecycleGraceMs) {
          this.logger.warn(
            `sandbox_broken_recycle name=${sandbox.name} reason=${sandbox.brokenReason} `
            + `brokenForMs=${nowMs - brokenSinceMs}`,
          );
          this.invalidateEnsureFastPath(sandbox.name);
          await this.kubectl.run(['delete', this.resourceName(sandbox.name), '--ignore-not-found=true'], {
            timeoutMs: this.config.sandboxWaitTimeoutMs,
          });
          await this.networkPolicyManager.deleteForSandboxName(sandbox.name);
          snatDeleted.push(...await this.snatManager.deleteForSandboxName(sandbox.name));
          brokenRecycled.push(sandbox.name);
          continue;
        }
      }
      // 07-05：CI 临时 sandbox（as-ws-ci-* 前缀）走短 TTL（sandboxCiTtlMs，默认 6h）。
      // CI 场景一次性使用无复用价值，不该跟用户会话共享 7 天 TTL。
      // sandboxCiTtlMs=0 表示关闭这条特殊路径，退回普通 TTL。
      const isCiSandbox = isCiSandboxName(sandbox.name);
      const effectiveTtlMs = isCiSandbox && this.config.sandboxCiTtlMs > 0
        ? this.config.sandboxCiTtlMs
        : this.config.sandboxTtlMs;
      const shouldDeleteByTtl = effectiveTtlMs > 0 && idleMs >= effectiveTtlMs;
      const orphanPhase = !['Running', 'Paused'].includes(phase);
      const shouldDeleteOrphan = this.config.sandboxOrphanGraceMs > 0 && orphanPhase && ageMs >= this.config.sandboxOrphanGraceMs;
      if (shouldDeleteByTtl || shouldDeleteOrphan) {
        if (this.isBusy(sandbox.name, busySandboxNames)) {
          skippedBusy.push(sandbox.name);
          continue;
        }
        this.invalidateEnsureFastPath(sandbox.name);
        await this.kubectl.run(['delete', this.resourceName(sandbox.name), '--ignore-not-found=true'], {
          timeoutMs: this.config.sandboxWaitTimeoutMs,
        });
        await this.networkPolicyManager.deleteForSandboxName(sandbox.name);
        snatDeleted.push(...await this.snatManager.deleteForSandboxName(sandbox.name));
        deleted.push(sandbox.name);
        continue;
      }
      if (phase === 'Running' && this.config.sandboxIdlePauseMs > 0 && idleMs >= this.config.sandboxIdlePauseMs) {
        if (this.isBusy(sandbox.name, busySandboxNames)) {
          skippedBusy.push(sandbox.name);
          continue;
        }
        await this.patchPaused(sandbox.name, true);
        paused.push(sandbox.name);
      }
    }

    const pausedSet = new Set(paused);
    const removedSet = new Set([...deleted, ...brokenRecycled]);
    const snatReport = await this.cleanupOrphanSnat();

    return {
      checked: sandboxes.length,
      paused,
      deleted,
      brokenRecycled,
      skippedBusy,
      snatDeleted: [...snatDeleted, ...snatReport.deleted],
      snatUnexpected: snatReport.unexpected.length,
      runningCount: sandboxes.filter((sandbox) => (
        !removedSet.has(sandbox.name)
        && !pausedSet.has(sandbox.name)
        && isRunningCostPhase(sandbox.phase)
      )).length,
      totalCount: sandboxes.length,
    };
  }

  async archiveWorkspace(workspaceId: string, reason: string): Promise<{ workspaceId: string; archived: boolean; missing?: boolean; archiveId?: string; archivePath?: string }> {
    const id = validateWorkspaceId(workspaceId);
    if (!this.config.hostWorkspaceRoot) {
      return { workspaceId: id, archived: false, missing: false };
    }
    const workspacePath = join(this.config.hostWorkspaceRoot, id);
    try {
      const current = await stat(workspacePath);
      if (!current.isDirectory()) throw new Error(`workspace 不是目录: ${id}`);
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && (err as { code?: unknown }).code === 'ENOENT') {
        return { workspaceId: id, archived: false, missing: true };
      }
      throw err;
    }
    const archiveRoot = join(this.config.hostWorkspaceRoot, '.archive');
    await mkdir(archiveRoot, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const suffix = reason.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'manual';
    const archiveId = `${id}__${stamp}__${suffix}`;
    const archivePath = join(archiveRoot, archiveId);
    await rename(workspacePath, archivePath);
    return { workspaceId: id, archived: true, archiveId, archivePath };
  }

  async patchPaused(name: string, paused: boolean, options: { activeKey?: string } = {}): Promise<void> {
    if (paused) this.assertIdle(name, 'pause', options.activeKey);
    this.invalidateEnsureFastPath(name);
    const result = await this.kubectl.run([
      'patch',
      this.resourceName(name),
      '--type=merge',
      '-p',
      JSON.stringify({ spec: { paused } }),
    ], { timeoutMs: this.config.sandboxWaitTimeoutMs });
    if (result.exitCode !== 0) throw new Error(`patch sandbox paused=${paused} 失败: ${result.stderr || result.stdout}`);
  }

  async touch(name: string, now: Date = new Date()): Promise<void> {
    const result = await this.kubectl.run([
      'patch',
      this.resourceName(name),
      '--type=merge',
      '-p',
      JSON.stringify({ metadata: { annotations: { [LAST_ACTIVE_AT_ANNOTATION]: now.toISOString() } } }),
    ], { timeoutMs: this.config.sandboxWaitTimeoutMs });
    if (result.exitCode !== 0) throw new Error(`touch sandbox 失败: ${result.stderr || result.stdout}`);
  }

  /** 60s 内已 touch 过则跳过（idle 判定为小时级，精度足够；省一次 kubectl patch）。 */
  private async touchThrottled(name: string, now: Date = new Date()): Promise<void> {
    const entry = this.ensureFastPath.get(name);
    if (entry && now.getTime() - entry.touchedAt < TOUCH_THROTTLE_MS) return;
    await this.touch(name, now);
    const updated = this.ensureFastPath.get(name);
    if (updated) updated.touchedAt = now.getTime();
  }

  private markEnsureFastPathVerified(name: string, nowMs = Date.now()): void {
    const entry = this.ensureFastPath.get(name);
    if (entry) entry.verifiedAt = nowMs;
    else this.ensureFastPath.set(name, { verifiedAt: nowMs, touchedAt: 0 });
  }

  private isEnsureFastPathFresh(name: string, nowMs = Date.now()): boolean {
    const entry = this.ensureFastPath.get(name);
    return Boolean(entry && nowMs - entry.verifiedAt < ENSURE_FAST_PATH_TTL_MS);
  }

  private invalidateEnsureFastPath(name: string): void {
    this.ensureFastPath.delete(name);
  }

  async setBackgroundShellProtection(name: string, protectedUntil?: string): Promise<void> {
    if (protectedUntil && !Number.isFinite(Date.parse(protectedUntil))) {
      throw new Error('background shell protectedUntil 必须是合法 ISO 时间。');
    }
    const result = await this.kubectl.run([
      'patch',
      this.resourceName(name),
      '--type=merge',
      '-p',
      JSON.stringify({
        metadata: {
          annotations: {
            [BACKGROUND_SHELL_PROTECTED_UNTIL_ANNOTATION]: protectedUntil ?? null,
          },
        },
      }),
    ], { timeoutMs: this.config.sandboxWaitTimeoutMs });
    if (result.exitCode !== 0) {
      throw new Error(`更新后台 Shell 生命周期保护失败: ${result.stderr || result.stdout}`);
    }
  }

  async getStatus(name: string): Promise<SandboxStatus | null> {
    const result = await this.kubectl.run(['get', this.resourceName(name), '-o', 'json'], { timeoutMs: 15_000 });
    if (result.exitCode !== 0) {
      if (/NotFound|not found/i.test(result.stderr + result.stdout)) return null;
      throw new Error(`读取 Sandbox 失败: ${result.stderr || result.stdout}`);
    }
    const raw = JSON.parse(result.stdout || '{}') as Record<string, unknown>;
    const status = raw.status && typeof raw.status === 'object' ? raw.status as Record<string, unknown> : {};
    return { phase: typeof status.phase === 'string' ? status.phase : undefined, raw };
  }

  private async applySandbox(ref: SandboxRef): Promise<void> {
    const manifest = this.buildSandboxManifest(ref);
    const result = await this.kubectl.run(['apply', '-f', '-'], {
      input: JSON.stringify(manifest),
      timeoutMs: this.config.sandboxWaitTimeoutMs,
    });
    if (result.exitCode !== 0) throw new Error(`apply Sandbox 失败: ${result.stderr || result.stdout}`);
    this.logger.info(`sandbox_applied name=${ref.name} workspaceId=${ref.workspaceId} sessionId=${ref.sessionId}`);
  }

  private async waitForPhase(name: string, expected: string): Promise<void> {
    const deadline = Date.now() + this.config.sandboxWaitTimeoutMs;
    let lastPhase = 'unknown';
    let lastError = '';
    while (Date.now() < deadline) {
      try {
        const status = await this.getStatus(name);
        lastPhase = status?.phase ?? 'missing';
        if (lastPhase === expected) return;
        // 2026-07-31 fail-fast：等 Running 时遇到终态 Failed 立即报错，不再空转到
        // 超时（生产 env timeout 600s，曾造成用户干等 10 分钟）。下一次 ensure 会
        // 走既有 broken-recreate 路径自动重建。
        if (expected === 'Running' && lastPhase === 'Failed') {
          const message = stringValue((status?.raw?.status as Record<string, unknown> | undefined)?.message);
          throw new SandboxInvalidStateError(
            `Sandbox ${name} 进入 Failed 终态，停止等待 ${expected}${message ? `：${message}` : ''}`,
          );
        }
      } catch (err) {
        if (err instanceof SandboxInvalidStateError) throw err;
        lastError = err instanceof Error ? err.message : String(err);
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    throw new Error(`等待 Sandbox ${name} 进入 ${expected} 超时，lastPhase=${lastPhase}${lastError ? ` lastError=${lastError}` : ''}`);
  }

  private async waitForPrewarm(name: string): Promise<void> {
    const pending = this.prewarmInFlight.get(name);
    if (!pending) return;
    this.logger.info(`sandbox_prewarm_join name=${name}`);
    try {
      await pending;
    } catch (err) {
      this.logger.warn(`sandbox_prewarm_join_failed name=${name} err=${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async startPrewarm(ref: SandboxRef): Promise<'retired' | 'adopted' | 'skipped'> {
    const existing = this.prewarmInFlight.get(ref.name);
    if (existing) {
      await existing;
      return 'skipped';
    }
    let outcome: 'retired' | 'adopted' | 'skipped' = 'skipped';
    const promise = this.retireStalePausedSandbox(ref).then((result) => {
      outcome = result;
    });
    this.prewarmInFlight.set(ref.name, promise);
    try {
      await promise;
      return outcome;
    } finally {
      if (this.prewarmInFlight.get(ref.name) === promise) this.prewarmInFlight.delete(ref.name);
    }
  }

  /**
   * 2026-08-01：stale-image Paused sandbox 直接删除退役，取代旧「原地 applySandbox
   * 换镜像 + 保持 Running 等 idle pause」的 prewarm。
   *
   * 事故依据（07-22 / 08-01 两轮，journal 实锤）：
   * - apply 后 waitRunning 失败无回滚 → CR 留在 spec.paused=false + phase=Paused +
   *   SandboxPaused=False/ImageChanged 半状态，ACS 持续按运行态计费；
   * - apply「成功」（prewarm_ready）后 4h idle pause 时仍卡 ImageChanged 无法完成
   *   休眠（07-31 21:17 prewarm_ready → 08-01 01:15 pause 卡死，精确到秒对应）；
   * - 对照：走 delete+recreate 的 sandbox 后续 pause 均正常（True/DeletePod）。
   *
   * 删除只影响 CR/NetworkPolicy/SNAT，NAS workspace/用户数据不动；用户下次访问
   * ensureRunning 按新镜像 create（冷启动 ~90-140s），Paused 态本就无热度可保。
   */
  private async retireStalePausedSandbox(ref: SandboxRef): Promise<'retired' | 'adopted' | 'skipped'> {
    const activeKey = `retire:${ref.name}:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`;
    const releaseActive = this.activeRegistry?.acquire(ref.name, activeKey);
    try {
      const latest = await this.getStatus(ref.name);
      if (!latest || latest.phase !== 'Paused') return 'skipped';
      const oldImage = this.existingImage(latest);
      if (!oldImage || oldImage === this.config.sandboxImage) return 'skipped';
      if (this.isBusy(ref.name, undefined, activeKey)) return 'adopted';

      this.logger.warn(`sandbox_stale_image_paused_retire name=${ref.name} old=${oldImage} new=${this.config.sandboxImage}`);
      this.invalidateEnsureFastPath(ref.name);
      const result = await this.kubectl.run(['delete', this.resourceName(ref.name), '--ignore-not-found=true'], {
        timeoutMs: this.config.sandboxWaitTimeoutMs,
      });
      if (result.exitCode !== 0) throw new Error(`delete stale paused sandbox 失败: ${result.stderr || result.stdout}`);
      await this.networkPolicyManager.deleteForSandboxName(ref.name);
      await this.snatManager.deleteForSandboxName(ref.name);
      this.logger.info(`sandbox_stale_image_retired name=${ref.name}`);
      return 'retired';
    } finally {
      releaseActive?.();
    }
  }

  private async ensureHostWorkspace(ref: SandboxRef): Promise<void> {
    if (!this.config.hostWorkspaceRoot) return;
    const path = join(this.config.hostWorkspaceRoot, ref.mountSubPath);
    await this.prepareWritableDir(path, 0o775);
    await this.prepareWritableDir(join(path, '.ky-agent'), 0o770);
    await this.prepareWritableDir(join(path, '.ky-agent', 'runtime'), 0o770);
    await this.prepareWritableDir(join(path, '.ky-agent', 'runtime', 'cache'), 0o770);
    await this.prepareWritableDir(join(path, '.ky-agent', 'runtime', 'cache', 'pip'), 0o770);
    await this.prepareWritableDir(join(path, '.ky-agent', 'runtime', 'provision'), 0o770);
    await this.prepareWritableDir(join(path, '.ky-agent', 'runtime', 'venv-archive'), 0o770);
    await this.prepareWritableDir(join(path, 'downloads'), 0o775);
  }

  private async prepareWritableDir(path: string, mode: number): Promise<void> {
    await mkdir(path, { recursive: true });
    try {
      await chown(path, this.config.sandboxRunAsUser, this.config.sandboxRunAsGroup);
      await chmod(path, mode);
    } catch (err) {
      this.logger.warn(
        `workspace_permission_prepare_failed path=${path} uid=${this.config.sandboxRunAsUser} gid=${this.config.sandboxRunAsGroup} mode=${mode.toString(8)} err=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async ensureCapacity(currentSandboxName: string, busySandboxNames?: Set<string>): Promise<void> {
    if (this.config.maxRunningSandboxes <= 0) return;
    if (this.config.lifecycleEnabled) {
      const protectedSandboxes = new Set(busySandboxNames ?? []);
      protectedSandboxes.add(currentSandboxName);
      // 2026-08-11：回收是「尽力而为的维护动作」，绝不能让用户的 provision 陪葬。
      // 生产实证（ACS run 31440440098）：发布瞬间 startup 的 stale-image 退休流程
      // 与本次 provision 并发操作同一批 Sandbox / 同一张 SNAT 表，回收链路里任意
      // 一次 kubectl / 阿里云调用失败就会顺着 ensureCapacity 冒泡，把整个 provision
      // 打成 500——恰好每次发布都撞上，表现为「只有部署时才失败」。
      // 回收失败的真实后果只是配额没腾出来，而配额是否足够由下面的硬检查负责；
      // 因此这里吞掉异常并留证，把判定权交给唯一有资格阻断的那道检查。
      try {
        const report = await this.cleanupSandboxes({ busySandboxNames: protectedSandboxes });
        if (report.paused.length || report.deleted.length) {
          this.logger.warn(
            `sandbox_capacity_reclaimed current=${currentSandboxName} paused=${report.paused.length} deleted=${report.deleted.length}`,
          );
        }
      } catch (err) {
        this.logger.warn(
          `sandbox_capacity_cleanup_failed current=${currentSandboxName} `
          + `reason=${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const sandboxes = await this.listManagedSandboxes();
    const protectedSandboxes = new Set(busySandboxNames ?? []);
    protectedSandboxes.add(currentSandboxName);
    const active = sandboxes.filter((sandbox) => sandbox.name !== currentSandboxName && isRunningCostPhase(sandbox.phase));
    if (this.config.lifecycleEnabled && active.length >= this.config.maxRunningSandboxes) {
      const candidates = active
        .filter((sandbox) => (
          !protectedSandboxes.has(sandbox.name)
          && sandbox.phase === 'Running'
          && !isBackgroundShellProtected(sandbox, Date.now())
        ))
        .sort((a, b) => (parseDateMs(a.lastActiveAt) ?? 0) - (parseDateMs(b.lastActiveAt) ?? 0));
      const pauseCount = active.length - this.config.maxRunningSandboxes + 1;
      const paused: string[] = [];
      for (const sandbox of candidates.slice(0, pauseCount)) {
        if (this.isBusy(sandbox.name, protectedSandboxes)) continue;
        await this.patchPaused(sandbox.name, true);
        paused.push(sandbox.name);
      }
      if (paused.length) {
        this.logger.warn(`sandbox_capacity_forced_pause current=${currentSandboxName} paused=${paused.length}`);
        const remainingActive = active.length - paused.length;
        if (remainingActive < this.config.maxRunningSandboxes) return;
      }
    }
    const refreshed = await this.listManagedSandboxes();
    const refreshedActive = refreshed.filter((sandbox) => (
      sandbox.name !== currentSandboxName
      && isRunningCostPhase(sandbox.phase)
    ));
    if (refreshedActive.length >= this.config.maxRunningSandboxes) {
      throw new Error(`ACS Sandbox running quota exceeded: ${refreshedActive.length}/${this.config.maxRunningSandboxes}`);
    }
  }

  private assertNotBusyForRecreate(
    ref: SandboxRef,
    busySandboxNames: Set<string> | undefined,
    reason: string,
    activeKey?: string,
  ): void {
    if (!this.isBusy(ref.name, busySandboxNames, activeKey)) return;
    throw new Error(`ACS Sandbox ${ref.name} is busy; refuse to recreate while active (${reason})`);
  }

  private isBusy(name: string, busySandboxNames?: Set<string>, activeKey?: string): boolean {
    return busySandboxNames?.has(name) === true || this.activeRegistry?.isBusy(name, { exceptKey: activeKey }) === true;
  }

  private assertIdle(name: string, reason: string, activeKey?: string): void {
    if (!this.activeRegistry?.isBusy(name, { exceptKey: activeKey })) return;
    throw new SandboxBusyError(`ACS Sandbox ${name} is busy; refuse to ${reason} while active`);
  }

  private assertIdleByName(name: string, reason: string, busySandboxNames?: Set<string>, activeKey?: string): void {
    if (!this.isBusy(name, busySandboxNames, activeKey)) return;
    throw new SandboxBusyError(`ACS Sandbox ${name} is busy; refuse to ${reason} while active`);
  }

  private async assertNotBackgroundShellProtected(name: string, reason: string): Promise<void> {
    const status = await this.getStatus(name);
    if (!status || !backgroundShellProtectionFromStatus(status)) return;
    throw new SandboxBusyError(`ACS Sandbox ${name} has active background shell tasks; refuse to ${reason}`);
  }

  private effectiveTtlMs(name: string): number {
    return isCiSandboxName(name) && this.config.sandboxCiTtlMs > 0
      ? this.config.sandboxCiTtlMs
      : this.config.sandboxTtlMs;
  }

  private refFromStatus(name: string, status: SandboxStatus): SandboxRef {
    const raw = status.raw ?? {};
    const metadata = raw.metadata && typeof raw.metadata === 'object' ? raw.metadata as Record<string, unknown> : {};
    const annotations = metadata.annotations && typeof metadata.annotations === 'object' ? metadata.annotations as Record<string, unknown> : {};
    const labels = metadata.labels && typeof metadata.labels === 'object' ? metadata.labels as Record<string, unknown> : {};
    const workspaceId = stringValue(annotations[WORKSPACE_ANNOTATION]) ?? stringValue(labels[WORKSPACE_LABEL]);
    const sessionId = stringValue(annotations[SESSION_ANNOTATION]) ?? stringValue(labels[SESSION_LABEL]);
    const sandboxScopeId = stringValue(annotations[SANDBOX_SCOPE_ANNOTATION]) ?? stringValue(labels[SANDBOX_SCOPE_LABEL]);
    const mountSubPath = stringValue(annotations[MOUNT_SUBPATH_ANNOTATION]) ?? workspaceId;
    if (!workspaceId || !sessionId || !mountSubPath) {
      throw new SandboxInvalidStateError(`ACS Sandbox ${name} missing workspace/session annotations`);
    }
    const ref = this.ref({ workspaceId, sessionId, sandboxScopeId, mountSubPath });
    if (ref.name !== name) {
      throw new SandboxInvalidStateError(`ACS Sandbox ${name} annotations resolve to ${ref.name}`);
    }
    return ref;
  }

  private async waitForRunningAndEnsureSnat(ref: SandboxRef, timing: EnsureTiming): Promise<void> {
    await Promise.all([
      timing.step('waitRunning', () => this.waitForPhase(ref.name, 'Running')),
      timing.step('ensureSnat', () => this.snatManager.ensureForSandboxWhenPodReady(ref, {
        timeoutMs: this.config.sandboxWaitTimeoutMs,
      })),
    ]);
  }

  private buildSandboxManifest(ref: SandboxRef): Record<string, unknown> {
    const now = new Date().toISOString();
    // per-tenant/workspace 规格覆盖（2026-08-10，批次 3）：逐字段回落全局默认，
    // 因此调用方可以只覆盖其中一项（如只调大内存）。ref.resources 参与 provision
    // 指纹，改规格会触发 pod 重建——这正是期望行为。
    const effectiveCpuRequest = ref.resources?.cpuRequest ?? this.config.cpuRequest;
    const effectiveMemoryRequest = ref.resources?.memoryRequest ?? this.config.memoryRequest;
    const effectiveCpuLimit = ref.resources?.cpuLimit ?? this.config.cpuLimit;
    const effectiveMemoryLimit = ref.resources?.memoryLimit ?? this.config.memoryLimit;
    const labels = {
      'app.kubernetes.io/name': APP_LABEL,
      'app.kubernetes.io/managed-by': MANAGED_BY_LABEL,
      [WORKSPACE_LABEL]: labelValue(ref.workspaceId),
      [SANDBOX_SCOPE_LABEL]: labelValue(ref.sandboxScopeId),
      [SESSION_LABEL]: labelValue(ref.sessionId),
      [NETWORK_POLICY_MODE_LABEL]: this.config.networkPolicy.mode,
      'alibabacloud.com/acs': 'true',
      'alibabacloud.com/compute-class': 'agent-sandbox',
    };
    const annotations = {
      [WORKSPACE_ANNOTATION]: ref.workspaceId,
      [SANDBOX_SCOPE_ANNOTATION]: ref.sandboxScopeId,
      [SESSION_ANNOTATION]: ref.sessionId,
      [MOUNT_SUBPATH_ANNOTATION]: ref.mountSubPath,
      [CREATED_AT_ANNOTATION]: now,
      [LAST_ACTIVE_AT_ANNOTATION]: now,
      [NETWORK_POLICY_MODE_ANNOTATION]: this.config.networkPolicy.mode,
      [NETWORK_POLICY_DENY_PRIVATE_ANNOTATION]: String(this.config.networkPolicy.denyPrivateNetworks),
      [ACS_NETWORK_POLICY_AGENT_ANNOTATION]: 'true',
      [ACS_NETWORK_POLICY_MODE_ANNOTATION]: acsNetworkPolicyMode(this.config.networkPolicy.mode),
      // 出口配置指纹：Pod env 创建后固化，靠它能一眼看出某个容器用的是哪版出口配置。
      // 刻意不作为重建条件——改配置就重建会中断用户在跑的会话，让它随自然 pause/重建生效。
      [EGRESS_FINGERPRINT_ANNOTATION]: egressSandboxFingerprint(
        this.config.egress.proxy,
        this.config.egress.packageMirrors,
      ) || 'none',
    };
    const container: Record<string, unknown> = {
      name: this.config.sandboxContainerName,
      image: this.config.sandboxImage,
      imagePullPolicy: this.config.imagePullPolicy,
      command: ['/bin/sh', '-c', 'mkdir -p "$ACS_WORKSPACE_PATH" "$DOWNLOAD_DIR" && cd "$ACS_WORKSPACE_PATH" && sleep infinity'],
      env: [
        { name: 'ACS_WORKSPACE_PATH', value: this.config.workspaceMountPath },
        { name: 'ACS_SANDBOX_IMAGE', value: this.config.sandboxImage },
        { name: 'DOWNLOAD_DIR', value: `${this.config.workspaceMountPath}/downloads` },
        { name: 'XDG_DOWNLOAD_DIR', value: `${this.config.workspaceMountPath}/downloads` },
        { name: 'PLAYWRIGHT_BROWSERS_PATH', value: '/ms-playwright' },
        { name: 'NPM_CONFIG_PREFIX', value: '/home/agent/.npm-global' },
        { name: 'VIRTUAL_ENV', value: `${this.config.workspaceMountPath}/.ky-agent/runtime/venv` },
        { name: 'PIP_CACHE_DIR', value: `${this.config.workspaceMountPath}/.ky-agent/runtime/cache/pip` },
        { name: 'PIP_DISABLE_PIP_VERSION_CHECK', value: '1' },
        { name: 'PIP_REQUIRE_VIRTUALENV', value: '1' },
        {
          name: 'PATH',
          value: `${this.config.workspaceMountPath}/.ky-agent/runtime/venv/bin:/home/agent/.npm-global/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin`,
        },
        { name: 'FORCE_COLOR', value: '0' },
        { name: 'TZ', value: SANDBOX_TIMEZONE },
        { name: 'LANG', value: 'C.UTF-8' },
        { name: 'LC_ALL', value: 'C.UTF-8' },
        // Node 堆上限按容器内存规格推导（2026-08-10）。此前 Agent 惯用
        // `--max-old-space-size=4096`，在 2GiB 容器上直接导致 cgroup oom_kill
        // （生产实测单个 pod 累计 10 次）。留 25% 给非堆内存（V8 元数据、
        // 原生模块、子进程），Agent 显式设置仍可覆盖本默认值。
        // 堆上限跟随**本 Sandbox 实际生效的**内存规格，而非全局默认——
        // per-tenant 覆盖后若仍按全局值算，大规格容器会白白浪费内存，
        // 小规格容器则会重新引发 oom_kill。
        ...(nodeHeapLimitMb(effectiveMemoryLimit)
          ? [{ name: 'NODE_OPTIONS', value: `--max-old-space-size=${nodeHeapLimitMb(effectiveMemoryLimit)}` }]
          : []),
        // 出口代理与国内镜像源（2026-07-25）：由 server「网络出口」配置页下发。
        // 代理变量大小写各一份是刚需——curl/wget/git 与容器内 Chromium 只认小写，
        // Go 二进制（gh/aliyun/dws/lark-cli）优先读大写。未启用时这里为空数组。
        ...buildSandboxProxyEnv(this.config.egress.proxy),
        ...buildPackageMirrorEnv(this.config.egress.packageMirrors),
      ],
      workingDir: this.config.workspaceMountPath,
      securityContext: {
        runAsNonRoot: true,
        runAsUser: this.config.sandboxRunAsUser,
        runAsGroup: this.config.sandboxRunAsGroup,
        allowPrivilegeEscalation: false,
        capabilities: { drop: ['ALL'] },
      },
      resources: {
        requests: {
          cpu: effectiveCpuRequest,
          memory: effectiveMemoryRequest,
        },
        ...(effectiveCpuLimit || effectiveMemoryLimit
          ? { limits: { ...(effectiveCpuLimit ? { cpu: effectiveCpuLimit } : {}), ...(effectiveMemoryLimit ? { memory: effectiveMemoryLimit } : {}) } }
          : {}),
      },
      ...(this.config.pvcName ? {
        volumeMounts: [{
          name: 'workspace',
          mountPath: this.config.workspaceMountPath,
          subPath: ref.mountSubPath,
        }],
      } : {}),
    };
    return {
      apiVersion: this.config.sandboxApiVersion,
      kind: this.config.sandboxKind,
      metadata: {
        name: ref.name,
        namespace: this.config.namespace,
        labels,
        annotations,
      },
      spec: {
        paused: false,
        ...(this.config.sandboxRuntimes.length ? { runtimes: this.config.sandboxRuntimes.map((name) => ({ name })) } : {}),
        template: {
          metadata: {
            annotations: {
              'network.alibabacloud.com/wait-clusterip-ready': '*',
              // 方案3-P0（2026-07-31）：按镜像名自动匹配 ImageCache，命中后 ACS 回填
              // `image.alibabacloud.com/matched-image-caches` 注解；无缓存时无副作用。
              ...(this.config.imageCacheEnabled ? { 'image.alibabacloud.com/enable-image-cache': 'true' } : {}),
              ...annotations,
            },
            labels,
          },
          spec: {
            automountServiceAccountToken: false,
            enableServiceLinks: false,
            hostNetwork: false,
            hostPID: false,
            hostIPC: false,
            securityContext: {
              runAsNonRoot: true,
              runAsUser: this.config.sandboxRunAsUser,
              runAsGroup: this.config.sandboxRunAsGroup,
              ...(this.config.sandboxFsGroup !== undefined ? { fsGroup: this.config.sandboxFsGroup } : {}),
            },
            restartPolicy: 'Never',
            terminationGracePeriodSeconds: 30,
            ...(this.config.imagePullSecretNames.length
              ? { imagePullSecrets: this.config.imagePullSecretNames.map((name) => ({ name })) }
              : {}),
            containers: [container],
            ...(this.config.pvcName ? { volumes: [{ name: 'workspace', persistentVolumeClaim: { claimName: this.config.pvcName } }] } : {}),
          },
        },
      },
    };
  }

  private resourceName(name: string): string {
    return `${this.config.sandboxKind.toLowerCase()}/${name}`;
  }

  private existingMountSubPath(status: SandboxStatus, ref: SandboxRef): string {
    const raw = status.raw ?? {};
    const metadata = raw.metadata && typeof raw.metadata === 'object' ? raw.metadata as Record<string, unknown> : {};
    const annotations = metadata.annotations && typeof metadata.annotations === 'object' ? metadata.annotations as Record<string, unknown> : {};
    return stringValue(annotations[MOUNT_SUBPATH_ANNOTATION]) ?? ref.workspaceId;
  }

  private existingImage(status: SandboxStatus): string | undefined {
    const raw = status.raw ?? {};
    const spec = raw.spec && typeof raw.spec === 'object' ? raw.spec as Record<string, unknown> : {};
    const template = spec.template && typeof spec.template === 'object' ? spec.template as Record<string, unknown> : {};
    const podSpec = template.spec && typeof template.spec === 'object' ? template.spec as Record<string, unknown> : {};
    const containers = Array.isArray(podSpec.containers) ? podSpec.containers : [];
    const container = containers.find((item): item is Record<string, unknown> => (
      Boolean(item)
      && typeof item === 'object'
      && (!('name' in item) || item.name === this.config.sandboxContainerName)
    ));
    return container ? stringValue(container.image) : undefined;
  }

}

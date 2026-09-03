import { chmod, chown, mkdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { CapacityReservations } from './capacityReservations.js';
import { summarizeSandboxCapacity } from './sandboxCapacity.js';
import type { AcsOrchestratorConfig } from './config.js';
import { reserveSandboxCapacity } from './sandboxCapacityAdmission.js';
import type { ActiveSandboxRegistry } from './activeSandboxRegistry.js';
import { Kubectl } from './kubectl.js';
import type { KubeApi } from './kubeApi.js';
import { AcsNetworkPolicyManager, type NetworkPolicyProbeDetails } from './networkPolicyManager.js';
import { sandboxNameFor, validateSessionId, validateWorkspaceId } from './sandboxName.js';
import { deleteSandboxAndReclaimNetwork, reconcileTerminatingSandboxDeletions, type SandboxDeletionPreconditions } from './sandboxDeletion.js';
import { cleanupManagedSandboxes } from './sandboxCleanup.js';
import { applyDeletionGeneration, applyPausedWithPreconditions, applyWorkloadDescriptor, createSandboxResource, touchSandboxActivity } from './sandboxLifecycleMutations.js';
import { SandboxInvocationMutationFacade } from './sandboxInvocationMutationFacade.js';
import { updateSandboxLifecycle } from './sandboxLifecycleUpdater.js';
import {
  APP_LABEL, CREATED_AT_ANNOTATION, LAST_ACTIVE_AT_ANNOTATION, MANAGED_BY_LABEL, MOUNT_SUBPATH_ANNOTATION,
  NETWORK_POLICY_DENY_PRIVATE_ANNOTATION, NETWORK_POLICY_MODE_ANNOTATION, NETWORK_POLICY_MODE_LABEL,
  SANDBOX_SCOPE_ANNOTATION, SANDBOX_SCOPE_LABEL, SESSION_ANNOTATION, SESSION_LABEL,
  WORKSPACE_ANNOTATION, WORKSPACE_LABEL, readManagedSandboxes,
} from './sandboxInventoryReader.js';
import { SingleflightCleanup } from './singleflightCleanup.js';
import { deleteSandboxWhenIdle } from './sandboxSafeDeletion.js';
import { pauseSandboxWhenIdle } from './sandboxSafePause.js';
import { readSandboxMutationGate, SandboxDestructiveMutationBlockedError } from './sandboxMutationGate.js';
import { SandboxDeletionGenerationCoordinator } from './sandboxDeletionGeneration.js';
import {
  WORKLOAD_CLASS_LABEL, WORKLOAD_DESCRIPTOR_ANNOTATION,
  decideSandboxLifecycle, sandboxLifecycleMetrics,
  isActiveInvocationLeaseProtected,
  type ActiveInvocationLeaseState,
  type SandboxDeletionGenerationUpdate,
  type SandboxLifecycleUpdate,
  type SandboxScopeDeletion,
  type SandboxWorkloadDescriptor,
} from './sandboxLifecyclePolicy.js';
import { hasSandboxResourceDrift, sameResourceTarget, sandboxResourceTarget } from './sandboxResourceDrift.js';
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
  labelValue,
  nodeHeapLimitMb,
  normalizeMountSubPath,
  parseDateMs,
  pausedConditionLastTransition,
  stringValue,
} from './sandboxState.js';
import { SnatManager, type SnatCleanupReport, type SnatStatus } from './snatManager.js';
import type { NetworkPolicyStatus } from 'server/runtime/networkPolicy.js';
import {
  buildPackageMirrorEnv, buildSandboxProxyEnv, egressSandboxFingerprint,
} from 'server/runtime/egressPolicy.js';
import type {
  SandboxCleanupReport,
  SandboxInventorySummary,
  SandboxRef,
  SandboxResourceOverride,
  SandboxStaleImagePrewarmReport,
} from './sandboxManagerTypes.js';
// 状态模型与纯判定函数已迁至 ./sandboxState.ts，这里按既有 import 路径继续对外转发。
export type { ManagedSandbox, ManagedSandboxInventory, SandboxStatus } from './sandboxState.js';
export {
  brokenPausedStateReason,
  brokenSandboxStateReason,
  nodeHeapLimitMb,
  pausedConditionLastTransition,
} from './sandboxState.js';
export type {
  SandboxCleanupReport,
  SandboxInventorySummary,
  SandboxRef,
  SandboxResourceOverride,
  SandboxStaleImagePrewarmReport,
} from './sandboxManagerTypes.js';
export class SandboxBusyError extends Error {
  readonly statusCode = 409;
}
export class SandboxNotFoundError extends Error {
  readonly statusCode = 404;
}
export class SandboxInvalidStateError extends Error {
  readonly statusCode = 400;
}
export { SandboxCapacityError } from './sandboxCapacity.js';
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

interface EnsureRunningOptions {
  busySandboxNames?: Set<string>; skipCapacityManagement?: boolean; activeKey?: string; recordActivity?: boolean;
}
export class SandboxManager {
  private readonly networkPolicyManager: AcsNetworkPolicyManager;
  readonly snatManager: SnatManager;
  private readonly prewarmInFlight = new Map<string, Promise<void>>();
  private readonly ensureInFlight = new Map<string, { ref: SandboxRef; promise: Promise<SandboxRef>; mutationToken: symbol }>();
  /** Serializes deletion against ensureRunning; new invocations wait and recreate safely. */
  private readonly deleteInFlight = new Map<string, Promise<string[] | null>>();
  /** Scope delete generation/UID CAS fence. */ private readonly deletionGeneration: SandboxDeletionGenerationCoordinator; private readonly invocationMutations: SandboxInvocationMutationFacade;
  /** Attestation 超时后服务端仍会继续；整段 probe 合流，避免重试持续创建临时 Sandbox。 */
  private readonly networkPolicyProbe = new SingleflightCleanup<NetworkPolicyStatus & { probe: NetworkPolicyProbeDetails }>();
  private readonly capacityReservations = new CapacityReservations();
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
    this.invocationMutations = new SandboxInvocationMutationFacade({ config, kubectl, resourceName: (name) => this.resourceName(name), getStatus: (name) => this.getStatus(name) });
    this.deletionGeneration = new SandboxDeletionGenerationCoordinator({
      getStatus: (name) => this.getStatus(name), refFromStatus: (name, status) => this.refFromStatus(name, status),
      patchGeneration: (name, generation, preconditions) => applyDeletionGeneration(config, kubectl, this.resourceName(name), generation, preconditions),
      conflict: (name) => new SandboxBusyError(`ACS Sandbox ${name} deletion generation changed`),
      deleteWhenIdle: (name, busy, canDelete, preconditions) => this.deleteWhenIdle(name, busy, canDelete, preconditions),
    });
  }
  ref(input: {
    workspaceId: string;
    sessionId: string;
    sandboxScopeId?: string;
    mountSubPath?: string;
    resources?: SandboxResourceOverride;
    workload?: SandboxWorkloadDescriptor;
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
      ...(input.workload ? { workload: input.workload } : {}),
    };
  }  async ensureRunning(
    input: {
      workspaceId: string;
      sessionId: string;
      sandboxScopeId?: string;
      mountSubPath?: string;
      resources?: SandboxResourceOverride;
      workload?: SandboxWorkloadDescriptor;
    },
    options: EnsureRunningOptions = {},
  ): Promise<SandboxRef> {
    const ref = this.ref(input);
    while (true) {
      const deleting = this.deleteInFlight.get(ref.name);
      if (deleting) {
        this.logger.info(`sandbox_ensure_wait_delete name=${ref.name}`);
        await deleting.catch(() => undefined);
        continue;
      }
      const inFlight = this.ensureInFlight.get(ref.name);
      if (inFlight) {
        this.logger.info(`sandbox_ensure_join name=${ref.name}`);
        const result = await inFlight.promise;
        if (sameResourceTarget(inFlight.ref, ref)) return result;
        // 不同 profile/workload 不能共享 leader 结果；join 后重新进入 drift/descriptor 检查。
        this.logger.info(`sandbox_ensure_resource_followup name=${ref.name}`);
        continue;
      }
      const mutationToken = Symbol(ref.name);
      const promise = this.ensureRunningExclusive(ref, options, mutationToken);
      const tracked = { ref, promise, mutationToken };
      this.ensureInFlight.set(ref.name, tracked);
      void promise.finally(() => this.ensureInFlight.get(ref.name) === tracked && this.ensureInFlight.delete(ref.name)).catch(() => {});
      return await promise;
    }
  }  private async ensureRunningExclusive(
    ref: SandboxRef,
    options: EnsureRunningOptions,
    mutationToken: symbol,
  ): Promise<SandboxRef> {
    const timing = createEnsureTiming(ref.name, this.logger);
    let path = 'unknown'; let resourceDriftDeferred = false;
    let status: 'ok' | 'error' = 'error';
    try {
      await timing.step('waitPrewarm', () => this.waitForPrewarm(ref.name));
      await timing.step('ensureHostWorkspace', () => this.ensureHostWorkspace(ref));
      let existing = await timing.step('getStatus', () => this.getStatus(ref.name));
      if (existing && ref.workload) {
        await timing.step('workloadDescriptor', () => this.patchWorkloadDescriptor(ref.name, ref.workload!));
      }
      const brokenState = existing ? brokenSandboxStateReason(existing) : undefined;
      if (existing && brokenState) {
        path = `recreate_broken_${brokenState}`;
        this.assertNotBusyForRecreate(ref, options.busySandboxNames, brokenState, options.activeKey);
        this.logger.warn(
          `sandbox_broken_state name=${ref.name} reason=${brokenState} phase=${existing.phase ?? 'unknown'}`,
        );
        await timing.step('deleteBrokenState', () => this.delete(ref, { activeKey: options.activeKey, mutationToken }));
        existing = null;
      }
      if (existing && this.existingMountSubPath(existing, ref) !== ref.mountSubPath) {
        path = 'recreate_mount_subpath_changed';
        this.assertNotBusyForRecreate(ref, options.busySandboxNames, 'mountSubPath changed', options.activeKey);
        this.logger.warn(
          `sandbox_mount_subpath_changed name=${ref.name} workspaceId=${ref.workspaceId} old=${this.existingMountSubPath(existing, ref)} new=${ref.mountSubPath}`,
        );
        await timing.step('delete', () => this.delete(ref, { activeKey: options.activeKey, mutationToken }));
        existing = null;
      }
      if (existing && ref.resources && hasSandboxResourceDrift(existing, ref.resources, this.config)) {
        const busy = this.isBusyForImageUpgrade(ref.name, options.busySandboxNames, options.activeKey) || Boolean(backgroundShellProtectionFromStatus(existing));
        if (busy) {
          path = 'defer_resource_changed_busy'; resourceDriftDeferred = true; this.logger.warn(`sandbox_resource_drift_deferred name=${ref.name} workspaceId=${ref.workspaceId} reason=busy`);
        } else {
          path = 'recreate_resource_changed'; this.logger.warn(`sandbox_resource_drift name=${ref.name} workspaceId=${ref.workspaceId}`);
          await timing.step('deleteResourceDrift', () => this.delete(ref, { activeKey: options.activeKey, mutationToken }));
          existing = null;
        }
      }
      if (
        existing
        && this.existingImage(existing) !== this.config.sandboxImage
        && !backgroundShellProtectionFromStatus(existing)
      ) {
        const oldImage = this.existingImage(existing) ?? 'unknown';
        if (
          existing.phase === 'Running'
          && this.isBusyForImageUpgrade(ref.name, options.busySandboxNames, options.activeKey)
        ) {
          // 镜像升级不是当前工具调用的正确性前置条件。共享 Sandbox 正被其他调用
          // 使用时继续复用现有 Running 实例，避免把发布竞态转成原始 busy 工具错误；
          // 不修改 spec，空闲后的下一次 ensure 仍会看到 drift 并完成重建。
          path = 'defer_image_changed_busy';
          this.logger.warn(
            `sandbox_image_upgrade_deferred name=${ref.name} workspaceId=${ref.workspaceId} old=${oldImage} new=${this.config.sandboxImage} reason=busy`,
          );
        } else {
          path = existing.phase === 'Paused' ? 'recreate_paused_image_changed' : 'recreate_image_changed';
          if (existing.phase !== 'Running') {
            this.assertNotBusyForRecreate(ref, options.busySandboxNames, 'image changed', options.activeKey);
          }
          this.logger.warn(
            `sandbox_image_changed name=${ref.name} workspaceId=${ref.workspaceId} old=${oldImage} new=${this.config.sandboxImage}`,
          );
          // In-place apply cannot couple the final lease read to the spec write. Delete with
          // UID/resourceVersion fencing, then create, so a lease written after the gate conflicts.
          await timing.step('delete', () => this.delete(ref, { activeKey: options.activeKey, mutationToken }));
          existing = null;
        }
      }
      if (!existing) {
        path = path === 'unknown' ? 'create' : path;
        await timing.step('ensureCapacity', () => this.reserveCapacity(ref, options));
        await timing.step('networkPolicy', () => this.networkPolicyManager.reconcile(ref));
        await timing.step('createSandbox', () => createSandboxResource(this.config, this.kubectl, this.buildSandboxManifest(ref)));
        this.logger.info(`sandbox_created name=${ref.name} workspaceId=${ref.workspaceId} sessionId=${ref.sessionId}`);
        await this.waitForRunningAndEnsureSnat(ref, timing);
        this.markEnsureFastPathVerified(ref.name);
        if (options.recordActivity !== false) await timing.step('touch', () => this.touchThrottled(ref.name));
        status = 'ok';
        return resourceDriftDeferred ? { ...ref, resourceDriftDeferred: true } : ref;
      }
      // already_running 快路径：5 分钟内已完整校验 networkPolicy+SNAT 的 Running
      // Sandbox，跳过两项 reconcile（合计 ~1.1s/次 kubectl/CLI 开销）。getStatus
      // 上面已真查过 phase，Running 事实不依赖缓存；housekeeping 跳过 touch。
      if (existing.phase === 'Running' && this.isEnsureFastPathFresh(ref.name)) {
        path = 'already_running_fast';
        await timing.step('verifySnatCoverage', () => this.snatManager.assertSharedCidrCoverageForSandbox(ref));
        if (options.recordActivity !== false) await timing.step('touch', () => this.touchThrottled(ref.name));
        status = 'ok';
        return resourceDriftDeferred ? { ...ref, resourceDriftDeferred: true } : ref;
      }
      await timing.step('networkPolicy', () => this.networkPolicyManager.reconcile(ref));
      if (existing.phase === 'Paused') {
        path = 'resume_paused';
        await timing.step('ensureCapacity', () => this.reserveCapacity(ref, options));
        await timing.step('patchUnpause', () => this.patchPaused(ref.name, false));
        await this.waitForRunningAndEnsureSnat(ref, timing);
      } else if (existing.phase !== 'Running') {
        path = 'wait_non_running';
        await timing.step('ensureCapacity', () => this.reserveCapacity(ref, options));
        await this.waitForRunningAndEnsureSnat(ref, timing);
      } else {
        path = 'already_running';
        await timing.step('ensureSnat', () => this.snatManager.ensureForSandbox(ref));
      }
      this.markEnsureFastPathVerified(ref.name);
      if (options.recordActivity !== false) await timing.step('touch', () => this.touchThrottled(ref.name));
      status = 'ok';
      return resourceDriftDeferred ? { ...ref, resourceDriftDeferred: true } : ref;
    } finally {
      this.capacityReservations.release(ref.name);
      timing.finish(path, status);
    }
  }

  async delete(ref: SandboxRef, options: { activeKey?: string; mutationToken?: symbol } = {}): Promise<void> {
    this.invalidateEnsureFastPath(ref.name);
    // mutationToken 仅由当前 ensure leader 持有，普通调用无法绕过 ensureInFlight。
    await this.deleteSandboxAndReclaimNetwork(ref.name, undefined, {
      activeKey: options.activeKey, ensureMutationToken: options.mutationToken,
    });
  }

  async deleteByWorkspaceId(workspaceId: string, input: { busySandboxNames?: Set<string> } = {}): Promise<{ names: string[]; skippedBusy: string[] }> {
    const id = validateWorkspaceId(workspaceId);
    const sandboxes = (await this.listManagedSandboxes())
      .filter((sandbox) => sandbox.workspaceId === id);
    const names = sandboxes.map((sandbox) => sandbox.name);
    const skippedBusy: string[] = [];
    for (const sandbox of sandboxes) {
      const deleted = await this.deleteWhenIdle(sandbox.name, input.busySandboxNames);
      if (deleted === null) skippedBusy.push(sandbox.name);
    }
    return { names: names.filter((name) => !skippedBusy.includes(name)), skippedBusy };
  }

  networkPolicyStatus(): NetworkPolicyStatus { return this.networkPolicyManager.currentStatus(); }
  async probeNetworkPolicyForRef(ref: SandboxRef): Promise<NetworkPolicyStatus & { probe: NetworkPolicyProbeDetails }> { return await this.networkPolicyManager.probe(ref); }

  async probeNetworkPolicy(): Promise<NetworkPolicyStatus & { probe: NetworkPolicyProbeDetails }> {
    const probeId = `probe-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const input = {
      workspaceId: 'network-probe',
      sessionId: probeId,
      sandboxScopeId: `network-probe-${probeId}`,
      workload: { class: 'probe' as const },
    };
    const plannedRef = this.ref(input);
    const activeKey = `probe:${probeId}`; // probe workload is capped at a 5 minute residue grace
    let releaseActive: (() => void) | undefined;
    return await this.networkPolicyProbe.run(async () => {
      releaseActive = this.activeRegistry?.acquire(plannedRef.name, activeKey);
      const ref = await this.ensureRunning(input, { skipCapacityManagement: true, activeKey });
      await this.snatManager.ensureForProbe(ref);
      return await this.networkPolicyManager.probe(ref);
    }, async () => {
      try {
        // ensureRunning 失败时也删 plannedRef；此前只清理成功 ref，会泄漏 Pending probe。
        await this.delete(plannedRef, { activeKey });
      } finally {
        releaseActive?.();
      }
    });
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
    // phase 不代表资源消失；只要受管 Sandbox CR 仍在就保留 SNAT，清单失败则 fail-closed。
    const retainedEntryNames = new Set(
      (await this.listManagedSandboxes())
        .map((sandbox) => this.snatManager.entryNameForSandboxName(sandbox.name)),
    );
    const activeCidrs = await this.snatManager.activeManagedPodCidrs();
    return await this.snatManager.cleanupOrphans(activeCidrs, { retainedEntryNames });
  }

  async listManagedSandboxes(): Promise<ManagedSandbox[]> {
    return await readManagedSandboxes(this.config, this.kubectl, this.kubeApi);
  }

  async listSandboxInventory(input: {
    busySandboxNames?: Set<string>;
    now?: Date;
  } = {}): Promise<ManagedSandboxInventory[]> {
    const nowMs = (input.now ?? new Date()).getTime();
    return (await this.listManagedSandboxes()).map((sandbox) => {
      const lastActiveAtMs = parseDateMs(sandbox.lastActiveAt);
      const idleMs = lastActiveAtMs === undefined ? undefined : Math.max(0, nowMs - lastActiveAtMs);
      const active = this.isBusy(sandbox.name, input.busySandboxNames)
        || isActiveInvocationLeaseProtected(sandbox, nowMs);
      const backgroundProtected = isBackgroundShellProtected(sandbox, nowMs);
      const lifecycle = decideSandboxLifecycle({ ...sandbox, nowMs, active, backgroundProtected });
      const { effectiveTtlMs, ttlRemainingMs } = sandboxLifecycleMetrics({
        ...sandbox, deadlineAt: lifecycle.deadlineAt, nowMs,
      });
      return {
        ...sandbox,
        workloadClass: lifecycle.workloadClass,
        workloadDescriptor: sandbox.workloadDescriptor ?? { class: lifecycle.workloadClass },
        busy: active || backgroundProtected,
        imageStale: Boolean(sandbox.image && sandbox.image !== this.config.sandboxImage),
        lifecycleDecision: lifecycle.decision,
        lifecycleDecisionReason: lifecycle.reason,
        ...(lifecycle.deadlineAt ? { lifecycleDeadlineAt: lifecycle.deadlineAt } : {}),
        ...(lifecycle.terminalDeadlineAt ? { terminalDeadlineAt: lifecycle.terminalDeadlineAt } : {}),
        ...(idleMs === undefined ? {} : { idleMs }),
        ...(effectiveTtlMs === undefined ? {} : { effectiveTtlMs }),
        ...(ttlRemainingMs === undefined ? {} : { ttlRemainingMs }),
      };
    });
  }

  async pauseByName(name: string, input: { busySandboxNames?: Set<string> } = {}): Promise<void> {
    await this.patchPaused(name, true, { busySandboxNames: input.busySandboxNames });
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
    this.invalidateEnsureFastPath(name);
    await this.deleteSandboxAndReclaimNetwork(
      name, undefined, { busySandboxNames: input.busySandboxNames });
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
      if (this.isBusy(sandbox.name, busySandboxNames)
        || isActiveInvocationLeaseProtected(sandbox, Date.now())
        || isBackgroundShellProtected(sandbox, Date.now())) {
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
    const workloadClassCounts = { interactive: 0, taskboard: 0, cron: 0, memory: 0, 'deploy-smoke': 0, probe: 0, unknown: 0 };
    const lifecycleDecisionCounts: Record<string, number> = {};
    const nowMs = Date.now();
    let oldestCreatedAt: string | undefined;
    let newestLastActiveAt: string | undefined;
    for (const sandbox of sandboxes) {
      const phase = sandbox.phase ?? 'Unknown';
      phaseCounts[phase] = (phaseCounts[phase] ?? 0) + 1;
      const lifecycle = decideSandboxLifecycle({
        ...sandbox,
        nowMs,
        active: this.isBusy(sandbox.name) || isActiveInvocationLeaseProtected(sandbox, nowMs),
        backgroundProtected: isBackgroundShellProtected(sandbox, nowMs),
      });
      workloadClassCounts[lifecycle.workloadClass] += 1;
      lifecycleDecisionCounts[lifecycle.decision] = (lifecycleDecisionCounts[lifecycle.decision] ?? 0) + 1;
      if (sandbox.createdAt && (!oldestCreatedAt || Date.parse(sandbox.createdAt) < Date.parse(oldestCreatedAt))) {
        oldestCreatedAt = sandbox.createdAt;
      }
      if (sandbox.lastActiveAt && (!newestLastActiveAt || Date.parse(sandbox.lastActiveAt) > Date.parse(newestLastActiveAt))) {
        newestLastActiveAt = sandbox.lastActiveAt;
      }
    }
    const pendingUsage = this.capacityReservations.pendingUsage(new Set(sandboxes.map((sandbox) => sandbox.name)), '');
    const capacity = summarizeSandboxCapacity({
      sandboxes, pendingUsage, config: this.config,
      canEvict: (sandbox) => !this.isBusy(sandbox.name)
        && !isActiveInvocationLeaseProtected(sandbox, Date.now())
        && !isBackgroundShellProtected(sandbox, Date.now()),
    });
    return {
      totalCount: sandboxes.length,
      phaseCounts,
      runningCount: phaseCounts.Running ?? 0,
      pausedCount: phaseCounts.Paused ?? 0,
      allocatedCount: capacity.snapshot.count,
      pendingReservationCount: pendingUsage.count,
      evictablePausedCount: capacity.evictablePausedCount,
      executionReady: capacity.executionReady,
      allocatedCpuMillicores: capacity.snapshot.cpuMillicores,
      allocatedMemoryBytes: capacity.snapshot.memoryBytes,
      availableCount: capacity.snapshot.availableCount,
      availableCpuMillicores: capacity.snapshot.availableCpuMillicores,
      availableMemoryBytes: capacity.snapshot.availableMemoryBytes,
      ...(oldestCreatedAt ? { oldestCreatedAt } : {}),
      ...(newestLastActiveAt ? { newestLastActiveAt } : {}),
      workloadClassCounts,
      lifecycleDecisionCounts,
      lifecyclePolicyMode: this.config.lifecyclePolicyMode ?? 'shadow',
    };
  }

  async cleanupSandboxes(input: { busySandboxNames?: Set<string>; now?: Date } = {}): Promise<SandboxCleanupReport> {
    await reconcileTerminatingSandboxDeletions({ sandboxes: await this.listManagedSandboxes(),
      retry: (name) => this.deleteSandboxAndReclaimNetwork(name), warn: (message) => this.logger.warn(message) });
    return await cleanupManagedSandboxes({
      lifecyclePolicyMode: this.config.lifecyclePolicyMode ?? 'shadow',
      sandboxBrokenRecycleGraceMs: this.config.sandboxBrokenRecycleGraceMs,
      sandboxOrphanGraceMs: this.config.sandboxOrphanGraceMs,
      sandboxTtlMs: this.config.sandboxTtlMs,
      sandboxIdlePauseMs: this.config.sandboxIdlePauseMs,
      listManagedSandboxes: () => this.listManagedSandboxes(),
      isBusy: (name, busy) => this.isBusy(name, busy),
      deleteWhenIdle: (name, busy, canDelete) => this.deleteWhenIdle(name, busy, canDelete),
      pauseWhenIdle: (name, busy, canPause) => this.pauseWhenIdle(name, busy, canPause),
      cleanupOrphanSnat: () => this.cleanupOrphanSnat(),
      warn: (message) => this.logger.warn(message),
    }, input);
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

  async patchPaused(name: string, paused: boolean, options: {
    activeKey?: string; busySandboxNames?: Set<string>; preconditions?: SandboxDeletionPreconditions;
  } = {}): Promise<void> {
    this.invalidateEnsureFastPath(name);
    if (paused) {
      const gate = await this.readDestructiveMutationGate(name, {
        activeKey: options.activeKey,
        busySandboxNames: options.busySandboxNames,
        expectedPreconditions: options.preconditions,
      });
      if (!gate) throw new SandboxNotFoundError(`ACS Sandbox ${name} not found`);
      return await applyPausedWithPreconditions(
        this.config, this.kubectl, this.resourceName(name), true, gate,
      );
    }
    const result = await this.kubectl.run([
      'patch', this.resourceName(name), '--type=merge', '-p', JSON.stringify({ spec: { paused: false } }),
    ], { timeoutMs: this.config.sandboxWaitTimeoutMs });
    if (result.exitCode !== 0) throw new Error(`patch sandbox paused=${paused} 失败: ${result.stderr || result.stdout}`);
  }
  private async pauseWhenIdle(name: string, busy: Set<string>, canPause: (latest: ManagedSandbox) => boolean) {
    return await pauseSandboxWhenIdle({ name, config: this.config, canPause, isBusy: () => this.isBusy(name, busy), isEnsuring: () => this.ensureInFlight.has(name),
      getStatus: () => this.getStatus(name), pause: (preconditions) => this.patchPaused(name, true, { preconditions }) });
  }

  async updateLifecycle(input: SandboxLifecycleUpdate): Promise<{ name: string; retentionDeadline?: string }> {
    const ref = this.ref(input);
    return await updateSandboxLifecycle({
      config: this.config, kubectl: this.kubectl, name: ref.name, resourceName: this.resourceName(ref.name),
      getStatus: () => this.getStatus(ref.name), notFound: (message) => new SandboxNotFoundError(message),
      matchesIdentity: (status) => {
        const actual = this.refFromStatus(ref.name, status);
        return actual.workspaceId === input.workspaceId && actual.sessionId === input.sessionId
          && actual.sandboxScopeId === input.sandboxScopeId;
      },
    }, input);
  }
  async advanceDeletionGeneration(input: SandboxDeletionGenerationUpdate) { return await this.deletionGeneration.advance(this.ref(input), input); }
  async deleteByScope(input: SandboxScopeDeletion, options: { busySandboxNames?: Set<string> } = {}) {
    const result = await this.deletionGeneration.delete(this.ref(input), input, options.busySandboxNames);
    if (result.busy) throw new SandboxBusyError(`ACS Sandbox ${result.name} is active or deletion generation changed`);
    const { busy: _busy, ...response } = result;
    return response;
  }

  private async deleteWhenIdle(name: string, busySandboxNames: Set<string> = new Set(),
    canDelete?: (latest: ManagedSandbox) => boolean, preconditions?: SandboxDeletionPreconditions): Promise<string[] | null> {
    const existing = this.deleteInFlight.get(name);
    if (existing) return await existing;
    const promise = deleteSandboxWhenIdle({
      name, config: this.config, canDelete, expectedPreconditions: preconditions,
      isBusy: () => this.isBusy(name, busySandboxNames),
      isEnsuring: () => this.ensureInFlight.has(name),
      getStatus: () => this.getStatus(name),
      delete: async (latestPreconditions) => {
        this.invalidateEnsureFastPath(name);
        return await this.deleteSandboxAndReclaimNetwork(name, latestPreconditions);
      },
    });
    this.deleteInFlight.set(name, promise);
    try {
      return await promise;
    } finally {
      if (this.deleteInFlight.get(name) === promise) this.deleteInFlight.delete(name);
    }
  }
  async setActiveInvocationLease(name: string, invocationKey: string, leaseUntil?: string, expectedUid?: string, activityGeneration?: string, leaseState: ActiveInvocationLeaseState = 'executing', completedAt?: string): Promise<string> {
    return await this.invocationMutations.setActiveLease(name, invocationKey, leaseUntil, expectedUid, activityGeneration, leaseState, completedAt);
  }
  async completeInvocation(name: string, invocationKey: string, completedAt: Date, expectedUid: string): Promise<string> { return await this.invocationMutations.completeInvocation(name, invocationKey, completedAt, expectedUid); }
  async clearExpiredInvocationLeases(name: string, now = new Date(), expectedUid?: string): Promise<{ active: boolean; removed: number }> { return await this.invocationMutations.clearExpired(name, now, expectedUid); }
  async clearMalformedInvocationLeases(name: string, expectedUid?: string, now = new Date()): Promise<number> { return await this.invocationMutations.clearMalformed(name, expectedUid, now); }
  private async patchWorkloadDescriptor(name: string, workload: SandboxWorkloadDescriptor): Promise<void> {
    await applyWorkloadDescriptor(this.config, this.kubectl, this.resourceName(name), workload, () => this.getStatus(name));
  }

  /**
   * Updates last-active through UID/resourceVersion CAS.
   * completeInvocation makes lease removal and activity touch share one CAS.
   * Callers without a pinned UID still retry only within one observed UID.
   * The mutation helper rejects resources already entering deletion.
   */
  async touch(name: string, now: Date = new Date(), expectedUid?: string): Promise<void> {
    await touchSandboxActivity(
      this.config, this.kubectl, this.resourceName(name), now, () => this.getStatus(name), expectedUid,
    );
  }

  /** 60s 内已 touch 过则跳过（idle 判定为分钟级，精度足够，减少 kubectl patch）。 */
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

  async setBackgroundShellProtection(name: string, protectedUntil?: string, expectedUid?: string, expectedClearGeneration?: string | null, generation?: string): Promise<string> { return await this.invocationMutations.setBackgroundProtection(name, protectedUntil, expectedUid, expectedClearGeneration, generation); }
  async getSandboxUid(name: string): Promise<string | null> { return await this.invocationMutations.getUid(name); } async getMutableSandboxUid(name: string): Promise<string | null> { return await this.invocationMutations.getMutableUid(name); } async getBackgroundShellProtection(name: string, expectedUid: string) { return await this.invocationMutations.getBackgroundProtection(name, expectedUid); }

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
   * 2026-08-01：stale-image Paused sandbox 直接删除退役，取代旧「原地 apply Sandbox
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
      await this.deleteSandboxAndReclaimNetwork(ref.name, undefined, { activeKey });
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

  private async reserveCapacity(
    ref: SandboxRef,
    options: { busySandboxNames?: Set<string>; skipCapacityManagement?: boolean },
  ): Promise<void> {
    await reserveSandboxCapacity({
      ref, config: this.config, reservations: this.capacityReservations,
      busySandboxNames: options.busySandboxNames,
      skipCapacityManagement: options.skipCapacityManagement,
      listSandboxes: () => this.listManagedSandboxes(),
      isBusy: (name, busy) => this.isBusy(name, busy),
      evict: async (name) => (await this.deleteWhenIdle(name, options.busySandboxNames, (latest) => latest.phase === 'Paused')) !== null,
      warn: (message) => this.logger.warn(message),
    });
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

  private isBusyForImageUpgrade(name: string, busySandboxNames?: Set<string>, activeKey?: string): boolean {
    // executor.busySandboxNames() 包含当前刚登记、尚未执行工具的 invocation。存在
    // activeRegistry + activeKey 时可精确排除自己，只把其他 lease 视为升级阻塞；
    // 旧调用方没有 registry/key 时保留 busySandboxNames 的保守语义。
    if (this.activeRegistry && activeKey) {
      return this.activeRegistry.isBusy(name, { exceptKey: activeKey });
    }
    return this.isBusy(name, busySandboxNames, activeKey);
  }

  private assertIdleByName(name: string, reason: string, busySandboxNames?: Set<string>, activeKey?: string): void {
    if (!this.isBusy(name, busySandboxNames, activeKey)) return;
    throw new SandboxBusyError(`ACS Sandbox ${name} is busy; refuse to ${reason} while active`);
  }

  refFromStatus(name: string, status: SandboxStatus): SandboxRef {
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
    const effectiveResources = sandboxResourceTarget(ref.resources, this.config);
    const labels = {
      'app.kubernetes.io/name': APP_LABEL,
      'app.kubernetes.io/managed-by': MANAGED_BY_LABEL,
      [WORKSPACE_LABEL]: labelValue(ref.workspaceId),
      [SANDBOX_SCOPE_LABEL]: labelValue(ref.sandboxScopeId),
      [SESSION_LABEL]: labelValue(ref.sessionId),
      [NETWORK_POLICY_MODE_LABEL]: this.config.networkPolicy.mode,
      [WORKLOAD_CLASS_LABEL]: ref.workload?.class ?? 'unknown',
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
      [WORKLOAD_DESCRIPTOR_ANNOTATION]: JSON.stringify(ref.workload ?? { class: 'unknown' }),
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
        ...(nodeHeapLimitMb(effectiveResources.memoryLimit) ? [{ name: 'NODE_OPTIONS', value: `--max-old-space-size=${nodeHeapLimitMb(effectiveResources.memoryLimit)}` }] : []),
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
        requests: { cpu: effectiveResources.cpuRequest, memory: effectiveResources.memoryRequest },
        ...(effectiveResources.cpuLimit || effectiveResources.memoryLimit ? { limits: { ...(effectiveResources.cpuLimit ? { cpu: effectiveResources.cpuLimit } : {}), ...(effectiveResources.memoryLimit ? { memory: effectiveResources.memoryLimit } : {}) } } : {}),
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

  /** 删除 finalizer 在网络回收完成前固定旧 CR UID/RV，禁止同名 Sandbox 穿插重建。 */
  private async deleteSandboxAndReclaimNetwork(
    name: string,
    expectedPreconditions?: SandboxDeletionPreconditions,
    options: { activeKey?: string; busySandboxNames?: Set<string>; ensureMutationToken?: symbol } = {},
  ): Promise<string[]> {
    const preconditions = await this.readDestructiveMutationGate(name, {
      activeKey: options.activeKey, busySandboxNames: options.busySandboxNames,
      expectedPreconditions, ensureMutationToken: options.ensureMutationToken,
    });
    if (!preconditions) return [];
    return await deleteSandboxAndReclaimNetwork({ name, resource: this.resourceName(name),
      apiVersion: this.config.sandboxApiVersion,
      kind: this.config.sandboxKind, namespace: this.config.namespace, timeoutMs: this.config.sandboxWaitTimeoutMs,
      kubectl: this.kubectl, networkPolicyManager: this.networkPolicyManager, snatManager: this.snatManager, preconditions,
    });
  }

  private async readDestructiveMutationGate(name: string, options: {
    activeKey?: string; busySandboxNames?: Set<string>; expectedPreconditions?: SandboxDeletionPreconditions;
    ensureMutationToken?: symbol;
  } = {}): Promise<SandboxDeletionPreconditions | undefined> {
    try {
      const gate = await readSandboxMutationGate({
        name, config: this.config, getStatus: () => this.getStatus(name),
        isBusy: () => this.isBusy(name, options.busySandboxNames, options.activeKey),
        isEnsuring: () => {
          const ensuring = this.ensureInFlight.get(name);
          return Boolean(ensuring && ensuring.mutationToken !== options.ensureMutationToken);
        },
        expectedPreconditions: options.expectedPreconditions,
      });
      return gate?.preconditions;
    } catch (err) {
      if (err instanceof SandboxDestructiveMutationBlockedError) {
        throw new SandboxBusyError(err.message);
      }
      throw err;
    }
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

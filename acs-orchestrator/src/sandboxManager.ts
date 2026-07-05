import { createHash } from 'node:crypto';
import { chmod, chown, mkdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { AcsOrchestratorConfig } from './config.js';
import type { ActiveSandboxRegistry } from './activeSandboxRegistry.js';
import { Kubectl } from './kubectl.js';
import { AcsNetworkPolicyManager, type NetworkPolicyProbeDetails } from './networkPolicyManager.js';
import { sandboxNameFor, validateSessionId, validateWorkspaceId } from './sandboxName.js';
import { SnatManager, type SnatCleanupReport, type SnatStatus } from './snatManager.js';
import type { NetworkPolicyStatus } from 'server/runtime/networkPolicy.js';

interface SandboxStatus {
  phase?: string;
  raw?: Record<string, unknown>;
}

interface EnsureTiming {
  step<T>(stepName: string, fn: () => Promise<T>): Promise<T>;
  finish(path: string, status: 'ok' | 'error'): void;
}

export interface ManagedSandbox {
  name: string;
  workspaceId?: string;
  sessionId?: string;
  sandboxScopeId?: string;
  mountSubPath?: string;
  phase?: string;
  createdAt?: string;
  lastActiveAt?: string;
  /**
   * 当前 sandbox spec 里 podTemplate 主容器的 image tag，用于 image drift 判定。
   */
  image?: string;
}

export interface SandboxRef {
  name: string;
  workspaceId: string;
  sessionId: string;
  sandboxScopeId: string;
  mountSubPath: string;
}

export interface SandboxCleanupReport {
  checked: number;
  paused: string[];
  deleted: string[];
  skippedBusy: string[];
  snatDeleted: string[];
  snatUnexpected: number;
  runningCount: number;
  totalCount: number;
}

export interface SandboxStaleImagePrewarmReport {
  checked: number;
  queued: string[];
  prewarmed: string[];
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
const SANDBOX_TIMEZONE = 'Asia/Shanghai';

export class SandboxManager {
  private readonly networkPolicyManager: AcsNetworkPolicyManager;
  private readonly snatManager: SnatManager;
  private readonly prewarmInFlight = new Map<string, Promise<void>>();

  constructor(
    private readonly config: AcsOrchestratorConfig,
    private readonly kubectl: Kubectl,
    private readonly logger: { info(msg: string): void; warn(msg: string): void; error(msg: string): void },
    private readonly activeRegistry?: ActiveSandboxRegistry,
  ) {
    this.networkPolicyManager = new AcsNetworkPolicyManager(config, kubectl, logger);
    this.snatManager = new SnatManager(config, kubectl, logger);
  }

  ref(input: { workspaceId: string; sessionId: string; sandboxScopeId?: string; mountSubPath?: string }): SandboxRef {
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
    };
  }

  async ensureRunning(
    input: { workspaceId: string; sessionId: string; sandboxScopeId?: string; mountSubPath?: string },
    options: { busySandboxNames?: Set<string>; skipCapacityManagement?: boolean; activeKey?: string } = {},
  ): Promise<SandboxRef> {
    const ref = this.ref(input);
    const timing = this.createEnsureTiming(ref.name);
    let path = 'unknown';
    let status: 'ok' | 'error' = 'error';
    try {
      await timing.step('waitPrewarm', () => this.waitForPrewarm(ref.name));
      await timing.step('ensureHostWorkspace', () => this.ensureHostWorkspace(ref));
      let existing = await timing.step('getStatus', () => this.getStatus(ref.name));
      const brokenPausedState = existing ? this.brokenPausedStateReason(existing) : undefined;
      if (existing && brokenPausedState) {
        path = `recreate_broken_paused_${brokenPausedState}`;
        this.assertNotBusyForRecreate(ref, options.busySandboxNames, brokenPausedState, options.activeKey);
        this.logger.warn(
          `sandbox_broken_paused_state name=${ref.name} reason=${brokenPausedState} phase=${existing.phase ?? 'unknown'}`,
        );
        await timing.step('deleteBrokenPaused', () => this.delete(ref, { activeKey: options.activeKey }));
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
      if (existing && this.existingImage(existing) !== this.config.sandboxImage) {
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
          await timing.step('touch', () => this.touch(ref.name));
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
        await timing.step('touch', () => this.touch(ref.name));
        status = 'ok';
        return ref;
      }
      await timing.step('networkPolicy', () => this.networkPolicyManager.reconcile(ref));
      if (existing.phase === 'Paused') {
        path = 'resume_paused';
        if (!options.skipCapacityManagement) await timing.step('ensureCapacity', () => this.ensureCapacity(ref.name, options.busySandboxNames));
        await timing.step('patchUnpause', () => this.patchPaused(ref.name, false));
        await this.waitForRunningAndEnsureSnat(ref, timing);
        await timing.step('touch', () => this.touch(ref.name));
        status = 'ok';
        return ref;
      }
      if (existing.phase !== 'Running') {
        path = 'wait_non_running';
        if (!options.skipCapacityManagement) await timing.step('ensureCapacity', () => this.ensureCapacity(ref.name, options.busySandboxNames));
        await this.waitForRunningAndEnsureSnat(ref, timing);
      } else {
        path = 'already_running';
        await timing.step('ensureSnat', () => this.snatManager.ensureForSandbox(ref));
      }
      await timing.step('touch', () => this.touch(ref.name));
      status = 'ok';
      return ref;
    } finally {
      timing.finish(path, status);
    }
  }

  async delete(ref: SandboxRef, options: { activeKey?: string } = {}): Promise<void> {
    this.assertIdle(ref.name, 'delete', options.activeKey);
    await this.kubectl.run(['delete', this.resourceName(ref.name), '--ignore-not-found=true'], {
      timeoutMs: this.config.sandboxWaitTimeoutMs,
    });
    await this.networkPolicyManager.deleteForSandboxName(ref.name);
    await this.snatManager.deleteForSandboxName(ref.name);
  }

  async deleteByWorkspaceId(workspaceId: string, input: { busySandboxNames?: Set<string> } = {}): Promise<{ names: string[]; skippedBusy: string[] }> {
    const id = validateWorkspaceId(workspaceId);
    const names = (await this.listManagedSandboxes())
      .filter((sandbox) => sandbox.workspaceId === id)
      .map((sandbox) => sandbox.name);
    const skippedBusy: string[] = [];
    for (const name of names) {
      if (this.isBusy(name, input.busySandboxNames)) {
        skippedBusy.push(name);
        continue;
      }
      await this.kubectl.run(['delete', this.resourceName(name), '--ignore-not-found=true'], {
        timeoutMs: this.config.sandboxWaitTimeoutMs,
      });
      await this.networkPolicyManager.deleteForSandboxName(name);
      await this.snatManager.deleteForSandboxName(name);
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

  async snatStatus(): Promise<SnatStatus> {
    const activeCidrs = this.snatManager.isEnabled()
      ? await this.snatManager.activeManagedPodCidrs()
      : undefined;
    return await this.snatManager.status(activeCidrs);
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
    const result = await this.kubectl.run([
      'get',
      this.config.sandboxKind.toLowerCase(),
      '-l',
      `app.kubernetes.io/managed-by=${MANAGED_BY_LABEL}`,
      '-o',
      'json',
    ], { timeoutMs: this.config.sandboxWaitTimeoutMs });
    if (result.exitCode !== 0) throw new Error(`list managed Sandbox 失败: ${result.stderr || result.stdout}`);
    const body = JSON.parse(result.stdout || '{}') as { items?: Array<Record<string, unknown>> };
    return (body.items ?? []).map((item) => {
      const metadata = item.metadata && typeof item.metadata === 'object' ? item.metadata as Record<string, unknown> : {};
      const annotations = metadata.annotations && typeof metadata.annotations === 'object' ? metadata.annotations as Record<string, unknown> : {};
      const labels = metadata.labels && typeof metadata.labels === 'object' ? metadata.labels as Record<string, unknown> : {};
      const status = item.status && typeof item.status === 'object' ? item.status as Record<string, unknown> : {};
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
        phase: stringValue(status.phase),
        createdAt: stringValue(annotations[CREATED_AT_ANNOTATION]) ?? stringValue(metadata.creationTimestamp),
        lastActiveAt: stringValue(annotations[LAST_ACTIVE_AT_ANNOTATION]) ?? stringValue(annotations[CREATED_AT_ANNOTATION]) ?? stringValue(metadata.creationTimestamp),
        image: primaryContainer ? stringValue(primaryContainer.image) : undefined,
      };
    }).filter((sandbox) => sandbox.name);
  }

  async prewarmStaleImagePausedSandboxes(input: {
    busySandboxNames?: Set<string>;
    bootstrap?: (ref: SandboxRef) => Promise<void>;
  } = {}): Promise<SandboxStaleImagePrewarmReport> {
    const busySandboxNames = input.busySandboxNames ?? new Set<string>();
    const currentImage = this.config.sandboxImage;
    const sandboxes = await this.listManagedSandboxes();
    const queued: string[] = [];
    const prewarmed: string[] = [];
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
      if (this.isBusy(sandbox.name, busySandboxNames)) {
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

    const runningCount = sandboxes.filter((sandbox) => isRunningCostPhase(sandbox.phase)).length;
    const availableSlots = this.config.maxRunningSandboxes > 0
      ? Math.max(1, this.config.maxRunningSandboxes - runningCount)
      : candidates.length;
    const concurrency = Math.min(candidates.length, availableSlots);
    let cursor = 0;
    const worker = async () => {
      while (cursor < candidates.length) {
        const ref = candidates[cursor++]!;
        await this.runPrewarmCandidate(ref, input.bootstrap, prewarmed, adopted, skipped, failed);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return { checked: sandboxes.length, queued, prewarmed, adopted, skipped, skippedBusy, failed };
  }

  private async runPrewarmCandidate(
    ref: SandboxRef,
    bootstrap: ((ref: SandboxRef) => Promise<void>) | undefined,
    prewarmed: string[],
    adopted: string[],
    skipped: string[],
    failed: Array<{ name: string; error: string }>,
  ): Promise<void> {
    try {
      const result = await this.startPrewarm(ref, bootstrap);
      if (result === 'prewarmed') prewarmed.push(ref.name);
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
    const skippedBusy: string[] = [];
    const snatDeleted: string[] = [];

    for (const sandbox of sandboxes) {
      if (this.isBusy(sandbox.name, busySandboxNames)) {
        skippedBusy.push(sandbox.name);
        continue;
      }
      const phase = sandbox.phase ?? 'Unknown';
      const createdAtMs = parseDateMs(sandbox.createdAt);
      const lastActiveAtMs = parseDateMs(sandbox.lastActiveAt) ?? createdAtMs;
      const ageMs = createdAtMs === undefined ? 0 : nowMs - createdAtMs;
      const idleMs = lastActiveAtMs === undefined ? 0 : nowMs - lastActiveAtMs;
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
    const deletedSet = new Set(deleted);
    const snatReport = await this.cleanupOrphanSnat();

    return {
      checked: sandboxes.length,
      paused,
      deleted,
      skippedBusy,
      snatDeleted: [...snatDeleted, ...snatReport.deleted],
      snatUnexpected: snatReport.unexpected.length,
      runningCount: sandboxes.filter((sandbox) => (
        !deletedSet.has(sandbox.name)
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
      } catch (err) {
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

  private async startPrewarm(
    ref: SandboxRef,
    bootstrap: ((ref: SandboxRef) => Promise<void>) | undefined,
  ): Promise<'prewarmed' | 'adopted' | 'skipped'> {
    const existing = this.prewarmInFlight.get(ref.name);
    if (existing) {
      await existing;
      return 'skipped';
    }
    let outcome: 'prewarmed' | 'adopted' | 'skipped' = 'skipped';
    const promise = this.prewarmPausedSandbox(ref, bootstrap).then((result) => {
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

  private async prewarmPausedSandbox(
    ref: SandboxRef,
    bootstrap: ((ref: SandboxRef) => Promise<void>) | undefined,
  ): Promise<'prewarmed' | 'adopted' | 'skipped'> {
    const activeKey = `prewarm:${ref.name}:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`;
    const releaseActive = this.activeRegistry?.acquire(ref.name, activeKey);
    try {
      const latest = await this.getStatus(ref.name);
      if (!latest || latest.phase !== 'Paused') return 'skipped';
      const oldImage = this.existingImage(latest);
      if (!oldImage || oldImage === this.config.sandboxImage) return 'skipped';
      if (this.isBusy(ref.name, undefined, activeKey)) return 'adopted';

      this.logger.warn(`sandbox_stale_image_paused_prewarm name=${ref.name} old=${oldImage} new=${this.config.sandboxImage}`);
      await this.ensureHostWorkspace(ref);
      await this.ensureCapacity(ref.name);
      await this.networkPolicyManager.reconcile(ref);
      await this.applySandbox(ref);
      await this.waitForPhase(ref.name, 'Running');
      await this.snatManager.ensureForSandbox(ref);
      await this.touch(ref.name);
      await bootstrap?.(ref);

      if (this.isBusy(ref.name, undefined, activeKey)) {
        this.logger.info(`sandbox_stale_image_prewarm_adopted name=${ref.name}`);
        return 'adopted';
      }
      // Keep the freshly updated sandbox Running. Pausing immediately after a
      // Paused image refresh can leave ACS in ImageChanged/recreating limbo.
      this.logger.info(`sandbox_stale_image_prewarm_ready name=${ref.name}`);
      return 'prewarmed';
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
      const report = await this.cleanupSandboxes({ busySandboxNames: protectedSandboxes });
      if (report.paused.length || report.deleted.length) {
        this.logger.warn(
          `sandbox_capacity_reclaimed current=${currentSandboxName} paused=${report.paused.length} deleted=${report.deleted.length}`,
        );
      }
    }
    const sandboxes = await this.listManagedSandboxes();
    const protectedSandboxes = new Set(busySandboxNames ?? []);
    protectedSandboxes.add(currentSandboxName);
    const active = sandboxes.filter((sandbox) => sandbox.name !== currentSandboxName && isRunningCostPhase(sandbox.phase));
    if (this.config.lifecycleEnabled && active.length >= this.config.maxRunningSandboxes) {
      const candidates = active
        .filter((sandbox) => !protectedSandboxes.has(sandbox.name) && sandbox.phase === 'Running')
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
    throw new Error(`ACS Sandbox ${name} is busy; refuse to ${reason} while active`);
  }

  private async waitForRunningAndEnsureSnat(ref: SandboxRef, timing: EnsureTiming): Promise<void> {
    await Promise.all([
      timing.step('waitRunning', () => this.waitForPhase(ref.name, 'Running')),
      timing.step('ensureSnat', () => this.snatManager.ensureForSandboxWhenPodReady(ref, {
        timeoutMs: this.config.sandboxWaitTimeoutMs,
      })),
    ]);
  }

  private createEnsureTiming(name: string): EnsureTiming {
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
          throw err;
        }
      },
      finish: (path: string, status: 'ok' | 'error') => {
        this.logger.info(`sandbox_ensure_timing sandbox=${name} path=${path} status=${status} totalMs=${Date.now() - startedAt} steps=${steps.join(',')}`);
      },
    };
  }

  private buildSandboxManifest(ref: SandboxRef): Record<string, unknown> {
    const now = new Date().toISOString();
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
          cpu: this.config.cpuRequest,
          memory: this.config.memoryRequest,
        },
        ...(this.config.cpuLimit || this.config.memoryLimit
          ? { limits: { ...(this.config.cpuLimit ? { cpu: this.config.cpuLimit } : {}), ...(this.config.memoryLimit ? { memory: this.config.memoryLimit } : {}) } }
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

  private brokenPausedStateReason(status: SandboxStatus): string | undefined {
    if (status.phase !== 'Paused') return undefined;
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

    if (pausedReason === 'ImageChanged' && pausedStatus === 'False') return 'image_changed';
    if (recreating) return 'recreating';
    if (requestedRunning) return 'requested_running';
    return undefined;
  }
}

/**
 * 07-05：判断 sandbox 名字是否属于 CI 临时 sandbox（不是用户会话 sandbox）。
 * 命名约定：CI workflow 触发的 sandbox 名字都以 `as-ws-ci-` 开头
 * （acs-sandbox.yml build-deploy 里 build/smoke test 起的 sandbox），
 * 用户会话的 sandbox 是 `as-ws-<tenantId>-<userId>-workspace-<hash>` 形态。
 * 见生产 kubectl get sandbox 命名样本。
 */
export function isCiSandboxName(name: string): boolean {
  return name.startsWith('as-ws-ci-');
}

function labelValue(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 40);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function normalizeMountSubPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('mountSubPath must not be empty');
  if (trimmed.startsWith('/') || trimmed.includes('\\')) throw new Error('mountSubPath must be a relative POSIX path');
  const parts = trimmed.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error('mountSubPath must not contain empty segments, . or ..');
  }
  return parts.join('/');
}

function parseDateMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isRunningCostPhase(phase: string | undefined): boolean {
  return phase !== 'Paused';
}

function acsNetworkPolicyMode(mode: string): string {
  return mode === 'isolated' ? 'network-policy' : 'traffic-policy';
}

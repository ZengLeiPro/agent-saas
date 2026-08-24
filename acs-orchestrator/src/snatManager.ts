import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

import { ipv4InCidr } from './cidr.js';
import type { AcsOrchestratorConfig } from './config.js';
import type { Kubectl } from './kubectl.js';
import type { KubeApi } from './kubeApi.js';
import type { SandboxRef } from './sandboxManager.js';

export interface SnatEntry {
  id: string;
  name: string;
  sourceCidr: string;
  snatIp: string;
  status?: string;
  managed: boolean;
}

export interface SnatStatus {
  enabled: boolean;
  mode: AcsOrchestratorConfig['snat']['mode'];
  configured: boolean;
  sharedCidrs?: string[];
  sharedCidrConfigDigest?: string;
  regionId?: string;
  snatTableId?: string;
  snatIp?: string;
  entryNamePrefix: string;
  maxManagedEntries: number;
  managedCount: number;
  unexpectedCount: number;
  orphanCount: number;
  redundantPerPodCount: number;
  sharedCidrAvailableCount: number;
  uncoveredPodCidrs: string[];
  entries: SnatEntry[];
  error?: string;
}

export interface SnatCleanupReport {
  enabled: boolean;
  checked: number;
  deleted: string[];
  orphanCidrs: string[];
  unexpected: SnatEntry[];
  error?: string;
}

export interface SnatRestoreReport {
  checked: number;
  available: number;
  entries: SnatEntry[];
}

export interface ManagedSandboxIdentity {
  name: string;
  workspaceId: string;
  sandboxScopeId: string;
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

const MANAGED_BY_LABEL = 'agent-saas-acs-orchestrator';
const WORKSPACE_LABEL = 'agent-saas.kaiyan.net/workspace-id';
const SANDBOX_SCOPE_LABEL = 'agent-saas.kaiyan.net/sandbox-scope-id';

export class SnatSharedCidrCoverageError extends Error {
  constructor(readonly podIp: string, readonly sharedCidrs: string[]) {
    super(`ACS Pod IP ${podIp} is outside configured shared CIDRs: ${sharedCidrs.join(',')}`);
    this.name = 'SnatSharedCidrCoverageError';
  }
}

export class SnatManager {
  private readonly sharedCidrEnsureInFlight = new Map<string, Promise<SnatEntry>>();

  constructor(
    private readonly config: AcsOrchestratorConfig,
    private readonly kubectl: Kubectl,
    private readonly logger: { info(msg: string): void; warn(msg: string): void; error(msg: string): void },
    private readonly kubeApi?: KubeApi | null,
  ) {}

  isEnabled(): boolean {
    return this.config.snat.mode !== 'disabled';
  }

  private isSharedCidrMode(): boolean {
    return this.config.snat.mode === 'shared-cidr';
  }

  shouldAttachToSandbox(): boolean {
    return (this.config.snat.mode === 'per-sandbox' || this.isSharedCidrMode())
      && this.config.networkPolicy.mode === 'public-egress';
  }

  shouldAttachToProbe(): boolean {
    return (this.config.snat.mode === 'probe-only'
      || this.config.snat.mode === 'per-sandbox'
      || this.isSharedCidrMode())
      && this.config.networkPolicy.mode === 'public-egress';
  }

  async ensureForSandbox(ref: SandboxRef): Promise<SnatEntry | null> {
    if (!this.shouldAttachToSandbox()) return null;
    if (this.isSharedCidrMode()) return await this.ensureSharedCidrForRef(ref);
    return await this.ensureForRef(ref);
  }

  async ensureForSandboxWhenPodReady(
    ref: SandboxRef,
    options: { timeoutMs: number; pollIntervalMs?: number },
  ): Promise<SnatEntry | null> {
    if (!this.shouldAttachToSandbox()) return null;
    const deadline = Date.now() + options.timeoutMs;
    const pollIntervalMs = options.pollIntervalMs ?? 1_000;
    let lastError = '';
    while (Date.now() < deadline) {
      try {
        const podIp = await this.findPodIp(ref);
        if (podIp) {
          if (!this.isSharedCidrMode()) return await this.ensureForPodIp(ref.name, podIp);
          return await this.ensureSharedCidrForPodIp(ref, podIp);
        }
      } catch (err) {
        // 配置覆盖缺口不是瞬态；继续轮询只会把明确错误伪装成 180s 超时。
        if (err instanceof SnatSharedCidrCoverageError) throw err;
        lastError = err instanceof Error ? err.message : String(err);
      }
      await sleep(pollIntervalMs);
    }
    throw new Error(`未找到 Sandbox Pod IP: ${ref.name}${lastError ? ` lastError=${lastError}` : ''}`);
  }

  /** 每个共享网段使用确定性唯一名称；旧单网段名称通过 SourceCIDR 自动接管。 */
  sharedCidrEntryName(sourceCidr: string): string {
    const prefix = safeSnatNamePrefix(this.config.snat.entryNamePrefix);
    const cidrSuffix = sourceCidr.replace(/[^a-zA-Z0-9_-]+/g, '-');
    return `${prefix}-shared-cidr-${cidrSuffix}`.slice(0, 128);
  }

  private sharedCidrs(): string[] {
    if (this.config.snat.sharedCidrs?.length) return this.config.snat.sharedCidrs;
    return this.config.snat.sharedCidr ? [this.config.snat.sharedCidr] : [];
  }

  sharedCidrConfigDigest(): string {
    return createHash('sha256').update(JSON.stringify({
      regionId: this.config.snat.regionId,
      snatTableId: this.config.snat.snatTableId,
      snatIp: this.config.snat.snatIp,
      sharedCidrs: this.sharedCidrs(),
    })).digest('hex').slice(0, 24);
  }

  private matchingSharedCidr(podIp: string): string | undefined {
    return this.sharedCidrs().find((cidr) => ipv4InCidr(podIp, cidr));
  }

  private isSharedCidrEntry(entry: SnatEntry): boolean {
    return this.isSharedCidrMode() && this.sharedCidrs().includes(entry.sourceCidr);
  }

  private async ensureSharedCidrForRef(ref: SandboxRef): Promise<SnatEntry> {
    this.assertRequiredConfig();
    const podIp = await this.findPodIp(ref);
    if (!podIp) throw new Error(`未找到 Sandbox Pod IP: ${ref.name}`);
    return await this.ensureSharedCidrForPodIp(ref, podIp);
  }

  private requireSharedCidrForPodIp(sandboxName: string, podIp: string): string {
    const sourceCidr = this.matchingSharedCidr(podIp);
    if (sourceCidr) return sourceCidr;
    const error = new SnatSharedCidrCoverageError(podIp, this.sharedCidrs());
    this.logger.error(
      `snat_pod_ip_outside_shared_cidrs sandbox=${sandboxName} podIp=${podIp} `
      + `sharedCidrs=${this.sharedCidrs().join(',')} action=fail_closed`,
    );
    throw error;
  }

  private async ensureSharedCidrForPodIp(ref: SandboxRef, podIp: string): Promise<SnatEntry> {
    return await this.ensureSharedCidrEntry(this.requireSharedCidrForPodIp(ref.name, podIp));
  }

  async assertSharedCidrCoverageForSandbox(ref: SandboxRef): Promise<void> {
    if (!this.isSharedCidrMode()) return;
    const pods = await this.listManagedPods(ref);
    if (pods.length === 0) throw new Error(`未找到 Sandbox Pod IP: ${ref.name}`);
    for (const pod of pods) await this.ensureSharedCidrForPodIp(ref, pod.podIp);
  }

  /** 确保指定共享网段条目存在并已进入 Available；同进程同 CIDR 创建 singleflight。 */
  private async ensureSharedCidrEntry(sourceCidr: string, knownEntries?: SnatEntry[]): Promise<SnatEntry> {
    const existing = this.sharedCidrEnsureInFlight.get(sourceCidr);
    if (existing) return await existing;
    const promise = this.ensureSharedCidrEntryExclusive(sourceCidr, knownEntries);
    this.sharedCidrEnsureInFlight.set(sourceCidr, promise);
    try {
      return await promise;
    } finally {
      if (this.sharedCidrEnsureInFlight.get(sourceCidr) === promise) {
        this.sharedCidrEnsureInFlight.delete(sourceCidr);
      }
    }
  }

  private async ensureSharedCidrEntryExclusive(sourceCidr: string, knownEntries?: SnatEntry[]): Promise<SnatEntry> {
    this.assertRequiredConfig();
    const snatIp = this.config.snat.snatIp!;
    const entries = knownEntries ?? await this.listEntries();
    const sameSource = entries.filter((entry) => entry.sourceCidr === sourceCidr);
    const existing = sameSource.find((entry) => entry.snatIp.split(',').includes(snatIp));
    if (existing?.status === 'Available') return existing;
    if (existing) return await this.waitForSharedCidrAvailable(sourceCidr, existing.id);
    if (sameSource.length > 0) {
      throw new Error(`ACS SNAT shared CIDR ${sourceCidr} 已被其他 SnatIp 占用`);
    }

    const tableEntryCount = entries.length;
    if (tableEntryCount >= this.config.snat.maxManagedEntries) {
      throw new Error(`ACS SNAT table entry quota exceeded: ${tableEntryCount}/${this.config.snat.maxManagedEntries}`);
    }
    const name = this.sharedCidrEntryName(sourceCidr);
    const result = await this.runAliyun([
      'vpc', 'CreateSnatEntry',
      '--RegionId', this.config.snat.regionId!,
      '--SnatTableId', this.config.snat.snatTableId!,
      '--SourceCIDR', sourceCidr,
      '--SnatIp', snatIp,
      '--SnatEntryName', name,
      '--ClientToken', createSnatClientToken(),
    ]);
    if (result.exitCode !== 0) throw new Error(`CreateSnatEntry(shared) 失败: ${result.stderr || result.stdout}`);
    this.logger.warn(`snat_shared_cidr_created sourceCidr=${sourceCidr} snatIp=${snatIp}`);
    const createdId = stringValue(parseJsonObject(result.stdout)?.SnatEntryId);
    return await this.waitForSharedCidrAvailable(sourceCidr, createdId);
  }

  private async waitForSharedCidrAvailable(sourceCidr: string, entryId?: string): Promise<SnatEntry> {
    const deadline = Date.now() + Math.max(
      this.config.snat.requestTimeoutMs,
      this.config.snat.stabilizeAfterCreateMs + 5_000,
    );
    let lastStatus = 'missing';
    while (Date.now() < deadline) {
      const entry = (await this.listEntries(sourceCidr)).find((candidate) => (
        candidate.sourceCidr === sourceCidr
        && (!entryId || candidate.id === entryId)
        && candidate.snatIp.split(',').includes(this.config.snat.snatIp!)
      ));
      if (entry?.status === 'Available') return entry;
      lastStatus = entry?.status ?? 'missing';
      await sleep(500);
    }
    throw new Error(`ACS SNAT shared CIDR ${sourceCidr} 未进入 Available: lastStatus=${lastStatus}`);
  }

  async ensureForProbe(ref: SandboxRef): Promise<SnatEntry | null> {
    if (!this.shouldAttachToProbe()) return null;
    if (this.isSharedCidrMode()) return await this.ensureSharedCidrForRef(ref);
    return await this.ensureForRef(ref);
  }

  async deleteForSandboxName(sandboxName: string): Promise<string[]> {
    if (!this.isEnabled() || !this.hasRequiredConfig()) return [];
    // shared-cidr 下条目为全体 pod 共用，删单个 Sandbox 绝不能连带删除它，
    // 否则会一次性掐断所有 pod 的公网出口。仍按名字清理该 Sandbox 可能遗留的
    // per-pod 条目（模式切换前建的、或越界回退产生的）。
    const name = this.entryNameForSandboxName(sandboxName);
    const entries = (await this.listEntries()).filter((entry) => entry.managed && entry.name === name);
    const deleted: string[] = [];
    for (const entry of entries) {
      await this.deleteEntry(entry.id);
      deleted.push(entry.id);
    }
    if (deleted.length) this.logger.warn(`snat_deleted sandbox=${sandboxName} entries=${deleted.length}`);
    return deleted;
  }

  private async reconcileConfiguredSharedCidrs(): Promise<SnatEntry[]> {
    let entries = await this.listEntries();
    for (const sourceCidr of this.sharedCidrs()) {
      const ensured = await this.ensureSharedCidrEntry(sourceCidr, entries);
      if (!entries.some((entry) => entry.id === ensured.id)) entries = [...entries, ensured];
    }
    // 删除 /32 前再次读取权威状态：所有共享条目必须已由云侧确认 Available。
    entries = await this.listEntries();
    for (const sourceCidr of this.sharedCidrs()) {
      const available = entries.some((entry) => (
        entry.sourceCidr === sourceCidr
        && entry.status === 'Available'
        && entry.snatIp.split(',').includes(this.config.snat.snatIp!)
      ));
      if (!available) throw new Error(`ACS SNAT shared CIDR ${sourceCidr} 未确认 Available，拒绝删除 /32`);
    }
    return entries;
  }

  private availableSharedCidrs(entries: SnatEntry[]): string[] {
    if (!this.isSharedCidrMode()) return [];
    return this.sharedCidrs().filter((sourceCidr) => entries.some((entry) => (
      entry.sourceCidr === sourceCidr
      && entry.status === 'Available'
      && entry.snatIp.split(',').includes(this.config.snat.snatIp!)
    )));
  }

  private isRedundantPerPodEntry(entry: SnatEntry, availableSharedCidrs: string[]): boolean {
    if (!entry.sourceCidr.endsWith('/32')) return false;
    const podIp = entry.sourceCidr.slice(0, -3);
    return availableSharedCidrs.some((sourceCidr) => ipv4InCidr(podIp, sourceCidr));
  }

  /**
   * 在运维已完成真实网络验收后显式调用：再次确认全部共享条目 Available，
   * 再逐条删除其覆盖的 managed /32。常规 lifecycle 不会自动调用此迁移。
   */
  async migrateCoveredPerPodEntries(): Promise<SnatCleanupReport> {
    if (!this.isSharedCidrMode() || !this.hasRequiredConfig()) {
      throw new Error('SNAT /32 migration 仅支持已完整配置的 shared-cidr 模式');
    }
    const entries = await this.reconcileConfiguredSharedCidrs();
    const availableSharedCidrs = this.availableSharedCidrs(entries);
    const managed = entries.filter((entry) => entry.managed);
    const coveredPerPodEntries = managed.filter((entry) => (
      !this.isSharedCidrEntry(entry)
      && this.isRedundantPerPodEntry(entry, availableSharedCidrs)
    ));
    const deleted = await this.deleteEntriesBestEffort(coveredPerPodEntries, 'snat_migration');
    if (deleted.length) {
      this.logger.warn(
        `snat_shared_cidr_migration deleted=${deleted.length} `
        + `coveredCidrs=${coveredPerPodEntries.map((entry) => entry.sourceCidr).join(',')}`,
      );
    }
    return {
      enabled: true,
      checked: entries.length,
      deleted,
      orphanCidrs: coveredPerPodEntries.map((entry) => entry.sourceCidr),
      unexpected: entries.filter((entry) => !entry.managed),
    };
  }

  /** 回滚旧单网段版本前调用：为当前 Running Sandbox Pod 恢复 /32，并确认稳定集合全部 Available。 */
  async restorePerPodEntriesForManagedPods(
    sandboxIdentities?: readonly ManagedSandboxIdentity[],
  ): Promise<SnatRestoreReport> {
    if (!this.isSharedCidrMode() || !this.hasRequiredConfig()) {
      throw new Error('SNAT /32 restore 仅支持已完整配置的 shared-cidr 模式');
    }
    const expectedSandboxes = sandboxIdentities
      ? new Map(sandboxIdentities.map((sandbox) => [managedSandboxIdentityKey(sandbox), sandbox.name]))
      : undefined;
    const selectPods = async () => (await this.listManagedPods())
      .filter((pod) => !expectedSandboxes || expectedSandboxes.has(pod.sandboxIdentity))
      .map((pod) => ({
        ...pod,
        sandboxName: expectedSandboxes?.get(pod.sandboxIdentity) ?? pod.name,
      }));
    for (let round = 1; round <= 5; round++) {
      const pods = await selectPods();
      const selectedIdentities = new Set(pods.map((pod) => pod.sandboxIdentity));
      if (expectedSandboxes && (
        pods.length !== expectedSandboxes.size
        || [...expectedSandboxes.keys()].some((identity) => !selectedIdentities.has(identity))
      )) {
        this.logger.warn(
          `snat_per_pod_restore_retry reason=running_sandbox_pod_mismatch round=${round} `
          + `sandboxes=${expectedSandboxes.size} pods=${pods.length}`,
        );
        await sleep(500);
        continue;
      }

      const expectedCidrs = new Set(pods.map((pod) => `${pod.podIp}/32`));
      const tableEntries = await this.listEntries();
      const missingCount = [...expectedCidrs].filter((sourceCidr) => !tableEntries.some((entry) => (
        entry.sourceCidr === sourceCidr
        && entry.snatIp.split(',').includes(this.config.snat.snatIp!)
      ))).length;
      if (tableEntries.length + missingCount > this.config.snat.maxManagedEntries) {
        throw new Error(
          `ACS SNAT rollback capacity insufficient: entries=${tableEntries.length} `
          + `missing=${missingCount} limit=${this.config.snat.maxManagedEntries}`,
        );
      }
      for (const pod of pods) await this.ensureForPodIp(pod.sandboxName, pod.podIp);

      const expectedKeys = new Set(pods.map((pod) => `${pod.sandboxIdentity}=${pod.podIp}`));
      const deadline = Date.now() + Math.max(
        this.config.snat.requestTimeoutMs,
        this.config.snat.stabilizeAfterCreateMs + 5_000,
      );
      let availableEntries: SnatEntry[] = [];
      let availableCidrs = new Set<string>();
      while (Date.now() < deadline) {
        const entries = await this.listEntries();
        availableEntries = entries.filter((entry) => (
          expectedCidrs.has(entry.sourceCidr)
          && entry.status === 'Available'
          && entry.snatIp.split(',').includes(this.config.snat.snatIp!)
        ));
        availableCidrs = new Set(availableEntries.map((entry) => entry.sourceCidr));
        if (availableCidrs.size === expectedCidrs.size) break;
        await sleep(500);
      }
      if (availableCidrs.size !== expectedCidrs.size) {
        throw new Error(
          `ACS SNAT rollback /32 未全部进入 Available: ${availableCidrs.size}/${expectedCidrs.size}`,
        );
      }
      const verifiedPods = await selectPods();
      const verifiedKeys = new Set(verifiedPods.map((pod) => `${pod.sandboxIdentity}=${pod.podIp}`));
      if (sameStringSet(expectedKeys, verifiedKeys)) {
        return { checked: expectedCidrs.size, available: availableCidrs.size, entries: availableEntries };
      }
      this.logger.warn(`snat_per_pod_restore_retry reason=pod_set_changed round=${round}`);
    }
    throw new Error('ACS SNAT rollback 期间 Running Sandbox 与 Pod 集合持续变化，拒绝确认恢复完成');
  }

  private async deleteEntriesBestEffort(entries: SnatEntry[], event: string): Promise<string[]> {
    const deleted: string[] = [];
    for (const entry of entries) {
      try {
        await this.deleteEntry(entry.id);
        deleted.push(entry.id);
      } catch (err) {
        this.logger.warn(
          `${event}_delete_failed id=${entry.id} sourceCidr=${entry.sourceCidr} `
          + `reason=${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return deleted;
  }

  async cleanupOrphans(
    activeSourceCidrs: Set<string>,
    options: { retainedEntryNames?: Set<string> } = {},
  ): Promise<SnatCleanupReport> {
    if (!this.isEnabled() || !this.hasRequiredConfig()) {
      return { enabled: false, checked: 0, deleted: [], orphanCidrs: [], unexpected: [] };
    }
    // shared-cidr 下 lifecycle 负责先把全部共享条目建到 Available，但不自动删除
    // 活跃/Paused 的 /32；后者必须等真实网络验收后显式调用迁移。
    const entries = this.isSharedCidrMode()
      ? await this.reconcileConfiguredSharedCidrs()
      : await this.listEntries();
    const managed = entries.filter((entry) => entry.managed);
    const unexpected = entries.filter((entry) => !entry.managed);
    const retainedEntryNames = options.retainedEntryNames ?? new Set<string>();
    const orphans = managed.filter((entry) => (
      !this.isSharedCidrEntry(entry)
      && !activeSourceCidrs.has(entry.sourceCidr)
      && !retainedEntryNames.has(entry.name)
    ));
    // 活跃与 Paused 的 /32 即使已被共享网段覆盖，也必须等显式迁移调用；这给生产
    // 留出逐网段真实出网验收窗口，避免 lifecycle 仅凭控制面 Available 就提前清场。
    const deleted = await this.deleteEntriesBestEffort(orphans, 'snat_orphan');
    if (deleted.length) {
      this.logger.warn(`snat_orphan_cleanup deleted=${deleted.length} orphanCidrs=${orphans.map((entry) => entry.sourceCidr).join(',')}`);
    }
    return {
      enabled: true,
      checked: entries.length,
      deleted,
      orphanCidrs: orphans.map((entry) => entry.sourceCidr),
      unexpected,
    };
  }

  async status(activeSourceCidrs?: Set<string>): Promise<SnatStatus> {
    const configured = this.hasRequiredConfig();
    if (!this.isEnabled() || !configured) {
      return this.emptyStatus(configured);
    }
    try {
      const entries = await this.listEntries();
      const managed = entries.filter((entry) => entry.managed);
      const unexpected = entries.filter((entry) => !entry.managed);
      const availableSharedCidrs = this.availableSharedCidrs(entries);
      const redundantPerPodCount = managed.filter((entry) => (
        !this.isSharedCidrEntry(entry)
        && this.isRedundantPerPodEntry(entry, availableSharedCidrs)
      )).length;
      const uncoveredPodCidrs = this.isSharedCidrMode() && activeSourceCidrs
        ? [...activeSourceCidrs].filter((podCidr) => (
          !podCidr.endsWith('/32')
          || !this.matchingSharedCidr(podCidr.slice(0, -3))
        ))
        : [];
      const orphanCount = activeSourceCidrs
        ? managed.filter((entry) => (
          !this.isSharedCidrEntry(entry) && !activeSourceCidrs.has(entry.sourceCidr)
        )).length
        : 0;
      return {
        enabled: true,
        mode: this.config.snat.mode,
        configured: true,
        ...(this.isSharedCidrMode() ? {
          sharedCidrs: this.sharedCidrs(),
          sharedCidrConfigDigest: this.sharedCidrConfigDigest(),
        } : {}),
        regionId: this.config.snat.regionId,
        snatTableId: this.config.snat.snatTableId,
        snatIp: this.config.snat.snatIp,
        entryNamePrefix: this.config.snat.entryNamePrefix,
        maxManagedEntries: this.config.snat.maxManagedEntries,
        managedCount: managed.length,
        unexpectedCount: unexpected.length,
        orphanCount,
        redundantPerPodCount,
        sharedCidrAvailableCount: availableSharedCidrs.length,
        uncoveredPodCidrs,
        entries,
      };
    } catch (err) {
      return {
        ...this.emptyStatus(configured),
        enabled: true,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async activeManagedPodCidrs(): Promise<Set<string>> {
    const pods = await this.listManagedPods();
    return new Set(pods.map((pod) => `${pod.podIp}/32`));
  }

  entryNameForSandboxName(sandboxName: string): string {
    const prefix = safeSnatNamePrefix(this.config.snat.entryNamePrefix);
    return `${prefix}-${sandboxName}`.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 128);
  }

  private async ensureForRef(ref: SandboxRef): Promise<SnatEntry> {
    this.assertRequiredConfig();
    const podIp = await this.findPodIp(ref);
    if (!podIp) throw new Error(`未找到 Sandbox Pod IP: ${ref.name}`);
    return await this.ensureForPodIp(ref.name, podIp);
  }

  private async ensureForPodIp(sandboxName: string, podIp: string): Promise<SnatEntry> {
    const sourceCidr = `${podIp}/32`;
    const name = this.entryNameForSandboxName(sandboxName);
    const existing = (await this.listEntries(sourceCidr))
      .find((entry) => entry.sourceCidr === sourceCidr && entry.snatIp.split(',').includes(this.config.snat.snatIp!));
    if (existing) return existing;
    const allEntries = await this.listEntries();
    const staleNamedEntries = allEntries.filter((entry) => (
      entry.managed
      && entry.name === name
      && entry.sourceCidr !== sourceCidr
    ));
    for (const entry of staleNamedEntries) {
      await this.deleteEntry(entry.id);
    }
    if (staleNamedEntries.length) {
      this.logger.warn(`snat_stale_deleted sandbox=${sandboxName} entries=${staleNamedEntries.length}`);
    }
    const staleIds = new Set(staleNamedEntries.map((entry) => entry.id));
    const tableEntryCount = allEntries.filter((entry) => !staleIds.has(entry.id)).length;
    if (tableEntryCount >= this.config.snat.maxManagedEntries) {
      throw new Error(`ACS SNAT table entry quota exceeded: ${tableEntryCount}/${this.config.snat.maxManagedEntries}`);
    }
    const result = await this.runAliyun([
      'vpc',
      'CreateSnatEntry',
      '--RegionId',
      this.config.snat.regionId!,
      '--SnatTableId',
      this.config.snat.snatTableId!,
      '--SourceCIDR',
      sourceCidr,
      '--SnatIp',
      this.config.snat.snatIp!,
      '--SnatEntryName',
      name,
      '--ClientToken',
      createSnatClientToken(),
    ]);
    if (result.exitCode !== 0) throw new Error(`CreateSnatEntry 失败: ${result.stderr || result.stdout}`);
    this.logger.warn(`snat_created sandbox=${sandboxName} sourceCidr=${sourceCidr} snatIp=${this.config.snat.snatIp}`);
    if (this.config.snat.stabilizeAfterCreateMs > 0) {
      // 2026-07-31 方案4：stabilize 传播等待移出关键路径。等待不影响传播完成时
      // 刻，只影响「返回时是否已稳」；新建 Sandbox 的首个工具调用通常是读文件/
      // Shell 而非公网请求，8s 硬等待是 100% 确定成本，换成小概率「公网请求撞
      // 传播窗口失败一次由 Agent 重试」。后台计时结束补记日志便于诊断。
      const stabilizeMs = this.config.snat.stabilizeAfterCreateMs;
      this.logger.info(`snat_stabilizing_background sandbox=${sandboxName} ms=${stabilizeMs}`);
      void sleep(stabilizeMs).then(() => {
        this.logger.info(`snat_stabilized sandbox=${sandboxName} ms=${stabilizeMs}`);
      });
    }
    const created = (await this.listEntries(sourceCidr))
      .find((entry) => entry.sourceCidr === sourceCidr && entry.name === name);
    return created ?? {
      id: parseJsonObject(result.stdout)?.SnatEntryId ? String(parseJsonObject(result.stdout)?.SnatEntryId) : '',
      name,
      sourceCidr,
      snatIp: this.config.snat.snatIp!,
      managed: true,
    };
  }

  private async findPodIp(ref: SandboxRef): Promise<string | undefined> {
    const pods = await this.listManagedPods(ref);
    return pods[0]?.podIp;
  }

  private async listManagedPods(ref?: SandboxRef): Promise<Array<{ name: string; podIp: string; sandboxIdentity: string }>> {
    const selector = [
      `app.kubernetes.io/managed-by=${MANAGED_BY_LABEL}`,
      ...(ref ? [
        `${WORKSPACE_LABEL}=${labelValue(ref.workspaceId)}`,
        `${SANDBOX_SCOPE_LABEL}=${labelValue(ref.sandboxScopeId)}`,
      ] : []),
    ].join(',');
    // 2026-08-03 CPU 治理 P3b：REST 直连优先，失败回退 kubectl。
    let items = await this.kubeApi?.listPodItems(selector) ?? null;
    if (items === null) {
      const result = await this.kubectl.run(['get', 'pod', '-l', selector, '-o', 'json'], {
        timeoutMs: this.config.sandboxWaitTimeoutMs,
      });
      if (result.exitCode !== 0) throw new Error(`list Sandbox Pod 失败: ${result.stderr || result.stdout}`);
      const body = JSON.parse(result.stdout || '{}') as { items?: Array<Record<string, unknown>> };
      items = body.items ?? [];
    }
    return items.map((item) => {
      const metadata = item.metadata && typeof item.metadata === 'object' ? item.metadata as Record<string, unknown> : {};
      const status = item.status && typeof item.status === 'object' ? item.status as Record<string, unknown> : {};
      const labels = metadata.labels && typeof metadata.labels === 'object'
        ? metadata.labels as Record<string, unknown>
        : {};
      const name = typeof metadata.name === 'string' ? metadata.name : '';
      const podIp = typeof status.podIP === 'string' && isIP(status.podIP) === 4 ? status.podIP : '';
      const workspaceId = typeof labels[WORKSPACE_LABEL] === 'string' ? labels[WORKSPACE_LABEL] : '';
      const sandboxScopeId = typeof labels[SANDBOX_SCOPE_LABEL] === 'string' ? labels[SANDBOX_SCOPE_LABEL] : '';
      return { name, podIp, sandboxIdentity: `${workspaceId}\u0000${sandboxScopeId}` };
    }).filter((pod) => pod.name && pod.podIp);
  }

  private async listEntries(sourceCidr?: string): Promise<SnatEntry[]> {
    this.assertRequiredConfig();
    const pageSize = 50;
    const entries: SnatEntry[] = [];
    const seenIds = new Set<string>();
    for (let pageNumber = 1; pageNumber <= 100; pageNumber++) {
      const result = await this.runAliyun([
        'vpc',
        'DescribeSnatTableEntries',
        '--RegionId',
        this.config.snat.regionId!,
        '--SnatTableId',
        this.config.snat.snatTableId!,
        '--PageSize',
        String(pageSize),
        '--PageNumber',
        String(pageNumber),
        ...(sourceCidr ? ['--SourceCIDR', sourceCidr] : []),
      ]);
      if (result.exitCode !== 0) throw new Error(`DescribeSnatTableEntries 失败: ${result.stderr || result.stdout}`);
      const body = parseJsonObject(result.stdout);
      const rawEntries = (((body?.SnatTableEntries as Record<string, unknown> | undefined)?.SnatTableEntry) ?? []) as unknown;
      const items = Array.isArray(rawEntries) ? rawEntries : rawEntries ? [rawEntries] : [];
      const pageEntries = items
        .map((item) => normalizeEntry(item, this.config.snat.entryNamePrefix))
        .filter((entry): entry is SnatEntry => Boolean(entry));
      let added = 0;
      for (const entry of pageEntries) {
        if (seenIds.has(entry.id)) continue;
        seenIds.add(entry.id);
        entries.push(entry);
        added += 1;
      }
      const rawTotal = body?.TotalCount;
      const totalCount = typeof rawTotal === 'number'
        ? rawTotal
        : typeof rawTotal === 'string' && /^\d+$/.test(rawTotal) ? Number(rawTotal) : undefined;
      if (totalCount !== undefined ? entries.length >= totalCount : items.length < pageSize) return entries;
      if (items.length === 0 || added === 0) {
        throw new Error(`DescribeSnatTableEntries 分页未前进: page=${pageNumber} collected=${entries.length}`);
      }
    }
    throw new Error('DescribeSnatTableEntries 分页超过 100 页，拒绝使用不完整结果');
  }

  private async deleteEntry(entryId: string): Promise<void> {
    const result = await this.runAliyun([
      'vpc',
      'DeleteSnatEntry',
      '--RegionId',
      this.config.snat.regionId!,
      '--SnatTableId',
      this.config.snat.snatTableId!,
      '--SnatEntryId',
      entryId,
    ]);
    if (result.exitCode !== 0) throw new Error(`DeleteSnatEntry 失败: ${result.stderr || result.stdout}`);
  }

  private async runAliyun(args: string[]): Promise<CommandResult> {
    return await new Promise<CommandResult>((resolve) => {
      const child = spawn(this.config.snat.aliyunCliPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) child.kill('SIGTERM');
      }, this.config.snat.requestTimeoutMs);
      timer.unref?.();
      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf-8'); });
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8'); });
      child.on('error', (err) => {
        settled = true;
        clearTimeout(timer);
        resolve({ stdout, stderr: stderr + `\n${err.message}`, exitCode: -1, signal: null });
      });
      child.on('close', (exitCode, signal) => {
        settled = true;
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode, signal });
      });
    });
  }

  private hasRequiredConfig(): boolean {
    return Boolean(
      this.config.snat.regionId
      && this.config.snat.snatTableId
      && this.config.snat.snatIp
      && (!this.isSharedCidrMode() || this.sharedCidrs().length > 0),
    );
  }

  private assertRequiredConfig(): void {
    if (!this.hasRequiredConfig()) {
      throw new Error('ACS SNAT 未完整配置：需要 regionId/snatTableId/snatIp，shared-cidr 模式还需要 sharedCidrs');
    }
  }

  private emptyStatus(configured: boolean): SnatStatus {
    return {
      enabled: this.isEnabled(),
      mode: this.config.snat.mode,
      configured,
      ...(this.isSharedCidrMode() ? {
        sharedCidrs: this.sharedCidrs(),
        sharedCidrConfigDigest: this.sharedCidrConfigDigest(),
      } : {}),
      regionId: this.config.snat.regionId,
      snatTableId: this.config.snat.snatTableId,
      snatIp: this.config.snat.snatIp,
      entryNamePrefix: this.config.snat.entryNamePrefix,
      maxManagedEntries: this.config.snat.maxManagedEntries,
      managedCount: 0,
      unexpectedCount: 0,
      orphanCount: 0,
      redundantPerPodCount: 0,
      sharedCidrAvailableCount: 0,
      uncoveredPodCidrs: [],
      entries: [],
    };
  }
}

function normalizeEntry(input: unknown, managedPrefix: string): SnatEntry | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;
  const id = stringValue(raw.SnatEntryId);
  const name = stringValue(raw.SnatEntryName) ?? '';
  const sourceCidr = stringValue(raw.SourceCIDR) ?? '';
  const snatIp = stringValue(raw.SnatIp) ?? '';
  if (!id || !sourceCidr) return null;
  return {
    id,
    name,
    sourceCidr,
    snatIp,
    status: stringValue(raw.Status),
    managed: name.startsWith(`${safeSnatNamePrefix(managedPrefix)}-`),
  };
}

function parseJsonObject(stdout: string): Record<string, unknown> | null {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  return JSON.parse(stdout.slice(start, end + 1)) as Record<string, unknown>;
}

function safeSnatNamePrefix(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return /^[a-zA-Z]/.test(cleaned) ? cleaned : `a${cleaned || 'agent-saas-acs'}`;
}

function createSnatClientToken(): string {
  return `agent-saas-acs-${randomUUID()}`;
}

function sameStringSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function managedSandboxIdentityKey(sandbox: ManagedSandboxIdentity): string {
  return `${labelValue(sandbox.workspaceId)}\u0000${labelValue(sandbox.sandboxScopeId)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function labelValue(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 40);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

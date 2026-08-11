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
  regionId?: string;
  snatTableId?: string;
  snatIp?: string;
  entryNamePrefix: string;
  maxManagedEntries: number;
  managedCount: number;
  unexpectedCount: number;
  orphanCount: number;
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

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

const MANAGED_BY_LABEL = 'agent-saas-acs-orchestrator';
const WORKSPACE_LABEL = 'agent-saas.kaiyan.net/workspace-id';
const SANDBOX_SCOPE_LABEL = 'agent-saas.kaiyan.net/sandbox-scope-id';

export class SnatManager {
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
    if (this.isSharedCidrMode()) return await this.ensureSharedCidrEntry();
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
          if (!this.isSharedCidrMode()) return await this.ensureForPodIp(ref, podIp);
          // shared-cidr 安全兜底：网段共享建立在「pod IP 必落在托管网段内」这一
          // 观测之上（生产 7 天实测全部同 /24），但 ACS 并未对分配范围作出保证。
          // 一旦某个 pod 落到网段外，共享条目覆盖不到它 → **静默断网**，且极难排查。
          // 故此处逐 pod 校验，越界即回退 per-pod 建条目并告警，绝不放任。
          if (ipv4InCidr(podIp, this.config.snat.sharedCidr)) {
            return await this.ensureSharedCidrEntry();
          }
          this.logger.error(
            `snat_pod_ip_outside_shared_cidr sandbox=${ref.name} podIp=${podIp} `
            + `sharedCidr=${this.config.snat.sharedCidr} action=fallback_per_pod`,
          );
          return await this.ensureForPodIp(ref, podIp);
        }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
      await sleep(pollIntervalMs);
    }
    throw new Error(`未找到 Sandbox Pod IP: ${ref.name}${lastError ? ` lastError=${lastError}` : ''}`);
  }

  /** 托管网段的固定条目名——与 per-pod 条目共用前缀，故同样被 `managed` 识别。 */
  sharedCidrEntryName(): string {
    const prefix = safeSnatNamePrefix(this.config.snat.entryNamePrefix);
    return `${prefix}-shared-cidr`.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 128);
  }

  private isSharedCidrEntry(entry: SnatEntry): boolean {
    if (!this.isSharedCidrMode()) return false;
    return entry.sourceCidr === this.config.snat.sharedCidr || entry.name === this.sharedCidrEntryName();
  }

  /**
   * 确保网段条目存在。幂等：已存在直接返回，不重复创建。
   * 与 per-pod 的关键差异——**它与 pod 生命周期无关**，因此新 pod 不再需要
   * 建条目，也就不再有 8 秒传播等待。
   */
  private async ensureSharedCidrEntry(): Promise<SnatEntry> {
    this.assertRequiredConfig();
    const sourceCidr = this.config.snat.sharedCidr;
    if (!sourceCidr) throw new Error('shared-cidr 模式缺少 sharedCidr 配置');
    const snatIp = this.config.snat.snatIp!;
    const existing = (await this.listEntries(sourceCidr))
      .find((entry) => entry.sourceCidr === sourceCidr && entry.snatIp.split(',').includes(snatIp));
    if (existing) return existing;

    const name = this.sharedCidrEntryName();
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
    if (this.config.snat.stabilizeAfterCreateMs > 0) {
      const stabilizeMs = this.config.snat.stabilizeAfterCreateMs;
      void sleep(stabilizeMs).then(() => {
        this.logger.info(`snat_stabilized shared=true ms=${stabilizeMs}`);
      });
    }
    const created = (await this.listEntries(sourceCidr))
      .find((entry) => entry.sourceCidr === sourceCidr && entry.name === name);
    return created ?? {
      id: parseJsonObject(result.stdout)?.SnatEntryId ? String(parseJsonObject(result.stdout)?.SnatEntryId) : '',
      name,
      sourceCidr,
      snatIp,
      managed: true,
    };
  }

  async ensureForProbe(ref: SandboxRef): Promise<SnatEntry | null> {
    if (!this.shouldAttachToProbe()) return null;
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

  async cleanupOrphans(
    activeSourceCidrs: Set<string>,
    options: { retainedEntryNames?: Set<string> } = {},
  ): Promise<SnatCleanupReport> {
    if (!this.isEnabled() || !this.hasRequiredConfig()) {
      return { enabled: false, checked: 0, deleted: [], orphanCidrs: [], unexpected: [] };
    }
    const entries = await this.listEntries();
    const managed = entries.filter((entry) => entry.managed);
    const unexpected = entries.filter((entry) => !entry.managed);
    const retainedEntryNames = options.retainedEntryNames ?? new Set<string>();
    // ⚠️ 共享网段条目的 sourceCidr 是网段而非某个 podIp/32，永远不会出现在
    // activeSourceCidrs（那是活跃 pod IP 集合）里，若不显式豁免就会被当孤儿删掉——
    // 后果是全体 pod 同时断网。这里按「网段 + 固定条目名」双重豁免。
    const orphans = managed.filter((entry) => (
      !activeSourceCidrs.has(entry.sourceCidr)
      && !retainedEntryNames.has(entry.name)
      && !this.isSharedCidrEntry(entry)
    ));
    const deleted: string[] = [];
    // 逐条容错：同一张 SNAT 表的操作在阿里云侧是串行的，发布瞬间与 pod 退休流程
    // 并发时单条删除可能瞬时失败。孤儿清理本就是尽力而为——一条删不掉不该中断其余
    // 条目，更不该顺着调用链把 provision 打挂（2026-08-11）。残留条目会在下一轮
    // lifecycle 循环里重新被识别为孤儿并重试。
    for (const entry of orphans) {
      try {
        await this.deleteEntry(entry.id);
        deleted.push(entry.id);
      } catch (err) {
        this.logger.warn(
          `snat_orphan_delete_failed id=${entry.id} sourceCidr=${entry.sourceCidr} `
          + `reason=${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
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
      const orphanCount = activeSourceCidrs
        ? managed.filter((entry) => (
          !activeSourceCidrs.has(entry.sourceCidr) && !this.isSharedCidrEntry(entry)
        )).length
        : 0;
      return {
        enabled: true,
        mode: this.config.snat.mode,
        configured: true,
        regionId: this.config.snat.regionId,
        snatTableId: this.config.snat.snatTableId,
        snatIp: this.config.snat.snatIp,
        entryNamePrefix: this.config.snat.entryNamePrefix,
        maxManagedEntries: this.config.snat.maxManagedEntries,
        managedCount: managed.length,
        unexpectedCount: unexpected.length,
        orphanCount,
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
    return await this.ensureForPodIp(ref, podIp);
  }

  private async ensureForPodIp(ref: SandboxRef, podIp: string): Promise<SnatEntry> {
    const sourceCidr = `${podIp}/32`;
    const name = this.entryNameForSandboxName(ref.name);
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
      this.logger.warn(`snat_stale_deleted sandbox=${ref.name} entries=${staleNamedEntries.length}`);
    }
    const staleIds = new Set(staleNamedEntries.map((entry) => entry.id));
    const managedCount = allEntries.filter((entry) => entry.managed && !staleIds.has(entry.id)).length;
    if (managedCount >= this.config.snat.maxManagedEntries) {
      throw new Error(`ACS SNAT managed entry quota exceeded: ${managedCount}/${this.config.snat.maxManagedEntries}`);
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
    this.logger.warn(`snat_created sandbox=${ref.name} sourceCidr=${sourceCidr} snatIp=${this.config.snat.snatIp}`);
    if (this.config.snat.stabilizeAfterCreateMs > 0) {
      // 2026-07-31 方案4：stabilize 传播等待移出关键路径。等待不影响传播完成时
      // 刻，只影响「返回时是否已稳」；新建 Sandbox 的首个工具调用通常是读文件/
      // Shell 而非公网请求，8s 硬等待是 100% 确定成本，换成小概率「公网请求撞
      // 传播窗口失败一次由 Agent 重试」。后台计时结束补记日志便于诊断。
      const stabilizeMs = this.config.snat.stabilizeAfterCreateMs;
      this.logger.info(`snat_stabilizing_background sandbox=${ref.name} ms=${stabilizeMs}`);
      void sleep(stabilizeMs).then(() => {
        this.logger.info(`snat_stabilized sandbox=${ref.name} ms=${stabilizeMs}`);
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

  private async listManagedPods(ref?: SandboxRef): Promise<Array<{ name: string; podIp: string }>> {
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
      const name = typeof metadata.name === 'string' ? metadata.name : '';
      const podIp = typeof status.podIP === 'string' && isIP(status.podIP) === 4 ? status.podIP : '';
      return { name, podIp };
    }).filter((pod) => pod.name && pod.podIp);
  }

  private async listEntries(sourceCidr?: string): Promise<SnatEntry[]> {
    this.assertRequiredConfig();
    const result = await this.runAliyun([
      'vpc',
      'DescribeSnatTableEntries',
      '--RegionId',
      this.config.snat.regionId!,
      '--SnatTableId',
      this.config.snat.snatTableId!,
      '--PageSize',
      '50',
      ...(sourceCidr ? ['--SourceCIDR', sourceCidr] : []),
    ]);
    if (result.exitCode !== 0) throw new Error(`DescribeSnatTableEntries 失败: ${result.stderr || result.stdout}`);
    const body = parseJsonObject(result.stdout);
    const rawEntries = (((body?.SnatTableEntries as Record<string, unknown> | undefined)?.SnatTableEntry) ?? []) as unknown;
    const items = Array.isArray(rawEntries) ? rawEntries : rawEntries ? [rawEntries] : [];
    return items.map((item) => normalizeEntry(item, this.config.snat.entryNamePrefix)).filter((entry): entry is SnatEntry => Boolean(entry));
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
    return Boolean(this.config.snat.regionId && this.config.snat.snatTableId && this.config.snat.snatIp);
  }

  private assertRequiredConfig(): void {
    if (!this.hasRequiredConfig()) {
      throw new Error('ACS SNAT 未完整配置：需要 regionId/snatTableId/snatIp');
    }
  }

  private emptyStatus(configured: boolean): SnatStatus {
    return {
      enabled: this.isEnabled(),
      mode: this.config.snat.mode,
      configured,
      regionId: this.config.snat.regionId,
      snatTableId: this.config.snat.snatTableId,
      snatIp: this.config.snat.snatIp,
      entryNamePrefix: this.config.snat.entryNamePrefix,
      maxManagedEntries: this.config.snat.maxManagedEntries,
      managedCount: 0,
      unexpectedCount: 0,
      orphanCount: 0,
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function labelValue(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 40);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

import type { AcsOrchestratorConfig } from './config.js';
import type { Kubectl } from './kubectl.js';
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
  ) {}

  isEnabled(): boolean {
    return this.config.snat.mode !== 'disabled';
  }

  shouldAttachToSandbox(): boolean {
    return this.config.snat.mode === 'per-sandbox' && this.config.networkPolicy.mode === 'public-egress';
  }

  shouldAttachToProbe(): boolean {
    return (this.config.snat.mode === 'probe-only' || this.config.snat.mode === 'per-sandbox')
      && this.config.networkPolicy.mode === 'public-egress';
  }

  async ensureForSandbox(ref: SandboxRef): Promise<SnatEntry | null> {
    if (!this.shouldAttachToSandbox()) return null;
    return await this.ensureForRef(ref);
  }

  async ensureForProbe(ref: SandboxRef): Promise<SnatEntry | null> {
    if (!this.shouldAttachToProbe()) return null;
    return await this.ensureForRef(ref);
  }

  async deleteForSandboxName(sandboxName: string): Promise<string[]> {
    if (!this.isEnabled() || !this.hasRequiredConfig()) return [];
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

  async cleanupOrphans(activeSourceCidrs: Set<string>): Promise<SnatCleanupReport> {
    if (!this.isEnabled() || !this.hasRequiredConfig()) {
      return { enabled: false, checked: 0, deleted: [], orphanCidrs: [], unexpected: [] };
    }
    const entries = await this.listEntries();
    const managed = entries.filter((entry) => entry.managed);
    const unexpected = entries.filter((entry) => !entry.managed);
    const orphans = managed.filter((entry) => !activeSourceCidrs.has(entry.sourceCidr));
    const deleted: string[] = [];
    for (const entry of orphans) {
      await this.deleteEntry(entry.id);
      deleted.push(entry.id);
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
        ? managed.filter((entry) => !activeSourceCidrs.has(entry.sourceCidr)).length
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

  private async ensureForRef(ref: SandboxRef): Promise<SnatEntry> {
    this.assertRequiredConfig();
    const podIp = await this.findPodIp(ref);
    if (!podIp) throw new Error(`未找到 Sandbox Pod IP: ${ref.name}`);
    const sourceCidr = `${podIp}/32`;
    const existing = (await this.listEntries(sourceCidr))
      .find((entry) => entry.sourceCidr === sourceCidr && entry.snatIp.split(',').includes(this.config.snat.snatIp!));
    if (existing) return existing;
    const managedCount = (await this.listEntries()).filter((entry) => entry.managed).length;
    if (managedCount >= this.config.snat.maxManagedEntries) {
      throw new Error(`ACS SNAT managed entry quota exceeded: ${managedCount}/${this.config.snat.maxManagedEntries}`);
    }
    const name = this.entryNameForSandboxName(ref.name);
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
      `agent-saas-acs-${ref.name}`.slice(0, 64),
    ]);
    if (result.exitCode !== 0) throw new Error(`CreateSnatEntry 失败: ${result.stderr || result.stdout}`);
    this.logger.warn(`snat_created sandbox=${ref.name} sourceCidr=${sourceCidr} snatIp=${this.config.snat.snatIp}`);
    if (this.config.snat.stabilizeAfterCreateMs > 0) {
      this.logger.info(`snat_stabilizing sandbox=${ref.name} ms=${this.config.snat.stabilizeAfterCreateMs}`);
      await sleep(this.config.snat.stabilizeAfterCreateMs);
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
    const result = await this.kubectl.run(['get', 'pod', '-l', selector, '-o', 'json'], {
      timeoutMs: this.config.sandboxWaitTimeoutMs,
    });
    if (result.exitCode !== 0) throw new Error(`list Sandbox Pod 失败: ${result.stderr || result.stdout}`);
    const body = JSON.parse(result.stdout || '{}') as { items?: Array<Record<string, unknown>> };
    return (body.items ?? []).map((item) => {
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

  private entryNameForSandboxName(sandboxName: string): string {
    const prefix = safeSnatNamePrefix(this.config.snat.entryNamePrefix);
    return `${prefix}-${sandboxName}`.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 128);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function labelValue(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 40);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

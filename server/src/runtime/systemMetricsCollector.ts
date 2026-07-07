import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { readdir, stat, statfs } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import tls from 'node:tls';

import type { TenantStore } from '../data/tenants/store.js';
import type { UserStore } from '../data/users/store.js';
import type { PgSystemMetricsStore, UpsertWorkspaceUsageInput, WorkspaceUsageStatus } from './systemMetricsStore.js';

export interface SystemMetricsCollectorOptions {
  store: PgSystemMetricsStore;
  agentCwd: string;
  processCwd: string;
  tablePrefix?: string;
  tenantStore?: TenantStore;
  userStore?: UserStore;
  enabled?: boolean;
  fastIntervalMs?: number;
  workspaceScanIntervalMs?: number;
  duConcurrency?: number;
  tlsCheckHosts?: string[];
  duExecutor?: (path: string, timeoutMs: number) => Promise<{ bytes: number; fileCount?: number | null }>;
  tlsChecker?: (host: string) => Promise<number>;
  logger?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
}

export interface WorkspaceScanResult {
  dirs: number;
  orphans: number;
  totalBytes: number;
  durationMs: number;
}

export class WorkspaceScanAlreadyRunningError extends Error {
  constructor() {
    super('Workspace scan is already running');
    this.name = 'WorkspaceScanAlreadyRunningError';
  }
}

export class SystemMetricsCollector {
  private fastTimer: ReturnType<typeof setInterval> | undefined;
  private workspaceTimer: ReturnType<typeof setInterval> | undefined;
  private fastInFlight = false;
  private workspaceInFlight = false;
  private readonly fastIntervalMs: number;
  private readonly workspaceScanIntervalMs: number;
  private readonly duConcurrency: number;
  private readonly tlsCheckHosts: string[];
  private readonly duExecutor: (path: string, timeoutMs: number) => Promise<{ bytes: number; fileCount?: number | null }>;
  private readonly tlsChecker: (host: string) => Promise<number>;

  constructor(private readonly options: SystemMetricsCollectorOptions) {
    this.fastIntervalMs = options.fastIntervalMs ?? 600_000;
    this.workspaceScanIntervalMs = options.workspaceScanIntervalMs ?? 21_600_000;
    this.duConcurrency = Math.max(1, Math.min(8, options.duConcurrency ?? 2));
    this.tlsCheckHosts = options.tlsCheckHosts?.length ? options.tlsCheckHosts : ['agent.kaiyan.net'];
    this.duExecutor = options.duExecutor ?? runDu;
    this.tlsChecker = options.tlsChecker ?? getTlsCertSecondsLeft;
  }

  start(): void {
    if (this.options.enabled === false || this.fastTimer || this.workspaceTimer) return;
    // FIX-3: 定时回调必须整体 catch，否则 PG 抖动等异常会变成 unhandled rejection 打崩进程。
    this.fastTimer = setInterval(() => {
      void this.collectFastOnce().catch((err) => {
        this.options.logger?.warn(`SystemMetricsCollector fast pass failed: ${errorMessage(err)}`);
      });
    }, this.fastIntervalMs);
    this.fastTimer.unref?.();
    this.workspaceTimer = setInterval(() => {
      void this.scanWorkspacesOnce().catch((err) => {
        this.options.logger?.warn(`SystemMetricsCollector workspace scan failed: ${errorMessage(err)}`);
      });
    }, this.workspaceScanIntervalMs);
    this.workspaceTimer.unref?.();
    this.options.logger?.info(
      `SystemMetricsCollector started: fastIntervalMs=${this.fastIntervalMs} workspaceScanIntervalMs=${this.workspaceScanIntervalMs}`,
    );
    void this.collectFastOnce().catch((err) => {
      this.options.logger?.warn(`SystemMetricsCollector startup fast pass failed: ${errorMessage(err)}`);
    });
    void this.scanWorkspacesOnce().catch((err) => {
      this.options.logger?.warn(`SystemMetricsCollector startup workspace scan failed: ${errorMessage(err)}`);
    });
  }

  stop(): void {
    if (this.fastTimer) {
      clearInterval(this.fastTimer);
      this.fastTimer = undefined;
    }
    if (this.workspaceTimer) {
      clearInterval(this.workspaceTimer);
      this.workspaceTimer = undefined;
    }
  }

  async collectFastOnce(): Promise<void> {
    if (this.fastInFlight) return;
    this.fastInFlight = true;
    const sampledAt = new Date();
    try {
      await Promise.all([
        this.collectDisk('/', 'disk_root', sampledAt),
        existsSync(this.options.agentCwd) ? this.collectDisk(this.options.agentCwd, 'disk_nas', sampledAt) : Promise.resolve(),
        this.collectPgTableSizes(sampledAt),
        this.collectPathSize(join(this.options.processCwd, 'data'), 'server_data_size', '', sampledAt),
        this.collectFileSize(join(this.options.processCwd, 'data', 'business.sqlite'), sampledAt),
        this.collectTls(sampledAt),
      ]);
      await this.options.store.pruneSystemMetrics(90).catch((err) => {
        this.options.logger?.warn(`SystemMetricsCollector prune failed: ${errorMessage(err)}`);
        return 0;
      });
    } finally {
      this.fastInFlight = false;
    }
  }

  async scanWorkspacesOnce(): Promise<WorkspaceScanResult> {
    if (this.workspaceInFlight) throw new WorkspaceScanAlreadyRunningError();
    this.workspaceInFlight = true;
    const startedAt = Date.now();
    const scannedAt = new Date();
    try {
      // FIX-1: 顶层 readdir 失败必须中止本轮扫描（不写库），防止 NAS 瞬断把
      // workspace_usage 整表清空；二级目录失败只跳过该租户并把本轮标记为 partial。
      let listing: WorkspaceDirListing;
      try {
        listing = await listWorkspaceDirs(this.options.agentCwd, (tenantName, err) => {
          this.options.logger?.warn(
            `Workspace scan tenant readdir failed tenant=${tenantName}: ${errorMessage(err)}; marking round partial`,
          );
        });
      } catch (err) {
        this.options.logger?.warn(`Workspace scan aborted: agentCwd readdir failed: ${errorMessage(err)}`);
        throw err;
      }
      const { entries, partial } = listing;
      if (entries.length === 0) {
        // FIX-1: 0 目录 + 库内已有行 → 同样中止（0 目录 + 库空是合法初始态，放行）。
        const existingRows = await this.options.store.countWorkspaceUsage();
        if (existingRows > 0) {
          const message = `Workspace scan aborted: readdir returned 0 directories while ${existingRows} usage rows exist (possible NAS outage)`;
          this.options.logger?.warn(message);
          throw new Error(message);
        }
      }
      const tenants = new Set((this.options.tenantStore?.listAll() ?? []).map((tenant) => tenant.id));
      const users = new Set((this.options.userStore?.listAll() ?? []).map((user) => `${user.tenantId}:${user.id}`));
      const classified = entries.map((entry) => {
        const classification = classifyWorkspacePath(entry.relativePath, tenants, users);
        return { ...entry, ...classification };
      });
      const sizes = await mapWithConcurrency(classified, this.duConcurrency, async (entry) => {
        try {
          return await this.duExecutor(entry.absolutePath, 120_000);
        } catch (err) {
          this.options.logger?.warn(`Workspace du failed path=${entry.relativePath}: ${errorMessage(err)}`);
          // FIX-4: du 失败/超时记 -1（与空目录的 0 区分），汇总时不计入求和。
          return { bytes: -1, fileCount: null };
        }
      });
      const records: UpsertWorkspaceUsageInput[] = classified.map((entry, index) => ({
        path: entry.relativePath,
        tenantId: entry.tenantId,
        userId: entry.userId,
        status: entry.status,
        bytes: sizes[index]?.bytes ?? -1,
        fileCount: sizes[index]?.fileCount ?? null,
        scannedAt,
      }));
      const durationMs = Date.now() - startedAt;
      // FIX-1: partial 轮只 upsert 不删除「本轮未见 path」。
      await this.options.store.upsertWorkspaceUsage(
        records,
        scannedAt,
        partial ? { durationMs, partial: true } : { durationMs },
        { partial },
      );
      const result = {
        dirs: records.length,
        orphans: records.filter((record) => record.status !== 'active').length,
        totalBytes: records.reduce((sum, record) => sum + Math.max(0, record.bytes), 0),
        durationMs,
      };
      this.options.logger?.info(
        `Workspace scan completed: dirs=${result.dirs} orphans=${result.orphans} bytes=${result.totalBytes} durationMs=${result.durationMs}${partial ? ' partial=true' : ''}`,
      );
      return result;
    } finally {
      this.workspaceInFlight = false;
    }
  }

  private async collectDisk(path: string, metric: 'disk_root' | 'disk_nas', sampledAt: Date): Promise<void> {
    try {
      const s = await statfs(path);
      const totalBytes = Number(s.blocks) * Number(s.bsize);
      const freeBytes = Number(s.bfree) * Number(s.bsize);
      const usedBytes = Math.max(0, totalBytes - freeBytes);
      const usedPct = totalBytes > 0 ? usedBytes / totalBytes : 0;
      await this.options.store.insertMetric({
        metric,
        valueNum: metric === 'disk_root' ? usedPct * 100 : usedBytes,
        detailJson: { totalBytes, freeBytes, usedBytes, usedPct },
        sampledAt,
      });
    } catch (err) {
      this.options.logger?.warn(`SystemMetricsCollector statfs failed path=${path}: ${errorMessage(err)}`);
    }
  }

  private async collectPgTableSizes(sampledAt: Date): Promise<void> {
    try {
      const tables = await this.options.store.queryPgRuntimeTableSizes(this.options.tablePrefix ?? 'runtime');
      await Promise.all(tables.map((table) => this.options.store.insertMetric({
        metric: 'pg_table_size',
        label: table.table,
        valueNum: table.bytes,
        detailJson: { table: table.table },
        sampledAt,
      })));
    } catch (err) {
      this.options.logger?.warn(`SystemMetricsCollector pg table size failed: ${errorMessage(err)}`);
    }
  }

  private async collectPathSize(path: string, metric: 'server_data_size', label: string, sampledAt: Date): Promise<void> {
    if (!existsSync(path)) return;
    try {
      const size = await this.duExecutor(path, 120_000);
      await this.options.store.insertMetric({
        metric,
        label,
        valueNum: size.bytes,
        detailJson: { path: safePathLabel(path) },
        sampledAt,
      });
    } catch (err) {
      this.options.logger?.warn(`SystemMetricsCollector du failed path=${safePathLabel(path)}: ${errorMessage(err)}`);
    }
  }

  private async collectFileSize(path: string, sampledAt: Date): Promise<void> {
    try {
      const s = await stat(path);
      await this.options.store.insertMetric({
        metric: 'sqlite_size',
        label: basename(path),
        valueNum: s.size,
        detailJson: { path: safePathLabel(path) },
        sampledAt,
      });
    } catch {
      // business.sqlite is optional in PG-focused production deploys.
    }
  }

  private async collectTls(sampledAt: Date): Promise<void> {
    await Promise.all(this.tlsCheckHosts.map(async (host) => {
      try {
        const secondsLeft = await this.tlsChecker(host);
        await this.options.store.insertMetric({
          metric: 'tls_cert_expiry',
          label: host,
          valueNum: secondsLeft,
          detailJson: { host },
          sampledAt,
        });
      } catch (err) {
        this.options.logger?.warn(`SystemMetricsCollector TLS check failed host=${host}: ${errorMessage(err)}`);
      }
    }));
  }
}

export interface ClassifiedWorkspacePath {
  tenantId: string;
  userId: string | null;
  status: WorkspaceUsageStatus;
}

export function classifyWorkspacePath(
  relativePath: string,
  activeTenantIds: ReadonlySet<string>,
  activeUserKeys: ReadonlySet<string>,
): ClassifiedWorkspacePath {
  const [tenantId = '', rawUserSegment = ''] = relativePath.split('/');
  const parsed = parseSoftDeletedSegment(rawUserSegment);
  const userId = parsed.userId || rawUserSegment || null;
  if (!activeTenantIds.has(tenantId)) {
    return { tenantId, userId, status: 'orphan_tenant' };
  }
  if (parsed.softDeleted) {
    return { tenantId, userId, status: 'soft_deleted' };
  }
  if (!userId || !activeUserKeys.has(`${tenantId}:${userId}`)) {
    return { tenantId, userId, status: 'orphan_user' };
  }
  return { tenantId, userId, status: 'active' };
}

export function parseSoftDeletedSegment(segment: string): { userId: string; softDeleted: boolean } {
  const match = /^(.+)-deleted-\d+$/.exec(segment);
  if (!match) return { userId: segment, softDeleted: false };
  return { userId: match[1]!, softDeleted: true };
}

interface WorkspaceDirListing {
  entries: Array<{ relativePath: string; absolutePath: string }>;
  partial: boolean;
}

async function listWorkspaceDirs(
  agentCwd: string,
  onTenantReaddirError?: (tenantName: string, err: unknown) => void,
): Promise<WorkspaceDirListing> {
  const root = resolve(agentCwd);
  // FIX-1: 顶层 readdir 失败直接抛出，由调用方中止本轮（不再吞错返回空清单）。
  const tenants = await readdir(root, { withFileTypes: true });
  const out: Array<{ relativePath: string; absolutePath: string }> = [];
  let partial = false;
  for (const tenant of tenants) {
    if (!tenant.isDirectory()) continue;
    const tenantPath = join(root, tenant.name);
    let users: Dirent[];
    try {
      users = await readdir(tenantPath, { withFileTypes: true });
    } catch (err) {
      // FIX-1: 二级目录读取失败 → 跳过该租户并标记本轮 partial。
      partial = true;
      onTenantReaddirError?.(tenant.name, err);
      continue;
    }
    for (const user of users) {
      if (!user.isDirectory()) continue;
      const absolutePath = join(tenantPath, user.name);
      out.push({ absolutePath, relativePath: relative(root, absolutePath) });
    }
  }
  return { entries: out, partial };
}

export class CommandTimeoutError extends Error {
  constructor(command: string, timeoutMs: number) {
    super(`${command} timed out after ${timeoutMs}ms`);
    this.name = 'CommandTimeoutError';
  }
}

export async function runDu(
  path: string,
  timeoutMs: number,
  exec: (command: string, args: string[], timeoutMs: number) => Promise<string> = runCommand,
): Promise<{ bytes: number; fileCount: number | null }> {
  let stdout: string;
  let multiplier = 1;
  try {
    stdout = await exec('du', ['-sb', path], timeoutMs);
  } catch (err) {
    // FIX-4: 仅 `du -sb` 立即报错（如 BSD du 不支持 -b）才 fallback 到 -sk；
    // 超时说明目录过大/存储无响应，重跑 -sk 只会再吃满一轮 timeout。
    if (err instanceof CommandTimeoutError) throw err;
    stdout = await exec('du', ['-sk', path], timeoutMs);
    multiplier = 1024;
  }
  const bytes = Number(stdout.trim().split(/\s+/)[0] ?? 0);
  if (!Number.isFinite(bytes)) throw new Error(`invalid du output: ${stdout.slice(0, 120)}`);
  return { bytes: bytes * multiplier, fileCount: null };
}

async function runCommand(command: string, args: string[], timeoutMs: number): Promise<string> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new CommandTimeoutError(command, timeoutMs));
    }, timeoutMs);
    timer.unref?.();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise(stdout);
      else reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });
  });
}

async function getTlsCertSecondsLeft(host: string): Promise<number> {
  return await new Promise((resolvePromise, reject) => {
    const socket = tls.connect({ host, port: 443, servername: host, timeout: 10_000 }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      const validTo = cert.valid_to ? Date.parse(cert.valid_to) : NaN;
      if (!Number.isFinite(validTo)) {
        reject(new Error(`invalid TLS certificate valid_to for ${host}`));
        return;
      }
      resolvePromise(Math.floor((validTo - Date.now()) / 1000));
    });
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error(`TLS check timed out for ${host}`));
    });
    socket.on('error', reject);
  });
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await mapper(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return out;
}

function safePathLabel(path: string): string {
  return createHash('sha256').update(path).digest('hex').slice(0, 12);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

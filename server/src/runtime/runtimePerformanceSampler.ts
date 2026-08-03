import { readFile } from 'node:fs/promises';
import { loadavg } from 'node:os';
import { resolve } from 'node:path';
import {
  monitorEventLoopDelay,
  performance,
  PerformanceObserver,
  type IntervalHistogram,
} from 'node:perf_hooks';

import type { RuntimeAdmissionSnapshot } from './memoryPressureGuard.js';
import type { ActiveRunCounts } from './runStore.js';
import type { RuntimeSchedulerPerformanceSnapshot } from './scheduler.js';

const DEFAULT_INTERVAL_MS = 30_000;
const MIN_INTERVAL_MS = 1_000;

export interface RuntimePerformanceWorkloadSnapshot {
  scheduler: RuntimeSchedulerPerformanceSnapshot;
  activeRuns?: ActiveRunCounts;
  admission?: RuntimeAdmissionSnapshot;
}

interface RuntimePerformanceSamplerOptions {
  getWorkloadSnapshot: () => Promise<RuntimePerformanceWorkloadSnapshot>;
  logger: {
    info(message: string): void;
    warn(message: string): void;
  };
  intervalMs?: number;
  eventLoopDelayMonitor?: IntervalHistogram;
  now?: () => number;
}

interface LinuxPerformanceSnapshot {
  host?: {
    totalBytes?: number;
    availableBytes?: number;
    loadAverage1m: number;
    loadAverage5m: number;
    loadAverage15m: number;
    memoryPsi?: PressureSnapshot;
    cpuPsi?: PressureSnapshot;
    ioPsi?: PressureSnapshot;
  };
  cgroup?: {
    path: string;
    memoryCurrentBytes?: number;
    memoryHighBytes?: number;
    memoryMaxBytes?: number;
    memory: Record<string, number>;
    memoryEvents: Record<string, number>;
    cpu: Record<string, number>;
    cpuMax?: string;
    io: CgroupIoSnapshot;
  };
}

interface CgroupIoSnapshot {
  readBytes: number;
  writeBytes: number;
  readOperations: number;
  writeOperations: number;
}

interface PressureSnapshot {
  someAvg10?: number;
  someAvg60?: number;
  someAvg300?: number;
  someTotalMicros?: number;
  fullAvg10?: number;
  fullAvg60?: number;
  fullAvg300?: number;
  fullTotalMicros?: number;
}

interface GcIntervalSnapshot {
  count: number;
  durationMs: number;
  maxDurationMs: number;
  byKind: Record<string, number>;
}

export interface RuntimePerformanceSample {
  schemaVersion: 1;
  sampledAt: string;
  intervalMs: number;
  process: {
    pid: number;
    uptimeSeconds: number;
    cpuPercent: number;
    cpuUserMicros: number;
    cpuSystemMicros: number;
    rssBytes: number;
    heapTotalBytes: number;
    heapUsedBytes: number;
    externalBytes: number;
    arrayBuffersBytes: number;
    eventLoopUtilization: number;
    eventLoopDelayMeanMs: number;
    eventLoopDelayP50Ms: number;
    eventLoopDelayP95Ms: number;
    eventLoopDelayP99Ms: number;
    eventLoopDelayMaxMs: number;
    gc: GcIntervalSnapshot;
    activeResources: Record<string, number>;
    resourceUsage: {
      userCpuMicros: number;
      systemCpuMicros: number;
      maxRssKiB: number;
      fsRead: number;
      fsWrite: number;
      voluntaryContextSwitches: number;
      involuntaryContextSwitches: number;
    };
  };
  host?: LinuxPerformanceSnapshot['host'];
  cgroup?: LinuxPerformanceSnapshot['cgroup'] & {
    cpuPercent?: number;
  };
  workload?: RuntimePerformanceWorkloadSnapshot;
  workloadError?: string;
}

export class RuntimePerformanceSampler {
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly eventLoopDelayMonitor: IntervalHistogram;
  private readonly ownsEventLoopDelayMonitor: boolean;
  private readonly gcObserver: PerformanceObserver;
  private timer?: NodeJS.Timeout;
  private sampling = false;
  private previousSampleAtMs: number;
  private previousCpuUsage: NodeJS.CpuUsage;
  private previousCgroupCpuUsageMicros?: number;
  private previousElu = performance.eventLoopUtilization();
  private gcInterval: GcIntervalSnapshot = emptyGcSnapshot();
  private warnedSampleFailure = false;

  constructor(private readonly options: RuntimePerformanceSamplerOptions) {
    this.intervalMs = normalizeIntervalMs(options.intervalMs ?? DEFAULT_INTERVAL_MS);
    this.now = options.now ?? Date.now;
    this.previousSampleAtMs = this.now();
    this.previousCpuUsage = process.cpuUsage();
    this.eventLoopDelayMonitor = options.eventLoopDelayMonitor
      ?? monitorEventLoopDelay({ resolution: 20 });
    this.ownsEventLoopDelayMonitor = !options.eventLoopDelayMonitor;
    this.gcObserver = new PerformanceObserver((entries) => {
      for (const entry of entries.getEntries()) {
        const detail = (entry as PerformanceEntry & { detail?: { kind?: number } }).detail;
        const kind = String(detail?.kind ?? 'unknown');
        this.gcInterval.count += 1;
        this.gcInterval.durationMs += entry.duration;
        this.gcInterval.maxDurationMs = Math.max(this.gcInterval.maxDurationMs, entry.duration);
        this.gcInterval.byKind[kind] = (this.gcInterval.byKind[kind] ?? 0) + 1;
      }
    });
  }

  start(): void {
    if (this.timer) return;
    if (this.ownsEventLoopDelayMonitor) this.eventLoopDelayMonitor.enable();
    this.gcObserver.observe({ entryTypes: ['gc'] });
    this.timer = setInterval(() => void this.sampleOnce(), this.intervalMs);
    this.timer.unref();
    this.options.logger.info(`Runtime performance sampler enabled: interval=${this.intervalMs}ms`);
    void this.sampleOnce();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.gcObserver.disconnect();
    if (this.ownsEventLoopDelayMonitor) this.eventLoopDelayMonitor.disable();
  }

  async sampleOnce(): Promise<RuntimePerformanceSample | undefined> {
    if (this.sampling) return undefined;
    this.sampling = true;
    try {
      const sampledAtMs = this.now();
      const intervalMs = Math.max(1, sampledAtMs - this.previousSampleAtMs);
      const [linuxResult, workloadResult] = await Promise.allSettled([
        readLinuxPerformanceSnapshot(),
        this.options.getWorkloadSnapshot(),
      ]);
      const linux = linuxResult.status === 'fulfilled' ? linuxResult.value : {};
      const currentCpuUsage = process.cpuUsage();
      const cpuUserMicros = currentCpuUsage.user - this.previousCpuUsage.user;
      const cpuSystemMicros = currentCpuUsage.system - this.previousCpuUsage.system;
      const currentElu = performance.eventLoopUtilization();
      const elu = performance.eventLoopUtilization(currentElu, this.previousElu);
      const memory = process.memoryUsage();
      const resources = countValues(process.getActiveResourcesInfo());
      const resourceUsage = process.resourceUsage();
      const cgroupCpuUsageMicros = linux.cgroup?.cpu.usage_usec;
      const cgroupCpuPercent = cgroupCpuUsageMicros !== undefined
        && this.previousCgroupCpuUsageMicros !== undefined
        ? percent(cgroupCpuUsageMicros - this.previousCgroupCpuUsageMicros, intervalMs * 1_000)
        : undefined;
      const workloadError = workloadResult.status === 'rejected'
        ? formatError(workloadResult.reason)
        : undefined;
      const sample: RuntimePerformanceSample = {
        schemaVersion: 1,
        sampledAt: new Date(sampledAtMs).toISOString(),
        intervalMs,
        process: {
          pid: process.pid,
          uptimeSeconds: round(process.uptime(), 3),
          cpuPercent: percent(cpuUserMicros + cpuSystemMicros, intervalMs * 1_000),
          cpuUserMicros,
          cpuSystemMicros,
          rssBytes: memory.rss,
          heapTotalBytes: memory.heapTotal,
          heapUsedBytes: memory.heapUsed,
          externalBytes: memory.external,
          arrayBuffersBytes: memory.arrayBuffers,
          eventLoopUtilization: round(elu.utilization, 6),
          eventLoopDelayMeanMs: nanosecondsToMilliseconds(this.eventLoopDelayMonitor.mean),
          eventLoopDelayP50Ms: nanosecondsToMilliseconds(this.eventLoopDelayMonitor.percentile(50)),
          eventLoopDelayP95Ms: nanosecondsToMilliseconds(this.eventLoopDelayMonitor.percentile(95)),
          eventLoopDelayP99Ms: nanosecondsToMilliseconds(this.eventLoopDelayMonitor.percentile(99)),
          eventLoopDelayMaxMs: nanosecondsToMilliseconds(this.eventLoopDelayMonitor.max),
          gc: takeGcSnapshot(this.gcInterval),
          activeResources: resources,
          resourceUsage: {
            userCpuMicros: resourceUsage.userCPUTime,
            systemCpuMicros: resourceUsage.systemCPUTime,
            maxRssKiB: resourceUsage.maxRSS,
            fsRead: resourceUsage.fsRead,
            fsWrite: resourceUsage.fsWrite,
            voluntaryContextSwitches: resourceUsage.voluntaryContextSwitches,
            involuntaryContextSwitches: resourceUsage.involuntaryContextSwitches,
          },
        },
        ...(linux.host ? { host: linux.host } : {}),
        ...(linux.cgroup
          ? { cgroup: { ...linux.cgroup, ...(cgroupCpuPercent !== undefined ? { cpuPercent: cgroupCpuPercent } : {}) } }
          : {}),
        ...(workloadResult.status === 'fulfilled' ? { workload: workloadResult.value } : {}),
        ...(workloadError ? { workloadError } : {}),
      };

      this.previousSampleAtMs = sampledAtMs;
      this.previousCpuUsage = currentCpuUsage;
      this.previousCgroupCpuUsageMicros = cgroupCpuUsageMicros;
      this.previousElu = currentElu;
      this.gcInterval = emptyGcSnapshot();
      this.eventLoopDelayMonitor.reset();
      this.warnedSampleFailure = false;
      this.options.logger.info(`[RuntimePerf] ${JSON.stringify(sample)}`);
      return sample;
    } catch (error) {
      if (!this.warnedSampleFailure) {
        this.warnedSampleFailure = true;
        this.options.logger.warn(`Runtime performance sample failed: ${formatError(error)}`);
      }
      return undefined;
    } finally {
      this.sampling = false;
    }
  }
}

export function runtimePerformanceSamplerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.AGENT_SAAS_RUNTIME_PERF_ENABLED?.trim().toLowerCase();
  return raw !== 'false' && raw !== '0' && raw !== 'off';
}

export function runtimePerformanceSamplerIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.AGENT_SAAS_RUNTIME_PERF_INTERVAL_MS);
  return normalizeIntervalMs(Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_INTERVAL_MS);
}

export function parseKeyValueNumbers(raw: string): Record<string, number> {
  const parsed: Record<string, number> = {};
  for (const line of raw.split('\n')) {
    const [key, value] = line.trim().split(/\s+/, 2);
    if (!key || !value) continue;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) parsed[key] = numeric;
  }
  return parsed;
}

export function parsePressure(raw: string): PressureSnapshot {
  const snapshot: PressureSnapshot = {};
  for (const line of raw.split('\n')) {
    const [kind, ...fields] = line.trim().split(/\s+/);
    if (kind !== 'some' && kind !== 'full') continue;
    const values = Object.fromEntries(fields.map((field) => {
      const [key, value] = field.split('=', 2);
      return [key, Number(value)];
    }));
    const prefix = kind === 'some' ? 'some' : 'full';
    if (Number.isFinite(values.avg10)) snapshot[`${prefix}Avg10`] = values.avg10;
    if (Number.isFinite(values.avg60)) snapshot[`${prefix}Avg60`] = values.avg60;
    if (Number.isFinite(values.avg300)) snapshot[`${prefix}Avg300`] = values.avg300;
    if (Number.isFinite(values.total)) snapshot[`${prefix}TotalMicros`] = values.total;
  }
  return snapshot;
}

export function parseCgroupIo(raw: string): CgroupIoSnapshot {
  const total = { readBytes: 0, writeBytes: 0, readOperations: 0, writeOperations: 0 };
  for (const line of raw.split('\n')) {
    const fields = line.trim().split(/\s+/).slice(1);
    for (const field of fields) {
      const [key, rawValue] = field.split('=', 2);
      const value = Number(rawValue);
      if (!Number.isFinite(value)) continue;
      if (key === 'rbytes') total.readBytes += value;
      if (key === 'wbytes') total.writeBytes += value;
      if (key === 'rios') total.readOperations += value;
      if (key === 'wios') total.writeOperations += value;
    }
  }
  return total;
}

async function readLinuxPerformanceSnapshot(): Promise<LinuxPerformanceSnapshot> {
  if (process.platform !== 'linux') return {};
  const [meminfo, memoryPsi, cpuPsi, ioPsi, cgroupPath] = await Promise.all([
    readFile('/proc/meminfo', 'utf8').catch(() => ''),
    readFile('/proc/pressure/memory', 'utf8').catch(() => ''),
    readFile('/proc/pressure/cpu', 'utf8').catch(() => ''),
    readFile('/proc/pressure/io', 'utf8').catch(() => ''),
    resolveCurrentCgroupPath().catch(() => undefined),
  ]);
  const loads = loadavg();
  const host: NonNullable<LinuxPerformanceSnapshot['host']> = {
    totalBytes: parseMeminfoBytes(meminfo, 'MemTotal'),
    availableBytes: parseMeminfoBytes(meminfo, 'MemAvailable'),
    loadAverage1m: round(loads[0] ?? 0, 3),
    loadAverage5m: round(loads[1] ?? 0, 3),
    loadAverage15m: round(loads[2] ?? 0, 3),
    ...(memoryPsi ? { memoryPsi: parsePressure(memoryPsi) } : {}),
    ...(cpuPsi ? { cpuPsi: parsePressure(cpuPsi) } : {}),
    ...(ioPsi ? { ioPsi: parsePressure(ioPsi) } : {}),
  };
  if (!cgroupPath) return { host };

  const root = resolve('/sys/fs/cgroup', `.${cgroupPath}`);
  const [memoryCurrent, memoryHigh, memoryMax, memoryStat, memoryEvents, cpuStat, cpuMax, ioStat] = await Promise.all([
    readFile(`${root}/memory.current`, 'utf8').catch(() => ''),
    readFile(`${root}/memory.high`, 'utf8').catch(() => ''),
    readFile(`${root}/memory.max`, 'utf8').catch(() => ''),
    readFile(`${root}/memory.stat`, 'utf8').catch(() => ''),
    readFile(`${root}/memory.events`, 'utf8').catch(() => ''),
    readFile(`${root}/cpu.stat`, 'utf8').catch(() => ''),
    readFile(`${root}/cpu.max`, 'utf8').catch(() => ''),
    readFile(`${root}/io.stat`, 'utf8').catch(() => ''),
  ]);
  return {
    host,
    cgroup: {
      path: cgroupPath,
      memoryCurrentBytes: parseNumberOrMax(memoryCurrent),
      memoryHighBytes: parseNumberOrMax(memoryHigh),
      memoryMaxBytes: parseNumberOrMax(memoryMax),
      memory: selectKeys(parseKeyValueNumbers(memoryStat), [
        'anon',
        'file',
        'kernel',
        'kernel_stack',
        'pagetables',
        'percpu',
        'sock',
        'shmem',
        'file_mapped',
        'file_dirty',
        'file_writeback',
        'inactive_anon',
        'active_anon',
        'inactive_file',
        'active_file',
        'slab_reclaimable',
        'slab_unreclaimable',
        'workingset_refault_file',
        'pgscan',
        'pgsteal',
      ]),
      memoryEvents: parseKeyValueNumbers(memoryEvents),
      cpu: parseKeyValueNumbers(cpuStat),
      ...(cpuMax.trim() ? { cpuMax: cpuMax.trim() } : {}),
      io: parseCgroupIo(ioStat),
    },
  };
}

async function resolveCurrentCgroupPath(): Promise<string | undefined> {
  const raw = await readFile('/proc/self/cgroup', 'utf8');
  const unified = raw.split('\n').find((line) => line.startsWith('0::'));
  const path = unified?.slice(3).trim();
  if (!path || !path.startsWith('/')) return undefined;
  return path;
}

function parseMeminfoBytes(raw: string, key: string): number | undefined {
  const match = raw.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB$`, 'm'));
  return match ? Number(match[1]) * 1024 : undefined;
}

function parseNumberOrMax(raw: string): number | undefined {
  const normalized = raw.trim();
  if (!normalized || normalized === 'max') return undefined;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : undefined;
}

function selectKeys(source: Record<string, number>, keys: string[]): Record<string, number> {
  return Object.fromEntries(keys.flatMap((key) => source[key] === undefined ? [] : [[key, source[key]]]));
}

function normalizeIntervalMs(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_INTERVAL_MS;
  return Math.max(MIN_INTERVAL_MS, Math.floor(value));
}

function countValues(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function emptyGcSnapshot(): GcIntervalSnapshot {
  return { count: 0, durationMs: 0, maxDurationMs: 0, byKind: {} };
}

function takeGcSnapshot(snapshot: GcIntervalSnapshot): GcIntervalSnapshot {
  return {
    count: snapshot.count,
    durationMs: round(snapshot.durationMs, 3),
    maxDurationMs: round(snapshot.maxDurationMs, 3),
    byKind: { ...snapshot.byKind },
  };
}

function nanosecondsToMilliseconds(value: number): number {
  return Number.isFinite(value) ? round(value / 1e6, 3) : 0;
}

function percent(numerator: number, denominator: number): number {
  return denominator > 0 ? round((numerator / denominator) * 100, 3) : 0;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

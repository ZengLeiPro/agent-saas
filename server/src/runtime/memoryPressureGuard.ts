import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const GIB = 1024 ** 3;

export interface MemoryPressureSample {
  totalBytes: number;
  availableBytes: number;
  psiSomeAvg10?: number;
  psiFullAvg10?: number;
  cgroupCurrentBytes?: number;
  cgroupHighBytes?: number;
  cgroupMaxBytes?: number;
}

export interface RuntimeAdmissionSnapshot extends Partial<MemoryPressureSample> {
  state: 'unknown' | 'healthy' | 'paused';
  admitting: boolean;
  sampledAt?: string;
  stateSince?: string;
  reason?: string;
  enterAvailableBytes?: number;
  resumeAvailableBytes?: number;
}

export interface RuntimeAdmissionGuard {
  start(): Promise<void>;
  stop(): void;
  canAcquire(): boolean;
  getSnapshot(): RuntimeAdmissionSnapshot;
}

export interface MemoryPressureGuardOptions {
  sampleIntervalMs?: number;
  enterSustainMs?: number;
  resumeSustainMs?: number;
  sample?: () => Promise<MemoryPressureSample | null>;
  now?: () => number;
  logger?: {
    info(message: string): void;
    warn(message: string): void;
  };
}

/**
 * 只控制“是否领取新 run”，绝不取消或降级正在执行的 run。
 * 阈值按宿主可用内存、Linux memory PSI 与当前 Worker cgroup 三者取最先触发者；
 * 进入/恢复使用不同阈值与持续时间，防止在临界点抖动。
 */
export class MemoryPressureGuard implements RuntimeAdmissionGuard {
  private readonly sampleIntervalMs: number;
  private readonly enterSustainMs: number;
  private readonly resumeSustainMs: number;
  private readonly sample: () => Promise<MemoryPressureSample | null>;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | undefined;
  private sampling = false;
  private pressureSinceMs: number | undefined;
  private recoverySinceMs: number | undefined;
  private snapshot: RuntimeAdmissionSnapshot = { state: 'unknown', admitting: true };

  constructor(private readonly options: MemoryPressureGuardOptions = {}) {
    this.sampleIntervalMs = Math.max(250, options.sampleIntervalMs ?? 1_000);
    this.enterSustainMs = Math.max(0, options.enterSustainMs ?? 3_000);
    this.resumeSustainMs = Math.max(0, options.resumeSustainMs ?? 30_000);
    this.sample = options.sample ?? readLinuxMemoryPressureSample;
    this.now = options.now ?? Date.now;
  }

  async start(): Promise<void> {
    if (this.timer) return;
    const initial = await this.sampleOnce();
    this.options.logger?.info(
      `Runtime memory admission guard started: state=${initial.state}`
      + `${initial.availableBytes !== undefined ? ` available=${formatMib(initial.availableBytes)}MiB` : ''}`
      + `${initial.enterAvailableBytes !== undefined ? ` pauseBelow=${formatMib(initial.enterAvailableBytes)}MiB` : ''}`
      + `${initial.resumeAvailableBytes !== undefined ? ` resumeAbove=${formatMib(initial.resumeAvailableBytes)}MiB` : ''}`,
    );
    this.timer = setInterval(() => {
      void this.sampleOnce();
    }, this.sampleIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  canAcquire(): boolean {
    return this.snapshot.state !== 'paused';
  }

  getSnapshot(): RuntimeAdmissionSnapshot {
    return { ...this.snapshot };
  }

  async sampleOnce(): Promise<RuntimeAdmissionSnapshot> {
    if (this.sampling) return this.getSnapshot();
    this.sampling = true;
    try {
      const sample = await this.sample();
      if (!sample || sample.totalBytes <= 0 || sample.availableBytes < 0) {
        return this.handleUnavailable('memory pressure metrics unavailable');
      }
      return this.applySample(sample);
    } catch (err) {
      return this.handleUnavailable(
        `memory pressure metrics unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.sampling = false;
    }
  }

  private applySample(sample: MemoryPressureSample): RuntimeAdmissionSnapshot {
    const now = this.now();
    const enterAvailableBytes = Math.max(1.5 * GIB, sample.totalBytes * 0.20);
    const resumeAvailableBytes = Math.max(2.5 * GIB, sample.totalBytes * 0.30);
    const pressureReason = detectPressureReason(sample, enterAvailableBytes);
    const recoverySafe = isRecoverySafe(sample, resumeAvailableBytes);

    if (this.snapshot.state === 'paused') {
      this.pressureSinceMs = undefined;
      if (recoverySafe) {
        this.recoverySinceMs ??= now;
        if (now - this.recoverySinceMs >= this.resumeSustainMs) {
          this.transition('healthy', now, sample);
        }
      } else {
        this.recoverySinceMs = undefined;
      }
    } else {
      this.recoverySinceMs = undefined;
      if (pressureReason) {
        this.pressureSinceMs ??= now;
        if (now - this.pressureSinceMs >= this.enterSustainMs) {
          this.transition('paused', now, sample, pressureReason);
        }
      } else {
        this.pressureSinceMs = undefined;
        if (this.snapshot.state === 'unknown') this.transition('healthy', now, sample);
      }
    }

    this.snapshot = {
      ...this.snapshot,
      ...sample,
      admitting: this.snapshot.state !== 'paused',
      sampledAt: new Date(now).toISOString(),
      enterAvailableBytes,
      resumeAvailableBytes,
      ...(this.snapshot.state === 'paused' && pressureReason ? { reason: pressureReason } : {}),
    };
    return this.getSnapshot();
  }

  private transition(
    state: 'healthy' | 'paused',
    now: number,
    sample: MemoryPressureSample,
    reason?: string,
  ): void {
    const previous = this.snapshot.state;
    this.snapshot = {
      ...this.snapshot,
      state,
      admitting: state !== 'paused',
      stateSince: new Date(now).toISOString(),
      ...(reason ? { reason } : { reason: undefined }),
    };
    if (state === 'paused') {
      this.options.logger?.warn(
        `Runtime admission paused by memory pressure: reason=${reason ?? 'unknown'} available=${formatMib(sample.availableBytes)}MiB`,
      );
    } else if (previous === 'paused') {
      this.options.logger?.info(
        `Runtime admission resumed after memory recovery: available=${formatMib(sample.availableBytes)}MiB`,
      );
    }
  }

  private handleUnavailable(reason: string): RuntimeAdmissionSnapshot {
    const wasUnavailable = this.snapshot.state === 'unknown' && this.snapshot.reason === reason;
    this.pressureSinceMs = undefined;
    this.recoverySinceMs = undefined;
    this.snapshot = {
      state: 'unknown',
      admitting: true,
      sampledAt: new Date(this.now()).toISOString(),
      reason,
    };
    if (!wasUnavailable) this.options.logger?.warn(`${reason}; fail-open keeps runtime admission enabled`);
    return this.getSnapshot();
  }
}

function detectPressureReason(sample: MemoryPressureSample, enterAvailableBytes: number): string | undefined {
  if (sample.availableBytes < enterAvailableBytes) return 'host_mem_available_low';
  if (
    sample.cgroupCurrentBytes !== undefined
    && sample.cgroupHighBytes !== undefined
    && sample.cgroupHighBytes > 0
    && sample.cgroupCurrentBytes >= sample.cgroupHighBytes * 0.90
  ) return 'worker_cgroup_near_high';
  if ((sample.psiFullAvg10 ?? 0) >= 2) return 'memory_psi_full';
  if ((sample.psiSomeAvg10 ?? 0) >= 10) return 'memory_psi_some';
  return undefined;
}

function isRecoverySafe(sample: MemoryPressureSample, resumeAvailableBytes: number): boolean {
  if (sample.availableBytes <= resumeAvailableBytes) return false;
  if ((sample.psiFullAvg10 ?? 0) >= 1) return false;
  if ((sample.psiSomeAvg10 ?? 0) >= 5) return false;
  if (
    sample.cgroupCurrentBytes !== undefined
    && sample.cgroupHighBytes !== undefined
    && sample.cgroupHighBytes > 0
    && sample.cgroupCurrentBytes > sample.cgroupHighBytes * 0.70
  ) return false;
  return true;
}

export async function readLinuxMemoryPressureSample(): Promise<MemoryPressureSample | null> {
  const meminfo = await readFile('/proc/meminfo', 'utf8');
  const totalBytes = parseMeminfoBytes(meminfo, 'MemTotal');
  const availableBytes = parseMeminfoBytes(meminfo, 'MemAvailable');
  if (totalBytes === undefined || availableBytes === undefined) return null;

  const [psi, cgroup] = await Promise.all([
    readFile('/proc/pressure/memory', 'utf8').then(parseMemoryPsi).catch(() => ({})),
    readCurrentCgroupMemory().catch(() => ({})),
  ]);
  return { totalBytes, availableBytes, ...psi, ...cgroup };
}

function parseMeminfoBytes(raw: string, key: string): number | undefined {
  const match = raw.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB$`, 'm'));
  return match ? Number(match[1]) * 1024 : undefined;
}

function parseMemoryPsi(raw: string): Pick<MemoryPressureSample, 'psiSomeAvg10' | 'psiFullAvg10'> {
  const some = raw.match(/^some\s+avg10=([\d.]+)/m);
  const full = raw.match(/^full\s+avg10=([\d.]+)/m);
  return {
    ...(some ? { psiSomeAvg10: Number(some[1]) } : {}),
    ...(full ? { psiFullAvg10: Number(full[1]) } : {}),
  };
}

async function readCurrentCgroupMemory(): Promise<Pick<
  MemoryPressureSample,
  'cgroupCurrentBytes' | 'cgroupHighBytes' | 'cgroupMaxBytes'
>> {
  const cgroup = await readFile('/proc/self/cgroup', 'utf8');
  const unified = cgroup.split('\n').find((line) => line.startsWith('0::'));
  if (!unified) return {};
  const relative = unified.slice(3).replace(/^\/+/, '');
  const root = join('/sys/fs/cgroup', relative);
  const [current, high, max] = await Promise.all([
    readCgroupLimit(join(root, 'memory.current')),
    readCgroupLimit(join(root, 'memory.high')),
    readCgroupLimit(join(root, 'memory.max')),
  ]);
  return {
    ...(current !== undefined ? { cgroupCurrentBytes: current } : {}),
    ...(high !== undefined ? { cgroupHighBytes: high } : {}),
    ...(max !== undefined ? { cgroupMaxBytes: max } : {}),
  };
}

async function readCgroupLimit(path: string): Promise<number | undefined> {
  const raw = (await readFile(path, 'utf8')).trim();
  if (!raw || raw === 'max') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function formatMib(bytes: number): string {
  return (bytes / 1024 ** 2).toFixed(0);
}

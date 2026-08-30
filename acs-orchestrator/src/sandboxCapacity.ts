import type { AcsOrchestratorConfig } from './config.js';
import { parseDateMs, type ManagedSandbox } from './sandboxState.js';
import type { SandboxRef } from './sandboxManagerTypes.js';
import { decideSandboxLifecycle } from './sandboxLifecyclePolicy.js';

export interface SandboxResourceUsage {
  count: number;
  cpuMillicores: number;
  memoryBytes: number;
}

export interface SandboxCapacitySnapshot extends SandboxResourceUsage {
  maxCount: number;
  maxCpuMillicores: number;
  maxMemoryBytes: number;
  availableCount: number | null;
  availableCpuMillicores: number | null;
  availableMemoryBytes: number | null;
}

export class SandboxCapacityError extends Error {
  readonly code = 'ACS_CAPACITY_EXHAUSTED';

  constructor(readonly snapshot: SandboxCapacitySnapshot) {
    super(
      `ACS Sandbox capacity exhausted: count=${snapshot.count}/${limitText(snapshot.maxCount)} `
      + `cpu=${snapshot.cpuMillicores}m/${limitText(snapshot.maxCpuMillicores)}m `
      + `memory=${snapshot.memoryBytes}/${limitText(snapshot.maxMemoryBytes)}`,
    );
    this.name = 'SandboxCapacityError';
  }
}

export async function enforceSandboxCapacity(input: {
  sandboxes: ManagedSandbox[];
  currentName: string;
  desiredUsage: SandboxResourceUsage;
  pendingUsage: SandboxResourceUsage;
  config: AcsOrchestratorConfig;
  allowEviction: boolean;
  canEvict: (sandbox: ManagedSandbox) => boolean;
  evict: (sandbox: ManagedSandbox) => Promise<boolean>;
}): Promise<{ snapshot: SandboxCapacitySnapshot; evicted: string[] }> {
  // CR 只要仍存在就可能仍占 ACS quota；Creating/Paused/Deleting 都必须计入。
  // 尤其不能在删除完成前提前释放额度，否则并发 provision 会短时超卖。
  const quotaSandboxes = input.sandboxes;
  let usage = addUsage(input.pendingUsage, input.desiredUsage);
  for (const sandbox of quotaSandboxes) {
    if (sandbox.name !== input.currentName) usage = addUsage(usage, usageForSandbox(sandbox, input.config));
  }
  let snapshot = snapshotForUsage(usage, input.config);
  if (!capacityExceeded(snapshot)) return { snapshot, evicted: [] };

  const evicted: string[] = [];
  if (input.allowEviction) {
    const nowMs = Date.now();
    const candidates = quotaSandboxes
      .filter((sandbox) => sandbox.name !== input.currentName && sandbox.phase === 'Paused' && input.canEvict(sandbox))
      .sort((left, right) => {
        const leftExpired = decideSandboxLifecycle({ ...left, nowMs }).delete ? 0 : 1;
        const rightExpired = decideSandboxLifecycle({ ...right, nowMs }).delete ? 0 : 1;
        return leftExpired - rightExpired
          || (parseDateMs(left.lastActiveAt) ?? 0) - (parseDateMs(right.lastActiveAt) ?? 0);
      });
    for (const candidate of candidates) {
      if (!await input.evict(candidate)) continue;
      usage = subtractUsage(usage, usageForSandbox(candidate, input.config));
      evicted.push(candidate.name);
      snapshot = snapshotForUsage(usage, input.config);
      if (!capacityExceeded(snapshot)) return { snapshot, evicted };
    }
  }
  throw new SandboxCapacityError(snapshot);
}

export function zeroUsage(): SandboxResourceUsage {
  return { count: 0, cpuMillicores: 0, memoryBytes: 0 };
}

export function addUsage(left: SandboxResourceUsage, right: SandboxResourceUsage): SandboxResourceUsage {
  return {
    count: left.count + right.count,
    cpuMillicores: left.cpuMillicores + right.cpuMillicores,
    memoryBytes: left.memoryBytes + right.memoryBytes,
  };
}

export function subtractUsage(left: SandboxResourceUsage, right: SandboxResourceUsage): SandboxResourceUsage {
  return {
    count: Math.max(0, left.count - right.count),
    cpuMillicores: Math.max(0, left.cpuMillicores - right.cpuMillicores),
    memoryBytes: Math.max(0, left.memoryBytes - right.memoryBytes),
  };
}

export function usageForRef(ref: SandboxRef, config: AcsOrchestratorConfig): SandboxResourceUsage {
  return usageFromQuantities({
    cpuRequest: ref.resources?.cpuRequest ?? config.cpuRequest,
    cpuLimit: ref.resources?.cpuLimit ?? config.cpuLimit,
    memoryRequest: ref.resources?.memoryRequest ?? config.memoryRequest,
    memoryLimit: ref.resources?.memoryLimit ?? config.memoryLimit,
  });
}

export function defaultSandboxUsage(config: AcsOrchestratorConfig): SandboxResourceUsage {
  return usageFromQuantities({
    cpuRequest: config.cpuRequest,
    cpuLimit: config.cpuLimit,
    memoryRequest: config.memoryRequest,
    memoryLimit: config.memoryLimit,
  });
}

export function usageForSandbox(sandbox: ManagedSandbox, config: AcsOrchestratorConfig): SandboxResourceUsage {
  return usageFromQuantities({
    cpuRequest: sandbox.cpuRequest ?? config.cpuRequest,
    cpuLimit: sandbox.cpuLimit ?? config.cpuLimit,
    memoryRequest: sandbox.memoryRequest ?? config.memoryRequest,
    memoryLimit: sandbox.memoryLimit ?? config.memoryLimit,
  });
}

export function snapshotForUsage(usage: SandboxResourceUsage, config: AcsOrchestratorConfig): SandboxCapacitySnapshot {
  return {
    ...usage,
    maxCount: config.maxRunningSandboxes,
    maxCpuMillicores: config.maxAllocatedCpuMillicores,
    maxMemoryBytes: config.maxAllocatedMemoryMib > 0 ? config.maxAllocatedMemoryMib * 1024 * 1024 : 0,
    availableCount: available(config.maxRunningSandboxes, usage.count),
    availableCpuMillicores: available(config.maxAllocatedCpuMillicores, usage.cpuMillicores),
    availableMemoryBytes: available(
      config.maxAllocatedMemoryMib > 0 ? config.maxAllocatedMemoryMib * 1024 * 1024 : 0,
      usage.memoryBytes,
    ),
  };
}

export function capacityExceeded(snapshot: SandboxCapacitySnapshot): boolean {
  return exceeds(snapshot.maxCount, snapshot.count)
    || exceeds(snapshot.maxCpuMillicores, snapshot.cpuMillicores)
    || exceeds(snapshot.maxMemoryBytes, snapshot.memoryBytes);
}

export function canAdmitWithReclaimableUsage(
  allocated: SandboxResourceUsage,
  desired: SandboxResourceUsage,
  reclaimable: SandboxResourceUsage,
  config: AcsOrchestratorConfig,
): boolean {
  const next = addUsage(allocated, desired);
  return !capacityExceeded(snapshotForUsage(next, config))
    || !capacityExceeded(snapshotForUsage(subtractUsage(next, reclaimable), config));
}

export function summarizeSandboxCapacity(input: {
  sandboxes: ManagedSandbox[];
  pendingUsage: SandboxResourceUsage;
  config: AcsOrchestratorConfig;
  canEvict: (sandbox: ManagedSandbox) => boolean;
}): { snapshot: SandboxCapacitySnapshot; evictablePausedCount: number; executionReady: boolean } {
  let allocated = input.pendingUsage;
  let reclaimable = zeroUsage();
  let evictablePausedCount = 0;
  for (const sandbox of input.sandboxes) {
    const usage = usageForSandbox(sandbox, input.config);
    allocated = addUsage(allocated, usage);
    if (sandbox.phase === 'Paused' && input.canEvict(sandbox)) {
      reclaimable = addUsage(reclaimable, usage);
      evictablePausedCount += 1;
    }
  }
  return {
    snapshot: snapshotForUsage(allocated, input.config),
    evictablePausedCount,
    executionReady: canAdmitWithReclaimableUsage(
      allocated,
      defaultSandboxUsage(input.config),
      reclaimable,
      input.config,
    ),
  };
}

export function parseCpuMillicores(value: string | undefined): number {
  if (!value) return 0;
  const trimmed = value.trim();
  const match = /^(\d+(?:\.\d+)?)(m?)$/.exec(trimmed);
  if (!match) throw new Error(`unsupported Kubernetes CPU quantity: ${value}`);
  const amount = Number(match[1]);
  return Math.ceil(match[2] === 'm' ? amount : amount * 1000);
}

export function parseMemoryBytes(value: string | undefined): number {
  if (!value) return 0;
  const match = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|K|M|G|T)?$/.exec(value.trim());
  if (!match) throw new Error(`unsupported Kubernetes memory quantity: ${value}`);
  const amount = Number(match[1]);
  const binaryPowers: Record<string, number> = { Ki: 1, Mi: 2, Gi: 3, Ti: 4 };
  const decimalPowers: Record<string, number> = { K: 1, M: 2, G: 3, T: 4 };
  const unit = match[2] ?? '';
  if (unit in binaryPowers) return Math.ceil(amount * 1024 ** binaryPowers[unit]!);
  if (unit in decimalPowers) return Math.ceil(amount * 1000 ** decimalPowers[unit]!);
  return Math.ceil(amount);
}

function usageFromQuantities(input: {
  cpuRequest?: string;
  cpuLimit?: string;
  memoryRequest?: string;
  memoryLimit?: string;
}): SandboxResourceUsage {
  return {
    count: 1,
    cpuMillicores: Math.max(parseCpuMillicores(input.cpuRequest), parseCpuMillicores(input.cpuLimit)),
    memoryBytes: Math.max(parseMemoryBytes(input.memoryRequest), parseMemoryBytes(input.memoryLimit)),
  };
}

function exceeds(limit: number, value: number): boolean {
  return limit > 0 && value > limit;
}

function available(limit: number, value: number): number | null {
  return limit > 0 ? Math.max(0, limit - value) : null;
}

function limitText(limit: number): string {
  return limit > 0 ? String(limit) : 'unlimited';
}

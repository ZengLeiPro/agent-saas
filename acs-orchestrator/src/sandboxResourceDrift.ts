import type { SandboxResourceOverride, SandboxRef } from './sandboxManagerTypes.js';
import type { SandboxStatus } from './sandboxState.js';

type ResourceDefaults = SandboxResourceOverride & { sandboxContainerName: string };

export interface SandboxResourceTarget {
  cpuRequest: string | undefined;
  memoryRequest: string | undefined;
  cpuLimit: string | undefined;
  memoryLimit: string | undefined;
}

const RESOURCE_KEYS: Array<keyof SandboxResourceOverride> = [
  'cpuRequest',
  'memoryRequest',
  'cpuLimit',
  'memoryLimit',
];

// singleflight 只有完整 provision 目标一致才能直接复用 leader 结果。
export function sameResourceTarget(left: SandboxRef, right: SandboxRef): boolean {
  return RESOURCE_KEYS.every((key) => left.resources?.[key] === right.resources?.[key])
    && left.workload?.class === right.workload?.class
    && left.workload?.taskKind === right.workload?.taskKind
    && left.workload?.purpose === right.workload?.purpose;
}

export function sandboxResourceTarget(
  override: SandboxResourceOverride | undefined,
  defaults: SandboxResourceOverride,
): SandboxResourceTarget {
  return {
    cpuRequest: override?.cpuRequest ?? defaults.cpuRequest,
    memoryRequest: override?.memoryRequest ?? defaults.memoryRequest,
    cpuLimit: override?.cpuLimit ?? defaults.cpuLimit,
    memoryLimit: override?.memoryLimit ?? defaults.memoryLimit,
  };
}

export function hasSandboxResourceDrift(
  status: SandboxStatus,
  override: SandboxResourceOverride,
  defaults: ResourceDefaults,
): boolean {
  const raw = status.raw ?? {};
  const spec = objectValue(raw.spec);
  const template = objectValue(spec.template);
  const podSpec = objectValue(template.spec);
  const containers = Array.isArray(podSpec.containers) ? podSpec.containers : [];
  const container = containers.find((item): item is Record<string, unknown> => (
    Boolean(item)
    && typeof item === 'object'
    && (!('name' in item) || item.name === defaults.sandboxContainerName)
  ));
  const resources = objectValue(container?.resources);
  const requests = objectValue(resources.requests);
  const limits = objectValue(resources.limits);
  const desired = sandboxResourceTarget(override, defaults);
  return !resourceQuantityEqual('cpu', stringValue(requests.cpu), desired.cpuRequest)
    || !resourceQuantityEqual('memory', stringValue(requests.memory), desired.memoryRequest)
    || !resourceQuantityEqual('cpu', stringValue(limits.cpu), desired.cpuLimit)
    || !resourceQuantityEqual('memory', stringValue(limits.memory), desired.memoryLimit);
}

function resourceQuantityEqual(
  kind: 'cpu' | 'memory',
  actual: string | undefined,
  desired: string | undefined,
): boolean {
  if (actual === undefined || desired === undefined) return actual === desired;
  const parse = kind === 'cpu' ? parseCpuMillicores : parseMemoryBytes;
  const left = parse(actual);
  const right = parse(desired);
  return left !== undefined && right !== undefined ? left === right : actual.trim() === desired.trim();
}

function parseCpuMillicores(value: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)(m?)$/.exec(value.trim());
  if (!match) return undefined;
  const numeric = Number(match[1]);
  return Number.isFinite(numeric) ? numeric * (match[2] === 'm' ? 1 : 1_000) : undefined;
}

function parseMemoryBytes(value: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|K|M|G)?$/.exec(value.trim());
  if (!match) return undefined;
  const numeric = Number(match[1]);
  if (!Number.isFinite(numeric)) return undefined;
  const factors: Record<string, number> = {
    Ki: 1_024, Mi: 1_024 ** 2, Gi: 1_024 ** 3,
    K: 1_000, M: 1_000_000, G: 1_000_000_000,
  };
  return numeric * (match[2] ? factors[match[2]]! : 1);
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

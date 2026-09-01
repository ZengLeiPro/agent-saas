import { randomUUID } from 'node:crypto';

import type { AcsOrchestratorConfig } from './config.js';
import type { Kubectl } from './kubectl.js';
import type { SandboxDeletionPreconditions } from './sandboxDeletion.js';
import type { SandboxStatus } from './sandboxState.js';
import {
  ACTIVITY_GENERATION_ANNOTATION,
  DELETION_GENERATION_ANNOTATION,
  RETENTION_DEADLINE_ANNOTATION,
  TERMINAL_AT_ANNOTATION,
  TERMINAL_OUTCOME_ANNOTATION,
  TERMINAL_STATE_ANNOTATION,
  WORKLOAD_CLASS_LABEL,
  WORKLOAD_DESCRIPTOR_ANNOTATION,
  ACTIVE_INVOCATION_LEASE_ANNOTATION_PREFIX,
  activeInvocationLeaseAnnotationKey,
  expiredActiveInvocationLeaseAnnotationKeys,
  type SandboxLifecycleUpdate,
  type SandboxWorkloadDescriptor,
} from './sandboxLifecyclePolicy.js';
import {
  BACKGROUND_SHELL_PROTECTED_UNTIL_ANNOTATION,
  BACKGROUND_SHELL_PROTECTION_GENERATION_ANNOTATION,
} from './sandboxState.js';
import { LAST_ACTIVE_AT_ANNOTATION } from './sandboxInventoryReader.js';

/** Kubernetes UID/resourceVersion JSON Patch 前置条件失败统一映射为可重试冲突。 */
export class SandboxMutationPreconditionError extends Error {
  readonly statusCode = 409;
}

type ResourcePatchChange = { path: string; value: unknown } | { path: string; remove: true };

async function patchWithResourcePreconditions(
  config: AcsOrchestratorConfig,
  kubectl: Kubectl,
  resourceName: string,
  preconditions: SandboxDeletionPreconditions,
  changes: ResourcePatchChange[],
  errorPrefix: string,
): Promise<void> {
  const patch = [
    { op: 'test', path: '/metadata/uid', value: preconditions.uid },
    { op: 'test', path: '/metadata/resourceVersion', value: preconditions.resourceVersion },
    ...changes.map((change) => 'remove' in change
      ? { op: 'remove', path: change.path }
      : { op: 'add', path: change.path, value: change.value }),
  ];
  const result = await kubectl.run([
    'patch', resourceName, '--type=json', '-p', JSON.stringify(patch),
  ], { timeoutMs: config.sandboxWaitTimeoutMs });
  if (result.exitCode === 0) return;
  const detail = result.stderr || result.stdout;
  if (/conflict|test(?: operation)? failed|object has been modified|precondition|resourceversion|uid.*immutable/i.test(detail)) {
    throw new SandboxMutationPreconditionError(`${errorPrefix}: ${detail}`);
  }
  throw new Error(`${errorPrefix}: ${detail}`);
}

export async function applyLifecycleUpdate(
  config: AcsOrchestratorConfig, kubectl: Kubectl, resourceName: string, input: SandboxLifecycleUpdate,
  preconditions: SandboxDeletionPreconditions, currentAnnotations: Record<string, unknown>,
): Promise<void> {
  const optionalAnnotation = (key: string, value: string | undefined): ResourcePatchChange[] => {
    const path = `/metadata/annotations/${jsonPointerSegment(key)}`;
    if (value !== undefined) return [{ path, value }];
    return Object.prototype.hasOwnProperty.call(currentAnnotations, key) ? [{ path, remove: true }] : [];
  };
  await patchWithResourcePreconditions(config, kubectl, resourceName, preconditions, [
    { path: `/metadata/annotations/${jsonPointerSegment(TERMINAL_STATE_ANNOTATION)}`, value: input.terminalState },
    { path: `/metadata/annotations/${jsonPointerSegment(TERMINAL_AT_ANNOTATION)}`, value: input.terminalAt },
    ...optionalAnnotation(
      TERMINAL_OUTCOME_ANNOTATION,
      input.outcome === undefined ? undefined : JSON.stringify(input.outcome),
    ),
    ...optionalAnnotation(RETENTION_DEADLINE_ANNOTATION, input.retentionDeadline),
  ], '更新 Sandbox lifecycle 失败');
}

export async function applyDeletionGeneration(
  config: AcsOrchestratorConfig, kubectl: Kubectl, resourceName: string, generation: string,
  preconditions: SandboxDeletionPreconditions,
): Promise<void> {
  await patchWithResourcePreconditions(config, kubectl, resourceName, preconditions, [{
    path: `/metadata/annotations/${jsonPointerSegment(DELETION_GENERATION_ANNOTATION)}`,
    value: generation,
  }], '更新 Sandbox deletion generation 失败');
}

export async function applyPausedWithPreconditions(
  config: AcsOrchestratorConfig, kubectl: Kubectl, resourceName: string, paused: boolean,
  preconditions: SandboxDeletionPreconditions,
): Promise<void> {
  await patchWithResourcePreconditions(config, kubectl, resourceName, preconditions, [
    { path: '/spec/paused', value: paused },
  ], `patch sandbox paused=${paused} 失败`);
}

export async function createSandboxResource(
  config: AcsOrchestratorConfig, kubectl: Kubectl, manifest: Record<string, unknown>,
): Promise<void> {
  const result = await kubectl.run(['create', '-f', '-'], {
    input: JSON.stringify(manifest), timeoutMs: config.sandboxWaitTimeoutMs,
  });
  if (result.exitCode !== 0) {
    throw new Error(`create Sandbox 失败，拒绝覆盖并发创建的同名资源: ${result.stderr || result.stdout}`);
  }
}

export async function applyInvocationLease(
  config: AcsOrchestratorConfig, kubectl: Kubectl, resourceName: string,
  invocationKey: string, leaseUntil: string | undefined,
  getStatus: () => Promise<SandboxStatus | null>, expectedUid?: string, activityGeneration?: string,
): Promise<string> {
  const activityUpdates = leaseUntil && activityGeneration ? {
    [ACTIVITY_GENERATION_ANNOTATION]: activityGeneration,
    [TERMINAL_STATE_ANNOTATION]: null, [TERMINAL_AT_ANNOTATION]: null,
    [TERMINAL_OUTCOME_ANNOTATION]: null, [RETENTION_DEADLINE_ANNOTATION]: null,
  } : undefined;
  return await applyProtectedAnnotation(
    config, kubectl, resourceName, activeInvocationLeaseAnnotationKey(invocationKey),
    leaseUntil ? JSON.stringify({ invocationKey, until: leaseUntil }) : undefined,
    'invocation lease', getStatus, { mergeLatest: true, expectedUid, updates: activityUpdates },
  );
}

/** Atomically removes every expired invocation annotation observed on one resource. */
export async function clearExpiredInvocationLeases(
  config: AcsOrchestratorConfig, kubectl: Kubectl, resourceName: string,
  nowMs: number, getStatus: () => Promise<SandboxStatus | null>,
): Promise<{ active: boolean; removed: number }> {
  let observedUid: string | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const status = await getStatus();
    if (!status) return { active: false, removed: 0 };
    const metadata = objectValue(status.raw?.metadata);
    const uid = stringValue(metadata.uid);
    const resourceVersion = stringValue(metadata.resourceVersion);
    if (!uid || !resourceVersion) throw new SandboxMutationPreconditionError('Sandbox 缺少 UID/resourceVersion');
    if (observedUid && observedUid !== uid) {
      throw new SandboxMutationPreconditionError('Sandbox 已同名重建，拒绝清扫 invocation lease');
    }
    observedUid ??= uid;
    const annotations = objectValue(metadata.annotations);
    const expiredKeys = expiredActiveInvocationLeaseAnnotationKeys(annotations, nowMs);
    const active = Object.entries(annotations).some(([key, raw]) => {
      if (!key.startsWith(ACTIVE_INVOCATION_LEASE_ANNOTATION_PREFIX) || typeof raw !== 'string') return false;
      try {
        const parsed = JSON.parse(raw) as { until?: unknown };
        return typeof parsed.until === 'string' && Date.parse(parsed.until) > nowMs;
      } catch {
        return false;
      }
    });
    if (expiredKeys.length === 0) return { active, removed: 0 };
    const patch = [
      { op: 'test', path: '/metadata/uid', value: uid },
      { op: 'test', path: '/metadata/resourceVersion', value: resourceVersion },
      ...expiredKeys.flatMap((key) => {
        const path = `/metadata/annotations/${jsonPointerSegment(key)}`;
        return [
          { op: 'test', path, value: annotations[key] },
          { op: 'remove', path },
        ];
      }),
    ];
    const result = await kubectl.run([
      'patch', resourceName, '--type=json', '-p', JSON.stringify(patch),
    ], { timeoutMs: config.sandboxWaitTimeoutMs });
    if (result.exitCode === 0) return { active, removed: expiredKeys.length };
    const detail = result.stderr || result.stdout;
    const conflict = /conflict|test(?: operation)? failed|object has been modified|precondition|resourceversion/i.test(detail);
    if (conflict && attempt < 2) continue;
    if (conflict) throw new SandboxMutationPreconditionError(`清扫 invocation lease 失败: ${detail}`);
    throw new Error(`清扫 invocation lease 失败: ${detail}`);
  }
  return { active: false, removed: 0 };
}

export async function applyWorkloadDescriptor(
  config: AcsOrchestratorConfig, kubectl: Kubectl, resourceName: string,
  workload: SandboxWorkloadDescriptor, getStatus: () => Promise<SandboxStatus | null>,
): Promise<void> {
  const activityGeneration = `ensure:${randomUUID()}`;
  const admittedAt = new Date().toISOString();
  let observedUid: string | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const status = await getStatus();
    if (!status) throw new SandboxMutationPreconditionError('Sandbox 不存在，拒绝更新 workload descriptor');
    const metadata = objectValue(status.raw?.metadata);
    const annotations = objectValue(metadata.annotations);
    const uid = stringValue(metadata.uid);
    const resourceVersion = stringValue(metadata.resourceVersion);
    if (!uid || !resourceVersion) throw new SandboxMutationPreconditionError('Sandbox 缺少 UID/resourceVersion');
    if (observedUid && observedUid !== uid) {
      throw new SandboxMutationPreconditionError('Sandbox 已同名重建，拒绝更新 workload descriptor');
    }
    observedUid ??= uid;
    if (stringValue(metadata.deletionTimestamp)) {
      throw new SandboxMutationPreconditionError('Sandbox 已进入删除流程，拒绝更新 workload descriptor');
    }
    const changes: ResourcePatchChange[] = [
      { path: `/metadata/labels/${jsonPointerSegment(WORKLOAD_CLASS_LABEL)}`, value: workload.class },
      { path: `/metadata/annotations/${jsonPointerSegment(WORKLOAD_DESCRIPTOR_ANNOTATION)}`, value: JSON.stringify(workload) },
      { path: `/metadata/annotations/${jsonPointerSegment(LAST_ACTIVE_AT_ANNOTATION)}`, value: admittedAt },
      { path: `/metadata/annotations/${jsonPointerSegment(ACTIVITY_GENERATION_ANNOTATION)}`, value: activityGeneration },
      ...[TERMINAL_STATE_ANNOTATION, TERMINAL_AT_ANNOTATION, TERMINAL_OUTCOME_ANNOTATION, RETENTION_DEADLINE_ANNOTATION]
        .filter((key) => Object.hasOwn(annotations, key))
        .map((key) => ({ path: `/metadata/annotations/${jsonPointerSegment(key)}`, remove: true as const })),
    ];
    try {
      await patchWithResourcePreconditions(config, kubectl, resourceName, { uid, resourceVersion }, changes, '更新 workload descriptor 失败');
      return;
    } catch (error) {
      if (!(error instanceof SandboxMutationPreconditionError) || attempt === 2) throw error;
    }
  }
}

type ProtectedAnnotationOptions = { mergeLatest?: boolean; expectedUid?: string; expectedClear?: { key: string; value: string | null }; updates?: Record<string, string | null> };
async function applyProtectedAnnotation(
  config: AcsOrchestratorConfig, kubectl: Kubectl, resourceName: string,
  key: string, value: string | undefined, description: string,
  getStatus: () => Promise<SandboxStatus | null>, options: ProtectedAnnotationOptions = {},
): Promise<string> {
  const maxAttempts = value ? 3 : 1; let observedUid = options.expectedUid;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const status = await getStatus();
    if (!status) throw new SandboxMutationPreconditionError(`Sandbox 不存在，拒绝更新 ${description}`);
    const metadata = objectValue(status.raw?.metadata); const annotations = objectValue(metadata.annotations);
    const uid = stringValue(metadata.uid); const resourceVersion = stringValue(metadata.resourceVersion);
    if (!uid || !resourceVersion) throw new SandboxMutationPreconditionError('Sandbox 缺少 UID/resourceVersion');
    if (observedUid && observedUid !== uid) throw new SandboxMutationPreconditionError(`Sandbox 已同名重建，拒绝更新 ${description}`);
    observedUid ??= uid;
    if (value && stringValue(metadata.deletionTimestamp)) throw new SandboxMutationPreconditionError(`Sandbox 已进入删除流程，拒绝新增或续租 ${description}`);
    if (!value && options.expectedClear
      && stringValue(annotations[options.expectedClear.key]) !== (options.expectedClear.value ?? undefined)) return uid;
    const current = stringValue(annotations[key]);
    const desired = value && options.mergeLatest ? laterProtection(current, value) : value;
    const changes = Object.entries(options.updates ?? {}).filter(([extraKey, extraValue]) => (
      extraValue === null ? Object.hasOwn(annotations, extraKey) : annotations[extraKey] !== extraValue
    ));
    if ((desired === current || (!desired && current === undefined)) && changes.length === 0) return uid;
    const path = `/metadata/annotations/${jsonPointerSegment(key)}`;
    const patch = [
      { op: 'test', path: '/metadata/uid', value: uid }, { op: 'test', path: '/metadata/resourceVersion', value: resourceVersion },
      ...(!desired && current !== undefined ? [{ op: 'test', path, value: current }] : []),
      ...(desired === current || (!desired && current === undefined) ? [] : [desired ? { op: 'add', path, value: desired } : { op: 'remove', path }]),
      ...changes.flatMap(([extraKey, extraValue]) => {
        const extraPath = `/metadata/annotations/${jsonPointerSegment(extraKey)}`; const existing = annotations[extraKey];
        return extraValue === null ? [{ op: 'test', path: extraPath, value: existing }, { op: 'remove', path: extraPath }]
          : [{ op: 'add', path: extraPath, value: extraValue }];
      }),
    ];
    const result = await kubectl.run(['patch', resourceName, '--type=json', '-p', JSON.stringify(patch)], { timeoutMs: config.sandboxWaitTimeoutMs });
    if (result.exitCode === 0) return uid;
    const detail = result.stderr || result.stdout;
    const conflict = /conflict|test(?: operation)? failed|object has been modified|precondition|resourceversion/i.test(detail);
    if (conflict && attempt + 1 < maxAttempts) continue;
    if (conflict) throw new SandboxMutationPreconditionError(`更新 ${description} 失败: ${detail}`);
    throw new Error(`更新 ${description} 失败: ${detail}`);
  }
  throw new SandboxMutationPreconditionError(`更新 ${description} 失败: retry exhausted`);
}

function laterProtection(current: string | undefined, requested: string): string {
  const protectionMs = (value: string | undefined): number => {
    if (value === undefined) return Number.NaN;
    const direct = Date.parse(value);
    if (Number.isFinite(direct)) return direct;
    try {
      const parsed = JSON.parse(value) as { until?: unknown };
      return typeof parsed.until === 'string' ? Date.parse(parsed.until) : Number.NaN;
    } catch {
      return Number.NaN;
    }
  };
  return protectionMs(current) > protectionMs(requested) ? current! : requested;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function jsonPointerSegment(value: string): string {
  return value.replace(/~/g, '~0').replace(/\//g, '~1');
}

export async function applyBackgroundShellProtection(
  config: AcsOrchestratorConfig, kubectl: Kubectl, resourceName: string,
  protectedUntil: string | undefined, getStatus: () => Promise<SandboxStatus | null>,
  expectedUid?: string, expectedClearGeneration?: string | null, generation?: string,
): Promise<string> {
  const clearFence = !protectedUntil && expectedClearGeneration !== undefined
    ? { key: BACKGROUND_SHELL_PROTECTION_GENERATION_ANNOTATION, value: expectedClearGeneration } : undefined;
  const updates = protectedUntil && generation ? { [BACKGROUND_SHELL_PROTECTION_GENERATION_ANNOTATION]: generation }
    : !protectedUntil ? { [BACKGROUND_SHELL_PROTECTION_GENERATION_ANNOTATION]: null } : undefined;
  return await applyProtectedAnnotation(
    config, kubectl, resourceName, BACKGROUND_SHELL_PROTECTED_UNTIL_ANNOTATION,
    protectedUntil, '后台 Shell 生命周期保护', getStatus,
    { mergeLatest: true, expectedUid, expectedClear: clearFence, updates },
  );
}

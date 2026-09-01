import type { AcsOrchestratorConfig } from './config.js';
import type { Kubectl } from './kubectl.js';
import type { SandboxDeletionPreconditions } from './sandboxDeletion.js';
import type { SandboxStatus } from './sandboxState.js';
import {
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
import { BACKGROUND_SHELL_PROTECTED_UNTIL_ANNOTATION } from './sandboxState.js';

/** Kubernetes UID/resourceVersion JSON Patch 前置条件失败统一映射为可重试冲突。 */
export class SandboxMutationPreconditionError extends Error {
  readonly statusCode = 409;
}

async function patchMetadata(
  config: AcsOrchestratorConfig,
  kubectl: Kubectl,
  resourceName: string,
  metadata: Record<string, unknown>,
  errorPrefix: string,
): Promise<void> {
  const result = await kubectl.run([
    'patch', resourceName, '--type=merge', '-p', JSON.stringify({ metadata }),
  ], { timeoutMs: config.sandboxWaitTimeoutMs });
  if (result.exitCode !== 0) throw new Error(`${errorPrefix}: ${result.stderr || result.stdout}`);
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
  getStatus: () => Promise<SandboxStatus | null>, expectedUid?: string,
): Promise<string> {
  return await applyProtectedAnnotation(
    config, kubectl, resourceName, activeInvocationLeaseAnnotationKey(invocationKey),
    leaseUntil ? JSON.stringify({ invocationKey, until: leaseUntil }) : undefined,
    'invocation lease', getStatus, true, expectedUid,
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
  workload: SandboxWorkloadDescriptor,
): Promise<void> {
  await patchMetadata(config, kubectl, resourceName, {
    labels: { [WORKLOAD_CLASS_LABEL]: workload.class },
    annotations: {
      [WORKLOAD_DESCRIPTOR_ANNOTATION]: JSON.stringify(workload),
      [TERMINAL_STATE_ANNOTATION]: null,
      [TERMINAL_AT_ANNOTATION]: null,
      [TERMINAL_OUTCOME_ANNOTATION]: null,
      [RETENTION_DEADLINE_ANNOTATION]: null,
    },
  }, '更新 workload descriptor 失败');
}

async function applyProtectedAnnotation(
  config: AcsOrchestratorConfig, kubectl: Kubectl, resourceName: string,
  key: string, value: string | undefined, description: string,
  getStatus: () => Promise<SandboxStatus | null>, mergeLatestProtection = false,
  expectedUid?: string,
): Promise<string> {
  const maxAttempts = value ? 3 : 1;
  let observedUid = expectedUid;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const status = await getStatus();
    if (!status) throw new SandboxMutationPreconditionError(`Sandbox 不存在，拒绝更新 ${description}`);
    const metadata = objectValue(status.raw?.metadata);
    const uid = stringValue(metadata.uid);
    const resourceVersion = stringValue(metadata.resourceVersion);
    if (!uid || !resourceVersion) throw new SandboxMutationPreconditionError('Sandbox 缺少 UID/resourceVersion');
    if (observedUid && observedUid !== uid) {
      throw new SandboxMutationPreconditionError(`Sandbox 已同名重建，拒绝更新 ${description}`);
    }
    observedUid ??= uid;
    if (value && stringValue(metadata.deletionTimestamp)) {
      throw new SandboxMutationPreconditionError(`Sandbox 已进入删除流程，拒绝新增或续租 ${description}`);
    }
    const current = stringValue(objectValue(metadata.annotations)[key]);
    const desired = value && mergeLatestProtection ? laterProtection(current, value) : value;
    if (desired === current || (!desired && current === undefined)) return uid;
    const path = `/metadata/annotations/${jsonPointerSegment(key)}`;
    const patch = [
      { op: 'test', path: '/metadata/uid', value: uid },
      { op: 'test', path: '/metadata/resourceVersion', value: resourceVersion },
      ...(!desired && current !== undefined ? [{ op: 'test', path, value: current }] : []),
      desired ? { op: 'add', path, value: desired } : { op: 'remove', path },
    ];
    const result = await kubectl.run([
      'patch', resourceName, '--type=json', '-p', JSON.stringify(patch),
    ], { timeoutMs: config.sandboxWaitTimeoutMs });
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
  expectedUid?: string,
): Promise<string> {
  return await applyProtectedAnnotation(
    config, kubectl, resourceName, BACKGROUND_SHELL_PROTECTED_UNTIL_ANNOTATION,
    protectedUntil, '后台 Shell 生命周期保护', getStatus, true, expectedUid,
  );
}

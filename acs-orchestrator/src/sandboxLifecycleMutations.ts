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
  activeInvocationLeaseAnnotationKey,
  type SandboxLifecycleUpdate,
  type SandboxWorkloadDescriptor,
} from './sandboxLifecyclePolicy.js';
import { BACKGROUND_SHELL_PROTECTED_UNTIL_ANNOTATION } from './sandboxState.js';

/** Kubernetes resourceVersion CAS 失败统一映射为可重试冲突。 */
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

async function patchWithResourcePreconditions(
  config: AcsOrchestratorConfig,
  kubectl: Kubectl,
  resourceName: string,
  preconditions: SandboxDeletionPreconditions,
  changes: Array<{ path: string; value: unknown }>,
  errorPrefix: string,
): Promise<void> {
  const patch = [
    { op: 'test', path: '/metadata/uid', value: preconditions.uid },
    { op: 'test', path: '/metadata/resourceVersion', value: preconditions.resourceVersion },
    ...changes.map(({ path, value }) => ({ op: 'add', path, value })),
  ];
  const result = await kubectl.run([
    'patch', resourceName, '--type=json', '-p', JSON.stringify(patch),
  ], { timeoutMs: config.sandboxWaitTimeoutMs });
  if (result.exitCode === 0) return;
  const detail = result.stderr || result.stdout;
  if (/conflict|test failed|object has been modified|precondition|resourceversion|uid.*immutable/i.test(detail)) {
    throw new SandboxMutationPreconditionError(`${errorPrefix}: ${detail}`);
  }
  throw new Error(`${errorPrefix}: ${detail}`);
}

export async function applyLifecycleUpdate(
  config: AcsOrchestratorConfig, kubectl: Kubectl, resourceName: string, input: SandboxLifecycleUpdate,
): Promise<void> {
  await patchMetadata(config, kubectl, resourceName, { annotations: {
    [TERMINAL_STATE_ANNOTATION]: input.terminalState,
    [TERMINAL_AT_ANNOTATION]: input.terminalAt,
    [TERMINAL_OUTCOME_ANNOTATION]: input.outcome === undefined ? null : JSON.stringify(input.outcome),
    [RETENTION_DEADLINE_ANNOTATION]: input.retentionDeadline ?? null,
  } }, '更新 Sandbox lifecycle 失败');
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
  getStatus: () => Promise<SandboxStatus | null>,
): Promise<void> {
  await applyProtectedAnnotation(
    config, kubectl, resourceName, activeInvocationLeaseAnnotationKey(invocationKey),
    leaseUntil ? JSON.stringify({ invocationKey, until: leaseUntil }) : undefined,
    'invocation lease', getStatus,
  );
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
  getStatus: () => Promise<SandboxStatus | null>,
): Promise<void> {
  const status = await getStatus();
  if (!status) throw new SandboxMutationPreconditionError(`Sandbox 不存在，拒绝更新 ${description}`);
  const metadata = objectValue(status.raw?.metadata);
  const uid = stringValue(metadata.uid);
  const resourceVersion = stringValue(metadata.resourceVersion);
  if (!uid || !resourceVersion) throw new SandboxMutationPreconditionError('Sandbox 缺少 UID/resourceVersion');
  if (value && stringValue(metadata.deletionTimestamp)) {
    throw new SandboxMutationPreconditionError(`Sandbox 已进入删除流程，拒绝新增或续租 ${description}`);
  }
  const current = stringValue(objectValue(metadata.annotations)[key]);
  if (!value && current === undefined) return;
  const path = `/metadata/annotations/${jsonPointerSegment(key)}`;
  const patch = [
    { op: 'test', path: '/metadata/uid', value: uid },
    { op: 'test', path: '/metadata/resourceVersion', value: resourceVersion },
    ...(!value && current !== undefined ? [{ op: 'test', path, value: current }] : []),
    value ? { op: 'add', path, value } : { op: 'remove', path },
  ];
  const result = await kubectl.run([
    'patch', resourceName, '--type=json', '-p', JSON.stringify(patch),
  ], { timeoutMs: config.sandboxWaitTimeoutMs });
  if (result.exitCode !== 0) {
    throw new SandboxMutationPreconditionError(`更新 ${description} 失败: ${result.stderr || result.stdout}`);
  }
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
): Promise<void> {
  await applyProtectedAnnotation(
    config, kubectl, resourceName, BACKGROUND_SHELL_PROTECTED_UNTIL_ANNOTATION,
    protectedUntil, '后台 Shell 生命周期保护', getStatus,
  );
}

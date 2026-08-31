import type { Kubectl } from './kubectl.js';
import type { SandboxStatus } from './sandboxState.js';

interface SandboxNetworkReclaimer {
  deleteForSandboxName(name: string): Promise<unknown>;
}

interface SandboxSnatReclaimer {
  deleteForSandboxName(name: string): Promise<string[]>;
}

export const SANDBOX_NETWORK_CLEANUP_FINALIZER = 'agent-saas.kaiyan.net/network-cleanup';

export interface SandboxDeletionPreconditions {
  uid: string;
  resourceVersion: string;
  networkCleanupFinalizer?: true;
}

export class SandboxDeletionPreconditionError extends Error {
  readonly statusCode = 409;
}

export function sandboxResourcePreconditions(status: SandboxStatus): SandboxDeletionPreconditions | undefined {
  const metadata = status.raw?.metadata && typeof status.raw.metadata === 'object'
    ? status.raw.metadata as Record<string, unknown>
    : {};
  const uid = typeof metadata.uid === 'string' ? metadata.uid : undefined;
  const resourceVersion = typeof metadata.resourceVersion === 'string' ? metadata.resourceVersion : undefined;
  const finalizers = stringArray(metadata.finalizers);
  return uid && resourceVersion ? {
    uid,
    resourceVersion,
    ...(finalizers.includes(SANDBOX_NETWORK_CLEANUP_FINALIZER) ? { networkCleanupFinalizer: true as const } : {}),
  } : undefined;
}

export async function deleteSandboxAndReclaimNetwork(input: {
  name: string;
  resource: string;
  apiVersion: string;
  kind: string;
  namespace: string;
  timeoutMs: number;
  kubectl: Kubectl;
  networkPolicyManager: SandboxNetworkReclaimer;
  snatManager: SandboxSnatReclaimer;
  preconditions?: SandboxDeletionPreconditions;
}): Promise<string[]> {
  if (!input.preconditions) {
    throw new SandboxDeletionPreconditionError('delete Sandbox 缺少 UID/resourceVersion，拒绝无栅栏回收网络资源');
  }

  const fenced = input.preconditions.networkCleanupFinalizer
    ? input.preconditions
    : await (async () => {
        const current = await readSandbox(input);
        if (!current) return undefined;
        assertExpectedUid(current, input.preconditions!.uid);
        return await ensureNetworkCleanupFinalizer(input, current);
      })();
  if (!fenced) return [];
  // DeleteOptions 只传 Kubernetes 原生 preconditions。
  const rawPath = sandboxResourcePath(input.apiVersion, input.kind, input.namespace, input.name);
  const deleted = await input.kubectl.run(['delete', `--raw=${rawPath}`, '-f', '-'], {
    timeoutMs: input.timeoutMs,
    input: JSON.stringify({
      apiVersion: 'v1', kind: 'DeleteOptions', propagationPolicy: 'Foreground',
      preconditions: { uid: fenced.uid, resourceVersion: fenced.resourceVersion },
    }),
  });
  if (deleted.exitCode !== 0) {
    throw new SandboxDeletionPreconditionError(
      `delete Sandbox 失败(exit=${deleted.exitCode ?? 'null'}): ${deleted.stderr || deleted.stdout || 'unknown error'}`,
    );
  }

  // finalizer 让旧 UID 在网络回收完成前保持 Terminating；Kubernetes 因而不会允许
  // 同名 Sandbox 重建，按名称管理的 TrafficPolicy/SNAT 不会误伤新 incarnation。
  await input.networkPolicyManager.deleteForSandboxName(input.name);
  const snatDeleted = await input.snatManager.deleteForSandboxName(input.name);
  await removeNetworkCleanupFinalizer(input, fenced.uid);
  await waitForSandboxAbsent(input);
  return snatDeleted;
}

async function ensureNetworkCleanupFinalizer(
  input: { resource: string; timeoutMs: number; kubectl: Kubectl },
  current: Record<string, unknown>,
): Promise<SandboxDeletionPreconditions> {
  const metadata = objectValue(current.metadata);
  const uid = stringValue(metadata.uid);
  const resourceVersion = stringValue(metadata.resourceVersion);
  if (!uid || !resourceVersion) throw new SandboxDeletionPreconditionError('Sandbox 缺少 UID/resourceVersion');
  const finalizers = stringArray(metadata.finalizers);
  if (finalizers.includes(SANDBOX_NETWORK_CLEANUP_FINALIZER)) return { uid, resourceVersion };
  if (stringValue(metadata.deletionTimestamp)) {
    throw new SandboxDeletionPreconditionError('Sandbox 已进入删除流程但缺少网络回收 finalizer，拒绝按名称清理');
  }
  const add = Array.isArray(metadata.finalizers)
    ? { op: 'add', path: '/metadata/finalizers/-', value: SANDBOX_NETWORK_CLEANUP_FINALIZER }
    : { op: 'add', path: '/metadata/finalizers', value: [SANDBOX_NETWORK_CLEANUP_FINALIZER] };
  const patched = await input.kubectl.run([
    'patch', input.resource, '--type=json', '-p', JSON.stringify([
      { op: 'test', path: '/metadata/uid', value: uid },
      { op: 'test', path: '/metadata/resourceVersion', value: resourceVersion },
      add,
    ]), '-o', 'json',
  ], { timeoutMs: input.timeoutMs });
  if (patched.exitCode !== 0) {
    throw new SandboxDeletionPreconditionError(
      `设置 Sandbox 网络回收 finalizer 失败(exit=${patched.exitCode ?? 'null'}): ${patched.stderr || patched.stdout || 'unknown error'}`,
    );
  }
  const patchedMetadata = objectValue(parseObject(patched.stdout).metadata);
  const nextResourceVersion = stringValue(patchedMetadata.resourceVersion);
  if (!nextResourceVersion || stringValue(patchedMetadata.uid) !== uid) {
    throw new SandboxDeletionPreconditionError('设置 Sandbox 网络回收 finalizer 后未返回同一 UID/resourceVersion');
  }
  return { uid, resourceVersion: nextResourceVersion };
}

async function removeNetworkCleanupFinalizer(
  input: { resource: string; timeoutMs: number; kubectl: Kubectl },
  expectedUid: string,
): Promise<void> {
  const current = await readSandbox(input);
  if (!current) return;
  assertExpectedUid(current, expectedUid);
  const metadata = objectValue(current.metadata);
  const finalizers = stringArray(metadata.finalizers);
  const index = finalizers.indexOf(SANDBOX_NETWORK_CLEANUP_FINALIZER);
  if (index < 0) return;
  const removed = await input.kubectl.run([
    'patch', input.resource, '--type=json', '-p', JSON.stringify([
      { op: 'test', path: '/metadata/uid', value: expectedUid },
      { op: 'test', path: `/metadata/finalizers/${index}`, value: SANDBOX_NETWORK_CLEANUP_FINALIZER },
      { op: 'remove', path: `/metadata/finalizers/${index}` },
    ]),
  ], { timeoutMs: input.timeoutMs });
  if (removed.exitCode !== 0) {
    throw new SandboxDeletionPreconditionError(
      `移除 Sandbox 网络回收 finalizer 失败(exit=${removed.exitCode ?? 'null'}): ${removed.stderr || removed.stdout || 'unknown error'}`,
    );
  }
}

async function readSandbox(input: {
  resource: string;
  timeoutMs: number;
  kubectl: Kubectl;
}): Promise<Record<string, unknown> | undefined> {
  const result = await input.kubectl.run(['get', input.resource, '-o', 'json'], { timeoutMs: input.timeoutMs });
  if (result.exitCode !== 0) {
    if (/NotFound|not found/i.test(result.stderr + result.stdout)) return undefined;
    throw new Error(`读取 Sandbox 删除状态失败: ${result.stderr || result.stdout}`);
  }
  if (!result.stdout.trim()) return undefined;
  return parseObject(result.stdout);
}

async function waitForSandboxAbsent(input: {
  resource: string;
  timeoutMs: number;
  kubectl: Kubectl;
}): Promise<void> {
  const deadline = Date.now() + input.timeoutMs;
  while (true) {
    const confirmed = await input.kubectl.run([
      'get', input.resource, '--ignore-not-found=true', '-o', 'name',
    ], { timeoutMs: input.timeoutMs });
    if (confirmed.exitCode !== 0) {
      throw new Error(
        `确认 Sandbox 删除失败(exit=${confirmed.exitCode ?? 'null'}): ${confirmed.stderr || confirmed.stdout || 'unknown error'}`,
      );
    }
    if (!confirmed.stdout.trim()) return;
    if (Date.now() >= deadline) throw new Error(`确认 Sandbox 删除失败: ${input.resource} 仍然存在`);
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))));
  }
}

function assertExpectedUid(current: Record<string, unknown>, expectedUid: string): void {
  const actualUid = stringValue(objectValue(current.metadata).uid);
  if (actualUid !== expectedUid) {
    throw new SandboxDeletionPreconditionError(`Sandbox UID 已变化: expected=${expectedUid} actual=${actualUid ?? 'missing'}`);
  }
}

function sandboxResourcePath(apiVersion: string, kind: string, namespace: string, name: string): string {
  const [group, version] = apiVersion.split('/');
  if (!group || !version) throw new Error(`Sandbox apiVersion 格式非法: ${apiVersion}`);
  const lowerKind = kind.toLowerCase();
  const plural = lowerKind.endsWith('s') ? lowerKind : `${lowerKind}es`;
  return `/apis/${group}/${version}/namespaces/${encodeURIComponent(namespace)}/${plural}/${encodeURIComponent(name)}`;
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || '{}') as unknown;
    return objectValue(parsed);
  } catch {
    throw new Error('kubectl get Sandbox 返回了非法 JSON');
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

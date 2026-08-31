import type { Kubectl } from './kubectl.js';
import type { SandboxStatus } from './sandboxState.js';

interface SandboxNetworkReclaimer {
  deleteForSandboxName(name: string): Promise<unknown>;
}

interface SandboxSnatReclaimer {
  deleteForSandboxName(name: string): Promise<string[]>;
}

export interface SandboxDeletionPreconditions {
  uid: string;
  resourceVersion: string;
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
  return uid && resourceVersion ? { uid, resourceVersion } : undefined;
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
  const rawPath = sandboxResourcePath(input.apiVersion, input.kind, input.namespace, input.name);
  const deleted = input.preconditions
    ? await input.kubectl.run(['delete', `--raw=${rawPath}`, '-f', '-'], {
        timeoutMs: input.timeoutMs,
        input: JSON.stringify({
          apiVersion: 'v1', kind: 'DeleteOptions', propagationPolicy: 'Foreground',
          preconditions: input.preconditions,
        }),
      })
    : await input.kubectl.run([
        'delete', input.resource, '--ignore-not-found=true', '--wait=true',
      ], { timeoutMs: input.timeoutMs });
  if (deleted.exitCode !== 0) {
    const message = `delete Sandbox 失败(exit=${deleted.exitCode ?? 'null'}): ${deleted.stderr || deleted.stdout || 'unknown error'}`;
    throw input.preconditions ? new SandboxDeletionPreconditionError(message) : new Error(message);
  }

  await waitForSandboxAbsent(input);

  await input.networkPolicyManager.deleteForSandboxName(input.name);
  return await input.snatManager.deleteForSandboxName(input.name);
}

async function waitForSandboxAbsent(input: {
  resource: string;
  timeoutMs: number;
  kubectl: Kubectl;
  preconditions?: SandboxDeletionPreconditions;
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
    if (!input.preconditions || Date.now() >= deadline) {
      throw new Error(`确认 Sandbox 删除失败: ${input.resource} 仍然存在`);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))));
  }
}

function sandboxResourcePath(apiVersion: string, kind: string, namespace: string, name: string): string {
  const [group, version] = apiVersion.split('/');
  if (!group || !version) throw new Error(`Sandbox apiVersion 格式非法: ${apiVersion}`);
  const lowerKind = kind.toLowerCase();
  const plural = lowerKind.endsWith('s') ? lowerKind : `${lowerKind}es`;
  return `/apis/${group}/${version}/namespaces/${encodeURIComponent(namespace)}/${plural}/${encodeURIComponent(name)}`;
}

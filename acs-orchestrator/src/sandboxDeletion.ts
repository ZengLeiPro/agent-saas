import type { Kubectl } from './kubectl.js';

interface SandboxNetworkReclaimer {
  deleteForSandboxName(name: string): Promise<unknown>;
}

interface SandboxSnatReclaimer {
  deleteForSandboxName(name: string): Promise<string[]>;
}

export async function deleteSandboxAndReclaimNetwork(input: {
  name: string;
  resource: string;
  timeoutMs: number;
  kubectl: Kubectl;
  networkPolicyManager: SandboxNetworkReclaimer;
  snatManager: SandboxSnatReclaimer;
}): Promise<string[]> {
  const deleted = await input.kubectl.run([
    'delete', input.resource, '--ignore-not-found=true', '--wait=true',
  ], { timeoutMs: input.timeoutMs });
  if (deleted.exitCode !== 0) {
    throw new Error(
      `delete Sandbox 失败(exit=${deleted.exitCode ?? 'null'}): ${deleted.stderr || deleted.stdout || 'unknown error'}`,
    );
  }

  const confirmed = await input.kubectl.run([
    'get', input.resource, '--ignore-not-found=true', '-o', 'name',
  ], { timeoutMs: input.timeoutMs });
  if (confirmed.exitCode !== 0) {
    throw new Error(
      `确认 Sandbox 删除失败(exit=${confirmed.exitCode ?? 'null'}): ${confirmed.stderr || confirmed.stdout || 'unknown error'}`,
    );
  }
  if (confirmed.stdout.trim()) throw new Error(`确认 Sandbox 删除失败: ${input.resource} 仍然存在`);

  await input.networkPolicyManager.deleteForSandboxName(input.name);
  return await input.snatManager.deleteForSandboxName(input.name);
}

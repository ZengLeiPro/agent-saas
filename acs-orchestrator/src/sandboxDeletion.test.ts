import { describe, expect, it } from 'vitest';

import type { Kubectl, KubectlResult } from './kubectl.js';
import { deleteSandboxAndReclaimNetwork } from './sandboxDeletion.js';

function dependencies(run: (args: string[]) => Promise<KubectlResult>) {
  const events: string[] = [];
  return {
    events,
    input: {
      name: 'as-test',
      resource: 'sandbox/as-test',
      timeoutMs: 1_000,
      kubectl: { run: async (args: string[]) => {
        events.push(`kubectl:${args[0]}`);
        return await run(args);
      } } as unknown as Kubectl,
      networkPolicyManager: { async deleteForSandboxName() { events.push('traffic-policy'); } },
      snatManager: { async deleteForSandboxName() { events.push('snat'); return ['snat-1']; } },
    },
  };
}

describe('deleteSandboxAndReclaimNetwork', () => {
  it.each([1, null] as const)('delete exitCode=%s 时保留网络资源', async (exitCode) => {
    const { events, input } = dependencies(async () => ({
      stdout: '', stderr: 'injected delete failure', exitCode, signal: null,
    }));
    await expect(deleteSandboxAndReclaimNetwork(input)).rejects.toThrow(/delete Sandbox 失败/);
    expect(events).toEqual(['kubectl:delete']);
  });

  it('确认 Sandbox 仍存在时保留网络资源', async () => {
    const { events, input } = dependencies(async (args) => ({
      stdout: args[0] === 'get' ? 'sandbox/as-test\n' : '', stderr: '', exitCode: 0, signal: null,
    }));
    await expect(deleteSandboxAndReclaimNetwork(input)).rejects.toThrow(/仍然存在/);
    expect(events).toEqual(['kubectl:delete', 'kubectl:get']);
  });

  it('仅在确认 Sandbox 消失后依次回收 TrafficPolicy 与 SNAT', async () => {
    const { events, input } = dependencies(async () => ({ stdout: '', stderr: '', exitCode: 0, signal: null }));
    await expect(deleteSandboxAndReclaimNetwork(input)).resolves.toEqual(['snat-1']);
    expect(events).toEqual(['kubectl:delete', 'kubectl:get', 'traffic-policy', 'snat']);
  });
});

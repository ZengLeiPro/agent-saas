import { describe, expect, it } from 'vitest';

import type { Kubectl, KubectlResult } from './kubectl.js';
import { deleteSandboxAndReclaimNetwork, SandboxDeletionPreconditionError } from './sandboxDeletion.js';

function dependencies(run: (args: string[], options?: { input?: string }) => Promise<KubectlResult>) {
  const events: string[] = [];
  return {
    events,
    input: {
      name: 'as-test',
      resource: 'sandbox/as-test',
      apiVersion: 'agents.kruise.io/v1alpha1', kind: 'Sandbox', namespace: 'agent-saas',
      timeoutMs: 1_000,
      kubectl: { run: async (args: string[], options?: { input?: string }) => {
        events.push(`kubectl:${args[0]}`);
        return await run(args, options);
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

  it('precondition 冲突以 409 拒绝且保留网络资源', async () => {
    const { events, input } = dependencies(async () => ({
      stdout: '', stderr: 'the object has been modified', exitCode: 1, signal: null,
    }));
    const error = await deleteSandboxAndReclaimNetwork({
      ...input, preconditions: { uid: 'old-uid', resourceVersion: 'old-rv' },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SandboxDeletionPreconditionError);
    expect((error as SandboxDeletionPreconditionError).statusCode).toBe(409);
    expect(events).toEqual(['kubectl:delete']);
  });

  it('raw foreground delete 等待 finalizer 完成后再回收网络', async () => {
    let gets = 0;
    const { events, input } = dependencies(async (args) => ({
      stdout: args[0] === 'get' && gets++ === 0 ? 'sandbox/as-test\n' : '',
      stderr: '', exitCode: 0, signal: null,
    }));
    await deleteSandboxAndReclaimNetwork({
      ...input, preconditions: { uid: 'uid-1', resourceVersion: 'rv-1' },
    });
    expect(events).toEqual(['kubectl:delete', 'kubectl:get', 'kubectl:get', 'traffic-policy', 'snat']);
  });

  it('带 UID/resourceVersion precondition 原子删除精确 CR 实例', async () => {
    let rawArgs: string[] | undefined;
    let rawBody: unknown;
    const { input } = dependencies(async (args, options) => {
      if (args[0] === 'delete') {
        rawArgs = args;
        rawBody = JSON.parse(options?.input ?? '{}');
      }
      return { stdout: '', stderr: '', exitCode: 0, signal: null };
    });
    await deleteSandboxAndReclaimNetwork({
      ...input,
      preconditions: { uid: 'uid-1', resourceVersion: 'rv-1' },
    });
    expect(rawArgs).toEqual([
      'delete', '--raw=/apis/agents.kruise.io/v1alpha1/namespaces/agent-saas/sandboxes/as-test', '-f', '-',
    ]);
    expect(rawBody).toMatchObject({ preconditions: { uid: 'uid-1', resourceVersion: 'rv-1' } });
  });

  it('普通删除确认 Sandbox 仍存在时保留网络资源', async () => {
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

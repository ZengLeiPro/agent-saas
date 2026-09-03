import { describe, expect, it } from 'vitest';

import type { Kubectl, KubectlResult } from './kubectl.js';
import {
  deleteSandboxAndReclaimNetwork,
  reconcileTerminatingSandboxDeletions,
  SANDBOX_NETWORK_CLEANUP_FINALIZER,
  SandboxDeletionPreconditionError,
} from './sandboxDeletion.js';

const ok = (stdout = ''): KubectlResult => ({ stdout, stderr: '', exitCode: 0, signal: null });

function statefulDependencies(input: {
  uid?: string;
  resourceVersion?: string;
  finalizer?: boolean;
  networkFailure?: boolean;
  leaseAfterDelete?: boolean;
  absentAfterDelete?: boolean;
} = {}) {
  const events: string[] = [];
  let present = true;
  let deleting = false;
  let resourceVersion = input.resourceVersion ?? 'rv-1';
  let annotations: Record<string, string> = {};
  let finalizers = input.finalizer ? [SANDBOX_NETWORK_CLEANUP_FINALIZER] : [];
  let rawDeleteBody: Record<string, unknown> | undefined;
  const object = () => JSON.stringify({
    metadata: {
      uid: input.uid ?? 'uid-1', resourceVersion, finalizers, annotations,
      ...(deleting ? { deletionTimestamp: new Date().toISOString() } : {}),
    },
  });
  const kubectl = { run: async (args: string[], options?: { input?: string }): Promise<KubectlResult> => {
    if (args[0] === 'get' && args.includes('--ignore-not-found=true')) {
      events.push('confirm-absent');
      return ok(present ? 'sandbox/as-test\n' : '');
    }
    if (args[0] === 'get') {
      events.push('get-sandbox');
      return present ? ok(object()) : { ...ok(), stderr: 'NotFound', exitCode: 1 };
    }
    if (args[0] === 'patch' && args.includes('-o')) {
      events.push('add-finalizer');
      finalizers = [SANDBOX_NETWORK_CLEANUP_FINALIZER];
      resourceVersion = 'rv-2';
      return ok(object());
    }
    if (args[0] === 'delete') {
      events.push('delete-cr');
      rawDeleteBody = JSON.parse(options?.input ?? '{}') as Record<string, unknown>;
      deleting = true;
      if (input.absentAfterDelete) present = false;
      if (input.leaseAfterDelete) {
        resourceVersion = 'rv-leased-after-delete';
        annotations = {
          'agent-saas.kaiyan.net/active-invocation-lease-test': JSON.stringify({
            invocationKey: 'inv-race', until: new Date(Date.now() + 60_000).toISOString(),
          }),
        };
      }
      return ok();
    }
    if (args[0] === 'patch') {
      events.push('remove-finalizer');
      const patch = JSON.parse(args[4] ?? '[]') as Array<{ path?: string; value?: unknown }>;
      const expectedResourceVersion = patch.find((operation) => operation.path === '/metadata/resourceVersion')?.value;
      if (expectedResourceVersion !== resourceVersion) return { ...ok(), stderr: 'Conflict', exitCode: 1 };
      finalizers = [];
      present = false;
      return ok();
    }
    throw new Error(`unexpected kubectl ${args.join(' ')}`);
  } } as unknown as Kubectl;
  return {
    events,
    state: {
      get present() { return present; },
      get deleting() { return deleting; },
      get rawDeleteBody() { return rawDeleteBody; },
    },
    request: {
      name: 'as-test', resource: 'sandbox/as-test',
      apiVersion: 'agents.kruise.io/v1alpha1', kind: 'Sandbox', namespace: 'agent-saas',
      timeoutMs: 1_000, kubectl,
      networkPolicyManager: { async deleteForSandboxName() {
        events.push('traffic-policy');
        if (input.networkFailure) throw new Error('network failure');
      } },
      snatManager: { async deleteForSandboxName() { events.push('snat'); return ['snat-1']; } },
      preconditions: { uid: input.uid ?? 'uid-1', resourceVersion: input.resourceVersion ?? 'rv-1' },
    },
  };
}

describe('deleteSandboxAndReclaimNetwork', () => {
  it('缺少 UID/resourceVersion 时拒绝无栅栏网络回收', async () => {
    const { request } = statefulDependencies();
    const { preconditions: _preconditions, ...withoutFence } = request;
    await expect(deleteSandboxAndReclaimNetwork(withoutFence)).rejects.toBeInstanceOf(SandboxDeletionPreconditionError);
  });

  it('为 legacy Sandbox 以 CAS 补 finalizer，再按补丁后的 resourceVersion 删除', async () => {
    const { events, request, state } = statefulDependencies();
    await expect(deleteSandboxAndReclaimNetwork(request)).resolves.toEqual(['snat-1']);
    expect(events).toEqual([
      'get-sandbox', 'add-finalizer', 'delete-cr', 'get-sandbox', 'traffic-policy', 'snat',
      'get-sandbox', 'remove-finalizer', 'confirm-absent',
    ]);
    expect(state.rawDeleteBody).toMatchObject({ preconditions: { uid: 'uid-1', resourceVersion: 'rv-2' } });
  });

  it('旧 UID 网络回收期间 finalizer 阻止同名新 Sandbox 穿插创建', async () => {
    const { events, request, state } = statefulDependencies({ finalizer: true });
    let recreationBlocked = false;
    request.networkPolicyManager.deleteForSandboxName = async () => {
      events.push('traffic-policy');
      recreationBlocked = state.present && state.deleting;
    };
    await deleteSandboxAndReclaimNetwork(request);
    expect(recreationBlocked).toBe(true);
    expect(state.present).toBe(false);
    expect(events).toEqual([
      'get-sandbox', 'delete-cr', 'get-sandbox', 'traffic-policy', 'snat',
      'get-sandbox', 'remove-finalizer', 'confirm-absent',
    ]);
  });

  it('网络回收失败时保留 Terminating CR/finalizer，供重启后重试', async () => {
    const { events, request, state } = statefulDependencies({ finalizer: true, networkFailure: true });
    await expect(deleteSandboxAndReclaimNetwork(request)).rejects.toThrow('network failure');
    expect(state.present).toBe(true);
    expect(state.deleting).toBe(true);
    expect(events).toEqual(['get-sandbox', 'delete-cr', 'get-sandbox', 'traffic-policy']);
  });

  it('并发清理已使旧 UID 消失时直接返回，不按名称误删新实例网络', async () => {
    const { events, request } = statefulDependencies({ finalizer: true, absentAfterDelete: true });
    await expect(deleteSandboxAndReclaimNetwork(request)).resolves.toEqual([]);
    expect(events).toEqual(['get-sandbox', 'delete-cr', 'get-sandbox']);
  });

  it('DELETE 后迟到 lease 被复读拦截，网络清理尚未开始', async () => {
    const { events, request, state } = statefulDependencies({ finalizer: true, leaseAfterDelete: true });
    await expect(deleteSandboxAndReclaimNetwork(request))
      .rejects.toBeInstanceOf(SandboxDeletionPreconditionError);
    expect(state.present).toBe(true);
    expect(events).toEqual(['get-sandbox', 'delete-cr', 'get-sandbox']);
  });

  it('final gate 后 resourceVersion 已被 lease 改写时不补 finalizer、不删除', async () => {
    const { events, request } = statefulDependencies({ resourceVersion: 'rv-leased' });
    request.preconditions = { uid: 'uid-1', resourceVersion: 'rv-final-gate' };
    await expect(deleteSandboxAndReclaimNetwork(request))
      .rejects.toBeInstanceOf(SandboxDeletionPreconditionError);
    expect(events).toEqual(['get-sandbox']);
  });

  it('UID 已变化时以 409 拒绝且不回收网络', async () => {
    const { events, request } = statefulDependencies({ uid: 'new-uid' });
    request.preconditions = { uid: 'old-uid', resourceVersion: 'rv-1' };
    const error = await deleteSandboxAndReclaimNetwork(request).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SandboxDeletionPreconditionError);
    expect((error as SandboxDeletionPreconditionError).statusCode).toBe(409);
    expect(events).toEqual(['get-sandbox']);
  });

  it('周期恢复 Terminating finalizer，且单个失败不阻塞后续对象', async () => {
    const retried: string[] = [];
    const warnings: string[] = [];
    await reconcileTerminatingSandboxDeletions({
      sandboxes: [
        { name: 'healthy' },
        { name: 'stuck-a', deletionTimestamp: '2026-09-01T00:00:00Z', networkCleanupFinalizer: true },
        { name: 'stuck-b', deletionTimestamp: '2026-09-01T00:00:00Z', networkCleanupFinalizer: true },
      ],
      retry: async (name) => { retried.push(name); if (name === 'stuck-a') throw new Error('temporary'); },
      warn: (message) => warnings.push(message),
    });
    expect(retried).toEqual(['stuck-a', 'stuck-b']);
    expect(warnings).toHaveLength(1);
  });
});

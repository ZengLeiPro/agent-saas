import { describe, expect, it, vi } from 'vitest';

import type { InstallationBinding, P256PublicJwk } from '@kaiyan/ky-app-contract';

import { MemoryInstallationBindingProvider } from './memory.js';
import { V2DeploymentKeyRotation } from './keyRotation.js';
import { InstallationRuntimeManager } from './runtimeManager.js';
import type { DeploymentKeyStore } from './types.js';

const publicJwk = (x: string, y: string): P256PublicJwk => ({
  kty: 'EC',
  crv: 'P-256',
  x,
  y,
});

describe('V2DeploymentKeyRotation', () => {
  it('prepare、全部实例确认、平台切换、本地热切换、旧钥匙淘汰严格按序执行', async () => {
    const order: string[] = [];
    const current = {
      deploymentId: 'deployment-1',
      keyId: 'A'.repeat(43),
      keyRef: 'kms:current',
      publicJwk: publicJwk('a'.repeat(43), 'b'.repeat(43)),
    };
    const next = {
      deploymentId: 'deployment-1',
      keyId: 'B'.repeat(43),
      keyRef: 'kms:next',
      publicJwk: publicJwk('c'.repeat(43), 'd'.repeat(43)),
    };
    let activeKey = current;
    const keys: DeploymentKeyStore = {
      current: async () => activeKey,
      sign: async () => new Uint8Array(64),
      prepareRotation: async () => {
        order.push('prepare-local');
        return next;
      },
      commitRotation: async () => {
        order.push('commit-local');
        activeKey = next;
      },
    };
    const bindings = new MemoryInstallationBindingProvider();
    const initial: InstallationBinding = {
      installationId: 'inst-1',
      tenantId: 'tenant-1',
      systemId: 'system-1',
      deploymentId: current.deploymentId,
      origin: 'https://business.example.com',
      platformIssuer: 'https://platform.example.com',
      platformApiBaseUrl: 'https://api.example.com',
      keyId: current.keyId,
      grantedScopes: ['installation.keys.rotate'],
      registeredDigest: 'a'.repeat(64),
      generation: 1,
      state: 'connected',
      updatedAt: new Date().toISOString(),
    };
    await bindings.stage(initial);
    await bindings.activate(initial.installationId, 1);
    const runtimes = new InstallationRuntimeManager(bindings, async () => ({
      validate: async () => {
        order.push('runtime-validate');
      },
      start: async () => {
        order.push('runtime-start');
      },
      drain: async () => {
        order.push('runtime-drain');
      },
    }));
    const request = vi.fn(async (_binding, _scope, _url, init) => {
      const body = JSON.parse(String(init.body)) as { mode?: string };
      order.push(
        body.mode === 'switch'
          ? 'switch-platform'
          : body.mode === 'finalize'
            ? 'finalize-platform'
            : 'prepare-platform',
      );
      return new Response('{}', { status: 200 });
    });
    const clear = vi.fn();
    const rotation = new V2DeploymentKeyRotation({
      keys,
      bindings,
      runtimes,
      workload: { request, clear } as never,
      instanceObservations: async () => {
        order.push('heartbeats');
        return {
          expectedInstanceIds: ['pod-a', 'pod-b'],
          observations: [
            { instanceId: 'pod-a', keyId: next.keyId, generation: 2 },
            { instanceId: 'pod-b', keyId: next.keyId, generation: 2 },
          ],
        };
      },
    });

    await expect(rotation.rotate('inst-1')).resolves.toMatchObject({
      keyId: next.keyId,
      generation: 2,
      state: 'connected',
    });
    expect(order).toEqual([
      'prepare-local',
      'prepare-platform',
      'heartbeats',
      'switch-platform',
      'commit-local',
      'runtime-validate',
      'runtime-start',
      'finalize-platform',
    ]);
    expect(clear).toHaveBeenCalledWith('inst-1');
  });
});

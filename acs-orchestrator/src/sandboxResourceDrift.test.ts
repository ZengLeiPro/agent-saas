import { describe, expect, it } from 'vitest';

import { ActiveSandboxRegistry } from './activeSandboxRegistry.js';
import type { Kubectl, KubectlResult } from './kubectl.js';
import { SandboxManager } from './sandboxManager.js';
import { baseConfig } from './sandboxManagerTestFixtures.js';
import type { SandboxResourceOverride } from './sandboxManagerTypes.js';

const identity = {
  workspaceId: 'ws_kaiyan__test',
  sessionId: 'session-123',
  mountSubPath: 'workspaces/kaiyan/u-1',
};

function sandboxBody(resources: { requests: Record<string, string>; limits?: Record<string, string> }) {
  return {
    metadata: { annotations: { 'agent-saas.kaiyan.net/mount-subpath': identity.mountSubPath } },
    spec: {
      paused: false,
      template: {
        spec: {
          containers: [{ name: 'sandbox', image: baseConfig().sandboxImage, resources }],
        },
      },
    },
    status: { phase: 'Running' },
  };
}

function harness(existing?: ReturnType<typeof sandboxBody>, firstSandboxApplyGate?: Promise<void>) {
  let current = existing;
  const deleted: string[] = [];
  const sandboxManifests: Array<Record<string, any>> = [];
  const logs: string[] = [];
  const kubectl = {
    async run(args: string[], options: { input?: string } = {}): Promise<KubectlResult> {
      if (args[0] === 'get' && args[1] === 'sandbox' && args.includes('-l')) {
        return { stdout: JSON.stringify({ items: [] }), stderr: '', exitCode: 0, signal: null };
      }
      if (args[0] === 'get' && args[1]?.startsWith('sandbox/')) {
        if (!current && args.includes('--ignore-not-found=true')) {
          return { stdout: '', stderr: '', exitCode: 0, signal: null };
        }
        return current
          ? { stdout: JSON.stringify(current), stderr: '', exitCode: 0, signal: null }
          : { stdout: '', stderr: 'NotFound', exitCode: 1, signal: null };
      }
      if (args[0] === 'get' && args.includes('--ignore-not-found=true')) {
        return { stdout: '', stderr: '', exitCode: 0, signal: null };
      }
      if (args[0] === 'apply') {
        const manifest = JSON.parse(options.input ?? '{}') as Record<string, any>;
        if (manifest.kind === 'Sandbox') {
          sandboxManifests.push(manifest);
          if (sandboxManifests.length === 1 && firstSandboxApplyGate) await firstSandboxApplyGate;
          current = { ...manifest, status: { phase: 'Running' } } as ReturnType<typeof sandboxBody>;
        }
        return { stdout: '', stderr: '', exitCode: 0, signal: null };
      }
      if (args[0] === 'delete') {
        if (args[1]?.startsWith('sandbox/')) {
          deleted.push(args[1]);
          current = undefined;
        }
        return { stdout: '', stderr: '', exitCode: 0, signal: null };
      }
      if (args[0] === 'patch') return { stdout: '', stderr: '', exitCode: 0, signal: null };
      throw new Error(`unexpected kubectl args: ${args.join(' ')}`);
    },
  } as unknown as Kubectl;
  const logger = { info: (message: string) => logs.push(message), warn: (message: string) => logs.push(message), error: (message: string) => logs.push(message) };
  return { kubectl, deleted, sandboxManifests, logs, logger };
}

const daily: SandboxResourceOverride = { cpuLimit: '1', memoryLimit: '2048Mi' };
const coding: SandboxResourceOverride = { cpuLimit: '2', memoryLimit: '4096Mi' };

describe('SandboxManager profile resources', () => {
  it.each([
    ['daily', daily, { cpu: '1', memory: '2048Mi' }],
    ['coding', coding, { cpu: '2', memory: '4096Mi' }],
  ] as const)('writes %s resources into the Sandbox manifest', async (_profile, resources, limits) => {
    const h = harness();
    const manager = new SandboxManager(baseConfig(), h.kubectl, h.logger);
    await manager.ensureRunning({ ...identity, resources });
    const container = h.sandboxManifests[0]!.spec.template.spec.containers[0];
    expect(container.resources).toEqual({
      requests: { cpu: '250m', memory: '512Mi' },
      limits,
    });
  });

  it('recreates an idle Running Sandbox when actual requests/limits drift from target', async () => {
    const h = harness(sandboxBody({
      requests: { cpu: '250m', memory: '512Mi' },
      limits: { cpu: '2', memory: '4096Mi' },
    }));
    const manager = new SandboxManager(baseConfig(), h.kubectl, h.logger);
    const ref = manager.ref({ ...identity, resources: daily });
    await manager.ensureRunning({ ...identity, resources: daily });
    expect(h.deleted).toContain(`sandbox/${ref.name}`);
    expect(h.sandboxManifests).toHaveLength(1);
    expect(h.logs.some((line) => line.includes('sandbox_resource_drift name='))).toBe(true);
  });

  it('singleflights the same name but performs a follow-up ensure when concurrent targets differ', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const h = harness(undefined, firstGate);
    const manager = new SandboxManager(baseConfig(), h.kubectl, h.logger);
    const first = manager.ensureRunning({ ...identity, resources: daily });
    while (h.sandboxManifests.length === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    const second = manager.ensureRunning({ ...identity, resources: coding });
    releaseFirst();
    await Promise.all([first, second]);
    expect(h.sandboxManifests).toHaveLength(2);
    const finalResources = h.sandboxManifests[1]!.spec.template.spec.containers[0].resources;
    expect(finalResources.limits).toEqual({ cpu: '2', memory: '4096Mi' });
    expect(h.logs.some((line) => line.includes('sandbox_ensure_join'))).toBe(true);
    expect(h.logs.some((line) => line.includes('sandbox_ensure_resource_followup'))).toBe(true);
  });

  it('defers resource drift while busy and reuses the existing Running Sandbox', async () => {
    const h = harness(sandboxBody({
      requests: { cpu: '250m', memory: '512Mi' },
      limits: { cpu: '2', memory: '4096Mi' },
    }));
    const registry = new ActiveSandboxRegistry();
    const manager = new SandboxManager(baseConfig(), h.kubectl, h.logger, registry);
    const ref = manager.ref({ ...identity, resources: daily });
    const release = registry.acquire(ref.name, 'existing-task');
    let deferred;
    try {
      deferred = await manager.ensureRunning({ ...identity, resources: daily }, { activeKey: 'warmup' });
    } finally {
      release();
    }
    expect(deferred.resourceDriftDeferred).toBe(true);
    expect(h.deleted).toEqual([]);
    expect(h.sandboxManifests).toEqual([]);
    expect(h.logs.some((line) => line.includes('sandbox_resource_drift_deferred') && line.includes('reason=busy'))).toBe(true);
    await manager.ensureRunning({ ...identity, resources: daily }, { activeKey: 'next-task' });
    expect(h.deleted).toContain(`sandbox/${ref.name}`);
  });
});

import { describe, expect, it } from 'vitest';

import type { Kubectl, KubectlResult } from './kubectl.js';
import { SandboxManager } from './sandboxManager.js';
import { baseConfig, noopLogger } from './sandboxManagerTestFixtures.js';
import { WORKLOAD_DESCRIPTOR_ANNOTATION } from './sandboxLifecyclePolicy.js';

const ok = (stdout = ''): KubectlResult => ({ stdout, stderr: '', exitCode: 0, signal: null });

describe('SandboxManager workload concurrency', () => {
  it('leader 完成后重新检查不同 workload，并把 descriptor 补写为 follower 目标', async () => {
    const config = { ...baseConfig(), sandboxWaitTimeoutMs: 5_000, maxRunningSandboxes: 0 };
    const identity = { workspaceId: 'ws-workload-race', sessionId: 's-1' };
    let created = false;
    let workload = { class: 'unknown' };
    let applyStarted!: () => void;
    let releaseApply!: () => void;
    const applyPending = new Promise<void>((resolve) => { applyStarted = resolve; });
    const applyBlocked = new Promise<void>((resolve) => { releaseApply = resolve; });
    const kubectl = {
      async run(args: string[], options: { input?: string } = {}): Promise<KubectlResult> {
        if (args[0] === 'get' && args.includes('-l')) return ok(JSON.stringify({ items: [] }));
        if (args[0] === 'get') {
          if (args.includes('--ignore-not-found=true')) return ok();
          if (!created) return { stdout: '', stderr: 'NotFound', exitCode: 1, signal: null };
          return ok(JSON.stringify({
            metadata: { annotations: {
              'agent-saas.kaiyan.net/mount-subpath': identity.workspaceId,
              [WORKLOAD_DESCRIPTOR_ANNOTATION]: JSON.stringify(workload),
            } },
            spec: { template: { spec: { containers: [{ name: config.sandboxContainerName, image: config.sandboxImage }] } } },
            status: { phase: 'Running' },
          }));
        }
        if (args[0] === 'apply') {
          const manifest = JSON.parse(options.input ?? '{}') as { kind?: string; metadata?: { annotations?: Record<string, string> } };
          if (manifest.kind === 'Sandbox') {
            workload = JSON.parse(manifest.metadata?.annotations?.[WORKLOAD_DESCRIPTOR_ANNOTATION] ?? '{}');
            applyStarted();
            await applyBlocked;
            created = true;
          }
          return ok();
        }
        if (args[0] === 'patch') {
          const payload = JSON.parse(args[args.length - 1] ?? '{}') as { metadata?: { annotations?: Record<string, string> } };
          const descriptor = payload.metadata?.annotations?.[WORKLOAD_DESCRIPTOR_ANNOTATION];
          if (descriptor) workload = JSON.parse(descriptor);
          return ok();
        }
        throw new Error(`unexpected kubectl args: ${args.join(' ')}`);
      },
    } as unknown as Kubectl;
    const manager = new SandboxManager(config, kubectl, noopLogger);

    const leader = manager.ensureRunning({ ...identity, workload: { class: 'unknown' } });
    await applyPending;
    const follower = manager.ensureRunning({ ...identity, workload: { class: 'taskboard', taskKind: 'delivery', purpose: 'work' } });
    releaseApply();
    await Promise.all([leader, follower]);

    expect(workload).toEqual({ class: 'taskboard', taskKind: 'delivery', purpose: 'work' });
  });
});

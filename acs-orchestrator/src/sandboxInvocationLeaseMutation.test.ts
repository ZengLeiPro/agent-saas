import { describe, expect, it, vi } from 'vitest';

import type { Kubectl, KubectlResult } from './kubectl.js';
import { SandboxManager } from './sandboxManager.js';
import { baseConfig, noopLogger } from './sandboxManagerTestFixtures.js';

const ok = (): KubectlResult => ({ stdout: '', stderr: '', exitCode: 0, signal: null });

describe('Sandbox invocation and background protection mutation fence', () => {
  it('rejects a new lease after Kubernetes accepted deletion', async () => {
    const run = vi.fn(async () => ok());
    const manager = new SandboxManager(baseConfig(), { run } as unknown as Kubectl, noopLogger);
    vi.spyOn(manager, 'getStatus').mockResolvedValue({
      phase: 'Running',
      raw: {
        metadata: {
          uid: 'uid-deleting', resourceVersion: 'rv-deleting',
          deletionTimestamp: new Date().toISOString(), annotations: {},
        },
      },
    });

    await expect(manager.setActiveInvocationLease(
      'as-deleting', 'inv-after-delete', new Date(Date.now() + 60_000).toISOString(),
    )).rejects.toThrow(/已进入删除流程/u);
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects late background protection after Kubernetes accepted deletion', async () => {
    const run = vi.fn(async () => ok());
    const manager = new SandboxManager(baseConfig(), { run } as unknown as Kubectl, noopLogger);
    vi.spyOn(manager, 'getStatus').mockResolvedValue({
      phase: 'Running',
      raw: {
        metadata: {
          uid: 'uid-deleting', resourceVersion: 'rv-deleting',
          deletionTimestamp: new Date().toISOString(), annotations: {},
        },
      },
    });

    await expect(manager.setBackgroundShellProtection(
      'as-deleting', new Date(Date.now() + 60_000).toISOString(),
    )).rejects.toThrow(/已进入删除流程/u);
    expect(run).not.toHaveBeenCalled();
  });
});

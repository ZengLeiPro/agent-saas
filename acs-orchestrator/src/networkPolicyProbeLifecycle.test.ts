import { describe, expect, it, vi } from 'vitest';

import { ActiveSandboxRegistry } from './activeSandboxRegistry.js';
import type { Kubectl } from './kubectl.js';
import { SandboxManager } from './sandboxManager.js';
import { baseConfig, noopLogger } from './sandboxManagerTestFixtures.js';

describe('SandboxManager network policy probe lifecycle', () => {
  it('cleans the planned probe Sandbox when ensureRunning fails', async () => {
    const manager = new SandboxManager(baseConfig(), {} as Kubectl, noopLogger);
    vi.spyOn(manager, 'ensureRunning').mockRejectedValueOnce(new Error('probe sandbox pending timeout'));
    const deleteProbe = vi.spyOn(manager, 'delete').mockResolvedValueOnce();

    await expect(manager.probeNetworkPolicy()).rejects.toThrow('probe sandbox pending timeout');

    expect(deleteProbe).toHaveBeenCalledOnce();
    expect(deleteProbe.mock.calls[0]?.[0]).toMatchObject({ workspaceId: 'network-probe' });
    expect(deleteProbe.mock.calls[0]?.[1]?.activeKey).toMatch(/^probe:/);
  });

  it('preserves both the probe and cleanup failures', async () => {
    const manager = new SandboxManager(baseConfig(), {} as Kubectl, noopLogger);
    vi.spyOn(manager, 'ensureRunning').mockRejectedValueOnce(new Error('probe failed'));
    vi.spyOn(manager, 'delete').mockRejectedValueOnce(new Error('cleanup failed'));

    let error: unknown;
    try {
      await manager.probeNetworkPolicy();
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) throw new Error('expected AggregateError');
    expect(error.errors.map((item: unknown) => (item as Error).message)).toEqual(['probe failed', 'cleanup failed']);
  });

  it('singleflights overlapping attestation retries into one temporary Sandbox', async () => {
    const activeRegistry = new ActiveSandboxRegistry();
    const manager = new SandboxManager(baseConfig(), {} as Kubectl, noopLogger, activeRegistry);
    const ref = manager.ref({ workspaceId: 'network-probe', sessionId: 'probe-shared' });
    let resolveEnsure!: (value: typeof ref) => void;
    const ensurePending = new Promise<typeof ref>((resolve) => { resolveEnsure = resolve; });
    const ensure = vi.spyOn(manager, 'ensureRunning').mockReturnValue(ensurePending);
    const ensureSnat = vi.spyOn(manager.snatManager, 'ensureForProbe').mockResolvedValueOnce(null);
    const probeResult = {
      desiredPolicy: baseConfig().networkPolicy,
      effectivePolicy: {
        mode: 'public-egress' as const,
        enforcement: 'enforced' as const,
        publicEgressReachable: true,
        privateEgressBlocked: true,
        metadataBlocked: true,
        dnsRebindingProtected: true,
      },
      probe: { checks: {} },
    };
    const runProbe = vi.spyOn(
      (manager as unknown as { networkPolicyManager: { probe: (value: typeof ref) => Promise<typeof probeResult> } }).networkPolicyManager,
      'probe',
    ).mockResolvedValueOnce(probeResult);
    const deleteProbe = vi.spyOn(manager, 'delete').mockResolvedValueOnce();

    const first = manager.probeNetworkPolicy();
    const second = manager.probeNetworkPolicy();
    expect(ensure).toHaveBeenCalledOnce();
    resolveEnsure(ref);

    await expect(Promise.all([first, second])).resolves.toEqual([probeResult, probeResult]);
    expect(ensureSnat).toHaveBeenCalledOnce();
    expect(runProbe).toHaveBeenCalledOnce();
    expect(deleteProbe).toHaveBeenCalledOnce();
    expect(activeRegistry.busyNames()).toEqual(new Set());
  });
});

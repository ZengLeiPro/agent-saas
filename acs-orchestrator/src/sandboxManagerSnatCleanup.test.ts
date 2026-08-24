import { describe, expect, it, vi } from 'vitest';

import type { AcsOrchestratorConfig } from './config.js';
import type { Kubectl, KubectlResult } from './kubectl.js';
import { SandboxManager } from './sandboxManager.js';
import { baseConfig, noopLogger } from './sandboxManagerTestFixtures.js';

describe('SandboxManager SNAT orphan cleanup', () => {
  it.each([
    ['Running', 'Running'],
    ['Paused', 'Paused'],
    ['Pending', 'Pending'],
    ['Unknown', 'Unknown'],
    ['undefined', undefined],
  ] as const)('retains the managed SNAT while an existing Sandbox phase is %s', async (_label, phase) => {
    const config = snatEnabledConfig();
    const sandboxName = `as-existing-${_label.toLowerCase()}`;
    const kubectl = sandboxListKubectl([{
      metadata: { name: sandboxName },
      ...(phase === undefined ? {} : { status: { phase } }),
    }]);
    const manager = new SandboxManager(config, kubectl, noopLogger);
    const activeCidrs = new Set<string>();
    vi.spyOn(manager.snatManager, 'activeManagedPodCidrs').mockResolvedValue(activeCidrs);
    const cleanup = vi.spyOn(manager.snatManager, 'cleanupOrphans').mockResolvedValue({
      enabled: true,
      checked: 0,
      deleted: [],
      orphanCidrs: [],
      unexpected: [],
    });

    await manager.cleanupOrphanSnat();

    expect(cleanup).toHaveBeenCalledWith(activeCidrs, {
      retainedEntryNames: new Set([manager.snatManager.entryNameForSandboxName(sandboxName)]),
    });
  });

  it('retains only names corresponding to Sandbox resources in the confirmed managed inventory', async () => {
    const config = snatEnabledConfig();
    const kubectl = sandboxListKubectl([
      { metadata: { name: 'as-existing-pending' }, status: { phase: 'Pending' } },
    ]);
    const manager = new SandboxManager(config, kubectl, noopLogger);
    vi.spyOn(manager.snatManager, 'activeManagedPodCidrs').mockResolvedValue(new Set());
    const cleanup = vi.spyOn(manager.snatManager, 'cleanupOrphans').mockResolvedValue({
      enabled: true,
      checked: 2,
      deleted: ['snat-confirmed-orphan'],
      orphanCidrs: ['172.16.177.12/32'],
      unexpected: [{
        id: 'snat-unmanaged',
        name: 'manual-entry',
        sourceCidr: '172.16.177.13/32',
        snatIp: '120.77.218.94',
        managed: false,
      }],
    });

    const report = await manager.cleanupOrphanSnat();

    const retainedEntryNames = cleanup.mock.calls[0]?.[1]?.retainedEntryNames;
    expect(retainedEntryNames).toEqual(new Set([
      manager.snatManager.entryNameForSandboxName('as-existing-pending'),
    ]));
    expect(retainedEntryNames).not.toContain(manager.snatManager.entryNameForSandboxName('as-confirmed-missing'));
    expect(retainedEntryNames).not.toContain('manual-entry');
    expect(report.deleted).toEqual(['snat-confirmed-orphan']);
    expect(report.unexpected.map((entry) => entry.id)).toEqual(['snat-unmanaged']);
  });
});

function snatEnabledConfig(): AcsOrchestratorConfig {
  const config = baseConfig();
  return {
    ...config,
    snat: {
      ...config.snat,
      mode: 'probe-only',
      regionId: 'cn-shenzhen',
      snatTableId: 'stb-test',
      snatIp: '120.77.218.94',
    },
  };
}

function sandboxListKubectl(items: Array<Record<string, unknown>>): Kubectl {
  return {
    async run(args: string[]): Promise<KubectlResult> {
      expect(args.slice(0, 3)).toEqual(['get', 'sandbox', '-l']);
      return {
        stdout: JSON.stringify({ items }),
        stderr: '',
        exitCode: 0,
        signal: null,
      };
    },
  } as unknown as Kubectl;
}

import { describe, expect, it, vi } from 'vitest';
import { RetirementInventory } from './retirementInventory.js';

describe('retirement inventory', () => {
  it('copies immutable owner and tenant identities and does not expose the map', () => {
    const inventory = new RetirementInventory();
    inventory.add('r1', 'worker-a', 'tenant-a');
    const first = inventory.snapshot();
    first.drainRuns[0].workerId = 'corrupt';
    first.drainRuns.length = 0;
    expect(inventory.snapshot()).toEqual({
      inventoryComplete: true,
      drainRuns: [{ runId: 'r1', workerId: 'worker-a', tenantId: 'tenant-a' }],
    });
  });
  it('makes overflow and changed owner/tenant explicit rather than silently dropping proof obligations', () => {
    for (const kind of ['overflow', 'owner', 'tenant']) {
      const inventory = new RetirementInventory(1);
      inventory.add('r1', 'old', 't1');
      inventory.add(
        kind === 'overflow' ? 'r2' : 'r1',
        kind === 'owner' ? 'new' : 'old',
        kind === 'tenant' ? 't2' : 't1',
      );
      expect(inventory.snapshot().inventoryComplete).toBe(false);
      expect(inventory.snapshot().drainRuns).toEqual([
        { runId: 'r1', workerId: 'old', tenantId: 't1' },
      ]);
    }
  });
  it('retains unregistered and late-arriving runs after drain begins', async () => {
    vi.resetModules();
    const { runtimeRunController: controller } = await import('./runController.js');
    controller.register('old-run', new AbortController(), { workerId: 'old', tenantId: 't1' });
    controller.beginRetirementTracking();
    controller.unregister('old-run');
    controller.register('late-run', new AbortController(), { workerId: 'old', tenantId: 't1' });
    controller.unregister('late-run');
    expect(controller.drainSnapshot().registeredRuns).toBe(0);
    expect(controller.retirementSnapshot().drainRuns.map((r) => r.runId)).toEqual([
      'old-run',
      'late-run',
    ]);
  });
});

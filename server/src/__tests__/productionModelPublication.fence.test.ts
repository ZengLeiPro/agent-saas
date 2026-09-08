import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { acquireFileGuard } from '../config/adminConfigMutationService.js';
import {
  createProductionPublicationRig,
  type ProductionPublicationRig,
} from './helpers/productionPublicationRig.js';

describe('production model publication shares the production host fence', () => {
  let rig: ProductionPublicationRig;
  beforeEach(async () => {
    rig = await createProductionPublicationRig();
  });
  afterEach(async () => {
    await rig?.close();
  });

  it('refuses a save before candidate side effects while code promotion owns the host lock', async () => {
    const release = await acquireFileGuard(join(rig.root, 'promotion.lock'));
    const input = rig.input();
    const candidate = vi.fn(input.buildCandidate);
    input.buildCandidate = candidate;
    try {
      await expect(rig.service.mutate(input)).rejects.toThrow('互斥锁');
      expect(candidate).not.toHaveBeenCalled();
      expect(readFileSync(rig.configPath, 'utf8')).toBe(rig.before);
    } finally {
      await release();
    }
    await expect(rig.service.mutate(rig.input())).resolves.toMatchObject({
      previousConfig: expect.any(Object),
    });
  });

  it('holds the host fence through candidate application and committed readback, then releases it', async () => {
    const phases = new Set<string>();
    rig.setBeforeObserve(async (state) => {
      await expect(acquireFileGuard(join(rig.root, 'promotion.lock'))).rejects.toThrow();
      phases.add(state.phase);
    });
    await rig.service.mutate(rig.input());
    expect(phases).toEqual(new Set(['committed', 'applying']));
    const release = await acquireFileGuard(join(rig.root, 'promotion.lock'));
    await release();
  });
});

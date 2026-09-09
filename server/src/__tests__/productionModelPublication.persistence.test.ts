import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as publications from '../../../scripts/release/config-publication.mjs';
import { RuntimeRestoreFailedError } from '../config/adminConfigMutationService.js';
import {
  createProductionPublicationRig,
  type ProductionPublicationRig,
} from './helpers/productionPublicationRig.js';

let rig: ProductionPublicationRig;
beforeEach(async () => {
  rig = await createProductionPublicationRig();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rig.close();
});

describe('production rollback publication errors', () => {
  it.each(['before', 'after'] as const)(
    'remains recoverable by the live owner when the rollback head fails %s replacement',
    async (moment) => {
      rig.blockedPhases.add('runtime-worker:applying');
      const original = publications.writePublication;
      let injected = false;
      vi.spyOn(publications, 'writePublication').mockImplementation((path, record) => {
        if (record.phase === 'rolling_back' && !injected) {
          injected = true;
          if (moment === 'after') original(path, record);
          // A rename may have succeeded before a following directory fsync fails.
          throw new Error('injected rollback publication failure');
        }
        return original(path, record);
      });

      await expect(rig.service.mutate(rig.input())).rejects.toBeInstanceOf(
        RuntimeRestoreFailedError,
      );
      expect(injected).toBe(true);
      expect(readFileSync(rig.configPath, 'utf8')).toBe(rig.before);
      const interrupted = publications.readPublication(rig.configPath)!;
      expect(interrupted.phase).toBe('recovery_required');
      expect(publications.isOwnerAlive(interrupted.owner!)).toBe(true);
      expect(rig.publisher.getWritePolicy().canSave).toBe(false);

      vi.restoreAllMocks();
      await rig.service.recoverProductionPublication();
      const restored = publications.readPublication(rig.configPath)!;
      expect(restored.phase).toBe('committed');
      expect(restored.rawRevision).toBe(rig.baseline.rawRevision);
      for (const target of rig.targets) {
        const receipt = JSON.parse(readFileSync(target.receiptPath, 'utf8'));
        expect(receipt.phase).toBe('committed');
        expect(receipt.revision).toBe(restored.revision);
        expect(receipt.sequence).toBe(restored.sequence);
      }
    },
  );

  it('does not relabel a different signed transaction after a rollback write error', async () => {
    rig.blockedPhases.add('runtime-worker:applying');
    const original = publications.writePublication;
    const foreignRevision = randomUUID();
    vi.spyOn(publications, 'writePublication').mockImplementation((path, record) => {
      if (record.phase === 'rolling_back') {
        original(path, { ...record, revision: foreignRevision });
        throw new Error('injected unrelated authority change');
      }
      return original(path, record);
    });
    await expect(rig.service.mutate(rig.input())).rejects.toBeInstanceOf(
      RuntimeRestoreFailedError,
    );
    const current = publications.readPublication(rig.configPath)!;
    expect(current.revision).toBe(foreignRevision);
    expect(current.phase).toBe('rolling_back');
  });
});

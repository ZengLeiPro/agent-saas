import { describe, expect, it, vi } from 'vitest';
import type { PgAssignmentStore } from '../../data/assignments/store.js';
import {
  createKyAppTestRig,
  seedPublishedInstallation,
  TEST_IID,
  PLATFORM_ADMIN,
} from '../__tests__/harness.js';

describe('业务系统启停保留授权', () => {
  it.each(
    [
      [],
      [
        { assigneeType: 'user', assigneeId: 'u1', effect: 'allow', origin: 'migration' },
        { assigneeType: 'directory_group', assigneeId: 'g1', effect: 'deny', origin: 'direct' },
        { assigneeType: 'agent', assigneeId: 'a1', effect: 'allow' },
      ],
      [{ assigneeType: 'everyone', effect: 'allow' }],
    ].map((rules) => [rules]),
  )('规则保留，删除清空：%j', async (rules) => {
    const replaceAssignments = vi.fn(async (..._args: unknown[]) => ({ version: 2 }));
    const assignmentStore = {
      getAssignmentSet: async () => ({ version: 1, assignments: rules }),
      replaceAssignments,
    } as unknown as PgAssignmentStore;
    const harness = await createKyAppTestRig({ assignmentStore });
    try {
      await seedPublishedInstallation(harness);
      for (const status of ['disabled', 'enabled', 'deleted'] as const) {
        await harness.installations.setStatus({
          installationId: TEST_IID,
          status,
          actor: {
            sub: PLATFORM_ADMIN.sub,
            role: PLATFORM_ADMIN.role,
            tenantId: PLATFORM_ADMIN.tenantId,
          },
        });
        expect(replaceAssignments.mock.calls.at(-1)?.[3]).toEqual(
          status === 'deleted'
            ? []
            : rules.map(({ assigneeType, effect, ...rest }) => ({
                assigneeType,
                effect,
                ...('assigneeId' in rest ? { assigneeId: rest.assigneeId } : {}),
              })),
        );
      }
    } finally {
      await harness.close();
    }
  });
});

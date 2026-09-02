import { describe, expect, it } from 'vitest';
import { createCacheBackup } from '@agent/shared';

/** Server projections must never be serialized as client backup authority. */
describe('M30-02 server cache authority boundary', () => {
  it('rejects server queue/runtime/cursor/attachment submission material at the shared codec', () => {
    const owner = { tenantId: 'tenant-a', userId: 'user-a' };
    for (const data of [{ queue: [] }, { runtime: { runId: 'r1' } }, { cursor: 'c1' }, { interaction: { id: 'i1' } }, { attachmentId: 'server-attachment' }, { submissionId: 'server-submission' }]) {
      expect(() => createCacheBackup(owner, [{ resource: 'messages', resourceId: 's1', type: 'display', data }])).toThrow();
    }
  });
});

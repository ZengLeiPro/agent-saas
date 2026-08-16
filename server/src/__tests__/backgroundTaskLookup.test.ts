import { describe, expect, it, vi } from 'vitest';

import { PgRunStore } from '../runtime/runStore.js';

describe('PgRunStore background task identifier lookup', () => {
  it('queries full/short id directly within parent, user and tenant scope and returns at most two', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const store = new PgRunStore({ pool: { query } as never });

    await expect(store.findBackgroundTasksByIdentifier(
      'parent-session', 'T-ABCDEF', { userId: 'user-1', tenantId: 'tenant-1' },
    )).resolves.toEqual([]);

    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(/run_id = \$2 OR UPPER\(metadata->>'shortTaskId'\) = UPPER\(\$2\)[\s\S]*LIMIT 2/),
      ['parent-session', 'T-ABCDEF', 'user-1', 'tenant-1'],
    );
  });
});

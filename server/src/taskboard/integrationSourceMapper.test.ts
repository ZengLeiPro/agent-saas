import { describe, expect, it } from 'vitest';

import { rowToIntegrationSource } from './integrationSourceMapper.js';

const base = {
  id: 'source-1', integration_task_id: 'integration-1', delivery_task_id: 'delivery-1',
  repository_id: 'github:acme/app', frozen_head_oid: 'frozen-head-1',
  source_order: 0, updated_at: '2026-08-26T06:00:00.000Z',
};

describe('rowToIntegrationSource', () => {
  it('does not require a reviewed PR revision for a source', () => {
    expect(rowToIntegrationSource({ ...base, state: 'pending' })).toEqual({
      id: 'source-1', integrationTaskId: 'integration-1', deliveryTaskId: 'delivery-1',
      repositoryId: 'github:acme/app', frozenHeadOid: 'frozen-head-1', order: 0,
      state: 'pending', updatedAt: '2026-08-26T06:00:00.000Z',
    });
  });

  it('keeps historical sources without a frozen head representable', () => {
    const { frozen_head_oid: _, ...historical } = base;
    expect(rowToIntegrationSource({ ...historical, state: 'pending' })).not.toHaveProperty('frozenHeadOid');
  });

  it.each(['validating', 'ready', 'merging', 'waiting_retry', 're_reviewing', 'resolving_conflict', 'waiting_remediation'])(
    'normalizes historical %s state to a generic active source projection',
    (state) => expect(rowToIntegrationSource({ ...base, state }).state).toBe('pending'),
  );

  it.each(['merged', 'needs_human', 'canceled'] as const)(
    'keeps the user-relevant %s state',
    (state) => expect(rowToIntegrationSource({ ...base, state }).state).toBe(state),
  );
});

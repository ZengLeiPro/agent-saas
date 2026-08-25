import { describe, expect, it, vi } from 'vitest';

import type { ContextPgPool } from '../store/migration.js';
import { DerivedContextAdminReadStore } from './adminRead.js';

const NOW = new Date('2026-08-25T00:10:00.000Z');

function reader(rows: object[]) {
  const query = vi.fn(async () => ({ rows, rowCount: rows.length }));
  return {
    query,
    store: new DerivedContextAdminReadStore({ query } as unknown as ContextPgPool, 'runtime', () => NOW),
  };
}

describe('DerivedContextAdminReadStore', () => {
  it('does not report a never-started or stale consumer as current', async () => {
    const { store } = reader([{
      consumer_id: 'projector', cursor_seq: '10', max_seq: '10', status: 'idle',
      updated_at: '2026-08-25T00:09:00.000Z', last_heartbeat_at: null, last_error_code: null,
    }, {
      consumer_id: 'stale', cursor_seq: '10', max_seq: '10', status: 'idle',
      updated_at: '2026-08-25T00:09:00.000Z', last_heartbeat_at: '2026-08-25T00:04:59.000Z', last_error_code: null,
    }]);

    await expect(store.listConsumers('tenant-a')).resolves.toEqual([
      expect.objectContaining({ id: 'projector', status: 'offline', watermarkAt: null }),
      expect.objectContaining({ id: 'stale', status: 'offline', detail: expect.stringContaining('无 heartbeat') }),
    ]);
  });

  it('distinguishes fresh retry, sequence lag and current consumers', async () => {
    const heartbeat = '2026-08-25T00:09:00.000Z';
    const { store, query } = reader([{
      consumer_id: 'blocked', cursor_seq: '4', max_seq: '5', status: 'retry_wait',
      updated_at: heartbeat, last_heartbeat_at: heartbeat, last_error_code: 'PROJECT_FAILED',
    }, {
      consumer_id: 'lagging', cursor_seq: '4', max_seq: '5', status: 'idle',
      updated_at: heartbeat, last_heartbeat_at: heartbeat, last_error_code: null,
    }, {
      consumer_id: 'current', cursor_seq: '5', max_seq: '5', status: 'idle',
      updated_at: heartbeat, last_heartbeat_at: heartbeat, last_error_code: null,
    }]);

    const result = await store.listConsumers('tenant-a');
    expect(result).toEqual([
      expect.objectContaining({ id: 'blocked', status: 'blocked', detail: expect.stringContaining('PROJECT_FAILED') }),
      expect.objectContaining({ id: 'lagging', status: 'lagging', detail: '待处理 1 个 Context revision' }),
      expect.objectContaining({ id: 'current', status: 'current', watermarkAt: heartbeat }),
    ]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('WHERE consumer.tenant_id=$1'), ['tenant-a']);
  });
});

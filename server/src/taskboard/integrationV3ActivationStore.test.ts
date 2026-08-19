import { describe, expect, it, vi } from 'vitest';

import {
  PostgresIntegrationV3ActivationStore,
  createIntegrationV3ActivationHeartbeat,
} from './integrationV3ActivationStore.js';

describe('PostgresIntegrationV3ActivationStore', () => {
  it.each([
    [undefined, 'worker_heartbeat_missing'],
    [{ status: 'healthy', compatible: true, fresh: false }, 'worker_heartbeat_expired'],
    [{ status: 'healthy', compatible: false, fresh: true }, 'worker_heartbeat_incompatible'],
    [{ status: 'unhealthy', compatible: true, fresh: true, reason: 'gateway_down' }, 'gateway_down'],
    [{ status: 'inactive', compatible: true, fresh: true, reason: 'stopped' }, 'stopped'],
  ])('fails closed for missing, stale, incompatible, or unhealthy workers %#', async (row, reason) => {
    const db = { query: vi.fn(async () => ({ rows: row ? [row] : [] })) };
    const store = new PostgresIntegrationV3ActivationStore(db as never, 'activation');
    await expect(store.compatibleHealth()).resolves.toEqual({ enabled: true, healthy: false, reason });
  });

  it('accepts a fresh compatible healthy independent worker', async () => {
    const db = { query: vi.fn(async () => ({ rows: [{ status: 'healthy', compatible: true, fresh: true }] })) };
    const store = new PostgresIntegrationV3ActivationStore(db as never, 'activation');
    await expect(store.compatibleHealth()).resolves.toEqual({ enabled: true, healthy: true });
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('schema_version=$1 AND protocol_version=$2 AND policy_revision=$3'), expect.any(Array));
  });

  it('marks the process inactive on stop after publishing a healthy heartbeat', async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    const store = new PostgresIntegrationV3ActivationStore(db as never, 'activation');
    const heartbeat = createIntegrationV3ActivationHeartbeat({
      store,
      releaseIdentity: 'release-green',
      processRole: 'runtime-worker',
      getHealth: async () => ({ healthy: true }),
      intervalMs: 60_000,
    });
    await heartbeat.start();
    await heartbeat.stop();
    expect(db.query).toHaveBeenNthCalledWith(1, expect.stringContaining('INSERT INTO activation'), expect.arrayContaining([
      heartbeat.processIdentity, 'release-green', 'runtime-worker', expect.any(Number), expect.any(Number),
      expect.any(String), 'healthy', null,
    ]));
    expect(db.query).toHaveBeenNthCalledWith(2, expect.stringContaining("SET status='inactive'"), [heartbeat.processIdentity, 'stopped']);
  });
});

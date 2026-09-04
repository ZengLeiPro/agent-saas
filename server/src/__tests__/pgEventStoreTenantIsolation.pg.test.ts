import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { LEGACY_TENANT_ID } from '../data/tenants/types.js';
import { PgEventStore } from '../runtime/pgEventStore.js';
import type { PlatformEventInput } from '../runtime/types.js';

const { Pool } = pg;
const connectionString = process.env.TEST_DATABASE_URL?.trim();
const describePg = connectionString ? describe : describe.skip;
if (!connectionString) {
  console.warn('[pgEventStoreTenantIsolation.pg] SKIPPED: TEST_DATABASE_URL is not configured');
}

const createdStores: PgEventStore[] = [];
const prefixes: string[] = [];

function createStore(label: string): { store: PgEventStore; prefix: string } {
  const prefix = `${label}_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const store = new PgEventStore({ connectionString: connectionString!, tablePrefix: prefix });
  createdStores.push(store);
  prefixes.push(prefix);
  return { store, prefix };
}

function message(id: string, tenantMarker: string) {
  return {
    id,
    type: 'user_message',
    runId: 'shared-run',
    sessionId: 'shared-session',
    content: `shared-needle ${tenantMarker}`,
  } as never;
}

function toolResult(id: string, tenantMarker: string) {
  return {
    id,
    type: 'tool_result',
    runId: 'shared-run',
    sessionId: 'shared-session',
    toolCallId: 'shared-tool-call',
    toolName: 'Read',
    content: `tool-result ${tenantMarker}`,
    isError: false,
  } as never;
}

describePg('PgEventStore tenant isolation PostgreSQL contract', () => {
  afterAll(async () => {
    for (const store of createdStores) {
      const prefix = prefixes[createdStores.indexOf(store)]!;
      await store.pool.query(`DROP TABLE IF EXISTS ${prefix}_events`);
      await store.pool.query(`DROP TABLE IF EXISTS ${prefix}_event_cursors`);
      await store.close();
    }
  }, 30_000);

  it('同 sessionId/runId/eventId 的两个 tenant 独立编号且所有读取边界不混读', async () => {
    const { store } = createStore('event_tenant_scope');
    await store.init();

    const sharedMessageId = 'same-event-id-message';
    const sharedToolResultId = 'same-event-id-tool-result';
    const tenantA = 'tenant-a';
    const tenantB = 'tenant-b';
    const wrongTenant = 'tenant-c';

    const appendedA = await store.appendBatch([
      message(sharedMessageId, 'only-a'),
      toolResult(sharedToolResultId, 'only-a'),
    ], { tenantId: tenantA });
    const appendedB = await store.appendBatch([
      message(sharedMessageId, 'only-b'),
      toolResult(sharedToolResultId, 'only-b'),
    ], { tenantId: tenantB });

    expect(appendedA.map((event) => (event as unknown as { sequence: number }).sequence)).toEqual([1, 2]);
    expect(appendedB.map((event) => (event as unknown as { sequence: number }).sequence)).toEqual([1, 2]);
    expect(appendedA.map((event) => event.id)).toEqual([sharedMessageId, sharedToolResultId]);
    expect(appendedB.map((event) => event.id)).toEqual([sharedMessageId, sharedToolResultId]);

    expect((await store.list(tenantA, 'shared-session')).map((event) => event.id))
      .toEqual([sharedMessageId, sharedToolResultId]);
    expect((await store.list(tenantB, 'shared-session')).map((event) => event.id))
      .toEqual([sharedMessageId, sharedToolResultId]);
    await expect(store.list(wrongTenant, 'shared-session')).resolves.toEqual([]);

    const firstPageA = await store.listPage(tenantA, 'shared-session', { limit: 1 });
    expect(firstPageA.events).toMatchObject([{ id: sharedMessageId, content: 'shared-needle only-a', sequence: 1 }]);
    expect(firstPageA).toMatchObject({ nextCursor: '1', hasMore: true });
    const secondPageB = await store.listPage(tenantB, 'shared-session', { afterCursor: '1', limit: 1 });
    expect(secondPageB.events).toMatchObject([{ id: sharedToolResultId, content: 'tool-result only-b', sequence: 2 }]);
    await expect(store.listPage(wrongTenant, 'shared-session', { limit: 10 }))
      .resolves.toMatchObject({ events: [], hasMore: false });

    await expect(store.getById(tenantA, sharedMessageId)).resolves.toMatchObject({ content: 'shared-needle only-a' });
    await expect(store.getById(tenantB, sharedMessageId)).resolves.toMatchObject({ content: 'shared-needle only-b' });
    await expect(store.getById(wrongTenant, sharedMessageId)).resolves.toBeNull();

    await expect(store.search(tenantA, 'shared-session', 'shared-needle')).resolves.toMatchObject([
      { id: sharedMessageId, content: 'shared-needle only-a' },
    ]);
    await expect(store.search(tenantB, 'shared-session', 'only-a')).resolves.toEqual([]);
    await expect(store.search(wrongTenant, 'shared-session', 'shared-needle')).resolves.toEqual([]);

    await expect(store.listAround(tenantA, 'shared-session', sharedMessageId, { before: 0, after: 1 }))
      .resolves.toMatchObject([{ content: 'shared-needle only-a' }, { content: 'tool-result only-a' }]);
    await expect(store.listAround(wrongTenant, 'shared-session', sharedMessageId)).resolves.toEqual([]);
    await expect(store.listByRun(tenantB, 'shared-session', 'shared-run'))
      .resolves.toMatchObject([{ content: 'shared-needle only-b' }, { content: 'tool-result only-b' }]);
    await expect(store.listByRun(wrongTenant, 'shared-session', 'shared-run')).resolves.toEqual([]);
    await expect(store.listByToolCall(tenantA, 'shared-session', 'shared-tool-call'))
      .resolves.toMatchObject([{ content: 'tool-result only-a' }]);
    await expect(store.listByToolCall(wrongTenant, 'shared-session', 'shared-tool-call')).resolves.toEqual([]);
  });

  it('并发 append 以 terminal delivery 稳定 eventId 命中持久唯一幂等', async () => {
    const { store, prefix } = createStore('event_terminal_idempotency');
    await store.init();
    const tenantId = 'terminal-idempotency-tenant';
    const deliveryId = randomUUID();
    const marker = { terminalDeliveryId: deliveryId };
    const terminalEvents: PlatformEventInput[] = [{
      id: `terminal:${deliveryId}:0`,
      type: 'run_state_changed',
      runId: 'terminal-idempotency-run',
      sessionId: 'terminal-idempotency-session',
      status: 'completed',
      terminalDeliveryIndex: 0,
      ...marker,
    }, {
      id: `terminal:${deliveryId}:1`,
      type: 'run_finished',
      runId: 'terminal-idempotency-run',
      sessionId: 'terminal-idempotency-session',
      subtype: 'success',
      numTurns: 1,
      terminalDeliveryIndex: 1,
      ...marker,
    }] as unknown as PlatformEventInput[];

    const [first, second] = await Promise.all([
      store.appendBatch(terminalEvents, { tenantId }),
      store.appendBatch(terminalEvents, { tenantId }),
    ]);

    expect(first.map((event) => event.id)).toEqual(second.map((event) => event.id));
    const stored = await store.list(tenantId, 'terminal-idempotency-session');
    expect(stored).toHaveLength(2);
    expect(stored.map((event) => event.id)).toEqual([
      `terminal:${deliveryId}:0`,
      `terminal:${deliveryId}:1`,
    ]);
    const rows = await store.pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM ${prefix}_events WHERE tenant_id=$1 AND event_json->>'terminalDeliveryId'=$2`,
      [tenantId, deliveryId],
    );
    expect(rows.rows[0]?.count).toBe('2');
  });

  it('旧 schema 幂等迁移为 LEGACY，保留非目标约束并且不产生重复 cursor', async () => {
    const { store, prefix } = createStore('event_legacy_migration');
    const pool = new Pool({ connectionString: connectionString!, max: 2 });
    try {
      await pool.query(`
        CREATE TABLE ${prefix}_event_cursors (
          session_id TEXT PRIMARY KEY,
          next_sequence BIGINT NOT NULL DEFAULT 1
        )
      `);
      await pool.query(`
        CREATE TABLE ${prefix}_events (
          global_sequence BIGSERIAL PRIMARY KEY,
          session_id TEXT NOT NULL,
          session_sequence BIGINT NOT NULL,
          event_id TEXT NOT NULL UNIQUE,
          event_type TEXT NOT NULL,
          run_id TEXT,
          timestamp TIMESTAMPTZ NOT NULL,
          event_json JSONB NOT NULL,
          UNIQUE(session_id, session_sequence),
          CONSTRAINT ${prefix}_preserve_unique UNIQUE(event_type, timestamp)
        )
      `);
      await pool.query(`
        INSERT INTO ${prefix}_event_cursors (session_id, next_sequence)
        VALUES ('legacy-session', 2)
      `);
      await pool.query(`
        INSERT INTO ${prefix}_events
          (session_id, session_sequence, event_id, event_type, run_id, timestamp, event_json)
        VALUES
          ('legacy-session', 1, 'legacy-event', 'user_message', 'legacy-run',
           '2026-08-24T00:00:00.000Z',
           '{"id":"legacy-event","timestamp":"2026-08-24T00:00:00.000Z","type":"user_message","runId":"legacy-run","sessionId":"legacy-session","content":"legacy-only"}'::jsonb)
      `);

      await store.init();
      await pool.query(`ALTER TABLE ${prefix}_event_cursors ALTER COLUMN tenant_id DROP DEFAULT`);
      await store.init();

      const preserved = await pool.query<{ present: boolean }>(`
        SELECT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = $1::regclass AND conname = $2
        ) AS present
      `, [`${prefix}_events`, `${prefix}_preserve_unique`]);
      expect(preserved.rows[0]?.present).toBe(true);

      const cursors = await pool.query<{ tenant_id: string; session_id: string; next_sequence: string }>(`
        SELECT tenant_id, session_id, next_sequence
        FROM ${prefix}_event_cursors
        WHERE session_id = 'legacy-session'
      `);
      expect(cursors.rows).toEqual([{
        tenant_id: LEGACY_TENANT_ID,
        session_id: 'legacy-session',
        next_sequence: '2',
      }]);
      const duplicateCursorGroups = await pool.query<{ count: string }>(`
        SELECT COUNT(*) AS count
        FROM (
          SELECT tenant_id, session_id
          FROM ${prefix}_event_cursors
          GROUP BY tenant_id, session_id
          HAVING COUNT(*) > 1
        ) duplicates
      `);
      expect(duplicateCursorGroups.rows[0]?.count).toBe('0');
      await expect(store.list(LEGACY_TENANT_ID, 'legacy-session')).resolves.toMatchObject([
        { id: 'legacy-event', content: 'legacy-only' },
      ]);
      await expect(store.list('wrong-tenant', 'legacy-session')).resolves.toEqual([]);

      // rolling deploy 的旧 INSERT 省略 tenant_id 时仍明确落入 LEGACY，而不是新 tenant。
      await pool.query(`
        INSERT INTO ${prefix}_event_cursors (session_id, next_sequence)
        VALUES ('rolling-legacy-session', 2)
      `);
      await pool.query(`
        INSERT INTO ${prefix}_events
          (session_id, session_sequence, event_id, event_type, run_id, timestamp, event_json)
        VALUES
          ('rolling-legacy-session', 1, 'rolling-legacy-event', 'user_message', 'rolling-legacy-run',
           '2026-08-24T00:00:01.000Z',
           '{"id":"rolling-legacy-event","timestamp":"2026-08-24T00:00:01.000Z","type":"user_message","runId":"rolling-legacy-run","sessionId":"rolling-legacy-session","content":"rolling-legacy-only"}'::jsonb)
      `);
      const rollingCursor = await pool.query<{ tenant_id: string }>(`
        SELECT tenant_id FROM ${prefix}_event_cursors WHERE session_id = 'rolling-legacy-session'
      `);
      expect(rollingCursor.rows).toEqual([{ tenant_id: LEGACY_TENANT_ID }]);
      await expect(store.list(LEGACY_TENANT_ID, 'rolling-legacy-session')).resolves.toMatchObject([
        { id: 'rolling-legacy-event', content: 'rolling-legacy-only' },
      ]);
      await expect(store.list('tenant-new', 'rolling-legacy-session')).resolves.toEqual([]);

      const sameIdInNewTenant = await store.append(message('legacy-event', 'new-tenant'), { tenantId: 'tenant-new' });
      expect((sameIdInNewTenant as unknown as { sequence: number }).sequence).toBe(1);
      await expect(store.getById('tenant-new', 'legacy-event')).resolves.toMatchObject({ content: 'shared-needle new-tenant' });
      await expect(store.getById(LEGACY_TENANT_ID, 'legacy-event')).resolves.toMatchObject({ content: 'legacy-only' });
    } finally {
      await pool.end();
    }
  });
});

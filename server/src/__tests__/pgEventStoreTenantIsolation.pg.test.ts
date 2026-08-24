import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { LEGACY_TENANT_ID } from '../data/tenants/types.js';
import { PgEventStore } from '../runtime/pgEventStore.js';

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

function message(id: string, tenantMarker: string, sessionId = 'shared-session') {
  return {
    id,
    type: 'user_message',
    runId: 'shared-run',
    sessionId,
    content: `shared-needle ${tenantMarker}`,
  } as never;
}

function toolResult(id: string, tenantMarker: string, sessionId = 'shared-session') {
  return {
    id,
    type: 'tool_result',
    runId: 'shared-run',
    sessionId,
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

  it('tenant 查询边界不混读相同 runId/toolCallId 的事件', async () => {
    const { store } = createStore('event_tenant_scope');
    await store.init();

    const messageIdA = 'tenant-a-message';
    const toolResultIdA = 'tenant-a-tool-result';
    const messageIdB = 'tenant-b-message';
    const toolResultIdB = 'tenant-b-tool-result';
    const sessionA = 'tenant-a-session';
    const sessionB = 'tenant-b-session';
    const tenantA = 'tenant-a';
    const tenantB = 'tenant-b';
    const wrongTenant = 'tenant-c';

    const appendedA = await store.appendBatch([
      message(messageIdA, 'only-a', sessionA),
      toolResult(toolResultIdA, 'only-a', sessionA),
    ], { tenantId: tenantA });
    const appendedB = await store.appendBatch([
      message(messageIdB, 'only-b', sessionB),
      toolResult(toolResultIdB, 'only-b', sessionB),
    ], { tenantId: tenantB });

    expect(appendedA.map((event) => (event as unknown as { sequence: number }).sequence)).toEqual([1, 2]);
    expect(appendedB.map((event) => (event as unknown as { sequence: number }).sequence)).toEqual([1, 2]);
    expect(appendedA.map((event) => event.id)).toEqual([messageIdA, toolResultIdA]);
    expect(appendedB.map((event) => event.id)).toEqual([messageIdB, toolResultIdB]);

    expect((await store.list(tenantA, sessionA)).map((event) => event.id)).toEqual([messageIdA, toolResultIdA]);
    expect((await store.list(tenantB, sessionB)).map((event) => event.id)).toEqual([messageIdB, toolResultIdB]);
    await expect(store.list(wrongTenant, sessionA)).resolves.toEqual([]);

    const firstPageA = await store.listPage(tenantA, sessionA, { limit: 1 });
    expect(firstPageA.events).toMatchObject([{ id: messageIdA, content: 'shared-needle only-a', sequence: 1 }]);
    expect(firstPageA).toMatchObject({ nextCursor: '1', hasMore: true });
    const secondPageB = await store.listPage(tenantB, sessionB, { afterCursor: '1', limit: 1 });
    expect(secondPageB.events).toMatchObject([{ id: toolResultIdB, content: 'tool-result only-b', sequence: 2 }]);
    await expect(store.listPage(wrongTenant, sessionA, { limit: 10 }))
      .resolves.toMatchObject({ events: [], hasMore: false });

    await expect(store.getById(tenantA, messageIdA)).resolves.toMatchObject({ content: 'shared-needle only-a' });
    await expect(store.getById(tenantB, messageIdB)).resolves.toMatchObject({ content: 'shared-needle only-b' });
    await expect(store.getById(wrongTenant, messageIdA)).resolves.toBeNull();

    await expect(store.search(tenantA, sessionA, 'shared-needle')).resolves.toMatchObject([
      { id: messageIdA, content: 'shared-needle only-a' },
    ]);
    await expect(store.search(tenantB, sessionB, 'only-a')).resolves.toEqual([]);
    await expect(store.search(wrongTenant, sessionA, 'shared-needle')).resolves.toEqual([]);

    await expect(store.listAround(tenantA, sessionA, messageIdA, { before: 0, after: 1 }))
      .resolves.toMatchObject([{ content: 'shared-needle only-a' }, { content: 'tool-result only-a' }]);
    await expect(store.listAround(wrongTenant, sessionA, messageIdA)).resolves.toEqual([]);
    await expect(store.listByRun(tenantB, sessionB, 'shared-run'))
      .resolves.toMatchObject([{ content: 'shared-needle only-b' }, { content: 'tool-result only-b' }]);
    await expect(store.listByRun(wrongTenant, sessionB, 'shared-run')).resolves.toEqual([]);
    await expect(store.listByToolCall(tenantA, sessionA, 'shared-tool-call'))
      .resolves.toMatchObject([{ content: 'tool-result only-a' }]);
    await expect(store.listByToolCall(wrongTenant, sessionA, 'shared-tool-call')).resolves.toEqual([]);
  });

  it('跨 tenant 的全局 ID 碰撞 fail-closed 且不泄露已有事件', async () => {
    const { store } = createStore('event_global_identity');
    await store.init();

    await store.append(message('collision-event', 'only-a', 'collision-session'), { tenantId: 'tenant-a' });
    await expect(store.append(message('collision-event', 'only-b', 'collision-session'), { tenantId: 'tenant-b' }))
      .rejects.toMatchObject({ code: '23505' });

    await expect(store.list('tenant-a', 'collision-session'))
      .resolves.toMatchObject([{ id: 'collision-event', content: 'shared-needle only-a' }]);
    await expect(store.list('tenant-b', 'collision-session')).resolves.toEqual([]);
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
        ON CONFLICT (session_id) DO NOTHING
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

      await expect(store.append(message('legacy-event', 'new-tenant'), { tenantId: 'tenant-new' }))
        .rejects.toMatchObject({ code: '23505' });
      await expect(store.getById('tenant-new', 'legacy-event')).resolves.toBeNull();
      await expect(store.getById(LEGACY_TENANT_ID, 'legacy-event')).resolves.toMatchObject({ content: 'legacy-only' });
    } finally {
      await pool.end();
    }
  });
});

import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgExternalClientStore } from '../externalClients/store.js';
import { PgExternalConversationStore } from './store.js';

const connectionString = process.env.TEST_DATABASE_URL?.trim();
const describePg = connectionString ? describe : describe.skip;
const { Pool } = pg;

describePg('External Agent conversation PostgreSQL contract', () => {
  const prefix = `external_conversation_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let pool: InstanceType<typeof Pool>;
  let clients: PgExternalClientStore;
  let store: PgExternalConversationStore;
  let clientId: string;

  beforeAll(async () => {
    pool = new Pool({
      connectionString: connectionString!,
      connectionTimeoutMillis: 5_000,
      max: 4,
    });
    clients = new PgExternalClientStore(pool, { tablePrefix: prefix });
    await clients.init();
    clientId = (
      await clients.create({
        tenantId: 'tenant-a',
        serviceAccountUserId: 'svc-a',
        name: 'ERP',
        keyHash: 'hash-a',
        keyPrefix: 'ky_ext_a',
        scopes: ['conversations:write', 'executions:read'],
        actorUserId: 'admin-a',
      })
    ).clientId;
    store = new PgExternalConversationStore(pool, { tablePrefix: prefix });
    await Promise.all([store.init(), store.init()]);
  }, 30_000);

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DROP TABLE IF EXISTS ${store.tables.executions}`);
    await pool.query(`DROP TABLE IF EXISTS ${store.tables.conversations}`);
    await pool.query(`DROP TABLE IF EXISTS ${clients.table}`);
    await pool.end();
  });

  it('persists idempotent conversation and execution bindings without duplicate runs', async () => {
    const first = await store.createConversation({
      clientId,
      tenantId: 'tenant-a',
      serviceAccountUserId: 'svc-a',
      externalConversationId: 'external-1',
      agentId: 'oa-1',
      metadata: { order: 'SO-1' },
      idempotencyKey: 'conversation-request-1',
      requestHash: 'conversation-hash-1',
    });
    expect(first.outcome).toBe('created');
    const replay = await store.createConversation({
      clientId,
      tenantId: 'tenant-a',
      serviceAccountUserId: 'svc-a',
      externalConversationId: 'external-1',
      agentId: 'oa-1',
      metadata: { order: 'SO-1' },
      idempotencyKey: 'conversation-request-1',
      requestHash: 'conversation-hash-1',
    });
    expect(replay).toMatchObject({
      outcome: 'replay',
      record: { conversationId: first.record.conversationId, agentId: 'oa-1' },
    });

    const execution = await store.reserveExecution({
      conversation: first.record,
      idempotencyKey: 'message-request-1',
      requestHash: 'message-hash-1',
      requestedReasoningEffort: 'high',
    });
    expect(execution).toMatchObject({
      outcome: 'created',
      record: { submissionStatus: 'submitting' },
    });
    const accepted = await store.bindAcceptedExecution({
      executionId: execution.record.executionId,
      conversationId: first.record.conversationId,
      sessionId: 'session-1',
      runId: 'run-1',
    });
    expect(accepted).toMatchObject({
      submissionStatus: 'accepted',
      sessionId: 'session-1',
      runId: 'run-1',
    });
    expect(await store.getConversation(first.record.conversationId)).toMatchObject({
      sessionId: 'session-1',
    });

    await expect(
      store.bindAcceptedExecution({
        executionId: execution.record.executionId,
        conversationId: first.record.conversationId,
        sessionId: 'session-other',
        runId: 'run-other',
      }),
    ).resolves.toBeUndefined();
  });

  it('creates tenant lookup, idempotency and partial identity indexes', async () => {
    const result = await pool.query<{ table_name: string; index_count: number }>(
      `SELECT relname AS table_name,
              (SELECT count(*)::int FROM pg_index WHERE indrelid=c.oid) AS index_count
       FROM pg_class c WHERE c.relname = ANY($1::text[]) ORDER BY relname`,
      [[store.tables.conversations, store.tables.executions]],
    );
    expect(result.rows).toEqual([
      { table_name: store.tables.conversations, index_count: 5 },
      { table_name: store.tables.executions, index_count: 5 },
    ]);
  });
});

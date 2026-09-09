import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PgAgentDwsMessageStore } from '../data/agentDwsMessages/store.js';
import {
  claimNextDeliveryIntent,
  reconcileUnknownDelivery,
} from '../data/orgGroupAgents/deliveryClaims.js';

const { Pool } = pg;
const testPgUrl = process.env.TEST_DATABASE_URL?.trim();
const describePg = testPgUrl ? describe : describe.skip;

describePg('DWS inbox/outbox 恢复 PostgreSQL 组合', () => {
  const prefix = `dws_delivery_recovery_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const inbox = `${prefix}_agent_dws_event_inbox`;
  const deliveries = `${prefix}_deliveries`;
  const workOrders = `${prefix}_work_orders`;
  const attempts = `${prefix}_attempts`;
  let pool: InstanceType<typeof Pool>;

  beforeAll(async () => {
    pool = new Pool({ connectionString: testPgUrl!, connectionTimeoutMillis: 5_000, max: 2 });
    await pool.query(`
      CREATE TABLE ${inbox} (
        inbox_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, account_id TEXT NOT NULL,
        event_id TEXT NOT NULL, event_type TEXT NOT NULL, conversation_id TEXT NOT NULL,
        message_id TEXT, sender_open_dingtalk_id TEXT, content TEXT NOT NULL,
        event_timestamp TIMESTAMPTZ, payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        work_conversation_id TEXT, state TEXT NOT NULL, session_id TEXT, run_id TEXT,
        response_text TEXT, reply_started_at TIMESTAMPTZ, attempt INTEGER NOT NULL,
        max_attempts INTEGER NOT NULL, lease_owner TEXT, lease_fence INTEGER NOT NULL,
        lease_expires_at TIMESTAMPTZ, next_attempt_at TIMESTAMPTZ, last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      );
      CREATE TABLE ${deliveries} (
        delivery_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, inbox_id TEXT,
        account_id TEXT NOT NULL, account_profile_id TEXT, account_corp_id TEXT,
        account_dingtalk_user_id TEXT, account_identity_updated_at TIMESTAMPTZ,
        conversation_id TEXT NOT NULL, agent_id TEXT, binding_id TEXT,
        conversation_space_id TEXT, work_conversation_id TEXT, policy_revision INTEGER,
        visibility TEXT, source_work_order_id TEXT, source_attempt_id TEXT,
        source TEXT NOT NULL, delivery_kind TEXT NOT NULL, disposition TEXT NOT NULL,
        delivery_state TEXT NOT NULL, destination_json JSONB NOT NULL, content TEXT NOT NULL,
        idempotency_key TEXT NOT NULL, provider_receipt_json JSONB, attempt INTEGER NOT NULL,
        lease_owner TEXT, lease_fence INTEGER NOT NULL, lease_expires_at TIMESTAMPTZ,
        provider_attempt_phase TEXT NOT NULL, provider_started_at TIMESTAMPTZ,
        next_attempt_at TIMESTAMPTZ, last_attempt_at TIMESTAMPTZ, last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      );
      CREATE TABLE ${workOrders} (
        tenant_id TEXT NOT NULL, work_order_id TEXT PRIMARY KEY,
        current_attempt_no INTEGER NOT NULL, state TEXT NOT NULL
      );
      CREATE TABLE ${attempts} (
        tenant_id TEXT NOT NULL, work_order_id TEXT NOT NULL, attempt_id TEXT PRIMARY KEY,
        attempt_no INTEGER NOT NULL, status TEXT NOT NULL
      );
    `);
  }, 30_000);

  afterAll(async () => {
    if (!pool) return;
    try {
      await pool.query(`DROP TABLE IF EXISTS ${attempts},${workOrders},${deliveries},${inbox}`);
    } finally {
      await pool.end();
    }
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE ${attempts},${workOrders},${deliveries},${inbox}`);
  });

  it('confirmed_not_sent 由 outbox 重新领取原正文，inbox 不再重跑业务', async () => {
    await insertInbox({
      inboxId: 'inbox-recover',
      state: 'dead_letter',
      attempt: 3,
      maxAttempts: 8,
      responseText: '原始最终正文',
      disposition: 'delivery_unknown',
    });
    await insertDelivery({
      deliveryId: 'delivery-recover',
      inboxId: 'inbox-recover',
      state: 'unknown',
      content: '原始最终正文',
      idempotencyKey: 'stable-final-key',
    });

    await reconcileUnknownDelivery(
      pool,
      { deliveries, inbox },
      {
        tenantId: 'tenant-a',
        deliveryId: 'delivery-recover',
        actorId: 'admin-a',
        reason: 'provider audit confirmed not sent',
        evidence: { ticket: 'ticket-a' },
        outcome: 'confirmed_not_sent',
      },
    );

    const inbound = await pool.query<{ state: string; disposition: string }>(
      `SELECT state,payload_json->>'disposition' AS disposition FROM ${inbox}
       WHERE inbox_id='inbox-recover'`,
    );
    expect(inbound.rows[0]).toEqual({
      state: 'completed',
      disposition: 'delivery_recovery_pending',
    });
    const claimed = await claimNextDeliveryIntent(
      pool,
      { deliveries, inbox, workOrders, attempts },
      'outbox-worker',
      60_000,
    );
    expect(claimed).toMatchObject({
      deliveryId: 'delivery-recover',
      deliveryState: 'sending',
      content: '原始最终正文',
      idempotencyKey: 'stable-final-key',
    });
  });

  it('confirmed_sent 终结 inbox 且不会再次被 outbox 领取', async () => {
    await insertInbox({
      inboxId: 'inbox-sent',
      state: 'dead_letter',
      attempt: 2,
      maxAttempts: 8,
      responseText: '已经送达的正文',
      disposition: 'delivery_unknown',
    });
    await insertDelivery({
      deliveryId: 'delivery-sent',
      inboxId: 'inbox-sent',
      state: 'unknown',
      content: '已经送达的正文',
      idempotencyKey: 'stable-sent-key',
    });

    await reconcileUnknownDelivery(
      pool,
      { deliveries, inbox },
      {
        tenantId: 'tenant-a',
        deliveryId: 'delivery-sent',
        actorId: 'admin-a',
        reason: 'provider audit confirmed sent',
        evidence: { messageId: 'msg-a' },
        outcome: 'confirmed_sent',
      },
    );

    const stored = await pool.query<{ delivery_state: string; inbox_state: string }>(`
      SELECT delivery.delivery_state,inbound.state AS inbox_state
      FROM ${deliveries} delivery JOIN ${inbox} inbound ON inbound.inbox_id=delivery.inbox_id
      WHERE delivery.delivery_id='delivery-sent'
    `);
    expect(stored.rows[0]).toEqual({ delivery_state: 'sent', inbox_state: 'completed' });
    await expect(
      claimNextDeliveryIntent(
        pool,
        { deliveries, inbox, workOrders, attempts },
        'outbox-worker',
        60_000,
      ),
    ).resolves.toBeNull();
  });

  it('执行重试耗尽后固化失败正文，并以 reply_pending 交给回复链而非再次 dispatch', async () => {
    await insertInbox({
      inboxId: 'inbox-exhausted',
      state: 'processing',
      attempt: 3,
      maxAttempts: 3,
      leaseOwner: 'router-worker',
      leaseFence: 7,
    });
    const messageStore = new PgAgentDwsMessageStore(pool, prefix);

    const failed = await messageStore.fail(
      'inbox-exhausted',
      'router-worker',
      7,
      new Error('runtime retries exhausted'),
      0,
    );
    expect(failed).toMatchObject({
      state: 'reply_pending',
      disposition: 'execution_failed',
      responseText: expect.stringContaining('这次处理未能完成'),
    });

    const claimed = await messageStore.claimNext('reply-worker', 60_000);
    expect(claimed).toMatchObject({
      inboxId: 'inbox-exhausted',
      state: 'reply_pending',
      disposition: 'execution_failed',
      responseText: failed.responseText,
    });
    expect(claimed?.runId).toBe('run-inbox-exhausted');
  });

  it('失败终态有独立有限投递预算，耗尽后保留固定正文和明确诊断状态', async () => {
    await insertInbox({
      inboxId: 'inbox-terminal-budget',
      state: 'processing',
      attempt: 3,
      maxAttempts: 3,
      leaseOwner: 'business-worker',
      leaseFence: 1,
    });
    const messageStore = new PgAgentDwsMessageStore(pool, prefix);
    let current = await messageStore.fail(
      'inbox-terminal-budget',
      'business-worker',
      1,
      new Error('business exhausted'),
      0,
    );
    const fixedText = current.responseText;

    for (let terminalAttempt = 1; terminalAttempt <= 3; terminalAttempt += 1) {
      const claimed = await messageStore.claimNext(`reply-worker-${terminalAttempt}`, 60_000);
      expect(claimed).toMatchObject({
        inboxId: 'inbox-terminal-budget',
        responseText: fixedText,
      });
      current = await messageStore.fail(
        claimed!.inboxId,
        `reply-worker-${terminalAttempt}`,
        claimed!.leaseFence,
        new Error(`transient-before-outbox-${terminalAttempt}`),
        0,
      );
      if (terminalAttempt < 3) {
        expect(current).toMatchObject({
          state: 'reply_pending',
          disposition: 'execution_failed',
          responseText: fixedText,
        });
      }
    }

    expect(current).toMatchObject({
      state: 'dead_letter',
      disposition: 'execution_failure_delivery_exhausted',
      responseText: fixedText,
    });
  });

  async function insertInbox(input: {
    inboxId: string;
    state: string;
    attempt: number;
    maxAttempts: number;
    responseText?: string;
    disposition?: string;
    leaseOwner?: string;
    leaseFence?: number;
  }): Promise<void> {
    await pool.query(
      `INSERT INTO ${inbox} (
      inbox_id,tenant_id,account_id,event_id,event_type,conversation_id,
      sender_open_dingtalk_id,content,payload_json,state,session_id,run_id,response_text,
      attempt,max_attempts,lease_owner,lease_fence,lease_expires_at,last_error,completed_at
    ) VALUES ($1,'tenant-a','account-a',$2,'user_im_message_receive_o2o_all','direct-a',
      'peer-a','请处理',$3::jsonb,$4,'session-a',$5,$6,$7,$8,$9,$10,
      CASE WHEN $9::text IS NULL THEN NULL ELSE NOW()+INTERVAL '10 minutes' END,
      CASE WHEN $4='dead_letter' THEN 'AGENT_DWS_REPLY_DELIVERY_UNKNOWN' ELSE NULL END,
      CASE WHEN $4='dead_letter' THEN NOW() ELSE NULL END
    )`,
      [
        input.inboxId,
        `event-${input.inboxId}`,
        JSON.stringify(
          input.disposition ? { disposition: input.disposition, replyKind: 'normal' } : {},
        ),
        input.state,
        `run-${input.inboxId}`,
        input.responseText ?? null,
        input.attempt,
        input.maxAttempts,
        input.leaseOwner ?? null,
        input.leaseFence ?? 0,
      ],
    );
  }

  async function insertDelivery(input: {
    deliveryId: string;
    inboxId: string;
    state: string;
    content: string;
    idempotencyKey: string;
  }): Promise<void> {
    await pool.query(
      `INSERT INTO ${deliveries} (
      delivery_id,tenant_id,inbox_id,account_id,conversation_id,source,delivery_kind,
      disposition,delivery_state,destination_json,content,idempotency_key,attempt,lease_fence,
      provider_attempt_phase,provider_started_at,completed_at
    ) VALUES ($1,'tenant-a',$2,'account-a','direct-a','command','front_reply','replied',$3,
      $4::jsonb,$5,$6,1,2,'provider_started',NOW(),NOW())`,
      [
        input.deliveryId,
        input.inboxId,
        input.state,
        JSON.stringify({
          provider: 'dingtalk',
          accountId: 'account-a',
          conversationId: 'direct-a',
          kind: 'direct',
          peerOpenId: 'peer-a',
        }),
        input.content,
        input.idempotencyKey,
      ],
    );
  }
});

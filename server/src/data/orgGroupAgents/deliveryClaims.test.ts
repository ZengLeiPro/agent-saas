import { describe, expect, it, vi } from 'vitest';

import {
  cancelUnstartedDeliveryIntentsForInbox,
  getReplyRecoveryStateForInbox,
  reconcileUnknownDelivery,
} from './deliveryClaims.js';

describe('getReplyRecoveryStateForInbox', () => {
  it.each(['none', 'unstarted', 'sent', 'unknown'] as const)(
    'returns the durable recovery classification %s',
    async recoveryState => {
      const query = vi.fn().mockResolvedValue({
        rows: [{ recovery_state: recoveryState }],
      });

      await expect(getReplyRecoveryStateForInbox(
        { query } as never,
        'gov_agent_dws_delivery_intents',
        'tenant-a',
        'inbox-a',
      )).resolves.toBe(recoveryState);

      const [sql, values] = query.mock.calls[0]!;
      expect(String(sql)).toContain("delivery_kind='front_reply'");
      expect(String(sql)).toContain("delivery_state='unknown'");
      expect(String(sql)).toContain("provider_attempt_phase='before_provider'");
      expect(String(sql)).toContain("provider_attempt_phase='provider_started'");
      expect(String(sql)).toContain("delivery_state='sent'");
      expect(String(sql)).toContain("LIKE 'ORG_AGENT_PROVIDER_AUTHORIZATION_%'");
      expect(values).toEqual(['tenant-a', 'inbox-a']);
    },
  );

  it('隔离无法证明未出站的 legacy delivery，而不是把它取消成安全未发送', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 2 });

    await expect(cancelUnstartedDeliveryIntentsForInbox(
      { query } as never, 'deliveries', 'tenant-a', 'inbox-a', 'revoked',
    )).resolves.toBe(2);

    const sql = String(query.mock.calls[0]![0]);
    expect(sql).toContain("provider_attempt_phase='before_provider'");
    expect(sql).toContain("THEN 'dead_letter' ELSE 'unknown'");
    expect(sql).toContain("delivery_state IN ('pending','sending')");
  });

  it('aggregate row 意外缺失时回退为 none', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });

    await expect(getReplyRecoveryStateForInbox(
      { query } as never,
      'gov_agent_dws_delivery_intents',
      'tenant-a',
      'inbox-a',
    )).resolves.toBe('none');
  });

  it.each([
    ['confirmed_not_sent', 'pending', 'delivery_recovery_pending'],
    ['confirmed_sent', 'sent', 'replied'],
  ] as const)('原子核对 %s 时同步终结 inbox 且保留原投递正文', async (
    outcome,
    deliveryState,
    inboxDisposition,
  ) => {
    const row = deliveryRow({ delivery_state: deliveryState });
    const query = vi.fn(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] };
      if (sql.includes('UPDATE deliveries')) return { rows: [row] };
      if (sql.includes('UPDATE inbox')) return { rows: [{ inbox_id: 'inbox-a' }] };
      throw new Error(`unexpected SQL: ${sql}`);
    });
    const client = { query, release: vi.fn() };

    const reconciled = await reconcileUnknownDelivery(
      { connect: vi.fn(async () => client) } as never,
      { deliveries: 'deliveries', inbox: 'inbox' },
      {
        tenantId: 'tenant-a', deliveryId: 'delivery-a', actorId: 'admin-a',
        reason: 'provider log checked', evidence: { ticket: 'ticket-a' }, outcome,
      },
    );

    expect(reconciled).toMatchObject({
      deliveryState,
      content: '原始最终正文',
      idempotencyKey: 'stable-key',
    });
    const inboxSql = String(query.mock.calls.find(call => String(call[0]).includes('UPDATE inbox'))?.[0]);
    expect(inboxSql).toContain("SET state='completed'");
    expect(inboxSql).toContain("payload_json->>'disposition'='delivery_unknown'");
    expect(inboxSql).toContain(inboxDisposition);
    expect(query.mock.calls.at(-1)?.[0]).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('关联 inbox 不再处于 unknown 终态时回滚核对，避免拆裂两个状态机', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('UPDATE deliveries')) return { rows: [deliveryRow()] };
      if (sql.includes('UPDATE inbox')) return { rows: [] };
      throw new Error(`unexpected SQL: ${sql}`);
    });
    const client = { query, release: vi.fn() };

    await expect(reconcileUnknownDelivery(
      { connect: vi.fn(async () => client) } as never,
      { deliveries: 'deliveries', inbox: 'inbox' },
      {
        tenantId: 'tenant-a', deliveryId: 'delivery-a', actorId: 'admin-a',
        reason: 'checked', evidence: {}, outcome: 'confirmed_not_sent',
      },
    )).rejects.toThrow('DWS_DELIVERY_INBOX_NOT_RECONCILABLE');

    expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });
});

function deliveryRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    delivery_id: 'delivery-a', tenant_id: 'tenant-a', inbox_id: 'inbox-a',
    account_id: 'account-a', conversation_id: 'conversation-a', source: 'command',
    delivery_kind: 'front_reply', disposition: 'replied', delivery_state: 'pending',
    destination_json: {
      provider: 'dingtalk', accountId: 'account-a', conversationId: 'conversation-a',
      kind: 'direct', peerOpenId: 'open-a',
    },
    content: '原始最终正文', idempotency_key: 'stable-key', attempt: 1,
    lease_fence: 3, provider_attempt_phase: 'provider_started',
    created_at: new Date('2026-09-08T00:00:00.000Z'),
    updated_at: new Date('2026-09-08T00:00:01.000Z'),
    ...overrides,
  };
}

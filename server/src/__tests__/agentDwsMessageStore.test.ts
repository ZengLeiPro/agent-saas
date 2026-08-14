import { describe, expect, it, vi } from 'vitest';

import {
  AgentDwsMessageInvariantError,
  PgAgentDwsMessageStore,
} from '../data/agentDwsMessages/index.js';

const NOW = '2026-08-14T00:00:00.000Z';

function inboxRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    inbox_id: 'adwsi-1',
    tenant_id: 'tenant-1',
    account_id: 'account-1',
    event_id: 'event-1',
    event_type: 'chatbot_message',
    conversation_id: 'conversation-1',
    message_id: 'message-1',
    sender_open_dingtalk_id: 'sender-1',
    content: 'hello',
    event_timestamp: new Date(NOW),
    payload_json: { normalized: true },
    state: 'pending',
    session_id: null,
    run_id: null,
    response_text: null,
    reply_started_at: null,
    attempt: 0,
    max_attempts: 8,
    lease_owner: null,
    lease_fence: 0,
    lease_expires_at: null,
    next_attempt_at: new Date(NOW),
    last_error: null,
    created_at: NOW,
    updated_at: new Date(NOW),
    completed_at: null,
    ...overrides,
  };
}

const event = {
  tenantId: 'tenant-1',
  accountId: 'account-1',
  eventId: 'event-1',
  eventType: 'chatbot_message',
  conversationId: 'conversation-1',
  messageId: 'message-1',
  senderOpenDingtalkId: 'sender-1',
  content: 'hello',
  eventTimestamp: NOW,
};

describe('PgAgentDwsMessageStore', () => {
  it('ingest 以 account/event 幂等并返回 created，同时剥离超大 raw 为合法 JSON 对象', async () => {
    const query = vi.fn(async (_sql: string, values: unknown[]) => ({
      rows: [inboxRow({ payload_json: JSON.parse(String(values[10])), created: query.mock.calls.length === 1 })],
    }));
    const store = new PgAgentDwsMessageStore({ query } as never, 'gov');
    const payload = { normalized: { text: 'hello' }, raw: 'x'.repeat(300_000) };

    const first = await store.ingest(event, payload);
    const second = await store.ingest(event, payload);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(first.record.payload).toEqual({ normalized: { text: 'hello' }, _rawOmitted: true });
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain('ON CONFLICT (account_id,event_id) DO UPDATE');
    expect(sql).toContain('(xmax=0) AS created');
    expect(Buffer.byteLength(String(query.mock.calls[0]?.[1]?.[10]), 'utf8')).toBeLessThanOrEqual(262_144);
  });

  it('超大无 raw payload 硬截为可解析 JSON 对象而非非法 JSON 文本', async () => {
    const query = vi.fn(async (_sql: string, values: unknown[]) => ({
      rows: [inboxRow({ payload_json: String(values[10]), created: true })],
    }));
    const store = new PgAgentDwsMessageStore({ query } as never);

    const result = await store.ingest(event, { body: '中'.repeat(200_000) });
    const serialized = String(query.mock.calls[0]?.[1]?.[10]);

    expect(() => JSON.parse(serialized)).not.toThrow();
    expect(result.record.payload).toMatchObject({ _truncated: true });
    expect(Array.isArray(result.record.payload)).toBe(false);
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThan(262_144);
  });

  it('claim 在事务 CTE 中使用 SKIP LOCKED、过期恢复及同账号会话门禁并递增 fence/attempt', async () => {
    const claimed = inboxRow({
      state: 'processing', attempt: 2, lease_owner: 'worker-1', lease_fence: 3,
      lease_expires_at: '2026-08-14T00:00:30.000Z', next_attempt_at: null,
    });
    const clientQuery = vi.fn(async (sql: string) => (
      sql.includes('RETURNING inbox.*') ? { rows: [claimed] } : { rows: [] }
    ));
    const client = { query: clientQuery, release: vi.fn() };
    const store = new PgAgentDwsMessageStore({ connect: async () => client } as never);

    await expect(store.claimNext('worker-1', 30_000)).resolves.toMatchObject({
      state: 'processing', attempt: 2, leaseFence: 3,
    });

    const sql = clientQuery.mock.calls.map(call => String(call[0])).join('\n');
    expect(clientQuery.mock.calls[0]?.[0]).toBe('BEGIN');
    expect(sql).toContain('FOR UPDATE OF item SKIP LOCKED');
    expect(sql).toContain("item.state='retry_wait' AND item.next_attempt_at <= NOW()");
    expect(sql).toContain("item.state='reply_pending'");
    expect(sql).toContain("item.state='processing' AND item.lease_expires_at <= NOW()");
    expect(sql).toContain('active.account_id=item.account_id');
    expect(sql).toContain('active.conversation_id=item.conversation_id');
    expect(sql).toContain("active.state='processing'");
    expect(sql).toContain("earlier.state IN ('pending','processing','retry_wait','reply_pending')");
    expect(sql).toContain('lease_fence=inbox.lease_fence+1');
    expect(sql).toContain('attempt=inbox.attempt+1');
    expect(clientQuery.mock.calls.at(-1)?.[0]).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('binding 并发 upsert 总是返回数据库 winner session', async () => {
    const winner = {
      binding_id: 'binding-winner', tenant_id: 'tenant-1', account_id: 'account-1',
      conversation_id: 'conversation-1', session_id: 'session-winner',
      created_at: new Date(NOW), updated_at: NOW,
    };
    const query = vi.fn().mockResolvedValue({ rows: [winner] });
    const store = new PgAgentDwsMessageStore({ query } as never, 'gov');

    const [first, second] = await Promise.all([
      store.getOrCreateBinding('tenant-1', 'account-1', 'conversation-1', 'session-a'),
      store.getOrCreateBinding('tenant-1', 'account-1', 'conversation-1', 'session-b'),
    ]);

    expect(first.sessionId).toBe('session-winner');
    expect(second.sessionId).toBe('session-winner');
    expect(String(query.mock.calls[0]?.[0])).toContain(
      'ON CONFLICT (account_id,conversation_id) DO UPDATE',
    );
  });

  it('状态写入均校验 owner/fence/有效 lease，状态与 Date/string 正确映射', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [inboxRow({
        state: 'reply_pending', response_text: '', lease_owner: 'worker-1', lease_fence: 7,
        lease_expires_at: new Date('2026-08-14T00:01:00.000Z'), next_attempt_at: null,
      })] })
      .mockResolvedValueOnce({ rows: [] });
    const store = new PgAgentDwsMessageStore({ query } as never);

    const saved = await store.saveDispatchResult('adwsi-1', 'worker-1', 7, '');
    expect(saved).toMatchObject({
      state: 'reply_pending', responseText: '', leaseFence: 7,
      eventTimestamp: NOW, createdAt: NOW, updatedAt: NOW,
    });
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("SET state='reply_pending'");
    expect(sql).toContain('lease_owner=$2 AND lease_fence=$3');
    expect(sql).toContain('lease_expires_at > NOW()');

    await expect(store.complete('adwsi-1', 'stale-worker', 6))
      .rejects.toEqual(expect.objectContaining<Partial<AgentDwsMessageInvariantError>>({
        code: 'AGENT_DWS_MESSAGE_LEASE_LOST',
      }));
  });

  it('续租、首次回复时间与 active run defer 都受同一 fence 保护', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ inbox_id: 'adwsi-1' }] })
      .mockResolvedValueOnce({ rows: [inboxRow({
        state: 'reply_pending', reply_started_at: new Date(NOW),
        lease_owner: 'worker-1', lease_fence: 7,
      })] })
      .mockResolvedValueOnce({ rows: [inboxRow({
        state: 'retry_wait', attempt: 1, next_attempt_at: new Date(NOW),
        lease_owner: null, lease_expires_at: null, lease_fence: 7,
      })] });
    const store = new PgAgentDwsMessageStore({ query } as never);

    await expect(store.renewLease('adwsi-1', 'worker-1', 7, 60_000)).resolves.toBe(true);
    await expect(store.markReplyAttemptStarted('adwsi-1', 'worker-1', 7)).resolves.toMatchObject({
      replyStartedAt: NOW,
    });
    await expect(store.defer('adwsi-1', 'worker-1', 7, 30_000, 'run still active')).resolves.toMatchObject({
      state: 'retry_wait', attempt: 1,
    });

    const sql = query.mock.calls.map(call => String(call[0])).join('\n');
    expect(sql).toContain("state IN ('processing','reply_pending')");
    expect(sql).toContain('reply_started_at=COALESCE(reply_started_at,NOW())');
    expect(sql).toContain('attempt=GREATEST(attempt-1,0)');
    expect(sql).toContain('lease_owner=$2 AND lease_fence=$3');
  });

  it('fail 到达 maxAttempts 转 dead_letter，否则指数/受控 retry，错误脱敏至 500 字且保留响应', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [inboxRow({
      state: 'dead_letter', attempt: 8, max_attempts: 8, lease_owner: null,
      lease_fence: 9, lease_expires_at: null, next_attempt_at: null,
      response_text: 'durable response', last_error: 'authorization=[REDACTED]',
      completed_at: new Date(NOW),
    })] });
    const store = new PgAgentDwsMessageStore({ query } as never);
    const secret = `authorization: Bearer private-token ${'x'.repeat(800)}`;

    const failed = await store.fail('adwsi-1', 'worker-1', 9, secret, 5_000);

    expect(failed).toMatchObject({
      state: 'dead_letter', responseText: 'durable response', completedAt: NOW,
    });
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("attempt>=max_attempts THEN 'dead_letter'");
    expect(sql).toContain("ELSE 'retry_wait'");
    expect(sql).toContain('POWER(2,LEAST(attempt-1,8))');
    expect(sql).not.toContain('response_text=NULL');
    const persistedError = String(query.mock.calls[0]?.[1]?.[3]);
    expect(persistedError).not.toContain('private-token');
    expect(persistedError.length).toBeLessThanOrEqual(500);
  });
});

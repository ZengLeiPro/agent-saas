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

  it('claim 在事务 CTE 中使用 SKIP LOCKED、过期恢复及同账号会话门禁，且只为旧 v1 保留 reply_pending', async () => {
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
    expect(sql).toContain('item.next_attempt_at IS NULL OR item.next_attempt_at <= NOW()');
    expect(sql).toContain("item.state='processing' AND item.lease_expires_at <= NOW()");
    expect(sql).toContain('active.account_id=item.account_id');
    expect(sql).toContain('active.conversation_id=item.conversation_id');
    expect(sql).toContain("active.state='processing'");
    expect(sql).toContain("earlier.state IN ('pending','processing','retry_wait','reply_pending')");
    expect(sql).toContain('lease_fence=inbox.lease_fence+1');
    expect(sql).toContain("WHEN inbox.state='reply_pending' THEN 'reply_pending'");
    expect(sql).not.toContain("inbox.payload_json->>'schemaVersion'='1'");
    expect(sql).toContain('attempt=inbox.attempt+1');
    expect(clientQuery.mock.calls.at(-1)?.[0]).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('v1 身份可证明时忽略普通 revision 变化并按身份时间原子补 pin', async () => {
    const pinned = inboxRow({
      payload_json: {
        schemaVersion: 1,
        accountIdentity: { profileId: 'corp-1:user-1', corpId: 'corp-1', dingtalkUserId: 'user-1' },
      },
      state: 'processing', lease_owner: 'worker-1', lease_fence: 3,
      lease_expires_at: new Date('2026-08-14T00:01:00.000Z'), next_attempt_at: null,
    });
    const query = vi.fn().mockResolvedValue({ rows: [pinned] });
    const store = new PgAgentDwsMessageStore({ query } as never, 'gov');

    await expect(store.pinLegacyIdentityOrTerminate('adwsi-1', 'worker-1', 3, {
      profileId: 'corp-1:user-1',
      corpId: 'corp-1',
      dingtalkUserId: 'user-1',
    })).resolves.toMatchObject({
      state: 'processing',
      payload: { accountIdentity: { profileId: 'corp-1:user-1' } },
      leaseFence: 3,
    });

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain('FROM gov_agent_dws_accounts account');
    expect(sql).toContain("account.status='active'");
    expect(sql).not.toContain('account.revision=');
    expect(sql).toContain('account.identity_updated_at <= inbox.created_at');
    expect(sql).toContain("inbox.payload_json->>'schemaVersion'='1'");
    expect(sql).toContain("NOT (inbox.payload_json ? 'accountIdentity')");
    expect(sql).toContain('inbox.lease_owner=$2 AND inbox.lease_fence=$3');
    expect(query.mock.calls[0]?.[1]).toEqual([
      'adwsi-1', 'worker-1', 3, 'corp-1:user-1', 'corp-1', 'user-1',
      'DWS_INBOX_V1_IDENTITY_UNPROVABLE',
    ]);
  });

  it('v1 身份不可证明时原子执行一次终结，并清 lease/next attempt、保留稳定诊断码', async () => {
    const terminal = inboxRow({
      payload_json: { schemaVersion: 1 }, state: 'dead_letter', lease_owner: null,
      lease_fence: 3, lease_expires_at: null, next_attempt_at: null,
      last_error: 'DWS_INBOX_V1_IDENTITY_UNPROVABLE', completed_at: new Date(NOW),
    });
    const query = vi.fn().mockResolvedValue({ rows: [terminal] });
    const store = new PgAgentDwsMessageStore({ query } as never, 'gov');

    await expect(store.pinLegacyIdentityOrTerminate('adwsi-1', 'worker-1', 3))
      .resolves.toMatchObject({
        state: 'dead_letter',
        lastError: 'DWS_INBOX_V1_IDENTITY_UNPROVABLE',
        completedAt: NOW,
      });

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("state=CASE WHEN decision.provable THEN inbox.state ELSE 'dead_letter' END");
    expect(sql).toContain('lease_owner=CASE WHEN decision.provable THEN inbox.lease_owner ELSE NULL END');
    expect(sql).toContain('next_attempt_at=CASE WHEN decision.provable THEN inbox.next_attempt_at ELSE NULL END');
    expect(query.mock.calls[0]?.[1]?.slice(3, 6)).toEqual([null, null, null]);
  });

  it('停机释放 processing 或旧 v1 reply claim 时保持可恢复状态并回退 attempt', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [inboxRow({ state: 'pending', attempt: 0 })] })
      .mockResolvedValueOnce({ rows: [inboxRow({ state: 'reply_pending', attempt: 1 })] });
    const store = new PgAgentDwsMessageStore({ query } as never, 'gov');

    await expect(store.releaseClaim('inbox-1', 'worker-1', 3)).resolves.toMatchObject({
      state: 'pending', attempt: 0,
    });
    await expect(store.releaseClaim('inbox-2', 'worker-1', 4)).resolves.toMatchObject({
      state: 'reply_pending', attempt: 1,
    });

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("state=CASE WHEN state='reply_pending' THEN 'reply_pending' ELSE 'pending' END");
    expect(sql).toContain("WHERE inbox_id=$1 AND state IN ('processing','reply_pending')");
    expect(sql).toContain('lease_owner=$2 AND lease_fence=$3 AND lease_expires_at > NOW()');
    expect(query.mock.calls[0]?.[1]).toEqual(['inbox-1', 'worker-1', 3]);
    expect(query.mock.calls[1]?.[1]).toEqual(['inbox-2', 'worker-1', 4]);
  });

  it('未提供身份过滤时按租户和账号读取诊断 inbox，并限制页大小', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [inboxRow({ state: 'retry_wait', attempt: 2 })] });
    const store = new PgAgentDwsMessageStore({ query } as never, 'gov');

    const records = await store.listForAccount('tenant-1', 'account-1', 999);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ state: 'retry_wait', attempt: 2 });
    expect(String(query.mock.calls[0]?.[0])).toContain('WHERE tenant_id=$1 AND account_id=$2');
    expect(query.mock.calls[0]?.[1]).toEqual(['tenant-1', 'account-1', 100]);
  });

  it('群观测列表在 SQL limit 前按当前精确身份和身份纪元过滤', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const store = new PgAgentDwsMessageStore({ query } as never, 'gov');
    const identity = {
      profileId: 'corp-1:user-1', corpId: 'corp-1', dingtalkUserId: 'user-1',
      identityUpdatedAt: '2026-09-04T00:00:00.000Z',
    };

    await store.listForAccount('tenant-1', 'account-1', 100, identity);

    const [sql, values] = query.mock.calls[0]!;
    expect(String(sql)).toContain('created_at >= $4::timestamptz');
    expect(String(sql)).toContain("payload_json->'accountIdentity'->>'dingtalkUserId'=$7");
    expect(values).toEqual([
      'tenant-1', 'account-1', 100, identity.identityUpdatedAt,
      identity.profileId, identity.corpId, identity.dingtalkUserId,
    ]);
  });

  it('审批定位读取账号全部活跃 inbox，不受诊断页 100 条窗口限制', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [inboxRow({ state: 'retry_wait' })] });
    const store = new PgAgentDwsMessageStore({ query } as never, 'gov');

    await expect(store.listActiveForAccount('tenant-1', 'account-1')).resolves.toHaveLength(1);

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("state IN ('pending','processing','retry_wait','reply_pending')");
    expect(sql).not.toContain('LIMIT');
    expect(query.mock.calls[0]?.[1]).toEqual(['tenant-1', 'account-1']);
  });

  it('binding 先与 legacy writer 汇合，再按 requester 隔离后续成员', async () => {
    let requesterBindingCount = 0;
    const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] };
      if (sql.includes('gov_agent_dws_conversation_bindings AS binding')) {
        return { rows: [{ session_id: 'legacy-session', peer_open_dingtalk_id: 'peer-winner' }] };
      }
      if (sql.includes('SELECT 1 FROM gov_agent_dws_requester_conversation_bindings')) {
        return { rows: requesterBindingCount > 0 ? [{ '?column?': 1 }] : [] };
      }
      if (sql.includes('gov_agent_dws_requester_conversation_bindings AS binding')) {
        requesterBindingCount += 1;
        return { rows: [{
          binding_id: `binding-${requesterBindingCount}`, tenant_id: 'tenant-1', account_id: 'account-1',
          conversation_id: 'conversation-1', requester_user_id: values?.[4], session_id: values?.[5],
          peer_open_dingtalk_id: 'peer-winner', created_at: new Date(NOW), updated_at: NOW,
        }] };
      }
      throw new Error(`unexpected sql: ${sql}`);
    });
    const client = { query, release: vi.fn() };
    const store = new PgAgentDwsMessageStore({ connect: async () => client } as never, 'gov');

    const first = await store.getOrCreateBinding(
      'tenant-1', 'account-1', 'conversation-1', 'user-1', 'session-a', 'peer-winner',
    );
    const second = await store.getOrCreateBinding(
      'tenant-1', 'account-1', 'conversation-1', 'user-2', 'session-b', 'peer-winner',
    );

    expect(first).toMatchObject({ requesterUserId: 'user-1', sessionId: 'legacy-session' });
    expect(second).toMatchObject({ requesterUserId: 'user-2', sessionId: 'session-b' });
    expect(query.mock.calls.some(call => String(call[0]).includes(
      'ON CONFLICT (account_id,conversation_id) DO UPDATE',
    ))).toBe(true);
    expect(query.mock.calls.some(call => String(call[0]).includes(
      'ON CONFLICT (account_id,conversation_id,requester_user_id) DO UPDATE',
    ))).toBe(true);
    expect(client.release).toHaveBeenCalledTimes(2);
  });

  it('requester binding 写入失败时回滚 legacy 双写', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('gov_agent_dws_conversation_bindings AS binding')) {
        return { rows: [{ session_id: 'legacy-session' }] };
      }
      if (sql.includes('SELECT 1 FROM gov_agent_dws_requester_conversation_bindings')) return { rows: [] };
      throw new Error('requester binding unavailable');
    });
    const client = { query, release: vi.fn() };
    const store = new PgAgentDwsMessageStore({ connect: async () => client } as never, 'gov');

    await expect(store.getOrCreateBinding(
      'tenant-1', 'account-1', 'conversation-1', 'user-1', 'session-a',
    )).rejects.toThrow('requester binding unavailable');

    expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    expect(query).not.toHaveBeenCalledWith('COMMIT');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('按 tenant、account、conversation 精确确认已观测群，不受列表窗口限制', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ observed: true }] });
    const store = new PgAgentDwsMessageStore({ query } as never, 'gov');

    const identity = {
      profileId: 'corp-1:user-1', corpId: 'corp-1', dingtalkUserId: 'user-1',
      identityUpdatedAt: '2026-09-04T00:00:00.000Z',
    };
    await expect(store.hasObservedGroup('tenant-1', 'account-1', 'group-101', identity))
      .resolves.toBe(true);
    const [sql, values] = query.mock.calls[0]!;
    expect(String(sql)).toContain("event_type='user_im_message_receive_at'");
    expect(String(sql)).toContain('conversation_id=$3');
    expect(String(sql)).toContain("payload_json->'accountIdentity'->>'profileId'=$5");
    expect(String(sql)).toContain('created_at >= $4::timestamptz');
    expect(values).toEqual([
      'tenant-1', 'account-1', 'group-101', identity.identityUpdatedAt,
      identity.profileId, identity.corpId, identity.dingtalkUserId,
    ]);
  });

  it('普通回复持久化 replyKind 并校验 owner/fence/有效 lease', async () => {
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
    expect(sql).toContain("jsonb_build_object('replyKind','normal')");
    expect(sql).toContain('lease_owner=$2 AND lease_fence=$3');
    expect(sql).toContain('lease_expires_at > NOW()');

    await expect(store.complete('adwsi-1', 'stale-worker', 6))
      .rejects.toEqual(expect.objectContaining<Partial<AgentDwsMessageInvariantError>>({
        code: 'AGENT_DWS_MESSAGE_LEASE_LOST',
      }));
  });

  it('拒绝回复在 processing 阶段持久化正文与原因后进入 reply_pending', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [inboxRow({
      state: 'reply_pending', response_text: '权限不足',
      payload_json: { replyKind: 'access_rejection', rejectionReasonCode: 'ASSIGNMENT_DENIED' },
    })] });
    const store = new PgAgentDwsMessageStore({ query } as never, 'gov');

    await expect(store.saveRejectionResult(
      'adwsi-1', 'worker-1', 7, '权限不足', 'ASSIGNMENT_DENIED',
    )).resolves.toMatchObject({
      state: 'reply_pending', replyKind: 'access_rejection', responseText: '权限不足',
      rejectionReasonCode: 'ASSIGNMENT_DENIED',
    });
    const [sql, values] = query.mock.calls[0]!;
    expect(String(sql)).toContain("'replyKind','access_rejection','rejectionReasonCode',$5::text");
    expect(String(sql)).toContain("WHERE inbox_id=$1 AND state='processing'");
    expect(values).toEqual([
      'adwsi-1', 'worker-1', 7, '权限不足', 'ASSIGNMENT_DENIED',
    ]);
  });

  it('普通 reply_pending 在授权变化时进入可诊断人工核对终态', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [inboxRow({
      state: 'dead_letter', payload_json: {
        replyKind: 'normal', disposition: 'reply_blocked',
        rejectionReasonCode: 'ASSIGNMENT_DENIED',
      }, last_error: 'AGENT_DWS_REPLY_AUTHORIZATION_CHANGED:ASSIGNMENT_DENIED',
      completed_at: new Date(NOW),
    })] });
    const store = new PgAgentDwsMessageStore({ query } as never, 'gov');

    await expect(store.blockReply('adwsi-1', 'worker-1', 7, 'ASSIGNMENT_DENIED'))
      .resolves.toMatchObject({ state: 'dead_letter', replyKind: 'normal',
        disposition: 'reply_blocked', rejectionReasonCode: 'ASSIGNMENT_DENIED' });
    const [sql] = query.mock.calls[0]!;
    expect(String(sql)).toContain("COALESCE(payload_json->>'replyKind','normal')<>'access_rejection'");
    expect(String(sql)).toContain("'disposition','reply_blocked','rejectionReasonCode',$4::text");
  });

  it('provider 已开始后的发送歧义进入 delivery_unknown 人工核对终态', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [inboxRow({
      state: 'dead_letter', payload_json: {
        replyKind: 'normal', disposition: 'delivery_unknown',
      }, last_error: 'AGENT_DWS_REPLY_DELIVERY_UNKNOWN', completed_at: new Date(NOW),
    })] });
    const store = new PgAgentDwsMessageStore({ query } as never, 'gov');

    await expect(store.markReplyUnknown('adwsi-1', 'worker-1', 7)).resolves.toMatchObject({
      state: 'dead_letter', disposition: 'delivery_unknown',
    });
    const [sql] = query.mock.calls[0]!;
    expect(String(sql)).toContain("'disposition','delivery_unknown'");
    expect(String(sql)).toContain("WHERE inbox_id=$1 AND state='reply_pending'");
  });

  it('拒绝终态在兼容 payload 中记录 disposition 与稳定 reasonCode', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [inboxRow({
      state: 'completed',
      payload_json: {
        normalized: true,
        disposition: 'rejected',
        rejectionReasonCode: 'REQUESTER_IDENTITY_UNMAPPED',
      },
      completed_at: new Date(NOW),
    })] });
    const store = new PgAgentDwsMessageStore({ query } as never, 'gov');

    await expect(store.reject(
      'adwsi-1', 'worker-1', 7, 'REQUESTER_IDENTITY_UNMAPPED',
    )).resolves.toMatchObject({
      state: 'completed',
      disposition: 'rejected',
      rejectionReasonCode: 'REQUESTER_IDENTITY_UNMAPPED',
    });
    const [sql, values] = query.mock.calls[0]!;
    expect(String(sql)).toContain("'disposition','rejected','rejectionReasonCode',$4::text");
    expect(String(sql)).toContain("WHERE inbox_id=$1 AND state='reply_pending'");
    expect(String(sql)).toContain("payload_json->>'replyKind'='access_rejection'");
    expect(values).toEqual([
      'adwsi-1', 'worker-1', 7, 'REQUESTER_IDENTITY_UNMAPPED',
    ]);
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

  it('租户删除在同一事务清理 requester、legacy binding 与 inbox', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [], rowCount: 0 };
      if (sql.includes('requester_conversation_bindings')) return { rows: [], rowCount: 2 };
      if (sql.includes('agent_dws_conversation_bindings')) return { rows: [], rowCount: 3 };
      if (sql.includes('agent_dws_event_inbox')) return { rows: [], rowCount: 4 };
      throw new Error(`unexpected sql: ${sql}`);
    });
    const client = { query, release: vi.fn() };
    const store = new PgAgentDwsMessageStore({ connect: async () => client } as never, 'gov');

    await expect(store.deleteForTenant('tenant-1')).resolves.toBe(9);

    expect(query.mock.calls.map(call => String(call[0]))).toEqual([
      'BEGIN',
      expect.stringContaining('gov_agent_dws_requester_conversation_bindings'),
      expect.stringContaining('gov_agent_dws_conversation_bindings'),
      expect.stringContaining('gov_agent_dws_event_inbox'),
      'COMMIT',
    ]);
    expect(client.release).toHaveBeenCalledOnce();
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
    expect(sql).toContain("WHEN response_text IS NOT NULL THEN 'reply_pending'");
    expect(sql).toContain("ELSE 'retry_wait'");
    expect(sql).toContain('POWER(2,LEAST(attempt-1,8))');
    expect(sql).not.toContain('response_text=NULL');
    const persistedError = String(query.mock.calls[0]?.[1]?.[3]);
    expect(persistedError).not.toContain('private-token');
    expect(persistedError.length).toBeLessThanOrEqual(500);
  });
});

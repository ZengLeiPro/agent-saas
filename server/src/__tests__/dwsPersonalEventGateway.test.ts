import { describe, expect, it, vi } from 'vitest';

import type { AgentDwsAccountRecord, AgentDwsAccountStore } from '../data/agentDwsAccounts/index.js';
import { DwsPersonalEventGateway, parseEventLine } from '../dws/personalEventGateway.js';

const event = {
  type: 'user_im_message_receive_at',
  event_id: 'event-1',
  conversation_id: 'cid-1',
  message_id: 'msg-1',
  sender_open_dingtalk_id: 'sender-1',
  sender_nick: '爱丽丝',
  content: '@销售数字员工 查一下进度',
  timestamp: 1786630000000,
};

describe('DWS Personal Stream event parser', () => {
  it('提取稳定路由字段并保留原始 payload', () => {
    expect(parseEventLine(JSON.stringify(event))).toEqual({
      type: event.type,
      eventId: event.event_id,
      conversationId: event.conversation_id,
      messageId: event.message_id,
      senderOpenDingtalkId: event.sender_open_dingtalk_id,
      senderName: event.sender_nick,
      content: event.content,
      timestamp: event.timestamp,
      raw: event,
    });
  });

  it('忽略日志、坏 JSON 和没有 event_id 的对象', () => {
    expect(parseEventLine('[event] ready')).toBeNull();
    expect(parseEventLine('{bad')).toBeNull();
    expect(parseEventLine(JSON.stringify({ type: event.type }))).toBeNull();
  });
});

const account: AgentDwsAccountRecord = {
  accountId: 'account-1', tenantId: 'tenant-1', agentId: 'agent-1', displayName: '销售数字员工', loginId: 'login-1',
  profileId: 'corp-1:user-1', corpId: 'corp-1', dingtalkUserId: 'user-1',
  status: 'active', runtimeStatus: 'stopped', eventKinds: ['at_me'], revision: 1,
  createdAt: '2026-08-24T00:00:00Z', createdBy: 'admin', updatedAt: '2026-08-24T00:00:00Z', updatedBy: 'admin',
};

describe('DWS Personal Stream exact-profile retry circuit', () => {
  it('claims the exact account revision, backs off failures and opens the circuit after five attempts', async () => {
    let now = Date.parse('2026-08-24T14:00:00Z');
    const claimRuntimeLease = vi.fn(async () => true);
    const store = {
      claimRuntimeLease,
      renewRuntimeLease: vi.fn(async () => true),
      releaseRuntimeLease: vi.fn(async () => undefined),
      updateRuntimeStatus: vi.fn(async () => undefined),
    } as unknown as AgentDwsAccountStore;
    const gateway = new DwsPersonalEventGateway({
      agentCwd: '/tmp/agent', accountStore: store, now: () => now,
      resolveServerRemote: async () => { throw new Error('remote unavailable'); },
    });

    await gateway.startAccount(account);
    await vi.waitFor(() => expect(gateway.getRetrySnapshot()['account-1']?.failures).toBe(1));
    expect(claimRuntimeLease).toHaveBeenCalledWith('account-1', expect.any(String), 60_000, account.revision);
    await gateway.startAccount(account);
    expect(claimRuntimeLease).toHaveBeenCalledTimes(1);

    for (let attempt = 2; attempt <= 5; attempt += 1) {
      now = gateway.getRetrySnapshot()['account-1']!.nextAttemptAt;
      await gateway.startAccount(account);
      await vi.waitFor(() => expect(gateway.getRetrySnapshot()['account-1']?.failures).toBe(attempt));
    }
    const retry = gateway.getRetrySnapshot()['account-1']!;
    expect(retry.circuitOpenUntil).toBe(now + 60 * 60_000);
    expect(retry.nextAttemptAt).toBe(retry.circuitOpenUntil);
    await gateway.stop();
  });

  it('does not claim a stream while unified execution maintenance is active', async () => {
    const claimRuntimeLease = vi.fn(async () => true);
    const gateway = new DwsPersonalEventGateway({
      agentCwd: '/tmp/agent',
      accountStore: { claimRuntimeLease } as unknown as AgentDwsAccountStore,
      resolveServerRemote: async () => ({ baseUrl: 'http://acs', authToken: 'token' }),
      isExecutionEnabled: () => false,
    });
    await gateway.startAccount(account);
    expect(claimRuntimeLease).not.toHaveBeenCalled();
    await gateway.stop();
  });
});

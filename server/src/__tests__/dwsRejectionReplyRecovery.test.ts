import { describe, expect, it, vi } from 'vitest';

import type { AgentDwsAccountRecord, AgentDwsAccountStore } from '../data/agentDwsAccounts/index.js';
import type { AgentDwsInboxRecord, AgentDwsMessageStore } from '../data/agentDwsMessages/index.js';
import { AgentDwsMessageRouter } from '../dws/personalMessageRouter.js';

const now = new Date().toISOString();
const account: AgentDwsAccountRecord = {
  accountId: 'account-a', tenantId: 'tenant-a', agentId: 'agent-a', displayName: '开开',
  loginId: '17300000000', profileId: 'corp-a:agent-self', corpId: 'corp-a',
  dingtalkUserId: 'agent-self', status: 'active', runtimeStatus: 'ready',
  eventKinds: ['at_me'], revision: 1, createdAt: now, createdBy: 'admin-a',
  updatedAt: now, updatedBy: 'admin-a',
};
const item: AgentDwsInboxRecord = {
  inboxId: 'inbox-a', tenantId: 'tenant-a', accountId: 'account-a', eventId: 'event-a',
  eventType: 'user_im_message_receive_at', conversationId: 'group-a', messageId: 'mid-a',
  senderOpenDingtalkId: 'open-a', content: '@开开', state: 'processing', payload: {
    accountIdentity: { profileId: 'corp-a:agent-self', corpId: 'corp-a', dingtalkUserId: 'agent-self' },
  },
  attempt: 1, maxAttempts: 8, leaseOwner: 'worker-a', leaseFence: 1,
  leaseExpiresAt: now, createdAt: now, updatedAt: now,
};

function setup(claimed: AgentDwsInboxRecord[]) {
  const queue = [...claimed];
  const messageStore = {
    claimNext: vi.fn(async () => queue.shift() ?? null), renewLease: vi.fn().mockResolvedValue(true),
    pinLegacyIdentityOrTerminate: vi.fn(async (_id: string) => claimed[0]),
    saveRejectionResult: vi.fn(async (
      _id: string, _owner: string, _fence: number, responseText: string, reasonCode: string,
    ) => ({ ...claimed[0], state: 'reply_pending', responseText,
      rejectionReasonCode: reasonCode, replyStartedAt: now })),
    markReplyAttemptStarted: vi.fn(async () => {
      const source = claimed[Math.min(vi.mocked(messageStore.markReplyAttemptStarted).mock.calls.length - 1, claimed.length - 1)]!;
      return { ...source, state: 'reply_pending', replyStartedAt: source.replyStartedAt ?? now };
    }),
    reject: vi.fn(async (_id: string, _owner: string, _fence: number, reasonCode: string) => ({
      ...claimed.at(-1)!, state: 'completed', disposition: 'rejected', rejectionReasonCode: reasonCode,
    })),
    fail: vi.fn().mockResolvedValue({ ...claimed[0], state: 'retry_wait' }),
    complete: vi.fn(), getOrCreateBinding: vi.fn(), markDispatchStarted: vi.fn(),
    saveDispatchResult: vi.fn(), defer: vi.fn(), releaseClaim: vi.fn(), init: vi.fn(), ingest: vi.fn(),
    listForAccount: vi.fn(), hasObservedGroup: vi.fn(), listActiveForAccount: vi.fn(),
    deleteForTenant: vi.fn(),
  } as unknown as AgentDwsMessageStore;
  const sender = { send: vi.fn().mockResolvedValue({ status: 'accepted', acceptedAt: now }) };
  const dispatch = vi.fn();
  const router = new AgentDwsMessageRouter({
    agentCwd: '/workspace', messageStore,
    accountStore: { getForTenant: vi.fn().mockResolvedValue(account) } as unknown as AgentDwsAccountStore,
    dispatch: dispatch as never, resolveDefaultModel: () => ({ ref: 'models/test', model: 'test' }),
    resolveRequester: vi.fn().mockResolvedValue(null),
    authorizeRequester: vi.fn().mockResolvedValue({ allowed: true }),
    auditRequesterRejection: vi.fn(), auditToolPolicyRejection: vi.fn(), sender,
  });
  return { router, messageStore, sender, dispatch };
}

describe('Agent DWS rejection reply recovery', () => {
  it('发送失败后从 reply_pending 重领，复用已保存正文与 reasonCode', async () => {
    const retry = { ...item, state: 'reply_pending' as const, attempt: 2, leaseFence: 2,
      responseText: '已持久化拒绝', rejectionReasonCode: 'ASSIGNMENT_DENIED', replyStartedAt: now };
    const test = setup([item, retry]);
    vi.mocked(test.sender.send).mockRejectedValueOnce(new Error('provider unavailable'));

    await expect(test.router.runOnce()).resolves.toBe(false);
    await expect(test.router.runOnce()).resolves.toBe(true);

    expect(test.messageStore.saveRejectionResult).toHaveBeenCalledTimes(1);
    expect(test.messageStore.fail).toHaveBeenCalledOnce();
    expect(test.messageStore.reject).toHaveBeenLastCalledWith(
      'inbox-a', expect.any(String), 2, 'ASSIGNMENT_DENIED',
    );
    expect(test.sender.send).toHaveBeenLastCalledWith(
      account, expect.any(Object), '已持久化拒绝', expect.any(String),
    );
    expect(test.dispatch).not.toHaveBeenCalled();
  });

  it('超出 provider 幂等安全窗口时不重复发送拒绝', async () => {
    const expired = { ...item, state: 'reply_pending' as const, attempt: 2,
      responseText: '已持久化拒绝', rejectionReasonCode: 'ASSIGNMENT_DENIED',
      replyStartedAt: new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString() };
    const test = setup([expired]);

    await expect(test.router.runOnce()).resolves.toBe(false);

    expect(test.messageStore.saveRejectionResult).not.toHaveBeenCalled();
    expect(test.sender.send).not.toHaveBeenCalled();
    expect(test.messageStore.fail).toHaveBeenCalledWith(
      'inbox-a', expect.any(String), 1,
      expect.objectContaining({ message: expect.stringContaining('idempotency window expired') }),
    );
  });
});

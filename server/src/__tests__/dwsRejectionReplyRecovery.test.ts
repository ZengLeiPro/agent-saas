import { describe, expect, it, vi } from 'vitest';

import type { AgentDwsAccountRecord, AgentDwsAccountStore } from '../data/agentDwsAccounts/index.js';
import type {
  AgentDwsInboxRecord,
  AgentDwsMessageStore,
} from '../data/agentDwsMessages/index.js';
import type { OrgGroupAgentStore } from '../data/orgGroupAgents/index.js';
import { AgentDwsMessageRouter } from '../dws/personalMessageRouter.js';

const now = new Date().toISOString();
const account: AgentDwsAccountRecord = {
  accountId: 'account-a', tenantId: 'tenant-a', agentId: 'agent-a', displayName: '开开',
  loginId: '17300000000', profileId: 'corp-a:agent-self', corpId: 'corp-a',
  dingtalkUserId: 'agent-self', status: 'active', runtimeStatus: 'ready',
  eventKinds: ['at_me'], revision: 1, identityUpdatedAt: now,
  createdAt: now, createdBy: 'admin-a',
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

const requester = { id: 'user-a', username: 'alice', role: 'user' as const,
  tenantId: 'tenant-a', dingtalkStaffId: 'staff-a' };

function setup(claimed: AgentDwsInboxRecord[], options: {
  requester?: boolean;
  requesterAllowed?: boolean;
  outcome?: { status: 'unavailable'; reason: string };
  useOutcome?: boolean;
  recoveryState?: 'none' | 'unstarted' | 'sent' | 'unknown';
  cancelCount?: number;
  withDeliveryStore?: boolean;
  authorizationSequence?: Array<{ allowed: boolean; reason?: string }>;
} = {}) {
  const queue = [...claimed];
  const messageStore = {
    claimNext: vi.fn(async () => queue.shift() ?? null), renewLease: vi.fn().mockResolvedValue(true),
    pinLegacyIdentityOrTerminate: vi.fn(async (_id: string) => claimed[0]),
    saveRejectionResult: vi.fn(async (
      _id: string, _owner: string, _fence: number, responseText: string, reasonCode: string,
    ) => ({ ...claimed[0], state: 'reply_pending', replyKind: 'access_rejection',
      responseText, rejectionReasonCode: reasonCode, replyStartedAt: now })),
    markReplyAttemptStarted: vi.fn(async () => {
      const source = claimed[Math.min(vi.mocked(messageStore.markReplyAttemptStarted).mock.calls.length - 1, claimed.length - 1)]!;
      return { ...source, state: 'reply_pending', replyStartedAt: source.replyStartedAt ?? now };
    }),
    reject: vi.fn(async (_id: string, _owner: string, _fence: number, reasonCode: string) => ({
      ...claimed.at(-1)!, state: 'completed', disposition: 'rejected', rejectionReasonCode: reasonCode,
    })),
    blockReply: vi.fn(async (_id: string, _owner: string, _fence: number, reasonCode: string) => ({
      ...claimed.at(-1)!, state: 'dead_letter', disposition: 'reply_blocked',
      rejectionReasonCode: reasonCode,
    })),
    markReplyUnknown: vi.fn().mockResolvedValue({
      ...claimed[0], state: 'dead_letter', disposition: 'delivery_unknown',
    }),
    fail: vi.fn().mockResolvedValue({ ...claimed[0], state: 'retry_wait' }),
    complete: vi.fn(), getOrCreateBinding: vi.fn().mockResolvedValue({ sessionId: 'session-a' }),
    markDispatchStarted: vi.fn(async () => claimed[0]),
    saveDispatchResult: vi.fn(), defer: vi.fn(), releaseClaim: vi.fn(), init: vi.fn(), ingest: vi.fn(),
    listForAccount: vi.fn(), hasObservedGroup: vi.fn(), listActiveForAccount: vi.fn(),
    deleteForTenant: vi.fn(),
  } as unknown as AgentDwsMessageStore;
  const providerSend = vi.fn();
  const sender = { send: vi.fn(async (
    _account: unknown, _event: unknown, _text: string, _key: string,
    onProviderStart?: () => Promise<void>,
  ) => {
    await onProviderStart?.();
    providerSend(_text);
    return { status: 'accepted', acceptedAt: now };
  }) };
  let createdDelivery: Record<string, unknown> | undefined;
  const orgGroupAgentStore = options.withDeliveryStore
    ? {
        reconcileAllExpiredDeliveries: vi.fn().mockResolvedValue(0),
        claimNextDelivery: vi.fn().mockResolvedValue(null),
        cancelUnstartedDeliveriesForInbox: vi.fn().mockResolvedValue(
          options.cancelCount ?? 1,
        ),
        getReplyRecoveryStateForInbox: vi.fn().mockResolvedValue(
          options.recoveryState ?? 'unstarted',
        ),
        createDelivery: vi.fn(async (input: Record<string, unknown>) => {
          createdDelivery = { ...input, deliveryId: 'delivery-a', deliveryState: 'pending',
            attempt: 0, maxAttempts: 8, createdAt: now, updatedAt: now };
          return createdDelivery;
        }),
        claimDelivery: vi.fn(async () => ({ ...createdDelivery, deliveryState: 'sending',
          leaseOwner: 'worker-a', leaseFence: 1, leaseExpiresAt: now })),
        markDeliveryProviderStarted: vi.fn(async () => ({ ...createdDelivery,
          deliveryState: 'sending', providerStage: 'provider_started' })),
        markDeliverySent: vi.fn(async () => ({ ...createdDelivery, deliveryState: 'sent' })),
        markDeliveryUnknown: vi.fn(async () => ({ ...createdDelivery, deliveryState: 'unknown' })),
        releaseDelivery: vi.fn(async () => ({ ...createdDelivery, deliveryState: 'pending' })),
        releaseClaimedDeliveryForRetry: vi.fn(async () => ({ ...createdDelivery,
          deliveryState: 'pending' })),
        markClaimedDeliveryDeadLetter: vi.fn(async () => ({ ...createdDelivery,
          deliveryState: 'dead_letter' })),
        getDelivery: vi.fn(async () => createdDelivery),
      } as unknown as OrgGroupAgentStore
    : undefined;
  const dispatch = vi.fn();
  const authorizeRequester = vi.fn();
  for (const authorization of options.authorizationSequence ?? [])
    authorizeRequester.mockResolvedValueOnce(authorization);
  authorizeRequester.mockResolvedValue(
    options.requesterAllowed === false
      ? { allowed: false, reason: 'ASSIGNMENT_DENIED' }
      : { allowed: true },
  );
  const resolveRequesterOutcome = vi.fn().mockResolvedValue(
    options.outcome ?? { status: 'resolved', requester },
  );
  const router = new AgentDwsMessageRouter({
    agentCwd: '/workspace', messageStore,
    accountStore: { getForTenant: vi.fn().mockResolvedValue(account) } as unknown as AgentDwsAccountStore,
    dispatch: dispatch as never, resolveDefaultModel: () => ({ ref: 'models/test', model: 'test' }),
    resolveRequester: vi.fn().mockResolvedValue(options.requester ? requester : null),
    ...(options.outcome || options.useOutcome ? { resolveRequesterOutcome } : {}),
    authorizeRequester,
    auditRequesterRejection: vi.fn(), auditToolPolicyRejection: vi.fn(), sender,
    ...(orgGroupAgentStore ? { orgGroupAgentStore } : {}),
  });
  return { router, messageStore, sender, providerSend, dispatch, authorizeRequester,
    resolveRequesterOutcome, orgGroupAgentStore };
}

describe('Agent DWS rejection reply recovery', () => {
  it('初始拒绝发送失败后从 reply_pending 重领，复用正文与 reasonCode', async () => {
    const retry = { ...item, state: 'reply_pending' as const, replyKind: 'access_rejection' as const,
      attempt: 2, leaseFence: 2, responseText: '已持久化拒绝',
      rejectionReasonCode: 'ASSIGNMENT_DENIED', replyStartedAt: now };
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
      account, expect.any(Object), '已持久化拒绝', expect.any(String), expect.any(Function),
    );
    expect(test.dispatch).not.toHaveBeenCalled();
  });

  it('普通 reply_pending 无旧投递证据时宁可标记 unknown 也不发送拒绝', async () => {
    const normal = { ...item, state: 'reply_pending' as const,
      responseText: '机密正常回复', replyStartedAt: now };
    const test = setup([normal], {
      outcome: { status: 'unavailable', reason: 'DWS_REQUESTER_DIRECTORY_UNAVAILABLE' },
    });

    await expect(test.router.runOnce()).resolves.toBe(true);

    expect(test.messageStore.blockReply).not.toHaveBeenCalled();
    expect(test.providerSend).not.toHaveBeenCalled();
    expect(test.messageStore.markReplyUnknown).toHaveBeenCalledWith(
      'inbox-a', expect.any(String), 1,
    );
    expect(test.messageStore.reject).not.toHaveBeenCalled();
  });

  it('普通 reply_pending 遇 Assignment deny 时仅在未出站时发送安全拒绝', async () => {
    const normal = {
      ...item,
      eventType: 'user_im_message_receive_o2o_all' as const,
      state: 'reply_pending' as const,
      replyKind: 'normal' as const,
      responseText: '机密正常回复',
      replyStartedAt: now,
    };
    const test = setup([normal], {
      requester: true,
      requesterAllowed: false,
      withDeliveryStore: true,
    });

    await expect(test.router.runOnce()).resolves.toBe(true);

    expect(test.authorizeRequester).toHaveBeenCalledOnce();
    expect(test.orgGroupAgentStore?.cancelUnstartedDeliveriesForInbox).toHaveBeenCalledWith(
      'tenant-a', 'inbox-a', 'ORG_AGENT_DIRECT_DELIVERY_AUTHORIZATION_REVOKED:ASSIGNMENT_DENIED',
    );
    expect(test.messageStore.blockReply).not.toHaveBeenCalled();
    expect(
      vi.mocked(test.orgGroupAgentStore!.cancelUnstartedDeliveriesForInbox).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(test.messageStore.saveRejectionResult).mock.invocationCallOrder[0]!);
    expect(test.providerSend).toHaveBeenCalledWith(
      '当前请求未通过组织权限检查。请联系管理员确认本群配置和你的访问范围。',
    );
    expect(test.messageStore.reject).toHaveBeenCalledWith(
      'inbox-a', expect.any(String), 1, 'ASSIGNMENT_DENIED',
    );
  });

  it.each([
    ['sent', 'sent', 'complete'],
    ['provider_started', 'unknown', 'unknown'],
    ['unknown', 'unknown', 'unknown'],
  ] as const)('旧 normal 为 %s 时不发送第二条拒绝', async (
    _deliveryState, recoveryState, expectedInboxState,
  ) => {
    const normal = { ...item, eventType: 'user_im_message_receive_o2o_all' as const,
      state: 'reply_pending' as const, replyKind: 'normal' as const,
      responseText: '可能已经出站的正文', replyStartedAt: now };
    const test = setup([normal], { requester: true, requesterAllowed: false,
      withDeliveryStore: true, recoveryState, cancelCount: 0 });

    await expect(test.router.runOnce()).resolves.toBe(true);

    expect(test.messageStore.saveRejectionResult).not.toHaveBeenCalled();
    expect(test.sender.send).not.toHaveBeenCalled();
    if (expectedInboxState === 'complete') {
      expect(test.messageStore.complete).toHaveBeenCalledWith(
        'inbox-a', expect.any(String), 1,
      );
      expect(test.messageStore.markReplyUnknown).not.toHaveBeenCalled();
    } else {
      expect(test.messageStore.markReplyUnknown).toHaveBeenCalledWith(
        'inbox-a', expect.any(String), 1,
      );
      expect(test.messageStore.complete).not.toHaveBeenCalled();
    }
  });

  it('长运行回复在 provider fence 后 Assignment 撤权时发送安全拒绝', async () => {
    const normal = { ...item, eventType: 'user_im_message_receive_o2o_all' as const,
      state: 'reply_pending' as const, replyKind: 'normal' as const,
      responseText: '旧授权下生成的机密正文', replyStartedAt: now };
    const test = setup([normal], {
      requester: true,
      withDeliveryStore: true,
      authorizationSequence: [
        { allowed: true }, { allowed: false, reason: 'ASSIGNMENT_DENIED' },
      ],
    });

    await expect(test.router.runOnce()).resolves.toBe(true);

    expect(test.authorizeRequester).toHaveBeenCalledTimes(2);
    expect(test.messageStore.blockReply).not.toHaveBeenCalled();
    expect(test.messageStore.saveRejectionResult).toHaveBeenCalledWith(
      'inbox-a', expect.any(String), 1,
      '当前请求未通过组织权限检查。请联系管理员确认本群配置和你的访问范围。',
      'ASSIGNMENT_DENIED', true,
    );
    expect(test.sender.send).toHaveBeenLastCalledWith(
      account, expect.any(Object),
      '当前请求未通过组织权限检查。请联系管理员确认本群配置和你的访问范围。',
      expect.any(String), expect.any(Function),
    );
    expect(test.providerSend).toHaveBeenCalledOnce();
    expect(vi.mocked(test.sender.send).mock.calls[0]![3])
      .not.toBe(vi.mocked(test.sender.send).mock.calls[1]![3]);
    expect(test.providerSend).not.toHaveBeenCalledWith('旧授权下生成的机密正文');
    expect(test.providerSend).toHaveBeenCalledWith(
      '当前请求未通过组织权限检查。请联系管理员确认本群配置和你的访问范围。',
    );
    expect(test.messageStore.reject).toHaveBeenCalledWith(
      'inbox-a', expect.any(String), 1, 'ASSIGNMENT_DENIED',
    );
    expect(test.messageStore.complete).not.toHaveBeenCalled();
  });

  it('provider-start 慢重验期间 staffId 映射变化时旧正文零发送', async () => {
    const normal = { ...item, eventType: 'user_im_message_receive_o2o_all' as const,
      state: 'reply_pending' as const, replyKind: 'normal' as const,
      responseText: '旧身份生成的正文', replyStartedAt: now };
    const test = setup([normal], { requester: true, useOutcome: true,
      withDeliveryStore: true, authorizationSequence: [{ allowed: true }] });
    let release!: () => void;
    let started!: () => void;
    const resolving = new Promise<void>(resolve => { started = resolve; });
    test.resolveRequesterOutcome.mockReset()
      .mockResolvedValueOnce({ status: 'resolved', requester })
      .mockImplementationOnce(async () => {
        started();
        await new Promise<void>(resolve => { release = resolve; });
        return { status: 'resolved', requester: { ...requester, dingtalkStaffId: 'staff-b' } };
      });

    const running = test.router.runOnce();
    await resolving;
    release();
    await expect(running).resolves.toBe(true);

    expect(test.authorizeRequester).toHaveBeenCalledOnce();
    expect(test.providerSend).not.toHaveBeenCalledWith('旧身份生成的正文');
    expect(test.providerSend).toHaveBeenCalledWith(
      '当前请求未通过组织权限检查。请联系管理员确认本群配置和你的访问范围。',
    );
    expect(test.messageStore.saveRejectionResult).toHaveBeenCalledWith(
      'inbox-a', expect.any(String), 1, expect.any(String), 'REQUESTER_IDENTITY_CHANGED', true,
    );
    expect(test.messageStore.markReplyUnknown).not.toHaveBeenCalled();
  });

  it('撤权后的安全拒绝在 provider 后歧义时标记 delivery_unknown', async () => {
    const normal = { ...item, eventType: 'user_im_message_receive_o2o_all' as const,
      state: 'reply_pending' as const, replyKind: 'normal' as const,
      responseText: '旧授权正文', replyStartedAt: now };
    const test = setup([normal], { requester: true, withDeliveryStore: true,
      authorizationSequence: [{ allowed: true }, { allowed: false, reason: 'ASSIGNMENT_DENIED' }] });
    vi.mocked(test.sender.send).mockImplementation(async (
      _account, _event, text, _key, onProviderStart,
    ) => {
      await onProviderStart?.();
      test.providerSend(text);
      throw new Error('provider receipt lost after acceptance');
    });

    await expect(test.router.runOnce()).resolves.toBe(true);

    expect(test.providerSend).toHaveBeenCalledTimes(1);
    expect(test.providerSend).not.toHaveBeenCalledWith('旧授权正文');
    expect(test.messageStore.markReplyUnknown).toHaveBeenCalledWith(
      'inbox-a', expect.any(String), 1,
    );
    expect(test.messageStore.reject).not.toHaveBeenCalled();
  });

  it('撤权后的安全拒绝在 provider 前失败时只恢复拒绝正文', async () => {
    const normal = { ...item, eventType: 'user_im_message_receive_o2o_all' as const,
      state: 'reply_pending' as const, replyKind: 'normal' as const,
      responseText: '旧授权正文', replyStartedAt: now };
    const rejected = { ...normal, state: 'reply_pending' as const,
      replyKind: 'access_rejection' as const, responseText: '安全拒绝',
      rejectionReasonCode: 'ASSIGNMENT_DENIED', attempt: 2, leaseFence: 2 };
    const test = setup([normal, rejected], { requester: true,
      authorizationSequence: [{ allowed: true }, { allowed: false, reason: 'ASSIGNMENT_DENIED' }] });
    let failedRejection = false;
    vi.mocked(test.sender.send).mockImplementation(async (
      _account, _event, text, _key, onProviderStart,
    ) => {
      if (text !== '旧授权正文' && !failedRejection) {
        failedRejection = true;
        throw new Error('prepare failed');
      }
      await onProviderStart?.();
      test.providerSend(text);
      return { status: 'accepted', acceptedAt: now };
    });

    await expect(test.router.runOnce()).resolves.toBe(false);
    await expect(test.router.runOnce()).resolves.toBe(true);

    expect(test.messageStore.saveRejectionResult).toHaveBeenCalledOnce();
    expect(test.messageStore.fail).toHaveBeenCalledOnce();
    expect(test.providerSend).toHaveBeenCalledTimes(1);
    expect(test.providerSend).not.toHaveBeenCalledWith('旧授权正文');
    expect(test.messageStore.reject).toHaveBeenCalledWith(
      'inbox-a', expect.any(String), 2, 'ASSIGNMENT_DENIED',
    );
  });

  it('拒绝型 reply_pending 即使身份恢复，也只恢复原拒绝投递', async () => {
    const rejected = { ...item, state: 'reply_pending' as const,
      replyKind: 'access_rejection' as const, responseText: '原拒绝正文',
      rejectionReasonCode: 'REQUESTER_IDENTITY_UNMAPPED', replyStartedAt: now };
    const test = setup([rejected], { requester: true });

    await expect(test.router.runOnce()).resolves.toBe(true);

    expect(test.authorizeRequester).not.toHaveBeenCalled();
    expect(test.sender.send).toHaveBeenCalledWith(
      account, expect.any(Object), '原拒绝正文', expect.any(String), expect.any(Function),
    );
    expect(test.messageStore.reject).toHaveBeenCalledWith(
      'inbox-a', expect.any(String), 1, 'REQUESTER_IDENTITY_UNMAPPED',
    );
    expect(test.messageStore.blockReply).not.toHaveBeenCalled();
  });

  it('超出 provider 幂等安全窗口时不重复发送拒绝', async () => {
    const expired = { ...item, state: 'reply_pending' as const,
      replyKind: 'access_rejection' as const, attempt: 2,
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

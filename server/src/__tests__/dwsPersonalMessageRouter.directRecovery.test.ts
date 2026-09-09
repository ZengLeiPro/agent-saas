import { describe, expect, it, vi } from 'vitest';

import type { OrgGroupAgentStore } from '../data/orgGroupAgents/index.js';
import { account, item, requester, setup } from './dwsPersonalMessageRouter.testHelpers.js';

describe('AgentDwsMessageRouter direct recovery authority', () => {
  it.each([
    ['撤权后', false, false],
    ['仍授权时', true, true],
  ] as const)(
    'direct reconcile 后 outbox 在%s按可信 requester 快照重查权限',
    async (_label, requesterAllowed, shouldSend) => {
      const recoveredInbox = {
        ...item,
        eventType: 'user_im_message_receive_o2o_all' as const,
        conversationId: 'direct-a',
        state: 'completed' as const,
        sessionId: 'session-a',
        runId: 'run-a',
        payload: {
          ...item.payload,
          requesterIdentity: {
            id: requester.id,
            username: requester.username,
            role: requester.role,
            tenantId: requester.tenantId,
            dingtalkStaffId: requester.dingtalkStaffId,
          },
        },
      };
      const directDelivery = {
        deliveryId: 'delivery-direct',
        tenantId: 'tenant-a',
        inboxId: 'inbox-a',
        accountId: 'account-a',
        accountIdentity: {
          profileId: account.profileId!,
          corpId: account.corpId!,
          dingtalkUserId: account.dingtalkUserId!,
          identityUpdatedAt: account.identityUpdatedAt,
        },
        conversationId: 'direct-a',
        source: 'command' as const,
        deliveryKind: 'front_reply' as const,
        disposition: 'replied' as const,
        deliveryState: 'sending' as const,
        destination: {
          provider: 'dingtalk' as const,
          accountId: 'account-a',
          conversationId: 'direct-a',
          kind: 'direct' as const,
          peerOpenId: 'sender-a',
        },
        content: '固定恢复正文',
        idempotencyKey: 'stable-key',
        attempt: 2,
        leaseOwner: 'worker-a',
        leaseFence: 4,
        leaseExpiresAt: '2099-01-01T00:00:00.000Z',
        providerAttemptPhase: 'before_provider' as const,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      };
      const orgGroupAgentStore = {
        reconcileAllExpiredDeliveries: vi.fn().mockResolvedValue(0),
        claimNextDelivery: vi.fn().mockResolvedValue(directDelivery),
        markClaimedDeliveryDeadLetter: vi
          .fn()
          .mockResolvedValue({ ...directDelivery, deliveryState: 'dead_letter' }),
        markDeliveryProviderStarted: vi
          .fn()
          .mockResolvedValue({ ...directDelivery, providerAttemptPhase: 'provider_started' }),
        markDeliverySent: vi.fn().mockResolvedValue({ ...directDelivery, deliveryState: 'sent' }),
        markDeliveryUnknown: vi.fn(),
        releaseClaimedDeliveryForRetry: vi.fn(),
      } as unknown as OrgGroupAgentStore;
      const test = setup({ claimed: recoveredInbox, requesterAllowed, orgGroupAgentStore });

      await expect(test.router.runOnce()).resolves.toBe(true);
      expect(test.authorizeRequester).toHaveBeenCalledWith(
        expect.objectContaining({
          requester: expect.objectContaining({ id: 'user-a', dingtalkStaffId: 'sender-a' }),
          sessionId: 'session-a',
          runId: 'run-a',
          phase: 'provider_start',
        }),
      );
      if (shouldSend) {
        expect(test.sender.send).toHaveBeenCalledWith(
          account,
          expect.objectContaining({ conversationId: 'direct-a' }),
          '固定恢复正文',
          'stable-key',
          expect.any(Function),
        );
      } else {
        expect(test.sender.send).not.toHaveBeenCalled();
        expect(orgGroupAgentStore.markClaimedDeliveryDeadLetter).toHaveBeenCalledWith(
          'delivery-direct',
          expect.stringMatching(/^agent-dws-router:/),
          4,
          'ORG_AGENT_DIRECT_REQUESTER_ACCESS_REVOKED:ASSIGNMENT_DENIED',
        );
      }
    },
  );
});

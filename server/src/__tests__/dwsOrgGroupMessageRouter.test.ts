import { describe, expect, it, vi } from 'vitest';

import type { AgentRunDispatch } from '../agent/index.js';
import type {
  AgentDwsAccountRecord,
  AgentDwsAccountStore,
} from '../data/agentDwsAccounts/index.js';
import type { AgentDwsInboxRecord, AgentDwsMessageStore } from '../data/agentDwsMessages/index.js';
import type { OrgGroupAgentStore } from '../data/orgGroupAgents/index.js';
import { AgentDwsMessageRouter } from '../dws/personalMessageRouter.js';
import type { DwsRequesterResolution } from '../dws/requesterIdentityResolver.js';

const now = '2026-09-04T00:00:00.000Z';
const account: AgentDwsAccountRecord = {
  accountId: 'account-a',
  tenantId: 'tenant-a',
  agentId: 'agent-a',
  displayName: '开开',
  loginId: 'agent',
  corpId: 'corp-a',
  dingtalkUserId: 'agent-self',
  profileId: 'corp-a:agent-self',
  status: 'active',
  runtimeStatus: 'ready',
  eventKinds: ['at_me'],
  revision: 1,
  createdAt: now,
  createdBy: 'admin',
  updatedAt: now,
  updatedBy: 'admin',
};
const item: AgentDwsInboxRecord = {
  inboxId: 'inbox-a',
  tenantId: 'tenant-a',
  accountId: 'account-a',
  eventId: 'event-a',
  eventType: 'user_im_message_receive_at',
  conversationId: 'cid-a',
  messageId: 'mid-a',
  senderOpenDingtalkId: 'sender-a',
  content: '整理采购异常',
  state: 'processing',
  attempt: 1,
  leaseFence: 1,
  maxAttempts: 5,
  createdAt: now,
  updatedAt: now,
  payload: {
    schemaVersion: 2,
    source: 'dws_personal_stream',
    routing: {},
    senderName: '调用人',
    accountIdentity: {
      profileId: 'corp-a:agent-self',
      corpId: 'corp-a',
      dingtalkUserId: 'agent-self',
    },
  },
};

function setup(
  options: {
    liveDeny?: boolean;
    guestReadOnly?: boolean;
    requesterOutcome?: DwsRequesterResolution;
    senderReceipt?: Record<string, unknown> | null;
    claimed?: AgentDwsInboxRecord;
  } = {},
) {
  const claimed = options.claimed ?? item;
  const messageStore = {
    claimNext: vi.fn().mockResolvedValueOnce(claimed).mockResolvedValue(null),
    renewLease: vi.fn().mockResolvedValue(true),
    getOrCreateBinding: vi.fn(),
    markDispatchStarted: vi
      .fn()
      .mockImplementation(
        async (_id: string, _owner: string, _fence: number, sessionId: string, runId: string) => ({
          ...claimed,
          sessionId,
          runId,
        }),
      ),
    saveDispatchResult: vi
      .fn()
      .mockImplementation(async (_id: string, _owner: string, _fence: number, text: string) => ({
        ...claimed,
        state: 'reply_pending',
        responseText: text,
      })),
    markReplyAttemptStarted: vi
      .fn()
      .mockResolvedValue({ ...claimed, state: 'reply_pending', replyStartedAt: now }),
    complete: vi.fn().mockResolvedValue({ ...claimed, state: 'completed' }),
    fail: vi.fn(),
    defer: vi.fn(),
    releaseClaim: vi.fn(),
    pinLegacyIdentityOrTerminate: vi.fn(),
    init: vi.fn(),
    ingest: vi.fn(),
    listForAccount: vi.fn(),
    deleteForTenant: vi.fn(),
  } as unknown as AgentDwsMessageStore;
  const binding = {
    bindingId: 'channel-binding-a',
    tenantId: 'tenant-a',
    accountId: 'account-a',
    agentId: 'agent-a',
    conversationId: 'cid-a',
    channelKind: 'group' as const,
    activationState: 'active' as const,
    enabled: true,
    conversationSpaceId: 'space-a',
    serviceSessionId: 'service-session-a',
    workspaceId: 'ws_tenant-a__agent_agent-a',
    policy: {
      enabled: true,
      membership: 'members' as const,
      guest: options.guestReadOnly ? ('shared_read_only' as const) : ('deny' as const),
      taskVisibility: 'conversation' as const,
      completion: 'reply_to_work_conversation' as const,
      liveDeny: options.liveDeny === true,
    },
    effectiveConfig: {
      identity: { displayName: '开开' },
      knowledge: { contextEnabled: options.guestReadOnly === true, sourceIds: ['source-a'] },
      capabilities: {
        skillIds: [],
        toolNames: ['Agent', 'BackgroundTask', 'ContextSearch', 'ContextGet'],
      },
      access: { triggerRoles: [], approvalRoles: [] },
      speech: { proactive: false, requireMention: true },
    },
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
  const delivery = {
    deliveryId: 'delivery-a',
    tenantId: 'tenant-a',
    inboxId: 'inbox-a',
    accountId: 'account-a',
    conversationId: 'cid-a',
    agentId: 'agent-a',
    bindingId: 'channel-binding-a',
    conversationSpaceId: 'space-a',
    workConversationId: 'workconv-a',
    policyRevision: 1,
    source: 'command' as const,
    deliveryKind: 'front_reply' as const,
    disposition: 'replied' as const,
    deliveryState: 'pending' as const,
    destination: {
      provider: 'dingtalk' as const,
      accountId: 'account-a',
      conversationId: 'cid-a',
      kind: 'group' as const,
    },
    content: '完成',
    idempotencyKey: 'delivery-key',
    attempt: 0,
    leaseFence: 0,
    createdAt: now,
    updatedAt: now,
  };
  const orgStore = {
    claimNextDelivery: vi.fn().mockResolvedValue(null),
    ensureShadowBinding: vi.fn().mockResolvedValue(binding),
    getBinding: vi.fn().mockResolvedValue(binding),
    getOrCreateWorkConversation: vi.fn().mockResolvedValue({
      workConversationId: 'workconv-a',
      tenantId: 'tenant-a',
      bindingId: 'channel-binding-a',
      rootKey: 'mid-a',
      rootMessageId: 'mid-a',
      sessionId: 'session-a',
      state: 'active',
      createdAt: now,
      updatedAt: now,
    }),
    findWorkConversationByMessage: vi.fn().mockResolvedValue(null),
    pinInboxContext: vi.fn(),
    listMemories: vi.fn().mockResolvedValue([]),
    createDelivery: vi.fn().mockResolvedValue(delivery),
    claimDelivery: vi
      .fn()
      .mockResolvedValue({ ...delivery, deliveryState: 'sending', leaseFence: 1 }),
    markDeliverySent: vi.fn(),
    markDeliveryUnknown: vi.fn(),
    markDeliveryDeadLetter: vi.fn(),
  } as unknown as OrgGroupAgentStore;
  const dispatch = vi.fn((_message, _context, _options, hooks) =>
    (async function* () {
      await hooks?.onResult?.({ resultText: '完成' });
      yield { type: 'session_init' as const, sessionId: 'session-a' };
      yield { type: 'done' as const };
    })(),
  ) as unknown as AgentRunDispatch;
  const sender = {
    send: vi
      .fn()
      .mockResolvedValue(
        options.senderReceipt === null
          ? undefined
          : (options.senderReceipt ?? { status: 'accepted', acceptedAt: now }),
      ),
  };
  const resolveRequester = vi.fn().mockResolvedValue({
    id: 'user-a',
    username: 'user',
    role: 'user',
    tenantId: 'tenant-a',
  });
  const router = new AgentDwsMessageRouter({
    agentCwd: '/workspace',
    messageStore,
    orgGroupAgentStore: orgStore,
    accountStore: {
      getForTenant: vi.fn().mockResolvedValue(account),
    } as unknown as AgentDwsAccountStore,
    dispatch,
    resolveDefaultModel: () => ({ ref: 'models/test', model: 'test' }),
    resolveRequester,
    ...(options.requesterOutcome
      ? { resolveRequesterOutcome: vi.fn().mockResolvedValue(options.requesterOutcome) }
      : {}),
    authorizeRequester: vi.fn().mockResolvedValue({ allowed: true }),
    auditRequesterRejection: vi.fn(),
    auditToolPolicyRejection: vi.fn(),
    sender,
    leaseTtlMs: 60_000,
    leaseRenewMs: 30_000,
  });
  return { router, messageStore, orgStore, dispatch, sender, resolveRequester };
}

describe('AgentDwsMessageRouter organization group binding', () => {
  it('uses an Agent-owned WorkConversation and durable delivery', async () => {
    const test = setup();
    await expect(test.router.runOnce()).resolves.toBe(true);
    expect(test.messageStore.getOrCreateBinding).not.toHaveBeenCalled();
    expect(test.orgStore.pinInboxContext).toHaveBeenCalledWith(
      expect.objectContaining({
        inboxId: 'inbox-a',
        conversationSpaceId: 'space-a',
        workConversationId: 'workconv-a',
      }),
    );
    expect(test.dispatch).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        resumeSessionId: 'session-a',
        sessionOwner: expect.objectContaining({ username: 'agent-dws:agent-a' }),
        orgAgentChannel: expect.objectContaining({ bindingId: 'channel-binding-a' }),
      }),
      expect.objectContaining({ allowedTools: ['Agent', 'BackgroundTask'], skipMemory: true }),
      expect.any(Object),
    );
    expect(test.orgStore.createDelivery).toHaveBeenCalledOnce();
    expect(test.orgStore.markDeliverySent).toHaveBeenCalledOnce();
  });

  it('does not fall through to a requester-owned legacy session after live deny', async () => {
    const test = setup({ liveDeny: true });
    await expect(test.router.runOnce()).resolves.toBe(true);
    expect(test.messageStore.getOrCreateBinding).not.toHaveBeenCalled();
    expect(test.dispatch).not.toHaveBeenCalled();
    expect(test.sender.send).toHaveBeenCalledOnce();
    expect(test.messageStore.complete).toHaveBeenCalledOnce();
  });

  it('visibly rejects an unavailable identity resolver instead of treating it as a guest', async () => {
    const test = setup({
      requesterOutcome: { status: 'unavailable', reason: 'DWS_IDENTITY_LOOKUP_FAILED' },
    });
    await expect(test.router.runOnce()).resolves.toBe(true);
    expect(test.dispatch).not.toHaveBeenCalled();
    expect(test.sender.send).toHaveBeenCalledOnce();
    expect(test.messageStore.complete).toHaveBeenCalledOnce();
  });

  it('allows an unmapped guest only the configured shared context tools', async () => {
    const test = setup({
      guestReadOnly: true,
      requesterOutcome: { status: 'unmapped', reason: 'DWS_IDENTITY_NOT_MAPPED' },
    });
    await expect(test.router.runOnce()).resolves.toBe(true);
    expect(test.dispatch).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        user: undefined,
        orgAgentChannel: expect.objectContaining({
          externalActorAssurance: 'unmapped',
          contextEnabled: true,
        }),
      }),
      expect.objectContaining({ allowedTools: ['ContextSearch', 'ContextGet'] }),
      expect.any(Object),
    );
  });

  it('routes a service completion without resolving or borrowing a requester identity', async () => {
    const completion = {
      ...item,
      senderOpenDingtalkId: undefined,
      payload: {
        ...item.payload,
        source: 'background_task_completion',
        workOrderId: 'work-1',
        attemptId: 'attempt-2',
      },
    };
    const test = setup({ claimed: completion });
    await expect(test.router.runOnce()).resolves.toBe(true);
    expect(test.resolveRequester).not.toHaveBeenCalled();
    expect(test.dispatch).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        user: undefined,
        orgAgentChannel: expect.objectContaining({
          externalActorAssurance: 'service',
          externalActor: expect.objectContaining({ kind: 'service_event', workOrderId: 'work-1' }),
        }),
      }),
      expect.objectContaining({ dispatcherCompletion: true, allowedTools: [] }),
      expect.any(Object),
    );
  });

  it('finishes the inbox but leaves a missing provider receipt in unknown for reconciliation', async () => {
    const test = setup({ senderReceipt: null });
    await expect(test.router.runOnce()).resolves.toBe(true);
    expect(test.orgStore.markDeliveryUnknown).toHaveBeenCalledWith(
      'delivery-a',
      expect.stringMatching(/^agent-dws-router:/),
      1,
      expect.any(Error),
    );
    expect(test.messageStore.complete).toHaveBeenCalledOnce();
  });
});

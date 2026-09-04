import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { AgentRunDispatch } from '../agent/index.js';
import type {
  AgentDwsAccountRecord,
  AgentDwsAccountStore,
} from '../data/agentDwsAccounts/index.js';
import type { AgentDwsInboxRecord, AgentDwsMessageStore } from '../data/agentDwsMessages/index.js';
import type { DwsDeliveryIntent, OrgGroupAgentStore } from '../data/orgGroupAgents/index.js';
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

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  return {
    promise: new Promise<void>((done) => {
      resolve = done;
    }),
    resolve: () => resolve(),
  };
}

function workOrder(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workOrderId: 'work-route-a',
    shortId: 'W-ABCDEF123456',
    tenantId: 'tenant-a',
    agentId: 'agent-a',
    bindingId: 'channel-binding-a',
    workConversationId: 'workconv-route-a',
    idempotencyKey: 'route-key-a',
    title: '整理采购异常',
    state: 'running',
    visibility: 'conversation',
    currentAttemptNo: 1,
    createdByActor: {
      kind: 'external_user', provider: 'dingtalk', corpId: 'corp-a', openId: 'sender-a',
      assurance: 'mapped', mappedUserId: 'user-a', role: 'member',
    },
    policySnapshot: {},
    cancelPolicy: {},
    control: { revision: 1, supplements: [], workerType: 'general' },
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function setup(
  options: {
    liveDeny?: boolean;
    guestReadOnly?: boolean;
    requesterOutcome?: DwsRequesterResolution;
    senderReceipt?: Record<string, unknown> | null;
    claimed?: AgentDwsInboxRecord;
    triggerRoles?: Array<'member' | 'org_admin'>;
    governanceRole?: 'member' | 'org_admin' | null;
    workVisibility?: 'conversation' | 'requester_only';
    content?: string;
    contextEnabled?: boolean;
    workOrders?: Array<Record<string, unknown>>;
    shortWorkOrder?: Record<string, unknown> | null;
    completionRequesterAuthorized?: boolean;
    memories?: Array<Record<string, unknown>>;
    frontReplyDeadlineMs?: number;
    dispatchGate?: Promise<void>;
    failFirstDeliveryClaim?: boolean;
    systemInstructions?: string;
    existingRun?: Record<string, unknown>;
    memoryPolicy?: {
      readAgent: boolean;
      readConversation: boolean;
      adminWriteConversation: boolean;
    };
  } = {},
) {
  const claimed = options.claimed ?? { ...item, content: options.content ?? item.content };
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
    fail: vi.fn().mockResolvedValue(undefined),
    defer: vi.fn().mockResolvedValue(undefined),
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
      membership: options.guestReadOnly ? ('members_and_guests' as const) : ('members' as const),
      guest: options.guestReadOnly ? ('shared_read_only' as const) : ('deny' as const),
      taskVisibility: 'conversation' as const,
      completion: 'reply_to_work_conversation' as const,
      liveDeny: options.liveDeny === true,
    },
    effectiveConfig: {
      identity: { displayName: '开开' },
      instructions: { system: options.systemInstructions ?? '' },
      knowledge: { contextEnabled: options.contextEnabled ?? false, sourceIds: ['source-a'] },
      capabilities: {
        skillIds: [],
        toolNames: ['Agent', 'BackgroundTask', 'ContextSearch', 'ContextGet'],
        dwsResourceIds: [],
      },
      memory: options.memoryPolicy ?? {
        readAgent: true,
        readConversation: true,
        adminWriteConversation: false,
      },
      access: { triggerRoles: options.triggerRoles ?? [], approvalRoles: ['org_admin'] },
      speech: { proactive: false, requireMention: true },
    },
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
  const delivery: DwsDeliveryIntent = {
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
    providerAttemptPhase: 'legacy_unknown',
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
  const storedDeliveries = new Map<string, typeof delivery>();
  let deliverySequence = 0;
  let deliveryClaimSequence = 0;
  const orgStore = {
    reconcileAllExpiredDeliveries: vi.fn().mockResolvedValue(0),
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
    getWorkConversation: vi.fn().mockImplementation(async (_tenantId: string, workConversationId: string) => {
      const routed = [options.shortWorkOrder, ...(options.workOrders ?? [])]
        .find(candidate => candidate?.workConversationId === workConversationId);
      if (routed) {
        return {
          workConversationId,
          tenantId: 'tenant-a',
          bindingId: 'channel-binding-a',
          rootKey: 'routed-message',
          sessionId: 'session-routed',
          state: 'active',
          createdAt: now,
          updatedAt: now,
        };
      }
      return null;
    }),
    pinInboxContext: vi.fn(),
    pinInboxRouting: vi.fn(),
    getWorkOrder: vi.fn().mockResolvedValue({
      workOrderId: 'work-a', tenantId: 'tenant-a', agentId: 'agent-a',
      bindingId: 'channel-binding-a', workConversationId: 'workconv-a',
      state: 'completed', currentAttemptNo: 1,
      visibility: options.workVisibility ?? 'conversation',
      createdByActor: {
        kind: 'external_user', provider: 'dingtalk', corpId: 'corp-a',
        openId: 'requester-open-id', assurance: 'mapped', mappedUserId: 'user-a', role: 'member',
      },
    }),
    getWorkOrderByShortId: vi.fn().mockImplementation(async (
      _tenantId: string,
      _agentId: string,
      shortId: string,
    ) => options.shortWorkOrder?.shortId === shortId ? options.shortWorkOrder : null),
    listWorkOrders: vi.fn().mockResolvedValue(options.workOrders ?? []),
    listWorkAttempts: vi.fn().mockResolvedValue([
      {
        attemptId: 'attempt-a',
        workOrderId: 'work-a',
        runtimeRunId: 'bg-a',
        attemptNo: 1,
        status: 'completed',
      },
    ]),
    listMemories: vi
      .fn()
      .mockImplementation(
        async (query: {
          memoryScope?: string;
          status?: string;
          bindingId?: string;
          workConversationId?: string;
        }) =>
          (options.memories ?? []).filter(
            (memory) =>
              (!query.memoryScope || memory.memoryScope === query.memoryScope) &&
              (!query.status || memory.status === query.status) &&
              (!query.bindingId || memory.bindingId === query.bindingId) &&
              (!query.workConversationId || memory.workConversationId === query.workConversationId),
          ),
      ),
    createDelivery: vi.fn().mockImplementation(async (input: Record<string, unknown>) => {
      const key = String(input.idempotencyKey);
      const existing = storedDeliveries.get(key);
      if (existing) return existing;
      deliverySequence += 1;
      const created = {
        ...delivery,
        ...input,
        deliveryId: deliverySequence === 1 ? 'delivery-a' : `delivery-${deliverySequence}`,
        deliveryState: 'pending' as const,
        attempt: 0,
        leaseFence: 0,
      };
      storedDeliveries.set(key, created);
      return created;
    }),
    claimDelivery: vi.fn().mockImplementation(async (deliveryId: string) => {
      deliveryClaimSequence += 1;
      if (options.failFirstDeliveryClaim && deliveryClaimSequence === 1) {
        throw new Error('simulated process crash before delivery claim');
      }
      const current = [...storedDeliveries.values()].find(
        (candidate) => candidate.deliveryId === deliveryId,
      );
      if (!current || current.deliveryState !== 'pending')
        throw new Error('DWS_DELIVERY_NOT_CLAIMABLE');
      const claimedDelivery = {
        ...current,
        deliveryState: 'sending' as const,
        attempt: current.attempt + 1,
        leaseFence: current.leaseFence + 1,
      };
      storedDeliveries.set(current.idempotencyKey, claimedDelivery);
      return claimedDelivery;
    }),
    getDelivery: vi
      .fn()
      .mockImplementation(
        async (_tenantId: string, deliveryId: string) =>
          [...storedDeliveries.values()].find((candidate) => candidate.deliveryId === deliveryId) ??
          null,
      ),
    markDeliveryProviderStarted: vi.fn().mockImplementation(async (deliveryId: string) => {
      const current = [...storedDeliveries.values()].find(
        (candidate) => candidate.deliveryId === deliveryId,
      );
      if (!current) throw new Error('DWS_DELIVERY_LEASE_LOST');
      return current;
    }),
    releaseClaimedDeliveryForRetry: vi.fn().mockImplementation(async (deliveryId: string) => {
      const current = [...storedDeliveries.values()].find(
        (candidate) => candidate.deliveryId === deliveryId,
      );
      if (!current) throw new Error('DWS_DELIVERY_LEASE_LOST');
      const released = { ...current, deliveryState: 'pending' as const };
      storedDeliveries.set(current.idempotencyKey, released);
      return released;
    }),
    markDeliverySent: vi.fn().mockImplementation(async (deliveryId: string) => {
      const current = [...storedDeliveries.values()].find(
        (candidate) => candidate.deliveryId === deliveryId,
      );
      if (current)
        storedDeliveries.set(current.idempotencyKey, {
          ...current,
          deliveryState: 'sent' as const,
        });
    }),
    markDeliveryUnknown: vi.fn().mockImplementation(async (deliveryId: string) => {
      const current = [...storedDeliveries.values()].find(
        (candidate) => candidate.deliveryId === deliveryId,
      );
      if (current)
        storedDeliveries.set(current.idempotencyKey, {
          ...current,
          deliveryState: 'unknown' as const,
        });
    }),
    markDeliveryDeadLetter: vi.fn(),
  } as unknown as OrgGroupAgentStore;
  const dispatch = vi.fn((_message, context, _options, hooks) =>
    (async function* () {
      if (options.dispatchGate) await options.dispatchGate;
      await hooks?.onResult?.({ resultText: '完成' });
      yield { type: 'session_init' as const, sessionId: context.resumeSessionId };
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
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
  const resolveRequester = vi.fn().mockResolvedValue({
    id: 'user-a',
    username: 'user',
    role: 'user',
    tenantId: 'tenant-a',
  });
  const router = new AgentDwsMessageRouter({
    agentCwd: '/tmp',
    messageStore,
    orgGroupAgentStore: orgStore,
    orgAgentStore: {
      get: vi.fn().mockReturnValue({ id: 'agent-a', tenantId: 'tenant-a', enabled: true }),
    } as never,
    accountStore: {
      getForTenant: vi.fn().mockResolvedValue(account),
    } as unknown as AgentDwsAccountStore,
    dispatch,
    resolveDefaultModel: () => ({ ref: 'models/test', model: 'test' }),
    resolveRequester,
    resolveRequesterGovernanceRole: vi.fn().mockResolvedValue(
      options.governanceRole === null ? undefined : (options.governanceRole ?? 'member'),
    ),
    ...(options.requesterOutcome
      ? { resolveRequesterOutcome: vi.fn().mockResolvedValue(options.requesterOutcome) }
      : {}),
    authorizeRequester: vi.fn().mockResolvedValue({ allowed: true }),
    authorizeCompletionRequester: vi.fn().mockResolvedValue(options.completionRequesterAuthorized ?? true),
    auditRequesterRejection: vi.fn(),
    auditToolPolicyRejection: vi.fn(),
    sender,
    ...(options.existingRun
      ? {
          runStore: { get: vi.fn().mockResolvedValue(options.existingRun) } as never,
        }
      : {}),
    isOrgAgentRuntimeV2Ready: () => true,
    logger,
    leaseTtlMs: 60_000,
    leaseRenewMs: 30_000,
    ...(options.frontReplyDeadlineMs ? { frontReplyDeadlineMs: options.frontReplyDeadlineMs } : {}),
  });
  return { router, messageStore, orgStore, dispatch, sender, resolveRequester, logger };
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
        orgAgentChannel: expect.objectContaining({
          bindingId: 'channel-binding-a', actorRole: 'member', approvalRoles: ['org_admin'],
          externalActor: expect.objectContaining({ role: 'member' }),
        }),
      }),
      expect.objectContaining({ allowedTools: ['Agent', 'BackgroundTask'], skipMemory: true }),
      expect.any(Object),
    );
    expect(test.orgStore.createDelivery).toHaveBeenCalledOnce();
    const legacyProviderKey = `agent-dws-reply-${createHash('sha256')
      .update('account-a:event-a')
      .digest('hex')
      .slice(0, 32)}`;
    expect(test.orgStore.createDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: legacyProviderKey }),
    );
    expect(test.sender.send).toHaveBeenCalledWith(
      expect.any(Object), expect.any(Object), '完成', legacyProviderKey,
    );
    expect(test.orgStore.markDeliveryProviderStarted).toHaveBeenCalledOnce();
    expect(test.orgStore.markDeliverySent).toHaveBeenCalledOnce();
  });


  it('routes an obvious continuation when its native thread has exactly one visible task', async () => {
    const routed = workOrder({ shortId: 'W-123456ABCDEF' });
    const test = setup({
      claimed: { ...item, content: '继续这个任务', workConversationId: 'workconv-route-a' },
      workOrders: [routed],
    });

    await expect(test.router.runOnce()).resolves.toBe(true);

    expect(test.orgStore.pinInboxContext).toHaveBeenCalledWith(expect.objectContaining({
      workConversationId: 'workconv-route-a',
    }));
    expect(test.dispatch).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ resumeSessionId: 'session-routed' }),
      expect.any(Object),
      expect.any(Object),
    );
  });

  it('asks for a task reference instead of guessing from one binding-level candidate', async () => {
    const routed = workOrder({ shortId: 'W-123456ABCDEF' });
    const test = setup({ content: '继续这个任务', workOrders: [routed] });

    await expect(test.router.runOnce()).resolves.toBe(true);

    expect(test.dispatch).not.toHaveBeenCalled();
    expect(test.sender.send).toHaveBeenCalledWith(
      expect.any(Object), expect.any(Object),
      expect.stringContaining('W-123456ABCDEF'), expect.any(String),
    );
  });

  it('keeps two active WorkOrders in one native thread ambiguous instead of choosing the latest', async () => {
    const first = workOrder({ shortId: 'W-123456ABCDEF', title: '采购异常核对' });
    const second = workOrder({
      workOrderId: 'work-route-b', shortId: 'W-987654ABCDEF', title: '采购合同复核',
    });
    const test = setup({
      claimed: { ...item, content: '复核这个任务', workConversationId: 'workconv-route-a' },
      workOrders: [first, second],
    });

    await expect(test.router.runOnce()).resolves.toBe(true);

    expect(test.dispatch).not.toHaveBeenCalled();
    expect(test.messageStore.saveDispatchResult).toHaveBeenCalledWith(
      'inbox-a', expect.stringMatching(/^agent-dws-router:/), 1,
      expect.stringContaining('W-123456ABCDEF'),
    );
    expect(test.sender.send).toHaveBeenCalledWith(
      expect.any(Object), expect.any(Object),
      expect.stringContaining('W-987654ABCDEF'), expect.any(String),
    );
  });

  it('writes and sends a durable clarification instead of dispatching an ambiguous continuation', async () => {
    const first = workOrder({ shortId: 'W-123456ABCDEF', title: '采购异常核对' });
    const second = workOrder({
      workOrderId: 'work-route-b', shortId: 'W-987654ABCDEF',
      workConversationId: 'workconv-route-b', title: '供应商资料补全',
    });
    const test = setup({ content: '继续这个任务', workOrders: [first, second] });

    await expect(test.router.runOnce()).resolves.toBe(true);

    expect(test.dispatch).not.toHaveBeenCalled();
    expect(test.messageStore.saveDispatchResult).toHaveBeenCalledWith(
      'inbox-a', expect.stringMatching(/^agent-dws-router:/), 1,
      expect.stringContaining('W-123456ABCDEF'),
    );
    expect(test.sender.send).toHaveBeenCalledWith(
      expect.any(Object), expect.any(Object),
      expect.stringContaining('W-987654ABCDEF'), expect.any(String),
    );
    expect(test.messageStore.complete).toHaveBeenCalledOnce();
  });

  it('does not route a private W-short number owned by another requester', async () => {
    const privateWork = workOrder({
      visibility: 'requester_only',
      createdByActor: {
        kind: 'external_user', provider: 'dingtalk', corpId: 'corp-a', openId: 'another-user',
        assurance: 'mapped', mappedUserId: 'user-b', role: 'member',
      },
    });
    const test = setup({ content: '继续 W-ABCDEF123456', shortWorkOrder: privateWork });

    await expect(test.router.runOnce()).resolves.toBe(true);

    expect(test.dispatch).not.toHaveBeenCalled();
    expect(test.sender.send).toHaveBeenCalledWith(
      expect.any(Object), expect.any(Object),
      expect.stringContaining('找不到你可访问的任务 W-ABCDEF123456'), expect.any(String),
    );
  });

  it('enforces trigger roles against the active governance membership persona', async () => {
    const denied = setup({ triggerRoles: ['org_admin'], governanceRole: 'member' });
    await expect(denied.router.runOnce()).resolves.toBe(true);
    expect(denied.dispatch).not.toHaveBeenCalled();

    const allowed = setup({ triggerRoles: ['org_admin'], governanceRole: 'org_admin' });
    await expect(allowed.router.runOnce()).resolves.toBe(true);
    expect(allowed.dispatch).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        orgAgentChannel: expect.objectContaining({ actorRole: 'org_admin' }),
      }),
      expect.any(Object),
      expect.any(Object),
    );
  });

  it('fails closed when a mapped requester no longer has an active membership', async () => {
    const test = setup({ governanceRole: null });
    await expect(test.router.runOnce()).resolves.toBe(true);
    expect(test.dispatch).not.toHaveBeenCalled();
    expect(test.sender.send).toHaveBeenCalledOnce();
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

  it('keeps an allowed guest in the group scope while topic Context is fail-closed', async () => {
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
          contextEnabled: false,
        }),
      }),
      expect.objectContaining({ allowedTools: [] }),
      expect.any(Object),
    );
  });

  it('exposes Context tools to a mapped member only when topic Context is enabled', async () => {
    const enabled = setup({ contextEnabled: true });
    await expect(enabled.router.runOnce()).resolves.toBe(true);
    expect(enabled.dispatch).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ orgAgentChannel: expect.objectContaining({ contextEnabled: true }) }),
      expect.objectContaining({ allowedTools: ['Agent', 'BackgroundTask', 'ContextSearch', 'ContextGet'] }),
      expect.any(Object),
    );

    const disabled = setup();
    await expect(disabled.router.runOnce()).resolves.toBe(true);
    expect(disabled.dispatch).toHaveBeenCalledWith(
      expect.any(Object), expect.any(Object),
      expect.objectContaining({ allowedTools: ['Agent', 'BackgroundTask'] }), expect.any(Object),
    );
  });

  it('does not inject a revoked AgentMemory derived from another group into the next group turn', async () => {
    const sourceMemoryId = 'conversation-memory-group-a';
    const promoted = {
      memoryId: 'agent-memory-a', tenantId: 'tenant-a', agentId: 'agent-a',
      memoryScope: 'agent', status: 'active', content: { fact: 'A 群受限采购底价' },
      provenance: { messageId: 'message-group-a', sourceMemoryId },
      promotedBy: 'admin-a', promotionReason: '管理员确认', policyRevision: 1, version: 1,
      createdAt: now, updatedAt: now,
    };
    const beforeRevocation = setup({ memories: [promoted] });
    await expect(beforeRevocation.router.runOnce()).resolves.toBe(true);
    expect(beforeRevocation.dispatch).toHaveBeenCalledWith(
      expect.any(Object), expect.objectContaining({
        systemContext: expect.stringContaining('A 群受限采购底价'),
      }), expect.any(Object), expect.any(Object),
    );

    const afterRevocation = setup({ memories: [{
      ...promoted, status: 'revoked', version: 2, revokedAt: now,
    }] });
    await expect(afterRevocation.router.runOnce()).resolves.toBe(true);
    expect(afterRevocation.dispatch).toHaveBeenCalledWith(
      expect.any(Object), expect.objectContaining({
        systemContext: expect.not.stringContaining('A 群受限采购底价'),
      }), expect.any(Object), expect.any(Object),
    );
  });

  it('limits an unmapped guest with shared read-only access to Context tools', async () => {
    const test = setup({
      guestReadOnly: true,
      contextEnabled: true,
      requesterOutcome: { status: 'unmapped', reason: 'DWS_IDENTITY_NOT_MAPPED' },
    });

    await expect(test.router.runOnce()).resolves.toBe(true);

    expect(test.dispatch).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ user: undefined }),
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
        backgroundTaskId: 'bg-a',
        workOrderId: 'work-a',
        attemptId: 'attempt-a',
        attemptFence: 1,
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
          externalActor: expect.objectContaining({ kind: 'service_event', workOrderId: 'work-a' }),
        }),
      }),
      expect.objectContaining({ dispatcherCompletion: true, allowedTools: [] }),
      expect.any(Object),
    );
  });

  it('routes requester-only task completion to its pinned creator instead of the group', async () => {
    const completion = {
      ...item,
      senderOpenDingtalkId: undefined,
      payload: {
        ...item.payload,
        source: 'background_task_completion',
        backgroundTaskId: 'bg-a',
        workOrderId: 'work-a',
        attemptId: 'attempt-a',
        attemptFence: 1,
      },
    };
    const test = setup({ claimed: completion, workVisibility: 'requester_only' });
    await expect(test.router.runOnce()).resolves.toBe(true);

    expect(test.orgStore.createDelivery).toHaveBeenCalledWith(expect.objectContaining({
      visibility: 'requester_only',
      destination: expect.objectContaining({
        kind: 'direct',
        peerOpenId: 'requester-open-id',
      }),
    }));
    expect(test.sender.send).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        type: 'user_im_message_receive_o2o_all',
        senderOpenDingtalkId: 'requester-open-id',
      }),
      '完成',
      expect.any(String),
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

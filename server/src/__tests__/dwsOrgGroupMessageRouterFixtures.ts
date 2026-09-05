import { vi } from 'vitest';

import type { AgentRunDispatch } from '../agent/index.js';
import type {
  AgentDwsAccountRecord,
  AgentDwsAccountStore,
} from '../data/agentDwsAccounts/index.js';
import type {
  AgentDwsInboxRecord,
  AgentDwsMessageStore,
} from '../data/agentDwsMessages/index.js';
import type {
  DwsDeliveryIntent,
  OrgAgentChannelBinding,
  OrgGroupAgentStore,
} from '../data/orgGroupAgents/index.js';
import { AgentDwsMessageRouter } from '../dws/personalMessageRouter.js';
import type { DwsRequesterResolution } from '../dws/requesterIdentityResolver.js';

// Keep reply-window fixtures relative to wall-clock time so the suite cannot expire.
export const now = new Date().toISOString();

export interface DwsOrgGroupRouterHarnessOptions {
  liveDeny?: boolean;
  guestReadOnly?: boolean;
  requesterOutcome?: DwsRequesterResolution;
  senderReceipt?: Record<string, unknown> | null;
  claimed?: AgentDwsInboxRecord;
  /** Claims and current authorization decisions returned across runOnce calls. */
  claimedSequence?: AgentDwsInboxRecord[];
  authorizationSequence?: Array<{ allowed: boolean; reason?: string }>;
  triggerRoles?: Array<'member' | 'org_admin'>;
  governanceRole?: 'member' | 'org_admin' | null;
  workVisibility?: 'conversation' | 'requester_only';
  content?: string;
  contextEnabled?: boolean;
  dwsBusinessEnabled?: boolean;
  workOrders?: Array<Record<string, unknown>>;
  shortWorkOrder?: Record<string, unknown> | null;
  completionRequesterAuthorized?: boolean;
  memories?: Array<Record<string, unknown>>;
  frontReplyDeadlineMs?: number;
  dispatchGate?: Promise<void>;
  /** Simulates a process failure before any provider transport can start. */
  failFirstDeliveryClaim?: boolean;
  systemInstructions?: string;
  existingRun?: Record<string, unknown>;
  memoryPolicy?: {
    readAgent: boolean;
    readConversation: boolean;
    adminWriteConversation: boolean;
  };
}

export function createBinding(options: DwsOrgGroupRouterHarnessOptions): OrgAgentChannelBinding {
  return {
    bindingId: 'channel-binding-a',
    tenantId: 'tenant-a',
    accountId: 'account-a',
    agentId: 'agent-a',
    conversationId: 'cid-a',
    channelKind: 'group',
    activationState: 'active',
    enabled: true,
    conversationSpaceId: 'space-a',
    serviceSessionId: 'service-session-a',
    workspaceId: 'ws_tenant-a__agent_agent-a',
    accountIdentity: {
      profileId: 'corp-a:agent-self', corpId: 'corp-a', dingtalkUserId: 'agent-self',
      identityUpdatedAt: now,
    },
    policy: {
      enabled: true,
      membership: options.guestReadOnly ? 'members_and_guests' : 'members',
      guest: options.guestReadOnly ? 'shared_read_only' : 'deny',
      taskVisibility: 'conversation',
      completion: 'reply_to_work_conversation',
      liveDeny: options.liveDeny === true,
    },
    effectiveConfig: {
      identity: { displayName: '开开' },
      instructions: { system: options.systemInstructions ?? '' },
      knowledge: { contextEnabled: options.contextEnabled ?? false, sourceIds: ['source-a'] },
      capabilities: {
        skillIds: [],
        toolNames: [
          'Agent',
          'BackgroundTask',
          'ContextSearch',
          'ContextGet',
          ...(options.dwsBusinessEnabled ? ['DwsBusiness'] : []),
        ],
        dwsResourceIds: options.dwsBusinessEnabled ? ['doc:doc-a'] : [],
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
}

export const delivery: DwsDeliveryIntent = {
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
  source: 'command',
  deliveryKind: 'front_reply',
  disposition: 'replied',
  deliveryState: 'pending',
  destination: {
    provider: 'dingtalk',
    accountId: 'account-a',
    conversationId: 'cid-a',
    kind: 'group',
  },
  content: '完成',
  idempotencyKey: 'delivery-key',
  attempt: 0,
  leaseFence: 0,
  createdAt: now,
  updatedAt: now,
};

export const account: AgentDwsAccountRecord = {
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
  identityUpdatedAt: now,
  createdAt: now,
  createdBy: 'admin',
  updatedAt: now,
  updatedBy: 'admin',
};

export const item: AgentDwsInboxRecord = {
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

export function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  return {
    promise: new Promise<void>((done) => {
      resolve = done;
    }),
    resolve: () => resolve(),
  };
}

export function workOrder(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
      kind: 'external_user',
      provider: 'dingtalk',
      corpId: 'corp-a',
      openId: 'sender-a',
      assurance: 'mapped',
      mappedUserId: 'user-a',
      role: 'member',
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


export function setup(options: DwsOrgGroupRouterHarnessOptions = {}) {
  const claimed = options.claimed ?? { ...item, content: options.content ?? item.content };
  const claimedQueue = [...(options.claimedSequence ?? [claimed])];
  const messageStore = {
    claimNext: vi.fn(async () => claimedQueue.shift() ?? null),
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
    saveRejectionResult: vi.fn().mockImplementation(async (
      _id: string, _owner: string, _fence: number, text: string, reasonCode: string,
    ) => ({ ...claimed, state: 'reply_pending', replyKind: 'access_rejection',
      responseText: text, rejectionReasonCode: reasonCode })),
    // 真实 store 会写入当前时间；测试夹具也必须对齐 DWS 23 小时幂等窗口。
    // 固定时间会随真实时钟推移而穿越窗口，造成与业务无关的假失败。
    markReplyAttemptStarted: vi.fn().mockImplementation(async () => ({
      ...claimed,
      state: 'reply_pending',
      replyStartedAt: new Date().toISOString(),
    })),
    complete: vi.fn().mockResolvedValue({ ...claimed, state: 'completed' }),
    reject: vi.fn().mockImplementation(async (
      _id: string, _owner: string, _fence: number, rejectionReasonCode: string,
    ) => ({ ...claimed, state: 'completed', disposition: 'rejected', rejectionReasonCode })),
    blockReply: vi.fn().mockResolvedValue({ ...claimed, state: 'dead_letter' }),
    markReplyUnknown: vi.fn().mockResolvedValue({
      ...claimed, state: 'dead_letter', disposition: 'delivery_unknown' }),
    fail: vi.fn().mockResolvedValue(undefined),
    defer: vi.fn().mockResolvedValue(undefined),
    releaseClaim: vi.fn(),
    pinLegacyIdentityOrTerminate: vi.fn(),
    init: vi.fn(),
    ingest: vi.fn().mockResolvedValue({ record: claimed, created: true }),
    listForAccount: vi.fn(),
    hasObservedGroup: vi.fn(),
    deleteForTenant: vi.fn(),
  } as unknown as AgentDwsMessageStore;
  const binding = createBinding(options);
  // Durable intents survive the simulated router process failure across runOnce calls.
  const storedDeliveries = new Map<string, typeof delivery>();
  let deliverySequence = 0;
  let deliveryClaimSequence = 0;
  const orgStore = {
    reconcileAllExpiredDeliveries: vi.fn().mockResolvedValue(0),
    claimNextDelivery: vi.fn(async () => {
      if (claimedQueue[0]?.state === 'reply_pending') return null;
      return [...storedDeliveries.values()].find(
        candidate => candidate.deliveryState === 'pending',
      ) ?? null;
    }),
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
    getWorkConversation: vi
      .fn()
      .mockImplementation(async (_tenantId: string, workConversationId: string) => {
        if (workConversationId === 'workconv-a') {
          return {
            workConversationId,
            tenantId: 'tenant-a',
            bindingId: 'channel-binding-a',
            rootKey: 'mid-a',
            rootMessageId: 'mid-a',
            sessionId: 'session-a',
            state: 'active',
            createdAt: now,
            updatedAt: now,
          };
        }
        const routed = [options.shortWorkOrder, ...(options.workOrders ?? [])].find(
          (candidate) => candidate?.workConversationId === workConversationId,
        );
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
      workOrderId: 'work-a',
      tenantId: 'tenant-a',
      agentId: 'agent-a',
      bindingId: 'channel-binding-a',
      workConversationId: 'workconv-a',
      title: '整理采购异常',
      resultEnvelope: { summary: '敏感结果' },
      state: 'completed',
      currentAttemptNo: 1,
      visibility: options.workVisibility ?? 'conversation',
      createdByActor: {
        kind: 'external_user',
        provider: 'dingtalk',
        corpId: 'corp-a',
        openId: 'requester-open-id',
        assurance: 'mapped',
        mappedUserId: 'user-a',
        role: 'member',
      },
    }),
    getWorkOrderByShortId: vi
      .fn()
      .mockImplementation(async (_tenantId: string, _agentId: string, shortId: string) =>
        options.shortWorkOrder?.shortId === shortId ? options.shortWorkOrder : null,
      ),
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
    // Mirrors the production recovery split after cancellation.
    cancelUnstartedDeliveriesForInbox: vi.fn(async (
      _tenantId: string,
      inboxId: string,
      reason: string,
    ) => {
      let cancelled = 0;
      for (const [key, candidate] of storedDeliveries) {
        if (candidate.inboxId !== inboxId || candidate.deliveryState !== 'pending') continue;
        storedDeliveries.set(key, {
          ...candidate,
          deliveryState: 'dead_letter' as const,
          lastError: reason,
        });
        cancelled += 1;
      }
      return cancelled;
    }),
    getReplyRecoveryStateForInbox: vi.fn(async (_tenantId: string, inboxId: string) => {
      const matches = [...storedDeliveries.values()].filter(candidate => (
        candidate.inboxId === inboxId && candidate.deliveryKind === 'front_reply'
      ));
      if (matches.some(candidate => candidate.deliveryState === 'unknown')) return 'unknown';
      if (matches.some(candidate => candidate.deliveryState === 'sent')) return 'sent';
      return matches.length > 0 ? 'unstarted' : 'none';
    }),
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
    send: vi.fn(async (
      _account: unknown,
      _event: unknown,
      _text: string,
      _key: string,
      onProviderStart?: () => Promise<void>,
    ) => {
      await onProviderStart?.();
      return options.senderReceipt === null
        ? undefined
        : (options.senderReceipt ?? { status: 'accepted', acceptedAt: now });
    }),
  };
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
  const authorizationQueue = [...(options.authorizationSequence ?? [{ allowed: true }])];
  const authorizeRequester = vi.fn(async () => authorizationQueue.shift() ?? { allowed: true });
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
    resolveRequesterGovernanceRole: vi
      .fn()
      .mockResolvedValue(
        options.governanceRole === null ? undefined : (options.governanceRole ?? 'member'),
      ),
    ...(options.requesterOutcome
      ? { resolveRequesterOutcome: vi.fn().mockResolvedValue(options.requesterOutcome) }
      : {}),
    authorizeRequester,
    authorizeCompletionRequester: vi
      .fn()
      .mockResolvedValue(options.completionRequesterAuthorized ?? true),
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
  return {
    router, messageStore, orgStore, dispatch, sender, resolveRequester, authorizeRequester, logger,
  };
}

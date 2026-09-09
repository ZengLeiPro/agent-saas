import { vi } from 'vitest';

import type { AgentRunDispatch } from '../agent/index.js';
import type {
  AgentDwsAccountRecord,
  AgentDwsAccountStore,
} from '../data/agentDwsAccounts/index.js';
import {
  DWS_INBOX_V1_IDENTITY_UNPROVABLE,
  type AgentDwsInboxRecord,
  type AgentDwsMessageStore,
} from '../data/agentDwsMessages/index.js';
import type { OrgGroupAgentStore } from '../data/orgGroupAgents/index.js';
import {
  AgentDwsMessageRouter,
  type AgentDwsDefaultModelResolution,
} from '../dws/personalMessageRouter.js';
import type { DwsPersonalMessageSenderLike } from '../dws/personalMessageSender.js';

export const account: AgentDwsAccountRecord = {
  accountId: 'account-a',
  tenantId: 'tenant-a',
  agentId: 'agent-a',
  displayName: '开开',
  loginId: '17300000000',
  profileId: 'corp-a:agent-self',
  corpId: 'corp-a',
  dingtalkUserId: 'agent-self',
  status: 'active',
  runtimeStatus: 'ready',
  eventKinds: ['at_me', 'all_direct'],
  revision: 2,
  identityUpdatedAt: '2026-08-13T00:00:00.000Z',
  createdAt: '2026-08-14T00:00:00.000Z',
  createdBy: 'admin-a',
  updatedAt: '2026-08-14T00:00:00.000Z',
  updatedBy: 'admin-a',
};
export const requester = {
  id: 'user-a',
  username: 'alice',
  role: 'user' as const,
  tenantId: 'tenant-a',
  realName: '爱丽丝',
  dingtalkStaffId: 'sender-a',
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
  content: '请汇总今天的进展',
  payload: {
    accountIdentity: {
      profileId: account.profileId,
      corpId: account.corpId,
      dingtalkUserId: account.dingtalkUserId,
    },
  },
  state: 'processing',
  attempt: 1,
  maxAttempts: 8,
  leaseOwner: 'worker-a',
  leaseFence: 1,
  leaseExpiresAt: '2026-08-14T01:00:00.000Z',
  createdAt: '2026-08-14T00:00:00.000Z',
  updatedAt: '2026-08-14T00:00:00.000Z',
};

export function setup(
  input: {
    claimed?: AgentDwsInboxRecord | AgentDwsInboxRecord[];
    dispatch?: AgentRunDispatch;
    maxConcurrency?: number;
    pollMs?: number;
    existingRun?: { runId: string; sessionId: string; status: string } | null;
    recoveredEvents?: Array<Record<string, unknown>>;
    bindingPeerOpenDingtalkId?: string;
    resolveDefaultModel?: (tenantId: string) => AgentDwsDefaultModelResolution | null;
    resolveRequester?: typeof requester | null;
    requesterAllowed?: boolean;
    claimNext?: AgentDwsMessageStore['claimNext'];
    legacyIdentityUnprovable?: boolean;
    logger?: { info(message: string): void; warn(message: string): void };
    orgGroupAgentStore?: OrgGroupAgentStore;
  } = {},
) {
  const claimedItems = Array.isArray(input.claimed) ? input.claimed : [input.claimed ?? item];
  const claimed = claimedItems[0]!;
  const claimedById = new Map(claimedItems.map((entry) => [entry.inboxId, entry]));
  const defaultClaimNext = vi.fn();
  for (const entry of claimedItems) defaultClaimNext.mockResolvedValueOnce(entry);
  defaultClaimNext.mockResolvedValue(null);
  const claimNext = input.claimNext ?? defaultClaimNext;
  const messageStore = {
    init: vi.fn(),
    ingest: vi.fn(),
    listForAccount: vi.fn().mockResolvedValue([]),
    hasObservedGroup: vi.fn().mockResolvedValue(false),
    listActiveForAccount: vi.fn().mockResolvedValue([]),
    getById: vi
      .fn()
      .mockImplementation(
        async (_tenantId: string, inboxId: string) => claimedById.get(inboxId) ?? null,
      ),
    claimNext,
    releaseClaim: vi.fn().mockResolvedValue({ ...claimed, state: 'pending', attempt: 0 }),
    renewLease: vi.fn().mockResolvedValue(true),
    pinLegacyIdentityOrTerminate: vi.fn().mockImplementation(async (inboxId: string) => {
      const entry = claimedById.get(inboxId) ?? claimed;
      return input.legacyIdentityUnprovable
        ? {
            ...entry,
            state: 'dead_letter' as const,
            leaseOwner: undefined,
            leaseExpiresAt: undefined,
            nextAttemptAt: undefined,
            lastError: DWS_INBOX_V1_IDENTITY_UNPROVABLE,
            completedAt: new Date().toISOString(),
          }
        : {
            ...entry,
            payload: {
              ...entry.payload,
              accountIdentity: {
                profileId: account.profileId,
                corpId: account.corpId,
                dingtalkUserId: account.dingtalkUserId,
              },
            },
          };
    }),
    getOrCreateBinding: vi
      .fn()
      .mockImplementation(async (tenantId: string, accountId: string, conversationId: string) => ({
        bindingId: `binding-${conversationId}`,
        tenantId,
        accountId,
        conversationId,
        requesterUserId: 'user-a',
        sessionId: conversationId === 'cid-a' ? 'session-a' : `session-${conversationId}`,
        ...(input.bindingPeerOpenDingtalkId
          ? { peerOpenDingtalkId: input.bindingPeerOpenDingtalkId }
          : {}),
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      })),
    markDispatchStarted: vi
      .fn()
      .mockImplementation(
        async (
          inboxId: string,
          _owner: string,
          _fence: number,
          sessionId: string,
          runId: string,
        ) => ({ ...(claimedById.get(inboxId) ?? claimed), sessionId, runId }),
      ),
    saveDispatchResult: vi
      .fn()
      .mockImplementation(
        async (inboxId: string, _owner: string, _fence: number, responseText: string) => ({
          ...(claimedById.get(inboxId) ?? claimed),
          state: 'reply_pending',
          responseText,
        }),
      ),
    saveRejectionResult: vi
      .fn()
      .mockImplementation(
        async (
          inboxId: string,
          _owner: string,
          _fence: number,
          responseText: string,
          rejectionReasonCode: string,
        ) => ({
          ...(claimedById.get(inboxId) ?? claimed),
          state: 'reply_pending',
          replyKind: 'access_rejection',
          responseText,
          rejectionReasonCode,
        }),
      ),
    markReplyAttemptStarted: vi.fn().mockImplementation(async (inboxId: string) => {
      const entry = claimedById.get(inboxId) ?? claimed;
      return {
        ...entry,
        state: 'reply_pending',
        replyStartedAt: entry.replyStartedAt ?? item.updatedAt,
      };
    }),
    defer: vi.fn().mockResolvedValue({ ...claimed, state: 'retry_wait' }),
    complete: vi.fn().mockResolvedValue({ ...claimed, state: 'completed' }),
    reject: vi
      .fn()
      .mockImplementation(
        async (_inboxId: string, _owner: string, _fence: number, rejectionReasonCode: string) => ({
          ...claimed,
          state: 'completed',
          disposition: 'rejected',
          rejectionReasonCode,
        }),
      ),
    blockReply: vi
      .fn()
      .mockResolvedValue({ ...claimed, state: 'dead_letter', disposition: 'reply_blocked' }),
    markReplyUnknown: vi
      .fn()
      .mockResolvedValue({ ...claimed, state: 'dead_letter', disposition: 'delivery_unknown' }),
    fail: vi.fn().mockResolvedValue({ ...claimed, state: 'retry_wait' }),
    deleteForTenant: vi.fn(),
  } satisfies AgentDwsMessageStore;
  const accountStore = {
    getForTenant: vi.fn().mockResolvedValue(account),
  } as unknown as AgentDwsAccountStore;
  const sender: DwsPersonalMessageSenderLike = {
    send: vi.fn().mockResolvedValue({ status: 'accepted', acceptedAt: item.createdAt }),
  };
  const auditRequesterRejection = vi.fn().mockResolvedValue(undefined);
  const auditToolPolicyRejection = vi.fn().mockResolvedValue(undefined);
  const authorizeRequester = vi
    .fn()
    .mockResolvedValue(
      input.requesterAllowed === false
        ? { allowed: false, reason: 'ASSIGNMENT_DENIED' }
        : { allowed: true },
    );
  const dispatch =
    input.dispatch ??
    vi.fn((_message, _context, _options, hooks) =>
      (async function* () {
        await hooks?.onResult?.({ resultText: '今天已完成三项工作。' });
        yield { type: 'session_init' as const, sessionId: 'session-a' };
        yield { type: 'text_delta' as const, content: '今天已完成三项工作。' };
        yield { type: 'done' as const };
      })(),
    );
  const router = new AgentDwsMessageRouter({
    agentCwd: '/workspace',
    messageStore,
    accountStore,
    dispatch,
    resolveDefaultModel:
      input.resolveDefaultModel ??
      vi.fn(() => ({
        ref: 'group/model-a',
        model: 'model-a',
        connection: { apiKey: 'test-key', baseUrl: 'https://model.test/v1' },
        providerOptions: { protocol: 'responses' as const },
      })),
    resolveRequester: vi
      .fn()
      .mockResolvedValue(input.resolveRequester === undefined ? requester : input.resolveRequester),
    authorizeRequester,
    auditRequesterRejection,
    auditToolPolicyRejection,
    sender,
    ...(input.orgGroupAgentStore ? { orgGroupAgentStore: input.orgGroupAgentStore } : {}),
    ...(input.existingRun !== undefined
      ? { runStore: { get: vi.fn().mockResolvedValue(input.existingRun) } }
      : {}),
    ...(input.recoveredEvents
      ? { eventStore: { listByRun: vi.fn().mockResolvedValue(input.recoveredEvents) } }
      : {}),
    now: () => Date.parse(item.updatedAt) + 60_000,
    pollMs: input.pollMs ?? 60_000,
    leaseTtlMs: 60_000,
    leaseRenewMs: 30_000,
    ...(input.maxConcurrency ? { maxConcurrency: input.maxConcurrency } : {}),
    ...(input.logger ? { logger: input.logger } : {}),
  });
  return {
    router,
    messageStore,
    accountStore,
    dispatch,
    sender,
    authorizeRequester,
    auditRequesterRejection,
    auditToolPolicyRejection,
  };
}

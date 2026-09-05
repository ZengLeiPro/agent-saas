import type { AgentDwsAccountRecord } from '../data/agentDwsAccounts/index.js';
import type { AgentDwsInboxRecord } from '../data/agentDwsMessages/index.js';
import type { DwsDeliveryIntent, OrgAgentChannelBinding } from '../data/orgGroupAgents/index.js';
import type { DwsRequesterResolution } from '../dws/requesterIdentityResolver.js';

// 普通回复使用本轮时间，避免固定日期跨过 DWS 幂等窗口后整组测试失效。
export const now = new Date().toISOString();

export interface DwsOrgGroupRouterHarnessOptions {
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
  dwsBusinessEnabled?: boolean;
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

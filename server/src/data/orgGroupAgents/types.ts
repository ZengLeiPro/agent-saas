export type ExternalActorAssurance = 'mapped' | 'unmapped' | 'ambiguous';
export type OrgAgentGovernanceRole = 'member' | 'org_admin';

export interface AgentPrincipal {
  kind: 'org_agent';
  tenantId: string;
  agentId: string;
  accountId: string;
  workspaceId: string;
}

export interface ExternalActorRef {
  kind: 'external_user';
  provider: 'dingtalk';
  corpId: string;
  openId: string;
  displayName?: string;
  mappedUserId?: string;
  role?: OrgAgentGovernanceRole;
  assurance: ExternalActorAssurance;
}

export interface OrgAgentServiceEventRef {
  kind: 'service_event';
  issuer: 'runtime';
  workOrderId: string;
  attemptId: string;
  fence: number;
}

export type OrgAgentChannelActorRef = ExternalActorRef | OrgAgentServiceEventRef;

export interface ChannelPrincipal {
  provider: 'dingtalk';
  accountId: string;
  conversationId: string;
  kind: 'group' | 'direct';
  peerOpenId?: string;
}

export interface OrgAgentChannelPolicy {
  enabled: boolean;
  membership: 'members' | 'members_and_guests';
  guest: 'deny' | 'shared_read_only';
  taskVisibility: 'conversation' | 'requester_only';
  completion: 'reply_to_work_conversation' | 'silent';
  liveDeny: boolean;
}

export interface OrgAgentEffectiveConfig {
  identity: { displayName?: string };
  instructions: { system: string };
  knowledge: { contextEnabled: boolean; sourceIds: string[] };
  capabilities: {
    skillIds: string[];
    toolNames: string[];
    /**
     * 组织群可由 DwsBusiness 访问的资源。每项使用 `<module>:<resourceId>`，例如
     * `doc:abc123`。字段缺失与空数组都表示没有任何 DWS 数据权限。
     */
    dwsResourceIds: string[];
  };
  memory: {
    readAgent: boolean;
    readConversation: boolean;
    adminWriteConversation: boolean;
  };
  access: { triggerRoles: OrgAgentGovernanceRole[]; approvalRoles: OrgAgentGovernanceRole[] };
  speech: { proactive: boolean; requireMention: boolean };
}

export interface OrgAgentChannelBinding {
  bindingId: string;
  tenantId: string;
  accountId: string;
  agentId: string;
  conversationId: string;
  channelKind: 'group' | 'direct';
  activationState: 'shadow' | 'active' | 'disabled';
  enabled: boolean;
  conversationSpaceId: string;
  serviceSessionId: string;
  workspaceId: string;
  policy: OrgAgentChannelPolicy;
  effectiveConfig: OrgAgentEffectiveConfig;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface OrgAgentWorkConversation {
  workConversationId: string;
  tenantId: string;
  bindingId: string;
  rootKey: string;
  rootMessageId?: string;
  sessionId: string;
  state: 'active' | 'closed';
  createdAt: string;
  updatedAt: string;
}

export type DwsDeliveryState = 'pending' | 'sending' | 'sent' | 'unknown' | 'dead_letter';
export interface DwsDeliveryIntent {
  deliveryId: string;
  tenantId: string;
  inboxId?: string;
  accountId: string;
  conversationId: string;
  agentId?: string;
  bindingId?: string;
  conversationSpaceId?: string;
  workConversationId?: string;
  policyRevision?: number;
  visibility?: 'conversation' | 'requester_only' | 'public_notice';
  sourceWorkOrderId?: string;
  sourceAttemptId?: string;
  source: 'command' | 'background_completion' | 'system';
  deliveryKind:
    'front_reply' | 'access_rejection' | 'task_completion' | 'system_notice' | 'needs_input';
  disposition: 'replied' | 'rejected' | 'ignored' | 'unrouteable';
  deliveryState: DwsDeliveryState;
  destination: ChannelPrincipal;
  content: string;
  idempotencyKey: string;
  providerReceipt?: Record<string, unknown>;
  attempt: number;
  leaseOwner?: string;
  leaseFence: number;
  leaseExpiresAt?: string;
  providerAttemptPhase: 'legacy_unknown' | 'before_provider' | 'provider_started';
  providerStartedAt?: string;
  nextAttemptAt?: string;
  lastAttemptAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export type DwsDeliveryIntentCreate = Omit<
  DwsDeliveryIntent,
  'deliveryId' | 'deliveryState' | 'attempt' | 'leaseFence' | 'providerAttemptPhase'
    | 'createdAt' | 'updatedAt'
>;

export type OrgAgentWorkOrderState =
  'queued' | 'running' | 'waiting_input' | 'paused' | 'completed' | 'failed' | 'cancelled';

export interface OrgAgentResultEnvelope {
  status: 'completed' | 'failed' | 'cancelled' | 'waiting_input';
  summary: string;
  facts: Array<{ key: string; value: string }>;
  artifacts: Array<{ path: string; digest: string; size: number }>;
  writeScope: string[];
}

export interface OrgAgentWorkOrder {
  workOrderId: string;
  shortId: string;
  tenantId: string;
  agentId: string;
  bindingId: string;
  workConversationId: string;
  idempotencyKey: string;
  title: string;
  state: OrgAgentWorkOrderState;
  visibility: 'conversation' | 'requester_only';
  currentAttemptNo: number;
  createdByActor: ExternalActorRef;
  policySnapshot: Record<string, unknown>;
  cancelPolicy: Record<string, unknown>;
  control: OrgAgentWorkOrderControl;
  resultEnvelope?: OrgAgentResultEnvelope;
  version: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface OrgAgentWorkOrderControl {
  revision: number;
  supplements: Array<{
    text: string;
    actorOpenId: string;
    createdAt: string;
    kind: 'supplement' | 'review';
  }>;
  workerType: 'general' | 'explore';
}

export interface OrgAgentWorkAttempt {
  attemptId: string;
  tenantId: string;
  workOrderId: string;
  attemptNo: number;
  runtimeRunId: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  parentAttemptId?: string;
  taskWorkspaceId: string;
  sandboxScopeId: string;
  mountSubPath: string;
  sharedReadOnlySubPath: string;
  publishState: 'pending' | 'published' | 'conflict' | 'rejected';
  checkpoint?: Record<string, unknown>;
  artifactManifest?: Record<string, unknown>;
  resultEnvelope?: OrgAgentResultEnvelope;
  failure?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface OrgAgentMemory {
  memoryId: string;
  tenantId: string;
  agentId: string;
  bindingId?: string;
  workConversationId?: string;
  workOrderId?: string;
  memoryScope: 'agent' | 'conversation' | 'task_checkpoint';
  status: 'active' | 'revoked' | 'deleted';
  content: Record<string, unknown>;
  provenance: Record<string, unknown>;
  promotedBy?: string;
  promotionReason?: string;
  policyRevision: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  revokedAt?: string;
  deletedAt?: string;
}

export interface OrgAgentGroupWorkspaceData {
  conversations: OrgAgentWorkConversation[];
  workOrders: OrgAgentWorkOrder[];
  attempts: OrgAgentWorkAttempt[];
  memories: OrgAgentMemory[];
}

export interface OrgGroupAgentStore {
  init(): Promise<void>;
  ensureShadowBinding(input: {
    tenantId: string;
    accountId: string;
    agentId: string;
    conversationId: string;
    channelKind: 'group' | 'direct';
    workspaceId: string;
  }): Promise<OrgAgentChannelBinding>;
  getBinding(
    tenantId: string,
    accountId: string,
    conversationId: string,
  ): Promise<OrgAgentChannelBinding | null>;
  getBindingById(tenantId: string, bindingId: string): Promise<OrgAgentChannelBinding | null>;
  listBindings(tenantId: string, accountId: string): Promise<OrgAgentChannelBinding[]>;
  updateBinding(input: {
    tenantId: string;
    accountId: string;
    conversationId: string;
    expectedRevision: number;
    enabled: boolean;
    policy: OrgAgentChannelPolicy;
    effectiveConfig: OrgAgentEffectiveConfig;
  }): Promise<OrgAgentChannelBinding>;
  getOrCreateWorkConversation(input: {
    tenantId: string;
    bindingId: string;
    rootKey: string;
    rootMessageId?: string;
  }): Promise<OrgAgentWorkConversation>;
  findWorkConversationByMessage(input: {
    tenantId: string;
    bindingId: string;
    accountId: string;
    conversationId: string;
    messageIds: string[];
  }): Promise<OrgAgentWorkConversation | null>;
  pinInboxRouting(input: {
    inboxId: string;
    conversationSpaceId: string;
    workConversationId: string;
    policyRevision: number;
  }): Promise<void>;
  pinInboxContext(input: {
    inboxId: string;
    externalActor: OrgAgentChannelActorRef;
    conversationSpaceId: string;
    workConversationId: string;
    policyRevision: number;
  }): Promise<void>;
  createDelivery(input: DwsDeliveryIntentCreate): Promise<DwsDeliveryIntent>;
  claimDelivery(deliveryId: string, owner: string, ttlMs: number): Promise<DwsDeliveryIntent>;
  claimNextDelivery(owner: string, ttlMs: number): Promise<DwsDeliveryIntent | null>;
  reconcileAllExpiredDeliveries(limit?: number): Promise<number>;
  markDeliveryProviderStarted(
    deliveryId: string,
    owner: string,
    fence: number,
  ): Promise<DwsDeliveryIntent>;
  releaseClaimedDeliveryForRetry(
    deliveryId: string,
    owner: string,
    fence: number,
    error: unknown,
    delayMs: number,
    maxAttempts: number,
  ): Promise<DwsDeliveryIntent>;
  markDeliverySent(
    deliveryId: string,
    owner: string,
    fence: number,
    receipt: Record<string, unknown>,
  ): Promise<DwsDeliveryIntent>;
  markDeliveryUnknown(
    deliveryId: string,
    owner: string,
    fence: number,
    error: unknown,
  ): Promise<DwsDeliveryIntent>;
  markDeliveryDeadLetter(deliveryId: string, reason: string): Promise<DwsDeliveryIntent>;
  markClaimedDeliveryDeadLetter(
    deliveryId: string,
    owner: string,
    fence: number,
    reason: string,
  ): Promise<DwsDeliveryIntent>;
  reconcileExpiredDeliveries(tenantId: string, accountId: string, limit?: number): Promise<number>;
  listDeliveries(tenantId: string, accountId: string, limit?: number): Promise<DwsDeliveryIntent[]>;
  getDelivery(tenantId: string, deliveryId: string): Promise<DwsDeliveryIntent | null>;
  reconcileDelivery(input: {
    tenantId: string;
    deliveryId: string;
    actorId: string;
    reason: string;
    evidence: Record<string, unknown>;
    outcome: 'confirmed_sent' | 'confirmed_not_sent' | 'indeterminate';
  }): Promise<DwsDeliveryIntent>;
  createWorkOrder(input: {
    tenantId: string;
    agentId: string;
    bindingId: string;
    workConversationId: string;
    idempotencyKey: string;
    title: string;
    visibility: 'conversation' | 'requester_only';
    createdByActor: ExternalActorRef;
    policySnapshot: Record<string, unknown>;
    cancelPolicy: Record<string, unknown>;
    workerType?: 'general' | 'explore';
  }): Promise<OrgAgentWorkOrder>;
  createWorkAttempt(input: {
    tenantId: string;
    workOrderId: string;
    runtimeRunId: string;
    attemptId: string;
    parentAttemptId?: string;
    taskWorkspaceId: string;
    sandboxScopeId: string;
    mountSubPath: string;
    sharedReadOnlySubPath: string;
  }): Promise<OrgAgentWorkAttempt>;
  listWorkAttempts(tenantId: string, workOrderId: string): Promise<OrgAgentWorkAttempt[]>;
  loadGroupWorkspace(input: {
    tenantId: string;
    bindingIds: string[];
    limitPerBinding?: number;
  }): Promise<OrgAgentGroupWorkspaceData>;
  transitionWorkAttempt(input: {
    tenantId: string;
    runtimeRunId: string;
    status: 'running' | 'completed' | 'failed' | 'cancelled';
    resultEnvelope?: OrgAgentResultEnvelope;
    failure?: string;
    checkpoint?: Record<string, unknown>;
    artifactManifest?: Record<string, unknown>;
    publishState?: OrgAgentWorkAttempt['publishState'];
  }): Promise<OrgAgentWorkAttempt | null>;
  transitionWorkAttemptPublishState(input: {
    tenantId: string;
    attemptId: string;
    expectedState: 'pending';
    state: 'published' | 'conflict' | 'rejected';
    artifactManifest?: Record<string, unknown>;
  }): Promise<OrgAgentWorkAttempt>;
  getWorkOrder(tenantId: string, workOrderId: string): Promise<OrgAgentWorkOrder | null>;
  getWorkOrderByShortId(
    tenantId: string,
    agentId: string,
    shortId: string,
  ): Promise<OrgAgentWorkOrder | null>;
  getWorkConversation(
    tenantId: string,
    workConversationId: string,
  ): Promise<OrgAgentWorkConversation | null>;
  listWorkConversations(
    tenantId: string,
    bindingId: string,
    limit?: number,
  ): Promise<OrgAgentWorkConversation[]>;
  listWorkOrders(tenantId: string, bindingId: string, limit?: number): Promise<OrgAgentWorkOrder[]>;
  listStagedWorkOrders(staleBefore: Date, limit?: number): Promise<OrgAgentWorkOrder[]>;
  transitionWorkOrder(input: {
    tenantId: string;
    workOrderId: string;
    expectedVersion: number;
    state: OrgAgentWorkOrderState;
    resultEnvelope?: OrgAgentResultEnvelope;
  }): Promise<OrgAgentWorkOrder>;
  updateWorkOrderControl(input: {
    tenantId: string;
    workOrderId: string;
    expectedVersion: number;
    control: OrgAgentWorkOrderControl;
  }): Promise<OrgAgentWorkOrder>;
  pauseWorkOrder(input: {
    tenantId: string;
    workOrderId: string;
    expectedVersion: number;
  }): Promise<OrgAgentWorkOrder>;
  queueWorkOrderAttempt(input: {
    tenantId: string;
    workOrderId: string;
    expectedVersion: number;
    control?: OrgAgentWorkOrderControl;
    supersedePendingCompletion?: boolean;
  }): Promise<OrgAgentWorkOrder>;
  reopenWorkOrder(input: {
    tenantId: string;
    workOrderId: string;
    expectedVersion: number;
  }): Promise<OrgAgentWorkOrder>;
  createMemory(input: {
    tenantId: string;
    agentId: string;
    bindingId?: string;
    workConversationId?: string;
    workOrderId?: string;
    memoryScope: 'conversation' | 'task_checkpoint';
    content: Record<string, unknown>;
    provenance: Record<string, unknown>;
    policyRevision: number;
  }): Promise<OrgAgentMemory>;
  promoteMemory(input: {
    tenantId: string;
    sourceMemoryId: string;
    promotedBy: string;
    reason: string;
    policyRevision: number;
  }): Promise<OrgAgentMemory>;
  changeMemoryStatus(input: {
    tenantId: string;
    memoryId: string;
    expectedVersion: number;
    status: 'revoked' | 'deleted';
  }): Promise<OrgAgentMemory>;
  listMemories(input: {
    tenantId: string;
    agentId: string;
    bindingId?: string;
    workConversationId?: string;
    memoryScope?: 'agent' | 'conversation' | 'task_checkpoint';
    status?: 'active' | 'revoked' | 'deleted';
    limit?: number;
  }): Promise<OrgAgentMemory[]>;
  getMemory(tenantId: string, memoryId: string): Promise<OrgAgentMemory | null>;
}

export const DEFAULT_ORG_AGENT_CHANNEL_POLICY: OrgAgentChannelPolicy = {
  enabled: false,
  membership: 'members',
  guest: 'deny',
  taskVisibility: 'conversation',
  completion: 'reply_to_work_conversation',
  liveDeny: false,
};

export const DEFAULT_ORG_AGENT_EFFECTIVE_CONFIG: OrgAgentEffectiveConfig = {
  identity: {},
  instructions: { system: '' },
  knowledge: { contextEnabled: false, sourceIds: [] },
  capabilities: { skillIds: [], toolNames: [], dwsResourceIds: [] },
  memory: { readAgent: true, readConversation: true, adminWriteConversation: true },
  access: { triggerRoles: [], approvalRoles: [] },
  speech: { proactive: false, requireMention: true },
};

import type {
  DwsDeliveryIntent,
  ExternalActorRef,
  OrgAgentChannelBinding,
  OrgAgentChannelPolicy,
  OrgAgentEffectiveConfig,
  OrgAgentMemory,
  OrgAgentResultEnvelope,
  OrgAgentWorkAttempt,
  OrgAgentWorkConversation,
  OrgAgentWorkOrder,
  OrgAgentWorkOrderControl,
} from './types.js';

/** Missing identity columns are legacy and remain fail-closed at the routing boundary. */
export function mapBinding(row: Record<string, unknown>): OrgAgentChannelBinding {
  const profileId = text(row.account_profile_id);
  const corpId = text(row.account_corp_id);
  const dingtalkUserId = text(row.account_dingtalk_user_id);
  const accountIdentity = profileId && corpId && dingtalkUserId && row.account_identity_updated_at
    ? { profileId, corpId, dingtalkUserId, identityUpdatedAt: iso(row.account_identity_updated_at) }
    : undefined;
  return {
    bindingId: String(row.binding_id),
    tenantId: String(row.tenant_id),
    accountId: String(row.account_id),
    agentId: String(row.agent_id),
    conversationId: String(row.conversation_id),
    channelKind: row.channel_kind as 'group' | 'direct',
    activationState: row.activation_state as 'shadow' | 'active' | 'disabled',
    enabled: row.enabled === true,
    conversationSpaceId: String(row.conversation_space_id),
    serviceSessionId: String(row.service_session_id),
    workspaceId: String(row.workspace_id),
    ...(accountIdentity ? { accountIdentity } : {}),
    policy: validatePolicy(parseJson(row.policy_json)),
    effectiveConfig: validateEffectiveConfig(parseJson(row.effective_config_json)),
    revision: Number(row.revision),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function mapWorkConversation(row: Record<string, unknown>): OrgAgentWorkConversation {
  return {
    workConversationId: String(row.work_conversation_id),
    tenantId: String(row.tenant_id),
    bindingId: String(row.binding_id),
    rootKey: String(row.root_key),
    ...(text(row.root_message_id) ? { rootMessageId: text(row.root_message_id) } : {}),
    sessionId: String(row.session_id),
    state: row.state as 'active' | 'closed',
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function mapDelivery(row: Record<string, unknown>): DwsDeliveryIntent {
  const profileId = text(row.account_profile_id);
  const corpId = text(row.account_corp_id);
  const dingtalkUserId = text(row.account_dingtalk_user_id);
  const accountIdentity = profileId && corpId && dingtalkUserId && row.account_identity_updated_at
    ? { profileId, corpId, dingtalkUserId, identityUpdatedAt: iso(row.account_identity_updated_at) }
    : undefined;
  return {
    deliveryId: String(row.delivery_id),
    tenantId: String(row.tenant_id),
    ...(text(row.inbox_id) ? { inboxId: text(row.inbox_id) } : {}),
    accountId: String(row.account_id),
    ...(accountIdentity ? { accountIdentity } : {}),
    conversationId: String(row.conversation_id),
    ...(text(row.agent_id) ? { agentId: text(row.agent_id) } : {}),
    ...(text(row.binding_id) ? { bindingId: text(row.binding_id) } : {}),
    ...(text(row.conversation_space_id)
      ? { conversationSpaceId: text(row.conversation_space_id) }
      : {}),
    ...(text(row.work_conversation_id)
      ? { workConversationId: text(row.work_conversation_id) }
      : {}),
    ...(Number.isSafeInteger(Number(row.policy_revision)) && Number(row.policy_revision) >= 1
      ? { policyRevision: Number(row.policy_revision) }
      : {}),
    ...(row.visibility === 'conversation' ||
    row.visibility === 'requester_only' ||
    row.visibility === 'public_notice'
      ? { visibility: row.visibility }
      : {}),
    ...(text(row.source_work_order_id)
      ? { sourceWorkOrderId: text(row.source_work_order_id) }
      : {}),
    ...(text(row.source_attempt_id) ? { sourceAttemptId: text(row.source_attempt_id) } : {}),
    source: row.source as DwsDeliveryIntent['source'],
    deliveryKind: row.delivery_kind as DwsDeliveryIntent['deliveryKind'],
    disposition: row.disposition as DwsDeliveryIntent['disposition'],
    deliveryState: row.delivery_state as DwsDeliveryIntent['deliveryState'],
    destination: validateDestination(
      parseJson(row.destination_json),
      String(row.account_id),
      String(row.conversation_id),
    ),
    content: String(row.content),
    idempotencyKey: String(row.idempotency_key),
    ...(row.provider_receipt_json ? { providerReceipt: parseJson(row.provider_receipt_json) } : {}),
    attempt: Number(row.attempt),
    ...(text(row.lease_owner) ? { leaseOwner: text(row.lease_owner) } : {}),
    leaseFence: Number(row.lease_fence),
    ...(row.lease_expires_at ? { leaseExpiresAt: iso(row.lease_expires_at) } : {}),
    providerAttemptPhase: (text(row.provider_attempt_phase) ?? 'legacy_unknown') as DwsDeliveryIntent['providerAttemptPhase'],
    ...(row.provider_started_at ? { providerStartedAt: iso(row.provider_started_at) } : {}),
    ...(row.next_attempt_at ? { nextAttemptAt: iso(row.next_attempt_at) } : {}),
    ...(row.last_attempt_at ? { lastAttemptAt: iso(row.last_attempt_at) } : {}),
    ...(text(row.last_error) ? { lastError: text(row.last_error) } : {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(row.completed_at ? { completedAt: iso(row.completed_at) } : {}),
  };
}

export function mapWorkOrder(row: Record<string, unknown>): OrgAgentWorkOrder {
  const actor = parseJson(row.created_by_actor_json);
  if (actor.kind !== 'external_user' || actor.provider !== 'dingtalk')
    throw new Error('ORG_AGENT_WORK_ORDER_ACTOR_INVALID');
  return {
    workOrderId: String(row.work_order_id),
    shortId: text(row.short_id) ?? fallbackShortId(String(row.work_order_id)),
    tenantId: String(row.tenant_id),
    agentId: String(row.agent_id),
    bindingId: String(row.binding_id),
    workConversationId: String(row.work_conversation_id),
    idempotencyKey: String(row.idempotency_key),
    title: String(row.title),
    state: row.state as OrgAgentWorkOrder['state'],
    visibility: row.visibility as OrgAgentWorkOrder['visibility'],
    currentAttemptNo: Number(row.current_attempt_no),
    createdByActor: actor as unknown as ExternalActorRef,
    policySnapshot: parseJson(row.policy_snapshot_json),
    cancelPolicy: parseJson(row.cancel_policy_json),
    control: validateWorkOrderControl(parseJson(row.control_json)),
    ...(row.result_envelope_json
      ? { resultEnvelope: parseJson(row.result_envelope_json) as unknown as OrgAgentResultEnvelope }
      : {}),
    version: Number(row.version),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(row.completed_at ? { completedAt: iso(row.completed_at) } : {}),
  };
}

function validateWorkOrderControl(value: Record<string, unknown>): OrgAgentWorkOrderControl {
  const supplements = Array.isArray(value.supplements) ? value.supplements.flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    if (typeof row.text !== 'string' || typeof row.actorOpenId !== 'string'
      || typeof row.createdAt !== 'string' || (row.kind !== 'supplement' && row.kind !== 'review')) return [];
    return [{ text: row.text, actorOpenId: row.actorOpenId, createdAt: row.createdAt,
      kind: row.kind as 'supplement' | 'review' }];
  }) : [];
  return {
    revision: Number.isSafeInteger(value.revision) && Number(value.revision) >= 1 ? Number(value.revision) : 1,
    supplements,
    workerType: value.workerType === 'explore' ? 'explore' : 'general',
  };
}

function fallbackShortId(workOrderId: string): string {
  return `W-${workOrderId.replace(/[^A-Za-z0-9]/g, '').slice(-12).toUpperCase()}`;
}

export function mapWorkAttempt(row: Record<string, unknown>): OrgAgentWorkAttempt {
  return {
    attemptId: String(row.attempt_id),
    tenantId: String(row.tenant_id),
    workOrderId: String(row.work_order_id),
    attemptNo: Number(row.attempt_no),
    runtimeRunId: String(row.runtime_run_id),
    status: row.status as OrgAgentWorkAttempt['status'],
    ...(text(row.parent_attempt_id) ? { parentAttemptId: text(row.parent_attempt_id) } : {}),
    taskWorkspaceId: String(row.task_workspace_id),
    sandboxScopeId: String(row.sandbox_scope_id),
    mountSubPath: String(row.mount_sub_path),
    sharedReadOnlySubPath: String(row.shared_read_only_sub_path),
    publishState: row.publish_state as OrgAgentWorkAttempt['publishState'],
    ...(row.checkpoint_json ? { checkpoint: parseJson(row.checkpoint_json) } : {}),
    ...(row.artifact_manifest_json
      ? { artifactManifest: parseJson(row.artifact_manifest_json) }
      : {}),
    ...(row.result_envelope_json
      ? { resultEnvelope: parseJson(row.result_envelope_json) as unknown as OrgAgentWorkAttempt['resultEnvelope'] }
      : {}),
    ...(text(row.failure) ? { failure: text(row.failure) } : {}),
    ...(row.started_at ? { startedAt: iso(row.started_at) } : {}),
    ...(row.completed_at ? { completedAt: iso(row.completed_at) } : {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function mapMemory(row: Record<string, unknown>): OrgAgentMemory {
  return {
    memoryId: String(row.memory_id),
    tenantId: String(row.tenant_id),
    agentId: String(row.agent_id),
    ...(text(row.binding_id) ? { bindingId: text(row.binding_id) } : {}),
    ...(text(row.work_conversation_id)
      ? { workConversationId: text(row.work_conversation_id) }
      : {}),
    ...(text(row.work_order_id) ? { workOrderId: text(row.work_order_id) } : {}),
    memoryScope: row.memory_scope as OrgAgentMemory['memoryScope'],
    status: row.status as OrgAgentMemory['status'],
    content: parseJson(row.content_json),
    provenance: parseJson(row.provenance_json),
    ...(text(row.promoted_by) ? { promotedBy: text(row.promoted_by) } : {}),
    ...(text(row.promotion_reason) ? { promotionReason: text(row.promotion_reason) } : {}),
    policyRevision: Number(row.policy_revision),
    version: Number(row.version),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(row.revoked_at ? { revokedAt: iso(row.revoked_at) } : {}),
    ...(row.deleted_at ? { deletedAt: iso(row.deleted_at) } : {}),
  };
}

export function validatePolicy(value: unknown): OrgAgentChannelPolicy {
  const raw = parseJson(value);
  return {
    enabled: raw.enabled === true,
    membership: raw.membership === 'members_and_guests' ? 'members_and_guests' : 'members',
    guest: raw.guest === 'shared_read_only' ? 'shared_read_only' : 'deny',
    taskVisibility: raw.taskVisibility === 'requester_only' ? 'requester_only' : 'conversation',
    completion: raw.completion === 'silent' ? 'silent' : 'reply_to_work_conversation',
    liveDeny: raw.liveDeny === true,
  };
}

export function validateEffectiveConfig(value: unknown): OrgAgentEffectiveConfig {
  const raw = parseJson(value);
  const identity = parseJson(raw.identity);
  const instructions = parseJson(raw.instructions);
  const knowledge = parseJson(raw.knowledge);
  const capabilities = parseJson(raw.capabilities);
  const memory = parseJson(raw.memory);
  const access = parseJson(raw.access);
  const speech = parseJson(raw.speech);
  return {
    identity: {
      ...(text(identity.displayName) ? { displayName: text(identity.displayName) } : {}),
    },
    instructions: { system: text(instructions.system) ?? '' },
    knowledge: {
      contextEnabled: knowledge.contextEnabled === true,
      sourceIds: stringArray(knowledge.sourceIds),
    },
    capabilities: {
      skillIds: stringArray(capabilities.skillIds),
      toolNames: stringArray(capabilities.toolNames),
      dwsResourceIds: stringArray(capabilities.dwsResourceIds),
    },
    memory: {
      readAgent: memory.readAgent !== false,
      readConversation: memory.readConversation !== false,
      adminWriteConversation: memory.adminWriteConversation !== false,
    },
    access: {
      triggerRoles: governanceRoleArray(access.triggerRoles),
      approvalRoles: governanceRoleArray(access.approvalRoles),
    },
    speech: {
      proactive: speech.proactive === true,
      requireMention: speech.requireMention !== false,
    },
  };
}

export function requiredRow(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') throw new Error('ORG_AGENT_STORE_INVALID');
  return value as Record<string, unknown>;
}

export function validateDestination(
  value: unknown,
  accountId: string,
  conversationId: string,
): DwsDeliveryIntent['destination'] {
  const raw = parseJson(value);
  if (
    raw.provider !== 'dingtalk' ||
    raw.accountId !== accountId ||
    raw.conversationId !== conversationId ||
    (raw.kind !== 'group' && raw.kind !== 'direct')
  )
    throw new Error('DWS_DELIVERY_DESTINATION_INVALID');
  if (raw.kind === 'direct' && !text(raw.peerOpenId))
    throw new Error('DWS_DELIVERY_DESTINATION_INVALID');
  return {
    provider: 'dingtalk',
    accountId,
    conversationId,
    kind: raw.kind,
    ...(text(raw.peerOpenId) ? { peerOpenId: text(raw.peerOpenId) } : {}),
  };
}

function parseJson(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      return parseJson(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}
function governanceRoleArray(value: unknown): Array<'member' | 'org_admin'> {
  if (!Array.isArray(value) || !value.every(item => item === 'member' || item === 'org_admin'))
    throw new Error('ORG_AGENT_EFFECTIVE_CONFIG_ROLE_INVALID');
  return value;
}
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}
function iso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error('ORG_AGENT_STORE_INVALID_DATE');
  return date.toISOString();
}

import type { AgentDwsAccountRecord } from '../data/agentDwsAccounts/index.js';
import type { AgentDwsInboxRecord } from '../data/agentDwsMessages/index.js';
import type { OrgGroupAgentStore } from '../data/orgGroupAgents/index.js';
import type { DwsPersonalEvent } from './personalEventGateway.js';
import { bindingMatchesCurrentAccountIdentity } from './agentDwsAccountIdentity.js';

const MAX_EVENT_ID_LENGTH = 512;

export const ORG_AGENT_ROUTING_FIELD_NAMES = [
  'root_message_id',
  'thread_id',
  'parent_message_id',
  'quote_message_id',
  'reply_message_id',
] as const;

export function extractOrgAgentRoutingFields(raw: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    ORG_AGENT_ROUTING_FIELD_NAMES.flatMap((key) => {
      const value = raw[key];
      return typeof value === 'string' && value.trim() && value.length <= MAX_EVENT_ID_LENGTH
        ? [[key, value.trim()]]
        : [];
    }),
  );
}

export async function pinActiveOrgAgentGroupRouting(input: {
  store?: OrgGroupAgentStore;
  account: AgentDwsAccountRecord;
  event: DwsPersonalEvent;
  item: AgentDwsInboxRecord;
}): Promise<void> {
  const { store, account, event, item } = input;
  if (!store || event.type !== 'user_im_message_receive_at') return;
  const binding = await store.getBinding(
    account.tenantId,
    account.accountId,
    event.conversationId!,
  );
  if (!binding || !bindingMatchesCurrentAccountIdentity(binding, account)) return;
  if (
    binding.activationState !== 'active' ||
    !binding.enabled ||
    !binding.policy.enabled ||
    binding.policy.liveDeny
  )
    return;
  const referencedMessages = Object.values(extractOrgAgentRoutingFields(event.raw));
  const explicitId =
    typeof event.raw.workConversationId === 'string' ? event.raw.workConversationId : undefined;
  if (!explicitId && referencedMessages.length === 0) return;
  const explicit = explicitId
    ? await store.getWorkConversation(account.tenantId, explicitId)
    : null;
  if (explicit && explicit.bindingId !== binding.bindingId)
    throw new Error('ORG_AGENT_WORK_CONVERSATION_BINDING_MISMATCH');
  const existing =
    explicit ??
    (await store.findWorkConversationByMessage({
      tenantId: account.tenantId,
      bindingId: binding.bindingId,
      accountId: account.accountId,
      conversationId: event.conversationId!,
      messageIds: referencedMessages,
    }));
  const rootKey = referencedMessages[0] ?? event.messageId ?? event.eventId;
  const conversation =
    existing ??
    (await store.getOrCreateWorkConversation({
      tenantId: account.tenantId,
      bindingId: binding.bindingId,
      rootKey,
      ...(event.messageId ? { rootMessageId: event.messageId } : {}),
    }));
  await store.pinInboxRouting({
    inboxId: item.inboxId,
    conversationSpaceId: binding.conversationSpaceId,
    workConversationId: conversation.workConversationId,
    policyRevision: binding.revision,
  });
}

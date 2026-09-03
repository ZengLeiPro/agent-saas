import {
  hasExactAgentDwsProfile,
  type AgentDwsAccountStore,
} from '../data/agentDwsAccounts/index.js';
import type { DwsDeliveryIntent, OrgGroupAgentStore } from '../data/orgGroupAgents/index.js';
import type { DwsPersonalEvent } from './personalEventGateway.js';
import type { DwsPersonalMessageSenderLike } from './personalMessageSender.js';

export interface OrgAgentDeliveryWorkerOptions {
  store: OrgGroupAgentStore;
  accountStore: AgentDwsAccountStore;
  sender: DwsPersonalMessageSenderLike;
  workerId: string;
  leaseTtlMs: number;
}

/**
 * Drains durable outbound intents independently from the inbound event that created them.
 * Unknown deliveries are deliberately excluded: only an administrator can prove that an
 * unknown provider attempt was not sent and move it back to pending.
 */
export async function deliverNextOrgAgentIntent(
  options: OrgAgentDeliveryWorkerOptions,
): Promise<boolean> {
  const delivery = await options.store.claimNextDelivery(options.workerId, options.leaseTtlMs);
  if (!delivery) return false;

  const account = await options.accountStore.getForTenant(delivery.tenantId, delivery.accountId);
  if (
    !account ||
    account.status !== 'active' ||
    !hasExactAgentDwsProfile(account) ||
    (Boolean(delivery.agentId) && account.agentId !== delivery.agentId)
  ) {
    await options.store.markClaimedDeliveryDeadLetter(
      delivery.deliveryId,
      options.workerId,
      delivery.leaseFence,
      'ORG_AGENT_DELIVERY_ACCOUNT_UNAVAILABLE',
    );
    return true;
  }

  if (delivery.bindingId || delivery.agentId) {
    const binding = await options.store.getBinding(
      delivery.tenantId,
      delivery.accountId,
      delivery.conversationId,
    );
    if (
      !binding ||
      binding.bindingId !== delivery.bindingId ||
      binding.agentId !== delivery.agentId ||
      binding.activationState !== 'active' ||
      !binding.enabled ||
      !binding.policy.enabled ||
      binding.policy.liveDeny ||
      (delivery.deliveryKind === 'task_completion' && binding.policy.completion === 'silent')
    ) {
      await options.store.markClaimedDeliveryDeadLetter(
        delivery.deliveryId,
        options.workerId,
        delivery.leaseFence,
        'ORG_AGENT_CHANNEL_LIVE_DENY',
      );
      return true;
    }
  }

  try {
    const receipt = await options.sender.send(
      account,
      deliveryEvent(delivery),
      delivery.content,
      delivery.idempotencyKey,
    );
    if (!receipt) throw new Error('DWS_DELIVERY_RECEIPT_MISSING');
    await options.store.markDeliverySent(
      delivery.deliveryId,
      options.workerId,
      delivery.leaseFence,
      receipt,
    );
  } catch (error) {
    await options.store.markDeliveryUnknown(
      delivery.deliveryId,
      options.workerId,
      delivery.leaseFence,
      error,
    );
  }
  return true;
}

function deliveryEvent(delivery: DwsDeliveryIntent): DwsPersonalEvent {
  return {
    type:
      delivery.destination.kind === 'group'
        ? 'user_im_message_receive_at'
        : 'user_im_message_receive_o2o_all',
    eventId: delivery.deliveryId,
    conversationId: delivery.destination.conversationId,
    ...(delivery.destination.peerOpenId
      ? { senderOpenDingtalkId: delivery.destination.peerOpenId }
      : {}),
    content: delivery.content,
    raw: {
      schemaVersion: 1,
      source: 'durable_delivery_intent',
      deliveryId: delivery.deliveryId,
    },
  };
}

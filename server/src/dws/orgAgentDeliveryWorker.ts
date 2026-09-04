import { createHash } from 'node:crypto';

import {
  hasExactAgentDwsProfile,
  type AgentDwsAccountStore,
} from '../data/agentDwsAccounts/index.js';
import type { DwsDeliveryIntent, OrgGroupAgentStore } from '../data/orgGroupAgents/index.js';
import {
  DELIVERY_MAX_ATTEMPTS,
  deliveryRetryDelayMs,
} from '../data/orgGroupAgents/deliveryClaims.js';
import type { OrgAgentStore } from '../data/orgAgents/store.js';
import type { DwsPersonalEvent } from './personalEventGateway.js';
import type { DwsPersonalMessageSenderLike } from './personalMessageSender.js';
import { bindingMatchesCurrentAccountIdentity } from './agentDwsAccountIdentity.js';

export interface OrgAgentDeliveryWorkerOptions {
  store: OrgGroupAgentStore;
  accountStore: AgentDwsAccountStore;
  agentStore?: Pick<OrgAgentStore, 'get'>;
  sender: DwsPersonalMessageSenderLike;
  workerId: string;
  leaseTtlMs: number;
  authorizeCompletionRequester?: (
    tenantId: string,
    agentId: string,
    userId: string,
  ) => Promise<boolean> | boolean;
}

/**
 * Drains durable outbound intents independently from the inbound event that created them.
 * Unknown deliveries are deliberately excluded: only an administrator can prove that an
 * unknown provider attempt was not sent and move it back to pending.
 */
export async function deliverNextOrgAgentIntent(
  options: OrgAgentDeliveryWorkerOptions,
): Promise<boolean> {
  await options.store.reconcileAllExpiredDeliveries();
  const delivery = await options.store.claimNextDelivery(options.workerId, options.leaseTtlMs);
  if (!delivery) return false;

  let providerStarted = false;
  try {
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

    if (delivery.deliveryKind === 'task_completion') {
      const work = delivery.sourceWorkOrderId
        ? await options.store.getWorkOrder(delivery.tenantId, delivery.sourceWorkOrderId)
        : null;
      const attempt =
        work && delivery.sourceAttemptId
          ? (await options.store.listWorkAttempts(delivery.tenantId, work.workOrderId)).find(
              (candidate) => candidate.attemptId === delivery.sourceAttemptId,
            )
          : undefined;
      const conversation = work
        ? await options.store.getWorkConversation(delivery.tenantId, work.workConversationId)
        : null;
      if (
        !work ||
        !attempt ||
        !conversation ||
        work.bindingId !== delivery.bindingId ||
        work.agentId !== delivery.agentId ||
        work.workConversationId !== delivery.workConversationId ||
        conversation.bindingId !== work.bindingId ||
        attempt.workOrderId !== work.workOrderId ||
        work.currentAttemptNo !== attempt.attemptNo ||
        work.state !== attempt.status ||
        !['completed', 'failed', 'cancelled'].includes(work.state)
      ) {
        await options.store.markClaimedDeliveryDeadLetter(
          delivery.deliveryId,
          options.workerId,
          delivery.leaseFence,
          'ORG_AGENT_DELIVERY_STALE_ATTEMPT',
        );
        return true;
      }
      if (delivery.visibility === 'requester_only') {
        const mappedUserId = work.createdByActor.mappedUserId;
        const allowed =
          mappedUserId && delivery.agentId
            ? await options.authorizeCompletionRequester?.(
                delivery.tenantId,
                delivery.agentId,
                mappedUserId,
              )
            : false;
        if (!allowed) {
          await createRedactedTerminalNotice(options.store, delivery);
          await options.store.markClaimedDeliveryDeadLetter(
            delivery.deliveryId,
            options.workerId,
            delivery.leaseFence,
            'ORG_AGENT_REQUESTER_MEMBERSHIP_REVOKED',
          );
          return true;
        }
      }
    }

    if (delivery.bindingId || delivery.agentId) {
      const binding = await options.store.getBinding(
        delivery.tenantId,
        delivery.accountId,
        delivery.conversationId,
      );
      if (
        !binding ||
        !bindingMatchesCurrentAccountIdentity(binding, account) ||
        binding.bindingId !== delivery.bindingId ||
        binding.agentId !== delivery.agentId
      ) {
        await options.store.markClaimedDeliveryDeadLetter(
          delivery.deliveryId,
          options.workerId,
          delivery.leaseFence,
          'ORG_AGENT_CHANNEL_LIVE_DENY',
        );
        return true;
      }
      const agent = delivery.agentId ? options.agentStore?.get(delivery.agentId) : undefined;
      if (delivery.deliveryKind === 'task_completion' && binding.policy.completion === 'silent') {
        await options.store.markClaimedDeliveryDeadLetter(
          delivery.deliveryId,
          options.workerId,
          delivery.leaseFence,
          'ORG_AGENT_COMPLETION_SILENT',
        );
        return true;
      }
      if (
        binding.activationState !== 'active' ||
        !binding.enabled ||
        !binding.policy.enabled ||
        binding.policy.liveDeny ||
        !agent ||
        agent.tenantId !== delivery.tenantId ||
        !agent.enabled
      ) {
        if (delivery.deliveryKind === 'task_completion')
          await createRedactedTerminalNotice(options.store, delivery);
        await options.store.markClaimedDeliveryDeadLetter(
          delivery.deliveryId,
          options.workerId,
          delivery.leaseFence,
          'ORG_AGENT_CHANNEL_LIVE_DENY',
        );
        return true;
      }
    }

    await options.store.markDeliveryProviderStarted(
      delivery.deliveryId,
      options.workerId,
      delivery.leaseFence,
    );
    providerStarted = true;
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
  } catch (error) {
    if (providerStarted) throw error;
    await options.store.releaseClaimedDeliveryForRetry(
      delivery.deliveryId,
      options.workerId,
      delivery.leaseFence,
      error,
      deliveryRetryDelayMs(delivery.attempt),
      DELIVERY_MAX_ATTEMPTS,
    );
    return true;
  }
}

const REDACTED_TERMINAL_NOTICE = '任务已结束，但当前群策略不允许披露结果，请联系管理员。';

export async function createRedactedTerminalNotice(
  store: OrgGroupAgentStore,
  delivery: DwsDeliveryIntent,
): Promise<void> {
  await store.createDelivery({
    tenantId: delivery.tenantId,
    ...(delivery.inboxId ? { inboxId: delivery.inboxId } : {}),
    accountId: delivery.accountId,
    conversationId: delivery.conversationId,
    source: 'system',
    deliveryKind: 'system_notice',
    disposition: 'rejected',
    destination: delivery.destination,
    content: REDACTED_TERMINAL_NOTICE,
    idempotencyKey: `agent-dws-policy-notice-${createHash('sha256')
      .update(delivery.idempotencyKey)
      .digest('hex')
      .slice(0, 32)}`,
  });
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

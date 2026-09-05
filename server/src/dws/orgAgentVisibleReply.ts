import { createHash } from 'node:crypto';

import {
  hasExactAgentDwsProfile,
  type AgentDwsAccountRecord,
  type AgentDwsAccountStore,
} from '../data/agentDwsAccounts/index.js';
import type {
  AgentDwsInboxRecord,
  AgentDwsMessageStore,
} from '../data/agentDwsMessages/index.js';
import type { DwsDeliveryIntent, OrgGroupAgentStore } from '../data/orgGroupAgents/index.js';
import {
  DELIVERY_MAX_ATTEMPTS,
  deliveryRetryDelayMs,
} from '../data/orgGroupAgents/deliveryClaims.js';
import type { OrgAgentStore } from '../data/orgAgents/store.js';
import type { SharedGroupContext } from './orgAgentSharedGroupContext.js';
import { createRedactedTerminalNotice } from './orgAgentDeliveryWorker.js';
import type { DwsPersonalEvent } from './personalEventGateway.js';
import type { DwsPersonalMessageSenderLike } from './personalMessageSender.js';
import {
  bindingMatchesCurrentAccountIdentity,
  currentAgentDwsAccountIdentity,
  deliveryMatchesCurrentAccountIdentity,
  inboxMatchesCurrentAccountIdentity,
} from './agentDwsAccountIdentity.js';

const FRONT_REPLY_FALLBACK = '收到，我正在处理，完成后会在这里回复结果。';

export class OrgAgentProviderAuthorizationRevokedError extends Error {
  constructor(readonly reason: string) {
    super(`ORG_AGENT_PROVIDER_AUTHORIZATION_REVOKED:${reason}`);
  }
}

/** A final reply may follow only a confirmed-sent fallback, never an unknown provider attempt. */
export async function settleFrontReply(
  deadline: { cancel(): Promise<DwsDeliveryIntent | undefined> } | undefined,
  sendNatural: () => Promise<DwsDeliveryIntent | undefined>,
  sendFinal: () => Promise<DwsDeliveryIntent | undefined>,
): Promise<DwsDeliveryIntent | undefined> {
  const [fallback, natural] = await Promise.all([
    deadline?.cancel() ?? Promise.resolve(undefined),
    sendNatural(),
  ]);
  const first = natural ?? fallback;
  if (first?.source === 'system' && first.deliveryState === 'sent') return await sendFinal();
  return first;
}

export async function finalizeReplyDelivery(
  store: AgentDwsMessageStore,
  owner: string,
  item: AgentDwsInboxRecord,
  delivery: DwsDeliveryIntent | undefined,
): Promise<boolean> {
  if (!delivery || delivery.deliveryState === 'sent') return true;
  if (delivery.deliveryState === 'unknown' || delivery.deliveryState === 'dead_letter') {
    await store.markReplyUnknown(item.inboxId, owner, item.leaseFence);
    return false;
  }
  throw new Error(`AGENT_DWS_REPLY_DELIVERY_NOT_SENT:${delivery.deliveryState}`);
}

export class OrgAgentVisibleReplyService {
  constructor(
    private readonly options: {
      accountStore: AgentDwsAccountStore;
      orgGroupAgentStore?: OrgGroupAgentStore;
      orgAgentStore?: Pick<OrgAgentStore, 'get'>;
      sender: DwsPersonalMessageSenderLike;
      authorizeCompletionRequester?: (
        tenantId: string,
        agentId: string,
        userId: string,
      ) => Promise<boolean> | boolean;
      logger?: { warn(message: string): void };
    },
    private readonly workerId: string,
    private readonly leaseTtlMs: number,
    private readonly frontReplyDeadlineMs: number,
  ) {}

  schedule(account: AgentDwsAccountRecord, item: AgentDwsInboxRecord, shared: SharedGroupContext) {
    let started = false;
    let settle!: (delivery: DwsDeliveryIntent | undefined) => void;
    const settled = new Promise<DwsDeliveryIntent | undefined>((resolve) => {
      settle = resolve;
    });
    let timer: NodeJS.Timeout;
    const start = (): Promise<DwsDeliveryIntent | undefined> => {
      if (started) return settled;
      started = true;
      clearTimeout(timer);
      void this.send(
        account,
        item,
        FRONT_REPLY_FALLBACK,
        shared,
        'front_reply',
        'replied',
        'first',
        'system',
      )
        .then(settle)
        .catch((error) => {
          this.options.logger?.warn(
            `Agent DWS front reply fallback failed inbox=${item.inboxId}: ${compactError(error)}`,
          );
          settle(undefined);
        });
      return settled;
    };
    timer = setTimeout(() => {
      void start();
    }, this.frontReplyDeadlineMs);
    timer.unref?.();
    return {
      cancel: async () => {
        clearTimeout(timer);
        if (!started) settle(undefined);
        return await settled;
      },
      fireNow: start,
    };
  }

  async send(
    account: AgentDwsAccountRecord,
    item: AgentDwsInboxRecord,
    text: string,
    shared: SharedGroupContext | undefined,
    deliveryKind: 'front_reply' | 'access_rejection',
    disposition: 'replied' | 'rejected',
    replyPhase: 'first' | 'final' = 'first',
    sourceOverride?: DwsDeliveryIntent['source'],
    authorizeBeforeProvider?: () => Promise<{ allowed: boolean; reason?: string }>,
  ): Promise<DwsDeliveryIntent | undefined> {
    const idempotencyKey = deterministicId(
      replyPhase === 'first' ? 'agent-dws-reply' : 'agent-dws-final',
      `${item.accountId}:${item.eventId}`,
    );
    if (!this.options.orgGroupAgentStore) {
      await this.options.sender.send(account, inboxEvent(item), text, idempotencyKey, async () => {
        const authorization = await authorizeBeforeProvider?.();
        if (authorization && !authorization.allowed)
          throw new OrgAgentProviderAuthorizationRevokedError(
            authorization.reason ?? 'ACCESS_DENIED',
          );
      });
      return undefined;
    }
    const visibility = shared?.completionWork?.visibility ?? shared?.binding.policy.taskVisibility;
    const requesterAllowed =
      shared?.completionWork?.visibility === 'requester_only' &&
      shared.completionWork.createdByActor.mappedUserId
        ? await this.options.authorizeCompletionRequester?.(
            shared.binding.tenantId,
            shared.binding.agentId,
            shared.completionWork.createdByActor.mappedUserId,
          )
        : false;
    const visibleText =
      shared?.completionWork?.visibility === 'requester_only' && !requesterAllowed
        ? '任务已经结束，但你的组织权限已发生变化，当前无法展示任务结果。请联系管理员确认权限。'
        : text;
    const destination =
      shared?.completionWork?.visibility === 'requester_only'
        ? {
            provider: 'dingtalk' as const,
            accountId: item.accountId,
            conversationId: item.conversationId,
            kind: 'direct' as const,
            peerOpenId: shared.completionWork.createdByActor.openId,
          }
        : {
            provider: 'dingtalk' as const,
            accountId: item.accountId,
            conversationId: item.conversationId,
            kind:
              item.eventType === 'user_im_message_receive_at'
                ? ('group' as const)
                : ('direct' as const),
            ...(item.eventType === 'user_im_message_receive_o2o_all' && item.senderOpenDingtalkId
              ? { peerOpenId: item.senderOpenDingtalkId }
              : {}),
          };
    const accountIdentity = currentAgentDwsAccountIdentity(account);
    if (!accountIdentity || !inboxMatchesCurrentAccountIdentity(item, account))
      throw new Error('ORG_AGENT_DELIVERY_ACCOUNT_IDENTITY_UNAVAILABLE');
    const delivery = await this.options.orgGroupAgentStore.createDelivery({
      tenantId: item.tenantId,
      inboxId: item.inboxId,
      accountId: item.accountId,
      accountIdentity,
      conversationId: item.conversationId,
      ...(shared
        ? {
            agentId: shared.binding.agentId,
            bindingId: shared.binding.bindingId,
            conversationSpaceId: shared.binding.conversationSpaceId,
            workConversationId: shared.workConversation.workConversationId,
            policyRevision: shared.binding.revision,
            ...(visibility ? { visibility } : {}),
          }
        : {}),
      ...(typeof item.payload.workOrderId === 'string'
        ? { sourceWorkOrderId: item.payload.workOrderId }
        : {}),
      ...(typeof item.payload.attemptId === 'string'
        ? { sourceAttemptId: item.payload.attemptId }
        : {}),
      source:
        sourceOverride ??
        (item.payload.source === 'background_task_completion'
          ? 'background_completion'
          : 'command'),
      deliveryKind:
        item.payload.source === 'background_task_completion' ? 'task_completion' : deliveryKind,
      disposition,
      destination,
      content: visibleText,
      idempotencyKey,
    });
    if (['sent', 'unknown', 'dead_letter'].includes(delivery.deliveryState)) return delivery;
    if (shared && !(await this.isLive(shared, delivery))) return delivery;
    let claimed: DwsDeliveryIntent;
    try {
      claimed = await this.options.orgGroupAgentStore.claimDelivery(
        delivery.deliveryId,
        this.workerId,
        this.leaseTtlMs,
      );
    } catch (error) {
      if (compactError(error) !== 'DWS_DELIVERY_NOT_CLAIMABLE') throw error;
      const current = await this.options.orgGroupAgentStore.getDelivery(
        delivery.tenantId,
        delivery.deliveryId,
      );
      if (!current || current.idempotencyKey !== delivery.idempotencyKey) throw error;
      return current;
    }
    const currentAccount = await this.options.accountStore.getForTenant(
      claimed.tenantId, claimed.accountId,
    );
    if (
      !currentAccount ||
      currentAccount.status !== 'active' ||
      !hasExactAgentDwsProfile(currentAccount) ||
      (Boolean(claimed.agentId) && currentAccount.agentId !== claimed.agentId)
    ) {
      return await this.options.orgGroupAgentStore.markClaimedDeliveryDeadLetter(
        claimed.deliveryId, this.workerId, claimed.leaseFence,
        'ORG_AGENT_DELIVERY_ACCOUNT_UNAVAILABLE',
      );
    }
    if (!deliveryMatchesCurrentAccountIdentity(claimed.accountIdentity, currentAccount)) {
      return await this.options.orgGroupAgentStore.markClaimedDeliveryDeadLetter(
        claimed.deliveryId, this.workerId, claimed.leaseFence,
        'ORG_AGENT_DELIVERY_ACCOUNT_IDENTITY_STALE',
      );
    }
    let providerStarted = false;
    try {
      const receipt = await this.options.sender.send(
        currentAccount,
        outboundEvent(item, claimed.destination),
        claimed.content,
        claimed.idempotencyKey,
        async () => {
          const authorization = await authorizeBeforeProvider?.();
          if (authorization && !authorization.allowed)
            throw new OrgAgentProviderAuthorizationRevokedError(
              authorization.reason ?? 'ACCESS_DENIED',
            );
          await this.options.orgGroupAgentStore!.markDeliveryProviderStarted(
            delivery.deliveryId,
            this.workerId,
            claimed.leaseFence,
          );
          providerStarted = true;
        },
      );
      if (!receipt) throw new Error('DWS_DELIVERY_RECEIPT_MISSING');
      return await this.options.orgGroupAgentStore.markDeliverySent(
        delivery.deliveryId,
        this.workerId,
        claimed.leaseFence,
        receipt,
      );
    } catch (error) {
      if (providerStarted)
        return await this.options.orgGroupAgentStore.markDeliveryUnknown(
          delivery.deliveryId,
          this.workerId,
          claimed.leaseFence,
          error,
        );
      await this.options.orgGroupAgentStore.releaseClaimedDeliveryForRetry(
        delivery.deliveryId,
        this.workerId,
        claimed.leaseFence,
        error,
        deliveryRetryDelayMs(claimed.attempt),
        DELIVERY_MAX_ATTEMPTS,
      );
      throw error;
    }
  }

  /** Prevents stale direct replies from surviving a newly denied inbound request. */
  async cancelPendingForInbox(item: AgentDwsInboxRecord, reason: string): Promise<void> {
    await this.options.orgGroupAgentStore?.cancelUnstartedDeliveriesForInbox(
      item.tenantId,
      item.inboxId,
      reason,
    );
  }

  private async isLive(shared: SharedGroupContext, delivery: DwsDeliveryIntent): Promise<boolean> {
    const store = this.options.orgGroupAgentStore!;
    const [current, currentAccount] = await Promise.all([
      store.getBinding(
        shared.binding.tenantId,
        shared.binding.accountId,
        shared.binding.conversationId,
      ),
      this.options.accountStore.getForTenant(shared.binding.tenantId, shared.binding.accountId),
    ]);
    const currentAgent = this.options.orgAgentStore?.get(shared.binding.agentId);
    const unavailable =
      !current ||
      !currentAccount ||
      !bindingMatchesCurrentAccountIdentity(current, currentAccount) ||
      current.bindingId !== shared.binding.bindingId ||
      current.agentId !== shared.binding.agentId ||
      currentAccount.status !== 'active' ||
      !hasExactAgentDwsProfile(currentAccount) ||
      currentAccount.agentId !== shared.binding.agentId;
    const silent =
      delivery.deliveryKind === 'task_completion' && current?.policy.completion === 'silent';
    const denied =
      current &&
      (current.activationState !== 'active' ||
        !current.enabled ||
        !current.policy.enabled ||
        current.policy.liveDeny ||
        !currentAgent ||
        !currentAgent.enabled ||
        currentAgent.tenantId !== shared.binding.tenantId);
    if (!unavailable && !silent && !denied) return true;
    if (denied && delivery.deliveryKind === 'task_completion')
      await createRedactedTerminalNotice(store, delivery);
    await store.markDeliveryDeadLetter(
      delivery.deliveryId,
      silent ? 'ORG_AGENT_COMPLETION_SILENT' : 'ORG_AGENT_CHANNEL_LIVE_DENY',
    );
    return false;
  }
}

function outboundEvent(
  item: AgentDwsInboxRecord,
  destination: { kind: 'group' | 'direct'; peerOpenId?: string },
): DwsPersonalEvent {
  if (destination.kind === 'group') return inboxEvent(item);
  return {
    type: 'user_im_message_receive_o2o_all',
    eventId: item.eventId,
    conversationId: item.conversationId,
    senderOpenDingtalkId: destination.peerOpenId,
    content: item.content,
    ...(item.eventTimestamp ? { timestamp: new Date(item.eventTimestamp).getTime() } : {}),
    raw: item.payload,
  };
}

function inboxEvent(item: AgentDwsInboxRecord): DwsPersonalEvent {
  return {
    type: item.eventType,
    eventId: item.eventId,
    conversationId: item.conversationId,
    ...(item.messageId ? { messageId: item.messageId } : {}),
    ...(item.senderOpenDingtalkId ? { senderOpenDingtalkId: item.senderOpenDingtalkId } : {}),
    content: item.content,
    ...(item.eventTimestamp ? { timestamp: new Date(item.eventTimestamp).getTime() } : {}),
    raw: item.payload,
  };
}

function deterministicId(prefix: string, value: string): string {
  return `${prefix}-${createHash('sha256').update(value).digest('hex').slice(0, 32)}`;
}

function compactError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, ' ')
    .slice(0, 500);
}

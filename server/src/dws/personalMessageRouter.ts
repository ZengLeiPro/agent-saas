import { createHash, randomUUID } from 'node:crypto';

import type { AgentRunDispatch, AgentRunOptions } from '../agent/index.js';
import { createEventConsumer } from '../channels/eventConsumer.js';
import {
  hasExactAgentDwsProfile,
  type AgentDwsAccountRecord,
  type AgentDwsAccountStore,
} from '../data/agentDwsAccounts/index.js';
import {
  DWS_INBOX_V1_IDENTITY_UNPROVABLE,
  type AgentDwsInboxRecord,
  type AgentDwsMessageStore,
} from '../data/agentDwsMessages/index.js';
import type { RunStore } from '../runtime/runStore.js';
import {
  type OrgAgentChannelActorRef,
  type OrgAgentChannelBinding,
  type OrgAgentMemory,
  type OrgAgentWorkConversation,
  type OrgGroupAgentStore,
} from '../data/orgGroupAgents/index.js';
import { deriveAgentWorkspaceId } from '../runtime/workspaceIdentity.js';
import type { EventStore, PlatformEvent } from '../runtime/types.js';
import type { UserIdentity } from '../types/index.js';
import { resolveAgentCwd } from '../workspace/resolver.js';
import type { DwsPersonalEvent } from './personalEventGateway.js';
import { deliverNextOrgAgentIntent } from './orgAgentDeliveryWorker.js';
import type { DwsPersonalMessageSenderLike } from './personalMessageSender.js';
import type { DwsRequesterResolution } from './requesterIdentityResolver.js';

const DEFAULT_POLL_MS = 1_000;
const DEFAULT_LEASE_TTL_MS = 120_000;
const DEFAULT_LEASE_RENEW_MS = 30_000;
const DEFAULT_MAX_CONCURRENCY = 4;
const MAX_CONCURRENCY = 32;
const ACTIVE_RUN_RECHECK_MS = 30_000;
const DWS_REPLY_IDEMPOTENCY_SAFE_MS = 23 * 60 * 60 * 1_000;
const MAX_EVENT_ID_LENGTH = 512;
const MAX_CONVERSATION_ID_LENGTH = 1_024;
const MAX_MESSAGE_CONTENT_LENGTH = 100_000;
const MAX_SYSTEM_CONTEXT_FIELD = 500;
const SUPPORTED_EVENT_TYPES = new Set([
  'user_im_message_receive_at',
  'user_im_message_receive_o2o_all',
]);

class AgentDwsMessageDeferredError extends Error {
  constructor(message: string, readonly delayMs: number) {
    super(message);
    this.name = 'AgentDwsMessageDeferredError';
  }
}

interface ExistingRunStore {
  get(runId: string): ReturnType<RunStore['get']>;
}

interface ExistingRunEventStore {
  listByRun?: NonNullable<EventStore['listByRun']>;
}

export interface AgentDwsDefaultModelResolution {
  ref: string;
  model: string;
  connection?: AgentRunOptions['modelConnection'];
  providerOptions?: AgentRunOptions['modelProviderOptions'];
}

export interface AgentDwsMessageRouterOptions {
  agentCwd: string;
  messageStore: AgentDwsMessageStore;
  orgGroupAgentStore?: OrgGroupAgentStore;
  accountStore: AgentDwsAccountStore;
  dispatch: AgentRunDispatch;
  resolveDefaultModel: (tenantId: string) => AgentDwsDefaultModelResolution | null;
  resolveRequester: (
    account: AgentDwsAccountRecord,
    senderOpenDingtalkId: string,
    senderName?: string,
  ) => Promise<UserIdentity | null> | UserIdentity | null;
  resolveRequesterOutcome?: (
    account: AgentDwsAccountRecord,
    senderOpenDingtalkId: string,
    senderName?: string,
  ) => Promise<DwsRequesterResolution> | DwsRequesterResolution;
  authorizeRequester: (input: {
    account: AgentDwsAccountRecord;
    requester: UserIdentity;
    sessionId: string;
    runId: string;
  }) => Promise<{ allowed: boolean; reason?: string }>;
  auditRequesterRejection: (input: {
    account: AgentDwsAccountRecord;
    eventId: string;
    requester?: UserIdentity;
    reason: string;
  }) => Promise<void>;
  auditToolPolicyRejection: (input: {
    account: AgentDwsAccountRecord;
    requester: UserIdentity;
    runId: string;
    toolName?: string;
  }) => Promise<void>;
  sender: DwsPersonalMessageSenderLike;
  runStore?: ExistingRunStore;
  eventStore?: ExistingRunEventStore;
  pollMs?: number;
  leaseTtlMs?: number;
  leaseRenewMs?: number;
  maxConcurrency?: number;
  logger?: {
    info(message: string): void;
    warn(message: string): void;
  };
}

/** Durable DWS inbox worker. Conversations run concurrently; each conversation remains FIFO in the store. */
export class AgentDwsMessageRouter {
  private readonly workerId = `agent-dws-router:${randomUUID()}`;
  private readonly pollMs: number;
  private readonly leaseTtlMs: number;
  private readonly leaseRenewMs: number;
  private readonly maxConcurrency: number;
  private readonly active = new Set<Promise<void>>();
  private readonly activeAborts = new Set<AbortController>();
  private timer?: NodeJS.Timeout;
  private retryTimer?: NodeJS.Timeout;
  private pumping = false;
  private stopped = false;

  constructor(private readonly options: AgentDwsMessageRouterOptions) {
    this.pollMs = boundedPositive(options.pollMs, DEFAULT_POLL_MS);
    this.leaseTtlMs = boundedPositive(options.leaseTtlMs, DEFAULT_LEASE_TTL_MS);
    this.leaseRenewMs = boundedPositive(options.leaseRenewMs, DEFAULT_LEASE_RENEW_MS);
    this.maxConcurrency = Math.min(boundedPositive(options.maxConcurrency, DEFAULT_MAX_CONCURRENCY), MAX_CONCURRENCY);
    if (this.leaseRenewMs >= this.leaseTtlMs) {
      throw new Error('Agent DWS inbox lease renew interval must be shorter than its TTL');
    }
  }

  start(): void {
    if (this.stopped || this.timer) return;
    this.timer = setInterval(() => this.scheduleKick(), this.pollMs);
    this.timer.unref?.();
    this.scheduleKick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.timer = undefined;
    this.retryTimer = undefined;
    for (const controller of this.activeAborts) controller.abort();
    await Promise.allSettled([...this.active]);
  }

  async ingest(account: AgentDwsAccountRecord, event: DwsPersonalEvent): Promise<boolean> {
    if (!hasExactAgentDwsProfile(account)) {
      this.options.logger?.warn(`Agent DWS event ignored with inexact account identity account=${account.accountId}`);
      return false;
    }
    if (!SUPPORTED_EVENT_TYPES.has(event.type)) {
      this.options.logger?.warn(
        `Agent DWS event ignored with unsupported type account=${account.accountId} event=${safeLogId(event.eventId)}`,
      );
      return false;
    }
    if (!boundedExternalId(event.eventId, MAX_EVENT_ID_LENGTH)
      || !boundedExternalId(event.conversationId, MAX_CONVERSATION_ID_LENGTH)) {
      this.options.logger?.warn(`Agent DWS event ignored with invalid identifiers account=${account.accountId}`);
      return false;
    }
    if (typeof event.content !== 'string' || !event.content.trim() || event.content.length > MAX_MESSAGE_CONTENT_LENGTH) {
      this.options.logger?.warn(
        `Agent DWS event ignored with invalid text content account=${account.accountId} event=${safeLogId(event.eventId)}`,
      );
      return false;
    }
    if (event.messageId && !boundedExternalId(event.messageId, MAX_EVENT_ID_LENGTH)) return false;
    if (event.senderOpenDingtalkId && !boundedExternalId(event.senderOpenDingtalkId, MAX_EVENT_ID_LENGTH)) return false;
    if (event.senderName && (!event.senderName.trim() || event.senderName.length > 200)) return false;
    const result = await this.options.messageStore.ingest({
      tenantId: account.tenantId,
      accountId: account.accountId,
      eventId: event.eventId,
      eventType: event.type,
      conversationId: event.conversationId,
      ...(event.messageId ? { messageId: event.messageId } : {}),
      ...(event.senderOpenDingtalkId ? { senderOpenDingtalkId: event.senderOpenDingtalkId } : {}),
      content: event.content,
      ...(event.timestamp !== undefined ? { eventTimestamp: normalizeEventTimestamp(event.timestamp) } : {}),
    }, {
      schemaVersion: 2,
      source: 'dws_personal_stream',
      eventType: event.type,
      accountIdentity: {
        profileId: account.profileId,
        corpId: account.corpId,
        dingtalkUserId: account.dingtalkUserId,
      },
      routing: extractRoutingFields(event.raw),
      ...(event.senderName ? { senderName: event.senderName } : {}),
    });
    if (result.created) this.scheduleKick();
    return result.created;
  }

  async runOnce(): Promise<boolean> {
    if (this.stopped) return false;
    if (this.options.orgGroupAgentStore && await deliverNextOrgAgentIntent({
      store: this.options.orgGroupAgentStore,
      accountStore: this.options.accountStore,
      sender: this.options.sender,
      workerId: this.workerId,
      leaseTtlMs: this.leaseTtlMs,
    })) return true;
    const item = await this.options.messageStore.claimNext(this.workerId, this.leaseTtlMs);
    if (!item) return false;
    if (this.stopped) {
      await this.options.messageStore.releaseClaim(item.inboxId, this.workerId, item.leaseFence);
      return false;
    }
    const abortController = new AbortController();
    this.activeAborts.add(abortController);
    let leaseLost = false;
    let renewing = false;
    const heartbeat = setInterval(() => {
      if (renewing || abortController.signal.aborted) return;
      renewing = true;
      void this.options.messageStore.renewLease(
        item.inboxId,
        this.workerId,
        item.leaseFence,
        this.leaseTtlMs,
      ).then(renewed => {
        if (!renewed) {
          leaseLost = true;
          abortController.abort();
        }
      }).catch(error => {
        leaseLost = true;
        abortController.abort();
        this.options.logger?.warn(
          `Agent DWS inbox lease renewal failed inbox=${item.inboxId}: ${compactError(error)}`,
        );
      }).finally(() => {
        renewing = false;
      });
    }, this.leaseRenewMs);
    heartbeat.unref?.();

    try {
      await this.process(item, abortController);
      if (leaseLost) throw new Error('Agent DWS inbox lease lost');
      return true;
    } catch (error) {
      if (!leaseLost && !(this.stopped && abortController.signal.aborted)) {
        const persist = error instanceof AgentDwsMessageDeferredError
          ? this.options.messageStore.defer(
              item.inboxId,
              this.workerId,
              item.leaseFence,
              error.delayMs,
              error.message,
            )
          : this.options.messageStore.fail(
              item.inboxId,
              this.workerId,
              item.leaseFence,
              error,
            );
        await persist.catch(failError => {
          this.options.logger?.warn(
            `Agent DWS inbox failure persistence failed inbox=${item.inboxId}: ${compactError(failError)}`,
          );
        });
      }
      this.options.logger?.warn(`Agent DWS inbox processing failed inbox=${item.inboxId}: ${compactError(error)}`);
      return false;
    } finally {
      clearInterval(heartbeat);
      this.activeAborts.delete(abortController);
    }
  }

  private scheduleKick(): void {
    void this.kick().catch(error => {
      this.options.logger?.warn(`Agent DWS inbox poll failed: ${compactError(error)}`);
    });
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.scheduleKick();
    }, this.pollMs);
    this.retryTimer.unref?.();
  }

  private async kick(): Promise<void> {
    if (this.stopped || this.pumping) return;
    this.pumping = true;
    try {
      while (!this.stopped && this.active.size < this.maxConcurrency) {
        let processed = false;
        let task!: Promise<void>;
        task = this.runOnce()
          .then(result => { processed = result; })
          .catch(error => {
            this.options.logger?.warn(`Agent DWS inbox claim failed: ${compactError(error)}`);
            this.scheduleRetry();
          })
          .finally(() => {
            this.active.delete(task);
            if (processed) this.scheduleKick();
          });
        this.active.add(task);
      }
    } finally {
      this.pumping = false;
    }
  }

  private async process(item: AgentDwsInboxRecord, abortController: AbortController): Promise<void> {
    const account = await this.options.accountStore.getForTenant(item.tenantId, item.accountId);
    if (isV1InboxWithoutIdentity(item)) {
      const upgraded = await this.options.messageStore.pinLegacyIdentityOrTerminate(
        item.inboxId,
        this.workerId,
        item.leaseFence,
        account && account.status === 'active' && hasExactAgentDwsProfile(account) ? {
          profileId: account.profileId!,
          corpId: account.corpId!,
          dingtalkUserId: account.dingtalkUserId!,
        } : undefined,
      );
      if (upgraded.state === 'dead_letter'
        && upgraded.lastError === DWS_INBOX_V1_IDENTITY_UNPROVABLE) {
        this.options.logger?.warn(JSON.stringify({
          level: 'warn',
          code: DWS_INBOX_V1_IDENTITY_UNPROVABLE,
          inboxId: item.inboxId,
          tenantId: item.tenantId,
          accountId: item.accountId,
          eventId: item.eventId,
        }));
        return;
      }
      item = upgraded;
    }
    if (!account || account.status !== 'active' || !hasExactAgentDwsProfile(account)) {
      throw new Error('Agent DWS account is unavailable or unauthorized');
    }
    if (!matchesInboxAccountIdentity(item, account)) {
      throw new Error('Agent DWS inbox account identity is missing, invalid or stale');
    }
    if (account.agentId.length === 0) throw new Error('Agent DWS account has no Agent binding');
    if (item.eventType === 'user_im_message_receive_o2o_all'
      && item.senderOpenDingtalkId === account.dingtalkUserId) {
      await this.options.messageStore.complete(item.inboxId, this.workerId, item.leaseFence);
      return;
    }

    const senderName = typeof item.payload.senderName === 'string' ? item.payload.senderName : undefined;
    const serviceEvent = item.payload.source === 'background_task_completion';
    const requesterResolution = item.senderOpenDingtalkId && !serviceEvent
      ? this.options.resolveRequesterOutcome
        ? await this.options.resolveRequesterOutcome(account, item.senderOpenDingtalkId, senderName)
        : await legacyRequesterResolution(this.options.resolveRequester, account, item.senderOpenDingtalkId, senderName)
      : null;
    if (requesterResolution?.status === 'self_echo') {
      await this.options.messageStore.complete(item.inboxId, this.workerId, item.leaseFence);
      return;
    }
    if (requesterResolution?.status === 'ambiguous') {
      await this.rejectAccess(account, item, requesterResolution.reason);
      return;
    }
    if (requesterResolution?.status === 'unavailable') {
      await this.rejectAccess(account, item, requesterResolution.reason);
      return;
    }
    const requester = requesterResolution?.status === 'resolved' ? requesterResolution.requester
      : serviceEvent && !this.options.orgGroupAgentStore && item.senderOpenDingtalkId
        ? await this.options.resolveRequester(account, item.senderOpenDingtalkId, senderName)
        : null;
    const sharedResolution = await this.resolveSharedGroupContext(account, item, requester, senderName);
    if (sharedResolution.state === 'denied') {
      await this.rejectAccess(account, item, sharedResolution.reason, requester ?? undefined);
      return;
    }
    const shared = sharedResolution.state === 'active' ? sharedResolution.context : undefined;
    if (!serviceEvent && !item.senderOpenDingtalkId) {
      await this.rejectAccess(account, item, 'REQUESTER_IDENTITY_MISSING');
      return;
    }
    if (!serviceEvent && !shared && (!requester || !requester.tenantId || requester.tenantId !== account.tenantId)) {
      await this.rejectAccess(account, item, 'REQUESTER_IDENTITY_UNMAPPED_OR_AMBIGUOUS');
      return;
    }

    const candidateSessionId = `agent-dws-session-${randomUUID()}`;
    const runId = item.runId ?? deterministicId('agent-dws-run', `${item.accountId}:${item.eventId}`);
    if (requester && !serviceEvent) {
      const authorization = await this.options.authorizeRequester({ account, requester, sessionId: candidateSessionId, runId });
      if (!authorization.allowed) {
        await this.rejectAccess(account, item, authorization.reason ?? 'ACCESS_DENIED', requester);
        return;
      }
    } else if (!serviceEvent && (!shared || shared.binding.policy.guest !== 'shared_read_only')) {
      await this.rejectAccess(account, item, 'REQUESTER_IDENTITY_UNMAPPED_OR_AMBIGUOUS');
      return;
    }
    const legacyBinding = shared ? undefined : await this.options.messageStore.getOrCreateBinding(
      item.tenantId, item.accountId, item.conversationId, requester!.id, candidateSessionId,
      item.eventType === 'user_im_message_receive_o2o_all' ? item.senderOpenDingtalkId : undefined,
    );
    const sessionId = shared?.workConversation.sessionId ?? legacyBinding!.sessionId;
    const claimed = await this.options.messageStore.markDispatchStarted(
      item.inboxId,
      this.workerId,
      item.leaseFence,
      sessionId,
      runId,
    );

    let responseText = claimed.responseText;
    if (responseText === undefined) {
      responseText = item.runId
        ? await this.recoverOrResumeMissingRun(item, sessionId, runId, account, requester ?? serviceIdentity(account), abortController, shared)
        : await this.dispatch(item, sessionId, runId, account, requester ?? serviceIdentity(account), abortController, shared);
      if (!responseText.trim()) throw new Error('Agent runtime completed without a reply');
      await this.options.messageStore.saveDispatchResult(
        item.inboxId,
        this.workerId,
        item.leaseFence,
        responseText,
      );
    }

    if (abortController.signal.aborted) throw new Error('Agent DWS inbox processing aborted');
    const replyAttempt = await this.options.messageStore.markReplyAttemptStarted(
      item.inboxId,
      this.workerId,
      item.leaseFence,
    );
    if (!replyAttempt.replyStartedAt) throw new Error('Agent DWS reply attempt timestamp is missing');
    if (Date.now() - Date.parse(replyAttempt.replyStartedAt) > DWS_REPLY_IDEMPOTENCY_SAFE_MS) {
      throw new Error('Agent DWS reply idempotency window expired; manual reconciliation required');
    }
    const replyAccount = await this.options.accountStore.getForTenant(item.tenantId, item.accountId);
    if (!replyAccount || replyAccount.status !== 'active' || !hasExactAgentDwsProfile(replyAccount)
      || !matchesInboxAccountIdentity(item, replyAccount)) {
      throw new Error('Agent DWS account identity changed before reply');
    }
    await this.sendVisibleReply(replyAccount, item, responseText, shared, 'front_reply', 'replied');
    await this.options.messageStore.complete(item.inboxId, this.workerId, item.leaseFence);
    this.options.logger?.info(
      `Agent DWS inbox completed account=${item.accountId} event=${item.eventId} session=${sessionId}`,
    );
  }

  private async rejectAccess(
    account: AgentDwsAccountRecord,
    item: AgentDwsInboxRecord,
    reason: string,
    requester?: UserIdentity,
  ): Promise<void> {
    await this.options.auditRequesterRejection({
      account,
      eventId: item.eventId,
      ...(requester ? { requester } : {}),
      reason,
    });
    const responseText = rejectionMessage(reason);
    await this.options.messageStore.saveDispatchResult(item.inboxId, this.workerId, item.leaseFence, responseText);
    await this.options.messageStore.markReplyAttemptStarted(item.inboxId, this.workerId, item.leaseFence);
    await this.sendVisibleReply(account, item, responseText, undefined, 'access_rejection', 'rejected');
    await this.options.messageStore.complete(item.inboxId, this.workerId, item.leaseFence);
    this.options.logger?.warn(
      `Agent DWS requester rejected account=${item.accountId} event=${item.eventId} reason=${reason}`,
    );
  }

  private async recoverOrResumeMissingRun(
    item: AgentDwsInboxRecord,
    sessionId: string,
    runId: string,
    account: AgentDwsAccountRecord,
    requester: UserIdentity,
    abortController: AbortController,
    shared?: SharedGroupContext,
  ): Promise<string> {
    const existing = await this.options.runStore?.get(runId);
    if (!existing) {
      return await this.dispatch(item, sessionId, runId, account, requester, abortController, shared);
    }
    if (existing.sessionId !== sessionId) throw new Error('Agent DWS run/session binding mismatch');
    if (['pending', 'running', 'waiting_approval', 'waiting_user', 'waiting_hand'].includes(existing.status)) {
      throw new AgentDwsMessageDeferredError(
        `Agent DWS previous run is still active: ${existing.status}`,
        ACTIVE_RUN_RECHECK_MS,
      );
    }
    if (existing.status !== 'completed') {
      throw new Error(`Agent DWS previous run is not recoverable: ${existing.status}`);
    }
    const listByRun = this.options.eventStore?.listByRun;
    if (!listByRun) throw new Error('Agent DWS completed run output recovery is unavailable');
    if (existing.tenantId && existing.tenantId !== account.tenantId) {
      throw new Error('Agent DWS run/account tenant binding mismatch');
    }
    const events = await listByRun.call(this.options.eventStore, account.tenantId, sessionId, runId);
    const recovered = collectAssistantText(events);
    if (!recovered.trim()) throw new Error('Agent DWS completed run has no recoverable reply');
    return recovered;
  }

  private async dispatch(
    item: AgentDwsInboxRecord,
    sessionId: string,
    runId: string,
    account: AgentDwsAccountRecord,
    requester: UserIdentity,
    abortController: AbortController,
    shared?: SharedGroupContext,
  ): Promise<string> {
    const resolvedModel = this.options.resolveDefaultModel(account.tenantId);
    if (!resolvedModel) throw new Error('Agent DWS 当前组织没有可用的默认模型');
    let resultText: string | undefined;
    const events = this.options.dispatch({
      channel: 'dingtalk',
      chatId: item.conversationId,
      content: item.content,
      ...(item.senderOpenDingtalkId ? { senderId: item.senderOpenDingtalkId } : {}),
      metadata: {
        source: item.payload.source === 'background_task_completion'
          ? 'agent_dws_background_completion' : 'agent_dws_personal_stream',
        accountId: item.accountId,
        profileId: account.profileId,
        corpId: account.corpId,
        dingtalkUserId: account.dingtalkUserId,
        eventId: item.eventId,
        eventType: item.eventType,
        ...(item.messageId ? { messageId: item.messageId } : {}),
      },
    }, {
      channel: 'dingtalk',
      outputTransactionMode: 'terminal_buffered',
      resumeSessionId: sessionId,
      systemContext: buildSystemContext(account, item, shared),
      ...(shared ? { user: shared.requester ?? undefined, sessionOwner: serviceIdentity(account), orgAgentChannel: {
        bindingId: shared.binding.bindingId,
        accountId: shared.binding.accountId,
        agentId: shared.binding.agentId,
        conversationSpaceId: shared.binding.conversationSpaceId,
        workConversationId: shared.workConversation.workConversationId,
        policyRevision: shared.binding.revision,
        agentPrincipal: { kind: 'org_agent', tenantId: shared.binding.tenantId,
          agentId: shared.binding.agentId, accountId: shared.binding.accountId,
          workspaceId: shared.binding.workspaceId },
        externalActorAssurance: shared.externalActor.kind === 'service_event' ? 'service' : shared.externalActor.assurance,
        allowedToolNames: sharedAllowedTools(shared),
        allowedSourceIds: [...shared.binding.effectiveConfig.knowledge.sourceIds],
        contextEnabled: shared.externalActor.kind === 'external_user'
          && (shared.externalActor.assurance === 'mapped' || shared.binding.policy.guest === 'shared_read_only')
          && shared.binding.effectiveConfig.knowledge.contextEnabled,
        externalActor: shared.externalActor,
        channelPrincipal: { provider: 'dingtalk', accountId: shared.binding.accountId,
          conversationId: shared.binding.conversationId, kind: 'group' },
      } } : { sessionOwner: requester }),
      targetCwd: resolveAgentCwd(this.options.agentCwd, account.tenantId, account.agentId),
    }, {
      cwd: resolveAgentCwd(this.options.agentCwd, account.tenantId, account.agentId),
      resumeSessionId: sessionId,
      orgAgentId: account.agentId,
      model: resolvedModel.model,
      modelRef: resolvedModel.ref,
      ...(resolvedModel.connection ? { modelConnection: resolvedModel.connection } : {}),
      ...(resolvedModel.providerOptions ? { modelProviderOptions: resolvedModel.providerOptions } : {}),
      runtimeRunId: runId,
      ...(shared ? {
        allowedTools: sharedAllowedTools(shared),
        skipMemory: true,
        executionTarget: 'server-container' as const,
      } : {}),
      ...(item.payload.source === 'background_task_completion' ? { dispatcherCompletion: true } : {}),
      abortController,
    }, {
      onInteraction: async event => {
        if (event.type === 'permission_request') {
          await this.options.auditToolPolicyRejection({
            account,
            requester,
            runId,
            ...(event.toolName || event.toolId ? { toolName: event.toolName ?? event.toolId } : {}),
          });
          return {
            allow: false,
            message: '钉钉成员会话暂不支持交互式工具审批，本次工具调用已拒绝；请直接回复用户可执行的替代方案。',
          };
        }
        return {
          answers: {},
          message: '钉钉成员会话暂不支持交互式提问；请在回复中直接向用户说明需要补充的信息。',
        };
      },
      onResult: result => {
        resultText = result.resultText;
      },
    });
    let dispatchError: string | undefined;
    const consumed = await createEventConsumer().consume(events, {
      onError: error => { dispatchError = compactError(error); },
    });
    if (abortController.signal.aborted) throw new Error('Agent DWS runtime dispatch aborted');
    if (consumed.hasError) {
      throw new Error(`Agent DWS runtime dispatch failed: ${dispatchError ?? 'unknown_error'}`);
    }
    if (consumed.sessionId && consumed.sessionId !== sessionId) {
      throw new Error('Agent DWS runtime returned an unexpected session');
    }
    return resultText ?? consumed.finalText;
  }

  private async resolveSharedGroupContext(
    account: AgentDwsAccountRecord,
    item: AgentDwsInboxRecord,
    requester: UserIdentity | null,
    senderName?: string,
  ): Promise<SharedGroupResolution> {
    if (!this.options.orgGroupAgentStore || item.eventType !== 'user_im_message_receive_at') return { state: 'legacy' };
    const store = this.options.orgGroupAgentStore;
    const binding = await store.ensureShadowBinding({
      tenantId: account.tenantId, accountId: account.accountId, agentId: account.agentId,
      conversationId: item.conversationId, channelKind: 'group',
      workspaceId: deriveAgentWorkspaceId(account.tenantId, account.agentId),
    });
    if (binding.policy.liveDeny) return { state: 'denied', reason: 'ORG_AGENT_CHANNEL_LIVE_DENY' };
    if (binding.activationState === 'disabled') return { state: 'denied', reason: 'ORG_AGENT_CHANNEL_DISABLED' };
    if (binding.activationState === 'shadow') return { state: 'legacy' };
    if (!binding.enabled || !binding.policy.enabled) return { state: 'denied', reason: 'ORG_AGENT_CHANNEL_DISABLED' };
    const serviceEvent = item.payload.source === 'background_task_completion';
    if (!serviceEvent && !item.senderOpenDingtalkId) return { state: 'denied', reason: 'REQUESTER_IDENTITY_MISSING' };
    const referencedMessages = routingMessageIds(item);
    const existingConversation = await store.findWorkConversationByMessage({
      tenantId: account.tenantId, bindingId: binding.bindingId, accountId: account.accountId,
      conversationId: item.conversationId, messageIds: referencedMessages,
    });
    const rootKey = referencedMessages[0] ?? item.messageId ?? item.eventId;
    const workConversation = existingConversation ?? await store.getOrCreateWorkConversation({
      tenantId: account.tenantId, bindingId: binding.bindingId, rootKey,
      ...(item.messageId ? { rootMessageId: item.messageId } : {}),
    });
    const [agentMemories, conversationMemories] = await Promise.all([
      store.listMemories({ tenantId: binding.tenantId, agentId: binding.agentId,
        memoryScope: 'agent', status: 'active', limit: 20 }),
      store.listMemories({ tenantId: binding.tenantId, agentId: binding.agentId,
        bindingId: binding.bindingId, workConversationId: workConversation.workConversationId,
        memoryScope: 'conversation', status: 'active', limit: 20 }),
    ]);
    const externalActor: OrgAgentChannelActorRef = serviceEvent
      ? { kind: 'service_event', issuer: 'runtime',
          workOrderId: String(item.payload.workOrderId ?? item.payload.backgroundTaskId ?? item.eventId),
          attemptId: String(item.payload.attemptId ?? item.payload.backgroundTaskId ?? item.eventId),
          fence: Number.isSafeInteger(item.payload.attemptFence) ? Number(item.payload.attemptFence) : 0 }
      : { kind: 'external_user', provider: 'dingtalk', corpId: account.corpId!,
          openId: item.senderOpenDingtalkId!, ...(senderName ? { displayName: senderName } : {}),
          ...(requester ? { mappedUserId: requester.id, assurance: 'mapped' as const }
            : { assurance: 'unmapped' as const }) };
    await store.pinInboxContext({ inboxId: item.inboxId, externalActor,
      conversationSpaceId: binding.conversationSpaceId,
      workConversationId: workConversation.workConversationId, policyRevision: binding.revision });
    return { state: 'active', context: { binding, workConversation, externalActor, requester,
      memories: [...agentMemories, ...conversationMemories] } };
  }

  private async sendVisibleReply(
    account: AgentDwsAccountRecord,
    item: AgentDwsInboxRecord,
    text: string,
    shared: SharedGroupContext | undefined,
    deliveryKind: 'front_reply' | 'access_rejection',
    disposition: 'replied' | 'rejected',
  ): Promise<void> {
    const idempotencyKey = deterministicId('agent-dws-reply', `${item.accountId}:${item.eventId}:${deliveryKind}`);
    if (!this.options.orgGroupAgentStore) {
      await this.options.sender.send(account, inboxEvent(item), text, idempotencyKey);
      return;
    }
    const delivery = await this.options.orgGroupAgentStore.createDelivery({
      tenantId: item.tenantId, inboxId: item.inboxId, accountId: item.accountId,
      conversationId: item.conversationId,
      ...(shared ? { agentId: shared.binding.agentId, bindingId: shared.binding.bindingId,
        conversationSpaceId: shared.binding.conversationSpaceId,
        workConversationId: shared.workConversation.workConversationId,
        policyRevision: shared.binding.revision,
        visibility: shared.binding.policy.taskVisibility } : {}),
      ...(typeof item.payload.workOrderId === 'string' ? { sourceWorkOrderId: item.payload.workOrderId } : {}),
      ...(typeof item.payload.attemptId === 'string' ? { sourceAttemptId: item.payload.attemptId } : {}),
      source: item.payload.source === 'background_task_completion' ? 'background_completion' : 'command',
      deliveryKind: item.payload.source === 'background_task_completion' ? 'task_completion' : deliveryKind,
      disposition,
      destination: { provider: 'dingtalk', accountId: item.accountId, conversationId: item.conversationId,
        kind: item.eventType === 'user_im_message_receive_at' ? 'group' : 'direct',
        ...(item.eventType === 'user_im_message_receive_o2o_all' && item.senderOpenDingtalkId
          ? { peerOpenId: item.senderOpenDingtalkId } : {}) },
      content: text, idempotencyKey,
    });
    if (delivery.deliveryState === 'sent' || delivery.deliveryState === 'unknown') return;
    if (shared) {
      const current = await this.options.orgGroupAgentStore.getBinding(
        shared.binding.tenantId, shared.binding.accountId, shared.binding.conversationId,
      );
      if (!current || current.bindingId !== shared.binding.bindingId
        || current.agentId !== shared.binding.agentId || current.activationState !== 'active'
        || !current.enabled || !current.policy.enabled || current.policy.liveDeny
        || (delivery.deliveryKind === 'task_completion' && current.policy.completion === 'silent')) {
        await this.options.orgGroupAgentStore.markDeliveryDeadLetter(delivery.deliveryId, 'ORG_AGENT_CHANNEL_LIVE_DENY');
        return;
      }
    }
    const claimed = await this.options.orgGroupAgentStore.claimDelivery(delivery.deliveryId, this.workerId, this.leaseTtlMs);
    try {
      const receipt = await this.options.sender.send(account, inboxEvent(item), text, idempotencyKey);
      if (!receipt) throw new Error('DWS_DELIVERY_RECEIPT_MISSING');
      await this.options.orgGroupAgentStore.markDeliverySent(delivery.deliveryId, this.workerId, claimed.leaseFence, receipt);
    } catch (error) {
      await this.options.orgGroupAgentStore.markDeliveryUnknown(delivery.deliveryId, this.workerId, claimed.leaseFence, error);
    }
  }
}

interface SharedGroupContext {
  binding: OrgAgentChannelBinding;
  workConversation: OrgAgentWorkConversation;
  externalActor: OrgAgentChannelActorRef;
  requester: UserIdentity | null;
  memories: OrgAgentMemory[];
}

type SharedGroupResolution =
  | { state: 'legacy' }
  | { state: 'denied'; reason: string }
  | { state: 'active'; context: SharedGroupContext };

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

function isV1InboxWithoutIdentity(item: AgentDwsInboxRecord): boolean {
  return item.payload.schemaVersion === 1
    && !Object.prototype.hasOwnProperty.call(item.payload, 'accountIdentity');
}

function matchesInboxAccountIdentity(
  item: AgentDwsInboxRecord,
  account: AgentDwsAccountRecord,
): boolean {
  const rawIdentity = item.payload.accountIdentity;
  if (!rawIdentity || typeof rawIdentity !== 'object' || Array.isArray(rawIdentity)) return false;
  const identity = rawIdentity as Record<string, unknown>;
  return identity.profileId === account.profileId
    && identity.corpId === account.corpId
    && identity.dingtalkUserId === account.dingtalkUserId;
}

function buildSystemContext(
  account: AgentDwsAccountRecord,
  item: AgentDwsInboxRecord,
  shared?: SharedGroupContext,
): string {
  const isBackgroundCompletion = item.payload.source === 'background_task_completion';
  return [
    `你正在通过组织 Agent「${bounded(account.displayName)}」的专属钉钉成员账号参与工作。`,
    '回复会由平台以该成员账号发回当前钉钉会话。不要声称自己是机器人，也不要泄露内部账号、事件或会话标识。',
    '需要澄清时直接用普通文本提问，不要调用 AskUserQuestion；当前钉钉通道不承载平台审批交互。',
    ...(isBackgroundCompletion ? [
      '当前消息是平台生成的 durable Worker 完成通知，不是用户的新请求。请播报其中的任务 ID、准确终态和精炼结果；不要再创建 Worker。',
    ] : []),
    ...(shared ? [
      `当前工作空间：${shared.binding.conversationSpaceId}；当前话题：${shared.workConversation.workConversationId}。`,
      `本轮调用者身份可信度：${shared.externalActor.kind === 'service_event' ? 'service' : shared.externalActor.assurance}。只能调用本群 effective config 明确开放的工具。`,
      '这是组织共享会话。禁止读取请求者个人记忆、个人连接器或其他群内容；未映射身份只能处理本群允许的组织共享信息。',
      ...(shared.memories.length ? [`当前已治理记忆（只读）：${bounded(JSON.stringify(shared.memories.map(memory => ({ scope: memory.memoryScope, content: memory.content }))), 12_000)}`] : []),
    ] : []),
    `当前入口：${item.eventType === 'user_im_message_receive_at' ? '群聊 @' : '单聊'}。`,
  ].join('\n');
}

function serviceIdentity(account: AgentDwsAccountRecord): UserIdentity {
  return {
    id: `adws-${account.accountId}`,
    username: `agent-dws:${account.agentId}`,
    role: 'user',
    tenantId: account.tenantId,
    realName: account.displayName,
  };
}

function sharedAllowedTools(shared: SharedGroupContext): string[] {
  const contextTools = new Set(['ContextSearch', 'ContextGet']);
  const alwaysPersonal = new Set(['MemoryCommand', 'UserActivityList']);
  if (shared.externalActor.kind === 'service_event') return [];
  if (shared.externalActor.assurance !== 'mapped') {
    if (shared.binding.policy.guest !== 'shared_read_only'
      || !shared.binding.effectiveConfig.knowledge.contextEnabled) return [];
    return shared.binding.effectiveConfig.capabilities.toolNames.filter(name => contextTools.has(name));
  }
  return shared.binding.effectiveConfig.capabilities.toolNames.filter(name => (
    !alwaysPersonal.has(name)
    && (shared.binding.effectiveConfig.knowledge.contextEnabled || !contextTools.has(name))
  ));
}

function rejectionMessage(reason: string): string {
  switch (reason) {
    case 'REQUESTER_IDENTITY_MISSING':
    case 'REQUESTER_IDENTITY_UNMAPPED_OR_AMBIGUOUS':
      return '我暂时无法确认你的组织身份。请先完成账号绑定，或联系管理员开放本群的访客共享读取权限。';
    case 'ORG_AGENT_AUDIENCE_DENIED':
      return '你目前不在这个 Agent 的可用范围内，请联系管理员调整成员范围。';
    case 'ORG_AGENT_UNAVAILABLE':
      return '这个 Agent 当前未启用，请联系管理员检查账号与 Agent 状态。';
    default:
      return '当前请求未通过组织权限检查。请联系管理员确认本群配置和你的访问范围。';
  }
}

function collectAssistantText(events: PlatformEvent[]): string {
  return events
    .filter((event): event is Extract<PlatformEvent, { type: 'assistant_message' }> => (
      event.type === 'assistant_message' && !event.incomplete
    ))
    .map(event => event.content)
    .filter(Boolean)
    .join('');
}

function normalizeEventTimestamp(value: number): Date {
  const millis = value < 10_000_000_000 ? value * 1_000 : value;
  const date = new Date(millis);
  return Number.isFinite(date.getTime()) ? date : new Date();
}

const ROUTING_FIELD_NAMES = [
  'root_message_id', 'thread_id', 'parent_message_id', 'quote_message_id', 'reply_message_id',
] as const;

function extractRoutingFields(raw: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(ROUTING_FIELD_NAMES.flatMap(key => {
    const value = raw[key];
    return typeof value === 'string' && value.trim() && value.length <= MAX_EVENT_ID_LENGTH
      ? [[key, value.trim()]] : [];
  }));
}

function routingMessageIds(item: AgentDwsInboxRecord): string[] {
  const routing = item.payload.routing;
  if (routing && typeof routing === 'object' && !Array.isArray(routing)) {
    const record = routing as Record<string, unknown>;
    for (const key of ROUTING_FIELD_NAMES) {
      const value = record[key];
      if (typeof value === 'string' && value) return [value];
    }
  }
  return [];
}

function deterministicId(prefix: string, value: string): string {
  return `${prefix}-${createHash('sha256').update(value).digest('hex').slice(0, 32)}`;
}

function boundedPositive(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value! > 0 ? value! : fallback;
}

function bounded(value: string, maxLength = MAX_SYSTEM_CONTEXT_FIELD): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function boundedExternalId(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function safeLogId(value: unknown): string {
  return typeof value === 'string'
    ? value.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 100)
    : 'unknown';
}

function compactError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/((?:access_token|refresh_token|authorization|token)\s*[=:]\s*["']?)[^\s,"'}]+/gi, '$1[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500) || 'unknown_error';
}

async function legacyRequesterResolution(
  resolver: AgentDwsMessageRouterOptions['resolveRequester'],
  account: AgentDwsAccountRecord,
  senderOpenDingtalkId: string,
  senderName?: string,
): Promise<DwsRequesterResolution> {
  const requester = await resolver(account, senderOpenDingtalkId, senderName);
  return requester ? { status: 'resolved', requester }
    : { status: 'unmapped', reason: 'REQUESTER_IDENTITY_UNMAPPED' };
}

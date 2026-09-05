import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { relative, sep } from 'node:path';

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
import type { OrgGroupAgentStore } from '../data/orgGroupAgents/index.js';
import { deriveOrgAgentSharedView } from '../runtime/orgAgentTaskWorkspace.js';
import type { EventStore } from '../runtime/types.js';
import type { UserIdentity } from '../types/index.js';
import type { OrgAgentStore } from '../data/orgAgents/store.js';
import { resolveAgentCwd } from '../workspace/resolver.js';
import {
  extractOrgAgentRoutingFields,
  pinActiveOrgAgentGroupRouting,
} from './orgAgentInboxRouting.js';
import {
  resolveSharedGroupContext,
  type SharedGroupContext,
  type SharedGroupResolution,
} from './orgAgentSharedGroupContext.js';
import {
  allowsGuestSharedRead,
  formatPrivateCompletion,
  sharedAllowedTools,
} from './orgAgentGroupPolicy.js';
import {
  assertDwsReplyAttemptFresh,
  authorizeCurrentDwsRequester,
  boundedExternalId,
  boundedPositive,
  buildSystemContext,
  collectAssistantText,
  compactError,
  deterministicId,
  isV1InboxWithoutIdentity,
  legacyRequesterResolution,
  matchesInboxAccountIdentity,
  normalizeEventTimestamp,
  persistedRejectionReason,
  prepareRoutingClarificationReply,
  rejectionMessage,
  safeLogId,
  serviceIdentity,
} from './personalMessageRouterHelpers.js';
import type { DwsPersonalEvent } from './personalEventGateway.js';
import { deliverNextOrgAgentIntent } from './orgAgentDeliveryWorker.js';
import {
  finalizeReplyDelivery, OrgAgentProviderAuthorizationRevokedError,
  OrgAgentVisibleReplyService, settleFrontReply,
} from './orgAgentVisibleReply.js';
import type { DwsPersonalMessageSenderLike } from './personalMessageSender.js';
import type { DwsRequesterResolution } from './requesterIdentityResolver.js';

const DEFAULT_POLL_MS = 1_000;
const DEFAULT_LEASE_TTL_MS = 120_000;
const DEFAULT_LEASE_RENEW_MS = 30_000;
const DEFAULT_MAX_CONCURRENCY = 4;
const MAX_CONCURRENCY = 32;
const ACTIVE_RUN_RECHECK_MS = 30_000;
const DEFAULT_FRONT_REPLY_DEADLINE_MS = 3_000;
const MAX_EVENT_ID_LENGTH = 512;
const MAX_CONVERSATION_ID_LENGTH = 1_024;
const MAX_MESSAGE_CONTENT_LENGTH = 100_000;
const SUPPORTED_EVENT_TYPES = new Set([
  'user_im_message_receive_at',
  'user_im_message_receive_o2o_all',
]);

class AgentDwsMessageDeferredError extends Error {
  constructor(
    message: string,
    readonly delayMs: number,
  ) {
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
  orgAgentStore?: Pick<OrgAgentStore, 'get'>;
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
  resolveRequesterGovernanceRole?: (
    tenantId: string,
    userId: string,
  ) => Promise<'member' | 'org_admin' | undefined> | 'member' | 'org_admin' | undefined;
  isOrgAgentRuntimeV2Ready?: (account: AgentDwsAccountRecord) => boolean | Promise<boolean>;
  authorizeCompletionRequester?: (
    tenantId: string,
    agentId: string,
    userId: string,
  ) => Promise<boolean> | boolean;
  authorizeRequester: (input: {
    account: AgentDwsAccountRecord;
    requester: UserIdentity;
    sessionId: string;
    runId: string;
    phase?: 'dispatch' | 'provider_start';
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
  frontReplyDeadlineMs?: number;
  now?: () => number; // 可注入时钟；测试用于让幂等窗口判定确定化。
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
  private readonly frontReplyDeadlineMs: number;
  private readonly visibleReply: OrgAgentVisibleReplyService;
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
    this.maxConcurrency = Math.min(
      boundedPositive(options.maxConcurrency, DEFAULT_MAX_CONCURRENCY),
      MAX_CONCURRENCY,
    );
    this.frontReplyDeadlineMs = boundedPositive(
      options.frontReplyDeadlineMs,
      DEFAULT_FRONT_REPLY_DEADLINE_MS,
    );
    this.visibleReply = new OrgAgentVisibleReplyService(
      options,
      this.workerId,
      this.leaseTtlMs,
      this.frontReplyDeadlineMs,
    );
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
      this.options.logger?.warn(
        `Agent DWS event ignored with inexact account identity account=${account.accountId}`,
      );
      return false;
    }
    if (!SUPPORTED_EVENT_TYPES.has(event.type)) {
      this.options.logger?.warn(
        `Agent DWS event ignored with unsupported type account=${account.accountId} event=${safeLogId(event.eventId)}`,
      );
      return false;
    }
    if (
      !boundedExternalId(event.eventId, MAX_EVENT_ID_LENGTH) ||
      !boundedExternalId(event.conversationId, MAX_CONVERSATION_ID_LENGTH)
    ) {
      this.options.logger?.warn(
        `Agent DWS event ignored with invalid identifiers account=${account.accountId}`,
      );
      return false;
    }
    if (
      typeof event.content !== 'string' ||
      !event.content.trim() ||
      event.content.length > MAX_MESSAGE_CONTENT_LENGTH
    ) {
      this.options.logger?.warn(
        `Agent DWS event ignored with invalid text content account=${account.accountId} event=${safeLogId(event.eventId)}`,
      );
      return false;
    }
    if (event.messageId && !boundedExternalId(event.messageId, MAX_EVENT_ID_LENGTH)) return false;
    if (
      event.senderOpenDingtalkId &&
      !boundedExternalId(event.senderOpenDingtalkId, MAX_EVENT_ID_LENGTH)
    )
      return false;
    if (event.senderName && (!event.senderName.trim() || event.senderName.length > 200))
      return false;
    const result = await this.options.messageStore.ingest(
      {
        tenantId: account.tenantId,
        accountId: account.accountId,
        eventId: event.eventId,
        eventType: event.type,
        conversationId: event.conversationId,
        ...(event.messageId ? { messageId: event.messageId } : {}),
        ...(event.senderOpenDingtalkId ? { senderOpenDingtalkId: event.senderOpenDingtalkId } : {}),
        content: event.content,
        ...(event.timestamp !== undefined
          ? { eventTimestamp: normalizeEventTimestamp(event.timestamp) }
          : {}),
      },
      {
        schemaVersion: 2,
        source: 'dws_personal_stream',
        eventType: event.type,
        accountIdentity: {
          profileId: account.profileId,
          corpId: account.corpId,
          dingtalkUserId: account.dingtalkUserId,
        },
        routing: extractOrgAgentRoutingFields(event.raw),
        ...(event.senderName ? { senderName: event.senderName } : {}),
      },
    );
    await pinActiveOrgAgentGroupRouting({
      store: this.options.orgGroupAgentStore,
      account,
      event,
      item: result.record,
    });
    if (result.created) this.scheduleKick();
    return result.created;
  }

  async runOnce(): Promise<boolean> {
    if (this.stopped) return false;
    if (
      this.options.orgGroupAgentStore &&
      (await deliverNextOrgAgentIntent({
        store: this.options.orgGroupAgentStore,
        accountStore: this.options.accountStore,
        ...(this.options.orgAgentStore ? { agentStore: this.options.orgAgentStore } : {}),
        sender: this.options.sender,
        workerId: this.workerId,
        leaseTtlMs: this.leaseTtlMs,
        ...(this.options.authorizeCompletionRequester
          ? { authorizeCompletionRequester: this.options.authorizeCompletionRequester }
          : {}),
      }))
    )
      return true;
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
      void this.options.messageStore
        .renewLease(item.inboxId, this.workerId, item.leaseFence, this.leaseTtlMs)
        .then((renewed) => {
          if (!renewed) {
            leaseLost = true;
            abortController.abort();
          }
        })
        .catch((error) => {
          leaseLost = true;
          abortController.abort();
          this.options.logger?.warn(
            `Agent DWS inbox lease renewal failed inbox=${item.inboxId}: ${compactError(error)}`,
          );
        })
        .finally(() => {
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
        const persist =
          error instanceof AgentDwsMessageDeferredError
            ? this.options.messageStore.defer(
                item.inboxId,
                this.workerId,
                item.leaseFence,
                error.delayMs,
                error.message,
              )
            : this.options.messageStore.fail(item.inboxId, this.workerId, item.leaseFence, error);
        await persist.catch((failError) => {
          this.options.logger?.warn(
            `Agent DWS inbox failure persistence failed inbox=${item.inboxId}: ${compactError(failError)}`,
          );
        });
      }
      this.options.logger?.warn(
        `Agent DWS inbox processing failed inbox=${item.inboxId}: ${compactError(error)}`,
      );
      return false;
    } finally {
      clearInterval(heartbeat);
      this.activeAborts.delete(abortController);
    }
  }

  private scheduleKick(): void {
    void this.kick().catch((error) => {
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
          .then((result) => {
            processed = result;
          })
          .catch((error) => {
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

  private async process(
    item: AgentDwsInboxRecord,
    abortController: AbortController,
  ): Promise<void> {
    const account = await this.options.accountStore.getForTenant(item.tenantId, item.accountId);
    if (isV1InboxWithoutIdentity(item)) {
      const upgraded = await this.options.messageStore.pinLegacyIdentityOrTerminate(
        item.inboxId,
        this.workerId,
        item.leaseFence,
        account && account.status === 'active' && hasExactAgentDwsProfile(account)
          ? {
              profileId: account.profileId!,
              corpId: account.corpId!,
              dingtalkUserId: account.dingtalkUserId!,
            }
          : undefined,
      );
      if (
        upgraded.state === 'dead_letter' &&
        upgraded.lastError === DWS_INBOX_V1_IDENTITY_UNPROVABLE
      ) {
        this.options.logger?.warn(
          JSON.stringify({
            level: 'warn',
            code: DWS_INBOX_V1_IDENTITY_UNPROVABLE,
            inboxId: item.inboxId,
            tenantId: item.tenantId,
            accountId: item.accountId,
            eventId: item.eventId,
          }),
        );
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
    if (
      item.eventType === 'user_im_message_receive_o2o_all' &&
      item.senderOpenDingtalkId === account.dingtalkUserId
    ) {
      await this.options.messageStore.complete(item.inboxId, this.workerId, item.leaseFence);
      return;
    }
    const persistedRejection = persistedRejectionReason(item);
    if (persistedRejection) {
      await this.rejectAccess(account, item, persistedRejection);
      return;
    }
    const senderName =
      typeof item.payload.senderName === 'string' ? item.payload.senderName : undefined;
    const serviceEvent = item.payload.source === 'background_task_completion';
    const requesterResolution =
      item.senderOpenDingtalkId && !serviceEvent
        ? this.options.resolveRequesterOutcome
          ? await this.options.resolveRequesterOutcome(
              account,
              item.senderOpenDingtalkId,
              senderName,
            )
          : await legacyRequesterResolution(
              this.options.resolveRequester,
              account,
              item.senderOpenDingtalkId,
              senderName,
            )
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
    const requester =
      requesterResolution?.status === 'resolved'
        ? requesterResolution.requester
        : serviceEvent && !this.options.orgGroupAgentStore && item.senderOpenDingtalkId
          ? await this.options.resolveRequester(account, item.senderOpenDingtalkId, senderName)
          : null;
    const sharedResolution = await resolveSharedGroupContext(
      this.options,
      account,
      item,
      requester,
      senderName,
    );
    if (sharedResolution.state === 'ignored') {
      await this.options.messageStore.complete(item.inboxId, this.workerId, item.leaseFence);
      return;
    }
    if (sharedResolution.state === 'denied') {
      await this.rejectAccess(account, item, sharedResolution.reason, requester ?? undefined);
      return;
    }
    const shared = sharedResolution.state === 'active' ? sharedResolution.context : undefined;
    if (!serviceEvent && !item.senderOpenDingtalkId) {
      await this.rejectAccess(account, item, 'REQUESTER_IDENTITY_MISSING');
      return;
    }
    if (
      !serviceEvent &&
      !shared &&
      (!requester || !requester.tenantId || requester.tenantId !== account.tenantId)
    ) {
      await this.rejectAccess(account, item, 'REQUESTER_IDENTITY_UNMAPPED_OR_AMBIGUOUS');
      return;
    }
    const candidateSessionId = `agent-dws-session-${randomUUID()}`;
    const runId =
      item.runId ?? deterministicId('agent-dws-run', `${item.accountId}:${item.eventId}`);
    if (requester && !serviceEvent) {
      const authorization = await this.options.authorizeRequester({
        account,
        requester,
        sessionId: candidateSessionId,
        runId,
      });
      if (!authorization.allowed) {
        await this.rejectAccess(account, item, authorization.reason ?? 'ACCESS_DENIED', requester);
        return;
      }
    } else if (!serviceEvent && (!shared || !allowsGuestSharedRead(shared.binding))) {
      await this.rejectAccess(account, item, 'REQUESTER_IDENTITY_UNMAPPED_OR_AMBIGUOUS');
      return;
    }
    if (shared?.routingClarification) {
      const clarificationText = await prepareRoutingClarificationReply(
        this.options.messageStore,
        item,
        this.workerId,
        shared.routingClarification,
        this.options.now?.() ?? Date.now(),
      );
      const clarificationDelivery = await this.visibleReply.send(
        account, item, clarificationText, shared, 'front_reply', 'replied',
      );
      if (!(await finalizeReplyDelivery(this.options.messageStore, this.workerId, item, clarificationDelivery))) return;
      await this.options.messageStore.complete(item.inboxId, this.workerId, item.leaseFence);
      return;
    }
    const legacyBinding = shared
      ? undefined
      : await this.options.messageStore.getOrCreateBinding(
          item.tenantId,
          item.accountId,
          item.conversationId,
          requester!.id,
          candidateSessionId,
          item.eventType === 'user_im_message_receive_o2o_all'
            ? item.senderOpenDingtalkId
            : undefined,
        );
    const privateCompletion =
      serviceEvent && shared?.completionWork?.visibility === 'requester_only'
        ? shared.completionWork
        : undefined;
    const sessionId = privateCompletion
      ? deterministicId(
          'agent-dws-private-completion',
          `${privateCompletion.workOrderId}:${privateCompletion.createdByActor.openId}`,
        )
      : (shared?.workConversation.sessionId ?? legacyBinding!.sessionId);
    const claimed = await this.options.messageStore.markDispatchStarted(
      item.inboxId,
      this.workerId,
      item.leaseFence,
      sessionId,
      runId,
    );

    const frontReplyDeadline =
      shared && !serviceEvent ? this.visibleReply.schedule(account, item, shared) : undefined;
    let responseText = claimed.responseText;
    try {
      if (responseText === undefined) {
        responseText = privateCompletion
          ? formatPrivateCompletion(privateCompletion)
          : item.runId
            ? await this.recoverOrResumeMissingRun(
                item,
                sessionId,
                runId,
                account,
                requester ?? serviceIdentity(account),
                abortController,
                shared,
              )
            : await this.dispatch(
                item,
                sessionId,
                runId,
                account,
                requester ?? serviceIdentity(account),
                abortController,
                shared,
              );
        if (!responseText.trim()) throw new Error('Agent runtime completed without a reply');
        await this.options.messageStore.saveDispatchResult(
          item.inboxId,
          this.workerId,
          item.leaseFence,
          responseText,
        );
      }
    } catch (error) {
      if (error instanceof AgentDwsMessageDeferredError) {
        await frontReplyDeadline?.fireNow();
      } else {
        await frontReplyDeadline?.cancel();
      }
      throw error;
    }

    if (abortController.signal.aborted) throw new Error('Agent DWS inbox processing aborted');
    const replyAttempt = await this.options.messageStore.markReplyAttemptStarted(
      item.inboxId,
      this.workerId,
      item.leaseFence,
    );
    assertDwsReplyAttemptFresh(replyAttempt.replyStartedAt, 'reply', this.options.now?.() ?? Date.now());
    const replyAccount = await this.options.accountStore.getForTenant(
      item.tenantId,
      item.accountId,
    );
    if (
      !replyAccount ||
      replyAccount.status !== 'active' ||
      !hasExactAgentDwsProfile(replyAccount) ||
      !matchesInboxAccountIdentity(item, replyAccount)
    ) {
      throw new Error('Agent DWS account identity changed before reply');
    }
    const authorizeBeforeProvider = !shared && requester && !serviceEvent
      ? () => authorizeCurrentDwsRequester({
          account: replyAccount, expectedRequester: requester,
          senderOpenDingtalkId: item.senderOpenDingtalkId!, ...(senderName ? { senderName } : {}),
          sessionId, runId, resolveRequester: this.options.resolveRequester,
          ...(this.options.resolveRequesterOutcome
            ? { resolveRequesterOutcome: this.options.resolveRequesterOutcome } : {}),
          authorizeRequester: this.options.authorizeRequester,
        })
      : undefined;
    const sendReply = (phase: 'first' | 'final') => this.visibleReply.send(
      replyAccount, item, responseText, shared, 'front_reply', 'replied', phase,
      undefined, authorizeBeforeProvider,
    );
    let replyDelivery;
    try {
      replyDelivery = await settleFrontReply(
        frontReplyDeadline, () => sendReply('first'), () => sendReply('final'),
      );
    } catch (error) {
      if (!(error instanceof OrgAgentProviderAuthorizationRevokedError)) throw error;
      await this.options.auditRequesterRejection({ account: replyAccount,
        eventId: item.eventId, ...(requester ? { requester } : {}), reason: error.reason });
      await this.visibleReply.replacePendingWithAccessRejection(
        replyAccount, item, rejectionMessage(error.reason), error.reason, true);
      return;
    }
    if (!(await finalizeReplyDelivery(
      this.options.messageStore, this.workerId, item, replyDelivery,
    ))) return;
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
    if (item.state === 'reply_pending' && item.replyKind !== 'access_rejection') {
      await this.visibleReply.replacePendingWithAccessRejection(
        account, item, rejectionMessage(reason), reason,
      );
      this.options.logger?.warn(`Agent DWS pending normal reply reconciled account=${item.accountId} event=${item.eventId} reason=${reason}`);
      return;
    }
    // processing 阶段先持久化拒绝正文与类型；拒绝型 reply_pending 重领时直接恢复。
    const saved = item.state === 'reply_pending'
      ? item
      : await this.options.messageStore.saveRejectionResult(
          item.inboxId,
          this.workerId,
          item.leaseFence,
          rejectionMessage(reason),
          reason,
        );
    const responseText = saved.responseText ?? rejectionMessage(reason);
    const reasonCode = saved.rejectionReasonCode ?? reason;
    const replyAttempt = await this.options.messageStore.markReplyAttemptStarted(
      item.inboxId,
      this.workerId,
      item.leaseFence,
    );
    assertDwsReplyAttemptFresh(replyAttempt.replyStartedAt, 'rejection reply', this.options.now?.() ?? Date.now());
    const rejectionDelivery = await this.visibleReply.send(
      account,
      item,
      responseText,
      undefined,
      'access_rejection',
      'rejected',
    );
    if (!(await finalizeReplyDelivery(this.options.messageStore, this.workerId, item, rejectionDelivery))) return;
    await this.options.messageStore.reject(
      item.inboxId,
      this.workerId,
      item.leaseFence,
      reasonCode,
    );
    this.options.logger?.warn(
      `Agent DWS requester rejected account=${item.accountId} event=${item.eventId} reason=${reasonCode}`,
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
      return await this.dispatch(
        item,
        sessionId,
        runId,
        account,
        requester,
        abortController,
        shared,
      );
    }
    if (existing.sessionId !== sessionId) throw new Error('Agent DWS run/session binding mismatch');
    if (
      ['pending', 'running', 'waiting_approval', 'waiting_user', 'waiting_hand'].includes(
        existing.status,
      )
    ) {
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
    const events = await listByRun.call(
      this.options.eventStore,
      account.tenantId,
      sessionId,
      runId,
    );
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
    const agentRoot = resolveAgentCwd(this.options.agentCwd, account.tenantId, account.agentId);
    const agentMountSubPath = relative(this.options.agentCwd, agentRoot).split(sep).join('/');
    const sharedView = shared
      ? deriveOrgAgentSharedView({
          agentRoot,
          agentMountSubPath,
          bindingId: shared.binding.bindingId,
          workConversationId: shared.workConversation.workConversationId,
        })
      : undefined;
    if (sharedView) await mkdir(sharedView.root, { recursive: true });
    const executionCwd = sharedView?.root ?? agentRoot;
    let resultText: string | undefined;
    let pendingApproval = false;
    const events = this.options.dispatch(
      {
        channel: 'dingtalk',
        chatId: item.conversationId,
        content: item.content,
        ...(item.senderOpenDingtalkId ? { senderId: item.senderOpenDingtalkId } : {}),
        metadata: {
          source:
            item.payload.source === 'background_task_completion'
              ? 'agent_dws_background_completion'
              : 'agent_dws_personal_stream',
          accountId: item.accountId,
          profileId: account.profileId,
          corpId: account.corpId,
          dingtalkUserId: account.dingtalkUserId,
          eventId: item.eventId,
          eventType: item.eventType,
          ...(item.messageId ? { messageId: item.messageId } : {}),
        },
      },
      {
        channel: 'dingtalk',
        outputTransactionMode: 'terminal_buffered',
        resumeSessionId: sessionId,
        systemContext: buildSystemContext(account, item, shared),
        ...(shared
          ? {
              user: shared.requester ?? undefined,
              sessionOwner: serviceIdentity(account),
              orgAgentChannel: {
                bindingId: shared.binding.bindingId,
                accountId: shared.binding.accountId,
                agentId: shared.binding.agentId,
                conversationSpaceId: shared.binding.conversationSpaceId,
                workConversationId: shared.workConversation.workConversationId,
                policyRevision: shared.binding.revision,
                agentPrincipal: {
                  kind: 'org_agent',
                  tenantId: shared.binding.tenantId,
                  agentId: shared.binding.agentId,
                  accountId: shared.binding.accountId,
                  workspaceId: shared.binding.workspaceId,
                },
                externalActorAssurance:
                  shared.externalActor.kind === 'service_event'
                    ? 'service'
                    : shared.externalActor.assurance,
                allowedToolNames: sharedAllowedTools(shared),
                allowedSkillIds: [...shared.binding.effectiveConfig.capabilities.skillIds],
                allowedSourceIds: [...shared.binding.effectiveConfig.knowledge.sourceIds],
                dwsResourceIds: [...shared.binding.effectiveConfig.capabilities.dwsResourceIds],
                contextEnabled: shared.binding.effectiveConfig.knowledge.contextEnabled,
                taskVisibility: shared.binding.policy.taskVisibility,
                ...(shared.governanceRole ? { actorRole: shared.governanceRole } : {}),
                triggerRoles: [...shared.binding.effectiveConfig.access.triggerRoles],
                approvalRoles: [...shared.binding.effectiveConfig.access.approvalRoles],
                externalActor: shared.externalActor,
                channelPrincipal: {
                  provider: 'dingtalk',
                  accountId: shared.binding.accountId,
                  conversationId: shared.binding.conversationId,
                  kind: 'group',
                },
              },
            }
          : { sessionOwner: requester }),
        targetCwd: executionCwd,
      },
      {
        cwd: executionCwd,
        resumeSessionId: sessionId,
        orgAgentId: account.agentId,
        model: resolvedModel.model,
        modelRef: resolvedModel.ref,
        ...(resolvedModel.connection ? { modelConnection: resolvedModel.connection } : {}),
        ...(resolvedModel.providerOptions
          ? { modelProviderOptions: resolvedModel.providerOptions }
          : {}),
        runtimeRunId: runId,
        ...(shared
          ? {
              allowedTools: sharedAllowedTools(shared),
              skipMemory: true,
              executionTarget: 'server-container' as const,
            }
          : {}),
        ...(item.payload.source === 'background_task_completion'
          ? { dispatcherCompletion: true }
          : {}),
        abortController,
      },
      {
        onInteraction: async (event) => {
          if (event.type === 'permission_request') {
            if (shared && event.toolName === 'DwsBusiness') {
              pendingApproval = true;
              await this.visibleReply.send(
                account,
                item,
                '这项组织写操作已进入审批，管理员批准后我会继续执行并回复结果。',
                shared,
                'front_reply',
                'replied',
                'first',
                'system',
              );
              return {
                deferred: true,
                message: '等待平台管理员审批组织写操作',
              };
            }
            await this.options.auditToolPolicyRejection({
              account,
              requester,
              runId,
              ...(event.toolName || event.toolId
                ? { toolName: event.toolName ?? event.toolId }
                : {}),
            });
            return {
              allow: false,
              message:
                '钉钉成员会话暂不支持交互式工具审批，本次工具调用已拒绝；请直接回复用户可执行的替代方案。',
            };
          }
          return {
            answers: {},
            message: '钉钉成员会话暂不支持交互式提问；请在回复中直接向用户说明需要补充的信息。',
          };
        },
        onResult: (result) => {
          resultText = result.resultText;
        },
      },
    );
    let dispatchError: string | undefined;
    const consumed = await createEventConsumer().consume(events, {
      onError: (error) => {
        dispatchError = compactError(error);
      },
    });
    if (abortController.signal.aborted) throw new Error('Agent DWS runtime dispatch aborted');
    if (consumed.hasError) {
      throw new Error(`Agent DWS runtime dispatch failed: ${dispatchError ?? 'unknown_error'}`);
    }
    if (consumed.sessionId && consumed.sessionId !== sessionId) {
      throw new Error('Agent DWS runtime returned an unexpected session');
    }
    if (pendingApproval) {
      throw new AgentDwsMessageDeferredError(
        'Agent DWS organization write is waiting for durable approval',
        ACTIVE_RUN_RECHECK_MS,
      );
    }
    return resultText ?? consumed.finalText;
  }

  private async resolveSharedGroupContext(
    account: AgentDwsAccountRecord,
    item: AgentDwsInboxRecord,
    requester: UserIdentity | null,
    senderName?: string,
  ): Promise<SharedGroupResolution> {
    return await resolveSharedGroupContext(this.options, account, item, requester, senderName);
  }
}

export { buildSystemContext } from './personalMessageRouterHelpers.js';

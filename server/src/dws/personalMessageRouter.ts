import { createHash, randomUUID } from 'node:crypto';

import type { AgentRunDispatch, AgentRunOptions } from '../agent/index.js';
import { createEventConsumer } from '../channels/eventConsumer.js';
import type { AgentDwsAccountRecord, AgentDwsAccountStore } from '../data/agentDwsAccounts/index.js';
import type {
  AgentDwsInboxRecord,
  AgentDwsMessageStore,
} from '../data/agentDwsMessages/index.js';
import type { RunStore } from '../runtime/runStore.js';
import type { EventStore, PlatformEvent } from '../runtime/types.js';
import { resolveAgentCwd } from '../workspace/resolver.js';
import type { DwsPersonalEvent } from './personalEventGateway.js';
import type { DwsPersonalMessageSenderLike } from './personalMessageSender.js';

const DEFAULT_POLL_MS = 1_000;
const DEFAULT_LEASE_TTL_MS = 120_000;
const DEFAULT_LEASE_RENEW_MS = 30_000;
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
  accountStore: AgentDwsAccountStore;
  dispatch: AgentRunDispatch;
  resolveDefaultModel: (tenantId: string) => AgentDwsDefaultModelResolution | null;
  sender: DwsPersonalMessageSenderLike;
  runStore?: ExistingRunStore;
  eventStore?: ExistingRunEventStore;
  pollMs?: number;
  leaseTtlMs?: number;
  leaseRenewMs?: number;
  logger?: {
    info(message: string): void;
    warn(message: string): void;
  };
}

/** Durable DWS inbox worker. One claimed event is processed at a time per process. */
export class AgentDwsMessageRouter {
  private readonly workerId = `agent-dws-router:${randomUUID()}`;
  private readonly pollMs: number;
  private readonly leaseTtlMs: number;
  private readonly leaseRenewMs: number;
  private timer?: NodeJS.Timeout;
  private active?: Promise<boolean>;
  private activeAbort?: AbortController;
  private stopped = false;

  constructor(private readonly options: AgentDwsMessageRouterOptions) {
    this.pollMs = boundedPositive(options.pollMs, DEFAULT_POLL_MS);
    this.leaseTtlMs = boundedPositive(options.leaseTtlMs, DEFAULT_LEASE_TTL_MS);
    this.leaseRenewMs = boundedPositive(options.leaseRenewMs, DEFAULT_LEASE_RENEW_MS);
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
    this.timer = undefined;
    this.activeAbort?.abort();
    await this.active?.catch(() => undefined);
  }

  async ingest(account: AgentDwsAccountRecord, event: DwsPersonalEvent): Promise<boolean> {
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
      schemaVersion: 1,
      source: 'dws_personal_stream',
      eventType: event.type,
    });
    if (result.created) this.scheduleKick();
    return result.created;
  }

  async runOnce(): Promise<boolean> {
    if (this.stopped) return false;
    const item = await this.options.messageStore.claimNext(this.workerId, this.leaseTtlMs);
    if (!item) return false;
    const abortController = new AbortController();
    this.activeAbort = abortController;
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
      if (!leaseLost) {
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
      if (this.activeAbort === abortController) this.activeAbort = undefined;
    }
  }

  private scheduleKick(): void {
    void this.kick().catch(error => {
      this.options.logger?.warn(`Agent DWS inbox poll failed: ${compactError(error)}`);
    });
  }

  private async kick(): Promise<void> {
    if (this.stopped || this.active) return;
    const task = (async () => {
      let processed = false;
      do {
        processed = await this.runOnce();
      } while (processed && !this.stopped);
      return processed;
    })().finally(() => {
      if (this.active === task) this.active = undefined;
    });
    this.active = task;
    await task;
  }

  private async process(item: AgentDwsInboxRecord, abortController: AbortController): Promise<void> {
    const account = await this.options.accountStore.getForTenant(item.tenantId, item.accountId);
    if (!account || account.status !== 'active' || !account.profileId) {
      throw new Error('Agent DWS account is unavailable or unauthorized');
    }
    if (account.agentId.length === 0) throw new Error('Agent DWS account has no Agent binding');

    const binding = await this.options.messageStore.getOrCreateBinding(
      item.tenantId,
      item.accountId,
      item.conversationId,
      `agent-dws-session-${randomUUID()}`,
      item.eventType === 'user_im_message_receive_o2o_all' ? item.senderOpenDingtalkId : undefined,
    );
    if (item.eventType === 'user_im_message_receive_o2o_all'
      && binding.peerOpenDingtalkId
      && binding.peerOpenDingtalkId !== item.senderOpenDingtalkId) {
      await this.options.messageStore.complete(item.inboxId, this.workerId, item.leaseFence);
      this.options.logger?.info(`Agent DWS self echo ignored account=${item.accountId} event=${item.eventId}`);
      return;
    }
    const runId = item.runId ?? deterministicId('agent-dws-run', `${item.accountId}:${item.eventId}`);
    const claimed = await this.options.messageStore.markDispatchStarted(
      item.inboxId,
      this.workerId,
      item.leaseFence,
      binding.sessionId,
      runId,
    );

    let responseText = claimed.responseText;
    if (responseText === undefined) {
      responseText = item.runId
        ? await this.recoverOrResumeMissingRun(item, binding.sessionId, runId, account, abortController)
        : await this.dispatch(item, binding.sessionId, runId, account, abortController);
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
    await this.options.sender.send(
      account,
      inboxEvent(item),
      responseText,
      deterministicId('agent-dws-reply', `${item.accountId}:${item.eventId}`),
    );
    await this.options.messageStore.complete(item.inboxId, this.workerId, item.leaseFence);
    this.options.logger?.info(
      `Agent DWS inbox completed account=${item.accountId} event=${item.eventId} session=${binding.sessionId}`,
    );
  }

  private async recoverOrResumeMissingRun(
    item: AgentDwsInboxRecord,
    sessionId: string,
    runId: string,
    account: AgentDwsAccountRecord,
    abortController: AbortController,
  ): Promise<string> {
    const existing = await this.options.runStore?.get(runId);
    if (!existing) {
      return await this.dispatch(item, sessionId, runId, account, abortController);
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
    abortController: AbortController,
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
          ? 'agent_dws_background_completion'
          : 'agent_dws_personal_stream',
        accountId: item.accountId,
        eventId: item.eventId,
        eventType: item.eventType,
        ...(item.messageId ? { messageId: item.messageId } : {}),
      },
    }, {
      channel: 'dingtalk',
      outputTransactionMode: 'terminal_buffered',
      resumeSessionId: sessionId,
      systemContext: buildSystemContext(account, item),
      sessionOwner: {
        id: account.accountId,
        username: `agent-dws:${account.agentId}`,
        role: 'user',
        tenantId: account.tenantId,
        realName: account.displayName,
        ...(account.dingtalkUserId ? { dingtalkStaffId: account.dingtalkUserId } : {}),
      },
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
      ...(item.payload.source === 'background_task_completion' ? { dispatcherCompletion: true } : {}),
      abortController,
    }, {
      onInteraction: async event => event.type === 'permission_request'
        ? {
            allow: false,
            message: '钉钉成员会话暂不支持交互式工具审批，本次工具调用已拒绝；请直接回复用户可执行的替代方案。',
          }
        : {
            answers: {},
            message: '钉钉成员会话暂不支持交互式提问；请在回复中直接向用户说明需要补充的信息。',
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

function buildSystemContext(account: AgentDwsAccountRecord, item: AgentDwsInboxRecord): string {
  const isBackgroundCompletion = item.payload.source === 'background_task_completion';
  return [
    `你正在通过组织 Agent「${bounded(account.displayName)}」的专属钉钉成员账号参与工作。`,
    '回复会由平台以该成员账号发回当前钉钉会话。不要声称自己是机器人，也不要泄露内部账号、事件或会话标识。',
    '需要澄清时直接用普通文本提问，不要调用 AskUserQuestion；当前钉钉通道不承载平台审批交互。',
    ...(isBackgroundCompletion ? [
      '当前消息是平台生成的 durable Worker 完成通知，不是用户的新请求。请播报其中的任务 ID、准确终态和精炼结果；不要再创建 Worker。',
    ] : []),
    `当前入口：${item.eventType === 'user_im_message_receive_at' ? '群聊 @' : '单聊'}。`,
  ].join('\n');
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

function deterministicId(prefix: string, value: string): string {
  return `${prefix}-${createHash('sha256').update(value).digest('hex').slice(0, 32)}`;
}

function boundedPositive(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value! > 0 ? value! : fallback;
}

function bounded(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_SYSTEM_CONTEXT_FIELD);
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

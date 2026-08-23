/**
 * Web Channel
 *
 * 处理 Web 前端的聊天请求，通过 WebSocket 推送 Agent 事件流。
 * 支持交互式事件（权限确认、AskUser 提问）的双向通信。
 *
 * WS 消息协议见 wsTypes.ts。
 */

import { appendFile, mkdir } from 'fs/promises';
import { randomUUID } from 'crypto';
import { homedir } from 'os';
import { dirname, resolve as resolvePath } from 'path';
import type { Express } from 'express';
import type { WebSocket } from 'ws';
import { getWebDisplayConfig, isDedicatedWebTool, projectArtifactDelivery } from './displayFilter.js';
import { chatLogger } from '../../utils/logger.js';
import type {
  WebMessageDisplayConfig,
  BaseChannel,
  InboundMessage,
  ChannelContext,
  UploadedFileInfo,
  OutboundEvent,
  ContextUsageData,
} from '../../types/index.js';
import { loadResolvedInteractionIds, notifyCrossProcessInteractionResume, scanBufferForPendingInteractions } from './interactionRecovery.js';
import type { AgentRunDispatch, AgentRunHooks } from '../../agent/types.js';
import type { ExecutionTargetKind } from '../../agent/toolRuntime.js';
import { toRunModelOptions } from '../../app/models.js';
import { interactionStore } from './interactionStore.js';
import { persistedInteractionAccessError } from './persistedInteractionAccess.js';
import {
  buildChatMessageActivityDetail,
  canViewContextUsageDetails,
  canViewContextUsageDetailsForUser,
  isPlatformAdminUser,
  redactContextUsageDetails,
} from './channelHelpers.js';
import {
  getDurableEventCursor,
  isDurableCursorAtOrBefore,
  projectRuntimePlatformEvent,
  type RuntimeStreamProjectionState,
} from './runtimeEventProjection.js';
import { getTranscriptPath, sessionExists, findTranscriptOrMetaPathBySessionId } from '../../data/transcripts/index.js';
import { readSessionMeta, writeSessionMeta, updateSessionMeta, addSessionCost, type SessionMeta } from '../../data/transcripts/meta.js';
import { resolveUserCwd } from '../../workspace/resolver.js';
import { resolveAgentPath } from '../../workspace/namespace.js';
import type { UserStore } from '../../data/users/store.js';
import { tenantAccessErrorMessage } from '../../data/tenants/access.js';
import { speechToText } from '../../integrations/stt/sttClient.js';
import { EventBufferStore } from './eventBuffer.js';
import { clearSessionsListCache } from '../../routes/sessions.js';
import {
  extractTitleContext,
  generateTitleWithFallback,
  shouldGenerateTitleFromFirstMessage,
} from '../../agent/titleGenerator.js';
import { checkTopicScope, extractRecentUserMessages } from '../../agent/guardrail.js';
import { isCompactCommand } from '../../agent/prompt.js';
import { isAssignedToOrgAgent, parseOrgAgentAudience } from '../../data/orgAgents/store.js';
import type { OrgAgentGuardrailMode, OrgAgentRecord } from '../../data/orgAgents/types.js';
import { normalizeGuardrailConfig } from '../../data/orgAgents/types.js';
import type { GuardrailEventVerdict } from '../../data/guardrail/pgGuardrailEventStore.js';
import { WsServer, type WsClient } from './wsServer.js';
import { EventBus, type SessionContext } from './eventBus.js';
import type { WsChatMessage, WsRespondMessage, WsAbortMessage, WsRunStatusMessage, WsResumeMessage, WsSyncMessage, WsInboundMessage, ChatRejectReasonCode } from './wsTypes.js';
import { appendLoginLog, detectLoginChannel } from '../../data/login-logs/index.js';
import {
  getUserExtraDirs,
  isPathWithinAnyDirectory,
  isPathWithinDirectory,
} from '../../security/extraDirs.js';
import { EventBackedApprovalStore } from '../../runtime/approvalStore.js';
import { FileEventStore, getRuntimeEventLogPath } from '../../runtime/fileEventStore.js';
import type { EventStore, PlatformEvent } from '../../runtime/types.js';
import { buildRuntimeReplayState } from '../../runtime/replay.js';
import {
  DEFAULT_EXECUTION_CONFIG,
  resolveExecutionTarget,
} from '../../runtime/executionConfig.js';
import { createRuntimeSessionRecord, resolveSessionMemoryPolicy } from '../../runtime/sessionCatalog.js';
import { deriveStableWorkspaceId } from '../../runtime/workspaceIdentity.js';
import type { RunRecord } from '../../runtime/runStore.js';
import { DEFAULT_TENANT_ID } from '../../data/tenants/types.js';
import { runtimeRunController } from '../../runtime/runController.js';
import {
  buildPendingInteractionsFromEvents,
  normalizeInteractionResponse,
} from '../../runtime/interactionProjection.js';
// Keep bounded resume primitives and workspace plan discovery out of the channel orchestrator.
// These helpers retain the existing policy constants and filesystem behavior.
import {
  approvalResumeSemaphore,
  INTERACTIVE_PERMISSION_TOOLS,
  readLatestPlanContent,
  TERMINAL_RUN_STATUSES,
  VOICE_STT_TAG,
  wantsToolAutoApproval,
} from './channelRuntimeHelpers.js';

import { handleWebChannelEvents, type WebChannelEventTitleContext } from './channelEventHandler.js';
import { bindChatAttachments } from './attachmentBinding.js';

import { deriveSubmissionSessionId, resolveAuthoritativeSubmissionState } from './channelSubmissionHelpers.js';
import type { ModelResolver, WebChannelRuntimeConfig } from './channelConfig.js';
export type { ModelResolver } from './channelConfig.js';

/**
 * Public WebChannel construction contract.
 *
 * Web-facing paths and adapters stay beside the channel orchestrator, while
 * runtime/store integrations live in channelConfig.ts to keep this file under
 * its grandfathered line ceiling without changing the exported API.
 * Keeping this facade here also preserves existing type-only import paths.
 * Consumers do not need to know how the contract is partitioned internally.
 */
export interface WebChannelConfig extends WebChannelRuntimeConfig {
  /** Server timezone used when formatting channel output. */
  timezone?: string;
  /** Optional overrides for web message rendering. */
  displayConfig?: WebMessageDisplayConfig;
  /** Default agent workspace root. */
  agentCwd?: string;
  /** Shared resource root. */
  sharedDir?: string;
  /** Login activity JSONL path. */
  loginLogFilePath?: string;
  /** Tenant-aware model reference resolver. */
  modelResolver?: ModelResolver;
  /** User lookup used for channel identity and preferences. */
  userStore?: UserStore;
  /** Secret used to authenticate WebSocket connections. */
  jwtSecret?: string;
  /** Reports whether shutdown draining has begun. */
  getIsDraining?: () => boolean;
}
export { buildChatMessageActivityDetail } from './channelHelpers.js';

interface ActiveStreamEntry {
  controller: AbortController;
  userId?: string;
  ws: WebSocket;
  sessionId?: string;
  runId?: string;
  clientMsgId?: string;
}

export class WebChannel implements BaseChannel {
  readonly name = 'web' as const;
  private displayConfig: WebMessageDisplayConfig;
  private modelResolver?: ModelResolver;
  private userStore?: UserStore;

  /**
   * 活跃流的映射：streamId → { controller, userId, ws }
   * controller 用于用户主动停止时中止 Agent。
   */
  private activeStreams = new Map<string, ActiveStreamEntry>();
  /** 同一 WS 上的 chat 必须按到达顺序完成接收入队，避免异步 guardrail/附件处理打乱插话 FIFO。 */
  private chatProcessingTails = new WeakMap<WebSocket, Promise<void>>();
  /** 同进程跨 WS 的相同 clientMessageId 也要串行，避免重复 STT/门禁与 TOCTOU 入队竞争。 */
  private submissionProcessingTails = new Map<string, Promise<void>>();

  /** 返回当前活跃流数量（供 ChannelManager 聚合） */
  getActiveStreamCount(): number {
    return this.activeStreams.size;
  }

  /** 禁用用户时调用：断开 WS 连接 + 中止活跃流 */
  disconnectUser(userId: string): void {
    for (const [streamId, entry] of this.activeStreams) {
      if (entry.userId === userId) {
        entry.controller.abort();
        if (entry.runId) runtimeRunController.abort(entry.runId, 'Account disabled');
        chatLogger.info(`Aborted stream ${streamId} for disabled user ${userId}`);
      }
    }
    this.wsServer?.disconnectUser(userId, 'Account disabled');
  }

  /** 禁用组织时调用：断开该组织 WS 连接 + 中止活跃流。 */
  disconnectTenant(tenantId: string): void {
    for (const [streamId, entry] of this.activeStreams) {
      const record = entry.userId ? this.userStore?.findById(entry.userId) : undefined;
      if (record?.tenantId === tenantId) {
        entry.controller.abort();
        if (entry.runId) runtimeRunController.abort(entry.runId, 'Tenant disabled');
        chatLogger.info(`Aborted stream ${streamId} for disabled tenant ${tenantId}`);
      }
    }
    this.wsServer?.disconnectTenant(tenantId, 'Tenant disabled');
  }

  private tenantAccessErrorForClient(client: WsClient): string | null {
    const user = client.user;
    if (!user) return null;
    const record = this.userStore?.findById(user.sub);
    return tenantAccessErrorMessage(this.config.tenantStore, record?.tenantId || user.tenantId);
  }

  private findActiveStreamIdBySession(sessionId: string): string | undefined {
    for (const [streamId, entry] of this.activeStreams) {
      if (entry.sessionId === sessionId) return streamId;
    }
    return undefined;
  }
  private findActiveStreamByRunId(runId: string): { streamId: string; entry: ActiveStreamEntry } | undefined {
    for (const [streamId, entry] of this.activeStreams) {
      if (entry.runId === runId) return { streamId, entry };
    }
    return undefined;
  }

  /**
   * 查询指定会话是否有活跃的 Agent 流。
   *
   * 事实源选择：主查 durable PG `runStore.getActiveBySession()`（run 是否活着的唯一真相）;
   * `EventBufferStore` 只是内存传输缓存，进程重启/buffer 被 evict 都会丢，**不能**承担判活职责。
   * 仅当 runStore 不可用或异常时退化看 buffer 信号。
   *
   * 这是 2026-06-25 "切会话后看不到积压消息" 问题的根因之一：原实现只看 buffer.isActive,
   * buffer 在 chat 流结束后会 `complete` 但 PG run 仍可能 active（多 turn 场景）,导致 HTTP
   * 误报 inactive,前端连锁忽略 active_stream 兜底,刷新才能看到新消息。
   */
  async getStreamStatus(sessionId: string): Promise<{ active: boolean; streamId?: string; runId?: string; status?: string }> {
    try {
      const runStore = this.config.enqueueRuntime?.runStore;
      if (runStore?.getActiveBySession) {
        const activeRun = await runStore.getActiveBySession(sessionId);
        if (activeRun) {
          const streamId = this.findActiveStreamIdBySession(sessionId)
            ?? (typeof activeRun.metadata?.streamId === 'string' ? activeRun.metadata.streamId : undefined);
          return {
            active: true,
            ...(streamId ? { streamId } : {}),
            runId: activeRun.runId,
            status: activeRun.status,
          };
        }
        // runStore 明确说没在跑 → 即使 buffer 还 active 也按 runStore 为准
        return { active: false };
      }
    } catch (err) {
      chatLogger.warn(`[stream-status] runStore.getActiveBySession 异常,降级查 buffer: ${err instanceof Error ? err.message : String(err)}`);
    }
    // 兜底：runStore 不可用时退化看 buffer
    const active = this.eventBufferStore.isActive(sessionId);
    if (!active) return { active: false };
    const streamId = this.findActiveStreamIdBySession(sessionId);
    return { active: true, ...(streamId ? { streamId } : {}) };
  }
  private streamIdCounter = 0;
  private eventBufferStore = new EventBufferStore();

  /**
   * 消息幂等 LRU：以 `userId|client_msg_id` 为键，记录最近收到的 chat 请求。
   * 防止：1) WS 传输层重试重复 dispatch；2) 用户双击发送按钮。
   *
   * 大小上限 500，单条 TTL 60s；TTL 过后允许用户手动"重试"生成新 client_msg_id。
   */
  private idempotencyCache = new Map<string, { streamId: string; status: 'in_flight' | 'done' | 'failed'; at: number; sessionId?: string; runId?: string; deliveryMode?: 'queue' | 'steer'; queuedBehindRunId?: string; steeringTargetRunId?: string; terminalStatus?: 'completed' | 'failed' | 'cancelled' }>();
  private static readonly IDEMPOTENCY_MAX = 500;
  private static readonly IDEMPOTENCY_TTL_MS = 60_000;
  private idempotencyGet(userId: string | undefined, clientMsgId: string): { streamId: string; status: 'in_flight' | 'done' | 'failed'; sessionId?: string; runId?: string; deliveryMode?: 'queue' | 'steer'; queuedBehindRunId?: string; steeringTargetRunId?: string; terminalStatus?: 'completed' | 'failed' | 'cancelled' } | undefined {
    const key = `${userId ?? 'anon'}|${clientMsgId}`;
    const entry = this.idempotencyCache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.at > WebChannel.IDEMPOTENCY_TTL_MS) {
      this.idempotencyCache.delete(key);
      return undefined;
    }
    // LRU: 重新插入以刷新顺序
    this.idempotencyCache.delete(key);
    this.idempotencyCache.set(key, entry);
    return {
      streamId: entry.streamId,
      status: entry.status,
      ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
      ...(entry.runId ? { runId: entry.runId } : {}),
      ...(entry.deliveryMode ? { deliveryMode: entry.deliveryMode } : {}),
      ...(entry.queuedBehindRunId ? { queuedBehindRunId: entry.queuedBehindRunId } : {}),
      ...(entry.steeringTargetRunId ? { steeringTargetRunId: entry.steeringTargetRunId } : {}),
      ...(entry.terminalStatus ? { terminalStatus: entry.terminalStatus } : {}),
    };
  }
  private idempotencySet(
    userId: string | undefined,
    clientMsgId: string,
    status: 'in_flight' | 'done' | 'failed',
    streamId: string,
    meta: { sessionId?: string; runId?: string; deliveryMode?: 'queue' | 'steer'; queuedBehindRunId?: string; steeringTargetRunId?: string; terminalStatus?: 'completed' | 'failed' | 'cancelled' } = {},
  ): void {
    const key = `${userId ?? 'anon'}|${clientMsgId}`;
    this.idempotencyCache.set(key, {
      streamId,
      status,
      at: Date.now(),
      ...(meta.sessionId ? { sessionId: meta.sessionId } : {}),
      ...(meta.runId ? { runId: meta.runId } : {}),
      ...(meta.deliveryMode ? { deliveryMode: meta.deliveryMode } : {}),
      ...(meta.queuedBehindRunId ? { queuedBehindRunId: meta.queuedBehindRunId } : {}),
      ...(meta.steeringTargetRunId ? { steeringTargetRunId: meta.steeringTargetRunId } : {}),
      ...(meta.terminalStatus ? { terminalStatus: meta.terminalStatus } : {}),
    });
    // LRU 驱逐
    while (this.idempotencyCache.size > WebChannel.IDEMPOTENCY_MAX) {
      const firstKey = this.idempotencyCache.keys().next().value;
      if (firstKey === undefined) break;
      this.idempotencyCache.delete(firstKey);
    }
  }

  /** durable enqueue 成功后的接收确认；绝不把“仅通过基础校验”冒充 accepted。 */
  private sendChatAck(
    ws: WebSocket,
    clientMsgId: string,
    meta: {
      sessionId?: string;
      runId?: string;
      status?: 'accepted' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
      deliveryMode?: 'queue' | 'steer';
      queuePosition?: number;
    } = {},
  ): void {
    if (ws.readyState !== ws.OPEN) return;
    const data = { type: 'chat_ack' as const, client_msg_id: clientMsgId, server_recv_ts: Date.now(), ...meta };
    if (this.eventBus) this.eventBus.emitReply(ws, data);
    else this.wsSend(ws, data);
  }

  /** 发送消息拒绝（服务端决定不处理），客户端据此将 pending 气泡翻为 failed */
  private sendChatRejected(ws: WebSocket, clientMsgId: string, reasonCode: ChatRejectReasonCode, reason: string): void {
    if (ws.readyState !== ws.OPEN) return;
    const data = { type: 'chat_rejected' as const, client_msg_id: clientMsgId, reason_code: reasonCode, reason };
    if (this.eventBus) {
      this.eventBus.emitReply(ws, data);
    } else {
      this.wsSend(ws, data);
    }
    chatLogger.warn(`[chat_rejected] ${reasonCode}: ${reason} (client_msg_id=${clientMsgId})`);
  }

  /** 企业专家会话的后续动作统一重新鉴权，避免停用/取消指派后从特殊路径继续执行。 */
  private orgAgentActionAccessError(
    client: WsClient,
    orgAgentId: string | undefined,
    expectedTenantId?: string,
    assignedUsername?: string,
  ): string | null {
    if (!orgAgentId) return null;
    const record = this.config.orgAgentStore?.get(orgAgentId);
    const actor = client.user;
    const adminExempt = actor?.role === 'admin'
      && (isPlatformAdminUser(actor) || record?.tenantId === actor.tenantId);
    const tenantMatches = !!record && (expectedTenantId
      ? record.tenantId === expectedTenantId
      : (isPlatformAdminUser(actor) || record.tenantId === actor?.tenantId));
    const assigned = !!record && !!parseOrgAgentAudience(record.audience) && (adminExempt || isAssignedToOrgAgent(record, assignedUsername ?? actor?.username));
    return record && record.enabled && tenantMatches && assigned
      ? null
      : '该企业专家当前不可用，请联系组织管理员';
  }

  private resumeSubscriptions = new WeakMap<WebSocket, () => void>();
  /**
   * 按 ws 串行化 resume 处理链。handleResumeAsync 内部有 await（runStore.getActiveBySession），
   * 两条并发 resume（如前端重连时多个监听器各发一次）会在 await 处交错：都读到空的 prevUnsub，
   * 都 eventBufferStore.subscribe，第二个 resumeSubscriptions.set 覆盖第一个的退订句柄，第一个
   * EventBuffer listener 泄漏且无法退订 → 每个流式事件被投递两次（前端表现为逐字符重复）。
   * 串行化保证后一条 resume 一定读到前一条已注册的订阅并先退订，同一 ws 只保留一个 listener。
   */
  private resumeChains = new WeakMap<WebSocket, Promise<void>>();
  /**
   * 追踪每个 WS 连接当前绑定的 streamId。
   * 用于防止用户切换会话后，旧会话的 handleEvents 继续向同一 WS 直接推送事件。
   * 事件仍会写入 EventBuffer，用户切回时通过 resume + replay 获取。
   */
  private wsActiveStream = new WeakMap<WebSocket, string>();
  /**
   * WS → 当前查看会话的亲和映射（chat accept / resume 设置，detach 清除）。
   * 接管 stream_id 的补发必须限定在"用户仍查看该会话"的连接上：插话 queued 期间
   * 用户切去别的会话后，退化 run 的接管不应劫持新会话视图的流绑定。
   */
  private wsSessionAffinity = new WeakMap<WebSocket, string>();

  private handleActiveStreamSocketClose(
    streamId: string,
    ws: WebSocket,
    connectionAbortController: AbortController,
    activeInteractionIds: Set<string>,
  ): void {
    const entry = this.activeStreams.get(streamId);
    // 断线不删除 activeStreams：Agent 可能仍在跑，重连 resume 需要同一个 streamId。
    // 最终清理由 processChatMessage.finally 负责。
    if (entry && entry.ws === ws) {
      this.wsActiveStream.delete(ws);
    }
    connectionAbortController.abort();
    interactionStore.rejectOnDisconnect(activeInteractionIds, 'WebSocket connection closed');
  }

  /** per-session 串行锁：确保同一 session 的 Agent run 不会并发执行 */
  private sessionLocks = new Map<string, { promise: Promise<void>; createdAt: number }>();
  /** stale lock 清理定时器 */
  private lockCleanupTimer?: ReturnType<typeof setInterval>;

  /** stale lock 判定阈值（15 分钟） */
  private static readonly LOCK_STALE_MS = 15 * 60 * 1000;
  /** 清理扫描间隔（5 分钟） */
  private static readonly LOCK_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

  /** WS server instance（由 start() 创建） */
  private wsServer?: WsServer;
  /** 中央事件总线（由 start() 创建） */
  private eventBus?: EventBus;
  private readonly inProcessOutboundRuns = new Set<string>();
  /** 跨进程 durable stream batch 的逐 run 投影状态，用于终态全文补差而非重复展开。 */
  private readonly crossProcessStreamStates = new Map<string, RuntimeStreamProjectionState>();
  /**
   * 跨进程终态投影去重：runId → 已发过 terminal 投影。
   *
   * publishRuntimePlatformEvent 会先收到 `run_finished`、再收到由
   * `RunStoreBackedEventStore.afterAppend` 派生的 `run_state_changed`，
   * 两者都可能投影出 `done`+`session_status`。无去重的话前端会收到两次 done
   * 与两次 session_status,导致 setLoading 重复触发、消息列表渲染抖动。
   *
   * 用 runId 做 dedupe key；首个 terminal 投影 add，后续 short-circuit。
   * 每个 run 只 terminate 一次,Set 长期增长上限 ≈ 历史 run 总数,可接受。
   */
  private readonly crossProcessTerminalRuns = new Set<string>();

  constructor(
    private readonly config: WebChannelConfig,
    private dispatch: AgentRunDispatch,
  ) {
    this.displayConfig = getWebDisplayConfig(config.displayConfig);
    this.modelResolver = config.modelResolver;
    this.userStore = config.userStore;
    // 定期清理 stale session locks，防止异常路径导致的 Map 泄漏
    this.lockCleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.sessionLocks) {
        if (now - entry.createdAt > WebChannel.LOCK_STALE_MS) {
          chatLogger.warn(`Cleaning stale session lock: ${key} (age: ${Math.round((now - entry.createdAt) / 1000)}s)`);
          this.sessionLocks.delete(key);
        }
      }
    }, WebChannel.LOCK_CLEANUP_INTERVAL_MS);
    this.lockCleanupTimer.unref();
  }

  /** 创建 WS server 并注册消息处理器 */
  async start(app: Express): Promise<void> {
    // 创建 WS server（noServer 模式，需要在 index.ts 中调用 attachToServer）
    this.wsServer = new WsServer({
      jwtSecret: this.config.jwtSecret,
      userStore: this.userStore,
      tenantStore: this.config.tenantStore,
      allowedOrigins: this.config.allowedOrigins,
    });

    // 创建 EventBus（所有 WS 下行事件的唯一出口）
    this.eventBus = new EventBus({
      eventBufferStore: this.eventBufferStore,
      userEventLog: this.wsServer.userEventLog,
      getClientsByUser: (userId) => this.wsServer!.getClientsByUser(userId),
      getAdminUserIds: () => {
        if (!this.userStore) return [];
        return this.userStore.listAll().filter(u => u.role === 'admin').map(u => u.id);
      },
      sendTo: (ws, envelope) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify(envelope));
        }
      },
      isActiveStream: (ws, streamId) => this.wsActiveStream.get(ws) === streamId,
    });

    // 注册 WS 消息路由
    this.wsServer.onMessage((client, msg) => {
      switch (msg.action) {
        case 'chat':
          this.handleChat(client, msg);
          break;
        case 'respond':
          this.handleRespond(client, msg);
          break;
        case 'abort':
          this.handleAbort(client, msg);
          break;
        case 'cancel_queued':
          void this.handleCancelQueued(client, msg).catch((err) => {
            chatLogger.error(`[chat] cancel_queued failed: ${err instanceof Error ? err.message : String(err)}`);
            this.wsSend(client.ws, { type: 'cancel_queued_result', ok: false, sourceRunId: msg.sourceRunId, reason: 'error' });
          });
          break;
        case 'approval_policy':
          void this.handleApprovalPolicy(client, msg);
          break;
        case 'run_status':
          void this.handleRunStatus(client, msg);
          break;
        case 'resume':
          this.handleResume(client, msg);
          break;
        case 'detach':
          this.handleDetach(client);
          break;
        case 'sync':
          this.handleSync(client, msg);
          break;
        default:
          this.wsSend(client.ws, { type: 'error', message: `Unknown action: ${(msg as any).action}` });
      }
    });

    // WS 断开时清理关联的 pending 交互
    this.wsServer.onClose((client) => {
      // 找到此 WS 连接关联的所有 active streams，abort 连接级 controller
      for (const [streamId, entry] of this.activeStreams) {
        if (entry.ws === client.ws) {
          // 不触发 userAbortController（Agent 继续运行），仅标记连接断开
          // interactionStore 的清理由 connectionAbortController 在 handleChat 中处理
        }
      }
    });

    // Express 路由保留：respond / abort / pending interactions 仍走 HTTP（兼容性）
    // 但主要通过 WS 处理，HTTP 端点可在后续版本移除
  }

  /** 将 WS server 绑定到 HTTP server（在 app.listen() 之后调用） */
  attachToServer(httpServer: import('http').Server): void {
    if (!this.wsServer) {
      throw new Error('WsServer not initialized. Call start() first.');
    }
    this.wsServer.attach(httpServer);
    chatLogger.info('WebSocket server attached to HTTP server');
  }

  /** 获取 WS server 实例（供外部使用） */
  getWsServer(): WsServer | undefined {
    return this.wsServer;
  }

  /** 获取 EventBus 实例（供 routes / runtime 等外部模块使用） */
  getEventBus(): EventBus | undefined {
    return this.eventBus;
  }

  /**
   * Scheduler/wake 后台执行路径的 Web stream bridge。
   *
   * enqueue-only 模式下 WebChannel 不再持有 dispatch generator；RuntimeScheduler
   * 通过 wakeRuntimeSession 的 onOutboundEvent 回调把 OutboundEvent 送到这里。
   * 本方法把事件投递到 EventBuffer/UserEventLog：当前 WS 仍连接则直推，否则
   * 用户重连时可通过 resume 从 EventBuffer 回放短期流。
   */
  publishRuntimeOutboundEvent(input: {
    sessionId: string;
    runId: string;
    streamId?: string;
    userId?: string;
    clientMsgId?: string;
    event: OutboundEvent;
  }): void {
    if (!this.eventBus) {
      chatLogger.warn(`Runtime outbound event dropped before WebChannel start: session=${input.sessionId} run=${input.runId} type=${input.event.type}`);
      return;
    }
    const streamId = input.streamId ?? input.runId;
    this.inProcessOutboundRuns.add(input.runId);
    const activeEntry = this.activeStreams.get(streamId);
    const userRecord = this.userStore?.findById(input.userId ?? activeEntry?.userId ?? '');
    const ws = activeEntry?.ws ?? ({ readyState: 3, OPEN: 1 } as unknown as WebSocket);
    const sessionCtx: SessionContext = {
      sessionId: input.sessionId,
      streamId,
      ws,
      userId: input.userId,
    };
    const emitSession = (data: object) => this.eventBus!.emitSession(sessionCtx, data);

    switch (input.event.type) {
      case 'session_init':
        // 接管补发：仅当该连接仍查看此会话（affinity）且未绑定其他流时。
        // 插话 queued 期间用户切走（detach 清 affinity）时不得劫持新视图的流绑定。
        if (
          activeEntry
          && !this.wsActiveStream.has(activeEntry.ws)
          && this.wsSessionAffinity.get(activeEntry.ws) === input.sessionId
        ) {
          this.wsActiveStream.set(activeEntry.ws, streamId);
          this.eventBus.emitReply(activeEntry.ws, {
            type: 'stream_id',
            streamId,
            sessionId: input.sessionId,
            runId: input.runId,
            client_msg_id: activeEntry.clientMsgId,
          });
        }
        this.eventBufferStore.create(input.sessionId, input.userId);
        emitSession({ type: 'session', sessionId: input.event.sessionId ?? input.sessionId, ...(input.clientMsgId ? { client_msg_id: input.clientMsgId } : {}) });
        if (input.userId) {
          // 后台 Runtime 没有浏览器发起连接；必须像 enqueue-only 路径一样广播
          // stream_started，让正在查看该会话的 Web 页面主动 resume EventBuffer。
          // 否则 ask_user 等 session scope 事件只会留在 buffer，直到切会话或刷新才恢复。
          this.eventBus.emitUser(input.userId, {
            type: 'stream_started',
            sessionId: input.sessionId,
            streamId,
            runId: input.runId,
          }, activeEntry?.ws);
          this.eventBus.emitUser(input.userId, {
            type: 'session_status',
            sessionId: input.sessionId,
            status: 'running',
            streamId,
            runId: input.runId,
          });
        }
        break;
      case 'interjection_applied': {
        const sourceRunIds = input.event.sourceRunIds ?? [];
        const clientMsgIds = input.event.clientMsgIds ?? [];
        emitSession({ type: 'interjection_applied', sourceRunIds, clientMsgIds });
        for (const [sourceStreamId, sourceEntry] of this.activeStreams) {
          if (!sourceEntry.runId || !sourceRunIds.includes(sourceEntry.runId)) continue;
          this.activeStreams.delete(sourceStreamId);
          if (sourceEntry.clientMsgId) {
            this.idempotencySet(
              sourceEntry.userId,
              sourceEntry.clientMsgId,
              'done',
              sourceStreamId,
              { sessionId: sourceEntry.sessionId, runId: sourceEntry.runId },
            );
          }
        }
        break;
      }
      case 'text_start':
        emitSession({
          type: 'block_start',
          blockType: 'text',
          runId: input.runId,
          ...(input.event.draftId ? { draftId: input.event.draftId } : {}),
        });
        break;
      case 'text_delta':
        emitSession({ type: 'text', content: input.event.content ?? '' });
        break;
      case 'text_end':
        emitSession({ type: 'block_end', blockType: 'text' });
        break;
      case 'thinking_start':
        emitSession({
          type: 'block_start',
          blockType: 'thinking',
          ...(input.event.draftId ? { draftId: input.event.draftId } : {}),
        });
        break;
      case 'thinking_delta':
        emitSession({ type: 'thinking', content: input.event.content ?? '' });
        break;
      case 'thinking_end':
        emitSession({ type: 'block_end', blockType: 'thinking' });
        break;
      case 'draft_reset':
        if (input.event.draftId) {
          emitSession({
            type: 'draft_reset',
            draftId: input.event.draftId,
            ...(input.event.attempt !== undefined ? { attempt: input.event.attempt } : {}),
          });
        }
        break;
      case 'draft_commit':
        if (input.event.draftId) {
          emitSession({ type: 'draft_commit', draftId: input.event.draftId });
        }
        break;
      case 'tool_start':
        if (isDedicatedWebTool(input.event.toolName)) break;
        emitSession({
          type: 'block_start',
          blockType: 'tool_use',
          toolId: input.event.toolId,
          toolName: input.event.toolName, runId: input.runId,
        });
        break;
      case 'tool_input_delta':
        if (isDedicatedWebTool(input.event.toolName)) break;
        emitSession({
          type: 'tool_input',
          toolId: input.event.toolId,
          toolName: input.event.toolName,
          content: input.event.partialJson ?? '',
        });
        break;
      case 'tool_end':
        if (isDedicatedWebTool(input.event.toolName)) break;
        emitSession({
          type: 'block_end',
          blockType: 'tool_use',
          toolName: input.event.toolName,
        });
        break;
      case 'tool_execution_start':
        if (isDedicatedWebTool(input.event.toolName)) break;
        emitSession({
          type: 'tool_execution',
          phase: 'started',
          toolId: input.event.toolId,
          toolName: input.event.toolName,
          invocationId: input.event.invocationId,
        });
        break;
      case 'tool_execution_end':
        if (isDedicatedWebTool(input.event.toolName)) break;
        emitSession({
          type: 'tool_execution',
          phase: 'completed',
          toolId: input.event.toolId,
          toolName: input.event.toolName,
          invocationId: input.event.invocationId,
          status: input.event.status,
          durationMs: input.event.durationMs,
          error: input.event.error,
        });
        break;
      case 'tool_result': {
        const artifactDelivery = projectArtifactDelivery(input.event.toolName, input.event.toolResultMetadata, input.event.toolResult);
        if (artifactDelivery) emitSession(artifactDelivery);
        if (isDedicatedWebTool(input.event.toolName)) break;
        emitSession({
          type: 'tool_result',
          toolId: input.event.toolId,
          toolName: input.event.toolName,
          result: input.event.toolResult ?? '',
          content: input.event.toolResult ?? '',
          ...(input.event.isError ? { isError: true } : {}),
          // 与历史加载同源的摘要与执行事实：实时观看的工具行不用等刷新才有徽标。
          // presentation 自带 200 行 detail 上限，不会把全量 stdout 塞进 WS
          ...(input.event.toolPresentation ? { presentation: input.event.toolPresentation } : {}),
          ...(input.event.toolResultMetadata ? { metadata: input.event.toolResultMetadata } : {}),
        });
        break;
      }
      case 'context_usage':
        if (input.event.contextUsage) {
          emitSession({
            type: 'context_usage',
            contextUsage: canViewContextUsageDetailsForUser(userRecord, this.config.tenantStore)
              ? input.event.contextUsage
              : redactContextUsageDetails(input.event.contextUsage),
          });
        }
        break;
      case 'permission_request':
      case 'ask_user':
        if (input.userId) {
          void this.markSessionUnread({
            userId: input.userId,
            sessionId: input.sessionId,
            eventKey: `interaction:${input.event.interactionId}`,
          });
        }
        emitSession({
          type: input.event.type,
          interactionId: input.event.interactionId,
          toolId: input.event.toolId,
          toolName: input.event.toolName,
          displayName: input.event.displayName,
          toolInput: input.event.toolInput,
          questions: input.event.questions,
        });
        break;
      // /compact v2：压缩过程黑箱——开始/结束各一条状态消息，无流式内容
      case 'compaction_start':
        emitSession({ type: 'compaction_status', phase: 'started' });
        break;
      case 'compaction_end':
        emitSession({
          type: 'compaction_status',
          phase: 'completed',
          compaction: input.event.compaction,
        });
        break;
      case 'done':
        emitSession({
          type: 'done',
          sessionId: input.sessionId,
          streamId,
          runId: input.runId,
          client_msg_id: input.clientMsgId,
          finalOutput: true,
        });
        const hasDeferredStream = Array.from(this.activeStreams.entries()).some(
          ([candidateStreamId, entry]) => (
            candidateStreamId !== streamId && entry.sessionId === input.sessionId
          ),
        );
        if (!hasDeferredStream) this.eventBufferStore.complete(input.sessionId);
        this.activeStreams.delete(streamId);
        if (activeEntry?.ws && this.wsActiveStream.get(activeEntry.ws) === streamId) {
          this.wsActiveStream.delete(activeEntry.ws);
        }
        this.inProcessOutboundRuns.delete(input.runId);
        if (input.userId) {
          if (!input.event.error) void this.markSessionUnread({
            userId: input.userId,
            sessionId: input.sessionId,
            eventKey: `done:${input.runId}`,
          });
          this.eventBus.emitUser(input.userId, {
            type: 'session_status',
            sessionId: input.sessionId,
            status: 'completed',
            streamId,
            runId: input.runId,
          });
          this.eventBus.emitDual(input.userId, input.sessionId, {
            type: 'session_updated',
            sessionId: input.sessionId,
            updatedAtMs: Date.now(),
          });
          // enqueue-only 路径绕过 handleEvents()，终态统一尝试补齐标题。
          // 会话级 in-flight 去重与 meta 守卫会吸收同进程/跨进程的重复触发。
          void this.maybeGenerateTitleByUserId(input.sessionId, input.userId, '', true);
        }
        clearSessionsListCache();
        break;
      case 'error':
        emitSession({
          type: 'done',
          sessionId: input.sessionId,
          streamId,
          runId: input.runId,
          client_msg_id: input.clientMsgId,
          error: input.event.error, ...(input.event.failureKind ? { failureKind: input.event.failureKind } : {}), ...(input.event.recoveryAction ? { recoveryAction: input.event.recoveryAction } : {}),
        });
        const hasDeferredErrorStream = Array.from(this.activeStreams.entries()).some(
          ([candidateStreamId, entry]) => (
            candidateStreamId !== streamId && entry.sessionId === input.sessionId
          ),
        );
        if (!hasDeferredErrorStream) this.eventBufferStore.complete(input.sessionId);
        this.activeStreams.delete(streamId);
        if (activeEntry?.ws && this.wsActiveStream.get(activeEntry.ws) === streamId) {
          this.wsActiveStream.delete(activeEntry.ws);
        }
        this.inProcessOutboundRuns.delete(input.runId);
        if (input.userId) {
          // 与 PG 桥接路径（publishRuntimePlatformEvent → run_state_changed{failed}）行为对齐:
          // 推 status='failed' + reason,而不是 idle 无 reason。前端只需识别一条失败分支。
          this.eventBus.emitUser(input.userId, {
            type: 'session_status',
            sessionId: input.sessionId,
            status: 'failed',
            streamId,
            runId: input.runId,
            reason: input.event.error, ...(input.event.failureKind ? { failureKind: input.event.failureKind } : {}), ...(input.event.recoveryAction ? { recoveryAction: input.event.recoveryAction } : {}),
          });
          // error 不一定还会补发 done；直接在失败终态补偿命名。
          void this.maybeGenerateTitleByUserId(input.sessionId, input.userId, '', true);
        }
        clearSessionsListCache();
        break;
      default:
        break;
    }
  }

  /**
   * Cross-process runtime event bridge entrypoint.
   *
   * PG EventStore LISTEN/NOTIFY delivers durable PlatformEvents to every web
   * process. We project the subset that is useful for live/reconnect UI into
   * the same EventBuffer/UserEventLog path used by in-process scheduler output.
   */
  publishRuntimePlatformEvent(event: PlatformEvent): void {
    if (!this.eventBus) return;
    if (event.type === 'session_group_changed') {
      clearSessionsListCache();
      // Cron 会话由 Worker 后台创建，Web 端通常还没有本地列表项；isNew 让客户端
      // 主动刷新会话列表，groups_changed 则在分组落盘后刷新成员关系。
      this.eventBus.emitDual(event.userId, event.sessionId, {
        type: 'session_updated',
        sessionId: event.sessionId,
        updatedAtMs: Date.now(),
        isNew: true,
      });
      this.eventBus.emitUser(event.userId, { type: 'groups_changed' });
      return;
    }
    if (event.type === 'session_read_state_changed') {
      clearSessionsListCache();
      this.eventBus.emitUser(event.userId, {
        type: 'session_read_state_changed',
        sessionId: event.sessionId,
        hasUnreadAiReply: event.hasUnreadAiReply,
      });
      return;
    }
    if (event.type === 'interaction_requested' && event.userId && event.sessionId) {
      void this.markSessionUnread({
        userId: event.userId,
        sessionId: event.sessionId,
        eventKey: `interaction:${event.interactionId}`,
        broadcastEvenIfUnchanged: true,
      });
    }
    const sessionId = event.sessionId;
    if (!sessionId) return;
    if (event.type === 'interjection_applied') {
      // 插话吸收信号（2026-08-04 BUG-2 修复）：先做本地清理（web 进程持有插话
      // source 的 activeStreams/幂等缓存；worker 进程此处天然 no-op），幂等可重入。
      for (const [sourceStreamId, sourceEntry] of this.activeStreams) {
        if (!sourceEntry.runId || !event.sourceRunIds.includes(sourceEntry.runId)) continue;
        this.activeStreams.delete(sourceStreamId);
        if (sourceEntry.clientMsgId) {
          this.idempotencySet(sourceEntry.userId, sourceEntry.clientMsgId, 'done', sourceStreamId, {
            sessionId: sourceEntry.sessionId,
            runId: sourceEntry.runId,
          });
        }
      }
      // in-process run 的前端通知已由 yield 路径（handleRuntimeEvent）emitSession，
      // 这里 return 防止 buffer 双写；跨进程（ws-only 收 NOTIFY）继续走通用投影推送。
      if (this.inProcessOutboundRuns.has(event.runId)) return;
    }
    const runId = 'runId' in event ? event.runId : undefined;
    if (runId && this.inProcessOutboundRuns.has(runId) && ![
      'assistant_tool_calls',
      'approval_requested',
      'tool_invocation_started',
      'tool_invocation_completed',
      'tool_output_delta',
      'tool_progress',
      // 子 agent 生命周期（2026-07-06）：runner 不向父 outbound 流 yield 任何子事件，
      // SubagentBlock 的唯一数据通路就是 durable PlatformEvent → NOTIFY → 本投影，
      // 因此 in-process run 也必须放行这两类。
      'subagent_started',
      'subagent_finished',
      // 插话 user_message（2026-08-04）：loop 不 yield 用户消息，被吸收的插话进时间线
      // 只能靠本投影（单进程与跨进程同理）；普通 user_message 在投影函数内已被过滤。
      'user_message',
    ].includes(event.type)) return;
    const active = runId ? this.findActiveStreamByRunId(runId) : undefined;
    const streamId = active?.streamId ?? (runId ? runId : undefined);
    const activeEntry = active?.entry ?? (streamId ? this.activeStreams.get(streamId) : undefined);
    // 跨进程接管兜底：steering 插话 accept 时不绑定 wsActiveStream（queued 语义）。
    // 它退化为独立 run 后若被另一进程（standby/scheduler-only）的 scheduler wake，
    // 本进程（ws 所在）只收到 PG NOTIFY 投影，同进程 session_init 的接管分支不会执行；
    // 不在这里补绑定 + 补发 stream_id 的话，整条流都会被 wsActiveStream 门控丢掉。
    // 每个投影事件都重试一次：目标 run 的终态投影与退化 run 的首个事件乱序到达时，
    // 靠后续事件自愈（期间漏推的内容已写 EventBuffer，可经 resume 回放）。
    // 仅在用户仍查看该会话（affinity）且连接未绑定任何流时接管——绑定到目标 run
    // 期间绝不抢绑，等其终态投影释放后由退化 run 的后续事件补绑。
    if (
      activeEntry?.ws
      && activeEntry.ws.readyState === activeEntry.ws.OPEN
      && streamId
      && !this.wsActiveStream.has(activeEntry.ws)
      && this.wsSessionAffinity.get(activeEntry.ws) === sessionId
    ) {
      this.wsActiveStream.set(activeEntry.ws, streamId);
      this.eventBus.emitReply(activeEntry.ws, {
        type: 'stream_id',
        streamId,
        sessionId,
        ...(runId ? { runId } : {}),
        ...(activeEntry.clientMsgId ? { client_msg_id: activeEntry.clientMsgId } : {}),
      });
    }
    const projection = projectRuntimePlatformEvent(event, {
      clientMsgId: activeEntry?.clientMsgId,
      // 同进程 run 的 live 内容已由直推（publishRuntimeOutboundEvent）送达，聚合行
      // 不展开防重复；跨进程 durable batch 则由 streamStates 做前缀补差。
      expandStreamed: !(runId && this.inProcessOutboundRuns.has(runId)),
      streamStates: this.crossProcessStreamStates,
    });
    // 空投影且非终态的背景事件（如 hand_health_changed / hand_provisioning_log）直接跳过:
    // 不允许它们为已结束的会话 create 一个永不 complete 的 active buffer。
    // 否则 WS resume 判活会把该会话误报成 running(前端永久"正在思考"/停止按钮,刷新无效)。
    // 实证: 2026-07-02 会话 3adc25a5 服务重启后被 ACS sandbox 健康探测事件复活。
    if (projection.events.length === 0 && !projection.terminal) return;
    const buffer = this.eventBufferStore.get(sessionId);
    if (!buffer || (!buffer.completed && !buffer.userId)) this.eventBufferStore.create(sessionId, activeEntry?.userId ?? ('userId' in event && typeof event.userId === 'string' ? event.userId : undefined));
    // 终态投影跨事件去重：run_finished{error} 与 RunStore 派生的 run_state_changed{failed}
    // 来自同一个 runId 且都会 terminal=true，第二次到达直接 return 避免给前端发两次 done /
    // session_status。注意必须在 events push 之前判断,否则 buffer 仍会被脏写。
    if (projection.terminal && runId) {
      if (this.crossProcessTerminalRuns.has(runId)) return;
      this.crossProcessTerminalRuns.add(runId);
    }
    const eventCursor = getDurableEventCursor(event);
    for (const [index, data] of projection.events.entries()) {
      // A durable PlatformEvent is the atomic resume unit. Advancing its cursor on an
      // earlier projected frame could make a reconnect skip the remaining frames (most
      // importantly a terminal done), so only the final frame may carry the cursor.
      const frameCursor = index === projection.events.length - 1 ? eventCursor : undefined;
      const eventId = this.eventBufferStore.push(sessionId, JSON.stringify(data), frameCursor);
      const ws = activeEntry?.ws;
      if (ws && ws.readyState === ws.OPEN && streamId && this.wsActiveStream.get(ws) === streamId) {
        this.wsSend(ws, data, eventId ?? undefined, frameCursor);
      }
    }
    // EventBuffer 入库后触发 resume，避免跨进程交互只在刷新时出现。
    notifyCrossProcessInteractionResume(event, sessionId, activeEntry?.userId, this.inProcessOutboundRuns, (userId, data) => this.eventBus?.emitUser(userId, data));
    if (projection.terminal) {
      const hasDeferredStream = Array.from(this.activeStreams.entries()).some(
        ([candidateStreamId, entry]) => (
          candidateStreamId !== streamId && entry.sessionId === sessionId
        ),
      );
      if (!hasDeferredStream) this.eventBufferStore.complete(sessionId);
      if (streamId) this.activeStreams.delete(streamId);
      if (activeEntry?.ws && this.wsActiveStream.get(activeEntry.ws) === streamId) {
        this.wsActiveStream.delete(activeEntry.ws);
      }
      if (runId) {
        this.inProcessOutboundRuns.delete(runId);
        this.crossProcessStreamStates.delete(runId);
      }
      if (activeEntry?.clientMsgId) {
        this.idempotencySet(
          activeEntry.userId,
          activeEntry.clientMsgId,
          projection.sessionStatus === 'failed' ? 'failed' : 'done',
          streamId ?? '',
          {
            sessionId,
            ...(runId ? { runId } : {}),
            terminalStatus: projection.sessionStatus === 'cancelled'
              ? 'cancelled'
              : projection.sessionStatus === 'failed'
                ? 'failed'
                : 'completed',
          },
        );
      }
      if (activeEntry?.userId && projection.sessionStatus) {
        this.eventBus.emitUser(activeEntry.userId, {
          type: 'session_status',
          sessionId,
          status: projection.sessionStatus,
          ...(streamId ? { streamId } : {}),
          ...(runId ? { runId } : {}),
          ...(projection.terminalError ? { reason: projection.terminalError } : {}),
        });
      }
      clearSessionsListCache();
      // 自动命名跨进程兜底：ws-only 进程收到 scheduler-only 进程产生的
      // durable 终态后，从 RunStore 反查 owner 并补齐标题。
      if (runId && projection.sessionStatus === 'completed') {
        const runStore = this.config.enqueueRuntime?.runStore;
        if (runStore) {
          void runStore.get(runId).then((record) => {
            if (record?.userId) return this.markSessionUnread({
              userId: record.userId,
              sessionId,
              eventKey: `done:${runId}`,
              broadcastEvenIfUnchanged: true,
            });
          }).catch((err) => {
            chatLogger.warn(`unread cross-process hook failed run=${runId}:`, err);
          });
        }
      }
      // 所有 durable 终态都尝试补齐标题，包括 failed/cancelled/orphaned。
      // 会话级 in-flight 与 meta 守卫会吸收同进程 done 的重复触发。
      if (runId && projection.sessionStatus) {
        const runStore = this.config.enqueueRuntime?.runStore;
        if (runStore) {
          void runStore.get(runId).then((record) => {
            if (!record?.userId) return;
            return this.maybeGenerateTitleByUserId(sessionId, record.userId, '', true);
          }).catch((err) => {
            chatLogger.warn(`title cross-process hook failed run=${runId}:`, err);
          });
        }
      }
    }
  }
  // ── WS 辅助方法 ──────────────────────────────────────

  private wsSend(ws: WebSocket, data: object, eventId?: number, eventCursor?: string): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({
        ...(eventId !== undefined ? { eventId } : {}),
        ...(eventCursor ? { eventCursor } : {}),
        data,
      }));
    }
  }

  // ── 消息处理器 ──────────────────────────────────────

  /** 处理 chat 消息（替代 POST /api/chat） */
  private handleChat(client: WsClient, msg: WsChatMessage): void {
    const previousWs = this.chatProcessingTails.get(client.ws) ?? Promise.resolve();
    const clientMsgId = msg.client_msg_id?.trim();
    const submissionKey = clientMsgId
      ? `${client.user?.tenantId ?? 'tenant'}|${client.user?.sub ?? 'anon'}|${clientMsgId}`
      : undefined;
    const previousSubmission = submissionKey
      ? this.submissionProcessingTails.get(submissionKey)
      : undefined;
    const dependencies = previousSubmission && previousSubmission !== previousWs
      ? [previousWs, previousSubmission]
      : [previousWs];
    const next = Promise.all(dependencies.map((dependency) => dependency.catch(() => undefined)))
      .then(() => this.processChatMessage(client, msg));
    this.chatProcessingTails.set(client.ws, next);
    if (submissionKey) this.submissionProcessingTails.set(submissionKey, next);
    const cleanup = () => {
      if (this.chatProcessingTails.get(client.ws) === next) {
        this.chatProcessingTails.delete(client.ws);
      }
      if (submissionKey && this.submissionProcessingTails.get(submissionKey) === next) {
        this.submissionProcessingTails.delete(submissionKey);
      }
    };
    void next.then(cleanup, (error) => {
      chatLogger.error(`[chat] 消息接收入队失败: ${error instanceof Error ? error.message : String(error)}`);
      cleanup();
    });
  }

  /** 处理 respond 消息（替代 POST /api/chat/respond） */
  private handleRespond(client: WsClient, msg: WsRespondMessage): void {
    const { interactionId, sessionId, action: _, ...response } = msg;
    if (!interactionId) {
      this.wsSend(client.ws, { type: 'respond_error', interactionId: '', error: 'interactionId is required' });
      return;
    }
    const tenantAccessError = this.tenantAccessErrorForClient(client);
    if (tenantAccessError) {
      this.wsSend(client.ws, { type: 'respond_error', interactionId, error: tenantAccessError });
      return;
    }

    // 会话归属校验（fail-closed：无法验证时拒绝）
    if (client.user && client.user.role !== 'admin') {
      // 优先使用 interactionStore 中存储的 userId 做归属校验（创建时记录，无 TOCTOU 风险）
      const storedUserId = interactionStore.getUserId(interactionId);
      if (storedUserId && storedUserId !== client.user.sub) {
        this.wsSend(client.ws, { type: 'respond_error', interactionId, error: 'Access denied' });
        return;
      }
      // storedUserId 匹配或未设置（兼容旧 interaction）时放行
    }

    void this.resolveInteraction(client, interactionId, response, typeof sessionId === 'string' ? sessionId : undefined);
  }

  private async resolveInteraction(
    client: WsClient,
    interactionId: string,
    response: Record<string, unknown>,
    fallbackSessionId?: string,
  ): Promise<void> {
    // 在 resolve 之前获取 sessionId（resolve 会删除 entry）
    const pendingInteraction = interactionStore.get(interactionId);
    const sessionId = pendingInteraction?.sessionId ?? interactionStore.getSessionId(interactionId);
    const orgAgentAccessError = this.orgAgentActionAccessError(client, pendingInteraction?.orgAgentId);
    if (orgAgentAccessError) {
      this.wsSend(client.ws, { type: 'respond_error', interactionId, error: orgAgentAccessError });
      return;
    }
    if (
      pendingInteraction?.type === 'permission_request'
      && pendingInteraction.runId
      && this.config.enqueueRuntime?.runStore
    ) {
      const sourceRun = await this.config.enqueueRuntime.runStore.get(pendingInteraction.runId);
      if (!sourceRun || TERMINAL_RUN_STATUSES.has(sourceRun.status)) {
        const reason = `源 run 不可恢复（${sourceRun?.status ?? 'missing'}），拒绝遗留审批`;
        const closed = await this.tryResumePersistedInteraction(client, interactionId, { allow: false }, sessionId);
        interactionStore.discard(interactionId, reason);
        if (!closed) {
          this.wsSend(client.ws, { type: 'respond_error', interactionId, error: '终态 Run 的遗留审批关闭失败' });
        }
        return;
      }
    }
    const resolved = interactionStore.resolve(interactionId, response);
    if (!resolved) {
      const resumed = await this.tryResumePersistedInteraction(client, interactionId, response, fallbackSessionId);
      if (!resumed) {
        this.wsSend(client.ws, { type: 'respond_error', interactionId, error: 'Interaction not found or expired' });
      }
      return;
    }
    if (sessionId && pendingInteraction) {
      await this.appendDurableWebCommand(sessionId, {
        type: 'interaction_resolved',
        sessionId,
        ...(pendingInteraction.runId ? { runId: pendingInteraction.runId } : {}),
        ...(pendingInteraction.toolCallId ? { toolCallId: pendingInteraction.toolCallId } : {}),
        ...(pendingInteraction.invocationId ? { invocationId: pendingInteraction.invocationId } : {}),
        interactionId,
        interactionType: pendingInteraction.type,
        userId: client.user?.sub,
        response: normalizeInteractionResponse(response),
      });
    }
    this.wsSend(client.ws, { type: 'respond_ok', interactionId });

    // 广播到同用户其他连接，让它们关闭弹窗
    if (sessionId && this.eventBus) {
      for (const [, entry] of this.activeStreams) {
        if (entry.sessionId === sessionId && entry.userId) {
          this.eventBus!.emitUser(entry.userId, {
            type: 'interaction_resolved',
            sessionId,
            interactionId,
          }, client.ws);
          break;
        }
      }
    }
  }

  private async tryResumePersistedInteraction(
    client: WsClient,
    interactionId: string,
    response: Record<string, unknown>,
    sessionId?: string,
  ): Promise<boolean> {
    if (!sessionId) return false;
    const transcriptPath = this.config.agentCwd ? await findTranscriptOrMetaPathBySessionId(sessionId) : null;
    if (!transcriptPath && !this.config.runtimeEventStoreSupportsPathless) return false;
    // 跨 session 并发兜底：限制同时进入的 jsonl 读路径并发数，遏制 EMFILE 突发。
    // 仅保护读路径（list + buildRuntimeReplayState）；dispatch 流不持锁。
    const release = await approvalResumeSemaphore.acquire();
    let eventStore: EventStore;
    let approvalStore: EventBackedApprovalStore;
    let existingEvents: PlatformEvent[];
    let pendingApprovalRunId: string | undefined;
    let pendingAskUser: ReturnType<typeof buildPendingInteractionsFromEvents>[number] | undefined;
    let hasPendingApproval: boolean;
    try {
      eventStore = this.config.runtimeEventStoreFor
        ? this.config.runtimeEventStoreFor(transcriptPath ?? '') : new FileEventStore(getRuntimeEventLogPath(transcriptPath!));
      approvalStore = new EventBackedApprovalStore(eventStore, sessionId);
      existingEvents = await eventStore.list(sessionId);
      const replayState = buildRuntimeReplayState(
        existingEvents,
        await approvalStore.list(sessionId),
        sessionId,
      );
      const pendingState = replayState.pendingApprovals.find(
        (state) => state.approval?.id === interactionId,
      );
      hasPendingApproval = Boolean(pendingState);
      pendingApprovalRunId = pendingState?.approval?.runId;
      pendingAskUser = buildPendingInteractionsFromEvents(existingEvents, sessionId)
        .find((interaction) => interaction.type === 'ask_user' && interaction.interactionId === interactionId);
    } finally {
      release();
    }
    if (!hasPendingApproval && !pendingAskUser) return false;
    const meta = transcriptPath ? (await readSessionMeta(transcriptPath) ?? undefined) : undefined;
    const enqueueRuntime = this.config.enqueueRuntime?.enabled === false ? undefined : this.config.enqueueRuntime;
    const sourceRunId = pendingApprovalRunId ?? pendingAskUser?.runId;
    const sourceRun = sourceRunId && enqueueRuntime ? await enqueueRuntime.runStore.get(sourceRunId) : null;
    if (sourceRun?.tenantId) approvalStore = new EventBackedApprovalStore(eventStore, sessionId, sourceRun.tenantId);
    const accessError = persistedInteractionAccessError({
      sessionId, user: client.user,
      meta,
      sourceRun,
      tenantStore: this.config.tenantStore,
      orgAgentAccessError: (orgAgentId, tenantId, username) => this.orgAgentActionAccessError(client, orgAgentId, tenantId, username),
    });
    if (accessError) {
      this.wsSend(client.ws, { type: 'respond_error', interactionId, error: accessError });
      return true;
    }
    const userRecord = client.user ? this.userStore?.findById(client.user.sub) : undefined;
    const userIdentity: ChannelContext['user'] | undefined = client.user ? {
      id: client.user.sub,
      username: client.user.username,
      role: client.user.role,
      tenantId: userRecord?.tenantId || client.user.tenantId,
      ...(userRecord?.realName ? { realName: userRecord.realName } : {}),
      ...(userRecord?.dingtalkStaffId ? { dingtalkStaffId: userRecord.dingtalkStaffId } : {}),
    } : undefined;

    if (pendingAskUser) {
      if (!enqueueRuntime) {
        this.wsSend(client.ws, { type: 'respond_error', interactionId, error: 'AskUserQuestion resume requires runtime scheduler' });
        return true;
      }
      if (!meta || !pendingAskUser.runId || !pendingAskUser.toolCallId) {
        chatLogger.warn(`ask_user resume enqueue rejected: missing meta/runId/toolCallId session=${sessionId} interaction=${interactionId}`);
        return false;
      }
      const currentRun = await enqueueRuntime.runStore.get(pendingAskUser.runId);
      if (!currentRun || TERMINAL_RUN_STATUSES.has(currentRun.status)) {
        chatLogger.warn(
          `ask_user resume enqueue ignored unavailable run=${pendingAskUser.runId} `
          + `status=${currentRun?.status ?? 'missing'}`,
        );
        this.wsSend(client.ws, { type: 'respond_error', interactionId, error: 'Run unavailable' });
        return true;
      }
      const normalizedResponse = normalizeInteractionResponse(response);
      await eventStore!.append({
        type: 'interaction_resolved',
        sessionId,
        runId: pendingAskUser.runId,
        toolCallId: pendingAskUser.toolCallId,
        ...(pendingAskUser.invocationId ? { invocationId: pendingAskUser.invocationId } : {}),
        interactionId,
        interactionType: 'ask_user',
        userId: client.user?.sub,
        response: normalizedResponse,
      }, { tenantId: meta.tenantId });
      await enqueueRuntime.runStore.markStatus(pendingAskUser.runId, 'pending', 'ask_user_resolved_enqueue_resume', {
        resumeInteractionConsumedAt: null,
        resumeInteractionConsumedId: null,
        resumeInteraction: {
          interactionId,
          response: normalizedResponse,
        },
      });
      const workspaceId = meta.workspaceId ?? sessionId;
      await enqueueRuntime.scheduler.enqueue({
        runId: pendingAskUser.runId,
        sessionId,
        userId: meta.userId,
        tenantId: meta.tenantId,
        model: meta.model,
        channel: 'web',
        executionTarget: meta.executionTarget as any,
        workspaceId,
        metadata: {
          transcriptPath,
          resumeInteraction: {
            interactionId,
            response: normalizedResponse,
          },
        },
      });
      this.wsSend(client.ws, { type: 'respond_ok', interactionId });
      if (client.user?.sub && this.eventBus) {
        this.eventBus.emitUser(client.user.sub, { type: 'interaction_resolved', sessionId, interactionId }, client.ws);
        this.eventBus.emitUser(client.user.sub, { type: 'session_status', sessionId, status: 'queued', runId: pendingAskUser.runId });
      }
      return true;
    }

    if (!enqueueRuntime) {
      await approvalStore.resolvePending(
        interactionId,
        'rejected',
        '持久审批恢复需要 Runtime Scheduler；已安全拒绝，未恢复旧 Run',
      );
      this.wsSend(client.ws, { type: 'respond_ok', interactionId });
      if (client.user?.sub && this.eventBus) {
        this.eventBus.emitUser(client.user.sub, { type: 'interaction_resolved', sessionId, interactionId }, client.ws);
      }
      return true;
    }
    if (enqueueRuntime) {
      if (!pendingApprovalRunId) {
        chatLogger.warn(`approval resume enqueue rejected: missing runId session=${sessionId} approval=${interactionId}`);
        return false;
      }
      const acceptedEvent = [...existingEvents].reverse().find((event) => (
        event.type === 'interaction_resolved'
        && event.sessionId === sessionId
        && event.interactionId === interactionId
      ));
      const alreadyAccepted = Boolean(acceptedEvent);
      const alreadyApplied = existingEvents.some((event) => (
        event.type === 'approval_resolved'
        && event.sessionId === sessionId
        && event.approvalId === interactionId
      ));
      const currentRun = sourceRun?.runId === pendingApprovalRunId ? sourceRun : await enqueueRuntime.runStore.get(pendingApprovalRunId);
      const cannotResume = !currentRun || TERMINAL_RUN_STATUSES.has(currentRun.status)
        || (!alreadyAccepted && !alreadyApplied && currentRun.status !== 'waiting_approval');
      if (cannotResume) {
        const sourceStatus = currentRun?.status ?? 'missing';
        const resolved = await approvalStore.resolvePending(
          interactionId,
          'rejected',
          `源 run 不可恢复（${sourceStatus}），拒绝遗留审批`,
        );
        chatLogger.warn(
          `approval resume closed unavailable run=${pendingApprovalRunId} status=${sourceStatus} `
          + `approval=${interactionId} resolved=${Boolean(resolved)}`,
        );
        this.wsSend(client.ws, { type: 'respond_ok', interactionId });
        if (client.user?.sub && this.eventBus) {
          this.eventBus.emitUser(client.user.sub, { type: 'interaction_resolved', sessionId, interactionId }, client.ws);
        }
        return true;
      }
      if (alreadyAccepted || alreadyApplied) {
        this.wsSend(client.ws, { type: 'respond_ok', interactionId });
        return true;
      }
      if (!meta || !transcriptPath) {
        await approvalStore.resolvePending(
          interactionId,
          'rejected',
          '缺少可恢复的会话元数据，已安全拒绝审批',
        );
        this.wsSend(client.ws, { type: 'respond_ok', interactionId });
        return true;
      }
      const acceptedResponse = acceptedEvent?.type === 'interaction_resolved'
        ? acceptedEvent.response
        : undefined;
      const resumeResponse = acceptedResponse && typeof acceptedResponse === 'object'
        ? normalizeInteractionResponse(acceptedResponse as Record<string, unknown>)
        : normalizeInteractionResponse(response);
      const resumedRun = await enqueueRuntime.runStore.markStatus(
        pendingApprovalRunId,
        'pending',
        'approval_resolved_enqueue_resume',
        {
          transcriptPath,
          resumeApprovalConsumedAt: null,
          resumeApprovalConsumedId: null,
          resumeApproval: {
            approvalId: interactionId,
            response: resumeResponse,
          },
        },
      );
      if (!resumedRun || TERMINAL_RUN_STATUSES.has(resumedRun.status)) {
        await approvalStore.resolvePending(
          interactionId,
          'rejected',
          `源 run 不可恢复（${resumedRun?.status ?? 'missing'}），拒绝遗留审批`,
        );
        this.wsSend(client.ws, { type: 'respond_ok', interactionId });
        return true;
      }
      if (!alreadyAccepted) await eventStore.append({
        type: 'interaction_resolved',
        sessionId,
        runId: pendingApprovalRunId,
        interactionId,
        interactionType: 'approval',
        userId: client.user?.sub,
        response: resumeResponse,
      }, { tenantId: meta.tenantId });
      const workspaceId = meta.workspaceId ?? sessionId;
      await enqueueRuntime.scheduler.enqueue({
        runId: pendingApprovalRunId,
        sessionId,
        userId: meta.userId,
        tenantId: meta.tenantId,
        model: meta.model,
        channel: 'web',
        executionTarget: meta.executionTarget as any,
        workspaceId,
        metadata: {
          transcriptPath,
          resumeApproval: {
            approvalId: interactionId,
            response: resumeResponse,
          },
        },
      });
      this.wsSend(client.ws, { type: 'respond_ok', interactionId });
      if (client.user?.sub && this.eventBus) {
        this.eventBus.emitUser(client.user.sub, { type: 'interaction_resolved', sessionId, interactionId }, client.ws);
        this.eventBus.emitUser(client.user.sub, { type: 'session_status', sessionId, status: 'queued', runId: pendingApprovalRunId });
      }
      return true;
    }

    return false;
  }
  /** 处理 abort 消息（runId-first；streamId 仅兼容旧客户端）。
   * 与同连接 chat 共用串行链，确保先收到的 chat 完成 durable enqueue 后再执行 stop-all。
   */
  private handleAbort(client: WsClient, msg: WsAbortMessage): void {
    // legacy 直连路径的 chat tail 覆盖整段模型流，abort 必须立即执行，不能排队到流结束。
    if (!this.config.enqueueRuntime) {
      void this.handleAbortAsync(client, msg).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        chatLogger.warn(`abort failed: ${message}`);
        this.wsSend(client.ws, { type: 'error', message });
      });
      return;
    }
    const previous = this.chatProcessingTails.get(client.ws) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.handleAbortAsync(client, msg));
    this.chatProcessingTails.set(client.ws, next);
    const cleanup = () => {
      if (this.chatProcessingTails.get(client.ws) === next) {
        this.chatProcessingTails.delete(client.ws);
      }
    };
    void next.then(cleanup, (err) => {
      const message = err instanceof Error ? err.message : String(err);
      chatLogger.warn(`abort failed: ${message}`);
      this.wsSend(client.ws, { type: 'error', message });
      cleanup();
    });
  }

  private async handleAbortAsync(client: WsClient, msg: WsAbortMessage): Promise<void> {
    const runId = typeof msg.runId === 'string' && msg.runId.trim() ? msg.runId.trim() : undefined;
    const streamId = typeof msg.streamId === 'string' && msg.streamId.trim() ? msg.streamId.trim() : undefined;
    if (!runId && !streamId) {
      this.wsSend(client.ws, { type: 'error', message: 'runId is required' });
      return;
    }

    const active = runId ? this.findActiveStreamByRunId(runId) : undefined;
    const legacyEntry = !runId && streamId ? this.activeStreams.get(streamId) : undefined;
    if (runId && streamId && active && active.streamId !== streamId) {
      this.wsSend(client.ws, { type: 'error', message: 'runId and streamId do not match' });
      return;
    }
    const entry = active?.entry ?? legacyEntry;
    const resolvedStreamId = active?.streamId ?? (!runId ? streamId : undefined);
    let sessionId = entry?.sessionId;
    let resolvedRunId = runId ?? entry?.runId;
    let resolvedRunStatus: string | undefined;
    let resolvedRunStatusReason: string | undefined;

    if (resolvedRunId && this.config.enqueueRuntime?.runStore) {
      const record = await this.config.enqueueRuntime.runStore.get(resolvedRunId);
      if (record) {
        sessionId = record.sessionId;
        resolvedRunStatus = record.status;
        resolvedRunStatusReason = record.statusReason;
        if (
          client.user
          && (
            (record.tenantId && client.user.tenantId !== record.tenantId)
            || (client.user.role !== 'admin' && record.userId && record.userId !== client.user.sub)
          )
        ) {
          this.wsSend(client.ws, { type: 'error', message: 'Access denied' });
          return;
        }
      }
    }

    if (entry && client.user && entry.userId && entry.userId !== client.user.sub) {
      this.wsSend(client.ws, { type: 'error', message: 'Access denied' });
      return;
    }

    if (resolvedRunStatus && TERMINAL_RUN_STATUSES.has(resolvedRunStatus)) {
      // 只有 cancelled run 的 stop 重试需要修复首次取消遗留的 steering/tool 半状态。
      // completed/failed/orphaned 必须只回放权威终态，不能撤销同会话后续排队项。
      if (sessionId && resolvedRunStatus === 'cancelled' && resolvedRunId) {
        // 首次 stop 的 target/steering 取消已在同一事务提交；重试只修复该 run 的工具
        // outbox，不能再次扫 session，否则会撤销首次 stop 后新进入的排队消息。
        await this.requestRunningToolCancellations(sessionId, resolvedRunId, client.user?.sub);
      }
      this.wsSend(client.ws, { type: 'abort_ok', ...(resolvedStreamId ? { streamId: resolvedStreamId } : {}), ...(resolvedRunId ? { runId: resolvedRunId } : {}) });
      if (sessionId) {
        this.wsSend(client.ws, {
          type: 'session_status',
          sessionId,
          status: resolvedRunStatus as 'completed' | 'failed' | 'cancelled' | 'orphaned',
          ...(resolvedRunId ? { runId: resolvedRunId } : {}),
          ...(resolvedRunStatusReason ? { reason: resolvedRunStatusReason } : {}),
        });
      }
      return;
    }

    // PG 路径把 stop 事件、目标 run 与 pending/reserved steering 同事务提交；旧实现也
    // 严格先取消后记事件，避免事件先落而取消失败的“撒谎”状态。
    const cancelEvent: Parameters<EventStore['append']>[0] = {
      type: 'run_cancel_requested',
      sessionId,
      runId: resolvedRunId,
      streamId: resolvedStreamId,
      userId: client.user?.sub,
      reason: 'web_abort',
    };
    const stopResult = sessionId
      ? await this.cancelPendingSteeringForSession(
        sessionId,
        'aborted',
        resolvedRunId,
        cancelEvent,
        client.user?.tenantId,
      )
      : { targetCancelled: false, eventAppended: false, newCancellation: true };
    if (resolvedRunId && this.config.enqueueRuntime?.runStore) {
      if (!stopResult.targetCancelled) {
        const cancelled = await this.config.enqueueRuntime.runStore.markStatus(
          resolvedRunId,
          'cancelled',
          'web_abort',
        );
        if (!cancelled) {
          throw new Error(`Failed to persist cancellation for run ${resolvedRunId}`);
        }
        if (cancelled.status !== 'cancelled') {
          if (!TERMINAL_RUN_STATUSES.has(cancelled.status)) {
            throw new Error(`Failed to persist cancellation for run ${resolvedRunId}`);
          }
          this.wsSend(client.ws, {
            type: 'abort_ok',
            ...(resolvedStreamId ? { streamId: resolvedStreamId } : {}),
            runId: resolvedRunId,
          });
          if (sessionId) {
            this.wsSend(client.ws, {
              type: 'session_status',
              sessionId,
              status: cancelled.status as 'completed' | 'failed' | 'orphaned',
              runId: resolvedRunId,
              ...(cancelled.statusReason ? { reason: cancelled.statusReason } : {}),
            });
          }
          return;
        }
      }
      if (sessionId && !stopResult.eventAppended) {
        await this.appendDurableWebCommand(sessionId, cancelEvent, client.user?.tenantId);
      }
      if (sessionId) {
        await this.requestRunningToolCancellations(sessionId, resolvedRunId, client.user?.sub);
      }
      runtimeRunController.abort(resolvedRunId, 'web_abort');
    }
    entry?.controller.abort('web_abort');
    this.wsSend(client.ws, { type: 'abort_ok', ...(resolvedStreamId ? { streamId: resolvedStreamId } : {}), ...(resolvedRunId ? { runId: resolvedRunId } : {}) });
  }

  /**
   * stop 的工具取消使用 tool_invocations 作为 durable outbox：每次 stop（包括终态重试）
   * 都重放 requestCancel，不能依赖 run_cancel_requested 是否首次创建。即时事件只在首次
   * 持久化 cancel_requested_at 时追加；若进程在两步之间退出，后台扫描仍会从 durable 行补投。
   */
  private async requestRunningToolCancellations(
    sessionId: string,
    runId: string,
    requestedBy?: string,
  ): Promise<void> {
    const store = this.config.enqueueRuntime?.toolInvocationStore;
    if (!store) return;
    const runningInvocations = await store.listRunning(sessionId);
    for (const invocation of runningInvocations.filter((item) => item.runId === runId)) {
      const cancelRequest = await store.requestCancelOnce(
        invocation.invocationId,
        'web_abort',
        { requestedBy: requestedBy ?? 'anonymous' },
      );
      if (!cancelRequest?.created) continue;
      const cancelRecord = cancelRequest.record;
      await this.appendDurableWebCommand(sessionId, {
        type: 'tool_invocation_cancel_requested',
        sessionId,
        runId,
        invocationId: invocation.invocationId,
        toolCallId: invocation.toolCallId,
        toolName: invocation.toolName,
        userId: requestedBy,
        reason: 'web_abort',
        metadata: cancelRecord.metadata,
      });
    }
  }

  /** 撤销一条仍在排队的插话（终态队列区的撤回按钮）。 */
  private async handleCancelQueued(client: WsClient, msg: import('./wsTypes.js').WsCancelQueuedMessage): Promise<void> {
    const runStore = this.config.enqueueRuntime?.runStore;
    const sourceRunId = typeof msg.sourceRunId === 'string' ? msg.sourceRunId.trim() : '';
    if (!runStore || !sourceRunId || (!runStore.cancelPendingUserMessage && !runStore.cancelPendingSteeringSourceRun)) {
      this.wsSend(client.ws, { type: 'cancel_queued_result', ok: false, sourceRunId, reason: 'unsupported' });
      return;
    }
    const record = await runStore.get(sourceRunId);
    if (!record) {
      this.wsSend(client.ws, { type: 'cancel_queued_result', ok: false, sourceRunId, reason: 'not_found' });
      return;
    }
    if (
      client.user
      && (
        (record.tenantId && client.user.tenantId !== record.tenantId)
        || (client.user.role !== 'admin' && record.userId && record.userId !== client.user.sub)
      )
    ) {
      this.wsSend(client.ws, { type: 'error', message: 'Access denied' });
      return;
    }
    const result = runStore.cancelPendingUserMessage
      ? await runStore.cancelPendingUserMessage(sourceRunId, 'user_withdrew')
      : await runStore.cancelPendingSteeringSourceRun!(sourceRunId, 'user_withdrew');
    if (result.ok) {
      this.finalizeCancelledSteeringSource({
        sourceRunId,
        sessionId: result.sessionId ?? record.sessionId,
        clientMsgId: result.clientMsgId,
        userId: record.userId,
        reason: 'user_withdrew',
      });
    }
    this.wsSend(client.ws, {
      type: 'cancel_queued_result',
      ok: result.ok,
      sourceRunId,
      ...(result.reason ? { reason: result.reason } : {}),
    });
  }

  /** abort 联动：撤销 session 内全部排队插话并广播。 */
  private async cancelPendingSteeringForSession(
    sessionId: string,
    reason: string,
    targetRunId?: string,
    cancelEvent?: Parameters<EventStore['append']>[0],
    tenantId?: string,
  ): Promise<{ targetCancelled: boolean; eventAppended: boolean; newCancellation: boolean }> {
    const runStore = this.config.enqueueRuntime?.runStore;
    if (!runStore) return { targetCancelled: false, eventAppended: false, newCancellation: true };
    if (cancelEvent && runStore.cancelSteeringBeforeDispatchBySessionWithEvent) {
      const { cancelled, targetCancelled, event, eventCreated } = await runStore.cancelSteeringBeforeDispatchBySessionWithEvent(
        sessionId,
        reason,
        targetRunId,
        cancelEvent,
        tenantId,
      );
      for (const input of cancelled) {
        const clientMsgId = typeof input.sourceRun.metadata?.clientMsgId === 'string'
          ? input.sourceRun.metadata.clientMsgId
          : undefined;
        this.finalizeCancelledSteeringSource({
          sourceRunId: input.sourceRunId,
          sessionId,
          ...(clientMsgId ? { clientMsgId } : {}),
          userId: input.sourceRun.userId,
          reason,
        });
      }
      return { targetCancelled, eventAppended: Boolean(event), newCancellation: eventCreated };
    }
    if (runStore.cancelSteeringBeforeDispatchBySession) {
      const cancelled = await runStore.cancelSteeringBeforeDispatchBySession(sessionId, reason, targetRunId);
      // 非 PG/旧实现无法跨 store 原子提交：先落取消事实，再追加事件。事件绝不先行撒谎；
      // 即使 append 失败，run status 仍是可恢复权威事实。
      if (cancelEvent) await this.appendDurableWebCommand(sessionId, cancelEvent, tenantId);
      for (const input of cancelled) {
        const clientMsgId = typeof input.sourceRun.metadata?.clientMsgId === 'string'
          ? input.sourceRun.metadata.clientMsgId
          : undefined;
        this.finalizeCancelledSteeringSource({
          sourceRunId: input.sourceRunId,
          sessionId,
          ...(clientMsgId ? { clientMsgId } : {}),
          userId: input.sourceRun.userId,
          reason,
        });
      }
      const target = targetRunId ? await runStore.get(targetRunId) : null;
      return {
        targetCancelled: target?.status === 'cancelled',
        eventAppended: Boolean(cancelEvent),
        newCancellation: true,
      };
    }
    if (!runStore.listPendingSteeringBySession || !runStore.cancelPendingSteeringSourceRun) {
      return { targetCancelled: false, eventAppended: false, newCancellation: true };
    }
    const pending = await runStore.listPendingSteeringBySession(sessionId);
    for (const input of pending) {
      const result = await runStore.cancelPendingSteeringSourceRun(input.sourceRunId, reason);
      if (!result.ok) continue;
      this.finalizeCancelledSteeringSource({
        sourceRunId: input.sourceRunId,
        sessionId,
        ...(result.clientMsgId ? { clientMsgId: result.clientMsgId } : {}),
        userId: input.sourceRun.userId,
        reason,
      });
    }
    return { targetCancelled: false, eventAppended: false, newCancellation: true };
  }

  /** 撤销成功后的统一收尾：清 activeStreams/幂等缓存 + 多端广播 steering_cancelled。 */
  private finalizeCancelledSteeringSource(input: {
    sourceRunId: string;
    sessionId: string;
    clientMsgId?: string;
    userId?: string;
    reason: string;
  }): void {
    for (const [streamId, entry] of this.activeStreams) {
      if (entry.runId !== input.sourceRunId) continue;
      this.activeStreams.delete(streamId);
      if (entry.clientMsgId) {
        this.idempotencySet(entry.userId, entry.clientMsgId, 'failed', streamId, {
          sessionId: entry.sessionId,
          runId: entry.runId,
          terminalStatus: 'cancelled',
        });
      }
    }
    if (input.userId && this.eventBus) {
      this.eventBus.emitUser(input.userId, {
        type: 'steering_cancelled',
        sessionId: input.sessionId,
        sourceRunId: input.sourceRunId,
        ...(input.clientMsgId ? { clientMsgId: input.clientMsgId } : {}),
        reason: input.reason,
      });
    }
  }

  private async handleApprovalPolicy(client: WsClient, msg: import('./wsTypes.js').WsApprovalPolicyMessage): Promise<void> {
    if (!client.user) {
      this.wsSend(client.ws, { type: 'error', message: 'Access denied' });
      return;
    }
    const runStore = this.config.enqueueRuntime?.runStore;
    const runId = typeof msg.runId === 'string' ? msg.runId.trim() : '';
    if (!runStore || !runId) {
      this.wsSend(client.ws, { type: 'error', message: 'runId is required' });
      return;
    }
    const record = await runStore.get(runId);
    if (!record) {
      this.wsSend(client.ws, { type: 'error', message: 'Run not found' });
      return;
    }
    // 归属校验：平台 admin 可操作任意 run；其他用户（含组织 admin）只能改自己的 run。
    const isPlatformAdmin = client.user.role === 'admin' && client.user.tenantId === DEFAULT_TENANT_ID;
    if (!isPlatformAdmin && record.userId !== client.user.sub) {
      this.wsSend(client.ws, { type: 'error', message: 'Access denied' });
      return;
    }
    if (msg.sessionId && record.sessionId !== msg.sessionId) {
      this.wsSend(client.ws, { type: 'error', message: 'Access denied' });
      return;
    }
    const approvalPolicy = wantsToolAutoApproval(msg.approvalPolicy)
      ? { autoApproveTools: true }
      : null;
    await runStore.markStatus(
      runId,
      record.status,
      'approval_policy_updated',
      { approvalPolicy },
    );
    this.wsSend(client.ws, { type: 'approval_policy_ok', runId, sessionId: record.sessionId });
  }
  private async handleRunStatus(client: WsClient, msg: WsRunStatusMessage): Promise<void> {
    const runId = typeof msg.runId === 'string' ? msg.runId.trim() : '';
    if (!runId || !this.config.enqueueRuntime?.runStore) {
      this.wsSend(client.ws, { type: 'error', message: 'runId is required' });
      return;
    }
    const record = await this.config.enqueueRuntime.runStore.get(runId);
    if (!record) {
      this.wsSend(client.ws, { type: 'error', message: 'Run not found' });
      return;
    }
    if (client.user && client.user.role !== 'admin' && record.userId && record.userId !== client.user.sub) {
      this.wsSend(client.ws, { type: 'error', message: 'Access denied' });
      return;
    }
    this.wsSend(client.ws, {
      type: 'session_status',
      sessionId: record.sessionId,
      status: record.status,
      runId: record.runId,
      ...(typeof record.metadata?.streamId === 'string' ? { streamId: record.metadata.streamId } : {}),
      ...(record.statusReason ? { reason: record.statusReason } : {}),
    });
  }

  private async appendDurableWebCommand(
    sessionId: string | undefined,
    event: Parameters<EventStore['append']>[0],
    tenantId?: string,
  ): Promise<void> {
    if (!sessionId || !this.config.agentCwd) return;
    try {
      const transcriptPath = await findTranscriptOrMetaPathBySessionId(sessionId);
      const resolvedTenantId = tenantId
        ?? (transcriptPath ? (await readSessionMeta(transcriptPath))?.tenantId : undefined);
      const eventStore = this.config.runtimeEventStoreFor && transcriptPath
        ? this.config.runtimeEventStoreFor(transcriptPath)
        : transcriptPath
          ? new FileEventStore(getRuntimeEventLogPath(transcriptPath))
          : null;
      await eventStore?.append(
        event,
        resolvedTenantId ? { tenantId: resolvedTenantId } : undefined,
      );
    } catch (err) {
      chatLogger.warn(`Failed to append durable web command event: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async appendRuntimeEvent(
    transcriptPath: string,
    event: Parameters<EventStore['append']>[0],
    tenantId?: string,
  ): Promise<void> {
    const eventStore = this.config.runtimeEventStoreFor
      ? this.config.runtimeEventStoreFor(transcriptPath)
      : new FileEventStore(getRuntimeEventLogPath(transcriptPath));
    await eventStore.append(event, tenantId ? { tenantId } : undefined);
  }

  /** 处理 resume 消息（替代 GET /api/chat/stream/:sessionId） */
  private handleResume(client: WsClient, msg: WsResumeMessage): void {
    // 串行化同一 ws 上的 resume，避免并发 handleResumeAsync 在 await 处交错导致
    // 双 EventBuffer listener 泄漏、每个流式事件被投递两次（详见 resumeChains 注释）。
    const ws = client.ws;
    const run = () => this.handleResumeAsync(client, msg);
    const pending = this.resumeChains.get(ws);
    // 无在途 resume → 同步启动，保持单条 resume 的同步语义（回放/订阅在本 tick 生效）；
    // 有在途 resume → 串到其后执行，后一条一定能读到前一条已注册的订阅并先退订。
    const next = pending ? pending.then(run, run) : run();
    this.resumeChains.set(ws, next);
    // handleResumeAsync 内部已容错；此处仅防 unhandled rejection 断链。
    void next.catch(() => { /* noop */ });
  }

  private async handleResumeAsync(client: WsClient, msg: WsResumeMessage): Promise<void> {
    const { sessionId: sid, requestId, lastEventId, lastEventCursor, skipReplay } = msg;
    this.wsSessionAffinity.set(client.ws, sid);

    // 总是先清理旧订阅（防止切换会话后旧事件继续推送到新会话）
    const prevUnsub = this.resumeSubscriptions.get(client.ws);
    if (prevUnsub) {
      prevUnsub();
      this.resumeSubscriptions.delete(client.ws);
    }

    const bufferEntry = this.eventBufferStore.get(sid);
    // Capture before the first async status/replay decision. If the run terminates while
    // either await is in flight, subscribeFrom must still include that terminal window.
    const resumeBufferBoundary = bufferEntry ? bufferEntry.nextId - 1 : 0;
    // 判活口径与 getStreamStatus() 统一：durable runStore 是 run 是否活着的唯一真相,
    // 内存 buffer 只是传输缓存。buffer active 但 runStore 明确说没有活跃 run 时,
    // 这是幽灵 buffer(背景事件误建/complete 丢失),就地收口并按 inactive 处理。
    // 否则前端 resume 永远收到 active:true,会话永久卡在"正在思考"。
    let bufferActive = Boolean(bufferEntry && this.eventBufferStore.isActive(sid));
    let durableStatus: string | undefined;
    if (bufferActive) {
      try {
        const runStore = this.config.enqueueRuntime?.runStore;
        if (runStore?.getActiveBySession) {
          const activeRun = await runStore.getActiveBySession(sid);
          if (!activeRun) {
            this.eventBufferStore.complete(sid);
            bufferActive = false;
          } else {
            durableStatus = activeRun.status;
          }
        }
      } catch (err) {
        // runStore 异常时退化信 buffer(与 getStreamStatus 的降级方向一致)
        chatLogger.warn(`[resume] runStore.getActiveBySession 异常,降级信 buffer: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // buffer 不存在 OR 已完成/被收口 → 返回 inactive
    if (!bufferEntry || !bufferActive) {
      const durableActive = await this.tryReplayDurableRuntimeEvents(client, sid, {
        requestId,
        lastEventId,
        lastEventCursor,
        skipReplay: skipReplay === true,
      });
      if (!durableActive) {
        this.wsSend(client.ws, {
          type: 'active_stream', sessionId: sid, active: false,
          ...(requestId ? { requestId } : {}),
        });
      }
      // 已完成的 buffer：推送 pending 交互（须先通过归属校验，防止把他人交互内容暴露给非本人用户）
      if (bufferEntry && (client.user?.role === 'admin' || !bufferEntry.userId || bufferEntry.userId === client.user?.sub)) {
        await this.pushPendingInteractions(client, sid);
      }
      return;
    }

    // 用户归属校验
    if (client.user?.role !== 'admin' && bufferEntry.userId && bufferEntry.userId !== client.user?.sub) {
      this.wsSend(client.ws, {
        type: 'active_stream', sessionId: sid, active: false,
        ...(requestId ? { requestId } : {}),
      });
      return;
    }

    const activeStreamId = this.findActiveStreamIdBySession(sid);
    const activeEntry = activeStreamId ? this.activeStreams.get(activeStreamId) : undefined;
    if (activeStreamId) {
      this.wsActiveStream.set(client.ws, activeStreamId);
    }

    // 通知客户端有活跃流（附带 runId/streamId；runId 是控制面事实源）
    this.wsSend(client.ws, {
      type: 'active_stream',
      sessionId: sid,
      active: true,
      streamId: activeStreamId,
      ...(activeEntry?.runId ? { runId: activeEntry.runId } : {}),
      status: durableStatus ?? 'running',
      ...(requestId ? { requestId } : {}),
    });

    const alreadyDirectBound = Boolean(
      activeStreamId
      && activeEntry?.ws === client.ws
      && this.wsActiveStream.get(client.ws) === activeStreamId,
    );
    if (alreadyDirectBound) {
      await this.pushPendingInteractions(client, sid);
      return;
    }

    // 回放错过的事件（skipReplay 模式下跳过）。
    // 2026-08-04 P1：buffer 的 lastEventId 是本 buffer 实例的内存自增 id，buffer 重建
    // （run 交替/幽灵收口/进程重启）后与客户端持有值错位。客户端没有有效 buffer id、
    // 只有 durable cursor 时（典型：刷新后 transcript 快照已含历史，随后断线重连），
    // 走 durable 增量重放；此时 getEventsAfter(sid, 0) 会把整个 buffer 全量重放，
    // 叠加到 transcript 快照上形成整段重复（实证 fc3bf95a）。
    // 无任何游标（buffer id 与 durable cursor 皆无）时，"重放"没有起点可言，
    // 全量重放必然与客户端已持有的 transcript 快照重叠 —— 这是内容重复的服务端
    // 侧根因，必须在此收口而不能只依赖客户端自觉（旧版本前端、mobile/shared store
    // 都可能发出 lastEventId=0 + skipReplay:false）。此时只发 active_stream，
    // 由客户端刷新 transcript 补齐，与 Web 前端无游标时的策略一致。
    const hasBufferCursor = typeof lastEventId === 'number' && lastEventId > 0;
    const hasAnyCursor = hasBufferCursor || Boolean(lastEventCursor);
    if (!skipReplay && !hasAnyCursor) {
      chatLogger.warn(`[resume] replay requested without any cursor session=${sid}; skipping full replay to avoid duplicate content`);
    }
    let subscribeAfterId = resumeBufferBoundary;
    let durableReplayCursor: string | undefined;
    if (!skipReplay && hasAnyCursor) {
      if (!hasBufferCursor && lastEventCursor) {
        // The boundary was captured before async status lookup. Events pushed while either
        // status lookup or durable replay is in flight are recovered by subscribeFrom below.
        const store = await this.getRuntimeEventStoreForSession(sid);
        if (store) {
          durableReplayCursor = await this.replayDurableRuntimeEvents(client, sid, store, {
            lastEventCursor,
            activeRunId: activeEntry?.runId ?? '',
          });
        }
      } else {
        const result = this.eventBufferStore.getEventsAfter(sid, lastEventId);
        subscribeAfterId = lastEventId;
        if (result) {
          if (result.gapDetected) {
            this.wsSend(client.ws, { type: 'buffer_overflow' });
          }
          for (const evt of result.events) {
            if (client.ws.readyState !== client.ws.OPEN) break;
            try {
              const data = JSON.parse(evt.data);
              this.wsSend(client.ws, data, evt.id, evt.eventCursor);
            } catch { /* skip */ }
            subscribeAfterId = evt.id;
          }
        }
      }
    }
    // Atomically recover the replay→subscribe window and subscribe to future events.
    const unsubscribe = this.eventBufferStore.subscribeFrom(
      sid,
      subscribeAfterId,
      (event) => {
        if (
          durableReplayCursor
          && event.eventCursor
          && isDurableCursorAtOrBefore(event.eventCursor, durableReplayCursor)
        ) return;
        if (client.ws.readyState === client.ws.OPEN) {
          try {
            const data = JSON.parse(event.data);
            this.wsSend(client.ws, data, event.id, event.eventCursor);
          } catch { /* skip */ }
        }
      },
      () => {
        // Agent 完成； subscribeFrom may invoke this synchronously before returning null.
        this.resumeSubscriptions.delete(client.ws);
      },
    );

    if (unsubscribe) {
      this.resumeSubscriptions.set(client.ws, unsubscribe);
    }
    // 仅首次 resume 注册 close listener（旧订阅存在说明已注册过）
    if (!prevUnsub) {
      client.ws.on('close', () => {
        const closeSub = this.resumeSubscriptions.get(client.ws);
        if (closeSub) { closeSub(); this.resumeSubscriptions.delete(client.ws); }
      });
    }

    // 推送 pending 交互
    await this.pushPendingInteractions(client, sid);
  }

  private async tryReplayDurableRuntimeEvents(
    client: WsClient,
    sessionId: string,
    options: { requestId?: string; lastEventId?: number; lastEventCursor?: string; skipReplay?: boolean },
  ): Promise<boolean> {
    const runStore = this.config.enqueueRuntime?.runStore;
    if (!runStore) return false;
    const activeRun = await runStore.getActiveBySession?.(sessionId);
    if (!activeRun) return false;
    if (client.user && client.user.role !== 'admin' && activeRun.userId && activeRun.userId !== client.user.sub) {
      return false;
    }
    const streamId = typeof activeRun.metadata?.streamId === 'string' ? activeRun.metadata.streamId : activeRun.runId;
    this.eventBufferStore.create(sessionId, activeRun.userId);
    this.wsActiveStream.set(client.ws, streamId);
    this.wsSend(client.ws, {
      type: 'active_stream',
      sessionId,
      active: true,
      streamId,
      runId: activeRun.runId,
      status: activeRun.status,
      ...(options.requestId ? { requestId: options.requestId } : {}),
    });
    // Capture before either durable-store await. subscribeFrom recovers every buffered
    // event produced while store lookup/replay is in flight, including terminal events.
    const subscribeAfterId = this.eventBufferStore.get(sessionId)!.nextId - 1;
    let durableReplayCursor: string | undefined;
    if (!options.skipReplay) {
      const store = await this.getRuntimeEventStoreForSession(sessionId);
      if (store) {
        durableReplayCursor = await this.replayDurableRuntimeEvents(client, sessionId, store, {
          ...options,
          activeRunId: activeRun.runId,
        });
      }
    }
    const unsubscribe = this.eventBufferStore.subscribeFrom(
      sessionId,
      subscribeAfterId,
      (event) => {
        if (
          durableReplayCursor
          && event.eventCursor
          && isDurableCursorAtOrBefore(event.eventCursor, durableReplayCursor)
        ) return;
        if (client.ws.readyState === client.ws.OPEN) {
          try { this.wsSend(client.ws, JSON.parse(event.data), event.id, event.eventCursor); } catch { /* skip */ }
        }
      },
      () => {
        // subscribeFrom may complete synchronously and return null; never install a noop.
        this.resumeSubscriptions.delete(client.ws);
      },
    );
    if (unsubscribe) this.resumeSubscriptions.set(client.ws, unsubscribe);
    client.ws.once('close', () => {
      const closeSub = this.resumeSubscriptions.get(client.ws);
      if (closeSub) { closeSub(); this.resumeSubscriptions.delete(client.ws); }
    });
    await this.pushPendingInteractions(client, sessionId);
    return true;
  }

  private async getRuntimeEventStoreForSession(sessionId: string): Promise<EventStore | null> {
    if (!this.config.runtimeEventStoreFor) return null;
    const transcriptPath = await findTranscriptOrMetaPathBySessionId(sessionId);
    return this.config.runtimeEventStoreFor(transcriptPath ?? '');
  }

  private async replayDurableRuntimeEvents(
    client: WsClient,
    sessionId: string,
    store: EventStore,
    options: { lastEventId?: number; lastEventCursor?: string; activeRunId: string },
  ): Promise<string | undefined> {
    let replayId = options.lastEventId ?? 0;
    let replayedCursor = options.lastEventCursor;
    const hasDurableCursor = Boolean(options.lastEventCursor);
    const streamStates = new Map<string, RuntimeStreamProjectionState>();
    // 新 ws-only 实例可能在流进行到一半时接管：浏览器 cursor 之前的 batch 已在 DOM，
    // 但本进程没有内存状态。只预热投影状态、不重发事件，后续聚合全文才能正确补差。
    if (hasDurableCursor && options.lastEventCursor && store.listByRun) {
      const priorRunEvents = await store.listByRun(sessionId, options.activeRunId);
      for (const event of priorRunEvents) {
        if (event.type !== 'assistant_stream_event') continue;
        const eventCursor = getDurableEventCursor(event);
        if (!eventCursor || !isDurableCursorAtOrBefore(eventCursor, options.lastEventCursor)) continue;
        projectRuntimePlatformEvent(event, { expandStreamed: true, streamStates });
      }
    }
    if (store.listPage) {
      let cursor: string | undefined = hasDurableCursor ? options.lastEventCursor : undefined;
      while (true) {
        const page = await store.listPage(sessionId, {
          afterCursor: cursor,
          limit: 200,
          // durable cursor 是会话级游标；没有游标时绝不能从会话开头回放，
          // 否则重连会把历次 Agent 回复全部追加到当前消息流。
          ...(!hasDurableCursor ? { runId: options.activeRunId } : {}),
        });
        for (const event of page.events) {
          const eventCursor = getDurableEventCursor(event);
          const frames = projectRuntimePlatformEvent(event, { expandStreamed: true, streamStates }).events;
          for (const [index, data] of frames.entries()) {
            replayId += 1;
            const frameCursor = index === frames.length - 1 ? eventCursor : undefined;
            // replayId is synthetic, not an EventBuffer ID. Once the client has a durable
            // cursor, attaching replayId would let a later resume accidentally enter the
            // in-memory buffer-cursor path.
            this.wsSend(client.ws, data, hasDurableCursor ? undefined : replayId, frameCursor);
          }
          // Do not cover buffered events with this cursor until every projected frame sent.
          if (eventCursor) replayedCursor = eventCursor;
        }
        if (!page.hasMore || !page.nextCursor) break;
        cursor = page.nextCursor;
      }
      return replayedCursor;
    }
    // 兼容没有分页能力的自定义 EventStore，同样把最坏影响限制在当前 run。
    const events = store.listByRun
      ? await store.listByRun(sessionId, options.activeRunId)
      : (await store.list(sessionId)).filter(
          (event) => 'runId' in event && event.runId === options.activeRunId,
        );
    for (const event of events) {
      const eventCursor = getDurableEventCursor(event);
      const frames = projectRuntimePlatformEvent(event, { expandStreamed: true, streamStates }).events;
      for (const [index, data] of frames.entries()) {
        replayId += 1;
        const frameCursor = index === frames.length - 1 ? eventCursor : undefined;
        if (replayId > (options.lastEventId ?? 0)) {
          this.wsSend(client.ws, data, hasDurableCursor ? undefined : replayId, frameCursor);
        }
      }
      if (eventCursor) replayedCursor = eventCursor;
    }
    return replayedCursor;
  }

  /** 处理 detach 消息：客户端切换会话时立即取消 EventBuffer 订阅，防止旧会话事件串流 */
  private handleDetach(client: WsClient): void {
    // 清除 WS 活跃流绑定，阻止旧会话的 handleEvents/hooks send 继续向此 WS 直接推送
    this.wsActiveStream.delete(client.ws);
    this.wsSessionAffinity.delete(client.ws);
    const prevUnsub = this.resumeSubscriptions.get(client.ws);
    if (prevUnsub) {
      prevUnsub();
      this.resumeSubscriptions.delete(client.ws);
    }
  }

  /** 处理 sync 消息：断线重连时回放漏掉的元数据事件 */
  private handleSync(client: WsClient, msg: WsSyncMessage): void {
    const userId = client.user?.sub;
    if (!userId || !this.wsServer) return;

    const eventLog = this.wsServer.userEventLog;
    const epoch = eventLog.getEpoch(userId);
    const currentSeq = eventLog.getCurrentSeq(userId);
    if (this.wsServer.hasUserEventEpochMismatch(client, userId, msg.epoch, msg.lastSeq)) {
      this.wsSend(client.ws, { type: 'sync_overflow', seq: currentSeq, epoch });
      return;
    }

    const result = eventLog.getEventsAfter(userId, msg.lastSeq);
    if (result.gapDetected) {
      this.wsSend(client.ws, { type: 'sync_overflow', seq: currentSeq, epoch });
    } else {
      this.wsSend(client.ws, {
        type: 'sync_ok',
        seq: currentSeq,
        epoch,
        events: result.events,
      });
    }
  }

  private async pushPendingInteractions(client: WsClient, sessionId: string): Promise<void> {
    const resolvedIds = this.config.runtimeEventStoreFor ? await loadResolvedInteractionIds(await this.getRuntimeEventStoreForSession(sessionId), sessionId) : new Set<string>();
    const pending = interactionStore.getPendingInteractions(sessionId).filter((entry) => !resolvedIds.has(entry.interactionId));
    const excluded = new Set([...resolvedIds, ...pending.map((entry) => entry.interactionId)]);

    const recovered = scanBufferForPendingInteractions(this.eventBufferStore.getEventsAfter(sessionId, 0)?.events, excluded);
    if (recovered.length > 0) pending.push(...recovered);
    if (pending.length > 0) this.wsSend(client.ws, { type: 'pending_interactions', interactions: pending });
  }

  // ── 核心聊天处理逻辑 ──────────────────────────────────
  private async processChatMessage(client: WsClient, msg: WsChatMessage): Promise<void> {
    const steeringAcceptedAt = new Date().toISOString();
    const { message, sessionId, attachments, model, voiceFile } = msg;
    let deliveryMode: 'queue' | 'steer' = msg.deliveryMode === 'steer' && !isCompactCommand(message)
      ? 'steer'
      : 'queue';
    const ws = client.ws;
    const user = client.user;
    const executionConfig = this.config.executionConfig ?? DEFAULT_EXECUTION_CONFIG;
    // 授权模式对所有已认证用户生效（2026-07-02 起）：用户通过账户设置自行切换。
    const approvalPolicy = user && wantsToolAutoApproval(msg.approvalPolicy)
      ? { autoApproveTools: true }
      : undefined;

    // 读取（或为老客户端生成）客户端消息 ID —— 贯穿全链路的幂等/绑定键
    let clientMsgId = msg.client_msg_id;
    if (!clientMsgId) {
      clientMsgId = `srv-${Date.now()}-${++this.streamIdCounter}`;
      chatLogger.warn(`[chat] Legacy client without client_msg_id, generated ${clientMsgId}`);
    }

    const tenantAccessError = this.tenantAccessErrorForClient(client);
    if (tenantAccessError) {
      this.sendChatRejected(ws, clientMsgId, 'access_denied', tenantAccessError);
      return;
    }

    // 永久幂等事实必须先于 drain/载荷校验：重放一个已受理请求只回原权威结果，
    // 不能因本次传输载荷缺失或实例正在排水而改写为 rejected。
    const durableRun = await this.config.enqueueRuntime?.runStore.findByIdempotencyKey(user?.sub, clientMsgId);
    if (durableRun) {
      const tenantMismatch = Boolean(
        user
        && !isPlatformAdminUser(user)
        && durableRun.tenantId
        && durableRun.tenantId !== user.tenantId,
      );
      const ownerMismatch = Boolean(
        durableRun.userId
        && (!user || (user.role !== 'admin' && durableRun.userId !== user.sub)),
      );
      if (tenantMismatch || ownerMismatch) {
        this.sendChatRejected(ws, clientMsgId, 'access_denied', '无权访问该会话');
        return;
      }
      const authoritative = resolveAuthoritativeSubmissionState(durableRun);
      const terminal = TERMINAL_RUN_STATUSES.has(durableRun.status);
      this.wsSessionAffinity.set(ws, durableRun.sessionId);
      this.idempotencySet(
        user?.sub,
        clientMsgId,
        authoritative.status === 'completed' ? 'done' : terminal ? 'failed' : 'in_flight',
        authoritative.streamId ?? '',
        {
          sessionId: durableRun.sessionId,
          runId: durableRun.runId,
          deliveryMode: authoritative.deliveryMode,
          ...(authoritative.deliveryMode === 'queue' && authoritative.queuedTargetRunId
            ? { queuedBehindRunId: authoritative.queuedTargetRunId }
            : {}),
          ...(authoritative.deliveryMode === 'steer' && authoritative.queuedTargetRunId
            ? { steeringTargetRunId: authoritative.queuedTargetRunId }
            : {}),
          ...(terminal
            ? { terminalStatus: authoritative.status as 'completed' | 'failed' | 'cancelled' }
            : {}),
        },
      );
      this.sendChatAck(ws, clientMsgId, {
        sessionId: durableRun.sessionId,
        runId: durableRun.runId,
        status: authoritative.status,
        deliveryMode: authoritative.deliveryMode,
      });
      if (authoritative.streamId && !terminal) {
        this.wsSend(ws, {
          type: 'stream_id',
          streamId: authoritative.streamId,
          sessionId: durableRun.sessionId,
          runId: durableRun.runId,
          client_msg_id: clientMsgId,
          ...(authoritative.queuedTargetRunId
            ? { queued: true, deliveryMode: authoritative.deliveryMode, targetRunId: authoritative.queuedTargetRunId }
            : {}),
        });
      }
      this.wsSend(ws, { type: 'session', sessionId: durableRun.sessionId, client_msg_id: clientMsgId });
      return;
    }


    // 1) Drain 拦截（服务端优雅关闭期间）
    if (this.config.getIsDraining?.()) {
      this.sendChatRejected(ws, clientMsgId, 'server_draining', '服务即将关闭，请稍后重试');
      return;
    }

    // 2) 空消息校验
    if (!message && !voiceFile) {
      this.sendChatRejected(ws, clientMsgId, 'empty_message', '消息内容不能为空');
      return;
    }

    // 3a) ExecutionTarget 解析：统一入口，禁止通道内联策略
    const executionDecision = resolveExecutionTarget({
      requested: msg.executionTarget,
      user: user ? { role: user.role, tenantId: user.tenantId } : null,
      sessionId,
      config: executionConfig,
    });
    if (!executionDecision.ok) {
      this.sendChatRejected(ws, clientMsgId, 'access_denied', executionDecision.reason);
      return;
    }
    const resolvedExecutionTarget = executionDecision.target;

    // 3b) 恢复会话的归属校验
    if (sessionId && user && user.role !== 'admin') {
      const checkCwd = resolveUserCwd(this.config.agentCwd!, { id: user.sub, username: user.username, role: user.role, tenantId: user.tenantId });
      const transcriptPath = getTranscriptPath(checkCwd, sessionId, { tenantId: user.tenantId, userId: user.sub });
      const meta = await readSessionMeta(transcriptPath);
      if (meta && meta.userId !== user.sub) {
        this.sendChatRejected(ws, clientMsgId, 'access_denied', '无权访问该会话');
        return;
      }
    }

    // 4) 幂等检查：同 client_msg_id 已在处理中 → 直接 ACK（不再 dispatch）
    //    done/failed 终态一律拒绝重试（用户手动重试应生成新的 client_msg_id）
    const dupEntry = this.idempotencyGet(user?.sub, clientMsgId);
    if (dupEntry) {
      if (dupEntry.status === 'in_flight') {
        const durableStore = this.config.enqueueRuntime?.runStore;
        if (durableStore && dupEntry.runId) {
          let authoritativeRun: RunRecord | null;
          try {
            authoritativeRun = await durableStore.get(dupEntry.runId);
          } catch (error) {
            chatLogger.warn(`[chat] Idempotency authority lookup failed run=${dupEntry.runId}: ${error instanceof Error ? error.message : String(error)}`);
            return;
          }
          if (!authoritativeRun) {
            chatLogger.warn(`[chat] Idempotency cache points to missing run=${dupEntry.runId}`);
            return;
          }
          const authoritative = resolveAuthoritativeSubmissionState(authoritativeRun);
          this.wsSessionAffinity.set(ws, authoritativeRun.sessionId);
          this.idempotencySet(
            user?.sub,
            clientMsgId,
            authoritative.status === 'completed' ? 'done' : TERMINAL_RUN_STATUSES.has(authoritativeRun.status) ? 'failed' : 'in_flight',
            authoritative.streamId ?? '',
            {
              sessionId: authoritativeRun.sessionId,
              runId: authoritativeRun.runId,
              deliveryMode: authoritative.deliveryMode,
              ...(authoritative.deliveryMode === 'queue' && authoritative.queuedTargetRunId
                ? { queuedBehindRunId: authoritative.queuedTargetRunId }
                : {}),
              ...(authoritative.deliveryMode === 'steer' && authoritative.queuedTargetRunId
                ? { steeringTargetRunId: authoritative.queuedTargetRunId }
                : {}),
              ...(TERMINAL_RUN_STATUSES.has(authoritativeRun.status)
                ? { terminalStatus: authoritative.status as 'completed' | 'failed' | 'cancelled' }
                : {}),
            },
          );
          this.sendChatAck(ws, clientMsgId, {
            sessionId: authoritativeRun.sessionId,
            runId: authoritativeRun.runId,
            status: authoritative.status,
            deliveryMode: authoritative.deliveryMode,
          });
          if (authoritative.streamId && !TERMINAL_RUN_STATUSES.has(authoritativeRun.status)) {
            this.wsSend(ws, {
              type: 'stream_id',
              streamId: authoritative.streamId,
              sessionId: authoritativeRun.sessionId,
              runId: authoritativeRun.runId,
              client_msg_id: clientMsgId,
              ...(authoritative.queuedTargetRunId
                ? { queued: true, deliveryMode: authoritative.deliveryMode, targetRunId: authoritative.queuedTargetRunId }
                : {}),
            });
          }
          this.wsSend(ws, { type: 'session', sessionId: authoritativeRun.sessionId, client_msg_id: clientMsgId });
          return;
        }

        if (dupEntry.sessionId) this.wsSessionAffinity.set(ws, dupEntry.sessionId);
        chatLogger.info(`[chat] Legacy idempotency hit (in_flight), resending cached ACK for client_msg_id=${clientMsgId}`);
        const duplicateQueuedBehind = dupEntry.steeringTargetRunId ?? dupEntry.queuedBehindRunId;
        this.sendChatAck(ws, clientMsgId, {
          ...(dupEntry.sessionId ? { sessionId: dupEntry.sessionId } : {}),
          ...(dupEntry.runId ? { runId: dupEntry.runId } : {}),
          status: duplicateQueuedBehind ? 'queued' : 'accepted',
          ...(dupEntry.deliveryMode ? { deliveryMode: dupEntry.deliveryMode } : {}),
        });
        if (dupEntry.streamId) {
          this.wsSend(ws, {
            type: 'stream_id',
            streamId: dupEntry.streamId,
            ...(dupEntry.sessionId ? { sessionId: dupEntry.sessionId } : {}),
            ...(dupEntry.runId ? { runId: dupEntry.runId } : {}),
            client_msg_id: clientMsgId,
            ...(duplicateQueuedBehind
              ? { queued: true, deliveryMode: dupEntry.deliveryMode ?? 'queue', targetRunId: duplicateQueuedBehind }
              : {}),
          });
        }
        if (dupEntry.sessionId) {
          this.wsSend(ws, { type: 'session', sessionId: dupEntry.sessionId, client_msg_id: clientMsgId });
        }
        return;
      }
      // done/failed 仍返回原提交的终态关联；传输层重试不是新的业务消息。
      this.sendChatAck(ws, clientMsgId, {
        ...(dupEntry.sessionId ? { sessionId: dupEntry.sessionId } : {}),
        ...(dupEntry.runId ? { runId: dupEntry.runId } : {}),
        status: dupEntry.terminalStatus ?? (dupEntry.status === 'done' ? 'completed' : 'failed'),
        ...(dupEntry.deliveryMode ? { deliveryMode: dupEntry.deliveryMode } : {}),
      });
      if (dupEntry.sessionId) {
        this.wsSend(ws, { type: 'session', sessionId: dupEntry.sessionId, client_msg_id: clientMsgId });
      }
      return;
    }

    // 5) 此处仍未 accepted：STT、门禁、会话持久化和 durable enqueue 任一步都可能失败。
    // chat_ack 必须延后到 run 与幂等提交记录同事务落库之后。

    // 6) 语音消息: STT 转文字
    let resolvedMessage = message || '';
    if (voiceFile && this.config.sttConfig) {
      try {
        chatLogger.info(`Voice STT: processing ${voiceFile.savedPath} (${voiceFile.duration}ms)`);
        const sttResult = await speechToText(voiceFile.savedPath, this.config.sttConfig);
        if (sttResult.text) {
          const displayText = sttResult.text;
          resolvedMessage = VOICE_STT_TAG + displayText;
          chatLogger.info(`Voice STT result: "${displayText}" (duration=${sttResult.duration}ms, hasText=true)`);
          this.wsSend(ws, { type: 'voice_transcribed', text: displayText });
        } else {
          // STT 返回空文本（静音 / ASR 异常）→ 视为拒绝，不再送给 Agent
          const reason = sttResult.duration === 0
            ? '语音无法识别：未检测到语音'
            : '语音无法识别：识别结果为空';
          chatLogger.warn(`Voice STT empty: duration=${sttResult.duration}ms`);
          this.wsSend(ws, { type: 'voice_transcribed', text: `[${reason}]`, error: true });
          this.idempotencySet(user?.sub, clientMsgId, 'failed', '');
          this.sendChatRejected(ws, clientMsgId, 'stt_failed', reason);
          return;
        }
      } catch (err) {
        chatLogger.error('Voice STT failed:', err);
        this.wsSend(ws, { type: 'voice_transcribed', text: '[语音识别失败]', error: true });
        this.idempotencySet(user?.sub, clientMsgId, 'failed', '');
        this.sendChatRejected(ws, clientMsgId, 'stt_failed', '语音识别服务调用失败');
        return;
      }
    } else if (voiceFile && !this.config.sttConfig) {
      chatLogger.warn('Voice message received but STT not configured (missing doubaoCluster)');
      this.wsSend(ws, { type: 'voice_transcribed', text: '[语音识别未配置]', error: true });
      this.idempotencySet(user?.sub, clientMsgId, 'failed', '');
      this.sendChatRejected(ws, clientMsgId, 'stt_not_configured', '服务端未配置语音识别');
      return;
    }

    // Log attachment info
    if (attachments && attachments.length > 0) {
      const imageCount = attachments.filter((a: UploadedFileInfo) => a.isImage).length;
      const fileCount = attachments.length - imageCount;
      chatLogger.info(`Attachments: ${imageCount} image(s), ${fileCount} file(s)`);
    }

    // 构造 InboundMessage
    const inbound: InboundMessage = {
      channel: 'web',
      chatId: sessionId || '',
      content: resolvedMessage,
      attachments,
    };

    // 构造 ChannelContext
    let userIdentity: ChannelContext['user'];
    if (user) {
      const record = this.userStore?.findById(user.sub);
      userIdentity = {
        id: user.sub,
        username: user.username,
        role: user.role,
        tenantId: record?.tenantId || user.tenantId,
        ...(record?.realName ? { realName: record.realName } : {}),
        ...(record?.dingtalkStaffId ? { dingtalkStaffId: record.dingtalkStaffId } : {}),
      };
    }

    // 防止 resume 已删除的会话；admin 需要跨用户查找
    let validSessionId = sessionId;
    let targetCwd: string | undefined;
    let sessionOwner: ChannelContext['sessionOwner'];
    // 专职 Agent 门禁需要的会话上下文：meta（orgAgentId 事实源）+ transcript 路径（最近用户消息）
    let gateSessionMeta: SessionMeta | null = null;
    let gateTranscriptPath: string | undefined;
    if (sessionId) {
      const resumeCwd = resolveUserCwd(this.config.agentCwd!, userIdentity);
      const resumeTranscriptPath = getTranscriptPath(resumeCwd, sessionId, user ? { tenantId: user.tenantId, userId: user.sub } : undefined);
      const resumeMeta = await readSessionMeta(resumeTranscriptPath);
      gateSessionMeta = resumeMeta;
      gateTranscriptPath = resumeTranscriptPath;
      const resumeSessionExists = (await sessionExists(resumeCwd, sessionId))
        || (!!resumeMeta && (!user || user.role === 'admin' || resumeMeta.userId === user.sub));
      if (!resumeSessionExists) {
        // admin 代操作：会话可能在其他用户的 workspace 中
        if (user?.role === 'admin') {
          const transcriptPath = await findTranscriptOrMetaPathBySessionId(sessionId);
          if (transcriptPath) {
            const meta = await readSessionMeta(transcriptPath);
            // 跨租户收口（2026-07 审查 F1b）：组织 admin 仅可代操作本租户会话；
            // 平台 admin 保留全局代操作。legacy meta 可能缺 tenantId，按 ownerRecord 回退
            //（与下方 targetCwd 解析同口径）；解析不出 owner 租户时 fail-closed。
            if (!isPlatformAdminUser(user)) {
              const ownerTenantId = meta
                ? (this.userStore?.findById(meta.userId)?.tenantId || meta.tenantId)
                : undefined;
              if (ownerTenantId !== user.tenantId) {
                this.idempotencySet(user?.sub, clientMsgId, 'failed', '');
                this.sendChatRejected(ws, clientMsgId, 'access_denied', '无权访问该会话');
                return;
              }
            }
            gateSessionMeta = meta;
            gateTranscriptPath = transcriptPath;
            if (meta?.username) {
              // PR 7 P1-2：admin resume 时按 ownerRecord.tenantId 落对路径
              const ownerRecord = this.userStore?.findById(meta.userId);
              targetCwd = resolveUserCwd(this.config.agentCwd!, {
                id: meta.userId,
                username: meta.username,
                role: 'user',
                tenantId: ownerRecord?.tenantId || meta.tenantId,
              });
              sessionOwner = {
                id: meta.userId,
                username: meta.username,
                role: (ownerRecord?.role as 'admin' | 'user' | undefined) ?? 'user',
                tenantId: ownerRecord?.tenantId || meta.tenantId,
                ...(ownerRecord?.realName ? { realName: ownerRecord.realName } : {}),
              };
              chatLogger.info(`Admin resuming session owned by ${meta.username}, targetCwd=${targetCwd}`);
            }
          } else {
            chatLogger.warn(`Session ${sessionId} transcript not found globally, starting new session`);
            validSessionId = undefined;
            gateSessionMeta = null;
            gateTranscriptPath = undefined;
          }
        } else {
          chatLogger.warn(`Session ${sessionId} transcript not found, starting new session`);
          validSessionId = undefined;
          gateSessionMeta = null;
          gateTranscriptPath = undefined;
        }
      }
    }

    // 构建用户消息展示内容（纯文本 + 结构化附件）
    const AI_FALLBACK_TEXT = 'Please check the attachments I uploaded';
    const userDisplayContent = (resolvedMessage === AI_FALLBACK_TEXT && attachments?.length)
      ? ''
      : resolvedMessage;
    const attachmentMeta = attachments?.length
      ? attachments.map((a: UploadedFileInfo) => ({
        name: a.originalName,
        isImage: a.isImage,
        // 前端点击预览/下载用（走 /api/file 端点，workspace 内路径校验）
        relativePath: a.relativePath,
      }))
      : undefined;

    const context: ChannelContext = {
      channel: 'web',
      outputTransactionMode: msg.clientCapabilities?.includes('replaceable_drafts') === true
        ? 'replaceable_draft'
        : 'irreversible_stream',
      resumeSessionId: validSessionId,
      timezone: this.config.timezone,
      ...(userIdentity ? { user: userIdentity } : {}),
      ...(sessionOwner ? { sessionOwner } : {}),
      ...(targetCwd ? { targetCwd } : {}),
    };

    const targetTenantAccessError = tenantAccessErrorMessage(
      this.config.tenantStore,
      context.sessionOwner?.tenantId ?? context.user?.tenantId,
    );
    if (targetTenantAccessError) {
      this.idempotencySet(user?.sub, clientMsgId, 'failed', '');
      this.sendChatRejected(ws, clientMsgId, 'access_denied', targetTenantAccessError);
      return;
    }

    // ── 公司级专职 Agent 解析与门禁（2026-07 唯恩批次，2026-07-18 蓝图 v2 § 4.3.1 加 shadow/enforce 三档）──
    // 0) /compact 等平台命令只跳过 LLM 话题门禁，企业专家授权校验仍必须执行
    // 1) 解析 orgAgentId：带 sessionId 以会话 meta 为准（忽略客户端值防伪造）；新会话取 msg.orgAgentId
    // 2) org agent 校验：存在 + enabled + 同租户 + 被指派（admin 豁免 audience）→ 否则 org_agent_unavailable
    // 3) personalAgent gate：无 orgAgentId 且租户关闭个人 Agent 时普通用户被拒
    // 4) LLM 话题门禁三档（mode = off | shadow | enforce）：
    //    - off:     不跑门禁模型，直通主 Agent
    //    - shadow:  跑门禁 + 落库审计（打 mode='shadow' 供看板过滤），但**不拦截**主 Agent（新专家 3-7 天观察期）
    //    - enforce: 跑门禁 + 落库审计 + off_topic 时用 rejectionMessage 拦截主 Agent（现有行为）
    //    Fail-open 保留（曾磊 07-10 决策：门禁是体验壁垒非安全边界）——门禁 LLM 失败/超时默认放行。
    let orgAgentId: string | undefined;
    let orgAgentRecord: OrgAgentRecord | undefined;
    let guardrailMark: 'pass_flagged' | 'fail_open' | 'shadow_off_topic' | undefined;
    /** uncertain/纯附件/shadow 拒答的落库负载：延迟到 sessionId 确定后 flush */
    let pendingGuardrailEvent: {
      messageText: string;
      model?: string;
      latencyMs?: number;
      /** shadow 分支的 flush 用（enforce 直接走 handleGuardrailRejection 落 off_topic） */
      verdict?: GuardrailEventVerdict;
      /** 落库时打入 event 用于看板过滤（'shadow' 表示未拦截；enforce/未标记默认 'enforce'） */
      mode?: OrgAgentGuardrailMode;
      /** 门禁模型自报确信度 0-1（usage-stats P50/P90 数据源） */
      confidence?: number;
    } | undefined;
    if (validSessionId) {
      orgAgentId = gateSessionMeta?.orgAgentId;
      if (msg.orgAgentId && msg.orgAgentId !== orgAgentId) {
        chatLogger.warn(`[org-agent] client orgAgentId=${msg.orgAgentId} ignored, session meta wins (${orgAgentId ?? 'none'}, session=${validSessionId})`);
      }
    } else {
      orgAgentId = msg.orgAgentId;
    }
    const isPlatformCommand = isCompactCommand(resolvedMessage);
    if (isPlatformCommand) deliveryMode = 'queue';
    if (orgAgentId) {
      const record = this.config.orgAgentStore?.get(orgAgentId);
      const gateIdentity = sessionOwner ?? userIdentity;
      // admin 豁免 audience 收紧（2026-07 审查 F1a）：仅平台 admin 或与该 org agent
      // 同租户的组织 admin；跨租户组织 admin → assigned=false → org_agent_unavailable（同码防枚举）
      const adminExempt = user?.role === 'admin'
        && (isPlatformAdminUser(user) || record?.tenantId === user.tenantId);
      const assigned = !!record && !!parseOrgAgentAudience(record.audience) && (adminExempt || isAssignedToOrgAgent(record, gateIdentity?.username));
      if (!record || !record.enabled || record.tenantId !== gateIdentity?.tenantId || !assigned) {
        // 跨租户/缺失/停用/未指派一律同码防枚举（决策 8）；读留发禁（决策 1/3）
        this.idempotencySet(user?.sub, clientMsgId, 'failed', '');
        this.sendChatRejected(ws, clientMsgId, 'org_agent_unavailable', '该企业专家当前不可用，请联系组织管理员');
        return;
      }
      orgAgentRecord = record;
    }
    if (!orgAgentId && !isPlatformCommand && user && user.role !== 'admin') {
      const features = this.config.tenantStore?.getSettings(user.tenantId ?? DEFAULT_TENANT_ID)?.features;
      if (features?.personalAgentEnabled === false) {
        this.idempotencySet(user?.sub, clientMsgId, 'failed', '');
        this.sendChatRejected(ws, clientMsgId, 'personal_agent_disabled', '当前组织未开放个人通用 Agent，请使用组织为你配置的企业专家');
        return;
      }
    }
    // 门禁三档决策（2026-07-18 蓝图 v2 § 4.3.1）：先归一化配置，从 enabled/mode 二选一取权威档位。
    // 旧记录只有 `enabled: boolean` → mode 派生（true=enforce / false=off）；新记录直接读 mode。
    const guardrailConfig = orgAgentRecord
      ? normalizeGuardrailConfig(orgAgentRecord.guardrail)
      : undefined;
    const guardrailMode: OrgAgentGuardrailMode = guardrailConfig?.mode ?? 'off';
    if (orgAgentRecord && guardrailMode !== 'off' && !isPlatformCommand) {
      const guardrailConfigs = this.config.getGuardrailModelConfigs?.() ?? [];
      if (guardrailConfigs.length > 0) {
        const isPureAttachment = resolvedMessage === AI_FALLBACK_TEXT && !!attachments?.length;
        if (isPureAttachment) {
          // 决策 5：纯附件消息跳过门禁模型调用，按 uncertain 放行 + 打标（message_text 记附件名清单）
          // shadow 与 enforce 在纯附件上语义相同（都不拦截、都落库 pass_flagged），mode 用于看板过滤。
          guardrailMark = 'pass_flagged';
          pendingGuardrailEvent = {
            messageText: `[附件] ${attachments!.map((a: UploadedFileInfo) => a.originalName).join(', ')}`,
            verdict: 'pass_flagged',
            mode: guardrailMode,
          };
        } else {
          // 决策 6：语音只看 STT 后文本（剥 VOICE_STT_TAG）
          const guardText = resolvedMessage.startsWith(VOICE_STT_TAG)
            ? resolvedMessage.slice(VOICE_STT_TAG.length)
            : resolvedMessage;
          const recentUserMessages = gateTranscriptPath
            ? await extractRecentUserMessages(gateTranscriptPath, this.config.guardrailOptions?.maxRecentRounds ?? 2)
            : [];
          const billingService = this.config.billingService?.();
          const utilityBilling = billingService && user
            ? await billingService.beginUtilityModelRun({
                tenantId: user.tenantId ?? DEFAULT_TENANT_ID,
                ...(userIdentity?.id ? { userId: userIdentity.id } : {}),
                username: user.username,
                sessionId: validSessionId,
                channel: 'guardrail',
              })
            : undefined;
          let check: Awaited<ReturnType<typeof checkTopicScope>>;
          try {
            check = await checkTopicScope(
              {
                message: guardText,
                scopeDescription: guardrailConfig!.scopeDescription,
                strictness: guardrailConfig!.strictness,
                recentUserMessages,
              },
              guardrailConfigs,
              {
                timeoutMs: this.config.guardrailOptions?.timeoutMs,
                systemPrompt: this.config.getGuardrailSystemPrompt?.(),
                beforeModelCall: () => utilityBilling?.beforeModelCall(),
                onUsage: async (usageModel, usage) => {
                  await utilityBilling?.recordUsage(usageModel, usage);
                  const tokenStore = this.config.tokenUsageStore;
                  if (!tokenStore || !user) return;
                  try {
                    tokenStore.recordResult({
                      username: user.username,
                      tenantId: user.tenantId ?? DEFAULT_TENANT_ID,
                      channel: 'guardrail',
                      modelUsage: { [usageModel]: usage },
                      occurredAtMs: Date.now(),
                    });
                  } catch (err) {
                    chatLogger.warn(`[guardrail] usage record failed: ${err instanceof Error ? err.message : String(err)}`);
                  }
                },
              },
            );
          } finally {
            await utilityBilling?.finalize();
          }
          if (check.verdict === 'off_topic') {
            if (guardrailMode === 'enforce') {
              // enforce：现有行为——合成拒答气泡、不启动主 Agent
              await this.handleGuardrailRejection({
                ws,
                user,
                userIdentity,
                sessionOwner,
                targetCwd,
                validSessionId,
                clientMsgId,
                orgAgent: orgAgentRecord,
                model,
                executionTarget: resolvedExecutionTarget,
                resolvedMessage,
                userDisplayContent,
                attachmentMeta,
                guardrailModel: check.model,
                guardrailLatencyMs: check.latencyMs,
                guardrailConfidence: check.confidence,
              });
              return;
            }
            // shadow：落库审计（verdict=off_topic + mode=shadow 便于看板区分），但**不拦截**主 Agent
            // 决策依据：新专家上线前观察 3-7 天，管理员看 shadow off_topic 数据判定 scopeDescription
            // 是否写歪，再决定切 enforce。metadata 打 'shadow_off_topic' 便于 run 侧关联。
            guardrailMark = 'shadow_off_topic';
            pendingGuardrailEvent = {
              messageText: guardText,
              ...(check.model ? { model: check.model } : {}),
              latencyMs: check.latencyMs,
              verdict: 'off_topic',
              mode: 'shadow',
              ...(check.confidence !== undefined ? { confidence: check.confidence } : {}),
            };
            chatLogger.info(
              `[guardrail] shadow off_topic (not blocking): orgAgent=${orgAgentRecord.id} model=${check.model ?? 'n/a'}`,
            );
          } else if (check.verdict === 'uncertain') {
            guardrailMark = 'pass_flagged';
            pendingGuardrailEvent = {
              messageText: guardText,
              ...(check.model ? { model: check.model } : {}),
              latencyMs: check.latencyMs,
              verdict: 'pass_flagged',
              mode: guardrailMode,
              ...(check.confidence !== undefined ? { confidence: check.confidence } : {}),
            };
          } else if (check.source === 'fail_open') {
            // fail_open 打 metadata 不落库（与 pass_flagged 区分，避免污染需求雷达数据）
            // fail-open 语义在 shadow / enforce 下一致：门禁 LLM 失败时默认放行
            guardrailMark = 'fail_open';
          }
        }
      }
    }
    const flushPendingGuardrailEvent = (resolvedGuardrailSessionId: string | undefined): void => {
      if (!pendingGuardrailEvent || !orgAgentRecord) return;
      // shadow vs enforce 区分打在 messageText 前缀 [shadow] 里（PG 表 schema 未变，
      // 不新增列；GuardrailEventsView 可用 SUBSTRING(message_text, 1, 8) = '[shadow]' 过滤）
      // 详见蓝图 v2 § 4.3.1"UI 侧看板过滤器"。
      const prefix = pendingGuardrailEvent.mode === 'shadow' ? '[shadow] ' : '';
      void this.insertGuardrailEvent({
        orgAgent: orgAgentRecord,
        user,
        sessionId: resolvedGuardrailSessionId,
        clientMsgId,
        verdict: pendingGuardrailEvent.verdict ?? 'pass_flagged',
        messageText: `${prefix}${pendingGuardrailEvent.messageText}`,
        model: pendingGuardrailEvent.model,
        latencyMs: pendingGuardrailEvent.latencyMs,
        confidence: pendingGuardrailEvent.confidence,
      });
      pendingGuardrailEvent = undefined;
    };
    // ── 门禁段结束 ─────────────────────────────────────────────────

    // 只有消息通过基础校验、租户校验与企业专家门禁后，附件才从 staged 转为
    // referenced。后续 run 即使失败也必须保留附件，因为用户消息已被平台接受。
    if (attachments?.length && this.config.uploadManager && this.config.agentCwd) {
      const attachmentUserCwd = resolveUserCwd(this.config.agentCwd, userIdentity);
      try {
        await this.config.uploadManager.markReferenced(attachmentUserCwd, attachments, {
          ...(validSessionId ? { sessionId: validSessionId } : {}),
          clientMessageId: clientMsgId,
        });
      } catch (error) {
        chatLogger.error(`[attachments] failed to mark referenced: ${error instanceof Error ? error.message : String(error)}`);
        this.idempotencySet(user?.sub, clientMsgId, 'failed', '');
        this.sendChatRejected(ws, clientMsgId, 'attachment_state_failed', '附件状态保存失败，请重试');
        return;
      }
    }

    // 2026-08-04 P2：enqueue 路径（下方 enqueueRuntime 分支）会写带 runId 的权威
    // user_message_submitted；这里再写一条无 runId 的会造成同一消息双份 submitted
    // 事件（实证 fc3bf95a seq 75/76 等四对）。仅在 enqueue-only 运行时不可用的
    // 旧同步路径保留此兜底写入。
    const enqueueRuntimeEnabled = Boolean(this.config.enqueueRuntime) && this.config.enqueueRuntime?.enabled !== false;
    if (validSessionId && !enqueueRuntimeEnabled) {
      void this.appendDurableWebCommand(validSessionId, {
        type: 'user_message_submitted',
        sessionId: validSessionId,
        userId: user?.sub,
        clientMsgId,
        content: resolvedMessage,
      });
    }
    if (user && user.role !== 'admin' && this.config.loginLogFilePath) {
      appendLoginLog({
        timestamp: new Date().toISOString(),
        event: 'chat_message_sent',
        username: user.username,
        userId: user.sub,
        ip: client.ip || 'unknown',
        userAgent: client.userAgent || 'unknown',
        channel: detectLoginChannel(client.userAgent || ''),
        detail: buildChatMessageActivityDetail(validSessionId, attachments?.length ?? 0, voiceFile?.duration),
      }, this.config.loginLogFilePath).catch(() => {});
    }

    const enqueueRuntime = this.config.enqueueRuntime?.enabled === false ? undefined : this.config.enqueueRuntime;
    if (enqueueRuntime) {
      // 新会话用永久幂等键派生稳定 sessionId；跨进程重复提交即使同时越过预检，
      // 也只会 upsert 同一会话，不会留下竞争失败者的幽灵会话。
      const enqueueSessionId = validSessionId ?? deriveSubmissionSessionId(
        `${user?.tenantId ?? 'tenant'}|${user?.sub ?? 'anon'}`,
        clientMsgId,
      );
      if (attachments?.length && this.config.uploadManager && this.config.agentCwd
        && !(await bindChatAttachments(this.config.uploadManager, this.config.agentCwd, userIdentity, attachments, enqueueSessionId, clientMsgId))) { this.idempotencySet(user?.sub, clientMsgId, 'failed', ''); this.sendChatRejected(ws, clientMsgId, 'attachment_state_failed', '附件会话归属保存失败，请重试'); return; }
      const enqueueRunId = `${Date.now()}-${randomUUID()}`; const streamId = String(++this.streamIdCounter);
      let sessionPersisted = false;
      let titleOwnerId = userIdentity?.id; let durableAccepted = false;
      let durableAcceptedSessionId = enqueueSessionId; let durableAcceptedRunId = enqueueRunId;
      let durableAcceptedStreamId = streamId;
      let durableAcceptedDeliveryMode: 'queue' | 'steer' = deliveryMode;
      let durableAcceptedQueuedTargetRunId: string | undefined;
      try {
        const enqueueCwd = targetCwd || resolveUserCwd(this.config.agentCwd!, userIdentity);
        const existingSessionRecord = await enqueueRuntime.sessionCatalog.get(enqueueSessionId);
        // policy 必须在首条消息入队前 pin；先刷新共享配置，避免 Web 预建 Session
        // 把刚开启 delegation 的新会话永久写成 v1。
        this.config.refreshSharedConfig?.();
        const enqueueOwner = sessionOwner ?? userIdentity;
        titleOwnerId = enqueueOwner?.id;
        const enqueueWorkspaceId = existingSessionRecord?.workspaceId
          ?? deriveStableWorkspaceId(enqueueOwner, enqueueSessionId);
        const sessionRecord = createRuntimeSessionRecord({
          sessionId: enqueueSessionId,
          userId: enqueueOwner?.id,
          username: enqueueOwner?.username,
          userRole: enqueueOwner?.role,
          tenantId: enqueueOwner?.tenantId,
          channel: 'web',
          cwd: enqueueCwd,
          modelRef: model,
          executionTarget: resolvedExecutionTarget,
          workspaceId: enqueueWorkspaceId,
          status: 'running',
          ...(orgAgentId ? { orgAgentId } : {}),
          memoryPolicyVersion: resolveSessionMemoryPolicy({
            existing: existingSessionRecord,
            delegationEnabled: this.config.memoryWriteDelegationEnabled?.(enqueueOwner?.tenantId) === true,
            channel: 'web',
            ...(orgAgentId ? { orgAgentId } : {}),
          }),
        });
        if (existingSessionRecord) {
          await enqueueRuntime.sessionCatalog.upsert(sessionRecord);
        } else {
          // ensure 通过跨进程原子首写保证并发首投只能有一个 policy 胜出。
          await enqueueRuntime.sessionCatalog.ensure(sessionRecord);
        }
        sessionPersisted = true;
        // 门禁 uncertain/纯附件的 pass_flagged 落库：sessionId 到这里才确定
        flushPendingGuardrailEvent(enqueueSessionId);
        const controller = new AbortController();
        // Governance shadow：enqueue 前用统一 evaluator 产出 AccessDecision/Readiness
        // 对比证据。legacy adminExempt/audience 门禁仍是权威；shadow 失败只记日志。
        if (this.config.runPreflight) {
          try {
            const preflight = await this.config.runPreflight.preflight({
              phase: 'enqueue',
              runId: enqueueRunId,
              sessionId: enqueueSessionId,
              ...(enqueueOwner?.id ? { userId: enqueueOwner.id } : {}),
              ...(enqueueOwner?.tenantId ? { tenantId: enqueueOwner.tenantId } : {}),
              ...(orgAgentId ? { orgAgentId } : {}),
              modelRef: model,
              // enqueue 侧不做计费扣减（wake 由 legacy billing 权威执行），避免双结算。
              skipBilling: true,
            });
            if (!preflight.proceed) {
              throw new Error(
                `[${preflight.accessDecision.reasonCode}] governance enqueue preflight blocked`,
              );
            }
            if (preflight.shadowWouldBlock) {
              chatLogger.warn(
                `[governance-shadow] enqueue preflight would block run=${enqueueRunId} `
                + `access=${preflight.accessDecision.reasonCode} layer=${preflight.accessDecision.decisiveLayer} `
                + `blockers=${preflight.readiness.blockers.map(b => b.code).join(',') || 'none'}`,
              );
            }
          } catch (error) {
            const enforcing = await this.config.runPreflight.enforcementMode()
              .then(mode => mode === 'enforce')
              .catch(() => true);
            if (enforcing) throw error;
            chatLogger.warn(
              `[governance-shadow] enqueue preflight unavailable (not blocking): run=${enqueueRunId} `
              + `error=${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        const enqueuedRun = await enqueueRuntime.scheduler.enqueue({
          runId: enqueueRunId,
          sessionId: enqueueSessionId,
          userId: enqueueOwner?.id,
          submitterUserId: user?.sub,
          tenantId: enqueueOwner?.tenantId,
          model,
          channel: 'web',
          idempotencyKey: clientMsgId,
          executionTarget: resolvedExecutionTarget,
          workspaceId: enqueueWorkspaceId,
          metadata: {
            cwd: enqueueCwd,
            transcriptPath: sessionRecord.transcriptPath,
            streamId,
            clientMsgId,
            steeringAcceptedAt,
            ...(approvalPolicy ? { approvalPolicy } : {}),
            ...(guardrailMark ? { guardrail: guardrailMark } : {}),
            outputTransactionMode: context.outputTransactionMode,
            wakeMessage: {
              channel: inbound.channel,
              chatId: enqueueSessionId,
              content: inbound.content,
              attachments: inbound.attachments ?? [],
              ...(inbound.metadata ? { metadata: inbound.metadata } : {}),
            },
          },
        }, { deliveryMode });
        durableAccepted = true;
        const acceptedRunId = enqueuedRun.runId;
        const acceptedSessionId = enqueuedRun.sessionId;
        durableAcceptedRunId = acceptedRunId;
        durableAcceptedSessionId = acceptedSessionId;
        const duplicateSubmission = acceptedRunId !== enqueueRunId;
        const authoritative = resolveAuthoritativeSubmissionState(enqueuedRun);
        const acceptedStreamId = authoritative.streamId ?? (duplicateSubmission ? '' : streamId);
        const acceptedDeliveryMode = authoritative.deliveryMode;
        durableAcceptedStreamId = acceptedStreamId;
        durableAcceptedDeliveryMode = acceptedDeliveryMode;
        const queuedTargetRunId = authoritative.queuedTargetRunId;
        const steeringTargetRunId = acceptedDeliveryMode === 'steer' ? queuedTargetRunId : undefined;
        const queuedBehindRunId = acceptedDeliveryMode === 'queue' ? queuedTargetRunId : undefined;
        durableAcceptedQueuedTargetRunId = queuedTargetRunId;
        let queuePosition: number | undefined;
        if (queuedTargetRunId && enqueueRuntime.runStore.listPendingUserMessagesBySession) {
          try {
            const pendingMessages = await enqueueRuntime.runStore.listPendingUserMessagesBySession(acceptedSessionId);
            const pendingIndex = pendingMessages.findIndex((run) => run.runId === acceptedRunId);
            if (pendingIndex >= 0) queuePosition = pendingIndex + 1;
          } catch (queueError) {
            chatLogger.warn(`[chat] queue position lookup failed run=${acceptedRunId}: ${queueError instanceof Error ? queueError.message : String(queueError)}`);
          }
        }
        if (['completed', 'failed', 'cancelled', 'orphaned'].includes(enqueuedRun.status)) {
          // 跨进程同 clientMessageId 竞态：本请求命中另一请求已完成的原 run。
          // 返回原终态关联，不创建第二条 active stream / run / queue item。
          const terminalStatus = enqueuedRun.status === 'completed'
            ? 'completed'
            : enqueuedRun.status === 'cancelled'
              ? 'cancelled'
              : 'failed';
          this.idempotencySet(user?.sub, clientMsgId, terminalStatus === 'completed' ? 'done' : 'failed', acceptedStreamId, {
            sessionId: acceptedSessionId,
            runId: acceptedRunId,
            deliveryMode: acceptedDeliveryMode,
            terminalStatus,
          });
          this.sendChatAck(ws, clientMsgId, {
            sessionId: acceptedSessionId,
            runId: acceptedRunId,
            status: terminalStatus,
            deliveryMode: acceptedDeliveryMode,
          });
          this.eventBus!.emitReply(ws, { type: 'session', sessionId: acceptedSessionId, client_msg_id: clientMsgId });
          return;
        }

        if (duplicateSubmission) {
          // 并发重复提交命中原 run：只回放原 run 当前权威状态，不注册第二条本地 stream，
          // 也不重复追加事件或广播 queue item。
          this.idempotencySet(user?.sub, clientMsgId, 'in_flight', acceptedStreamId, {
            sessionId: acceptedSessionId,
            runId: acceptedRunId,
            deliveryMode: acceptedDeliveryMode,
            ...(queuedBehindRunId ? { queuedBehindRunId } : {}),
            ...(steeringTargetRunId ? { steeringTargetRunId } : {}),
          });
          this.wsSessionAffinity.set(ws, acceptedSessionId);
          this.sendChatAck(ws, clientMsgId, {
            sessionId: acceptedSessionId,
            runId: acceptedRunId,
            status: authoritative.status,
            deliveryMode: acceptedDeliveryMode,
            ...(queuePosition ? { queuePosition } : {}),
          });
          if (acceptedStreamId) {
            this.eventBus!.emitReply(ws, {
              type: 'stream_id',
              streamId: acceptedStreamId,
              sessionId: acceptedSessionId,
              runId: acceptedRunId,
              client_msg_id: clientMsgId,
              ...(queuedTargetRunId
                ? { queued: true, deliveryMode: acceptedDeliveryMode, targetRunId: queuedTargetRunId, ...(queuePosition ? { queuePosition } : {}) }
                : {}),
            });
          }
          this.eventBus!.emitReply(ws, { type: 'session', sessionId: acceptedSessionId, client_msg_id: clientMsgId });
          return;
        }

        this.activeStreams.set(acceptedStreamId, {
          controller,
          userId: user?.sub,
          ws,
          sessionId: acceptedSessionId,
          runId: acceptedRunId,
          clientMsgId,
        });
        this.idempotencySet(user?.sub, clientMsgId, 'in_flight', acceptedStreamId, {
          sessionId: acceptedSessionId,
          runId: acceptedRunId,
          deliveryMode: acceptedDeliveryMode,
          ...(queuedBehindRunId ? { queuedBehindRunId } : {}),
          ...(steeringTargetRunId ? { steeringTargetRunId } : {}),
        });
        // run + clientMessageId 已原子落库；事件投影失败不撤销 accepted，wakeMessage 与
        // message_submissions 仍能恢复。并发重复提交命中旧 run 时不重复追加事件。
        if (acceptedRunId === enqueueRunId) {
          await this.appendRuntimeEvent(sessionRecord.transcriptPath, {
            type: 'user_message_submitted',
            sessionId: acceptedSessionId,
            runId: acceptedRunId,
            streamId: acceptedStreamId,
            userId: user?.sub,
            clientMsgId,
            content: resolvedMessage,
          }, sessionRecord.tenantId).catch((eventError) => {
            chatLogger.warn(`[chat] accepted message event append failed run=${acceptedRunId}: ${eventError instanceof Error ? eventError.message : String(eventError)}`);
          });
          await this.appendRuntimeEvent(sessionRecord.transcriptPath, {
            type: 'run_enqueued',
            sessionId: acceptedSessionId,
            runId: acceptedRunId,
            userId: user?.sub,
            clientMsgId,
          }, sessionRecord.tenantId).catch((eventError) => {
            chatLogger.warn(`[chat] run_enqueued event append failed run=${acceptedRunId}: ${eventError instanceof Error ? eventError.message : String(eventError)}`);
          });
        }

        const send = (data: object) => this.eventBus!.emitReply(ws, data);
        this.wsSessionAffinity.set(ws, acceptedSessionId);
        if (!queuedTargetRunId) {
          this.wsActiveStream.set(ws, acceptedStreamId);
          this.eventBufferStore.create(acceptedSessionId, user?.sub);
        }
        this.sendChatAck(ws, clientMsgId, {
          sessionId: acceptedSessionId,
          runId: acceptedRunId,
          status: authoritative.status,
          deliveryMode: acceptedDeliveryMode,
          ...(queuePosition ? { queuePosition } : {}),
        });
        send({
          type: 'stream_id',
          streamId: acceptedStreamId,
          sessionId: acceptedSessionId,
          runId: acceptedRunId,
          client_msg_id: clientMsgId,
          ...(queuedTargetRunId ? { queued: true, deliveryMode: acceptedDeliveryMode, targetRunId: queuedTargetRunId, ...(queuePosition ? { queuePosition } : {}) } : {}),
        });
        send({ type: 'session', sessionId: acceptedSessionId, client_msg_id: clientMsgId });
        // 首条长消息不等待 Agent 输出；续聊时若仍无标题，也在本次输入后立即补偿。
        if (
          titleOwnerId
          && (Boolean(validSessionId) || shouldGenerateTitleFromFirstMessage(resolvedMessage))
        ) {
          void this.maybeGenerateTitleByUserId(acceptedSessionId, titleOwnerId, resolvedMessage);
        }
        // steering 排队的消息尚未被消费，不进会话事件流（buffer 里的 user_message 会被
        // 其他端/重连回放成一条普通「已发送」气泡，时间线交错且不可撤回——2026-08-04
        // 终态设计改为：排队期间只存在于队列区（steering_queued 广播 + detail API 恢复），
        // 被目标 run 吸收时由 durable user_message 投影进流。
        if ((userDisplayContent || attachmentMeta) && !queuedTargetRunId) {
          this.eventBufferStore.push(acceptedSessionId, JSON.stringify({
            type: 'user_message',
            content: userDisplayContent,
            ...(attachmentMeta ? { attachments: attachmentMeta } : {}),
            timestamp: Date.now(),
            client_msg_id: clientMsgId,
          }));
        }
        if (user?.sub && this.eventBus && queuedTargetRunId) {
          // 多端统一队列快照：普通 queue 与显式 steer 都广播，按 clientMsgId 幂等 upsert。
          this.eventBus.emitUser(user.sub, {
            type: 'message_queued',
            sessionId: acceptedSessionId,
            runId: acceptedRunId,
            clientMsgId,
            deliveryMode: acceptedDeliveryMode,
            targetRunId: queuedTargetRunId,
            ...(queuePosition ? { queuePosition } : {}),
            content: userDisplayContent ?? resolvedMessage,
            ...(attachmentMeta ? { attachments: attachmentMeta } : {}),
            timestamp: Date.now(),
          });
        }
        if (user?.sub && this.eventBus && !queuedTargetRunId) {
          this.eventBus.emitUser(user.sub, {
            type: 'stream_started',
            sessionId: acceptedSessionId,
            streamId: acceptedStreamId,
            runId: acceptedRunId,
          }, ws);
          this.eventBus.emitUser(user.sub, {
            type: 'session_status',
            sessionId: acceptedSessionId,
            status: 'queued',
            streamId: acceptedStreamId,
            runId: acceptedRunId,
          });
        }
        chatLogger.info(
          `[chat] enqueue-only accepted run=${acceptedRunId} session=${acceptedSessionId}`
          + ` client_msg_id=${clientMsgId} delivery=${acceptedDeliveryMode}`
          + (queuedTargetRunId ? ` queued_behind=${queuedTargetRunId}` : ''),
        );
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        let durableLookupAvailable = true;
        if (!durableAccepted) {
          // PostgreSQL 的 COMMIT 可能已生效但连接在回执前中断；先按永久幂等键反查，
          // 绝不能把“提交结果未知”直接改成 failed 并清掉 wakeMessage。
          const committedRun = await enqueueRuntime.runStore.findByIdempotencyKey(user?.sub, clientMsgId).catch(() => {
            durableLookupAvailable = false;
            return null;
          });
          if (committedRun) {
            durableAccepted = true;
            durableAcceptedRunId = committedRun.runId;
            durableAcceptedSessionId = committedRun.sessionId;
            durableAcceptedStreamId = typeof committedRun.metadata?.streamId === 'string'
              ? committedRun.metadata.streamId
              : streamId;
            durableAcceptedDeliveryMode = committedRun.metadata?.deliveryMode === 'steer' ? 'steer' : 'queue';
            durableAcceptedQueuedTargetRunId = typeof committedRun.metadata?.steeringTargetRunId === 'string'
              ? committedRun.metadata.steeringTargetRunId
              : typeof committedRun.metadata?.queuedBehindRunId === 'string'
                ? committedRun.metadata.queuedBehindRunId
                : undefined;
          }
        }
        if (durableAccepted) {
          // durable commit 之后的投影/广播失败不能反向把 run 改成 failed，更不能清 wakeMessage。
          // ACK 必须再次读取原 run 当前状态；读取失败时保持“结果未知”，交给客户端状态查询恢复。
          chatLogger.warn(`[chat] post-accept projection failed run=${durableAcceptedRunId}: ${errorMessage}`);
          const currentRun = await enqueueRuntime.runStore.get(durableAcceptedRunId).catch((lookupError) => {
            chatLogger.warn(`[chat] post-accept authority lookup failed run=${durableAcceptedRunId}: ${lookupError instanceof Error ? lookupError.message : String(lookupError)}`);
            return null;
          });
          if (!currentRun) return;
          const authoritative = resolveAuthoritativeSubmissionState(currentRun);
          const terminal = TERMINAL_RUN_STATUSES.has(currentRun.status);
          durableAcceptedSessionId = currentRun.sessionId;
          durableAcceptedStreamId = authoritative.streamId ?? '';
          durableAcceptedDeliveryMode = authoritative.deliveryMode;
          durableAcceptedQueuedTargetRunId = authoritative.queuedTargetRunId;
          this.idempotencySet(
            user?.sub,
            clientMsgId,
            authoritative.status === 'completed' ? 'done' : terminal ? 'failed' : 'in_flight',
            durableAcceptedStreamId,
            {
              sessionId: durableAcceptedSessionId,
              runId: durableAcceptedRunId,
              deliveryMode: durableAcceptedDeliveryMode,
              ...(durableAcceptedDeliveryMode === 'queue' && durableAcceptedQueuedTargetRunId
                ? { queuedBehindRunId: durableAcceptedQueuedTargetRunId }
                : {}),
              ...(durableAcceptedDeliveryMode === 'steer' && durableAcceptedQueuedTargetRunId
                ? { steeringTargetRunId: durableAcceptedQueuedTargetRunId }
                : {}),
              ...(terminal
                ? { terminalStatus: authoritative.status as 'completed' | 'failed' | 'cancelled' }
                : {}),
            },
          );
          this.sendChatAck(ws, clientMsgId, {
            sessionId: durableAcceptedSessionId,
            runId: durableAcceptedRunId,
            status: authoritative.status,
            deliveryMode: durableAcceptedDeliveryMode,
          });
          if (durableAcceptedStreamId && !terminal) {
            this.wsSend(ws, {
              type: 'stream_id',
              streamId: durableAcceptedStreamId,
              sessionId: durableAcceptedSessionId,
              runId: durableAcceptedRunId,
              client_msg_id: clientMsgId,
              ...(durableAcceptedQueuedTargetRunId
                ? { queued: true, deliveryMode: durableAcceptedDeliveryMode, targetRunId: durableAcceptedQueuedTargetRunId }
                : {}),
            });
          }
          this.wsSend(ws, { type: 'session', sessionId: durableAcceptedSessionId, client_msg_id: clientMsgId });
          return;
        }
        if (!durableLookupAvailable) {
          chatLogger.warn(`[chat] enqueue outcome unknown; client must verify client_msg_id=${clientMsgId}: ${errorMessage}`);
          return;
        }
        chatLogger.error(`[chat] enqueue-only failed: ${errorMessage}`);
        this.idempotencySet(user?.sub, clientMsgId, 'failed', streamId);
        this.activeStreams.delete(streamId);
        if (this.wsActiveStream.get(ws) === streamId) this.wsActiveStream.delete(ws);
        await enqueueRuntime.runStore.markStatus(enqueueRunId, 'failed', errorMessage).catch(() => null);
        if (sessionPersisted) {
          await enqueueRuntime.sessionCatalog.markStatus(enqueueSessionId, 'error').catch((statusError) => {
            chatLogger.warn(`[chat] failed to mark session error session=${enqueueSessionId}: ${statusError instanceof Error ? statusError.message : String(statusError)}`);
          });
          if (titleOwnerId) {
            void this.maybeGenerateTitleByUserId(enqueueSessionId, titleOwnerId, resolvedMessage, true);
          }
        }
        if (this.eventBus) {
          if (!validSessionId && sessionPersisted) {
            this.eventBus.emitReply(ws, { type: 'session', sessionId: enqueueSessionId, client_msg_id: clientMsgId });
          }
          this.eventBus.emitReply(ws, { type: 'done', client_msg_id: clientMsgId, error: errorMessage });
        } else {
          if (!validSessionId && sessionPersisted) {
            this.wsSend(ws, { type: 'session', sessionId: enqueueSessionId, client_msg_id: clientMsgId });
          }
          this.wsSend(ws, { type: 'done', client_msg_id: clientMsgId, error: errorMessage });
        }
      }
      return;
    }

    // 追踪本连接创建的 pending 交互 ID
    const activeInteractionIds = new Set<string>();
    // 连接级 controller：WS 断开时触发，用于自动拒绝 pending 交互
    const connectionAbortController = new AbortController();
    // 用户级 controller：仅在用户主动点击"停止"时触发，用于终止 Agent
    const userAbortController = new AbortController();
    const streamId = String(++this.streamIdCounter);
    this.activeStreams.set(streamId, { controller: userAbortController, userId: user?.sub, ws, sessionId: validSessionId, clientMsgId });
    this.wsActiveStream.set(ws, streamId);
    // 回填幂等记录的真实 streamId（之前占位为空）
    this.idempotencySet(user?.sub, clientMsgId, 'in_flight', streamId);

    // 会话硬超时兜底：runAgent 内已有 end_turn 时 stopTask 清扫机制，
    // 此 watchdog 是最后一道防线，防止 SDK 因未知原因（网络/子进程/bug）持续挂起。
    // 对齐 cron/service.ts:23 的 6h 兜底理念，web 更激进（用户可感知，3h 内会主动刷新）。
    const WEB_SESSION_HARD_TIMEOUT_MS = 3 * 3600_000;
    const watchdogTimer = setTimeout(() => {
      if (!userAbortController.signal.aborted) {
        chatLogger.warn(
          `Web session watchdog fired (stream=${streamId}, 3h hard limit); aborting`,
        );
        userAbortController.abort();
      }
    }, WEB_SESSION_HARD_TIMEOUT_MS);
    watchdogTimer.unref?.();

    const send = (data: object) => {
      // 仅当此流仍是该 WS 的活跃流时才直接推送（防止切换会话后旧流事件串入新会话）
      if (this.wsActiveStream.get(ws) === streamId) {
        this.eventBus!.emitReply(ws, data);
      }
    };

    // WS 连接关闭时标记连接断开并清理 pending 交互
    const onWsClose = () => {
      this.handleActiveStreamSocketClose(streamId, ws, connectionAbortController, activeInteractionIds);
    };
    ws.on('close', onWsClose);

    // 旧同步运行时没有 durable queue；到这里已绑定唯一执行流，才可确认 accepted。
    this.sendChatAck(ws, clientMsgId, { status: 'accepted', deliveryMode });
    // 将 streamId 作为首条事件发送给前端（透传 client_msg_id 以便客户端精确绑定 bubble）
    send({ type: 'stream_id', streamId, client_msg_id: clientMsgId });

    // 追踪当前会话 ID
    let resolvedSessionId: string | undefined = sessionId;

    // SDK warmup 过滤：CLI 在 session_init 之前会为内置 Agent（Explore/Plan/Bash）
    // 触发 SubagentStart hook 做 cache warming，这些事件不应转发给前端。
    let sessionInitialized = false;

    // 构造 hooks（交互侧通道）
    let resolvedTranscriptPath: string | undefined;
    const hooks: AgentRunHooks = {
      onSessionStart: async (sid, transcriptPath) => {
        resolvedSessionId = sid;
        resolvedTranscriptPath = transcriptPath;
        sessionInitialized = true;
        const streamEntry = this.activeStreams.get(streamId);
        if (streamEntry) streamEntry.sessionId = sid;
      },
      onResult: async (meta) => {
        // 现有：累计 session 级 cost 到 meta.json
        if (meta.totalCostUsd) {
          // 优先用 onSessionStart 传入的路径，否则通过 session ID 查找
          let tp = resolvedTranscriptPath;
          if (!tp && resolvedSessionId) {
            tp = (await findTranscriptOrMetaPathBySessionId(resolvedSessionId)) ?? undefined;
          }
          if (tp) {
            addSessionCost(tp, meta.totalCostUsd).catch(() => {});
          }
        }

        // 新增：写入 token_usage_daily（按操作者归属，按模型拆行）
        const tokenStore = this.config.tokenUsageStore;
        if (tokenStore && user && meta.modelUsage && Object.keys(meta.modelUsage).length > 0) {
          try {
            tokenStore.recordResult({
              username: user.username,
              // JwtPayload.tenantId 必填；闭包内 TS narrow 保守，兜底平台根组织。
              tenantId: user.tenantId ?? DEFAULT_TENANT_ID,
              channel: 'web',
              modelUsage: meta.modelUsage,
              occurredAtMs: Date.now(),
            });
          } catch (err) {
            chatLogger.warn(`[token-usage] web record failed: ${err instanceof Error ? err.message : String(err)}`);
            // 不阻塞业务流
          }
        }
      },

      onInteraction: async (event) => {
        // 用户主动停止 → 所有交互立即拒绝
        if (userAbortController.signal.aborted) {
          return { allow: false, message: 'User stopped generation' };
        }
        if (
          event.type === 'permission_request'
          && approvalPolicy?.autoApproveTools === true
          && user?.role === 'admin'
          && user.tenantId === DEFAULT_TENANT_ID
          && event.toolName
          && !INTERACTIVE_PERMISSION_TOOLS.has(event.toolName)
          && (!event.toolId || !INTERACTIVE_PERMISSION_TOOLS.has(event.toolId))
        ) {
          return { allow: true, message: 'auto-approved by policy' };
        }
        // 非平台用户（组织 admin + 普通用户）开启授权模式时走「沙箱审计后自动裁决」：
        // 免除的是人工确认，不豁免路径/命令安全审计；未开启授权模式则落到下方人工审批流程。
        if (
          event.type === 'permission_request'
          && user
          && !(user.role === 'admin' && user.tenantId === DEFAULT_TENANT_ID)
          && approvalPolicy?.autoApproveTools === true
        ) {
          // 安全工具：无路径风险，直接放行
          const safeTools = new Set([
            'Agent', 'Workflow',
            'WebFetch', 'WebSearch', 'Task',
            'Skill', 'AskUserQuestion',
            'EnterPlanMode', 'ExitPlanMode',
            'EnterWorktree', 'ExitWorktree',
            'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TaskStop', 'TaskOutput',
            'TodoWrite', 'ToolSearch',
            'CronCreate', 'CronDelete', 'CronList',
            'RemoteTrigger',
          ]);
          if (event.toolName && (
            safeTools.has(event.toolName)
            || event.toolName.startsWith('mcp__')
          )) {
            return { allow: true };
          }

          // Shell/Bash 工具：命令审计
          if (event.toolName === 'Bash' || event.toolName === 'Shell') {
            const command = (event.toolInput?.command as string) ?? '';

            // 环境变量探测命令拦截（纵深防御，主防线是不注入敏感变量 + OS 沙箱）
            if (/(?:^|[;&|]\s*)(?:env|printenv)(?:\s|$|;|\|)/.test(command)) {
              return { allow: false, message: '安全限制：不允许执行环境变量探测命令' };
            }

            const userCwd = resolveUserCwd(this.config.agentCwd!, {
              id: user.sub, username: user.username, role: user.role, tenantId: user.tenantId,
            });
            const userExtraDirs = getUserExtraDirs(this.config.userOverrides, user.username);
            const fileOps = /\b(?:cat|head|tail|less|more|cp|mv|rm|mkdir|rmdir|touch|chmod|chown|ln|tee|dd)\b/;
            const hasFileOp = fileOps.test(command);
            if (hasFileOp) {
              const absPaths = command.match(/(?:^|\s)(\/[^\s|>&;]+)/g)
                ?.map(p => p.trim())
                ?.filter(p => !p.startsWith('/dev/null')) ?? [];
              for (const absPath of absPaths) {
                if (!isPathWithinDirectory(absPath, userCwd) && !isPathWithinAnyDirectory(absPath, userExtraDirs)) {
                  return {
                    allow: false,
                    message: `安全限制：不允许对工作目录外的路径执行文件操作。检测到路径: ${absPath}，工作目录: ${userCwd}`,
                  };
                }
              }
            }
            const redirects = command.match(/>{1,2}\s*(\/[^\s|>&;]+)/g)
              ?.map(m => m.replace(/^>{1,2}\s*/, '')) ?? [];
            for (const rPath of redirects) {
              if (
                rPath !== '/dev/null'
                && !isPathWithinDirectory(rPath, userCwd)
                && !isPathWithinAnyDirectory(rPath, userExtraDirs)
              ) {
                return {
                  allow: false,
                  message: `安全限制：不允许将输出重定向到工作目录外。检测到路径: ${rPath}，工作目录: ${userCwd}`,
                };
              }
            }
            // 相对路径穿越检测（纵深防御，OS 沙箱是主防线）
            const traversalPaths = command.match(/(?:^|\s)(\.\.[\w/.~-]*|~[\w/.-]+)/g)
              ?.map(p => p.trim())
              ?.filter(p => p.startsWith('..') || p.startsWith('~')) ?? [];
            for (const relPath of traversalPaths) {
              const expanded = relPath.startsWith('~')
                ? relPath.replace(/^~/, homedir())
                : relPath;
              const resolved = resolvePath(userCwd, expanded);
              if (!isPathWithinDirectory(resolved, userCwd) && !isPathWithinAnyDirectory(resolved, userExtraDirs)) {
                return {
                  allow: false,
                  message: `安全限制：不允许对工作目录外的路径执行文件操作。检测到路径: ${relPath}，工作目录: ${userCwd}`,
                };
              }
            }
            return { allow: true };
          }

          // 文件类工具：路径字段映射
          const pathFields: Record<string, { field: string; optional?: boolean }> = {
            Read: { field: 'path' },
            Write: { field: 'path' },
            Edit: { field: 'file_path' },
            NotebookEdit: { field: 'notebook_path' },
          };

          const pathInfo = event.toolName ? pathFields[event.toolName] : undefined;
          if (pathInfo !== undefined) {
            const filePath = event.toolInput?.[pathInfo.field] as string | undefined;
            if (!filePath) {
              if (pathInfo.optional) return { allow: true };
              return { allow: false, message: 'Access denied: missing file path' };
            }
            const userCwd = resolveUserCwd(this.config.agentCwd!, {
              id: user.sub, username: user.username, role: user.role, tenantId: user.tenantId,
            });
            const userExtraDirs = getUserExtraDirs(this.config.userOverrides, user.username);
            const resolved = resolvePath(userCwd, filePath);
            if (isPathWithinDirectory(resolved, userCwd)) {
              const isWrite = event.toolName === 'Write' || event.toolName === 'Edit';
              if (isWrite) {
                const rel = resolved.slice(userCwd.length + 1);
                if (
                  rel === '.ky-agent/settings.json'
                  || rel === '.ky-agent/settings.local.json'
                  || rel === '.claude/settings.json'
                  || rel === '.claude/settings.local.json'
                ) {
                  return { allow: false, message: 'Access denied: cannot modify agent settings files' };
                }
              }
              return { allow: true };
            }
            if (isPathWithinAnyDirectory(resolved, userExtraDirs)) {
              return { allow: true };
            }
            if (this.config.agentCwd) {
              const sharedAgentDir = resolveAgentPath(this.config.sharedDir || this.config.agentCwd);
              const allowedSubdirs = ['skills', 'extension', 'scripts'];
              for (const sub of allowedSubdirs) {
                const allowed = resolvePath(sharedAgentDir, sub);
                if (isPathWithinDirectory(resolved, allowed)) {
                  return { allow: true };
                }
              }
            }
            return { allow: false, message: 'Access denied: path outside your workspace' };
          }

          // 未知工具：拒绝
          return { allow: false, message: 'Operation not permitted' };
        }
        // WS 断开：普通 permission_request 立即拒绝，ask_user 和 plan mode 存活等待重连
        const isPlanMode = event.type === 'permission_request'
          && (event.toolName === 'EnterPlanMode' || event.toolName === 'ExitPlanMode');
        if (connectionAbortController.signal.aborted && event.type !== 'ask_user' && !isPlanMode) {
          // 平台 admin 断连时自动放行（等同于 bypassPermissions 行为）；
          // 其他用户（含组织 admin）若未走上方授权模式自动裁决，说明其要求人工审批，
          // 断连时无法确认 → 拒绝。
          if (user?.role === 'admin' && user.tenantId === DEFAULT_TENANT_ID) {
            return { allow: true };
          }
          return { allow: false, message: 'WebSocket connection closed' };
        }
        // ExitPlanMode: 读取最新 plan 文件内容（按用户 cwd 隔离）
        let planContent: string | undefined;
        if (event.type === 'permission_request' && event.toolName === 'ExitPlanMode') {
          const effectiveUserCwd = user
            ? resolveUserCwd(this.config.agentCwd!, { id: user.sub, username: user.username, role: user.role, tenantId: user.tenantId })
            : undefined;
          planContent = (await readLatestPlanContent(effectiveUserCwd)) ?? undefined;
        }

        if (resolvedSessionId) {
          await this.appendDurableWebCommand(resolvedSessionId, {
            type: 'interaction_requested',
            sessionId: resolvedSessionId,
            ...(event.runId ? { runId: event.runId } : {}),
            ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
            ...(event.invocationId ? { invocationId: event.invocationId } : {}),
            interactionId: event.interactionId,
            interactionType: event.type,
            userId: user?.sub,
            toolId: event.toolId,
            toolName: event.toolName,
            displayName: event.displayName,
            questions: event.questions,
            toolInput: event.toolInput,
          }).catch((err: unknown) => {
            chatLogger.warn(`failed to persist interaction_requested: ${err instanceof Error ? err.message : String(err)}`);
          });
        }

        // WS 仍连接时正常推送事件给前端
        if (!connectionAbortController.signal.aborted) {
          send({
            type: event.type,
            interactionId: event.interactionId,
            toolId: event.toolId,
            toolName: event.toolName,
            displayName: event.displayName,
            toolInput: event.toolInput,
            questions: event.questions,
            ...(planContent ? { planContent } : {}),
          });
        }
        activeInteractionIds.add(event.interactionId);
        try {
          return await interactionStore.create(event.interactionId, event.type, {
            sessionId: resolvedSessionId,
            runId: event.runId,
            toolCallId: event.toolCallId,
            invocationId: event.invocationId,
            userId: user?.sub,
            orgAgentId,
            questions: event.questions,
            toolId: event.toolId,
            toolName: event.toolName,
            displayName: event.displayName,
            toolInput: event.toolInput,
            planContent,
          });
        } finally {
          activeInteractionIds.delete(event.interactionId);
        }
      },

      onSubagentStart: async (info) => {
        if (!sessionInitialized) return; // 过滤 warmup
        send({
          type: 'subagent_start',
          toolId: info.toolUseId,
          agentType: info.agentType,
        });
      },
      onSubagentEnd: async (info) => {
        if (!sessionInitialized) return; // 过滤 warmup
        send({
          type: 'subagent_end',
          toolId: info.toolUseId,
        });
      },
    };

    // per-session 串行锁
    const lockKey = validSessionId || streamId;
    const prevEntry = this.sessionLocks.get(lockKey);

    let releaseLock: () => void;
    const lockPromise = new Promise<void>((resolve) => { releaseLock = resolve; });
    const lockEntry = { promise: lockPromise, createdAt: Date.now() };
    this.sessionLocks.set(lockKey, lockEntry);
    const bufferCtx: { sessionId?: string; streamId?: string } = { streamId };

    try {
      if (prevEntry) {
        const LOCK_WAIT_TIMEOUT_MS = 2 * 60 * 1000;
        const lockAge = Date.now() - prevEntry.createdAt;
        const timeoutMs = Math.max(LOCK_WAIT_TIMEOUT_MS - lockAge, 0);
        const timedOut = Symbol('timedOut');
        const result = await Promise.race([
          prevEntry.promise,
          new Promise<typeof timedOut>(resolve => {
            const t = setTimeout(() => resolve(timedOut), timeoutMs);
            if (typeof t === 'object' && 'unref' in t) (t as NodeJS.Timeout).unref();
          }),
        ]);
        if (result === timedOut) {
          chatLogger.warn(`Session lock wait timeout for ${lockKey}, rejecting new chat`);
          this.idempotencySet(user?.sub, clientMsgId, 'failed', streamId);
          this.sendChatRejected(ws, clientMsgId, 'session_locked', '同会话上一条消息仍在处理，请稍后重试');
          return;
        }
      }
      if (connectionAbortController.signal.aborted || userAbortController.signal.aborted) {
        // C 修复：等待 session lock 期间被中断时，必须显式给客户端一个终态，
        // 否则 outbox 里这条消息会停在 acked 状态，只能靠 60s watchdog 兜底。
        // 同时更新幂等缓存到 failed 终态，允许用户同 id 重发。
        this.idempotencySet(user?.sub, clientMsgId, 'failed', streamId);
        this.sendChatRejected(
          ws,
          clientMsgId,
          'session_locked',
          userAbortController.signal.aborted ? '已取消' : '连接中断',
        );
        return;
      }

      // 解析模型引用
      const resolved = model && this.modelResolver ? this.modelResolver(model, user?.tenantId) : undefined;
      if (model && this.modelResolver && !resolved) {
        this.idempotencySet(user?.sub, clientMsgId, 'failed', streamId);
        this.sendChatRejected(ws, clientMsgId, 'model_not_allowed', '当前组织不可使用所选模型');
        return;
      }
      const modelOptions = resolved ? toRunModelOptions(resolved) : {};

      // 门禁 pass_flagged 落库（非 enqueue 路径：新会话 id 由 SDK 侧生成，此处只带续聊 id）
      flushPendingGuardrailEvent(validSessionId);
      const events = this.dispatch(inbound, context, {
        ...modelOptions,
        executionTarget: resolvedExecutionTarget,
        ...(approvalPolicy ? { approvalPolicy } : {}),
        ...(orgAgentId ? { orgAgentId } : {}),
        abortController: userAbortController,
      }, hooks);
      if (validSessionId) {
        bufferCtx.sessionId = validSessionId;
        this.eventBufferStore.create(validSessionId, user?.sub);
        // 注入用户消息到 buffer（其他设备 resume 时会 replay）
        if (userDisplayContent || attachmentMeta) {
          this.eventBufferStore.push(validSessionId, JSON.stringify({
            type: 'user_message',
            content: userDisplayContent,
            ...(attachmentMeta ? { attachments: attachmentMeta } : {}),
            timestamp: Date.now(),
            client_msg_id: clientMsgId,
          }));
        }
        // 续聊场景：广播 stream_started + session_status 到同用户的其他连接
        if (user?.sub && this.eventBus) {
          this.eventBus.emitUser(user.sub, {
            type: 'stream_started',
            sessionId: validSessionId,
            streamId,
          }, ws);
          this.eventBus.emitUser(user.sub, {
            type: 'session_status',
            sessionId: validSessionId,
            status: 'busy',
            streamId,
          });
        }
      }
      // titleCtx 每轮都构造：自动命名不再依赖"新会话"，续聊时若首轮命名失败可补救。
      // 是否新会话由独立的 isNewSession 标志承担（见 handleEvents 内部）。
      const titleCtx = {
        userMessage: resolvedMessage,
        userDisplayContent,
        attachmentMeta,
        clientMsgId,
        isNewSession: !validSessionId,
        getSessionId: () => resolvedSessionId,
      };
      if (validSessionId) {
        void this.maybeGenerateTitle(validSessionId, context, resolvedMessage, '');
      }
      await this.handleEvents(events, ws, context, userAbortController.signal, bufferCtx, titleCtx, model, clientMsgId);
    } catch (error) {
      chatLogger.error('处理消息错误:', error);
      // 外层兜底：发 done(error) 让客户端正常清 loading + 翻 bubble failed
      // 不再单发 error 事件（否则客户端只会加一条 text 气泡，pending 气泡永久卡住）
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.idempotencySet(user?.sub, clientMsgId, 'failed', streamId);
      const terminalSessionId = bufferCtx.sessionId ?? validSessionId ?? resolvedSessionId;
      send({
        type: 'done',
        ...(terminalSessionId ? { sessionId: terminalSessionId } : {}),
        streamId,
        client_msg_id: clientMsgId,
        error: errorMessage,
      });
      if (terminalSessionId) {
        void this.maybeGenerateTitle(terminalSessionId, context, resolvedMessage, '', true);
      }
    } finally {
      clearTimeout(watchdogTimer);
      ws.off('close', onWsClose);
      this.activeStreams.delete(streamId);
      if (bufferCtx?.sessionId) {
        this.eventBufferStore.complete(bufferCtx.sessionId);
        // 广播 idle 状态到所有连接
        if (user?.sub && this.eventBus) {
          this.eventBus.emitUser(user.sub, {
            type: 'session_status',
            sessionId: bufferCtx.sessionId,
            status: 'idle',
          });
        }
      }
      releaseLock!();
      if (this.sessionLocks.get(lockKey) === lockEntry) {
        this.sessionLocks.delete(lockKey);
      }
    }
  }

  /**
   * 门禁 off_topic 的合成气泡：前端看到一条正常 AI 文本回复（预设话术），
   * 刷新后仍在（legacy transcript 两行），**不创建 run、不写 runtime EventStore**
   * （保持模型上下文干净），幂等置 done。
   *
   * 事件序列（仿 enqueue accept + publishRuntimeOutboundEvent done 映射）：
   *   stream_id → session → user_message(buffer) → block_start → text → block_end
   *   → done → session_status(completed) → session_updated
   */
  private async handleGuardrailRejection(args: {
    ws: WebSocket;
    user: WsClient['user'];
    userIdentity: ChannelContext['user'];
    sessionOwner: ChannelContext['sessionOwner'];
    targetCwd?: string;
    validSessionId?: string;
    clientMsgId: string;
    orgAgent: OrgAgentRecord;
    model?: string;
    executionTarget: ExecutionTargetKind;
    resolvedMessage: string;
    userDisplayContent: string;
    attachmentMeta?: Array<{ name: string; isImage?: boolean; relativePath?: string }>;
    guardrailModel?: string;
    guardrailLatencyMs?: number;
    guardrailConfidence?: number;
  }): Promise<void> {
    const { ws, user, orgAgent } = args;
    const sessionId = args.validSessionId ?? randomUUID();
    const streamId = String(++this.streamIdCounter);
    const rejectionMessage = orgAgent.guardrail.rejectionMessage;
    const owner = args.sessionOwner ?? args.userIdentity;
    const cwd = args.targetCwd || resolveUserCwd(this.config.agentCwd!, args.userIdentity);
    const enqueueRuntime = this.config.enqueueRuntime?.enabled === false ? undefined : this.config.enqueueRuntime;

    // (a) enqueue 模式：session catalog upsert（status finished，无 run）——刷新后会话在列表可见
    let transcriptPath: string;
    if (enqueueRuntime) {
      const existing = args.validSessionId
        ? await enqueueRuntime.sessionCatalog.get(sessionId).catch(() => null)
        : null;
      const record = createRuntimeSessionRecord({
        sessionId,
        userId: owner?.id,
        username: owner?.username,
        userRole: owner?.role,
        tenantId: owner?.tenantId,
        channel: 'web',
        cwd,
        modelRef: args.model,
        executionTarget: args.executionTarget,
        workspaceId: existing?.workspaceId ?? deriveStableWorkspaceId(owner, sessionId),
        status: 'finished',
        orgAgentId: orgAgent.id,
      });
      transcriptPath = existing?.transcriptPath ?? record.transcriptPath;
      try {
        await enqueueRuntime.sessionCatalog.upsert({ ...record, transcriptPath });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        chatLogger.warn(`[guardrail] session upsert failed: ${errorMessage}`);
        if (!args.validSessionId) {
          this.idempotencySet(user?.sub, args.clientMsgId, 'failed', streamId);
          this.sendChatRejected(ws, args.clientMsgId, 'org_agent_unavailable', '企业专家会话创建失败，请重试');
          return;
        }
      }
    } else {
      transcriptPath = getTranscriptPath(cwd, sessionId, owner ? { tenantId: owner.tenantId, userId: owner.id } : undefined);
      // file backend 也要写 session meta（2026-07 审查 F2）：orgAgentId 绑定的事实源在 meta，
      // 不写则第二条消息 readSessionMeta 拿不到 orgAgentId → 静默回退个人 Agent 路径
      try {
        const existingMeta = await readSessionMeta(transcriptPath);
        const now = new Date().toISOString();
        await writeSessionMeta(transcriptPath, {
          ...(existingMeta ?? {}),
          userId: existingMeta?.userId ?? owner?.id ?? '',
          username: existingMeta?.username ?? owner?.username ?? '',
          ...(existingMeta?.tenantId ?? owner?.tenantId
            ? { tenantId: existingMeta?.tenantId ?? owner?.tenantId }
            : {}),
          channel: existingMeta?.channel ?? 'web',
          cwd: existingMeta?.cwd ?? cwd,
          orgAgentId: orgAgent.id,
          createdAt: existingMeta?.createdAt ?? now,
          updatedAt: now,
        });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        chatLogger.warn(`[guardrail] session meta write failed: ${errorMessage}`);
        if (!args.validSessionId) {
          this.idempotencySet(user?.sub, args.clientMsgId, 'failed', streamId);
          this.sendChatRejected(ws, args.clientMsgId, 'org_agent_unavailable', '企业专家会话创建失败，请重试');
          return;
        }
      }
    }

    // (b) guardrail_events 先落库拿 event id（员工申诉按 id 关联；2026-07-19 F2 收尾）。
    // await 一次 PG insert（拒答链路本就不启动主 Agent，几十 ms 可接受）；
    // 失败/无 store → undefined，气泡与 transcript 照发，仅申诉入口不渲染。
    const guardrailEventId = await this.insertGuardrailEvent({
      orgAgent,
      user,
      sessionId,
      clientMsgId: args.clientMsgId,
      verdict: 'off_topic',
      messageText: args.resolvedMessage.startsWith(VOICE_STT_TAG)
        ? args.resolvedMessage.slice(VOICE_STT_TAG.length)
        : args.resolvedMessage,
      model: args.guardrailModel,
      latencyMs: args.guardrailLatencyMs,
      confidence: args.guardrailConfidence,
    });

    // (c) legacy transcript 追加 user + assistant 两行（刷新后气泡仍在；
    // assistant 行顶层带 guardrailEventId → 历史重建后申诉入口仍可用）
    try {
      await this.appendGuardrailTranscript(transcriptPath, sessionId, args.resolvedMessage, rejectionMessage, guardrailEventId);
    } catch (err) {
      chatLogger.warn(`[guardrail] transcript append failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // (d) 幂等置 done（同 client_msg_id 重发不再触发）
    this.idempotencySet(user?.sub, args.clientMsgId, 'done', streamId, { sessionId });

    // (e) WS 合成气泡序列
    const sendReply = (data: object) => {
      if (this.eventBus) this.eventBus.emitReply(ws, data);
      else this.wsSend(ws, data);
    };
    sendReply({ type: 'stream_id', streamId, client_msg_id: args.clientMsgId });
    sendReply({ type: 'session', sessionId, client_msg_id: args.clientMsgId });
    this.eventBufferStore.create(sessionId, user?.sub);
    if (args.userDisplayContent || args.attachmentMeta) {
      this.eventBufferStore.push(sessionId, JSON.stringify({
        type: 'user_message',
        content: args.userDisplayContent,
        ...(args.attachmentMeta ? { attachments: args.attachmentMeta } : {}),
        timestamp: Date.now(),
        client_msg_id: args.clientMsgId,
      }));
    }
    this.wsActiveStream.set(ws, streamId);
    const sessionCtx: SessionContext = { sessionId, streamId, ws, userId: user?.sub };
    const emitSession = (data: object) => {
      if (this.eventBus) this.eventBus.emitSession(sessionCtx, data);
      else this.wsSend(ws, data);
    };
    emitSession({ type: 'block_start', blockType: 'text' });
    emitSession({
      type: 'text',
      content: rejectionMessage,
      ...(guardrailEventId ? { guardrailEventId } : {}),
    });
    emitSession({ type: 'block_end', blockType: 'text' });
    emitSession({ type: 'done', sessionId, streamId, client_msg_id: args.clientMsgId });
    this.eventBufferStore.complete(sessionId);
    if (user?.sub && this.eventBus) {
      this.eventBus.emitUser(user.sub, {
        type: 'session_status',
        sessionId,
        status: 'completed',
        streamId,
      });
      this.eventBus.emitDual(user.sub, sessionId, {
        type: 'session_updated',
        sessionId,
        updatedAtMs: Date.now(),
        preview: rejectionMessage.slice(0, 200),
      });
    }
    clearSessionsListCache();
    chatLogger.info(`[guardrail] off_topic rejected via synthetic bubble: session=${sessionId} orgAgent=${orgAgent.id} client_msg_id=${args.clientMsgId}`);
  }
  /**
   * 门禁拒绝的 legacy transcript 两行（格式照 legacyTranscriptProjection line builder）。
   * assistant 行顶层可带 guardrailEventId：parse.ts 透传到 text block →
   * 前端历史重建后申诉按钮仍拿得到真实 event id。
   */
  private async appendGuardrailTranscript(
    transcriptPath: string,
    sessionId: string,
    userContent: string,
    assistantContent: string,
    guardrailEventId?: string,
  ): Promise<void> {
    const lines = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: userContent },
      sessionId,
      timestamp: new Date().toISOString(),
    }) + '\n' + JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: assistantContent }] },
      sessionId,
      ...(guardrailEventId ? { guardrailEventId } : {}),
      timestamp: new Date().toISOString(),
    }) + '\n';
    await mkdir(dirname(transcriptPath), { recursive: true });
    await appendFile(transcriptPath, lines, 'utf-8');
  }

  /**
   * guardrail_events 落库（PG 不可用/未配置时降级 log，绝不阻塞聊天链路）。
   * 返回生成的 event id（员工申诉据此关联）；无 store / insert 失败返回 undefined。
   * fire-and-forget 调用点用 `void this.insertGuardrailEvent(...)` 即可，行为不变。
   */
  private async insertGuardrailEvent(args: {
    orgAgent: OrgAgentRecord;
    user: WsClient['user'];
    sessionId?: string;
    clientMsgId?: string;
    verdict: GuardrailEventVerdict;
    messageText: string;
    model?: string;
    latencyMs?: number;
    confidence?: number;
  }): Promise<string | undefined> {
    const store = this.config.guardrailEventStore;
    if (!store) {
      chatLogger.info(`[guardrail] event not persisted (no PG store): verdict=${args.verdict} orgAgent=${args.orgAgent.id} session=${args.sessionId ?? 'n/a'}`);
      return undefined;
    }
    try {
      return await store.insert({
        tenantId: args.orgAgent.tenantId,
        orgAgentId: args.orgAgent.id,
        ...(args.user?.sub ? { userId: args.user.sub } : {}),
        ...(args.user?.username ? { username: args.user.username } : {}),
        ...(args.sessionId ? { sessionId: args.sessionId } : {}),
        ...(args.clientMsgId ? { clientMsgId: args.clientMsgId } : {}),
        verdict: args.verdict,
        messageText: args.messageText.slice(0, 2000),
        ...(args.model ? { model: args.model } : {}),
        ...(args.latencyMs !== undefined ? { latencyMs: args.latencyMs } : {}),
        ...(args.confidence !== undefined ? { confidence: args.confidence } : {}),
      });
    } catch (err) {
      chatLogger.warn(`[guardrail] event insert failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  async stop(): Promise<void> {
    if (this.lockCleanupTimer) {
      clearInterval(this.lockCleanupTimer);
    }
    for (const [, { controller }] of this.activeStreams) {
      controller.abort();
    }
    this.activeStreams.clear();
    this.sessionLocks.clear();
    this.eventBufferStore.destroy();
    this.wsServer?.destroy();
  }

  /**
   * 消费事件流，通过 WebSocket 推送给前端。
   *
   * VOICE 标记智能缓冲策略：
   * - 文本以 [VOICE 开头时进入缓冲模式，不立即推送
   * - text block 结束后判断：
   *   - 纯 VOICE 内容 → 只发 voice 事件（standalone），不发文本
   *   - 混合内容 → 发清理后的文本 + voice 事件
   * - 文本不以 [VOICE 开头 → 正常流式推送，结尾 VOICE 标记在 onTextEnd 处理
   */
  /**
   * 自动命名核心 IO：解析 cwd → 读 meta 防覆盖 → 读 transcript 抽前两轮 →
   * 调上游模型 → 落 meta.generatedTitle。首条长消息、续聊补偿、所有终态与
   * 跨进程 durable 终态共用；会话级 in-flight 仅合并并发，失败后仍可重试。
   */
  private async markSessionUnread(input: {
    userId: string;
    sessionId: string;
    eventKey: string;
    broadcastEvenIfUnchanged?: boolean;
  }): Promise<void> {
    // 任务看板执行会话完成时不应作为未读提醒；执行中请求用户介入仍沿用未读提醒。
    if (input.sessionId.startsWith('taskboard-') && input.eventKey.startsWith('done:')) return;
    const store = this.config.sessionReadStateStore;
    const user = this.config.userStore?.findById(input.userId);
    if (!store) return;
    const tenantId = user?.tenantId ?? DEFAULT_TENANT_ID;
    if (!tenantId) return;
    try {
      const changed = await store.markUnread({
        tenantId,
        userId: input.userId,
        sessionId: input.sessionId,
        eventKey: input.eventKey,
      });
      if (!changed && !input.broadcastEvenIfUnchanged) return;
      // PG runtime event 会投递到每个 Web 进程；跨进程路径即使数据库幂等更新只由
      // 一个进程命中，也要在每个进程广播，才能覆盖连接在不同进程上的设备。
      this.eventBus?.emitUser(input.userId, {
        type: 'session_read_state_changed',
        sessionId: input.sessionId,
        hasUnreadAiReply: true,
      });
    } catch (err) {
      chatLogger.warn(`Failed to mark session unread ${input.sessionId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private readonly titleGenerationInFlight = new Map<string, Promise<string | null>>();

  private async resolveTitleForSession(
    sessionId: string,
    userInfo: { id: string; username: string; role: string; tenantId?: string },
    fallbackUserMessage = '',
    fallbackAssistantReply = '',
    retryAfterInFlightFailure = false,
  ): Promise<string | null> {
    const existing = this.titleGenerationInFlight.get(sessionId);
    if (existing) {
      const title = await existing;
      if (title || !retryAfterInFlightFailure) return title;
      // 终态若撞上首条消息的在途生成，且该次失败，补偿重试一次。
      return this.resolveTitleForSession(
        sessionId,
        userInfo,
        fallbackUserMessage,
        fallbackAssistantReply,
      );
    }

    const generation = this.generateTitleForSession(
      sessionId,
      userInfo,
      fallbackUserMessage,
      fallbackAssistantReply,
    ).then((title) => {
      if (title) {
        this.eventBus?.emitDual(userInfo.id, sessionId, {
          type: 'title_updated',
          sessionId,
          title,
        });
        clearSessionsListCache();
      }
      return title;
    });
    const tracked = generation.finally(() => {
      if (this.titleGenerationInFlight.get(sessionId) === tracked) {
        this.titleGenerationInFlight.delete(sessionId);
      }
    });
    this.titleGenerationInFlight.set(sessionId, tracked);
    return tracked;
  }

  private async generateTitleForSession(
    sessionId: string,
    userInfo: { id: string; username: string; role: string; tenantId?: string },
    fallbackUserMessage = '',
    fallbackAssistantReply = '',
  ): Promise<string | null> {
    this.config.refreshSharedConfig?.();
    const titleConfigs = this.config.titleGeneratorConfigs;
    const agentCwd = this.config.agentCwd;
    if (!titleConfigs?.length || !agentCwd) return null;
    try {
      const userCwd = resolveUserCwd(agentCwd, {
        id: userInfo.id,
        username: userInfo.username,
        role: userInfo.role as 'admin' | 'user',
        tenantId: userInfo.tenantId,
      });
      const transcriptPath = getTranscriptPath(userCwd, sessionId, { tenantId: userInfo.tenantId, userId: userInfo.id });
      const meta = await readSessionMeta(transcriptPath);
      // 没有 meta 无法持久化，等 session 初始化/后续终态再次触发；已有命名不覆盖。
      if (!meta || meta.customTitle || meta.generatedTitle) return null;

      // 优先从 transcript 读首两轮（命名素材稳定，与手动 /auto-title 一致）；
      // 极早期 transcript 还没落盘时退回本轮 fallback。
      const ctx = await extractTitleContext(transcriptPath).catch(() => null);
      const userMessage = ctx?.userMessages[0] || fallbackUserMessage;
      const assistantReply = ctx?.assistantReplies[0] || fallbackAssistantReply;
      if (!userMessage) return null;

      const utilityBilling = await this.config.billingService?.()?.beginUtilityModelRun({
        tenantId: userInfo.tenantId ?? DEFAULT_TENANT_ID,
        userId: userInfo.id,
        username: userInfo.username,
        sessionId,
        channel: 'title',
      });
      let title: string | null;
      try {
        title = await generateTitleWithFallback(
          userMessage, assistantReply, titleConfigs,
          ctx?.userMessages[1], ctx?.assistantReplies[1],
          {
            systemPrompt: this.config.getTitleSystemPrompt?.(),
            modelAdapterFactory: this.config.titleModelAdapterFactory,
            runtimeContext: { sessionId, tenantId: userInfo.tenantId, cwd: userCwd },
            beforeModelCall: () => utilityBilling?.beforeModelCall(),
            onUsage: async (model, usage) => {
              await utilityBilling?.recordUsage(model, usage);
              const tokenStore = this.config.tokenUsageStore;
              if (!tokenStore) return;
              try {
                tokenStore.recordResult({
                  username: userInfo.username,
                  tenantId: userInfo.tenantId ?? DEFAULT_TENANT_ID,
                  channel: 'title',
                  modelUsage: { [model]: usage },
                  occurredAtMs: Date.now(),
                });
              } catch (err) {
                chatLogger.warn(`[token-usage] title record failed: ${err instanceof Error ? err.message : String(err)}`);
              }
            },
          },
        );
      } finally {
        await utilityBilling?.finalize();
      }
      if (title) {
        const updatedMeta = await updateSessionMeta(transcriptPath, { generatedTitle: title });
        if (!updatedMeta) {
          chatLogger.warn(`Generated title was not persisted because session meta is missing: ${sessionId}`);
          return null;
        }
        chatLogger.info(`Generated title for session ${sessionId}: ${title}`);
        return title;
      }
    } catch (err) {
      chatLogger.warn(`Failed to generate title for session ${sessionId}:`, err);
    }
    return null;
  }

  private async maybeGenerateTitle(
    sessionId: string,
    context: ChannelContext,
    fallbackUserMessage: string,
    fallbackAssistantReply: string,
    retryAfterInFlightFailure = false,
  ): Promise<string | null> {
    const owner = context.sessionOwner ?? context.user;
    if (!owner) return null;
    return this.resolveTitleForSession(
      sessionId,
      {
        id: owner.id,
        username: owner.username,
        role: owner.role,
        tenantId: owner.tenantId,
      },
      fallbackUserMessage,
      fallbackAssistantReply,
      retryAfterInFlightFailure,
    );
  }

  /**
   * enqueue-only / cross-process 路径专用：只有 userId 时按 UserStore 反查
   * username/role/tenantId 再走 resolveTitleForSession。userStore 缺失或查不到
   * 用户则放弃命名（无法解析物理 cwd）。
   */
  private async maybeGenerateTitleByUserId(
    sessionId: string,
    userId: string,
    fallbackUserMessage = '',
    retryAfterInFlightFailure = false,
  ): Promise<string | null> {
    if (!this.userStore) return null;
    const userRecord = this.userStore.findById(userId);
    if (!userRecord) return null;
    return this.resolveTitleForSession(sessionId, {
      id: userRecord.id,
      username: userRecord.username,
      role: userRecord.role,
      tenantId: userRecord.tenantId,
    }, fallbackUserMessage, '', retryAfterInFlightFailure);
  }

  private handleEvents(
    events: AsyncGenerator<OutboundEvent>,
    ws: WebSocket,
    context: ChannelContext,
    signal?: AbortSignal,
    bufferCtx?: { sessionId?: string; streamId?: string },
    titleCtx?: WebChannelEventTitleContext,
    modelRef?: string,
    clientMsgId?: string,
  ): Promise<void> {
    return handleWebChannelEvents({
      displayConfig: this.displayConfig,
      agentCwd: this.config.agentCwd,
      tenantStore: this.config.tenantStore,
      eventBus: this.eventBus!,
      eventBufferStore: this.eventBufferStore,
      setIdempotency: (userId, messageId, status, streamId) => this.idempotencySet(userId, messageId, status, streamId),
      generateTitle: (sessionId, ctx, userMessage, reply, retry) => this.maybeGenerateTitle(sessionId, ctx, userMessage, reply, retry),
    }, events, ws, context, signal, bufferCtx, titleCtx, modelRef, clientMsgId);
  }
}

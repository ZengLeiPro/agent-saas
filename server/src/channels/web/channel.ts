/**
 * Web Channel
 *
 * 处理 Web 前端的聊天请求，通过 WebSocket 推送 Agent 事件流。
 * 支持交互式事件（权限确认、AskUser 提问）的双向通信。
 *
 * WS 消息协议见 wsTypes.ts。
 */

import { appendFile, mkdir, readdir, readFile, stat } from 'fs/promises';
import { randomUUID } from 'crypto';
import { homedir } from 'os';
import { dirname, join, resolve as resolvePath } from 'path';
import type { Express } from 'express';
import type { WebSocket } from 'ws';
import {
  shouldSendWebBlock,
  shouldSendWebToolResult,
  getWebDisplayConfig,
  isDedicatedWebTool,
} from './displayFilter.js';
import { chatLogger } from '../../utils/logger.js';
import { parseVoiceMarkers } from '../../utils/voiceMarkers.js';
import { FILE_MARKER_PATTERN, MEDIA_MARKER_CLEAN_RE } from '../../integrations/dingtalk/constants.js';
import type {
  WebMessageDisplayConfig,
  BaseChannel,
  InboundMessage,
  ChannelContext,
  UploadedFileInfo,
  OutboundEvent,
  ContextUsageData,
} from '../../types/index.js';
import type { AgentRunDispatch, AgentRunHooks } from '../../agent/types.js';
import type { ExecutionTargetKind } from '../../agent/toolRuntime.js';
import { toRunModelOptions, type ResolvedModel } from '../../app/models.js';
import { createEventConsumer, type EventHandler } from '../eventConsumer.js';
import { interactionStore } from './interactionStore.js';
import { getTranscriptPath, sessionExists, findTranscriptOrMetaPathBySessionId, deleteSession } from '../../data/transcripts/index.js';
import { readSessionMeta, writeSessionMeta, updateSessionMeta, addSessionCost, type SessionMeta } from '../../data/transcripts/meta.js';
import { resolveUserCwd } from '../../workspace/resolver.js';
import { agentPath, resolveAgentPath } from '../../workspace/namespace.js';
import type { UserStore } from '../../data/users/store.js';
import type { TenantStore } from '../../data/tenants/store.js';
import { tenantAccessErrorMessage } from '../../data/tenants/access.js';
import { speechToText, type SttConfig } from '../../integrations/stt/sttClient.js';
import { EventBufferStore } from './eventBuffer.js';
import { clearSessionsListCache } from '../../routes/sessions.js';
import { extractTitleContext, generateTitleWithFallback, type TitleGeneratorConfig } from '../../agent/titleGenerator.js';
import { checkTopicScope, extractRecentUserMessages, type GuardrailModelConfig } from '../../agent/guardrail.js';
import { isCompactCommand } from '../../agent/prompt.js';
import { isAssignedToOrgAgent, type OrgAgentStore } from '../../data/orgAgents/store.js';
import type { OrgAgentRecord } from '../../data/orgAgents/types.js';
import type { GuardrailEventStore, GuardrailEventVerdict } from '../../data/guardrail/pgGuardrailEventStore.js';
import { WsServer, type WsClient } from './wsServer.js';
import { EventBus, type SessionContext } from './eventBus.js';
import type { WsChatMessage, WsRespondMessage, WsAbortMessage, WsRunStatusMessage, WsResumeMessage, WsSyncMessage, WsInboundMessage, ChatRejectReasonCode } from './wsTypes.js';
import { appendLoginLog, detectLoginChannel } from '../../data/login-logs/index.js';
import {
  getUserExtraDirs,
  isPathWithinAnyDirectory,
  isPathWithinDirectory,
  type UserOverrides,
} from '../../security/extraDirs.js';
import type { TokenUsageStore } from '../../data/usage/store.js';
import { EventBackedApprovalStore } from '../../runtime/approvalStore.js';
import { FileEventStore, getRuntimeEventLogPath } from '../../runtime/fileEventStore.js';
import type { EventStore, PlatformEvent } from '../../runtime/types.js';
import { buildRuntimeReplayState } from '../../runtime/replay.js';
import { Semaphore } from '../../runtime/fileReadCoalesce.js';
import type { RawApprovalResumeRequest } from '../../runtime/rawRuntimeRunDispatch.js';
import {
  DEFAULT_EXECUTION_CONFIG,
  resolveExecutionTarget,
  type ExecutionConfig,
} from '../../runtime/executionConfig.js';
import { createRuntimeSessionRecord, type SessionCatalog } from '../../runtime/sessionCatalog.js';
import { deriveStableWorkspaceId } from '../../runtime/workspaceIdentity.js';
import type { RuntimeScheduler } from '../../runtime/scheduler.js';
import type { RunStore } from '../../runtime/runStore.js';
import type { ToolInvocationStore } from '../../runtime/toolInvocationStore.js';
import { DEFAULT_TENANT_ID } from '../../data/tenants/types.js';
import { isPlatformAdmin } from '../../auth/types.js';
import { runtimeRunController } from '../../runtime/runController.js';
import {
  buildPendingInteractionsFromEvents,
  normalizeInteractionResponse,
} from '../../runtime/interactionProjection.js';

/**
 * 跨 session 的 approval resume 并发兜底（cap=8）。
 * fileReadCoalesce 已经 dedup 了同文件并发；这里限制跨文件场景下
 * 同时进入 tryResumePersistedApproval 的会话数，避免 EMFILE 在 SaaS
 * 多 session 突发时被打穿。
 */
const approvalResumeSemaphore = new Semaphore(8);

function canViewContextUsageDetails(context: ChannelContext, tenantStore: TenantStore | undefined): boolean {
  return canViewContextUsageDetailsForUser(context.user, tenantStore);
}

function canViewContextUsageDetailsForUser(
  user: { tenantId?: string } | undefined,
  tenantStore: TenantStore | undefined,
): boolean {
  if (!user?.tenantId) return false;
  const settings = tenantStore?.getSettings(user.tenantId);
  return settings?.models.showContextTokens !== false
    && settings?.models.allowContextTokenDetails === true;
}

/** WsUser（tenantId 可选）适配 auth/types 的 isPlatformAdmin（JwtPayload tenantId 必选）。 */
function isPlatformAdminUser(user: WsClient['user']): boolean {
  if (!user?.tenantId) return false;
  return isPlatformAdmin({ sub: user.sub, username: user.username, role: user.role, tenantId: user.tenantId });
}

function redactContextUsageDetails(usage: ContextUsageData): ContextUsageData {
  return {
    ...usage,
    categories: [],
    memoryFiles: [],
    mcpTools: [],
  };
}

const INTERACTIVE_PERMISSION_TOOLS = new Set([
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'RequestPluginInstall',
]);

const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled', 'orphaned']);

/** 语音转写前缀标记（STT 注入 / 门禁判定前剥离共用） */
const VOICE_STT_TAG = '[这是一条语音转文字的消息，可能存在识别准确度问题] ';

function wantsToolAutoApproval(policy: { autoApproveTools?: boolean; autoApproveRunShell?: boolean } | undefined): boolean {
  return policy?.autoApproveTools === true || policy?.autoApproveRunShell === true;
}

export type ModelResolver = (ref: string, tenantId?: string) => ResolvedModel | null;

export interface WebChannelConfig {
  timezone?: string;
  displayConfig?: WebMessageDisplayConfig;
  agentCwd?: string;
  sharedDir?: string;
  loginLogFilePath?: string;
  modelResolver?: ModelResolver;
  userStore?: UserStore;
  /** 主 + fallback 链；主返回空或异常时按顺序回落，全部失败再 return null。 */
  titleGeneratorConfigs?: TitleGeneratorConfig[];
  sttConfig?: SttConfig;
  jwtSecret?: string;
  userOverrides?: UserOverrides;
  /** 优雅关闭（drain）状态回调，由 ChannelManager 注入；draining 时拒绝新 chat */
  getIsDraining?: () => boolean;
  /** Token 用量统计 store（可选，注入失败时静默跳过统计） */
  tokenUsageStore?: TokenUsageStore;
  /** Tenant store for disabled-tenant hard-stop checks. */
  tenantStore?: TenantStore;
  /** Browser WebSocket Origin allowlist，复用 HTTP CORS origins。 */
  allowedOrigins?: string[];
  /** 公司级专职 Agent store（orgAgentId 解析/audience 校验/门禁配置来源）。 */
  orgAgentStore?: OrgAgentStore;
  /**
   * 门禁模型配置链 getter（主 + fallback）。**必须是 getter**：模型列表热更新
   * 时 routes.ts 换新数组，channel 每次调用取最新链——避开 titleGeneratorConfigs
   * 构造时捕获旧数组引用的 stale 坑。空数组/缺省 = 门禁模块未激活（fail-open 短路）。
   */
  getGuardrailModelConfigs?: () => GuardrailModelConfig[];
  /** 门禁事件落库（PG backend）。缺省（file backend）时降级 log，判定照常。 */
  guardrailEventStore?: GuardrailEventStore;
  /** 门禁调用参数（maxRecentRounds 现表示最近真实用户消息数，配置键为兼容历史保留）。 */
  guardrailOptions?: { timeoutMs?: number; maxRecentRounds?: number };
  /** raw runtime 持久化 approval 的恢复入口 */
  resumeApprovalDispatch?: (request: RawApprovalResumeRequest) => AsyncGenerator<OutboundEvent>;
  /**
   * Runtime-level execution config；未传时使用 DEFAULT_EXECUTION_CONFIG（server-local 默认 + admin override 允许）。
   * 所有 executionTarget 策略集中到 resolveExecutionTarget，不再在通道内联判定。
   */
  executionConfig?: ExecutionConfig;
  /**
   * Runtime EventStore 解析函数。WS 重连恢复持久化 approval 时（tryResumePersistedApproval）
   * 用它拿到当前 session 的事件流。
   * - PG backend：返回共享 pgEventStore（按 session_id 过滤）
   * - file backend / 缺省：`new FileEventStore(getRuntimeEventLogPath(transcriptPath))`
   * 注入路径见 app/runtime.ts。
   */
  runtimeEventStoreFor?: (transcriptPath: string) => EventStore;
  /**
   * Web chat enqueue-only runtime. 配置后，Web chat 默认只创建 durable
   * session/run/command event，然后交给 RuntimeScheduler wake；WebSocket 仅返回
   * stream/session id 并订阅后续事件，不直接持有长 run 生命周期。
   */
  enqueueRuntime?: {
    scheduler: RuntimeScheduler;
    runStore: RunStore;
    sessionCatalog: SessionCatalog;
    toolInvocationStore?: ToolInvocationStore;
    enabled?: boolean;
  };
}

/** 读取用户 workspace 内最近生成的 plan 文件内容。 */
async function readLatestPlanContent(userCwd?: string): Promise<string | null> {
  if (!userCwd) return null;
  const candidates = [agentPath(userCwd, 'plans')];

  try {
    const now = Date.now();
    let latest = { name: '', mtime: 0, dir: '' };

    for (const plansDir of candidates) {
      let files: string[];
      try { files = await readdir(plansDir); } catch { continue; }
      const mdFiles = files.filter(f => f.endsWith('.md'));
      for (const f of mdFiles) {
        const s = await stat(join(plansDir, f));
        // 只取最近 60s 内修改的文件，减少串线概率
        if (s.mtimeMs > latest.mtime && (now - s.mtimeMs) < 60_000) {
          latest = { name: f, mtime: s.mtimeMs, dir: plansDir };
        }
      }
    }

    if (!latest.name) return null;
    return await readFile(join(latest.dir, latest.name), 'utf-8');
  } catch {
    return null;
  }
}

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
  async getStreamStatus(sessionId: string): Promise<{ active: boolean; streamId?: string; runId?: string }> {
    try {
      const runStore = this.config.enqueueRuntime?.runStore;
      if (runStore?.getActiveBySession) {
        const activeRun = await runStore.getActiveBySession(sessionId);
        if (activeRun) {
          const streamId = this.findActiveStreamIdBySession(sessionId)
            ?? (typeof activeRun.metadata?.streamId === 'string' ? activeRun.metadata.streamId : undefined);
          return { active: true, ...(streamId ? { streamId } : {}), runId: activeRun.runId };
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
  private idempotencyCache = new Map<string, { streamId: string; status: 'in_flight' | 'done' | 'failed'; at: number; sessionId?: string; runId?: string }>();
  private static readonly IDEMPOTENCY_MAX = 500;
  private static readonly IDEMPOTENCY_TTL_MS = 60_000;
  private idempotencyGet(userId: string | undefined, clientMsgId: string): { streamId: string; status: 'in_flight' | 'done' | 'failed'; sessionId?: string; runId?: string } | undefined {
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
    };
  }
  private idempotencySet(
    userId: string | undefined,
    clientMsgId: string,
    status: 'in_flight' | 'done' | 'failed',
    streamId: string,
    meta: { sessionId?: string; runId?: string } = {},
  ): void {
    const key = `${userId ?? 'anon'}|${clientMsgId}`;
    this.idempotencyCache.set(key, {
      streamId,
      status,
      at: Date.now(),
      ...(meta.sessionId ? { sessionId: meta.sessionId } : {}),
      ...(meta.runId ? { runId: meta.runId } : {}),
    });
    // LRU 驱逐
    while (this.idempotencyCache.size > WebChannel.IDEMPOTENCY_MAX) {
      const firstKey = this.idempotencyCache.keys().next().value;
      if (firstKey === undefined) break;
      this.idempotencyCache.delete(firstKey);
    }
  }

  /** 发送消息 ACK（服务端已接收并通过基础校验） */
  private sendChatAck(ws: WebSocket, clientMsgId: string): void {
    if (ws.readyState !== ws.OPEN) return;
    if (this.eventBus) {
      this.eventBus.emitReply(ws, { type: 'chat_ack', client_msg_id: clientMsgId, server_recv_ts: Date.now() });
    } else {
      this.wsSend(ws, { type: 'chat_ack', client_msg_id: clientMsgId, server_recv_ts: Date.now() });
    }
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
    const assigned = !!record && (adminExempt || isAssignedToOrgAgent(record, assignedUsername ?? actor?.username));
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
        this.eventBufferStore.create(input.sessionId, input.userId);
        emitSession({ type: 'session', sessionId: input.event.sessionId ?? input.sessionId, ...(input.clientMsgId ? { client_msg_id: input.clientMsgId } : {}) });
        if (input.userId) {
          this.eventBus.emitUser(input.userId, {
            type: 'session_status',
            sessionId: input.sessionId,
            status: 'running',
            streamId,
            runId: input.runId,
          });
        }
        break;
      case 'text_start':
        emitSession({ type: 'block_start', blockType: 'text' });
        break;
      case 'text_delta':
        emitSession({ type: 'text', content: input.event.content ?? '' });
        break;
      case 'text_end':
        emitSession({ type: 'block_end', blockType: 'text' });
        break;
      case 'thinking_start':
        emitSession({ type: 'block_start', blockType: 'thinking' });
        break;
      case 'thinking_delta':
        emitSession({ type: 'thinking', content: input.event.content ?? '' });
        break;
      case 'thinking_end':
        emitSession({ type: 'block_end', blockType: 'thinking' });
        break;
      case 'tool_start':
        if (isDedicatedWebTool(input.event.toolName)) break;
        emitSession({
          type: 'block_start',
          blockType: 'tool_use',
          toolId: input.event.toolId,
          toolName: input.event.toolName,
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
        if (isDedicatedWebTool(input.event.toolName)) break;
        emitSession({
          type: 'tool_result',
          toolId: input.event.toolId,
          toolName: input.event.toolName,
          result: input.event.toolResult ?? '',
          content: input.event.toolResult ?? '',
          ...(input.event.isError ? { isError: true } : {}),
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
        emitSession({ type: 'done', client_msg_id: input.clientMsgId });
        this.eventBufferStore.complete(input.sessionId);
        this.activeStreams.delete(streamId);
        this.inProcessOutboundRuns.delete(input.runId);
        if (input.userId) {
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
          // 自动命名钩子：enqueue-only 路径完全绕过 handleEvents()，原 onDone 内的
          // maybeGenerateTitle 永远不会被调到。这里覆盖 in-process scheduler wake
          // 路径；cross-process（ws-only 进程）由 publishRuntimePlatformEvent 兜底。
          if (this.claimTitleGenerationAttempt(input.runId)) {
            const userId = input.userId;
            void this.maybeGenerateTitleByUserId(input.sessionId, userId).then((title) => {
              if (title && this.eventBus) {
                this.eventBus.emitDual(userId, input.sessionId, {
                  type: 'title_updated',
                  sessionId: input.sessionId,
                  title,
                });
                clearSessionsListCache();
              }
            });
          }
        }
        clearSessionsListCache();
        break;
      case 'error':
        emitSession({ type: 'done', client_msg_id: input.clientMsgId, error: input.event.error });
        this.eventBufferStore.complete(input.sessionId);
        this.activeStreams.delete(streamId);
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
            reason: input.event.error,
          });
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
    const sessionId = event.sessionId;
    if (!sessionId) return;
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
    ].includes(event.type)) return;
    const active = runId ? this.findActiveStreamByRunId(runId) : undefined;
    const streamId = active?.streamId ?? (runId ? runId : undefined);
    const activeEntry = active?.entry ?? (streamId ? this.activeStreams.get(streamId) : undefined);
    const projection = projectRuntimePlatformEvent(event, {
      clientMsgId: activeEntry?.clientMsgId,
      // 同进程 run 的 live 内容已由直推（publishRuntimeOutboundEvent）送达，聚合行
      // 不展开防重复；跨进程（ws-only）无直推，聚合行整块展开补内容。
      expandStreamed: !(runId && this.inProcessOutboundRuns.has(runId)),
    });
    // 空投影且非终态的背景事件（如 hand_health_changed / hand_provisioning_log）直接跳过:
    // 不允许它们为已结束的会话 create 一个永不 complete 的 active buffer。
    // 否则 WS resume 判活会把该会话误报成 running(前端永久"正在思考"/停止按钮,刷新无效)。
    // 实证: 2026-07-02 会话 3adc25a5 服务重启后被 ACS sandbox 健康探测事件复活。
    if (projection.events.length === 0 && !projection.terminal) return;
    const buffer = this.eventBufferStore.get(sessionId);
    if (!buffer) {
      this.eventBufferStore.create(sessionId, activeEntry?.userId);
    }
    // 终态投影跨事件去重：run_finished{error} 与 RunStore 派生的 run_state_changed{failed}
    // 来自同一个 runId 且都会 terminal=true，第二次到达直接 return 避免给前端发两次 done /
    // session_status。注意必须在 events push 之前判断,否则 buffer 仍会被脏写。
    if (projection.terminal && runId) {
      if (this.crossProcessTerminalRuns.has(runId)) return;
      this.crossProcessTerminalRuns.add(runId);
    }
    const eventCursor = getDurableEventCursor(event);
    for (const data of projection.events) {
      const eventId = this.eventBufferStore.push(sessionId, JSON.stringify(data), eventCursor);
      const ws = activeEntry?.ws;
      if (ws && ws.readyState === ws.OPEN && streamId && this.wsActiveStream.get(ws) === streamId) {
        this.wsSend(ws, data, eventId ?? undefined, eventCursor);
      }
    }
    if (projection.terminal) {
      this.eventBufferStore.complete(sessionId);
      if (streamId) this.activeStreams.delete(streamId);
      if (activeEntry?.ws && this.wsActiveStream.get(activeEntry.ws) === streamId) {
        this.wsActiveStream.delete(activeEntry.ws);
      }
      if (runId) this.inProcessOutboundRuns.delete(runId);
      if (activeEntry?.clientMsgId) {
        this.idempotencySet(
          activeEntry.userId,
          activeEntry.clientMsgId,
          projection.sessionStatus === 'failed' ? 'failed' : 'done',
          streamId ?? '',
          { sessionId, ...(runId ? { runId } : {}) },
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
      // 自动命名跨进程兜底：ws-only 进程收到由 scheduler-only 进程产生的
      // run_finished。userId 不在事件 payload 里，从 RunStore 反查；失败状态不命名。
      // 单进程部署下 PG NOTIFY 也会回投 run_finished，靠 titleGenerationAttempts
      // 去重避免与 publishRuntimeOutboundEvent('done') 路径双发。
      if (runId && projection.sessionStatus === 'completed' && this.claimTitleGenerationAttempt(runId)) {
        const runStore = this.config.enqueueRuntime?.runStore;
        const eventBus = this.eventBus;
        if (runStore && eventBus) {
          void runStore.get(runId).then(async (record) => {
            if (!record?.userId) return;
            const title = await this.maybeGenerateTitleByUserId(sessionId, record.userId);
            if (title) {
              eventBus.emitDual(record.userId, sessionId, {
                type: 'title_updated',
                sessionId,
                title,
              });
              clearSessionsListCache();
            }
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
    // 异步处理，不阻塞 WS 消息循环
    void this.processChatMessage(client, msg);
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
    if (!sessionId || !this.config.agentCwd) return false;

    const transcriptPath = await findTranscriptOrMetaPathBySessionId(sessionId);
    if (!transcriptPath) return false;

    // 跨 session 并发兜底：限制同时进入的 jsonl 读路径并发数，遏制 EMFILE 突发。
    // 仅保护读路径（list + buildRuntimeReplayState）；dispatch 流不持锁。
    const release = await approvalResumeSemaphore.acquire();
    let eventStore: EventStore;
    let existingEvents: PlatformEvent[];
    let pendingApprovalRunId: string | undefined;
    let pendingAskUser: ReturnType<typeof buildPendingInteractionsFromEvents>[number] | undefined;
    let hasPendingApproval: boolean;
    try {
      eventStore = this.config.runtimeEventStoreFor
        ? this.config.runtimeEventStoreFor(transcriptPath)
        : new FileEventStore(getRuntimeEventLogPath(transcriptPath));
      const approvalStore = new EventBackedApprovalStore(eventStore, sessionId);
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

    const meta = await readSessionMeta(transcriptPath);
    const targetTenantAccessError = tenantAccessErrorMessage(this.config.tenantStore, meta?.tenantId);
    if (targetTenantAccessError) {
      this.wsSend(client.ws, { type: 'respond_error', interactionId, error: targetTenantAccessError });
      return true;
    }
    if (client.user && client.user.role !== 'admin') {
      if (!meta || meta.userId !== client.user.sub) {
        this.wsSend(client.ws, { type: 'respond_error', interactionId, error: 'Access denied' });
        return true;
      }
    }
    const orgAgentAccessError = this.orgAgentActionAccessError(
      client,
      meta?.orgAgentId,
      meta?.tenantId,
      meta?.username,
    );
    if (orgAgentAccessError) {
      this.wsSend(client.ws, { type: 'respond_error', interactionId, error: orgAgentAccessError });
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

    const enqueueRuntime = this.config.enqueueRuntime?.enabled === false ? undefined : this.config.enqueueRuntime;
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
      if (currentRun && ['completed', 'failed', 'cancelled', 'orphaned'].includes(currentRun.status)) {
        chatLogger.warn(`ask_user resume enqueue ignored terminal run=${pendingAskUser.runId} status=${currentRun.status}`);
        this.wsSend(client.ws, { type: 'respond_error', interactionId, error: 'Run already finished' });
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

    if (enqueueRuntime) {
      if (!meta || !pendingApprovalRunId) {
        chatLogger.warn(`approval resume enqueue rejected: missing meta/runId session=${sessionId} approval=${interactionId}`);
        return false;
      }
      const alreadyAccepted = existingEvents.some((event) => (
        event.type === 'interaction_resolved'
        && event.sessionId === sessionId
        && event.interactionId === interactionId
      ));
      const alreadyApplied = existingEvents.some((event) => (
        event.type === 'approval_resolved'
        && event.sessionId === sessionId
        && event.approvalId === interactionId
      ));
      if (alreadyAccepted || alreadyApplied) {
        this.wsSend(client.ws, { type: 'respond_ok', interactionId });
        return true;
      }
      const currentRun = await enqueueRuntime.runStore.get(pendingApprovalRunId);
      if (currentRun && ['completed', 'failed', 'cancelled', 'orphaned'].includes(currentRun.status)) {
        chatLogger.warn(`approval resume enqueue ignored terminal run=${pendingApprovalRunId} status=${currentRun.status}`);
        this.wsSend(client.ws, { type: 'respond_error', interactionId, error: 'Run already finished' });
        return true;
      }
      await eventStore.append({
        type: 'interaction_resolved',
        sessionId,
        runId: pendingApprovalRunId,
        interactionId,
        interactionType: 'approval',
        userId: client.user?.sub,
        response: {
          allow: response.allow === true,
          ...(typeof response.message === 'string' ? { message: response.message } : {}),
        },
      }, { tenantId: meta.tenantId });
      await enqueueRuntime.runStore.markStatus(pendingApprovalRunId, 'pending', 'approval_resolved_enqueue_resume', {
        resumeApprovalConsumedAt: null,
        resumeApprovalConsumedId: null,
        resumeApproval: {
          approvalId: interactionId,
          response: {
            allow: response.allow === true,
            ...(typeof response.message === 'string' ? { message: response.message } : {}),
          },
        },
      });
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
            response: {
              allow: response.allow === true,
              ...(typeof response.message === 'string' ? { message: response.message } : {}),
            },
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

    let targetCwd: string | undefined;
    if (!this.config.resumeApprovalDispatch) return false;
    let sessionOwner: ChannelContext['sessionOwner'];
    if (client.user?.role === 'admin' && meta?.username && meta.userId !== client.user.sub) {
      // PR 7 P1-2：admin 代操作时按 ownerRecord.tenantId 落对路径
      const ownerRecord = this.userStore?.findById(meta.userId);
      targetCwd = resolveUserCwd(this.config.agentCwd, {
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
    } else if (userIdentity) {
      targetCwd = resolveUserCwd(this.config.agentCwd, userIdentity);
    }
    const cwd = targetCwd || this.config.agentCwd;

    const resolvedModel = meta?.model && this.modelResolver ? this.modelResolver(meta.model) : null;
    const modelOptions = resolvedModel ? toRunModelOptions(resolvedModel) : {};
    const resumeContext: ChannelContext = {
      channel: 'web',
      resumeSessionId: sessionId,
      timezone: this.config.timezone,
      ...(userIdentity ? { user: userIdentity } : {}),
      ...(sessionOwner ? { sessionOwner } : {}),
      ...(targetCwd ? { targetCwd } : {}),
    };

    const streamId = String(++this.streamIdCounter);
    const controller = new AbortController();
    this.activeStreams.set(streamId, {
      controller,
      userId: client.user?.sub,
      ws: client.ws,
      sessionId,
    });
    this.wsActiveStream.set(client.ws, streamId);
    this.eventBufferStore.create(sessionId, client.user?.sub);

    this.wsSend(client.ws, { type: 'respond_ok', interactionId });
    if (client.user?.sub && this.eventBus) {
      this.eventBus.emitUser(client.user.sub, {
        type: 'interaction_resolved',
        sessionId,
        interactionId,
      }, client.ws);
      this.eventBus.emitUser(client.user.sub, {
        type: 'session_status',
        sessionId,
        status: 'busy',
        streamId,
      });
    }

    const hooks: AgentRunHooks = {
      onResult: async (metaResult) => {
        const tokenStore = this.config.tokenUsageStore;
        if (tokenStore && client.user && metaResult.modelUsage && Object.keys(metaResult.modelUsage).length > 0) {
          try {
            tokenStore.recordResult({
              username: client.user.username,
              // JwtPayload.tenantId 必填；闭包内 TS narrow 保守，兜底平台根组织。
              tenantId: client.user.tenantId ?? DEFAULT_TENANT_ID,
              channel: 'web',
              modelUsage: metaResult.modelUsage,
              occurredAtMs: Date.now(),
            });
          } catch (err) {
            chatLogger.warn(`[token-usage] approval resume record failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      },
    };

    const events = this.config.resumeApprovalDispatch({
      approvalId: interactionId,
      response: {
        allow: response.allow === true,
        ...(typeof response.message === 'string' ? { message: response.message } : {}),
      },
      sessionId,
      context: resumeContext,
      model: modelOptions.model,
      modelConnection: modelOptions.modelConnection,
      modelProviderOptions: modelOptions.modelProviderOptions,
      hooks,
      abortController: controller,
    });

    void (async () => {
      try {
        await this.handleEvents(
          events,
          client.ws,
          resumeContext,
          controller.signal,
          { sessionId, streamId },
          undefined,
          meta?.model,
        );
      } catch (err) {
        chatLogger.error(`approval resume stream failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        this.activeStreams.delete(streamId);
        this.eventBufferStore.complete(sessionId);
        if (client.user?.sub && this.eventBus) {
          this.eventBus.emitUser(client.user.sub, {
            type: 'session_status',
            sessionId,
            status: 'idle',
          });
        }
      }
    })();

    return true;
  }

  /** 处理 abort 消息（runId-first；streamId 仅兼容旧客户端） */
  private handleAbort(client: WsClient, msg: WsAbortMessage): void {
    void this.handleAbortAsync(client, msg).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      chatLogger.warn(`abort failed: ${message}`);
      this.wsSend(client.ws, { type: 'error', message });
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

    if (!sessionId && resolvedRunId && this.config.enqueueRuntime?.runStore) {
      const record = await this.config.enqueueRuntime.runStore.get(resolvedRunId);
      if (record) {
        sessionId = record.sessionId;
        resolvedRunStatus = record.status;
        resolvedRunStatusReason = record.statusReason;
        if (client.user && client.user.role !== 'admin' && record.userId && record.userId !== client.user.sub) {
          this.wsSend(client.ws, { type: 'error', message: 'Access denied' });
          return;
        }
      }
    }

    if (entry && client.user && client.user.role !== 'admin' && entry.userId && entry.userId !== client.user.sub) {
      this.wsSend(client.ws, { type: 'error', message: 'Access denied' });
      return;
    }

    if (resolvedRunStatus && TERMINAL_RUN_STATUSES.has(resolvedRunStatus)) {
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

    await this.appendDurableWebCommand(sessionId, {
      type: 'run_cancel_requested',
      sessionId,
      runId: resolvedRunId,
      streamId: resolvedStreamId,
      userId: client.user?.sub,
      reason: 'web_abort',
    });
    if (resolvedRunId && this.config.enqueueRuntime?.runStore) {
      if (sessionId && this.config.enqueueRuntime.toolInvocationStore) {
        const runningInvocations = await this.config.enqueueRuntime.toolInvocationStore.listRunning(sessionId).catch(() => []);
        for (const invocation of runningInvocations.filter((item) => item.runId === resolvedRunId)) {
          const cancelRecord = await this.config.enqueueRuntime.toolInvocationStore.requestCancel(
            invocation.invocationId,
            'web_abort',
            { requestedBy: client.user?.sub ?? 'anonymous' },
          ).catch(() => null);
          await this.appendDurableWebCommand(sessionId, {
            type: 'tool_invocation_cancel_requested',
            sessionId,
            runId: resolvedRunId,
            invocationId: invocation.invocationId,
            toolCallId: invocation.toolCallId,
            toolName: invocation.toolName,
            userId: client.user?.sub,
            reason: 'web_abort',
            metadata: cancelRecord?.metadata,
          });
        }
      }
      await this.config.enqueueRuntime.runStore.markStatus(resolvedRunId, 'cancelled', 'web_abort').catch(() => null);
      runtimeRunController.abort(resolvedRunId, 'web_abort');
    }
    entry?.controller.abort();
    this.wsSend(client.ws, { type: 'abort_ok', ...(resolvedStreamId ? { streamId: resolvedStreamId } : {}), ...(resolvedRunId ? { runId: resolvedRunId } : {}) });
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
    const { sessionId: sid, lastEventId, lastEventCursor, skipReplay } = msg;

    // 总是先清理旧订阅（防止切换会话后旧事件继续推送到新会话）
    const prevUnsub = this.resumeSubscriptions.get(client.ws);
    if (prevUnsub) {
      prevUnsub();
      this.resumeSubscriptions.delete(client.ws);
    }

    const bufferEntry = this.eventBufferStore.get(sid);
    // 判活口径与 getStreamStatus() 统一：durable runStore 是 run 是否活着的唯一真相,
    // 内存 buffer 只是传输缓存。buffer active 但 runStore 明确说没有活跃 run 时,
    // 这是幽灵 buffer(背景事件误建/complete 丢失),就地收口并按 inactive 处理。
    // 否则前端 resume 永远收到 active:true,会话永久卡在"正在思考"。
    let bufferActive = Boolean(bufferEntry && this.eventBufferStore.isActive(sid));
    if (bufferActive) {
      try {
        const runStore = this.config.enqueueRuntime?.runStore;
        if (runStore?.getActiveBySession) {
          const activeRun = await runStore.getActiveBySession(sid);
          if (!activeRun) {
            this.eventBufferStore.complete(sid);
            bufferActive = false;
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
        lastEventId,
        lastEventCursor,
        skipReplay: skipReplay === true,
      });
      if (!durableActive) {
        this.wsSend(client.ws, { type: 'active_stream', sessionId: sid, active: false });
      }
      // 已完成的 buffer：推送 pending 交互（如有）
      if (bufferEntry) {
        this.pushPendingInteractions(client, sid);
      }
      return;
    }

    // 用户归属校验
    if (client.user?.role !== 'admin' && bufferEntry.userId && bufferEntry.userId !== client.user?.sub) {
      this.wsSend(client.ws, { type: 'active_stream', sessionId: sid, active: false });
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
      status: 'running',
    });

    const alreadyDirectBound = Boolean(
      activeStreamId
      && activeEntry?.ws === client.ws
      && this.wsActiveStream.get(client.ws) === activeStreamId,
    );
    if (alreadyDirectBound) {
      this.pushPendingInteractions(client, sid);
      return;
    }

    // 回放错过的事件（skipReplay 模式下跳过）
    if (!skipReplay) {
      const result = this.eventBufferStore.getEventsAfter(sid, lastEventId);
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
        }
      }
    }

    // 订阅新事件
    const unsubscribe = this.eventBufferStore.subscribe(
      sid,
      (event) => {
        if (client.ws.readyState === client.ws.OPEN) {
          try {
            const data = JSON.parse(event.data);
            this.wsSend(client.ws, data, event.id, event.eventCursor);
          } catch { /* skip */ }
        }
      },
      () => {
        // Agent 完成
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
    this.pushPendingInteractions(client, sid);
  }

  private async tryReplayDurableRuntimeEvents(
    client: WsClient,
    sessionId: string,
    options: { lastEventId?: number; lastEventCursor?: string; skipReplay?: boolean },
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
    });
    if (!options.skipReplay) {
      const store = await this.getRuntimeEventStoreForSession(sessionId);
      if (store) {
        await this.replayDurableRuntimeEvents(client, sessionId, store, options);
      }
    }
    const unsubscribe = this.eventBufferStore.subscribe(
      sessionId,
      (event) => {
        if (client.ws.readyState === client.ws.OPEN) {
          try { this.wsSend(client.ws, JSON.parse(event.data), event.id, event.eventCursor); } catch { /* skip */ }
        }
      },
      () => this.resumeSubscriptions.delete(client.ws),
    );
    if (unsubscribe) this.resumeSubscriptions.set(client.ws, unsubscribe);
    client.ws.once('close', () => {
      const closeSub = this.resumeSubscriptions.get(client.ws);
      if (closeSub) { closeSub(); this.resumeSubscriptions.delete(client.ws); }
    });
    this.pushPendingInteractions(client, sessionId);
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
    options: { lastEventId?: number; lastEventCursor?: string },
  ): Promise<void> {
    let replayId = options.lastEventId ?? 0;
    if (store.listPage && options.lastEventCursor !== undefined && options.lastEventCursor !== null) {
      let cursor: string | undefined = options.lastEventCursor || undefined;
      while (true) {
        const page = await store.listPage(sessionId, { afterCursor: cursor, limit: 200 });
        for (const event of page.events) {
          const eventCursor = getDurableEventCursor(event);
          for (const data of projectRuntimePlatformEvent(event, { expandStreamed: true }).events) {
            replayId += 1;
            this.wsSend(client.ws, data, replayId, eventCursor);
          }
        }
        if (!page.hasMore || !page.nextCursor) break;
        cursor = page.nextCursor;
      }
      return;
    }
    const events = await store.list(sessionId);
    for (const event of events) {
      const eventCursor = getDurableEventCursor(event);
      for (const data of projectRuntimePlatformEvent(event, { expandStreamed: true }).events) {
        replayId += 1;
        if (replayId > (options.lastEventId ?? 0)) this.wsSend(client.ws, data, replayId, eventCursor);
      }
    }
  }

  /** 处理 detach 消息：客户端切换会话时立即取消 EventBuffer 订阅，防止旧会话事件串流 */
  private handleDetach(client: WsClient): void {
    // 清除 WS 活跃流绑定，阻止旧会话的 handleEvents/hooks send 继续向此 WS 直接推送
    this.wsActiveStream.delete(client.ws);
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

    const result = this.wsServer.userEventLog.getEventsAfter(userId, msg.lastSeq);
    if (result.gapDetected) {
      this.wsSend(client.ws, {
        type: 'sync_overflow',
        seq: this.wsServer.userEventLog.getCurrentSeq(userId),
      });
    } else {
      this.wsSend(client.ws, {
        type: 'sync_ok',
        seq: this.wsServer.userEventLog.getCurrentSeq(userId),
        events: result.events,
      });
    }
  }

  /** 推送 pending 交互给客户端 */
  private pushPendingInteractions(client: WsClient, sessionId: string): void {
    const pending = interactionStore.getPendingInteractions(sessionId);
    if (pending.length > 0) {
      this.wsSend(client.ws, {
        type: 'pending_interactions',
        interactions: pending,
      });
    }
  }

  // ── 核心聊天处理逻辑 ──────────────────────────────────

  private async processChatMessage(client: WsClient, msg: WsChatMessage): Promise<void> {
    const { message, sessionId, attachments, model, voiceFile } = msg;
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

    // 1) Drain 拦截（服务端优雅关闭期间）
    if (this.config.getIsDraining?.()) {
      this.sendChatRejected(ws, clientMsgId, 'server_draining', '服务即将关闭，请稍后重试');
      return;
    }

    const tenantAccessError = this.tenantAccessErrorForClient(client);
    if (tenantAccessError) {
      this.sendChatRejected(ws, clientMsgId, 'access_denied', tenantAccessError);
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
        chatLogger.info(`[chat] Idempotency hit (in_flight), resending ACK for client_msg_id=${clientMsgId}`);
        this.sendChatAck(ws, clientMsgId);
        if (dupEntry.streamId) {
          this.wsSend(ws, {
            type: 'stream_id',
            streamId: dupEntry.streamId,
            ...(dupEntry.runId ? { runId: dupEntry.runId } : {}),
            client_msg_id: clientMsgId,
          });
        }
        if (dupEntry.sessionId) {
          this.wsSend(ws, { type: 'session', sessionId: dupEntry.sessionId, client_msg_id: clientMsgId });
        }
        return;
      }
      // done/failed：客户端若拿同 ID 重发视为重复提交
      this.sendChatRejected(ws, clientMsgId, 'duplicate_inflight', '该消息已处理，请发新消息');
      return;
    }

    const durableRun = await this.config.enqueueRuntime?.runStore.findByIdempotencyKey(user?.sub, clientMsgId);
    if (durableRun) {
      const streamId = typeof durableRun.metadata?.streamId === 'string' ? durableRun.metadata.streamId : '';
      const activeStatuses = new Set(['pending', 'running', 'waiting_approval', 'waiting_user', 'waiting_hand']);
      if (activeStatuses.has(durableRun.status)) {
        this.idempotencySet(user?.sub, clientMsgId, 'in_flight', streamId, { sessionId: durableRun.sessionId, runId: durableRun.runId });
        this.sendChatAck(ws, clientMsgId);
        this.wsSend(ws, { type: 'stream_id', streamId: streamId || durableRun.runId, runId: durableRun.runId, client_msg_id: clientMsgId });
        this.wsSend(ws, { type: 'session', sessionId: durableRun.sessionId, client_msg_id: clientMsgId });
        return;
      }
      this.sendChatRejected(ws, clientMsgId, 'duplicate_inflight', '该消息已处理，请发新消息');
      return;
    }

    // 5) ACK：到此通过连通性与权限校验，即将进入业务流程（STT/dispatch）
    //    标记 in_flight（streamId 占位，真实 streamId 后面分配后会覆盖）
    this.idempotencySet(user?.sub, clientMsgId, 'in_flight', '');
    this.sendChatAck(ws, clientMsgId);

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

    // ── 公司级专职 Agent 解析与门禁（2026-07 唯恩批次）──────────────────
    // 0) /compact 等平台命令只跳过 LLM 话题门禁，企业专家授权校验仍必须执行
    // 1) 解析 orgAgentId：带 sessionId 以会话 meta 为准（忽略客户端值防伪造）；新会话取 msg.orgAgentId
    // 2) org agent 校验：存在 + enabled + 同租户 + 被指派（admin 豁免 audience）→ 否则 org_agent_unavailable
    // 3) personalAgent gate：无 orgAgentId 且租户关闭个人 Agent 时普通用户被拒
    // 4) LLM 话题门禁：off_topic → 合成气泡不启动 run；uncertain → 放行 + pass_flagged 打标落库
    let orgAgentId: string | undefined;
    let orgAgentRecord: OrgAgentRecord | undefined;
    let guardrailMark: 'pass_flagged' | 'fail_open' | undefined;
    /** uncertain/纯附件的落库负载：延迟到 sessionId 确定后 flush（新会话 id 在 enqueue 时才生成） */
    let pendingGuardrailEvent: { messageText: string; model?: string; latencyMs?: number } | undefined;
    if (validSessionId) {
      orgAgentId = gateSessionMeta?.orgAgentId;
      if (msg.orgAgentId && msg.orgAgentId !== orgAgentId) {
        chatLogger.warn(`[org-agent] client orgAgentId=${msg.orgAgentId} ignored, session meta wins (${orgAgentId ?? 'none'}, session=${validSessionId})`);
      }
    } else {
      orgAgentId = msg.orgAgentId;
    }
    const isPlatformCommand = isCompactCommand(resolvedMessage);
    if (orgAgentId) {
      const record = this.config.orgAgentStore?.get(orgAgentId);
      const gateIdentity = sessionOwner ?? userIdentity;
      // admin 豁免 audience 收紧（2026-07 审查 F1a）：仅平台 admin 或与该 org agent
      // 同租户的组织 admin；跨租户组织 admin → assigned=false → org_agent_unavailable（同码防枚举）
      const adminExempt = user?.role === 'admin'
        && (isPlatformAdminUser(user) || record?.tenantId === user.tenantId);
      const assigned = !!record && (adminExempt || isAssignedToOrgAgent(record, gateIdentity?.username));
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
    if (orgAgentRecord?.guardrail.enabled && !isPlatformCommand) {
      const guardrailConfigs = this.config.getGuardrailModelConfigs?.() ?? [];
      if (guardrailConfigs.length > 0) {
        const isPureAttachment = resolvedMessage === AI_FALLBACK_TEXT && !!attachments?.length;
        if (isPureAttachment) {
          // 决策 5：纯附件消息跳过门禁模型调用，按 uncertain 放行 + 打标（message_text 记附件名清单）
          guardrailMark = 'pass_flagged';
          pendingGuardrailEvent = {
            messageText: `[附件] ${attachments!.map((a: UploadedFileInfo) => a.originalName).join(', ')}`,
          };
        } else {
          // 决策 6：语音只看 STT 后文本（剥 VOICE_STT_TAG）
          const guardText = resolvedMessage.startsWith(VOICE_STT_TAG)
            ? resolvedMessage.slice(VOICE_STT_TAG.length)
            : resolvedMessage;
          const recentUserMessages = gateTranscriptPath
            ? await extractRecentUserMessages(gateTranscriptPath, this.config.guardrailOptions?.maxRecentRounds ?? 2)
            : [];
          const check = await checkTopicScope(
            {
              message: guardText,
              scopeDescription: orgAgentRecord.guardrail.scopeDescription,
              strictness: orgAgentRecord.guardrail.strictness,
              recentUserMessages,
            },
            guardrailConfigs,
            {
              timeoutMs: this.config.guardrailOptions?.timeoutMs,
              onUsage: async (usageModel, usage) => {
                // 记账 channel='guardrail'（沿 title 先例，不进 PG credits）
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
          if (check.verdict === 'off_topic') {
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
            });
            return;
          }
          if (check.verdict === 'uncertain') {
            guardrailMark = 'pass_flagged';
            pendingGuardrailEvent = {
              messageText: guardText,
              ...(check.model ? { model: check.model } : {}),
              latencyMs: check.latencyMs,
            };
          } else if (check.source === 'fail_open') {
            // fail_open 打 metadata 不落库（与 pass_flagged 区分，避免污染需求雷达数据）
            guardrailMark = 'fail_open';
          }
        }
      }
    }
    const flushPendingGuardrailEvent = (resolvedGuardrailSessionId: string | undefined): void => {
      if (!pendingGuardrailEvent || !orgAgentRecord) return;
      this.insertGuardrailEvent({
        orgAgent: orgAgentRecord,
        user,
        sessionId: resolvedGuardrailSessionId,
        clientMsgId,
        verdict: 'pass_flagged',
        messageText: pendingGuardrailEvent.messageText,
        model: pendingGuardrailEvent.model,
        latencyMs: pendingGuardrailEvent.latencyMs,
      });
      pendingGuardrailEvent = undefined;
    };
    // ── 门禁段结束 ─────────────────────────────────────────────────

    if (validSessionId) {
      void this.appendDurableWebCommand(validSessionId, {
        type: 'user_message_submitted',
        sessionId: validSessionId,
        userId: user?.sub,
        clientMsgId,
        content: resolvedMessage,
      });
    }

    if (user && user.role !== 'admin' && this.config.loginLogFilePath) {
      const trimmed = resolvedMessage.trim();
      const preview = trimmed.length > 80 ? `${trimmed.slice(0, 80)}...` : trimmed;
      const detailParts = [
        `session=${validSessionId || 'new'}`,
        `attachments=${attachments?.length ?? 0}`,
      ];
      if (voiceFile) detailParts.push(`voice=${voiceFile.duration}ms`);
      if (preview) detailParts.push(`preview=${preview}`);

      appendLoginLog({
        timestamp: new Date().toISOString(),
        event: 'chat_message_sent',
        username: user.username,
        userId: user.sub,
        ip: client.ip || 'unknown',
        userAgent: client.userAgent || 'unknown',
        channel: detectLoginChannel(client.userAgent || ''),
        detail: detailParts.join(' | '),
      }, this.config.loginLogFilePath).catch(() => {});
    }

    const enqueueRuntime = this.config.enqueueRuntime?.enabled === false ? undefined : this.config.enqueueRuntime;
    if (enqueueRuntime) {
      const enqueueSessionId = validSessionId ?? randomUUID();
      const enqueueRunId = `${Date.now()}-${randomUUID()}`;
      const streamId = String(++this.streamIdCounter);
      let sessionPersisted = false;
      try {
        const enqueueCwd = targetCwd || resolveUserCwd(this.config.agentCwd!, userIdentity);
        const existingSessionRecord = validSessionId
          ? await enqueueRuntime.sessionCatalog.get(enqueueSessionId)
          : null;
        const enqueueOwner = sessionOwner ?? userIdentity;
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
        });
        await enqueueRuntime.sessionCatalog.upsert(sessionRecord);
        sessionPersisted = true;
        // 门禁 uncertain/纯附件的 pass_flagged 落库：sessionId 到这里才确定
        flushPendingGuardrailEvent(enqueueSessionId);
        const controller = new AbortController();
        this.activeStreams.set(streamId, {
          controller,
          userId: user?.sub,
          ws,
          sessionId: enqueueSessionId,
          runId: enqueueRunId,
          clientMsgId,
        });
        this.wsActiveStream.set(ws, streamId);
        this.idempotencySet(user?.sub, clientMsgId, 'in_flight', streamId, { sessionId: enqueueSessionId, runId: enqueueRunId });
        this.eventBufferStore.create(enqueueSessionId, user?.sub);

        await this.appendRuntimeEvent(sessionRecord.transcriptPath, {
          type: 'user_message_submitted',
          sessionId: enqueueSessionId,
          runId: enqueueRunId,
          streamId,
          userId: user?.sub,
          clientMsgId,
          content: resolvedMessage,
        }, sessionRecord.tenantId);
        await enqueueRuntime.scheduler.enqueue({
          runId: enqueueRunId,
          sessionId: enqueueSessionId,
          userId: enqueueOwner?.id,
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
            ...(approvalPolicy ? { approvalPolicy } : {}),
            ...(guardrailMark ? { guardrail: guardrailMark } : {}),
            wakeMessage: {
              channel: inbound.channel,
              chatId: enqueueSessionId,
              content: inbound.content,
              attachments: inbound.attachments ?? [],
            },
          },
        });
        await this.appendRuntimeEvent(sessionRecord.transcriptPath, {
          type: 'run_enqueued',
          sessionId: enqueueSessionId,
          runId: enqueueRunId,
          userId: user?.sub,
          clientMsgId,
        }, sessionRecord.tenantId);

        const send = (data: object) => this.eventBus!.emitReply(ws, data);
        send({ type: 'stream_id', streamId, runId: enqueueRunId, client_msg_id: clientMsgId });
        send({ type: 'session', sessionId: enqueueSessionId, client_msg_id: clientMsgId });
        if (userDisplayContent || attachmentMeta) {
          this.eventBufferStore.push(enqueueSessionId, JSON.stringify({
            type: 'user_message',
            content: userDisplayContent,
            ...(attachmentMeta ? { attachments: attachmentMeta } : {}),
            timestamp: Date.now(),
            client_msg_id: clientMsgId,
          }));
        }
        if (user?.sub && this.eventBus) {
          this.eventBus.emitUser(user.sub, {
            type: 'stream_started',
            sessionId: enqueueSessionId,
            streamId,
            runId: enqueueRunId,
          }, ws);
          this.eventBus.emitUser(user.sub, {
            type: 'session_status',
            sessionId: enqueueSessionId,
            status: 'queued',
            streamId,
            runId: enqueueRunId,
          });
        }
        chatLogger.info(`[chat] enqueue-only accepted run=${enqueueRunId} session=${enqueueSessionId} client_msg_id=${clientMsgId}`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        chatLogger.error(`[chat] enqueue-only failed: ${errorMessage}`);
        this.idempotencySet(user?.sub, clientMsgId, 'failed', streamId);
        this.activeStreams.delete(streamId);
        this.wsActiveStream.delete(ws);
        await enqueueRuntime.runStore.markStatus(enqueueRunId, 'failed', errorMessage).catch(() => null);
        if (sessionPersisted) {
          await enqueueRuntime.sessionCatalog.markStatus(enqueueSessionId, 'error').catch((statusError) => {
            chatLogger.warn(`[chat] failed to mark session error session=${enqueueSessionId}: ${statusError instanceof Error ? statusError.message : String(statusError)}`);
          });
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
            List: { field: 'path', optional: true },
            Edit: { field: 'file_path' },
            Glob: { field: 'path', optional: true },
            Grep: { field: 'path', optional: true },
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
        userMessage: message,
        userDisplayContent,
        attachmentMeta,
        clientMsgId,
        isNewSession: !validSessionId,
        getSessionId: () => resolvedSessionId,
      };
      await this.handleEvents(events, ws, context, userAbortController.signal, bufferCtx, titleCtx, model, clientMsgId);
    } catch (error) {
      chatLogger.error('处理消息错误:', error);
      // 外层兜底：发 done(error) 让客户端正常清 loading + 翻 bubble failed
      // 不再单发 error 事件（否则客户端只会加一条 text 气泡，pending 气泡永久卡住）
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.idempotencySet(user?.sub, clientMsgId, 'failed', streamId);
      send({ type: 'done', client_msg_id: clientMsgId, error: errorMessage });
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

    // (b) legacy transcript 追加 user + assistant 两行（刷新后气泡仍在）
    try {
      await this.appendGuardrailTranscript(transcriptPath, sessionId, args.resolvedMessage, rejectionMessage);
    } catch (err) {
      chatLogger.warn(`[guardrail] transcript append failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // (c) guardrail_events 落库（需求雷达；fire-and-forget 内部吞错）
    this.insertGuardrailEvent({
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
    });

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
    emitSession({ type: 'text', content: rejectionMessage });
    emitSession({ type: 'block_end', blockType: 'text' });
    emitSession({ type: 'done', client_msg_id: args.clientMsgId });
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

  /** 门禁拒绝的 legacy transcript 两行（格式照 legacyTranscriptProjection line builder）。 */
  private async appendGuardrailTranscript(
    transcriptPath: string,
    sessionId: string,
    userContent: string,
    assistantContent: string,
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
      timestamp: new Date().toISOString(),
    }) + '\n';
    await mkdir(dirname(transcriptPath), { recursive: true });
    await appendFile(transcriptPath, lines, 'utf-8');
  }

  /** guardrail_events 落库（PG 不可用/未配置时降级 log，绝不阻塞聊天链路）。 */
  private insertGuardrailEvent(args: {
    orgAgent: OrgAgentRecord;
    user: WsClient['user'];
    sessionId?: string;
    clientMsgId?: string;
    verdict: GuardrailEventVerdict;
    messageText: string;
    model?: string;
    latencyMs?: number;
  }): void {
    const store = this.config.guardrailEventStore;
    if (!store) {
      chatLogger.info(`[guardrail] event not persisted (no PG store): verdict=${args.verdict} orgAgent=${args.orgAgent.id} session=${args.sessionId ?? 'n/a'}`);
      return;
    }
    void store.insert({
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
    }).catch((err) => {
      chatLogger.warn(`[guardrail] event insert failed: ${err instanceof Error ? err.message : String(err)}`);
    });
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
   * 调上游模型 → 落 meta.generatedTitle。三条触发路径共用：
   * 1. handleEvents() onDone（同步 dispatch 历史路径，含 dingtalk/旧 web）
   * 2. publishRuntimeOutboundEvent('done')（enqueue-only + 同进程 scheduler wake）
   * 3. publishRuntimePlatformEvent(run_finished terminal)（跨进程 PG NOTIFY 桥）
   *
   * `userInfo` 由调用方按各自上下文准备：handleEvents 用 ChannelContext.user，
   * 后两条用 userId → UserStore.findById 反查 username/role/tenantId。
   */
  private async resolveTitleForSession(
    sessionId: string,
    userInfo: { id: string; username: string; role: string; tenantId?: string },
    fallbackUserMessage = '',
    fallbackAssistantReply = '',
  ): Promise<string | null> {
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
      // 已有命名（手动或自动）不覆盖。续聊轮 + 三路重复触发都命中这个守卫，幂等。
      if (meta?.customTitle || meta?.generatedTitle) return null;

      // 优先从 transcript 读首两轮（命名素材稳定，与手动 /auto-title 一致）；
      // 极早期 transcript 还没落盘时退回本轮 fallback。
      const ctx = await extractTitleContext(transcriptPath).catch(() => null);
      const userMessage = ctx?.userMessages[0] || fallbackUserMessage;
      const assistantReply = ctx?.assistantReplies[0] || fallbackAssistantReply;
      if (!userMessage) return null;

      const title = await generateTitleWithFallback(
        userMessage,
        assistantReply,
        titleConfigs,
        ctx?.userMessages[1],
        ctx?.assistantReplies[1],
        {
          onUsage: (model, usage) => {
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
      if (title) {
        await updateSessionMeta(transcriptPath, { generatedTitle: title });
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
  ): Promise<string | null> {
    if (!context.user) return null;
    return this.resolveTitleForSession(
      sessionId,
      {
        id: context.user.id,
        username: context.user.username,
        role: context.user.role,
        tenantId: context.user.tenantId,
      },
      fallbackUserMessage,
      fallbackAssistantReply,
    );
  }

  /**
   * enqueue-only / cross-process 路径专用：只有 userId 时按 UserStore 反查
   * username/role/tenantId 再走 resolveTitleForSession。userStore 缺失或查不到
   * 用户则放弃命名（无法解析物理 cwd）。
   */
  private async maybeGenerateTitleByUserId(sessionId: string, userId: string): Promise<string | null> {
    if (!this.userStore) return null;
    const userRecord = this.userStore.findById(userId);
    if (!userRecord) return null;
    return this.resolveTitleForSession(sessionId, {
      id: userRecord.id,
      username: userRecord.username,
      role: userRecord.role,
      tenantId: userRecord.tenantId,
    });
  }

  /**
   * 自动命名跨调用去重：三路触发都先 add(runId)，已存在直接 skip。
   * 跨 in-process outbound 'done' 与 cross-process platform 'run_finished'
   * 投影后的二次广播——后者由 PG NOTIFY 在 single-process 部署下也会再投回来。
   * runId 是 dispatch 维度唯一，长会话累积有限；为防极端长生命周期泄漏，
   * 在 1024 条时截断保留最近一半，保证基本去重时效性。
   */
  private readonly titleGenerationAttempts = new Set<string>();
  private claimTitleGenerationAttempt(runId: string): boolean {
    if (this.titleGenerationAttempts.has(runId)) return false;
    this.titleGenerationAttempts.add(runId);
    if (this.titleGenerationAttempts.size > 1024) {
      const arr = Array.from(this.titleGenerationAttempts);
      this.titleGenerationAttempts.clear();
      for (const id of arr.slice(arr.length / 2)) this.titleGenerationAttempts.add(id);
    }
    return true;
  }

  private async handleEvents(
    events: AsyncGenerator<OutboundEvent>,
    ws: WebSocket,
    context: ChannelContext,
    signal?: AbortSignal,
    bufferCtx?: { sessionId?: string; streamId?: string },
    titleCtx?: {
      userMessage: string;
      userDisplayContent?: string;
      attachmentMeta?: Array<{ name: string; isImage?: boolean; relativePath?: string }>;
      clientMsgId?: string;
      isNewSession: boolean;
      getSessionId: () => string | undefined;
    },
    modelRef?: string,
    clientMsgId?: string,
  ): Promise<void> {
    const config = this.displayConfig;
    // 会话上下文（sessionId 由 onSessionInit 填充，streamId 提前已知）
    const sessionCtx: SessionContext = {
      sessionId: bufferCtx?.sessionId || '',
      streamId: bufferCtx?.streamId || '',
      ws,
      userId: context.user?.id,
    };
    const send = (data: object) => {
      if (sessionCtx.sessionId) {
        this.eventBus!.emitSession(sessionCtx, data);
      } else {
        // EventBuffer 尚未建立（session_init 之前），直发
        this.eventBus!.emitReply(ws, data);
      }
    };

    const sendVoiceMarkers = (text: string, standalone: boolean) => {
      const parsed = parseVoiceMarkers(text);
      for (const marker of parsed.markers) {
        send({
          type: 'voice',
          text: marker.text,
          voice: marker.voice,
          speed: marker.speed,
          standalone,
        });
      }
    };

    // ---- 每个 text block 的缓冲状态 ----
    let textBuffer: string[] = [];
    let textAccumulated = '';
    let isBuffering = true;
    let textBlockStartSent = false;

    const flushTextBuffer = () => {
      if (!textBlockStartSent) {
        send({ type: 'block_start', blockType: 'text' });
        textBlockStartSent = true;
      }
      for (const chunk of textBuffer) {
        send({ type: 'text', content: chunk });
      }
      textBuffer = [];
      isBuffering = false;
    };

    const resetTextBlockState = () => {
      textBuffer = [];
      textAccumulated = '';
      isBuffering = true;
      textBlockStartSent = false;
    };

    let collectedAssistantText = '';
    // SDK 错误透传：onError 记录，onDone 合并进 done 事件
    let lastError: string | undefined;

    // ---- 幽灵会话检测 ----
    // 新会话必须至少产生过一次"真实内容"事件（text/thinking/tool），
    // 否则在流结束时删除，避免用户刷新/断连/立刻取消产生的空「新对话」污染列表。
    // 之前的 isNewSession 与 titleCtx 同体，命名扩成"每轮都尝试"后两者解耦。
    const isNewSession = titleCtx?.isNewSession ?? false;
    let hasRealContent = false;
    const markRealContent = () => { hasRealContent = true; };

    const agentCwd = this.config.agentCwd;
    const self = this;
    const handler: EventHandler = {
      onSessionInit(sessionId) {
        if (bufferCtx && sessionId) {
          bufferCtx.sessionId = sessionId;
          sessionCtx.sessionId = sessionId;
          self.eventBufferStore.create(sessionId, context.user?.id);
          // 新建会话：注入用户消息到 buffer（其他设备 resume 时会 replay）
          // 续聊不该重发 user_message，靠 isNewSession 守卫——之前用 titleCtx 存在与否兼任此判断，
          // 命名上下文改成每轮都构造后，此处必须显式判断会话新旧。
          if (isNewSession && (titleCtx?.userDisplayContent || titleCtx?.attachmentMeta)) {
            self.eventBufferStore.push(sessionId, JSON.stringify({
              type: 'user_message',
              content: titleCtx?.userDisplayContent ?? '',
              ...(titleCtx?.attachmentMeta?.length ? { attachments: titleCtx.attachmentMeta } : {}),
              timestamp: Date.now(),
              ...(titleCtx?.clientMsgId ? { client_msg_id: titleCtx.clientMsgId } : {}),
            }));
            // B 修复：user_message 已进 EventBuffer，本会话视为"有真实内容"，
            // 防止 SDK 在 session_init 后立刻 error 时幽灵回滚连带删除用户消息。
            markRealContent();
          }
        }
        send({ type: 'session', sessionId, ...(titleCtx?.clientMsgId ? { client_msg_id: titleCtx.clientMsgId } : {}) });
        // 新会话创建后立即清除缓存，确保客户端 loadSessions() 能发现新会话
        clearSessionsListCache();
        if (context.user && agentCwd && sessionId) {
          // Admin 代操作其他用户会话时，meta 必须写回原会话 owner 的目录，
          // 否则会在 admin 自己的 projectKey 下产生孤儿 meta，污染 owner 展示。
          const metaCwd = context.targetCwd || resolveUserCwd(agentCwd, {
            id: context.user.id,
            username: context.user.username,
            role: context.user.role as 'admin' | 'user',
            tenantId: context.user.tenantId,
          });
          const transcriptPath = getTranscriptPath(metaCwd, sessionId, { tenantId: context.user.tenantId, userId: context.user.id });
          readSessionMeta(transcriptPath).then((existing) => {
            if (existing) {
              // 续对话：只更新 model，保留已有的所有字段（customTitle、generatedTitle、createdAt 等）
              const ownerRole = context.sessionOwner?.role ?? context.user!.role;
              const updated: SessionMeta = {
                ...existing,
                userRole: existing.userRole ?? ownerRole,
                ...(modelRef ? { model: modelRef } : {}),
              };
              return writeSessionMeta(transcriptPath, updated);
            }
            // 新会话：写完整初始 meta
            const meta: SessionMeta = {
              userId: context.user!.id,
              username: context.user!.username,
              userRole: context.user!.role,
              tenantId: context.user!.tenantId,
              channel: 'web',
              createdAt: new Date().toISOString(),
              ...(modelRef ? { model: modelRef } : {}),
            };
            return writeSessionMeta(transcriptPath, meta);
          }).catch((err) => {
            chatLogger.warn(`[meta] Failed to write session meta: sessionId=${sessionId} user=${context.user?.username} error=${err}`);
          });
        }
        // 新会话场景：广播 stream_started + session_status + session_updated 到同用户的其他连接
        if (context.user?.id && self.eventBus && sessionId) {
          self.eventBus.emitUser(context.user.id, {
            type: 'stream_started',
            sessionId,
            streamId: bufferCtx?.streamId || '',
          }, ws);
          self.eventBus.emitUser(context.user.id, {
            type: 'session_status',
            sessionId,
            status: 'busy',
            streamId: bufferCtx?.streamId || '',
          });
          // 通知所有连接新会话已创建（不排除发起方），可直接 upsert 到本地列表
          self.eventBus.emitDual(context.user.id, sessionId, {
            type: 'session_updated',
            sessionId,
            updatedAtMs: Date.now(),
            isNew: true,
            username: context.user.username,
            model: modelRef || undefined,
          });
        }
      },

      onThinkingStart() {
        markRealContent();
        if (shouldSendWebBlock('thinking', undefined, config)) {
          send({ type: 'block_start', blockType: 'thinking' });
        }
      },
      onThinkingDelta(content) {
        if (shouldSendWebBlock('thinking', undefined, config)) {
          send({ type: 'thinking', content });
        }
      },
      onThinkingEnd() {
        if (shouldSendWebBlock('thinking', undefined, config)) {
          send({ type: 'block_end', blockType: 'thinking' });
        }
      },

      onTextStart() {
        markRealContent();
        resetTextBlockState();
      },

      onTextDelta(content) {
        textAccumulated += content;
        // 命名上下文每轮都构造，因此 collectedAssistantText 也每轮累积前 500 字符——
        // 作 transcript 尚未落盘时的 fallback；超过 500 即停止累积，避免大流额外内存压力。
        if (collectedAssistantText.length < 500) {
          collectedAssistantText += content;
        }

        if (isBuffering) {
          textBuffer.push(content);
          const trimmed = textAccumulated.trimStart();
          const couldBeVoice = trimmed.length === 0
            || '[VOICE'.startsWith(trimmed)
            || trimmed.startsWith('[VOICE');
          if (!couldBeVoice) {
            flushTextBuffer();
          }
        } else {
          if (!textBlockStartSent) {
            send({ type: 'block_start', blockType: 'text' });
            textBlockStartSent = true;
          }
          send({ type: 'text', content });
        }
      },

      async onTextEnd(blockText) {
        const parsed = parseVoiceMarkers(blockText);
        const hasVoice = parsed.markers.length > 0;
        const cleanedText = parsed.cleanedText.replace(new RegExp(MEDIA_MARKER_CLEAN_RE.source, 'g'), '').trim();
        const hasText = cleanedText.length > 0;

        if (isBuffering) {
          if (hasVoice && !hasText) {
            sendVoiceMarkers(blockText, true);
          } else if (hasVoice && hasText) {
            send({ type: 'block_start', blockType: 'text' });
            send({ type: 'text', content: cleanedText });
            send({ type: 'block_end', blockType: 'text' });
            sendVoiceMarkers(blockText, false);
          } else if (hasText) {
            send({ type: 'block_start', blockType: 'text' });
            send({ type: 'text', content: cleanedText });
            send({ type: 'block_end', blockType: 'text' });
          }
        } else {
          send({ type: 'block_end', blockType: 'text' });
          if (hasVoice) {
            sendVoiceMarkers(blockText, false);
          }
        }

        // FILE 标记处理
        const fileMatches = [...blockText.matchAll(new RegExp(FILE_MARKER_PATTERN.source, 'g'))];
        for (const match of fileMatches) {
          try {
            const payload = JSON.parse(match[1]);
            const filePath: string = payload.filePath || payload.path;
            if (!filePath) continue;

            const userCwd = context.user && agentCwd
              ? resolveUserCwd(agentCwd, { id: context.user.id, username: context.user.username, role: context.user.role as 'admin' | 'user', tenantId: context.user.tenantId })
              : agentCwd || '';
            const absoluteFilePath = resolvePath(userCwd, filePath);
            const fileStat = await stat(absoluteFilePath).catch(() => null);
            if (!fileStat || !fileStat.isFile()) continue;

            const relativePath = absoluteFilePath.startsWith(userCwd + '/')
              ? absoluteFilePath.slice(userCwd.length + 1)
              : filePath;

            send({
              type: 'file_download',
              fileName: payload.fileName || absoluteFilePath.split('/').pop() || 'file',
              fileType: payload.fileType || '',
              filePath: relativePath,
              fileSize: fileStat.size,
              ...(context.user ? { owner: context.user.username } : {}),
            });
          } catch {
            // 解析失败，跳过
          }
        }

        resetTextBlockState();
      },

      onToolStart(toolId, toolName) {
        markRealContent();
        if (shouldSendWebBlock('tool_use', toolName, config)) {
          send({
            type: 'block_start',
            blockType: 'tool_use',
            toolName,
            toolId,
          });
        }
      },
      onToolInputDelta(partialJson, toolId, toolName) {
        if (shouldSendWebBlock('tool_use', toolName, config)) {
          send({
            type: 'tool_input',
            content: partialJson,
            toolName,
            toolId,
          });
        }
      },
      onToolEnd(_toolId, resolvedToolName) {
        if (shouldSendWebBlock('tool_use', resolvedToolName, config)) {
          send({ type: 'block_end', blockType: 'tool_use', toolName: resolvedToolName });
        }
      },

      onToolResult(toolId, toolName, result, isError) {
        if (shouldSendWebToolResult(toolName, config)) {
          send({
            type: 'tool_result',
            toolId,
            toolName,
            result,
            ...(isError ? { isError: true } : {}),
          });
        }
      },

      async onDone() {
        // done 事件携带 client_msg_id + 可选 error（SDK 错误时由 onError 写入 lastError）
        // 多设备兜底：finally 块会广播 session_status idle（user scope，含 UserEventLog），
        // 其他设备通过 session_status 匹配 sessionId 独立清 loading，不依赖 done 跨 WS 广播。
        send({
          type: 'done',
          ...(clientMsgId ? { client_msg_id: clientMsgId } : {}),
          ...(lastError ? { error: lastError } : {}),
        });
        // 更新幂等记录终态
        if (clientMsgId) {
          self.idempotencySet(context.user?.id, clientMsgId, lastError ? 'failed' : 'done', bufferCtx?.streamId ?? '');
        }
        // 元数据事件统一走 broadcastToUser（不排除发起方）——消除 send() isActive 守卫导致的事件黑洞
        const updatedSid = titleCtx?.getSessionId() ?? bufferCtx?.sessionId;
        if (updatedSid && context.user?.id && self.eventBus) {
          self.eventBus.emitDual(context.user.id, updatedSid, {
            type: 'session_updated',
            sessionId: updatedSid,
            preview: collectedAssistantText.slice(0, 200) || undefined,
            updatedAtMs: Date.now(),
          });
        }
        // 立即清除缓存，确保客户端收到 done/session_updated 后 loadSessions() 不命中旧缓存
        clearSessionsListCache();
        // 自动命名触发条件：会话 id 已就绪 + 本轮有真实文本输出。
        // 不再限定"新会话"——续聊时若 meta 仍无 customTitle/generatedTitle
        // （首轮 LLM 抖动失败、或首轮纯工具/纯思考没出文本），后续轮可补救。
        // maybeGenerateTitle 内部用 meta 防覆盖，幂等。
        if (titleCtx && collectedAssistantText.length > 0) {
          const sid = titleCtx.getSessionId();
          if (sid) {
            const title = await self.maybeGenerateTitle(sid, context, titleCtx.userMessage, collectedAssistantText);
            if (title && context.user?.id && self.eventBus) {
              self.eventBus.emitDual(context.user.id, sid, {
                type: 'title_updated',
                sessionId: sid,
                title,
              });
              // 标题生成后再清一次，确保后续请求也拿到含标题的最新数据
              clearSessionsListCache();
            }
          }
        }
      },
      onError(error) {
        // SDK 错误：记录 error 供 onDone 合并到 done 事件，不再单发 error
        // （客户端收到 done + error 后会清理 loading 状态 + 显示错误文案，无需靠 watchdog 兜底）
        lastError = error;
        chatLogger.error(`[chat] SDK error for client_msg_id=${clientMsgId}: ${error}`);
      },
      // SDK 0.2.112+ 新事件透传
      onContextUsage(usage) {
        send({
          type: 'context_usage',
          contextUsage: canViewContextUsageDetails(context, self.config.tenantStore)
            ? usage
            : redactContextUsageDetails(usage),
        });
      },
      onPluginInstall(data) {
        send({ type: 'plugin_install', pluginInstall: data });
      },
      onNotification(data) {
        // REPL 级通知跨会话可见，走 user scope
        if (context.user?.id && self.eventBus) {
          self.eventBus.emitUser(context.user.id, { type: 'notification', notification: data });
        } else {
          send({ type: 'notification', notification: data });
        }
      },
      onMemoryRecall(data) {
        send({ type: 'memory_recall', memoryRecall: data });
      },
    };

    const consumer = createEventConsumer();
    try {
      await consumer.consume(events, handler, signal);
    } finally {
      // 幽灵会话回滚：新会话从未产生任何真实内容（用户刷新/断连/立刻取消/SDK 只写了 system init）
      const phantomSessionId = bufferCtx?.sessionId;
      if (isNewSession && !hasRealContent && phantomSessionId && context.user && agentCwd) {
        const metaCwd = context.targetCwd || resolveUserCwd(agentCwd, {
          id: context.user.id,
          username: context.user.username,
          role: context.user.role as 'admin' | 'user',
          tenantId: context.user.tenantId,
        });
        const transcriptPath = getTranscriptPath(metaCwd, phantomSessionId, { tenantId: context.user.tenantId, userId: context.user.id });
        try {
          await deleteSession(phantomSessionId, { deleteSidecarDir: true });
          chatLogger.info(`[phantom-session] Rolled back empty session ${phantomSessionId} (user=${context.user.username}) path=${transcriptPath}`);
        } catch (err) {
          chatLogger.warn(`[phantom-session] Failed to delete ${phantomSessionId}: ${err}`);
        }
        // 清理 EventBuffer（用户其他设备不再能 resume 到这个会话）
        try { self.eventBufferStore.remove(phantomSessionId); } catch { /* noop */ }
        // 通知所有设备从列表移除（onSessionInit 已经 emit 过 session_updated isNew:true）
        if (self.eventBus) {
          self.eventBus.emitUser(context.user.id, {
            type: 'session_deleted',
            sessionId: phantomSessionId,
          });
        }
        clearSessionsListCache();
      }
    }
  }
}

function projectRuntimePlatformEvent(
  event: PlatformEvent,
  options: {
    clientMsgId?: string;
    /**
     * true = 展开 streamed 聚合行（assistant_thinking/message/tool_calls 的正文）。
     * 2026-07-03 起 assistant_stream_event delta 不再落库，durable replay 与跨进程
     * NOTIFY 路径的内容必须由聚合行整块补出；同进程直推已覆盖 live 的场景传 false
     * 防止重复显示。
     */
    expandStreamed?: boolean;
  } = {},
): { events: object[]; terminal?: boolean; sessionStatus?: 'completed' | 'failed' | 'cancelled'; terminalError?: string } {
  switch (event.type) {
    case 'tool_output_delta':
      return {
        events: [{
          type: 'tool_execution',
          phase: 'progress',
          toolId: event.toolCallId,
          content: event.content,
          channel: event.channel,
          invocationId: event.invocationId,
        }],
      };
    case 'tool_progress':
      return {
        events: [{
          type: 'tool_execution',
          phase: 'progress',
          toolId: event.toolCallId,
          content: event.content,
          invocationId: event.invocationId,
        }],
      };
    case 'tool_invocation_started':
      // 拥有独立卡片的工具由 ask_user / permission_request / subagent 侧通道驱动，
      // 不该再走通用 tool_execution 通道，否则前端会叠加第二条工具骨架。
      // live 通道 onToolStart 已用 shouldSendWebBlock 过滤,这里补上 replay/
      // durable/跨进程 NOTIFY 路径的兜底,与 displayFilter.ts 语义对齐。
      if (isDedicatedWebTool(event.toolName)) return { events: [] };
      return {
        events: [{
          type: 'tool_execution',
          phase: 'started',
          toolId: event.toolCallId,
          toolName: event.toolName,
          invocationId: event.invocationId,
        }],
      };
    case 'tool_invocation_completed':
      if (isDedicatedWebTool(event.toolName)) return { events: [] };
      return {
        events: [{
          type: 'tool_execution',
          phase: 'completed',
          toolId: event.toolCallId,
          toolName: event.toolName,
          invocationId: event.invocationId,
          status: event.status,
          durationMs: event.durationMs,
          ...(event.error ? { error: event.error } : {}),
        }],
      };
    case 'tool_result': {
      if (isDedicatedWebTool(event.toolName)) return { events: [] };
      const events: object[] = [{
        type: 'tool_result',
        toolId: event.toolCallId,
        toolName: event.toolName,
        content: event.content,
        result: event.content,
        isError: event.isError,
      }];
      return { events };
    }
    case 'approval_requested':
      return {
        events: [{
          type: 'permission_request',
          interactionId: event.approvalId,
          toolId: event.toolId,
          toolName: event.toolName,
          displayName: event.displayName,
          toolInput: event.input && typeof event.input === 'object'
            ? event.input as Record<string, unknown>
            : { value: event.input },
        }],
      };
    // 'assistant_stream_event'：已停写（2026-07-03）。存量历史行走 default 分支忽略；
    // replay 内容由下方 streamed 聚合行在 expandStreamed=true 时整块补出。
    case 'assistant_thinking':
      if (event.streamed && !options.expandStreamed) return { events: [] };
      return event.content
        ? { events: [
            { type: 'block_start', blockType: 'thinking' },
            { type: 'thinking', content: event.content },
            { type: 'block_end', blockType: 'thinking' },
          ] }
        : { events: [] };
    case 'assistant_message':
      if (event.streamed && !options.expandStreamed) return { events: [] };
      return event.content
        ? { events: [
            { type: 'block_start', blockType: 'text' },
            { type: 'text', content: event.content },
            { type: 'block_end', blockType: 'text' },
          ] }
        : { events: [] };
    case 'assistant_tool_calls': {
      const events: object[] = [];
      if (event.content && (!event.streamed || options.expandStreamed)) {
        events.push(
          { type: 'block_start', blockType: 'text' },
          { type: 'text', content: event.content },
          { type: 'block_end', blockType: 'text' },
        );
      }
      for (const call of event.toolCalls) {
        // 拥有独立卡片的工具不产生通用 tool_use 骨架，避免双条并存。
        if (isDedicatedWebTool(call.name)) continue;
        events.push(
          { type: 'block_start', blockType: 'tool_use', toolId: call.id, toolName: call.name },
          { type: 'tool_input', toolId: call.id, toolName: call.name, content: call.arguments },
          { type: 'block_end', blockType: 'tool_use', toolName: call.name },
        );
      }
      return { events };
    }
    case 'subagent_started':
      // 子 agent 工具（2026-07-06）：live 与 replay 共用本投影（durable 事件是
      // SubagentBlock 唯一数据源，无同进程直推路径需要防重）。agentType 字段
      // 填 description——前端 SubagentBlock 直接渲染该字段，任务概述比裸类型名
      // （general/explore）对用户友好；toolId 用父 run 的 Agent 工具 callId 锚定。
      return {
        events: [{
          type: 'subagent_start',
          toolId: event.toolCallId,
          agentType: event.description || event.agentType,
          childSessionId: event.childSessionId,
          childRunId: event.childRunId,
          model: event.model,
        }],
      };
    case 'subagent_finished':
      return {
        events: [{
          type: 'subagent_end',
          toolId: event.toolCallId,
          agentType: event.description || event.agentType,
          status: event.status,
          childSessionId: event.childSessionId,
          childRunId: event.childRunId,
          model: event.model,
          durationMs: event.durationMs,
          totalTokens: event.totalTokens,
          toolUseCount: event.toolUseCount,
          turnCount: event.turnCount,
          errorMessage: event.errorMessage,
          resultPreview: event.resultPreview,
        }],
      };
    case 'compaction':
      // /compact v2：durable replay / 跨进程 NOTIFY 路径把压缩点投影为分界线状态事件
      // （同进程直推路径由 handleRuntimeOutboundEvent 的 compaction_end case 覆盖）
      return {
        events: [{
          type: 'compaction_status',
          phase: 'completed',
          compaction: { summary: event.summary, coveredEventCount: event.coveredEventCount },
        }],
      };
    case 'run_state_changed':
      if (event.status === 'completed' || event.status === 'failed' || event.status === 'cancelled') {
        const terminalError = event.status !== 'completed' ? event.reason ?? event.status : undefined;
        return {
          events: [
            {
              type: 'session_status',
              sessionId: event.sessionId,
              status: event.status,
              runId: event.runId,
              ...(event.reason ? { reason: event.reason } : {}),
            },
            {
              type: 'done',
              ...(options.clientMsgId ? { client_msg_id: options.clientMsgId } : {}),
              ...(terminalError ? { error: terminalError } : {}),
            },
          ],
          terminal: true,
          sessionStatus: event.status,
          ...(terminalError ? { terminalError } : {}),
        };
      }
      // 非终态：PR #26 的核心增强 —— 把 running/queued/waiting_* 等 lifecycle
      // 早早推给前端,让 active 状态判定不再只能等 idle/busy 粗粒度信号。
      return {
        events: [{
          type: 'session_status',
          sessionId: event.sessionId,
          status: event.status,
          runId: event.runId,
          ...(event.reason ? { reason: event.reason } : {}),
        }],
      };
    case 'run_finished': {
      // 双保险 fallback：正常路径下 RunStoreBackedEventStore.afterAppend 会派生
      // run_state_changed{failed,reason},由上面的 case 投影 done.error/session_status.failed。
      // 这里直接识别 run_finished{subtype:'error'} 是为防 runStore 链路缺失/异常时,
      // 失败信号仍能到前端。publishRuntimePlatformEvent 用 runId 做 terminal 跨事件去重,
      // 避免与 run_state_changed 双触发。
      // success / interrupted 由 run_state_changed 处理,这里 noop。
      if (event.subtype === 'error') {
        const terminalError = event.error ?? 'error';
        return {
          events: [{
            type: 'done',
            ...(options.clientMsgId ? { client_msg_id: options.clientMsgId } : {}),
            error: terminalError,
          }],
          terminal: true,
          sessionStatus: 'failed',
          terminalError,
        };
      }
      return { events: [] };
    }
    default:
      return { events: [] };
  }
}

function getDurableEventCursor(event: PlatformEvent): string | undefined {
  const sequence = (event as PlatformEvent & { sequence?: unknown }).sequence;
  if (typeof sequence === 'number' && Number.isFinite(sequence)) return String(sequence);
  if (typeof sequence === 'string' && sequence.trim()) return sequence;
  return event.id;
}

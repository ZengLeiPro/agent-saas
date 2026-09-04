/**
 * Sessions API 路由
 *
 * 提供会话列表、详情、删除等操作。
 * 真源来自 ~/.agent-saas/legacy-transcripts/<tenantId>/<userId>/*.jsonl
 * （PR #31 起的新 Agent SaaS layout；旧 cwd-derived transcript root 不再作为在线读路径）
 */
import { Router, type Request, type Response } from "express";
import { createHash, randomUUID } from "node:crypto";
import * as path from "node:path";
import {
  listSessions,
  getTranscriptPath,
  findTranscriptPathBySessionId,
  findMetaPathBySessionId,
  deleteSession,
  deleteSessionMetaOnly,
  encodeTranscriptWindowCursor,
  listSessionMetas,
  parseTranscriptFile,
  parseTranscriptWindow,
  type ParsedTranscript,
  summarizeTranscript,
  getTokenUsage,
  isValidSessionId,
  forkSession,
  getAgentTranscriptDir,
  statTrustedTranscript,
  withTrustedTranscript,
  type SessionListItem,
} from "../data/transcripts/index.js";
import {
  readSessionMeta,
  writeSessionMeta,
  updateSessionMeta,
  resolveSessionAgentTargetForAccess,
  type SessionMeta,
} from "../data/transcripts/meta.js";
import { resolveUserCwd } from "../workspace/resolver.js";
import { TTLCache } from "../utils/cache.js";
import {
  extractTitleContext,
  generateTitleWithFallback,
  type TitleGeneratorConfig, type TitleModelAdapterFactory,
} from "../agent/titleGenerator.js";
import type { GroupStore } from "../data/groups/index.js";
import type { UserStore } from "../data/users/store.js";
import type { TokenUsageStore } from "../data/usage/store.js";
import type { BillingService } from "../data/billing/service.js";
import {
  computeCacheHitDenominatorTokens,
  computeUsageTotalTokens,
  getUsageAccountingMode,
} from "../data/usage/pricing.js";
import { interactionStore } from "../channels/web/interactionStore.js";
import { buildApprovalRecordsFromEvents } from "../runtime/approvalStore.js";
import {
  FileEventStore,
  getRuntimeEventLogPath,
} from "../runtime/fileEventStore.js";
import {
  enrichTranscriptActivityDurations,
  listActivityDurationEvents,
} from "../data/transcripts/activityDurations.js";
import {
  collectFinalOutputEventIds,
  enrichTranscriptFinalOutputs,
} from "../data/transcripts/finalOutput.js";
import type { EventStore, PlatformEvent } from "../runtime/types.js";
import { RuntimeContextUsageTracker } from "../runtime/contextUsage.js";
import { buildPendingInteractionsFromEvents, reconcileInMemoryPendingInteractions } from "../runtime/interactionProjection.js";
import { auditLog } from "../data/login-logs/index.js";
import { apiLogger } from "../utils/logger.js";
import type { EventBus } from "../channels/web/eventBus.js";
import { canAccessSession, hidesSystemSessionFrom } from "../data/sessions/access.js";
import { createSessionWarmupHandler } from "./sessionWarmup.js";
import type { AgentStore } from "../data/agents/store.js";
import type { AgentProfileInfo } from "../data/agents/types.js";
import { isAssignedToOrgAgent, type OrgAgentStore } from "../data/orgAgents/store.js";
import { DEFAULT_TENANT_ID } from "../data/tenants/types.js";
import { isShareExpired, type SessionShareSnapshot, type SessionShareStore } from "../data/sessionShares/store.js";
import { permanentlyDeleteSession, type SessionArtifactLifecycle } from './sessionPermanentDeletion.js';
import { requireSandboxPhysicalDeletion, type SandboxSessionDeletionResult } from './sandboxSessionDeletion.js'; export type { SandboxSessionDeletionResult } from './sandboxSessionDeletion.js';
import type { SessionReadStateStore } from "../data/sessionReadStateStore.js";
import { resolveSessionDetailAccess, type TaskboardSessionReadAuthorizer } from './taskboardSessionReadAccess.js';
import { collectSessionShareCandidateFiles, normalizeSessionShareFilePath, projectSessionShareSnapshot, SessionShareProjectionError } from "../data/sessionShares/publicProjection.js";
import { openTrustedFile } from "../security/trustedFile.js";
import { resolveSessionSandboxProfile } from '../runtime/sandboxProfile.js';
import { resolveSessionShareFileSelection } from './sessionShareSelection.js';
import {
  AGENT_TARGET_BINDING_VERSION,
  redactInteractionCredentials,
  type AgentTarget,
  type AgentTargetIdentitySnapshot,
  type AgentTargetUnavailableReason,
  type SessionDetailAccessMode,
  type SessionListActiveInteraction,
} from '@agent/shared';
import { parseCanonicalChatSubmission } from '@agent/shared';
import type { ChatQueueSnapshot } from '@agent/shared';
import { buildChatQueueSnapshot } from '../channels/web/chatQueueSnapshot.js';
import type { RunRecord } from '../runtime/runStoreTypes.js';
import { projectRunLiveness, type RunLiveness } from '../runtime/runLiveness.js';
import type { RuntimeSessionListQuery, RuntimeSessionListResult, RuntimeSessionProjectionRecord } from "../runtime/sessionProjectionStore.js";
// Session list enrichment and projection helpers.
import {
  buildMetaOnlyTranscript,
  buildSessionDetailPayload,
  filterProjectedQueuedMessages,
  getLastRunState,
  reqTranscriptOwner,
  resolveSessionPathForRead,
  SESSION_DETAIL_DEFAULT_PAGE_SIZE,
  SESSION_DETAIL_MAX_PAGE_SIZE,
  type LastRunState,
  type ResolvedSessionPath,
} from './sessionDetailHelpers.js';
export { buildSessionDetailPayload, filterProjectedQueuedMessages, type LastRunState } from './sessionDetailHelpers.js';
export { listDurablyProjectedQueuedRunIds } from './sessionListHelpers.js';
import {
  buildCronSessionIndex,
  buildDingtalkSessionIndex,
  listDurablyProjectedQueuedRunIds,
  projectQueuedMessageAttachments,
  stripMarkdown,
  compareCanonicalSessionKeys,
  decodeSessionListCursor,
  encodeSessionListCursor,
  isSessionAfterCursor,
  type CronSessionInfo,
} from "./sessionListHelpers.js";

// 5 分钟。所有 mutation(create/delete/rename/restore/fork...)都已主动 sessionsListCache.clear(),
// 所以 TTL 只是兜底,越长越好。
const SESSIONS_LIST_CACHE_TTL_MS = 5 * 60_000;
interface SessionSource {
  type: string;
  label: string;
}

type SessionAgent = Pick<
  AgentProfileInfo,
  "username" | "name" | "signature" | "avatar" | "avatarVersion"
>;

interface EnrichedSessionListItem extends SessionListItem {
  title?: string;
  preview?: string;
  createdAtMs?: number;
  source: SessionSource;
  owner?: {
    userId: string;
    username: string;
    realName?: string;
    avatar?: string;
    avatarVersion?: number;
  };
  agent?: SessionAgent;
  model?: string;
  cronJobId?: string;
  cronJobName?: string;
  hasUnreadAiReply?: boolean;
  version?: number;
  serverUpdatedAt?: string;
  sourceSeq?: number;
  activeInteraction?: SessionListActiveInteraction;
}

interface SessionsListResponse {
  sessions: EnrichedSessionListItem[];
  hasMore: boolean;
  nextCursor?: string;
}

interface TokenContextAccounting {
  exact: boolean;
  kind: "exact_current" | "stateful_response_exact" | "unknown";
  source: "provider_usage" | "unknown";
  label: string;
  reason?: string;
  lastRequestTokens?: number;
}

type ContextAccountingResolver = (modelRef?: string) => Omit<TokenContextAccounting, "lastRequestTokens">;

function unknownContextAccounting(): Omit<TokenContextAccounting, "lastRequestTokens"> {
  return {
    exact: false,
    kind: "unknown",
    source: "unknown",
    label: "上下文不可确认",
    reason: "当前会话缺少可解析的模型配置，不能把 transcript 最后一轮 usage 当作准确当前上下文。",
  };
}

function attachContextAccounting<T extends { contextTokens: number }>(
  usage: T,
  accounting: Omit<TokenContextAccounting, "lastRequestTokens">,
): T & { contextAccounting: TokenContextAccounting } {
  const lastRequestTokens = 'lastRequestTokens' in usage && typeof usage.lastRequestTokens === 'number'
    ? usage.lastRequestTokens
    : usage.contextTokens;
  return {
    ...usage,
    contextAccounting: {
      ...accounting,
      lastRequestTokens,
    },
  };
}

interface DurableSubagentUsage {
  childCount: number;
  requestCount: number;
  inputTokens: number;
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheHitDenominatorTokens: number;
  cacheHitRatio: number | null;
}

async function listRuntimeEventsByType(
  eventStore: EventStore,
  tenantId: string,
  sessionId: string,
  type: PlatformEvent["type"],
): Promise<PlatformEvent[]> {
  if (!eventStore.listPage) {
    const projected = await eventStore.list(tenantId, sessionId, {
      includeTypes: [type],
      projection: "usage",
    });
    return projected.filter(
      (event) => event.sessionId === sessionId && event.type === type,
    );
  }

  const events: PlatformEvent[] = [];
  let afterCursor: string | undefined;
  do {
    const page = await eventStore.listPage(tenantId, sessionId, {
      ...(afterCursor ? { afterCursor } : {}),
      limit: 500,
      type,
      projection: "usage",
    });
    events.push(...page.events.filter(
      (event) => event.sessionId === sessionId && event.type === type,
    ));
    if (!page.hasMore || !page.nextCursor || page.nextCursor === afterCursor) break;
    afterCursor = page.nextCursor;
  } while (afterCursor);
  return events;
}

async function getDurableSubagentUsage(
  tenantId: string,
  sessionId: string,
  transcriptPath: string,
  runtimeEventStoreFor?: (transcriptPath: string, tenantId: string) => EventStore,
): Promise<DurableSubagentUsage | null> {
  const parentEventStore = runtimeEventStoreFor
    ? runtimeEventStoreFor(transcriptPath, tenantId)
    : new FileEventStore(getRuntimeEventLogPath(transcriptPath), tenantId);
  const finishedEvents = await listRuntimeEventsByType(
    parentEventStore,
    tenantId,
    sessionId,
    "subagent_finished",
  );
  const children = new Map<string, string>();
  for (const event of finishedEvents) {
    if (event.type !== "subagent_finished") continue;
    children.set(event.childRunId, event.childSessionId);
  }
  if (children.size === 0) return null;

  const usage: DurableSubagentUsage = {
    childCount: children.size,
    requestCount: 0,
    inputTokens: 0,
    uncachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheHitDenominatorTokens: 0,
    cacheHitRatio: null,
  };

  await Promise.all([...children.values()].map(async (childSessionId) => {
    const childTranscriptPath = await findTranscriptPathBySessionId(childSessionId);
    const childEventStore = childTranscriptPath
      ? runtimeEventStoreFor
        ? runtimeEventStoreFor(childTranscriptPath, tenantId)
        : new FileEventStore(getRuntimeEventLogPath(childTranscriptPath), tenantId)
      : parentEventStore;
    const [toolCallEvents, messageEvents] = await Promise.all([
      listRuntimeEventsByType(childEventStore, tenantId, childSessionId, "assistant_tool_calls"),
      listRuntimeEventsByType(childEventStore, tenantId, childSessionId, "assistant_message"),
    ]);

    for (const event of [...toolCallEvents, ...messageEvents]) {
      if (
        (event.type !== "assistant_tool_calls" && event.type !== "assistant_message")
        || !event.usage
      ) continue;
      const model = event.model ?? "";
      const inputTokens = Math.max(0, Math.floor(event.usage.inputTokens ?? 0));
      const outputTokens = Math.max(0, Math.floor(event.usage.outputTokens ?? 0));
      const cacheReadTokens = Math.max(0, Math.floor(event.usage.cacheReadInputTokens ?? 0));
      const cacheCreationTokens = Math.max(0, Math.floor(event.usage.cacheCreationInputTokens ?? 0));
      const amounts = {
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
      };
      usage.requestCount += Math.max(1, Math.floor(event.usage.apiRequestCount ?? 1));
      usage.inputTokens += inputTokens;
      usage.outputTokens += outputTokens;
      usage.cacheReadTokens += cacheReadTokens;
      usage.cacheCreationTokens += cacheCreationTokens;
      usage.uncachedInputTokens += getUsageAccountingMode(model) === "cache_tokens_separate"
        ? inputTokens
        : Math.max(0, inputTokens - cacheReadTokens - cacheCreationTokens);
      usage.totalTokens += computeUsageTotalTokens(model, amounts);
      usage.cacheHitDenominatorTokens += computeCacheHitDenominatorTokens(model, amounts);
    }
  }));

  usage.cacheHitRatio = usage.cacheHitDenominatorTokens > 0
    ? usage.cacheReadTokens / usage.cacheHitDenominatorTokens
    : null;
  return usage;
}

export interface SessionsRouterOptions {
  /** Agent 工作目录（用于推导 transcript projectKey） */
  agentCwd: string;
  /** dingtalk-sessions.json 所在目录 */
  dingtalkSessionsBasePath?: string;
  /** cron run logs 目录 */
  cronRunsDir?: string;
  /** GroupStore for cascading session removal from groups */
  groupStore?: GroupStore;
  /** UserStore for resolving session owner display info */
  userStore?: UserStore;
  /** AgentStore for resolving session owner's agent display info */
  agentStore?: AgentStore;
  /** OrgAgentStore：会话列表按 meta.orgAgentId join 出专职 Agent 名称（徽标展示） */
  orgAgentStore?: OrgAgentStore;
  /** 查询会话流状态（由 WebChannel 提供） */
  getStreamStatus?: (sessionId: string) => Promise<{ active: boolean; streamId?: string; runId?: string; status?: string }>;
  /** 广播事件到指定用户的所有 WS 连接 */
  broadcastToUser?: (userId: string, data: object) => void;
  /** 中央事件总线（优先于 broadcastToUser），延迟求值避免初始化时序问题 */
  getEventBus?: () => EventBus | undefined;
  /** Title generator 配置链：主 + fallback；空表示功能未配置（接口将 501） */
  titleGeneratorConfigs?: TitleGeneratorConfig[];
  titleModelAdapterFactory?: TitleModelAdapterFactory;
  refreshSharedConfig?: () => void;
  /** 平台系统提示语热更新 getter；每次标题生成现取。 */
  getTitleSystemPrompt?: () => string;
  /** Token 用量统计 store，用于记录手动 auto-title 等基础设施模型调用 */
  tokenUsageStore?: TokenUsageStore;
  /** PG Billing；手动 auto-title 使用独立 Utility Run 的实际用量门禁。 */
  billingService?: BillingService;
  /**
   * Runtime EventStore 解析函数。pending API 列出某 session 的 replay state
   * 需要它读事件流。
   * - PG backend：返回共享 pgEventStore（按 session_id 过滤）
   * - file backend / 缺省：`new FileEventStore(getRuntimeEventLogPath(transcriptPath))`
   * 注入路径见 app/runtime.ts → routes.ts。
   */
  runtimeEventStoreFor?: (transcriptPath: string, tenantId: string) => EventStore;
  /**
   * Resolve whether transcript-derived `contextTokens` is an exact current
   * context count for this session's model. Stateful Responses chaining keeps
   * context on the provider side, so last-turn usage must not be displayed as
   * exact current context.
   */
  resolveContextAccounting?: ContextAccountingResolver;
  /** 会话只读分享存储。 */
  sessionShareStore?: SessionShareStore;
  /** Revoke on soft delete; erase metadata/blob on permanent delete. */ artifactLifecycle?: SessionArtifactLifecycle;
  /** PG 会话元数据投影；在线列表优先走索引，无 PG 的测试/开发环境回退文件扫描。 */
  sessionProjectionStore?: {
    get?(
      sessionId: string,
      options?: { tenantId?: string; includeDeleted?: boolean },
    ): Promise<RuntimeSessionProjectionRecord | null>;
    list(query?: RuntimeSessionListQuery): Promise<RuntimeSessionListResult>;
  };
  /** 用户维度会话未读状态真源。 */
  sessionReadStateStore?: SessionReadStateStore;
  /** 任务看板成员只读打开 owner 的执行会话；不得用于写入、分享或预热授权。 */
  canReadTaskboardSession?: TaskboardSessionReadAuthorizer;
  /**
   * Sandbox 预热钩子（2026-07-31 冷启动治理）：用户在会话输入框首次产生有效输入时
   * fire-and-forget 预热 ACS Sandbox。纯旁路，失败不影响输入与正式 dispatch。
   */
  sandboxWarmup?: (sessionId: string) => void; sandboxCleanupRequired?: boolean; sandboxSessionDeletionIntent?: (sessionId: string) => Promise<Exclude<SandboxSessionDeletionResult, 'deleted'>>;
  sandboxSessionDeletion?: (sessionId: string) => Promise<SandboxSessionDeletionResult>; sandboxSessionRestore?: (sessionId: string) => Promise<void>;
  /**
   * 排队插话查询（2026-08-04 终态设计）：detail API 返回仍在排队（未被目标 run
   * 消费）的插话消息，前端刷新/切会话时据此重建队列区。失败降级为空数组。
   */
  listPendingSteeringBySession?: (sessionId: string) => Promise<Array<{
    sourceRunId: string;
    targetRunId: string;
    sourceRun: { metadata?: Record<string, unknown> };
    acceptedAt: string;
  }>>;
  /** 普通 queue + 显式 steer 的统一权威 pending 快照。 */
  listPendingUserMessagesBySession?: (sessionId: string) => Promise<Array<{
    runId: string;
    sessionId: string;
    status: string;
    requestedAt: string;
    metadata: Record<string, unknown>;
  }>>;
  /** M20-02：所有 durable V1 用户提交，供 lifecycle snapshot 投影。 */
  listUserMessagesBySession?: (sessionId: string) => Promise<RunRecord[]>;
  /** clientMessageId 权威状态核验（ACK 超时/断线重连）。 */
  findRunByClientMessageId?: (userId: string | undefined, clientMessageId: string) => Promise<{
    runId: string;
    sessionId: string;
    status: string;
    statusReason?: string;
    metadata: Record<string, unknown>;
  } | null>;
}

// 模块级缓存实例（供外部清除）
const sessionsListCache = new TTLCache<SessionsListResponse>(
  SESSIONS_LIST_CACHE_TTL_MS,
  SESSIONS_LIST_CACHE_TTL_MS,
);
/** 清除会话列表缓存，供 Agent 完成时调用以确保其他端轮询获取最新数据 */
export function clearSessionsListCache(): void {
  sessionsListCache.clear();
}

/**
 * 创建会话路由
 */
export function createSessionsRouter(options: SessionsRouterOptions): Router {
  const {
    agentCwd,
    dingtalkSessionsBasePath,
    cronRunsDir,
    runtimeEventStoreFor,
  } = options;
  const router = Router();

  /**
   * 会话列表透传专职 Agent 绑定和当前请求人的可用态。
   * 可用态与 Web 消息入口保持一致：存在、启用、同租户，且员工被指派；
   * 平台 admin / 同租户组织 admin 豁免 audience。
   */
  function orgAgentFields(
    meta: SessionMeta | null,
    reqUser: Request["user"] | undefined,
  ): {
    orgAgentId?: string;
    orgAgentName?: string;
    orgAgentAvailable?: boolean;
    agentTarget?: AgentTarget;
    agentTargetBindingVersion?: number;
    agentTargetSnapshot?: AgentTargetIdentitySnapshot;
    agentTargetUnavailableReason?: AgentTargetUnavailableReason;
  } {
    if (!meta) return {};
    const resolved = resolveSessionAgentTargetForAccess(meta, meta.tenantId);
    if (resolved.status === 'unproven') {
      return {
        orgAgentAvailable: false,
        agentTargetUnavailableReason: {
          code: 'legacy_binding_unproven',
          message: '历史会话缺少可证明的 Agent 绑定，仅支持查看',
          contactAdmin: true,
        },
      };
    }
    const target = resolved.target;
    const base = {
      agentTarget: target,
      agentTargetBindingVersion: meta.agentTargetBindingVersion ?? AGENT_TARGET_BINDING_VERSION,
    };
    if (target.kind === 'personal') return {
      ...base,
      agentTargetSnapshot: meta.agentTargetSnapshot ?? { name: '个人 Agent', status: 'available', version: 1 },
    };

    const record = options.orgAgentStore?.get(target.orgAgentId);
    const adminExempt = reqUser?.role === "admin"
      && (reqUser.tenantId === DEFAULT_TENANT_ID || record?.tenantId === reqUser.tenantId);
    let reason: AgentTargetUnavailableReason | undefined;
    if (!record) {
      reason = { code: 'org_agent_deleted', message: '该企业专家已删除，历史会话仅支持查看', contactAdmin: true };
    } else if (record.tenantId !== target.tenantId || (meta.tenantId && record.tenantId !== meta.tenantId)) {
      reason = { code: 'tenant_mismatch', message: '会话与企业专家的组织不一致，仅支持查看', contactAdmin: true };
    } else if (!record.enabled) {
      reason = { code: 'org_agent_disabled', message: '该企业专家已停用，历史会话仅支持查看', contactAdmin: true };
    } else if (!record.audience || !(adminExempt || isAssignedToOrgAgent(record, meta.username))) {
      reason = { code: 'org_agent_unassigned', message: '你已无权使用该企业专家，历史会话仅支持查看', contactAdmin: true };
    }
    const status: AgentTargetIdentitySnapshot['status'] = !reason
      ? 'available'
      : reason.code === 'org_agent_deleted' ? 'deleted'
        : reason.code === 'org_agent_disabled' ? 'disabled'
          : 'revoked';
    const snapshotVersion = Math.max(
      meta.agentTargetSnapshot?.version ?? 1,
      record?.updatedAt ? Date.parse(record.updatedAt) || 1 : 1,
    );
    const agentTargetSnapshot: AgentTargetIdentitySnapshot = {
      name: reason?.code === 'tenant_mismatch' ? '企业专家' : meta.agentTargetSnapshot?.name ?? record?.name ?? '企业专家',
      status,
      version: snapshotVersion,
    };
    return {
      ...base,
      agentTargetSnapshot,
      orgAgentId: target.orgAgentId,
      orgAgentName: reason?.code === 'tenant_mismatch' ? undefined : agentTargetSnapshot.name,
      orgAgentAvailable: !reason,
      ...(reason ? { agentTargetUnavailableReason: reason } : {}),
    };
  }

  function getSessionAgent(username?: string): SessionAgent | undefined {
    if (!username) return undefined;
    const profile = options.agentStore?.getOrDefault(username);
    if (!profile) return undefined;
    return {
      username: profile.username,
      name: profile.name,
      ...(profile.signature !== undefined ? { signature: profile.signature } : {}),
      ...(profile.avatar !== undefined ? { avatar: profile.avatar } : {}),
      ...(profile.avatarVersion !== undefined ? { avatarVersion: profile.avatarVersion } : {}),
    };
  }

  /**
   * POST /api/sessions
   *
   * 立即创建一个绑定公司专职 Agent 的空会话。只写入现有 session meta，
   * 不新建另一套索引；会话列表原生支持 meta-only session。
   */
  router.post("/sessions", async (req: Request, res: Response) => {
    try {
      const user = req.user;
      if (!user) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      const orgAgentId = typeof req.body?.orgAgentId === "string"
        ? req.body.orgAgentId.trim()
        : "";
      if (!orgAgentId || orgAgentId.length > 128) {
        res.status(400).json({ error: "orgAgentId is required" });
        return;
      }

      const record = options.orgAgentStore?.get(orgAgentId);
      const adminExempt = user.role === "admin"
        && (user.tenantId === DEFAULT_TENANT_ID || record?.tenantId === user.tenantId);
      const assigned = !!record?.audience
        && (adminExempt || isAssignedToOrgAgent(record, user.username));
      if (!record || !record.enabled || record.tenantId !== user.tenantId || !assigned) {
        res.status(403).json({ error: "该企业专家当前不可用，请联系组织管理员" });
        return;
      }

      const sessionId = randomUUID();
      const now = new Date();
      const createdAt = now.toISOString();
      const cwd = resolveUserCwd(agentCwd, {
        id: user.sub,
        username: user.username,
        role: user.role,
        tenantId: user.tenantId,
      });
      const transcriptPath = getTranscriptPath(cwd, sessionId, {
        tenantId: user.tenantId,
        userId: user.sub,
      });
      await writeSessionMeta(transcriptPath, {
        userId: user.sub,
        username: user.username,
        userRole: user.role,
        tenantId: user.tenantId,
        channel: "web",
        createdAt,
        updatedAt: createdAt,
        cwd,
        transcriptPath,
        workspaceId: sessionId,
        runtimeStatus: "idle",
        sandboxProfile: 'daily',
        orgAgentId,
        agentTarget: { kind: 'org-agent', tenantId: user.tenantId, orgAgentId },
        agentTargetBindingVersion: AGENT_TARGET_BINDING_VERSION,
        agentTargetSnapshot: { name: record.name, status: 'available', version: Date.parse(record.updatedAt) || 1 },
      });
      sessionsListCache.clear();
      auditLog(req, "session_opened", `created orgAgentId=${orgAgentId} sessionId=${sessionId}`);

      res.status(201).json({
        session: {
          sessionId,
          title: "新会话",
          createdAtMs: now.getTime(),
          updatedAtMs: now.getTime(),
          source: { type: "web", label: "WEB" },
          sandboxProfile: 'daily',
          owner: {
            userId: user.sub,
            username: user.username,
          },
          orgAgentId,
          orgAgentName: record.name,
          orgAgentAvailable: true,
          agentTarget: { kind: 'org-agent', tenantId: user.tenantId, orgAgentId },
          agentTargetBindingVersion: AGENT_TARGET_BINDING_VERSION,
          agentTargetSnapshot: { name: record.name, status: 'available', version: Date.parse(record.updatedAt) || 1 },
        },
      });
    } catch (err) {
      apiLogger.error(`[sessions] create org-agent session failed: ${err instanceof Error ? err.message : String(err)}`);
      res.status(500).json({ error: "Failed to create session" });
    }
  });

  async function buildSessionDetailSnapshot(
    req: Request,
    sessionId: string,
    optionsForBuild: {
      includeDeleted?: boolean;
      transcriptWindow?: { after?: string; before?: string; limit: number };
    } = {},
  ): Promise<
    | {
        ok: true;
        meta: SessionMeta | null;
        transcriptPath: string;
        parseDurationMs: number;
        transcriptWindow?: {
          startsAtBeginning: boolean;
          latestCursor?: string;
          cursorGeneration: string;
          resolvedAfter?: string;
          resolvedBefore?: string;
          cursorInvalidated: boolean;
          indexDurationMs: number;
          readParseDurationMs: number;
        };
        detail: SessionShareSnapshot & { accessMode: SessionDetailAccessMode };
      }
    | { ok: false; status: number; error: string }
  > {
    const userCwd = resolveUserCwd(
      agentCwd,
      req.user
        ? {
            id: req.user.sub,
            username: req.user.username,
            role: req.user.role,
            tenantId: req.user.tenantId,
          }
        : undefined,
    );

    const resolvedPath = await resolveSessionPathForRead(userCwd, sessionId, reqTranscriptOwner(req.user));
    if (!resolvedPath) return { ok: false, status: 404, error: "Session not found" };
    const { transcriptPath, hasTranscript } = resolvedPath;

    const meta = await readSessionMeta(transcriptPath);
    const accessMode = await resolveSessionDetailAccess(req.user, meta, sessionId, options.userStore, options.canReadTaskboardSession); if (!accessMode) return { ok: false, status: 403, error: "Access denied" };
    if (meta?.deletedAt && (accessMode !== "owner" || !optionsForBuild.includeDeleted)) return { ok: false, status: 404, error: "Session not found" };
    if (hidesSystemSessionFrom(req.user, meta)) {
      return { ok: false, status: 404, error: "Session not found" };
    }

    const tenantId = meta?.tenantId ?? req.user?.tenantId ?? DEFAULT_TENANT_ID;
    const detailEventStore = runtimeEventStoreFor
      ? runtimeEventStoreFor(transcriptPath, tenantId)
      : new FileEventStore(getRuntimeEventLogPath(transcriptPath), tenantId);
    const parseStartedAt = Date.now();
    const parsedWindow = hasTranscript && optionsForBuild.transcriptWindow
      ? await parseTranscriptWindow(transcriptPath, optionsForBuild.transcriptWindow)
      : undefined;
    let parsed = hasTranscript
      ? parsedWindow ?? await parseTranscriptFile(transcriptPath)
      : await buildMetaOnlyTranscript(
          tenantId,
          sessionId,
          transcriptPath,
          runtimeEventStoreFor,
        );
    if (parsed.blocks.some((block) => block.kind === "thinking" || block.kind === "tool_use")) {
      try {
        parsed = enrichTranscriptActivityDurations(
          parsed,
          await listActivityDurationEvents(detailEventStore, tenantId, sessionId),
          sessionId,
        );
      } catch (err) {
        apiLogger.warn(
          `[sessions] activity enrichment failed sessionId=${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (parsed.blocks.some((block) => block.kind === "text" && block.sourceEventId)) {
      try {
        const finalOutputEvents = await detailEventStore.list(tenantId, sessionId, {
          includeTypes: ["assistant_message", "run_finished"],
        });
        parsed = enrichTranscriptFinalOutputs(
          parsed,
          collectFinalOutputEventIds(finalOutputEvents),
        );
      } catch (err) {
        apiLogger.warn(
          `[sessions] final output enrichment failed sessionId=${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const parseDurationMs = Date.now() - parseStartedAt;
    let lastRunState = await getLastRunState(detailEventStore, tenantId, sessionId);
    // 尚未开始执行的用户消息不进 transcript，统一从 durable run.wakeMessage 恢复。
    let queueSnapshot: ChatQueueSnapshot = buildChatQueueSnapshot(sessionId, []);
    let queuedMessages: Array<{
      sourceRunId: string;
      runId?: string;
      clientMsgId?: string;
      deliveryMode?: 'queue' | 'steer';
      targetRunId?: string;
      queuePosition?: number;
      content: string;
      attachments?: Array<{
        name: string;
        attachmentId: string;
        size?: number;
        mimeType?: string;
        isImage?: boolean;
      }>;
      acceptedAt: string;
    }> = [];
    if (options.listUserMessagesBySession) {
      try {
        const userMessageRuns = await options.listUserMessagesBySession(sessionId);
        queueSnapshot = buildChatQueueSnapshot(sessionId, userMessageRuns);
        if (lastRunState) {
          const lastRun = userMessageRuns.find((run) => run.runId === lastRunState!.runId);
          if (lastRun) lastRunState = { ...lastRunState, liveness: projectRunLiveness(lastRun) };
        }
      } catch (err) {
        apiLogger.warn(`[sessions] queue snapshot lookup failed sessionId=${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (options.listPendingUserMessagesBySession) {
      try {
        const queriedPending = await options.listPendingUserMessagesBySession(sessionId);
        // 普通 queue 与 steer 共用本分支：transcript 窗口 + durable user_message 双对账，
        // 过滤「已投影但 source run 尚未转出 pending」的消息，防止刷新/切回时复活（TASK-70）。
        const projectedRunIds = new Set(await listDurablyProjectedQueuedRunIds(detailEventStore, tenantId, sessionId, queriedPending, parsed.blocks));
        queuedMessages = queriedPending.flatMap((run, index) => {
          if (projectedRunIds.has(run.runId)) return [];
          const wakeMessage = run.metadata?.wakeMessage as { content?: unknown; attachments?: unknown } | undefined;
          const parsedSubmission = parseCanonicalChatSubmission(run.metadata?.chatSubmission);
          if (!parsedSubmission.ok && (!wakeMessage || typeof wakeMessage.content !== 'string')) return [];
          const clientMsgId = typeof run.metadata?.clientMsgId === 'string' ? run.metadata.clientMsgId : undefined;
          const deliveryMode = run.metadata?.deliveryMode === 'steer' ? 'steer' as const : 'queue' as const;
          const targetRunId = deliveryMode === 'steer'
            ? (typeof run.metadata?.steeringTargetRunId === 'string' ? run.metadata.steeringTargetRunId : undefined)
            : (typeof run.metadata?.queuedBehindRunId === 'string' ? run.metadata.queuedBehindRunId : undefined);
          const attachments = projectQueuedMessageAttachments(
            parsedSubmission.ok ? parsedSubmission.value.attachments : wakeMessage?.attachments,
          );
          return [{
            sourceRunId: run.runId,
            runId: run.runId,
            ...(clientMsgId ? { clientMsgId } : {}),
            deliveryMode,
            ...(targetRunId ? { targetRunId } : {}),
            queuePosition: index + 1,
            content: parsedSubmission.ok ? parsedSubmission.value.text : wakeMessage!.content as string,
            ...(attachments.length ? { attachments } : {}),
            acceptedAt: typeof run.metadata?.acceptedAt === 'string' ? run.metadata.acceptedAt : run.requestedAt,
          }];
        });
      } catch (err) {
        apiLogger.warn(`[sessions] queued message lookup failed sessionId=${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else if (options.listPendingSteeringBySession) {
      try {
        const queriedPending = await options.listPendingSteeringBySession(sessionId);
        const durableProjectedSourceRunIds = await listDurablyProjectedQueuedRunIds(
          detailEventStore, tenantId, sessionId, queriedPending, parsed.blocks,
        );
        const pending = filterProjectedQueuedMessages(queriedPending, [], durableProjectedSourceRunIds);
        queuedMessages = pending.flatMap((input, index) => {
          const wakeMessage = input.sourceRun.metadata?.wakeMessage as { content?: unknown; attachments?: unknown } | undefined;
          const parsedSubmission = parseCanonicalChatSubmission(input.sourceRun.metadata?.chatSubmission);
          if (!parsedSubmission.ok && (!wakeMessage || typeof wakeMessage.content !== 'string')) return [];
          const clientMsgId = typeof input.sourceRun.metadata?.clientMsgId === 'string' ? input.sourceRun.metadata.clientMsgId : undefined;
          const attachments = projectQueuedMessageAttachments(
            parsedSubmission.ok ? parsedSubmission.value.attachments : wakeMessage?.attachments,
          );
          return [{
            sourceRunId: input.sourceRunId,
            runId: input.sourceRunId,
            ...(clientMsgId ? { clientMsgId } : {}),
            deliveryMode: 'steer' as const,
            targetRunId: input.targetRunId,
            queuePosition: index + 1,
            content: parsedSubmission.ok ? parsedSubmission.value.text : wakeMessage!.content as string,
            ...(attachments.length ? { attachments } : {}),
            acceptedAt: input.acceptedAt,
          }];
        });
      } catch (err) {
        apiLogger.warn(`[sessions] queued steering lookup failed sessionId=${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const owner = meta
      ? (() => {
          const ownerRecord = options.userStore?.findById(meta.userId);
          return {
            userId: meta.userId,
            username: meta.username,
            realName: ownerRecord?.realName,
            avatar: ownerRecord?.avatar,
            avatarVersion: ownerRecord?.avatarVersion,
          };
        })()
      : undefined;

    const source =
      meta?.channel === "cron"
        ? { type: "cron" as const, label: meta.cronJobName || "定时任务" }
        : undefined;

    return {
      ok: true,
      meta,
      transcriptPath,
      parseDurationMs,
      ...(parsedWindow ? {
        transcriptWindow: {
          startsAtBeginning: parsedWindow.window.startsAtBeginning,
          ...(parsedWindow.window.latestCursor
            ? { latestCursor: parsedWindow.window.latestCursor }
            : {}),
          cursorGeneration: parsedWindow.window.cursorGeneration,
          ...(parsedWindow.window.resolvedAfter
            ? { resolvedAfter: parsedWindow.window.resolvedAfter }
            : {}),
          ...(parsedWindow.window.resolvedBefore
            ? { resolvedBefore: parsedWindow.window.resolvedBefore }
            : {}),
          cursorInvalidated: parsedWindow.window.cursorInvalidated,
          indexDurationMs: parsedWindow.timing.indexDurationMs,
          readParseDurationMs: parsedWindow.timing.readParseDurationMs,
        },
      } : {}),
      detail: {
        accessMode,
        sessionId: parsed.sessionId ?? sessionId,
        stats: parsed.stats,
        blocks: parsed.blocks,
        ...(owner ? { owner } : {}),
        ...(source ? { source } : {}),
        sandboxProfile: resolveSessionSandboxProfile({ existing: meta }),
        ...orgAgentFields(meta, req.user),
        ...(lastRunState ? { lastRunState } : {}),
        ...({ queueSnapshot }),
        ...(queuedMessages.length ? { queuedMessages } : {}),
      },
    };
  }

  async function readAccessibleSessionMetaForRequest(
    req: Request,
    sessionId: string,
  ): Promise<{ ok: true; meta: SessionMeta } | { ok: false; status: number; error: string }> {
    const userCwd = resolveUserCwd(
      agentCwd,
      req.user
        ? {
            id: req.user.sub,
            username: req.user.username,
            role: req.user.role,
            tenantId: req.user.tenantId,
          }
        : undefined,
    );
    const resolvedPath = await resolveSessionPathForRead(userCwd, sessionId, reqTranscriptOwner(req.user));
    if (!resolvedPath) return { ok: false, status: 404, error: "Session not found" };
    const meta = await readSessionMeta(resolvedPath.transcriptPath);
    if (!meta) return { ok: false, status: 404, error: "Session not found" };
    if (!canAccessSession(req.user, meta, options.userStore)) {
      return { ok: false, status: 403, error: "Access denied" };
    }
    if (meta?.deletedAt) return { ok: false, status: 404, error: "Session not found" };
    if (hidesSystemSessionFrom(req.user, meta)) {
      return { ok: false, status: 404, error: "Session not found" };
    }
    return { ok: true, meta };
  }

  function toShareResponse(record: Awaited<ReturnType<SessionShareStore["upsertActive"]>>) {
    return {
      enabled: !record.revokedAt && !isShareExpired(record),
      shareId: record.shareId,
      sessionId: record.sessionId,
      url: `/share/${record.token}`,
      debugMode: record.debugMode,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      expiresAt: record.expiresAt,
      revokedAt: record.revokedAt,
      accessCount: record.accessCount,
      lastAccessedAt: record.lastAccessedAt,
    };
  }

  function publicShareFileUrlToken(req: Request): string {
    return String(req.params.token || "");
  }

  function validateShareToken(token: string): boolean {
    return /^[a-zA-Z0-9_-]{16,128}$/.test(token);
  }

  async function getReadableShareRecord(token: string) {
    const store = options.sessionShareStore;
    if (!store || !validateShareToken(token)) return null;
    const record = await store.getByToken(token);
    if (!record || record.revokedAt || isShareExpired(record)) return null;
    return record;
  }

  function shareFileContentType(fileName: string): string {
    const ext = path.extname(fileName).toLowerCase();
    const mimeMap: Record<string, string> = {
      ".pdf": "application/pdf",
      ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ".xls": "application/vnd.ms-excel",
      ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ".doc": "application/msword",
      ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      ".csv": "text/csv",
      ".txt": "text/plain",
      ".json": "application/json",
      ".md": "text/markdown",
      ".html": "text/html",
      ".htm": "text/html",
      ".zip": "application/zip",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".mp3": "audio/mpeg",
      ".wav": "audio/wav",
      ".mp4": "video/mp4",
      ".mov": "video/quicktime",
      ".webm": "video/webm",
    };
    return mimeMap[ext] || "application/octet-stream";
  }

  const MAX_SESSION_SHARE_FILE_BYTES = 20 * 1024 * 1024;
  const MAX_SESSION_SHARE_TOTAL_BYTES = 50 * 1024 * 1024;
  const DEFAULT_SESSION_SHARE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const MAX_SESSION_SHARE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

  async function freezeSessionShareFiles(
    selectedFilePaths: readonly string[],
    candidateFilePaths: ReadonlySet<string>,
    userCwd: string,
  ): Promise<NonNullable<SessionShareSnapshot['allowedFiles']>> {
    const frozen: NonNullable<SessionShareSnapshot['allowedFiles']> = [];
    if (selectedFilePaths.length === 0) return frozen;
    let totalBytes = 0;
    for (const requestedPath of selectedFilePaths) {
      const normalizedPath = normalizeSessionShareFilePath(requestedPath);
      if (!normalizedPath || !candidateFilePaths.has(normalizedPath)) {
        throw new SessionShareProjectionError('所选文件不在本次会话的可分享清单中');
      }
      let trustedFile;
      try {
        trustedFile = await openTrustedFile(userCwd, normalizedPath);
      } catch {
        throw new SessionShareProjectionError('所选文件超出工作区边界');
      }
      try {
        if (!trustedFile.stats.isFile() || trustedFile.stats.size > MAX_SESSION_SHARE_FILE_BYTES) {
          throw new SessionShareProjectionError('所选文件不是普通文件或超过 20MB');
        }
        totalBytes += trustedFile.stats.size;
        if (totalBytes > MAX_SESSION_SHARE_TOTAL_BYTES) {
          throw new SessionShareProjectionError('本次分享文件总量超过 50MB');
        }
        const content = await trustedFile.handle.readFile();
        frozen.push({
          relativePath: normalizedPath,
          fileName: path.basename(normalizedPath),
          sha256: createHash('sha256').update(content).digest('hex'),
          bytes: content.byteLength,
          contentType: shareFileContentType(normalizedPath),
          contentBase64: content.toString('base64'),
        });
      } finally {
        await trustedFile.handle.close();
      }
    }
    return frozen;
  }

  async function handlePublicShareFile(req: Request, res: Response): Promise<void> {
    try {
      const token = publicShareFileUrlToken(req);
      const filePath = req.query.path as string | undefined;
      if (!filePath) {
        res.status(400).json({ error: "Missing path parameter" });
        return;
      }
      const normalizedPath = normalizeSessionShareFilePath(filePath);
      if (!normalizedPath) {
        res.status(403).json({ error: "Access denied: file is not in the share manifest" });
        return;
      }

      const record = await getReadableShareRecord(token);
      if (!record) {
        res.status(404).json({ error: "Share not found" });
        return;
      }

      const frozenFile = record.snapshot.allowedFiles?.find((file) => file.relativePath === normalizedPath);
      if (!frozenFile) {
        res.status(403).json({ error: "Access denied: file is not in the share manifest" });
        return;
      }
      if (!frozenFile.contentBase64 || !frozenFile.sha256 || frozenFile.bytes === undefined || !frozenFile.contentType) {
        res.status(410).json({ error: "Legacy shared file snapshot is unavailable" });
        return;
      }
      const content = Buffer.from(frozenFile.contentBase64, 'base64');
      const contentHash = createHash('sha256').update(content).digest('hex');
      if (content.byteLength !== frozenFile.bytes || contentHash !== frozenFile.sha256) {
        res.status(410).json({ error: "Shared file snapshot integrity check failed" });
        return;
      }
      const fileName = frozenFile.fileName;
      const contentType = frozenFile.contentType;
      const forceDownload = req.query.download === "1" || req.query.download === "true";
      const disposition = forceDownload
        ? "attachment"
        : contentType.startsWith("image/") ||
            contentType.startsWith("video/") ||
            contentType === "application/pdf"
          ? "inline"
          : "attachment";

      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Length", String(content.byteLength));
      res.setHeader(
        "Content-Disposition",
        `${disposition}; filename="${encodeURIComponent(fileName)}"`,
      );
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      res.end(content);
    } catch (err: any) {
      if (err?.code === "ENOENT") {
        res.status(404).json({ error: "File not found" });
        return;
      }
      res.status(500).json({ error: "Failed to read shared file" });
    }
  }

  /**
   * GET /api/sessions
   *
   * 列出当前项目的所有会话
   * Query params:
   *   - scope: "project" | "all" (default: "project")
   *   - limit: number (default: 100)
   */
  router.get("/sessions", async (req: Request, res: Response) => {
    const requestStartedAt = Date.now();
    const stageTimings: string[] = [];
    const markStage = (label: string, startedAt: number): void => {
      stageTimings.push(`${label}=${Date.now() - startedAt}ms`);
    };
    try {
      const scope = (req.query.scope as string) || "project";
      const limit = Math.min(parseInt(req.query.limit as string) || 200, 500);
      const before = req.query.before
        ? parseInt(req.query.before as string)
        : undefined;
      const cursorParam = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
      if (cursorParam && req.query.before !== undefined) {
        res.status(400).json({ error: 'cursor and before cannot be mixed' });
        return;
      }
      let canonicalCursor: ReturnType<typeof decodeSessionListCursor> | undefined;
      if (cursorParam) {
        try {
          canonicalCursor = decodeSessionListCursor(cursorParam);
        } catch {
          res.status(400).json({ error: 'Invalid session list cursor' });
          return;
        }
      }

      const isAdmin = req.user?.role === "admin";
      const userCwd = resolveUserCwd(
        agentCwd,
        req.user
          ? {
              id: req.user.sub,
              username: req.user.username,
              role: req.user.role,
              tenantId: req.user.tenantId,
            }
          : undefined,
      );

      // 非 admin 用户不使用缓存（结果因人而异），admin 也只看自己；未认证用户共享缓存
      const fresh = req.query.fresh === "1" || req.query.fresh === "true";
      const cacheKey =
        !fresh && !before && !canonicalCursor && !req.user ? `${scope}:${limit}` : null;

      if (cacheKey) {
        const cached = sessionsListCache.get(cacheKey);
        if (cached) {
          res.json(cached);
          return;
        }
      }

      if (scope === "all") {
        // 列出所有 projectKey 下的会话（需要扫描）
        // MVP: 先不做，支持 project scope 即可
        res
          .status(400)
          .json({ error: "scope=all not implemented yet, use scope=project" });
        return;
      }

      // 默认只列当前用户项目（per-user cwd 产生不同的 projectKey，天然隔离）。
      // enqueue-only 新会话在 pending 阶段只有 .meta.json + runtime_events，
      // 尚未生成 .jsonl；列表必须把 meta-only 会话一并纳入，否则刷新后会“消失”。
      let sessions: SessionListItem[] = [];
      let hasMore = false;
      const metaOnlySessionIds = new Set<string>();
      let authMetaMap: Map<string, SessionMeta | null> | undefined;
      const listStageStartedAt = Date.now();
      const transcriptOwner = reqTranscriptOwner(req.user);
      let projectionUsed = false;

      if (options.sessionProjectionStore && req.user) {
        try {
          const visibleRecords: RuntimeSessionProjectionRecord[] = [];
          let cursor: RuntimeSessionListQuery["cursor"] = canonicalCursor
            ? { updatedAt: new Date(canonicalCursor.updatedAtMs).toISOString(), sessionId: canonicalCursor.sessionId }
            : undefined;
          const updatedTo = !canonicalCursor && before && Number.isFinite(before)
            ? new Date(before - 1).toISOString()
            : undefined;

          // Store 单页上限 100；持续翻页直到拿够 limit+1 个真正可见会话。
          for (let guard = 0; guard < 100 && visibleRecords.length <= limit; guard++) {
            const page = await options.sessionProjectionStore.list({
              tenantId: req.user.tenantId,
              userId: req.user.sub,
              kind: "user",
              includeDeleted: false,
              limit: 100,
              ...(updatedTo ? { updatedTo } : {}),
              ...(cursor ? { cursor } : {}),
            });
            for (const record of page.items) {
              // Defense in depth: a custom/proxy projection reader cannot bypass tenant/user scope.
              if (record.tenantId !== req.user.tenantId || record.userId !== req.user.sub) continue;
              if (hidesSystemSessionFrom(req.user, record.metaJson)) continue;
              visibleRecords.push(record);
              if (visibleRecords.length > limit) break;
            }
            if (!page.nextCursor || visibleRecords.length > limit) break;
            cursor = page.nextCursor;
          }

          const projected = visibleRecords.slice(0, limit + 1);
          const entries = await Promise.all(projected.map(async (record) => {
            const transcriptPath = getTranscriptPath(userCwd, record.sessionId, transcriptOwner);
            let hasTranscript = false;
            try {
              hasTranscript = (await statTrustedTranscript(transcriptPath)).size > 0;
            } catch {
              // enqueue-only 会话尚未生成 transcript，后续从 runtime events 补 prompt。
            }
            if (!hasTranscript) metaOnlySessionIds.add(record.sessionId);
            const parsedUpdatedAt = Date.parse(record.updatedAt);
            const parsedCreatedAt = record.createdAt ? Date.parse(record.createdAt) : NaN;
            return {
              item: {
                sessionId: record.sessionId,
                projectKey: `${record.tenantId}/${record.userId ?? req.user!.sub}`,
                updatedAtMs: Number.isFinite(parsedUpdatedAt) ? parsedUpdatedAt : Date.now(),
                ...(Number.isFinite(parsedCreatedAt) ? { createdAtMs: parsedCreatedAt } : {}),
                transcriptPath,
              } satisfies SessionListItem,
              meta: record.metaJson,
            };
          }));
          sessions = entries.map((entry) => entry.item);
          authMetaMap = new Map(entries.map((entry) => [entry.item.sessionId, entry.meta]));
          projectionUsed = true;
          markStage(`listSessionsProjection[user,metaOnly=${metaOnlySessionIds.size}]`, listStageStartedAt);
        } catch (err) {
          apiLogger.warn(
            `[sessions] projection list failed, falling back to files: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      if (!projectionUsed) {
        const [transcriptResult, metaItems] = await Promise.all([
          listSessions(userCwd, { limit: Number.MAX_SAFE_INTEGER, owner: transcriptOwner }),
          listSessionMetas(userCwd, transcriptOwner),
        ]);
        const bySessionId = new Map<string, SessionListItem>();
        for (const session of transcriptResult.items) {
          bySessionId.set(session.sessionId, session);
        }
        for (const item of metaItems) {
          if (item.hasTranscript || bySessionId.has(item.sessionId)) continue;
          bySessionId.set(item.sessionId, {
            sessionId: item.sessionId,
            projectKey: item.projectKey,
            updatedAtMs: item.updatedAtMs,
            transcriptPath: item.metaPath,
          });
          metaOnlySessionIds.add(item.sessionId);
        }
        sessions = [...bySessionId.values()].sort(compareCanonicalSessionKeys);
        markStage(`listSessionsWithMeta[user,metaOnly=${metaOnlySessionIds.size}]`, listStageStartedAt);
      }

      // 构建来源反向索引
      const sourceIndexStageStartedAt = Date.now();
      const [dingtalkIndex, cronIndex] = await Promise.all([
        dingtalkSessionsBasePath
          ? buildDingtalkSessionIndex(dingtalkSessionsBasePath)
          : Promise.resolve(new Map<string, string>()),
        cronRunsDir
          ? buildCronSessionIndex(cronRunsDir)
          : Promise.resolve(new Map<string, CronSessionInfo>()),
      ]);
      markStage("buildSourceIndexes", sourceIndexStageStartedAt);

      // 补充 title/preview/source（异步并行）
      const transcriptPathById = new Map(
        sessions.map((session) => [
          session.sessionId,
          session.transcriptPath ?? getTranscriptPath(userCwd, session.sessionId, transcriptOwner),
        ] as const),
      );
      const resolveTranscriptPath = (sessionId: string): string =>
        transcriptPathById.get(sessionId) ?? getTranscriptPath(userCwd, sessionId, transcriptOwner);

      // 提前读取 meta 用于授权过滤 + 软删除过滤
      // 非 admin 使用 userCwd 路径，admin 使用 resolveTranscriptPath fallback
      if (req.user && !isAdmin) {
        const userId = req.user.sub;
        if (!authMetaMap) {
          const authMetaStageStartedAt = Date.now();
          const entries = await Promise.all(
            sessions.map(async (session) => {
              const transcriptPath = resolveTranscriptPath(session.sessionId);
              const meta = await readSessionMeta(transcriptPath);
              return [session.sessionId, meta] as const;
            }),
          );
          authMetaMap = new Map(entries);
          markStage("readSessionMeta[user]", authMetaStageStartedAt);
        }
        // 权限过滤：只保留属于当前用户的会话 + 排除软删除 + 隐藏系统轮询会话
        // + 隐藏子 agent hidden session（kind='subagent'，2026-07-06——执行细节
        //   经父会话的 SubagentBlock / Run Trace 观测，不作为独立会话展示）
        sessions = sessions.filter((s) => {
          const meta = authMetaMap!.get(s.sessionId);
          if (!meta || meta.userId !== userId || meta.deletedAt) return false;
          if (meta.kind === "subagent") return false;
          if (hidesSystemSessionFrom(req.user, meta)) return false;
          return true;
        });
      } else {
        // Admin / 未认证用户：读取 meta 过滤软删除
        if (!authMetaMap) {
          const authMetaStageStartedAt = Date.now();
          const entries = await Promise.all(
            sessions.map(async (session) => {
              const transcriptPath = resolveTranscriptPath(session.sessionId);
              const meta = await readSessionMeta(transcriptPath);
              return [session.sessionId, meta] as const;
            }),
          );
          authMetaMap = new Map(entries);
          markStage("readSessionMeta[admin]", authMetaStageStartedAt);
        }
        sessions = sessions.filter((s) => {
          const meta = authMetaMap!.get(s.sessionId);
          if (meta?.deletedAt) return false;
          // 子 agent hidden session 对 admin 列表同样隐藏（Run Trace 按 parentRunId 可查）
          if (meta?.kind === "subagent") return false;
          // role=admin 同时包含组织管理员；记忆轮询只允许 pantheon 平台管理员看到。
          if (hidesSystemSessionFrom(req.user, meta)) return false;
          return true;
        });
      }

      sessions.sort(compareCanonicalSessionKeys);
      if (!projectionUsed && canonicalCursor) sessions = sessions.filter((session) => isSessionAfterCursor(session, canonicalCursor));
      if (!projectionUsed && !canonicalCursor && before) sessions = sessions.filter((session) => session.updatedAtMs < before);
      const totalVisibleSessions = sessions.length;
      hasMore = totalVisibleSessions > limit;
      sessions = sessions.slice(0, limit);

      const enrichStageStartedAt = Date.now();
      const enrichedSessions: EnrichedSessionListItem[] = await Promise.all(
        sessions.map(async (session) => {
          const transcriptPath = resolveTranscriptPath(session.sessionId);

          // 确定来源：dingtalk > cron > web
          let source: { type: string; label: string };
          const dingtalkNick = dingtalkIndex.get(session.sessionId);
          const cronInfo = cronIndex.get(session.sessionId);
          if (dingtalkNick) {
            source = { type: "dingtalk", label: dingtalkNick };
          } else if (cronInfo) {
            source = { type: "cron", label: "cron" };
          } else {
            source = { type: "web", label: "WEB" };
          }

          // 读取 meta（非 admin 复用授权阶段已读取的结果）
          const meta =
            authMetaMap?.get(session.sessionId) ??
            (await readSessionMeta(transcriptPath));
          let owner:
            | {
                userId: string;
                username: string;
                realName?: string;
                avatar?: string;
                avatarVersion?: number;
              }
            | undefined;
          if (meta) {
            const ownerRecord = options.userStore?.findById(meta.userId);
            owner = {
              userId: meta.userId,
              username: meta.username,
              realName: ownerRecord?.realName,
              avatar: ownerRecord?.avatar,
              avatarVersion: ownerRecord?.avatarVersion,
            };
          }
          const agent = getSessionAgent(owner?.username);

          // cron 会话兜底：即使 run log 被清理，meta.channel 仍能标识来源
          if (meta?.channel === "cron" && source.type !== "cron") {
            source = { type: "cron", label: meta.cronJobName || "定时任务" };
          } else if (source.type === "cron" && meta?.cronJobName) {
            source = { type: "cron", label: meta.cronJobName };
          }

          if (metaOnlySessionIds.has(session.sessionId)) {
            const transcript = await buildMetaOnlyTranscript(
              meta?.tenantId ?? req.user?.tenantId ?? DEFAULT_TENANT_ID,
              session.sessionId,
              transcriptPath,
              runtimeEventStoreFor,
            );
            const prompts = transcript.blocks
              .filter((block) => block.kind === "prompt" && typeof block.content === "string")
              .map((block) => ({ content: block.content, tsMs: block.tsMs }));
            const firstPrompt = prompts[0];
            const latestPrompt = prompts.at(-1);
            const promptTitle = firstPrompt?.content
              ? stripMarkdown(firstPrompt.content).slice(0, 80)
              : undefined;
            const preview = latestPrompt?.content
              ? stripMarkdown(latestPrompt.content).slice(0, 200)
              : firstPrompt?.content
                ? stripMarkdown(firstPrompt.content).slice(0, 200)
                : undefined;
            const createdAtFromMeta = meta?.createdAt
              ? Date.parse(meta.createdAt)
              : NaN;
            const cronTitle = meta?.cronJobName || cronInfo?.jobName;
            const title =
              meta?.customTitle ||
              meta?.generatedTitle ||
              cronTitle ||
              promptTitle ||
              "新会话";
            const sessionModel = cronInfo?.model || meta?.model;
            const { transcriptPath: _transcriptPath, ...publicSession } = session;
            return {
              ...publicSession,
              version: meta?.updatedAt ? Date.parse(meta.updatedAt) : session.updatedAtMs,
              serverUpdatedAt: meta?.updatedAt ?? new Date(session.updatedAtMs).toISOString(),
              sourceSeq: meta?.updatedAt ? Date.parse(meta.updatedAt) : session.updatedAtMs,
              title,
              preview,
              createdAtMs: Number.isFinite(createdAtFromMeta)
                ? createdAtFromMeta
                : firstPrompt?.tsMs ?? session.updatedAtMs,
              source,
              ...(owner ? { owner } : {}),
              ...(agent ? { agent } : {}),
              ...(sessionModel ? { model: sessionModel } : {}),
              sandboxProfile: resolveSessionSandboxProfile({ existing: meta }),
              ...orgAgentFields(meta, req.user),
              ...(cronInfo
                ? { cronJobId: cronInfo.jobId, cronJobName: cronInfo.jobName }
                : {}),
            };
          }

          try {
            const summary = await summarizeTranscript(transcriptPath);

            // 标题优先级：customTitle > cronJobName(meta) > cronJobName(runLog) > generatedTitle > transcript
            const autoTitle =
              source.type === "cron" && (meta?.cronJobName || cronInfo?.jobName)
                ? meta?.cronJobName || cronInfo!.jobName
                : meta?.generatedTitle || summary.title;
            const title = meta?.customTitle || autoTitle;

            // 预览剥离 markdown 语法
            const preview = summary.preview
              ? stripMarkdown(summary.preview).slice(0, 200)
              : undefined;

            // model 优先级：cron 配置 > meta 记录
            const sessionModel = cronInfo?.model || meta?.model;

            const { transcriptPath: _transcriptPath, ...publicSession } = session;
            return {
              ...publicSession,
              version: meta?.updatedAt ? Date.parse(meta.updatedAt) : session.updatedAtMs,
              serverUpdatedAt: meta?.updatedAt ?? new Date(session.updatedAtMs).toISOString(),
              sourceSeq: meta?.updatedAt ? Date.parse(meta.updatedAt) : session.updatedAtMs,
              title,
              preview,
              createdAtMs: summary.createdAtMs ?? session.updatedAtMs,
              source,
              ...(owner ? { owner } : {}),
              ...(agent ? { agent } : {}),
              ...(sessionModel ? { model: sessionModel } : {}),
              sandboxProfile: resolveSessionSandboxProfile({ existing: meta }),
              ...orgAgentFields(meta, req.user),
              ...(cronInfo
                ? { cronJobId: cronInfo.jobId, cronJobName: cronInfo.jobName }
                : {}),
            };
          } catch {
            // 如果读取失败，返回基本信息
            const sessionModel = cronInfo?.model || meta?.model;
            const { transcriptPath: _transcriptPath, ...publicSession } = session;
            return {
              ...publicSession,
              version: meta?.updatedAt ? Date.parse(meta.updatedAt) : session.updatedAtMs,
              serverUpdatedAt: meta?.updatedAt ?? new Date(session.updatedAtMs).toISOString(),
              sourceSeq: meta?.updatedAt ? Date.parse(meta.updatedAt) : session.updatedAtMs,
              source,
              ...(owner ? { owner } : {}),
              ...(agent ? { agent } : {}),
              ...(sessionModel ? { model: sessionModel } : {}),
              sandboxProfile: resolveSessionSandboxProfile({ existing: meta }),
              ...orgAgentFields(meta, req.user),
              ...(cronInfo
                ? { cronJobId: cronInfo.jobId, cronJobName: cronInfo.jobName }
                : {}),
            };
          }
        }),
      );

      markStage(
        `enrichSessions[count=${sessions.length}]`,
        enrichStageStartedAt,
      );
      let visibleSessions = enrichedSessions;
      if (options.sessionReadStateStore && req.user && scope !== "all") {
        const unreadSessionIds = await options.sessionReadStateStore.listUnreadSessionIds({
          tenantId: req.user.tenantId,
          userId: req.user.sub,
          sessionIds: visibleSessions.map((session) => session.sessionId),
        });
        visibleSessions = visibleSessions.map((session) => ({
          ...session,
          hasUnreadAiReply: unreadSessionIds.has(session.sessionId),
        }));
      }

      visibleSessions = visibleSessions.map((session) => {
        const activeInteraction = interactionStore.getActiveInteraction(session.sessionId);
        return activeInteraction ? { ...session, activeInteraction } : session;
      });
      const lastVisibleSession = visibleSessions[visibleSessions.length - 1];
      const nextCursor = hasMore && lastVisibleSession
        ? encodeSessionListCursor({ updatedAtMs: lastVisibleSession.updatedAtMs, sessionId: lastVisibleSession.sessionId })
        : undefined;
      const payload: SessionsListResponse = { sessions: visibleSessions, hasMore, ...(nextCursor ? { nextCursor } : {}) };
      if (cacheKey) {
        sessionsListCache.set(cacheKey, payload);
      }
      const totalDurationMs = Date.now() - requestStartedAt;
      if (totalDurationMs >= 800) {
        apiLogger.warn(
          `[sessions] slow list ${totalDurationMs}ms scope=${scope} limit=${limit} cursor=${cursorParam ?? 'none'} before=${before ?? "none"} count=${visibleSessions.length} hasMore=${hasMore} stages=${stageTimings.join(", ")}`,
        );
      }
      res.json(payload);
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err);
      if (msg.includes("outside allowed directory")) {
        res.status(403).json({ error: msg });
        return;
      }
      res.status(500).json({ error: msg });
    }
  });

  /**
   * GET /api/sessions/trash
   *
   * Admin 回收站：列出所有用户已软删除的会话
   *
   * 直接扫描 .meta.json 文件而非依赖 .jsonl，
   * 确保即使 transcript 文件丢失（如历史迁移），软删除的会话仍可见。
   */
  router.get("/sessions/trash", async (req: Request, res: Response) => {
    try {
      // 只扫描当前登录用户自己的 projectKey。
      const userCwd = resolveUserCwd(
        agentCwd,
        req.user
          ? {
              id: req.user.sub,
              username: req.user.username,
              role: req.user.role,
              tenantId: req.user.tenantId,
            }
          : undefined,
      );

      // 扫描当前用户新旧布局下的 .meta.json 文件（不依赖 .jsonl 存在）
      const allMetas = await listSessionMetas(userCwd, reqTranscriptOwner(req.user));

      // 去重 + 读 meta 并过滤 deletedAt
      const seen = new Set<string>();
      const deletedEntries: {
        item: (typeof allMetas)[0];
        meta: SessionMeta;
      }[] = [];
      await Promise.all(
        allMetas.map(async (item) => {
          if (seen.has(item.sessionId)) return;
          seen.add(item.sessionId);
          const meta = await readSessionMeta(item.metaPath);
          if (meta?.deletedAt) {
            deletedEntries.push({ item, meta });
          }
        }),
      );

      // 构建来源索引
      const [dingtalkIndex, cronIndex] = await Promise.all([
        dingtalkSessionsBasePath
          ? buildDingtalkSessionIndex(dingtalkSessionsBasePath)
          : Promise.resolve(new Map<string, string>()),
        cronRunsDir
          ? buildCronSessionIndex(cronRunsDir)
          : Promise.resolve(new Map<string, CronSessionInfo>()),
      ]);

      // Enrich
      const enriched = await Promise.all(
        deletedEntries.map(async ({ item, meta }) => {
          const dingtalkNick = dingtalkIndex.get(item.sessionId);
          const cronInfo = cronIndex.get(item.sessionId);
          let source: SessionSource;
          if (dingtalkNick) source = { type: "dingtalk", label: dingtalkNick };
          else if (cronInfo)
            source = {
              type: "cron",
              label: meta.cronJobName || cronInfo.jobName || "cron",
            };
          else if (meta.channel === "cron")
            source = { type: "cron", label: meta.cronJobName || "定时任务" };
          else source = { type: "web", label: "WEB" };

          const ownerRecord = options.userStore?.findById(meta.userId);
          const owner = {
            userId: meta.userId,
            username: meta.username,
            realName: ownerRecord?.realName,
            avatar: ownerRecord?.avatar,
            avatarVersion: ownerRecord?.avatarVersion,
          };
          const agent = getSessionAgent(owner.username);

          let title: string | undefined;
          let preview: string | undefined;
          let createdAtMs: number | undefined;

          // 有 transcript 时读取完整摘要；否则仅用 meta 信息
          if (item.hasTranscript) {
            try {
              const summary = await summarizeTranscript(item.metaPath);
              const autoTitle =
                source.type === "cron" &&
                (meta.cronJobName || cronInfo?.jobName)
                  ? meta.cronJobName || cronInfo!.jobName
                  : meta.generatedTitle || summary.title;
              title = meta.customTitle || autoTitle;
              preview = summary.preview
                ? stripMarkdown(summary.preview).slice(0, 200)
                : undefined;
              createdAtMs = summary.createdAtMs ?? item.updatedAtMs;
            } catch {
              // fall through to meta-only
            }
          }
          if (!title) {
            title =
              meta.customTitle ||
              meta.generatedTitle ||
              meta.cronJobName ||
              undefined;
            createdAtMs = meta.createdAt
              ? new Date(meta.createdAt).getTime()
              : item.updatedAtMs;
          }

          return {
            sessionId: item.sessionId,
            updatedAtMs: item.updatedAtMs,
            createdAtMs,
            title,
            preview,
            source,
            owner,
            agent,
            model: cronInfo?.model || meta.model,
            sandboxProfile: resolveSessionSandboxProfile({ existing: meta }),
            deletedAt: meta.deletedAt,
            deletedBy: meta.deletedBy,
            hasTranscript: item.hasTranscript,
            ...(cronInfo
              ? { cronJobId: cronInfo.jobId, cronJobName: cronInfo.jobName }
              : {}),
          };
        }),
      );

      // 按 deletedAt 倒序
      enriched.sort((a, b) => {
        const da = a.deletedAt ? new Date(a.deletedAt).getTime() : 0;
        const db = b.deletedAt ? new Date(b.deletedAt).getTime() : 0;
        return db - da;
      });

      res.json({ sessions: enriched });
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err);
      res.status(500).json({ error: msg });
    }
  });

  /** 永久清空当前用户自己的回收站。 */
  router.delete("/sessions/trash", async (req: Request, res: Response) => {
    try {
      if (!req.user) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      const userCwd = resolveUserCwd(agentCwd, {
        id: req.user.sub,
        username: req.user.username,
        role: req.user.role,
        tenantId: req.user.tenantId,
      });
      const allMetas = await listSessionMetas(userCwd, reqTranscriptOwner(req.user));
      let deletedCount = 0;
      const failedSessionIds: string[] = [];

      for (const item of allMetas) {
        const meta = await readSessionMeta(item.metaPath);
        if (!meta?.deletedAt || meta.userId !== req.user.sub) continue;

        try {
          const deleted = await permanentlyDeleteSession({
            sessionId: item.sessionId,
            ownerUserId: meta.userId,
            hasTranscript: item.hasTranscript,
            artifactLifecycle: options.artifactLifecycle, isStillDeleted: async () => readSessionMeta(item.metaPath).then(meta => !!meta?.deletedAt && meta.userId === req.user!.sub), beforePhysicalDelete: () => requireSandboxPhysicalDeletion(options, item.sessionId),
            deleteTranscriptPreservingMeta: async () => !item.hasTranscript || (await deleteSession(item.sessionId, { preserveMeta: true })).deleted,
            deleteMetaAndSidecar: async () => (await deleteSessionMetaOnly(item.sessionId, { deleteSidecarDir: true })).deleted,
          });
          if (!deleted) {
            failedSessionIds.push(item.sessionId);
            continue;
          }
          if (options.groupStore) {
            await options.groupStore.removeSessionFromAllGroups(item.sessionId);
          }
          auditLog(req, "session_permanently_deleted", item.sessionId);
          deletedCount += 1;
        } catch (err) {
          failedSessionIds.push(item.sessionId);
          apiLogger.error(
            `[sessions] clear trash failed sessionId=${item.sessionId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      sessionsListCache.clear();
      if (failedSessionIds.length > 0) {
        res.status(500).json({
          error: `部分会话清空失败（成功 ${deletedCount} 个，失败 ${failedSessionIds.length} 个）`,
          deletedCount,
          failedCount: failedSessionIds.length,
        });
        return;
      }
      res.json({ ok: true, deletedCount });
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err);
      if (msg.includes("outside allowed directory")) {
        res.status(403).json({ error: msg });
        return;
      }
      res.status(500).json({ error: msg });
    }
  });

  /**
   * GET /api/share/sessions/:token
   *
   * 公开只读分享页读取快照。鉴权中间件会放行该路径；这里不触达原会话权限。
   */
  router.get("/share/sessions/:token", async (req: Request, res: Response) => {
    try {
      const store = options.sessionShareStore;
      if (!store) {
        res.status(404).json({ error: "Share not found" });
        return;
      }
      const token = String(req.params.token || "");
      if (!/^[a-zA-Z0-9_-]{16,128}$/.test(token)) {
        res.status(404).json({ error: "Share not found" });
        return;
      }

      const record = await store.getByToken(token);
      if (!record) {
        res.status(404).json({ error: "Share not found" });
        return;
      }
      if (record.revokedAt) {
        res.status(410).json({ error: "Share revoked" });
        return;
      }
      if (isShareExpired(record)) {
        res.status(410).json({ error: "Share expired" });
        return;
      }

      await store.markAccessed(record.shareId).catch((err) => {
        apiLogger.warn(
          `[sessions] mark share accessed failed shareId=${record.shareId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });

      const safeSnapshot = projectSessionShareSnapshot(record.snapshot);
      res.setHeader("Cache-Control", "no-store");
      res.json({
        share: {
          ownerUsername: safeSnapshot.owner?.username ?? "用户",
          debugMode: true,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          expiresAt: record.expiresAt,
          accessCount: record.accessCount + 1,
          lastAccessedAt: new Date().toISOString(),
        },
        detail: safeSnapshot,
      });
    } catch (err) {
      if (err instanceof SessionShareProjectionError) {
        res.status(410).json({ error: "Share is not safe to publish" });
        return;
      }
      res.status(500).json({ error: "暂时无法读取分享内容" });
    }
  });

  router.get("/share/sessions/:token/file", (req: Request, res: Response) => {
    void handlePublicShareFile(req, res);
  });

  router.head("/share/sessions/:token/file", (req: Request, res: Response) => {
    void handlePublicShareFile(req, res);
  });

  /**
   * GET /api/sessions/:sessionId/share
   *
   * 获取当前会话的有效分享设置。
   */
  router.get("/sessions/:sessionId/share", async (req: Request, res: Response) => {
    try {
      const { sessionId } = req.params;
      if (!isValidSessionId(sessionId)) {
        res.status(400).json({ error: "Invalid sessionId format" });
        return;
      }
      const store = options.sessionShareStore;
      if (!store) {
        res.status(501).json({ error: "Session share store not configured" });
        return;
      }

      const access = await readAccessibleSessionMetaForRequest(req, sessionId);
      if (!access.ok) {
        res.status(access.status).json({ error: access.error });
        return;
      }

      const record = await store.getActiveBySession(sessionId, access.meta.userId);
      if (!record) {
        res.json({ enabled: false });
        return;
      }
      res.json(toShareResponse(record));
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err);
      if (msg.includes("outside allowed directory")) {
        res.status(403).json({ error: msg });
        return;
      }
      res.status(500).json({ error: msg });
    }
  });

  router.get("/sessions/:sessionId/share-preview", async (req: Request, res: Response) => {
    try {
      const { sessionId } = req.params;
      if (!isValidSessionId(sessionId)) {
        res.status(400).json({ error: "Invalid sessionId format" });
        return;
      }
      const built = await buildSessionDetailSnapshot(req, sessionId);
      if (!built.ok) {
        res.status(built.status).json({ error: built.error });
        return;
      }
      const candidates = collectSessionShareCandidateFiles(built.detail.blocks);
      const inlineFilePaths = candidates
        .filter((file) => file.inlineInBody)
        .map((file) => file.relativePath);
      const projected = projectSessionShareSnapshot(built.detail, { selectedFilePaths: inlineFilePaths });
      res.json({
        blockCount: projected.blocks.filter((block) => block.kind === "prompt" || block.kind === "text").length,
        files: candidates,
        defaultExpiresAt: new Date(Date.now() + DEFAULT_SESSION_SHARE_TTL_MS).toISOString(),
      });
    } catch (err) {
      if (err instanceof SessionShareProjectionError) {
        res.status(422).json({ error: err.message, code: err.code });
        return;
      }
      res.status(500).json({ error: "暂时无法生成分享预览" });
    }
  });

  /**
   * POST /api/sessions/:sessionId/share
   *
   * 生成或更新当前会话的只读分享快照。
   */
  router.post("/sessions/:sessionId/share", async (req: Request, res: Response) => {
    try {
      const { sessionId } = req.params;
      if (!isValidSessionId(sessionId)) {
        res.status(400).json({ error: "Invalid sessionId format" });
        return;
      }
      const store = options.sessionShareStore;
      if (!store) {
        res.status(501).json({ error: "Session share store not configured" });
        return;
      }

      const body = (req.body ?? {}) as {
        expiresAt?: unknown;
        confirmPublicText?: unknown;
        filePaths?: unknown;
      };
      if (body.confirmPublicText !== true) {
        res.status(400).json({ error: "请确认公开当前会话" });
        return;
      }
      let expiresAt = new Date(Date.now() + DEFAULT_SESSION_SHARE_TTL_MS).toISOString();
      if (typeof body.expiresAt === "string" && body.expiresAt.trim()) {
        const parsed = Date.parse(body.expiresAt);
        if (!Number.isFinite(parsed) || parsed <= Date.now() || parsed - Date.now() > MAX_SESSION_SHARE_TTL_MS) {
          res.status(400).json({ error: "Invalid expiresAt" });
          return;
        }
        expiresAt = new Date(parsed).toISOString();
      }

      const built = await buildSessionDetailSnapshot(req, sessionId);
      if (!built.ok) {
        res.status(built.status).json({ error: built.error });
        return;
      }
      if (!built.meta) {
        res.status(404).json({ error: "Session not found" });
        return;
      }

      const candidates = collectSessionShareCandidateFiles(built.detail.blocks);
      const candidatePaths = new Set(candidates.map((file) => file.relativePath));
      const selection = resolveSessionShareFileSelection(body.filePaths, candidates);
      if (!selection.ok) {
        res.status(400).json({ error: selection.error });
        return;
      }
      const userCwd = resolveUserCwd(agentCwd, {
        id: built.meta.userId,
        username: built.meta.username,
        role: "user",
        tenantId: req.user?.tenantId || DEFAULT_TENANT_ID,
      });
      const projected = projectSessionShareSnapshot(built.detail, { selectedFilePaths: selection.filePaths });
      const frozenFiles = await freezeSessionShareFiles(selection.filePaths, candidatePaths, userCwd);
      const record = await store.upsertActive({
        sessionId,
        tenantId: req.user?.tenantId || DEFAULT_TENANT_ID,
        ownerUserId: built.meta.userId,
        ownerUsername: built.meta.username,
        createdByUserId: req.user?.sub || built.meta.userId,
        debugMode: true,
        snapshot: { ...projected, allowedFiles: frozenFiles },
        expiresAt,
      });
      auditLog(req, "session_share_updated", sessionId);
      res.json(toShareResponse(record));
    } catch (err) {
      if (err instanceof SessionShareProjectionError) {
        res.status(422).json({ error: err.message, code: err.code });
        return;
      }
      const msg = String(err instanceof Error ? err.message : err);
      if (msg.includes("outside allowed directory")) {
        res.status(403).json({ error: msg });
        return;
      }
      res.status(500).json({ error: msg });
    }
  });

  /**
   * DELETE /api/sessions/:sessionId/share
   *
   * 撤销当前会话的公开分享链接。
   */
  router.delete("/sessions/:sessionId/share", async (req: Request, res: Response) => {
    try {
      const { sessionId } = req.params;
      if (!isValidSessionId(sessionId)) {
        res.status(400).json({ error: "Invalid sessionId format" });
        return;
      }
      const store = options.sessionShareStore;
      if (!store) {
        res.status(501).json({ error: "Session share store not configured" });
        return;
      }

      const access = await readAccessibleSessionMetaForRequest(req, sessionId);
      if (!access.ok) {
        res.status(access.status).json({ error: access.error });
        return;
      }

      const revoked = await store.revokeBySession(sessionId, access.meta.userId);
      if (revoked) auditLog(req, "session_share_revoked", sessionId);
      res.json({ ok: true, enabled: false });
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err);
      if (msg.includes("outside allowed directory")) {
        res.status(403).json({ error: msg });
        return;
      }
      res.status(500).json({ error: msg });
    }
  });

  /**
   * PUT /api/sessions/:sessionId/read
   *
   * 将当前用户在该会话的未读状态推进到最新关注版本。
   */
  router.put("/sessions/:sessionId/read", async (req: Request, res: Response) => {
    try {
      if (!req.user) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
      if (!options.sessionReadStateStore) {
        res.status(503).json({ error: "Session read state store unavailable" });
        return;
      }

      const { sessionId } = req.params;
      if (!isValidSessionId(sessionId)) {
        res.status(400).json({ error: "Invalid session ID format" });
        return;
      }

      let resolved: ResolvedSessionPath | null = null;
      const projectedSession = await options.sessionProjectionStore?.get?.(sessionId, {
        tenantId: req.user.tenantId,
      });
      if (projectedSession) {
        if (projectedSession.userId && projectedSession.userId !== req.user.sub) {
          res.status(403).json({ error: "Access denied" });
          return;
        }
        const userCwd = resolveUserCwd(agentCwd, {
          id: req.user.sub,
          username: req.user.username,
          role: req.user.role,
          tenantId: req.user.tenantId,
        });
        resolved = await resolveSessionPathForRead(
          userCwd,
          sessionId,
          reqTranscriptOwner(req.user),
        );
      } else if (options.sessionProjectionStore?.get) {
        res.status(404).json({ error: "Session not found" });
        return;
      } else {
        const userCwd = resolveUserCwd(agentCwd, {
          id: req.user.sub,
          username: req.user.username,
          role: req.user.role,
          tenantId: req.user.tenantId,
        });
        resolved = await resolveSessionPathForRead(
          userCwd,
          sessionId,
          reqTranscriptOwner(req.user),
        );
        if (!resolved) {
          res.status(404).json({ error: "Session not found" });
          return;
        }
      }

      const readScope = { tenantId: req.user.tenantId, userId: req.user.sub, sessionId };
      const changed = await options.sessionReadStateStore.markRead(readScope);
      const readState = await options.sessionReadStateStore.getState?.(readScope);
      const updatedAt = readState?.updatedAt ?? new Date().toISOString();
      const serverVersion = Math.max(readState?.attentionVersion ?? 0, readState?.readVersion ?? 0);
      const readSeq = readState?.readVersion ?? serverVersion;
      if (changed) {
        const store = resolved
          ? options.runtimeEventStoreFor?.(resolved.transcriptPath, req.user.tenantId)
          : undefined;
        if (store) {
          await store.append({
            type: "session_read_state_changed",
            sessionId,
            userId: req.user.sub,
            hasUnreadAiReply: false,
            readSeq,
            serverVersion,
            updatedAt,
            sourceSeq: readSeq,
          }, { tenantId: req.user.tenantId });
        } else {
          const readEvent = {
            type: "session_read_state_changed",
            sessionId,
            hasUnreadAiReply: false,
            readSeq,
            serverVersion,
            updatedAt,
            sourceSeq: readSeq,
          } as const;
          const eventBus = options.getEventBus?.();
          if (eventBus) {
            eventBus.emitUser(req.user.sub, readEvent);
          } else {
            options.broadcastToUser?.(req.user.sub, readEvent);
          }
        }
      }
      res.json({ ok: true, sessionId, hasUnreadAiReply: false, ack: { status: changed ? "applied" : "duplicate", sessionId, hasUnreadAiReply: false, readSeq, serverVersion, updatedAt } });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      res.status(500).json({ error: String(err instanceof Error ? err.message : err) });
    }
  });

  /**
   * GET /api/sessions/:sessionId
   *
   * 获取会话详情（历史消息）
   */
  /** ACK 丢失/前端超时后的权威核验；同 clientMessageId 永远指向同一 run。 */
  router.get("/messages/:clientMessageId/status", async (req: Request, res: Response) => {
    const clientMessageId = String(req.params.clientMessageId || "").trim();
    if (!clientMessageId || clientMessageId.length > 256 || !options.findRunByClientMessageId) {
      res.status(404).json({ error: "Message not found" });
      return;
    }
    try {
      const run = await options.findRunByClientMessageId(req.user?.sub, clientMessageId);
      if (!run) {
        res.status(404).json({ error: "Message not found" });
        return;
      }
      const deliveryMode = run.metadata?.deliveryMode === 'steer' ? 'steer' : 'queue';
      const status = run.status === 'pending'
        ? 'queued'
        : ['running', 'waiting_approval', 'waiting_user', 'waiting_hand'].includes(run.status)
          ? 'running'
          : run.status === 'completed'
            ? 'completed'
            : run.status === 'cancelled'
              ? 'cancelled'
              : 'failed';
      let queuePosition: number | undefined;
      if (status === 'queued' && options.listPendingUserMessagesBySession) {
        const pending = await options.listPendingUserMessagesBySession(run.sessionId);
        const index = pending.findIndex((candidate) => candidate.runId === run.runId);
        if (index >= 0) queuePosition = index + 1;
      }
      res.json({
        clientMessageId,
        messageId: run.runId,
        runId: run.runId,
        conversationId: run.sessionId,
        sessionId: run.sessionId,
        status,
        deliveryMode,
        ...(queuePosition !== undefined ? { queuePosition } : {}),
        ...(run.statusReason ? { reason: run.statusReason } : {}),
      });
    } catch (err) {
      apiLogger.warn(`[sessions] message status lookup failed clientMessageId=${clientMessageId}: ${err instanceof Error ? err.message : String(err)}`);
      res.status(503).json({ error: "Message status unavailable" });
    }
  });

  router.post("/sessions/:sessionId/warmup", createSessionWarmupHandler({ readAccessibleSessionMetaForRequest, sandboxWarmup: options.sandboxWarmup }));

  router.get("/sessions/:sessionId", async (req: Request, res: Response) => {
    const requestStartedAt = Date.now();
    try {
      const { sessionId } = req.params;

      // 校验 sessionId 格式，防止路径注入
      if (!isValidSessionId(sessionId)) {
        res.status(400).json({ error: "Invalid sessionId format" });
        return;
      }

      const includeDeleted =
        req.query.includeDeleted === "1" || req.query.includeDeleted === "true";
      const after = typeof req.query.after === "string" && req.query.after.trim()
        ? req.query.after.trim()
        : undefined;
      const before = typeof req.query.before === "string" && req.query.before.trim()
        ? req.query.before.trim()
        : undefined;
      const hasOffset = typeof req.query.offset === "string";
      const parsedOffset = hasOffset ? Number.parseInt(req.query.offset as string, 10) : undefined;
      const offset = parsedOffset !== undefined && Number.isFinite(parsedOffset)
        ? Math.max(0, parsedOffset)
        : undefined;
      if ((after && before) || (offset !== undefined && (after || before))) {
        res.status(400).json({ error: "canonical cursor and N-1 offset modes cannot be mixed" });
        return;
      }
      const hasLimit = typeof req.query.limit === "string";
      const rawLimit = hasLimit ? Number.parseInt(req.query.limit as string, 10) : undefined;
      const limit = hasLimit
        ? rawLimit !== undefined && Number.isFinite(rawLimit)
          ? rawLimit
          : SESSION_DETAIL_DEFAULT_PAGE_SIZE
        : undefined;
      const transcriptWindowLimit = limit === undefined
        ? undefined
        : Math.min(
          SESSION_DETAIL_MAX_PAGE_SIZE,
          Math.max(1, Math.floor(limit || SESSION_DETAIL_DEFAULT_PAGE_SIZE)),
        );

      const built = await buildSessionDetailSnapshot(req, sessionId, {
        includeDeleted,
        ...(transcriptWindowLimit === undefined || offset !== undefined ? {} : {
          transcriptWindow: { after, before, limit: transcriptWindowLimit },
        }),
      });
      if (!built.ok) {
        res.status(built.status).json({ error: built.error });
        return;
      }

      // 审计：记录会话打开（silent 参数标记自动刷新，跳过审计）
      if (!req.query.silent) {
        auditLog(req, "session_opened", sessionId);
      }

      const totalDurationMs = Date.now() - requestStartedAt;
      if (totalDurationMs >= 800 || built.parseDurationMs >= 800) {
        apiLogger.warn(
          `[sessions] slow detail total=${totalDurationMs}ms parse=${built.parseDurationMs}ms sessionId=${sessionId} silent=${req.query.silent ? "1" : "0"} blocks=${built.detail.blocks.length} lines=${built.detail.stats.lines}`,
        );
      }

      const payload = buildSessionDetailPayload(built.detail, {
        after: built.transcriptWindow ? built.transcriptWindow.resolvedAfter : after,
        before: built.transcriptWindow ? built.transcriptWindow.resolvedBefore : before,
        ...(offset !== undefined ? { offset } : {}),
        limit,
        ...(built.transcriptWindow ? {
          windowStartsAtBeginning: built.transcriptWindow.startsAtBeginning,
          ...(built.transcriptWindow.latestCursor
            ? { latestCursor: built.transcriptWindow.latestCursor }
            : {}),
          historyRevision: built.transcriptWindow.cursorGeneration,
        } : {}),
      });
      if (built.transcriptWindow) {
        const encodedCursor = encodeTranscriptWindowCursor(
          built.transcriptWindow.cursorGeneration,
          payload.cursor,
        );
        const encodedOldestCursor = encodeTranscriptWindowCursor(
          built.transcriptWindow.cursorGeneration,
          payload.oldestCursor,
        );
        if (encodedCursor) payload.cursor = encodedCursor;
        else delete payload.cursor;
        if (encodedOldestCursor) {
          payload.oldestCursor = encodedOldestCursor;
          payload.nextCursor = encodedOldestCursor;
        } else {
          delete payload.oldestCursor;
          delete payload.nextCursor;
        }
      }
      const transcriptTiming = built.transcriptWindow
        ? `transcript-index;dur=${built.transcriptWindow.indexDurationMs}, transcript-read-parse;dur=${built.transcriptWindow.readParseDurationMs}`
        : `transcript-parse;dur=${built.parseDurationMs}`;
      res.setHeader(
        "Server-Timing",
        `session-detail;dur=${totalDurationMs}, ${transcriptTiming}`,
      );
      res.setHeader("X-Session-Detail-Mode", payload.mode);
      res.setHeader("X-Session-Blocks", String(payload.blocks.length));
      if (built.transcriptWindow) {
        res.setHeader("X-Transcript-Lines-Parsed", String(built.detail.stats.parsedLines ?? 0));
        if (built.transcriptWindow.cursorInvalidated) {
          res.setHeader("X-Session-Cursor-Invalidated", "1");
        }
      }
      res.json(payload);
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err);
      if (msg.includes("outside allowed directory")) {
        res.status(403).json({ error: msg });
        return;
      }
      res.status(500).json({ error: msg });
    }
  });

  /**
   * PATCH /api/sessions/:sessionId
   *
   * 更新会话元数据（目前支持重命名）
   * Body: { title: string }
   */
  router.patch("/sessions/:sessionId", async (req: Request, res: Response) => {
    try {
      const { sessionId } = req.params;
      const { title } = req.body as { title?: string };

      if (!isValidSessionId(sessionId)) {
        res.status(400).json({ error: "Invalid sessionId format" });
        return;
      }

      if (typeof title !== "string") {
        res.status(400).json({ error: "title must be a string" });
        return;
      }

      const userCwd = resolveUserCwd(
        agentCwd,
        req.user
          ? {
              id: req.user.sub,
              username: req.user.username,
              role: req.user.role,
            }
          : undefined,
      );
      const resolvedPath = await resolveSessionPathForRead(userCwd, sessionId, reqTranscriptOwner(req.user));
      if (!resolvedPath) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      const { transcriptPath } = resolvedPath;

      // 会话归属校验
      const meta = await readSessionMeta(transcriptPath);
      if (!canAccessSession(req.user, meta, options.userStore)) {
        res.status(403).json({ error: "Access denied" });
        return;
      }
      if (hidesSystemSessionFrom(req.user, meta)) {
        res.status(404).json({ error: "Session not found" });
        return;
      }

      const priorVersion = Date.parse(meta?.updatedAt ?? meta?.createdAt ?? '') || 0;
      const mutationUpdatedAt = new Date(Math.max(Date.now(), priorVersion + 1)).toISOString();
      const updated = await updateSessionMeta(transcriptPath, {
        customTitle: title.trim() || undefined,
        updatedAt: mutationUpdatedAt,
      });

      if (!updated) {
        res.status(404).json({ error: "Session meta not found" });
        return;
      }

      const updatedAt = updated.updatedAt ?? new Date().toISOString();
      const serverVersion = Date.parse(updatedAt) || Date.now();

      // 审计：记录会话重命名
      auditLog(req, "session_renamed", `${sessionId} → ${title.trim()}`);

      sessionsListCache.clear();
      // 广播标题更新到同用户所有连接
      if (req.user?.sub) {
        const eventBus = options.getEventBus?.();
        if (eventBus) {
          eventBus.emitUser(req.user.sub, {
            type: "title_updated",
            sessionId,
            title: updated.customTitle || "",
            serverVersion,
            updatedAt,
            sourceSeq: serverVersion,
          });
        } else {
          options.broadcastToUser?.(req.user.sub, {
            type: "title_updated",
            sessionId,
            title: updated.customTitle || "",
            serverVersion,
            updatedAt,
            sourceSeq: serverVersion,
          });
        }
      }
      res.json({ ok: true, title: updated.customTitle || null, ack: { status: "applied", sessionId, title: updated.customTitle || null, serverVersion, updatedAt } });
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err);
      if (msg.includes("outside allowed directory")) {
        res.status(403).json({ error: msg });
        return;
      }
      res.status(500).json({ error: msg });
    }
  });

  /**
   * POST /api/sessions/:sessionId/auto-title
   *
   * 从 transcript 提取首条用户消息和助手回复，调用 AI 生成标题
   */
  router.post(
    "/sessions/:sessionId/auto-title",
    async (req: Request, res: Response) => {
      try {
        const { sessionId } = req.params;
        if (!isValidSessionId(sessionId)) {
          res.status(400).json({ error: "Invalid sessionId format" });
          return;
        }
        options.refreshSharedConfig?.();
        if (!options.titleGeneratorConfigs?.length) {
          res.status(501).json({ error: "Title generator not configured" });
          return;
        }

        const userCwd = resolveUserCwd(
          agentCwd,
          req.user
            ? {
                id: req.user.sub,
                username: req.user.username,
                role: req.user.role,
                tenantId: req.user.tenantId,
              }
            : undefined,
        );
        const resolvedPath = await resolveSessionPathForRead(
          userCwd,
          sessionId,
          reqTranscriptOwner(req.user),
        );
        if (!resolvedPath) {
          res.status(404).json({ error: "Session not found" });
          return;
        }
        const { transcriptPath, hasTranscript } = resolvedPath;
        if (!hasTranscript) {
          res.status(404).json({ error: "Session transcript not found" });
          return;
        }

        // 会话归属校验
        // PR 7 P0-3 残余：canAccessSession 守门
        const meta = await readSessionMeta(transcriptPath);
        if (!canAccessSession(req.user, meta, options.userStore)) {
          res.status(403).json({ error: "Access denied" });
          return;
        }
        if (
          hidesSystemSessionFrom(req.user, meta)
        ) {
          res.status(404).json({ error: "Session not found" });
          return;
        }

        // 从已绑定 inode 的 /proc 路径提取上下文，避免校验后按原字符串路径重开。
        const { userMessages, assistantReplies } = await withTrustedTranscript(transcriptPath, transcript => extractTitleContext(transcript.fdPath));
        if (userMessages.length === 0) {
          res
            .status(400)
            .json({ error: "No user message found in transcript" });
          return;
        }

        const utilityBilling = options.billingService && req.user
          ? await options.billingService.beginUtilityModelRun({
              tenantId: req.user.tenantId ?? DEFAULT_TENANT_ID,
              userId: req.user.sub,
              username: req.user.username,
              sessionId,
              channel: "title",
            })
          : undefined;
        let title: string | null;
        try {
          title = await generateTitleWithFallback(
            userMessages[0], assistantReplies[0] || "", options.titleGeneratorConfigs,
            userMessages[1], assistantReplies[1],
            {
              systemPrompt: options.getTitleSystemPrompt?.(),
              modelAdapterFactory: options.titleModelAdapterFactory,
              runtimeContext: { sessionId, tenantId: req.user?.tenantId, cwd: userCwd },
              beforeModelCall: () => utilityBilling?.beforeModelCall(),
              onUsage: async (model, usage) => {
                await utilityBilling?.recordUsage(model, usage);
                if (!options.tokenUsageStore || !req.user) return;
                try {
                  options.tokenUsageStore.recordResult({
                    username: req.user.username,
                    tenantId: req.user.tenantId ?? DEFAULT_TENANT_ID,
                    channel: "title",
                    modelUsage: { [model]: usage },
                    occurredAtMs: Date.now(),
                  });
                } catch (err) {
                  console.warn(`[token-usage] auto-title record failed: ${err instanceof Error ? err.message : String(err)}`);
                }
              },
            },
          );
        } finally {
          await utilityBilling?.finalize();
        }

        if (!title) {
          // 上游模型抖动（超时/429/5xx 等）被 titleGenerator catch 后返回 null。
          // 返回 502 + errorCode，便于前端区分服务器异常和模型瞬断、按需自动重试。
          res.status(502).json({
            error: "Title generation failed",
            errorCode: "title_upstream_failed",
          });
          return;
        }

        await updateSessionMeta(transcriptPath, { generatedTitle: title });
        sessionsListCache.clear();

        // 广播标题更新
        if (req.user?.sub) {
          const eventBus = options.getEventBus?.();
          if (eventBus) {
            eventBus.emitUser(req.user.sub, {
              type: "title_updated",
              sessionId,
              title,
            });
          } else {
            options.broadcastToUser?.(req.user.sub, {
              type: "title_updated",
              sessionId,
              title,
            });
          }
        }

        res.json({ ok: true, title });
      } catch (err) {
        const msg = String(err instanceof Error ? err.message : err);
        res.status(500).json({ error: msg });
      }
    },
  );

  /**
   * POST /api/sessions/:sessionId/fork
   *
   * 从指定用户消息处分叉出新会话：
   * 保留该消息之前的对话历史，提取消息文本供客户端预填输入框。
   * Body: { blockId: string }  — 前端 message.id，如 "line-5-user-1"
   */
  router.post(
    "/sessions/:sessionId/fork",
    async (req: Request, res: Response) => {
      try {
        const { sessionId } = req.params;
        const { blockId } = req.body as { blockId?: string };

        if (!isValidSessionId(sessionId)) {
          res.status(400).json({ error: "Invalid sessionId format" });
          return;
        }
        if (!blockId || !/^line-\d+/.test(blockId)) {
          res.status(400).json({ error: "Invalid or missing blockId" });
          return;
        }

        const userCwd = resolveUserCwd(
          agentCwd,
          req.user
            ? {
                id: req.user.sub,
                username: req.user.username,
                role: req.user.role,
                tenantId: req.user.tenantId,
              }
            : undefined,
        );

        // 定位源 transcript
        let transcriptPath = getTranscriptPath(userCwd, sessionId, reqTranscriptOwner(req.user));
        try {
          await statTrustedTranscript(transcriptPath);
        } catch {
          const found = await findTranscriptPathBySessionId(sessionId);
          if (!found) {
            res.status(404).json({ error: "Session not found" });
            return;
          }
          transcriptPath = found;
        }

        // 所有权校验
        // PR 7 P0-3 残余：canAccessSession 守门
        const meta = await readSessionMeta(transcriptPath);
        if (!canAccessSession(req.user, meta, options.userStore)) {
          res.status(403).json({ error: "Access denied" });
          return;
        }
        if (
          hidesSystemSessionFrom(req.user, meta)
        ) {
          res.status(404).json({ error: "Session not found" });
          return;
        }

        // 新 JSONL 写入 Agent SaaS per-tenant/per-user legacy transcript 目录
        const ownerRef = reqTranscriptOwner(req.user);
        const targetProjectDir = ownerRef?.tenantId && ownerRef.userId
          ? getAgentTranscriptDir({ tenantId: ownerRef.tenantId, userId: ownerRef.userId })
          : path.dirname(getTranscriptPath(userCwd, sessionId));

        const result = await forkSession({
          sourceTranscriptPath: transcriptPath,
          targetProjectDir,
          blockId,
          sourceMeta: meta,
          requestUser: req.user
            ? { userId: req.user.sub, username: req.user.username, tenantId: req.user.tenantId }
            : undefined,
        });

        sessionsListCache.clear();
        auditLog(
          req,
          "session_forked",
          `${sessionId} → ${result.newSessionId}`,
        );

        res.json({
          newSessionId: result.newSessionId,
          forkMessage: result.forkMessage,
        });
      } catch (err) {
        const msg = String(err instanceof Error ? err.message : err);
        if (msg.includes("outside allowed directory")) {
          res.status(403).json({ error: msg });
          return;
        }
        res.status(400).json({ error: msg });
      }
    },
  );

  /**
   * GET /api/sessions/:sessionId/stats
   *
   * 轻量端点：仅返回会话的 token 统计，不解析 content blocks
   */
  router.get(
    "/sessions/:sessionId/stats",
    async (req: Request, res: Response) => {
      try {
        const { sessionId } = req.params;

        if (!isValidSessionId(sessionId)) {
          res.status(400).json({ error: "Invalid sessionId format" });
          return;
        }

        const userCwd = resolveUserCwd(
          agentCwd,
          req.user
            ? {
                id: req.user.sub,
                username: req.user.username,
                role: req.user.role,
                tenantId: req.user.tenantId,
              }
            : undefined,
        );
        const resolvedPath = await resolveSessionPathForRead(
          userCwd,
          sessionId,
          reqTranscriptOwner(req.user),
        );
        if (!resolvedPath) {
          res.status(404).json({ error: "Session not found" });
          return;
        }
        const { transcriptPath, hasTranscript } = resolvedPath;

        // 会话归属校验
        // PR 7 P0-3 残余：canAccessSession 守门
        const meta = await readSessionMeta(transcriptPath);
        if (!canAccessSession(req.user, meta, options.userStore)) {
          res.status(403).json({ error: "Access denied" });
          return;
        }
        if (
          hidesSystemSessionFrom(req.user, meta)
        ) {
          res.status(404).json({ error: "Session not found" });
          return;
        }

        const eventTenantId = meta?.tenantId ?? req.user?.tenantId ?? DEFAULT_TENANT_ID;
        const contextAccounting = options.resolveContextAccounting?.(meta?.model)
          ?? unknownContextAccounting();
        const legacyResponseMode = contextAccounting.kind === 'exact_current'
          ? 'full'
          : contextAccounting.kind === 'stateful_response_exact'
            ? 'relay'
            : undefined;
        let rawTokenUsage = hasTranscript
          ? await getTokenUsage(transcriptPath, { legacyResponseMode })
          : null;
        if (rawTokenUsage) {
          try {
            const subagentUsage = await getDurableSubagentUsage(
              eventTenantId,
              sessionId,
              transcriptPath,
              runtimeEventStoreFor,
            );
            if (subagentUsage) {
              rawTokenUsage = {
                ...rawTokenUsage,
                subagentTotalTokens: rawTokenUsage.subagentTotalTokens + subagentUsage.totalTokens,
                totalTokens: rawTokenUsage.totalTokens + subagentUsage.totalTokens,
                subagentUsage,
              };
            }
          } catch (err) {
            apiLogger.warn(
              `[sessions] subagent usage aggregation failed sessionId=${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        const tokenUsage = rawTokenUsage
          ? attachContextAccounting(
            rawTokenUsage,
            contextAccounting,
          )
          : null;
        let contextUsage = null;
        try {
          const runtimeEvents = runtimeEventStoreFor
            ? await runtimeEventStoreFor(transcriptPath, eventTenantId).list(eventTenantId, sessionId, {
                includeTypes: ["assistant_message", "assistant_tool_calls", "compaction"],
                projection: "usage",
              })
            : [];
          contextUsage = new RuntimeContextUsageTracker(meta?.model ?? 'unknown', runtimeEvents).record(
            meta?.model ?? 'unknown',
            undefined,
          );
        } catch (err) {
          apiLogger.warn(
            `[sessions] context usage reconstruction failed sessionId=${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        res.json({ tokenUsage, contextUsage, totalCostUsd: meta?.totalCostUsd ?? null });
      } catch (err) {
        const msg = String(err instanceof Error ? err.message : err);
        if (msg.includes("outside allowed directory")) {
          res.status(403).json({ error: msg });
          return;
        }
        res.status(500).json({ error: msg });
      }
    },
  );

  const getAuthorizedStreamStatus = async (
    req: Request,
    sessionId: string,
  ): Promise<{ active: boolean; streamId?: string; runId?: string; status?: string }> => {
    // stream-status 是探活接口：无权、不存在或隐藏的系统会话统一返回 inactive，
    // 不泄露会话是否存在，也绝不查询底层运行态。
    if (req.user) {
      const userCwd = resolveUserCwd(agentCwd, {
        id: req.user.sub,
        username: req.user.username,
        role: req.user.role,
        tenantId: req.user.tenantId,
      });
      const transcriptPath = getTranscriptPath(userCwd, sessionId, reqTranscriptOwner(req.user));
      const meta = await readSessionMeta(transcriptPath);
      if (!canAccessSession(req.user, meta, options.userStore) || hidesSystemSessionFrom(req.user, meta)) {
        return { active: false };
      }
    }

    return options.getStreamStatus
      ? options.getStreamStatus(sessionId)
      : { active: false };
  };

  /**
   * POST /api/sessions/active-streams
   *
   * 批量查询会话是否有活跃 Agent 流。用于刷新后恢复整个会话列表的运行态，
   * 避免逐条请求；最多 100 个，会话归属口径与单会话接口一致。
   */
  router.post(
    "/sessions/active-streams",
    async (req: Request, res: Response) => {
      try {
        const rawSessionIds = (req.body as { sessionIds?: unknown } | undefined)?.sessionIds;
        if (
          !Array.isArray(rawSessionIds)
          || rawSessionIds.length === 0
          || rawSessionIds.length > 100
          || rawSessionIds.some((sessionId) => typeof sessionId !== "string" || !isValidSessionId(sessionId))
        ) {
          res.status(400).json({ error: "sessionIds must contain 1 to 100 valid session IDs" });
          return;
        }

        const sessionIds = [...new Set(rawSessionIds as string[])];
        const sessions = await Promise.all(sessionIds.map(async (sessionId) => ({
          sessionId,
          ...await getAuthorizedStreamStatus(req, sessionId),
        })));
        res.json({ sessions });
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  /**
   * GET /api/sessions/:sessionId/stream-status
   *
   * 查询会话是否有活跃的 Agent 流（轻量 HTTP 端点，不依赖 WS）
   */
  router.get(
    "/sessions/:sessionId/stream-status",
    async (req: Request, res: Response) => {
      try {
        const { sessionId } = req.params;
        if (!isValidSessionId(sessionId)) {
          res.status(400).json({ error: "Invalid sessionId" });
          return;
        }

        res.json(await getAuthorizedStreamStatus(req, sessionId));
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  /**
   * GET /api/chat/interactions/pending
   *
   * 获取指定会话的 pending 交互（ask_user / plan mode permission_request）
   */
  router.get(
    "/chat/interactions/pending",
    async (req: Request, res: Response) => {
      const sessionId = req.query.sessionId as string;
      if (!sessionId) {
        res.status(400).json({ error: "sessionId required" });
        return;
      }

      try {
        let transcriptPath: string | null = null;

        // 会话归属校验
        // PR 7 P0-3 残余：admin 跨组织也得守门；轻量接口返回 [] 不暴露 403
        if (req.user && req.user.role !== "admin") {
          const pendingUserCwd = resolveUserCwd(agentCwd, {
            id: req.user.sub,
            username: req.user.username,
            role: req.user.role,
            tenantId: req.user.tenantId,
          });
          transcriptPath = getTranscriptPath(pendingUserCwd, sessionId, reqTranscriptOwner(req.user));
          const meta = await readSessionMeta(transcriptPath);
          if (!canAccessSession(req.user, meta, options.userStore)) {
            res.json([]);
            return;
          }
          if (hidesSystemSessionFrom(req.user, meta)) {
            res.json([]);
            return;
          }
        } else if (req.user) {
          transcriptPath = await findTranscriptPathBySessionId(sessionId);
          // admin 也要跨 tenant 检查
          if (transcriptPath) {
            const meta = await readSessionMeta(transcriptPath);
            if (!canAccessSession(req.user, meta, options.userStore)) {
              res.json([]);
              return;
            }
          }
        }

        const pending = interactionStore.getPendingInteractions(sessionId, { includeTransient: true });
        if (transcriptPath) {
          const eventTenantId = (await readSessionMeta(transcriptPath))?.tenantId
            ?? req.user?.tenantId
            ?? DEFAULT_TENANT_ID;
          const eventStore = runtimeEventStoreFor
            ? runtimeEventStoreFor(transcriptPath, eventTenantId)
            : new FileEventStore(getRuntimeEventLogPath(transcriptPath), eventTenantId);
          const durableInteractionEvents = await eventStore.list(eventTenantId, sessionId, {
            includeTypes: [
              "interaction_requested",
              "interaction_resolved",
              "approval_requested",
              "approval_resolved",
            ],
          });
          const existingIds = reconcileInMemoryPendingInteractions(pending, durableInteractionEvents);
          for (const state of buildPendingInteractionsFromEvents(
            durableInteractionEvents,
            sessionId,
          )) {
            if (existingIds.has(state.interactionId)) continue;
            if (state.type !== "ask_user" && state.type !== "permission_request" && state.type !== "approval")
              continue;
            pending.push({
              interactionId: state.interactionId,
              type: state.type,
              version: state.version ?? 0,
              order: state.order ?? state.version ?? 0,
              runId: state.runId,
              toolCallId: state.toolCallId,
              invocationId: state.invocationId,
              questions: state.questions,
              toolId: state.toolId,
              toolName: state.toolName,
              displayName: state.displayName,
              toolInput: state.type === 'approval'
                ? redactInteractionCredentials(state.toolInput) as Record<string, unknown> | undefined
                : state.toolInput,
            });
            existingIds.add(state.interactionId);
          }
          // Durable approvals use the same fixed interaction zone as runtime permission/AskUser cards.
          for (const approval of buildApprovalRecordsFromEvents(
            durableInteractionEvents,
            sessionId,
          )) {
            if (approval.status !== "pending") continue;
            if (existingIds.has(approval.id)) continue;
            pending.push({
              interactionId: approval.id,
              type: "approval",
              version: Number.isFinite(Date.parse(approval.createdAt)) ? Date.parse(approval.createdAt) : 0,
              order: Number.isFinite(Date.parse(approval.createdAt)) ? Date.parse(approval.createdAt) : 0,
              toolId: approval.toolId,
              toolName: approval.toolName,
              displayName: approval.displayName,
              toolInput: redactInteractionCredentials(
                approval.input && typeof approval.input === "object"
                  ? approval.input
                  : { value: approval.input },
              ) as Record<string, unknown>,
            });
          }
        }
        res.json(pending);
      } catch (err) {
        apiLogger.warn(
          `[sessions] pending interactions read failed sessionId=${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
        );
        res.status(503).json({ error: "暂时无法读取待处理交互" });
      }
    },
  );

  /** Canonical owner-scoped interaction detail/receipt endpoint used after list-summary hydration. */
  router.get('/chat/interactions/:interactionId', async (req: Request, res: Response) => {
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : '';
    const interactionId = req.params.interactionId;
    if (!sessionId || !interactionId) { res.status(400).json({ error: 'sessionId and interactionId required' }); return; }
    const pending = interactionStore.get(interactionId);
    if (pending) {
      if (pending.sessionId !== sessionId || (pending.userId && pending.userId !== req.user?.sub)) {
        res.status(404).json({ error: 'Interaction not found' }); return;
      }
      res.json({
        sessionId, interactionId, type: pending.type, version: pending.version, order: pending.order,
        questions: pending.questions, toolId: pending.toolId, toolName: pending.toolName,
        displayName: pending.displayName,
        toolInput: pending.type === 'approval' ? redactInteractionCredentials(pending.toolInput) : pending.toolInput,
      });
      return;
    }
    const completed = interactionStore.getCompleted(sessionId, interactionId);
    if (!completed || (completed.userId && completed.userId !== req.user?.sub)) { res.status(404).json({ error: 'Interaction not found' }); return; }
    const status = completed.response.answers ? 'answered' : completed.response.allow === false ? 'rejected' : 'approved';
    res.json({
      sessionId, interactionId, version: completed.version, order: completed.order,
      receipt: { status, requestId: completed.requestId, respondedAt: new Date(completed.completedAt).toISOString() },
    });
  });

  /**
   * POST /api/sessions/:sessionId/restore
   *
   * 从回收站恢复自己的会话（先取消 durable cleanup，再移除 deletedAt）。
   * Owner-self only：只允许会话原 owner 恢复，任何 admin（含平台 admin / 组织 admin）
   * 都不能代恢复他人会话。普通 user 也能恢复自己的。
   */
  router.post(
    "/sessions/:sessionId/restore",
    async (req: Request, res: Response) => {
      try {
        if (!req.user) {
          res.status(401).json({ error: "Authentication required" });
          return;
        }
        const { sessionId } = req.params;
        if (!isValidSessionId(sessionId)) {
          res.status(400).json({ error: "Invalid sessionId format" });
          return;
        }

        const restore = async () => {
          let transcriptPath = await findTranscriptPathBySessionId(sessionId);
          if (!transcriptPath) {
            transcriptPath = await findMetaPathBySessionId(sessionId);
          }
          if (!transcriptPath) {
            res.status(404).json({ error: "Session not found" });
            return;
          }
          const meta = await readSessionMeta(transcriptPath);
          // Owner-self gate：只允许 owner 自己 restore（admin 代恢复能力已收回）
          if (!meta || meta.userId !== req.user!.sub) {
            res.status(403).json({ error: "Access denied" });
            return;
          }
          if (!meta.deletedAt) {
            res.status(400).json({ error: "Session is not deleted" });
            return;
          }
          // 先 CAS 取消 durable cleanup，再移除 tombstone；否则重试可能在恢复后删除新建 Sandbox。
          if (options.sandboxCleanupRequired && !options.sandboxSessionRestore) { res.status(503).json({ error: "Sandbox restore 能力不可用" }); return; }
          await options.sandboxSessionRestore?.(sessionId); const { deletedAt, deletedBy, ...rest } = meta;
          await writeSessionMeta(transcriptPath, rest as SessionMeta);
          auditLog(req, "session_restored", sessionId);
          sessionsListCache.clear();
          res.json({ ok: true, restored: true });
        };
        await (options.artifactLifecycle ? options.artifactLifecycle.withSessionLock(sessionId, restore) : restore());
      } catch (err) {
        const msg = String(err instanceof Error ? err.message : err);
        res.status(500).json({ error: msg });
      }
    },
  );

  /**
   * DELETE /api/sessions/:sessionId/permanent
   *
   * 从回收站永久删除自己的会话（物理删除文件）。
   * Owner-self only：与 /restore 同步，admin 代删除能力已收回。
   */
  router.delete(
    "/sessions/:sessionId/permanent",
    async (req: Request, res: Response) => {
      try {
        if (!req.user) {
          res.status(401).json({ error: "Authentication required" });
          return;
        }
        const { sessionId } = req.params;
        if (!isValidSessionId(sessionId)) {
          res.status(400).json({ error: "Invalid sessionId format" });
          return;
        }

        // Owner-self gate：先查 meta 守门，再继续物理删除流程
        let transcriptPath = await findTranscriptPathBySessionId(sessionId);
        const hasTranscript = !!transcriptPath;
        if (!transcriptPath) {
          transcriptPath = await findMetaPathBySessionId(sessionId);
        }
        if (transcriptPath) {
          const meta = await readSessionMeta(transcriptPath);
          // Owner-self gate：只允许 owner 自己 permanent delete
          if (!meta || meta.userId !== req.user.sub) {
            res.status(403).json({ error: "Access denied" });
            return;
          }
          if (!meta.deletedAt) {
            res
              .status(400)
              .json({ error: "Session is not in trash, use normal delete" });
            return;
          }
        } else {
          res.status(404).json({ error: "Session not found" });
          return;
        }

        const deleted = await permanentlyDeleteSession({
          sessionId,
          ownerUserId: req.user.sub,
          hasTranscript,
          artifactLifecycle: options.artifactLifecycle, isStillDeleted: async () => readSessionMeta(transcriptPath).then(meta => !!meta?.deletedAt && meta.userId === req.user!.sub), beforePhysicalDelete: () => requireSandboxPhysicalDeletion(options, sessionId),
          deleteTranscriptPreservingMeta: async () => !hasTranscript || (await deleteSession(sessionId, { preserveMeta: true })).deleted,
          deleteMetaAndSidecar: async () => (await deleteSessionMetaOnly(sessionId, { deleteSidecarDir: true })).deleted,
        });
        if (!deleted) {
          res.status(404).json({ error: "Session not found" });
          return;
        }

        auditLog(req, "session_permanently_deleted", sessionId);
        if (options.groupStore) {
          await options.groupStore.removeSessionFromAllGroups(sessionId);
        }
        sessionsListCache.clear();
        res.json({ ok: true, permanentlyDeleted: true });
      } catch (err) {
        const msg = String(err instanceof Error ? err.message : err);
        if (msg.includes("outside allowed directory")) {
          res.status(403).json({ error: msg });
          return;
        }
        res.status(500).json({ error: msg });
      }
    },
  );

  /**
   * DELETE /api/sessions/:sessionId
   *
   * 软删除会话（写入 deletedAt，文件不物理删除；重复请求保持幂等）
   * 所有角色统一为软删除；非 admin 需归属校验
   */
  router.delete("/sessions/:sessionId", async (req: Request, res: Response) => {
    try {
      const { sessionId } = req.params;

      if (!isValidSessionId(sessionId)) {
        res.status(400).json({ error: "Invalid sessionId format" });
        return;
      }

      // 定位 transcript 路径（优先以 .jsonl 文件为准，避免孤立 meta 误匹配）
      const delUserCwd = resolveUserCwd(
        agentCwd,
        req.user
          ? {
              id: req.user.sub,
              username: req.user.username,
              role: req.user.role,
              tenantId: req.user.tenantId,
            }
          : undefined,
      );
      let transcriptPath = getTranscriptPath(delUserCwd, sessionId, reqTranscriptOwner(req.user));
      // 先检查 .jsonl 是否真的在当前用户目录下
      try {
        await statTrustedTranscript(transcriptPath);
      } catch {
        // .jsonl 不在当前用户目录，全局扫描
        const found = await findTranscriptPathBySessionId(sessionId);
        if (found) transcriptPath = found;
      }
      let meta = await readSessionMeta(transcriptPath);

      // transcript 存在但缺少 meta：补建 meta 以支持软删除
      if (!meta) {
        try {
          await statTrustedTranscript(transcriptPath);
        } catch {
          // transcript 也不存在，真正的 404
          res.status(404).json({ error: "Session not found" });
          return;
        }
        // 归属校验对所有角色生效（owner-self only，与 canAccessSession 同口径）：
        // meta 缺失时唯一的归属信号是 transcript 路径。若放过 admin，任意租户的
        // 组织 admin 都能以自己身份补写 stub meta「收养」孤儿 transcript 再软删，
        // 所有权被改写，与下方「跨组织 admin 不能删别 tenant 会话」的意图相悖。
        const expectedNewPath = getTranscriptPath(delUserCwd, sessionId, reqTranscriptOwner(req.user));
        const expectedLegacyPath = getTranscriptPath(delUserCwd, sessionId);
        if (transcriptPath !== expectedNewPath && transcriptPath !== expectedLegacyPath) {
          res.status(403).json({ error: "Access denied" });
          return;
        }
        // 补写一个最小 meta（channel/createdAt 从 transcript 首行推断）
        const stubMeta: SessionMeta = {
          userId: req.user?.sub || "unknown",
          username: req.user?.username || "unknown",
          channel: "web",
          createdAt: new Date().toISOString(),
        };
        await writeSessionMeta(transcriptPath, stubMeta);
        meta = stubMeta;
      }

      // PR 7 P0-3 残余：canAccessSession 守门，跨组织 admin 不能删别 tenant 会话
      if (!canAccessSession(req.user, meta, options.userStore)) {
        res.status(403).json({ error: "Access denied" });
        return;
      }
      // 记忆轮询会话对非 admin 视为不存在（不允许删除）
      if (hidesSystemSessionFrom(req.user, meta)) {
        res.status(404).json({ error: "Session not found" });
        return;
      }

      const applySoftDelete = async (): Promise<boolean> => {
        if (options.sandboxCleanupRequired && !options.sandboxSessionDeletion) throw new Error("Sandbox cleanup 能力不可用"); const currentMeta = await readSessionMeta(transcriptPath); if (!currentMeta) throw new Error("Session not found"); const newlyDeleted = !currentMeta.deletedAt;
        const priorVersion = Date.parse(currentMeta.updatedAt ?? currentMeta.createdAt) || 0;
        const nextDeletedAt = new Date(Math.max(Date.now(), priorVersion + 1)).toISOString();
        if (newlyDeleted) {
          // prepared 不可投递；meta tombstone 成功后才进入 durable cancelling，缓存与事件由 cleanup 成功后补偿。
          const intent = await options.sandboxSessionDeletionIntent?.(sessionId); if (intent === "blocked") throw new Error("Sandbox cleanup intent blocked");
          await updateSessionMeta(transcriptPath, {
            deletedAt: nextDeletedAt,
            updatedAt: nextDeletedAt,
            deletedBy: req.user?.username || "anonymous",
          });
        }
        await options.sessionShareStore?.revokeBySession(sessionId, currentMeta.userId).catch((err) => {
          apiLogger.warn(
            `[sessions] revoke share on delete failed sessionId=${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
        const cleanup = await options.sandboxSessionDeletion?.(sessionId); if (cleanup === "blocked") throw new Error("Sandbox cleanup commit blocked"); return newlyDeleted;
      };
      const changed = options.artifactLifecycle
        ? await options.artifactLifecycle.withRevoked(sessionId, meta.userId, applySoftDelete)
        : await applySoftDelete();
      const deletedMeta = await readSessionMeta(transcriptPath);
      const deletedAt = deletedMeta?.deletedAt ?? new Date().toISOString();
      const serverVersion = Date.parse(deletedAt) || Date.now();
      // cleanup 成功后补偿审计、缓存与删除事件；重复 DELETE 可幂等重放审计。
      auditLog(req, "session_soft_deleted", sessionId);
      sessionsListCache.clear();
      // 广播是幂等状态通知，重复 DELETE 可再次投递以补偿前次 cleanup 失败。
      // 广播删除事件到操作者和资源 owner 的所有连接（前端效果：会话从列表消失）
      const broadcastUserIds = new Set<string>();
      if (req.user?.sub) broadcastUserIds.add(req.user.sub);
      if (meta.userId && meta.userId !== req.user?.sub)
        broadcastUserIds.add(meta.userId);
      if (broadcastUserIds.size > 0) {
        const eventBus = options.getEventBus?.();
        for (const userId of broadcastUserIds) {
          if (eventBus) {
            eventBus.emitUser(userId, {
              type: "session_deleted",
              sessionId,
              serverVersion,
              updatedAt: deletedAt,
              sourceSeq: serverVersion,
            });
          } else {
            options.broadcastToUser?.(userId, {
              type: "session_deleted",
              sessionId,
              serverVersion,
              updatedAt: deletedAt,
              sourceSeq: serverVersion,
            });
          }
        }
      }
      res.json({ ok: true, softDeleted: true, ack: { status: changed ? "applied" : "duplicate", sessionId, deleted: true, serverVersion, updatedAt: deletedAt } });
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err);
      if (msg.includes("outside allowed directory")) {
        res.status(403).json({ error: msg });
        return;
      }
      if (msg.includes("Invalid sessionId")) {
        res.status(400).json({ error: msg });
        return;
      }
      res.status(msg.includes("Sandbox cleanup 能力不可用") ? 503 : 500).json({ error: msg });
    }
  });

  return router;
}

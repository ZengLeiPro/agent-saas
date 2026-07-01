/**
 * Sessions API 路由
 *
 * 提供会话列表、详情、删除等操作。
 * 真源来自 ~/.agent-saas/legacy-transcripts/<tenantId>/<userId>/*.jsonl
 * （PR #31 起的新 Agent SaaS layout；旧 cwd-derived transcript root 不再作为在线读路径）
 */
import { Router } from "express";
import type { Request, Response } from "express";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import {
  listSessions,
  getTranscriptPath,
  findTranscriptPathBySessionId,
  findMetaPathBySessionId,
  deleteSession,
  deleteSessionMetaOnly,
  listSessionMetas,
  parseTranscriptFile,
  type ParsedTranscript,
  summarizeTranscript,
  getTokenUsage,
  isValidSessionId,
  forkSession,
  getAgentTranscriptDir,
  type SessionListItem,
} from "../data/transcripts/index.js";
import {
  readSessionMeta,
  writeSessionMeta,
  updateSessionMeta,
  type SessionMeta,
} from "../data/transcripts/meta.js";
import { resolveUserCwd } from "../workspace/resolver.js";
import { TTLCache } from "../utils/cache.js";
import {
  extractTitleContext,
  generateTitleWithFallback,
  type TitleGeneratorConfig,
} from "../agent/titleGenerator.js";
import type { GroupStore } from "../data/groups/index.js";
import type { UserStore } from "../data/users/store.js";
import type { TokenUsageStore } from "../data/usage/store.js";
import { interactionStore } from "../channels/web/interactionStore.js";
import { EventBackedApprovalStore } from "../runtime/approvalStore.js";
import {
  FileEventStore,
  getRuntimeEventLogPath,
} from "../runtime/fileEventStore.js";
import {
  enrichTranscriptActivityDurations,
  listActivityDurationEvents,
} from "../data/transcripts/activityDurations.js";
import type { EventStore, PlatformEvent } from "../runtime/types.js";
import { buildRuntimeReplayState } from "../runtime/replay.js";
import { buildPendingInteractionsFromEvents } from "../runtime/interactionProjection.js";
import { auditLog } from "../data/login-logs/index.js";
import { apiLogger } from "../utils/logger.js";
import type { EventBus } from "../channels/web/eventBus.js";
import { canAccessSession, isMemoryPollSessionMeta } from "../data/sessions/access.js";
import type { AgentStore } from "../data/agents/store.js";
import type { AgentProfileInfo } from "../data/agents/types.js";
import { DEFAULT_TENANT_ID } from "../data/tenants/types.js";

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
}

interface SessionsListResponse {
  sessions: EnrichedSessionListItem[];
  hasMore: boolean;
}

interface TokenContextAccounting {
  exact: boolean;
  kind: "exact_current" | "stateful_response_unknown" | "unknown";
  source: "provider_usage" | "stateful_response" | "unknown";
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
  resolver: ContextAccountingResolver | undefined,
  modelRef: string | undefined,
): T & { contextAccounting: TokenContextAccounting } {
  const accounting = resolver?.(modelRef) ?? unknownContextAccounting();
  return {
    ...usage,
    contextAccounting: {
      ...accounting,
      lastRequestTokens: usage.contextTokens,
    },
  };
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
  /** 查询会话流状态（由 WebChannel 提供） */
  getStreamStatus?: (sessionId: string) => Promise<{ active: boolean; streamId?: string; runId?: string }>;
  /** 广播事件到指定用户的所有 WS 连接 */
  broadcastToUser?: (userId: string, data: object) => void;
  /** 中央事件总线（优先于 broadcastToUser），延迟求值避免初始化时序问题 */
  getEventBus?: () => EventBus | undefined;
  /** Title generator 配置链：主 + fallback；空表示功能未配置（接口将 501） */
  titleGeneratorConfigs?: TitleGeneratorConfig[];
  /** Token 用量统计 store，用于记录手动 auto-title 等基础设施模型调用 */
  tokenUsageStore?: TokenUsageStore;
  /**
   * Runtime EventStore 解析函数。pending API 列出某 session 的 replay state
   * 需要它读事件流。
   * - PG backend：返回共享 pgEventStore（按 session_id 过滤）
   * - file backend / 缺省：`new FileEventStore(getRuntimeEventLogPath(transcriptPath))`
   * 注入路径见 app/runtime.ts → routes.ts。
   */
  runtimeEventStoreFor?: (transcriptPath: string) => EventStore;
  /**
   * Resolve whether transcript-derived `contextTokens` is an exact current
   * context count for this session's model. Stateful Responses chaining keeps
   * context on the provider side, so last-turn usage must not be displayed as
   * exact current context.
   */
  resolveContextAccounting?: ContextAccountingResolver;
}

interface ResolvedSessionPath {
  transcriptPath: string;
  hasTranscript: boolean;
}

function reqTranscriptOwner(reqUser: Request["user"] | undefined): { tenantId?: string; userId?: string } | undefined {
  return reqUser ? { tenantId: reqUser.tenantId, userId: reqUser.sub } : undefined;
}

async function resolveSessionPathForRead(
  userCwd: string,
  sessionId: string,
  owner?: { tenantId?: string; userId?: string },
): Promise<ResolvedSessionPath | null> {
  let transcriptPath = getTranscriptPath(userCwd, sessionId, owner);
  try {
    await fs.access(transcriptPath);
    return { transcriptPath, hasTranscript: true };
  } catch {
    const foundTranscript = await findTranscriptPathBySessionId(sessionId);
    if (foundTranscript)
      return { transcriptPath: foundTranscript, hasTranscript: true };
    const foundMeta = await findMetaPathBySessionId(sessionId);
    if (foundMeta) return { transcriptPath: foundMeta, hasTranscript: false };
    return null;
  }
}

function isUserMessageSubmittedEvent(
  event: PlatformEvent,
): event is Extract<PlatformEvent, { type: "user_message_submitted" }> {
  return (
    event.type === "user_message_submitted" &&
    typeof event.content === "string" &&
    event.content.trim().length > 0
  );
}

/**
 * 会话最近一次 run 的终态。前端进会话时原子拿到,用于对账"后端早结束、
 * 前端 UI 仍显示 running" 这种鬼状态：
 * - status='failed'/'cancelled' → 显示对应失败/取消 banner
 * - status='running' 但 WS 未 active → 提示"上次回复未完成"
 * - 缺省 → 兼容旧会话(无 run_state_changed 事件)
 */
export interface LastRunState {
  runId: string;
  status: string;
  /** run_state_changed.reason —— failed/cancelled 时通常是 model error message */
  error?: string;
  /** 该 run_state_changed 事件的 ISO timestamp */
  finishedAt?: string;
}

/**
 * 拉最近一条 `run_state_changed` 事件,派生 lastRunState。
 *
 * 用 `listPage({type:'run_state_changed', limit:200})` 拉所有同类型事件再取末位。
 * run_state_changed 是稀疏事件(每个 run 通常 2-3 条),即使百 run 的超长会话也仅
 * 数百条;PG 后端走 (session_id, event_type) 索引几毫秒内完成。
 *
 * EventStore 不支持 DESC 排序 + LIMIT 1,所以采用拉全分页方案;后端类型也保证
 * filtered 行数远低于全表全量。任何异常都吞掉返回 undefined(对端将走 legacy 路径)。
 */
async function getLastRunState(
  eventStore: EventStore,
  sessionId: string,
): Promise<LastRunState | undefined> {
  try {
    const collected: PlatformEvent[] = [];
    if (eventStore.listPage) {
      let cursor: string | undefined;
      // 安全上限：单 session run_state_changed 极少超过 1000 条
      for (let guard = 0; guard < 10; guard++) {
        const page = await eventStore.listPage(sessionId, {
          type: "run_state_changed",
          limit: 200,
          afterCursor: cursor,
        });
        collected.push(...page.events);
        if (!page.hasMore || !page.nextCursor) break;
        cursor = page.nextCursor;
      }
    } else {
      const all = await eventStore.list(sessionId);
      for (const event of all) {
        if (event.type === "run_state_changed") collected.push(event);
      }
    }
    const last = collected.at(-1);
    if (!last || last.type !== "run_state_changed") return undefined;
    return {
      runId: last.runId,
      status: last.status,
      ...(last.reason ? { error: last.reason } : {}),
      ...(last.timestamp ? { finishedAt: last.timestamp } : {}),
    };
  } catch {
    return undefined;
  }
}

async function buildMetaOnlyTranscript(
  sessionId: string,
  transcriptPath: string,
  runtimeEventStoreFor?: (transcriptPath: string) => EventStore,
): Promise<ParsedTranscript> {
  let events: PlatformEvent[] = [];
  try {
    const eventStore = runtimeEventStoreFor
      ? runtimeEventStoreFor(transcriptPath)
      : new FileEventStore(getRuntimeEventLogPath(transcriptPath));
    events = await eventStore.list(sessionId);
  } catch {
    events = [];
  }

  const submitted = events.filter(isUserMessageSubmittedEvent);
  return {
    sessionId,
    blocks: submitted.map((event, index) => {
      const parsedTs = Date.parse(event.timestamp);
      return {
        id: `runtime-${event.id || index}-user`,
        ...(Number.isFinite(parsedTs) ? { tsMs: parsedTs } : {}),
        kind: "prompt" as const,
        title: "输入（Prompt）",
        defaultOpen: true,
        content: event.content,
      };
    }),
    stats: {
      lines: submitted.length,
      parsedLines: submitted.length,
      parseErrors: 0,
    },
  };
}

/**
 * 从 dingtalk-sessions.json 构建 agentSessionId -> senderNick 反向索引
 */
async function buildDingtalkSessionIndex(
  basePath: string,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const filePath = path.join(basePath, "dingtalk-sessions.json");
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const store = JSON.parse(raw) as Record<
      string,
      { agentSessionId?: string; senderNick?: string }
    >;
    for (const info of Object.values(store)) {
      if (info.agentSessionId && info.senderNick) {
        map.set(info.agentSessionId, info.senderNick);
      }
    }
  } catch {
    // file missing or parse error – ignore
  }
  return map;
}

interface CronSessionInfo {
  jobId: string;
  jobName: string;
  model?: string;
}

/**
 * 从 cron run logs JSONL 文件构建 sessionId -> { jobName, model } 反向索引
 */
async function buildCronSessionIndex(
  runsDir: string,
): Promise<Map<string, CronSessionInfo>> {
  const map = new Map<string, CronSessionInfo>();
  let files: string[];
  try {
    files = (await fs.readdir(runsDir)).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return map;
  }
  for (const file of files) {
    const jobId = file.replace(".jsonl", "");
    try {
      const content = await fs.readFile(path.join(runsDir, file), "utf-8");
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as {
            sessionId?: string;
            jobName?: string;
            model?: string;
          };
          if (entry.sessionId && entry.jobName) {
            map.set(entry.sessionId, {
              jobId,
              jobName: entry.jobName,
              model: entry.model,
            });
          }
        } catch {
          // skip malformed line
        }
      }
    } catch {
      // skip unreadable file
    }
  }
  return map;
}


/**
 * 剥离 markdown 语法，保留纯文本
 */
function stripMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, "") // headings
    .replace(/^\s*[-*]{3,}\s*$/gm, "") // horizontal rules
    .replace(/\*\*(.+?)\*\*/g, "$1") // bold
    .replace(/\*(.+?)\*/g, "$1") // italic
    .replace(/__(.+?)__/g, "$1") // bold alt
    .replace(/_(.+?)_/g, "$1") // italic alt
    .replace(/`(.+?)`/g, "$1") // inline code
    .replace(/^\s*>\s?/gm, "") // blockquotes
    .replace(/^\s*[-*+]\s+/gm, "") // unordered list markers
    .replace(/^\s*\d+\.\s+/gm, "") // ordered list markers
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // links
    .replace(/\n{2,}/g, " ") // collapse multiple newlines
    .trim();
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
        !fresh && !before && !req.user ? `${scope}:${limit}` : null;

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
      let sessions: SessionListItem[];
      let hasMore = false;
      const metaOnlySessionIds = new Set<string>();
      const listStageStartedAt = Date.now();
      const transcriptOwner = reqTranscriptOwner(req.user);
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
      sessions = [...bySessionId.values()].sort((a, b) => b.updatedAtMs - a.updatedAtMs);
      markStage(`listSessionsWithMeta[user,metaOnly=${metaOnlySessionIds.size}]`, listStageStartedAt);

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
      let authMetaMap: Map<string, SessionMeta | null> | undefined;
      if (req.user && !isAdmin) {
        const userId = req.user.sub;
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
        // 权限过滤：只保留属于当前用户的会话 + 排除软删除 + 隐藏系统轮询会话
        sessions = sessions.filter((s) => {
          const meta = authMetaMap!.get(s.sessionId);
          if (!meta || meta.userId !== userId || meta.deletedAt) return false;
          if (isMemoryPollSessionMeta(meta)) return false;
          return true;
        });
      } else {
        // Admin / 未认证用户：读取 meta 过滤软删除
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
        sessions = sessions.filter((s) => {
          const meta = authMetaMap!.get(s.sessionId);
          if (meta?.deletedAt) return false;
          return true;
        });
      }

      sessions.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
      if (before) sessions = sessions.filter((s) => s.updatedAtMs < before);
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
              title,
              preview,
              createdAtMs: Number.isFinite(createdAtFromMeta)
                ? createdAtFromMeta
                : firstPrompt?.tsMs ?? session.updatedAtMs,
              source,
              ...(owner ? { owner } : {}),
              ...(agent ? { agent } : {}),
              ...(sessionModel ? { model: sessionModel } : {}),
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
              title,
              preview,
              createdAtMs: summary.createdAtMs ?? session.updatedAtMs,
              source,
              ...(owner ? { owner } : {}),
              ...(agent ? { agent } : {}),
              ...(sessionModel ? { model: sessionModel } : {}),
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
              source,
              ...(owner ? { owner } : {}),
              ...(agent ? { agent } : {}),
              ...(sessionModel ? { model: sessionModel } : {}),
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
      const visibleSessions = enrichedSessions;

      const payload = { sessions: visibleSessions, hasMore };
      if (cacheKey) {
        sessionsListCache.set(cacheKey, payload);
      }
      const totalDurationMs = Date.now() - requestStartedAt;
      if (totalDurationMs >= 800) {
        apiLogger.warn(
          `[sessions] slow list ${totalDurationMs}ms scope=${scope} limit=${limit} before=${before ?? "none"} count=${visibleSessions.length} hasMore=${hasMore} stages=${stageTimings.join(", ")}`,
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

  /**
   * GET /api/sessions/:sessionId
   *
   * 获取会话详情（历史消息）
   */
  router.get("/sessions/:sessionId", async (req: Request, res: Response) => {
    const requestStartedAt = Date.now();
    try {
      const { sessionId } = req.params;

      // 校验 sessionId 格式，防止路径注入
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
            }
          : undefined,
      );

      const resolvedPath = await resolveSessionPathForRead(userCwd, sessionId, reqTranscriptOwner(req.user));
      if (!resolvedPath) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      const { transcriptPath, hasTranscript } = resolvedPath;

      // 读取 meta（用于归属校验 + admin 获取 owner）
      const meta = await readSessionMeta(transcriptPath);
      const includeDeleted =
        req.query.includeDeleted === "1" || req.query.includeDeleted === "true";

      // 会话归属校验
      if (!canAccessSession(req.user, meta, options.userStore)) {
        res.status(403).json({ error: "Access denied" });
        return;
      }
      if (meta?.deletedAt && !includeDeleted) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      // 对非 admin 屏蔽「记忆轮询 / 心跳轮询」会话
      // 即使用户本人是 owner，也不允许通过单点接口直接读取轮询 transcript
      if (req.user?.role !== "admin" && meta && isMemoryPollSessionMeta(meta)) {
        res.status(404).json({ error: "Session not found" });
        return;
      }

      const detailEventStore = runtimeEventStoreFor
        ? runtimeEventStoreFor(transcriptPath)
        : new FileEventStore(getRuntimeEventLogPath(transcriptPath));
      const parseStartedAt = Date.now();
      let parsed = hasTranscript
        ? await parseTranscriptFile(transcriptPath)
        : await buildMetaOnlyTranscript(
            sessionId,
            transcriptPath,
            runtimeEventStoreFor,
          );
      if (parsed.blocks.some((block) => block.kind === "thinking" || block.kind === "tool_use")) {
        try {
          parsed = enrichTranscriptActivityDurations(
            parsed,
            await listActivityDurationEvents(detailEventStore, sessionId),
            sessionId,
          );
        } catch (err) {
          apiLogger.warn(
            `[sessions] activity duration enrichment failed sessionId=${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      const parseDurationMs = Date.now() - parseStartedAt;

      // a-2 对账：拉最近一条 run_state_changed 派生 lastRunState,
      // 让前端进会话时能识别"后端已 failed/cancelled,但 UI 还在转" 的鬼状态。
      const lastRunState = await getLastRunState(detailEventStore, sessionId);

      // 审计：记录会话打开（silent 参数标记自动刷新，跳过审计）
      if (!req.query.silent) {
        auditLog(req, "session_opened", sessionId);
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

      // cron 会话附加 source 信息，供前端生成 displayContent
      const source =
        meta?.channel === "cron"
          ? { type: "cron" as const, label: meta.cronJobName || "定时任务" }
          : undefined;

      const totalDurationMs = Date.now() - requestStartedAt;
      if (totalDurationMs >= 800 || parseDurationMs >= 800) {
        apiLogger.warn(
          `[sessions] slow detail total=${totalDurationMs}ms parse=${parseDurationMs}ms sessionId=${sessionId} silent=${req.query.silent ? "1" : "0"} blocks=${parsed.blocks.length} lines=${parsed.stats.lines}`,
        );
      }

      res.json({
        sessionId: parsed.sessionId ?? sessionId,
        stats: parsed.stats,
        blocks: parsed.blocks,
        ...(owner ? { owner } : {}),
        ...(source ? { source } : {}),
        ...(lastRunState ? { lastRunState } : {}),
      });
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
      if (req.user?.role !== "admin" && meta && isMemoryPollSessionMeta(meta)) {
        res.status(404).json({ error: "Session not found" });
        return;
      }

      const updated = await updateSessionMeta(transcriptPath, {
        customTitle: title.trim() || undefined,
      });

      if (!updated) {
        res.status(404).json({ error: "Session meta not found" });
        return;
      }

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
          });
        } else {
          options.broadcastToUser?.(req.user.sub, {
            type: "title_updated",
            sessionId,
            title: updated.customTitle || "",
          });
        }
      }
      res.json({ ok: true, title: updated.customTitle || null });
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
          req.user?.role !== "admin" &&
          meta &&
          isMemoryPollSessionMeta(meta)
        ) {
          res.status(404).json({ error: "Session not found" });
          return;
        }

        // 从 transcript 提取前两轮用户消息和助手回复
        const { userMessages, assistantReplies } =
          await extractTitleContext(transcriptPath);

        if (userMessages.length === 0) {
          res
            .status(400)
            .json({ error: "No user message found in transcript" });
          return;
        }

        const title = await generateTitleWithFallback(
          userMessages[0],
          assistantReplies[0] || "",
          options.titleGeneratorConfigs,
          userMessages[1],
          assistantReplies[1],
          {
            onUsage: (model, usage) => {
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
          await fs.access(transcriptPath);
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
          req.user?.role !== "admin" &&
          meta &&
          isMemoryPollSessionMeta(meta)
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
          req.user?.role !== "admin" &&
          meta &&
          isMemoryPollSessionMeta(meta)
        ) {
          res.status(404).json({ error: "Session not found" });
          return;
        }

        const rawTokenUsage = hasTranscript
          ? await getTokenUsage(transcriptPath)
          : null;
        const tokenUsage = rawTokenUsage
          ? attachContextAccounting(
            rawTokenUsage,
            options.resolveContextAccounting,
            meta?.model,
          )
          : null;
        res.json({ tokenUsage, totalCostUsd: meta?.totalCostUsd ?? null });
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

        // 会话归属校验
        // PR 7 P0-3 残余：admin 跨组织也被挡，但 stream-status 是探活轻量接口，
        // 不暴露 403 区分 — 直接返回 active:false（与原非 admin 路径策略一致）
        if (req.user) {
          const userCwd = resolveUserCwd(agentCwd, {
            id: req.user.sub,
            username: req.user.username,
            role: req.user.role,
            tenantId: req.user.tenantId,
          });
          const transcriptPath = getTranscriptPath(userCwd, sessionId, reqTranscriptOwner(req.user));
          const meta = await readSessionMeta(transcriptPath);
          if (!canAccessSession(req.user, meta, options.userStore)) {
            res.json({ active: false });
            return;
          }
          if (
            req.user.role !== "admin" &&
            meta &&
            isMemoryPollSessionMeta(meta)
          ) {
            res.json({ active: false });
            return;
          }
        }

        const status = options.getStreamStatus
          ? await options.getStreamStatus(sessionId)
          : { active: false };
        res.json(status);
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
        if (meta && isMemoryPollSessionMeta(meta)) {
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

      const pending = interactionStore.getPendingInteractions(sessionId);
      if (transcriptPath) {
        const eventStore = runtimeEventStoreFor
          ? runtimeEventStoreFor(transcriptPath)
          : new FileEventStore(getRuntimeEventLogPath(transcriptPath));
        const approvalStore = new EventBackedApprovalStore(
          eventStore,
          sessionId,
        );
        const replayState = buildRuntimeReplayState(
          await eventStore.list(sessionId),
          await approvalStore.list(sessionId),
          sessionId,
        );
        const existingIds = new Set(
          pending.map((entry) => entry.interactionId),
        );
        for (const state of buildPendingInteractionsFromEvents(
          replayState.events,
          sessionId,
        )) {
          if (existingIds.has(state.interactionId)) continue;
          if (state.type !== "ask_user" && state.type !== "permission_request")
            continue;
          pending.push({
            interactionId: state.interactionId,
            type: state.type,
            runId: state.runId,
            toolCallId: state.toolCallId,
            invocationId: state.invocationId,
            questions: state.questions,
            toolId: state.toolId,
            toolName: state.toolName,
            displayName: state.displayName,
            toolInput: state.toolInput,
          });
          existingIds.add(state.interactionId);
        }
        for (const state of replayState.pendingApprovals) {
          const approval = state.approval;
          if (!approval) continue;
          if (existingIds.has(approval.id)) continue;
          pending.push({
            interactionId: approval.id,
            type: "permission_request",
            toolId: approval.toolId,
            toolName: approval.toolName,
            displayName: approval.displayName,
            toolInput:
              approval.input && typeof approval.input === "object"
                ? (approval.input as Record<string, unknown>)
                : { value: approval.input },
          });
        }
      }
      res.json(pending);
    },
  );

  /**
   * POST /api/sessions/:sessionId/restore
   *
   * 从回收站恢复自己的会话（移除 deletedAt）。
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

        // 优先找 .jsonl，fallback 到 .meta.json
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
        if (!meta || meta.userId !== req.user.sub) {
          res.status(403).json({ error: "Access denied" });
          return;
        }
        if (!meta.deletedAt) {
          res.status(400).json({ error: "Session is not deleted" });
          return;
        }

        // 移除 deletedAt/deletedBy
        const { deletedAt, deletedBy, ...rest } = meta;
        await writeSessionMeta(transcriptPath, rest as SessionMeta);

        auditLog(req, "session_restored", sessionId);
        sessionsListCache.clear();
        res.json({ ok: true, restored: true });
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

        // 有 .jsonl 时走完整删除；否则只清理孤儿 meta + sidecar
        if (hasTranscript) {
          const result = await deleteSession(sessionId, {
            deleteSidecarDir: true,
          });
          if (!result.deleted) {
            res.status(404).json({ error: "Session not found" });
            return;
          }
        } else {
          const result = await deleteSessionMetaOnly(sessionId, {
            deleteSidecarDir: true,
          });
          if (!result.deleted) {
            res.status(404).json({ error: "Session meta not found" });
            return;
          }
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
   * 软删除会话（写入 deletedAt，文件不物理删除）
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
        await fs.access(transcriptPath);
      } catch {
        // .jsonl 不在当前用户目录，全局扫描
        const found = await findTranscriptPathBySessionId(sessionId);
        if (found) transcriptPath = found;
      }
      let meta = await readSessionMeta(transcriptPath);

      // transcript 存在但缺少 meta：补建 meta 以支持软删除
      if (!meta) {
        try {
          await fs.access(transcriptPath);
        } catch {
          // transcript 也不存在，真正的 404
          res.status(404).json({ error: "Session not found" });
          return;
        }
        if (req.user?.role !== "admin") {
          const expectedNewPath = getTranscriptPath(delUserCwd, sessionId, reqTranscriptOwner(req.user));
          const expectedLegacyPath = getTranscriptPath(delUserCwd, sessionId);
          if (transcriptPath !== expectedNewPath && transcriptPath !== expectedLegacyPath) {
            res.status(403).json({ error: "Access denied" });
            return;
          }
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
      if (req.user?.role !== "admin" && isMemoryPollSessionMeta(meta)) {
        res.status(404).json({ error: "Session not found" });
        return;
      }

      // 已经软删除的不重复操作
      if (meta.deletedAt) {
        res.json({ ok: true, softDeleted: true });
        return;
      }

      // 软删除：写入 deletedAt + deletedBy
      await updateSessionMeta(transcriptPath, {
        deletedAt: new Date().toISOString(),
        deletedBy: req.user?.username || "anonymous",
      });

      auditLog(req, "session_soft_deleted", sessionId);
      sessionsListCache.clear();
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
            });
          } else {
            options.broadcastToUser?.(userId, {
              type: "session_deleted",
              sessionId,
            });
          }
        }
      }
      res.json({ ok: true, softDeleted: true });
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
      res.status(500).json({ error: msg });
    }
  });

  return router;
}

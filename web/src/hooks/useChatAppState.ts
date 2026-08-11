import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import type { ChangeEvent, ClipboardEvent, DragEvent, RefObject } from "react";
import type { MessageItem, UploadedFile } from "@/components/types";
import type { ApiSessionListItem, TokenUsage } from "@/lib/sessionsApi";
import type { AskUserAnswers, ContextUsageData, NotificationData, MemoryRecallData, PluginInstallData } from "@agent/shared";
import type { ModelList } from "@/types/models";
import type { AppTab } from "@/types/sidebar";
import type { CanonicalSettingsSectionId, SettingsSectionId } from "@/types/settings";
import type { WsEvent } from "@/types/ws";
import type { WsEnvelope, WsResumeMessage } from "@/lib/wsClient";
import { wsClient } from "@/lib/wsClient";
import { authFetch } from "@/lib/authFetch";
import { registerRefresh, unregisterRefresh } from "@/lib/refreshBus";
import { fetchAgentProfile, reportActivity } from "@agent/shared";
import type { AgentProfile, SessionParticipants } from "@agent/shared";
import { saveSessionMessages } from "@/lib/messageCache";
import {
  getComposerDraftScope,
  loadComposerAttachments,
  loadComposerText,
  saveComposerAttachments,
  saveComposerText,
} from "@/lib/composerDraftStorage";
import { mapSessionDetailToMessages } from "@/lib/sessionsApi";
import type { ApiSessionDetail } from "@/lib/sessionsApi";
import {
  asCompactionItem,
  compactionDoneReplacement,
  createCompactionDoneItem,
  createCompactionRunningItem,
} from "@/lib/compaction";
import type { CompactionMessageItem, CompactionStatusEvent } from "@/lib/compaction";
import {
  InterjectionConsumptionRegistry,
  reconcileQueuedInterjections,
  removeConsumedInterjections,
} from "@/lib/interjectionConsumption";
import type { QueuedInterjection } from "@/lib/interjectionConsumption";
export type { QueuedInterjection } from "@/lib/interjectionConsumption";
import { parseUrl, pushUrl, replaceUrl, buildUrl, buildSettingsUrl, replaceSettingsUrl, pushAdminSettingsUrl, replaceAdminSettingsUrl, buildAdminSettingsUrl, normalizeAdminSettingsSection, buildPlatformAdminUrl, pushPlatformAdminUrl, replacePlatformAdminUrl, buildTenantAdminUrl, pushTenantAdminUrl, replaceTenantAdminUrl, normalizeTenantAdminSection, preserveScopeSearch, preserveSearchKeys, TENANT_ADMIN_SCOPE_KEYS, pushGovernanceUrl, replaceGovernanceUrl } from "@/lib/urlSync";
import { buildGovernanceUrl, governanceRoute, type GovernanceRouteState } from "@/lib/governanceNavigation";
import { registerUpdateGuard, registerBeforeReloadHook, maybeReloadOnPopstate } from "@/lib/swUpdate";
import { clearRunShellApprovalStorage, runShellApprovalStorageKey } from "@/lib/runShellApprovalStorage";
import type { AdminSettingsState, AdminSettingsTarget, PlatformAdminSection, TenantAdminSection } from "@/lib/urlSync";
import { useMessages } from "@/hooks/useMessages";
import { usePersonalSettingsNavigation } from "@/hooks/usePersonalSettingsNavigation";
import { useAuth } from "@/contexts/AuthContext";
import { useSession } from "@/hooks/useSession";
import { useFileUpload } from "@/hooks/useFileUpload";
import { useConnectionState, type ConnectionState } from "@/hooks/useConnectionState";
import {
  processWsEvent,
  finalizeStreamingMessages,
  finalizeRunningSubagents,
  formatRuntimeFailureMessage,
  isInsufficientCreditsFailure,
  removeRuntimeStatusMessages,
  upsertRuntimeStatusMessage,
  type WsProcessingContext,
  type WsBlockState,
} from '@agent/shared';
/**
 * resume 去重闸门：重连时本 hook 有两个 onStateChange('connected') 监听器会各对当前会话
 * 发一次 resume（#1 连接管理、#2 subscribeToActiveStream）。重复 resume 会让服务端二次回放
 * 缓冲事件 → 整段重复。这里按 sessionId 做短时窗去重，保证一次重连只真正发一条 resume
 * （服务端 handleResume 串行化是另一层兜底）。手法同 shared/wsHandler 的 sync 防抖。
 * 去重 key 仅用 sessionId：中途切到别的 session 会重置 key，切回时不会被误挡。
 */
const RESUME_DEDUP_MS = 2000;
let _lastResumeSessionId = '';
let _lastResumeAt = 0;
function sendResumeDeduped(payload: WsResumeMessage): Promise<boolean> {
  const now = Date.now();
  if (_lastResumeSessionId === payload.sessionId && now - _lastResumeAt < RESUME_DEDUP_MS) {
    // 2s 内已对同一 session 发过 resume（多监听器重复触发）→ 跳过，视为成功
    // （已有等效 resume 在途，服务端会回同一个 active_stream，无需再发）。
    return Promise.resolve(true);
  }
  _lastResumeSessionId = payload.sessionId;
  _lastResumeAt = now;
  return wsClient.ensureConnectedSend(payload);
}
export interface ChatAppState {
  messages: MessageItem[];
  input: string;
  loading: boolean;
  sessionId: string | null;
  sessions: ApiSessionListItem[];
  activeTab: AppTab;
  /** 当前 V2 治理/设置稳定路由；保持 AppTab 外部合同不变。 */
  governanceRoute: GovernanceRouteState | null;
  platformAdminSection: PlatformAdminSection;
  platformAdminEntityId: string | null;
  /** 组织分析当前页签（进路径，可分享/刷新保留） */
  tenantAdminSection: TenantAdminSection;
  settingsOpen: boolean;
  settingsSection: CanonicalSettingsSectionId;
  uploadedFiles: UploadedFile[];
  uploading: boolean;
  uploadError: string | null;
  dismissUploadError: () => void;
  isDragging: boolean;
  isLoadingSessions: boolean;
  isLoadingMessages: boolean;
  hasMoreHistory: boolean;
  isLoadingEarlier: boolean;
  loadEarlierMessages: () => Promise<void>;
  deleteSessionId: string | null;
  deleteSessionCount: number;
  lastMessageRef: RefObject<HTMLDivElement>;
  scrollContainerRef: RefObject<HTMLDivElement>;
  isNearBottomRef: React.MutableRefObject<boolean>;
  setInput: (value: string) => void;
  setActiveTab: (tab: AppTab) => void;
  /** push 版本的 setActiveTab：会在浏览器历史里创建一条记录，供 user menu 跳转使用 */
  pushActiveTab: (tab: AppTab) => void;
  setPlatformAdminRoute: (section: PlatformAdminSection, entityId?: string | null) => void;
  /** 切换组织分析页签（push 历史，浏览器后退可回到上一个页签） */
  setTenantAdminRoute: (section: string) => void;
  openSettings: (section?: SettingsSectionId) => void;
  closeSettings: () => void;
  setSettingsSection: (section: SettingsSectionId) => void;
  /** 组织管理 / 平台管理 modal 状态。null = 未打开。 */
  adminSettings: AdminSettingsState | null;
  /** 打开 admin settings modal；activeTab 跟着切到对应 admin 区域 */
  openAdminSettings: (target: AdminSettingsTarget, section?: string) => void;
  /** 关闭 admin settings modal；URL 回到 admin frame 主路径 */
  closeAdminSettings: () => void;
  /** 切换 admin settings modal 内的 section（侧栏点击时调用） */
  setAdminSettingsSection: (section: string) => void;
  newSession: () => void;
  selectSession: (id: string) => void;
  /** 企业专家新草稿：不创建服务端会话，首条消息 WS payload 才带上 orgAgentId */
  startOrgAgentSession: (agentId: string) => void;
  /** 草稿中的企业专家 id；缺省 null */
  pendingOrgAgentId: string | null;
  confirmDeleteSession: (id: string) => void;
  confirmDeleteSessions: (ids: string[]) => void;
  cancelDeleteSession: () => void;
  handleDeleteSession: () => Promise<void>;
  renameSession: (sessionId: string, newTitle: string) => Promise<boolean>;
  autoTitleSession: (sessionId: string) => Promise<boolean>;
  compactSession: () => Promise<void>;
  removeFile: (index: number) => void;
  handleFileSelect: (event: ChangeEvent<HTMLInputElement>) => Promise<void>;
  handlePaste: (event: ClipboardEvent) => Promise<void>;
  sendMessage: () => Promise<void>;
  sendVoiceMessage: (wavBlob: Blob, durationMs: number) => Promise<void>;
  stopping: boolean;
  stopGeneration: () => void;
  /** 插话队列区（2026-08-04 终态设计） */
  queuedInterjections: QueuedInterjection[];
  /** 撤回一条排队插话；too_late（已被消费）时返回 false */
  cancelQueuedInterjection: (clientMsgId: string) => Promise<boolean>;
  /** 撤回并把内容放回输入框（编辑） */
  editQueuedInterjection: (clientMsgId: string) => Promise<void>;
  /** 重发一条已取消/失败的插话 */
  resendQueuedInterjection: (clientMsgId: string) => void;
  /** 从队列区移除一条已取消/失败条目 */
  dismissQueuedInterjection: (clientMsgId: string) => void;
  retryMessage: (message: MessageItem) => void;
  forkFromMessage: (message: MessageItem) => void;
  handleDragOver: (event: DragEvent) => void;
  handleDragLeave: (event: DragEvent) => void;
  handleDrop: (event: DragEvent) => Promise<void>;
  handlePermissionResponse: (interactionId: string, allow: boolean) => Promise<void>;
  handleAskUserResponse: (interactionId: string, answers: AskUserAnswers) => Promise<void>;
  modelList: ModelList | null;
  selectedModel: string | null;
  onModelChange: (ref: string) => void;
  autoApproveRunShell: boolean;
  setAutoApproveRunShell: (checked: boolean) => void;
  tokenUsage: TokenUsage | null;
  contextUsage: ContextUsageData | null;
  /** SDK 0.2.112+ REPL 通知队列（带 priority/timeoutMs 自动消失）*/
  notifications: NotificationData[];
  dismissNotification: (key: string) => void;
  /** SDK 最近一次 memory_recall（supervisor 自动注入记忆的元数据，当前会话只保留最后一次）*/
  lastMemoryRecall: MemoryRecallData | null;
  dismissMemoryRecall: () => void;
  /** SDK 插件安装进度（仅在 /plugin install 等命令期间有值）*/
  pluginInstallStatus: PluginInstallData | null;
  /** 当前处于活跃运行态的会话 ID 集合（含后台会话） */
  runningSessionIds: ReadonlySet<string>;
  connectionState: ConnectionState;
  refreshCurrentSession: () => void;
  resumeCurrentStream: () => Promise<void>;
  hasMoreSessions: boolean;
  isLoadingMoreSessions: boolean;
  loadMoreSessions: () => Promise<void>;
  loadGroupSessions: (groupId: string) => Promise<void>;
  agentProfile: AgentProfile | null;
  sessionParticipants: SessionParticipants | null;
  previewFilePath: string | null;
  previewFileOwner: string | undefined;
  previewMode: "dialog" | "side";
  openFilePreview: (path: string, owner?: string, options?: { mode?: "dialog" | "side" }) => void;
  dockFilePreview: () => void;
  expandFilePreview: () => void;
  closeFilePreview: () => void;
  fileBrowserOpen: boolean;
  toggleFileBrowser: () => void;
  closeFileBrowser: () => void;
  isTrashPreview: boolean;
  previewTrashSession: (id: string | null) => void;
  trashPreviewSessionId: string | null;
}

export interface ChatAppStateOptions {
  /** Callback when Agent VOICE markers arrive, used for auto-play */
  onVoiceEvent?: (key: string, text: string, voice?: string, speed?: number) => void;
}

type LastRunState = NonNullable<ApiSessionDetail["lastRunState"]>;
type TerminalRuntimeStatus = 'idle' | 'completed' | 'failed' | 'cancelled' | 'orphaned';

const ACTIVE_RUNTIME_STATUSES = new Set<string>([
  'busy',
  'queued',
  'running',
  'waiting_approval',
  'waiting_user',
  'waiting_hand',
]);

const TERMINAL_RUNTIME_STATUSES = new Set<string>([
  'idle',
  'completed',
  'failed',
  'cancelled',
  'orphaned',
]);

function isActiveRuntimeStatus(status: string | undefined): boolean {
  return !!status && ACTIVE_RUNTIME_STATUSES.has(status);
}

function isTerminalRuntimeStatus(status: string | undefined): status is TerminalRuntimeStatus {
  return !!status && TERMINAL_RUNTIME_STATUSES.has(status);
}

function runtimeStatusFromSessionStatus(status: string): Parameters<typeof upsertRuntimeStatusMessage>[1] | null {
  switch (status) {
    case 'queued':
      return 'queued';
    case 'busy':
    case 'running':
      return 'running';
    case 'waiting_hand':
      return 'waiting_hand';
    case 'waiting_approval':
      return 'waiting_approval';
    case 'waiting_user':
      return 'waiting_user';
    default:
      return null;
  }
}

export function useChatAppState(options?: ChatAppStateOptions): ChatAppState {
  const { user } = useAuth();
  // 授权模式对所有用户生效（2026-07-02 起），用户在账户设置中自行切换。
  const authorizationModeEnabled = user?.preferences?.authorizationModeEnabled === true;

  // 从 URL 解析初始状态（仅执行一次）
  const [urlState] = useState(() => parseUrl());



  // ---- Agent Profile ----
  const [agentProfile, setAgentProfile] = useState<AgentProfile | null>(null);
  useEffect(() => {
    if (!user) { setAgentProfile(null); return; }
    fetchAgentProfile(user.username)
      .then(setAgentProfile)
      .catch(() => setAgentProfile(null));
  }, [user]);

  // ---- Session Participants ----
  const [sessionParticipants, setSessionParticipants] = useState<SessionParticipants | null>(null);

  // ---- File preview ----
  const [previewFilePath, setPreviewFilePath] = useState<string | null>(null);
  const [explicitPreviewOwner, setExplicitPreviewOwner] = useState<string | undefined>(undefined);
  const [previewMode, setPreviewMode] = useState<"dialog" | "side">("dialog");
  const openFilePreview = useCallback((path: string, owner?: string, options?: { mode?: "dialog" | "side" }) => {
    setPreviewFilePath(path);
    setExplicitPreviewOwner(owner);
    // md/PDF 附件卡默认走 "side"（右侧面板），让用户可以边预览边继续对话；
    // FileBrowser、代码块内联路径等调用点保持默认 "dialog" 弹窗行为。
    setPreviewMode(options?.mode ?? "dialog");
  }, []);
  const dockFilePreview = useCallback(() => {
    setPreviewMode("side");
  }, []);
  const expandFilePreview = useCallback(() => {
    setPreviewMode("dialog");
  }, []);
  const closeFilePreview = useCallback(() => {
    setPreviewFilePath(null);
    setExplicitPreviewOwner(undefined);
    setPreviewMode("dialog");
  }, []);

  // ---- File browser ----
  const [fileBrowserOpen, setFileBrowserOpen] = useState(false);
  const toggleFileBrowser = useCallback(() => setFileBrowserOpen(v => !v), []);
  const closeFileBrowser = useCallback(() => setFileBrowserOpen(false), []);

  // ---- Trash preview (admin only) ----
  const [trashPreviewSessionId, setTrashPreviewSessionId] = useState<string | null>(null);
  const isTrashPreview = trashPreviewSessionId !== null;

  // ---- Input state（按用户 + 会话保存浏览器本地草稿）----
  const initialComposerScope = getComposerDraftScope(user?.id, urlState.sessionId);
  const composerScopeRef = useRef(initialComposerScope);
  const [input, setInputRaw] = useState(() => loadComposerText(initialComposerScope, true));
  const draftTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const setInput = useCallback((value: string) => {
    setInputRaw(value);
    clearTimeout(draftTimerRef.current);
    const scope = composerScopeRef.current;
    if (value) {
      draftTimerRef.current = setTimeout(() => saveComposerText(scope, value), 500);
    } else {
      saveComposerText(scope, "");
    }
  }, []);

  // ---- Loading / stream control ----
  const [loading, setLoading] = useState(false);
  const [stopping, setStopping] = useState(false);

  // ---- SDK notifications (REPL 级通知队列，按 priority 排序 + timeoutMs 自动消失) ----
  // 通知队列最大长度：超出后按优先级保留前 N 条，低优先级被挤掉
  const MAX_NOTIFICATIONS = 5;
  const [notifications, setNotifications] = useState<NotificationData[]>([]);
  const notificationTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const dismissNotification = useCallback((key: string) => {
    setNotifications((list) => list.filter((n) => n.key !== key));
    const timer = notificationTimersRef.current.get(key);
    if (timer) {
      clearTimeout(timer);
      notificationTimersRef.current.delete(key);
    }
  }, []);
  const pushNotification = useCallback((n: NotificationData) => {
    // 闭包变量：updater 执行后回写，决定新 timer 是否需要设置
    // React 18 StrictMode 下 updater 可能被调用两次，两次都会重置成一致值，安全
    let included = true;
    setNotifications((list) => {
      const next = list.filter((x) => x.key !== n.key);
      next.push(n);
      // 按 priority 排序（immediate > high > medium > low）
      const order: Record<NotificationData['priority'], number> = {
        immediate: 0, high: 1, medium: 2, low: 3,
      };
      next.sort((a, b) => order[a.priority] - order[b.priority]);
      if (next.length > MAX_NOTIFICATIONS) {
        const dropped = next.slice(MAX_NOTIFICATIONS);
        for (const d of dropped) {
          const t = notificationTimersRef.current.get(d.key);
          if (t) {
            clearTimeout(t);
            notificationTimersRef.current.delete(d.key);
          }
        }
        const finalNext = next.slice(0, MAX_NOTIFICATIONS);
        included = finalNext.some((x) => x.key === n.key);
        return finalNext;
      }
      included = true;
      return next;
    });
    // 无条件清除同 key 旧 timer——避免"新通知 timeoutMs 为 undefined 时，旧 timer 仍在原时间点把新通知误删"
    const existing = notificationTimersRef.current.get(n.key);
    if (existing) {
      clearTimeout(existing);
      notificationTimersRef.current.delete(n.key);
    }
    // 仅当新通知真的进入队列 + 自身带 timeoutMs 时才设新 timer，避免孤儿 timer
    if (included && n.timeoutMs && n.timeoutMs > 0) {
      const t = setTimeout(() => dismissNotification(n.key), n.timeoutMs);
      notificationTimersRef.current.set(n.key, t);
    }
  }, [dismissNotification]);

  const [lastMemoryRecall, setLastMemoryRecall] = useState<MemoryRecallData | null>(null);
  const dismissMemoryRecall = useCallback(() => setLastMemoryRecall(null), []);
  const [pluginInstallStatus, setPluginInstallStatus] = useState<PluginInstallData | null>(null);
  // pluginInstall 自动清除计时器：ref 化防止切会话时旧 timer 误清新会话状态
  const pluginInstallTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearPluginInstallTimer = useCallback(() => {
    if (pluginInstallTimerRef.current) {
      clearTimeout(pluginInstallTimerRef.current);
      pluginInstallTimerRef.current = null;
    }
  }, []);

  // 统一的 unmount cleanup：notifications timer + pluginInstall timer 一并回收
  useEffect(() => {
    return () => {
      for (const t of notificationTimersRef.current.values()) clearTimeout(t);
      notificationTimersRef.current.clear();
      clearPluginInstallTimer();
    };
  }, [clearPluginInstallTimer]);
  const [activeTab, setActiveTabRaw] = useState<AppTab>(urlState.tab);
  const [governanceRouteState, setGovernanceRouteRaw] = useState<GovernanceRouteState | null>(urlState.governanceRoute);
  const [platformAdminSection, setPlatformAdminSectionRaw] = useState<PlatformAdminSection>(urlState.adminSection ?? 'overview');
  const [platformAdminEntityId, setPlatformAdminEntityIdRaw] = useState<string | null>(urlState.adminEntityId);
  const [tenantAdminSection, setTenantAdminSectionRaw] = useState<TenantAdminSection>(urlState.tenantAdminSection ?? 'overview');
  const [pendingCanonicalPath, setPendingCanonicalPath] = useState<string | null>(urlState.canonicalPath);
  const [settingsOpen, setSettingsOpen] = useState(() => urlState.settingsSection !== null);
  const [settingsSection, setSettingsSectionRaw] = useState<CanonicalSettingsSectionId>(urlState.settingsSection ?? 'account-security');
  const [adminSettings, setAdminSettingsRaw] = useState<AdminSettingsState | null>(() => urlState.adminSettings);
  const activeTabRef = useRef<AppTab>(activeTab);
  activeTabRef.current = activeTab;
  const governanceRouteRef = useRef<GovernanceRouteState | null>(governanceRouteState);
  governanceRouteRef.current = governanceRouteState;
  const platformAdminRouteRef = useRef<{ section: PlatformAdminSection; entityId: string | null }>({
    section: platformAdminSection,
    entityId: platformAdminEntityId,
  });
  platformAdminRouteRef.current = { section: platformAdminSection, entityId: platformAdminEntityId };
  const tenantAdminSectionRef = useRef<TenantAdminSection>(tenantAdminSection);
  tenantAdminSectionRef.current = tenantAdminSection;
  const adminSettingsRef = useRef<AdminSettingsState | null>(adminSettings);
  adminSettingsRef.current = adminSettings;
  const streamNonceRef = useRef(0);
  const streamIdRef = useRef<string | null>(null);
  const runIdRef = useRef<string | null>(null);
  const handledTerminalKeysRef = useRef(new Set<string>());
  const lastEventIdRef = useRef<number | null>(null);
  const lastEventCursorRef = useRef<string | null>(null);

  /**
   * Per-session 运行态快照（架构升级,2026-06-25）。
   *
   * 替代单一全局 ref 模型（streamIdRef/runIdRef/lastEventIdRef/lastEventCursorRef/wsAttachedRef/loadingRef）,
   * 让"切走会话 → 切回会话"链路不再丢状态。原模型在 detachFromStream 时清光全部 ref,
   * 切回后只能靠 HTTP /stream-status 二次判活;原 stream-status 又只看 EventBuffer
   * (buffer 一丢即误报 inactive),同时全局 handler 直接吞掉 active_stream 事件。
   * 最终症状：切会话后看不到积压消息、停止按钮消失、必须刷新页面才能恢复。
   *
   * 新模型：activeRunsBySession 是 per-session 持久状态(单 hook 实例内存),
   * 全局 ref 退化为"当前选中会话的 active 镜像"。事件 reducer 总是写 Map,
   * 当 sessionId 匹配当前会话才 sync 到 ref;切走时 dump ref 到 Map,切回时 load Map 到 ref。
   */
  type SessionRuntime = {
    status: 'idle' | 'busy' | 'running' | 'queued'
      | 'waiting_approval' | 'waiting_user' | 'waiting_hand'
      | 'completed' | 'failed' | 'cancelled' | 'orphaned';
    streamId?: string;
    runId?: string;
    /** 当前 run 已成功接收的最大 EventBuffer id；新 run 必须重置 */
    lastEventId?: number;
    /** 会话级 durable 时序游标；跨 run 保留，跨进程增量回放以它为准 */
    lastEventCursor?: string | null;
    /** 当前 WS 是否订阅着这条流（瞬时；不持久化语义） */
    attached: boolean;
  };
  type SessionRuntimePatch = Partial<Omit<SessionRuntime, 'streamId' | 'runId' | 'lastEventId' | 'lastEventCursor'>> & {
    streamId?: string | null;
    runId?: string | null;
    lastEventId?: number | null;
    lastEventCursor?: string | null;
  };
  const activeRunsBySession = useRef<Map<string, SessionRuntime>>(new Map());
  /** 每次实时 runtime 事件递增；批量 HTTP 快照不得覆盖请求发出后的新事件。 */
  const runtimeVersionBySessionRef = useRef<Map<string, number>>(new Map());
  const [runningSessionIds, setRunningSessionIds] = useState<ReadonlySet<string>>(() => new Set());

  // ─── 消息可靠性：outbox 队列 + ACK 超时跟踪（2026-04-18）───
  /**
   * Outbox：用户已提交但尚未到达"服务端已处理"终态的消息队列。
   * - sending: 已 ensureConnectedSend，等 ACK
   * - acked: 收到 chat_ack，等 done
   * 替代旧的 pendingMessageRef 单槽设计：旧设计在用户快速连发时会静默覆盖。
   * 2026-08-04 终态设计删除本地 'queued' 双轨：运行中发送一律直发服务端做 durable
   * steering（进队列区），不再本地扣留等 done 后 flush——两套排队语义并存造成
   * 后发先至、气泡串号（P2-10）与停止丢消息（P2-5）。
   */
  interface OutboxEntry {
    clientMsgId: string;
    input: string;
    attachments: UploadedFile[];
    voiceFile?: { savedPath: string; relativePath: string; duration: number };
    autoApproveRunShell?: boolean;
    state: 'sending' | 'acked';
    createdAt: number;
  }
  const outboxRef = useRef<OutboxEntry[]>([]);
  /** 每个 inflight 消息的 ACK 超时定时器（收到 ack 清除） */
  const ackTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const ACK_TIMEOUT_MS = 15_000;
  /** cancel_queued 请求的等待器：sourceRunId → resolve(ok)（2026-08-04 终态设计） */
  const cancelWaitersRef = useRef<Map<string, (ok: boolean) => void>>(new Map());

  // ─── 插话队列区（2026-08-04 终态设计）───
  // 运行中发送的消息不进时间线，在输入框上方的队列区排队，被目标 run 消费
  //（user_message 投影）或回退接管（非 queued stream_id）时才进时间线。
  const [queuedInterjections, setQueuedInterjectionsState] = useState<QueuedInterjection[]>([]);
  const queuedInterjectionsRef = useRef<QueuedInterjection[]>([]);
  const consumedInterjectionsRef = useRef(new InterjectionConsumptionRegistry());
  const mutateQueuedInterjections = useCallback(
    (updater: (prev: QueuedInterjection[]) => QueuedInterjection[]) => {
      const next = updater(queuedInterjectionsRef.current);
      if (next === queuedInterjectionsRef.current) return;
      queuedInterjectionsRef.current = next;
      setQueuedInterjectionsState(next);
    },
    [],
  );

  // Detail 快照与消费标记的对账保持稳定引用，供 session callbacks 复用。
  const reconcileServerInterjections = useCallback(
    (serverQueued: NonNullable<ApiSessionDetail["queuedMessages"]>) => {
      mutateQueuedInterjections(
        (prev) => reconcileQueuedInterjections(
          prev,
          serverQueued,
          consumedInterjectionsRef.current,
        ),
      );
    },
    [mutateQueuedInterjections],
  );
  const voiceCallbackRef = useRef(options?.onVoiceEvent);
  voiceCallbackRef.current = options?.onVoiceEvent;

  // ---- Model selection (with retry on WS reconnect) ----
  const [modelList, setModelList] = useState<ModelList | null>(null);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [autoApproveRunShell, setAutoApproveRunShellState] = useState(false);
  const effectiveAutoApproveRunShell = authorizationModeEnabled || autoApproveRunShell;
  const modelListRef = useRef(modelList);
  modelListRef.current = modelList;

  const fetchModelList = useCallback(() => {
    authFetch("/api/models")
      .then((r) => {
        if (r.ok) return r.json();
        return null;
      })
      .then((data: ModelList | null) => {
        if (data) {
          setModelList(data);
          setSelectedModel((prev) => sessionIdRef.current ? (prev || data.default) : data.default);
        }
      })
      .catch(() => { });
  }, []);

  useEffect(() => {
    fetchModelList();
  }, [fetchModelList]);

  useEffect(() => {
    const handleDefaultModelChanged = () => { fetchModelList(); };
    window.addEventListener("agent:default-model-changed", handleDefaultModelChanged);
    return () => window.removeEventListener("agent:default-model-changed", handleDefaultModelChanged);
  }, [fetchModelList]);

  useEffect(() => {
    registerRefresh("models", async () => { fetchModelList(); });
    return () => unregisterRefresh("models");
  }, [fetchModelList]);

  // ---- Sub-hooks ----
  const msg = useMessages();
  const fileUpload = useFileUpload(activeTab);
  const { connectionState, dispatchConnection } = useConnectionState();

  // ---- Refs for unstable values ----
  const inputRef = useRef(input); inputRef.current = input;
  const loadingRef = useRef(loading); loadingRef.current = loading;
  const stoppingRef = useRef(stopping); stoppingRef.current = stopping;
  const uploadedFilesRef = useRef(fileUpload.uploadedFiles); uploadedFilesRef.current = fileUpload.uploadedFiles;
  const uploadingRef = useRef(fileUpload.uploading); uploadingRef.current = fileUpload.uploading;
  const selectedModelRef = useRef(selectedModel); selectedModelRef.current = selectedModel;
  const autoApproveRunShellRef = useRef(effectiveAutoApproveRunShell); autoApproveRunShellRef.current = effectiveAutoApproveRunShell;
  const msgRef = useRef(msg); msgRef.current = msg;
  const sessionIdRef = useRef<string | null>(null);
  // 同步更新的 sessionId ref（解决 React 批量更新时 sessionIdRef 延迟问题）
  const immediateSessionIdRef = useRef<string | null>(urlState.sessionId);
  const trashPreviewSessionIdRef = useRef<string | null>(trashPreviewSessionId);
  trashPreviewSessionIdRef.current = trashPreviewSessionId;
  const refreshTokenUsageRef = useRef<() => void>(() => { });
  const loadSessionDetailRef = useRef<(id: string) => Promise<void>>(async () => { });
  // ---- SW 更新协作（lib/swUpdate.ts）----
  // 守门：上传中 / 消息在途（outbox 未清）/ **当前会话** run 处于进行态 → 导航时不强刷。
  //
  // 只守当前会话（2026-08-02）：后台会话的 run 跑在服务端，整页跳转不会打断它，回来照样
  // resume。原实现遍历 activeRunsBySession 的所有会话，长期挂着后台任务的用户会被永久守门
  // ——tab 锁死在旧 bundle，前端修复永远送不到他手上（曾磊因此仍在复现 d181ca3 已修的
  // 跨会话残留 bug）。
  useEffect(() => {
    const unregisterGuard = registerUpdateGuard(() => {
      if (uploadingRef.current) return true;
      if (outboxRef.current.length > 0) return true;
      // 草稿会话首条消息在途时 sessionId 仍为 null，靠 loading 兜住。
      if (loadingRef.current) return true;
      const currentSessionId = immediateSessionIdRef.current ?? sessionIdRef.current;
      if (!currentSessionId) return false;
      return isActiveRuntimeStatus(activeRunsBySession.current.get(currentSessionId)?.status);
    });
    // 刷新前同步 flush 当前会话草稿：debounce 窗口内的输入不丢
    const unregisterHook = registerBeforeReloadHook(() => {
      clearTimeout(draftTimerRef.current);
      saveComposerText(composerScopeRef.current, inputRef.current);
    });
    return () => {
      unregisterGuard();
      unregisterHook();
    };
  }, []);

  // ---- WS event processing state ----
  const wsBlockRef = useRef<WsBlockState>({ currentBlockIndex: -1, currentBlockType: null });
  const wsLatestSessionIdRef = useRef<{ value: string | null }>(null!);
  const wsUserMsgIndexRef = useRef(-1);
  /** 是否已挂载到某个流（detach 后为 false，发起/订阅流时为 true） */
  const wsAttachedRef = useRef(false);
  /** 新会话首条消息与服务端 session 事件的关联键；切换草稿后迟到事件不得接管当前页面。 */
  const pendingNewSessionClientMsgIdRef = useRef<string | null>(null);
  /** 标记所有尚未收到 session 事件的新会话消息；即使浏览器导航清掉当前草稿，也能识别迟到事件。 */
  const newSessionClientMsgIdsRef = useRef<Set<string>>(new Set());
  /** 记录其他连接发起的流，等 idle 到达时标为 AI 回复未读 */
  const trackedAiReplyStreamsRef = useRef<Set<string>>(new Set());
  /** 引用 sendChatViaWs（定义在下面），用于在它之前定义的 callback 中 flush 排队消息 */
  const sendChatViaWsRef = useRef<((
    inputText: string,
    attachments: UploadedFile[],
    showBubble: boolean,
    voiceFile?: { savedPath: string; relativePath: string; duration: number },
    existingClientMsgId?: string,
    autoApproveRunShellForMessage?: boolean,
    preserveActiveStream?: boolean,
  ) => Promise<void>) | null>(null);
  const reconcileLastRunStateRef = useRef<(sessionId: string, lastRunState: LastRunState) => void>(() => {});

  /** Partial patch Map.get(sid)；若 sid === current,同步 ref（不动 setState 状态） */
  const patchSessionRuntime = useCallback((sid: string, patch: SessionRuntimePatch) => {
    runtimeVersionBySessionRef.current.set(
      sid,
      (runtimeVersionBySessionRef.current.get(sid) ?? 0) + 1,
    );
    const existing = activeRunsBySession.current.get(sid) ?? { status: 'idle' as const, attached: false };
    const next: SessionRuntime = { ...existing };
    if (patch.status !== undefined) next.status = patch.status;
    if (patch.attached !== undefined) next.attached = patch.attached;
    if (patch.streamId !== undefined) {
      if (patch.streamId === null) delete next.streamId;
      else next.streamId = patch.streamId;
    }
    if (patch.runId !== undefined) {
      if (patch.runId === null) delete next.runId;
      else next.runId = patch.runId;
    }
    if (patch.lastEventId !== undefined) {
      if (patch.lastEventId === null) delete next.lastEventId;
      else next.lastEventId = patch.lastEventId;
    }
    if (patch.lastEventCursor !== undefined) {
      if (patch.lastEventCursor === null) delete next.lastEventCursor;
      else next.lastEventCursor = patch.lastEventCursor;
    }
    activeRunsBySession.current.set(sid, next);
    setRunningSessionIds((current) => {
      const isRunning = isActiveRuntimeStatus(next.status);
      if (current.has(sid) === isRunning) return current;
      const updated = new Set(current);
      if (isRunning) updated.add(sid);
      else updated.delete(sid);
      return updated;
    });
    if (sid === sessionIdRef.current) {
      if (patch.streamId !== undefined) streamIdRef.current = patch.streamId;
      if (patch.runId !== undefined) runIdRef.current = patch.runId;
      if (patch.lastEventId !== undefined) lastEventIdRef.current = patch.lastEventId;
      if (patch.lastEventCursor !== undefined) lastEventCursorRef.current = patch.lastEventCursor;
      if (patch.attached !== undefined) wsAttachedRef.current = patch.attached;
    }
    return next;
  }, []);

  const runtimeHydrationNonceRef = useRef(0);
  const hydrateSessionRuntimeSnapshot = useCallback(async (sessions: ApiSessionListItem[]) => {
    const nonce = ++runtimeHydrationNonceRef.current;
    const sessionIds = [...new Set(sessions.map((item) => item.sessionId).filter(Boolean))];
    const requestedVersions = new Map(
      sessionIds.map((sessionId) => [sessionId, runtimeVersionBySessionRef.current.get(sessionId) ?? 0]),
    );
    if (sessionIds.length === 0) {
      setRunningSessionIds(new Set());
      return;
    }

    try {
      const batches: string[][] = [];
      for (let offset = 0; offset < sessionIds.length; offset += 100) {
        batches.push(sessionIds.slice(offset, offset + 100));
      }
      const responses = await Promise.all(batches.map(async (batch) => {
        const response = await authFetch('/api/sessions/active-streams', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionIds: batch }),
        });
        if (!response.ok) throw new Error(`active-streams ${response.status}`);
        return response.json() as Promise<{
          sessions?: Array<{ sessionId: string; active: boolean; streamId?: string; runId?: string }>;
        }>;
      }));
      if (runtimeHydrationNonceRef.current !== nonce) return;

      const snapshotStatus = new Map<string, boolean>();
      for (const data of responses) {
        for (const item of data.sessions ?? []) {
          if ((runtimeVersionBySessionRef.current.get(item.sessionId) ?? 0) !== requestedVersions.get(item.sessionId)) {
            continue;
          }
          snapshotStatus.set(item.sessionId, item.active);
          if (!item.active) {
            const existing = activeRunsBySession.current.get(item.sessionId);
            if (existing?.lastEventCursor) {
              activeRunsBySession.current.set(item.sessionId, {
                status: 'idle',
                lastEventCursor: existing.lastEventCursor,
                attached: false,
              });
            } else {
              activeRunsBySession.current.delete(item.sessionId);
            }
            continue;
          }
          const existing = activeRunsBySession.current.get(item.sessionId);
          activeRunsBySession.current.set(item.sessionId, {
            ...(existing ?? { attached: false }),
            status: 'running',
            streamId: item.streamId ?? existing?.streamId,
            runId: item.runId ?? existing?.runId,
            attached: existing?.attached ?? false,
          });
        }
      }
      setRunningSessionIds((current) => {
        const next = new Set(current);
        for (const [sessionId, active] of snapshotStatus) {
          if (active) next.add(sessionId);
          else next.delete(sessionId);
        }
        return next;
      });
    } catch {
      // 会话列表仍可正常展示；WS session_status 与当前会话探活继续兜底。
    }
  }, []);

  /** 用户点击"停止"按钮：发送 abort，等 done 到达后才恢复 UI */
  const cancelActiveStream = useCallback(() => {
    const targetSessionId = sessionIdRef.current;
    const sid = streamIdRef.current;
    const rid = runIdRef.current;
    if (!sid && !rid) return;
    void wsClient.ensureConnectedSend({ action: 'abort', ...(rid ? { runId: rid } : {}), ...(sid ? { streamId: sid } : {}) });
    setStopping(true);
    // 停止=全停（2026-08-04 终态设计）：服务端 abort 联动撤销排队插话并广播
    // steering_cancelled；这里乐观先行标记，广播到达时幂等。内容保留可重发。
    mutateQueuedInterjections((prev) => prev.map((entry) => (
      entry.status === 'sending' || entry.status === 'queued'
        ? { ...entry, status: 'cancelled' as const, reason: '已随停止一并撤销' }
        : entry
    )));

    // 安全超时：10 秒内 done 未到达则强制恢复
    const nonceAtAbort = streamNonceRef.current;
    setTimeout(() => {
      const existingRuntime = targetSessionId ? activeRunsBySession.current.get(targetSessionId) : undefined;
      const shouldClearRuntime = Boolean(
        targetSessionId
        && (!existingRuntime || isActiveRuntimeStatus(existingRuntime.status))
        && (
          !existingRuntime
          || ((!rid || existingRuntime.runId === rid) || (!sid || existingRuntime.streamId === sid))
        ),
      );
      if (shouldClearRuntime && targetSessionId) {
        patchSessionRuntime(targetSessionId, {
          status: 'cancelled',
          streamId: null,
          runId: null,
          lastEventId: null,
          attached: false,
        });
      }
      if (streamNonceRef.current === nonceAtAbort && streamIdRef.current === sid) {
        streamIdRef.current = null;
        runIdRef.current = null;
        streamNonceRef.current += 1;
        lastEventIdRef.current = null;
        finalizeRunningSubagents(msgRef.current);
        removeRuntimeStatusMessages(msgRef.current);
        setLoading(false);
        setStopping(false);
      }
    }, 10_000);
  }, [patchSessionRuntime, mutateQueuedInterjections]);

  /** 把当前 ref（current session 的运行态镜像）dump 进 Map,保留 cursor 等持久字段 */
  const dumpCurrentSessionRuntime = useCallback(() => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    const existing = activeRunsBySession.current.get(sid);
    // status 字段：只优先保留 Map 已有的 active 状态（如 running/waiting_*),
    // 否则按 loadingRef 推断（loadingRef=true → running,false → idle）。
    // 这样 dump 不会盲目把"我在跑"覆盖成 idle,也不会把 completed/failed/cancelled 等终态当 active 保护。
    const inferredStatus: SessionRuntime['status'] =
      existing?.status && isActiveRuntimeStatus(existing.status)
        ? existing.status
        : (loadingRef.current ? 'running' : 'idle');
    patchSessionRuntime(sid, {
      status: inferredStatus,
      streamId: streamIdRef.current,
      runId: runIdRef.current,
      lastEventId: lastEventIdRef.current,
      lastEventCursor: lastEventCursorRef.current,
      attached: wsAttachedRef.current,
    });
  }, [patchSessionRuntime]);

  /** 从 Map 加载 sid 的 runtime 到当前 ref（不调 setState,UI 由调用方决定） */
  const loadSessionRuntimeToRef = useCallback((sid: string): SessionRuntime | undefined => {
    const cached = activeRunsBySession.current.get(sid);
    streamIdRef.current = cached?.streamId ?? null;
    runIdRef.current = cached?.runId ?? null;
    lastEventIdRef.current = cached?.lastEventId ?? null;
    lastEventCursorRef.current = cached?.lastEventCursor ?? null;
    return cached;
  }, []);

  /**
   * 会话切换时：立即清理本地 ref 状态，不发 abort（避免误终止其他设备的流）。
   *
   * ⚠️ 关键变更（2026-06-25）：先 dump 当前 ref 到 Map,保留 streamId/runId/cursor 等
   * 持久化字段。原实现清光所有 ref 是切会话丢状态的根因之一——切回时只能靠 HTTP
   * /stream-status + skipReplay:true 兜底，导致积压消息丢、停止按钮消失、必须刷新页面。
   */
  const detachFromStream = useCallback(() => {
    dumpCurrentSessionRuntime();
    streamIdRef.current = null;
    runIdRef.current = null;
    streamNonceRef.current += 1;
    lastEventIdRef.current = null;
    lastEventCursorRef.current = null;
    wsBlockRef.current = { currentBlockIndex: -1, currentBlockType: null };
    wsLatestSessionIdRef.current = { value: null };
    wsUserMsgIndexRef.current = -1;
    wsAttachedRef.current = false;
    finalizeRunningSubagents(msgRef.current);
    removeRuntimeStatusMessages(msgRef.current);
    setLoading(false);
    setStopping(false);
    // 切会话：sending/acked 留给它们自己的终态处理；队列区随会话重建（detail API 恢复）
    // 清所有 ACK 超时定时器
    for (const t of ackTimersRef.current.values()) clearTimeout(t);
    ackTimersRef.current.clear();
    consumedInterjectionsRef.current.clear();
    mutateQueuedInterjections(() => []);
    // 通知服务端解除 wsActiveStream 绑定（buffer 仍保留,resume 时可用 cursor 增量回放）
    wsClient.send({ action: 'detach' });
  }, [dumpCurrentSessionRuntime, mutateQueuedInterjections]);

  const sessionCallbacks = useMemo(() => ({
    resetMessages: msg.resetMessages,
    setMessages: msg.setMessages,
    getMessages: () => msg.messagesRef.current,
    onSessionsLoaded: hydrateSessionRuntimeSnapshot,
    triggerScroll: msg.triggerScroll,
    cancelActiveStream: detachFromStream,
    onLastRunState: (sessionId: string, lastRunState: LastRunState) => {
      reconcileLastRunStateRef.current(sessionId, lastRunState);
    },
    // 队列区真源同步（2026-08-04 终态设计）：以服务端仍在排队的插话为基底重建；
    // 本地 sending（未 ACK）与 cancelled/failed（展示态）条目保留，其余以服务端为准。
    onQueuedMessages: (sessionId: string, serverQueued: NonNullable<ApiSessionDetail["queuedMessages"]>) => {
      const sid = immediateSessionIdRef.current ?? sessionIdRef.current;
      if (!sid || sessionId !== sid) return;
      reconcileServerInterjections(serverQueued);
    },
  }), [msg.resetMessages, msg.setMessages, msg.messagesRef, msg.triggerScroll, detachFromStream, hydrateSessionRuntimeSnapshot, reconcileServerInterjections]);

  const session = useSession(sessionCallbacks, { initialSessionId: urlState.sessionId });
  const markingReadSessionIdsRef = useRef(new Set<string>());
  const markSessionRead = useCallback((targetSessionId: string | null | undefined) => {
    if (!targetSessionId || markingReadSessionIdsRef.current.has(targetSessionId)) return;
    markingReadSessionIdsRef.current.add(targetSessionId);
    session.updateSessionMeta(targetSessionId, { hasUnreadAiReply: false });
    // 注意：authFetch 走 Authorization header，绝不能给该请求加 include 级 credentials——
    // 分域部署下会触发 credentialed CORS 检查，而 API 侧不返回
    // Access-Control-Allow-Credentials，preflight 直接被浏览器拦截，已读请求永远到不了服务端。
    void authFetch(`/api/sessions/${encodeURIComponent(targetSessionId)}/read`, {
      method: 'PUT',
    }).then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    }).catch((err) => {
      console.warn(`Failed to mark session read ${targetSessionId}:`, err);
      void session.loadSessions();
    }).finally(() => {
      markingReadSessionIdsRef.current.delete(targetSessionId);
    });
  }, [session.updateSessionMeta, session.loadSessions]);
  const sessionRef = useRef(session); sessionRef.current = session;
  const attachmentsHydratedRef = useRef(false);
  const attachmentScopeRef = useRef<string | null>(null);
  const composerScopeInitializedRef = useRef(false);

  // 会话切换时先保存旧草稿，再恢复目标会话的文字和附件。
  useEffect(() => {
    const previousScope = composerScopeRef.current;
    clearTimeout(draftTimerRef.current);
    if (composerScopeInitializedRef.current) {
      saveComposerText(previousScope, inputRef.current);
      if (attachmentsHydratedRef.current && attachmentScopeRef.current === previousScope) {
        void saveComposerAttachments(previousScope, uploadedFilesRef.current);
      }
    } else {
      composerScopeInitializedRef.current = true;
    }

    const nextScope = getComposerDraftScope(user?.id, session.sessionId);
    composerScopeRef.current = nextScope;
    attachmentsHydratedRef.current = false;
    attachmentScopeRef.current = null;
    setInputRaw(loadComposerText(nextScope));
    fileUpload.replaceFiles([]);

    let cancelled = false;
    void loadComposerAttachments(nextScope).then((files) => {
      if (!cancelled && composerScopeRef.current === nextScope) {
        attachmentScopeRef.current = nextScope;
        attachmentsHydratedRef.current = true;
        fileUpload.replaceFiles(files);
      }
    });
    return () => { cancelled = true; };
  }, [session.sessionId, user?.id, fileUpload.replaceFiles]);

  useEffect(() => {
    const scope = composerScopeRef.current;
    if (!attachmentsHydratedRef.current || attachmentScopeRef.current !== scope) return;
    void saveComposerAttachments(scope, fileUpload.uploadedFiles);
  }, [fileUpload.uploadedFiles]);

  const previewFileOwner = useMemo(() => {
    if (explicitPreviewOwner) return explicitPreviewOwner;
    if (!session.sessionId) return undefined;
    return session.sessions.find(s => s.sessionId === session.sessionId)?.owner?.username;
  }, [explicitPreviewOwner, session.sessionId, session.sessions]);
  const sessionOwnerRef = useRef(previewFileOwner); sessionOwnerRef.current = previewFileOwner;

  // ---- sessionParticipants: 监听 sessionOwner 变化，加载对应 Agent Profile ----
  useEffect(() => {
    const owner = session.sessionOwner;
    if (!owner || owner.username === user?.username) {
      setSessionParticipants(null);
      return;
    }
    // 立即设置 owner 信息（头像/名字可用），agent 异步加载后补充
    setSessionParticipants({ owner, agent: null });
    let cancelled = false;
    fetchAgentProfile(owner.username)
      .then(agent => {
        if (!cancelled) setSessionParticipants({ owner, agent });
      })
      .catch(() => {
        // agent 已为 null，无需额外处理
      });
    return () => { cancelled = true; };
  }, [session.sessionOwner, user?.username]);

  sessionIdRef.current = session.sessionId;
  refreshTokenUsageRef.current = session.refreshTokenUsage;
  loadSessionDetailRef.current = session.loadSessionDetail;

  useEffect(() => {
    if (activeTab === 'chat' && session.sessionId && !trashPreviewSessionId) {
      markSessionRead(session.sessionId);
    }
  }, [activeTab, session.sessionId, trashPreviewSessionId, markSessionRead]);

  // 切换会话时清理 SDK 新 state，避免跨会话串扰
  // - notifications 是 user scope（跨会话保留？业务含义说是 REPL 级，切会话应该清）
  // - lastMemoryRecall / pluginInstallStatus 是 session scope，必须清
  useEffect(() => {
    setNotifications([]);
    for (const t of notificationTimersRef.current.values()) clearTimeout(t);
    notificationTimersRef.current.clear();
    setLastMemoryRecall(null);
    setPluginInstallStatus(null);
    clearPluginInstallTimer();
  }, [session.sessionId, clearPluginInstallTimer]);

  const handleModelChange = useCallback((ref: string) => {
    setSelectedModel(ref);
    if (session.sessionId) {
      localStorage.setItem(`agentChat.model.${session.sessionId}`, ref);
    }
  }, [session.sessionId]);

  const setAutoApproveRunShell = useCallback((checked: boolean) => {
    const nextChecked = authorizationModeEnabled ? true : checked;
    setAutoApproveRunShellState(nextChecked);
    const currentSessionId = sessionIdRef.current;
    if (currentSessionId) {
      if (!authorizationModeEnabled) {
        localStorage.setItem(runShellApprovalStorageKey(currentSessionId), nextChecked ? 'true' : 'false');
      }
      const activeRun = activeRunsBySession.current.get(currentSessionId);
      if (activeRun?.runId && isActiveRuntimeStatus(activeRun.status)) {
        void wsClient.ensureConnectedSend({
          action: 'approval_policy',
          sessionId: currentSessionId,
          runId: activeRun.runId,
          approvalPolicy: { autoApproveTools: nextChecked },
        });
      }
    }
  }, [authorizationModeEnabled]);

  useEffect(() => {
    const currentSessionId = sessionIdRef.current;
    const activeRun = currentSessionId ? activeRunsBySession.current.get(currentSessionId) : undefined;
    const sendCurrentRunPolicy = (checked: boolean) => {
      if (!currentSessionId || !activeRun?.runId || !isActiveRuntimeStatus(activeRun.status)) return;
      void wsClient.ensureConnectedSend({
        action: 'approval_policy',
        sessionId: currentSessionId,
        runId: activeRun.runId,
        approvalPolicy: { autoApproveTools: checked },
      });
    };

    if (authorizationModeEnabled) {
      setAutoApproveRunShellState(true);
      sendCurrentRunPolicy(true);
      return;
    }

    setAutoApproveRunShellState(false);
    clearRunShellApprovalStorage();
    sendCurrentRunPolicy(false);
  }, [authorizationModeEnabled]);

  const prevSessionIdForShellApprovalRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const prev = prevSessionIdForShellApprovalRef.current;
    prevSessionIdForShellApprovalRef.current = session.sessionId;
    if (prev === session.sessionId) return;

    if (!session.sessionId) {
      setAutoApproveRunShellState(false);
      return;
    }

    if (authorizationModeEnabled) {
      setAutoApproveRunShellState(true);
      return;
    }

    const stored = localStorage.getItem(runShellApprovalStorageKey(session.sessionId));
    if (stored !== null) {
      setAutoApproveRunShellState(stored === 'true');
      return;
    }

    setAutoApproveRunShellState((current) => {
      const carryNewSessionChoice = prev === null && current;
      if (carryNewSessionChoice) {
        localStorage.setItem(runShellApprovalStorageKey(session.sessionId!), 'true');
      }
      return carryNewSessionChoice;
    });
  }, [authorizationModeEnabled, session.sessionId]);

  // ---- URL 路由同步 ----
  const TAB_LABELS: Partial<Record<AppTab, string>> = {
    cron: '任务中心', files: '文件管理', scenarios: '任务模板', capabilities: '能力中心',
  };
  const setActiveTab = useCallback((tab: AppTab) => {
    setSettingsOpen(false);
    setAdminSettingsRaw(null);
    setActiveTabRaw(tab);
    if (tab === 'platform-admin') {
      const next = governanceRoute('platform.overview.overview');
      setGovernanceRouteRaw(next);
      setPlatformAdminSectionRaw('overview');
      setPlatformAdminEntityIdRaw(null);
      replaceGovernanceUrl(next);
    } else if (tab === 'tenant-admin') {
      const current = governanceRouteRef.current?.area === 'organization' ? governanceRouteRef.current : null;
      const next = current ?? governanceRoute('organization.overview.overview');
      setGovernanceRouteRaw(next);
      replaceGovernanceUrl(next);
    } else {
      setGovernanceRouteRaw(null);
      replaceUrl(tab, tab === 'chat' ? immediateSessionIdRef.current : null);
    }
    // 上报非 chat/profile 的 tab 切换（profile 由 AgentProfile 组件自行上报）
    const label = TAB_LABELS[tab];
    if (label) reportActivity('page_viewed', { detail: label });
  }, []);

  /** push 版本的 setActiveTab：用 pushState 创建历史记录，供 user menu 跳转使用（浏览器后退可回到原页面） */
  const pushActiveTab = useCallback((tab: AppTab) => {
    setSettingsOpen(false);
    setAdminSettingsRaw(null);
    setActiveTabRaw(tab);
    if (tab === 'platform-admin') {
      const next = governanceRoute('platform.overview.overview');
      setGovernanceRouteRaw(next);
      setPlatformAdminSectionRaw('overview');
      setPlatformAdminEntityIdRaw(null);
      pushGovernanceUrl(next);
    } else if (tab === 'tenant-admin') {
      const current = governanceRouteRef.current?.area === 'organization' ? governanceRouteRef.current : null;
      const next = current ?? governanceRoute('organization.overview.overview');
      setGovernanceRouteRaw(next);
      pushGovernanceUrl(next);
    } else {
      setGovernanceRouteRaw(null);
      pushUrl(tab, tab === 'chat' ? immediateSessionIdRef.current : null);
    }
    const label = TAB_LABELS[tab];
    if (label) reportActivity('page_viewed', { detail: label });
  }, []);

  const setPlatformAdminRoute = useCallback((section: PlatformAdminSection, entityId: string | null = null) => {
    setSettingsOpen(false);
    setAdminSettingsRaw(null);
    setActiveTabRaw('platform-admin');
    setPlatformAdminSectionRaw(section);
    setPlatformAdminEntityIdRaw(entityId);
    // 改造前这里丢弃整串 query：从 sessions 筛了某组织再点侧栏「执行记录」，组织筛选没了。
    // 现在按白名单透传作用域筛选（tenantId / userId）——section 私有筛选（kind/phase/cursor…）
    // 跨 section 无意义，仍然丢弃。
    pushPlatformAdminUrl({ section, entityId, search: preserveScopeSearch() });
  }, []);

  /** 切换组织分析页签：进路径 + push 历史（后退回上一个页签，而不是退出整个组织分析） */
  const setTenantAdminRoute = useCallback((section: string) => {
    const next = normalizeTenantAdminSection(section);
    setSettingsOpen(false);
    setAdminSettingsRaw(null);
    setActiveTabRaw('tenant-admin');
    setTenantAdminSectionRaw(next);
    // 切页签丢弃页内私有筛选，但带着组织作用域走
    pushTenantAdminUrl({ section: next, search: preserveSearchKeys(TENANT_ADMIN_SCOPE_KEYS) });
  }, []);

  const { openSettings, closeSettings, setSettingsSection } = usePersonalSettingsNavigation({
    getActiveTab: () => activeTabRef.current,
    getPlatformRoute: () => platformAdminRouteRef.current,
    getTenantSection: () => tenantAdminSectionRef.current,
    getSessionId: () => immediateSessionIdRef.current,
    openState: (section, route) => {
      setAdminSettingsRaw(null); setGovernanceRouteRaw(route); setSettingsOpen(true); setSettingsSectionRaw(section);
    },
    closeState: () => { setSettingsOpen(false); setGovernanceRouteRaw(null); },
  });

  const openAdminSettings = useCallback((target: AdminSettingsTarget, section?: string) => {
    // user settings modal 互斥关闭；不要切 activeTab，避免关闭管理弹窗后把用户留在组织/平台分析页。
    setSettingsOpen(false);
    const sec = normalizeAdminSettingsSection(target, section);
    setAdminSettingsRaw({ target, section: sec });
    pushAdminSettingsUrl(target, sec);
  }, []);

  const closeAdminSettings = useCallback(() => {
    const current = adminSettingsRef.current;
    if (!current) return;
    setAdminSettingsRaw(null);
    // 从任意页面打开管理弹窗时，关闭后回到打开前的 activeTab/session；
    // 若用户是直接访问 /tenant-admin/settings 或 /platform-admin/settings，activeTab 本身就是 admin 页。
    const tab = activeTabRef.current;
    if (tab === 'platform-admin') {
      pushPlatformAdminUrl(platformAdminRouteRef.current);
    } else if (tab === 'tenant-admin') {
      pushTenantAdminUrl({ section: tenantAdminSectionRef.current, search: preserveSearchKeys(TENANT_ADMIN_SCOPE_KEYS) });
    } else {
      pushUrl(tab, tab === 'chat' ? immediateSessionIdRef.current : null);
    }
  }, []);

  const setAdminSettingsSection = useCallback((section: string) => {
    const current = adminSettingsRef.current;
    if (!current) return;
    const sec = normalizeAdminSettingsSection(current.target, section);
    setAdminSettingsRaw({ target: current.target, section: sec });
    pushAdminSettingsUrl(current.target, sec);
  }, []);

  // ---- 企业专家草稿态（2026-07 唯恩批次）----
  // ref：sendChatViaWs 首条消息（无 sessionId）时带上 orgAgentId，收到 'session' 事件
  //（会话真实建立、服务端已写 meta）后清除——ACK 只代表入队，rejected 后重发仍要带上
  //（2026-07 审查 F9）；
  // state：新会话空白态的顶部 banner 展示（会话入列表带 orgAgentId 后由列表接管）。
  const pendingOrgAgentIdRef = useRef<string | null>(null);
  const [pendingOrgAgentId, setPendingOrgAgentId] = useState<string | null>(null);
  const authOwnerKey = user ? `${user.tenantId}:${user.id}` : "anonymous";
  const clearPendingOrgAgent = useCallback(() => {
    pendingOrgAgentIdRef.current = null;
    setPendingOrgAgentId(null);
  }, []);

  const selectSessionWithUrl = useCallback((id: string) => {
    setTrashPreviewSessionId(null); // 选择正常会话时退出回收站预览
    clearPendingOrgAgent(); // 切换既有会话 = 放弃挂起的专职 Agent 新会话
    pendingNewSessionClientMsgIdRef.current = null;
    markSessionRead(id);
    immediateSessionIdRef.current = id;
    // 与 immediateSessionIdRef 同帧同语义：wsLatestSessionIdRef 原先只写不清，会长期
    // 指向上一个发过消息的会话，让终态守卫的回退值失效（2026-08-01 串会话路径）。
    wsLatestSessionIdRef.current = { value: id };
    session.selectSession(id);
    pushUrl('chat', id);
  }, [clearPendingOrgAgent, markSessionRead, session.selectSession]);

  const newSessionWithUrl = useCallback(() => {
    setTrashPreviewSessionId(null);
    clearPendingOrgAgent(); // 普通新会话 = 个人 Agent 路径
    pendingNewSessionClientMsgIdRef.current = null;
    immediateSessionIdRef.current = null;
    wsLatestSessionIdRef.current = { value: null };
    session.newSession();
    pushUrl('chat', null);
  }, [clearPendingOrgAgent, session.newSession]);

  /**
   * 企业专家新草稿：只切换前端会话目标，不制造 meta-only 空会话。
   * 首条消息沿用下方 sendChatViaWs 的 orgAgentId payload，由服务端一次性创建并绑定。
   */
  const startOrgAgentSession = useCallback((agentId: string): void => {
    const normalizedAgentId = agentId.trim();
    if (!normalizedAgentId || !user || loadingRef.current) return;
    setTrashPreviewSessionId(null);
    immediateSessionIdRef.current = null;
    wsLatestSessionIdRef.current = { value: null };
    session.newSession();
    pendingNewSessionClientMsgIdRef.current = null;
    pendingOrgAgentIdRef.current = normalizedAgentId;
    setPendingOrgAgentId(normalizedAgentId);
    pushUrl('chat', null);
    if (activeTabRef.current !== 'chat') setActiveTab('chat');
  }, [session.newSession, setActiveTab, user]);

  useEffect(() => {
    clearPendingOrgAgent();
  }, [authOwnerKey, clearPendingOrgAgent]);

  const previewTrashSession = useCallback(async (id: string | null) => {
    if (id) {
      msg.resetMessages();
      setTrashPreviewSessionId(id);
      try {
        const res = await authFetch(`/api/sessions/${encodeURIComponent(id)}?includeDeleted=1`);
        if (res.ok) {
          const data: ApiSessionDetail = await res.json();
          const sessionOwnerName = data.owner?.username;
          const msgs = mapSessionDetailToMessages(data, sessionOwnerName);
          msg.setMessages(msgs, { scrollToBottom: false });

          // 设置 sessionParticipants 供 MessageList 使用
          if (data.owner && data.owner.username !== user?.username) {
            try {
              const agent = await fetchAgentProfile(data.owner.username);
              setSessionParticipants({ owner: data.owner, agent });
            } catch {
              setSessionParticipants({ owner: data.owner, agent: null });
            }
          } else {
            setSessionParticipants(null);
          }
        }
      } catch (err) {
        console.error("加载回收站会话失败:", err);
      }
    } else {
      setTrashPreviewSessionId(null);
      setSessionParticipants(null);
      msg.resetMessages();
      if (session.sessionId) {
        void session.loadSessionDetail(session.sessionId);
      }
    }
  }, [msg, session.sessionId, session.loadSessionDetail, user?.username]);

  // Popstate refs（保持最新引用避免 effect 重注册）
  const selectSessionRawRef = useRef(session.selectSession);
  selectSessionRawRef.current = session.selectSession;
  const newSessionRawRef = useRef(session.newSession);
  newSessionRawRef.current = session.newSession;

  // 浏览器前进/后退 → 解析 URL → 更新状态（不操作 URL）
  useEffect(() => {
    const handler = () => {
      // update-on-navigation：popstate 时 URL 已变，有 pending SW 更新且无守门
      // 条件直接原地 reload 到新版本，跳过本次 SPA 状态同步
      if (maybeReloadOnPopstate()) return;
      const {
        tab,
        sessionId: urlSessionId,
        settingsSection: urlSettingsSection,
        adminSection: urlAdminSection,
        adminEntityId: urlAdminEntityId,
        tenantAdminSection: urlTenantAdminSection,
        adminSettings: urlAdminSettings,
        governanceRoute: urlGovernanceRoute,
        canonicalPath,
      } = parseUrl();
      setGovernanceRouteRaw(urlGovernanceRoute);
      setPendingCanonicalPath(canonicalPath);
      if (urlAdminSettings) {
        // admin settings modal 路径：activeTab 同步到 admin frame，modal 打开到对应 section
        setSettingsOpen(false);
        setActiveTabRaw(tab);
        setAdminSettingsRaw(urlAdminSettings);
        return;
      }
      if (urlSettingsSection) {
        setAdminSettingsRaw(null);
        setSettingsOpen(true);
        setSettingsSectionRaw(urlSettingsSection);
        return;
      }
      setSettingsOpen(false);
      setAdminSettingsRaw(null);
      if (tab === 'platform-admin') {
        setPlatformAdminSectionRaw(urlAdminSection ?? 'overview');
        setPlatformAdminEntityIdRaw(urlAdminEntityId);
      }
      if (tab === 'tenant-admin' && urlTenantAdminSection) {
        setTenantAdminSectionRaw(urlTenantAdminSection);
      }
      immediateSessionIdRef.current = urlSessionId;
      setActiveTabRaw(tab);
      if (tab === 'chat') {
        if (urlSessionId && urlSessionId !== sessionIdRef.current) {
          markSessionRead(urlSessionId);
          selectSessionRawRef.current(urlSessionId);
        } else if (!urlSessionId && sessionIdRef.current) {
          newSessionRawRef.current();
        }
      }
    };
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, [markSessionRead]);

  // 兜底：确保 URL 始终与 state 一致（覆盖 delete fallback 等间接变更）
  useEffect(() => {
    if (pendingCanonicalPath) {
      const current = `${window.location.pathname}${window.location.search}`;
      if (current !== pendingCanonicalPath) {
        window.history.replaceState({}, '', pendingCanonicalPath);
      }
      setPendingCanonicalPath(null);
      return;
    }
    const expectedUrl = buildUrl(
      activeTab,
      activeTab === 'chat' ? session.sessionId : null,
    );
    if (governanceRouteState) {
      const governanceUrl = buildGovernanceUrl(governanceRouteState);
      if (governanceUrl !== `${window.location.pathname}${window.location.search}`) {
        replaceGovernanceUrl(governanceRouteState);
      }
      return;
    }
    if (adminSettings) {
      const adminUrl = buildAdminSettingsUrl(adminSettings.target, adminSettings.section);
      if (adminUrl !== window.location.pathname) {
        replaceAdminSettingsUrl(adminSettings.target, adminSettings.section);
      }
      return;
    }
    if (settingsOpen) {
      const settingsUrl = buildSettingsUrl(settingsSection);
      if (settingsUrl !== window.location.pathname) {
        replaceSettingsUrl(settingsSection);
      }
      return;
    }
    if (activeTab === 'platform-admin') {
      const expectedPath = buildPlatformAdminUrl({
        section: platformAdminSection,
        entityId: platformAdminEntityId,
      });
      if (expectedPath !== window.location.pathname) {
        replacePlatformAdminUrl({
          section: platformAdminSection,
          entityId: platformAdminEntityId,
          search: window.location.search,
        });
      }
      return;
    }
    if (activeTab === 'tenant-admin') {
      // 与 platform-admin 完全对称：路径带页签，search（筛选）原样保留
      const expectedPath = buildTenantAdminUrl({ section: tenantAdminSection });
      if (expectedPath !== window.location.pathname) {
        replaceTenantAdminUrl({ section: tenantAdminSection, search: window.location.search });
      }
      return;
    }
    if (expectedUrl !== window.location.pathname) {
      immediateSessionIdRef.current = session.sessionId;
      replaceUrl(activeTab, activeTab === 'chat' ? session.sessionId : null);
    }
  }, [session.sessionId, activeTab, settingsOpen, settingsSection, adminSettings, governanceRouteState, platformAdminSection, platformAdminEntityId, tenantAdminSection, pendingCanonicalPath]);

  // ---- Loading watchdog：超时保护，防止 done 事件丢失时 loading 永久锁定 ----
  const watchdogTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastStreamEventAtRef = useRef(0);

  const clearWatchdog = useCallback(() => {
    if (watchdogTimerRef.current) { clearTimeout(watchdogTimerRef.current); watchdogTimerRef.current = null; }
    lastStreamEventAtRef.current = 0;
  }, []);

  const resetWatchdog = useCallback(() => {
    if (watchdogTimerRef.current) clearTimeout(watchdogTimerRef.current);
    if (!loadingRef.current) return;
    const timeout = lastStreamEventAtRef.current > 0 ? 45_000 : 60_000;
    watchdogTimerRef.current = setTimeout(async () => {
      watchdogTimerRef.current = null;
      if (!loadingRef.current) return;
      const sid = sessionIdRef.current;
      if (sid) {
        try {
          const res = await authFetch(`/api/sessions/${sid}/stream-status`);
          if (res.ok) {
            const { active } = await res.json() as { active: boolean };
            if (active) { resetWatchdog(); return; } // Agent 还活着
          }
        } catch { /* proceed with recovery */ }
      }
      // 超时恢复
      finalizeStreamingMessages(msgRef.current);
      finalizeRunningSubagents(msgRef.current);
      wsAttachedRef.current = false;
      setLoading(false);
      setStopping(false);
      dispatchConnection('complete');
      sessionRef.current.refreshCurrentSession();
    }, timeout);
  }, [dispatchConnection]);

  const finalizeTerminalRuntime = useCallback((args: {
    sessionId: string;
    status: TerminalRuntimeStatus;
    runId?: string;
    streamId?: string;
    reason?: string;
    refresh?: boolean;
  }) => {
    patchSessionRuntime(args.sessionId, {
      status: args.status,
      streamId: null,
      runId: null,
      lastEventId: null,
      attached: false,
    });

    if (args.sessionId !== immediateSessionIdRef.current) return;

    clearWatchdog();
    finalizeStreamingMessages(msgRef.current);
    finalizeRunningSubagents(msgRef.current);

    let alertContent: string | null = null;
    let severity: 'error' | 'cancelled' | 'billing' = 'error';
    if (args.status === 'failed' || args.status === 'orphaned') {
      alertContent = formatRuntimeFailureMessage(args.reason);
      if (isInsufficientCreditsFailure(args.reason)) severity = 'billing';
    } else if (args.status === 'cancelled') {
      alertContent = '会话已停止';
      severity = 'cancelled';
    }
    if (alertContent) {
      const msgs = msgRef.current.messagesRef.current;
      const last = msgs[msgs.length - 1];
      if (!(last?.type === 'system-error' && last.content === alertContent)) {
        msgRef.current.addMessage({ type: 'system-error', content: alertContent, severity, timestamp: Date.now() });
      }
    }

    wsAttachedRef.current = false;
    streamIdRef.current = null;
    runIdRef.current = null;
    lastEventIdRef.current = null;
    setLoading(false);
    setStopping(false);
    sessionRef.current.setContextUsage(null);

    // 2026-08-04 终态设计：不再有本地 'queued' 条目需要 flush（运行中发送直发服务端
    // steering）；终态时清空 outbox 与全部 ACK 定时器即可。
    for (const entry of outboxRef.current) {
      const timer = ackTimersRef.current.get(entry.clientMsgId);
      if (timer) {
        clearTimeout(timer);
        ackTimersRef.current.delete(entry.clientMsgId);
      }
    }
    outboxRef.current = [];

    dispatchConnection('complete');
    if (args.refresh !== false) {
      sessionRef.current.refreshCurrentSession();
    }
  }, [clearWatchdog, dispatchConnection, patchSessionRuntime]);

  const reconcileLastRunState = useCallback(async (sessionId: string, lastRunState: LastRunState) => {
    if (!isTerminalRuntimeStatus(lastRunState.status)) return;
    patchSessionRuntime(sessionId, {
      status: lastRunState.status,
      ...(lastRunState.runId ? { runId: lastRunState.runId } : {}),
      attached: false,
    });
    if (sessionId !== immediateSessionIdRef.current) return;

    try {
      const res = await authFetch(`/api/sessions/${sessionId}/stream-status`);
      if (!res.ok) return;
      const { active } = await res.json() as { active: boolean };
      if (active) return;
    } catch {
      return;
    }

    finalizeTerminalRuntime({
      sessionId,
      status: lastRunState.status,
      runId: lastRunState.runId,
      reason: lastRunState.error,
      refresh: false,
    });
  }, [finalizeTerminalRuntime, patchSessionRuntime]);

  reconcileLastRunStateRef.current = (sessionId, lastRunState) => {
    void reconcileLastRunState(sessionId, lastRunState);
  };

  // ---- Sync 序列号（用于断线重连恢复元数据事件）----
  const lastUserSeqRef = useRef(0);

  // ---- WS 连接管理 ----
  useEffect(() => {
    // 建立 WS 连接
    wsClient.connect().catch(() => { });

    // WS 状态同步到 connectionState
    const unsubState = wsClient.onStateChange((state) => {
      switch (state) {
        case 'connected':
          dispatchConnection('connect');
          // WS 连接成功时，如果 modelList 仍为空则重新获取
          if (!modelListRef.current) fetchModelList();

          // 发送 sync 请求恢复漏掉的元数据事件
          wsClient.send({ action: 'sync', lastSeq: lastUserSeqRef.current });

          // WS 重连时自动恢复活跃流
          if (loadingRef.current && sessionIdRef.current) {
            const targetSid = sessionIdRef.current;

            // 重连前清理断线遗留的半截消息
            wsBlockRef.current = { currentBlockIndex: -1, currentBlockType: null };
            const msgs = msgRef.current.messagesRef.current;
            const cleaned = msgs.filter(m => !('streaming' in m && m.streaming));
            if (cleaned.length !== msgs.length) {
              msgRef.current.setMessages(cleaned, { scrollToBottom: false });
            }

            // 2026-08-04 P1：只有持有增量游标（buffer eventId 或 durable cursor）才请求
            // replay；两者皆无时 replay 语义退化为「从头全量重放」，会把 transcript 快照
            // 已展示的内容整段叠加一遍（实证 fc3bf95a）。无游标改走 refreshCurrentSession
            // 补断线期间内容（transcript 投影是实时的）。
            const hasReplayCursor = lastEventIdRef.current !== null
              || Boolean(lastEventCursorRef.current);
            const handleReconnectStream = (envelope: WsEnvelope) => {
              const d = envelope.data as WsEvent;
              if (d.type !== 'active_stream') return;
              if (d.sessionId !== targetSid) return;
              unsubReconnect();
              if (!d.active) {
                wsAttachedRef.current = false;
                setLoading(false);
                sessionRef.current.refreshCurrentSession();
              } else {
                if (d.streamId) streamIdRef.current = d.streamId;
                wsAttachedRef.current = true;
                if (!hasReplayCursor) {
                  // 跳过了 replay：用 transcript 刷新补齐断线期间的增量
                  sessionRef.current.refreshCurrentSession();
                }
              }
            };
            const unsubReconnect = wsClient.onMessage(handleReconnectStream);
            sendResumeDeduped({
              action: 'resume',
              sessionId: targetSid,
              lastEventId: lastEventIdRef.current ?? 0,
              lastEventCursor: lastEventCursorRef.current,
              skipReplay: !hasReplayCursor,
            }).then(ok => {
              if (!ok) unsubReconnect();
            });
            setTimeout(() => unsubReconnect(), 30000);
          } else {
            // 非活跃状态断线重连：sync 协议会恢复元数据，仅刷新当前会话内容
            if (sessionIdRef.current) {
              sessionRef.current.refreshCurrentSession();
            }
          }
          break;
        case 'reconnecting':
          if (loadingRef.current) {
            dispatchConnection('drop');
          }
          break;
        case 'disconnected':
          if (loadingRef.current) {
            dispatchConnection('reconnect_fail');
          }
          break;
      }
    });

    return () => {
      unsubState();
      wsClient.disconnect();
    };
  }, [dispatchConnection]);

  // ---- WS 消息处理 ----
  useEffect(() => {
    const unsub = wsClient.onMessage((envelope: WsEnvelope) => {
      const data = envelope.data as WsEvent;
      if (!data || !data.type) return;

      // 追踪 eventId / cursor。元数据事件可能属于后台会话，不能写进当前 UI 会话；
      // 无 sessionId 的流事件则归属当前已 attach 的会话。
      const eventSessionId = 'sessionId' in data && typeof data.sessionId === 'string'
        ? data.sessionId
        : wsLatestSessionIdRef.current.value ?? sessionIdRef.current;
      if (envelope.eventId != null && eventSessionId) {
        const existing = activeRunsBySession.current.get(eventSessionId);
        activeRunsBySession.current.set(eventSessionId, {
          ...(existing ?? { status: 'idle' as const, attached: false }),
          lastEventId: envelope.eventId,
        });
        if (eventSessionId === sessionIdRef.current) {
          lastEventIdRef.current = envelope.eventId;
        }
      }
      if (envelope.eventCursor && eventSessionId) {
        const existing = activeRunsBySession.current.get(eventSessionId);
        activeRunsBySession.current.set(eventSessionId, {
          ...(existing ?? { status: 'idle' as const, attached: false }),
          lastEventCursor: envelope.eventCursor,
        });
        if (eventSessionId === sessionIdRef.current) {
          lastEventCursorRef.current = envelope.eventCursor;
        }
      }

      // 忽略控制消息
      if (data.type === 'respond_ok' || data.type === 'respond_error') {
        return;
      }

      if (data.type === 'session' && data.client_msg_id && newSessionClientMsgIdsRef.current.has(data.client_msg_id)) {
        const expectedClientMsgId = pendingNewSessionClientMsgIdRef.current;
        newSessionClientMsgIdsRef.current.delete(data.client_msg_id);
        if (expectedClientMsgId !== data.client_msg_id) {
          console.warn(`[chat] ignored stale session event for ${data.client_msg_id}`);
          return;
        }
      }
      if (data.type === 'abort_ok') {
        if ((data.runId && data.runId === runIdRef.current) || (data.streamId && data.streamId === streamIdRef.current)) {
          setStopping(true);
        }
        return;
      }

      // active_stream（服务端权威信号：该会话当前是否有 active run）
      // 进入 reducer 而非被吞掉：总是更新 Map（per-session 持久态）;
      // 若是当前会话,sync 到 ref + UI（loading/停止按钮）。
      // 这是 2026-06-25 切会话架构改造的关键修复：原实现 `return` 让全局信号
      // 被静默丢弃,只有 subscribeToActiveStream 内 oneshot 临时 handler 才接住,
      // 而该临时 handler 在 HTTP inactive 早 return 时根本没注册。
      if (data.type === 'active_stream') {
        const a = data as Extract<WsEvent, { type: 'active_stream' }>;
        patchSessionRuntime(
          a.sessionId,
          a.active
            ? {
                status: 'running',
                ...(a.streamId ? { streamId: a.streamId } : {}),
                ...(a.runId ? { runId: a.runId } : {}),
                attached: true,
              }
            : {
                status: 'idle',
                streamId: null,
                runId: null,
                attached: false,
              },
        );
        // 仅在 sessionId === 当前选中 时改 UI;其他会话只持久化状态(切回时再恢复 UI)
        if (a.sessionId === sessionIdRef.current) {
          if (a.active) {
            upsertRuntimeStatusMessage(msgRef.current, runtimeStatusFromSessionStatus(a.status || 'running') ?? 'running', {
              ...(a.streamId ? { streamId: a.streamId } : {}),
              ...(a.runId ? { runId: a.runId } : {}),
            });
            if (!loadingRef.current) {
              setLoading(true);
              dispatchConnection('connect');
            }
          } else if (loadingRef.current) {
            // 服务端权威说没在跑了 → 清 loading（用户切回后不应再显示停止按钮）
            setLoading(false);
            setStopping(false);
            dispatchConnection('complete');
            sessionRef.current.refreshCurrentSession();
          } else {
            sessionRef.current.refreshCurrentSession();
          }
        }
        return;
      }

      // ── sync 协议响应 ──
      if (data.type === 'sync_ok') {
        lastUserSeqRef.current = (data as any).seq;
        wsClient.setLastSeq((data as any).seq);
        for (const { event } of (data as any).events || []) {
          const e = event as WsEvent;
          if (e.type === 'title_updated') sessionRef.current.updateSessionTitle(e.sessionId, e.title);
          else if (e.type === 'session_updated') {
            if ((e as any).isNew && sessionRef.current.upsertSession) {
              sessionRef.current.upsertSession({ sessionId: e.sessionId, preview: e.preview, updatedAtMs: e.updatedAtMs, title: (e as any).title, model: (e as any).model, username: (e as any).username });
            } else {
              sessionRef.current.updateSessionMeta(e.sessionId, {
                preview: e.preview,
                updatedAtMs: e.updatedAtMs,
                ...((e as any).title !== undefined ? { title: (e as any).title } : {}),
              });
            }
          }
          else if (e.type === 'session_deleted') sessionRef.current.removeSession(e.sessionId);
          // SDK 0.2.112+ REPL 通知（user scope 事件也会进 UserEventLog，断线重连必须回放）
          else if (e.type === 'notification') {
            pushNotification((e as { notification: NotificationData }).notification);
          }
        }
        return;
      }
      if (data.type === 'sync_overflow') {
        lastUserSeqRef.current = (data as any).seq;
        wsClient.setLastSeq((data as any).seq);
        void sessionRef.current.loadSessions({ fresh: true });
        return;
      }

      if (
        data.type === 'session_read_state_changed'
        && data.hasUnreadAiReply
        && activeTabRef.current === 'chat'
        && !trashPreviewSessionIdRef.current
        && immediateSessionIdRef.current === data.sessionId
      ) {
        // 当前正在查看的会话不应显示未读。这里必须直接消费事件：若继续交给
        // processWsEvent，它会在 markSessionRead 的乐观更新之后又把红点写回 true；
        // 服务端状态已是 read 时不会再广播 false，红点就会一直残留。
        markSessionRead(data.sessionId);
        return;
      }

      // ── session_status（Agent/run 生命周期）──
      // 架构改造（2026-06-25）：摘掉"d.sessionId === sessionIdRef.current"守卫,
      // 总是更新 activeRunsBySession Map（per-session 持久态）。后台会话的状态变更
      // 仍能反映在 Map 里,切回时直接派生 UI,不再丢状态。
      //
      // PR #26 的 750ms + HTTP 二次确认 + system-error banner 注入仍保留,
      // 但仅对当前选中会话生效（banner UI 是会话级独立 alert）。
      if (data.type === 'session_status') {
        const d = data as Extract<WsEvent, { type: 'session_status' }>;

        // ① 总是更新 Map（per-session 持久态,不论是否当前会话）
        patchSessionRuntime(d.sessionId, {
          status: d.status,
          ...(d.streamId ? { streamId: d.streamId } : {}),
          ...(d.runId ? { runId: d.runId } : {}),
          attached: isActiveRuntimeStatus(d.status),
        });

        // ② tracking 集合仅用于关联运行态；未读状态由服务端事件同步。
        if (isActiveRuntimeStatus(d.status)) {
          trackedAiReplyStreamsRef.current.add(d.sessionId);
        } else if (isTerminalRuntimeStatus(d.status)) {
          trackedAiReplyStreamsRef.current.delete(d.sessionId);
        }

        // ③ 仅当事件属于当前选中会话,才动 UI（loading/banner/outbox）
        if (isActiveRuntimeStatus(d.status) && d.sessionId === sessionIdRef.current) {
          if (d.streamId) streamIdRef.current = d.streamId;
          if (d.runId) runIdRef.current = d.runId;
          wsAttachedRef.current = true;
          const visibleStatus = runtimeStatusFromSessionStatus(d.status);
          if (visibleStatus) {
            upsertRuntimeStatusMessage(msgRef.current, visibleStatus, {
              ...(d.streamId ? { streamId: d.streamId } : {}),
              ...(d.runId ? { runId: d.runId } : {}),
            });
          }
          if (!loadingRef.current) {
            setLoading(true);
            dispatchConnection('connect');
          }
          resetWatchdog();
        }

        if (isTerminalRuntimeStatus(d.status) && d.sessionId === sessionIdRef.current && loadingRef.current) {
          const terminalStatus = d.status;
          const statusRunId = d.runId;
          const statusStreamId = d.streamId;
          setTimeout(() => {
            if (!loadingRef.current || sessionIdRef.current !== d.sessionId) return;
            void (async () => {
              const idMismatched = Boolean(
                (statusRunId && runIdRef.current && statusRunId !== runIdRef.current)
                || (statusStreamId && streamIdRef.current && statusStreamId !== streamIdRef.current),
              );
              let active: boolean | null = null;
              try {
                const res = await authFetch(`/api/sessions/${d.sessionId}/stream-status`);
                if (res.ok) {
                  const json = await res.json() as { active: boolean };
                  active = json.active;
                  if (active) return;
                }
              } catch { /* fall through: session_status remains the fallback */ }
              if (idMismatched && active !== false) return;
              if (!loadingRef.current || sessionIdRef.current !== d.sessionId) return;
              finalizeTerminalRuntime({
                sessionId: d.sessionId,
                status: terminalStatus,
                ...(statusRunId ? { runId: statusRunId } : {}),
                ...(statusStreamId ? { streamId: statusStreamId } : {}),
                ...(d.reason ? { reason: d.reason } : {}),
              });
            })();
          }, 750);
        }
        return;
      }

      // ── groups_changed（由 useGroups WS 监听器处理）──
      if (data.type === 'groups_changed') return;

      // ── SDK 0.2.112+ 新事件（直接 setState，不走 processWsEvent）──
      if (data.type === 'context_usage') {
        sessionRef.current.setContextUsage((data as any).contextUsage);
        return;
      }
      if (data.type === 'notification') {
        pushNotification((data as { notification: NotificationData }).notification);
        return;
      }
      if (data.type === 'memory_recall') {
        setLastMemoryRecall((data as { memoryRecall: MemoryRecallData }).memoryRecall);
        return;
      }
      if (data.type === 'plugin_install') {
        const d = (data as { pluginInstall: PluginInstallData }).pluginInstall;
        setPluginInstallStatus(d);
        // 每次状态更新都清掉旧 timer，避免旧 timer 误清新状态（切会话或快速连续推送时）
        clearPluginInstallTimer();
        if (d.status === 'completed' || d.status === 'installed' || d.status === 'failed') {
          pluginInstallTimerRef.current = setTimeout(() => {
            setPluginInstallStatus((cur) => (cur && cur.status === d.status && cur.name === d.name ? null : cur));
            pluginInstallTimerRef.current = null;
          }, 5000);
        }
        return;
      }

      // 其他设备发起的流：自动订阅（多设备实时同步）
      if (data.type === 'stream_started') {
        trackedAiReplyStreamsRef.current.add(data.sessionId);
        // 总是更新 Map（per-session 持久态）,即使不是当前会话
        patchSessionRuntime(data.sessionId, {
          status: 'running',
          streamId: data.streamId,
          ...(data.runId ? { runId: data.runId } : {}),
          attached: false, // 当前 ws 尚未真正订阅这条流
        });
        const currentSid = immediateSessionIdRef.current;
        if (data.sessionId === currentSid && !loadingRef.current) {
          streamIdRef.current = data.streamId;
          if (data.runId) runIdRef.current = data.runId;
          wsLatestSessionIdRef.current = { value: data.sessionId };
          wsBlockRef.current = { currentBlockIndex: -1, currentBlockType: null };
          wsUserMsgIndexRef.current = -1;
          lastEventIdRef.current = null;
          wsAttachedRef.current = true;
          setLoading(true);
          dispatchConnection('connect');
          void wsClient.ensureConnectedSend({
            action: 'resume',
            sessionId: data.sessionId,
            lastEventId: 0,
            lastEventCursor: lastEventCursorRef.current,
            skipReplay: false,
          });
        }
        // 先本地占位，再刷新服务端真值；避免 enqueue-only 会话尚未投影 .jsonl 时被 fresh 覆盖抹掉。
        sessionRef.current.upsertSession({
          sessionId: data.sessionId,
          updatedAtMs: Date.now(),
        });
        void sessionRef.current.loadSessions({ fresh: true });
        return;
      }

      // 防串流守卫：未挂载到流时，只放行会话元数据事件，过滤所有流式内容事件
      if (!wsAttachedRef.current) {
        // stream_id 必须放行：插话回退为独立 run 时，目标 run 的 done 已把 attached 清掉，
        // 服务端补发的接管 stream_id 若被挡在这里，整条回退流的内容与 done 都会丢失。
        // 串会话风险由 processWsEvent 内的 sessionId 校验兜底。
        const isMetadata = data.type === 'title_updated' || data.type === 'session_updated'
          || data.type === 'session_deleted' || data.type === 'interaction_resolved'
          || data.type === 'pending_interactions' || data.type === 'voice_transcribed'
          || data.type === 'stream_id'
          // 插话队列区事件（2026-08-04 P2-13 修复）：均为元数据语义，被守卫吞掉会
          // 造成永久「已排队」+ outbox 泄漏锁死 SW 更新；串会话由 processWsEvent
          // 内的 sessionId 校验兜底。
          || data.type === 'interjection_applied' || data.type === 'steering_queued'
          || data.type === 'steering_cancelled' || data.type === 'cancel_queued_result'
          || data.type === 'user_message';
        if (!isMetadata) return;
      }

      // 流式事件到达 → 重置 loading watchdog
      if (wsAttachedRef.current && data.type !== 'title_updated' && data.type !== 'session_updated'
        && data.type !== 'session_deleted' && data.type !== 'interaction_resolved'
        && data.type !== 'pending_interactions') {
        lastStreamEventAtRef.current = Date.now();
        resetWatchdog();
      }

      // ── 上下文压缩黑箱化（2026-07）：compaction_status 专用事件，不进 processWsEvent ──
      // started → 消息流插入「正在压缩上下文…」状态条（先清掉 sending/running 等 runtime 状态行）；
      // completed → 状态条就地落定为分界线（skipped 走轻提示 toast，不入消息流——
      //   done 后的 refreshCurrentSession 会立即用 transcript 重建消息，流内临时项会被抹掉）。
      // 幂等（断线重连 / 切会话回来 replay）：running 条最多一条；completed 重放时
      //   若已有等值分界线则跳过。loading 解除仍由后续 done 事件的既有路径处理。
      // 撤回排队插话的请求响应（2026-08-04 终态设计）：解锁等待中的 cancelQueuedInterjection
      if (data.type === 'cancel_queued_result') {
        const waiter = cancelWaitersRef.current.get(data.sourceRunId);
        if (waiter) {
          cancelWaitersRef.current.delete(data.sourceRunId);
          waiter(data.ok);
        }
        return;
      }

      if ((data as { type?: string }).type === 'compaction_status') {
        const evt = data as unknown as CompactionStatusEvent;
        const currentMsgs = msgRef.current.messagesRef.current;
        let runningIdx = -1;
        for (let i = currentMsgs.length - 1; i >= 0; i--) {
          if (asCompactionItem(currentMsgs[i])?.status === 'running') {
            runningIdx = i;
            break;
          }
        }

        if (evt.phase === 'started') {
          if (runningIdx < 0) {
            removeRuntimeStatusMessages(msgRef.current);
            msgRef.current.addMessage(createCompactionRunningItem());
            msgRef.current.triggerScroll();
          }
          return;
        }

        // phase === 'completed'
        const outcome = evt.compaction;
        if (outcome?.skipped) {
          // 历史太短未压缩：撤掉状态条 + 轻提示（timeoutMs 后自动消失）
          if (runningIdx >= 0) {
            msgRef.current.setMessages(
              currentMsgs.filter((_, i) => i !== runningIdx),
              { scrollToBottom: false },
            );
          }
          pushNotification({
            key: 'compaction_skipped',
            text: outcome.note || '当前会话历史很短，无需压缩',
            priority: 'medium',
            timeoutMs: 8000,
          });
          return;
        }

        // replay 幂等：消息流中已有等值 done 分界线（如切会话回来时 transcript 已含
        // compaction block，事件 buffer 又重放同一次 started+completed）则不再新增/转换，
        // 只撤掉多余的 running 状态条，保证同一次压缩只有一条分界线。
        let lastDone: CompactionMessageItem | null = null;
        for (let i = currentMsgs.length - 1; i >= 0; i--) {
          const comp = asCompactionItem(currentMsgs[i]);
          if (comp?.status === 'done') {
            lastDone = comp;
            break;
          }
        }
        const isDupe = !!lastDone
          && lastDone.summary === outcome?.summary
          && lastDone.coveredEventCount === outcome?.coveredEventCount;
        if (isDupe) {
          if (runningIdx >= 0) {
            msgRef.current.setMessages(
              currentMsgs.filter((_, i) => i !== runningIdx),
              { scrollToBottom: false },
            );
          }
          return;
        }

        if (runningIdx >= 0) {
          msgRef.current.updateMessageAt(runningIdx, (m) => compactionDoneReplacement(m.id, outcome));
        } else {
          msgRef.current.addMessage(createCompactionDoneItem(outcome));
          msgRef.current.triggerScroll();
        }
        return;
      }

      // 构建处理上下文
      const ctx: WsProcessingContext = {
        msg: msgRef.current,
        session: sessionRef.current,
        selectedModelRef,
        voiceCallbackRef,
        streamIdRef,
        runIdRef,
        handledTerminalKeysRef,
        lastEventIdRef,
        userMsgIndex: wsUserMsgIndexRef.current,
        sessionOwnerRef,
        onModelPersist: (sessionId, model) => {
          localStorage.setItem(`agentChat.model.${sessionId}`, model);
        },
        // ─── 消息可靠性回调 ───
        onChatAck: (clientMsgId) => {
          // ACK 到达：清除超时定时器，outbox entry 翻 acked
          const t = ackTimersRef.current.get(clientMsgId);
          if (t) { clearTimeout(t); ackTimersRef.current.delete(clientMsgId); }
          const entry = outboxRef.current.find(e => e.clientMsgId === clientMsgId);
          if (entry) entry.state = 'acked';
          // 专职 Agent 挂起 ref 不在 ACK 清（2026-07 审查 F9）：ACK 只代表消息入队，
          // 门禁/入队失败（chat_rejected）后重发仍需带 orgAgentId；
          // 改在 'session' 事件（服务端已写 meta 绑定）后清除
        },
        onActiveUserMsgIndexChange: (index) => {
          // 插话回退为独立 run 的接管：把防串校验的归属索引切到接管消息的气泡
          wsUserMsgIndexRef.current = index;
        },
        onStreamAttached: () => {
          // 接管场景：目标 run 的 done 已清掉 attached，这里恢复，后续流式内容才能过守卫
          wsAttachedRef.current = true;
        },
        onInterjectionApplied: (sourceRunIds, clientMsgIds) => {
          const applied = new Set(clientMsgIds);
          const appliedRuns = new Set(sourceRunIds);
          consumedInterjectionsRef.current.markMany(clientMsgIds, sourceRunIds);
          outboxRef.current = outboxRef.current.filter((entry) => !applied.has(entry.clientMsgId));
          for (const clientMsgId of clientMsgIds) {
            const timer = ackTimersRef.current.get(clientMsgId);
            if (timer) clearTimeout(timer);
            ackTimersRef.current.delete(clientMsgId);
          }
          // 队列区：被吸收的插话移除（气泡由 user_message 投影事件补进时间线）。
          // 消费标记还会拦截稍晚到达的 queued 广播/旧 detail 快照，避免队列栏反复复活。
          mutateQueuedInterjections((prev) => removeConsumedInterjections(prev, applied, appliedRuns));
        },
        // ── 插话队列区（2026-08-04 终态设计）──
        onSteeringAckQueued: (clientMsgId, sourceRunId, targetRunId) => {
          if (!clientMsgId || consumedInterjectionsRef.current.has({ clientMsgId, sourceRunId })) return;
          mutateQueuedInterjections((prev) => prev.map((entry) => (
            entry.clientMsgId === clientMsgId
              ? {
                ...entry,
                status: 'queued' as const,
                ...(sourceRunId ? { sourceRunId } : {}),
                ...(targetRunId ? { targetRunId } : {}),
              }
              : entry
          )));
        },
        onSteeringQueued: (event) => {
          // user scope 多端广播：只处理当前会话；其他会话靠 detail API 恢复
          const sid = immediateSessionIdRef.current ?? sessionIdRef.current;
          if (
            !sid
            || event.sessionId !== sid
            || consumedInterjectionsRef.current.has({
              clientMsgId: event.clientMsgId,
              sourceRunId: event.sourceRunId,
            })
          ) return;
          mutateQueuedInterjections((prev) => {
            const existing = prev.find((entry) => entry.clientMsgId === event.clientMsgId);
            if (existing) {
              return prev.map((entry) => (
                entry.clientMsgId === event.clientMsgId
                  ? { ...entry, status: 'queued' as const, sourceRunId: event.sourceRunId, targetRunId: event.targetRunId }
                  : entry
              ));
            }
            return [...prev, {
              clientMsgId: event.clientMsgId,
              sourceRunId: event.sourceRunId,
              targetRunId: event.targetRunId,
              content: event.content,
              ...(event.attachments?.length ? { attachments: event.attachments } : {}),
              status: 'queued' as const,
              createdAt: event.timestamp,
            }];
          });
        },
        onSteeringCancelled: (event) => {
          const sid = immediateSessionIdRef.current ?? sessionIdRef.current;
          if (!sid || event.sessionId !== sid) return;
          mutateQueuedInterjections((prev) => prev.map((entry) => (
            (entry.sourceRunId && entry.sourceRunId === event.sourceRunId)
              || (event.clientMsgId && entry.clientMsgId === event.clientMsgId)
              ? {
                ...entry,
                status: 'cancelled' as const,
                reason: event.reason === 'aborted' ? '已随停止一并撤销' : '已撤回',
              }
              : entry
          )));
        },
        onSteeringPromoted: (clientMsgId, _streamId, _runId) => {
          // 插话回退为独立 run 被接管：队列区条目移入时间线成为正式 user 气泡
          if (!clientMsgId) return null;
          const entry = queuedInterjectionsRef.current.find((item) => item.clientMsgId === clientMsgId);
          if (!entry) return null;
          mutateQueuedInterjections((prev) => prev.filter((item) => item.clientMsgId !== clientMsgId));
          const index = msgRef.current.addMessage({
            type: 'user',
            content: entry.content,
            ...(entry.attachments?.length ? { attachments: entry.attachments } : {}),
            status: 'sent',
            timestamp: Date.now(),
            clientMsgId,
          });
          msgRef.current.triggerScroll();
          return index;
        },
        onUserMessageProjected: (clientMsgId, sourceRunId) => {
          if (!clientMsgId && !sourceRunId) return;
          consumedInterjectionsRef.current.mark({ clientMsgId, sourceRunId });
          mutateQueuedInterjections((prev) => removeConsumedInterjections(
            prev,
            new Set(clientMsgId ? [clientMsgId] : []),
            new Set(sourceRunId ? [sourceRunId] : []),
          ));
        },
        onChatRejected: (clientMsgId, reasonCode, reason) => {
          // 服务端拒绝：清 ACK 定时器、从 outbox 移除；bubble 已在 wsEventProcessor 翻 failed
          const t = ackTimersRef.current.get(clientMsgId);
          if (t) { clearTimeout(t); ackTimersRef.current.delete(clientMsgId); }
          outboxRef.current = outboxRef.current.filter(e => e.clientMsgId !== clientMsgId);
          if (pendingNewSessionClientMsgIdRef.current === clientMsgId) pendingNewSessionClientMsgIdRef.current = null;
          newSessionClientMsgIdsRef.current.delete(clientMsgId);
          // 插话被拒：只更新队列区条目，绝不动 loading/attached——当前 run 还在跑
          const queuedEntry = queuedInterjectionsRef.current.find((entry) => entry.clientMsgId === clientMsgId);
          if (queuedEntry) {
            if (reasonCode === 'duplicate_inflight') {
              // 重试撞上服务端已受理的原消息：移除本地条目，真态由
              // steering_queued/interjection_applied 广播或 detail 刷新补回。
              mutateQueuedInterjections((prev) => prev.filter((entry) => entry.clientMsgId !== clientMsgId));
            } else {
              mutateQueuedInterjections((prev) => prev.map((entry) => (
                entry.clientMsgId === clientMsgId
                  ? { ...entry, status: 'failed' as const, reason: reason || '已被拒绝，可重试' }
                  : entry
              )));
            }
            return;
          }
          // 清 loading 判定（2026-08-04 P1-2 修复）：outbox.every 在空数组上恒真，
          // 会把「后台已在跑、非本页发起」的 run 强制 detach（后续 done 全被防串守卫
          // 吞掉，界面卡死「正在思考」）。必须同时确认当前会话没有 active runtime。
          const rejectedSid = immediateSessionIdRef.current ?? sessionIdRef.current;
          const runtimeStillActive = rejectedSid
            ? isActiveRuntimeStatus(activeRunsBySession.current.get(rejectedSid)?.status)
            : false;
          if (
            !runtimeStillActive
            && outboxRef.current.every(e => e.state !== 'acked' && e.state !== 'sending')
          ) {
            wsAttachedRef.current = false;
            setLoading(false);
          }
        },
        onChatDone: (clientMsgId) => {
          if (!clientMsgId) return;
          const t = ackTimersRef.current.get(clientMsgId);
          if (t) { clearTimeout(t); ackTimersRef.current.delete(clientMsgId); }
          outboxRef.current = outboxRef.current.filter(e => e.clientMsgId !== clientMsgId);
          if (pendingNewSessionClientMsgIdRef.current === clientMsgId) pendingNewSessionClientMsgIdRef.current = null;
          newSessionClientMsgIdsRef.current.delete(clientMsgId);
        },
      };


      const result = processWsEvent(
        data, ctx, wsBlockRef.current,
        wsLatestSessionIdRef.current,
        immediateSessionIdRef.current,
      );

      // 新建会话 → replaceState（不创建历史记录）
      if (data.type === 'session' && 'sessionId' in data) {
        immediateSessionIdRef.current = (data as any).sessionId;
        replaceUrl('chat', (data as any).sessionId);
        // 自己发起的新会话流：id 确定后纳入未读追踪，确保切走后流完成（idle）时能标记未读
        trackedAiReplyStreamsRef.current.add((data as any).sessionId);
        // 专职 Agent 挂起 ref 此时才清（2026-07 审查 F9）：会话真实建立、
        // 服务端已写 meta 绑定 orgAgentId，后续 resume 以 meta 为准
        pendingOrgAgentIdRef.current = null;
        pendingNewSessionClientMsgIdRef.current = null;
      }

      if (data.type === 'session_updated' && !data.isNew) {
        trackedAiReplyStreamsRef.current.delete(data.sessionId);
      }

      if (result === 'buffer_overflow') {
        wsBlockRef.current = { currentBlockIndex: -1, currentBlockType: null };
        sessionRef.current.refreshCurrentSession();
        const overflowSid = sessionIdRef.current;
        if (overflowSid) {
          const detailPromise = sessionRef.current.loadDetailPromiseRef.current;
          void (async () => {
            try { await detailPromise; } catch { /* ignore */ }
            if (sessionIdRef.current !== overflowSid) return;
            wsClient.ensureConnectedSend({
              action: 'resume',
              sessionId: overflowSid,
              lastEventId: 0,
            lastEventCursor: null,
              skipReplay: true,
            }).catch(() => {});
          })();
        }
        return;
      }

      if (result === 'done') {
        const latestSid = wsLatestSessionIdRef.current.value || sessionIdRef.current;
        if (latestSid === sessionIdRef.current) {
          sessionRef.current.setContextUsage(null);
        }
        // 已 detach（切换会话后）或 loading 已被其他路径（watchdog/reject）清掉：
        // 本轮 outbox 条目已由 onChatDone 清理；已 ACK 的插话由服务端消费或回退执行。
        if (!loadingRef.current) {
          return;
        }
        clearWatchdog();
        dispatchConnection('complete');
        if (latestSid) {
          trackedAiReplyStreamsRef.current.delete(latestSid);
          const doneEvent = data as Extract<WsEvent, { type: 'done' }>;
          if (doneEvent.error) {
            // done.error：本轮 run 失败,必须把失败明确地呈现给用户,而不是只静默清 loading。
            // 用户侧通俗文案;原始 doneEvent.error（model error）仅保留在 server.log + PG runtime_events。
            // 协调：shared/wsEventProcessor 在 done 时若所有 user 气泡都已 failed,会注入一条同样
            //   通俗的 text 兜底（mobile 等不支持 system-error 的客户端也能看到）。
            //   web 端要升级成红边 system-error,所以扫尾 N 条找那条 text,有则就地替换、无则追加。
            // dedupe：若最末已是相同 content 的 system-error（重复 done 事件）则跳过。
            const alertContent = formatRuntimeFailureMessage(doneEvent.error);
            const alertSeverity = isInsufficientCreditsFailure(doneEvent.error) ? 'billing' : 'error';
            const msgs = msgRef.current.messagesRef.current;
            const last = msgs[msgs.length - 1];
            if (!(last?.type === 'system-error' && last.content === alertContent)) {
              // 扫最末 3 条找 wsEventProcessor 刚注入的同内容 text 兜底消息,就地升级
              let upgradeIdx = -1;
              for (let i = msgs.length - 1; i >= Math.max(0, msgs.length - 3); i--) {
                const m = msgs[i];
                if (m.type === 'text' && m.content === alertContent) {
                  upgradeIdx = i;
                  break;
                }
              }
              if (upgradeIdx >= 0) {
                msgRef.current.updateMessageAt(upgradeIdx, (m) => ({
                  id: m.id,
                  type: 'system-error',
                  content: alertContent,
                  severity: alertSeverity,
                  timestamp: Date.now(),
                }));
              } else {
                msgRef.current.addMessage({
                  type: 'system-error',
                  content: alertContent,
                  severity: alertSeverity,
                  timestamp: Date.now(),
                });
              }
            }
          }
          // 即时 patch：从本地消息提取最后一条文本作为 preview
          const msgs = msgRef.current.messagesRef.current;
          for (let i = msgs.length - 1; i >= 0; i--) {
            const m = msgs[i];
            if (m.type === 'text' && m.content) {
              sessionRef.current.updateSessionMeta(latestSid, {
                preview: (m.content as string).slice(0, 200),
                updatedAtMs: Date.now(),
              });
              break;
            }
          }
          void sessionRef.current.loadSessions();
          void refreshTokenUsageRef.current();
          saveSessionMessages(latestSid, msgRef.current.messagesRef.current);
          // 从 API 刷新：服务端 transcript 解析会做额外转换（如 task-notification → tool_use），
          // 实时流构建的消息可能缺少这些转换，需要用服务端数据替换。
          sessionRef.current.refreshCurrentSession();
        }
        finalizeRunningSubagents(msgRef.current);
        wsAttachedRef.current = false;
        setLoading(false);
        setStopping(false);

        // onChatDone 只移除本轮 entry；其他 acked 条目是服务端持久化插话，不能随本轮 done 丢弃。
        // 2026-08-04 终态设计：本地不再扣留排队消息，无需 done 后续发。
      }
    });

    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatchConnection]);

  /** 内部：标记 bubble 为 failed（按 clientMsgId 或回退到 userMsgIndex） */
  const markBubbleFailed = useCallback((clientMsgId: string | undefined, fallbackIndex: number, reason: string) => {
    const msgs = msgRef.current.messagesRef.current;
    let idx = -1;
    if (clientMsgId) {
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if ((m.type === 'user' || m.type === 'user-voice') && 'clientMsgId' in m && m.clientMsgId === clientMsgId) {
          idx = i;
          break;
        }
      }
    }
    if (idx < 0) idx = fallbackIndex;
    if (idx < 0) return;
    msgRef.current.updateMessageAt(idx, (m) => {
      if (m.type === 'user') return { ...m, status: 'failed' as const, failedReason: reason };
      if (m.type === 'user-voice') return { ...m, status: 'failed' as const, failedReason: reason };
      return m;
    });
  }, []);

  /** 启动 ACK 超时定时器：ACK_TIMEOUT_MS 内未收到 chat_ack 则翻 failed */
  const armAckTimeout = useCallback((clientMsgId: string) => {
    const existing = ackTimersRef.current.get(clientMsgId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      ackTimersRef.current.delete(clientMsgId);
      // 出队：移除该 entry
      const entry = outboxRef.current.find(e => e.clientMsgId === clientMsgId);
      outboxRef.current = outboxRef.current.filter(e => e.clientMsgId !== clientMsgId);
      if (pendingNewSessionClientMsgIdRef.current === clientMsgId) pendingNewSessionClientMsgIdRef.current = null;
      newSessionClientMsgIdsRef.current.delete(clientMsgId);
      if (!entry) return;
      console.warn(`[chat] ACK timeout for ${clientMsgId}`);
      // 插话超时：只更新队列区条目，绝不动 loading/attached——当前 run 还在跑
      const queuedEntry = queuedInterjectionsRef.current.find((item) => item.clientMsgId === clientMsgId);
      if (queuedEntry) {
        mutateQueuedInterjections((prev) => prev.map((item) => (
          item.clientMsgId === clientMsgId
            ? { ...item, status: 'failed' as const, reason: '发送超时，可重试' }
            : item
        )));
        return;
      }
      markBubbleFailed(clientMsgId, -1, '发送超时，请重试');
      // 清 loading 判定（2026-08-04 P1-2 修复）：outbox.every 在空数组上恒真，会把
      // 「后台已在跑、非本页发起」的 run 强制 detach。必须确认当前会话无 active runtime。
      const sid = immediateSessionIdRef.current ?? sessionIdRef.current;
      const runtimeStillActive = sid
        ? isActiveRuntimeStatus(activeRunsBySession.current.get(sid)?.status)
        : false;
      if (loadingRef.current && !runtimeStillActive && outboxRef.current.every(e => e.state !== 'acked')) {
        // 仅在没有其他 acked 条目时退出 loading；否则保留继续等 done
        // 保守策略：ACK 超时即视为"这一次失败"，清 loading 让用户能发新消息
        wsAttachedRef.current = false;
        setLoading(false);
      }
    }, ACK_TIMEOUT_MS);
    ackTimersRef.current.set(clientMsgId, timer);
  }, [markBubbleFailed, mutateQueuedInterjections]);

  // ---- 通过 WS 发送聊天消息 ----
  const sendChatViaWs = useCallback(async (
    inputText: string,
    attachments: UploadedFile[],
    showBubble: boolean,
    voiceFile?: { savedPath: string; relativePath: string; duration: number },
    existingClientMsgId?: string,
    autoApproveRunShellForMessage = autoApproveRunShellRef.current,
    preserveActiveStream = false,
    /** 2026-08-04 终态设计：插话（队列区条目已由调用方维护，不建气泡、不绑气泡） */
    steeringQueued = false,
  ) => {
    const activeSessionId = sessionIdRef.current;
    // 自己发起的续聊流：纳入未读追踪，确保切走后流完成（idle）时能标记未读
    //（不依赖后端 busy 广播是否到达；新会话的 id 在 'session' 事件确定后再 add）
    if (activeSessionId) trackedAiReplyStreamsRef.current.add(activeSessionId);
    // 生成或复用 clientMsgId（vote 重试或 voice 二次调用时复用）
    const clientMsgId = existingClientMsgId || (crypto.randomUUID?.() || `c-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    if (!activeSessionId) {
      pendingNewSessionClientMsgIdRef.current = clientMsgId;
      newSessionClientMsgIdsRef.current.add(clientMsgId);
    }

    if (!preserveActiveStream) {
      wsLatestSessionIdRef.current = { value: activeSessionId };
      wsBlockRef.current = { currentBlockIndex: -1, currentBlockType: null };
      lastEventIdRef.current = null;
      streamNonceRef.current += 1;
      wsAttachedRef.current = true;
    }

    let submittedUserMessageIndex = -1;
    if (showBubble) {
      msgRef.current.triggerScroll();
      submittedUserMessageIndex = msgRef.current.addMessage({
        type: "user",
        content: inputText,
        ...(attachments.length > 0 ? { attachments: attachments.map(f => ({ name: f.originalName, isImage: f.isImage, relativePath: f.relativePath })) } : {}),
        status: 'pending',
        timestamp: Date.now(),
        clientMsgId,
      });
      // 插话不能覆盖当前 run 的 userMsgIndex，否则目标 run 的 done 会被防串校验丢弃。
      if (!preserveActiveStream) wsUserMsgIndexRef.current = submittedUserMessageIndex;
      // 乐观更新会话列表：preview + 排序即时变化
      if (activeSessionId) {
        sessionRef.current.updateSessionMeta(activeSessionId, {
          preview: inputText.slice(0, 200),
          updatedAtMs: Date.now(),
        });
      }
    } else if (!steeringQueued) {
      // 语音消息：将 clientMsgId 绑定到最近那条 pending user/user-voice bubble。
      // 插话（steeringQueued）绝不走这里（2026-08-04 P2-10 修复）：倒序猜「最近一条
      // pending」会与其他在途气泡张冠李戴，且终态设计下插话根本没有气泡。
      const msgs = msgRef.current.messagesRef.current;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if ((m.type === 'user' && m.status === 'pending')
          || (m.type === 'user-voice' && (m.status === 'transcribing' || m.status === 'uploading'))) {
          wsUserMsgIndexRef.current = i;
          // 补写 clientMsgId 到这条 bubble（之前 addMessage 时可能未带）
          msgRef.current.updateMessageAt(i, (prev) => {
            if (prev.type === 'user') return { ...prev, clientMsgId };
            if (prev.type === 'user-voice') return { ...prev, clientMsgId };
            return prev;
          });
          break;
        }
      }
    }

    // 入 outbox
    outboxRef.current.push({
      clientMsgId,
      input: inputText,
      attachments,
      ...(voiceFile ? { voiceFile } : {}),
      ...(autoApproveRunShellForMessage ? { autoApproveRunShell: true } : {}),
      state: 'sending',
      createdAt: Date.now(),
    });

    if (!preserveActiveStream) {
      upsertRuntimeStatusMessage(msgRef.current, 'sending');
      setLoading(true);
      resetWatchdog();
      dispatchConnection('connect');
    }

    const ok = await wsClient.ensureConnectedSend({
      action: 'chat',
      clientCapabilities: ['replaceable_drafts'],
      client_msg_id: clientMsgId,
      message: inputText || "Please check the attachments I uploaded",
      sessionId: activeSessionId || undefined,
      // 专职 Agent 绑定：仅新会话首条消息带（带 sessionId 时服务端以 meta 为准）
      ...(pendingOrgAgentIdRef.current && !activeSessionId
        ? { orgAgentId: pendingOrgAgentIdRef.current }
        : {}),
      model: selectedModelRef.current || undefined,
      ...(autoApproveRunShellForMessage ? { approvalPolicy: { autoApproveTools: true } } : {}),
      attachments: attachments.length > 0
        ? attachments.map((file) => ({
          ...(file.attachmentId ? { attachmentId: file.attachmentId } : {}),
          originalName: file.originalName,
          ...(file.savedPath ? { savedPath: file.savedPath } : {}),
          relativePath: file.relativePath,
          size: file.size,
          mimeType: file.mimeType,
          isImage: file.isImage,
        }))
        : undefined,
      ...(voiceFile ? { voiceFile } : {}),
    });

    if (!ok) {
      // 传输层失败：从 outbox 移除，翻 failed
      outboxRef.current = outboxRef.current.filter(e => e.clientMsgId !== clientMsgId);
      if (steeringQueued) {
        // 插话无气泡：只标队列区条目，可重发；当前流不受影响
        mutateQueuedInterjections((prev) => prev.map((entry) => (
          entry.clientMsgId === clientMsgId
            ? { ...entry, status: 'failed' as const, reason: '网络连接失败，可重试' }
            : entry
        )));
      } else {
        markBubbleFailed(
          clientMsgId,
          submittedUserMessageIndex >= 0 ? submittedUserMessageIndex : wsUserMsgIndexRef.current,
          '网络连接失败，请重试',
        );
      }
      if (!preserveActiveStream) {
        wsAttachedRef.current = false;
        setLoading(false);
      }
      if (pendingNewSessionClientMsgIdRef.current === clientMsgId) pendingNewSessionClientMsgIdRef.current = null;
      newSessionClientMsgIdsRef.current.delete(clientMsgId);
    } else {
      // 启动 ACK 超时定时器
      armAckTimeout(clientMsgId);
    }
  }, [dispatchConnection, armAckTimeout, markBubbleFailed, mutateQueuedInterjections]);

  // 同步 sendChatViaWs 到 ref，让 flushQueuedHead / armAckTimeout 等前置 callback 可调用
  useEffect(() => { sendChatViaWsRef.current = sendChatViaWs; }, [sendChatViaWs]);

  // ---- 压缩当前会话上下文 ----
  const compactSession = useCallback(async () => {
    const activeSessionId = sessionIdRef.current;
    if (!activeSessionId || loadingRef.current) return;

    wsLatestSessionIdRef.current = { value: activeSessionId };
    wsBlockRef.current = { currentBlockIndex: -1, currentBlockType: null };
    lastEventIdRef.current = null;
    streamNonceRef.current += 1;
    wsAttachedRef.current = true;
    wsUserMsgIndexRef.current = -1;

    upsertRuntimeStatusMessage(msgRef.current, 'sending');
    setLoading(true);
    resetWatchdog();
    dispatchConnection('connect');

    const ok = await wsClient.ensureConnectedSend({
      action: 'chat',
      clientCapabilities: ['replaceable_drafts'],
      message: '/compact',
      sessionId: activeSessionId,
    });

    if (!ok) {
      wsAttachedRef.current = false;
      setLoading(false);
    }
  }, [dispatchConnection]);

  const sendMessage = useCallback(async () => {
    const trimmedInput = inputRef.current.trim();
    if (!trimmedInput && uploadedFilesRef.current.length === 0) return;
    if (stoppingRef.current) return; // 停止中禁止发送，保留输入内容

    const capturedInput = trimmedInput;
    const capturedAttachments = [...uploadedFilesRef.current];
    setInput("");
    fileUpload.clearFiles();

    if (loadingRef.current) {
      // 运行中（2026-08-04 终态设计）：消息进输入框上方的队列区（不进时间线），
      // 直发服务端做 durable steering；当前流保持挂载，服务端在 AgentLoop 边界注入。
      // 被消费（user_message 投影）或回退接管（非 queued stream_id）时才进时间线。
      const clientMsgId = crypto.randomUUID?.() || `c-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      mutateQueuedInterjections((prev) => [...prev, {
        clientMsgId,
        content: capturedInput,
        ...(capturedAttachments.length > 0 ? {
          attachments: capturedAttachments.map((f) => ({ name: f.originalName, isImage: f.isImage, relativePath: f.relativePath })),
        } : {}),
        status: 'sending' as const,
        createdAt: Date.now(),
      }]);
      await sendChatViaWs(
        capturedInput,
        capturedAttachments,
        false,
        undefined,
        clientMsgId,
        autoApproveRunShellRef.current,
        true,
        true,
      );
      return;
    }

    await sendChatViaWs(capturedInput, capturedAttachments, true);
  }, [
    setInput,
    fileUpload.clearFiles,
    sendChatViaWs,
    mutateQueuedInterjections,
  ]);

  // ---- 自动订阅活跃会话的事件流（架构改造,2026-06-25）----
  //
  // 改造点（对应曾磊 + GPT 共同盘出的根因）：
  // 1. 入口先从 Map 加载该 session 的运行态到 ref（streamId/runId/lastEventId/lastEventCursor）,
  //    切回时不再 zero-base resume。
  // 2. HTTP /stream-status 改为"信号源之一"而非唯一决策：
  //    - HTTP active=true → 乐观 setLoading（与原行为一致）
  //    - HTTP active=false 也**不再 early return** —— 仍发 resume,
  //      等服务端权威 active_stream 兜底纠正（由全局 reducer 处理）。
  //    这条修复对应 "runStore 知道还在跑但 HTTP buffer 信号已死" 的窗口。
  // 3. shouldSkipReplay 改成基于 cursor 是否存在：有 cursor → 走增量 replay（skipReplay:false）,
  //    没 cursor（首次进入,只有 transcript）→ skipReplay:true。
  //    原实现固定看 lastEventIdRef===null,在 cursor 被切走清掉时永远走 skipReplay 那条死路。
  const subscribeToActiveStream = useCallback(async (
    targetSessionId: string,
    options?: { skipReplay?: boolean },
  ) => {
    await sessionRef.current.loadDetailPromiseRef.current;
    if (sessionIdRef.current !== targetSessionId) return;

    // ① 从 Map 恢复该 session 的运行态到 ref（streamId/runId/cursor）
    loadSessionRuntimeToRef(targetSessionId);

    // ② HTTP /stream-status 探活（事实源已升级为 runStore,buffer 是兜底）
    let httpActive: boolean | null = null; // null = HTTP 失败,降级靠 active_stream
    let httpStreamId: string | undefined;
    let httpRunId: string | undefined;
    try {
      const statusRes = await authFetch(`/api/sessions/${targetSessionId}/stream-status`);
      if (statusRes.ok) {
        const json = await statusRes.json() as { active: boolean; streamId?: string; runId?: string };
        httpActive = json.active;
        if (json.streamId) httpStreamId = json.streamId;
        if (json.runId) httpRunId = json.runId;
      }
    } catch { /* HTTP 失败 → httpActive 留 null,降级靠 active_stream */ }

    if (sessionIdRef.current !== targetSessionId) return;

    // HTTP 探活把"权威 runId / streamId"补回来（即使 Map 没有也能恢复）
    if (httpStreamId) {
      patchSessionRuntime(targetSessionId, { streamId: httpStreamId });
    }
    if (httpRunId) {
      patchSessionRuntime(targetSessionId, { runId: httpRunId });
    }

    if (httpActive === true && !loadingRef.current) {
      // HTTP 已确认活跃 → 乐观 setLoading 立刻显示停止按钮（无需等 WS 往返）
      patchSessionRuntime(targetSessionId, { status: 'running', attached: true });
      setLoading(true);
      dispatchConnection('connect');
    }

    wsLatestSessionIdRef.current = { value: targetSessionId };
    wsBlockRef.current = { currentBlockIndex: -1, currentBlockType: null };
    wsUserMsgIndexRef.current = -1;

    // 刚加载过完整 transcript 时必须跳过旧 cursor replay；否则 snapshot 与 replay 会重叠。
    // 纯 WS 断线重连不刷新 transcript，仍从 cursor 增量追帧。
    const shouldSkipReplay = options?.skipReplay === true
      || (lastEventIdRef.current === null && !lastEventCursorRef.current);

    // 不论 HTTP active 真假都发 resume：
    //   - 让服务端清理旧订阅,绑定新 ws → 当前 stream
    //   - 服务端通过 active_stream 给前端权威信号（全局 reducer 接管）
    //   - 即使 HTTP buffer 误报 inactive,runStore 仍 active 时 active_stream{active:true} 兜底
    const ok = await sendResumeDeduped({
      action: 'resume',
      sessionId: targetSessionId,
      lastEventId: lastEventIdRef.current ?? 0,
      lastEventCursor: lastEventCursorRef.current,
      skipReplay: shouldSkipReplay,
    });

    if (!ok && loadingRef.current && !wsAttachedRef.current && sessionIdRef.current === targetSessionId) {
      // resume 发送失败,回退乐观 loading
      setLoading(false);
    }

    // 安全超时：30 秒内若 active_stream 仍未到达且仍未 attach,清掉乐观 loading
    setTimeout(() => {
      if (sessionIdRef.current !== targetSessionId) return;
      if (loadingRef.current && !wsAttachedRef.current) {
        setLoading(false);
        sessionRef.current.refreshCurrentSession();
      }
    }, 30_000);
  }, [dispatchConnection, loadSessionRuntimeToRef, patchSessionRuntime]);

  const subscribeToActiveStreamRef = useRef(subscribeToActiveStream);
  subscribeToActiveStreamRef.current = subscribeToActiveStream;

  const resumeCurrentStream = useCallback(async () => {
    const targetSessionId = sessionIdRef.current;
    if (!targetSessionId) return;
    if (loadingRef.current) {
      upsertRuntimeStatusMessage(msgRef.current, 'reconnecting');
    }
    try {
      await wsClient.forceReconnect();
    } catch {
      // subscribeToActiveStream 会通过 ensureConnectedSend 再尝试一次。
    }
    if (sessionIdRef.current !== targetSessionId) return;
    await subscribeToActiveStreamRef.current(targetSessionId);
  }, []);

  // WS 连接成功后或 sessionId 变化时，检测当前会话是否有活跃流（合并为单一 useEffect 避免重复触发）
  useEffect(() => {
    if (!session.sessionId) return;
    const targetId = session.sessionId;

    const checkActiveStream = () => {
      void subscribeToActiveStreamRef.current(targetId, { skipReplay: true });
    };

    // 如果当前已经是 connected 状态，立即检测
    if (wsClient.currentState === 'connected') {
      const raf = requestAnimationFrame(checkActiveStream);
      const unsubscribe = wsClient.onStateChange((state) => {
        if (state === 'connected') checkActiveStream();
      });
      return () => { cancelAnimationFrame(raf); unsubscribe(); };
    }

    const unsubscribe = wsClient.onStateChange((state) => {
      if (state === 'connected') checkActiveStream();
    });
    return unsubscribe;
  }, [session.sessionId]);

  // 切换会话时关闭文件预览面板
  useEffect(() => {
    setPreviewFilePath(null);
  }, [session.sessionId]);

  /**
   * 安全移除单条消息（2026-08-04 P1-4 修复）：流式写入按数组下标寻址
   *（wsBlockRef.currentBlockIndex / wsUserMsgIndexRef），直接 splice 会让后续
   * text 增量静默写偏、done 归属校验错位。移除后同步修正两处下标引用。
   */
  const removeMessageAtIndex = useCallback((idx: number) => {
    const msgs = msgRef.current.messagesRef.current;
    if (idx < 0 || idx >= msgs.length) return;
    msgRef.current.setMessages(msgs.filter((_, i) => i !== idx), { scrollToBottom: false });
    if (wsBlockRef.current.currentBlockIndex > idx) {
      wsBlockRef.current = { ...wsBlockRef.current, currentBlockIndex: wsBlockRef.current.currentBlockIndex - 1 };
    } else if (wsBlockRef.current.currentBlockIndex === idx) {
      wsBlockRef.current = { currentBlockIndex: -1, currentBlockType: null };
    }
    if (wsUserMsgIndexRef.current > idx) wsUserMsgIndexRef.current -= 1;
    else if (wsUserMsgIndexRef.current === idx) wsUserMsgIndexRef.current = -1;
  }, []);

  // ---- Retry failed message / continue interrupted reply ----
  // 运行时已经先做透明自动恢复；只有终态仍失败时才展示“继续生成”。点击后发送一条新的“继续”，
  // 不重放原始请求，避免工具已产生副作用时重复执行。
  const retryMessage = useCallback((message: MessageItem) => {
    if (message.type === 'system-error') {
      if (message.severity === 'billing' || message.severity === 'cancelled' || loadingRef.current) return;
      const msgs = msg.messagesRef.current;
      const idx = msgs.findIndex(m => m.id === message.id);
      if (idx >= 0) removeMessageAtIndex(idx);
      setInput("");
      void sendChatViaWs('继续', [], true);
      return;
    }

    if (message.type !== 'user' || message.status !== 'failed') return;
    const msgs = msg.messagesRef.current;
    const idx = msgs.findIndex(m => m.id === message.id);
    if (idx >= 0) removeMessageAtIndex(idx);
    // 清理该 clientMsgId 的旧 ACK 定时器
    if (message.clientMsgId) {
      const t = ackTimersRef.current.get(message.clientMsgId);
      if (t) { clearTimeout(t); ackTimersRef.current.delete(message.clientMsgId); }
      outboxRef.current = outboxRef.current.filter(e => e.clientMsgId !== message.clientMsgId);
    }
    const text = typeof message.content === 'string' ? message.content : '';
    if (!text) {
      setInput(text);
      return;
    }
    // 复用原 clientMsgId（2026-08-04 P2-9 修复）：「ACK 丢失但服务端已受理」是超时的
    // 最常见成因——重发同 id 命中服务端 in_flight 幂等缓存补发 ACK/stream_id，已处理完
    // 则回 duplicate_inflight（气泡翻已发送），真正未送达时当新消息处理。换新 id 会让
    // 同一句话被入队/执行两次。
    const retryClientMsgId = message.clientMsgId
      || (crypto.randomUUID?.() || `c-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    if (loadingRef.current) {
      // 运行中：直发服务端 steering，进队列区（2026-08-04 终态设计，替代本地扣留）
      setInput("");
      mutateQueuedInterjections((prev) => [
        ...prev.filter((entry) => entry.clientMsgId !== retryClientMsgId),
        { clientMsgId: retryClientMsgId, content: text, status: 'sending' as const, createdAt: Date.now() },
      ]);
      void sendChatViaWs(text, [], false, undefined, retryClientMsgId, autoApproveRunShellRef.current, true, true);
    } else {
      setInput("");
      void sendChatViaWs(text, [], true, undefined, retryClientMsgId);
    }
  }, [setInput, msg, sendChatViaWs, removeMessageAtIndex, mutateQueuedInterjections]);

  // ---- 插话队列区操作（2026-08-04 终态设计）----
  /** 撤回一条排队插话。sending（未 ACK）阶段由 UI 禁用按钮；too_late 返回 false。 */
  const cancelQueuedInterjection = useCallback(async (clientMsgId: string): Promise<boolean> => {
    const entry = queuedInterjectionsRef.current.find((item) => item.clientMsgId === clientMsgId);
    if (!entry) return false;
    if (entry.status === 'cancelled' || entry.status === 'failed') return true;
    if (!entry.sourceRunId || entry.status !== 'queued') return false;
    const sourceRunId = entry.sourceRunId;
    const ok = await new Promise<boolean>((resolve) => {
      cancelWaitersRef.current.set(sourceRunId, resolve);
      void wsClient.ensureConnectedSend({ action: 'cancel_queued', sourceRunId }).then((sent) => {
        if (!sent && cancelWaitersRef.current.has(sourceRunId)) {
          cancelWaitersRef.current.delete(sourceRunId);
          resolve(false);
        }
      });
      setTimeout(() => {
        if (cancelWaitersRef.current.has(sourceRunId)) {
          cancelWaitersRef.current.delete(sourceRunId);
          resolve(false);
        }
      }, 10_000);
    });
    if (ok) {
      // steering_cancelled 广播会做同样标记（幂等）；这里即时反馈
      mutateQueuedInterjections((prev) => prev.map((item) => (
        item.clientMsgId === clientMsgId
          ? { ...item, status: 'cancelled' as const, reason: '已撤回' }
          : item
      )));
    }
    return ok;
  }, [mutateQueuedInterjections]);

  /** 撤回并把内容放回输入框（编辑）。撤回失败（已被消费）不动输入框。 */
  const editQueuedInterjection = useCallback(async (clientMsgId: string): Promise<void> => {
    const entry = queuedInterjectionsRef.current.find((item) => item.clientMsgId === clientMsgId);
    if (!entry) return;
    const ok = await cancelQueuedInterjection(clientMsgId);
    if (!ok) return;
    mutateQueuedInterjections((prev) => prev.filter((item) => item.clientMsgId !== clientMsgId));
    setInput(entry.content);
  }, [cancelQueuedInterjection, mutateQueuedInterjections, setInput]);

  /** 重发一条已取消/失败的插话（附件仅保留元数据，与失败重试一致只重发文本）。 */
  const resendQueuedInterjection = useCallback((clientMsgId: string) => {
    const entry = queuedInterjectionsRef.current.find((item) => item.clientMsgId === clientMsgId);
    if (!entry || (entry.status !== 'cancelled' && entry.status !== 'failed')) return;
    mutateQueuedInterjections((prev) => prev.filter((item) => item.clientMsgId !== clientMsgId));
    if (loadingRef.current) {
      const newClientMsgId = crypto.randomUUID?.() || `c-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      mutateQueuedInterjections((prev) => [...prev, {
        clientMsgId: newClientMsgId,
        content: entry.content,
        status: 'sending' as const,
        createdAt: Date.now(),
      }]);
      void sendChatViaWs(entry.content, [], false, undefined, newClientMsgId, autoApproveRunShellRef.current, true, true);
    } else {
      void sendChatViaWs(entry.content, [], true);
    }
  }, [mutateQueuedInterjections, sendChatViaWs]);

  /** 从队列区移除一条已取消/失败条目（不重发）。 */
  const dismissQueuedInterjection = useCallback((clientMsgId: string) => {
    mutateQueuedInterjections((prev) => prev.filter((item) => (
      item.clientMsgId !== clientMsgId
      || (item.status !== 'cancelled' && item.status !== 'failed')
    )));
  }, [mutateQueuedInterjections]);

  // ---- Fork from message (从此编辑) ----
  const forkFromMessage = useCallback(async (message: MessageItem) => {
    if (message.type !== 'user') return;
    const sourceSessionId = sessionIdRef.current;
    if (!sourceSessionId) return;

    try {
      const res = await authFetch(`/api/sessions/${encodeURIComponent(sourceSessionId)}/fork`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blockId: message.id }),
      });
      if (!res.ok) {
        console.error('Fork failed:', res.status);
        return;
      }
      const { newSessionId, forkMessage } = await res.json();

      selectSessionWithUrl(newSessionId);
      await sessionRef.current.loadDetailPromiseRef.current;
      setInput(forkMessage);
      // 刷新会话列表，确保新会话出现在侧边栏
      void sessionRef.current.loadSessions({ fresh: true });
    } catch (err) {
      console.error('Fork failed:', err);
    }
  }, [setInput, selectSessionWithUrl]);

  // ---- Interaction responses (via WS) ----
  const respondToInteraction = useCallback(async (
    interactionId: string,
    response: Record<string, unknown>,
  ) => {
    await wsClient.ensureConnectedSend({
      action: 'respond',
      interactionId,
      sessionId: sessionIdRef.current,
      ...response,
    });
  }, []);

  const handlePermissionResponse = useCallback(async (
    interactionId: string,
    allow: boolean,
  ) => {
    await respondToInteraction(interactionId, { allow, message: allow ? undefined : "User denied" });

    const idx = msg.messagesRef.current.findIndex(
      (m) => m.type === "permission_request" && m.interactionId === interactionId
    );
    if (idx >= 0) {
      msg.updateMessageAt(idx, (m) =>
        m.type === "permission_request"
          ? { ...m, status: allow ? "allowed" as const : "denied" as const }
          : m
      );
    }
    markSessionRead(sessionIdRef.current);
  }, [respondToInteraction, msg.messagesRef, msg.updateMessageAt, markSessionRead]);

  const handleAskUserResponse = useCallback(async (
    interactionId: string,
    answers: AskUserAnswers,
  ) => {
    await respondToInteraction(interactionId, { answers });

    const idx = msg.messagesRef.current.findIndex(
      (m) => m.type === "ask_user" && m.interactionId === interactionId
    );
    if (idx >= 0) {
      msg.updateMessageAt(idx, (m) =>
        m.type === "ask_user"
          ? { ...m, status: "answered" as const, answers }
          : m
      );
    }
    markSessionRead(sessionIdRef.current);
  }, [respondToInteraction, msg.messagesRef, msg.updateMessageAt, markSessionRead]);

  // ---- 会话切换时恢复模型选择 ----
  // 仅在 sessionId 实际切换时才重置/恢复，避免 sessions 列表刷新（WS 重连、
  // session_updated 广播等）触发 effect 重跑、把用户在新会话期间的选择悄悄
  // 覆盖回默认模型。
  const prevSessionIdForModelRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!modelList) return;
    const prev = prevSessionIdForModelRef.current;
    prevSessionIdForModelRef.current = session.sessionId;

    // sessionId 没变（仅 sessions 数组引用刷新），不动 selectedModel
    if (prev === session.sessionId) return;

    if (session.sessionId) {
      const stored = localStorage.getItem(`agentChat.model.${session.sessionId}`);
      const serverModel = session.sessions.find(
        (s) => s.sessionId === session.sessionId,
      )?.model;
      // 校验持久化的 model ref 是否仍在当前模型列表中。模型被删/改名
      // （如 opus 4.7→4.8）后旧 ref 失效，若直接塞给 <Select> 会找不到
      // 对应项显示空、逼用户手选。失效时回退到 default。
      const isValidRef = (ref: string | null | undefined): boolean =>
        !!ref && modelList.groups.some((g) =>
          g.models.some((m) => `${g.id}/${m.id}` === ref),
        );
      setSelectedModel(
        isValidRef(stored)
          ? stored!
          : isValidRef(serverModel)
            ? serverModel!
            : modelList.default,
      );
    } else if (prev !== undefined) {
      // 仅"由有→null"时（用户主动新会话）重置；首挂载 prev===undefined 时
      // 让 selectedModel 的初始化逻辑处理，不在此处覆盖
      setSelectedModel(modelList.default);
    }
  }, [session.sessionId, session.sessions, modelList]);

  // ---- Cleanup on unmount ----
  useEffect(() => {
    return () => {
      for (const t of ackTimersRef.current.values()) clearTimeout(t);
      ackTimersRef.current.clear();
      wsClient.disconnect();
    };
  }, []);

  return {
    messages: msg.messages,
    input,
    loading,
    sessionId: session.sessionId,
    sessions: session.sessions,
    activeTab,
    governanceRoute: governanceRouteState,
    platformAdminSection,
    platformAdminEntityId,
    tenantAdminSection,
    settingsOpen,
    settingsSection,
    uploadedFiles: fileUpload.uploadedFiles,
    uploading: fileUpload.uploading,
    uploadError: fileUpload.uploadError,
    dismissUploadError: fileUpload.dismissUploadError,
    isDragging: fileUpload.isDragging,
    isLoadingSessions: session.isLoadingSessions,
    isLoadingMessages: session.isLoadingMessages,
    hasMoreHistory: session.hasMoreHistory,
    isLoadingEarlier: session.isLoadingEarlier,
    loadEarlierMessages: session.loadEarlierMessages,
    deleteSessionId: session.deleteSessionId,
    deleteSessionCount: session.deleteSessionCount,
    lastMessageRef: msg.lastMessageRef,
    scrollContainerRef: msg.scrollContainerRef,
    isNearBottomRef: msg.isNearBottomRef,
    setInput,
    setActiveTab,
    pushActiveTab,
    setPlatformAdminRoute,
    setTenantAdminRoute,
    openSettings,
    closeSettings,
    setSettingsSection,
    adminSettings,
    openAdminSettings,
    closeAdminSettings,
    setAdminSettingsSection,
    newSession: newSessionWithUrl,
    selectSession: selectSessionWithUrl,
    startOrgAgentSession,
    pendingOrgAgentId,
    confirmDeleteSession: session.confirmDeleteSession,
    confirmDeleteSessions: session.confirmDeleteSessions,
    cancelDeleteSession: session.cancelDeleteSession,
    handleDeleteSession: session.handleDeleteSession,
    renameSession: session.renameSession,
    autoTitleSession: session.autoTitleSession,
    compactSession,
    removeFile: fileUpload.removeFile,
    handleFileSelect: fileUpload.handleFileSelect,
    handlePaste: fileUpload.handlePaste,
    sendMessage,
    stopping,
    stopGeneration: cancelActiveStream,
    queuedInterjections,
    cancelQueuedInterjection,
    editQueuedInterjection,
    resendQueuedInterjection,
    dismissQueuedInterjection,
    retryMessage,
    forkFromMessage,
    handleDragOver: fileUpload.handleDragOver,
    handleDragLeave: fileUpload.handleDragLeave,
    handleDrop: fileUpload.handleDrop,
    handlePermissionResponse,
    handleAskUserResponse,
    modelList,
    selectedModel,
    onModelChange: handleModelChange,
    autoApproveRunShell: effectiveAutoApproveRunShell,
    setAutoApproveRunShell,
    tokenUsage: session.tokenUsage,
    contextUsage: session.contextUsage,
    notifications,
    dismissNotification,
    lastMemoryRecall,
    dismissMemoryRecall,
    pluginInstallStatus,
    runningSessionIds,
    connectionState,
    refreshCurrentSession: session.refreshCurrentSession,
    resumeCurrentStream,
    hasMoreSessions: session.hasMore,
    isLoadingMoreSessions: session.isLoadingMore,
    loadMoreSessions: session.loadMoreSessions,
    loadGroupSessions: session.loadGroupSessions,
    agentProfile,
    sessionParticipants,
    previewFilePath,
    previewFileOwner,
    previewMode,
    openFilePreview,
    dockFilePreview,
    expandFilePreview,
    closeFilePreview,
    fileBrowserOpen,
    toggleFileBrowser,
    closeFileBrowser,
    isTrashPreview,
    previewTrashSession: (id: string | null) => { void previewTrashSession(id); },
    trashPreviewSessionId,
    sendVoiceMessage: async (wavBlob: Blob, durationMs: number) => {
      // 1. 上传 WAV 文件（仍用 HTTP）
      const durationSec = Math.round(durationMs / 1000);
      const voiceMsgIndex = msg.addMessage({
        type: 'user-voice',
        audioUrl: '',
        duration: durationSec,
        status: 'uploading',
        timestamp: Date.now(),
      });
      msg.triggerScroll();

      let savedPath: string;
      let relativePath: string;
      try {
        const formData = new FormData();
        const filename = `voice_${Date.now()}_${crypto.randomUUID().slice(0, 8)}.wav`;
        formData.append('files', wavBlob, filename);

        const uploadRes = await authFetch('/api/upload', { method: 'POST', body: formData });
        if (!uploadRes.ok) throw new Error(`Upload failed: ${uploadRes.status}`);
        const uploadData = await uploadRes.json();
        if (!uploadData.success || !uploadData.files?.[0]) throw new Error('Upload response invalid');

        savedPath = uploadData.files[0].savedPath;
        relativePath = uploadData.files[0].relativePath;
      } catch (err) {
        console.error('Voice upload failed:', err);
        msg.updateMessageAt(voiceMsgIndex, (m) =>
          m.type === 'user-voice' ? { ...m, status: 'failed' as const } : m
        );
        return;
      }

      // 2. 更新消息状态为 transcribing
      const audioUrl = `/api/voice/play?path=${encodeURIComponent(relativePath)}`;
      msg.updateMessageAt(voiceMsgIndex, (m) =>
        m.type === 'user-voice' ? { ...m, audioUrl, status: 'transcribing' as const } : m
      );

      // 3. 通过 WS 发送 chat 消息（带 voiceFile）
      wsUserMsgIndexRef.current = -1;
      sendChatViaWs('[语音消息]', [], false, { savedPath, relativePath, duration: durationMs });
    },
  };
}

import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import type { ChangeEvent, ClipboardEvent, DragEvent, RefObject } from "react";
import type { MessageItem, UploadedFile } from "@/components/types";
import type { ApiSessionListItem, TokenUsage } from "@/lib/sessionsApi";
import type { AskUserAnswers, ContextUsageData, NotificationData, MemoryRecallData, PluginInstallData } from "@agent/shared";
import type { ModelList } from "@/types/models";
import type { AppTab } from "@/types/sidebar";
import type { SettingsSectionId } from "@/types/settings";
import type { WsEvent } from "@/types/ws";
import type { WsEnvelope } from "@/lib/wsClient";
import { wsClient } from "@/lib/wsClient";
import { authFetch } from "@/lib/authFetch";
import { registerRefresh, unregisterRefresh } from "@/lib/refreshBus";
import { fetchAgentProfile, reportActivity } from "@agent/shared";
import type { AgentProfile, SessionParticipants } from "@agent/shared";
import { saveSessionMessages } from "@/lib/messageCache";
import { INPUT_DRAFT_KEY } from "@/lib/constants";
import {
  getUnreadAiRepliesStorageKey,
  loadUnreadAiReplySessionIds,
  saveUnreadAiReplySessionIds,
} from "@/lib/unreadAiReplies";
import { mapSessionDetailToMessages } from "@/lib/sessionsApi";
import type { ApiSessionDetail } from "@/lib/sessionsApi";
import {
  asCompactionItem,
  compactionDoneReplacement,
  createCompactionDoneItem,
  createCompactionRunningItem,
} from "@/lib/compaction";
import type { CompactionMessageItem, CompactionStatusEvent } from "@/lib/compaction";
import { parseUrl, pushUrl, replaceUrl, buildUrl, buildSettingsUrl, pushSettingsUrl, replaceSettingsUrl, pushAdminSettingsUrl, replaceAdminSettingsUrl, buildAdminSettingsUrl, normalizeAdminSettingsSection, buildPlatformAdminUrl, pushPlatformAdminUrl, replacePlatformAdminUrl } from "@/lib/urlSync";
import { registerUpdateGuard, registerBeforeReloadHook, maybeReloadOnPopstate } from "@/lib/swUpdate";
import type { AdminSettingsState, AdminSettingsTarget, PlatformAdminSection } from "@/lib/urlSync";
import { useMessages } from "@/hooks/useMessages";
import { useAuth } from "@/contexts/AuthContext";
import { useSession } from "@/hooks/useSession";
import { useFileUpload } from "@/hooks/useFileUpload";
import { useConnectionState, type ConnectionState } from "@/hooks/useConnectionState";
import {
  processWsEvent,
  finalizeStreamingMessages,
  finalizeRunningSubagents,
  formatRuntimeFailureMessage,
  removeRuntimeStatusMessages,
  upsertRuntimeStatusMessage,
  type WsProcessingContext,
  type WsBlockState,
} from '@agent/shared';

const RUN_SHELL_APPROVAL_STORAGE_PREFIX = 'agentChat.autoApproveRunShell.';
const runShellApprovalStorageKey = (sessionId: string) => `${RUN_SHELL_APPROVAL_STORAGE_PREFIX}${sessionId}`;

function clearRunShellApprovalStorage() {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i);
    if (key?.startsWith(RUN_SHELL_APPROVAL_STORAGE_PREFIX)) {
      localStorage.removeItem(key);
    }
  }
}

export interface ChatAppState {
  messages: MessageItem[];
  input: string;
  loading: boolean;
  sessionId: string | null;
  sessions: ApiSessionListItem[];
  activeTab: AppTab;
  platformAdminSection: PlatformAdminSection;
  platformAdminEntityId: string | null;
  settingsOpen: boolean;
  settingsSection: SettingsSectionId;
  uploadedFiles: UploadedFile[];
  uploading: boolean;
  uploadError: string | null;
  dismissUploadError: () => void;
  isDragging: boolean;
  isLoadingSessions: boolean;
  isLoadingMessages: boolean;
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
  /** 已完成但用户尚未点击查看的 AI 回复会话 */
  unreadAiReplySessionIds: ReadonlySet<string>;
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

  // ---- Input state with draft persistence ----
  const [input, setInputRaw] = useState(() => localStorage.getItem(INPUT_DRAFT_KEY) || "");
  const draftTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const setInput = useCallback((value: string) => {
    setInputRaw(value);
    clearTimeout(draftTimerRef.current);
    if (value) {
      draftTimerRef.current = setTimeout(() => {
        try {
          localStorage.setItem(INPUT_DRAFT_KEY, value);
        } catch {
          // QuotaExceededError — 存储满时静默失败
        }
      }, 2000);
    } else {
      localStorage.removeItem(INPUT_DRAFT_KEY);
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
  const unreadAiReplyStorageKey = getUnreadAiRepliesStorageKey(user?.id);
  const [unreadAiReplySessionIds, setUnreadAiReplySessionIds] = useState<Set<string>>(
    () => loadUnreadAiReplySessionIds(unreadAiReplyStorageKey),
  );
  const isSessionVisibleRef = useRef<(targetSessionId: string) => boolean>(() => false);
  const markUnreadAiReply = useCallback((targetSessionId: string | null | undefined) => {
    if (!targetSessionId) return;
    if (isSessionVisibleRef.current(targetSessionId)) {
      setUnreadAiReplySessionIds((prev) => {
        if (!prev.has(targetSessionId)) return prev;
        const next = new Set(prev);
        next.delete(targetSessionId);
        saveUnreadAiReplySessionIds(unreadAiReplyStorageKey, next);
        return next;
      });
      return;
    }
    setUnreadAiReplySessionIds((prev) => {
      if (prev.has(targetSessionId)) return prev;
      const next = new Set(prev);
      next.add(targetSessionId);
      saveUnreadAiReplySessionIds(unreadAiReplyStorageKey, next);
      return next;
    });
  }, [unreadAiReplyStorageKey]);
  const clearUnreadAiReply = useCallback((targetSessionId: string | null | undefined) => {
    if (!targetSessionId) return;
    setUnreadAiReplySessionIds((prev) => {
      if (!prev.has(targetSessionId)) return prev;
      const next = new Set(prev);
      next.delete(targetSessionId);
      saveUnreadAiReplySessionIds(unreadAiReplyStorageKey, next);
      return next;
    });
  }, [unreadAiReplyStorageKey]);
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
  const [platformAdminSection, setPlatformAdminSectionRaw] = useState<PlatformAdminSection>(urlState.adminSection ?? 'overview');
  const [platformAdminEntityId, setPlatformAdminEntityIdRaw] = useState<string | null>(urlState.adminEntityId);
  const [pendingCanonicalPath, setPendingCanonicalPath] = useState<string | null>(urlState.canonicalPath);
  const [settingsOpen, setSettingsOpen] = useState(() => urlState.settingsSection !== null);
  const [settingsSection, setSettingsSectionRaw] = useState<SettingsSectionId>(urlState.settingsSection ?? 'account');
  const [adminSettings, setAdminSettingsRaw] = useState<AdminSettingsState | null>(() => urlState.adminSettings);
  const activeTabRef = useRef<AppTab>(activeTab);
  activeTabRef.current = activeTab;
  const platformAdminRouteRef = useRef<{ section: PlatformAdminSection; entityId: string | null }>({
    section: platformAdminSection,
    entityId: platformAdminEntityId,
  });
  platformAdminRouteRef.current = { section: platformAdminSection, entityId: platformAdminEntityId };
  const adminSettingsRef = useRef<AdminSettingsState | null>(adminSettings);
  adminSettingsRef.current = adminSettings;
  const streamNonceRef = useRef(0);
  const streamIdRef = useRef<string | null>(null);
  const runIdRef = useRef<string | null>(null);
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
    /** 已成功接收的最大事件 id; resume 时作为增量起点 */
    lastEventId?: number;
    /** 服务端时序游标, 与 lastEventId 配合, 跨进程兼容 */
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

  // ─── 消息可靠性：outbox 队列 + ACK 超时跟踪（2026-04-18）───
  /**
   * Outbox：用户已提交但尚未到达"服务端已处理"终态的消息队列。
   * - queued: 等待前一条 done 后出队
   * - sending: 已 ensureConnectedSend，等 ACK
   * - acked: 收到 chat_ack，等 done
   * 替代旧的 pendingMessageRef 单槽设计：旧设计在用户快速连发时会静默覆盖。
   */
  interface OutboxEntry {
    clientMsgId: string;
    input: string;
    attachments: UploadedFile[];
    voiceFile?: { savedPath: string; relativePath: string; duration: number };
    autoApproveRunShell?: boolean;
    state: 'queued' | 'sending' | 'acked';
    createdAt: number;
  }
  const outboxRef = useRef<OutboxEntry[]>([]);
  /** 每个 inflight 消息的 ACK 超时定时器（收到 ack 清除） */
  const ackTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const ACK_TIMEOUT_MS = 15_000;

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
          setSelectedModel((prev) => prev || data.default);
        }
      })
      .catch(() => { });
  }, []);

  useEffect(() => {
    fetchModelList();
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
  isSessionVisibleRef.current = (targetSessionId: string) =>
    activeTabRef.current === 'chat'
    && !trashPreviewSessionIdRef.current
    && immediateSessionIdRef.current === targetSessionId;

  // ---- SW 更新协作（lib/swUpdate.ts）----
  // 守门：上传中 / 消息在途（outbox 未清）/ 任一会话 run 处于进行态 → 导航时不强刷
  useEffect(() => {
    const unregisterGuard = registerUpdateGuard(() => {
      if (uploadingRef.current) return true;
      if (outboxRef.current.length > 0) return true;
      for (const runtime of activeRunsBySession.current.values()) {
        if (
          runtime.status === 'busy' || runtime.status === 'running' || runtime.status === 'queued'
          || runtime.status === 'waiting_approval' || runtime.status === 'waiting_hand'
        ) {
          return true;
        }
      }
      return false;
    });
    // 刷新前同步 flush 草稿：2s debounce 窗口内的输入不丢
    const unregisterHook = registerBeforeReloadHook(() => {
      clearTimeout(draftTimerRef.current);
      try {
        if (inputRef.current) localStorage.setItem(INPUT_DRAFT_KEY, inputRef.current);
      } catch {
        // 存储满时静默失败
      }
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
  ) => Promise<void>) | null>(null);
  const reconcileLastRunStateRef = useRef<(sessionId: string, lastRunState: LastRunState) => void>(() => {});

  /** Partial patch Map.get(sid)；若 sid === current,同步 ref（不动 setState 状态） */
  const patchSessionRuntime = useCallback((sid: string, patch: SessionRuntimePatch) => {
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
    if (sid === sessionIdRef.current) {
      if (patch.streamId !== undefined) streamIdRef.current = patch.streamId;
      if (patch.runId !== undefined) runIdRef.current = patch.runId;
      if (patch.lastEventId !== undefined) lastEventIdRef.current = patch.lastEventId;
      if (patch.lastEventCursor !== undefined) lastEventCursorRef.current = patch.lastEventCursor;
      if (patch.attached !== undefined) wsAttachedRef.current = patch.attached;
    }
    return next;
  }, []);

  /** 用户点击"停止"按钮：发送 abort，等 done 到达后才恢复 UI */
  const cancelActiveStream = useCallback(() => {
    const targetSessionId = sessionIdRef.current;
    const sid = streamIdRef.current;
    const rid = runIdRef.current;
    if (!sid && !rid) return;
    void wsClient.ensureConnectedSend({ action: 'abort', ...(rid ? { runId: rid } : {}), ...(sid ? { streamId: sid } : {}) });
    setStopping(true);
    // 停止时：丢弃 queued 但保留已发送的条目（让 ACK/rejected/done 继续处理）
    outboxRef.current = outboxRef.current.filter(e => e.state !== 'queued');

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
          lastEventCursor: null,
          attached: false,
        });
      }
      if (streamNonceRef.current === nonceAtAbort && streamIdRef.current === sid) {
        streamIdRef.current = null;
        runIdRef.current = null;
        streamNonceRef.current += 1;
        lastEventIdRef.current = null;
        lastEventCursorRef.current = null;
        finalizeRunningSubagents(msgRef.current);
        removeRuntimeStatusMessages(msgRef.current);
        setLoading(false);
        setStopping(false);
      }
    }, 10_000);
  }, [patchSessionRuntime]);

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
    activeRunsBySession.current.set(sid, {
      status: inferredStatus,
      streamId: streamIdRef.current ?? undefined,
      runId: runIdRef.current ?? undefined,
      lastEventId: lastEventIdRef.current ?? undefined,
      lastEventCursor: lastEventCursorRef.current ?? undefined,
      attached: wsAttachedRef.current,
    });
  }, []);

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
    // 切会话：清 outbox 中 queued（未发）条目；sending/acked 留给它们自己的终态处理
    // 清所有 ACK 超时定时器
    for (const t of ackTimersRef.current.values()) clearTimeout(t);
    ackTimersRef.current.clear();
    outboxRef.current = outboxRef.current.filter(e => e.state !== 'queued');
    // 通知服务端解除 wsActiveStream 绑定（buffer 仍保留,resume 时可用 cursor 增量回放）
    wsClient.send({ action: 'detach' });
  }, [dumpCurrentSessionRuntime]);

  const clearComposer = useCallback(() => {
    setInput("");
    fileUpload.setIsDragging(false);
    fileUpload.clearFiles();
  }, [setInput, fileUpload]);

  const sessionCallbacks = useMemo(() => ({
    resetMessages: msg.resetMessages,
    setMessages: msg.setMessages,
    getMessages: () => msg.messagesRef.current,
    triggerScroll: msg.triggerScroll,
    cancelActiveStream: detachFromStream,
    clearComposer,
    onLastRunState: (sessionId: string, lastRunState: LastRunState) => {
      reconcileLastRunStateRef.current(sessionId, lastRunState);
    },
  }), [msg.resetMessages, msg.setMessages, msg.messagesRef, msg.triggerScroll, detachFromStream, clearComposer]);

  const session = useSession(sessionCallbacks, { initialSessionId: urlState.sessionId });
  const sessionRef = useRef(session); sessionRef.current = session;
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
      clearUnreadAiReply(session.sessionId);
    }
  }, [activeTab, session.sessionId, trashPreviewSessionId, clearUnreadAiReply]);

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
    cron: '定时任务', files: '文件管理', scenarios: '任务模板', capabilities: '专家与能力',
  };
  const setActiveTab = useCallback((tab: AppTab) => {
    setSettingsOpen(false);
    setAdminSettingsRaw(null);
    setActiveTabRaw(tab);
    if (tab === 'platform-admin') {
      setPlatformAdminSectionRaw('overview');
      setPlatformAdminEntityIdRaw(null);
      replacePlatformAdminUrl({ section: 'overview' });
    } else {
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
      setPlatformAdminSectionRaw('overview');
      setPlatformAdminEntityIdRaw(null);
      pushPlatformAdminUrl({ section: 'overview' });
    } else {
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
    pushPlatformAdminUrl({ section, entityId });
  }, []);

  const openSettings = useCallback((section: SettingsSectionId = 'account') => {
    setAdminSettingsRaw(null);
    setSettingsOpen(true);
    setSettingsSectionRaw(section);
    pushSettingsUrl(section);
  }, []);

  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    if (activeTabRef.current === 'platform-admin') {
      pushPlatformAdminUrl(platformAdminRouteRef.current);
    } else {
      pushUrl(activeTabRef.current, activeTabRef.current === 'chat' ? immediateSessionIdRef.current : null);
    }
  }, []);

  const setSettingsSection = useCallback((section: SettingsSectionId) => {
    setSettingsOpen(true);
    setSettingsSectionRaw(section);
    pushSettingsUrl(section);
  }, []);

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
    clearUnreadAiReply(id);
    immediateSessionIdRef.current = id;
    session.selectSession(id);
    pushUrl('chat', id);
  }, [clearPendingOrgAgent, clearUnreadAiReply, session.selectSession]);

  const newSessionWithUrl = useCallback(() => {
    setTrashPreviewSessionId(null);
    clearPendingOrgAgent(); // 普通新会话 = 个人 Agent 路径
    pendingNewSessionClientMsgIdRef.current = null;
    immediateSessionIdRef.current = null;
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
        adminSettings: urlAdminSettings,
        canonicalPath,
      } = parseUrl();
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
      immediateSessionIdRef.current = urlSessionId;
      setActiveTabRaw(tab);
      if (tab === 'chat') {
        if (urlSessionId && urlSessionId !== sessionIdRef.current) {
          clearUnreadAiReply(urlSessionId);
          selectSessionRawRef.current(urlSessionId);
        } else if (!urlSessionId && sessionIdRef.current) {
          newSessionRawRef.current();
        }
      }
    };
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, []);

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
    if (expectedUrl !== window.location.pathname) {
      immediateSessionIdRef.current = session.sessionId;
      replaceUrl(activeTab, activeTab === 'chat' ? session.sessionId : null);
    }
  }, [session.sessionId, activeTab, settingsOpen, settingsSection, adminSettings, platformAdminSection, platformAdminEntityId, pendingCanonicalPath]);

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
      lastEventCursor: null,
      attached: false,
    });

    if (args.sessionId !== sessionIdRef.current) return;

    clearWatchdog();
    finalizeStreamingMessages(msgRef.current);
    finalizeRunningSubagents(msgRef.current);

    let alertContent: string | null = null;
    let severity: 'error' | 'cancelled' = 'error';
    if (args.status === 'failed' || args.status === 'orphaned') {
      alertContent = formatRuntimeFailureMessage(args.reason);
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
    lastEventCursorRef.current = null;
    setLoading(false);
    setStopping(false);
    sessionRef.current.setContextUsage(null);

    const queuedEntries = outboxRef.current.filter(e => e.state === 'queued');
    for (const entry of outboxRef.current) {
      if (entry.state === 'queued') continue;
      const timer = ackTimersRef.current.get(entry.clientMsgId);
      if (timer) {
        clearTimeout(timer);
        ackTimersRef.current.delete(entry.clientMsgId);
      }
    }
    outboxRef.current = queuedEntries;
    if (!stoppingRef.current) {
      const nextQueued = outboxRef.current.find(e => e.state === 'queued');
      if (nextQueued) {
        outboxRef.current = outboxRef.current.filter(e => e.clientMsgId !== nextQueued.clientMsgId);
        void sendChatViaWsRef.current?.(
          nextQueued.input,
          nextQueued.attachments,
          false,
          nextQueued.voiceFile,
          nextQueued.clientMsgId,
          nextQueued.autoApproveRunShell,
        );
      }
    }

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
    if (sessionId !== sessionIdRef.current) return;

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
              }
            };
            const unsubReconnect = wsClient.onMessage(handleReconnectStream);
            wsClient.ensureConnectedSend({
              action: 'resume',
              sessionId: targetSid,
              lastEventId: lastEventIdRef.current ?? 0,
              lastEventCursor: lastEventCursorRef.current,
              skipReplay: false,
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

      // 追踪 eventId / cursor —— 同步写 ref 和 Map（Map 是切会话后 resume 的增量起点）
      if (envelope.eventId != null) {
        lastEventIdRef.current = envelope.eventId;
        const currentSid = sessionIdRef.current;
        if (currentSid) {
          const existing = activeRunsBySession.current.get(currentSid);
          activeRunsBySession.current.set(currentSid, {
            ...(existing ?? { status: 'idle' as const, attached: false }),
            lastEventId: envelope.eventId,
          });
        }
      }
      if (envelope.eventCursor) {
        lastEventCursorRef.current = envelope.eventCursor;
        const currentSid = sessionIdRef.current;
        if (currentSid) {
          const existing = activeRunsBySession.current.get(currentSid);
          activeRunsBySession.current.set(currentSid, {
            ...(existing ?? { status: 'idle' as const, attached: false }),
            lastEventCursor: envelope.eventCursor,
          });
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

        // ② tracking 集合（用于"AI 回复未读"红点,与当前会话无关）
        if (isActiveRuntimeStatus(d.status)) {
          trackedAiReplyStreamsRef.current.add(d.sessionId);
        } else if (isTerminalRuntimeStatus(d.status) && trackedAiReplyStreamsRef.current.delete(d.sessionId)) {
          if (d.status === 'idle' || d.status === 'completed') markUnreadAiReply(d.sessionId);
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
          lastEventCursorRef.current = null;
          wsAttachedRef.current = true;
          setLoading(true);
          dispatchConnection('connect');
          void wsClient.ensureConnectedSend({
            action: 'resume',
            sessionId: data.sessionId,
            lastEventId: 0,
            lastEventCursor: null,
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
        const isMetadata = data.type === 'title_updated' || data.type === 'session_updated'
          || data.type === 'session_deleted' || data.type === 'interaction_resolved'
          || data.type === 'pending_interactions' || data.type === 'voice_transcribed';
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
        onChatRejected: (clientMsgId) => {
          // 服务端拒绝：清 ACK 定时器、从 outbox 移除；bubble 已在 wsEventProcessor 翻 failed
          const t = ackTimersRef.current.get(clientMsgId);
          if (t) { clearTimeout(t); ackTimersRef.current.delete(clientMsgId); }
          outboxRef.current = outboxRef.current.filter(e => e.clientMsgId !== clientMsgId);
          if (pendingNewSessionClientMsgIdRef.current === clientMsgId) pendingNewSessionClientMsgIdRef.current = null;
          newSessionClientMsgIdsRef.current.delete(clientMsgId);
          // 若无其他 inflight 条目，清 loading 让用户能继续发
          if (outboxRef.current.every(e => e.state !== 'acked' && e.state !== 'sending')) {
            wsAttachedRef.current = false;
            setLoading(false);
          }
          // H-2 修复：rejected 后必须推进排队消息，否则 queued 永远卡在 outbox
          flushQueuedHead();
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
        sessionIdRef.current,
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

      if (data.type === 'session_updated' && !data.isNew && trackedAiReplyStreamsRef.current.delete(data.sessionId)) {
        markUnreadAiReply(data.sessionId);
      }

      if (data.type === 'ask_user' || data.type === 'permission_request') {
        markUnreadAiReply(wsLatestSessionIdRef.current.value || sessionIdRef.current);
      } else if (data.type === 'pending_interactions' && data.interactions.length > 0) {
        markUnreadAiReply(wsLatestSessionIdRef.current.value || sessionIdRef.current);
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
        // 仍需清理本轮 acked/sending，并推进排队消息，避免 queued 永远卡在 outbox。
        if (!loadingRef.current) {
          // H-3 修复：done 晚到的路径也要排空 outbox 并推进队列
          outboxRef.current = outboxRef.current.filter(e => e.state === 'queued');
          flushQueuedHead();
          return;
        }
        clearWatchdog();
        dispatchConnection('complete');
        if (latestSid) {
          trackedAiReplyStreamsRef.current.delete(latestSid);
          const doneEvent = data as Extract<WsEvent, { type: 'done' }>;
          if (!doneEvent.error) {
            markUnreadAiReply(latestSid);
          } else {
            // done.error：本轮 run 失败,必须把失败明确地呈现给用户,而不是只静默清 loading。
            // 用户侧通俗文案;原始 doneEvent.error（model error）仅保留在 server.log + PG runtime_events。
            // 协调：shared/wsEventProcessor 在 done 时若所有 user 气泡都已 failed,会注入一条同样
            //   通俗的 text 兜底（mobile 等不支持 system-error 的客户端也能看到）。
            //   web 端要升级成红边 system-error,所以扫尾 N 条找那条 text,有则就地替换、无则追加。
            // dedupe：若最末已是相同 content 的 system-error（重复 done 事件）则跳过。
            const alertContent = formatRuntimeFailureMessage(doneEvent.error);
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
                  severity: 'error',
                  timestamp: Date.now(),
                }));
              } else {
                msgRef.current.addMessage({
                  type: 'system-error',
                  content: alertContent,
                  severity: 'error',
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

        // 从 outbox 移除已处理完的 acked/sending 条目（done 代表这一轮完结）
        outboxRef.current = outboxRef.current.filter(e => e.state === 'queued');

        // 检查排队消息（stopping 时不发排队消息，因为是用户主动中止）
        if (!stoppingRef.current) {
          const nextQueued = outboxRef.current.find(e => e.state === 'queued');
          if (nextQueued) {
            // 从 queued 移除，等 sendChatViaWs 重新入队为 sending
            outboxRef.current = outboxRef.current.filter(e => e.clientMsgId !== nextQueued.clientMsgId);
            void sendChatViaWs(
              nextQueued.input,
              nextQueued.attachments,
              false,
              nextQueued.voiceFile,
              nextQueued.clientMsgId,
              nextQueued.autoApproveRunShell,
            );
          }
        }
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

  /**
   * 在 loading reset 路径（ACK 超时 / chat_rejected / watchdog 后 done 到达）上推进
   * outbox 队列头部——若不调用，queued 消息会永远留在数组里 bubble pending。
   * stopping 状态下跳过（用户主动中止不自动续发）。
   */
  const flushQueuedHead = useCallback(() => {
    if (stoppingRef.current) return;
    const nextQueued = outboxRef.current.find(e => e.state === 'queued');
    if (!nextQueued) return;
    outboxRef.current = outboxRef.current.filter(e => e.clientMsgId !== nextQueued.clientMsgId);
    void sendChatViaWsRef.current?.(
      nextQueued.input,
      nextQueued.attachments,
      false,
      nextQueued.voiceFile,
      nextQueued.clientMsgId,
      nextQueued.autoApproveRunShell,
    );
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
      markBubbleFailed(clientMsgId, -1, '发送超时，请重试');
      // 如果此消息是当前正在等待的 loading 源头，清 loading
      if (loadingRef.current && outboxRef.current.every(e => e.state !== 'acked')) {
        // 仅在没有其他 acked 条目时退出 loading；否则保留继续等 done
        // 保守策略：ACK 超时即视为"这一次失败"，清 loading 让用户能发新消息
        wsAttachedRef.current = false;
        setLoading(false);
      }
      // H-1 修复：ACK 超时路径必须主动推进排队消息，否则 queued 永远卡在 outbox
      flushQueuedHead();
    }, ACK_TIMEOUT_MS);
    ackTimersRef.current.set(clientMsgId, timer);
  }, [markBubbleFailed, flushQueuedHead]);

  // ---- 通过 WS 发送聊天消息 ----
  const sendChatViaWs = useCallback(async (
    inputText: string,
    attachments: UploadedFile[],
    showBubble: boolean,
    voiceFile?: { savedPath: string; relativePath: string; duration: number },
    existingClientMsgId?: string,
    autoApproveRunShellForMessage = autoApproveRunShellRef.current,
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

    wsLatestSessionIdRef.current = { value: activeSessionId };
    wsBlockRef.current = { currentBlockIndex: -1, currentBlockType: null };
    lastEventIdRef.current = null;
        lastEventCursorRef.current = null;
    streamNonceRef.current += 1;
    wsAttachedRef.current = true;

    if (showBubble) {
      msgRef.current.triggerScroll();
      wsUserMsgIndexRef.current = msgRef.current.addMessage({
        type: "user",
        content: inputText,
        ...(attachments.length > 0 ? { attachments: attachments.map(f => ({ name: f.originalName, isImage: f.isImage })) } : {}),
        status: 'pending',
        timestamp: Date.now(),
        clientMsgId,
      });
      // 乐观更新会话列表：preview + 排序即时变化
      if (activeSessionId) {
        sessionRef.current.updateSessionMeta(activeSessionId, {
          preview: inputText.slice(0, 200),
          updatedAtMs: Date.now(),
        });
      }
    } else {
      // 排队/语音消息：将 clientMsgId 绑定到最近那条 pending user/user-voice bubble
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

    upsertRuntimeStatusMessage(msgRef.current, 'sending');
    setLoading(true);
    resetWatchdog();
    dispatchConnection('connect');

    const ok = await wsClient.ensureConnectedSend({
      action: 'chat',
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
          originalName: file.originalName,
          savedPath: file.savedPath,
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
      markBubbleFailed(clientMsgId, wsUserMsgIndexRef.current, '网络连接失败，请重试');
      wsAttachedRef.current = false;
      setLoading(false);
      if (pendingNewSessionClientMsgIdRef.current === clientMsgId) pendingNewSessionClientMsgIdRef.current = null;
      newSessionClientMsgIdsRef.current.delete(clientMsgId);
    } else {
      // 启动 ACK 超时定时器
      armAckTimeout(clientMsgId);
    }
  }, [dispatchConnection, armAckTimeout, markBubbleFailed]);

  // 同步 sendChatViaWs 到 ref，让 flushQueuedHead / armAckTimeout 等前置 callback 可调用
  useEffect(() => { sendChatViaWsRef.current = sendChatViaWs; }, [sendChatViaWs]);

  // ---- 压缩当前会话上下文 ----
  const compactSession = useCallback(async () => {
    const activeSessionId = sessionIdRef.current;
    if (!activeSessionId || loadingRef.current) return;

    wsLatestSessionIdRef.current = { value: activeSessionId };
    wsBlockRef.current = { currentBlockIndex: -1, currentBlockType: null };
    lastEventIdRef.current = null;
        lastEventCursorRef.current = null;
    streamNonceRef.current += 1;
    wsAttachedRef.current = true;
    wsUserMsgIndexRef.current = -1;

    upsertRuntimeStatusMessage(msgRef.current, 'sending');
    setLoading(true);
    resetWatchdog();
    dispatchConnection('connect');

    const ok = await wsClient.ensureConnectedSend({
      action: 'chat',
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
      // 排队：新一条消息入 outbox.queued + 渲染 pending bubble
      const queuedClientMsgId = crypto.randomUUID?.() || `c-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      outboxRef.current.push({
        clientMsgId: queuedClientMsgId,
        input: capturedInput,
        attachments: capturedAttachments,
        ...(autoApproveRunShellRef.current ? { autoApproveRunShell: true } : {}),
        state: 'queued',
        createdAt: Date.now(),
      });
      msgRef.current.triggerScroll();
      msgRef.current.addMessage({
        type: "user",
        content: capturedInput,
        ...(capturedAttachments.length > 0 ? { attachments: capturedAttachments.map(f => ({ name: f.originalName, isImage: f.isImage })) } : {}),
        status: 'pending',
        timestamp: Date.now(),
        clientMsgId: queuedClientMsgId,
      });
      return;
    }

    sendChatViaWs(capturedInput, capturedAttachments, true);
  }, [
    setInput,
    fileUpload.clearFiles,
    sendChatViaWs,
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
  const subscribeToActiveStream = useCallback(async (targetSessionId: string) => {
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

    // 有 cursor → 走增量 replay; 无 cursor → 跳过 replay（transcript 已覆盖历史）
    const shouldSkipReplay = lastEventIdRef.current === null && !lastEventCursorRef.current;

    // 不论 HTTP active 真假都发 resume：
    //   - 让服务端清理旧订阅,绑定新 ws → 当前 stream
    //   - 服务端通过 active_stream 给前端权威信号（全局 reducer 接管）
    //   - 即使 HTTP buffer 误报 inactive,runStore 仍 active 时 active_stream{active:true} 兜底
    const ok = await wsClient.ensureConnectedSend({
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
      void subscribeToActiveStreamRef.current(targetId);
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

  // ---- Retry failed message ----
  // 语义：用户手动点击 retry → **生成新 clientMsgId**，不重用原 id（否则服务端幂等会直接返回旧结果）
  // 传输层自动重试（ACK 超时）复用同 clientMsgId 的逻辑在 sendChatViaWs 内部（当前先不做自动重发）
  const retryMessage = useCallback((message: MessageItem) => {
    if (message.type !== 'user' || message.status !== 'failed') return;
    const msgs = msg.messagesRef.current;
    const idx = msgs.findIndex(m => m.id === message.id);
    if (idx >= 0) {
      // 移除失败 bubble
      msgs.splice(idx, 1);
      msg.setMessages([...msgs], { scrollToBottom: false });
    }
    // 清理该 clientMsgId 的旧 ACK 定时器
    if (message.clientMsgId) {
      const t = ackTimersRef.current.get(message.clientMsgId);
      if (t) { clearTimeout(t); ackTimersRef.current.delete(message.clientMsgId); }
      outboxRef.current = outboxRef.current.filter(e => e.clientMsgId !== message.clientMsgId);
    }
    // 生成新 clientMsgId 重新发送（附件从旧消息元信息无法恢复 savedPath，只能复用文本；保留旧行为）
    const text = typeof message.content === 'string' ? message.content : '';
    if (!text) {
      setInput(text);
      return;
    }
    if (loadingRef.current) {
      // 当前正有 stream 在跑：排队
      setInput("");
      const queuedClientMsgId = crypto.randomUUID?.() || `c-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      outboxRef.current.push({
        clientMsgId: queuedClientMsgId,
        input: text,
        attachments: [],
        ...(autoApproveRunShellRef.current ? { autoApproveRunShell: true } : {}),
        state: 'queued',
        createdAt: Date.now(),
      });
      msg.addMessage({ type: 'user', content: text, status: 'pending', timestamp: Date.now(), clientMsgId: queuedClientMsgId });
    } else {
      setInput("");
      void sendChatViaWs(text, [], true);
    }
  }, [setInput, msg, sendChatViaWs]);

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
    clearUnreadAiReply(sessionIdRef.current);
  }, [respondToInteraction, msg.messagesRef, msg.updateMessageAt, clearUnreadAiReply]);

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
    clearUnreadAiReply(sessionIdRef.current);
  }, [respondToInteraction, msg.messagesRef, msg.updateMessageAt, clearUnreadAiReply]);

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
    platformAdminSection,
    platformAdminEntityId,
    settingsOpen,
    settingsSection,
    uploadedFiles: fileUpload.uploadedFiles,
    uploading: fileUpload.uploading,
    uploadError: fileUpload.uploadError,
    dismissUploadError: fileUpload.dismissUploadError,
    isDragging: fileUpload.isDragging,
    isLoadingSessions: session.isLoadingSessions,
    isLoadingMessages: session.isLoadingMessages,
    deleteSessionId: session.deleteSessionId,
    deleteSessionCount: session.deleteSessionCount,
    lastMessageRef: msg.lastMessageRef,
    scrollContainerRef: msg.scrollContainerRef,
    isNearBottomRef: msg.isNearBottomRef,
    setInput,
    setActiveTab,
    pushActiveTab,
    setPlatformAdminRoute,
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
    unreadAiReplySessionIds,
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

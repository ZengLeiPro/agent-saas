import type { ChangeEvent, ClipboardEvent, DragEvent, RefObject } from "react";
import type { MessageItem, UploadedFile } from "@/components/types";
import type { ApiSessionListItem, TokenUsage } from "@/lib/sessionsApi";
import type { AskUserAnswers, ContextUsageData, MemoryRecallData, NotificationData, PluginInstallData, SessionRuntimeStatus } from "@agent/shared";
import type { AgentProfile, SessionParticipants } from "@agent/shared";
import type { ModelList } from "@/types/models";
import type { AppTab } from "@/types/sidebar";
import type { CanonicalSettingsSectionId, SettingsSectionId } from "@/types/settings";
import type { GovernanceRouteState } from "@/lib/governanceNavigation";
import type { AdminSettingsState, AdminSettingsTarget, PlatformAdminSection, TenantAdminSection } from "@/lib/urlSync";
import type { ConnectionState } from "@/hooks/useConnectionState";
import type { QueuedInterjection } from "@/lib/interjectionConsumption";
import type { TerminalRuntimeStatus } from "./chatRuntimeHelpers";

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
  newSession: (groupId?: string | null) => void;
  selectSession: (id: string) => void;
  /** 企业专家新草稿：不创建服务端会话，首条消息 WS payload 才带上 orgAgentId */
  startOrgAgentSession: (agentId: string, groupId?: string | null) => void;
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
  handleAssetSelect: (paths: string[]) => Promise<void>;
  handlePaste: (event: ClipboardEvent) => Promise<void>;
  sendMessage: () => Promise<void>;
  /** 当前 run 运行时显式插话；普通 sendMessage 始终走串行 queue。 */
  interjectMessage: () => Promise<void>;
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
  /** 活跃会话的精确运行态，供列表区分执行中与人工等待。 */
  sessionRuntimeStatuses: ReadonlyMap<string, SessionRuntimeStatus>;
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

export type SessionRuntime = {
  status: SessionRuntimeStatus | TerminalRuntimeStatus;
  streamId?: string;
  runId?: string;
  lastEventId?: number;
  lastEventCursor?: string | null;
  attached: boolean;
};

export type SessionRuntimePatch = Partial<Omit<SessionRuntime, 'streamId' | 'runId' | 'lastEventId' | 'lastEventCursor'>> & {
  streamId?: string | null;
  runId?: string | null;
  lastEventId?: number | null;
  lastEventCursor?: string | null;
};

export interface OutboxEntry {
  clientMsgId: string;
  sessionId?: string;
  deliveryMode: 'queue' | 'steer';
  input: string;
  attachments: UploadedFile[];
  voiceFile?: { savedPath: string; relativePath: string; duration: number };
  autoApproveRunShell?: boolean;
  preserveActiveStream: boolean;
  state: 'sending' | 'acked';
  createdAt: number;
}

export interface ProvisionalSubmission {
  rootClientMsgId: string;
  clientMsgId: string;
  deliveryMode: 'queue' | 'steer';
  input: string;
  attachments: UploadedFile[];
  autoApproveRunShell: boolean;
}

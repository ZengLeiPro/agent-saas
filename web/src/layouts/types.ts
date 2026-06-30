import type { Ref, MutableRefObject, ChangeEvent, ClipboardEvent } from "react";
import type { ChatSessionIndexItem, AppTab } from "@/types/sidebar";
import type { MessageItem, UploadedFile } from "@/components/types";
import type { TtsProps } from "@/components/MessageItem";
import type { TtsState } from "@/hooks/useTtsPlayer";
import type { ModelList } from "@/types/models";
import type { UseTtsPlayerReturn } from "@/hooks/useTtsPlayer";
import type { TokenUsage } from "@/lib/sessionsApi";
import type { ContextUsageData } from "@agent/shared";
import type { ConnectionState } from "@/hooks/useConnectionState";
import type { AgentProfile, SessionParticipants } from "@agent/shared";
import type { SettingsSectionId } from "@/types/settings";
import type { AdminSettingsState, AdminSettingsTarget } from "@/lib/urlSync";

export interface LayoutProps {
  // 会话导航
  sidebarSessions: ChatSessionIndexItem[];
  /** 完整未读 AI 回复会话集（不受会话分页影响），供 sidebar 计算分组聚合红点 */
  unreadAiReplySessionIds: ReadonlySet<string>;
  sessionId: string | null;
  selectSession: (id: string) => void;
  newSession: () => void;
  confirmDeleteSession: (id: string) => void;
  confirmDeleteSessions: (ids: string[]) => void;
  renameSession: (sessionId: string, newTitle: string) => Promise<boolean>;
  autoTitleSession: (sessionId: string) => Promise<boolean>;
  compactSession: () => Promise<void>;
  isLoadingSessions: boolean;
  activeTab: AppTab;
  setActiveTab: (tab: AppTab) => void;
  /** push 版本的 setActiveTab：浏览器历史会新增一条记录（user menu 跳转用） */
  pushActiveTab: (tab: AppTab) => void;
  settingsOpen: boolean;
  settingsSection: SettingsSectionId;
  openSettings: (section?: SettingsSectionId) => void;
  closeSettings: () => void;
  setSettingsSection: (section: SettingsSectionId) => void;
  /** 组织/平台管理 modal 状态。null = 未打开。 */
  adminSettings: AdminSettingsState | null;
  openAdminSettings: (target: AdminSettingsTarget, section?: string) => void;
  closeAdminSettings: () => void;
  setAdminSettingsSection: (section: string) => void;
  isAdmin: boolean;
  /** 平台 admin（跨组织管理者）。组织管理入口对 admin 可见，平台管理入口仅平台 admin 可见。 */
  isPlatformAdmin: boolean;
  isOnline: boolean;
  connectionState: ConnectionState;

  // 聊天内容
  messages: MessageItem[];
  loading: boolean;
  isLoadingMessages: boolean;
  retryMessage: (message: MessageItem) => void;
  forkFromMessage: (message: MessageItem) => void;
  lastMessageRef: Ref<HTMLDivElement>;
  scrollContainerRef: Ref<HTMLDivElement>;
  isNearBottomRef: MutableRefObject<boolean>;
  handlePermissionResponse: (interactionId: string, allow: boolean) => Promise<void>;
  handleAskUserResponse: (interactionId: string, answers: Record<string, string>) => Promise<void>;
  uploadedFiles: UploadedFile[];
  removeFile: (index: number) => void;
  input: string;
  uploading: boolean;
  uploadError: string | null;
  dismissUploadError: () => void;
  setInput: (value: string) => void;
  sendMessage: () => Promise<void>;
  sendVoiceMessage: (wavBlob: Blob, durationMs: number) => Promise<void>;
  stopping: boolean;
  stopGeneration: () => void;
  handleFileSelect: (event: ChangeEvent<HTMLInputElement>) => Promise<void>;
  handlePaste: (event: ClipboardEvent) => Promise<void>;
  ttsProps: TtsProps | undefined;
  ttsStateMap: Record<string, TtsState>;
  modelList: ModelList | null;
  selectedModel: string | null;
  onModelChange: (ref: string) => void;
  autoApproveRunShell: boolean;
  setAutoApproveRunShell: (checked: boolean) => void;

  // TTS 控制（header 使用）
  ttsPlayer: UseTtsPlayerReturn;

  // Token usage
  tokenUsage: TokenUsage | null;
  contextUsage: ContextUsageData | null;

  // 会话分页
  hasMoreSessions: boolean;
  isLoadingMoreSessions: boolean;
  loadMoreSessions: () => Promise<void>;
  loadGroupSessions: (groupId: string) => Promise<void>;

  // Agent profile
  agentProfile?: AgentProfile | null;

  // Session participants
  sessionParticipants?: SessionParticipants | null;

  // File preview
  previewFilePath: string | null;
  previewFileOwner?: string;
  openFilePreview: (path: string, owner?: string) => void;
  closeFilePreview: () => void;

  // File browser
  fileBrowserOpen: boolean;
  toggleFileBrowser: () => void;
  closeFileBrowser: () => void;

  // Trash preview (admin only)
  isTrashPreview: boolean;
  previewTrashSession: (id: string | null) => void;
  trashPreviewSessionId: string | null;
}

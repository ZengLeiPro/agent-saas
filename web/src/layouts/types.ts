import type { Ref, MutableRefObject, ChangeEvent, ClipboardEvent } from "react";
import type { ChatSessionIndexItem, AppTab } from "@/types/sidebar";
import type { MessageItem, UploadedFile } from "@/components/types";
import type { TtsProps } from "@/components/MessageItem";
import type { TtsState } from "@/hooks/useTtsPlayer";
import type { ModelList } from "@/types/models";
import type { UseTtsPlayerReturn } from "@/hooks/useTtsPlayer";
import type { TokenUsage } from "@/lib/sessionsApi";
import type { AgentTargetUnavailableReason, AskUserAnswers, ContextUsageData } from "@agent/shared";
import type { ConnectionState } from "@/hooks/useConnectionState";
import type { AgentProfile, OrgAgentSummary, SessionParticipants } from "@agent/shared";
import type { SettingsSectionId } from "@/types/settings";
import type { AdminSettingsState, AdminSettingsTarget } from "@/lib/urlSync";
import type { QueuedInterjection } from "@/hooks/useChatAppState";
import type { PlatformAdminSection, TenantAdminSection } from "@/lib/urlSync";
import type { GovernanceRouteState } from "@/lib/governanceNavigation";
import type { SandboxProfile } from "@/types/sandboxProfile";
import type { ArtifactPreviewTarget } from "@/contexts/FilePreviewContext";
import type { AutomationControlRequest, AutomationTimelineEvent, SessionAutomationSnapshot } from "@/lib/sessionAutomation";

export interface LayoutProps {
  // 会话导航
  sidebarSessions: ChatSessionIndexItem[];
  sessionId: string | null;
  selectSession: (id: string) => void;
  newSession: (groupId?: string | null) => void;
  /** 明确开始个人通用 Agent 草稿（任务模板只走此路径） */
  newPersonalSession: () => void;
  /** 企业专家新草稿：首条消息才创建会话并绑定 orgAgentId */
  startOrgAgentSession: (agentId: string, groupId?: string | null) => void;
  /** 当前会话绑定的企业专家（含草稿态）；null = 个人通用 Agent 会话 */
  activeOrgAgent: OrgAgentSummary | null;
  /** 当前会话 target 不可用时输入区只读。 */
  activeOrgAgentReadOnly: boolean;
  /** 当前登录人仅有会话查看权，不得在该会话中交互。 */
  sessionReadOnly: boolean;
  /** 服务端投影的结构化只读原因。 */
  activeAgentTargetUnavailableReason?: AgentTargetUnavailableReason;
  /** Header label derived only from persisted/pending canonical target. */
  activeAgentTargetLabel?: string;
  /** 当前用户被指派且启用的企业专家列表。 */
  myOrgAgents: OrgAgentSummary[];
  /** 当前用户是否可使用个人通用 Agent（admin 始终为 true） */
  personalAgentEnabled: boolean;
  /** 个人 Agent 关闭时，企业专家/会话元数据仍在加载；此阶段不得回退展示个人 Agent 身份。 */
  orgAgentIdentityLoading: boolean;
  confirmDeleteSession: (id: string) => void;
  confirmDeleteSessions: (ids: string[]) => void;
  renameSession: (sessionId: string, newTitle: string) => Promise<boolean>;
  autoTitleSession: (sessionId: string) => Promise<boolean>;
  compactSession: () => Promise<void>;
  isLoadingSessions: boolean;
  activeTab: AppTab;
  governanceRoute: GovernanceRouteState | null;
  platformAdminSection: PlatformAdminSection;
  platformAdminEntityId: string | null;
  /** 组织分析当前页签（来自 URL 路径，刷新/分享可保留） */
  tenantAdminSection: TenantAdminSection;
  /** 切换组织分析页签（push 历史） */
  setTenantAdminRoute: (section: string) => void;
  setActiveTab: (tab: AppTab) => void;
  /** push 版本的 setActiveTab：浏览器历史会新增一条记录（user menu 跳转用） */
  pushActiveTab: (tab: AppTab) => void;
  setPlatformAdminRoute: (section: PlatformAdminSection, entityId?: string | null) => void;
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
  /** null = 首屏尚未完成权威探活；不得冒充离线。 */
  isOnline: boolean | null;
  connectionState: ConnectionState;

  // 聊天内容
  messages: MessageItem[];
  loading: boolean;
  isLoadingMessages: boolean;
  sessionLoadError: string | null;
  retrySessionLoad: () => void;
  hasMoreHistory: boolean;
  isLoadingEarlier: boolean;
  loadEarlierMessages: () => Promise<void>;
  retryMessage: (message: MessageItem) => void;
  forkFromMessage: (message: MessageItem) => void;
  lastMessageRef: Ref<HTMLDivElement>;
  scrollContainerRef: Ref<HTMLDivElement>;
  isNearBottomRef: MutableRefObject<boolean>;
  handlePermissionResponse: (interactionId: string, allow: boolean) => Promise<void>;
  handleAskUserResponse: (interactionId: string, answers: AskUserAnswers) => Promise<void>;
  uploadedFiles: UploadedFile[];
  removeFile: (index: number) => void;
  input: string;
  sandboxProfile: SandboxProfile;
  setSandboxProfile: (profile: SandboxProfile) => void;
  uploading: boolean;
  uploadError: string | null;
  dismissUploadError: () => void;
  setInput: (value: string) => void;
  sendMessage: () => Promise<void>;
  sendVoiceMessage: (wavBlob: Blob, durationMs: number) => Promise<void>;
  stopping: boolean;
  stopGeneration: () => void;
  /** 运行中发送的补充消息队列。 */
  queuedInterjections: QueuedInterjection[];
  cancelQueuedInterjection: (clientMsgId: string) => Promise<boolean>;
  editQueuedInterjection: (clientMsgId: string) => Promise<void>;
  resendQueuedInterjection: (clientMsgId: string) => void;
  dismissQueuedInterjection: (clientMsgId: string) => void;
  handleFileSelect: (event: ChangeEvent<HTMLInputElement>) => Promise<void>;
  handleAssetSelect: (paths: string[]) => Promise<void>;
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

  // Session automation control plane
  automation: SessionAutomationSnapshot | null;
  automationTimeline: AutomationTimelineEvent[];
  automationPending: boolean;
  automationError: string | null;
  controlAutomation: (request: AutomationControlRequest) => Promise<void>;
  refreshAutomation: (sessionId?: string | null) => Promise<void>;

  // 会话分页
  hasMoreSessions: boolean;
  isLoadingMoreSessions: boolean;
  loadMoreSessions: () => Promise<void>;
  loadGroupSessions: (groupId: string) => Promise<void>;

  // Agent profile
  agentProfile?: AgentProfile | null;

  // Session participants（用于展示跨用户只读会话的实际 owner）
  sessionParticipants?: SessionParticipants | null;

  // File preview
  previewFilePath: string | null;
  previewFileOwner?: string;
  previewMode: "dialog" | "side";
  openFilePreview: (path: string, owner?: string, options?: { mode?: "dialog" | "side" }) => void;
  dockFilePreview: () => void;
  expandFilePreview: () => void;
  closeFilePreview: () => void;
  previewArtifact: ArtifactPreviewTarget | null;
  closeArtifactPreview: () => void;

  // File browser
  fileBrowserOpen: boolean;
  toggleFileBrowser: () => void;
  closeFileBrowser: () => void;

  // Trash preview (admin only)
  isTrashPreview: boolean;
  previewTrashSession: (id: string | null) => void;
  trashPreviewSessionId: string | null;
}

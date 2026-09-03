import type { ManagementSettingsAccess } from '@/hooks/useManagementSettingsAccess';
import type { GovernanceRouteState } from '@/lib/governanceNavigation';
import type { AdminSettingsTarget } from '@/lib/urlSync';
import type { AppTab, ChatSessionIndexItem } from '@/types/sidebar';
import type { SettingsSectionId } from '@/types/settings';

export interface DesktopSessionSidebarProps {
  sessions: ChatSessionIndexItem[];
  activeSessionId: string | null;
  onSelect: (sessionId: string) => void;
  onNew: (groupId?: string | null) => void;
  onDelete?: (sessionId: string) => void;
  onDeleteMany?: (sessionIds: string[]) => void;
  onRename?: (sessionId: string, newTitle: string) => Promise<boolean>;
  onAutoTitle?: (sessionId: string) => Promise<boolean>;
  onCompact?: () => Promise<void>;
  isLoading?: boolean;
  className?: string;
  activeTab?: AppTab;
  onTabChange?: (tab: AppTab) => void;
  onOpenSettings?: (section?: SettingsSectionId) => void;
  onOpenAnalysis?: () => void;
  /** 统一分析模式与设置模式一样，会替换整块主侧边栏。 */
  analysisMode?: boolean;
  analysisRoute?: GovernanceRouteState | null;
  onAnalysisNavigate?: (routeId: string) => void;
  onCloseAnalysis?: () => void;
  /** 统一设置模式会替换整块主侧边栏，而不是再打开一层弹窗。 */
  settingsMode?: boolean;
  settingsTarget?: 'personal' | AdminSettingsTarget;
  activeSettingsSection?: string;
  onSettingsNavigate?: (target: 'personal' | AdminSettingsTarget, section: string) => void;
  onCloseSettings?: () => void;
  isAdmin?: boolean;
  settingsAccess?: ManagementSettingsAccess;
  /** 平台 admin（跨组织管理者）。组织管理入口对 admin 可见，平台管理入口仅平台 admin 可见。 */
  isPlatformAdmin?: boolean;
  hasMore?: boolean;
  isLoadingMore?: boolean;
  onLoadMore?: () => void;
  onLoadGroupSessions?: (groupId: string) => Promise<void>;
  hidden?: boolean;
  /** 收起侧边栏（入口在侧边栏 header；收起后展开入口回到内容区 header） */
  onCollapse?: () => void;
  onPreviewTrashSession?: (id: string | null) => void;
  trashPreviewSessionId?: string | null;
  sidebarLayout?: 'double' | 'single';
  personalAgentEnabled?: boolean;
  responsiveMode?: 'none' | 'secondary-hidden' | 'hidden';
}

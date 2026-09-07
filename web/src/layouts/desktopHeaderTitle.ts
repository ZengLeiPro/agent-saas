import type { MySystemState } from '@/lib/systemsApi';
import type { LayoutProps } from './types';

const TAB_TITLES: Partial<Record<LayoutProps['activeTab'], string>> = {
  profile: '我的 Agent',
  capabilities: '能力中心',
  scenarios: '任务模板',
  cron: '任务中心',
  tenants: '组织分析',
  'tenant-admin': '组织分析',
  'platform-admin': '平台分析',
  skills: '技能管理',
  usage: 'Token 用量',
  mcp: 'MCP 配置',
  models: '模型管理',
  trash: '回收站',
};

/** 业务系统标签在拿到《系统名》之前的占位；拿不到名字总比显示上一段会话标题好。 */
export const APPS_TAB_FALLBACK_TITLE = '业务系统';
/** §6.6：系统被停用 / `live` 失败 → 标签「暂不可用」（不写技术归因）。 */
export const APPS_TAB_UNAVAILABLE_TITLE = '暂不可用';

/**
 * 业务系统标签的 header 标题。
 *
 * §5.5/§6.6 的关键点：停用**不是**把标签拿掉，而是「标签保留 +《系统名》+ 暂不可用」。
 * 服务端现在会把停用实例连同 `state` 一起返回，所以这里能同时给出名字与标注。
 * 「更新中」不加标注：那一档 §6.6 给的是条幅，header 保持《系统名》。
 */
export function buildAppsHeaderTitle(input: {
  name: string | null | undefined;
  state: MySystemState | null | undefined;
  /** `/api/systems/mine` 是否已就绪；未就绪时不要提前下「暂不可用」的结论。 */
  resolved: boolean;
}): string | null {
  const name = (input.name ?? '').trim();
  const unavailable = input.state === 'disabled' || input.state === 'unavailable';
  if (name !== '') return unavailable ? `${name} · ${APPS_TAB_UNAVAILABLE_TITLE}` : name;
  // 名字都拿不到 = 查无此实例（已删除 / 不再对本人可见）
  return input.resolved ? APPS_TAB_UNAVAILABLE_TITLE : null;
}

interface DesktopHeaderTitleOptions {
  activeTab: LayoutProps['activeTab'];
  isTrashPreview: boolean;
  sidebarSessions: LayoutProps['sidebarSessions'];
  sessionId: string | null;
  activeAgentTargetLabel?: string;
  activeOrgAgent: LayoutProps['activeOrgAgent'];
  orgAgentIdentityLoading: boolean;
  agentProfile: LayoutProps['agentProfile'];
  /**
   * 业务系统标签的标题（§6.6 的《系统名》或「暂不可用」）。
   * 不放进 `TAB_TITLES`：那是 `Record<AppTab, string>` 的静态映射，而业务系统
   * 每个安装实例一个名字，只有调用方拿到 `/api/systems/mine` 才知道。
   */
  appsTitle?: string | null;
}

export function getDesktopHeaderTitle({
  activeTab,
  isTrashPreview,
  sidebarSessions,
  sessionId,
  activeAgentTargetLabel,
  activeOrgAgent,
  orgAgentIdentityLoading,
  agentProfile,
  appsTitle,
}: DesktopHeaderTitleOptions): string {
  if (activeTab === 'apps') return appsTitle || APPS_TAB_FALLBACK_TITLE;
  const tabTitle = TAB_TITLES[activeTab];
  if (tabTitle) return tabTitle;
  if (isTrashPreview) return '回收站预览';
  const session = sidebarSessions.find((item) => item.id === sessionId);
  const sessionTitle = session?.title;
  // TASK-397：个人 Agent 是默认身份，「 · 个人 Agent」后缀对会话标题是冗余信息；
  // 企业专家名与「绑定不可验证」状态后缀仍然保留。
  if (sessionTitle && activeAgentTargetLabel && session?.agentTarget?.kind !== 'personal') {
    return `${sessionTitle} · ${activeAgentTargetLabel}`;
  }
  return sessionTitle
    || activeAgentTargetLabel
    || activeOrgAgent?.name
    || (orgAgentIdentityLoading ? '企业专家' : agentProfile?.name)
    || 'KY Agent';
}

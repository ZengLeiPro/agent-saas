import type { AgentProfile } from './agent';
import type { AgentTarget, AgentTargetIdentitySnapshot, AgentTargetUnavailableReason } from '../lib/agentTarget';

export type SessionRuntimeStatus =
  | 'busy'
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'waiting_user'
  | 'waiting_hand';

export function getSessionWaitingLabel(status?: SessionRuntimeStatus): string | null {
  if (status === 'waiting_user') return '待补充';
  if (status === 'waiting_approval') return '待处理';
  return null;
}

export function getGroupWaitingRuntimeStatus(
  sessions: ReadonlyArray<{ runtimeStatus?: SessionRuntimeStatus }>,
): Extract<SessionRuntimeStatus, 'waiting_approval' | 'waiting_user'> | undefined {
  if (sessions.some((session) => session.runtimeStatus === 'waiting_approval')) return 'waiting_approval';
  if (sessions.some((session) => session.runtimeStatus === 'waiting_user')) return 'waiting_user';
  return undefined;
}

/** Frontend session list item (adapted from API response) */
export interface ChatSessionIndexItem {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  preview?: string;
  hasUnreadAiReply?: boolean;
  /** 当前会话是否处于活跃 run，列表排序与运行指示器使用。 */
  isRunning?: boolean;
  /** 活跃 run 的精确状态；人工等待时用文本替代运行转圈。 */
  runtimeStatus?: SessionRuntimeStatus;
  source?: { type: "web" | "dingtalk" | "cron"; label: string };
  owner?: { userId: string; username: string; realName?: string; avatar?: string; avatarVersion?: number };
  agent?: AgentProfile | null;
  cronJobId?: string;
  cronJobName?: string;
  /** 公司级专职 Agent 绑定（2026-07 唯恩批次）；缺省 = 个人 Agent 会话 */
  orgAgentId?: string;
  /** 专职 Agent 名称（列表行徽标展示用） */
  orgAgentName?: string;
  /** 当前登录用户是否仍可续聊该专职 Agent 会话 */
  orgAgentAvailable?: boolean;
  /** M20-06 persisted target; absence is not equivalent to personal. */
  agentTarget?: AgentTarget;
  agentTargetSnapshot?: AgentTargetIdentitySnapshot;
  agentTargetUnavailableReason?: AgentTargetUnavailableReason;
}

/**
 * `apps` = 定制软件标签（WP4，规范 §5）。它**不进 `baseNavItems`**：
 * 定制软件是「每个安装实例一项」，条目要靠 `GET /api/systems/mine` 在 web 侧本地拼，
 * 且移动端按 §10 显式排除。放进 baseNavItems 会让 mobile 也长出入口。
 */
export type AppTab = "chat" | "capabilities" | "scenarios" | "cron" | "tenants" | "tenant-admin" | "platform-admin" | "files" | "profile" | "skills" | "usage" | "mcp" | "models" | "settings" | "trash" | "apps";

export interface SidebarNavItem {
  tab: AppTab;
  label: string;
  adminOnly?: boolean;
  personalAgentOnly?: boolean;
}

export const baseNavItems: SidebarNavItem[] = [
  { tab: "capabilities", label: "能力中心" },
  { tab: "cron", label: "任务中心", personalAgentOnly: true },
];

export function getSidebarNavItems({
  isAdmin,
  personalAgentEnabled,
}: {
  isAdmin: boolean;
  personalAgentEnabled: boolean;
}): SidebarNavItem[] {
  return baseNavItems.filter(
    (item) =>
      (!item.adminOnly || isAdmin) &&
      (!item.personalAgentOnly || personalAgentEnabled),
  );
}

export function formatShortDate(ts: number): string {
  try {
    const now = Date.now();
    const diff = now - ts;
    const d = new Date(ts);
    const today = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");

    if (diff < 60_000) return "刚刚";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;

    if (
      d.getFullYear() === today.getFullYear() &&
      d.getMonth() === today.getMonth() &&
      d.getDate() === today.getDate()
    ) {
      return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;

    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    if (
      d.getFullYear() === yesterday.getFullYear() &&
      d.getMonth() === yesterday.getMonth() &&
      d.getDate() === yesterday.getDate()
    ) {
      return `昨天 ${time}`;
    }

    if (diff < 7 * 86_400_000) {
      const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
      return `${weekdays[d.getDay()]} ${time}`;
    }

    if (d.getFullYear() === today.getFullYear()) {
      return `${d.getMonth() + 1}/${d.getDate()} ${time}`;
    }

    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${time}`;
  } catch {
    return "";
  }
}

export function sourceDisplayText(source?: ChatSessionIndexItem["source"]): string {
  if (!source) return "Web 会话";
  return source.label;
}

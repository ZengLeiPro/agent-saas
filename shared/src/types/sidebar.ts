import type { AgentProfile } from './agent';

/** Frontend session list item (adapted from API response) */
export interface ChatSessionIndexItem {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  preview?: string;
  hasUnreadAiReply?: boolean;
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
}

export type AppTab = "chat" | "capabilities" | "scenarios" | "cron" | "tenants" | "tenant-admin" | "platform-admin" | "files" | "profile" | "skills" | "usage" | "mcp" | "models" | "settings" | "trash";

export interface SidebarNavItem {
  tab: AppTab;
  label: string;
  adminOnly?: boolean;
  personalAgentOnly?: boolean;
}

export const baseNavItems: SidebarNavItem[] = [
  { tab: "capabilities", label: "能力中心" },
  { tab: "cron", label: "定时任务", personalAgentOnly: true },
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

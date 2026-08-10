import { Bot, HardDrive, Link2, MessageSquare, Palette, User } from "lucide-react";

import { EntityIcons } from "@/lib/icons";
import type { SettingsSectionConfig, SettingsSectionGroup } from "@/types/settings";

export const SETTINGS_SECTIONS: SettingsSectionConfig[] = [
  { id: "account-security", label: "账户与安全", description: "账号资料、安全和登录状态。", group: "personal", icon: User },
  { id: "my-agent", label: "我的 Agent", description: "资料、Persona 与长期 Memory。", group: "personal", icon: Bot },
  { id: "chat-model", label: "对话与模型", description: "默认模型与对话展示偏好。", group: "preferences", icon: MessageSquare },
  { id: "appearance-layout", label: "外观与布局", description: "侧边栏、会话列表和界面偏好。", group: "preferences", icon: Palette },
  { id: "my-permissions", label: "我的权限", description: "服务端权威有效资源与权限解释。", group: "access", icon: EntityIcons.admin },
  { id: "connections", label: "连接与授权", description: "长期账号授权与运行时工具批准。", group: "access", icon: Link2 },
  { id: "files-storage", label: "文件与存储", description: "浏览文件、查看用量并清理附件。", group: "data", icon: HardDrive },
  { id: "trash", label: "回收站", description: "恢复或彻底清理已删除会话。", group: "data", icon: EntityIcons.trash },
];

export const SETTINGS_GROUP_LABELS: Record<SettingsSectionGroup, string> = {
  personal: "个人",
  preferences: "偏好",
  access: "访问",
  data: "数据",
};

import type { LucideIcon } from "lucide-react";

import { EntityIcons } from "@/lib/icons";

export interface AdminSettingsNavigationItem<T extends string> {
  id: T;
  label: string;
  icon: LucideIcon;
}

export type TenantSettingsSectionId =
  | "users"
  | "skills"
  | "org-agents"
  | "mcp"
  | "connector-dictionary"
  | "billing"
  | "files"
  | "company"
  | "instructions"
  | "settings";

export type PlatformSettingsSectionId =
  | "tenants"
  | "signup"
  | "models"
  | "billing"
  | "remote-hands"
  | "tool-controls"
  | "connector-dictionary"
  | "agent-profiles"
  | "system-prompts"
  | "memory-polling"
  | "global-mcp"
  | "skill-pool"
  | "egress"
  | "system";

export const TENANT_SETTINGS_SECTIONS: AdminSettingsNavigationItem<TenantSettingsSectionId>[] = [
  { id: "users", label: "成员", icon: EntityIcons.members },
  { id: "skills", label: "技能", icon: EntityIcons.skill },
  { id: "org-agents", label: "组织智能体", icon: EntityIcons.expert },
  { id: "mcp", label: "连接器", icon: EntityIcons.connector },
  { id: "connector-dictionary", label: "连接器映射", icon: EntityIcons.connector },
  { id: "billing", label: "计费", icon: EntityIcons.billing },
  { id: "files", label: "文件与数据", icon: EntityIcons.files },
  { id: "company", label: "公司信息", icon: EntityIcons.companyInfo },
  { id: "instructions", label: "自定义规则", icon: EntityIcons.tenantInstructions },
  { id: "settings", label: "组织管理", icon: EntityIcons.org },
];

export const PLATFORM_SETTINGS_SECTIONS: AdminSettingsNavigationItem<PlatformSettingsSectionId>[] = [
  { id: "tenants", label: "组织", icon: EntityIcons.org },
  { id: "signup", label: "注册管理", icon: EntityIcons.signup },
  { id: "models", label: "模型", icon: EntityIcons.model },
  { id: "billing", label: "计费", icon: EntityIcons.billing },
  { id: "remote-hands", label: "执行环境池", icon: EntityIcons.runtimePool },
  { id: "tool-controls", label: "工具开关", icon: EntityIcons.toolControls },
  { id: "connector-dictionary", label: "连接器映射", icon: EntityIcons.connector },
  { id: "agent-profiles", label: "系统智能体", icon: EntityIcons.runtimePool },
  { id: "system-prompts", label: "系统提示语", icon: EntityIcons.systemPrompts },
  { id: "memory-polling", label: "记忆轮询", icon: EntityIcons.memoryPolling },
  { id: "global-mcp", label: "全局 MCP", icon: EntityIcons.connector },
  { id: "skill-pool", label: "技能池", icon: EntityIcons.skill },
  { id: "egress", label: "网络出口", icon: EntityIcons.egress },
  { id: "system", label: "系统配置", icon: EntityIcons.systemConfig },
];

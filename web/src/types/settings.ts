import type { LucideIcon } from "lucide-react";

export type SettingsSectionId =
  | "account"
  | "general"
  | "personalization"
  | "all-agents"
  | "memory"
  | "skills"
  | "mcp"
  | "files"
  | "storage"
  | "data";

export type SettingsSectionGroup = "account" | "features";

export interface SettingsSectionConfig {
  id: SettingsSectionId;
  label: string;
  description: string;
  group: SettingsSectionGroup;
  icon: LucideIcon;
  adminOnly?: boolean;
  platformAdminOnly?: boolean;
}

import type { LucideIcon } from "lucide-react";

/** V2 personal-settings page ids. Each id maps one-to-one to a canonical /settings URL. */
export type CanonicalSettingsSectionId =
  | "account-security"
  | "my-agent"
  | "chat-model"
  | "appearance-layout"
  | "my-permissions"
  | "connections"
  | "files-storage"
  | "trash";

/** Accepted only at legacy URL/helper and existing caller boundaries. */
export type LegacySettingsSectionId =
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

export type SettingsSectionId = CanonicalSettingsSectionId | LegacySettingsSectionId;
export type SettingsSectionInput = SettingsSectionId;
export type MyAgentSettingsTab = "agent-profile" | "persona" | "memory";

export type SettingsSectionGroup = "personal" | "preferences" | "access" | "data";

export interface SettingsSectionConfig {
  id: CanonicalSettingsSectionId;
  label: string;
  description: string;
  group: SettingsSectionGroup;
  icon: LucideIcon;
}

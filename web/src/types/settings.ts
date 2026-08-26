import type { LucideIcon } from "lucide-react";

import type {
  PersonalSettingsGroup,
  PersonalSettingsSectionId,
} from "@/lib/unifiedSettingsRegistry";

/** V2 personal-settings page ids. Each id maps one-to-one to a canonical /settings URL. */
export type CanonicalSettingsSectionId = PersonalSettingsSectionId;

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
export type MyAgentSettingsTab = "agent-profile" | "memory";

export type SettingsSectionGroup = PersonalSettingsGroup;

export interface SettingsSectionConfig {
  id: CanonicalSettingsSectionId;
  label: string;
  description: string;
  group: SettingsSectionGroup;
  icon: LucideIcon;
}

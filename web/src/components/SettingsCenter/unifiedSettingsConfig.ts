import type { LucideIcon } from "lucide-react";

import { EntityIcons } from "@/lib/icons";
import {
  settingsSectionsForScope,
  type PlatformSettingsIconKey,
  type PlatformSettingsSectionId,
  type TenantSettingsIconKey,
  type TenantSettingsSectionId,
} from "@/lib/unifiedSettingsRegistry";

export type { PlatformSettingsSectionId, TenantSettingsSectionId } from "@/lib/unifiedSettingsRegistry";

export interface AdminSettingsNavigationItem<T extends string> {
  id: T;
  label: string;
  icon: LucideIcon;
}

const TENANT_SETTINGS_ICONS: Record<TenantSettingsIconKey, LucideIcon> = {
  members: EntityIcons.members,
  skill: EntityIcons.skill,
  expert: EntityIcons.expert,
  connector: EntityIcons.connector,
  billing: EntityIcons.billing,
  files: EntityIcons.files,
  "company-info": EntityIcons.companyInfo,
  "tenant-instructions": EntityIcons.tenantInstructions,
  org: EntityIcons.org,
};

const PLATFORM_SETTINGS_ICONS: Record<PlatformSettingsIconKey, LucideIcon> = {
  org: EntityIcons.org,
  signup: EntityIcons.signup,
  model: EntityIcons.model,
  billing: EntityIcons.billing,
  "runtime-pool": EntityIcons.runtimePool,
  "tool-controls": EntityIcons.toolControls,
  connector: EntityIcons.connector,
  "system-prompts": EntityIcons.systemPrompts,
  "memory-polling": EntityIcons.memoryPolling,
  skill: EntityIcons.skill,
  egress: EntityIcons.egress,
  "system-config": EntityIcons.systemConfig,
};

export const TENANT_SETTINGS_SECTIONS: AdminSettingsNavigationItem<TenantSettingsSectionId>[] =
  settingsSectionsForScope("tenant").map((entry) => ({
    id: entry.id,
    label: entry.label,
    icon: TENANT_SETTINGS_ICONS[entry.iconKey],
  }));

export const PLATFORM_SETTINGS_SECTIONS: AdminSettingsNavigationItem<PlatformSettingsSectionId>[] =
  settingsSectionsForScope("platform").map((entry) => ({
    id: entry.id,
    label: entry.label,
    icon: PLATFORM_SETTINGS_ICONS[entry.iconKey],
  }));

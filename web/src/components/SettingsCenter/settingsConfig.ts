import { Bot, HardDrive, MessageSquare, Palette, Sparkles, User, type LucideIcon } from "lucide-react";

import { EntityIcons } from "@/lib/icons";
import {
  settingsSectionsForScope,
  type PersonalSettingsIconKey,
} from "@/lib/unifiedSettingsRegistry";
import type { SettingsSectionConfig, SettingsSectionGroup } from "@/types/settings";

const PERSONAL_SETTINGS_ICONS: Record<PersonalSettingsIconKey, LucideIcon> = {
  user: User,
  bot: Bot,
  "message-square": MessageSquare,
  sparkles: Sparkles,
  palette: Palette,
  admin: EntityIcons.admin,
  "hard-drive": HardDrive,
  trash: EntityIcons.trash,
};

export const SETTINGS_SECTIONS: SettingsSectionConfig[] = settingsSectionsForScope("personal").map((entry) => ({
  id: entry.id,
  label: entry.label,
  description: entry.description,
  group: entry.group,
  icon: PERSONAL_SETTINGS_ICONS[entry.iconKey],
}));

export const SETTINGS_GROUP_LABELS: Record<SettingsSectionGroup, string> = {
  personal: "个人",
  preferences: "偏好",
  access: "访问",
  data: "数据",
};

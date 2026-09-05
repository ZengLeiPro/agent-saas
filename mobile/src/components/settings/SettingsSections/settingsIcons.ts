/**
 * 个人设置分区图标映射 —— 与 Web `SettingsCenter/settingsConfig.ts` 的
 * `PERSONAL_SETTINGS_ICONS` 一一对应（Web 用 lucide-react，这里用
 * lucide-react-native 的同名图标）。
 *
 * 说明：这些是「设置分区」专用图标，Web 同样没有把它们收进 `lib/icons.ts`
 * 的 EntityIcons 注册表，本文件保持与 Web 相同的分层。
 */
import { Bot, HardDrive, Link2, MessageSquare, Palette, User } from 'lucide-react-native';
import type { LucideIcon } from 'lucide-react-native';

import { EntityIcons } from '../../../lib/icons';
import type { PersonalSettingsIconKey } from '../../../lib/settings/personalSettingsSections';

export const PERSONAL_SETTINGS_ICONS: Record<PersonalSettingsIconKey, LucideIcon> = {
  user: User,
  bot: Bot,
  'message-square': MessageSquare,
  palette: Palette,
  admin: EntityIcons.admin,
  link: Link2,
  'hard-drive': HardDrive,
  trash: EntityIcons.trash,
};

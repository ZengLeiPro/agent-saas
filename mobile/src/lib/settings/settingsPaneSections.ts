/**
 * Settings sections that can render as an md+ detail pane body
 * (reuse existing stack screens; trash stays a sheet).
 */
import type { PersonalSettingsSectionId } from './personalSettingsSections';

export const SETTINGS_PANE_SECTION_IDS = [
  'account-security',
  'my-agent',
  'chat-model',
  'appearance-layout',
  'files-storage',
  'my-permissions',
] as const satisfies readonly PersonalSettingsSectionId[];

export type SettingsPaneSectionId = (typeof SETTINGS_PANE_SECTION_IDS)[number];

export function isSettingsPaneSection(id: PersonalSettingsSectionId): id is SettingsPaneSectionId {
  return (SETTINGS_PANE_SECTION_IDS as readonly string[]).includes(id);
}

/**
 * md+ settings detail pane — reuses existing `app/settings/*` screen components
 * as in-pane bodies (phone keeps stack push to the same routes).
 */
import React from 'react';
import { View } from 'react-native';
import type { SettingsPaneSectionId } from '../../../src/lib/settings/settingsPaneSections';
import AccountSecurityScreen from '../../settings/account-security';
import MyAgentSettingsScreen from '../../settings/my-agent';
import ChatModelSettingsScreen from '../../settings/chat-model';
import AppearanceLayoutSettingsScreen from '../../settings/appearance-layout';
import FilesStorageSettingsScreen from '../../settings/files-storage';
import MyPermissionsScreen from '../../settings/my-permissions';

const PANE_BODIES: Record<SettingsPaneSectionId, React.ComponentType> = {
  'account-security': AccountSecurityScreen,
  'my-agent': MyAgentSettingsScreen,
  'chat-model': ChatModelSettingsScreen,
  'appearance-layout': AppearanceLayoutSettingsScreen,
  'files-storage': FilesStorageSettingsScreen,
  'my-permissions': MyPermissionsScreen,
};

export function SettingsPaneDetail({ sectionId }: { sectionId: SettingsPaneSectionId }) {
  const Body = PANE_BODIES[sectionId];
  return (
    <View style={{ flex: 1 }} testID={`settings-pane-${sectionId}`}>
      <Body />
    </View>
  );
}

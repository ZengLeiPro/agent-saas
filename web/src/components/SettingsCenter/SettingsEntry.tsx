import { SettingsDirtyBoundary } from "@/components/PersonalSettings/dirtyRegistry";
import { SettingsModalInner, type SettingsModalProps } from "@/components/SettingsCenter/SettingsModal";

export function SettingsModal(props: SettingsModalProps) {
  return (
    <SettingsDirtyBoundary>
      {(dirtyController) => <SettingsModalInner {...props} dirtyController={dirtyController} />}
    </SettingsDirtyBoundary>
  );
}

export function SettingsContent(props: SettingsModalProps) {
  return (
    <SettingsDirtyBoundary>
      {(dirtyController) => <SettingsModalInner {...props} dirtyController={dirtyController} embedded />}
    </SettingsDirtyBoundary>
  );
}

import { SettingsDirtyBoundary, type SettingsDirtyController } from "@/components/PersonalSettings/dirtyRegistry";
import { SettingsModalInner, type SettingsModalProps } from "@/components/SettingsCenter/SettingsModal";

export function SettingsModal(props: SettingsModalProps) {
  return (
    <SettingsDirtyBoundary>
      {(dirtyController) => <SettingsModalInner {...props} dirtyController={dirtyController} />}
    </SettingsDirtyBoundary>
  );
}

export function SettingsContent({
  dirtyController,
  ...props
}: SettingsModalProps & { dirtyController?: SettingsDirtyController }) {
  if (dirtyController) return <SettingsModalInner {...props} dirtyController={dirtyController} embedded />;
  return (
    <SettingsDirtyBoundary>
      {(controller) => <SettingsModalInner {...props} dirtyController={controller} embedded />}
    </SettingsDirtyBoundary>
  );
}

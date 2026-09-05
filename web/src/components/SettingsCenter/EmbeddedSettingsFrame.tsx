import type { ReactNode } from "react";

import { ChangePasswordDialog } from "@/components/ChangePasswordDialog";
import {
  SETTINGS_CONTENT_WIDTH,
  SettingsPanelHeaderStickyProvider,
} from "@/components/SettingsCenter/SettingsPanelHeader";

export function EmbeddedSettingsFrame({
  content,
  showPasswordDialog,
  onShowPasswordDialogChange,
  avatarUploading,
}: {
  content: ReactNode;
  showPasswordDialog: boolean;
  onShowPasswordDialogChange: (open: boolean) => void;
  avatarUploading: boolean;
}) {
  return (
    <div className="h-full overflow-y-auto bg-card p-4 md:p-8 md:pt-5" data-testid="personal-settings-content">
      <div className={`${SETTINGS_CONTENT_WIDTH} min-h-full`}>
        <SettingsPanelHeaderStickyProvider>{content}</SettingsPanelHeaderStickyProvider>
      </div>
      <ChangePasswordDialog open={showPasswordDialog} onOpenChange={onShowPasswordDialogChange} />
      <div className="sr-only" aria-live="polite">{avatarUploading ? "头像上传中" : ""}</div>
    </div>
  );
}

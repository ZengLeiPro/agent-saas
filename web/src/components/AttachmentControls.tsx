import { useState } from "react";

import AssetLibraryDialog from "@/components/AssetLibraryDialog";
import AttachmentSourceMenu from "@/components/AttachmentSourceMenu";

interface AttachmentControlsProps {
  onLocalFile: () => void;
  onMenuOpenChange: (open: boolean) => void;
  onAssetConfirm?: (paths: string[]) => Promise<void> | void;
  disabled: boolean;
}

export default function AttachmentControls({
  onLocalFile,
  onMenuOpenChange,
  onAssetConfirm,
  disabled,
}: AttachmentControlsProps) {
  const [libraryOpen, setLibraryOpen] = useState(false);

  if (!libraryOpen || !onAssetConfirm) {
    return (
      <AttachmentSourceMenu
        onLocalFile={onLocalFile}
        onAssetLibrary={onAssetConfirm ? () => setLibraryOpen(true) : undefined}
      />
    );
  }

  return (
    <AssetLibraryDialog
      open
      onOpenChange={(open) => {
        setLibraryOpen(open);
        if (!open) onMenuOpenChange(false);
      }}
      onConfirm={onAssetConfirm}
      disabled={disabled}
    />
  );
}

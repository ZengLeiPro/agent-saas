import { lazy, Suspense, useState } from "react";

import AttachmentSourceMenu from "@/components/AttachmentSourceMenu";

interface AttachmentControlsProps {
  onLocalFile: () => void;
  onMenuOpenChange: (open: boolean) => void;
  onAssetConfirm?: (paths: string[]) => Promise<void> | void;
  disabled: boolean;
}

const LazyAssetLibraryDialog = lazy(() => import("@/components/AssetLibraryDialog"));

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
    <Suspense fallback={null}>
      <LazyAssetLibraryDialog
        open
        onOpenChange={(open) => {
          setLibraryOpen(open);
          if (!open) onMenuOpenChange(false);
        }}
        onConfirm={onAssetConfirm}
        disabled={disabled}
      />
    </Suspense>
  );
}

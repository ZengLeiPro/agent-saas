import { FilePlus2, FolderOpen } from "lucide-react";

import { PopoverContent } from "@/components/ui/popover";

interface AttachmentSourceMenuProps {
  onLocalFile: () => void;
  onAssetLibrary?: () => void;
}

const optionClassName = "flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left text-sm transition-colors hover:bg-accent";

export default function AttachmentSourceMenu({
  onLocalFile,
  onAssetLibrary,
}: AttachmentSourceMenuProps) {
  return (
    <PopoverContent
      side="top"
      align="start"
      sideOffset={8}
      className="w-56 rounded-2xl p-1.5 shadow-xl"
      onClick={(event) => event.stopPropagation()}
    >
      <button type="button" className={optionClassName} onClick={onLocalFile} aria-label="本地文件">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-700 ring-1 ring-inset ring-brand-200/70 dark:bg-brand-900/40 dark:text-brand-200 dark:ring-brand-700/50">
          <FilePlus2 className="size-4.5" />
        </span>
        <span className="min-w-0">
          <span className="block font-medium">本地文件</span>
          <span className="block text-xs text-muted-foreground">从设备中选择</span>
        </span>
      </button>
      {onAssetLibrary && (
        <button type="button" className={optionClassName} onClick={onAssetLibrary} aria-label="资料库">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-200/70 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-800/60">
            <FolderOpen className="size-4.5" />
          </span>
          <span className="min-w-0">
            <span className="block font-medium">资料库</span>
            <span className="block text-xs text-muted-foreground">选择已有文件</span>
          </span>
        </button>
      )}
    </PopoverContent>
  );
}

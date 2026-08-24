import { Cloud, Paperclip } from "lucide-react";

import { PopoverContent } from "@/components/ui/popover";

interface AttachmentSourceMenuProps {
  onLocalFile: () => void;
  onAssetLibrary?: () => void;
}

const optionClassName = "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-xs font-medium transition-colors hover:bg-accent";

export default function AttachmentSourceMenu({
  onLocalFile,
  onAssetLibrary,
}: AttachmentSourceMenuProps) {
  return (
    <PopoverContent
      side="top"
      align="start"
      sideOffset={8}
      className="w-40 rounded-xl p-1.5 shadow-xl"
      onClick={(event) => event.stopPropagation()}
    >
      <button type="button" className={optionClassName} onClick={onLocalFile} aria-label="本地文件">
        <Paperclip className="size-4 shrink-0 text-foreground" />
        <span>本地文件</span>
      </button>
      {onAssetLibrary && (
        <button type="button" className={optionClassName} onClick={onAssetLibrary} aria-label="云端文件">
          <Cloud className="size-4 shrink-0 text-foreground" />
          <span>云端文件</span>
        </button>
      )}
    </PopoverContent>
  );
}

import { FileUp, FolderOpen } from "lucide-react";

import { PopoverContent } from "@/components/ui/popover";

interface AttachmentSourceMenuProps {
  onLocalFile: () => void;
  onAssetLibrary?: () => void;
}

const optionClassName = "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent";

export default function AttachmentSourceMenu({
  onLocalFile,
  onAssetLibrary,
}: AttachmentSourceMenuProps) {
  return (
    <PopoverContent
      side="top"
      align="start"
      sideOffset={8}
      className="w-52 rounded-2xl p-1.5 shadow-xl"
      onClick={(event) => event.stopPropagation()}
    >
      <button type="button" className={optionClassName} onClick={onLocalFile}>
        <FileUp className="size-4.5" />
        本地文件
      </button>
      {onAssetLibrary && (
        <button type="button" className={optionClassName} onClick={onAssetLibrary}>
          <FolderOpen className="size-4.5" />
          资料库
        </button>
      )}
    </PopoverContent>
  );
}

import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Presentation,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { FileTypeCategory } from "@agent/shared";

/**
 * 文件分类 → lucide 图标（聊天下载卡 / 上传附件 chip 共用）。
 * 色相唯一来源见 shared/src/lib/fileTypeVisual.ts；
 * FileBrowser 面板的 tile 映射见 components/FileBrowser/fileIcons.tsx（同色相语义）。
 */
export const CATEGORY_ICON: Record<FileTypeCategory, LucideIcon> = {
  pdf: FileText,
  word: FileText,
  ppt: Presentation,
  excel: FileSpreadsheet,
  code: FileCode,
  image: FileImage,
  video: FileVideo,
  audio: FileAudio,
  text: FileText,
  archive: FileArchive,
  default: File,
};

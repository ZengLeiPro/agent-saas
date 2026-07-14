import {
  Folder,
  FolderOpen,
  FileText,
  FileImage,
  FileCode,
  FileJson,
  FileVideo,
  FileAudio,
  FileArchive,
  FileSpreadsheet,
  Presentation,
  File as FileIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * FileBrowser 文件类型图标系统（参考 Notion / Linear / Claude.ai 文件面板）：
 * 每种类型使用「浅底 + 深字」的圆角图标 tile，同色调收敛，避免五颜六色堆叠。
 * 色相语义与 shared/src/lib/fileTypeVisual.ts（聊天下载卡）严格对齐，改色必须两处同步。
 */

type ToneKey =
  | "folder"
  | "image"
  | "code"
  | "text"
  | "doc"
  | "ppt"
  | "sheet"
  | "video"
  | "audio"
  | "archive"
  | "pdf"
  | "default";

interface Tone {
  /** 图标 tile 背景 */
  bg: string;
  /** 图标本体颜色 */
  fg: string;
  /** 类型徽标文字 */
  ring: string;
}

const TONES: Record<ToneKey, Tone> = {
  // 目录 = 品牌蓝：文件面板的主要导航单位，用主色最能引导视线
  folder: {
    bg: "bg-brand-50 dark:bg-brand-900/40",
    fg: "text-brand-600 dark:text-brand-300",
    ring: "ring-brand-200/60 dark:ring-brand-700/40",
  },
  image: {
    bg: "bg-teal-50 dark:bg-teal-950/40",
    fg: "text-teal-600 dark:text-teal-400",
    ring: "ring-teal-200/60 dark:ring-teal-800/40",
  },
  code: {
    bg: "bg-violet-50 dark:bg-violet-950/40",
    fg: "text-violet-600 dark:text-violet-400",
    ring: "ring-violet-200/60 dark:ring-violet-800/40",
  },
  text: {
    bg: "bg-slate-100 dark:bg-slate-800/60",
    fg: "text-slate-600 dark:text-slate-300",
    ring: "ring-slate-200/60 dark:ring-slate-700/40",
  },
  doc: {
    // Word / 富文本文档：偏冷蓝色，与主品牌蓝拉开
    bg: "bg-sky-50 dark:bg-sky-950/40",
    fg: "text-sky-600 dark:text-sky-400",
    ring: "ring-sky-200/60 dark:ring-sky-800/40",
  },
  ppt: {
    bg: "bg-orange-50 dark:bg-orange-950/40",
    fg: "text-orange-600 dark:text-orange-400",
    ring: "ring-orange-200/60 dark:ring-orange-800/40",
  },
  sheet: {
    bg: "bg-emerald-50 dark:bg-emerald-950/40",
    fg: "text-emerald-600 dark:text-emerald-400",
    ring: "ring-emerald-200/60 dark:ring-emerald-800/40",
  },
  video: {
    bg: "bg-rose-50 dark:bg-rose-950/40",
    fg: "text-rose-600 dark:text-rose-400",
    ring: "ring-rose-200/60 dark:ring-rose-800/40",
  },
  audio: {
    bg: "bg-fuchsia-50 dark:bg-fuchsia-950/40",
    fg: "text-fuchsia-600 dark:text-fuchsia-400",
    ring: "ring-fuchsia-200/60 dark:ring-fuchsia-800/40",
  },
  archive: {
    bg: "bg-amber-50 dark:bg-amber-950/40",
    fg: "text-amber-600 dark:text-amber-400",
    ring: "ring-amber-200/60 dark:ring-amber-800/40",
  },
  pdf: {
    bg: "bg-red-50 dark:bg-red-950/40",
    fg: "text-red-600 dark:text-red-400",
    ring: "ring-red-200/60 dark:ring-red-800/40",
  },
  default: {
    bg: "bg-slate-100 dark:bg-slate-800/60",
    fg: "text-slate-500 dark:text-slate-400",
    ring: "ring-slate-200/60 dark:ring-slate-700/40",
  },
};

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".bmp", ".avif", ".tiff"]);
const CODE_EXTS = new Set([
  ".js", ".ts", ".jsx", ".tsx", ".py", ".sh", ".rb", ".go", ".rs",
  ".java", ".c", ".cpp", ".h", ".hpp", ".php", ".swift", ".kt",
  ".sql", ".yml", ".yaml", ".toml", ".vue", ".svelte",
]);
const TEXT_EXTS = new Set([".md", ".txt", ".log", ".rst", ".readme", ".markdown"]);
const HTML_EXTS = new Set([".html", ".htm", ".xml", ".css", ".scss", ".sass", ".less"]);
const SHEET_EXTS = new Set([".csv", ".xlsx", ".xls", ".tsv"]);
const DOC_EXTS = new Set([".doc", ".docx", ".rtf", ".odt"]);
const PPT_EXTS = new Set([".ppt", ".pptx", ".key", ".odp"]);
const VIDEO_EXTS = new Set([".mp4", ".mov", ".avi", ".webm", ".mkv", ".flv"]);
const AUDIO_EXTS = new Set([".mp3", ".wav", ".ogg", ".flac", ".m4a", ".aac"]);
const ARCHIVE_EXTS = new Set([".zip", ".tar", ".gz", ".7z", ".rar", ".bz2", ".xz"]);

interface FileIconMeta {
  Icon: LucideIcon;
  tone: ToneKey;
}

export function resolveFileIcon(entry: { isDirectory: boolean; extension: string; name: string }): FileIconMeta {
  if (entry.isDirectory) {
    return { Icon: Folder, tone: "folder" };
  }
  const ext = (entry.extension || "").toLowerCase();

  if (ext === ".pdf") return { Icon: FileText, tone: "pdf" };
  if (ext === ".json") return { Icon: FileJson, tone: "code" };
  if (IMAGE_EXTS.has(ext)) return { Icon: FileImage, tone: "image" };
  if (VIDEO_EXTS.has(ext)) return { Icon: FileVideo, tone: "video" };
  if (AUDIO_EXTS.has(ext)) return { Icon: FileAudio, tone: "audio" };
  if (ARCHIVE_EXTS.has(ext)) return { Icon: FileArchive, tone: "archive" };
  if (SHEET_EXTS.has(ext)) return { Icon: FileSpreadsheet, tone: "sheet" };
  if (DOC_EXTS.has(ext)) return { Icon: FileText, tone: "doc" };
  if (PPT_EXTS.has(ext)) return { Icon: Presentation, tone: "ppt" };
  if (HTML_EXTS.has(ext)) return { Icon: FileCode, tone: "code" };
  if (CODE_EXTS.has(ext)) return { Icon: FileCode, tone: "code" };
  if (TEXT_EXTS.has(ext)) return { Icon: FileText, tone: "text" };

  return { Icon: FileIcon, tone: "default" };
}

interface FileIconTileProps {
  entry: { isDirectory: boolean; extension: string; name: string };
  /** 图标 tile 尺寸；list 视图用 sm、grid 视图用 lg */
  size?: "sm" | "md" | "lg";
  /** 目录 hover 时切换成打开态 */
  open?: boolean;
  className?: string;
}

const SIZE_MAP: Record<NonNullable<FileIconTileProps["size"]>, { box: string; icon: string; radius: string }> = {
  sm: { box: "size-9", icon: "size-4", radius: "rounded-lg" },
  md: { box: "size-11", icon: "size-5", radius: "rounded-xl" },
  lg: { box: "size-16", icon: "size-8", radius: "rounded-2xl" },
};

/** 统一的图标 tile：一层浅底 + 图标 + hover 的 ring 强调 */
export function FileIconTile({ entry, size = "sm", open, className }: FileIconTileProps) {
  const { Icon, tone } = resolveFileIcon(entry);
  const t = TONES[tone];
  const dims = SIZE_MAP[size];
  const RenderIcon = entry.isDirectory && open ? FolderOpen : Icon;

  return (
    <span
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center ring-1 ring-inset transition-all",
        dims.box,
        dims.radius,
        t.bg,
        t.ring,
        className,
      )}
      aria-hidden
    >
      <RenderIcon className={cn(dims.icon, t.fg)} />
    </span>
  );
}

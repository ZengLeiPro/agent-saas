export type FileTypeCategory =
  | 'pdf' | 'word' | 'ppt' | 'excel'
  | 'code' | 'image' | 'video' | 'audio' | 'text'
  | 'archive' | 'default';

export interface FileTypeVisual {
  category: FileTypeCategory;
  /** hex color for icon badge background */
  color: string;
  /** hex color for dark mode (only differs for 'default') */
  colorDark: string;
}

const EXT_TO_CATEGORY: Record<string, FileTypeCategory> = {
  // PDF
  pdf: 'pdf',
  // Word
  doc: 'word', docx: 'word',
  // PowerPoint
  ppt: 'ppt', pptx: 'ppt',
  // Excel / Spreadsheet
  xls: 'excel', xlsx: 'excel', csv: 'excel',
  // Code
  ts: 'code', tsx: 'code', js: 'code', jsx: 'code',
  py: 'code', go: 'code', rs: 'code', java: 'code',
  c: 'code', cpp: 'code', h: 'code', rb: 'code',
  php: 'code', swift: 'code', kt: 'code',
  sh: 'code', bash: 'code',
  json: 'code', yaml: 'code', yml: 'code', toml: 'code', xml: 'code',
  html: 'code', css: 'code', scss: 'code', sql: 'code',
  // Image
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image',
  svg: 'image', webp: 'image', bmp: 'image', ico: 'image',
  // Video
  mp4: 'video', mov: 'video', webm: 'video', m4v: 'video',
  avi: 'video', mkv: 'video',
  // Audio
  mp3: 'audio', wav: 'audio', ogg: 'audio', flac: 'audio',
  m4a: 'audio', aac: 'audio',
  // Text / Document
  md: 'text', txt: 'text', log: 'text', rtf: 'text',
  // Archive
  zip: 'archive', tar: 'archive', gz: 'archive', bz2: 'archive',
  rar: 'archive', '7z': 'archive', xz: 'archive',
};

/**
 * 全站文件类型色板唯一来源（FileBrowser tile 与聊天下载卡共用同一色相语义）：
 * Office 三件套走品牌色（Word 蓝 / Excel 绿 / PPT 橙），PDF 红；
 * 代码紫、图片青、视频玫红、音频紫红、压缩琥珀、文本灰。
 * 改色时必须同步 web/src/components/FileBrowser/fileIcons.tsx 的 TONES（同色相 Tailwind 浅底）。
 */
const CATEGORY_COLORS: Record<FileTypeCategory, { color: string; colorDark: string }> = {
  pdf:     { color: '#EF4444', colorDark: '#EF4444' },  // red-500
  word:    { color: '#0EA5E9', colorDark: '#0EA5E9' },  // sky-500
  ppt:     { color: '#F97316', colorDark: '#F97316' },  // orange-500
  excel:   { color: '#10B981', colorDark: '#10B981' },  // emerald-500
  code:    { color: '#8B5CF6', colorDark: '#8B5CF6' },  // violet-500
  image:   { color: '#14B8A6', colorDark: '#14B8A6' },  // teal-500
  video:   { color: '#F43F5E', colorDark: '#F43F5E' },  // rose-500
  audio:   { color: '#D946EF', colorDark: '#D946EF' },  // fuchsia-500
  text:    { color: '#64748B', colorDark: '#64748B' },  // slate-500
  archive: { color: '#F59E0B', colorDark: '#F59E0B' },  // amber-500
  default: { color: '#9CA3AF', colorDark: '#6B7280' },
};

export function getFileTypeVisual(fileName: string): FileTypeVisual {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  const category = EXT_TO_CATEGORY[ext] ?? 'default';
  return { category, ...CATEGORY_COLORS[category] };
}

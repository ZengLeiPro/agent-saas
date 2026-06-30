export type FileTypeCategory =
  | 'pdf' | 'word' | 'ppt' | 'excel'
  | 'code' | 'image' | 'video' | 'text'
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
  // Text / Document
  md: 'text', txt: 'text', log: 'text', rtf: 'text',
  // Archive
  zip: 'archive', tar: 'archive', gz: 'archive', bz2: 'archive',
  rar: 'archive', '7z': 'archive', xz: 'archive',
};

const CATEGORY_COLORS: Record<FileTypeCategory, { color: string; colorDark: string }> = {
  pdf:     { color: '#EF4444', colorDark: '#EF4444' },
  word:    { color: '#3B82F6', colorDark: '#3B82F6' },
  ppt:     { color: '#F97316', colorDark: '#F97316' },
  excel:   { color: '#10B981', colorDark: '#10B981' },
  code:    { color: '#16A34A', colorDark: '#16A34A' },
  image:   { color: '#A855F7', colorDark: '#A855F7' },
  video:   { color: '#2563EB', colorDark: '#2563EB' },
  text:    { color: '#64748B', colorDark: '#64748B' },
  archive: { color: '#F59E0B', colorDark: '#F59E0B' },
  default: { color: '#9CA3AF', colorDark: '#6B7280' },
};

export function getFileTypeVisual(fileName: string): FileTypeVisual {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  const category = EXT_TO_CATEGORY[ext] ?? 'default';
  return { category, ...CATEGORY_COLORS[category] };
}

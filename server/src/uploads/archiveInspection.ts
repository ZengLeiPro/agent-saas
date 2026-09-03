import yauzl, { type Entry, type ZipFile } from 'yauzl';

const MAX_ZIP_ENTRIES = 100_000;
const MAX_ZIP_ENTRY_BYTES = 256 * 1024 * 1024 * 1024;
const MAX_ZIP_TOTAL_BYTES = 1024 * 1024 * 1024 * 1024;
const MAX_SUSPICIOUS_RATIO = 10_000;
const MIN_RATIO_CHECK_BYTES = 100 * 1024 * 1024;

const ACTIVE_EXTENSIONS = new Set([
  'html',
  'htm',
  'xhtml',
  'svg',
  'svgz',
  'js',
  'mjs',
  'cjs',
  'jsx',
  'vbs',
  'wsf',
]);
const EXECUTABLE_EXTENSIONS = new Set([
  'exe',
  'dll',
  'com',
  'scr',
  'msi',
  'msp',
  'bat',
  'cmd',
  'ps1',
  'sh',
  'bash',
  'zsh',
  'app',
  'apk',
  'ipa',
  'jar',
  'dmg',
  'pkg',
  'deb',
  'rpm',
  'elf',
  'bin',
]);

export type ZipInspectionFailure = 'invalid' | 'unsafe' | 'limit_exceeded';

export class ZipInspectionError extends Error {
  constructor(
    readonly failure: ZipInspectionFailure,
    message: string,
  ) {
    super(message);
    this.name = 'ZipInspectionError';
  }
}

export interface ZipInspectionResult {
  entryCount: number;
  uncompressedBytes: number;
  containsActiveContent: boolean;
  containsExecutable: boolean;
}

function openZipArchive(path: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true, validateEntrySizes: true }, (error, zipFile) => {
      if (error || !zipFile) reject(classifyZipReadError(error));
      else resolve(zipFile);
    });
  });
}

function classifyZipReadError(error: unknown): ZipInspectionError {
  const message = error instanceof Error ? error.message : '';
  if (/invalid relative path|absolute path|backslash/i.test(message)) {
    return new ZipInspectionError('unsafe', 'ZIP 内包含不安全路径');
  }
  return new ZipInspectionError('invalid', 'ZIP 文件已损坏或无法读取');
}

function normalizedEntryName(entry: Entry): string {
  const name = entry.fileName;
  if (
    !name ||
    name.includes('\0') ||
    /^[\\/]/.test(name) ||
    /^[a-zA-Z]:[\\/]/.test(name) ||
    name.includes('\\')
  ) {
    throw new ZipInspectionError('unsafe', 'ZIP 内包含不安全路径');
  }
  const parts = name.split('/').filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..')) {
    throw new ZipInspectionError('unsafe', 'ZIP 内包含越界路径');
  }
  return parts.join('/');
}

function isSymbolicLink(entry: Entry): boolean {
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  return (unixMode & 0o170000) === 0o120000;
}

function extensionOf(name: string): string {
  const base = name.split('/').at(-1) || '';
  const index = base.lastIndexOf('.');
  return index > 0 ? base.slice(index + 1).toLowerCase() : '';
}

/** 只检查中央目录元数据，不解压或执行压缩包内容。 */
export async function inspectZipArchive(path: string): Promise<ZipInspectionResult> {
  const zipFile = await openZipArchive(path);
  const paths = new Set<string>();
  let entryCount = 0;
  let uncompressedBytes = 0;
  let containsActiveContent = false;
  let containsExecutable = false;

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      zipFile.close();
      if (error instanceof ZipInspectionError) reject(error);
      else if (error) reject(classifyZipReadError(error));
      else resolve({ entryCount, uncompressedBytes, containsActiveContent, containsExecutable });
    };

    zipFile.once('error', finish);
    zipFile.once('end', () => finish());
    zipFile.on('entry', (entry) => {
      try {
        entryCount += 1;
        if (entryCount > MAX_ZIP_ENTRIES) {
          throw new ZipInspectionError(
            'limit_exceeded',
            `ZIP 内条目超过安全上限（${MAX_ZIP_ENTRIES} 项）`,
          );
        }
        const normalized = normalizedEntryName(entry);
        if (!normalized || paths.has(normalized) || isSymbolicLink(entry)) {
          throw new ZipInspectionError('unsafe', 'ZIP 内包含重复路径、空路径或符号链接');
        }
        paths.add(normalized);
        if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
          throw new ZipInspectionError('unsafe', '暂不支持加密 ZIP 文件');
        }
        if (entry.uncompressedSize > MAX_ZIP_ENTRY_BYTES) {
          throw new ZipInspectionError('limit_exceeded', 'ZIP 内单个文件解压后超过安全上限');
        }
        uncompressedBytes += entry.uncompressedSize;
        if (!Number.isSafeInteger(uncompressedBytes) || uncompressedBytes > MAX_ZIP_TOTAL_BYTES) {
          throw new ZipInspectionError('limit_exceeded', 'ZIP 解压后总体积超过安全上限');
        }
        if (
          entry.uncompressedSize >= MIN_RATIO_CHECK_BYTES &&
          (entry.compressedSize === 0 ||
            entry.uncompressedSize / entry.compressedSize > MAX_SUSPICIOUS_RATIO)
        ) {
          throw new ZipInspectionError('limit_exceeded', 'ZIP 压缩比异常，疑似压缩炸弹');
        }
        const extension = extensionOf(normalized);
        containsActiveContent ||= ACTIVE_EXTENSIONS.has(extension);
        containsExecutable ||= EXECUTABLE_EXTENSIONS.has(extension);
        zipFile.readEntry();
      } catch (error) {
        finish(error);
      }
    });
    zipFile.readEntry();
  });
}

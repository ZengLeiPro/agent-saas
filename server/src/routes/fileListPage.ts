import { lstat, readdir } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { openTrustedDirectory } from '../security/trustedFile.js';

export interface FileListEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: number;
  extension: string;
}

interface TraversalFrame {
  directoryPath: string;
  afterName: string | null;
}

interface RecursiveCursor {
  version: 1;
  rootPath: string;
  stack: TraversalFrame[];
}

export interface RecursiveFilePage {
  entries: FileListEntry[];
  nextCursor: string | null;
}

export const DEFAULT_RECURSIVE_FILE_PAGE_SIZE = 200;
export const MAX_RECURSIVE_FILE_PAGE_SIZE = 500;
const MAX_DIRECTORY_ENTRIES_PER_PAGE = 2_000;
const MAX_CURSOR_BYTES = 64 * 1024;
const MAX_CURSOR_DEPTH = 256;

export class InvalidFileListCursorError extends Error {}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function encodeCursor(rootPath: string, stack: TraversalFrame[]): string {
  const payload: RecursiveCursor = { version: 1, rootPath, stack };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function isDirectChildPath(rootPath: string, candidate: string): boolean {
  if (
    candidate.startsWith('/') ||
    candidate.includes('\\') ||
    candidate.split('/').some((part) => part === '..' || part === '.')
  ) {
    return false;
  }
  return candidate === rootPath || candidate.startsWith(`${rootPath}/`);
}

function decodeCursor(cursor: string | undefined, rootPath: string): TraversalFrame[] {
  if (!cursor) return [{ directoryPath: rootPath, afterName: null }];
  if (Buffer.byteLength(cursor, 'utf8') > MAX_CURSOR_BYTES) {
    throw new InvalidFileListCursorError('Invalid cursor');
  }

  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as RecursiveCursor;
    if (
      parsed.version !== 1 ||
      parsed.rootPath !== rootPath ||
      !Array.isArray(parsed.stack) ||
      parsed.stack.length === 0 ||
      parsed.stack.length > MAX_CURSOR_DEPTH
    ) {
      throw new InvalidFileListCursorError('Invalid cursor');
    }
    for (const frame of parsed.stack) {
      if (
        typeof frame?.directoryPath !== 'string' ||
        !isDirectChildPath(rootPath, frame.directoryPath) ||
        (frame.afterName !== null &&
          (typeof frame.afterName !== 'string' ||
            frame.afterName.length === 0 ||
            frame.afterName.includes('/') ||
            frame.afterName.includes('\\')))
      ) {
        throw new InvalidFileListCursorError('Invalid cursor');
      }
    }
    return parsed.stack.map((frame) => ({ ...frame }));
  } catch (error) {
    if (error instanceof InvalidFileListCursorError) throw error;
    throw new InvalidFileListCursorError('Invalid cursor');
  }
}

export function parseRecursiveFilePageSize(value: unknown): number {
  if (value === undefined) return DEFAULT_RECURSIVE_FILE_PAGE_SIZE;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new InvalidFileListCursorError('Invalid limit');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_RECURSIVE_FILE_PAGE_SIZE) {
    throw new InvalidFileListCursorError('Invalid limit');
  }
  return parsed;
}

/**
 * 按稳定的逐目录深度优先顺序读取一页文件。游标保存遍历栈，因此后续页不会从根目录重扫；
 * 同时限制单次检查的目录项数量，空目录或目录极多时也能及时把控制权交回事件循环。
 */
export async function listRecursiveFilePage(input: {
  selectedRoot: string;
  rootPath: string;
  cursor?: string;
  limit: number;
}): Promise<RecursiveFilePage> {
  const stack = decodeCursor(input.cursor, input.rootPath);
  const entries: FileListEntry[] = [];
  const directoryNames = new Map<string, string[]>();
  let inspected = 0;

  while (
    stack.length > 0 &&
    entries.length < input.limit &&
    inspected < MAX_DIRECTORY_ENTRIES_PER_PAGE
  ) {
    const frame = stack[stack.length - 1]!;
    const relativeDirectory = relative(input.rootPath, frame.directoryPath);
    let names = directoryNames.get(frame.directoryPath);
    if (!names) {
      try {
        const pinned = await openTrustedDirectory(input.selectedRoot, relativeDirectory);
        try {
          names = (await readdir(pinned.fdPath))
            .filter((name) => !name.startsWith('.'))
            .sort(compareNames);
          directoryNames.set(frame.directoryPath, names);
        } finally {
          await pinned.handle.close();
        }
      } catch {
        // 目录在跨页期间被移动、删除或变成不可信链接时，略过这一支并继续其父目录。
        stack.pop();
        continue;
      }
    }

    const nextName = names.find(
      (name) => frame.afterName === null || compareNames(name, frame.afterName) > 0,
    );
    if (!nextName) {
      stack.pop();
      continue;
    }

    frame.afterName = nextName;
    inspected += 1;
    try {
      const directory = await openTrustedDirectory(input.selectedRoot, relativeDirectory);
      let entryStat;
      try {
        entryStat = await lstat(join(directory.fdPath, nextName));
      } finally {
        await directory.handle.close();
      }
      if (entryStat.isSymbolicLink()) continue;

      const entryPath = join(frame.directoryPath, nextName);
      if (entryStat.isDirectory()) {
        if (stack.length >= MAX_CURSOR_DEPTH) continue;
        stack.push({ directoryPath: entryPath, afterName: null });
        continue;
      }
      entries.push({
        name: nextName,
        path: entryPath,
        isDirectory: false,
        size: entryStat.size,
        modifiedAt: entryStat.mtimeMs,
        extension: extname(nextName).toLowerCase(),
      });
    } catch {
      // 遍历期间被移动、删除或变成不可信链接的条目直接略过；游标仍已向前推进。
    }
  }

  return {
    entries,
    nextCursor: stack.length > 0 ? encodeCursor(input.rootPath, stack) : null,
  };
}

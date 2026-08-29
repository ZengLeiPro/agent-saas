import { constants, type Stats } from 'node:fs';
import { open, mkdir, readdir, rmdir, unlink, lstat, link, rename, type FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;
const WRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW;

export class UnsafeFilePathError extends Error {
  readonly code = 'EACCES';

  constructor(message = 'Symbolic links and paths outside the trusted root are not allowed') {
    super(message);
    this.name = 'UnsafeFilePathError';
  }
}

export interface TrustedFile {
  handle: FileHandle;
  stats: Stats;
  /** A path bound to the opened inode, not the caller-controlled pathname. Linux only. */
  fdPath: string;
}

function asUnsafe(error: unknown): never {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'ELOOP') throw new UnsafeFilePathError();
  throw error;
}

function componentsOf(relativePath: string, allowRoot = false): string[] {
  if (relativePath.includes('\0') || isAbsolute(relativePath)) throw new UnsafeFilePathError('Absolute and NUL paths are not allowed');
  const components = relativePath.split(/[\\/]+/).filter((part) => part !== '' && part !== '.');
  if (components.some((part) => part === '..')) throw new UnsafeFilePathError('Path traversal is not allowed');
  if (!allowRoot && components.length === 0) throw new UnsafeFilePathError('The trusted root itself is not a file target');
  return components;
}

function procPath(handle: FileHandle, child?: string): string {
  if (process.platform !== 'linux') {
    throw Object.assign(new Error('Trusted descriptor-relative file operations require Linux /proc'), { code: 'ENOTSUP' });
  }
  return `/proc/self/fd/${handle.fd}${child ? `/${child}` : ''}`;
}

async function openRoot(root: string, create = false): Promise<FileHandle> {
  const absoluteRoot = resolve(root);
  const components = absoluteRoot.split(sep).filter(Boolean);
  let current = await open(sep, DIRECTORY_FLAGS);
  try {
    for (const component of components) {
      let next: FileHandle;
      try {
        next = await openChildDirectory(current, component);
      } catch (error) {
        if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        next = await createAndOpenChildDirectory(current, component);
      }
      await current.close();
      current = next;
    }
    return current;
  } catch (error) {
    await current.close().catch(() => undefined);
    throw error;
  }
}

async function openChildDirectory(parent: FileHandle, name: string): Promise<FileHandle> {
  const childPath = procPath(parent, name);
  try {
    return await open(childPath, DIRECTORY_FLAGS);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') {
      const stats = await lstat(childPath).catch(() => undefined);
      if (stats?.isSymbolicLink()) throw new UnsafeFilePathError();
    }
    asUnsafe(error);
  }
}

async function createAndOpenChildDirectory(parent: FileHandle, name: string): Promise<FileHandle> {
  try {
    await mkdir(procPath(parent, name), { mode: 0o775 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return openChildDirectory(parent, name);
}

async function bindParent(root: string, relativePath: string, createParents = false): Promise<{ parent: FileHandle; leaf: string }> {
  const components = componentsOf(relativePath);
  const leaf = components.pop()!;
  let current = await openRoot(root, createParents);
  try {
    for (const component of components) {
      let next: FileHandle;
      try {
        next = await openChildDirectory(current, component);
      } catch (error) {
        if (!createParents || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        next = await createAndOpenChildDirectory(current, component);
      }
      await current.close();
      current = next;
    }
    return { parent: current, leaf };
  } catch (error) {
    await current.close().catch(() => undefined);
    throw error;
  }
}

export function relativeToTrustedRoot(root: string, candidate: string): string {
  const absoluteRoot = resolve(root);
  const absoluteCandidate = resolve(candidate);
  const rel = relative(absoluteRoot, absoluteCandidate);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new UnsafeFilePathError('Path is outside the trusted root');
  return rel;
}

export function selectTrustedRoot(candidate: string, roots: string[]): { root: string; relativePath: string } {
  const absoluteCandidate = resolve(candidate);
  const matches = roots
    .map((root) => resolve(root))
    .filter((root) => absoluteCandidate !== root && !relative(root, absoluteCandidate).startsWith(`..${sep}`) && relative(root, absoluteCandidate) !== '..' && !isAbsolute(relative(root, absoluteCandidate)))
    .sort((a, b) => b.length - a.length);
  const root = matches[0];
  if (!root) throw new UnsafeFilePathError('Path is outside the trusted roots');
  return { root, relativePath: relative(root, absoluteCandidate) };
}

export async function openTrustedFile(root: string, relativePath: string): Promise<TrustedFile> {
  const { parent, leaf } = await bindParent(root, relativePath);
  try {
    let handle: FileHandle;
    try {
      handle = await open(procPath(parent, leaf), READ_FLAGS);
    } catch (error) {
      asUnsafe(error);
    }
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) throw Object.assign(new Error('Not a file'), { code: 'EISDIR' });
      return { handle, stats, fdPath: procPath(handle) };
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  } finally {
    await parent.close();
  }
}

export async function withTrustedFile<T>(
  root: string,
  relativePath: string,
  operation: (file: TrustedFile) => Promise<T>,
): Promise<T> {
  const file = await openTrustedFile(root, relativePath);
  try {
    return await operation(file);
  } finally {
    await file.handle.close();
  }
}

export async function openTrustedFileFromPath(candidate: string, roots: string[]): Promise<TrustedFile & { root: string; relativePath: string }> {
  const selected = selectTrustedRoot(candidate, roots);
  return { ...await openTrustedFile(selected.root, selected.relativePath), ...selected };
}

export async function openTrustedDirectory(root: string, relativePath = ''): Promise<{ handle: FileHandle; fdPath: string; stats: Stats }> {
  const components = componentsOf(relativePath, true);
  let current = await openRoot(root);
  try {
    for (const component of components) {
      const next = await openChildDirectory(current, component);
      await current.close();
      current = next;
    }
    return { handle: current, fdPath: procPath(current), stats: await current.stat() };
  } catch (error) {
    await current.close().catch(() => undefined);
    throw error;
  }
}

export function readTrustedFile(root: string, relativePath: string, encoding: BufferEncoding): Promise<string>;
export function readTrustedFile(root: string, relativePath: string): Promise<Buffer>;
export async function readTrustedFile(root: string, relativePath: string, encoding?: BufferEncoding): Promise<Buffer | string> {
  const file = await openTrustedFile(root, relativePath);
  try {
    return encoding ? await file.handle.readFile({ encoding }) : await file.handle.readFile();
  } finally {
    await file.handle.close();
  }
}

export async function writeTrustedFile(
  root: string,
  relativePath: string,
  data: string | Uint8Array,
  options: { encoding?: BufferEncoding; createParents?: boolean; exclusive?: boolean; mode?: number } = {},
): Promise<void> {
  const { parent, leaf } = await bindParent(root, relativePath, options.createParents === true);
  let handle: FileHandle | undefined;
  try {
    const flags = options.exclusive ? WRITE_FLAGS | constants.O_EXCL : WRITE_FLAGS;
    try {
      handle = await open(procPath(parent, leaf), flags, options.mode ?? 0o664);
    } catch (error) {
      asUnsafe(error);
    }
    await handle.writeFile(data, options.encoding ? { encoding: options.encoding } : undefined);
  } finally {
    await handle?.close().catch(() => undefined);
    await parent.close();
  }
}

/** Appends through a descriptor-pinned parent, creating the file and parents on first use. */
export async function appendTrustedFile(
  root: string,
  relativePath: string,
  data: string | Uint8Array,
  encoding?: BufferEncoding,
): Promise<void> {
  const relativeParent = dirname(relativePath);
  let directory: Awaited<ReturnType<typeof openTrustedDirectory>> | undefined;
  let handle: FileHandle | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      directory = await openTrustedDirectory(root, relativeParent === '.' ? '' : relativeParent);
      handle = await open(procPath(directory.handle, basename(relativePath)), constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
      break;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      handle = undefined;
      await directory?.handle.close().catch(() => undefined);
      directory = undefined;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ELOOP') throw new UnsafeFilePathError();
      if (code !== 'ENOENT' || attempt > 0) throw error;
      await writeTrustedFileIfAbsent(root, relativePath, '', { createParents: true });
    }
  }
  if (!directory || !handle) throw Object.assign(new Error('Unable to open append target'), { code: 'ENOENT' });
  try {
    if (!(await handle.stat()).isFile()) throw new UnsafeFilePathError('Append target is not a regular file');
    await handle.writeFile(data, encoding ? { encoding } : undefined);
  } finally {
    await handle.close().catch(() => undefined);
    await directory.handle.close();
  }
}

/** Atomically replaces a file inside a parent directory pinned by descriptor. */
export async function atomicWriteTrustedFile(
  root: string,
  relativePath: string,
  data: string | Uint8Array,
  options: {
    encoding?: BufferEncoding;
    createParents?: boolean;
    mode?: number;
    tempSuffix?: string;
    expectedFile?: Stats;
    expectedContent?: string | Uint8Array;
  } = {},
): Promise<void> {
  const tempLeaf = options.tempSuffix
    ? `.ky-write-${options.tempSuffix}`
    : `.ky-write-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  if (basename(tempLeaf) !== tempLeaf) throw new UnsafeFilePathError('Atomic write temp suffix must be a single path component');
  const { parent, leaf } = await bindParent(root, relativePath, options.createParents === true);
  let handle: FileHandle | undefined;
  let published = false;
  try {
    let targetStats: Stats | undefined;
    try {
      targetStats = await lstat(procPath(parent, leaf));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') asUnsafe(error);
    }
    // Best-effort stale-write detection for cooperative callers. POSIX rename is not a CAS:
    // a non-cooperating external writer can still win a race after these checks.
    if (options.expectedFile) {
      const expected = options.expectedFile;
      if (
        !targetStats?.isFile()
        || targetStats.dev !== expected.dev
        || targetStats.ino !== expected.ino
        || targetStats.size !== expected.size
        || targetStats.mtimeMs !== expected.mtimeMs
        || targetStats.ctimeMs !== expected.ctimeMs
      ) {
        throw Object.assign(new Error(`Atomic write target changed before commit: ${relativePath}`), { code: 'ESTALE' });
      }
    }
    if (options.expectedContent !== undefined) {
      let current: FileHandle | undefined;
      try {
        current = await open(procPath(parent, leaf), READ_FLAGS);
        const actual = await current.readFile();
        const expected = typeof options.expectedContent === 'string'
          ? Buffer.from(options.expectedContent, options.encoding ?? 'utf8')
          : Buffer.from(options.expectedContent);
        if (!actual.equals(expected)) {
          throw Object.assign(new Error(`Atomic write target content changed before commit: ${relativePath}`), { code: 'ESTALE' });
        }
      } finally {
        await current?.close().catch(() => undefined);
      }
    }
    // Preserve regular permission bits, but intentionally clear setuid/setgid/sticky on replacement.
    // New files keep normal open(2) semantics: the process umask narrows the default mode.
    const mode = options.mode
      ?? (targetStats?.isFile() ? targetStats.mode & 0o777 : (0o664 & ~process.umask()));
    handle = await open(procPath(parent, tempLeaf), WRITE_FLAGS | constants.O_EXCL, mode);
    await handle.writeFile(data, options.encoding ? { encoding: options.encoding } : undefined);
    await handle.chmod(mode);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(procPath(parent, tempLeaf), procPath(parent, leaf));
    published = true;
    await parent.sync();
  } catch (error) {
    asUnsafe(error);
  } finally {
    await handle?.close().catch(() => undefined);
    if (!published) await unlink(procPath(parent, tempLeaf)).catch(() => undefined);
    await parent.close();
  }
}

/** Publishes complete content only when the destination does not already exist. */
export async function writeTrustedFileIfAbsent(
  root: string,
  relativePath: string,
  data: string | Uint8Array,
  options: { encoding?: BufferEncoding; createParents?: boolean; mode?: number; tempSuffix?: string } = {},
): Promise<boolean> {
  const { parent, leaf } = await bindParent(root, relativePath, options.createParents === true);
  const tempLeaf = `${leaf}.${options.tempSuffix ?? `create.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`}`;
  let handle: FileHandle | undefined;
  let created = false;
  try {
    handle = await open(procPath(parent, tempLeaf), WRITE_FLAGS | constants.O_EXCL, options.mode ?? 0o664);
    await handle.writeFile(data, options.encoding ? { encoding: options.encoding } : undefined);
    await handle.close();
    handle = undefined;
    try {
      await link(procPath(parent, tempLeaf), procPath(parent, leaf));
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') asUnsafe(error);
    }
    return created;
  } catch (error) {
    return asUnsafe(error);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(procPath(parent, tempLeaf)).catch(() => undefined);
    await parent.close();
  }
}

export async function copyTrustedFile(
  sourceRoot: string,
  sourceRelativePath: string,
  destinationRoot: string,
  destinationRelativePath: string,
  options: { maxBytes?: number } = {},
): Promise<Stats> {
  const source = await openTrustedFile(sourceRoot, sourceRelativePath);
  let parent: FileHandle | undefined;
  let destination: FileHandle | undefined;
  let destinationLeaf: string | undefined;
  let destinationCreated = false;
  let copied = false;
  try {
    if (options.maxBytes !== undefined && source.stats.size > options.maxBytes) {
      throw Object.assign(new Error(`File exceeds ${options.maxBytes} bytes`), { code: 'EFBIG' });
    }
    const bound = await bindParent(destinationRoot, destinationRelativePath, true);
    parent = bound.parent;
    destinationLeaf = bound.leaf;
    destination = await open(procPath(parent, destinationLeaf), WRITE_FLAGS | constants.O_EXCL, 0o664);
    destinationCreated = true;
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, source.stats.size)));
    let position = 0;
    while (position < source.stats.size) {
      const length = Math.min(buffer.length, source.stats.size - position);
      const { bytesRead } = await source.handle.read(buffer, 0, length, position);
      if (bytesRead === 0) break;
      let written = 0;
      while (written < bytesRead) {
        const result = await destination.write(buffer, written, bytesRead - written, position + written);
        if (result.bytesWritten === 0) throw Object.assign(new Error('Destination write made no progress'), { code: 'EIO' });
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    if (position !== source.stats.size) {
      throw Object.assign(new Error('Source file changed during copy'), { code: 'EIO' });
    }
    copied = true;
    return source.stats;
  } catch (error) {
    return asUnsafe(error);
  } finally {
    await source.handle.close().catch(() => undefined);
    await destination?.close().catch(() => undefined);
    if (destinationCreated && !copied && parent && destinationLeaf) {
      await unlink(procPath(parent, destinationLeaf)).catch(() => undefined);
    }
    await parent?.close().catch(() => undefined);
  }
}

async function removeEntry(parent: FileHandle, leaf: string): Promise<void> {
  let directory: FileHandle | undefined;
  try {
    directory = await openChildDirectory(parent, leaf);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw error;
    if (code === 'ENOTDIR') {
      try {
        const file = await open(procPath(parent, leaf), READ_FLAGS);
        try {
          const stats = await file.stat();
          if (!stats.isFile()) throw new UnsafeFilePathError();
        } finally {
          await file.close().catch(() => undefined);
        }
        await unlink(procPath(parent, leaf));
        return;
      } catch (fileError) {
        asUnsafe(fileError);
      }
    }
    throw error;
  }

  try {
    for (const name of await readdir(procPath(directory))) {
      if (name === '.' || name === '..') continue;
      await removeEntry(directory, name);
    }
  } finally {
    await directory.close();
  }
  await rmdir(procPath(parent, leaf));
}

export async function removeTrustedPath(root: string, relativePath: string): Promise<void> {
  const { parent, leaf } = await bindParent(root, relativePath);
  try {
    await removeEntry(parent, leaf);
  } finally {
    await parent.close();
  }
}

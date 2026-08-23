import { constants, type Stats } from 'node:fs';
import { open, mkdir, readdir, rmdir, unlink, lstat, type FileHandle } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

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

async function openRoot(root: string): Promise<FileHandle> {
  try {
    return await open(resolve(root), DIRECTORY_FLAGS);
  } catch (error) {
    asUnsafe(error);
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

async function bindParent(root: string, relativePath: string, createParents = false): Promise<{ parent: FileHandle; leaf: string }> {
  const components = componentsOf(relativePath);
  const leaf = components.pop()!;
  let current = await openRoot(root);
  try {
    for (const component of components) {
      let next: FileHandle;
      try {
        next = await openChildDirectory(current, component);
      } catch (error) {
        if (!createParents || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await mkdir(procPath(current, component), { mode: 0o775 });
        next = await openChildDirectory(current, component);
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
    const stats = await handle.stat();
    if (!stats.isFile()) {
      await handle.close();
      throw Object.assign(new Error('Not a file'), { code: 'EISDIR' });
    }
    return { handle, stats, fdPath: procPath(handle) };
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

export async function copyTrustedFile(
  sourceRoot: string,
  sourceRelativePath: string,
  destinationRoot: string,
  destinationRelativePath: string,
  options: { maxBytes?: number } = {},
): Promise<Stats> {
  const source = await openTrustedFile(sourceRoot, sourceRelativePath);
  if (options.maxBytes !== undefined && source.stats.size > options.maxBytes) {
    await source.handle.close();
    throw Object.assign(new Error(`File exceeds ${options.maxBytes} bytes`), { code: 'EFBIG' });
  }
  const { parent, leaf } = await bindParent(destinationRoot, destinationRelativePath, true);
  let destination: FileHandle | undefined;
  try {
    destination = await open(procPath(parent, leaf), WRITE_FLAGS | constants.O_EXCL, 0o664);
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, source.stats.size)));
    let position = 0;
    while (position < source.stats.size) {
      const length = Math.min(buffer.length, source.stats.size - position);
      const { bytesRead } = await source.handle.read(buffer, 0, length, position);
      if (bytesRead === 0) break;
      let written = 0;
      while (written < bytesRead) {
        const result = await destination.write(buffer, written, bytesRead - written, position + written);
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    return source.stats;
  } catch (error) {
    return asUnsafe(error);
  } finally {
    await source.handle.close().catch(() => undefined);
    await destination?.close().catch(() => undefined);
    await parent.close();
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
        const stats = await file.stat();
        await file.close();
        if (!stats.isFile()) throw new UnsafeFilePathError();
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

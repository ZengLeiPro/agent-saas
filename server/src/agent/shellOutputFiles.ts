import { constants } from 'fs';
import { createHash, randomUUID } from 'crypto';
import { lstat, mkdir, open, realpath, stat, type FileHandle } from 'fs/promises';
import { resolve } from 'path';

import {
  MAX_SHELL_RETURN_CHARS,
  type ShellOutputFileRef,
} from './toolOutput.js';

const SHELL_OUTPUT_DIR = 'tmp/tool-results';

export { SHELL_OUTPUT_DIR };

export interface OpenShellOutputFile {
  relPath: string;
  fullPath: string;
  verificationPath: string;
  handle: FileHandle;
  directoryHandle?: FileHandle;
}

/**
 * 输出文件基名。流式溢出（shellOutputAccumulator）与一次性落盘
 * （persistShellOutputFiles）必须共用同一命名规则：进度提示里承诺的文件路径，
 * 就是最终信封里 `Full output files:` 指向的路径。
 */
export function shellOutputBaseName(invocationId?: string): string {
  const prefix = sanitizeFileSegment(invocationId ?? `shell-${Date.now()}`);
  // invocationId 在重试/并发恢复时可能复用；随机后缀避免覆盖另一条仍在写的输出。
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

export function shouldPersistShellOutput(stdout: string, stderr: string, force = false): boolean {
  return force || stdout.length + stderr.length > MAX_SHELL_RETURN_CHARS;
}

/**
 * 在 workspace 内安全打开唯一输出文件。
 *
 * Linux 从 workspace 根目录 fd 开始逐级打开 `tmp/tool-results`：每一层都用
 * O_DIRECTORY + O_NOFOLLOW，并通过 `/proc/self/fd/N/segment` 把父 inode 固定住。
 * 因此即使并发把路径换成符号链接，也只会打开失败，不会越出 workspace。
 * 最终文件再用 O_EXCL + O_NOFOLLOW，拒绝覆盖与最终路径符号链接。
 */
export async function openShellOutputFile(
  workspaceRoot: string,
  baseName: string,
  channel: 'stdout' | 'stderr',
): Promise<OpenShellOutputFile> {
  const requestedRoot = resolve(workspaceRoot);
  const requestedRootStat = await lstat(requestedRoot);
  if (requestedRootStat.isSymbolicLink() || !requestedRootStat.isDirectory()) {
    throw new Error(`workspace root is not a real directory: ${workspaceRoot}`);
  }
  const root = await realpath(requestedRoot);
  const rootStat = await lstat(root);
  if (rootStat.dev !== requestedRootStat.dev || rootStat.ino !== requestedRootStat.ino) {
    throw new Error('workspace root changed while opening Shell output directory');
  }

  if (process.platform !== 'linux') {
    throw new Error('Secure Shell full-output files require Linux directory-fd support');
  }

  const fileName = `${sanitizeFileSegment(baseName)}-${channel}.txt`;
  const relPath = `${SHELL_OUTPUT_DIR}/${fileName}`;
  const fullPath = resolve(root, SHELL_OUTPUT_DIR, fileName);
  // O_RDWR 允许收尾时从同一 fd 回读校验 sha256；不通过路径重开，避免被替换。
  const fileFlags = constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
  const directoryHandle = await openLinuxOutputDirectory(root, rootStat);
  try {
    const verificationPath = `/proc/self/fd/${directoryHandle.fd}/${fileName}`;
    const handle = await open(verificationPath, fileFlags, 0o600);
    return { relPath, fullPath, verificationPath, handle, directoryHandle };
  } catch (err) {
    await directoryHandle.close();
    throw err;
  }
}

/** 从同一已打开 fd 回读，校验 inode、字节数与 sha256 均和原始流一致。 */
export async function verifyShellOutputFile(
  opened: OpenShellOutputFile,
  expectedBytes: number,
  expectedSha256: string,
): Promise<void> {
  const [handleStat, pathStat] = await Promise.all([
    opened.handle.stat(),
    stat(opened.verificationPath),
  ]);
  if (handleStat.dev !== pathStat.dev || handleStat.ino !== pathStat.ino) {
    throw new Error(`Shell output file was replaced while writing: ${opened.relPath}`);
  }
  if (handleStat.size !== expectedBytes) {
    throw new Error(`Shell output file size mismatch: expected ${expectedBytes}, got ${handleStat.size}`);
  }

  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (position < expectedBytes) {
    const length = Math.min(buffer.length, expectedBytes - position);
    const { bytesRead } = await opened.handle.read(buffer, 0, length, position);
    if (bytesRead <= 0) throw new Error(`Shell output file ended early: ${opened.relPath}`);
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  const actualSha256 = hash.digest('hex');
  if (actualSha256 !== expectedSha256) {
    throw new Error(`Shell output file content mismatch: ${opened.relPath}`);
  }
  // hash 回读可能持续数秒；结束后再复核一次路径仍指向同一 inode/size。
  const finalPathStat = await stat(opened.verificationPath);
  if (
    finalPathStat.dev !== handleStat.dev
    || finalPathStat.ino !== handleStat.ino
    || finalPathStat.size !== expectedBytes
  ) {
    throw new Error(`Shell output file was replaced during verification: ${opened.relPath}`);
  }
}

export async function closeShellOutputFile(opened: OpenShellOutputFile): Promise<void> {
  let firstError: unknown;
  try { await opened.handle.close(); } catch (err) { firstError = err; }
  try { await opened.directoryHandle?.close(); } catch (err) { firstError ??= err; }
  if (firstError) throw firstError;
}

export async function persistShellOutputFiles(input: {
  workspaceRoot: string;
  invocationId?: string;
  /** 显式基名；与 ShellChannelAccumulator 共用，确保信封与实际路径一致。 */
  baseName?: string;
  stdout: string;
  stderr: string;
  force?: boolean;
}): Promise<ShellOutputFileRef[]> {
  if (!shouldPersistShellOutput(input.stdout, input.stderr, input.force)) return [];
  const baseName = input.baseName ?? shellOutputBaseName(input.invocationId);
  const files: ShellOutputFileRef[] = [];
  if (input.stdout) files.push(await writeChannelOutput(input.workspaceRoot, baseName, 'stdout', input.stdout));
  if (input.stderr) files.push(await writeChannelOutput(input.workspaceRoot, baseName, 'stderr', input.stderr));
  return files;
}

async function writeChannelOutput(
  workspaceRoot: string,
  baseName: string,
  channel: 'stdout' | 'stderr',
  content: string,
): Promise<ShellOutputFileRef> {
  const opened = await openShellOutputFile(workspaceRoot, baseName, channel);
  const bytes = Buffer.byteLength(content, 'utf-8');
  const sha256 = createHash('sha256').update(content).digest('hex');
  try {
    await opened.handle.writeFile(content, 'utf-8');
    await verifyShellOutputFile(opened, bytes, sha256);
    return {
      channel,
      path: opened.relPath,
      bytes,
      sha256,
    };
  } finally {
    await closeShellOutputFile(opened);
  }
}

async function openLinuxOutputDirectory(
  root: string,
  expectedRoot: { dev: number; ino: number },
): Promise<FileHandle> {
  const directoryFlags = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0);
  let current = await open(root, directoryFlags);
  try {
    const openedRoot = await current.stat();
    if (openedRoot.dev !== expectedRoot.dev || openedRoot.ino !== expectedRoot.ino) {
      throw new Error('workspace root was replaced while opening Shell output directory');
    }
    for (const segment of SHELL_OUTPUT_DIR.split('/')) {
      const segmentPath = `/proc/self/fd/${current.fd}/${segment}`;
      try {
        await mkdir(segmentPath, { mode: 0o700 });
      } catch (err) {
        if (!isNodeError(err) || err.code !== 'EEXIST') throw err;
      }
      const next = await open(segmentPath, directoryFlags);
      const nextStat = await next.stat();
      if (!nextStat.isDirectory()) {
        await next.close();
        throw new Error(`Shell output path component is not a directory: ${segment}`);
      }
      const previous = current;
      current = next;
      await previous.close();
    }
    return current;
  } catch (err) {
    try { await current.close(); } catch { /* 保留原始安全校验错误 */ }
    throw err;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function sanitizeFileSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || randomUUID();
}

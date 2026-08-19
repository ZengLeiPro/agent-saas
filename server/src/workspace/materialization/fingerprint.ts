import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';

const EXCLUDED_NAMES = new Set(['__pycache__', '.DS_Store', 'node_modules']);

export function shouldIncludeMaterializedPath(path: string): boolean {
  return !EXCLUDED_NAMES.has(basename(path));
}

async function hashFile(path: string, hash: ReturnType<typeof createHash>): Promise<void> {
  const stream = createReadStream(path);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
}

async function walk(root: string, current: string, hash: ReturnType<typeof createHash>): Promise<void> {
  const entries = (await readdir(current, { withFileTypes: true }))
    .filter((entry) => shouldIncludeMaterializedPath(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const path = join(current, entry.name);
    const relativePath = relative(root, path).replaceAll('\\', '/');
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      throw new Error(`技能源不允许包含软链接：${relativePath}`);
    }
    if (info.isDirectory()) {
      hash.update(`d\0${relativePath}\0`);
      await walk(root, path, hash);
      continue;
    }
    if (!info.isFile()) continue;
    hash.update(`f\0${relativePath}\0${info.size}\0`);
    await hashFile(path, hash);
    hash.update('\0');
  }
}

export async function computeDirectoryFingerprint(root: string): Promise<string> {
  const hash = createHash('sha256');
  await walk(root, root, hash);
  return hash.digest('hex');
}

async function walkSkillPackage(
  root: string,
  current: string,
  hash: ReturnType<typeof createHash>,
): Promise<void> {
  const entries = (await readdir(current, { withFileTypes: true }))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const path = join(current, entry.name);
    const relativePath = relative(root, path).replaceAll('\\', '/');
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      throw new Error(`技能源不允许包含软链接：${relativePath}`);
    }
    if (info.isDirectory()) {
      await walkSkillPackage(root, path, hash);
      continue;
    }
    if (!info.isFile()) continue;
    hash.update(relativePath).update('\0').update(String(info.size)).update('\0');
    await hashFile(path, hash);
  }
}

/** 与技能包上传时的 contentDigest 算法保持一致，用于校验治理历史版本。 */
export async function computeSkillPackageFingerprint(root: string): Promise<string> {
  const hash = createHash('sha256');
  await walkSkillPackage(root, root, hash);
  return hash.digest('hex');
}

export function computeDesiredHash(entries: Iterable<[string, string]>): string {
  const hash = createHash('sha256');
  for (const [id, digest] of [...entries].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(`${id}\0${digest}\0`);
  }
  return hash.digest('hex');
}

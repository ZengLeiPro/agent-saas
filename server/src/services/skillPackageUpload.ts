import { createHash } from 'node:crypto';
import {
  cp,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Readable } from 'node:stream';
import yauzl, { type Entry, type ZipFile } from 'yauzl';

import { ensureWorkspaceDir, repairWorkspaceTreeAsync } from '../workspace/permissions.js';
import { shouldIncludeMaterializedPath } from '../workspace/materialization/fingerprint.js';
const MAX_SKILL_FILES = 300;
const MAX_SKILL_FILE_BYTES = 25 * 1024 * 1024;
const MAX_SKILL_PACKAGE_BYTES = 100 * 1024 * 1024;
const MAX_SKILL_PATH_DEPTH = 16;

export class SkillPackageUploadError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'SkillPackageUploadError';
  }
}

export interface StagedSkillPackage {
  tempRoot: string;
  skillRoot: string;
  skillId: string;
  name: string;
  description: string;
  contentDigest: string;
  fileCount: number;
  totalBytes: number;
  dispose(): Promise<void>;
}

function safeRelativePath(name: string): string | null {
  if (!name || name.includes('\0') || /^[\\/]/.test(name) || /^[a-zA-Z]:[\\/]/.test(name)) return null;
  const normalized = name.replace(/\\/g, '/').split('/').filter(Boolean).join('/');
  if (
    !normalized
    || normalized.startsWith('.')
    || normalized.includes('../')
    || normalized.split('/').length > MAX_SKILL_PATH_DEPTH
    || normalized.split('/').some(part => part === '..' || part.startsWith('.'))
  ) return null;
  return normalized;
}

function openZipArchive(path: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true, validateEntrySizes: false }, (error, zipFile) => {
      if (error || !zipFile) reject(error ?? new Error('zip open failed'));
      else resolve(zipFile);
    });
  });
}

function openZipEntryStream(zipFile: ZipFile, entry: Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error || !stream) reject(error ?? new Error('zip entry stream failed'));
      else resolve(stream);
    });
  });
}

async function extractZipArchive(zipPath: string, destination: string): Promise<void> {
  const zipFile = await openZipArchive(zipPath);
  const paths = new Set<string>();
  let entryCount = 0;
  let declaredTotalBytes = 0;
  let actualTotalBytes = 0;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      zipFile.close();
      if (error) reject(error);
      else resolve();
    };

    zipFile.once('error', finish);
    zipFile.once('end', () => finish());
    zipFile.on('entry', (entry) => {
      void (async () => {
        entryCount += 1;
        if (entryCount > MAX_SKILL_FILES) {
          throw new SkillPackageUploadError('SKILL_PACKAGE_LIMIT_EXCEEDED', 'zip 内文件数量超出限制', 413);
        }
        const relativePath = safeRelativePath(entry.fileName);
        if (!relativePath || paths.has(relativePath)) {
          throw new SkillPackageUploadError('SKILL_PACKAGE_UNSAFE', 'zip 内包含不安全或重复路径', 400);
        }
        paths.add(relativePath);
        const unixMode = entry.externalFileAttributes >>> 16;
        if ((unixMode & 0xf000) === 0xa000) {
          throw new SkillPackageUploadError('SKILL_PACKAGE_UNSAFE', 'zip 内包含符号链接', 400);
        }
        if (entry.uncompressedSize > MAX_SKILL_FILE_BYTES) {
          throw new SkillPackageUploadError('SKILL_PACKAGE_LIMIT_EXCEEDED', 'zip 内单个文件解压后大小超出限制', 413);
        }
        declaredTotalBytes += entry.uncompressedSize;
        if (declaredTotalBytes > MAX_SKILL_PACKAGE_BYTES) {
          throw new SkillPackageUploadError('SKILL_PACKAGE_LIMIT_EXCEEDED', 'zip 解压后大小超出限制', 413);
        }

        const targetPath = join(destination, relativePath);
        if (entry.fileName.endsWith('/')) {
          await mkdir(targetPath, { recursive: true });
          return;
        }
        await mkdir(dirname(targetPath), { recursive: true });
        const stream = await openZipEntryStream(zipFile, entry);
        const target = await open(targetPath, 'wx');
        let entryBytes = 0;
        try {
          for await (const chunk of stream) {
            const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            entryBytes += data.length;
            actualTotalBytes += data.length;
            if (entryBytes > MAX_SKILL_FILE_BYTES || actualTotalBytes > MAX_SKILL_PACKAGE_BYTES) {
              stream.destroy();
              throw new SkillPackageUploadError(
                'SKILL_PACKAGE_LIMIT_EXCEEDED',
                entryBytes > MAX_SKILL_FILE_BYTES
                  ? 'zip 内单个文件解压后大小超出限制'
                  : 'zip 解压后大小超出限制',
                413,
              );
            }
            await target.write(data);
          }
        } finally {
          await target.close();
        }
        if (entryBytes !== entry.uncompressedSize) {
          throw new SkillPackageUploadError('SKILL_PACKAGE_INVALID', 'zip 条目实际大小与目录声明不一致', 400);
        }
      })().then(() => zipFile.readEntry(), finish);
    });
    zipFile.readEntry();
  });
}

async function findSkillRoot(dir: string): Promise<string | null> {
  const direct = join(dir, 'SKILL.md');
  if ((await stat(direct).catch(() => null))?.isFile()) return dir;
  const entries = (await readdir(dir)).filter(name => !name.startsWith('.'));
  const matches: string[] = [];
  for (const name of entries) {
    const path = join(dir, name);
    if (
      (await stat(path).catch(() => null))?.isDirectory()
      && (await stat(join(path, 'SKILL.md')).catch(() => null))?.isFile()
    ) matches.push(path);
  }
  return matches.length === 1 ? matches[0] : null;
}

function validateSkillDocument(content: string): { name: string; description: string } | null {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return null;
  let name = '';
  let description = '';
  for (const line of match[1].split('\n')) {
    const nameMatch = line.match(/^name:\s*["']?(.*?)["']?\s*$/);
    if (nameMatch) name = nameMatch[1].trim();
    const descriptionMatch = line.match(/^description:\s*["']?(.*?)["']?\s*$/);
    if (descriptionMatch) description = descriptionMatch[1].trim();
  }
  if (!name || !description) return null;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(name)) return null;
  if (description.length > 1024) return null;
  return { name, description };
}

async function packageFingerprint(root: string): Promise<{
  contentDigest: string;
  fileCount: number;
  totalBytes: number;
}> {
  const files: Array<{ path: string; size: number }> = [];
  const visit = async (dir: string, prefix = ''): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) await visit(fullPath, relativePath);
      else if (entry.isFile()) {
        if (files.length >= MAX_SKILL_FILES) {
          throw new SkillPackageUploadError('SKILL_PACKAGE_LIMIT_EXCEEDED', '技能包文件数量超出限制', 413);
        }
        files.push({ path: relativePath, size: (await stat(fullPath)).size });
      } else throw new SkillPackageUploadError('SKILL_PACKAGE_UNSAFE', '技能包包含不安全文件', 400);
    }
  };
  await visit(root);
  const digest = createHash('sha256');
  let totalBytes = 0;
  for (const file of files) {
    const data = await readFile(join(root, file.path));
    totalBytes += file.size;
    if (totalBytes > MAX_SKILL_PACKAGE_BYTES) {
      throw new SkillPackageUploadError('SKILL_PACKAGE_LIMIT_EXCEEDED', '技能包解压后大小超出限制', 413);
    }
    // provenance digest 必须与物化副本同口径；node_modules 等目录虽可上传，物化时不落盘。
    if (!file.path.split('/').every((part) => shouldIncludeMaterializedPath(part))) continue;
    digest.update(file.path).update('\0').update(String(file.size)).update('\0').update(data);
  }
  return { contentDigest: digest.digest('hex'), fileCount: files.length, totalBytes };
}

function inspectZipArchive(buffer: Buffer): void {
  const eocdSignature = 0x06054b50;
  const centralSignature = 0x02014b50;
  const minimumOffset = Math.max(0, buffer.length - 22 - 0xffff);
  let eocdOffset = -1;
  for (let offset = buffer.length - 22; offset >= minimumOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== eocdSignature) continue;
    const commentLength = buffer.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === buffer.length) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new SkillPackageUploadError('SKILL_PACKAGE_INVALID', 'zip 中央目录无效', 400);
  }

  const diskNumber = buffer.readUInt16LE(eocdOffset + 4);
  const centralDisk = buffer.readUInt16LE(eocdOffset + 6);
  const diskEntries = buffer.readUInt16LE(eocdOffset + 8);
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralSize = buffer.readUInt32LE(eocdOffset + 12);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (diskNumber !== 0 || centralDisk !== 0 || diskEntries !== entryCount) {
    throw new SkillPackageUploadError('SKILL_PACKAGE_UNSAFE', '不支持分卷 zip 技能包', 400);
  }
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new SkillPackageUploadError('SKILL_PACKAGE_LIMIT_EXCEEDED', 'zip 技能包超出支持的大小范围', 413);
  }
  if (entryCount > MAX_SKILL_FILES) {
    throw new SkillPackageUploadError('SKILL_PACKAGE_LIMIT_EXCEEDED', 'zip 内文件数量超出限制', 413);
  }
  const centralEnd = centralOffset + centralSize;
  if (centralOffset > eocdOffset || centralEnd > eocdOffset) {
    throw new SkillPackageUploadError('SKILL_PACKAGE_INVALID', 'zip 中央目录无效', 400);
  }

  let cursor = centralOffset;
  let totalBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > centralEnd || buffer.readUInt32LE(cursor) !== centralSignature) {
      throw new SkillPackageUploadError('SKILL_PACKAGE_INVALID', 'zip 中央目录条目无效', 400);
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const fileNameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const externalAttributes = buffer.readUInt32LE(cursor + 38);
    const entryEnd = cursor + 46 + fileNameLength + extraLength + commentLength;
    if (entryEnd > centralEnd) {
      throw new SkillPackageUploadError('SKILL_PACKAGE_INVALID', 'zip 中央目录条目无效', 400);
    }
    if ((flags & 0x1) !== 0) {
      throw new SkillPackageUploadError('SKILL_PACKAGE_UNSAFE', '不支持加密 zip 技能包', 400);
    }
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw new SkillPackageUploadError('SKILL_PACKAGE_LIMIT_EXCEEDED', 'zip 技能包超出支持的大小范围', 413);
    }
    const entryName = buffer.subarray(cursor + 46, cursor + 46 + fileNameLength).toString('utf-8');
    if (!safeRelativePath(entryName)) {
      throw new SkillPackageUploadError('SKILL_PACKAGE_UNSAFE', 'zip 内包含不安全路径', 400);
    }
    const unixMode = externalAttributes >>> 16;
    if ((unixMode & 0xf000) === 0xa000) {
      throw new SkillPackageUploadError('SKILL_PACKAGE_UNSAFE', 'zip 内包含符号链接', 400);
    }
    if (uncompressedSize > MAX_SKILL_FILE_BYTES) {
      throw new SkillPackageUploadError('SKILL_PACKAGE_LIMIT_EXCEEDED', 'zip 内单个文件解压后大小超出限制', 413);
    }
    totalBytes += uncompressedSize;
    if (totalBytes > MAX_SKILL_PACKAGE_BYTES) {
      throw new SkillPackageUploadError('SKILL_PACKAGE_LIMIT_EXCEEDED', 'zip 解压后大小超出限制', 413);
    }
    cursor = entryEnd;
  }
  if (cursor !== centralEnd) {
    throw new SkillPackageUploadError('SKILL_PACKAGE_INVALID', 'zip 中央目录大小不一致', 400);
  }
}

export async function stageSkillPackage(files: Express.Multer.File[]): Promise<StagedSkillPackage> {
  if (files.length === 0) {
    throw new SkillPackageUploadError('SKILL_PACKAGE_EMPTY', '请选择要上传的技能文件', 400);
  }
  if (files.length > MAX_SKILL_FILES
    || files.some(file => file.size > MAX_SKILL_FILE_BYTES)
    || files.reduce((total, file) => total + file.size, 0) > MAX_SKILL_PACKAGE_BYTES) {
    throw new SkillPackageUploadError('SKILL_PACKAGE_LIMIT_EXCEEDED', '技能包文件数量或大小超出限制', 413);
  }
  const tempRoot = await mkdtemp(join(tmpdir(), 'skill-import-'));
  try {
    let sourceDir: string;
    const first = files[0];
    if (files.length === 1 && first.originalname.toLowerCase().endsWith('.zip')) {
      inspectZipArchive(first.buffer);
      const zipPath = join(tempRoot, 'upload.zip');
      await writeFile(zipPath, first.buffer);
      sourceDir = join(tempRoot, 'extracted');
      await mkdir(sourceDir, { recursive: true });
      await extractZipArchive(zipPath, sourceDir);
    } else {
      sourceDir = join(tempRoot, 'upload');
      for (const file of files) {
        const relativePath = safeRelativePath(file.originalname);
        if (!relativePath) {
          throw new SkillPackageUploadError('SKILL_PACKAGE_UNSAFE', `无效文件路径：${file.originalname}`, 400);
        }
        const targetPath = join(sourceDir, relativePath);
        await mkdir(dirname(targetPath), { recursive: true });
        await writeFile(targetPath, file.buffer);
      }
    }

    const skillRoot = await findSkillRoot(sourceDir);
    if (!skillRoot) {
      throw new SkillPackageUploadError(
        'SKILL_PACKAGE_STRUCTURE_INVALID',
        '上传内容根目录或唯一一级目录中必须包含 SKILL.md',
        400,
      );
    }
    const metadata = validateSkillDocument(await readFile(join(skillRoot, 'SKILL.md'), 'utf-8'));
    if (!metadata) {
      throw new SkillPackageUploadError(
        'SKILL_DOCUMENT_INVALID',
        'SKILL.md 必须包含 YAML frontmatter，name 需为小写字母/数字/连字符且 description 非空',
        400,
      );
    }
    const fingerprint = await packageFingerprint(skillRoot);
    return {
      tempRoot,
      skillRoot,
      skillId: metadata.name,
      name: metadata.name,
      description: metadata.description,
      ...fingerprint,
      dispose: () => rm(tempRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(tempRoot, { recursive: true, force: true });
    if (error instanceof SkillPackageUploadError) throw error;
    throw new SkillPackageUploadError('SKILL_PACKAGE_INVALID', '技能包无法解析，请检查压缩包和文件结构', 400);
  }
}

function skillAlreadyExists(skillId: string): SkillPackageUploadError {
  return new SkillPackageUploadError('SKILL_ALREADY_EXISTS', `技能“${skillId}”已存在`, 409);
}

export async function moveStagedSkillIntoPlace(
  staged: StagedSkillPackage,
  parentDir: string,
  workspaceManaged: boolean,
): Promise<string> {
  if (workspaceManaged) ensureWorkspaceDir(parentDir, 0o775);
  else await mkdir(parentDir, { recursive: true });

  const targetDir = join(parentDir, staged.skillId);
  try {
    await mkdir(targetDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') throw skillAlreadyExists(staged.skillId);
    throw error;
  }

  try {
    for (const entry of await readdir(staged.skillRoot)) {
      await cp(join(staged.skillRoot, entry), join(targetDir, entry), {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
    }
    if (workspaceManaged) await repairWorkspaceTreeAsync(targetDir);
    return targetDir;
  } catch (error) {
    await rm(targetDir, { recursive: true, force: true });
    throw error;
  }
}

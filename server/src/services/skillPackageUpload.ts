import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

import { ensureWorkspaceDir, repairWorkspaceTreeAsync } from '../workspace/permissions.js';

const execFileAsync = promisify(execFile);
const MAX_SKILL_FILES = 300;
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

async function containsSymlink(dir: string): Promise<boolean> {
  for (const entry of await readdir(dir)) {
    const full = join(dir, entry);
    const entryStat = await lstat(full);
    if (entryStat.isSymbolicLink()) return true;
    if (entryStat.isDirectory() && await containsSymlink(full)) return true;
  }
  return false;
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
    digest.update(file.path).update('\0').update(String(file.size)).update('\0').update(data);
  }
  return { contentDigest: digest.digest('hex'), fileCount: files.length, totalBytes };
}

export async function stageSkillPackage(files: Express.Multer.File[]): Promise<StagedSkillPackage> {
  if (files.length === 0) {
    throw new SkillPackageUploadError('SKILL_PACKAGE_EMPTY', '请选择要上传的技能文件', 400);
  }
  if (files.length > MAX_SKILL_FILES
    || files.reduce((total, file) => total + file.size, 0) > MAX_SKILL_PACKAGE_BYTES) {
    throw new SkillPackageUploadError('SKILL_PACKAGE_LIMIT_EXCEEDED', '技能包文件数量或大小超出限制', 413);
  }
  const tempRoot = await mkdtemp(join(tmpdir(), 'skill-import-'));
  try {
    let sourceDir: string;
    const first = files[0];
    if (files.length === 1 && first.originalname.toLowerCase().endsWith('.zip')) {
      const zipPath = join(tempRoot, 'upload.zip');
      await writeFile(zipPath, first.buffer);
      const listed = await execFileAsync('unzip', ['-Z', '-1', zipPath], { encoding: 'utf-8' });
      const zipEntries = listed.stdout.split('\n').filter(Boolean);
      if (zipEntries.length > MAX_SKILL_FILES) {
        throw new SkillPackageUploadError('SKILL_PACKAGE_LIMIT_EXCEEDED', 'zip 内文件数量超出限制', 413);
      }
      if (zipEntries.some(entry => !safeRelativePath(entry))) {
        throw new SkillPackageUploadError('SKILL_PACKAGE_UNSAFE', 'zip 内包含不安全路径', 400);
      }
      sourceDir = join(tempRoot, 'extracted');
      await mkdir(sourceDir, { recursive: true });
      await execFileAsync('unzip', ['-q', zipPath, '-d', sourceDir]);
      if (await containsSymlink(sourceDir)) {
        throw new SkillPackageUploadError('SKILL_PACKAGE_UNSAFE', 'zip 内包含不安全路径', 400);
      }
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

export async function moveStagedSkillIntoPlace(
  staged: StagedSkillPackage,
  parentDir: string,
  workspaceManaged: boolean,
): Promise<string> {
  const targetDir = join(parentDir, staged.skillId);
  if (existsSync(targetDir)) {
    throw new SkillPackageUploadError('SKILL_ALREADY_EXISTS', `技能“${staged.skillId}”已存在`, 409);
  }
  if (workspaceManaged) ensureWorkspaceDir(parentDir, 0o775);
  else await mkdir(parentDir, { recursive: true });
  try {
    await rename(staged.skillRoot, targetDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EXDEV') throw error;
    try {
      await cp(staged.skillRoot, targetDir, { recursive: true, errorOnExist: true });
    } catch (copyError) {
      if (existsSync(targetDir)) {
        await rename(targetDir, join(parentDir, `.failed-${staged.skillId}-${Date.now()}`)).catch(() => undefined);
      }
      throw copyError;
    }
  }
  if (workspaceManaged) await repairWorkspaceTreeAsync(targetDir);
  return targetDir;
}

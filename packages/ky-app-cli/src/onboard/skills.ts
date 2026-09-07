import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';

import type { Manifest } from '@kaiyan/ky-app-contract';

import { KyAppPlatformError, platformFormRequest, platformRequest } from './platformClient.js';

interface LocalSkillPackage {
  id: string;
  root: string;
  files: Array<{ path: string; data: Buffer }>;
  contentDigest: string;
}

const EXCLUDED_NAMES = new Set(['__pycache__', '.DS_Store', 'node_modules']);

function resourceId(tenantId: string, skillId: string): string {
  return `tenant_${createHash('sha256').update(`${tenantId}\0${skillId}`).digest('hex').slice(0, 32)}`;
}

function readSkillId(document: string): string {
  const frontmatter = document.match(/^---\s*\n([\s\S]*?)\n---/u)?.[1] ?? '';
  const id = frontmatter
    .split('\n')
    .map((line) => line.match(/^name:\s*["']?(.*?)["']?\s*$/u)?.[1]?.trim())
    .find(Boolean);
  if (!id || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(id)) {
    throw new Error('技能 SKILL.md 缺少合法的 name');
  }
  return id;
}

async function collectFiles(root: string): Promise<Array<{ path: string; data: Buffer }>> {
  const files: Array<{ path: string; data: Buffer }> = [];
  const visit = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (EXCLUDED_NAMES.has(entry.name)) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`技能包不能包含符号链接：${fullPath}`);
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile())
        files.push({
          path: relative(root, fullPath).replaceAll('\\', '/'),
          data: await readFile(fullPath),
        });
    }
  };
  await visit(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function loadPackage(projectDir: string, manifestPath: string): Promise<LocalSkillPackage> {
  const normalized = manifestPath.replaceAll('\\', '/');
  if (!/^skills\/[a-z0-9-]+\/SKILL\.md$/u.test(normalized)) {
    throw new Error(`manifest 技能路径必须为 skills/<name>/SKILL.md：${manifestPath}`);
  }
  const root = resolve(projectDir, dirname(normalized));
  const projectRoot = resolve(projectDir);
  if (!root.startsWith(`${projectRoot}/`)) throw new Error(`技能路径越界：${manifestPath}`);
  const document = await readFile(join(root, basename(normalized)), 'utf8');
  const files = await collectFiles(root);
  const digest = createHash('sha256');
  for (const file of files) {
    digest
      .update(file.path)
      .update('\0')
      .update(String(file.data.length))
      .update('\0')
      .update(file.data);
  }
  return { id: readSkillId(document), root, files, contentDigest: digest.digest('hex') };
}

async function alreadyInstalled(input: {
  baseUrl: string;
  token: string;
  tenantId: string;
  skillId: string;
  contentDigest: string;
}): Promise<boolean> {
  try {
    const current = await platformRequest<{
      version?: { definition?: { contentDigest?: unknown } } | null;
    }>({
      baseUrl: input.baseUrl,
      token: input.token,
      path: `/api/governance/resources/skills/${resourceId(input.tenantId, input.skillId)}?tenantId=${encodeURIComponent(input.tenantId)}&includeVersion=true`,
    });
    if (current.version?.definition?.contentDigest !== input.contentDigest) {
      throw new Error(
        `租户技能 ${input.skillId} 已存在，但内容与当前项目不一致；请先完成技能版本治理，不能静默复用旧内容`,
      );
    }
    return true;
  } catch (error) {
    if (error instanceof KyAppPlatformError && error.status === 404) return false;
    throw error;
  }
}

export async function installManifestSkills(input: {
  baseUrl: string;
  token: string;
  tenantId: string;
  projectDir: string;
  manifest: Manifest;
}): Promise<{ installed: string[]; existing: string[] }> {
  const result = { installed: [] as string[], existing: [] as string[] };
  for (const item of input.manifest.skills ?? []) {
    const skill = await loadPackage(input.projectDir, item.path);
    if (
      await alreadyInstalled({
        ...input,
        skillId: skill.id,
        contentDigest: skill.contentDigest,
      })
    ) {
      result.existing.push(skill.id);
      continue;
    }
    const form = new FormData();
    for (const file of skill.files) form.append('files', new Blob([file.data]), file.path);
    await platformFormRequest({
      baseUrl: input.baseUrl,
      token: input.token,
      path: `/api/governance/resources/skills/import?scope=tenant&tenantId=${encodeURIComponent(input.tenantId)}`,
      body: form,
    });
    result.installed.push(skill.id);
  }
  return result;
}

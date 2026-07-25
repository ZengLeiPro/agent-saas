/**
 * 租户级自定义规则（`instructions.md`）。
 *
 * 与 company.md 的区别是语义，不是形态：
 *   - company.md      = 组织**事实**（业务、产品、团队、制度），注入靠前，稳定可缓存
 *   - instructions.md = 组织**行为规则**（语气、格式偏好、岗位约定），注入靠后，
 *                       需要能覆盖平台默认风格
 * 两者不合并成一个文件，正是因为注入位置和覆盖语义不同。
 *
 * 上限 20k 远小于 company.md 的 200k：行为规则写长了本身就是反模式，
 * 长内容应该进 company.md（事实）或 Skill（流程）。
 */

import { mkdirSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { resolveTenantFilePath } from './tenantFiles.js';

export const MAX_TENANT_INSTRUCTIONS_CHARS = 20_000;

export function resolveTenantInstructionsPath(sharedDir: string, tenantId: string): string {
  return resolveTenantFilePath(sharedDir, tenantId, 'instructions.md');
}

export async function readTenantInstructions(
  sharedDir: string,
  tenantId: string,
): Promise<string | null> {
  try {
    return await readFile(resolveTenantInstructionsPath(sharedDir, tenantId), 'utf-8');
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code?: unknown }).code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

export function readTenantInstructionsSync(sharedDir: string, tenantId: string): string | null {
  try {
    return readFileSync(resolveTenantInstructionsPath(sharedDir, tenantId), 'utf-8');
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code?: unknown }).code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

export async function writeTenantInstructions(
  sharedDir: string,
  tenantId: string,
  content: string,
): Promise<{ path: string; chars: number }> {
  if (content.length > MAX_TENANT_INSTRUCTIONS_CHARS) {
    throw new Error(`instructions.md 内容不超过 ${MAX_TENANT_INSTRUCTIONS_CHARS} 字符`);
  }
  const path = resolveTenantInstructionsPath(sharedDir, tenantId);
  mkdirSync(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf-8');
  return { path, chars: content.length };
}

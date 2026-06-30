import { mkdirSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import { TENANT_SLUG_PATTERN } from './types.js';

export const MAX_COMPANY_INFO_CHARS = 200_000;

function isInside(baseDir: string, candidate: string): boolean {
  const rel = relative(baseDir, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function resolveTenantCompanyInfoPath(sharedDir: string, tenantId: string): string {
  if (!TENANT_SLUG_PATTERN.test(tenantId)) {
    throw new Error(`Invalid tenant id "${tenantId}"`);
  }
  const tenantsRoot = resolve(sharedDir, 'tenants');
  const path = resolve(tenantsRoot, tenantId, 'company.md');
  if (!isInside(tenantsRoot, path)) {
    throw new Error(`Invalid tenant company info path for "${tenantId}"`);
  }
  return path;
}

export async function readTenantCompanyInfo(sharedDir: string, tenantId: string): Promise<string | null> {
  try {
    return await readFile(resolveTenantCompanyInfoPath(sharedDir, tenantId), 'utf-8');
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code?: unknown }).code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

export function readTenantCompanyInfoSync(sharedDir: string, tenantId: string): string | null {
  try {
    return readFileSync(resolveTenantCompanyInfoPath(sharedDir, tenantId), 'utf-8');
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code?: unknown }).code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

export async function writeTenantCompanyInfo(
  sharedDir: string,
  tenantId: string,
  content: string,
): Promise<{ path: string; chars: number }> {
  if (content.length > MAX_COMPANY_INFO_CHARS) {
    throw new Error(`company.md 内容不超过 ${MAX_COMPANY_INFO_CHARS} 字符`);
  }
  const path = resolveTenantCompanyInfoPath(sharedDir, tenantId);
  mkdirSync(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf-8');
  return { path, chars: content.length };
}

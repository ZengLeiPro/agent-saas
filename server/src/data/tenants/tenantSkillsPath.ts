import { isAbsolute, relative, resolve } from 'node:path';

import { TENANT_SLUG_PATTERN } from './types.js';

function isInside(baseDir: string, candidate: string): boolean {
  const rel = relative(baseDir, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * 租户自有 skill 目录：`${sharedDir}/tenants/<tenantId>/skills/`（与 company.md 同级）。
 * 与 resolveTenantCompanyInfoPath 同口径：slug 校验 + 防路径穿越。
 */
export function resolveTenantSkillsDir(sharedDir: string, tenantId: string): string {
  if (!TENANT_SLUG_PATTERN.test(tenantId)) {
    throw new Error(`Invalid tenant id "${tenantId}"`);
  }
  const tenantsRoot = resolve(sharedDir, 'tenants');
  const path = resolve(tenantsRoot, tenantId, 'skills');
  if (!isInside(tenantsRoot, path)) {
    throw new Error(`Invalid tenant skills path for "${tenantId}"`);
  }
  return path;
}

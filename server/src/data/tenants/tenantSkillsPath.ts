import { isAbsolute, relative, resolve } from 'node:path';

import { TENANT_SLUG_PATTERN } from './types.js';

function isInside(baseDir: string, candidate: string): boolean {
  const rel = relative(baseDir, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function resolveTenantSkillsDirFromRoot(tenantsRootDir: string, tenantId: string): string {
  if (!TENANT_SLUG_PATTERN.test(tenantId)) {
    throw new Error(`Invalid tenant id "${tenantId}"`);
  }
  const tenantsRoot = resolve(tenantsRootDir);
  const path = resolve(tenantsRoot, tenantId, 'skills');
  if (!isInside(tenantsRoot, path)) {
    throw new Error(`Invalid tenant skills path for "${tenantId}"`);
  }
  return path;
}

/**
 * 租户自有 skill 目录：`${sharedDir}/tenants/<tenantId>/skills/`。
 *
 * 仅作为旧布局兼容入口保留。生产运行时应优先传入持久化的
 * tenantSkillsRootDir，并调用 resolveTenantSkillsDirFromRoot()，避免在线上传的
 * 组织 skill 写进 release 目录后被下一次部署覆盖。
 */
export function resolveTenantSkillsDir(sharedDir: string, tenantId: string): string {
  return resolveTenantSkillsDirFromRoot(resolve(sharedDir, 'tenants'), tenantId);
}

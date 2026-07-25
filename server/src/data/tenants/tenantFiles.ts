/**
 * 租户级文本文件的公共路径解析。
 *
 * company.md 与 instructions.md 都落在 `<sharedDir>/tenants/<tenantId>/` 下，
 * 两者的 slug 校验与 path traversal 防护必须是同一份实现——安全逻辑重复写两遍
 * 迟早会分叉，业务逻辑重复可以接受，这个不行。
 */

import { isAbsolute, relative, resolve } from 'node:path';

import { TENANT_SLUG_PATTERN } from './types.js';

function isInside(baseDir: string, candidate: string): boolean {
  const rel = relative(baseDir, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * 解析租户目录下某个文件的绝对路径。
 * tenantId 非法或解析结果逃出 tenants 根目录时抛错，不返回可疑路径。
 */
export function resolveTenantFilePath(
  sharedDir: string,
  tenantId: string,
  fileName: string,
): string {
  if (!TENANT_SLUG_PATTERN.test(tenantId)) {
    throw new Error(`Invalid tenant id "${tenantId}"`);
  }
  const tenantsRoot = resolve(sharedDir, 'tenants');
  const path = resolve(tenantsRoot, tenantId, fileName);
  if (!isInside(tenantsRoot, path)) {
    throw new Error(`Invalid tenant file path for "${tenantId}/${fileName}"`);
  }
  return path;
}

import { rm } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { OrgAgentStore } from '../orgAgents/store.js';
import { seedOrgAgentTemplatesForTenant } from '../orgAgentTemplates.js';
import { apiLogger } from '../../utils/logger.js';
import { resolveTenantCompanyInfoPath, writeTenantCompanyInfo } from './companyInfo.js';
import type { TenantStore } from './store.js';
import type { TenantRecord } from './types.js';

export interface TenantProvisioningOptions {
  tenantStore: TenantStore;
  sharedDir: string;
  orgAgentStore?: OrgAgentStore;
}

export interface TenantProvisioningInput {
  id: string;
  name: string;
  createdBy: string;
}

/** 新组织的最小 company.md，避免 Agent 在资料未配置时编造组织信息。 */
function buildInitialCompanyInfo(tenantName: string): string {
  return [
    `# 组织名称：${tenantName}`,
    '',
    '（除组织名称外，本组织的详细资料尚未配置。当用户问及公司业务、产品、团队、制度等信息时，如实说明组织资料还未完善，不要编造；并提示：组织管理员可在管理后台「组织管理 → 公司信息」页补充，补充后新会话自动生效。）',
    '',
  ].join('\n');
}

/**
 * 创建权威组织记录，并执行不阻断创建结果的冷启动初始化。
 * TenantStore 持久化成功即视为创建成功；资料与种子专家均可由管理员后续补齐。
 */
export async function provisionTenant(
  options: TenantProvisioningOptions,
  input: TenantProvisioningInput,
): Promise<TenantRecord> {
  const tenant = await options.tenantStore.create(input);

  try {
    await writeTenantCompanyInfo(options.sharedDir, tenant.id, buildInitialCompanyInfo(tenant.name));
  } catch (error) {
    apiLogger.warn(`初始化 company.md 失败（tenant=${tenant.id}）: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (options.orgAgentStore) {
    try {
      const seedResult = await seedOrgAgentTemplatesForTenant(options.orgAgentStore, tenant.id, 'system');
      if (seedResult.seeded.length > 0) {
        apiLogger.info(
          `[org-agent-templates] seed 完成 tenant=${tenant.id} `
            + `seeded=[${seedResult.seeded.join(',')}] `
            + `skipped=[${seedResult.skipped.join(',')}] `
            + `errors=${seedResult.errors.length}`,
        );
      }
      for (const item of seedResult.errors) {
        apiLogger.warn(`[org-agent-templates] seed 失败 tenant=${tenant.id} template=${item.templateId}: ${item.error}`);
      }
    } catch (error) {
      apiLogger.warn(`[org-agent-templates] seed 异常 tenant=${tenant.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return tenant;
}

/** 创建回执无法安全落地时，删除刚创建的组织及其冷启动资源。 */
export async function rollbackProvisionedTenant(
  options: TenantProvisioningOptions,
  tenantId: string,
): Promise<void> {
  await options.tenantStore.delete(tenantId);

  const cleanupResults = await Promise.allSettled([
    rm(dirname(resolveTenantCompanyInfoPath(options.sharedDir, tenantId)), { recursive: true, force: true }),
    ...(options.orgAgentStore
      ? options.orgAgentStore.listByTenant(tenantId).map(agent => options.orgAgentStore!.remove(agent.id))
      : []),
  ]);
  const failures = cleanupResults.filter(result => result.status === 'rejected');
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map(result => (result as PromiseRejectedResult).reason),
      `Tenant provisioning rollback incomplete: ${tenantId}`,
    );
  }
}

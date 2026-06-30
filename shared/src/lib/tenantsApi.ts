/**
 * /api/tenants 平台/组织相关接口的前端 client。
 *
 * 当前承载 tenant-scoped company.md 读写——其他 tenant 元数据/settings 接口仍直接走 authFetch
 * 在各业务组件里调用（TenantManager / AdminShells.TenantSettingsPanel）。
 * 后续如需统一，可逐步收敛到这里。
 */
import { authFetch } from './authFetch';

/**
 * 读取指定组织的 company.md（注入到该组织 agent 的 system prompt 作为 {{COMPANY_INFO}}）。
 * 平台 admin 可读任意组织；组织 admin 仅可读自己组织；文件不存在时返回空串。
 */
export async function fetchTenantCompanyInfo(tenantId: string): Promise<string> {
  const res = await authFetch(`/api/tenants/${encodeURIComponent(tenantId)}/company-info`);
  if (!res.ok) throw new Error(`Failed to fetch company info: ${res.status}`);
  const data = (await res.json()) as { content: string };
  return data.content;
}

/**
 * 写入指定组织的 company.md。
 * 平台 admin 可写任意组织；组织 admin 仅可写自己组织。
 */
export async function updateTenantCompanyInfo(tenantId: string, content: string): Promise<void> {
  const res = await authFetch(`/api/tenants/${encodeURIComponent(tenantId)}/company-info`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    let msg = `更新失败 (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) msg = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
}

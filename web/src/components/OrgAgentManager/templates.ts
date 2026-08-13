import { authFetch } from '@/lib/authFetch';
import type { OrgAgentFormValues } from './types';

/**
 * 企业专家模板只接受后端 GET /api/tenant/expert-templates 的权威投影。
 * 后端数据源是 ORG_AGENT_SEED_TEMPLATES；请求失败或契约错误必须显式报错，
 * 不再用前端 hardcode 伪装加载成功。
 */
export interface OrgAgentTemplate {
  key: string;
  name: string;
  description: string;
  avatar: string;
  icon: string;
  values: OrgAgentFormValues;
}

function isTemplate(value: unknown): value is OrgAgentTemplate {
  if (!value || typeof value !== 'object') return false;
  const template = value as Partial<OrgAgentTemplate>;
  const values = template.values as Partial<OrgAgentFormValues> | undefined;
  return typeof template.key === 'string'
    && typeof template.name === 'string'
    && typeof template.description === 'string'
    && typeof template.avatar === 'string'
    && typeof template.icon === 'string'
    && !!values
    && typeof values.name === 'string'
    && typeof values.instructions === 'string'
    && Array.isArray(values.allowedSkills)
    && Array.isArray(values.guardrailAllowExamples)
    && Array.isArray(values.guardrailRejectExamples);
}

export async function fetchOrgAgentTemplates(): Promise<OrgAgentTemplate[]> {
  const res = await authFetch('/api/tenant/expert-templates');
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const message = data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string'
      ? (data as { error: string }).error
      : `HTTP ${res.status}`;
    throw new Error(`加载企业专家模板失败：${message}`);
  }
  if (!Array.isArray(data) || !data.every(isTemplate)) {
    throw new Error('加载企业专家模板失败：后端返回格式无效');
  }
  return data;
}

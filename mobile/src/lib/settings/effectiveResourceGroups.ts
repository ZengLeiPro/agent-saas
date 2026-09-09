/**
 * 「我的权限」有效资源分组 —— 与 Web `Governance/EffectiveResourceList.tsx`
 * 同一信息结构：仅保留已生效的业务能力，按面向用户的四类分组。
 *
 * 纯函数、无 React 依赖：客户端不推导权限，只做分组与文案投影。
 */
import type { EffectiveResourceView, GovernanceDomain } from '@agent/shared/types/governance';

/** 与 Web `DOMAINS` 常量同序。 */
export const GOVERNANCE_DOMAIN_ORDER: readonly GovernanceDomain[] = [
  'agent',
  'skill',
  'connector',
  'environment',
];

/** 与 Web `domainLabel` 一致。 */
export const GOVERNANCE_DOMAIN_LABELS: Record<GovernanceDomain, string> = {
  agent: 'Agent',
  skill: '技能',
  connector: '连接器',
  environment: '执行环境',
  memory: '记忆',
  file: '文件',
  automation: '自动化',
  model_tool: '模型与工具',
};

export interface EffectiveResourceRow {
  /** `type:id`，与 Web 的 list key 一致。 */
  key: string;
  displayName: string;
}

export interface EffectiveResourceGroup {
  domain: GovernanceDomain;
  label: string;
  rows: EffectiveResourceRow[];
}

export function toEffectiveResourceRow(resource: EffectiveResourceView): EffectiveResourceRow {
  return {
    key: `${resource.resource.type}:${resource.resource.id}`,
    displayName: resource.resource.displayName,
  };
}

/**
 * 按 Web 的四个业务 domain 固定顺序分组；不可用能力和内部 domain 均不返回。
 */
export function groupEffectiveResources(
  resources: readonly EffectiveResourceView[],
): EffectiveResourceGroup[] {
  const buckets = new Map<string, EffectiveResourceView[]>();
  for (const resource of resources) {
    if (resource.primaryResult.code !== 'available') continue;
    const domain = resource.resource.domain;
    if (!(GOVERNANCE_DOMAIN_ORDER as readonly string[]).includes(domain)) continue;
    const bucket = buckets.get(domain);
    if (bucket) bucket.push(resource);
    else buckets.set(domain, [resource]);
  }
  const ordered = GOVERNANCE_DOMAIN_ORDER.filter((domain) => buckets.has(domain));
  return ordered.map((domain) => ({
    domain: domain as GovernanceDomain,
    label: GOVERNANCE_DOMAIN_LABELS[domain as GovernanceDomain] ?? domain,
    rows: (buckets.get(domain) ?? []).map(toEffectiveResourceRow),
  }));
}

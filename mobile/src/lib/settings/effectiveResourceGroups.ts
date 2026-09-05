/**
 * 「我的权限」有效资源分组 —— 与 Web `Governance/EffectiveResourceList.tsx`
 * 同一信息结构：按治理 domain 固定顺序分组，组内逐条展示
 * 「资源名 / 权威结论 / 决定因素 / 访问判定 / 执行就绪」。
 *
 * 纯函数、无 React 依赖：客户端不推导权限，只做分组与文案投影。
 */
import type { EffectiveResourceView, GovernanceDomain } from '@agent/shared/types/governance';

/** 与 Web `DOMAINS` 常量同序。 */
export const GOVERNANCE_DOMAIN_ORDER: readonly GovernanceDomain[] = [
  'agent',
  'skill',
  'connector',
  'memory',
  'file',
  'automation',
  'model_tool',
  'environment',
];

/** 与 Web `domainLabel` 一致。 */
export const GOVERNANCE_DOMAIN_LABELS: Record<GovernanceDomain, string> = {
  agent: 'Agent',
  skill: '技能',
  connector: '连接器',
  memory: '记忆',
  file: '文件',
  automation: '自动化',
  model_tool: '模型与工具',
  environment: '环境',
};

export interface EffectiveResourceRow {
  /** `type:id`，与 Web 的 list key 一致。 */
  key: string;
  displayName: string;
  /** 权威结论文案（primaryResult.label）。 */
  resultLabel: string;
  /** 决定因素 + 访问判定 + 执行就绪，逐行展示的次要说明。 */
  detailLines: string[];
}

export interface EffectiveResourceGroup {
  domain: GovernanceDomain;
  label: string;
  rows: EffectiveResourceRow[];
}

function readinessLine(resource: EffectiveResourceView): string {
  if (!resource.readiness) return '执行就绪：权威数据不可用';
  if (resource.readiness.ready) return '执行就绪：已就绪';
  return `执行就绪：${resource.readiness.blockers[0]?.message ?? '不可执行'}`;
}

export function toEffectiveResourceRow(resource: EffectiveResourceView): EffectiveResourceRow {
  return {
    key: `${resource.resource.type}:${resource.resource.id}`,
    displayName: resource.resource.displayName,
    resultLabel: resource.primaryResult.label,
    detailLines: [
      `决定因素：${resource.decisiveFactor.label}`,
      `访问判定：${resource.access.reason}`,
      readinessLine(resource),
    ],
  };
}

/**
 * 按 Web 的 domain 固定顺序分组；空组不返回。
 * 清单里出现未知 domain 时不吞掉：追加到末尾，标签退化为 domain 原值。
 */
export function groupEffectiveResources(
  resources: readonly EffectiveResourceView[],
): EffectiveResourceGroup[] {
  const buckets = new Map<string, EffectiveResourceView[]>();
  for (const resource of resources) {
    const domain = resource.resource.domain;
    const bucket = buckets.get(domain);
    if (bucket) bucket.push(resource);
    else buckets.set(domain, [resource]);
  }
  const ordered: string[] = [
    ...GOVERNANCE_DOMAIN_ORDER.filter((domain) => buckets.has(domain)),
    ...[...buckets.keys()].filter(
      (domain) => !(GOVERNANCE_DOMAIN_ORDER as readonly string[]).includes(domain),
    ),
  ];
  return ordered.map((domain) => ({
    domain: domain as GovernanceDomain,
    label: GOVERNANCE_DOMAIN_LABELS[domain as GovernanceDomain] ?? domain,
    rows: (buckets.get(domain) ?? []).map(toEffectiveResourceRow),
  }));
}

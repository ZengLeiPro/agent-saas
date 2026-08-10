import type {
  EffectiveResourceView,
  GovernanceDomain,
  NextAction,
} from '@agent/shared/types/governance';

import { Button } from '@/components/ui/button';

import { GovernanceStatusBadge } from './GovernanceStatusBadge';
import { GovernanceUnavailable } from './GovernanceUnavailable';

const DOMAINS: GovernanceDomain[] = [
  'agent', 'skill', 'connector', 'memory', 'file', 'automation', 'model_tool', 'environment',
];

const domainLabel: Record<GovernanceDomain, string> = {
  agent: 'Agent',
  skill: '技能',
  connector: '连接器',
  memory: '记忆',
  file: '文件',
  automation: '自动化',
  model_tool: '模型与工具',
  environment: '环境',
};

export interface EffectiveResourceListProps {
  resources: EffectiveResourceView[] | null;
  loading?: boolean;
  error?: Error | string | null;
  onRetry?: () => void;
  onAction?: (action: NextAction, resource: EffectiveResourceView) => void;
  className?: string;
}

function ResourceAction({
  action,
  resource,
  onAction,
}: {
  action: NextAction;
  resource: EffectiveResourceView;
  onAction?: EffectiveResourceListProps['onAction'];
}) {
  if (action.href) {
    return <Button asChild size="sm" variant="outline"><a href={action.href}>{action.label}</a></Button>;
  }
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={!onAction}
      onClick={() => onAction?.(action, resource)}
    >
      {action.label}
    </Button>
  );
}

export function EffectiveResourceList({
  resources,
  loading = false,
  error,
  onRetry,
  onAction,
  className = '',
}: EffectiveResourceListProps) {
  if (error) return <GovernanceUnavailable error={error} onRetry={onRetry} retrying={loading} className={className} />;
  if (loading && resources === null) {
    return <div className={className} role="status" aria-live="polite">正在获取权威治理结论…</div>;
  }

  const groups = new Map<GovernanceDomain, EffectiveResourceView[]>();
  for (const domain of DOMAINS) groups.set(domain, []);
  for (const resource of resources ?? []) groups.get(resource.resource.domain)?.push(resource);

  if (!resources?.length) return <p className={`text-sm text-muted-foreground ${className}`}>没有返回有效资源。</p>;

  return (
    <div className={`space-y-6 ${className}`} aria-busy={loading}>
      {DOMAINS.map((domain) => {
        const items = groups.get(domain) ?? [];
        if (!items.length) return null;
        return (
          <section key={domain} aria-labelledby={`governance-domain-${domain}`}>
            <h2 id={`governance-domain-${domain}`} className="mb-2 text-sm font-semibold">{domainLabel[domain]}</h2>
            <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
              {items.map((resource) => {
                const action = resource.access.nextActions[0];
                return (
                  <li key={`${resource.resource.type}:${resource.resource.id}`} className="grid gap-3 p-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] md:items-center">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{resource.resource.displayName}</p>
                      <GovernanceStatusBadge label={resource.primaryResult.label} className="mt-1" />
                    </div>
                    <div className="min-w-0 text-sm">
                      <span className="text-muted-foreground">决定因素：</span>
                      <span>{resource.decisiveFactor.label}</span>
                    </div>
                    <div>{action ? <ResourceAction action={action} resource={resource} onAction={onAction} /> : null}</div>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

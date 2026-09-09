import type { EffectiveResourceView, GovernanceDomain } from '@agent/shared/types/governance';

import { Button } from '@/components/ui/button';

const DOMAIN_ORDER: GovernanceDomain[] = ['agent', 'skill', 'connector', 'environment'];

const DOMAIN_LABEL: Partial<Record<GovernanceDomain, string>> = {
  agent: 'Agent',
  skill: '技能',
  connector: '连接器',
  environment: '执行环境',
};

export function availablePermissionResources(
  resources: EffectiveResourceView[] | null,
): EffectiveResourceView[] {
  return (resources ?? []).filter((resource) => resource.primaryResult.code === 'available');
}

export function MyPermissionList({
  resources,
  loading,
  error,
  onRetry,
}: {
  resources: EffectiveResourceView[] | null;
  loading: boolean;
  error: Error | string | null;
  onRetry: () => void;
}) {
  if (error) {
    return (
      <div
        className="flex min-h-48 flex-col items-center justify-center rounded-2xl border bg-card p-6 text-center shadow-sm"
        role="alert"
      >
        <div className="font-medium">暂时无法加载我的权限</div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-4"
          onClick={onRetry}
          disabled={loading}
        >
          重新加载
        </Button>
      </div>
    );
  }

  if (loading && resources === null) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground" role="status">
        正在加载我的权限…
      </div>
    );
  }

  const available = availablePermissionResources(resources);
  if (!available.length) {
    return (
      <div className="rounded-2xl border border-dashed p-8 text-center text-sm text-muted-foreground">
        当前没有可展示的有效权限。
      </div>
    );
  }

  return (
    <div className="space-y-6" aria-busy={loading}>
      {DOMAIN_ORDER.map((domain) => {
        const items = available.filter((resource) => resource.resource.domain === domain);
        if (!items.length) return null;
        return (
          <section key={domain} aria-labelledby={`my-permission-${domain}`}>
            <h2 id={`my-permission-${domain}`} className="mb-2 text-sm font-semibold">
              {DOMAIN_LABEL[domain]}
            </h2>
            <ul className="divide-y overflow-hidden rounded-xl border bg-card shadow-sm">
              {items.map((resource) => (
                <li
                  key={`${resource.resource.type}:${resource.resource.id}`}
                  className="flex items-center justify-between gap-4 px-4 py-3"
                >
                  <span className="min-w-0 truncate text-sm font-medium">
                    {resource.resource.displayName}
                  </span>
                  <span className="shrink-0 rounded-full bg-success/10 px-2.5 py-1 text-xs font-medium text-success">
                    可使用
                  </span>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

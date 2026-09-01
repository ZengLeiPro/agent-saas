import { ArrowRight } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { governanceRoute } from '@/lib/governanceNavigation';
import { navigateGovernance } from '@/lib/urlSync';

import { TARGETS, secretAreaLabel, type ConfigTarget } from './configStatusTargets';
import type { EffectiveConfigStatus } from './types';

const SECRET_STATUS = {
  reference: { label: '引用就绪', variant: 'success' as const, order: 2 },
  legacy_inline: { label: '历史内联', variant: 'warning' as const, order: 1 },
  missing: { label: '缺失', variant: 'danger' as const, order: 0 },
};

function openTarget(target: Exclude<ConfigTarget, null>): void {
  navigateGovernance(governanceRoute(TARGETS[target].routeId));
}

function TargetAction({ target, ariaLabel }: { target: ConfigTarget; ariaLabel: string }) {
  if (!target) {
    return <span className="shrink-0 text-xs text-muted-foreground">暂无后台入口</span>;
  }
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-label={ariaLabel}
      onClick={() => openTarget(target)}
    >
      去配置
      <ArrowRight className="size-3.5" />
    </Button>
  );
}

export function ConfigStatusSecrets({ secrets }: { secrets: EffectiveConfigStatus['secrets'] }) {
  const items = secrets.items
    ? [...secrets.items].sort((left, right) => {
        const statusOrder = SECRET_STATUS[left.status].order - SECRET_STATUS[right.status].order;
        return statusOrder || left.path.localeCompare(right.path);
      })
    : null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Secret 配置定位</CardTitle>
        <p className="text-sm text-muted-foreground">
          仅展示配置字段路径和就绪状态，不返回 Secret 明文或 Vault 引用标识。
        </p>
      </CardHeader>
      <CardContent>
        {items === null ? (
          <p className="text-sm text-muted-foreground">
            当前服务尚未返回逐项清单，请刷新或升级服务端后重试。
          </p>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">当前有效配置中未识别到 Secret 字段。</p>
        ) : (
          <div className="space-y-2">
            {items.map((item) => {
              const status = SECRET_STATUS[item.status];
              const areaLabel = secretAreaLabel(item.path);
              return (
                <div
                  key={`${item.path}:${item.status}`}
                  className="flex min-h-16 items-center justify-between gap-3 rounded-lg border px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <span>{areaLabel}</span>
                      <Badge variant={status.variant}>{status.label}</Badge>
                    </div>
                    <code className="mt-1 block break-all text-xs text-muted-foreground">
                      {item.path}
                    </code>
                  </div>
                  <TargetAction target={item.target} ariaLabel={`配置 ${areaLabel} ${item.path}`} />
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

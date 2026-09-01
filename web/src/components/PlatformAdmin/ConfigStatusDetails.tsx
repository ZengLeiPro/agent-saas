import { ArrowRight } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { governanceRoute } from '@/lib/governanceNavigation';
import { navigateGovernance } from '@/lib/urlSync';

import type { EffectiveConfigStatus } from './types';

type SecretItem = NonNullable<EffectiveConfigStatus['secrets']['items']>[number];
type ConfigTarget = SecretItem['target'];

const TARGETS: Record<Exclude<ConfigTarget, null>, { label: string; routeId: string }> = {
  models: { label: '模型配置', routeId: 'platform.resource-center.models' },
  tools: { label: '工具配置', routeId: 'platform.resource-center.tools' },
  memory: { label: '记忆策略', routeId: 'platform.governance.memory-policy' },
  system: { label: '系统配置', routeId: 'platform.governance.system-settings' },
  execution: { label: '执行提供方', routeId: 'platform.runtime.execution-providers' },
};

const CAPABILITIES: Record<string, { label: string; source: string; target: ConfigTarget }> = {
  models: { label: '模型', source: 'models.groups', target: 'models' },
  codex: { label: 'Codex', source: 'codexSubscription.enabled', target: 'models' },
  webTools: { label: 'WebTools', source: 'webTools.enabled', target: 'tools' },
  imageGen: { label: 'ImageGen', source: 'imageGenTools.enabled', target: 'tools' },
  stt: { label: '语音转写', source: 'stt.enabled', target: 'tools' },
  tts: { label: '语音合成', source: 'tts', target: null },
  memory: { label: 'Memory', source: 'memory.enabled', target: 'memory' },
  memoryPolling: { label: '记忆轮询', source: 'memory.polling.enabled', target: 'memory' },
  memoryConsolidation: {
    label: '记忆整合',
    source: 'memory.consolidation.enabled',
    target: 'memory',
  },
  cron: { label: '定时任务', source: 'cron.enabled', target: 'system' },
  systemMonitor: { label: '系统监控', source: 'systemMonitor.enabled', target: 'system' },
  eventRetention: {
    label: '事件保留',
    source: 'runtimeEventRetention.enabled',
    target: 'system',
  },
  toolControls: { label: '工具控制', source: 'toolControls.enabled', target: 'tools' },
  acs: { label: 'ACS 执行环境', source: 'tenantRemoteHands.hands', target: 'execution' },
};

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

function secretAreaLabel(path: string): string {
  if (path.startsWith('models.')) return '模型';
  if (path.startsWith('codexSubscription.')) return 'Codex';
  if (path.startsWith('webTools.')) return 'WebTools';
  if (path.startsWith('imageGenTools.')) return 'ImageGen';
  if (path.startsWith('stt.')) return '语音转写';
  if (path.startsWith('tts.')) return '语音合成';
  if (path.startsWith('memory.')) return 'Memory';
  if (path.startsWith('tenantRemoteHands.')) return '执行环境';
  return '其他配置';
}

export function ConfigStatusCapabilities({
  capabilities,
}: {
  capabilities: Record<string, boolean>;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">当前实例能力</CardTitle>
        <p className="text-sm text-muted-foreground">
          此处只读展示有效配置；修改请进入对应业务页面，避免产生凭据或运行资源未就绪的半配置状态。
        </p>
      </CardHeader>
      <CardContent>
        <div className="grid gap-2 lg:grid-cols-2">
          {Object.entries(capabilities).map(([key, active]) => {
            const metadata = CAPABILITIES[key] ?? { label: key, source: key, target: null };
            return (
              <div
                key={key}
                className="flex min-h-16 items-center justify-between gap-3 rounded-lg border px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <span>{metadata.label}</span>
                    <Badge variant={active ? 'success' : 'muted'}>
                      {active ? '已启用' : '未启用'}
                    </Badge>
                  </div>
                  <code className="mt-1 block truncate text-xs text-muted-foreground">
                    {metadata.source}
                  </code>
                </div>
                <TargetAction target={metadata.target} ariaLabel={`配置 ${metadata.label}`} />
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
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

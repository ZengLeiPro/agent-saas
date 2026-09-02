import { useCallback, useEffect, useState } from 'react';
import { Download, Loader2, RefreshCw } from 'lucide-react';

import { MetricCard } from '@/components/PlatformAdmin/common';
import {
  SettingsPanelHeader,
  SETTINGS_CONTENT_WIDTH,
} from '@/components/SettingsCenter/SettingsPanelHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

import { platformAdminApi } from './api';
import { ConfigStatusCapabilities } from './ConfigStatusCapabilities';
import { ConfigStatusSecrets } from './ConfigStatusDetails';
import type { EffectiveConfigStatus } from './types';

function shortFingerprint(value: string | undefined): string {
  return value ? value.replace(/^sha256:/u, '').slice(0, 12) : '—';
}

function readinessLabel(value: EffectiveConfigStatus['secretReadiness'] | undefined): string {
  if (value === 'ready') return '引用就绪';
  if (value === 'missing') return '存在缺失';
  if (value === 'legacy_inline') return '含历史内联项';
  return '尚未识别';
}

export function ConfigStatusPanel() {
  const [status, setStatus] = useState<EffectiveConfigStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await platformAdminApi.configStatus());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const exportStatus = useCallback(() => {
    if (!status) return;
    const blob = new Blob([`${JSON.stringify(status, null, 2)}\n`], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `agent-saas-${status.environment}-config-status.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [status]);

  return (
    <div className={cn('flex h-full min-h-0 flex-col', SETTINGS_CONTENT_WIDTH)}>
      <SettingsPanelHeader
        title="配置状态"
        description="只读展示当前部署实例的环境身份、配置指纹、能力摘要与 Secret 就绪状态；不提供跨环境同步或自动修复。"
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={exportStatus} disabled={!status}>
              <Download className="size-3.5" />
              导出摘要
            </Button>
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
              {loading ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              刷新
            </Button>
          </div>
        }
      />
      <div className="min-h-0 flex-1 space-y-4 overflow-auto">
        {error ? (
          <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        ) : null}
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            title="当前环境"
            value={status?.environment ?? (loading ? '加载中' : '—')}
            description={
              status
                ? `${status.processRole} · Schema v${status.configSchemaVersion}`
                : '服务端可信身份'
            }
            tone={status?.environment === 'production' ? 'warn' : 'good'}
          />
          <MetricCard
            title="有效配置指纹"
            value={shortFingerprint(status?.effectiveConfigFingerprint)}
            description="完整 SHA-256 仅用于读回比对"
          />
          <MetricCard
            title="能力指纹"
            value={shortFingerprint(status?.capabilityFingerprint)}
            description="功能开关与能力摘要"
          />
          <MetricCard
            title="Secret 状态"
            value={readinessLabel(status?.secretReadiness)}
            description={
              status
                ? `${status.secrets.references} 个引用，${status.secrets.inlineLegacy} 个历史内联项，${status.secrets.missing} 个缺失项`
                : '不返回明文或引用标识'
            }
            tone={status?.secretReadiness === 'ready' ? 'good' : 'warn'}
          />
        </div>
        {status ? (
          <>
            <ConfigStatusCapabilities
              capabilities={status.capabilities}
              capabilityStates={status.capabilityStates}
            />
            <ConfigStatusSecrets secrets={status.secrets} />
          </>
        ) : (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">当前实例能力</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex h-28 items-center justify-center text-sm text-muted-foreground">
                <Loader2 className="mr-2 size-4 animate-spin" />
                加载配置状态...
              </div>
            </CardContent>
          </Card>
        )}
        {status?.environment === 'production' ? (
          <div className="rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning-ink">
            当前是 Production。此页面保持只读；任何配置保存、凭据迁移或重新授权都需要单独确认。
          </div>
        ) : null}
      </div>
    </div>
  );
}

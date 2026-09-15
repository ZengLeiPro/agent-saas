import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Save } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  PLATFORM_DEMO_BANNER,
  PLATFORM_DEMO_MENU_LABEL,
  enterPlatformDemo,
  fetchPlatformDemoAccess,
  fetchPlatformDemoAnalytics,
  fetchPlatformDemoConfig,
  savePlatformDemoConfig,
  type PlatformDemoAnalyticsResponse,
  type PlatformDemoConfigResponse,
} from '@agent/shared/lib/platformDemoApi';

const DEMO_SECTIONS = [
  { id: 'models', label: '模型' },
  { id: 'tool-controls', label: '工具开关' },
  { id: 'billing', label: '计费' },
  { id: 'system', label: '系统配置' },
] as const;

interface PlatformDemoShellProps {
  onClose?: () => void;
  /** When a real platform-admin deep link is opened by a demo identity, fall back here. */
  fallbackFromRealAdmin?: boolean;
}

export function PlatformDemoShell({ onClose, fallbackFromRealAdmin = false }: PlatformDemoShellProps) {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [sectionId, setSectionId] = useState<string>('models');
  const [analytics, setAnalytics] = useState<PlatformDemoAnalyticsResponse['analytics'] | null>(null);
  const [config, setConfig] = useState<PlatformDemoConfigResponse | null>(null);
  const [draftText, setDraftText] = useState('{}');
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const access = await fetchPlatformDemoAccess();
        if (!active) return;
        setAllowed(access.allowed);
        if (!access.allowed) {
          setError(access.reasonCode);
          return;
        }
        await enterPlatformDemo();
        const [analyticsResponse, configResponse] = await Promise.all([
          fetchPlatformDemoAnalytics(),
          fetchPlatformDemoConfig(sectionId),
        ]);
        if (!active) return;
        setAnalytics(analyticsResponse.analytics);
        setConfig(configResponse);
        setDraftText(JSON.stringify(configResponse.draft ?? configResponse.section.shape, null, 2));
      } catch (cause) {
        if (!active) return;
        setAllowed(false);
        setError(cause instanceof Error ? cause.message : '无法进入演示模式');
      }
    })();
    return () => { active = false; };
  }, []);

  const loadSection = useCallback(async (nextSectionId: string) => {
    setSectionId(nextSectionId);
    setSaveMessage(null);
    setError(null);
    try {
      const configResponse = await fetchPlatformDemoConfig(nextSectionId);
      setConfig(configResponse);
      setDraftText(JSON.stringify(configResponse.draft ?? configResponse.section.shape, null, 2));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '加载演示配置失败');
    }
  }, []);

  const onSave = useCallback(async () => {
    setSaving(true);
    setSaveMessage(null);
    setError(null);
    try {
      const parsed = JSON.parse(draftText) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('草稿必须是 JSON 对象');
      }
      const saved = await savePlatformDemoConfig(sectionId, parsed);
      setSaveMessage(`已保存到演示会话（不影响生产），过期 ${saved.expiresAt}`);
      setConfig((current) => current
        ? {
            ...current,
            draft: saved.draft,
            draftUpdatedAt: saved.updatedAt,
            draftExpiresAt: saved.expiresAt,
          }
        : current);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }, [draftText, sectionId]);

  const totals = useMemo(() => analytics?.totals, [analytics]);

  if (allowed === null) {
    return <div className="p-6 text-sm text-muted-foreground">正在进入{PLATFORM_DEMO_MENU_LABEL}…</div>;
  }
  if (!allowed) {
    return (
      <div className="p-6 space-y-3">
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          当前账号不能进入平台演示模式{error ? `（${error}）` : ''}。
        </div>
        {onClose ? <Button variant="outline" onClick={onClose}>返回</Button> : null}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-950">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        <span className="font-medium">{PLATFORM_DEMO_BANNER}</span>
        <Badge variant="secondary" className="ml-auto">{PLATFORM_DEMO_MENU_LABEL}</Badge>
      </div>
      {fallbackFromRealAdmin ? (
        <div className="border-b border-amber-200 bg-amber-50/70 px-4 py-2 text-xs text-amber-900">
          演示身份不能打开真实平台管理链接，已回退到演示壳层。
        </div>
      ) : null}
      <div className="grid min-h-0 flex-1 gap-4 p-4 lg:grid-cols-[220px_1fr]">
        <aside className="space-y-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">演示分区</div>
          {DEMO_SECTIONS.map((section) => (
            <Button
              key={section.id}
              variant={section.id === sectionId ? 'default' : 'ghost'}
              className="w-full justify-start"
              onClick={() => void loadSection(section.id)}
            >
              {section.label}
            </Button>
          ))}
          {onClose ? (
            <Button variant="outline" className="w-full" onClick={onClose}>关闭演示</Button>
          ) : null}
        </aside>
        <main className="min-h-0 space-y-4 overflow-auto">
          <section className="rounded-lg border p-4">
            <h2 className="mb-2 text-sm font-semibold">示例分析（fixture）</h2>
            {totals ? (
              <div className="grid gap-2 sm:grid-cols-4 text-sm">
                <div>组织 {totals.organizations}</div>
                <div>用户 {totals.users}</div>
                <div>24h Runs {totals.runs24h}</div>
                <div>错误率 {(totals.errorRate * 100).toFixed(1)}%</div>
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">加载中…</div>
            )}
            {analytics ? (
              <div className="mt-3 overflow-auto text-xs text-muted-foreground">
                {analytics.series.map((point) => (
                  <div key={point.date}>
                    {point.date}: req {point.requests} / tokens {point.tokens} / users {point.activeUsers}
                  </div>
                ))}
              </div>
            ) : null}
          </section>
          <section className="rounded-lg border p-4 space-y-3">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold">示例配置 · {config?.section.label ?? sectionId}</h2>
              <Badge variant="outline">fixture + demo_session</Badge>
            </div>
            <textarea
              className="min-h-[220px] w-full rounded-md border bg-background p-3 font-mono text-xs"
              value={draftText}
              onChange={(event) => setDraftText(event.target.value)}
              aria-label="演示配置草稿"
            />
            <div className="flex items-center gap-2">
              <Button onClick={() => void onSave()} disabled={saving}>
                <Save className="mr-2 h-4 w-4" />
                {saving ? '保存中…' : '保存（演示）'}
              </Button>
              {config?.draftUpdatedAt ? (
                <span className="text-xs text-muted-foreground">草稿更新于 {config.draftUpdatedAt}</span>
              ) : null}
            </div>
            {saveMessage ? <div className="text-sm text-emerald-700">{saveMessage}</div> : null}
            {error ? <div className="text-sm text-destructive">{error}</div> : null}
            <div className="text-xs text-muted-foreground">
              Save 仅写入 actor+org 隔离的 demo_session（TTL ~24h），永不触达生产 raw/secret/runner。
            </div>
            {/* Keep Input import used for form-shape parity with real admin pages */}
            <Input className="hidden" readOnly value={sectionId} aria-hidden />
          </section>
        </main>
      </div>
    </div>
  );
}

export default PlatformDemoShell;

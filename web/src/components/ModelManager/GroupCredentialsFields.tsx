import { useCallback, useState } from 'react';
import { CircleAlert, CircleCheck, Loader2, PlugZap } from 'lucide-react';
import type { ProviderQuotaTestResponse } from '@agent/shared';

import { authFetch } from '@/lib/authFetch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * 模型分组的「套餐用量查询来源」草稿。推理 API Key 查不到套餐额度，
 * 火山管控面 OpenAPI 需要账号级 AccessKey；Secret 与 apiKey 同策略：GET 只回 hasQuotaSecret，留空=保留。
 */
export type EditableQuotaSource = {
  provider: 'volcengine_ark_plan';
  accessKeyId: string;
  secretAccessKey?: string;
  region?: string;
  hasQuotaSecret?: boolean;
};

const DEFAULT_REGION = 'cn-beijing';

/** 保存前收口：去掉 GET 回显字段、空 Secret 不提交（服务端保留现有）。 */
export function normalizeQuotaSourceForSave(
  source: EditableQuotaSource | undefined,
): EditableQuotaSource | undefined {
  if (!source) return undefined;
  const next: EditableQuotaSource = {
    provider: source.provider,
    accessKeyId: source.accessKeyId.trim(),
    region: (source.region ?? '').trim() || DEFAULT_REGION,
  };
  const secret = source.secretAccessKey?.trim();
  if (secret) next.secretAccessKey = secret;
  return next;
}

type CredentialGroup = {
  id: string;
  apiKey?: string;
  hasApiKey?: boolean;
  baseUrl?: string | null;
  quotaSource?: EditableQuotaSource;
};

export function GroupCredentialsFields({
  group,
  readOnly,
  hasOpenAiCompatible,
  onChange,
}: {
  group: CredentialGroup;
  readOnly: boolean;
  hasOpenAiCompatible: boolean;
  onChange: (patch: {
    apiKey?: string;
    baseUrl?: string;
    quotaSource?: EditableQuotaSource | undefined;
  }) => void;
}) {
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<
    { ok: true; data: ProviderQuotaTestResponse } | { ok: false; error: string } | null
  >(null);
  const source = group.quotaSource;

  const updateSource = useCallback(
    (patch: Partial<EditableQuotaSource>) => {
      if (!source) return;
      setTestResult(null);
      onChange({ quotaSource: { ...source, ...patch } });
    },
    [onChange, source],
  );

  const runTest = useCallback(async () => {
    if (!source) return;
    setTesting(true);
    try {
      const res = await authFetch('/api/admin/provider-quota/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: source.provider,
          accessKeyId: source.accessKeyId.trim(),
          secretAccessKey: source.secretAccessKey?.trim() || undefined,
          groupId: group.id,
          region: (source.region ?? '').trim() || DEFAULT_REGION,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as ProviderQuotaTestResponse & {
        error?: string;
      };
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setTestResult({ ok: true, data });
    } catch (err) {
      setTestResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  }, [group.id, source]);

  if (!hasOpenAiCompatible) {
    return (
      <div className="rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground md:col-span-2">
        Codex 订阅分组直接使用上方已授权账号，不读取 API Key 或 Base URL；现有值会保留，切回 API Key
        transport 时可继续使用。 各账号的套餐额度由平台自动采集，见「平台分析 → 套餐额度」。
      </div>
    );
  }

  return (
    <>
      <div className="space-y-1.5">
        <Label>API Key</Label>
        <Input
          type="password"
          autoComplete="new-password"
          passwordManager="ignore"
          value={group.apiKey ?? ''}
          onChange={(e) => onChange({ apiKey: e.target.value })}
          placeholder={group.hasApiKey ? '已配置，留空则保留现有 Key' : '未配置'}
        />
      </div>
      <div className="space-y-1.5">
        <Label>Base URL</Label>
        <Input
          value={group.baseUrl ?? ''}
          onChange={(e) => onChange({ baseUrl: e.target.value })}
          placeholder="例如 http://127.0.0.1:8317"
        />
      </div>
      <div className="space-y-2 rounded-md border bg-muted/10 p-3 md:col-span-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="space-y-0.5">
            <Label>套餐用量查询</Label>
            <p className="text-xs text-muted-foreground">
              推理 Key 查不到套餐额度；配置账号级管控面凭据后，「平台分析 → 套餐额度」会每 5
              分钟采集一次。
            </p>
          </div>
          <select
            aria-label="套餐用量查询来源"
            className="h-9 rounded-md border bg-card px-3 text-sm"
            value={source?.provider ?? 'none'}
            disabled={readOnly}
            onChange={(e) => {
              setTestResult(null);
              onChange({
                quotaSource:
                  e.target.value === 'volcengine_ark_plan'
                    ? { provider: 'volcengine_ark_plan', accessKeyId: '', region: DEFAULT_REGION }
                    : undefined,
              });
            }}
          >
            <option value="none">不查询</option>
            <option value="volcengine_ark_plan">火山 Agent Plan（管控面 OpenAPI）</option>
          </select>
        </div>
        {source && (
          <div className="grid gap-3 md:grid-cols-3">
            <div className="space-y-1.5">
              <Label>Access Key ID</Label>
              <Input
                value={source.accessKeyId}
                disabled={readOnly}
                onChange={(e) => updateSource({ accessKeyId: e.target.value })}
                placeholder="AKLT…"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Secret Access Key</Label>
              <Input
                type="password"
                autoComplete="new-password"
                passwordManager="ignore"
                value={source.secretAccessKey ?? ''}
                disabled={readOnly}
                onChange={(e) => updateSource({ secretAccessKey: e.target.value })}
                placeholder={source.hasQuotaSecret ? '已配置，留空则保留现有 Secret' : '未配置'}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Region</Label>
              <Input
                value={source.region ?? DEFAULT_REGION}
                disabled={readOnly}
                onChange={(e) => updateSource({ region: e.target.value })}
                placeholder={DEFAULT_REGION}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2 md:col-span-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void runTest()}
                disabled={
                  testing ||
                  !source.accessKeyId.trim() ||
                  (!source.secretAccessKey?.trim() && !source.hasQuotaSecret)
                }
              >
                {testing ? (
                  <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                ) : (
                  <PlugZap className="mr-1.5 size-3.5" />
                )}
                测试连接
              </Button>
              {testResult?.ok === false && (
                <span className="inline-flex items-center gap-1 text-xs text-destructive">
                  <CircleAlert className="size-3.5" />
                  {testResult.error}
                </span>
              )}
              {testResult?.ok === true && (
                <span className="inline-flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                  <CircleCheck className="size-3.5 text-success-ink" />
                  {testResult.data.plan?.type ? `档位 ${testResult.data.plan.type}` : '已连通'}
                  {testResult.data.plan?.status ? ` · ${testResult.data.plan.status}` : ''}
                  {testResult.data.plan?.endTime
                    ? ` · 到期 ${new Date(testResult.data.plan.endTime).toLocaleDateString('zh-CN')}`
                    : ''}
                  {testResult.data.windows.length > 0
                    ? ` · ${testResult.data.windows.map((w) => `${w.label} ${w.usedPercent.toFixed(1)}%`).join('，')}`
                    : ''}
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

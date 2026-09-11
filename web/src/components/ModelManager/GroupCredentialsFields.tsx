import { useCallback, useEffect, useRef, useState } from 'react';
import { CircleAlert, CircleCheck, Loader2, PlugZap } from 'lucide-react';
import { isZhipuCodingPlanGroup, type ProviderQuotaTestRequest, type ProviderQuotaTestResponse } from '@agent/shared';

import { authFetch } from '@/lib/authFetch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type EditableVolcengineQuotaSource = {
  provider: 'volcengine_ark_plan';
  accessKeyId: string;
  secretAccessKey?: string;
  region?: string;
  hasQuotaSecret?: boolean;
};

/** 火山使用独立 Secret；智谱复用分组 Key；none 显式关闭自动识别。 */
export type EditableQuotaSource =
  | EditableVolcengineQuotaSource
  | { provider: 'zhipu_coding_plan' | 'none' };

const DEFAULT_REGION = 'cn-beijing';

/** 保存前收口：去掉 GET 回显字段、空 Secret 不提交（服务端保留现有）。 */
export function normalizeQuotaSourceForSave(
  source: EditableQuotaSource | undefined,
): EditableQuotaSource | undefined {
  if (!source) return undefined;
  if (source.provider !== 'volcengine_ark_plan') return { provider: source.provider };
  const next: EditableVolcengineQuotaSource = {
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

type GroupPatch = {
  apiKey?: string;
  baseUrl?: string;
  quotaSource?: EditableQuotaSource | undefined;
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
  onChange: (patch: GroupPatch) => void;
}) {
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<
    { ok: true; data: ProviderQuotaTestResponse } | { ok: false; error: string } | null
  >(null);
  const testVersion = useRef(0);
  const source = group.quotaSource;
  const volcSource = source?.provider === 'volcengine_ark_plan' ? source : undefined;
  const isZhipu = isZhipuCodingPlanGroup(group);

  // 配置变更后，旧请求不得把上一个 Key/来源的测试结果写回当前表单。
  useEffect(() => {
    testVersion.current += 1;
    setTestResult(null);
    setTesting(false);
  }, [group.id, group.apiKey, group.baseUrl, source]);

  const updateSource = useCallback(
    (patch: Partial<EditableVolcengineQuotaSource>) => {
      if (!volcSource) return;
      onChange({ quotaSource: { ...volcSource, ...patch } });
    },
    [onChange, volcSource],
  );

  const runTest = useCallback(async () => {
    if (!isZhipu && !volcSource) return;
    const version = ++testVersion.current;
    setTesting(true);
    setTestResult(null);
    const input: ProviderQuotaTestRequest = isZhipu
      ? {
          provider: 'zhipu_coding_plan',
          apiKey: group.apiKey?.trim() || undefined,
          groupId: group.id,
        }
      : {
          provider: 'volcengine_ark_plan',
          accessKeyId: volcSource!.accessKeyId.trim(),
          secretAccessKey: volcSource!.secretAccessKey?.trim() || undefined,
          groupId: group.id,
          region: (volcSource!.region ?? '').trim() || DEFAULT_REGION,
        };
    try {
      const res = await authFetch('/api/admin/provider-quota/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      const data = (await res.json().catch(() => ({}))) as ProviderQuotaTestResponse & {
        error?: string;
      };
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (testVersion.current === version) setTestResult({ ok: true, data });
    } catch (err) {
      if (testVersion.current === version) {
        setTestResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      if (testVersion.current === version) setTesting(false);
    }
  }, [group.id, group.apiKey, isZhipu, volcSource]);

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
          disabled={readOnly}
          onChange={(e) => onChange({ apiKey: e.target.value })}
          placeholder={group.hasApiKey ? '已配置，留空则保留现有 Key' : '未配置'}
        />
      </div>
      <div className="space-y-1.5">
        <Label>Base URL</Label>
        <Input
          value={group.baseUrl ?? ''}
          disabled={readOnly}
          onChange={(e) => onChange({ baseUrl: e.target.value })}
          placeholder="例如 http://127.0.0.1:8317"
        />
      </div>
      <div className="space-y-2 rounded-md border bg-muted/10 p-3 md:col-span-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="space-y-0.5">
            <Label>套餐用量查询</Label>
            <p className="text-xs text-muted-foreground">
              智谱复用本分组 API Key；火山需独立管控面凭据。配置后，「平台分析 → 套餐额度」每 5 分钟采集一次。
            </p>
          </div>
          <select
            aria-label="套餐用量查询来源"
            className="h-9 rounded-md border bg-card px-3 text-sm"
            value={source?.provider ?? 'auto'}
            disabled={readOnly}
            onChange={(e) => {
              const provider = e.target.value;
              onChange({
                quotaSource: provider === 'volcengine_ark_plan'
                  ? { provider, accessKeyId: '', region: DEFAULT_REGION }
                  : provider === 'zhipu_coding_plan' || provider === 'none'
                    ? { provider }
                    : undefined,
              });
            }}
          >
            <option value="auto">{isZhipu && !source ? '自动识别：智谱 Coding Plan' : '自动识别官方地址'}</option>
            <option value="none">不查询</option>
            <option value="zhipu_coding_plan">智谱 Coding Plan（个人版）</option>
            <option value="volcengine_ark_plan">火山 Agent Plan（管控面 OpenAPI）</option>
          </select>
        </div>
        {isZhipu && (
          <p className="rounded-md bg-muted/30 p-3 text-xs text-muted-foreground" role="note">
            已启用智谱个人 Coding Plan 额度查询，复用上方已保存的 API Key，无需第二套密钥。
            监控请求仅发送至智谱中国站官方接口。返回的是账号共享套餐额度，不是单 Key 用量；
            同账号多个 Key 对应的卡片可能重复，不能相加。套餐等级与重置时间仅在上游返回时显示。
          </p>
        )}
        {volcSource && (
          <div className="grid gap-3 md:grid-cols-3">
            <div className="space-y-1.5">
              <Label>Access Key ID</Label>
              <Input
                value={volcSource.accessKeyId}
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
                value={volcSource.secretAccessKey ?? ''}
                disabled={readOnly}
                onChange={(e) => updateSource({ secretAccessKey: e.target.value })}
                placeholder={volcSource.hasQuotaSecret ? '已配置，留空则保留现有 Secret' : '未配置'}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Region</Label>
              <Input
                value={volcSource.region ?? DEFAULT_REGION}
                disabled={readOnly}
                onChange={(e) => updateSource({ region: e.target.value })}
                placeholder={DEFAULT_REGION}
              />
            </div>
          </div>
        )}
        {(isZhipu || volcSource) && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void runTest()}
              disabled={testing || (isZhipu
                ? !group.apiKey?.trim() && !group.hasApiKey
                : !volcSource?.accessKeyId.trim() || (!volcSource.secretAccessKey?.trim() && !volcSource.hasQuotaSecret))}
            >
              {testing ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <PlugZap className="mr-1.5 h-3.5 w-3.5" />
              )}
              {isZhipu ? '测试额度查询' : '测试连接'}
            </Button>
            {testResult?.ok === false && (
              <span className="inline-flex items-center gap-1 text-xs text-destructive" role="alert">
                <CircleAlert className="h-3.5 w-3.5" />
                {testResult.error}
              </span>
            )}
            {testResult?.ok === true && (
              <span className="inline-flex flex-wrap items-center gap-1 text-xs text-muted-foreground" role="status">
                <CircleCheck className="h-3.5 w-3.5 text-success-ink" />
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
        )}
      </div>
    </>
  );
}

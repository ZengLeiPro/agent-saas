import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type {
  AgentDwsAccount,
  AgentDwsContextPolicyMode,
  UpdateAgentDwsContextPolicyInput,
} from '@agent/shared';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  useSettingsDirtyEntry,
  useSettingsDirtyNavigation,
} from '@/components/PersonalSettings/dirtyRegistry';
import { authFetch } from '@/lib/authFetch';

const MODE_OPTIONS: Array<{ value: AgentDwsContextPolicyMode; label: string }> = [
  { value: 'none', label: '不采集' },
  { value: 'selected', label: '仅指定会话' },
  { value: 'all', label: '全部会话' },
];

interface ContextPolicyDialogProps {
  account: AgentDwsAccount | null;
  tenantId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (account: AgentDwsAccount) => void;
}

export function ContextPolicyDialog({
  account,
  tenantId,
  open,
  onOpenChange,
  onSaved,
}: ContextPolicyDialogProps) {
  const [historicalMode, setHistoricalMode] = useState<AgentDwsContextPolicyMode>('none');
  const [realtimeMode, setRealtimeMode] = useState<AgentDwsContextPolicyMode>('none');
  const [historicalIds, setHistoricalIds] = useState('');
  const [realtimeIds, setRealtimeIds] = useState('');
  const [lookbackDays, setLookbackDays] = useState('30');
  const [wikiEnabled, setWikiEnabled] = useState(false);
  const [minutesEnabled, setMinutesEnabled] = useState(false);
  const [minutesLookbackDays, setMinutesLookbackDays] = useState('30');
  const [saving, setSaving] = useState(false);
  const requestDirtyNavigation = useSettingsDirtyNavigation();
  const [error, setError] = useState('');
  const [recentConversationIds, setRecentConversationIds] = useState<string[]>([]);

  useEffect(() => {
    if (!open || !account) return;
    setHistoricalMode(account.contextPolicy.historical.mode);
    setRealtimeMode(account.contextPolicy.realtime.mode);
    setHistoricalIds(account.contextPolicy.historical.conversationIds.join('\n'));
    setRealtimeIds(account.contextPolicy.realtime.conversationIds.join('\n'));
    setLookbackDays(String(account.contextPolicy.historical.lookbackDays));
    setWikiEnabled(account.contextPolicy.wiki?.enabled ?? false);
    setMinutesEnabled(account.contextPolicy.minutes?.enabled ?? false);
    setMinutesLookbackDays(String(account.contextPolicy.minutes?.lookbackDays ?? 30));
    setSaving(false);
    setError('');
  }, [account, open]);

  useEffect(() => {
    if (!open || !account) {
      setRecentConversationIds([]);
      return;
    }
    let cancelled = false;
    void authFetch(
      `/api/agent-dws-accounts/${encodeURIComponent(account.accountId)}/inbox?tenantId=${encodeURIComponent(tenantId)}&limit=100`,
    ).then(async response => {
      if (!response.ok) return [];
      const payload = await response.json() as { items?: Array<{ conversationId?: unknown }> };
      return [...new Set((payload.items ?? []).flatMap(item => (
        typeof item.conversationId === 'string' && item.conversationId.trim()
          ? [item.conversationId.trim()]
          : []
      )))];
    }).then(ids => { if (!cancelled) setRecentConversationIds(ids); })
      .catch(() => { if (!cancelled) setRecentConversationIds([]); });
    return () => { cancelled = true; };
  }, [account, open, tenantId]);

  const historyCount = useMemo(() => parseConversationIds(historicalIds).length, [historicalIds]);
  const realtimeCount = useMemo(() => parseConversationIds(realtimeIds).length, [realtimeIds]);

  const handleSubmit = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (!account) return false;
    const historicalConversationIds = historicalMode === 'selected' ? parseConversationIds(historicalIds) : [];
    const realtimeConversationIds = realtimeMode === 'selected' ? parseConversationIds(realtimeIds) : [];
    const days = Number(lookbackDays);
    const validation = validatePolicy({
      historicalMode,
      realtimeMode,
      historicalConversationIds,
      realtimeConversationIds,
      lookbackDays: days,
    });
    if (validation) {
      setError(validation);
      return false;
    }
    const minutesDays = Number(minutesLookbackDays);
    if (!Number.isInteger(minutesDays) || minutesDays < 1 || minutesDays > 365) {
      setError('听记回填天数必须是 1 到 365 的整数');
      return false;
    }

    const payload: UpdateAgentDwsContextPolicyInput = {
      expectedRevision: account.revision,
      historical: {
        mode: historicalMode,
        conversationIds: historicalConversationIds,
        lookbackDays: days,
      },
      realtime: { mode: realtimeMode, conversationIds: realtimeConversationIds },
      wiki: { enabled: wikiEnabled },
      minutes: { enabled: minutesEnabled, lookbackDays: minutesDays },
    };
    setSaving(true);
    setError('');
    try {
      const response = await authFetch(
        `/api/agent-dws-accounts/${encodeURIComponent(account.accountId)}/context-policy?tenantId=${encodeURIComponent(tenantId)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
      );
      if (!response.ok) throw await responseError(response);
      const result = await response.json() as { account?: AgentDwsAccount };
      if (!result.account) throw new Error('范围配置接口返回格式不正确');
      onSaved(result.account);
      onOpenChange(false);
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '保存 Context 范围失败');
      return false;
    } finally {
      setSaving(false);
    }
  };

  const baseline = account ? {
    historicalMode: account.contextPolicy.historical.mode,
    realtimeMode: account.contextPolicy.realtime.mode,
    historicalIds: account.contextPolicy.historical.conversationIds.join('\n'),
    realtimeIds: account.contextPolicy.realtime.conversationIds.join('\n'),
    lookbackDays: String(account.contextPolicy.historical.lookbackDays),
    wikiEnabled: account.contextPolicy.wiki?.enabled ?? false,
    minutesEnabled: account.contextPolicy.minutes?.enabled ?? false,
    minutesLookbackDays: String(account.contextPolicy.minutes?.lookbackDays ?? 30),
  } : null;
  const draft = { historicalMode, realtimeMode, historicalIds, realtimeIds, lookbackDays, wikiEnabled, minutesEnabled, minutesLookbackDays };
  useSettingsDirtyEntry({
    id: `organization-dws-context:${tenantId}:${account?.accountId ?? 'none'}`,
    label: `${account?.displayName ?? '钉钉账号'} Context 范围`,
    dirty: Boolean(open && baseline && JSON.stringify(draft) !== JSON.stringify(baseline)),
    save: async () => { if (!await handleSubmit()) throw new Error('DWS context policy save failed'); },
    discard: () => {
      if (!baseline) return;
      setHistoricalMode(baseline.historicalMode); setRealtimeMode(baseline.realtimeMode);
      setHistoricalIds(baseline.historicalIds); setRealtimeIds(baseline.realtimeIds); setLookbackDays(baseline.lookbackDays);
      setWikiEnabled(baseline.wikiEnabled); setMinutesEnabled(baseline.minutesEnabled);
      setMinutesLookbackDays(baseline.minutesLookbackDays); setError('');
    },
    draft,
  });

  const requestClose = () => requestDirtyNavigation(() => onOpenChange(false));

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !saving) requestClose(); }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <form onSubmit={(event) => void handleSubmit(event)} className="space-y-5">
          <DialogHeader>
            <DialogTitle>配置 Context 范围</DialogTitle>
            <DialogDescription>
              历史学习与实时监听分开授权。新账号默认不采集；事件只负责唤醒，消息正文仍会从钉钉回源读取。
            </DialogDescription>
          </DialogHeader>

          {error ? (
            <div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger-ink" role="alert">
              {error}
            </div>
          ) : null}

          <section className="space-y-4 rounded-lg border p-4">
            <div>
              <h3 className="text-sm font-medium">历史学习</h3>
              <p className="mt-1 text-xs text-muted-foreground">首次回填指定天数内的聊天记录，之后按独立水位增量同步。</p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="context-history-mode">会话范围</Label>
                <Select value={historicalMode} onValueChange={(value) => setHistoricalMode(value as AgentDwsContextPolicyMode)} disabled={saving}>
                  <SelectTrigger id="context-history-mode"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {MODE_OPTIONS.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="context-lookback-days">回填天数</Label>
                <Input
                  id="context-lookback-days"
                  type="number"
                  min={1}
                  max={365}
                  step={1}
                  value={lookbackDays}
                  onChange={(event) => setLookbackDays(event.target.value)}
                  disabled={saving}
                />
              </div>
            </div>
            {historicalMode === 'selected' ? (
              <ConversationIdsField
                id="context-history-conversations"
                value={historicalIds}
                onChange={setHistoricalIds}
                count={historyCount}
                disabled={saving}
                recentConversationIds={recentConversationIds}
              />
            ) : null}
          </section>

          <section className="space-y-4 rounded-lg border p-4">
            <div>
              <h3 className="text-sm font-medium">实时监听</h3>
              <p className="mt-1 text-xs text-muted-foreground">从保存配置时开始持续同步，不会因为开启监听自动回填 30 天历史。</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="context-realtime-mode">会话范围</Label>
              <Select value={realtimeMode} onValueChange={(value) => setRealtimeMode(value as AgentDwsContextPolicyMode)} disabled={saving}>
                <SelectTrigger id="context-realtime-mode"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {MODE_OPTIONS.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {realtimeMode === 'selected' ? (
              <ConversationIdsField
                id="context-realtime-conversations"
                value={realtimeIds}
                onChange={setRealtimeIds}
                count={realtimeCount}
                disabled={saving}
                recentConversationIds={recentConversationIds}
              />
            ) : null}
          </section>

          <section className="space-y-4 rounded-lg border p-4">
            <div>
              <h3 className="text-sm font-medium">文档与听记</h3>
              <p className="mt-1 text-xs text-muted-foreground">两类数据同样需要显式授权；新账号默认关闭。</p>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={wikiEnabled}
                onChange={(event) => setWikiEnabled(event.target.checked)}
                disabled={saving}
              />
              同步可访问的钉钉 Wiki 文档
            </label>
            <div className="grid gap-3 sm:grid-cols-2 sm:items-end">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={minutesEnabled}
                  onChange={(event) => setMinutesEnabled(event.target.checked)}
                  disabled={saving}
                />
                同步钉钉听记
              </label>
              <div className="space-y-2">
                <Label htmlFor="context-minutes-lookback-days">听记回填天数</Label>
                <Input
                  id="context-minutes-lookback-days"
                  type="number"
                  min={1}
                  max={365}
                  value={minutesLookbackDays}
                  onChange={(event) => setMinutesLookbackDays(event.target.value)}
                  disabled={saving || !minutesEnabled}
                />
              </div>
            </div>
          </section>

          <div className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            范围缩小时，旧记录会立即在检索层失效；不会采集通讯录，也不会全量下载附件。
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={requestClose} disabled={saving}>取消</Button>
            <Button type="submit" disabled={saving || !account}>保存范围</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ConversationIdsField({ id, value, onChange, count, disabled, recentConversationIds }: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  count: number;
  disabled: boolean;
  recentConversationIds: string[];
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>conversationId（每行一个）</Label>
      <Textarea
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={'cidA...\ncidB...'}
        rows={5}
        disabled={disabled}
      />
      <p className="text-xs text-muted-foreground">已识别 {count} 个，最多 100 个；可粘贴换行、逗号或空格分隔的 ID。</p>
      {recentConversationIds.length > 0 ? (
        <div>
          <p className="mb-2 text-xs text-muted-foreground">最近事件中的会话（点击添加）</p>
          <div className="flex max-h-24 flex-wrap gap-1.5 overflow-y-auto">
            {recentConversationIds.map(conversationId => (
              <button
                key={conversationId}
                type="button"
                className="max-w-full truncate rounded border bg-muted/40 px-2 py-1 font-mono text-xs hover:bg-muted"
                title={conversationId}
                disabled={disabled}
                onClick={() => onChange([...parseConversationIds(value), conversationId].join('\n'))}
              >
                {conversationId}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function parseConversationIds(value: string): string[] {
  return [...new Set(value.split(/[\s,，]+/u).map(item => item.trim()).filter(Boolean))];
}

function validatePolicy(input: {
  historicalMode: AgentDwsContextPolicyMode;
  realtimeMode: AgentDwsContextPolicyMode;
  historicalConversationIds: string[];
  realtimeConversationIds: string[];
  lookbackDays: number;
}): string | null {
  if (!Number.isInteger(input.lookbackDays) || input.lookbackDays < 1 || input.lookbackDays > 365) {
    return '历史回填天数必须是 1—365 的整数';
  }
  if (input.historicalMode === 'selected' && input.historicalConversationIds.length === 0) {
    return '历史学习选择“仅指定会话”时，至少填写一个 conversationId';
  }
  if (input.realtimeMode === 'selected' && input.realtimeConversationIds.length === 0) {
    return '实时监听选择“仅指定会话”时，至少填写一个 conversationId';
  }
  const ids = [...input.historicalConversationIds, ...input.realtimeConversationIds];
  if (input.historicalConversationIds.length > 100 || input.realtimeConversationIds.length > 100) {
    return '每个范围最多配置 100 个 conversationId';
  }
  if (ids.some(id => id.length > 256)) return 'conversationId 最长 256 个字符';
  return null;
}

async function responseError(response: Response): Promise<Error> {
  try {
    const payload = await response.json() as { error?: unknown; code?: unknown };
    if (typeof payload.error === 'string' && payload.error.trim()) return new Error(payload.error);
    if (payload.code === 'AGENT_DWS_ACCOUNT_REVISION_CONFLICT') return new Error('配置已被其他管理员更新，请刷新后重试');
  } catch {
    // 使用统一 fallback。
  }
  return new Error(`保存 Context 范围失败（HTTP ${response.status}）`);
}

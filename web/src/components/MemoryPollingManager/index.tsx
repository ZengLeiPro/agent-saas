import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Loader2, RefreshCw, Save } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { SettingsPanelHeader } from "@/components/SettingsCenter/SettingsPanelHeader";
import { authFetch } from "@/lib/authFetch";
import type { ModelList } from "@/types/models";

interface MemoryPollingDraft {
  enabled: boolean;
  hour: number;
  hoursSpan: number;
  timezone: string;
  lookbackHours: number;
  maxTurns: number;
  timeoutSeconds: number;
  model: string;
}

interface MemoryPollingAdminView {
  polling: Omit<MemoryPollingDraft, "model"> & { model: string | null };
  configured: boolean;
  defaultModel: string | null;
}

const EMPTY_DRAFT: MemoryPollingDraft = {
  enabled: false,
  hour: 4,
  hoursSpan: 4,
  timezone: "Asia/Shanghai",
  lookbackHours: 48,
  maxTurns: 30,
  timeoutSeconds: 900,
  model: "",
};

function draftFromView(view: MemoryPollingAdminView): MemoryPollingDraft {
  return { ...view.polling, model: view.polling.model ?? "" };
}

async function readJson<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error((data as { error?: string }).error || `请求失败（${response.status}）`);
  }
  return data as T;
}

function validateDraft(draft: MemoryPollingDraft): string | null {
  if (!Number.isInteger(draft.hour) || draft.hour < 0 || draft.hour > 23) return "起始小时必须是 0–23 的整数";
  if (!Number.isInteger(draft.hoursSpan) || draft.hoursSpan < 1 || draft.hoursSpan > 12) return "调度跨度必须是 1–12 小时";
  if (draft.hour + draft.hoursSpan > 24) return "触发窗口不能跨越次日 00:00";
  if (!draft.timezone.trim()) return "时区不能为空";
  try {
    new Intl.DateTimeFormat("zh-CN", { timeZone: draft.timezone.trim() }).format();
  } catch {
    return "请输入有效的 IANA 时区，例如 Asia/Shanghai";
  }
  if (!Number.isInteger(draft.lookbackHours) || draft.lookbackHours < 1 || draft.lookbackHours > 168) return "活动回看范围必须是 1–168 小时";
  if (!Number.isInteger(draft.maxTurns) || draft.maxTurns < 1 || draft.maxTurns > 100) return "最大轮数必须是 1–100";
  if (!Number.isInteger(draft.timeoutSeconds) || draft.timeoutSeconds < 1 || draft.timeoutSeconds > 3600) return "执行超时必须是 1–3600 秒";
  return null;
}

function Field({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      <p className="text-xs leading-5 text-muted-foreground">{description}</p>
    </div>
  );
}

export function MemoryPollingManager() {
  const [view, setView] = useState<MemoryPollingAdminView | null>(null);
  const [draft, setDraft] = useState<MemoryPollingDraft>(EMPTY_DRAFT);
  const [modelList, setModelList] = useState<ModelList | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const updateDraft = useCallback((patch: Partial<MemoryPollingDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setDirty(true);
    setMessage(null);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [configResponse, modelsResponse] = await Promise.all([
        authFetch("/api/admin/memory-polling"),
        authFetch("/api/admin/models"),
      ]);
      const nextView = await readJson<MemoryPollingAdminView>(configResponse);
      const modelsData = modelsResponse.ok
        ? await modelsResponse.json() as { publicModelList?: ModelList }
        : {};
      setView(nextView);
      setDraft(draftFromView(nextView));
      setModelList(modelsData.publicModelList ?? null);
      setDirty(false);
      setMessage(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async () => {
    const validationError = validateDraft(draft);
    if (validationError) {
      setMessage(validationError);
      return;
    }
    setSaving(true);
    try {
      const response = await authFetch("/api/admin/memory-polling", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          polling: {
            ...draft,
            timezone: draft.timezone.trim(),
            model: draft.model || undefined,
          },
        }),
      });
      const nextView = await readJson<MemoryPollingAdminView>(response);
      setView(nextView);
      setDraft(draftFromView(nextView));
      setDirty(false);
      setMessage("配置已保存并应用");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }, [draft]);

  const maxHoursSpan = Math.max(1, Math.min(12, 24 - draft.hour));
  const windowLabel = useMemo(() => {
    const endHour = Math.min(24, draft.hour + draft.hoursSpan);
    return `${String(draft.hour).padStart(2, "0")}:00–${String(endHour).padStart(2, "0")}:00`;
  }, [draft.hour, draft.hoursSpan]);

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col">
      <SettingsPanelHeader
        title="记忆轮询"
        description="管理平台每日记忆整理任务的调度、活动范围和执行参数。组织是否启用及是否扣积分仍由各组织的能力配置控制。"
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading || saving}>
              <RefreshCw className={loading ? "size-3.5 animate-spin" : "size-3.5"} />
              刷新
            </Button>
            <Button size="sm" onClick={() => void save()} disabled={loading || saving || !dirty}>
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
              保存配置
            </Button>
          </div>
        }
      />

      <div className="min-h-0 flex-1 space-y-4 overflow-auto pb-2">
        {message && (
          <div className={message.includes("已保存")
            ? "rounded-md bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700"
            : "rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"}
          >
            {message}
          </div>
        )}

        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <CardTitle className="text-base">平台总开关</CardTitle>
                <p className="mt-1 text-xs text-muted-foreground">关闭后平台会禁用所有自动预置的记忆轮询系统任务，不影响已有记忆文件。</p>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="outline">{view?.configured ? "已落配置" : "运行时默认"}</Badge>
                <Switch
                  checked={draft.enabled}
                  onCheckedChange={(enabled) => updateDraft({ enabled })}
                  disabled={loading}
                  aria-label="平台记忆轮询总开关"
                />
              </div>
            </div>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">每日调度</CardTitle>
            <p className="text-xs text-muted-foreground">当前触发窗口 {windowLabel}，每个用户按 ID 稳定分散到 {draft.hoursSpan * 60} 个分钟槽。</p>
          </CardHeader>
          <CardContent className="grid gap-5 md:grid-cols-3">
            <Field label="起始小时" description="0–23，使用下方时区。">
              <Input aria-label="起始小时" type="number" min={0} max={23} value={draft.hour} onChange={(event) => {
                const hour = Number(event.target.value);
                updateDraft({ hour, hoursSpan: Math.min(draft.hoursSpan, Math.max(1, 24 - hour)) });
              }} />
            </Field>
            <Field label="调度跨度（小时）" description={`1–${maxHoursSpan}，不能跨越次日。`}>
              <Input aria-label="调度跨度（小时）" type="number" min={1} max={maxHoursSpan} value={draft.hoursSpan} onChange={(event) => updateDraft({ hoursSpan: Number(event.target.value) })} />
            </Field>
            <Field label="IANA 时区" description="例如 Asia/Shanghai。">
              <Input aria-label="IANA 时区" value={draft.timezone} onChange={(event) => updateDraft({ timezone: event.target.value })} placeholder="Asia/Shanghai" />
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">活动与执行</CardTitle>
            <p className="text-xs text-muted-foreground">仅在活动回看范围内存在用户主动消息时才启动模型，数据源不可用时安全跳过。</p>
          </CardHeader>
          <CardContent className="grid gap-5 md:grid-cols-2">
            <Field label="活动回看范围（小时）" description="1–168；同时决定无活动跳过的判断窗口。">
              <Input aria-label="活动回看范围（小时）" type="number" min={1} max={168} value={draft.lookbackHours} onChange={(event) => updateDraft({ lookbackHours: Number(event.target.value) })} />
            </Field>
            <Field label="最大轮数" description="1–100；限制一次记忆整理最多运行多少个 Agent turn。">
              <Input aria-label="最大轮数" type="number" min={1} max={100} value={draft.maxTurns} onChange={(event) => updateDraft({ maxTurns: Number(event.target.value) })} />
            </Field>
            <Field label="执行超时（秒）" description="1–3600；超时后本轮按失败结束，下一日仍会继续。">
              <Input aria-label="执行超时（秒）" type="number" min={1} max={3600} value={draft.timeoutSeconds} onChange={(event) => updateDraft({ timeoutSeconds: Number(event.target.value) })} />
            </Field>
            <Field label="执行模型" description={`留空则跟随各组织默认模型；平台当前默认 ${view?.defaultModel ?? "未配置"}。`}>
              <select
                aria-label="执行模型"
                className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                value={draft.model}
                onChange={(event) => updateDraft({ model: event.target.value })}
              >
                <option value="">跟随各组织默认模型</option>
                {modelList?.groups.flatMap((group) => group.models.map((model) => (
                  <option key={`${group.id}/${model.id}`} value={`${group.id}/${model.id}`}>
                    {group.name} / {model.name}
                  </option>
                )))}
              </select>
            </Field>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

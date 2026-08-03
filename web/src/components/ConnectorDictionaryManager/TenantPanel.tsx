/**
 * 组织管理「连接器映射」（2026-08-04 任务 E）。
 *
 * 与平台版同一张编辑表单，差异在数据语义：
 * - 列表 = 平台词典基线 + 本组织覆盖（覆盖条目带「已覆盖」徽标，组织新增带「本组织」）；
 * - 保存 = 建立/更新本组织覆盖（整条覆盖同 binary 平台条目，不做字段级 merge）；
 * - 「恢复平台默认」= 删除覆盖，回落平台条目；平台条目本身组织侧不可删。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Plus, RefreshCw, RotateCcw, Save } from "lucide-react";
import {
  deleteOrgConnectorOverride,
  fetchOrgConnectorDictionary,
  saveOrgConnectorEntry,
  type ConnectorDictionaryEntry,
} from "@agent/shared";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { SettingsPanelHeader } from "@/components/SettingsCenter/SettingsPanelHeader";
import { cn } from "@/lib/utils";
import { Field, fromDraft, toDraft, type DraftState } from "./index";

interface MergedEntry {
  entry: ConnectorDictionaryEntry;
  /** 本组织存在覆盖条目 */
  overridden: boolean;
  /** 平台没有、组织新增的连接器 */
  tenantOnly: boolean;
}

function mergeEntries(
  platform: ConnectorDictionaryEntry[],
  overrides: ConnectorDictionaryEntry[],
): MergedEntry[] {
  const overrideByBinary = new Map(overrides.map((entry) => [entry.binary, entry]));
  const platformBinaries = new Set(platform.map((entry) => entry.binary));
  const merged: MergedEntry[] = platform.map((entry) => {
    const override = overrideByBinary.get(entry.binary);
    return { entry: override ?? entry, overridden: !!override, tenantOnly: false };
  });
  for (const entry of overrides) {
    if (!platformBinaries.has(entry.binary)) {
      merged.push({ entry, overridden: true, tenantOnly: true });
    }
  }
  return merged.sort((a, b) => a.entry.binary.localeCompare(b.entry.binary));
}

export function TenantConnectorDictionaryPanel({
  tenantId,
  tenantName,
}: {
  tenantId?: string;
  tenantName?: string;
}) {
  const [platform, setPlatform] = useState<ConnectorDictionaryEntry[]>([]);
  const [overrides, setOverrides] = useState<ConnectorDictionaryEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 组织新增、尚未保存的连接器（保存前不存在于任何一层） */
  const [pendingNew, setPendingNew] = useState<ConnectorDictionaryEntry | null>(null);

  const merged = useMemo(() => {
    const base = mergeEntries(platform, overrides);
    if (pendingNew && !base.some((item) => item.entry.binary === pendingNew.binary)) {
      base.push({ entry: pendingNew, overridden: true, tenantOnly: true });
      base.sort((a, b) => a.entry.binary.localeCompare(b.entry.binary));
    }
    return base;
  }, [platform, overrides, pendingNew]);

  const current = useMemo(
    () => merged.find((item) => item.entry.binary === selected) ?? null,
    [merged, selected],
  );

  const applyResponse = useCallback(
    (
      next: { platform: ConnectorDictionaryEntry[]; overrides: ConnectorDictionaryEntry[] },
      keep?: string | null,
    ) => {
      setPlatform(next.platform);
      setOverrides(next.overrides);
      setPendingNew(null);
      const view = mergeEntries(next.platform, next.overrides);
      const target = keep && view.some((item) => item.entry.binary === keep)
        ? keep
        : view[0]?.entry.binary ?? null;
      setSelected(target);
      const item = view.find((candidate) => candidate.entry.binary === target);
      setDraft(item ? toDraft(item.entry) : null);
      setDirty(false);
    },
    [],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetchOrgConnectorDictionary(tenantId);
      applyResponse(response, selected);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
    // selected 刻意不进依赖：刷新只在挂载/切组织/显式点击时发生
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyResponse, tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  const select = useCallback((binary: string) => {
    setSelected(binary);
    setDraft(() => {
      const item = merged.find((candidate) => candidate.entry.binary === binary);
      return item ? toDraft(item.entry) : null;
    });
    setDirty(false);
    setMessage(null);
  }, [merged]);

  const patch = useCallback((next: Partial<DraftState>) => {
    setDraft((currentDraft) => (currentDraft ? { ...currentDraft, ...next } : currentDraft));
    setDirty(true);
    setMessage(null);
    setError(null);
  }, []);

  const save = useCallback(async () => {
    if (!selected || !draft) return;
    setSaving(true);
    setError(null);
    try {
      const response = await saveOrgConnectorEntry(fromDraft(selected, draft), tenantId);
      applyResponse(response, selected);
      setMessage("已保存为本组织覆盖，后续工具调用按组织词典产出摘要（约 1 分钟内全量生效）");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [applyResponse, draft, selected, tenantId]);

  const removeOverride = useCallback(async () => {
    if (!selected) return;
    setSaving(true);
    setError(null);
    try {
      const response = await deleteOrgConnectorOverride(selected, tenantId);
      applyResponse(response, selected);
      setMessage("已恢复平台默认");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [applyResponse, selected, tenantId]);

  const addEntry = useCallback(() => {
    const binary = window.prompt("新连接器的命令名（如组织自装的 CLI）");
    if (!binary?.trim()) return;
    const name = binary.trim();
    if (merged.some((item) => item.entry.binary === name)) {
      setSelected(name);
      return;
    }
    const entry: ConnectorDictionaryEntry = {
      binary: name,
      systemName: name,
      enabled: true,
      modules: {},
      actionVerbs: {},
      excludePatterns: ["--help", "-h", "help", "--version"],
      urlWhitelist: [],
    };
    setPendingNew(entry);
    setSelected(name);
    setDraft(toDraft(entry));
    setDirty(true);
    setMessage("填好后点「保存」才会生效");
  }, [merged]);

  const busy = loading || saving;

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col">
      <SettingsPanelHeader
        title="连接器映射"
        description={`平台词典是默认基线；${tenantName ?? "本组织"}保存的条目按连接器整条覆盖平台默认，只对本组织的会话生效。`}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={busy}>
              <RefreshCw className={loading ? "size-3.5 animate-spin" : "size-3.5"} />
              刷新
            </Button>
            <Button size="sm" onClick={() => void save()} disabled={busy || !dirty || !draft}>
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
              保存
            </Button>
          </div>
        }
      />

      <div className="min-h-0 flex-1 space-y-3 overflow-auto pb-2">
        {message && (
          <div className="rounded-md border border-success/30 bg-success-subtle px-3 py-2 text-sm text-success-ink">
            {message}
          </div>
        )}
        {error && (
          <div className="rounded-md border border-danger/30 bg-danger-subtle px-3 py-2 text-sm text-danger-ink">
            {error}
          </div>
        )}

        <div className="grid gap-3 md:grid-cols-[220px_1fr]">
          <Card className="h-fit">
            <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
              <CardTitle className="text-sm">连接器</CardTitle>
              <Button variant="ghost" size="sm" onClick={addEntry} disabled={busy} aria-label="新增连接器">
                <Plus className="size-3.5" />
              </Button>
            </CardHeader>
            <CardContent className="space-y-1 pb-3">
              {loading && <p className="text-xs text-muted-foreground">加载中…</p>}
              {!loading && merged.length === 0 && (
                <p className="text-xs text-muted-foreground">暂无连接器。</p>
              )}
              {merged.map((item) => (
                <button
                  key={item.entry.binary}
                  type="button"
                  onClick={() => select(item.entry.binary)}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                    item.entry.binary === selected ? "bg-brand-accent-soft font-semibold" : "hover:bg-muted/60",
                  )}
                >
                  <span className="min-w-0 truncate">
                    <span className="font-mono text-xs">{item.entry.binary}</span>
                    <span className="ml-1.5 text-muted-foreground">{item.entry.systemName}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    {item.tenantOnly ? (
                      <Badge variant="outline" className="text-[10px]">本组织</Badge>
                    ) : item.overridden ? (
                      <Badge variant="outline" className="text-[10px]">已覆盖</Badge>
                    ) : null}
                    {!item.entry.enabled && <Badge variant="outline" className="text-[10px]">已停用</Badge>}
                  </span>
                </button>
              ))}
            </CardContent>
          </Card>

          {draft && selected ? (
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <CardTitle className="font-mono text-base">{selected}</CardTitle>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {current?.tenantOnly
                        ? "本组织新增的连接器，只对本组织会话生效。"
                        : current?.overridden
                          ? "当前生效的是本组织覆盖版本；「恢复平台默认」可回落平台词典。"
                          : "当前生效的是平台默认；保存修改后将成为本组织的覆盖版本。"}
                    </p>
                  </div>
                  <Switch
                    checked={draft.enabled}
                    onCheckedChange={(enabled) => patch({ enabled })}
                    disabled={busy}
                    aria-label="启用该连接器"
                  />
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <Field label="系统名" hint="客户在工具行上看到的第一段，如「钉钉」「飞书」。">
                  <Input
                    aria-label="系统名"
                    value={draft.systemName}
                    onChange={(event) => patch({ systemName: event.target.value })}
                    disabled={busy}
                  />
                </Field>

                <Field
                  label="模块映射"
                  hint="每行一条，格式「子命令 = 中文模块名」，如 todo = 待办。未登记的子命令原样显示，不硬凑中文。"
                >
                  <Textarea
                    aria-label="模块映射"
                    rows={6}
                    className="font-mono text-xs"
                    value={draft.modules}
                    onChange={(event) => patch({ modules: event.target.value })}
                    disabled={busy}
                  />
                </Field>

                <Field
                  label="动作动词"
                  hint="每行一条，格式「动词 = 中文动作 | 写」或「… | 读」。标「写」的动作才会被当成动了外部系统并展示回执；不写末段默认按「读」处理。"
                >
                  <Textarea
                    aria-label="动作动词"
                    rows={8}
                    className="font-mono text-xs"
                    value={draft.actionVerbs}
                    onChange={(event) => patch({ actionVerbs: event.target.value })}
                    disabled={busy}
                  />
                </Field>

                <Field
                  label="排除规则"
                  hint="每行一条，按完整参数匹配。命中的调用不产出业务动作标题。"
                >
                  <Textarea
                    aria-label="排除规则"
                    rows={4}
                    className="font-mono text-xs"
                    value={draft.excludePatterns}
                    onChange={(event) => patch({ excludePatterns: event.target.value })}
                    disabled={busy}
                  />
                </Field>

                <Field
                  label="链接域名白名单"
                  hint="每行一个域名，支持 *.example.com。只有这些域名下的链接才会作为业务链接展示；不填则不展示任何链接。"
                >
                  <Textarea
                    aria-label="链接域名白名单"
                    rows={4}
                    className="font-mono text-xs"
                    value={draft.urlWhitelist}
                    onChange={(event) => patch({ urlWhitelist: event.target.value })}
                    disabled={busy}
                  />
                </Field>

                <div className="flex items-center justify-between gap-3 border-t pt-3">
                  <p className="text-xs text-muted-foreground">
                    {current?.entry.updatedAt
                      ? `最近更新：${new Date(current.entry.updatedAt).toLocaleString("zh-CN")}${current.entry.updatedBy ? ` · ${current.entry.updatedBy}` : ""}`
                      : "尚未保存过"}
                  </p>
                  {current?.overridden && !pendingNew ? (
                    <Button variant="ghost" size="sm" onClick={() => void removeOverride()} disabled={busy}>
                      <RotateCcw className="size-3.5" />
                      恢复平台默认
                    </Button>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="py-10 text-center text-sm text-muted-foreground">
                {loading ? "加载中…" : "请选择左侧的连接器"}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

export default TenantConnectorDictionaryPanel;

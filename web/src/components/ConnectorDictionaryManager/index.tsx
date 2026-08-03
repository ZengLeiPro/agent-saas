/**
 * 平台管理「连接器映射」。
 *
 * 这张词典决定客户在工具行上看到的是「钉钉 · 创建待办 · 回执 7632…」还是
 * 一行 `dws todo create --title ...`。连接器 CLI 自己会迭代（加子命令、改动词），
 * 词典硬编码在代码里意味着每次升级都要发版——放到这里之后保存即热更新。
 *
 * 交互与「工具开关」「网络出口」同惯例：左侧列表选中、右侧整条编辑、
 * 顶部刷新 + 保存；委托运营账号只读。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Plus, RefreshCw, RotateCcw, Save, Trash2 } from "lucide-react";
import {
  deleteConnectorEntry,
  fetchConnectorDictionary,
  resetConnectorDictionary,
  saveConnectorEntry,
  type ConnectorDictionaryEntry,
} from "@agent/shared";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { SettingsPanelHeader } from "@/components/SettingsCenter/SettingsPanelHeader";
import { useAuth } from "@/contexts/AuthContext";
import { cn } from "@/lib/utils";

/** 词典里的映射表在界面上是「每行一条 `键 = 值`」——比 JSON 输入框好改十倍 */
export function mapToLines(map: Record<string, string>): string {
  return Object.entries(map).map(([key, value]) => `${key} = ${value}`).join("\n");
}

export function linesToMap(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const at = trimmed.indexOf("=");
    if (at <= 0) continue;
    const key = trimmed.slice(0, at).trim();
    const value = trimmed.slice(at + 1).trim();
    if (key && value) result[key] = value;
  }
  return result;
}

/** 动词行形如 `create = 创建 | 写`；末段决定它是不是写操作（是否配得上回执章） */
export function verbsToLines(verbs: ConnectorDictionaryEntry["actionVerbs"]): string {
  return Object.entries(verbs)
    .map(([verb, value]) => `${verb} = ${value.name} | ${value.write ? "写" : "读"}`)
    .join("\n");
}

export function linesToVerbs(text: string): ConnectorDictionaryEntry["actionVerbs"] {
  const result: ConnectorDictionaryEntry["actionVerbs"] = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const at = trimmed.indexOf("=");
    if (at <= 0) continue;
    const verb = trimmed.slice(0, at).trim();
    const rest = trimmed.slice(at + 1);
    const [rawName, rawFlag] = rest.split("|");
    const name = (rawName ?? "").trim();
    if (!verb || !name) continue;
    // 缺省按「读」处理：写操作会盖回执章，宁可漏盖不可错盖
    result[verb] = { name, write: (rawFlag ?? "").trim() === "写" };
  }
  return result;
}

export function listToLines(list: string[]): string {
  return list.join("\n");
}

export function linesToList(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter(Boolean);
}

interface DraftState {
  systemName: string;
  enabled: boolean;
  modules: string;
  actionVerbs: string;
  excludePatterns: string;
  urlWhitelist: string;
}

function toDraft(entry: ConnectorDictionaryEntry): DraftState {
  return {
    systemName: entry.systemName,
    enabled: entry.enabled,
    modules: mapToLines(entry.modules),
    actionVerbs: verbsToLines(entry.actionVerbs),
    excludePatterns: listToLines(entry.excludePatterns),
    urlWhitelist: listToLines(entry.urlWhitelist),
  };
}

function fromDraft(binary: string, draft: DraftState): ConnectorDictionaryEntry {
  return {
    binary,
    systemName: draft.systemName.trim(),
    enabled: draft.enabled,
    modules: linesToMap(draft.modules),
    actionVerbs: linesToVerbs(draft.actionVerbs),
    excludePatterns: linesToList(draft.excludePatterns),
    urlWhitelist: linesToList(draft.urlWhitelist),
  };
}

function Field({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      <p className="text-xs leading-5 text-muted-foreground">{hint}</p>
    </div>
  );
}

export function ConnectorDictionaryManager() {
  const { platformReadOnly } = useAuth();
  const [entries, setEntries] = useState<ConnectorDictionaryEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const current = useMemo(
    () => entries.find((entry) => entry.binary === selected) ?? null,
    [entries, selected],
  );

  const applyResponse = useCallback((next: ConnectorDictionaryEntry[], keep?: string | null) => {
    setEntries(next);
    const target = keep && next.some((entry) => entry.binary === keep) ? keep : next[0]?.binary ?? null;
    setSelected(target);
    const entry = next.find((item) => item.binary === target);
    setDraft(entry ? toDraft(entry) : null);
    setDirty(false);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetchConnectorDictionary();
      applyResponse(response.entries, selected);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
    // selected 刻意不进依赖：刷新只在挂载与显式点击时发生，跟着选中变会打断编辑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyResponse]);

  useEffect(() => {
    void load();
  }, [load]);

  const select = useCallback((binary: string) => {
    setSelected(binary);
    setEntries((list) => {
      const entry = list.find((item) => item.binary === binary);
      setDraft(entry ? toDraft(entry) : null);
      return list;
    });
    setDirty(false);
    setMessage(null);
  }, []);

  const patch = useCallback((next: Partial<DraftState>) => {
    setDraft((current) => (current ? { ...current, ...next } : current));
    setDirty(true);
    setMessage(null);
    setError(null);
  }, []);

  const save = useCallback(async () => {
    if (!selected || !draft) return;
    setSaving(true);
    setError(null);
    try {
      const response = await saveConnectorEntry(fromDraft(selected, draft));
      applyResponse(response.entries, selected);
      setMessage("已保存并生效，后续工具调用即按新词典产出摘要");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [applyResponse, draft, selected]);

  const remove = useCallback(async () => {
    if (!selected) return;
    setSaving(true);
    setError(null);
    try {
      const response = await deleteConnectorEntry(selected);
      applyResponse(response.entries, null);
      setMessage("已删除，该命令不再被还原成业务语言");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [applyResponse, selected]);

  const restore = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const response = await resetConnectorDictionary();
      applyResponse(response.entries, selected);
      setMessage("已恢复内置词典");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [applyResponse, selected]);

  const addEntry = useCallback(() => {
    const binary = window.prompt("新连接器的命令名（如 dws / lark）");
    if (!binary?.trim()) return;
    const name = binary.trim();
    setEntries((list) => (list.some((entry) => entry.binary === name)
      ? list
      : [...list, {
        binary: name,
        systemName: name,
        enabled: true,
        modules: {},
        actionVerbs: {},
        excludePatterns: ["--help", "-h", "help", "--version"],
        urlWhitelist: [],
      }].sort((a, b) => a.binary.localeCompare(b.binary))));
    setSelected(name);
    setDraft({
      systemName: name,
      enabled: true,
      modules: "",
      actionVerbs: "",
      excludePatterns: "--help\n-h\nhelp\n--version",
      urlWhitelist: "",
    });
    setDirty(true);
    setMessage("填好后点「保存」才会生效");
  }, []);

  const busy = loading || saving;
  const readOnly = platformReadOnly;

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col">
      <SettingsPanelHeader
        title="连接器映射"
        description="把命令行还原成客户读得懂的业务语言：系统名、模块名、动作动词。只有写操作才会被标成「动了外部系统」并展示回执。"
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={busy}>
              <RefreshCw className={loading ? "size-3.5 animate-spin" : "size-3.5"} />
              刷新
            </Button>
            <Button variant="outline" size="sm" onClick={() => void restore()} disabled={readOnly || busy}>
              <RotateCcw className="size-3.5" />
              恢复内置
            </Button>
            <Button size="sm" onClick={() => void save()} disabled={readOnly || busy || !dirty || !draft}>
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
              <Button variant="ghost" size="sm" onClick={addEntry} disabled={readOnly || busy} aria-label="新增连接器">
                <Plus className="size-3.5" />
              </Button>
            </CardHeader>
            <CardContent className="space-y-1 pb-3">
              {loading && <p className="text-xs text-muted-foreground">加载中…</p>}
              {!loading && entries.length === 0 && (
                <p className="text-xs text-muted-foreground">暂无连接器，点右上角「+」新增。</p>
              )}
              {entries.map((entry) => (
                <button
                  key={entry.binary}
                  type="button"
                  onClick={() => select(entry.binary)}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                    entry.binary === selected ? "bg-brand-accent-soft font-semibold" : "hover:bg-muted/60",
                  )}
                >
                  <span className="min-w-0 truncate">
                    <span className="font-mono text-xs">{entry.binary}</span>
                    <span className="ml-1.5 text-muted-foreground">{entry.systemName}</span>
                  </span>
                  {!entry.enabled && <Badge variant="outline" className="shrink-0 text-[10px]">已停用</Badge>}
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
                      停用后该命令不再被还原成业务语言，工具行退回「执行命令 + 命令行」。
                    </p>
                  </div>
                  <Switch
                    checked={draft.enabled}
                    onCheckedChange={(enabled) => patch({ enabled })}
                    disabled={readOnly || busy}
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
                    disabled={readOnly || busy}
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
                    disabled={readOnly || busy}
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
                    disabled={readOnly || busy}
                  />
                </Field>

                <Field
                  label="排除规则"
                  hint="每行一条，按完整参数匹配。命中的调用不产出业务动作标题——读帮助文档不是业务动作，写成「创建待办」是造假。"
                >
                  <Textarea
                    aria-label="排除规则"
                    rows={4}
                    className="font-mono text-xs"
                    value={draft.excludePatterns}
                    onChange={(event) => patch({ excludePatterns: event.target.value })}
                    disabled={readOnly || busy}
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
                    disabled={readOnly || busy}
                  />
                </Field>

                <div className="flex items-center justify-between gap-3 border-t pt-3">
                  <p className="text-xs text-muted-foreground">
                    {current?.updatedAt
                      ? `最近更新：${new Date(current.updatedAt).toLocaleString("zh-CN")}${current.updatedBy ? ` · ${current.updatedBy}` : ""}`
                      : "尚未保存过"}
                  </p>
                  <Button variant="ghost" size="sm" onClick={() => void remove()} disabled={readOnly || busy}>
                    <Trash2 className="size-3.5" />
                    删除
                  </Button>
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

export default ConnectorDictionaryManager;

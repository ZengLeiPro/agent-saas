import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, RotateCcw, Save } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { SettingsPanelHeader } from "@/components/SettingsCenter/SettingsPanelHeader";
import { useAuth } from "@/contexts/AuthContext";
import { authFetch } from "@/lib/authFetch";
import { cn } from "@/lib/utils";

type PromptCategory = "main" | "subagent" | "utility";

interface SystemPromptItem {
  id: string;
  category: PromptCategory;
  label: string;
  description: string;
  variables: string[];
  defaultContent: string;
  content: string;
  overridden: boolean;
}

interface SystemPromptsResponse {
  prompts: SystemPromptItem[];
}

const CATEGORY_LABELS: Record<PromptCategory, string> = {
  main: "主 Agent",
  subagent: "子 Agent",
  utility: "辅助模型",
};

export function SystemPromptsManager(): JSX.Element {
  const { platformReadOnly } = useAuth();
  const [prompts, setPrompts] = useState<SystemPromptItem[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  const selected = useMemo(
    () => prompts.find((prompt) => prompt.id === selectedId) ?? prompts[0] ?? null,
    [prompts, selectedId],
  );
  const dirty = !!selected && draft !== selected.content;

  const applyResponse = useCallback((data: SystemPromptsResponse, preferredId?: string) => {
    setPrompts(data.prompts);
    const nextSelected = data.prompts.find((item) => item.id === preferredId)
      ?? data.prompts[0]
      ?? null;
    setSelectedId(nextSelected?.id ?? "");
    setDraft(nextSelected?.content ?? "");
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    try {
      const response = await authFetch("/api/admin/system-prompts");
      const data = await readJson<SystemPromptsResponse>(response);
      applyResponse(data, selectedId);
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setLoading(false);
    }
  }, [applyResponse, selectedId]);

  useEffect(() => {
    void load();
    // 首次进入加载一次；切换类型不应重复请求并覆盖草稿。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectPrompt = useCallback((prompt: SystemPromptItem) => {
    if (dirty && !window.confirm("当前修改尚未保存，确定切换到其他提示语吗？")) return;
    setSelectedId(prompt.id);
    setDraft(prompt.content);
    setMessage(null);
  }, [dirty]);

  const save = useCallback(async () => {
    if (!selected || !draft.trim()) {
      setMessage({ kind: "error", text: "系统提示语不能为空" });
      return;
    }
    if (!window.confirm(`保存后「${selected.label}」将在后续模型调用中立即生效，确定继续吗？`)) return;
    setSaving(true);
    setMessage(null);
    try {
      const response = await authFetch(`/api/admin/system-prompts/${encodeURIComponent(selected.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: draft }),
      });
      const data = await readJson<SystemPromptsResponse>(response);
      applyResponse(data, selected.id);
      setMessage({ kind: "success", text: "已保存并热更新，后续模型调用立即使用新版本" });
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setSaving(false);
    }
  }, [applyResponse, draft, selected]);

  const reset = useCallback(async () => {
    if (!selected) return;
    if (!selected.overridden) {
      setDraft(selected.defaultContent);
      return;
    }
    if (!window.confirm(`确定恢复「${selected.label}」的系统默认提示语吗？恢复后立即生效。`)) return;
    setSaving(true);
    setMessage(null);
    try {
      const response = await authFetch(`/api/admin/system-prompts/${encodeURIComponent(selected.id)}`, {
        method: "DELETE",
      });
      const data = await readJson<SystemPromptsResponse>(response);
      applyResponse(data, selected.id);
      setMessage({ kind: "success", text: "已恢复系统默认并热更新" });
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setSaving(false);
    }
  }, [applyResponse, selected]);

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-6xl flex-col">
      <SettingsPanelHeader
        title="系统提示语"
        description="统一管理主 Agent、子 Agent 与辅助模型的全局系统提示语。组织资料、个人 Persona 和专职 Agent 指令仍在各自入口维护。"
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading || saving}>
              <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
              刷新
            </Button>
            <Button size="sm" onClick={() => void save()} disabled={platformReadOnly || loading || saving || !dirty || !draft.trim()}>
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
              保存并热更新
            </Button>
          </div>
        }
      />

      <div className="mb-3 rounded-md border border-brand-200 bg-brand-50 px-3 py-2 text-xs leading-5 text-brand-800">
        保存后从下一次模型调用开始生效；正在生成中的调用不变。该配置影响全平台，仅超级管理员 @admin 可修改。
      </div>

      {message && (
        <div className={cn(
          "mb-3 rounded-md px-3 py-2 text-sm",
          message.kind === "success"
            ? "bg-emerald-500/10 text-emerald-700"
            : "bg-destructive/10 text-destructive",
        )}>
          {message.text}
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-rows-[180px_minmax(0,1fr)] gap-4 overflow-hidden md:grid-cols-[240px_minmax(0,1fr)] md:grid-rows-1">
        <Card className="min-h-0 overflow-hidden">
          <CardContent className="h-full overflow-auto p-2">
            {loading && prompts.length === 0 ? (
              <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
                <Loader2 className="mr-2 size-4 animate-spin" />加载中
              </div>
            ) : (
              (["main", "subagent", "utility"] as const).map((category) => {
                const items = prompts.filter((prompt) => prompt.category === category);
                if (items.length === 0) return null;
                return (
                  <div key={category} className="mb-3 last:mb-0">
                    <div className="px-2 py-1 text-xs font-medium text-muted-foreground">{CATEGORY_LABELS[category]}</div>
                    <div className="space-y-1">
                      {items.map((prompt) => (
                        <button
                          key={prompt.id}
                          type="button"
                          className={cn(
                            "flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left text-sm",
                            selected?.id === prompt.id
                              ? "bg-brand-50 font-medium text-brand-800"
                              : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                          )}
                          onClick={() => selectPrompt(prompt)}
                        >
                          <span className="min-w-0 truncate">{prompt.label.replace(/^.*? · /, "")}</span>
                          {prompt.overridden && <span className="size-1.5 shrink-0 rounded-full bg-brand-600" title="已自定义" />}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>

        <Card className="flex min-h-0 flex-col overflow-hidden">
          {selected ? (
            <>
              <CardHeader className="shrink-0 space-y-2 border-b pb-4">
                <div className="flex flex-wrap items-start justify-between gap-3 pr-8">
                  <div>
                    <CardTitle className="text-base">{selected.label}</CardTitle>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">{selected.description}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">{selected.overridden ? "已自定义" : "系统默认"}</Badge>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void reset()}
                      disabled={platformReadOnly || saving || (!selected.overridden && draft === selected.defaultContent)}
                    >
                      <RotateCcw className="size-3.5" />恢复默认
                    </Button>
                  </div>
                </div>
                {selected.variables.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    <span>可用变量：</span>
                    {selected.variables.map((variable) => (
                      <code key={variable} className="rounded bg-muted px-1.5 py-0.5">{formatVariable(variable)}</code>
                    ))}
                  </div>
                )}
              </CardHeader>
              <CardContent className="flex min-h-0 flex-1 flex-col gap-2 p-4">
                <Textarea
                  aria-label={`${selected.label}内容`}
                  className="min-h-0 flex-1 resize-none font-mono text-xs leading-5"
                  value={draft}
                  onChange={(event) => { setDraft(event.target.value); setMessage(null); }}
                  disabled={platformReadOnly || loading || saving}
                  maxLength={200_000}
                  spellCheck={false}
                />
                <div className="flex shrink-0 items-center justify-between text-xs text-muted-foreground">
                  <span>{dirty ? "有未保存修改" : "内容已同步"}</span>
                  <span>{draft.length.toLocaleString()} / 200,000 字符</span>
                </div>
              </CardContent>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">暂无系统提示语</div>
          )}
        </Card>
      </div>
    </div>
  );
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `请求失败（HTTP ${response.status}）`);
  return body;
}

function formatVariable(variable: string): string {
  return variable.startsWith("IF_")
    ? `{{#${variable}}}…{{/${variable}}}`
    : `{{${variable}}}`;
}

export default SystemPromptsManager;

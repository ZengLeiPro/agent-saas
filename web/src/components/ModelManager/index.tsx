import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, Database, Loader2, Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import { authFetch } from "@/lib/authFetch";
import { refreshAll } from "@/lib/refreshBus";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { ModelList } from "@/types/models";
import { DescriptionTip, SettingsPanelHeader } from "@/components/SettingsCenter/SettingsPanelHeader";
import { SettingsTwoColumn } from "@/components/SettingsCenter/SettingsTwoColumn";
import { cn } from "@/lib/utils";

type ModelProtocol = "chat_completions" | "responses";

const DEFAULT_PROTOCOL: ModelProtocol = "chat_completions";
const INHERIT_PROTOCOL = "__inherit__";

type EditableModel = {
  id: string;
  name: string;
  value: string;
  pricing?: {
    input: number;
    output: number;
    cacheCreation: number;
    cacheRead: number;
  };
  thinking?: unknown;
  reasoning_effort?: string;
  reasoningEffort?: string;
  extraBody?: Record<string, unknown>;
  input_modalities?: Array<"text" | "image">;
  protocol?: ModelProtocol;
  usage_accounting?: "input_includes_cache" | "cache_tokens_separate";
  alias_actual?: string;
  context_window?: number;
  auto_compact_threshold?: number;
  tool_choice_modes?: Array<"auto" | "required" | "none" | "specific">;
  is_pseudo_reasoning?: boolean;
};

type EditableGroup = {
  id: string;
  name: string;
  apiKey?: string;
  baseUrl?: string | null;
  disable_response_chaining?: boolean;
  disable_prompt_cache_key?: boolean;
  protocol?: ModelProtocol;
  thinking?: unknown;
  reasoning_effort?: string;
  reasoningEffort?: string;
  extraBody?: Record<string, unknown>;
  input_modalities?: Array<"text" | "image">;
  models: EditableModel[];
};

type EditableModelsConfig = {
  groups: EditableGroup[];
  default: string;
  allowCrossGroupSwitch: boolean;
  imageUnderstanding?: {
    model: string;
    fallbackModels?: string[];
    timeoutMs?: number;
  };
};

type EditableMemoryIndexConfig = {
  enabled?: boolean;
  dbDir?: string;
  embedding: {
    baseUrl: string;
    apiKey: string;
    model: string;
    dimensions: number;
  };
  chunking?: {
    tokens?: number;
    overlap?: number;
  };
  search?: {
    vectorWeight?: number;
    textWeight?: number;
    maxResults?: number;
    minScore?: number;
  };
  temporalDecay?: {
    enabled?: boolean;
    halfLifeDays?: number;
  };
  sync?: {
    debounceMs?: number;
  };
};

type AdminModelsResponse = {
  models: EditableModelsConfig;
  memoryIndex: EditableMemoryIndexConfig | null;
  publicModelList: ModelList;
};

type SelectedPanel =
  | { type: "general" }
  | { type: "group"; groupId: string }
  | { type: "model"; groupId: string; modelId: string };

const emptyModel = (): EditableModel => ({ id: "", name: "", value: "" });
const emptyGroup = (): EditableGroup => ({ id: "", name: "", protocol: DEFAULT_PROTOCOL, models: [emptyModel()] });

const emptyPricing = () => ({ input: 0, output: 0, cacheCreation: 0, cacheRead: 0 });

const defaultMemoryIndex = (): EditableMemoryIndexConfig => ({
  enabled: false,
  dbDir: "data/memory-index",
  embedding: {
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode",
    apiKey: "",
    model: "text-embedding-v3",
    dimensions: 1024,
  },
  chunking: {
    tokens: 200,
    overlap: 40,
  },
  search: {
    vectorWeight: 0.7,
    textWeight: 0.3,
    maxResults: 10,
    minScore: 0.3,
  },
  temporalDecay: {
    enabled: false,
    halfLifeDays: 30,
  },
  sync: {
    debounceMs: 1500,
  },
});

function stringifyJson(value: unknown): string {
  return JSON.stringify(value ?? {}, null, 2);
}

function parseOptionalJsonObject(text: string, label: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} 必须是 JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function parseOptionalJson(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return JSON.parse(trimmed) as unknown;
}

function normalizePricing(pricing: EditableModel["pricing"]): EditableModel["pricing"] {
  if (!pricing) return undefined;
  return {
    input: Number(pricing.input) || 0,
    output: Number(pricing.output) || 0,
    cacheCreation: Number(pricing.cacheCreation) || 0,
    cacheRead: Number(pricing.cacheRead) || 0,
  };
}

function resolveGroupProtocol(group: EditableGroup): ModelProtocol {
  return group.protocol ?? DEFAULT_PROTOCOL;
}

function resolveModelProtocol(group: EditableGroup, model: EditableModel): ModelProtocol {
  return model.protocol ?? resolveGroupProtocol(group);
}

function resolveGroupReasoningEffort(group: EditableGroup): string | undefined {
  return group.reasoning_effort ?? group.reasoningEffort;
}

function resolveModelReasoningEffort(group: EditableGroup, model: EditableModel): string | undefined {
  return model.reasoning_effort ?? model.reasoningEffort ?? resolveGroupReasoningEffort(group);
}

function resolveModelImageInput(group: EditableGroup, model: EditableModel): boolean {
  return (model.input_modalities ?? group.input_modalities)?.includes("image") === true;
}

function formatEffectiveValue(value: string | undefined): string {
  return value || "未指定";
}

export function ModelManager() {
  const [models, setModels] = useState<EditableModelsConfig | null>(null);
  const [memoryIndex, setMemoryIndex] = useState<EditableMemoryIndexConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [selectedPanel, setSelectedPanel] = useState<SelectedPanel>({ type: "general" });
  const [advancedText, setAdvancedText] = useState<Record<string, { groupExtraBody: string; groupThinking: string; modelExtraBody: Record<string, string>; modelThinking: Record<string, string> }>>({});

  const selectedGroup = useMemo(
    () => selectedPanel.type === "group"
      ? models?.groups.find((group) => group.id === selectedPanel.groupId) ?? null
      : null,
    [models, selectedPanel],
  );

  const selectedModelContext = useMemo(() => {
    if (selectedPanel.type !== "model") return null;
    const group = models?.groups.find((item) => item.id === selectedPanel.groupId);
    const model = group?.models.find((item) => item.id === selectedPanel.modelId);
    return group && model ? { group, model } : null;
  }, [models, selectedPanel]);

  const hydrateAdvancedText = useCallback((next: EditableModelsConfig) => {
    const entries: typeof advancedText = {};
    for (const group of next.groups) {
      entries[group.id] = {
        groupExtraBody: group.extraBody ? stringifyJson(group.extraBody) : "",
        groupThinking: group.thinking !== undefined ? stringifyJson(group.thinking) : "",
        modelExtraBody: Object.fromEntries(group.models.map((model) => [model.id, model.extraBody ? stringifyJson(model.extraBody) : ""])),
        modelThinking: Object.fromEntries(group.models.map((model) => [model.id, model.thinking !== undefined ? stringifyJson(model.thinking) : ""])),
      };
    }
    setAdvancedText(entries);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authFetch("/api/admin/models");
      const data = (await res.json().catch(() => ({}))) as Partial<AdminModelsResponse> & { error?: string };
      if (!res.ok || !data.models) throw new Error(data.error || `HTTP ${res.status}`);
      setModels(data.models);
      setMemoryIndex(data.memoryIndex ?? null);
      setSelectedPanel((prev) => {
        if (prev.type === "group" && data.models!.groups.some((group) => group.id === prev.groupId)) return prev;
        if (prev.type === "model" && data.models!.groups.some((group) => group.id === prev.groupId && group.models.some((model) => model.id === prev.modelId))) return prev;
        return { type: "general" };
      });
      hydrateAdvancedText(data.models);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [hydrateAdvancedText]);

  useEffect(() => { void refresh(); }, [refresh]);

  const updateModels = useCallback((updater: (current: EditableModelsConfig) => EditableModelsConfig) => {
    setModels((current) => current ? updater(current) : current);
    setSavedAt(null);
  }, []);

  const updateMemoryIndex = useCallback((updater: (current: EditableMemoryIndexConfig) => EditableMemoryIndexConfig) => {
    setMemoryIndex((current) => updater(current ?? defaultMemoryIndex()));
    setSavedAt(null);
  }, []);

  const updateMemoryEmbedding = useCallback((patch: Partial<EditableMemoryIndexConfig["embedding"]>) => {
    updateMemoryIndex((current) => ({
      ...current,
      embedding: {
        ...current.embedding,
        ...patch,
      },
    }));
  }, [updateMemoryIndex]);

  const updateGroup = useCallback((groupId: string, patch: Partial<EditableGroup>) => {
    updateModels((current) => ({
      ...current,
      groups: current.groups.map((group) => group.id === groupId ? { ...group, ...patch } : group),
    }));
  }, [updateModels]);

  const updateGroupId = useCallback((groupId: string, nextGroupId: string) => {
    updateModels((current) => ({
      ...current,
      groups: current.groups.map((group) => group.id === groupId ? { ...group, id: nextGroupId } : group),
      default: current.default.startsWith(`${groupId}/`)
        ? `${nextGroupId}/${current.default.slice(groupId.length + 1)}`
        : current.default,
    }));
    setSelectedPanel((prev) => {
      if (prev.type === "group" && prev.groupId === groupId) return { type: "group", groupId: nextGroupId };
      if (prev.type === "model" && prev.groupId === groupId) return { ...prev, groupId: nextGroupId };
      return prev;
    });
    setAdvancedText((current) => {
      if (!(groupId in current) || groupId === nextGroupId) return current;
      const { [groupId]: oldValue, ...rest } = current;
      return { ...rest, [nextGroupId]: oldValue };
    });
  }, [updateModels]);

  const updateModel = useCallback((groupId: string, modelId: string, patch: Partial<EditableModel>) => {
    updateModels((current) => ({
      ...current,
      groups: current.groups.map((group) => group.id === groupId
        ? { ...group, models: group.models.map((model) => model.id === modelId ? { ...model, ...patch } : model) }
        : group),
    }));
  }, [updateModels]);

  const updateModelId = useCallback((groupId: string, modelId: string, nextModelId: string) => {
    updateModels((current) => ({
      ...current,
      groups: current.groups.map((group) => group.id === groupId
        ? { ...group, models: group.models.map((model) => model.id === modelId ? { ...model, id: nextModelId } : model) }
        : group),
      default: current.default === `${groupId}/${modelId}` ? `${groupId}/${nextModelId}` : current.default,
    }));
    setSelectedPanel((prev) => (
      prev.type === "model" && prev.groupId === groupId && prev.modelId === modelId
        ? { ...prev, modelId: nextModelId }
        : prev
    ));
    setAdvancedText((current) => {
      const groupText = current[groupId];
      if (!groupText || modelId === nextModelId) return current;
      const { [modelId]: oldExtraBody, ...restExtraBody } = groupText.modelExtraBody;
      const { [modelId]: oldThinking, ...restThinking } = groupText.modelThinking;
      return {
        ...current,
        [groupId]: {
          ...groupText,
          modelExtraBody: oldExtraBody === undefined ? restExtraBody : { ...restExtraBody, [nextModelId]: oldExtraBody },
          modelThinking: oldThinking === undefined ? restThinking : { ...restThinking, [nextModelId]: oldThinking },
        },
      };
    });
  }, [updateModels]);

  const addGroup = useCallback(() => {
    const id = `group-${Date.now().toString(36)}`;
    updateModels((current) => ({ ...current, groups: [...current.groups, { ...emptyGroup(), id, name: "新模型分组" }] }));
    setSelectedPanel({ type: "group", groupId: id });
  }, [updateModels]);

  const removeGroup = useCallback((groupId: string) => {
    updateModels((current) => {
      if (current.groups.length <= 1) return current;
      const groups = current.groups.filter((group) => group.id !== groupId);
      const defaultStillExists = groups.some((group) => group.models.some((model) => `${group.id}/${model.id}` === current.default));
      return { ...current, groups, default: defaultStillExists ? current.default : `${groups[0]!.id}/${groups[0]!.models[0]!.id}` };
    });
    setSelectedPanel((prev) => prev.type !== "general" && prev.groupId === groupId ? { type: "general" } : prev);
  }, [updateModels]);

  const addModel = useCallback((groupId: string) => {
    const id = `model-${Date.now().toString(36)}`;
    updateModels((current) => ({
      ...current,
      groups: current.groups.map((group) => group.id === groupId
        ? { ...group, models: [...group.models, { ...emptyModel(), id, name: "新模型" }] }
        : group),
    }));
    setSelectedPanel({ type: "model", groupId, modelId: id });
  }, [updateModels]);

  const removeModel = useCallback((groupId: string, modelId: string) => {
    updateModels((current) => {
      const groups = current.groups.map((group) => {
        if (group.id !== groupId || group.models.length <= 1) return group;
        return { ...group, models: group.models.filter((model) => model.id !== modelId) };
      });
      const defaultStillExists = groups.some((group) => group.models.some((model) => `${group.id}/${model.id}` === current.default));
      const firstModel = groups.flatMap((group) => group.models.map((model) => `${group.id}/${model.id}`))[0];
      return { ...current, groups, default: defaultStillExists ? current.default : (firstModel ?? current.default) };
    });
    setSelectedPanel((prev) => (
      prev.type === "model" && prev.groupId === groupId && prev.modelId === modelId
        ? { type: "group", groupId }
        : prev
    ));
    setAdvancedText((current) => {
      const groupText = current[groupId];
      if (!groupText) return current;
      const { [modelId]: _oldExtraBody, ...modelExtraBody } = groupText.modelExtraBody;
      const { [modelId]: _oldThinking, ...modelThinking } = groupText.modelThinking;
      return { ...current, [groupId]: { ...groupText, modelExtraBody, modelThinking } };
    });
  }, [updateModels]);

  const buildPayload = useCallback((): { models: EditableModelsConfig; memoryIndex: EditableMemoryIndexConfig | null } => {
    if (!models) throw new Error("models 尚未加载");
    const nextModels = {
      ...models,
      groups: models.groups.map((group) => {
        const adv = advancedText[group.id];
        const nextGroup: EditableGroup = {
          ...group,
          protocol: group.protocol ?? DEFAULT_PROTOCOL,
          extraBody: parseOptionalJsonObject(adv?.groupExtraBody ?? "", `${group.name || group.id}.extraBody`),
          thinking: parseOptionalJson(adv?.groupThinking ?? ""),
          models: group.models.map((model) => ({
            ...model,
            extraBody: parseOptionalJsonObject(adv?.modelExtraBody[model.id] ?? "", `${group.name || group.id}/${model.name || model.id}.extraBody`),
            thinking: parseOptionalJson(adv?.modelThinking[model.id] ?? ""),
          })),
        };
        if (!nextGroup.apiKey) delete nextGroup.apiKey;
        if (!nextGroup.baseUrl) delete nextGroup.baseUrl;
        if (!nextGroup.disable_response_chaining) delete nextGroup.disable_response_chaining;
        if (!nextGroup.disable_prompt_cache_key) delete nextGroup.disable_prompt_cache_key;
        if (nextGroup.extraBody === undefined) delete nextGroup.extraBody;
        if (nextGroup.thinking === undefined) delete nextGroup.thinking;
        nextGroup.models = nextGroup.models.map((model) => {
          const nextModel = { ...model };
          if (!nextModel.value) nextModel.value = nextModel.id;
          nextModel.pricing = normalizePricing(nextModel.pricing);
          if (!nextModel.reasoning_effort) delete nextModel.reasoning_effort;
          if (nextModel.extraBody === undefined) delete nextModel.extraBody;
          if (nextModel.thinking === undefined) delete nextModel.thinking;
          return nextModel;
        });
        return nextGroup;
      }),
    };
    const nextMemoryIndex = memoryIndex
      ? {
          ...memoryIndex,
          embedding: {
            baseUrl: memoryIndex.embedding.baseUrl.trim(),
            apiKey: memoryIndex.embedding.apiKey.trim(),
            model: memoryIndex.embedding.model.trim(),
            dimensions: Number(memoryIndex.embedding.dimensions) || 0,
          },
        }
      : null;
    return { models: nextModels, memoryIndex: nextMemoryIndex };
  }, [advancedText, memoryIndex, models]);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const payload = buildPayload();
      const res = await authFetch("/api/admin/models", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => ({}))) as Partial<AdminModelsResponse> & { error?: string };
      if (!res.ok || !data.models) throw new Error(data.error || `HTTP ${res.status}`);
      setModels(data.models);
      setMemoryIndex(data.memoryIndex ?? null);
      hydrateAdvancedText(data.models);
      setSavedAt(Date.now());
      setError(null);
      await refreshAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [buildPayload, hydrateAdvancedText]);

  if (loading && !models) {
    return <div className="flex flex-1 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col">
      <SettingsPanelHeader
        title="模型管理"
        description="这里维护平台模型上下文、自动压缩触发线、成本价与模型解析配置；客户售价、积分倍率和组织毛利不在此处配置。"
        actions={(
          <>
            {savedAt && <Badge variant="secondary" className="gap-1"><CheckCircle2 className="h-3 w-3" />已保存</Badge>}
            <Button variant="outline" size="sm" onClick={() => refresh()} disabled={loading || saving}><RefreshCw className="mr-1.5 h-3.5 w-3.5" />刷新</Button>
            <Button size="sm" onClick={save} disabled={saving || !models}>{saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-1.5 h-3.5 w-3.5" />}保存并生效</Button>
          </>
        )}
      />

      <div className="min-h-0 flex-1 space-y-4 overflow-auto">
      {error && <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />{error}</div>}

      {models && (
        <SettingsTwoColumn
          sidebarWidth={280}
          sidebar={(
            <>
              <Card className="h-fit">
                <CardContent className="px-4 py-4">
                  <button
                    type="button"
                    onClick={() => setSelectedPanel({ type: "general" })}
                    className={cn(
                      "w-full rounded-lg border px-3 py-2 text-left text-sm transition-colors",
                      selectedPanel.type === "general" ? "border-primary bg-primary/10" : "hover:bg-muted/60",
                    )}
                  >
                    <div className="font-medium">通用设置</div>
                  </button>
                </CardContent>
              </Card>

              <Card className="h-fit">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 px-4 pb-3 pt-4">
                  <CardTitle className="text-base">模型分组</CardTitle>
                  <Button variant="ghost" size="sm" className="h-7 px-2" onClick={addGroup} aria-label="新增模型分组"><Plus className="h-3.5 w-3.5" /></Button>
                </CardHeader>
                <CardContent className="space-y-3 px-3 pb-4 pt-0">
                  {models.groups.map((group, groupIndex) => {
                    const groupSelected = selectedPanel.type === "group" && selectedPanel.groupId === group.id;
                    const groupActive = groupSelected || (selectedPanel.type === "model" && selectedPanel.groupId === group.id);
                    return (
                      <div
                        key={`${group.id || "group"}-${groupIndex}`}
                        className={cn(
                          "rounded-xl border p-2 transition-colors",
                          groupActive ? "border-primary/40 bg-primary/[0.03]" : "bg-card",
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => setSelectedPanel({ type: "group", groupId: group.id })}
                          className={cn(
                            "w-full rounded-lg px-2.5 py-2 text-left text-sm transition-colors",
                            groupSelected ? "bg-primary text-primary-foreground shadow-sm" : "hover:bg-muted/70",
                          )}
                        >
                          <span className="block min-w-0">
                            <span className="block truncate font-medium">{group.name || group.id || "未命名分组"}</span>
                            <span className={cn(
                              "mt-0.5 block truncate text-xs",
                              groupSelected ? "text-primary-foreground/75" : "text-muted-foreground",
                            )}>
                              {group.id || "未填写 id"} · {group.models.length} 个模型
                            </span>
                          </span>
                        </button>

                        <div className="ml-3 mt-2 border-l border-border/80 pl-3">
                          <button
                            type="button"
                            onClick={() => addModel(group.id)}
                            className="flex h-8 w-full items-center gap-2 rounded-md border border-primary/30 px-2.5 text-left text-xs font-medium text-primary transition-colors hover:border-primary/50 hover:bg-primary/10"
                          >
                            <Plus className="h-3.5 w-3.5" />
                            新增模型
                          </button>
                          <div className="mt-1.5 space-y-1">
                            {group.models.map((model, modelIndex) => {
                              const selected = selectedPanel.type === "model" && selectedPanel.groupId === group.id && selectedPanel.modelId === model.id;
                              return (
                                <button
                                  key={`${model.id || "model"}-${modelIndex}`}
                                  type="button"
                                  onClick={() => setSelectedPanel({ type: "model", groupId: group.id, modelId: model.id })}
                                  className={cn(
                                    "w-full rounded-md px-2.5 py-2 text-left text-xs transition-colors",
                                    selected ? "bg-primary/10 text-primary ring-1 ring-primary/20" : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
                                  )}
                                >
                                  <span className="block min-w-0">
                                    <span className={cn("block truncate", selected && "font-medium")}>{model.name || model.id || "未命名模型"}</span>
                                    <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">{model.value || model.id || "未填写 value"}</span>
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </CardContent>
              </Card>
            </>
          )}
        >
          {selectedPanel.type === "general" && (
            <>
              <Card className="h-fit">
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-1.5 text-base">
                    通用设置
                    <DescriptionTip description="这些设置作用于整个模型配置，而不是某个单独分组。" />
                  </CardTitle>
                </CardHeader>
                <CardContent className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label>全局默认模型</Label>
                    <select className="h-9 w-full rounded-md border bg-card px-3 text-sm" value={models.default} onChange={(e) => updateModels((current) => ({ ...current, default: e.target.value }))}>
                      {models.groups.flatMap((group) => group.models.map((model) => <option key={`${group.id}/${model.id}`} value={`${group.id}/${model.id}`}>{group.name}/{model.name}</option>))}
                    </select>
                    <p className="text-xs text-muted-foreground">新会话与失效模型回退时使用的默认模型。</p>
                  </div>
                  <div className="space-y-1.5">
                    <Label>图片理解兜底模型</Label>
                    <select
                      className="h-9 w-full rounded-md border bg-card px-3 text-sm"
                      value={models.imageUnderstanding?.model ?? ""}
                      onChange={(e) => updateModels((current) => ({
                        ...current,
                        imageUnderstanding: e.target.value
                          ? { ...(current.imageUnderstanding ?? { model: e.target.value }), model: e.target.value }
                          : undefined,
                      }))}
                    >
                      <option value="">未配置（text-only 模型只收到明确占位）</option>
                      {models.groups.flatMap((group) => group.models.map((model) => (
                        <option key={`${group.id}/${model.id}`} value={`${group.id}/${model.id}`}>{group.name}/{model.name}</option>
                      )))}
                    </select>
                    <p className="text-xs text-muted-foreground">主模型未声明 image 输入时，由该模型先看图并生成带来源标记的视觉摘要。</p>
                  </div>
                  {models.imageUnderstanding && (
                    <>
                      <div className="space-y-1.5">
                        <Label>图片理解 fallback 模型</Label>
                        <Input
                          placeholder="group/model, group/backup-model"
                          value={(models.imageUnderstanding.fallbackModels ?? []).join(", ")}
                          onChange={(e) => updateModels((current) => ({
                            ...current,
                            imageUnderstanding: current.imageUnderstanding
                              ? {
                                  ...current.imageUnderstanding,
                                  fallbackModels: e.target.value
                                    .split(",")
                                    .map((value) => value.trim())
                                    .filter(Boolean),
                                }
                              : undefined,
                          }))}
                        />
                        <p className="text-xs text-muted-foreground">可选；主图片理解模型失败后按顺序尝试，使用 group/model 引用并以逗号分隔。</p>
                      </div>
                      <div className="space-y-1.5">
                        <Label>图片理解超时（ms）</Label>
                        <Input
                          type="number"
                          min="1000"
                          max="120000"
                          step="1000"
                          placeholder="30000"
                          value={models.imageUnderstanding.timeoutMs ?? ""}
                          onChange={(e) => updateModels((current) => ({
                            ...current,
                            imageUnderstanding: current.imageUnderstanding
                              ? { ...current.imageUnderstanding, timeoutMs: e.target.value ? Number(e.target.value) : undefined }
                              : undefined,
                          }))}
                        />
                      </div>
                    </>
                  )}
                  <label className="flex items-start gap-2 text-sm md:col-span-2">
                    <input type="checkbox" className="mt-0.5" checked={models.allowCrossGroupSwitch} onChange={(e) => updateModels((current) => ({ ...current, allowCrossGroupSwitch: e.target.checked }))} />
                    <span>允许会话中跨分组切换模型</span>
                  </label>
                </CardContent>
              </Card>

              <Card className="h-fit">
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-1.5 text-base">
                    <Database className="h-4 w-4 text-muted-foreground" />
                    向量化模型 API
                    <DescriptionTip description="用于 memory.index 的 OpenAI-compatible /v1/embeddings 调用。" />
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {!memoryIndex ? (
                    <div className="rounded-md border border-dashed bg-muted/20 p-4">
                      <p className="text-sm text-muted-foreground">当前 config.json 未配置 memory.index。</p>
                      <Button className="mt-3" variant="outline" size="sm" onClick={() => { setMemoryIndex(defaultMemoryIndex()); setSavedAt(null); }}>
                        <Plus className="h-3.5 w-3.5" />
                        新增向量化 API 配置
                      </Button>
                    </div>
                  ) : (
                    <div className="grid gap-3 md:grid-cols-2">
                      <label className="flex items-start gap-2 text-sm md:col-span-2">
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          checked={memoryIndex.enabled === true}
                          onChange={(e) => updateMemoryIndex((current) => ({ ...current, enabled: e.target.checked }))}
                        />
                        <span>启用记忆向量索引</span>
                      </label>
                      <div className="space-y-1.5">
                        <Label>Base URL</Label>
                        <Input
                          value={memoryIndex.embedding.baseUrl}
                          onChange={(e) => updateMemoryEmbedding({ baseUrl: e.target.value })}
                          placeholder="https://dashscope.aliyuncs.com/compatible-mode"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label>API Key</Label>
                        <Input
                          type="password"
                          autoComplete="new-password"
                          passwordManager="ignore"
                          value={memoryIndex.embedding.apiKey}
                          onChange={(e) => updateMemoryEmbedding({ apiKey: e.target.value })}
                          placeholder="sk-..."
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label>Embedding Model</Label>
                        <Input
                          value={memoryIndex.embedding.model}
                          onChange={(e) => updateMemoryEmbedding({ model: e.target.value })}
                          placeholder="text-embedding-v3"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label>Dimensions</Label>
                        <Input
                          type="number"
                          min="1"
                          step="1"
                          value={memoryIndex.embedding.dimensions}
                          onChange={(e) => updateMemoryEmbedding({ dimensions: Number(e.target.value) })}
                        />
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            </>
          )}

          {selectedGroup && (
            <Card>
              <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-3">
                <div className="min-w-0">
                  <CardTitle className="text-base">分组配置</CardTitle>
                  <p className="mt-1 truncate text-xs text-muted-foreground">{selectedGroup.id || "未填写 id"} · {selectedGroup.models.length} 个模型</p>
                </div>
                <Button variant="ghost" size="sm" className="shrink-0 text-destructive hover:text-destructive" onClick={() => removeGroup(selectedGroup.id)} disabled={models.groups.length <= 1}><Trash2 className="mr-1 h-3.5 w-3.5" />删除分组</Button>
              </CardHeader>
              <CardContent className="grid gap-3 md:grid-cols-2">
                <div className="space-y-1.5"><Label>ID</Label><Input value={selectedGroup.id} onChange={(e) => updateGroupId(selectedGroup.id, e.target.value)} /></div>
                <div className="space-y-1.5"><Label>显示名称</Label><Input value={selectedGroup.name} onChange={(e) => updateGroup(selectedGroup.id, { name: e.target.value })} /></div>
                <div className="space-y-1.5"><Label>API Key</Label><Input type="password" autoComplete="new-password" passwordManager="ignore" value={selectedGroup.apiKey ?? ""} onChange={(e) => updateGroup(selectedGroup.id, { apiKey: e.target.value })} placeholder="同组模型共用，可留空" /></div>
                <div className="space-y-1.5"><Label>Base URL</Label><Input value={selectedGroup.baseUrl ?? ""} onChange={(e) => updateGroup(selectedGroup.id, { baseUrl: e.target.value })} placeholder="例如 http://127.0.0.1:8317" /></div>
                <div className="space-y-1.5">
                  <Label>协议类型 protocol</Label>
                  <select
                    className="h-9 w-full rounded-md border bg-card px-3 text-sm"
                    value={selectedGroup.protocol ?? DEFAULT_PROTOCOL}
                    onChange={(e) => updateGroup(selectedGroup.id, { protocol: e.target.value as ModelProtocol })}
                  >
                    <option value="chat_completions">chat_completions</option>
                    <option value="responses">responses</option>
                  </select>
                  <p className="text-xs text-muted-foreground">分组内未覆盖的模型将使用该协议。</p>
                </div>
                <div className="space-y-1.5">
                  <Label>思考深度 reasoning_effort</Label>
                  <select
                    className="h-9 w-full rounded-md border bg-card px-3 text-sm"
                    value={selectedGroup.reasoning_effort ?? ""}
                    onChange={(e) => updateGroup(selectedGroup.id, { reasoning_effort: e.target.value || undefined })}
                  >
                    <option value="">不指定</option>
                    <option value="low">low</option>
                    <option value="medium">medium</option>
                    <option value="high">high</option>
                    <option value="xhigh">xhigh</option>
                    <option value="max">max</option>
                  </select>
                  <p className="text-xs text-muted-foreground">当前生效：{formatEffectiveValue(resolveGroupReasoningEffort(selectedGroup))}</p>
                </div>
                <label className="flex items-start gap-2 text-sm md:col-span-2"><input type="checkbox" className="mt-0.5" checked={!selectedGroup.disable_response_chaining} onChange={(e) => updateGroup(selectedGroup.id, { disable_response_chaining: e.target.checked ? undefined : true })} /><span>启用 Responses 有状态接力（previous_response_id）<span className="block text-xs text-muted-foreground">开启后会使用 previous_response_id 连接多轮 Responses 调用。适用于原生 Responses 服务，如火山等。无状态 OpenAI 兼容代理，例如 cli-proxy，请关闭，否则工具调用后可能报 "No tool call found for function call output"。</span></span></label>
                <label className="flex items-start gap-2 text-sm md:col-span-2"><input type="checkbox" className="mt-0.5" checked={!selectedGroup.disable_prompt_cache_key} onChange={(e) => updateGroup(selectedGroup.id, { disable_prompt_cache_key: e.target.checked ? undefined : true })} /><span>启用 prompt_cache_key 内容指纹（Chat Completions + Responses 通用）<span className="block text-xs text-muted-foreground">开启后以 sha256(model + system/instructions + tool 名单) 前 32 hex 作为 prompt_cache_key 传给上游，让相同前缀的请求命中同一缓存分片。07-04 实测 CLIProxyAPI 会为每次请求自动填新 UUID 覆盖 → 缓存永远打散，显式传稳定 key 后 cached_tokens 命中率 76%+。主流 OpenAI 兼容端点 silent ignore 未知字段，默认开启无害；仅在极少数「兼容层会拒绝该字段」的端点上关闭。</span></span></label>
                <label className="flex items-start gap-2 text-sm md:col-span-2"><input type="checkbox" className="mt-0.5" checked={selectedGroup.input_modalities?.includes("image") === true} onChange={(e) => updateGroup(selectedGroup.id, { input_modalities: e.target.checked ? ["text", "image"] : ["text"] })} /><span>分组模型支持图片输入<span className="block text-xs text-muted-foreground">只在已验证 provider 协议确实支持视觉时开启；模型可单独覆盖。</span></span></label>
                <div className="space-y-1.5"><Label>Group extraBody JSON</Label><Textarea className="min-h-28 font-mono text-xs" value={advancedText[selectedGroup.id]?.groupExtraBody ?? ""} onChange={(e) => setAdvancedText((current) => ({ ...current, [selectedGroup.id]: { ...(current[selectedGroup.id] ?? { modelExtraBody: {}, modelThinking: {}, groupExtraBody: "", groupThinking: "" }), groupExtraBody: e.target.value } }))} /></div>
                <div className="space-y-1.5"><Label>Group thinking JSON</Label><Textarea className="min-h-28 font-mono text-xs" value={advancedText[selectedGroup.id]?.groupThinking ?? ""} onChange={(e) => setAdvancedText((current) => ({ ...current, [selectedGroup.id]: { ...(current[selectedGroup.id] ?? { modelExtraBody: {}, modelThinking: {}, groupExtraBody: "", groupThinking: "" }), groupThinking: e.target.value } }))} /></div>
              </CardContent>
            </Card>
          )}

          {selectedModelContext && (
            <Card>
              <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-3">
                <div className="min-w-0">
                  <CardTitle className="text-base">模型配置</CardTitle>
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {selectedModelContext.group.name || selectedModelContext.group.id || "未命名分组"} / {selectedModelContext.model.id || "未填写 id"}
                  </p>
                </div>
                <Button variant="ghost" size="sm" className="shrink-0 text-destructive hover:text-destructive" onClick={() => removeModel(selectedModelContext.group.id, selectedModelContext.model.id)} disabled={selectedModelContext.group.models.length <= 1}><Trash2 className="mr-1 h-3.5 w-3.5" />删除模型</Button>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-3 md:grid-cols-3">
                  <div className="space-y-1.5"><Label>ID</Label><Input value={selectedModelContext.model.id} onChange={(e) => updateModelId(selectedModelContext.group.id, selectedModelContext.model.id, e.target.value)} /></div>
                  <div className="space-y-1.5"><Label>显示名称</Label><Input value={selectedModelContext.model.name} onChange={(e) => updateModel(selectedModelContext.group.id, selectedModelContext.model.id, { name: e.target.value })} /></div>
                  <div className="space-y-1.5"><Label>真实模型值 value</Label><Input value={selectedModelContext.model.value} onChange={(e) => updateModel(selectedModelContext.group.id, selectedModelContext.model.id, { value: e.target.value })} /></div>
                  <div className="space-y-1.5">
                    <Label>思考深度 reasoning_effort</Label>
                    <select
                      className="h-9 w-full rounded-md border bg-card px-3 text-sm"
                      value={selectedModelContext.model.reasoning_effort ?? ""}
                      onChange={(e) => updateModel(selectedModelContext.group.id, selectedModelContext.model.id, { reasoning_effort: e.target.value || undefined })}
                    >
                      <option value="">继承分组</option>
                      <option value="low">low</option>
                      <option value="medium">medium</option>
                      <option value="high">high</option>
                      <option value="xhigh">xhigh</option>
                      <option value="max">max</option>
                    </select>
                    <p className="text-xs text-muted-foreground">当前生效：{formatEffectiveValue(resolveModelReasoningEffort(selectedModelContext.group, selectedModelContext.model))}</p>
                  </div>
                  <div className="space-y-1.5">
                    <Label>协议类型 protocol</Label>
                    <select
                      className="h-9 w-full rounded-md border bg-card px-3 text-sm"
                      value={selectedModelContext.model.protocol ?? INHERIT_PROTOCOL}
                      onChange={(e) => updateModel(selectedModelContext.group.id, selectedModelContext.model.id, {
                        protocol: e.target.value === INHERIT_PROTOCOL ? undefined : e.target.value as ModelProtocol,
                      })}
                    >
                      <option value={INHERIT_PROTOCOL}>继承分组</option>
                      <option value="chat_completions">chat_completions</option>
                      <option value="responses">responses</option>
                    </select>
                    <p className="text-xs text-muted-foreground">当前生效：{resolveModelProtocol(selectedModelContext.group, selectedModelContext.model)}</p>
                  </div>
                  <div className="space-y-1.5"><Label>usage accounting</Label><select className="h-9 w-full rounded-md border bg-card px-3 text-sm" value={selectedModelContext.model.usage_accounting ?? ""} onChange={(e) => updateModel(selectedModelContext.group.id, selectedModelContext.model.id, { usage_accounting: e.target.value ? e.target.value as EditableModel["usage_accounting"] : undefined })}><option value="">auto / inferred</option><option value="input_includes_cache">input includes cache</option><option value="cache_tokens_separate">cache tokens separate</option></select><p className="text-xs text-muted-foreground">auto: claude-* uses separate cache tokens; other models treat cached tokens as part of input.</p></div>
                  <div className="space-y-1.5">
                    <Label>图片输入能力</Label>
                    <select
                      className="h-9 w-full rounded-md border bg-card px-3 text-sm"
                      value={selectedModelContext.model.input_modalities === undefined ? "inherit" : (selectedModelContext.model.input_modalities.includes("image") ? "image" : "text")}
                      onChange={(e) => updateModel(selectedModelContext.group.id, selectedModelContext.model.id, {
                        input_modalities: e.target.value === "inherit" ? undefined : (e.target.value === "image" ? ["text", "image"] : ["text"]),
                      })}
                    >
                      <option value="inherit">继承分组</option>
                      <option value="image">text + image</option>
                      <option value="text">仅 text</option>
                    </select>
                    <p className="text-xs text-muted-foreground">当前生效：{resolveModelImageInput(selectedModelContext.group, selectedModelContext.model) ? "text + image" : "仅 text / unknown"}</p>
                  </div>
                </div>

                <div className="rounded-md border bg-muted/20 p-3">
                  <div className="mb-3">
                    <Label>上下文与自动压缩</Label>
                    <p className="text-xs text-muted-foreground">
                      租户开启自动压缩后，当前上下文达到该模型触发线时，会在本回合结束后自动压缩。未配置窗口的模型不会自动压缩。
                    </p>
                  </div>
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label>上下文窗口（tokens）</Label>
                      <Input
                        type="number"
                        min="1"
                        step="1000"
                        placeholder="例如 128000"
                        value={selectedModelContext.model.context_window ?? ""}
                        onChange={(e) => updateModel(selectedModelContext.group.id, selectedModelContext.model.id, {
                          context_window: e.target.value === "" ? undefined : Number(e.target.value),
                        })}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>自动压缩触发比例（%）</Label>
                      <Input
                        type="number"
                        min="1"
                        max="99"
                        step="0.1"
                        placeholder="80"
                        value={selectedModelContext.model.auto_compact_threshold == null
                          ? ""
                          : selectedModelContext.model.auto_compact_threshold * 100}
                        onChange={(e) => updateModel(selectedModelContext.group.id, selectedModelContext.model.id, {
                          auto_compact_threshold: e.target.value === "" ? undefined : Number(e.target.value) / 100,
                        })}
                      />
                      <p className="text-xs text-muted-foreground">留空使用平台默认值 80%。</p>
                    </div>
                  </div>
                  {selectedModelContext.model.context_window != null && selectedModelContext.model.context_window > 0 && (
                    <p className="mt-3 text-xs text-muted-foreground">
                      当前实际触发线：
                      <span className="font-medium text-foreground">
                        {Math.floor(
                          selectedModelContext.model.context_window
                          * (selectedModelContext.model.auto_compact_threshold ?? 0.8),
                        ).toLocaleString()} tokens
                      </span>
                      （{((selectedModelContext.model.auto_compact_threshold ?? 0.8) * 100).toFixed(1)}%）
                    </p>
                  )}
                </div>

                <div className="rounded-md border bg-muted/20 p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div>
                      <Label>平台模型成本价（USD / 1M tokens）</Label>
                      <p className="text-xs text-muted-foreground">
                        仅用于平台成本统计，不是客户售价或积分倍率。留空表示继续使用内置成本价，未知模型 cost=0。
                      </p>
                    </div>
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={!!selectedModelContext.model.pricing}
                        onChange={(e) => updateModel(selectedModelContext.group.id, selectedModelContext.model.id, { pricing: e.target.checked ? (selectedModelContext.model.pricing ?? emptyPricing()) : undefined })}
                      />
                      自定义单价
                    </label>
                  </div>
                  {selectedModelContext.model.pricing && (
                    <div className="grid gap-3 md:grid-cols-4">
                      {([
                        ["input", "Input"],
                        ["output", "Output"],
                        ["cacheCreation", "Cache write"],
                        ["cacheRead", "Cache read"],
                      ] as const).map(([key, label]) => (
                        <div key={key} className="space-y-1.5">
                          <Label>{label}</Label>
                          <Input
                            type="number"
                            min="0"
                            step="0.001"
                            value={selectedModelContext.model.pricing?.[key] ?? 0}
                            onChange={(e) => updateModel(selectedModelContext.group.id, selectedModelContext.model.id, {
                              pricing: { ...(selectedModelContext.model.pricing ?? emptyPricing()), [key]: Number(e.target.value) },
                            })}
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-1.5"><Label>Model extraBody JSON</Label><Textarea className="min-h-24 font-mono text-xs" value={advancedText[selectedModelContext.group.id]?.modelExtraBody[selectedModelContext.model.id] ?? ""} onChange={(e) => setAdvancedText((current) => ({ ...current, [selectedModelContext.group.id]: { ...(current[selectedModelContext.group.id] ?? { groupExtraBody: "", groupThinking: "", modelExtraBody: {}, modelThinking: {} }), modelExtraBody: { ...(current[selectedModelContext.group.id]?.modelExtraBody ?? {}), [selectedModelContext.model.id]: e.target.value } } }))} /></div>
                  <div className="space-y-1.5"><Label>Model thinking JSON</Label><Textarea className="min-h-24 font-mono text-xs" value={advancedText[selectedModelContext.group.id]?.modelThinking[selectedModelContext.model.id] ?? ""} onChange={(e) => setAdvancedText((current) => ({ ...current, [selectedModelContext.group.id]: { ...(current[selectedModelContext.group.id] ?? { groupExtraBody: "", groupThinking: "", modelExtraBody: {}, modelThinking: {} }), modelThinking: { ...(current[selectedModelContext.group.id]?.modelThinking ?? {}), [selectedModelContext.model.id]: e.target.value } } }))} /></div>
                </div>
              </CardContent>
            </Card>
          )}
        </SettingsTwoColumn>
      )}
      </div>
    </div>
  );
}

import { useCallback, useEffect, useState } from "react";
import { CircleAlert, CircleCheck, ImageIcon, KeyRound, Loader2, RefreshCw, Save } from "lucide-react";
import { authFetch } from "@/lib/authFetch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

type EngineKey = "gptImage2" | "seedream";

interface ImageGenEngineConfigView {
  enabled?: boolean;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  apiKeyConfigured: boolean;
}

interface ImageGenConfigView {
  enabled: boolean;
  gptImage2: ImageGenEngineConfigView | null;
  seedream: ImageGenEngineConfigView | null;
}

interface ImageGenConfigResponse {
  config: ImageGenConfigView;
  error?: string;
}

interface EngineDraft {
  enabled: boolean;
  baseUrl: string;
  model: string;
  timeoutMs: string;
  apiKey: string;
  apiKeyConfigured: boolean;
}

interface ImageGenDraft {
  enabled: boolean;
  gptImage2: EngineDraft;
  seedream: EngineDraft;
}

const ENGINE_DEFAULTS: Record<EngineKey, Omit<EngineDraft, "apiKey" | "apiKeyConfigured">> = {
  gptImage2: {
    enabled: false,
    baseUrl: "https://llm.kaiyan.net/v1",
    model: "gpt-image-2",
    timeoutMs: "180000",
  },
  seedream: {
    enabled: false,
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    model: "doubao-seedream-5-0-lite-260128",
    timeoutMs: "180000",
  },
};

const ENGINE_LABELS: Record<EngineKey, { title: string; description: string }> = {
  gptImage2: {
    title: "GPT Image 2",
    description: "经 llm.kaiyan.net 订阅池调用；平台内串行并带退避重试。",
  },
  seedream: {
    title: "Seedream 5.0 Lite",
    description: "火山方舟按张计费接口；支持文生图和参考图。",
  },
};

function hydrateEngine(key: EngineKey, value: ImageGenEngineConfigView | null): EngineDraft {
  const defaults = ENGINE_DEFAULTS[key];
  return {
    enabled: value?.enabled ?? defaults.enabled,
    baseUrl: value?.baseUrl ?? defaults.baseUrl,
    model: value?.model ?? defaults.model,
    timeoutMs: value?.timeoutMs ? String(value.timeoutMs) : defaults.timeoutMs,
    apiKey: "",
    apiKeyConfigured: value?.apiKeyConfigured ?? false,
  };
}

function hydrateDraft(config: ImageGenConfigView): ImageGenDraft {
  return {
    enabled: config.enabled,
    gptImage2: hydrateEngine("gptImage2", config.gptImage2),
    seedream: hydrateEngine("seedream", config.seedream),
  };
}

function buildEnginePayload(key: EngineKey, draft: EngineDraft, platformEnabled: boolean) {
  const timeoutMs = Number(draft.timeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) {
    throw new Error(`${ENGINE_LABELS[key].title} Timeout 必须是 1 到 600000 之间的整数`);
  }
  if (draft.enabled && platformEnabled) {
    if (!draft.baseUrl.trim()) throw new Error(`${ENGINE_LABELS[key].title} Base URL 不能为空`);
    if (!draft.model.trim()) throw new Error(`${ENGINE_LABELS[key].title} 模型 ID 不能为空`);
    if (!draft.apiKeyConfigured && !draft.apiKey.trim()) {
      throw new Error(`${ENGINE_LABELS[key].title} 启用前必须填写 API Key`);
    }
  }
  return {
    enabled: draft.enabled,
    baseUrl: draft.baseUrl.trim(),
    model: draft.model.trim(),
    timeoutMs,
    ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
  };
}

export function ImageGenSettingsCard() {
  const [draft, setDraft] = useState<ImageGenDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hydrate = useCallback((body: ImageGenConfigResponse) => {
    setDraft(hydrateDraft(body.config));
    setDirty(false);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await authFetch("/api/admin/image-gen-pricing");
      const body = await response.json().catch(() => ({})) as Partial<ImageGenConfigResponse>;
      if (!response.ok || !body.config) throw new Error(body.error || `HTTP ${response.status}`);
      hydrate(body as ImageGenConfigResponse);
      setSaved(false);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [hydrate]);

  useEffect(() => { void refresh(); }, [refresh]);

  const markDirty = useCallback(() => {
    setDirty(true);
    setSaved(false);
    setError(null);
  }, []);

  const updateEngine = useCallback((key: EngineKey, patch: Partial<EngineDraft>) => {
    setDraft((current) => current ? {
      ...current,
      [key]: { ...current[key], ...patch },
    } : current);
    markDirty();
  }, [markDirty]);

  const save = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const response = await authFetch("/api/admin/image-gen-pricing/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          config: {
            enabled: draft.enabled,
            gptImage2: buildEnginePayload("gptImage2", draft.gptImage2, draft.enabled),
            seedream: buildEnginePayload("seedream", draft.seedream, draft.enabled),
          },
        }),
      });
      const body = await response.json().catch(() => ({})) as Partial<ImageGenConfigResponse>;
      if (!response.ok || !body.config) throw new Error(body.error || `HTTP ${response.status}`);
      hydrate(body as ImageGenConfigResponse);
      setSaved(true);
      setError(null);
      window.dispatchEvent(new Event("image-gen-config-updated"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [draft, hydrate]);

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 pb-3">
        <CardTitle className="flex items-center gap-2 text-base"><ImageIcon className="size-4" />AI 生图引擎（GenerateImage）</CardTitle>
        <div className="flex items-center gap-2">
          {dirty && <Badge variant="outline">有未保存更改</Badge>}
          {saved && !dirty && <Badge variant="secondary" className="gap-1"><CircleCheck className="size-3" />已保存并热生效</Badge>}
          <Button variant="outline" size="sm" onClick={() => { void refresh(); }} disabled={loading || saving}>
            <RefreshCw className="size-3.5" />刷新
          </Button>
          <Button size="sm" onClick={() => { void save(); }} disabled={saving || !dirty || !draft}>
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}保存引擎配置
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          API Key 保存到 SecretVault，页面和 config.json 都不显示明文；留空表示保留现有密钥。保存后只影响后续生图调用，无需重启服务。
        </p>

        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            <CircleAlert className="mt-0.5 size-4 shrink-0" /><span className="break-all">{error}</span>
          </div>
        )}

        {loading && !draft ? (
          <div className="flex items-center justify-center py-8 text-sm text-muted-foreground"><Loader2 className="mr-2 size-4 animate-spin" />加载引擎配置…</div>
        ) : draft ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
              <div>
                <Label className="text-sm font-medium">启用平台生图能力</Label>
                <p className="mt-1 text-xs text-muted-foreground">总开关；租户仍需在租户管理中单独授权。</p>
              </div>
              <Switch
                checked={draft.enabled}
                onCheckedChange={(checked) => { setDraft((current) => current ? { ...current, enabled: checked } : current); markDirty(); }}
                aria-label="启用平台生图能力"
              />
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              {(["gptImage2", "seedream"] as const).map((key) => {
                const engine = draft[key];
                const labels = ENGINE_LABELS[key];
                return (
                  <div key={key} className="space-y-4 rounded-lg border p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <Label className="text-sm font-medium">{labels.title}</Label>
                          <Badge variant={engine.apiKeyConfigured ? "secondary" : "outline"} className="gap-1">
                            <KeyRound className="size-3" />{engine.apiKeyConfigured ? "密钥已配置" : "密钥未配置"}
                          </Badge>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">{labels.description}</p>
                      </div>
                      <Switch
                        checked={engine.enabled}
                        disabled={!draft.enabled}
                        onCheckedChange={(checked) => updateEngine(key, { enabled: checked })}
                        aria-label={`启用 ${labels.title}`}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={`image-gen-${key}-base-url`}>Base URL</Label>
                      <Input id={`image-gen-${key}-base-url`} value={engine.baseUrl} onChange={(event) => updateEngine(key, { baseUrl: event.target.value })} />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={`image-gen-${key}-model`}>模型 ID</Label>
                      <Input id={`image-gen-${key}-model`} value={engine.model} onChange={(event) => updateEngine(key, { model: event.target.value })} />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={`image-gen-${key}-timeout`}>Timeout ms</Label>
                      <Input id={`image-gen-${key}-timeout`} type="number" min={1} max={600_000} value={engine.timeoutMs} onChange={(event) => updateEngine(key, { timeoutMs: event.target.value })} />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={`image-gen-${key}-api-key`}>API Key</Label>
                      <Input
                        id={`image-gen-${key}-api-key`}
                        type="password"
                        autoComplete="new-password"
                        passwordManager="ignore"
                        value={engine.apiKey}
                        onChange={(event) => updateEngine(key, { apiKey: event.target.value })}
                        placeholder={engine.apiKeyConfigured ? "留空保留现有密钥；填写则替换" : "请输入 API Key"}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

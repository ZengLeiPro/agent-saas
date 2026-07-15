import { useCallback, useEffect, useState } from "react";
import { CircleAlert, CircleCheck, ImageIcon, Loader2, RefreshCw, Save } from "lucide-react";
import { authFetch } from "@/lib/authFetch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * GenerateImage per-engine 生图定价卡片（2026-07-15 批次）。
 *
 * 挂载在平台管理「工具开关」页（ToolControlsManager），跟随该页既有信息架构：
 * per-tool 运行参数（WebSearch 参数 / WebFetch 参数）与工具开关同页维护。
 * 后端 API = GET/PUT /api/admin/image-gen-pricing（requirePlatformAdmin，
 * jsonc 回写 config.json + 注册表热更即时生效）。
 *
 * 定价 PUT 与 tool-controls PUT 是两个独立端点，故本卡片独立保存/刷新，
 * 避免一次保存里两个端点半成功导致状态混乱。
 */

export interface ImageGenEnginePricing {
  /** 每张图扣多少积分（面值口径，1 积分 = 0.01 元）。 */
  creditsPerImage: number;
  /** 每张图真实成本参考（元），仅供毛利审计，不参与应收计算。 */
  costYuanPerImage: number;
}

export type ImageGenPricingTable = Record<string, ImageGenEnginePricing>;

export interface ImageGenPlatformStatus {
  available: boolean;
  platformEnabled: boolean;
  toolEnabled: boolean;
  configuredEngines: string[];
}

export interface ImageGenPricingAdminResponse {
  /** 生效视图：管理员覆盖合并到内置默认（扣费实际使用的表）。 */
  pricing: ImageGenPricingTable;
  /** 管理员显式配置（null = 全部走内置默认）。 */
  configured: ImageGenPricingTable | null;
  /** 内置默认表。 */
  defaults: ImageGenPricingTable;
  /** 平台运行态摘要，不含任何凭据。 */
  status?: ImageGenPlatformStatus;
}

/** 已知引擎的展示名；其余引擎 key 原样展示（不硬编码只认两个）。 */
const ENGINE_LABELS: Record<string, string> = {
  "gpt-image-2": "GPT Image 2",
  "seedream": "Seedream（火山方舟）",
};

interface EngineDraft {
  /** 是否管理员覆盖（对应 configured 里有无该引擎条目）。 */
  overridden: boolean;
  creditsPerImage: string;
  costYuanPerImage: string;
}

type DraftTable = Record<string, EngineDraft>;

function listEngines(data: ImageGenPricingAdminResponse): string[] {
  return Array.from(new Set([
    ...Object.keys(data.defaults ?? {}),
    ...Object.keys(data.configured ?? {}),
    ...Object.keys(data.pricing ?? {}),
  ])).sort();
}

function hydrateDrafts(data: ImageGenPricingAdminResponse): DraftTable {
  const drafts: DraftTable = {};
  for (const engine of listEngines(data)) {
    const effective = data.pricing?.[engine] ?? data.configured?.[engine] ?? data.defaults?.[engine];
    drafts[engine] = {
      overridden: !!data.configured?.[engine],
      creditsPerImage: effective ? String(effective.creditsPerImage) : "",
      costYuanPerImage: effective ? String(effective.costYuanPerImage) : "",
    };
  }
  return drafts;
}

/** 本地校验 + 组 PUT payload：只提交勾选「自定义定价」的引擎；全不勾选 = null（整表回退内置默认）。 */
function buildPricingPayload(drafts: DraftTable): ImageGenPricingTable | null {
  const table: ImageGenPricingTable = {};
  const errors: string[] = [];
  for (const [engine, draft] of Object.entries(drafts)) {
    if (!draft.overridden) continue;
    const credits = Number(draft.creditsPerImage);
    const cost = Number(draft.costYuanPerImage);
    if (draft.creditsPerImage.trim() === "" || !Number.isFinite(credits) || credits <= 0) {
      errors.push(`${engine}.creditsPerImage 必须填写为大于 0 的数字`);
    }
    if (draft.costYuanPerImage.trim() === "" || !Number.isFinite(cost) || cost < 0) {
      errors.push(`${engine}.costYuanPerImage 必须填写为不小于 0 的数字`);
    }
    table[engine] = { creditsPerImage: credits, costYuanPerImage: cost };
  }
  if (errors.length > 0) throw new Error(errors.join("；"));
  return Object.keys(table).length > 0 ? table : null;
}

function formatPricing(entry: ImageGenEnginePricing | undefined): string {
  if (!entry) return "未配置";
  return `${entry.creditsPerImage} 积分/张 · 成本参考 ¥${entry.costYuanPerImage}/张`;
}

export function ImageGenPricingCard() {
  const [data, setData] = useState<ImageGenPricingAdminResponse | null>(null);
  const [drafts, setDrafts] = useState<DraftTable>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const hydrate = useCallback((next: ImageGenPricingAdminResponse) => {
    setData(next);
    setDrafts(hydrateDrafts(next));
    setDirty(false);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authFetch("/api/admin/image-gen-pricing");
      const body = (await res.json().catch(() => ({}))) as Partial<ImageGenPricingAdminResponse> & { error?: string };
      if (!res.ok || !body.pricing) throw new Error(body.error || `HTTP ${res.status}`);
      hydrate(body as ImageGenPricingAdminResponse);
      setSavedAt(null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [hydrate]);

  useEffect(() => {
    void refresh();
    const onConfigUpdated = () => { void refresh(); };
    window.addEventListener("image-gen-config-updated", onConfigUpdated);
    return () => window.removeEventListener("image-gen-config-updated", onConfigUpdated);
  }, [refresh]);

  const updateDraft = useCallback((engine: string, patch: Partial<EngineDraft>) => {
    setDrafts((current) => ({
      ...current,
      [engine]: { ...(current[engine] ?? { overridden: false, creditsPerImage: "", costYuanPerImage: "" }), ...patch },
    }));
    setDirty(true);
    setSavedAt(null);
    setError(null);
  }, []);

  const toggleOverride = useCallback((engine: string, checked: boolean) => {
    // 勾选时若输入为空，用默认值预填，减少必填校验摩擦。
    const fallback = data?.defaults?.[engine];
    setDrafts((current) => {
      const draft = current[engine] ?? { overridden: false, creditsPerImage: "", costYuanPerImage: "" };
      return {
        ...current,
        [engine]: {
          ...draft,
          overridden: checked,
          creditsPerImage: checked && draft.creditsPerImage.trim() === "" && fallback ? String(fallback.creditsPerImage) : draft.creditsPerImage,
          costYuanPerImage: checked && draft.costYuanPerImage.trim() === "" && fallback ? String(fallback.costYuanPerImage) : draft.costYuanPerImage,
        },
      };
    });
    setDirty(true);
    setSavedAt(null);
    setError(null);
  }, [data]);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const pricing = buildPricingPayload(drafts);
      const res = await authFetch("/api/admin/image-gen-pricing", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pricing }),
      });
      const body = (await res.json().catch(() => ({}))) as Partial<ImageGenPricingAdminResponse> & { error?: string };
      if (!res.ok || !body.pricing) throw new Error(body.error || `HTTP ${res.status}`);
      hydrate(body as ImageGenPricingAdminResponse);
      setSavedAt(Date.now());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [drafts, hydrate]);

  const engines = data ? listEngines(data) : [];

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 pb-3">
        <CardTitle className="flex items-center gap-2 text-base"><ImageIcon className="size-4" />AI 生图定价（GenerateImage）</CardTitle>
        <div className="flex items-center gap-2">
          {dirty && <Badge variant="outline">有未保存更改</Badge>}
          {savedAt && !dirty && <Badge variant="secondary" className="gap-1"><CircleCheck className="size-3" />已保存并热生效</Badge>}
          <Button variant="outline" size="sm" onClick={() => { void refresh(); }} disabled={loading || saving}>
            <RefreshCw className="size-3.5" />
            刷新
          </Button>
          <Button size="sm" onClick={() => { void save(); }} disabled={saving || !dirty}>
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
            保存定价
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          按引擎配置每张图扣多少积分（面值口径，1 积分 = 0.01 元）；真实成本参考仅用于平台毛利审计，不参与客户应收。
          本卡片独立保存：保存后立即对新的生图调用生效，无需重启。未勾选「自定义定价」的引擎使用内置默认值。
        </p>

        {data?.status && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border p-3 text-xs text-muted-foreground">
            <Badge variant={data.status.available ? "secondary" : "outline"}>
              {data.status.available ? "平台生图可用" : "平台生图未就绪"}
            </Badge>
            {!data.status.platformEnabled && <Badge variant="outline">引擎配置未启用</Badge>}
            {!data.status.toolEnabled && <Badge variant="outline">全局工具已关闭</Badge>}
            <span>
              已配置引擎：{data.status.configuredEngines.length > 0 ? data.status.configuredEngines.join("、") : "无"}
            </span>
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            <CircleAlert className="mt-0.5 size-4 shrink-0" />
            <span className="break-all">{error}</span>
          </div>
        )}

        {loading && !data ? (
          <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" />加载生图定价...
          </div>
        ) : engines.length === 0 ? (
          <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">暂无生图引擎定价条目。</div>
        ) : (
          <div className="space-y-3">
            {engines.map((engine) => {
              const draft = drafts[engine] ?? { overridden: false, creditsPerImage: "", costYuanPerImage: "" };
              const defaultEntry = data?.defaults?.[engine];
              const effectiveEntry = data?.pricing?.[engine];
              const savedOverridden = !!data?.configured?.[engine];
              return (
                <div key={engine} className="rounded-lg border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="break-all font-mono text-sm font-medium">{engine}</span>
                        {ENGINE_LABELS[engine] && <span className="text-xs text-muted-foreground">{ENGINE_LABELS[engine]}</span>}
                        <Badge variant={savedOverridden ? "secondary" : "outline"}>{savedOverridden ? "已覆盖" : "内置默认"}</Badge>
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        当前生效：{formatPricing(effectiveEntry)}
                      </div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {defaultEntry
                          ? `内置默认：${formatPricing(defaultEntry)}`
                          : "无内置默认；取消自定义并保存后该引擎将无定价，生图调用会被拒绝。"}
                      </div>
                    </div>
                    <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={draft.overridden}
                        onChange={(event) => toggleOverride(engine, event.target.checked)}
                        aria-label={`自定义 ${engine} 定价`}
                      />
                      自定义定价
                    </label>
                  </div>
                  {draft.overridden && (
                    <div className="mt-3 grid gap-3 md:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label htmlFor={`image-gen-pricing-${engine}-credits`}>积分/张</Label>
                        <Input
                          id={`image-gen-pricing-${engine}-credits`}
                          type="number"
                          min={0}
                          step={1}
                          value={draft.creditsPerImage}
                          onChange={(event) => updateDraft(engine, { creditsPerImage: event.target.value })}
                          placeholder={defaultEntry ? String(defaultEntry.creditsPerImage) : "必填"}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor={`image-gen-pricing-${engine}-cost`}>真实成本参考（元/张）</Label>
                        <Input
                          id={`image-gen-pricing-${engine}-cost`}
                          type="number"
                          min={0}
                          step={0.01}
                          value={draft.costYuanPerImage}
                          onChange={(event) => updateDraft(engine, { costYuanPerImage: event.target.value })}
                          placeholder={defaultEntry ? String(defaultEntry.costYuanPerImage) : "必填"}
                        />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

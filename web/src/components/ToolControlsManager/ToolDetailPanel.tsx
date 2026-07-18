import { useMemo, useState } from "react";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Code2,
  FileText,
  Loader2,
  MessageCircleWarning,
  Save,
} from "lucide-react";

import type {
  ToolCatalogItem,
  ToolControlsConfig,
  ToolDescriptionOverride,
  ToolDescriptionOverrideMode,
  WebToolsConfig,
  WebToolsFetchConfig,
  WebToolsSearchConfig,
} from "@agent/shared";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/contexts/AuthContext";
import { ImageGenSettingsCard } from "@/components/ToolControlsManager/ImageGenSettingsCard";
import { ImageGenPricingCard } from "@/components/ToolControlsManager/ImageGenPricingCard";

/**
 * 详情页 props。
 *
 * 参数面板（Web/ImageGen）复用主组件里的 draft，因为它们属于 webTools 顶层，只能
 * 整包保存。description override / enabled 有独立的 saveSingle 通道（PUT /:toolId）。
 */
export interface ToolDetailPanelProps {
  tool: ToolCatalogItem;
  toolControls: ToolControlsConfig;
  webToolsDraft: WebToolsConfig;
  onToggleEnabled: (enabled: boolean) => void;
  // Web 参数 draft mutators（沿用主页原有的 updater 签名）
  updateSearch: (patch: Partial<WebToolsSearchConfig>) => void;
  updateFetch: (patch: Partial<WebToolsFetchConfig>) => void;
  updateWebTools: (updater: (current: WebToolsConfig) => WebToolsConfig) => void;
  // Web 参数文本框 draft（allowedContentTypes/allowedHosts/blockedHosts/apiKey）
  allowedContentTypesText: string;
  setAllowedContentTypesText: (value: string) => void;
  allowedHostsText: string;
  setAllowedHostsText: (value: string) => void;
  blockedHostsText: string;
  setBlockedHostsText: (value: string) => void;
  searchApiKeyText: string;
  setSearchApiKeyText: (value: string) => void;
  markDirty: () => void;
  onBack: () => void;
  // 单工具 PUT: description override + 状态刷新
  saveSingleTool: (
    toolId: string,
    payload: { enabled?: boolean; descriptionOverride?: ToolDescriptionOverride | null },
  ) => Promise<void>;
}

const RISK_META: Record<
  ToolCatalogItem["risk"],
  { label: string; variant: "outline" | "secondary" | "destructive" }
> = {
  safe: { label: "safe · 只读或自恢复", variant: "secondary" },
  workspace_write: { label: "workspace_write · 写工作区", variant: "outline" },
  dangerous: { label: "dangerous · 需审批", variant: "destructive" },
};

const APPROVAL_META: Record<ToolCatalogItem["approvalMode"], string> = {
  never: "无需审批",
  web: "需 Web 审批",
};

const SEARCH_PROVIDER_OPTIONS: Array<{
  value: NonNullable<WebToolsSearchConfig["provider"]>;
  label: string;
  keyRefPlaceholder: string;
  endpointPlaceholder: string;
}> = [
  {
    value: "volcengine",
    label: "火山豆包搜索 Custom版",
    keyRefPlaceholder: "volcengine-web-search-api-key",
    endpointPlaceholder: "https://open.feedcoopapi.com/search_api/web_search",
  },
  {
    value: "brave",
    label: "Brave Search",
    keyRefPlaceholder: "brave-search-api-key",
    endpointPlaceholder: "https://api.search.brave.com/res/v1/web/search",
  },
  {
    value: "tencent_wsa",
    label: "腾讯云联网搜索 WSA",
    keyRefPlaceholder: "tencent-wsa-api-key",
    endpointPlaceholder: "https://api.wsa.cloud.tencent.com/SearchPro",
  },
];

const DEFAULT_SEARCH: WebToolsSearchConfig = {
  enabled: true,
  provider: "volcengine",
  timeoutMs: 8_000,
  maxResults: 5,
};

const DEFAULT_FETCH: WebToolsFetchConfig = {
  enabled: true,
  timeoutMs: 10_000,
  maxBytes: 1_048_576,
  maxChars: 20_000,
  maxRedirects: 3,
};

function numberOrUndefined(value: string): number | undefined {
  if (value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * 详情页——按工具类型分派参数面板。
 * 未匹配到运行时参数的工具（大多数只读/存量工具）在第 3 段显示"无运行时参数可配"。
 */
export function ToolDetailPanel(props: ToolDetailPanelProps): JSX.Element {
  const { tool, onBack, onToggleEnabled } = props;
  const { platformReadOnly } = useAuth();

  const risk = RISK_META[tool.risk];

  // description override 独立 draft：进详情时初始化，保存后走 saveSingleTool 单端点。
  const [overrideMode, setOverrideMode] = useState<ToolDescriptionOverrideMode>(
    tool.descriptionOverride?.mode ?? "append",
  );
  const [overrideText, setOverrideText] = useState<string>(tool.descriptionOverride?.text ?? "");
  const [overrideSaving, setOverrideSaving] = useState(false);
  const [overrideError, setOverrideError] = useState<string | null>(null);
  const [overrideSavedAt, setOverrideSavedAt] = useState<number | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [schemaOpen, setSchemaOpen] = useState(false);
  const [descOpen, setDescOpen] = useState(true);

  const originalOverrideKey = useMemo(() => {
    if (!tool.descriptionOverride) return "";
    return `${tool.descriptionOverride.mode}::${tool.descriptionOverride.text}`;
  }, [tool.descriptionOverride]);

  const currentOverrideKey = `${overrideMode}::${overrideText}`;
  const overrideDirty = currentOverrideKey !== originalOverrideKey;
  const canClearOverride = !!tool.descriptionOverride;

  const doSaveOverride = async () => {
    setOverrideSaving(true);
    setOverrideError(null);
    try {
      const trimmed = overrideText.trim();
      await props.saveSingleTool(tool.id, {
        descriptionOverride: trimmed ? { mode: overrideMode, text: trimmed } : null,
      });
      setOverrideSavedAt(Date.now());
      setConfirmOpen(false);
    } catch (err) {
      setOverrideError(err instanceof Error ? err.message : String(err));
    } finally {
      setOverrideSaving(false);
    }
  };

  const doClearOverride = async () => {
    setOverrideSaving(true);
    setOverrideError(null);
    try {
      await props.saveSingleTool(tool.id, { descriptionOverride: null });
      setOverrideText("");
      setOverrideMode("append");
      setOverrideSavedAt(Date.now());
    } catch (err) {
      setOverrideError(err instanceof Error ? err.message : String(err));
    } finally {
      setOverrideSaving(false);
    }
  };

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col">
      <div className="flex items-center gap-3 border-b py-3">
        <Button variant="ghost" size="sm" onClick={onBack} className="gap-1">
          <ArrowLeft className="size-3.5" />
          返回工具列表
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="break-all font-mono text-base font-semibold">{tool.name}</span>
            <Badge variant={risk.variant}>{risk.label}</Badge>
            <Badge variant="outline">{APPROVAL_META[tool.approvalMode]}</Badge>
            {tool.descriptionOverride && <Badge variant="secondary">已覆盖描述</Badge>}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {tool.label}
            {tool.sourceModule ? <> · <span className="font-mono">{tool.sourceModule}</span></> : null}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">启用</span>
          <Switch
            checked={tool.enabled}
            disabled={platformReadOnly || props.toolControls.enabled === false}
            onCheckedChange={onToggleEnabled}
            aria-label={`启用 ${tool.name}`}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-auto py-4">
        {/* ═════ 第 1 段：技术契约（只读） ═════ */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <FileText className="size-4" />
              技术契约
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 md:grid-cols-4">
              <ReadonlyRow label="Category" value={tool.category} />
              <ReadonlyRow label="Risk" value={tool.risk} />
              <ReadonlyRow label="Approval" value={tool.approvalMode} />
              <ReadonlyRow label="Audit" value={tool.auditCategory} />
            </div>

            <div>
              <button
                type="button"
                onClick={() => setDescOpen((v) => !v)}
                className="flex w-full items-center justify-between rounded-lg border p-3 text-left hover:bg-muted"
              >
                <div className="flex items-center gap-2">
                  {descOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                  <span className="text-sm font-medium">发送给模型的 description</span>
                  {tool.descriptionOverride && <Badge variant="outline">override merged</Badge>}
                </div>
                <span className="text-xs text-muted-foreground">
                  {tool.effectiveDescription.length} 字
                </span>
              </button>
              {descOpen && (
                <div className="mt-2 max-h-64 overflow-auto rounded-lg border bg-muted/40 p-3 text-xs leading-relaxed">
                  {tool.effectiveDescription}
                </div>
              )}
            </div>

            <div>
              <button
                type="button"
                onClick={() => setSchemaOpen((v) => !v)}
                className="flex w-full items-center justify-between rounded-lg border p-3 text-left hover:bg-muted"
              >
                <div className="flex items-center gap-2">
                  {schemaOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                  <Code2 className="size-4" />
                  <span className="text-sm font-medium">Input JSON Schema</span>
                </div>
                <span className="text-xs text-muted-foreground">只读</span>
              </button>
              {schemaOpen && (
                <pre className="mt-2 max-h-72 overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">
                  {JSON.stringify(tool.inputSchema, null, 2)}
                </pre>
              )}
            </div>
          </CardContent>
        </Card>

        {/* ═════ 第 2 段：Description 覆盖（可编辑 + 二次确认） ═════ */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <MessageCircleWarning className="size-4 text-amber-600" />
              Description 覆盖
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200">
              description 是 LLM 决策是否调用工具的核心依据。改动可能让模型不再调用该工具或调用方式偏离，
              推荐用 <b>append</b> 模式追加平台特定语义；<b>replace</b> 需二次确认。
            </div>
            <div className="grid gap-3 md:grid-cols-4">
              <div className="md:col-span-1">
                <Label className="text-xs">模式</Label>
                <Select value={overrideMode} onValueChange={(v) => setOverrideMode(v as ToolDescriptionOverrideMode)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="append">追加（append）</SelectItem>
                    <SelectItem value="replace">替换（replace）</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="md:col-span-3">
                <Label className="text-xs">覆盖文本（留空 = 不覆盖）</Label>
                <Textarea
                  className="min-h-24 text-xs"
                  value={overrideText}
                  onChange={(e) => setOverrideText(e.target.value)}
                  placeholder={overrideMode === "append"
                    ? "追加内容，比如：在本平台请优先把产物放在 assets/YYYYMMDD/ 目录下。"
                    : "完全替换 md 原描述——务必包含工具的核心用途与参数说明。"}
                  disabled={platformReadOnly}
                />
              </div>
            </div>
            {overrideError && (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
                <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
                <span>{overrideError}</span>
              </div>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs text-muted-foreground">
                {overrideSavedAt ? (
                  <span className="inline-flex items-center gap-1">
                    <CircleCheck className="size-3" />
                    已保存并热生效
                  </span>
                ) : overrideDirty ? (
                  <span>有未保存更改</span>
                ) : tool.descriptionOverride ? (
                  <span>当前使用：{tool.descriptionOverride.mode}</span>
                ) : (
                  <span>未覆盖，模型看到 md 原描述</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {canClearOverride && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={platformReadOnly || overrideSaving}
                    onClick={() => { void doClearOverride(); }}
                  >
                    清除覆盖
                  </Button>
                )}
                <Button
                  size="sm"
                  disabled={platformReadOnly || overrideSaving || !overrideDirty || !overrideText.trim()}
                  onClick={() => {
                    if (overrideMode === "replace") {
                      setConfirmOpen(true);
                    } else {
                      void doSaveOverride();
                    }
                  }}
                >
                  {overrideSaving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                  保存覆盖
                </Button>
              </div>
            </div>
            {confirmOpen && (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs">
                <div className="mb-2 font-medium text-destructive">
                  确认使用 replace 模式完全替换 description？
                </div>
                <div className="mb-3 text-muted-foreground">
                  该操作会立即影响所有租户的下一次会话——若替换文本没有覆盖到工具核心用途，模型可能停止调用该工具。
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" size="sm" onClick={() => setConfirmOpen(false)} disabled={overrideSaving}>
                    取消
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => { void doSaveOverride(); }}
                    disabled={overrideSaving}
                  >
                    确认替换
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* ═════ 第 3 段：运行时参数（按工具类型分派） ═════ */}
        {renderRuntimeParamsSection(props)}

        {/* ═════ 第 4 段：危险行为提示 ═════ */}
        {(tool.risk === "dangerous" || tool.risk === "workspace_write") && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <CircleAlert className="size-4 text-destructive" />
                安全提示
              </CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground">
              {tool.risk === "dangerous"
                ? "该工具会执行任意命令 / 副作用，运行前必须走 Web 审批（HITL）。关闭它前请确认没有场景强依赖。"
                : "该工具会写入工作区或组织数据。关闭它前请确认没有场景强依赖。"}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

function ReadonlyRow(props: { label: string; value: string }): JSX.Element {
  return (
    <div className="rounded-lg border p-3">
      <div className="text-xs text-muted-foreground">{props.label}</div>
      <div className="mt-1 break-all font-mono text-sm">{props.value}</div>
    </div>
  );
}

function renderRuntimeParamsSection(props: ToolDetailPanelProps): JSX.Element {
  const { tool } = props;
  if (tool.id === "WebSearch") return <WebSearchParamsSection {...props} />;
  if (tool.id === "WebFetch") return <WebFetchParamsSection {...props} />;
  if (tool.id === "GenerateImage") return <GenerateImageParamsSection />;
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">运行时参数</CardTitle>
      </CardHeader>
      <CardContent className="text-xs text-muted-foreground">
        该工具没有额外的运行时参数——契约由代码里的 zod schema 完整约束，UI 无需暴露可配项。
      </CardContent>
    </Card>
  );
}

function WebSearchParamsSection(props: ToolDetailPanelProps): JSX.Element {
  const { webToolsDraft, updateSearch, markDirty, searchApiKeyText, setSearchApiKeyText } = props;
  const search = webToolsDraft.search ?? DEFAULT_SEARCH;
  const provider = search.provider ?? DEFAULT_SEARCH.provider ?? "volcengine";
  const providerOption = SEARCH_PROVIDER_OPTIONS.find((option) => option.value === provider) ?? SEARCH_PROVIDER_OPTIONS[0];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">运行时参数（WebSearch）</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="rounded-lg border bg-muted/40 p-3 text-xs text-muted-foreground">
          修改后走顶部 <b>保存并生效</b> 按钮统一提交（webTools 属于顶层配置，需整包保存）。
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Provider</Label>
            <Select value={provider} onValueChange={(v) => updateSearch({ provider: v as typeof provider, endpoint: undefined })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {SEARCH_PROVIDER_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>API Key Ref</Label>
            <Input
              value={search.apiKeyRef ?? ""}
              onChange={(e) => updateSearch({ apiKeyRef: e.target.value, hasApiKey: search.hasApiKey })}
              placeholder={providerOption.keyRefPlaceholder}
            />
            {search.hasApiKey && !search.apiKeyRef && !searchApiKeyText && (
              <p className="text-xs text-muted-foreground">已有明文 apiKey，保存时由后端保留。</p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label>API Key</Label>
            <Input
              type="password"
              autoComplete="new-password"
              value={searchApiKeyText}
              onChange={(e) => { setSearchApiKeyText(e.target.value); markDirty(); }}
              placeholder="留空则使用 API Key Ref 或保留已有明文 key"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Endpoint</Label>
            <Input
              value={search.endpoint ?? ""}
              onChange={(e) => updateSearch({ endpoint: e.target.value })}
              placeholder={providerOption.endpointPlaceholder}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Timeout ms</Label>
            <Input
              type="number" min={1} max={60_000}
              value={search.timeoutMs ?? ""}
              onChange={(e) => updateSearch({ timeoutMs: numberOrUndefined(e.target.value) })}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Max results</Label>
            <Input
              type="number" min={1} max={10}
              value={search.maxResults ?? ""}
              onChange={(e) => updateSearch({ maxResults: numberOrUndefined(e.target.value) })}
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function WebFetchParamsSection(props: ToolDetailPanelProps): JSX.Element {
  const {
    webToolsDraft, updateFetch, updateWebTools, markDirty,
    allowedContentTypesText, setAllowedContentTypesText,
    allowedHostsText, setAllowedHostsText,
    blockedHostsText, setBlockedHostsText,
  } = props;
  const fetch = webToolsDraft.fetch ?? DEFAULT_FETCH;
  const egress = webToolsDraft.egress ?? {};

  return (
    <>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">运行时参数（WebFetch）</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="rounded-lg border bg-muted/40 p-3 text-xs text-muted-foreground">
            修改后走顶部 <b>保存并生效</b> 按钮统一提交。
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Timeout ms</Label>
              <Input type="number" min={1} max={60_000} value={fetch.timeoutMs ?? ""} onChange={(e) => updateFetch({ timeoutMs: numberOrUndefined(e.target.value) })} />
            </div>
            <div className="space-y-1.5">
              <Label>Max redirects</Label>
              <Input type="number" min={0} max={10} value={fetch.maxRedirects ?? ""} onChange={(e) => updateFetch({ maxRedirects: numberOrUndefined(e.target.value) })} />
            </div>
            <div className="space-y-1.5">
              <Label>Max bytes</Label>
              <Input type="number" min={1} max={10 * 1024 * 1024} value={fetch.maxBytes ?? ""} onChange={(e) => updateFetch({ maxBytes: numberOrUndefined(e.target.value) })} />
            </div>
            <div className="space-y-1.5">
              <Label>Max chars</Label>
              <Input type="number" min={100} max={50_000} value={fetch.maxChars ?? ""} onChange={(e) => updateFetch({ maxChars: numberOrUndefined(e.target.value) })} />
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label>Allowed content types</Label>
              <Textarea
                className="min-h-20 font-mono text-xs"
                value={allowedContentTypesText}
                onChange={(e) => { setAllowedContentTypesText(e.target.value); markDirty(); }}
                placeholder={"text/html\napplication/json\ntext/plain"}
              />
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label>User agent</Label>
              <Input value={fetch.userAgent ?? ""} onChange={(e) => updateFetch({ userAgent: e.target.value })} placeholder="留空使用内置默认 UA" />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">出站策略（WebFetch / WebSearch 共享）</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
            <div>
              <Label className="text-sm font-medium">允许访问私网 / localhost</Label>
              <p className="mt-1 text-xs text-muted-foreground">默认关闭；除非明确要访问内网服务，否则保持关闭。</p>
            </div>
            <Switch
              checked={egress.allowPrivateNetworks === true}
              onCheckedChange={(checked) => updateWebTools((current) => ({ ...current, egress: { ...(current.egress ?? {}), allowPrivateNetworks: checked } }))}
            />
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Allowed hosts</Label>
              <Textarea
                className="min-h-24 font-mono text-xs"
                value={allowedHostsText}
                onChange={(e) => { setAllowedHostsText(e.target.value); markDirty(); }}
                placeholder={"example.com\n*.trusted.com"}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Blocked hosts</Label>
              <Textarea
                className="min-h-24 font-mono text-xs"
                value={blockedHostsText}
                onChange={(e) => { setBlockedHostsText(e.target.value); markDirty(); }}
                placeholder={"localhost\n169.254.169.254"}
              />
            </div>
          </div>
        </CardContent>
      </Card>
    </>
  );
}

function GenerateImageParamsSection(): JSX.Element {
  // 现有两张 card 完全自包含（独立 fetch/save），直接嵌入即可；不通过主 draft 走。
  return (
    <>
      <ImageGenSettingsCard />
      <ImageGenPricingCard />
    </>
  );
}

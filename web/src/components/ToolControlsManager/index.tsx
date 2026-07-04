import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Database,
  Globe2,
  ListChecks,
  Loader2,
  MessageSquare,
  Puzzle,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  Terminal,
  Wrench,
} from "lucide-react";
import {
  fetchToolControlsConfig,
  updateToolControlsConfig,
  type ToolCatalogItem,
  type ToolControlsAdminResponse,
  type ToolControlsConfig,
  type WebToolsConfig,
  type WebToolsFetchConfig,
  type WebSearchProvider,
  type WebToolsSearchConfig,
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
import { SettingsPanelHeader } from "@/components/SettingsCenter/SettingsPanelHeader";

// 缺省视为「启用」以对齐后端语义：WebToolProvider.list() 判 `search.enabled !== false`
// 即缺省字段视为启用。若这里写 false，config.json 里省略 `enabled` 字段时前端会误
// 显示"关闭"，而后端 agent 实际能用 WebSearch。
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

const DEFAULT_WEB_TOOLS: WebToolsConfig = {
  enabled: true,
  search: DEFAULT_SEARCH,
  fetch: DEFAULT_FETCH,
  egress: { allowPrivateNetworks: false },
};

const TOOL_GROUPS = [
  { id: "workspace", label: "工作区", icon: Terminal },
  { id: "memory", label: "记忆", icon: Database },
  { id: "skill", label: "Skill", icon: Puzzle },
  { id: "meta", label: "协作", icon: ListChecks },
  { id: "session", label: "会话追踪", icon: MessageSquare },
  { id: "web", label: "Web", icon: Globe2 },
] as const;

const SEARCH_PROVIDER_OPTIONS: Array<{
  value: WebSearchProvider;
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
];

function splitList(value: string): string[] {
  const seen = new Set<string>();
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => {
      if (seen.has(item)) return false;
      seen.add(item);
      return true;
    });
}

function joinList(values?: string[]): string {
  return (values ?? []).join("\n");
}

function normalizeToolControls(toolControls: ToolControlsConfig | null): ToolControlsConfig {
  return {
    enabled: toolControls?.enabled ?? true,
    tools: { ...(toolControls?.tools ?? {}) },
  };
}

function normalizeWebTools(webTools: WebToolsConfig | null): WebToolsConfig {
  if (!webTools) {
    // config.webTools 未定义时后端 resolveWebToolsConfig 返回 undefined，
    // WebToolProvider 不会启动 —— 两个 web 工具都不会暴露给 agent。
    // UI 相应显示全部关闭，与运行时状态一致。
    return {
      ...DEFAULT_WEB_TOOLS,
      enabled: false,
      search: { ...DEFAULT_SEARCH, enabled: false },
      fetch: { ...DEFAULT_FETCH, enabled: false },
    };
  }
  // config.webTools 已定义。缺失字段视为「启用」，与后端 WebToolProvider.list()
  // 对 `search.enabled !== false` / `fetch?.enabled !== false` 的判定一致。
  return {
    enabled: webTools.enabled ?? DEFAULT_WEB_TOOLS.enabled,
    // webTools.search 不存在 → 后端不加 WebSearch → UI 显示关闭。
    search: webTools.search
      ? { ...DEFAULT_SEARCH, ...webTools.search }
      : { ...DEFAULT_SEARCH, enabled: false },
    // webTools.fetch 不存在但 webTools 存在 → 后端 `fetch?.enabled !== false`
    // 判定为 true，仍会暴露 WebFetch → UI 沿用 DEFAULT_FETCH.enabled=true。
    fetch: webTools.fetch
      ? { ...DEFAULT_FETCH, ...webTools.fetch }
      : { ...DEFAULT_FETCH },
    egress: { ...DEFAULT_WEB_TOOLS.egress, ...(webTools.egress ?? {}) },
  };
}

function isToolIndividuallyEnabled(toolControls: ToolControlsConfig, tool: Pick<ToolCatalogItem, "id" | "name"> | string): boolean {
  const id = typeof tool === "string" ? tool : tool.id;
  const name = typeof tool === "string" ? tool : tool.name;
  const tools = toolControls.tools ?? {};
  const byId = tools[id]?.enabled;
  const byName = name !== id ? tools[name]?.enabled : undefined;
  return byId !== false && byName !== false;
}

function isToolEnabledInDraft(toolControls: ToolControlsConfig, tool: Pick<ToolCatalogItem, "id" | "name"> | string): boolean {
  return toolControls.enabled !== false && isToolIndividuallyEnabled(toolControls, tool);
}

function isWebToolEnabledInDraft(toolControls: ToolControlsConfig, webTools: WebToolsConfig, toolId: string): boolean {
  return isToolEnabledInDraft(toolControls, toolId) && webProviderEnabled(webTools, toolId);
}

function webProviderEnabled(webTools: WebToolsConfig, toolId: string): boolean {
  if (webTools.enabled === false) return false;
  if (toolId === "WebSearch") return !!webTools.search && webTools.search.enabled !== false;
  if (toolId === "WebFetch") return !!webTools.fetch && webTools.fetch.enabled !== false;
  return true;
}

function listDraftVisibleTools(tools: ToolCatalogItem[], toolControls: ToolControlsConfig, webTools: WebToolsConfig): string[] {
  if (toolControls.enabled === false) return [];
  return tools
    .filter((tool) => {
      if (!isToolIndividuallyEnabled(toolControls, tool)) return false;
      if (tool.category === "web") return webProviderEnabled(webTools, tool.id);
      return true;
    })
    .map((tool) => tool.name);
}

function buildToolControlsPayload(toolControls: ToolControlsConfig): ToolControlsConfig | null {
  if (toolControls.enabled === false) return { enabled: false };
  const disabledTools = Object.fromEntries(
    Object.entries(toolControls.tools ?? {})
      .filter(([, value]) => value.enabled === false)
      .map(([key]) => [key, { enabled: false }]),
  );
  if (Object.keys(disabledTools).length === 0) return null;
  return { tools: disabledTools };
}

function numberOrUndefined(value: string): number | undefined {
  if (value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function assertIntegerRange(label: string, value: number | undefined, min: number, max: number): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} 必须是 ${min} 到 ${max} 之间的整数`);
  }
}

function buildWebToolsPayload(
  draft: WebToolsConfig,
  toolControls: ToolControlsConfig,
  allowedContentTypesText: string,
  allowedHostsText: string,
  blockedHostsText: string,
  searchApiKeyText: string,
): WebToolsConfig | null {
  const search = { ...DEFAULT_SEARCH, ...(draft.search ?? {}) };
  const fetch = { ...DEFAULT_FETCH, ...(draft.fetch ?? {}) };
  const egress = draft.egress ?? {};

  assertIntegerRange("Search timeout", search.timeoutMs, 1, 60_000);
  assertIntegerRange("Search maxResults", search.maxResults, 1, 10);
  assertIntegerRange("Fetch timeout", fetch.timeoutMs, 1, 60_000);
  assertIntegerRange("Fetch maxBytes", fetch.maxBytes, 1, 10 * 1024 * 1024);
  assertIntegerRange("Fetch maxChars", fetch.maxChars, 100, 50_000);
  assertIntegerRange("Fetch maxRedirects", fetch.maxRedirects, 0, 10);

  if (draft.enabled === false) return null;

  const webToolsPayload: WebToolsConfig = { enabled: true };
  const searchEnabled = isWebToolEnabledInDraft(toolControls, draft, "WebSearch");
  const searchPayload: WebToolsSearchConfig = {};
  if (!searchEnabled) searchPayload.enabled = false;
  if (search.provider && search.provider !== DEFAULT_SEARCH.provider) searchPayload.provider = search.provider;
  if (search.endpoint?.trim()) searchPayload.endpoint = search.endpoint.trim();
  if (searchApiKeyText.trim()) searchPayload.apiKey = searchApiKeyText.trim();
  else if (search.apiKeyRef?.trim()) searchPayload.apiKeyRef = search.apiKeyRef.trim();
  else if (search.hasApiKey) searchPayload.hasApiKey = true;
  if (search.timeoutMs !== undefined && search.timeoutMs !== DEFAULT_SEARCH.timeoutMs) searchPayload.timeoutMs = search.timeoutMs;
  if (search.maxResults !== undefined && search.maxResults !== DEFAULT_SEARCH.maxResults) searchPayload.maxResults = search.maxResults;
  if (searchEnabled || Object.keys(searchPayload).length > 1 || searchPayload.enabled !== false) {
    webToolsPayload.search = searchPayload;
  }

  const contentTypes = splitList(allowedContentTypesText);
  const fetchEnabled = isWebToolEnabledInDraft(toolControls, draft, "WebFetch");
  const fetchPayload: WebToolsFetchConfig = {};
  if (!fetchEnabled) fetchPayload.enabled = false;
  if (fetch.timeoutMs !== undefined && fetch.timeoutMs !== DEFAULT_FETCH.timeoutMs) fetchPayload.timeoutMs = fetch.timeoutMs;
  if (fetch.maxBytes !== undefined && fetch.maxBytes !== DEFAULT_FETCH.maxBytes) fetchPayload.maxBytes = fetch.maxBytes;
  if (fetch.maxChars !== undefined && fetch.maxChars !== DEFAULT_FETCH.maxChars) fetchPayload.maxChars = fetch.maxChars;
  if (fetch.maxRedirects !== undefined && fetch.maxRedirects !== DEFAULT_FETCH.maxRedirects) fetchPayload.maxRedirects = fetch.maxRedirects;
  if (contentTypes.length > 0) fetchPayload.allowedContentTypes = contentTypes;
  if (fetch.userAgent?.trim()) fetchPayload.userAgent = fetch.userAgent.trim();
  if (!fetchEnabled || Object.keys(fetchPayload).length > 0) {
    webToolsPayload.fetch = fetchPayload;
  }

  const allowedHosts = splitList(allowedHostsText);
  const blockedHosts = splitList(blockedHostsText);
  const egressPayload = {
    ...(egress.allowPrivateNetworks ? { allowPrivateNetworks: true } : {}),
    ...(allowedHosts.length > 0 ? { allowedHosts } : {}),
    ...(blockedHosts.length > 0 ? { blockedHosts } : {}),
  };
  if (Object.keys(egressPayload).length > 0) webToolsPayload.egress = egressPayload;
  return webToolsPayload;
}

export function ToolControlsManager() {
  const [toolControlsDraft, setToolControlsDraft] = useState<ToolControlsConfig>(() => normalizeToolControls(null));
  const [webToolsDraft, setWebToolsDraft] = useState<WebToolsConfig>(() => normalizeWebTools(null));
  const [tools, setTools] = useState<ToolCatalogItem[]>([]);
  const [effectiveWebTools, setEffectiveWebTools] = useState<string[]>([]);
  const [configured, setConfigured] = useState(false);
  const [allowedContentTypesText, setAllowedContentTypesText] = useState("");
  const [allowedHostsText, setAllowedHostsText] = useState("");
  const [blockedHostsText, setBlockedHostsText] = useState("");
  const [searchApiKeyText, setSearchApiKeyText] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const markDirty = useCallback(() => {
    setDirty(true);
    setSavedAt(null);
    setError(null);
  }, []);

  const hydrate = useCallback((response: ToolControlsAdminResponse) => {
    const nextToolControls = normalizeToolControls(response.toolControls);
    const nextWebTools = normalizeWebTools(response.webTools);
    setToolControlsDraft(nextToolControls);
    setWebToolsDraft(nextWebTools);
    setTools(response.tools);
    setEffectiveWebTools(response.effectiveWebTools);
    setConfigured(!!response.toolControls || !!response.webTools);
    setAllowedContentTypesText(joinList(nextWebTools.fetch?.allowedContentTypes));
    setAllowedHostsText(joinList(nextWebTools.egress?.allowedHosts));
    setBlockedHostsText(joinList(nextWebTools.egress?.blockedHosts));
    setSearchApiKeyText("");
    setDirty(false);
    setSavedAt(null);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetchToolControlsConfig();
      hydrate(response);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [hydrate]);

  useEffect(() => { void refresh(); }, [refresh]);

  const updateToolControls = useCallback((updater: (current: ToolControlsConfig) => ToolControlsConfig) => {
    setToolControlsDraft((current) => updater(current));
    markDirty();
  }, [markDirty]);

  const updateWebTools = useCallback((updater: (current: WebToolsConfig) => WebToolsConfig) => {
    setWebToolsDraft((current) => updater(current));
    markDirty();
  }, [markDirty]);

  const updateTool = useCallback((toolId: string, enabled: boolean) => {
    updateToolControls((current) => ({
      ...current,
      tools: {
        ...(current.tools ?? {}),
        [toolId]: { ...(current.tools?.[toolId] ?? {}), enabled },
      },
    }));
    if (toolId === "WebSearch") {
      updateWebTools((current) => ({
        ...current,
        enabled: enabled ? true : current.enabled,
        search: { ...DEFAULT_SEARCH, ...(current.search ?? {}), enabled },
      }));
    }
    if (toolId === "WebFetch") {
      updateWebTools((current) => ({
        ...current,
        enabled: enabled ? true : current.enabled,
        fetch: { ...DEFAULT_FETCH, ...(current.fetch ?? {}), enabled },
      }));
    }
  }, [updateToolControls, updateWebTools]);

  const updateSearch = useCallback((patch: Partial<WebToolsSearchConfig>) => {
    updateWebTools((current) => ({
      ...current,
      search: { ...DEFAULT_SEARCH, ...(current.search ?? {}), ...patch },
    }));
  }, [updateWebTools]);

  const updateFetch = useCallback((patch: Partial<WebToolsFetchConfig>) => {
    updateWebTools((current) => ({
      ...current,
      fetch: { ...DEFAULT_FETCH, ...(current.fetch ?? {}), ...patch },
    }));
  }, [updateWebTools]);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const toolControls = buildToolControlsPayload(toolControlsDraft);
      const webTools = buildWebToolsPayload(webToolsDraft, toolControlsDraft, allowedContentTypesText, allowedHostsText, blockedHostsText, searchApiKeyText);
      const response = await updateToolControlsConfig({ toolControls, webTools });
      hydrate(response);
      setSavedAt(Date.now());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [allowedContentTypesText, allowedHostsText, blockedHostsText, hydrate, searchApiKeyText, toolControlsDraft, webToolsDraft]);

  const draftVisibleTools = useMemo(
    () => listDraftVisibleTools(tools, toolControlsDraft, webToolsDraft),
    [tools, toolControlsDraft, webToolsDraft],
  );
  const savedDisabledTools = useMemo(() => tools.filter((tool) => !tool.enabled).map((tool) => tool.name), [tools]);
  const search = webToolsDraft.search ?? DEFAULT_SEARCH;
  const searchProvider = search.provider ?? DEFAULT_SEARCH.provider ?? "volcengine";
  const searchProviderOption = SEARCH_PROVIDER_OPTIONS.find((option) => option.value === searchProvider) ?? SEARCH_PROVIDER_OPTIONS[0];
  const fetch = webToolsDraft.fetch ?? DEFAULT_FETCH;
  const egress = webToolsDraft.egress ?? {};

  if (loading && tools.length === 0 && !dirty) {
    return <div className="flex flex-1 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col">
      <SettingsPanelHeader
        title="工具开关"
        description="统一管理平台内建工具是否向模型暴露，WebSearch / WebFetch 的 provider 参数在同页维护。"
        actions={(
          <>
            {!configured && <Badge variant="outline" title="config.json 里未显式写入 toolControls / webTools，运行时按缺省视为启用">运行时缺省·未落 config</Badge>}
            {dirty && <Badge variant="outline">有未保存更改</Badge>}
            {savedAt && !dirty && <Badge variant="secondary" className="gap-1"><CheckCircle2 className="h-3 w-3" />已保存并热生效</Badge>}
            <Button variant="outline" size="sm" onClick={() => { void refresh(); }} disabled={loading || saving}>
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              刷新
            </Button>
            <Button size="sm" onClick={() => { void save(); }} disabled={saving || !dirty}>
              {saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-1.5 h-3.5 w-3.5" />}
              保存并生效
            </Button>
          </>
        )}
      />

      <div className="min-h-0 flex-1 space-y-4 overflow-auto">
      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base"><Wrench className="h-4 w-4" />全局工具开关</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
            <div>
              <Label className="text-sm font-medium">向模型暴露平台工具</Label>
              <p className="mt-1 text-xs text-muted-foreground">关闭后本页所有内建工具都不会进入后续会话的工具列表。</p>
            </div>
            <Switch
              checked={toolControlsDraft.enabled !== false}
              onCheckedChange={(checked) => updateToolControls((current) => ({ ...current, enabled: checked }))}
            />
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded-lg border p-3">
              <div className="text-xs font-medium text-muted-foreground">已保存关闭</div>
              <div className="mt-2 flex flex-wrap gap-2">
                {savedDisabledTools.length > 0 ? savedDisabledTools.map((tool) => <Badge key={tool} variant="outline">{tool}</Badge>) : <Badge variant="secondary">无</Badge>}
              </div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="text-xs font-medium text-muted-foreground">草稿可见工具</div>
              <div className="mt-2 flex flex-wrap gap-2">
                <Badge variant="secondary">{draftVisibleTools.length} / {tools.length}</Badge>
              </div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="text-xs font-medium text-muted-foreground">已保存 Web 工具</div>
              <div className="mt-2 flex flex-wrap gap-2">
                {effectiveWebTools.length > 0 ? effectiveWebTools.map((tool) => <Badge key={tool} variant="secondary">{tool}</Badge>) : <Badge variant="outline">无</Badge>}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {TOOL_GROUPS.map((group) => {
          const groupTools = tools.filter((tool) => tool.category === group.id);
          if (groupTools.length === 0) return null;
          const Icon = group.icon;
          return (
            <Card key={group.id}>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base"><Icon className="h-4 w-4" />{group.label}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {groupTools.map((tool) => {
                  const individuallyEnabled = isToolIndividuallyEnabled(toolControlsDraft, tool);
                  const switchChecked = tool.category === "web"
                    ? individuallyEnabled && webProviderEnabled(webToolsDraft, tool.id)
                    : individuallyEnabled;
                  const draftEnabled = tool.category === "web"
                    ? isWebToolEnabledInDraft(toolControlsDraft, webToolsDraft, tool.id)
                    : isToolEnabledInDraft(toolControlsDraft, tool);
                  return (
                    <div key={tool.id} className="flex items-center justify-between gap-3 rounded-lg border p-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="break-all font-mono text-sm font-medium">{tool.name}</span>
                          <Badge variant={draftEnabled ? "secondary" : "outline"}>{draftEnabled ? "开启" : "关闭"}</Badge>
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">{tool.label}</div>
                      </div>
                      <Switch
                        checked={switchChecked}
                        disabled={toolControlsDraft.enabled === false}
                        onCheckedChange={(checked) => updateTool(tool.id, checked)}
                        aria-label={`启用 ${tool.name}`}
                      />
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base"><Globe2 className="h-4 w-4" />Web provider 配置</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
            <div>
              <Label className="text-sm font-medium">启用 Web provider</Label>
              <p className="mt-1 text-xs text-muted-foreground">WebSearch / WebFetch 仍分别受上方工具开关控制。</p>
            </div>
            <Switch checked={webToolsDraft.enabled !== false} onCheckedChange={(checked) => updateWebTools((current) => ({ ...current, enabled: checked }))} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base"><Search className="h-4 w-4" />WebSearch 参数</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="web-search-provider">Provider</Label>
              <Select
                value={searchProvider}
                onValueChange={(value) => updateSearch({ provider: value as WebSearchProvider, endpoint: undefined })}
              >
                <SelectTrigger id="web-search-provider">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SEARCH_PROVIDER_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="web-search-api-key-ref">API Key Ref</Label>
              <Input
                id="web-search-api-key-ref"
                value={search.apiKeyRef ?? ""}
                onChange={(event) => updateSearch({ apiKeyRef: event.target.value, hasApiKey: search.hasApiKey })}
                placeholder={searchProviderOption.keyRefPlaceholder}
              />
              {search.hasApiKey && !search.apiKeyRef && !searchApiKeyText && <p className="text-xs text-muted-foreground">已有明文 apiKey，保存时由后端保留。</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="web-search-api-key">API Key</Label>
              <Input
                id="web-search-api-key"
                type="password"
                value={searchApiKeyText}
                onChange={(event) => { setSearchApiKeyText(event.target.value); markDirty(); }}
                placeholder="留空则使用 API Key Ref 或保留已有明文 key"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="web-search-endpoint">Endpoint</Label>
              <Input
                id="web-search-endpoint"
                value={search.endpoint ?? ""}
                onChange={(event) => updateSearch({ endpoint: event.target.value })}
                placeholder={searchProviderOption.endpointPlaceholder}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="web-search-timeout">Timeout ms</Label>
              <Input
                id="web-search-timeout"
                type="number"
                min={1}
                max={60_000}
                value={search.timeoutMs ?? ""}
                onChange={(event) => updateSearch({ timeoutMs: numberOrUndefined(event.target.value) })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="web-search-max-results">Max results</Label>
              <Input
                id="web-search-max-results"
                type="number"
                min={1}
                max={10}
                value={search.maxResults ?? ""}
                onChange={(event) => updateSearch({ maxResults: numberOrUndefined(event.target.value) })}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base"><Globe2 className="h-4 w-4" />WebFetch 参数</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="web-fetch-timeout">Timeout ms</Label>
              <Input id="web-fetch-timeout" type="number" min={1} max={60_000} value={fetch.timeoutMs ?? ""} onChange={(event) => updateFetch({ timeoutMs: numberOrUndefined(event.target.value) })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="web-fetch-max-redirects">Max redirects</Label>
              <Input id="web-fetch-max-redirects" type="number" min={0} max={10} value={fetch.maxRedirects ?? ""} onChange={(event) => updateFetch({ maxRedirects: numberOrUndefined(event.target.value) })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="web-fetch-max-bytes">Max bytes</Label>
              <Input id="web-fetch-max-bytes" type="number" min={1} max={10 * 1024 * 1024} value={fetch.maxBytes ?? ""} onChange={(event) => updateFetch({ maxBytes: numberOrUndefined(event.target.value) })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="web-fetch-max-chars">Max chars</Label>
              <Input id="web-fetch-max-chars" type="number" min={100} max={50_000} value={fetch.maxChars ?? ""} onChange={(event) => updateFetch({ maxChars: numberOrUndefined(event.target.value) })} />
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="web-fetch-content-types">Allowed content types</Label>
              <Textarea
                id="web-fetch-content-types"
                className="min-h-20 font-mono text-xs"
                value={allowedContentTypesText}
                onChange={(event) => { setAllowedContentTypesText(event.target.value); markDirty(); }}
                placeholder={"text/html\napplication/json\ntext/plain"}
              />
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="web-fetch-user-agent">User agent</Label>
              <Input id="web-fetch-user-agent" value={fetch.userAgent ?? ""} onChange={(event) => updateFetch({ userAgent: event.target.value })} placeholder="留空使用内置默认 UA" />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base"><ShieldCheck className="h-4 w-4" />出站策略</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
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
              <Label htmlFor="web-egress-allowed-hosts">Allowed hosts</Label>
              <Textarea
                id="web-egress-allowed-hosts"
                className="min-h-24 font-mono text-xs"
                value={allowedHostsText}
                onChange={(event) => { setAllowedHostsText(event.target.value); markDirty(); }}
                placeholder={"example.com\n*.trusted.com"}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="web-egress-blocked-hosts">Blocked hosts</Label>
              <Textarea
                id="web-egress-blocked-hosts"
                className="min-h-24 font-mono text-xs"
                value={blockedHostsText}
                onChange={(event) => { setBlockedHostsText(event.target.value); markDirty(); }}
                placeholder={"localhost\n169.254.169.254"}
              />
            </div>
          </div>
        </CardContent>
      </Card>
      </div>
    </div>
  );
}

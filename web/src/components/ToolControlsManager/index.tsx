import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Clock,
  Database,
  Globe2,
  ImageIcon,
  ListChecks,
  Loader2,
  MessageSquare,
  RefreshCw,
  Save,
  Terminal,
  Wrench,
} from "lucide-react";
import { EntityIcons } from "@/lib/icons";
import {
  fetchToolControlsConfig,
  updateSingleTool,
  updateToolControlsConfig,
  type ToolCatalogItem,
  type ToolControlsAdminResponse,
  type ToolControlsConfig,
  type ToolDescriptionOverride,
  type WebToolsConfig,
  type WebToolsFetchConfig,
  type WebToolsSearchConfig,
} from "@agent/shared";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { SettingsPanelHeader } from "@/components/SettingsCenter/SettingsPanelHeader";
import { ToolDetailPanel } from "@/components/ToolControlsManager/ToolDetailPanel";
import { useAuth } from "@/contexts/AuthContext";

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
  { id: "skill", label: "技能", icon: EntityIcons.skill },
  { id: "meta", label: "协作", icon: ListChecks },
  { id: "session", label: "会话追踪", icon: MessageSquare },
  { id: "web", label: "Web", icon: Globe2 },
  { id: "media", label: "多媒体", icon: ImageIcon },
  { id: "cron", label: "定时任务", icon: Clock },
] as const;

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
    return {
      ...DEFAULT_WEB_TOOLS,
      enabled: false,
      search: { ...DEFAULT_SEARCH, enabled: false },
      fetch: { ...DEFAULT_FETCH, enabled: false },
    };
  }
  return {
    enabled: webTools.enabled ?? DEFAULT_WEB_TOOLS.enabled,
    search: webTools.search
      ? { ...DEFAULT_SEARCH, ...webTools.search }
      : { ...DEFAULT_SEARCH, enabled: false },
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
  const toolsEntries = Object.entries(toolControls.tools ?? {}).flatMap(([key, value]) => {
    const entry: { enabled?: boolean; descriptionOverride?: ToolDescriptionOverride } = {};
    if (value.enabled === false) entry.enabled = false;
    if (value.descriptionOverride) entry.descriptionOverride = value.descriptionOverride;
    return Object.keys(entry).length > 0 ? [[key, entry] as const] : [];
  });
  if (toolsEntries.length === 0) return null;
  return { tools: Object.fromEntries(toolsEntries) };
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

export function ToolControlsManager(): JSX.Element {
  const { platformReadOnly } = useAuth();
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
  const [selectedToolId, setSelectedToolId] = useState<string | null>(null);

  const markDirty = useCallback(() => {
    setDirty(true);
    setSavedAt(null);
    setError(null);
  }, []);

  const hydrate = useCallback((response: ToolControlsAdminResponse) => {
    const nextToolControls = normalizeToolControls(response.toolControls);
    // 把 catalog 里带回来的 descriptionOverride 合并回 draft，保证详情页看到最新 override
    for (const tool of response.tools) {
      if (tool.descriptionOverride) {
        nextToolControls.tools = nextToolControls.tools ?? {};
        nextToolControls.tools[tool.id] = {
          ...(nextToolControls.tools[tool.id] ?? {}),
          descriptionOverride: tool.descriptionOverride,
        };
      }
    }
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

  const saveSingleTool = useCallback(async (
    toolId: string,
    payload: { enabled?: boolean; descriptionOverride?: ToolDescriptionOverride | null },
  ) => {
    // 单工具 PUT 不受 dirty 状态影响：description override / 快捷开关自己有独立保存生命周期。
    const response = await updateSingleTool(toolId, payload);
    hydrate(response);
  }, [hydrate]);

  const draftVisibleTools = useMemo(
    () => listDraftVisibleTools(tools, toolControlsDraft, webToolsDraft),
    [tools, toolControlsDraft, webToolsDraft],
  );
  const savedDisabledTools = useMemo(() => tools.filter((tool) => !tool.enabled).map((tool) => tool.name), [tools]);

  if (loading && tools.length === 0 && !dirty) {
    return <div className="flex flex-1 items-center justify-center"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>;
  }

  const selectedTool = selectedToolId ? tools.find((tool) => tool.id === selectedToolId) : null;

  if (selectedTool) {
    return (
      <ToolDetailPanel
        tool={selectedTool}
        toolControls={toolControlsDraft}
        webToolsDraft={webToolsDraft}
        onToggleEnabled={(enabled) => updateTool(selectedTool.id, enabled)}
        updateSearch={updateSearch}
        updateFetch={updateFetch}
        updateWebTools={updateWebTools}
        allowedContentTypesText={allowedContentTypesText}
        setAllowedContentTypesText={(v) => setAllowedContentTypesText(v)}
        allowedHostsText={allowedHostsText}
        setAllowedHostsText={(v) => setAllowedHostsText(v)}
        blockedHostsText={blockedHostsText}
        setBlockedHostsText={(v) => setBlockedHostsText(v)}
        searchApiKeyText={searchApiKeyText}
        setSearchApiKeyText={(v) => setSearchApiKeyText(v)}
        markDirty={markDirty}
        onBack={() => setSelectedToolId(null)}
        saveSingleTool={saveSingleTool}
      />
    );
  }

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col">
      <SettingsPanelHeader
        title="工具开关"
        description="统一管理平台内建工具是否向模型暴露。点击任意工具进入详情页可查看契约、覆盖 description、配置运行时参数。"
        actions={(
          <>
            {!configured && <Badge variant="outline" title="config.json 里未显式写入 toolControls / webTools，运行时按缺省视为启用">运行时缺省·未落 config</Badge>}
            {dirty && <Badge variant="outline">有未保存更改</Badge>}
            {savedAt && !dirty && <Badge variant="secondary" className="gap-1"><CircleCheck className="size-3" />已保存并热生效</Badge>}
            <Button variant="outline" size="sm" onClick={() => { void refresh(); }} disabled={loading || saving}>
              <RefreshCw className="size-3.5" />
              刷新
            </Button>
            <Button size="sm" onClick={() => { void save(); }} disabled={platformReadOnly || saving || !dirty}>
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
              保存并生效
            </Button>
          </>
        )}
      />

      <div className="min-h-0 flex-1 space-y-4 overflow-auto">
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-950">
          保存后对后续 dispatch 热生效；已经开始的运行可能继续使用创建时的工具快照，直到该运行结束。关闭工具可能使依赖它的系统 Profile 失去能力，请到「Agent 运行配置」核对有效工具交集。
        </div>
        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            <CircleAlert className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base"><Wrench className="size-4" />全局工具开关</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
              <div>
                <span className="text-sm font-medium">向模型暴露平台工具</span>
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
                  <CardTitle className="flex items-center gap-2 text-base"><Icon className="size-4" />{group.label}</CardTitle>
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
                    const overridden = !!toolControlsDraft.tools?.[tool.id]?.descriptionOverride;
                    return (
                      <button
                        type="button"
                        key={tool.id}
                        onClick={() => setSelectedToolId(tool.id)}
                        className="flex w-full items-center justify-between gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-muted"
                      >
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="break-all font-mono text-sm font-medium">{tool.name}</span>
                            <Badge variant={draftEnabled ? "secondary" : "outline"}>{draftEnabled ? "开启" : "关闭"}</Badge>
                            {tool.risk === "dangerous" && <Badge variant="destructive">dangerous</Badge>}
                            {tool.risk === "workspace_write" && <Badge variant="outline">写工作区</Badge>}
                            {overridden && <Badge variant="outline">已覆盖描述</Badge>}
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground">{tool.label}</div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Switch
                            checked={switchChecked}
                            disabled={toolControlsDraft.enabled === false}
                            onCheckedChange={(checked) => updateTool(tool.id, checked)}
                            onClick={(e) => e.stopPropagation()}
                            aria-label={`启用 ${tool.name}`}
                          />
                          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                        </div>
                      </button>
                    );
                  })}
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>
    </div>
  );
}

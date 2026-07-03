import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Building2, CheckCircle2, Cpu, Loader2, Plus, Power, PowerOff, RefreshCw, Save, SlidersHorizontal, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { refreshAll } from "@/lib/refreshBus";
import { authFetch } from "@/lib/authFetch";
import { SettingsPanelHeader } from "@/components/SettingsCenter/SettingsPanelHeader";
import type { ModelList } from "@/types/models";
import { useUsers } from "@/components/UserManager/hooks";
import type { UserInfo } from "@/components/UserManager/types";
import { cn } from "@/lib/utils";
import { useTenants } from "./hooks";
import { TenantFormDialog } from "./TenantFormDialog";
import { DEFAULT_TENANT_SETTINGS, type Tenant, type TenantSettings } from "./types";

function cloneTenantSettings(settings: TenantSettings): TenantSettings {
  return {
    features: { ...settings.features },
    quotas: { ...settings.quotas },
    models: {
      ...settings.models,
      allowedModels: [...settings.models.allowedModels],
      displayOverrides: { ...(settings.models.displayOverrides ?? {}) },
    },
    mcp: {
      ...settings.mcp,
      defaultEnabledServerIds: [...settings.mcp.defaultEnabledServerIds],
    },
    branding: { ...settings.branding },
    security: { ...settings.security },
  };
}

function TenantModelPolicyPanel({
  tenant,
  onActionsChange,
}: {
  tenant: Tenant;
  onActionsChange?: (actions: ReactNode | null) => void;
}) {
  const [settings, setSettings] = useState<TenantSettings>(() => cloneTenantSettings(tenant.settings ?? DEFAULT_TENANT_SETTINGS));
  const [modelList, setModelList] = useState<ModelList | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [settingsRes, modelsRes] = await Promise.all([
        authFetch(`/api/tenants/${tenant.id}/settings`),
        authFetch("/api/admin/models"),
      ]);
      const settingsData = await settingsRes.json().catch(() => ({}));
      if (!settingsRes.ok) throw new Error((settingsData as { error?: string }).error || "加载组织模型策略失败");
      const modelData = await modelsRes.json().catch(() => ({}));
      const nextModels = modelsRes.ok
        ? ((modelData as { publicModelList?: ModelList }).publicModelList ?? null)
        : null;
      setSettings(cloneTenantSettings((settingsData as { settings: TenantSettings }).settings));
      setModelList(nextModels);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [tenant.id]);

  useEffect(() => { void load(); }, [load]);

  const modelOptions = useMemo(() => modelList?.groups.flatMap(group =>
    group.models.map(model => ({
      ref: `${group.id}/${model.id}`,
      groupName: group.name,
      modelName: model.name,
      label: settings.models.showGroupNames ? `${group.name}/${model.name}` : model.name,
    })),
  ) ?? [], [modelList, settings.models.showGroupNames]);

  const allowedSet = useMemo(() => new Set(settings.models.allowedModels), [settings.models.allowedModels]);
  const customMode = settings.models.allowedModels.length > 0;
  const visibleModelOptions = customMode ? modelOptions.filter(model => allowedSet.has(model.ref)) : modelOptions;

  const patch = useCallback((recipe: (draft: TenantSettings) => void) => {
    setSettings((prev) => {
      const draft = cloneTenantSettings(prev);
      recipe(draft);
      return draft;
    });
    setSaved(false);
  }, []);

  const toggleAllowedModel = useCallback((modelRef: string, checked: boolean) => {
    patch(draft => {
      draft.models.allowedModels = checked
        ? Array.from(new Set([...draft.models.allowedModels, modelRef]))
        : draft.models.allowedModels.filter(ref => ref !== modelRef);
      if (draft.models.defaultModel === modelRef && !checked) draft.models.defaultModel = undefined;
    });
  }, [patch]);

  const updateOverride = useCallback((modelRef: string, patchValue: Partial<NonNullable<TenantSettings["models"]["displayOverrides"]>[string]>) => {
    patch(draft => {
      const current = draft.models.displayOverrides ?? {};
      const next = { ...(current[modelRef] ?? {}), ...patchValue };
      for (const key of Object.keys(next) as Array<keyof typeof next>) {
        if (next[key] === "" || next[key] === undefined) delete next[key];
      }
      draft.models.displayOverrides = { ...current };
      if (Object.keys(next).length > 0) draft.models.displayOverrides[modelRef] = next;
      else delete draft.models.displayOverrides[modelRef];
    });
  }, [patch]);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const payload = cloneTenantSettings(settings);
      if (payload.models.allowedModels.length > 0 && payload.models.defaultModel && !payload.models.allowedModels.includes(payload.models.defaultModel)) {
        throw new Error("默认模型必须在组织可用模型范围内");
      }
      const res = await authFetch(`/api/tenants/${tenant.id}/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: payload }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error || "保存组织模型策略失败");
      setSettings(cloneTenantSettings((data as { settings: TenantSettings }).settings));
      setSaved(true);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [settings, tenant.id]);

  const actions = useMemo(() => (
    <>
      {saved && <Badge variant="secondary" className="gap-1"><CheckCircle2 className="h-3 w-3" />已保存</Badge>}
      <Button size="sm" onClick={() => { void save(); }} disabled={loading || saving}>
        {saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-1.5 h-3.5 w-3.5" />}
        保存策略
      </Button>
    </>
  ), [loading, save, saved, saving]);

  useEffect(() => {
    onActionsChange?.(actions);
    return () => onActionsChange?.(null);
  }, [actions, onActionsChange]);

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold">模型策略</h3>
        <p className="text-sm text-muted-foreground">配置 {tenant.name} 可用的模型、组织内显示名与默认模型。</p>
      </div>
      {error && <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}

      <Card>
        <CardHeader><CardTitle className="text-base">通用策略</CardTitle></CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label>可见范围</Label>
            <select
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              value={customMode ? "custom" : "inherit"}
              onChange={(event) => patch(draft => {
                if (event.target.value === "inherit") draft.models.allowedModels = [];
                else draft.models.allowedModels = modelOptions.map(model => model.ref);
              })}
            >
              <option value="inherit">继承平台模型池</option>
              <option value="custom">自定义可用模型</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label>默认模型</Label>
            <select
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              value={settings.models.defaultModel ?? ""}
              onChange={(event) => patch(draft => { draft.models.defaultModel = event.target.value || undefined; })}
            >
              <option value="">继承平台默认</option>
              {visibleModelOptions.map(model => <option key={model.ref} value={model.ref}>{model.label}</option>)}
            </select>
          </div>
          <label className="flex items-start gap-2 text-sm md:col-span-2">
            <input type="checkbox" className="mt-0.5" checked={settings.models.allowUserModelSwitch} onChange={(event) => patch(draft => { draft.models.allowUserModelSwitch = event.target.checked; })} />
            <span>允许组织用户切换模型<span className="block text-xs text-muted-foreground">关闭后，用户只能使用组织默认模型。</span></span>
          </label>
          <label className="flex items-center gap-2 text-sm md:col-span-2">
            <input type="checkbox" checked={!!settings.models.showGroupNames} onChange={(event) => patch(draft => { draft.models.showGroupNames = event.target.checked; })} />
            <span>显示分组名</span>
          </label>
          <label className="flex items-start gap-2 text-sm md:col-span-2">
            <input type="checkbox" className="mt-0.5" checked={settings.models.showContextTokens !== false} onChange={(event) => patch(draft => { draft.models.showContextTokens = event.target.checked; })} />
            <span>显示上下文 Token 统计<span className="block text-xs text-muted-foreground">关闭后，组织成员在会话顶部完全看不到上下文/Token 数字。</span></span>
          </label>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">可用模型与组织内展示</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {!modelList ? (
            <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">模型列表加载中或暂无可选模型。</div>
          ) : modelList.groups.map(group => (
            <div key={group.id} className="space-y-2 rounded-lg border p-3">
              <div className="font-medium">{group.name}</div>
              <div className="space-y-3">
                {group.models.map(model => {
                  const ref = `${group.id}/${model.id}`;
                  const override = settings.models.displayOverrides?.[ref] ?? {};
                  const checked = !customMode || allowedSet.has(ref);
                  return (
                    <div key={ref} className="grid gap-2 rounded-md bg-muted/30 p-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                      <label className="flex items-start gap-2 text-sm md:col-span-2">
                        <input type="checkbox" className="mt-0.5" checked={checked} disabled={!customMode} onChange={(event) => toggleAllowedModel(ref, event.target.checked)} />
                        <span>
                          <span className="block font-medium">{group.name}/{model.name}</span>
                          <span className="block font-mono text-xs text-muted-foreground">{ref}</span>
                        </span>
                      </label>
                      <div className="space-y-1.5">
                        <Label>组织内显示名</Label>
                        <Input value={override.displayName ?? ""} onChange={(event) => updateOverride(ref, { displayName: event.target.value })} placeholder={model.name} />
                      </div>
                      <div className="space-y-1.5">
                        <Label>说明</Label>
                        <Input value={override.description ?? ""} onChange={(event) => updateOverride(ref, { description: event.target.value })} placeholder="面向组织用户展示的说明" />
                      </div>
                      <label className="flex items-center gap-2 text-sm md:col-span-2">
                        <input type="checkbox" checked={!!override.recommended} onChange={(event) => updateOverride(ref, { recommended: event.target.checked || undefined })} />
                        标记为推荐模型
                      </label>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function formatDateTime(iso?: string): string {
  if (!iso) return "-";
  try {
    return new Date(iso).toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return iso;
  }
}

function formatQuota(value: number | undefined, unit = ""): string {
  return value ? `${value.toLocaleString("zh-CN")}${unit}` : "不限制";
}

type TenantDetailTab = "config" | "members" | "models" | "capabilities";

const tenantDetailTabs: Array<{ id: TenantDetailTab; label: string; icon: typeof Building2 }> = [
  { id: "config", label: "组织配置", icon: Building2 },
  { id: "members", label: "成员", icon: Users },
  { id: "models", label: "模型策略", icon: Cpu },
  { id: "capabilities", label: "能力与配额", icon: SlidersHorizontal },
];

function TenantMetric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 truncate text-sm font-medium">{value}</div>
    </div>
  );
}

function UserAvatar({ user }: { user: UserInfo }) {
  if (user.avatar) {
    return <img src={user.avatar} alt="" className="h-7 w-7 shrink-0 rounded-full object-cover" />;
  }
  return (
    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
      {(user.realName || user.username).charAt(0).toUpperCase()}
    </div>
  );
}

function TenantMembersPanel({
  users,
  loading,
  error,
}: {
  users: UserInfo[];
  loading: boolean;
  error: string | null;
}) {
  const admins = users.filter(user => user.role === "admin");
  const disabledUsers = users.filter(user => user.disabled);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-base">成员</CardTitle>
        <div className="text-xs text-muted-foreground">{admins.length} 管理员 · {disabledUsers.length} 已禁用</div>
      </CardHeader>
      <CardContent>
        {error && <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}
        {loading && users.length === 0 ? (
          <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            加载成员...
          </div>
        ) : users.length === 0 ? (
          <div className="rounded-md border border-dashed py-8 text-center text-sm text-muted-foreground">暂无成员</div>
        ) : (
          <div className="space-y-2">
            {users.slice(0, 8).map(user => (
              <div key={user.id} className={cn("flex items-center justify-between gap-3 rounded-lg border px-3 py-2", user.disabled && "opacity-60")}>
                <div className="flex min-w-0 items-center gap-2">
                  <UserAvatar user={user} />
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{user.realName || user.username}</div>
                    <div className="truncate text-xs text-muted-foreground">{user.username}</div>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Badge variant={user.role === "admin" ? "default" : "secondary"}>{user.role === "admin" ? "管理员" : "用户"}</Badge>
                  {user.disabled && <Badge variant="outline" className="border-destructive/50 text-destructive">已禁用</Badge>}
                </div>
              </div>
            ))}
            {users.length > 8 && (
              <div className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                另有 {users.length - 8} 个成员未显示
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function TenantCapabilitiesPanel({ tenant }: { tenant: Tenant }) {
  const settings = tenant.settings ?? DEFAULT_TENANT_SETTINGS;
  const features = [
    ["文件", settings.features.filesEnabled],
    ["定时任务", settings.features.cronEnabled],
    ["MCP", settings.features.mcpEnabled],
    ["自建 Skill", settings.features.customSkillsEnabled],
    ["调试模式", settings.features.debugModeAllowed],
    ["钉钉绑定", settings.security.requireDingtalkBinding],
  ] as const;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">能力与配额</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {features.map(([label, enabled]) => (
            <div key={label} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
              <span>{label}</span>
              <Badge variant={enabled ? "secondary" : "outline"}>{enabled ? "开启" : "关闭"}</Badge>
            </div>
          ))}
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <TenantMetric label="用户上限" value={formatQuota(settings.quotas.maxUsers)} />
          <TenantMetric label="管理员上限" value={formatQuota(settings.quotas.maxAdmins)} />
          <TenantMetric label="存储上限" value={formatQuota(settings.quotas.maxStorageMb, " MB")} />
          <TenantMetric label="月 Token 上限" value={formatQuota(settings.quotas.monthlyTokenLimit)} />
          <TenantMetric label="单次最大轮数" value={formatQuota(settings.quotas.maxTurnsPerRequest)} />
          <TenantMetric label="限流请求数" value={formatQuota(settings.quotas.rateLimitMaxRequests)} />
        </div>
      </CardContent>
    </Card>
  );
}

export function TenantManager() {
  const {
    tenants,
    loading,
    error,
    createTenant,
    updateTenant,
    setTenantDisabled,
  } = useTenants();
  const { users, loading: usersLoading, error: usersError } = useUsers();
  const [showForm, setShowForm] = useState(false);
  const [disableTarget, setDisableTarget] = useState<Tenant | null>(null);
  const [disableError, setDisableError] = useState<string | null>(null);
  const [selectedTenantId, setSelectedTenantId] = useState<string | null>(null);
  const [tenantNameDraft, setTenantNameDraft] = useState("");
  const [activeDetailTab, setActiveDetailTab] = useState<TenantDetailTab>("config");
  const [nameSaving, setNameSaving] = useState(false);
  const [nameSaved, setNameSaved] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [modelPolicyActions, setModelPolicyActions] = useState<ReactNode | null>(null);

  const openCreate = () => {
    setShowForm(true);
  };

  const usersByTenant = useMemo(() => {
    const map = new Map<string, UserInfo[]>();
    for (const user of users) {
      const list = map.get(user.tenantId) ?? [];
      list.push(user);
      map.set(user.tenantId, list);
    }
    return map;
  }, [users]);

  useEffect(() => {
    if (tenants.length === 0) {
      if (selectedTenantId !== null) setSelectedTenantId(null);
      return;
    }
    if (!selectedTenantId || !tenants.some((tenant) => tenant.id === selectedTenantId)) {
      setSelectedTenantId(tenants[0].id);
    }
  }, [selectedTenantId, tenants]);

  const selectedTenant = tenants.find((tenant) => tenant.id === selectedTenantId) ?? tenants[0] ?? null;
  const selectedUsers = selectedTenant ? (usersByTenant.get(selectedTenant.id) ?? []) : [];
  const selectedAdmins = selectedUsers.filter(user => user.role === "admin");
  const selectedSettings = selectedTenant?.settings ?? DEFAULT_TENANT_SETTINGS;
  const nameChanged = Boolean(selectedTenant && tenantNameDraft.trim() && tenantNameDraft.trim() !== selectedTenant.name);

  useEffect(() => {
    setTenantNameDraft(selectedTenant?.name ?? "");
    setNameError(null);
    setNameSaved(false);
  }, [selectedTenant?.id, selectedTenant?.name]);

  const saveTenantName = async () => {
    if (!selectedTenant) return;
    const nextName = tenantNameDraft.trim();
    if (!nextName) {
      setNameError("请输入组织名称");
      return;
    }
    if (nextName === selectedTenant.name) return;
    setNameSaving(true);
    try {
      await updateTenant(selectedTenant.id, { name: nextName });
      setNameSaved(true);
      setNameError(null);
    } catch (err) {
      setNameError(err instanceof Error ? err.message : String(err));
    } finally {
      setNameSaving(false);
    }
  };

  const requestToggleTenantDisabled = (tenant: Tenant) => {
    if (tenant.disabled) {
      setDisableError(null);
      setTenantDisabled(tenant.id, false).catch((err) => {
        setDisableError(err instanceof Error ? err.message : String(err));
      });
      return;
    }
    setDisableTarget(tenant);
    setDisableError(null);
  };

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col">
      <SettingsPanelHeader
        title="组织管理"
        description="管理平台组织与成员归属。"
        actions={
          <>
            <Select value={selectedTenant?.id ?? ""} onValueChange={setSelectedTenantId} disabled={loading || tenants.length === 0}>
              <SelectTrigger className="w-[260px]">
                <SelectValue placeholder={loading ? "加载组织中" : "选择组织"} />
              </SelectTrigger>
              <SelectContent>
                {tenants.map((tenant) => (
                  <SelectItem key={tenant.id} value={tenant.id}>
                    {tenant.name} · {tenant.id}{tenant.disabled ? " · 停用" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {activeDetailTab === "config" && selectedTenant && (
              <>
                {nameSaved && <Badge variant="secondary" className="gap-1"><CheckCircle2 className="h-3 w-3" />已保存</Badge>}
                <Button size="sm" onClick={() => { void saveTenantName(); }} disabled={!nameChanged || nameSaving}>
                  {nameSaving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-1.5 h-3.5 w-3.5" />}
                  保存名称
                </Button>
              </>
            )}
            {activeDetailTab === "models" && modelPolicyActions}
            <Button variant="outline" size="sm" onClick={refreshAll} disabled={loading}>
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              刷新
            </Button>
            <Button size="sm" onClick={openCreate}>
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              新建组织
            </Button>
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="flex h-full min-h-0 flex-col">
          {error && (
            <div className="mb-4 shrink-0 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
          {disableError && !disableTarget && (
            <div className="mb-4 shrink-0 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {disableError}
            </div>
          )}

          {!selectedTenant ? (
            <div className="min-h-0 flex-1 overflow-auto">
              <Card className="h-fit">
                <CardContent className="py-10 text-center text-sm text-muted-foreground">暂无组织</CardContent>
              </Card>
            </div>
          ) : (
          <Tabs value={activeDetailTab} onValueChange={(value) => setActiveDetailTab(value as TenantDetailTab)} className="flex min-h-0 flex-1 flex-col">
            <div className="rounded-lg border bg-card p-1 shadow-sm">
              <TabsList className="grid h-auto w-full grid-cols-2 gap-1 bg-transparent p-0 text-muted-foreground lg:grid-cols-4">
                {tenantDetailTabs.map((tab) => {
                  const Icon = tab.icon;
                  return (
                    <TabsTrigger
                      key={tab.id}
                      value={tab.id}
                      className="h-9 gap-2 rounded-md px-3 data-[state=active]:bg-brand-accent-soft data-[state=active]:text-foreground data-[state=active]:shadow-none"
                    >
                      <Icon className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{tab.label}</span>
                    </TabsTrigger>
                  );
                })}
              </TabsList>
            </div>

            <div className="min-h-0 flex-1 overflow-auto pt-4">
            <TabsContent value="config" forceMount className="mt-0">
              <Card>
                <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-3">
                  <div className="min-w-0">
                    <CardTitle className="text-base">基本信息</CardTitle>
                    <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{selectedTenant.id}</p>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  {nameError && <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{nameError}</div>}
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label>组织名称</Label>
                      <Input value={tenantNameDraft} onChange={(event) => { setTenantNameDraft(event.target.value); setNameSaved(false); }} />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Slug</Label>
                      <Input value={selectedTenant.id} disabled className="font-mono" />
                    </div>
                  </div>
                  <div className="grid gap-3 md:grid-cols-4">
                    <TenantMetric label="状态" value={selectedTenant.disabled ? "已禁用" : "启用中"} />
                    <TenantMetric label="成员" value={selectedUsers.length} />
                    <TenantMetric label="管理员" value={selectedAdmins.length} />
                    <TenantMetric label="模型策略" value={selectedSettings.models.allowedModels.length ? `${selectedSettings.models.allowedModels.length} 个自定义模型` : "继承平台"} />
                  </div>
                  <div className="grid gap-3 md:grid-cols-2">
                    <TenantMetric label="创建时间" value={formatDateTime(selectedTenant.createdAt)} />
                    <TenantMetric label="更新时间" value={formatDateTime(selectedTenant.updatedAt)} />
                  </div>
                  <div className="flex justify-end">
                    <Button
                      variant={selectedTenant.disabled ? "outline" : "destructive"}
                      size="sm"
                      onClick={() => requestToggleTenantDisabled(selectedTenant)}
                    >
                      {selectedTenant.disabled ? <Power className="mr-1.5 h-3.5 w-3.5" /> : <PowerOff className="mr-1.5 h-3.5 w-3.5" />}
                      {selectedTenant.disabled ? "启用组织" : "禁用组织"}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="members" forceMount className="mt-0">
              <TenantMembersPanel users={selectedUsers} loading={usersLoading} error={usersError} />
            </TabsContent>

            <TabsContent value="models" forceMount className="mt-0">
              <TenantModelPolicyPanel tenant={selectedTenant} onActionsChange={setModelPolicyActions} />
            </TabsContent>

            <TabsContent value="capabilities" forceMount className="mt-0">
              <TenantCapabilitiesPanel tenant={selectedTenant} />
            </TabsContent>
            </div>
          </Tabs>
          )}
        </div>
      </div>

      <TenantFormDialog
        open={showForm}
        onOpenChange={setShowForm}
        editingTenant={null}
        onCreate={createTenant}
        onUpdate={updateTenant}
      />

      <Dialog
        open={disableTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDisableTarget(null);
            setDisableError(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>禁用组织</DialogTitle>
            <DialogDescription>
              禁用后，组织 <strong>{disableTarget?.name}</strong>
              （slug: <code className="font-mono">{disableTarget?.id}</code>）
              将被标记为禁用状态。Slug 仍占用，组织下用户/会话保留，但禁止接入新资源。
            </DialogDescription>
          </DialogHeader>
          {disableError && (
            <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {disableError}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="outline"
              onClick={() => {
                setDisableTarget(null);
                setDisableError(null);
              }}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={async () => {
                if (!disableTarget) return;
                try {
                  await setTenantDisabled(disableTarget.id, true);
                  setDisableTarget(null);
                  setDisableError(null);
                } catch (err) {
                  setDisableError(
                    err instanceof Error ? err.message : String(err),
                  );
                }
              }}
            >
              禁用
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

import { useCallback, useEffect, useState } from "react";
import { governanceAccessApi } from "@agent/shared/lib/governanceApi";
import { AdminSelect, type AdminSelectOption } from "@/components/ui/admin-select";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { SETTINGS_CONTENT_WIDTH, SettingsPanelHeader } from "@/components/SettingsCenter/SettingsPanelHeader";
import { useAuth } from "@/contexts/AuthContext";
import { authFetch } from "@/lib/authFetch";
import { refreshAll } from "@/lib/refreshBus";
import { cn } from "@/lib/utils";
import { DEFAULT_TENANT_ID, DEFAULT_TENANT_SETTINGS, type TenantSettings } from "@/components/TenantManager/types";
import type { ModelList } from "@/types/models";

function cloneTenantSettings(settings: TenantSettings): TenantSettings {
  return {
    features: { ...settings.features },
    quotas: { ...settings.quotas },
    models: { ...settings.models, allowedModels: [...settings.models.allowedModels], displayOverrides: { ...(settings.models.displayOverrides ?? {}) } },
    mcp: { ...settings.mcp, defaultEnabledServerIds: [...settings.mcp.defaultEnabledServerIds] },
    branding: { ...settings.branding },
    personalization: { ...settings.personalization },
    security: { ...settings.security },
  };
}

function splitLines(value: string): string[] {
  return value.split(/[\n,]/).map(v => v.trim()).filter(Boolean);
}

function numericValue(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function SettingSwitch({
  label,
  description,
  checked,
  onCheckedChange,
  disabled = false,
}: {
  label: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className={`flex items-start justify-between gap-4 rounded-xl border p-3 ${disabled ? "opacity-70" : ""}`}>
      <div>
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs leading-5 text-muted-foreground">{description}</div>
      </div>
      <Switch checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} />
    </div>
  );
}

type TenantSettingsPanelSection = "all" | "model-tools" | "brand" | "security";

type GovernedTenantSettingsResponse = {
  tenantId: string;
  settings: TenantSettings;
  updatedAt: string;
};

export function TenantSettingsPanel({
  tenantId,
  section = "all",
}: {
  tenantId: string;
  section?: TenantSettingsPanelSection;
}) {
  const { isPlatformAdmin, canPlatform } = useAuth();
  const readOnly = isPlatformAdmin
    && (tenantId === DEFAULT_TENANT_ID || !canPlatform("customer_config.manage"));
  const [settings, setSettings] = useState<TenantSettings>(() => cloneTenantSettings(DEFAULT_TENANT_SETTINGS));
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [defaultMcpText, setDefaultMcpText] = useState("");
  const [modelList, setModelList] = useState<ModelList | null>(null);
  const [settingsUpdatedAt, setSettingsUpdatedAt] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!tenantId) return;
    setLoading(true);
    try {
      const data = await governanceAccessApi.getTenantSettings<GovernedTenantSettingsResponse>(tenantId);
      setSettings(data.settings);
      setSettingsUpdatedAt(data.updatedAt);
      setDefaultMcpText(data.settings.mcp.defaultEnabledServerIds.join("\n"));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (section !== "all" && section !== "model-tools") return;
    let cancelled = false;
    authFetch("/api/models")
      .then(async (res) => (res.ok ? (await res.json() as ModelList) : null))
      .then((next) => {
        if (!cancelled) setModelList(next);
      })
      .catch(() => {
        if (!cancelled) setModelList(null);
      });
    return () => { cancelled = true; };
  }, [section]);

  const patch = useCallback((recipe: (draft: TenantSettings) => void) => {
    setSettings((prev: TenantSettings) => {
      const draft = cloneTenantSettings(prev);
      recipe(draft);
      return draft;
    });
    setSaved(false);
  }, []);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      if (!settingsUpdatedAt) throw new Error("组织设置版本不可用，请刷新后重试");
      const payload = cloneTenantSettings(settings);
      payload.mcp.defaultEnabledServerIds = splitLines(defaultMcpText);
      const data = await governanceAccessApi.updateTenantSettings<GovernedTenantSettingsResponse>(tenantId, {
        settings: payload,
        expectedUpdatedAt: settingsUpdatedAt,
      });
      setSettings(data.settings);
      setSettingsUpdatedAt(data.updatedAt);
      setDefaultMcpText(data.settings.mcp.defaultEnabledServerIds.join("\n"));
      await refreshAll();
      setSaved(true);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [defaultMcpText, settings, settingsUpdatedAt, tenantId]);

  const modelOptions = modelList?.groups.flatMap(group =>
    group.models.map(model => ({
      ref: `${group.id}/${model.id}`,
      label: settings.models.showGroupNames ? `${group.name}/${model.name}` : model.name,
    })),
  ) ?? [];

  const defaultModelOptions: AdminSelectOption[] = [
    { value: "", label: "继承平台默认" },
    ...modelOptions.map(model => ({ value: model.ref, label: model.label })),
  ];

  const toggleAllowedModel = useCallback((modelRef: string, checked: boolean) => {
    patch(d => {
      d.models.allowedModels = checked
        ? Array.from(new Set([...d.models.allowedModels, modelRef]))
        : d.models.allowedModels.filter(ref => ref !== modelRef);
      if (d.models.defaultModel === modelRef && !checked) d.models.defaultModel = undefined;
    });
  }, [patch]);

  const sectionCopy: Record<TenantSettingsPanelSection, { title: string; description: string }> = {
    all: {
      title: "组织管理",
      description: `配置组织 ${tenantId} 的功能开关、配额、模型、MCP、安全和品牌策略。`,
    },
    "model-tools": {
      title: "模型与工具",
      description: `配置组织 ${tenantId} 可用的模型与 MCP 策略。`,
    },
    brand: {
      title: "品牌",
      description: `配置组织 ${tenantId} 的显示名称、Logo 和主色。`,
    },
    security: {
      title: "登录与安全",
      description: `配置组织 ${tenantId} 的密码、会话和钉钉绑定策略。`,
    },
  };
  const showGeneral = section === "all";
  const showModelTools = section === "all" || section === "model-tools";
  const showBrand = section === "all" || section === "brand";
  const showSecurity = section === "all" || section === "security";

  return (
    <div className={cn("flex h-full min-h-0 flex-col", SETTINGS_CONTENT_WIDTH)}>
      <SettingsPanelHeader
        title={sectionCopy[section].title}
        description={sectionCopy[section].description}
        actions={<Button onClick={() => { void save(); }} disabled={readOnly || loading || saving}>{saving ? "保存中..." : "保存设置"}</Button>}
      />
      <fieldset disabled={readOnly} className="min-h-0 flex-1 space-y-5 overflow-auto">
      {error && <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}
      {saved && <div className="rounded-md bg-success/10 px-3 py-2 text-sm text-success">组织管理已保存</div>}
      <div className="grid gap-4 xl:grid-cols-2">
        {showGeneral && <>
        <Card>
          <CardHeader><CardTitle className="text-base">功能开关</CardTitle></CardHeader>
          <CardContent className="grid gap-3">
            <SettingSwitch label="文件能力" description="允许组织用户访问文件浏览、上传和预览。" checked={settings.features.filesEnabled} onCheckedChange={checked => patch(d => { d.features.filesEnabled = checked; })} />
            <SettingSwitch label="定时任务" description="允许创建和运行 Cron 自动化任务。" checked={settings.features.cronEnabled} onCheckedChange={checked => patch(d => { d.features.cronEnabled = checked; })} />
            <SettingSwitch label="MCP 工具" description="允许组织使用 MCP 服务与工具密钥。" checked={settings.features.mcpEnabled} onCheckedChange={checked => patch(d => { d.features.mcpEnabled = checked; })} />
            <SettingSwitch label="自定义技能" description="允许用户维护自己的技能。" checked={settings.features.customSkillsEnabled} onCheckedChange={checked => patch(d => { d.features.customSkillsEnabled = checked; })} />
            <SettingSwitch label="调试模式" description="允许开启思考、工具和执行细节展示。" checked={settings.features.debugModeAllowed} onCheckedChange={checked => patch(d => { d.features.debugModeAllowed = checked; })} />
            <SettingSwitch label="自动压缩上下文" description="会话上下文达到各模型配置的触发线时，回合结束后自动压缩（还需模型配置上下文窗口）。" checked={settings.features.autoCompactEnabled} onCheckedChange={checked => patch(d => { d.features.autoCompactEnabled = checked; })} />
            <SettingSwitch
              label="AI 生图"
              description="平台托管的付费能力，仅平台管理员可为组织开通；此处只读展示当前授权状态。"
              checked={settings.features.imageGenEnabled === true}
              onCheckedChange={() => undefined}
              disabled
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">配额</CardTitle></CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            {[
              ["maxUsers", "用户数上限"],
              ["maxAdmins", "管理员上限"],
              ["maxStorageMb", "存储上限 MB"],
              ["monthlyTokenLimit", "月 Token 上限"],
              ["maxTurnsPerRequest", "单次最大轮数"],
              ["rateLimitMaxRequests", "限流请求数"],
            ].map(([key, label]) => (
              <div key={key} className="space-y-1.5">
                <Label>{label}</Label>
                <Input
                  type="number"
                  min={1}
                  value={settings.quotas[key as keyof TenantSettings["quotas"]] ?? ""}
                  onChange={event => patch(d => { d.quotas[key as keyof TenantSettings["quotas"]] = numericValue(event.target.value); })}
                  placeholder="不限制"
                />
              </div>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">个性化</CardTitle></CardHeader>
          <CardContent className="grid gap-3">
            <SettingSwitch
              label="首日新手引导条"
              description="在聊天输入框下方展示首日引导。默认关闭，需要时按组织开启。"
              checked={settings.personalization.firstDayGuideBarEnabled}
              onCheckedChange={checked => patch(d => { d.personalization.firstDayGuideBarEnabled = checked; })}
            />
          </CardContent>
        </Card>
        </>}
        {showModelTools && <>
        <Card>
          <CardHeader><CardTitle className="text-base">模型策略</CardTitle></CardHeader>
          <CardContent className="grid gap-3">
            <div className="space-y-1.5">
              <Label>默认模型</Label>
              <AdminSelect
                ariaLabel="默认模型"
                size="md"
                className="w-full"
                options={defaultModelOptions}
                value={settings.models.defaultModel ?? ""}
                onValueChange={value => patch(d => { d.models.defaultModel = value || undefined; })}
              />
            </div>
            <SettingSwitch label="允许用户切换模型" description="关闭后可在后续运行时策略中限制用户只能使用默认模型。" checked={settings.models.allowUserModelSwitch} onCheckedChange={checked => patch(d => { d.models.allowUserModelSwitch = checked; })} />
            <SettingSwitch label="显示分组名" description="模型选择器中显示模型分组标题。" checked={!!settings.models.showGroupNames} onCheckedChange={checked => patch(d => { d.models.showGroupNames = checked; })} />
            <div className="space-y-2">
              <div>
                <Label>可用模型白名单</Label>
                <p className="mt-1 text-xs text-muted-foreground">不勾选任何模型表示继承平台默认可用范围。</p>
              </div>
              {modelOptions.length === 0 ? (
                <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">模型列表加载中或暂无可选模型。</div>
              ) : (
                <div className="grid max-h-56 gap-2 overflow-auto rounded-md border p-3 sm:grid-cols-2">
                  {modelOptions.map(model => (
                    <label key={model.ref} className="flex items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={settings.models.allowedModels.includes(model.ref)}
                        onChange={event => toggleAllowedModel(model.ref, event.target.checked)}
                      />
                      <span>
                        <span className="block font-medium">{model.label}</span>
                        <span className="block text-xs text-muted-foreground">{model.ref}</span>
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">MCP 策略</CardTitle></CardHeader>
          <CardContent className="grid gap-3">
            <SettingSwitch label="允许组织 MCP" description="允许组织管理员维护本组织共享 MCP 服务。" checked={settings.mcp.allowTenantServers} onCheckedChange={checked => patch(d => { d.mcp.allowTenantServers = checked; })} />
            <SettingSwitch label="允许全局 MCP" description="允许组织用户使用平台全局 MCP 服务。" checked={settings.mcp.allowGlobalServers} onCheckedChange={checked => patch(d => { d.mcp.allowGlobalServers = checked; })} />
            <div className="space-y-1.5">
              <Label>默认启用 MCP 服务 ID</Label>
              <textarea autoComplete="off" className="min-h-24 w-full rounded-md border bg-background px-3 py-2 text-sm" value={defaultMcpText} onChange={event => { setDefaultMcpText(event.target.value); setSaved(false); }} placeholder="每行一个服务 ID" />
            </div>
          </CardContent>
        </Card>
        </>}
        {showBrand && <Card>
          <CardHeader><CardTitle className="text-base">品牌</CardTitle></CardHeader>
          <CardContent className="grid gap-3">
            <div className="space-y-1.5"><Label>显示名称</Label><Input value={settings.branding.displayName ?? ""} onChange={event => patch(d => { d.branding.displayName = event.target.value.trim() || undefined; })} /></div>
            <div className="space-y-1.5"><Label>Logo 地址</Label><Input value={settings.branding.logoUrl ?? ""} onChange={event => patch(d => { d.branding.logoUrl = event.target.value.trim() || undefined; })} /></div>
            <div className="space-y-1.5"><Label>主色</Label><Input value={settings.branding.primaryColor ?? ""} onChange={event => patch(d => { d.branding.primaryColor = event.target.value.trim() || undefined; })} placeholder="#2563eb" /></div>
          </CardContent>
        </Card>}
        {showSecurity && <Card>
          <CardHeader><CardTitle className="text-base">安全</CardTitle></CardHeader>
          <CardContent className="grid gap-3">
            <div className="space-y-1.5"><Label>密码最小长度</Label><Input type="number" min={1} value={settings.security.passwordMinLength ?? ""} onChange={event => patch(d => { d.security.passwordMinLength = numericValue(event.target.value); })} placeholder="系统默认" /></div>
            <div className="space-y-1.5"><Label>会话有效期（小时）</Label><Input type="number" min={1} value={settings.security.sessionTtlHours ?? ""} onChange={event => patch(d => { d.security.sessionTtlHours = numericValue(event.target.value); })} placeholder="系统默认" /></div>
            <SettingSwitch label="要求钉钉绑定" description="开启后可作为后续登录策略和成员校验依据。" checked={settings.security.requireDingtalkBinding} onCheckedChange={checked => patch(d => { d.security.requireDingtalkBinding = checked; })} />
          </CardContent>
        </Card>}
      </div>
      </fieldset>
    </div>
  );
}

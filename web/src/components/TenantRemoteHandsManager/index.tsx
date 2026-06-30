import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, KeyRound, Loader2, Plus, RefreshCw, Save, ServerCog, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { SettingsPanelHeader } from "@/components/SettingsCenter/SettingsPanelHeader";
import { SettingsTwoColumn } from "@/components/SettingsCenter/SettingsTwoColumn";
import { useTenants } from "@/components/TenantManager/hooks";
import { useUsers } from "@/components/UserManager/hooks";
import { cn } from "@/lib/utils";
import { useTenantRemoteHands } from "./hooks";
import type {
  CredentialMode,
  EditableTenantRemoteHand,
  HealthState,
  NetworkPolicyConfig,
  NetworkPolicyMode,
  RolloutEditorMode,
  TenantRemoteHandConfig,
  TenantRemoteHandRolloutMode,
  TenantRemoteHandUpdate,
} from "./types";

const HAND_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/;
const DEFAULT_NETWORK_POLICY: NetworkPolicyConfig = { mode: "public-egress", denyPrivateNetworks: true };
const CIDR_PATTERN = /^(?:\d{1,3}\.){3}\d{1,3}\/(?:\d|[12]\d|3[0-2])$|^[0-9a-fA-F:]+\/(?:\d|[1-9]\d|1[01]\d|12[0-8])$/;
const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;

function splitLines(value: string): string[] {
  const seen = new Set<string>();
  const items = value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
  return items.filter((item) => {
    if (seen.has(item)) return false;
    seen.add(item);
    return true;
  });
}

function joinLines(values?: string[]): string {
  return (values ?? []).join("\n");
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function requireList(label: string, values: string[], pattern: RegExp): string[] {
  for (const value of values) {
    if (!pattern.test(value)) throw new Error(`${label} 非法: ${value}`);
  }
  return values;
}

function inferLegacyRolloutMode(hand: TenantRemoteHandConfig): TenantRemoteHandRolloutMode {
  if ((hand.users?.length ?? 0) > 0) return "allowlist";
  if ((hand.tenantIds?.length ?? 0) > 0) return "tenant";
  return "all";
}

function toEditable(hand: TenantRemoteHandConfig, index: number): EditableTenantRemoteHand {
  const rolloutMode = hand.rollout?.mode ?? inferLegacyRolloutMode(hand);
  const networkPolicy = hand.networkPolicy ?? DEFAULT_NETWORK_POLICY;
  return {
    clientKey: `${hand.id || "hand"}:${index}`,
    originalId: hand.id,
    isNew: false,
    id: hand.id,
    description: hand.description ?? "",
    baseUrl: hand.baseUrl,
    invokeTimeoutMsText: hand.invokeTimeoutMs ? String(hand.invokeTimeoutMs) : "",
    recipe: hand.recipe,
    legacyUsersText: joinLines(hand.users),
    legacyTenantIdsText: joinLines(hand.tenantIds),
    rolloutEditorMode: hand.rollout ? "explicit" : "legacy",
    rolloutMode,
    rolloutUserIds: hand.rollout?.userIds ?? [],
    rolloutUsernamesText: joinLines(hand.rollout?.usernames),
    rolloutTenantIds: hand.rollout?.tenantIds ?? [],
    networkPolicyMode: networkPolicy.mode,
    networkDenyPrivateNetworks: networkPolicy.denyPrivateNetworks ?? true,
    networkAllowCidrsText: joinLines(networkPolicy.allowCidrs),
    networkAllowDomainsText: joinLines(networkPolicy.allowDomains),
    networkDenyCidrsText: joinLines(networkPolicy.denyCidrs),
    credentialMode: hand.authTokenConfigured || hand.authTokenRef ? "preserve" : "ref",
    authTokenInput: "",
    authTokenRef: hand.authTokenRef ?? "",
    authTokenConfigured: !!hand.authTokenConfigured,
  };
}

function createEmptyHand(existing: EditableTenantRemoteHand[]): EditableTenantRemoteHand {
  let suffix = existing.length + 1;
  let id = `tenant-hand-${suffix}`;
  const ids = new Set(existing.map((hand) => hand.id));
  while (ids.has(id)) {
    suffix += 1;
    id = `tenant-hand-${suffix}`;
  }
  return {
    clientKey: `new:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    originalId: null,
    isNew: true,
    id,
    description: "",
    baseUrl: "",
    invokeTimeoutMsText: "",
    legacyUsersText: "",
    legacyTenantIdsText: "",
    rolloutEditorMode: "explicit",
    rolloutMode: "disabled",
    rolloutUserIds: [],
    rolloutUsernamesText: "",
    rolloutTenantIds: [],
    networkPolicyMode: DEFAULT_NETWORK_POLICY.mode,
    networkDenyPrivateNetworks: DEFAULT_NETWORK_POLICY.denyPrivateNetworks ?? true,
    networkAllowCidrsText: "",
    networkAllowDomainsText: "",
    networkDenyCidrsText: "",
    credentialMode: "ref",
    authTokenInput: "",
    authTokenRef: "",
    authTokenConfigured: false,
  };
}

function validateBaseUrl(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Base URL 必须是合法 URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Base URL 只允许 http 或 https");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Base URL 不能包含用户名或密码");
  }
}

function buildRollout(hand: EditableTenantRemoteHand) {
  if (hand.rolloutMode === "disabled" || hand.rolloutMode === "drain" || hand.rolloutMode === "all") {
    return { mode: hand.rolloutMode };
  }
  if (hand.rolloutMode === "allowlist") {
    const userIds = unique(hand.rolloutUserIds);
    const usernames = splitLines(hand.rolloutUsernamesText);
    if (userIds.length + usernames.length === 0) {
      throw new Error(`${hand.id}: 用户白名单至少选择一个用户或填写一个 username`);
    }
    return {
      mode: "allowlist" as const,
      ...(userIds.length > 0 ? { userIds } : {}),
      ...(usernames.length > 0 ? { usernames } : {}),
    };
  }
  const tenantIds = unique(hand.rolloutTenantIds);
  if (tenantIds.length === 0) throw new Error(`${hand.id}: 按组织 rollout 至少选择一个组织`);
  return { mode: "tenant" as const, tenantIds };
}

function buildNetworkPolicy(hand: EditableTenantRemoteHand) {
  const allowCidrs = requireList(`${hand.id}: allowCidrs`, splitLines(hand.networkAllowCidrsText), CIDR_PATTERN);
  const allowDomains = requireList(`${hand.id}: allowDomains`, splitLines(hand.networkAllowDomainsText), DOMAIN_PATTERN);
  const denyCidrs = requireList(`${hand.id}: denyCidrs`, splitLines(hand.networkDenyCidrsText), CIDR_PATTERN);
  if (hand.networkPolicyMode !== "private-egress" && (allowCidrs.length > 0 || allowDomains.length > 0)) {
    throw new Error(`${hand.id}: allowCidrs/allowDomains 只允许 private-egress 使用`);
  }
  return {
    mode: hand.networkPolicyMode,
    denyPrivateNetworks: hand.networkDenyPrivateNetworks,
    ...(allowCidrs.length > 0 ? { allowCidrs } : {}),
    ...(allowDomains.length > 0 ? { allowDomains } : {}),
    ...(denyCidrs.length > 0 ? { denyCidrs } : {}),
  };
}

function isDefaultNetworkPolicy(policy: NetworkPolicyConfig): boolean {
  return policy.mode === DEFAULT_NETWORK_POLICY.mode
    && (policy.denyPrivateNetworks ?? true) === (DEFAULT_NETWORK_POLICY.denyPrivateNetworks ?? true)
    && (policy.allowCidrs?.length ?? 0) === 0
    && (policy.allowDomains?.length ?? 0) === 0
    && (policy.denyCidrs?.length ?? 0) === 0;
}

function buildHandPayload(hand: EditableTenantRemoteHand): TenantRemoteHandUpdate {
  const id = hand.id.trim();
  const baseUrl = hand.baseUrl.trim();
  if (!HAND_ID_PATTERN.test(id)) {
    throw new Error(`${id || "未命名执行环境池"}: ID 格式不合法`);
  }
  if (!baseUrl) throw new Error(`${id}: Base URL 必填`);
  validateBaseUrl(baseUrl);

  const next: TenantRemoteHandUpdate = { id, baseUrl };
  const description = hand.description.trim();
  if (description) next.description = description;
  const timeoutText = hand.invokeTimeoutMsText.trim();
  if (timeoutText) {
    const timeout = Number(timeoutText);
    if (!Number.isInteger(timeout) || timeout <= 0 || timeout > 600_000) {
      throw new Error(`${id}: Invoke timeout 必须是 1 到 600000 之间的整数`);
    }
    next.invokeTimeoutMs = timeout;
  }
  if (hand.recipe !== undefined) next.recipe = hand.recipe;
  const networkPolicy = buildNetworkPolicy(hand);
  if (!isDefaultNetworkPolicy(networkPolicy)) next.networkPolicy = networkPolicy;

  if (hand.rolloutEditorMode === "legacy") {
    const users = splitLines(hand.legacyUsersText);
    const tenantIds = splitLines(hand.legacyTenantIdsText);
    if (users.length > 0) next.users = users;
    if (tenantIds.length > 0) next.tenantIds = tenantIds;
  } else {
    next.rollout = buildRollout(hand);
  }

  if (hand.credentialMode === "preserve") {
    if (!hand.originalId || id !== hand.originalId) {
      throw new Error(`${id}: 改 ID 时不能保留旧凭据，请替换 token 或使用 authTokenRef`);
    }
    if (!hand.authTokenConfigured && !hand.authTokenRef) {
      throw new Error(`${id}: 没有可保留的旧凭据`);
    }
  } else if (hand.credentialMode === "inline") {
    const token = hand.authTokenInput.trim();
    if (token.length < 8) throw new Error(`${id}: 明文 token 至少 8 位`);
    next.authToken = token;
  } else {
    const ref = hand.authTokenRef.trim();
    if (!ref) throw new Error(`${id}: authTokenRef 必填`);
    next.authTokenRef = ref;
  }
  return next;
}

function buildPayload(hands: EditableTenantRemoteHand[]): TenantRemoteHandUpdate[] {
  const seen = new Set<string>();
  return hands.map((hand) => {
    const payload = buildHandPayload(hand);
    if (seen.has(payload.id)) throw new Error(`重复的执行环境池 ID: ${payload.id}`);
    seen.add(payload.id);
    return payload;
  });
}

function healthBadge(health?: HealthState) {
  if (!health || health.status === "idle") return <Badge variant="secondary">未检查</Badge>;
  if (health.status === "checking") return <Badge variant="outline" className="gap-1"><Loader2 className="h-3 w-3 animate-spin" />检查中</Badge>;
  if (health.status === "ok") return <Badge className="bg-emerald-600 text-white hover:bg-emerald-600">健康</Badge>;
  return <Badge variant="destructive">异常</Badge>;
}

function rolloutLabel(hand: EditableTenantRemoteHand): string {
  if (hand.rolloutEditorMode === "legacy") {
    if (hand.legacyUsersText.trim() && hand.legacyTenantIdsText.trim()) return "Legacy 联合";
    if (hand.legacyUsersText.trim()) return "Legacy 用户";
    if (hand.legacyTenantIdsText.trim()) return "Legacy 组织";
    return "Legacy 全部";
  }
  if (hand.rolloutMode === "disabled") return "停用";
  if (hand.rolloutMode === "drain") return "维护模式";
  if (hand.rolloutMode === "allowlist") return "用户白名单";
  if (hand.rolloutMode === "tenant") return "按组织";
  return "全部用户";
}

function credentialLabel(hand: EditableTenantRemoteHand): string {
  if (hand.credentialMode === "inline" && hand.authTokenInput.trim()) return "替换 token";
  if (hand.credentialMode === "ref" && hand.authTokenRef.trim()) return "Vault ref";
  if (hand.authTokenRef) return "Vault ref";
  if (hand.authTokenConfigured) return "Token 已配置";
  return "未配置";
}

function networkPolicyLabel(hand: EditableTenantRemoteHand): string {
  if (hand.networkPolicyMode === "isolated") return "无网络";
  if (hand.networkPolicyMode === "private-egress") return "私网白名单";
  return hand.networkDenyPrivateNetworks ? "公网出站" : "公网出站+私网";
}

function MetadataBlock({ value }: { value: unknown }) {
  if (value === undefined) return null;
  return (
    <pre className="mt-3 max-h-48 overflow-auto rounded-md border bg-muted/30 p-3 text-xs">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function healthDetail(health?: HealthState): string | undefined {
  return health?.status === "unhealthy" ? health.detail : undefined;
}

function healthMetadata(health?: HealthState): unknown {
  return health?.status === "ok" || health?.status === "unhealthy" ? health.metadata : undefined;
}

export function TenantRemoteHandsManager() {
  const { config, loading, saving, error, savedAt, healthById, refresh, save, probeHealth } = useTenantRemoteHands();
  const { users, loading: usersLoading } = useUsers();
  const { tenants, loading: tenantsLoading } = useTenants();
  const [draftHands, setDraftHands] = useState<EditableTenantRemoteHand[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [userSearch, setUserSearch] = useState("");
  const [tenantSearch, setTenantSearch] = useState("");

  useEffect(() => {
    if (!config) return;
    const next = config.hands.map(toEditable);
    setDraftHands(next);
    setSelectedKey((current) => current && next.some((hand) => hand.clientKey === current) ? current : next[0]?.clientKey ?? null);
    setLocalError(null);
    setDirty(false);
  }, [config]);

  const selectedHand = useMemo(
    () => draftHands.find((hand) => hand.clientKey === selectedKey) ?? null,
    [draftHands, selectedKey],
  );

  const tenantsById = useMemo(() => new Map(tenants.map((tenant) => [tenant.id, tenant])), [tenants]);

  const updateSelected = useCallback((updater: (hand: EditableTenantRemoteHand) => EditableTenantRemoteHand) => {
    setDraftHands((current) => current.map((hand) => hand.clientKey === selectedKey ? updater(hand) : hand));
    setDirty(true);
    setLocalError(null);
  }, [selectedKey]);

  const addHand = useCallback(() => {
    setDraftHands((current) => {
      const nextHand = createEmptyHand(current);
      setSelectedKey(nextHand.clientKey);
      return [...current, nextHand];
    });
    setDirty(true);
    setLocalError(null);
  }, []);

  const removeSelected = useCallback(() => {
    if (!selectedHand) return;
    const label = selectedHand.id || "未命名执行环境池";
    if (!window.confirm(`删除 ${label}？保存后会从配置中移除该执行环境池。`)) return;
    setDraftHands((current) => {
      const next = current.filter((hand) => hand.clientKey !== selectedHand.clientKey);
      setSelectedKey(next[0]?.clientKey ?? null);
      return next;
    });
    setDirty(true);
    setLocalError(null);
  }, [selectedHand]);

  const handleSave = useCallback(async () => {
    try {
      setLocalError(null);
      const payload = buildPayload(draftHands);
      const allHands = draftHands.filter((hand) => hand.rolloutEditorMode === "explicit" && hand.rolloutMode === "all");
      if (allHands.length > 0 && !window.confirm(`确认启用全部用户模式？涉及：${allHands.map((hand) => hand.id).join(", ")}`)) {
        return;
      }
      const saved = await save(payload);
      const next = saved.hands.map(toEditable);
      setDraftHands(next);
      setSelectedKey((current) => current && next.some((hand) => hand.clientKey === current) ? current : next[0]?.clientKey ?? null);
      setDirty(false);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    }
  }, [draftHands, save]);

  const handleHealth = useCallback(async () => {
    if (!selectedHand) return;
    if (dirty && !window.confirm("健康检查使用服务端已保存配置，不包含当前未保存改动。继续检查？")) return;
    try {
      setLocalError(null);
      await probeHealth(selectedHand.id);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    }
  }, [dirty, probeHealth, selectedHand]);

  const filteredUsers = useMemo(() => {
    const query = userSearch.trim().toLowerCase();
    if (!query) return users;
    return users.filter((user) => {
      const tenantName = tenantsById.get(user.tenantId)?.name ?? "";
      return [user.id, user.username, user.realName ?? "", user.tenantId, tenantName]
        .some((part) => part.toLowerCase().includes(query));
    });
  }, [tenantsById, userSearch, users]);

  const filteredTenants = useMemo(() => {
    const query = tenantSearch.trim().toLowerCase();
    if (!query) return tenants;
    return tenants.filter((tenant) => [tenant.id, tenant.name].some((part) => part.toLowerCase().includes(query)));
  }, [tenantSearch, tenants]);

  if (loading && !config) {
    return <div className="flex flex-1 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col">
      <SettingsPanelHeader
        title="执行环境池"
        description="管理 Agent 执行命令、读写文件的执行环境池。每个池按租户/用户灰度，按需拉起具体的执行环境（如 ACS 沙箱、未来的客户端等）。保存后写回 config.json 并热生效。"
        actions={(
          <>
            {dirty && <Badge variant="outline">有未保存更改</Badge>}
            {savedAt && !dirty && <Badge variant="secondary" className="gap-1"><CheckCircle2 className="h-3 w-3" />已保存并热生效</Badge>}
            <Button variant="outline" size="sm" onClick={() => refresh()} disabled={loading || saving}><RefreshCw className="mr-1.5 h-3.5 w-3.5" />刷新</Button>
            <Button size="sm" onClick={handleSave} disabled={saving}>{saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-1.5 h-3.5 w-3.5" />}保存并生效</Button>
          </>
        )}
      />

      <div className="min-h-0 flex-1 space-y-4 overflow-auto">
      {(error || localError) && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{localError || error}</span>
        </div>
      )}

      <SettingsTwoColumn
        sidebar={(
          <Card className="h-fit">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 px-4 pb-3 pt-4">
              <CardTitle className="text-base">池列表</CardTitle>
              <Button variant="ghost" size="sm" className="h-7 px-2" onClick={addHand}><Plus className="h-3.5 w-3.5" /></Button>
            </CardHeader>
            <CardContent className="space-y-2 px-4 pb-4 pt-0">
              {draftHands.length === 0 && (
                <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                  暂无执行环境池。新建后可按用户或组织控制灰度发布范围。
                </div>
              )}
              {draftHands.map((hand) => {
                const selected = hand.clientKey === selectedKey;
                return (
                  <button
                    key={hand.clientKey}
                    type="button"
                    onClick={() => setSelectedKey(hand.clientKey)}
                    className={cn(
                      "w-full rounded-lg border px-3 py-2 text-left text-sm transition-colors",
                      selected ? "border-primary bg-primary/10" : "hover:bg-muted/60",
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate font-mono font-medium">{hand.id || "未命名执行环境池"}</div>
                        <div className="mt-0.5 truncate text-xs text-muted-foreground">{hand.description || hand.baseUrl || "未填写 Base URL"}</div>
                      </div>
                      {hand.isNew && <Badge variant="secondary">新建</Badge>}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1">
                      <Badge variant={hand.rolloutMode === "all" && hand.rolloutEditorMode === "explicit" ? "destructive" : "outline"}>{rolloutLabel(hand)}</Badge>
                      <Badge variant="outline">{networkPolicyLabel(hand)}</Badge>
                      <Badge variant="secondary">{credentialLabel(hand)}</Badge>
                      {healthBadge(healthById[hand.id])}
                    </div>
                  </button>
                );
              })}
            </CardContent>
          </Card>
        )}
      >
        {!selectedHand ? (
          <Card className="h-fit">
            <CardContent className="flex min-h-64 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
              <ServerCog className="h-8 w-8" />
              选择或新建一个执行环境池。
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
                <div>
                  <CardTitle className="text-base">基础信息</CardTitle>
                  <p className="mt-1 text-sm text-muted-foreground">ID 是凭据保留的锚点，保存后不建议修改。</p>
                </div>
                <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={removeSelected}>
                  <Trash2 className="mr-1 h-3.5 w-3.5" />删除
                </Button>
              </CardHeader>
              <CardContent className="grid gap-3 md:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>ID</Label>
                  <Input value={selectedHand.id} onChange={(event) => updateSelected((hand) => ({ ...hand, id: event.target.value }))} />
                </div>
                <div className="space-y-1.5">
                  <Label>描述</Label>
                  <Input value={selectedHand.description} onChange={(event) => updateSelected((hand) => ({ ...hand, description: event.target.value }))} placeholder="例如 agent-saas-ecs" />
                </div>
                <div className="space-y-1.5 md:col-span-2">
                  <Label>Base URL</Label>
                  <Input value={selectedHand.baseUrl} onChange={(event) => updateSelected((hand) => ({ ...hand, baseUrl: event.target.value }))} placeholder="http://10.0.1.1:3300" />
                </div>
                <div className="space-y-1.5">
                  <Label>Invoke timeout ms</Label>
                  <Input type="number" min="1" max="600000" value={selectedHand.invokeTimeoutMsText} onChange={(event) => updateSelected((hand) => ({ ...hand, invokeTimeoutMsText: event.target.value }))} placeholder="默认 60000" />
                </div>
                {selectedHand.recipe !== undefined && (
                  <div className="rounded-lg border bg-muted/20 p-3 text-sm md:col-span-2">
                    <div className="font-medium">已配置 workspace recipe</div>
                    <div className="mt-1 text-xs text-muted-foreground">v1 不编辑 recipe，保存时会原样保留。</div>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="space-y-1 pb-3">
                <CardTitle className="text-base">网络策略</CardTitle>
                <p className="text-sm text-muted-foreground">配置 desired policy；实际生效状态以运行态 health/probe 为准。</p>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label>模式</Label>
                    <Select
                      value={selectedHand.networkPolicyMode}
                      onValueChange={(value) => updateSelected((hand) => ({ ...hand, networkPolicyMode: value as NetworkPolicyMode }))}
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="isolated">isolated</SelectItem>
                        <SelectItem value="public-egress">public-egress</SelectItem>
                        <SelectItem value="private-egress">private-egress</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <label className="flex items-center gap-2 self-end rounded-md border px-3 py-2 text-sm">
                    <Checkbox
                      checked={selectedHand.networkDenyPrivateNetworks}
                      onCheckedChange={(checked) => updateSelected((hand) => ({ ...hand, networkDenyPrivateNetworks: checked === true }))}
                    />
                    拒绝私网 / metadata
                  </label>
                </div>
                <div className="rounded-lg border bg-muted/20 p-3 text-sm text-muted-foreground">
                  coding shell 不承载公司高权限数据访问；RDS/CRM/ky-data-query 走平台受控工具。客户私有系统访问必须显式配置 private-egress allowlist。
                </div>
                {selectedHand.networkPolicyMode === "private-egress" && (
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label>allowCidrs</Label>
                      <Textarea
                        value={selectedHand.networkAllowCidrsText}
                        onChange={(event) => updateSelected((hand) => ({ ...hand, networkAllowCidrsText: event.target.value }))}
                        className="min-h-24 font-mono text-xs"
                        placeholder="每行一个 CIDR"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>allowDomains</Label>
                      <Textarea
                        value={selectedHand.networkAllowDomainsText}
                        onChange={(event) => updateSelected((hand) => ({ ...hand, networkAllowDomainsText: event.target.value }))}
                        className="min-h-24 font-mono text-xs"
                        placeholder="仅作为 desired；实际必须按解析 IP/CIDR 校验"
                      />
                    </div>
                  </div>
                )}
                <div className="space-y-1.5">
                  <Label>denyCidrs</Label>
                  <Textarea
                    value={selectedHand.networkDenyCidrsText}
                    onChange={(event) => updateSelected((hand) => ({ ...hand, networkDenyCidrsText: event.target.value }))}
                    className="min-h-20 font-mono text-xs"
                    placeholder="额外拒绝 CIDR，可留空使用默认私网拒绝集"
                  />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="space-y-1 pb-3">
                <CardTitle className="text-base">Rollout</CardTitle>
                <p className="text-sm text-muted-foreground">决定哪些用户的新会话会接入这个执行环境池。</p>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label>编辑模式</Label>
                    <Select value={selectedHand.rolloutEditorMode} onValueChange={(value) => updateSelected((hand) => ({ ...hand, rolloutEditorMode: value as RolloutEditorMode }))}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="explicit">新版 rollout</SelectItem>
                        <SelectItem value="legacy">Legacy 原样保留</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>模式</Label>
                    <Select value={selectedHand.rolloutMode} disabled={selectedHand.rolloutEditorMode === "legacy"} onValueChange={(value) => updateSelected((hand) => ({ ...hand, rolloutMode: value as TenantRemoteHandRolloutMode }))}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="disabled">停用</SelectItem>
                        <SelectItem value="drain">维护模式</SelectItem>
                        <SelectItem value="allowlist">指定用户</SelectItem>
                        <SelectItem value="tenant">指定组织</SelectItem>
                        <SelectItem value="all">全部用户</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {selectedHand.rolloutEditorMode === "legacy" ? (
                  <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                    当前使用旧版 users/tenantIds 规则。只改基础字段或凭据时会原样保留；如要改 rollout，请切到“新版 rollout”。
                    <div className="mt-3 grid gap-3 md:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label>Legacy users</Label>
                        <Textarea value={selectedHand.legacyUsersText} onChange={(event) => updateSelected((hand) => ({ ...hand, legacyUsersText: event.target.value }))} className="min-h-24 bg-white font-mono text-xs" />
                      </div>
                      <div className="space-y-1.5">
                        <Label>Legacy tenantIds</Label>
                        <Textarea value={selectedHand.legacyTenantIdsText} onChange={(event) => updateSelected((hand) => ({ ...hand, legacyTenantIdsText: event.target.value }))} className="min-h-24 bg-white font-mono text-xs" />
                      </div>
                    </div>
                  </div>
                ) : (
                  <>
                    {selectedHand.rolloutMode === "allowlist" && (
                      <div className="space-y-3 rounded-lg border p-3">
                        <div className="flex items-center justify-between gap-2">
                          <div>
                            <div className="text-sm font-medium">用户白名单</div>
                            <div className="text-xs text-muted-foreground">优先保存 userIds；手动 usernames 用于兼容旧账号名。</div>
                          </div>
                          {usersLoading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                        </div>
                        <Input value={userSearch} onChange={(event) => setUserSearch(event.target.value)} placeholder="搜索姓名、username、user id、组织" />
                        <div className="max-h-64 space-y-2 overflow-auto rounded-md border p-2">
                          {filteredUsers.map((user) => {
                            const checked = selectedHand.rolloutUserIds.includes(user.id);
                            const tenant = tenantsById.get(user.tenantId);
                            return (
                              <label key={user.id} className="flex cursor-pointer items-start gap-2 rounded-md p-2 text-sm hover:bg-muted/60">
                                <Checkbox
                                  checked={checked}
                                  onCheckedChange={(next) => updateSelected((hand) => ({
                                    ...hand,
                                    rolloutUserIds: next === true
                                      ? unique([...hand.rolloutUserIds, user.id])
                                      : hand.rolloutUserIds.filter((id) => id !== user.id),
                                  }))}
                                />
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate font-medium">{user.realName || user.username}</span>
                                  <span className="block truncate text-xs text-muted-foreground">{user.username} · {user.id} · {tenant?.name ?? user.tenantId}</span>
                                </span>
                                {user.disabled && <Badge variant="secondary">已禁用</Badge>}
                              </label>
                            );
                          })}
                          {filteredUsers.length === 0 && <div className="p-3 text-sm text-muted-foreground">没有匹配用户</div>}
                        </div>
                        <div className="space-y-1.5">
                          <Label>手动 usernames</Label>
                          <Textarea value={selectedHand.rolloutUsernamesText} onChange={(event) => updateSelected((hand) => ({ ...hand, rolloutUsernamesText: event.target.value }))} className="min-h-20 font-mono text-xs" placeholder="每行一个 username" />
                        </div>
                      </div>
                    )}

                    {selectedHand.rolloutMode === "tenant" && (
                      <div className="space-y-3 rounded-lg border p-3">
                        <div className="flex items-center justify-between gap-2">
                          <div>
                            <div className="text-sm font-medium">组织范围</div>
                            <div className="text-xs text-muted-foreground">选中组织下的用户会在新会话接入这个执行环境池。</div>
                          </div>
                          {tenantsLoading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                        </div>
                        <Input value={tenantSearch} onChange={(event) => setTenantSearch(event.target.value)} placeholder="搜索组织名或 tenantId" />
                        <div className="max-h-64 space-y-2 overflow-auto rounded-md border p-2">
                          {filteredTenants.map((tenant) => {
                            const checked = selectedHand.rolloutTenantIds.includes(tenant.id);
                            const userCount = users.filter((user) => user.tenantId === tenant.id && !user.disabled).length;
                            return (
                              <label key={tenant.id} className="flex cursor-pointer items-start gap-2 rounded-md p-2 text-sm hover:bg-muted/60">
                                <Checkbox
                                  checked={checked}
                                  onCheckedChange={(next) => updateSelected((hand) => ({
                                    ...hand,
                                    rolloutTenantIds: next === true
                                      ? unique([...hand.rolloutTenantIds, tenant.id])
                                      : hand.rolloutTenantIds.filter((id) => id !== tenant.id),
                                  }))}
                                />
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate font-medium">{tenant.name}</span>
                                  <span className="block truncate text-xs text-muted-foreground">{tenant.id} · {userCount} 个可用用户</span>
                                </span>
                                {tenant.disabled && <Badge variant="secondary">已禁用</Badge>}
                              </label>
                            );
                          })}
                          {filteredTenants.length === 0 && <div className="p-3 text-sm text-muted-foreground">没有匹配组织</div>}
                        </div>
                      </div>
                    )}

                    {selectedHand.rolloutMode === "all" && (
                      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                        全部用户模式会让所有组织用户的新会话接入该执行环境池，保存时会再次确认。
                      </div>
                    )}
                  </>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="space-y-1 pb-3">
                <CardTitle className="text-base">凭据</CardTitle>
                <p className="text-sm text-muted-foreground">真实 token 不会从服务端返回，也不会在保存成功后留在输入框。</p>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label>凭据模式</Label>
                    <Select value={selectedHand.credentialMode} onValueChange={(value) => updateSelected((hand) => ({ ...hand, credentialMode: value as CredentialMode }))}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {!selectedHand.isNew && <SelectItem value="preserve">保留现有凭据</SelectItem>}
                        <SelectItem value="ref">使用 authTokenRef</SelectItem>
                        <SelectItem value="inline">替换明文 token</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex items-end gap-2 text-sm text-muted-foreground">
                    <KeyRound className="mb-2 h-4 w-4" />
                    {credentialLabel(selectedHand)}
                  </div>
                </div>
                {selectedHand.credentialMode === "preserve" && (
                  <div className="rounded-lg border bg-muted/20 p-3 text-sm text-muted-foreground">
                    保存时会省略 authToken/authTokenRef，由后端按同一个执行环境池 ID 保留现有凭据。
                  </div>
                )}
                {selectedHand.credentialMode === "ref" && (
                  <div className="space-y-1.5">
                    <Label>authTokenRef</Label>
                    <Input value={selectedHand.authTokenRef} onChange={(event) => updateSelected((hand) => ({ ...hand, authTokenRef: event.target.value }))} placeholder="secret vault ref id" />
                  </div>
                )}
                {selectedHand.credentialMode === "inline" && (
                  <div className="space-y-1.5">
                    <Label>明文 token</Label>
                    <Input type="password" value={selectedHand.authTokenInput} onChange={(event) => updateSelected((hand) => ({ ...hand, authTokenInput: event.target.value }))} placeholder="保存成功后会清空" />
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
                <div>
                  <CardTitle className="text-base">健康检查</CardTitle>
                  <p className="mt-1 text-sm text-muted-foreground">检查服务端已保存配置，不包含未保存改动。</p>
                </div>
                <Button variant="outline" size="sm" onClick={handleHealth} disabled={selectedHand.isNew || healthById[selectedHand.id]?.status === "checking"}>
                  {healthById[selectedHand.id]?.status === "checking" ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
                  检查已保存配置
                </Button>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-2">
                  {healthBadge(healthById[selectedHand.id])}
                  {healthDetail(healthById[selectedHand.id]) && (
                    <span className="text-sm text-destructive">{healthDetail(healthById[selectedHand.id])}</span>
                  )}
                </div>
                <MetadataBlock value={healthMetadata(healthById[selectedHand.id])} />
              </CardContent>
            </Card>
          </div>
        )}
      </SettingsTwoColumn>
      </div>
    </div>
  );
}

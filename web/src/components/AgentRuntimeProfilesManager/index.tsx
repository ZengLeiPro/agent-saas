import { useCallback, useEffect, useMemo, useState } from "react";
import { Archive, Copy, History, Loader2, Plus, RefreshCw, Rocket, Save } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SettingsPanelHeader } from "@/components/SettingsCenter/SettingsPanelHeader";
import { useAuth } from "@/contexts/AuthContext";
import { authFetch } from "@/lib/authFetch";
import { cn } from "@/lib/utils";

type ProfileStatus = "draft" | "published" | "archived";

interface ProfileVersionSummary {
  profileVersionId: string;
  profileId: string;
  versionNumber: number;
  configDigest: string;
  publishedBy: string;
  publishedAt: string;
}

interface RuntimeProfile {
  profileId: string;
  profileKey: string;
  name: string;
  description: string;
  purpose: string;
  status: ProfileStatus;
  systemProfile: boolean;
  draftConfig: Record<string, unknown>;
  draftDigest: string;
  revision: number;
  latestVersion?: ProfileVersionSummary;
  updatedBy: string;
  updatedAt: string;
}

interface ProfileVersion extends ProfileVersionSummary {
  configSchemaVersion: number;
  config: Record<string, unknown>;
}

interface ProfileBinding {
  bindingKey: string;
  profileId: string;
  updatedBy: string;
  updatedAt: string;
}

interface ProfilesResponse {
  durable: boolean;
  profiles: RuntimeProfile[];
  bindings: ProfileBinding[];
  bindingKeys: string[];
  platformTools: {
    catalog: string[];
    enabled: string[];
  };
  semantics: {
    shellWarning: string;
    publishedVersionsImmutable: boolean;
    newSessionsOnly: boolean;
    effectiveToolsDependOnRuntime: boolean;
  };
}

const BINDING_LABELS: Record<string, string> = {
  main: "默认交互 Agent",
  org_agent: "专职 Agent",
  memory_poll: "记忆轮询",
  subagent_general: "子 Agent · General",
  subagent_explore: "子 Agent · Explore",
  background_general: "后台 Agent · General",
  background_explore: "后台 Agent · Explore",
};

const STATUS_LABELS: Record<ProfileStatus, string> = {
  draft: "草稿",
  published: "已发布",
  archived: "已归档",
};

type View = "profiles" | "bindings" | "versions";

export function AgentRuntimeProfilesManager(): JSX.Element {
  const { platformReadOnly } = useAuth();
  const [data, setData] = useState<ProfilesResponse | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [view, setView] = useState<View>("profiles");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [purpose, setPurpose] = useState("");
  const [configText, setConfigText] = useState("");
  const [versions, setVersions] = useState<ProfileVersion[]>([]);
  const [selectedVersionId, setSelectedVersionId] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  const selected = useMemo(
    () => data?.profiles.find((profile) => profile.profileId === selectedId) ?? data?.profiles[0] ?? null,
    [data, selectedId],
  );
  const selectedVersion = versions.find((version) => version.profileVersionId === selectedVersionId) ?? versions[0] ?? null;
  const hasUnpublishedChanges = !!selected?.latestVersion && selected.draftDigest !== selected.latestVersion.configDigest;
  const dirty = !!selected && (
    name !== selected.name
    || description !== selected.description
    || purpose !== selected.purpose
    || configText !== JSON.stringify(selected.draftConfig, null, 2)
  );

  const syncEditor = useCallback((profile: RuntimeProfile | null) => {
    setName(profile?.name ?? "");
    setDescription(profile?.description ?? "");
    setPurpose(profile?.purpose ?? "");
    setConfigText(profile ? JSON.stringify(profile.draftConfig, null, 2) : "");
  }, []);

  const load = useCallback(async (preferredId?: string) => {
    setLoading(true);
    setMessage(null);
    try {
      const response = await authFetch("/api/admin/agent-profiles");
      const next = await readJson<ProfilesResponse>(response);
      setData(next);
      const nextSelected = next.profiles.find((profile) => profile.profileId === (preferredId || selectedId))
        ?? next.profiles[0]
        ?? null;
      setSelectedId(nextSelected?.profileId ?? "");
      syncEditor(nextSelected);
    } catch (error) {
      setMessage({ kind: "error", text: errorMessage(error) });
    } finally {
      setLoading(false);
    }
  }, [selectedId, syncEditor]);

  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const selectProfile = (profile: RuntimeProfile) => {
    if (dirty && !window.confirm("当前草稿修改尚未保存，确定切换 Profile 吗？")) return;
    setSelectedId(profile.profileId);
    syncEditor(profile);
    setMessage(null);
    setVersions([]);
    setSelectedVersionId("");
  };

  const saveDraft = async () => {
    if (!selected) return;
    let config: Record<string, unknown>;
    try {
      config = JSON.parse(configText) as Record<string, unknown>;
    } catch (error) {
      setMessage({ kind: "error", text: `配置 JSON 无效：${errorMessage(error)}` });
      return;
    }
    await mutate(async () => {
      await request(`/api/admin/agent-profiles/${encodeURIComponent(selected.profileId)}/draft`, {
        method: "PATCH",
        body: JSON.stringify({ expectedRevision: selected.revision, name, description, purpose, config }),
      });
      await load(selected.profileId);
      setMessage({ kind: "success", text: "草稿已保存；尚未影响任何运行中的或新建会话" });
    });
  };

  const publish = async () => {
    if (!selected) return;
    if (dirty) {
      setMessage({ kind: "error", text: "请先保存草稿，再发布不可变版本" });
      return;
    }
    if (!window.confirm(`发布「${selected.name}」的新版本？仅之后创建的会话使用，新版不会改变既有会话。`)) return;
    await mutate(async () => {
      await request(`/api/admin/agent-profiles/${encodeURIComponent(selected.profileId)}/publish`, {
        method: "POST",
        body: JSON.stringify({ expectedRevision: selected.revision }),
      });
      await load(selected.profileId);
      setMessage({ kind: "success", text: "已发布不可变版本；既有会话继续使用原版本" });
    });
  };

  const createProfile = async (copyFrom?: RuntimeProfile) => {
    const suggested = copyFrom ? `${copyFrom.profileKey}_copy` : "custom_profile";
    const profileKey = window.prompt("稳定 Profile key（小写字母开头，可含数字、_、-）", suggested)?.trim();
    if (!profileKey) return;
    const profileName = window.prompt("Profile 名称", copyFrom ? `${copyFrom.name} 副本` : "自定义运行配置")?.trim();
    if (!profileName) return;
    await mutate(async () => {
      const url = copyFrom
        ? `/api/admin/agent-profiles/${encodeURIComponent(copyFrom.profileId)}/copy`
        : "/api/admin/agent-profiles";
      const result = await request<{ profile: RuntimeProfile }>(url, {
        method: "POST",
        body: JSON.stringify({ profileKey, name: profileName }),
      });
      await load(result.profile.profileId);
      setView("profiles");
      setMessage({ kind: "success", text: copyFrom ? "已复制为独立草稿" : "已创建 Profile 草稿" });
    });
  };

  const archive = async () => {
    if (!selected || selected.systemProfile) return;
    if (!window.confirm(`归档「${selected.name}」？已绑定的 Profile 会被后端拒绝，历史版本仍保留。`)) return;
    await mutate(async () => {
      await request(`/api/admin/agent-profiles/${encodeURIComponent(selected.profileId)}/archive`, {
        method: "POST",
        body: JSON.stringify({ expectedRevision: selected.revision }),
      });
      await load();
      setMessage({ kind: "success", text: "Profile 已归档，历史会话仍可读取其版本" });
    });
  };

  const loadVersions = async () => {
    if (!selected) return;
    setView("versions");
    setLoading(true);
    try {
      const result = await request<{ versions: ProfileVersion[] }>(
        `/api/admin/agent-profiles/${encodeURIComponent(selected.profileId)}/versions`,
      );
      setVersions(result.versions);
      setSelectedVersionId(result.versions[0]?.profileVersionId ?? "");
    } catch (error) {
      setMessage({ kind: "error", text: errorMessage(error) });
    } finally {
      setLoading(false);
    }
  };

  const updateBinding = async (bindingKey: string, profileId: string) => {
    await mutate(async () => {
      await request(`/api/admin/agent-profiles/bindings/${encodeURIComponent(bindingKey)}`, {
        method: "PUT",
        body: JSON.stringify({ profileId }),
      });
      await load(selectedId);
      setView("bindings");
      setMessage({ kind: "success", text: `${BINDING_LABELS[bindingKey] ?? bindingKey} 已改绑；只影响之后创建的会话` });
    });
  };

  const mutate = async (operation: () => Promise<void>) => {
    setSaving(true);
    setMessage(null);
    try { await operation(); }
    catch (error) { setMessage({ kind: "error", text: errorMessage(error) }); }
    finally { setSaving(false); }
  };

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-6xl flex-col">
      <SettingsPanelHeader
        title="Agent 运行配置"
        description="配置并版本化主 Agent、专职 Agent、子 Agent、记忆轮询和后台任务的上下文、技能、MCP、模型、工具与执行策略。"
        actions={<div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void load(selectedId)} disabled={loading || saving}>
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />刷新
          </Button>
          <Button size="sm" onClick={() => void createProfile()} disabled={platformReadOnly || saving || !data?.durable}>
            <Plus className="size-3.5" />新建
          </Button>
        </div>}
      />

      <div className="mb-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-950">
        <strong>能力边界说明：</strong>模型可见工具用于减少提示词和误调用，不等于安全权限。只要开启 Shell，Agent 仍可能读写文件、执行脚本、联网或调用 CLI；真正边界是执行环境、sandbox、网络出口、Secret/凭据挂载、后端鉴权、审批和审计。
      </div>

      {!data?.durable && !loading && (
        <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          当前未配置 PostgreSQL：系统内置 Profile 仍可安全运行，但管理修改不会持久化，因此写操作已禁用。
        </div>
      )}

      {message && <div className={cn("mb-3 rounded-md px-3 py-2 text-sm", message.kind === "success" ? "bg-emerald-500/10 text-emerald-700" : "bg-destructive/10 text-destructive")}>{message.text}</div>}

      <div className="mb-3 flex gap-1 rounded-lg bg-muted p-1">
        {(["profiles", "bindings", "versions"] as const).map((item) => (
          <button key={item} type="button" className={cn("rounded-md px-3 py-1.5 text-sm", view === item ? "bg-background font-medium shadow-sm" : "text-muted-foreground")} onClick={() => item === "versions" ? void loadVersions() : setView(item)}>
            {item === "profiles" ? "Profile" : item === "bindings" ? "场景绑定" : "版本记录"}
          </button>
        ))}
      </div>

      {loading && !data ? <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground"><Loader2 className="mr-2 size-4 animate-spin" />加载中</div> : null}

      {data && view === "profiles" && (
        <div className="grid min-h-0 flex-1 grid-rows-[190px_minmax(0,1fr)] gap-4 overflow-hidden md:grid-cols-[260px_minmax(0,1fr)] md:grid-rows-1">
          <Card className="min-h-0 overflow-hidden"><CardContent className="h-full overflow-auto p-2">
            {data.profiles.map((profile) => {
              const boundScenes = data.bindings
                .filter((binding) => binding.profileId === profile.profileId)
                .map((binding) => BINDING_LABELS[binding.bindingKey] ?? binding.bindingKey);
              return <button key={profile.profileId} type="button" onClick={() => selectProfile(profile)} className={cn("mb-1 w-full rounded-lg px-3 py-2 text-left", profile.profileId === selected?.profileId ? "bg-brand-accent-soft" : "hover:bg-muted") }>
                <div className="flex items-center justify-between gap-2"><span className="truncate text-sm font-medium">{profile.name}</span><Badge variant="outline">{STATUS_LABELS[profile.status]}</Badge></div>
                <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">{profile.profileKey} · {profile.latestVersion ? `v${profile.latestVersion.versionNumber}` : "未发布"}</div>
                <div className="mt-1 truncate text-[11px] text-muted-foreground">{boundScenes.length ? `绑定：${boundScenes.join(" / ")}` : "未绑定"} · {formatTime(profile.updatedAt)}</div>
              </button>;
            })}
          </CardContent></Card>

          {selected && <Card className="min-h-0 overflow-hidden"><CardHeader className="border-b py-3"><div className="flex flex-wrap items-center justify-between gap-2"><div><CardTitle className="text-base">{selected.name}</CardTitle><div className="mt-1 flex gap-2 text-xs text-muted-foreground"><span>{selected.profileKey}</span><span>revision {selected.revision}</span>{selected.systemProfile && <span>系统预置</span>}{hasUnpublishedChanges && <span className="text-amber-700">有未发布修改</span>}</div></div><div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" onClick={() => void createProfile(selected)} disabled={platformReadOnly || saving || !data.durable}><Copy className="size-3.5" />复制</Button><Button variant="outline" size="sm" onClick={() => void loadVersions()}><History className="size-3.5" />版本</Button>{!selected.systemProfile && <Button variant="outline" size="sm" onClick={() => void archive()} disabled={platformReadOnly || saving || !data.durable || selected.status === "archived"}><Archive className="size-3.5" />归档</Button>}<Button variant="outline" size="sm" onClick={() => void saveDraft()} disabled={platformReadOnly || saving || !data.durable || !dirty || selected.status === "archived"}><Save className="size-3.5" />保存草稿</Button><Button size="sm" onClick={() => void publish()} disabled={platformReadOnly || saving || !data.durable || dirty || selected.status === "archived" || (!!selected.latestVersion && !hasUnpublishedChanges)}><Rocket className="size-3.5" />发布新版</Button></div></div></CardHeader><CardContent className="h-[calc(100%-76px)] space-y-4 overflow-auto py-4">
            <div className="grid gap-3 md:grid-cols-2"><div className="space-y-1.5"><Label>名称</Label><Input value={name} onChange={(event) => setName(event.target.value)} disabled={platformReadOnly || selected.status === "archived"} /></div><div className="space-y-1.5"><Label>用途</Label><Input value={purpose} onChange={(event) => setPurpose(event.target.value)} disabled={platformReadOnly || selected.status === "archived"} /></div></div>
            <div className="space-y-1.5"><Label>说明</Label><Textarea value={description} onChange={(event) => setDescription(event.target.value)} className="min-h-20" disabled={platformReadOnly || selected.status === "archived"} /></div>
            <div className="space-y-1.5"><div className="flex items-center justify-between"><Label>Profile 配置 JSON</Label><span className="text-xs text-muted-foreground">schemaVersion 1 · 后端严格校验</span></div><Textarea value={configText} onChange={(event) => setConfigText(event.target.value)} className="min-h-[420px] font-mono text-xs" spellCheck={false} disabled={platformReadOnly || selected.status === "archived"} /></div>
            <EffectiveSummary config={safeConfig(configText) ?? selected.draftConfig} platformTools={data.platformTools} />
          </CardContent></Card>}
        </div>
      )}

      {data && view === "bindings" && <Card className="min-h-0 flex-1 overflow-auto"><CardHeader><CardTitle className="text-base">运行入口绑定</CardTitle><p className="text-sm text-muted-foreground">绑定稳定 Profile；发布新版后只影响后续新会话，已存在会话继续使用自己的不可变版本。</p></CardHeader><CardContent className="space-y-3">{data.bindingKeys.map((key) => { const binding = data.bindings.find((item) => item.bindingKey === key); return <div key={key} className="grid items-center gap-2 rounded-lg border p-3 md:grid-cols-[220px_minmax(0,1fr)_180px]"><div><div className="text-sm font-medium">{BINDING_LABELS[key] ?? key}</div><div className="font-mono text-xs text-muted-foreground">{key}</div></div><select className="h-9 rounded-md border bg-background px-3 text-sm" value={binding?.profileId ?? ""} disabled={platformReadOnly || saving || !data.durable} onChange={(event) => void updateBinding(key, event.target.value)}><option value="" disabled>请选择已发布 Profile</option>{data.profiles.filter((profile) => profile.status === "published" && profile.latestVersion).map((profile) => <option key={profile.profileId} value={profile.profileId}>{profile.name} · v{profile.latestVersion!.versionNumber}</option>)}</select><div className="text-xs text-muted-foreground">{binding ? `${formatTime(binding.updatedAt)} · ${binding.updatedBy}` : "未绑定（运行时使用内置兼容版本）"}</div></div>; })}</CardContent></Card>}

      {data && view === "versions" && <div className="grid min-h-0 flex-1 gap-4 overflow-hidden md:grid-cols-[260px_minmax(0,1fr)]"><Card className="min-h-0 overflow-auto"><CardContent className="p-2">{versions.length === 0 ? <div className="p-4 text-sm text-muted-foreground">当前 Profile 尚无已发布版本</div> : versions.map((version) => <button key={version.profileVersionId} type="button" onClick={() => setSelectedVersionId(version.profileVersionId)} className={cn("mb-1 w-full rounded-lg px-3 py-2 text-left", version.profileVersionId === selectedVersion?.profileVersionId ? "bg-brand-accent-soft" : "hover:bg-muted")}><div className="text-sm font-medium">版本 {version.versionNumber}</div><div className="mt-1 text-xs text-muted-foreground">{formatTime(version.publishedAt)} · {version.publishedBy}</div><div className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{version.configDigest}</div></button>)}</CardContent></Card><Card className="min-h-0 overflow-auto"><CardHeader><CardTitle className="text-base">{selectedVersion ? `${selected?.name ?? "Profile"} · v${selectedVersion.versionNumber}` : "版本详情"}</CardTitle><p className="text-sm text-muted-foreground">已发布版本只读且不可变；数据库 trigger 同时阻止 UPDATE 和 DELETE。</p></CardHeader><CardContent>{selectedVersion ? <><EffectiveSummary config={selectedVersion.config} platformTools={data.platformTools} /><pre className="mt-4 overflow-auto rounded-lg bg-muted p-4 text-xs leading-5">{JSON.stringify(selectedVersion.config, null, 2)}</pre></> : <div className="text-sm text-muted-foreground">选择一个版本查看</div>}</CardContent></Card></div>}
    </div>
  );
}

function EffectiveSummary({ config, platformTools }: { config: Record<string, unknown>; platformTools: ProfilesResponse["platformTools"] }): JSX.Element {
  const capabilities = (config.capabilities ?? {}) as Record<string, unknown>;
  const tools = (config.tools ?? {}) as { allowlist?: string[] | null; denylist?: string[] };
  const model = (config.model ?? {}) as { strategy?: string; modelRef?: string };
  const limits = (config.limits ?? {}) as { maxTurns?: number | null };
  const context = (config.context ?? {}) as { modules?: string[] };
  const skills = (config.skills ?? {}) as { defaultSkillIds?: string[]; allowlist?: string[] | null; denylist?: string[] };
  const mcp = (config.mcp ?? {}) as { serverAllowlist?: string[] | null; toolAllowlist?: string[] | null; denyServers?: string[]; denyTools?: string[] };
  const memory = (config.memory ?? {}) as { scope?: string };
  const execution = (config.execution ?? {}) as { allowedTargets?: string[] | null };
  const catalog = new Set(platformTools.catalog);
  const enabled = new Set(platformTools.enabled);
  const denied = new Set(tools.denylist ?? []);
  const requested = tools.allowlist ?? platformTools.enabled;
  const effective = requested.filter((tool) => enabled.has(tool) && !denied.has(tool));
  const retired = (tools.allowlist ?? []).filter((tool) => !catalog.has(tool));
  const platformDisabled = (tools.allowlist ?? []).filter((tool) => catalog.has(tool) && !enabled.has(tool));
  const shellAvailable = capabilities.shell === true && effective.includes("Shell");
  return <div className="rounded-lg border bg-muted/30 p-3">
    <div className="mb-2 text-sm font-medium">有效配置摘要（平台开关 ∩ Profile）</div>
    <div className="grid gap-2 text-xs text-muted-foreground md:grid-cols-2">
      <div>上下文：{context.modules?.join(" / ") || "无可选模块"}</div>
      <div>模型：{model.strategy === "fixed" ? model.modelRef : "继承入口/会话"}</div>
      <div>记忆：{memory.scope ?? "full"}</div>
      <div>最大轮次：{limits.maxTurns ?? "继承平台与账号上限"}</div>
      <div>工具：平台当前有效 {effective.length} 项{tools.allowlist ? ` / Profile 配置 ${tools.allowlist.length} 项` : ""}{tools.denylist?.length ? `，Profile 禁止 ${tools.denylist.length} 项` : ""}</div>
      <div>技能：默认/推荐 {skills.defaultSkillIds?.length ?? 0} 项；{skills.allowlist ? `允许 ${skills.allowlist.length} 项` : "继承现有有效集"}{skills.denylist?.length ? `，禁止 ${skills.denylist.length} 项` : ""}</div>
      <div>MCP：{mcp.serverAllowlist ? `${mcp.serverAllowlist.length} 个 Server` : "继承现有 Server"}{mcp.toolAllowlist ? ` / ${mcp.toolAllowlist.length} 个工具` : ""}{(mcp.denyServers?.length || mcp.denyTools?.length) ? `，禁止 ${(mcp.denyServers?.length ?? 0) + (mcp.denyTools?.length ?? 0)} 项` : ""}</div>
      <div>执行环境：{execution.allowedTargets?.join(" / ") || "继承当前入口"}</div>
      <div>Shell：{capabilities.shell ? "开放（不是权限边界）" : "关闭"}</div>
      <div>后台 / 交互 / 子 Agent / 排程：{["backgroundTasks", "interaction", "subagents", "scheduling"].filter((key) => capabilities[key]).join(" / ") || "均关闭"}</div>
    </div>
    {(retired.length > 0 || platformDisabled.length > 0) && <div className="mt-2 rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-900">
      {retired.length > 0 && <div>平台已移除：{retired.join(" / ")}</div>}
      {platformDisabled.length > 0 && <div>平台已关闭：{platformDisabled.join(" / ")}</div>}
    </div>}
    {!shellAvailable && <div className="mt-2 rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-900">
      当前有效工具集没有 Shell，Agent 无法通过 rg 发现或搜索工作区文件；仅适合路径已知且可直接 Read 的场景。
    </div>}
    <div className="mt-2 text-[11px] text-muted-foreground">实际会话还会继续与入口、租户、运行时就绪状态和后端能力取交集。</div>
  </div>;
}

function safeConfig(text: string): Record<string, unknown> | null {
  try { const value = JSON.parse(text); return value && typeof value === "object" && !Array.isArray(value) ? value : null; }
  catch { return null; }
}

async function request<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const response = await authFetch(url, { headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) }, ...init });
  return readJson<T>(response);
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `请求失败（HTTP ${response.status}）`);
  return body;
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function formatTime(value: string): string { return new Date(value).toLocaleString("zh-CN", { hour12: false }); }

export default AgentRuntimeProfilesManager;

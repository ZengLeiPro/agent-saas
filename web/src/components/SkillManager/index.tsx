import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw, ArrowUpCircle, Pencil, Trash2, Upload, Zap } from "lucide-react";
import {
  fetchTenantSkillPool,
  updateTenantSkillSettings,
  importPoolSkill,
  importTenantSkill,
  fetchTenantOwnSkills,
  updateTenantOwnSkillSettings,
  fetchTenantOwnSkillDocument,
  updateTenantOwnSkillDocument,
  deleteTenantOwnSkill,
  promoteSkillToTenant,
  promoteTenantSkillToPool,
  type PlatformSkillSettings,
  type PoolSkillInfo,
  type TenantSkillInfo,
  type TenantOwnSkillInfo,
  type TenantSkillSettings,
} from "@agent/shared";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { SettingsPanelHeader } from "@/components/SettingsCenter/SettingsPanelHeader";
import { useTenants } from "@/components/TenantManager/hooks";
import { useUsers } from "@/components/UserManager/hooks";
import { useAuth } from "@/contexts/AuthContext";
import { useSkillAdmin } from "./hooks";

export interface SkillManagerProps {
  mode?: "platform" | "tenant";
  tenantIdScope?: string;
  tenantName?: string;
}

export function SkillManager({ mode = "platform", tenantIdScope, tenantName }: SkillManagerProps = {}) {
  const {
    poolSkills,
    customData,
    loading,
    error,
    refresh,
    updatePlatformSettings,
    promoteSkill,
    deleteCustomSkill,
    fetchCustomSkillDocument,
    updateCustomSkillDocument,
    syncSkills,
  } = useSkillAdmin();
  const { users, loading: usersLoading } = useUsers();
  const { tenants, loading: tenantsLoading } = useTenants();

  const { isPlatformAdmin } = useAuth();
  const [syncing, setSyncing] = useState(false);
  const [activeTab, setActiveTab] = useState<"global" | "user">("global");
  const [deleteTarget, setDeleteTarget] = useState<{ kind: "custom" | "tenantOwn"; username: string; skillId: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [editTarget, setEditTarget] = useState<{ kind: "custom" | "tenantOwn"; username: string; skillId: string; name: string } | null>(null);
  const [editContent, setEditContent] = useState("");
  const [editLoading, setEditLoading] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [tenantSkills, setTenantSkills] = useState<TenantSkillInfo[]>([]);
  const [tenantLoading, setTenantLoading] = useState(false);
  const [tenantError, setTenantError] = useState<string | null>(null);
  const [ownSkills, setOwnSkills] = useState<TenantOwnSkillInfo[]>([]);
  const [ownError, setOwnError] = useState<string | null>(null);
  // 上传 skill（platform mode → pool；tenant mode → 组织自有）
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [importOk, setImportOk] = useState(false);
  const skillFileInputRef = useRef<HTMLInputElement>(null);
  const skillFolderInputRef = useRef<HTMLInputElement>(null);
  const skillZipInputRef = useRef<HTMLInputElement>(null);

  const isTenantMode = mode === "tenant";

  const refreshTenantSkills = useCallback(async () => {
    if (!isTenantMode || !tenantIdScope) return;
    setTenantLoading(true);
    try {
      const [poolResult, ownResult] = await Promise.all([
        fetchTenantSkillPool(tenantIdScope),
        fetchTenantOwnSkills(tenantIdScope),
      ]);
      setTenantSkills(poolResult.skills);
      setOwnSkills(ownResult.skills);
      setTenantError(null);
      setOwnError(null);
    } catch (err) {
      setTenantError(err instanceof Error ? err.message : String(err));
    } finally {
      setTenantLoading(false);
    }
  }, [isTenantMode, tenantIdScope]);

  useEffect(() => {
    void refreshTenantSkills();
  }, [refreshTenantSkills]);

  const refreshAll = useCallback(async () => {
    await Promise.all([refresh(), refreshTenantSkills()]);
  }, [refresh, refreshTenantSkills]);

  const handleSkillImport = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    if (files.length === 0) return;
    setImporting(true);
    setImportMsg(null);
    setImportOk(false);
    try {
      const result = isTenantMode && tenantIdScope
        ? await importTenantSkill(tenantIdScope, files)
        : await importPoolSkill(files);
      setImportDialogOpen(false);
      setImportOk(true);
      setImportMsg(`已上传技能：${result.skill.name}`);
      await refreshAll();
      setTimeout(() => setImportMsg(null), 2200);
    } catch (err) {
      setImportOk(false);
      setImportMsg(`上传失败: ${err instanceof Error ? err.message : "未知错误"}`);
    } finally {
      setImporting(false);
    }
  }, [isTenantMode, tenantIdScope, refreshAll]);

  const handleUpdateOwnSkill = useCallback(async (skill: TenantOwnSkillInfo, patch: Partial<TenantSkillSettings>) => {
    if (!tenantIdScope) return;
    try {
      await updateTenantOwnSkillSettings(tenantIdScope, {
        [skill.id]: {
          enabled: skill.enabled,
          exposure: skill.exposure,
          usernames: skill.usernames,
          ...patch,
        },
      });
      await refreshTenantSkills();
    } catch (err) {
      alert(err instanceof Error ? err.message : "更新失败");
    }
  }, [refreshTenantSkills, tenantIdScope]);

  const handlePromoteOwnToPool = useCallback(async (skillId: string) => {
    if (!tenantIdScope) return;
    try {
      await promoteTenantSkillToPool(tenantIdScope, skillId);
      await refreshAll();
    } catch (err) {
      alert(err instanceof Error ? err.message : "提升失败");
    }
  }, [tenantIdScope, refreshAll]);

  const handleSync = useCallback(async () => {
      setSyncing(true);
    try {
      await syncSkills();
      await refreshAll();
    } catch {
      alert("同步失败");
    } finally {
      setSyncing(false);
    }
  }, [syncSkills, refreshAll]);

  const handleUpdatePlatformSkill = useCallback(async (skill: PoolSkillInfo, patch: Partial<PlatformSkillSettings>) => {
    try {
      await updatePlatformSettings({
        [skill.id]: {
          enabled: skill.enabled,
          exposure: skill.exposure,
          tenantIds: skill.tenantIds,
          ...patch,
        },
      });
    } catch {
      alert("更新失败");
    }
  }, [updatePlatformSettings]);

  const handleUpdateTenantSkill = useCallback(async (skill: TenantSkillInfo, patch: Partial<TenantSkillSettings>) => {
    if (!tenantIdScope) return;
    try {
      await updateTenantSkillSettings(tenantIdScope, {
        [skill.id]: {
          enabled: skill.enabled,
          exposure: skill.exposure,
          usernames: skill.usernames,
          ...patch,
        },
      });
      await refreshTenantSkills();
    } catch (err) {
      alert(err instanceof Error ? err.message : "更新失败");
    }
  }, [refreshTenantSkills, tenantIdScope]);

  /** user tab 的提升：platform mode → 全局 pool；tenant mode → 组织自有 */
  const handlePromote = useCallback(async (skillId: string, sourceUser: string) => {
    try {
      if (isTenantMode && tenantIdScope) {
        await promoteSkillToTenant(tenantIdScope, skillId, sourceUser);
        await refreshAll();
      } else {
        await promoteSkill(skillId, sourceUser);
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : "提升失败");
    }
  }, [isTenantMode, tenantIdScope, promoteSkill, refreshAll]);

  const openEditor = useCallback(async (target: { kind: "custom" | "tenantOwn"; username: string; skillId: string; name: string }) => {
    setEditTarget(target);
    setEditContent("");
    setEditLoading(true);
    try {
      const doc = target.kind === "tenantOwn" && tenantIdScope
        ? await fetchTenantOwnSkillDocument(tenantIdScope, target.skillId)
        : await fetchCustomSkillDocument(target.username, target.skillId);
      setEditContent(doc.content);
    } catch (err) {
      alert(err instanceof Error ? err.message : "读取失败");
      setEditTarget(null);
    } finally {
      setEditLoading(false);
    }
  }, [fetchCustomSkillDocument, tenantIdScope]);

  const saveEditor = useCallback(async () => {
    if (!editTarget) return;
    setEditSaving(true);
    try {
      if (editTarget.kind === "tenantOwn" && tenantIdScope) {
        await updateTenantOwnSkillDocument(tenantIdScope, editTarget.skillId, editContent);
      } else {
        await updateCustomSkillDocument(editTarget.username, editTarget.skillId, editContent);
      }
      setEditTarget(null);
      await refreshAll();
    } catch (err) {
      alert(err instanceof Error ? err.message : "保存失败");
    } finally {
      setEditSaving(false);
    }
  }, [editContent, editTarget, refreshAll, tenantIdScope, updateCustomSkillDocument]);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      if (deleteTarget.kind === "tenantOwn" && tenantIdScope) {
        await deleteTenantOwnSkill(tenantIdScope, deleteTarget.skillId);
        await refreshTenantSkills();
      } else {
        await deleteCustomSkill(deleteTarget.username, deleteTarget.skillId);
      }
      setDeleteTarget(null);
    } catch {
      alert("删除失败");
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, deleteCustomSkill, refreshTenantSkills, tenantIdScope]);

  const customUsers = customData?.users ?? {};
  const tenantUsernames = tenantIdScope
    ? new Set(users.filter((u) => u.tenantId === tenantIdScope).map((u) => u.username))
    : null;
  const visibleCustomUsers = Object.fromEntries(
    Object.entries(customUsers).filter(([username]) => !tenantUsernames || tenantUsernames.has(username)),
  );
  const userSkillCount = Object.values(visibleCustomUsers).reduce((sum, arr) => sum + arr.length, 0);
  const hasCustomSkills = userSkillCount > 0;
  const activePoolSkillsCount = isTenantMode ? tenantSkills.length + ownSkills.length : poolSkills.length;
  const platformTenantOptions = tenants.filter((tenant) => !tenant.disabled);
  const tenantMemberOptions = tenantIdScope
    ? users.filter((user) => user.tenantId === tenantIdScope && !user.disabled)
    : [];

  if (loading || tenantLoading || (tenantIdScope && usersLoading) || (!isTenantMode && tenantsLoading)) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col">
      <SettingsPanelHeader
        title={isTenantMode && tenantName ? `${tenantName} · 技能管理` : "技能管理"}
        description={isTenantMode ? "管理当前组织可用的 Agent 技能与用户自建技能。" : "管理平台全局 Agent 技能池，支持启用、禁用和同步。"}
        actions={
          <>
            {!isTenantMode && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleSync}
                disabled={syncing}
              >
                {syncing ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Zap className="size-3.5" />
                )}
                强制同步
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setImportDialogOpen(true)}
              disabled={importing}
            >
              {importing ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Upload className="size-3.5" />
              )}
              上传技能
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => { void refreshAll(); }}
            >
              <RefreshCw className="size-3.5" />
              刷新
            </Button>
            {importMsg && (
              <span className={importOk ? "text-sm text-success" : "text-sm text-destructive"}>
                {importMsg}
              </span>
            )}
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="flex h-full min-h-0 flex-col">
          {(error || tenantError) && (
            <div className="mb-4 shrink-0 rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
              {error || tenantError}
            </div>
          )}

          <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as "global" | "user")} className="flex min-h-0 flex-1 flex-col">
            <div className="shrink-0 rounded-lg border bg-card p-1 shadow-sm">
              <TabsList className="grid h-auto w-full grid-cols-2 gap-1 bg-transparent p-0 text-muted-foreground">
                <TabsTrigger value="global" className="h-9 rounded-md px-3 data-[state=active]:bg-brand-accent-soft data-[state=active]:text-foreground data-[state=active]:shadow-none">
                  {isTenantMode ? "组织技能" : "平台技能"}
                  <span className="ml-1.5 text-xs font-normal">({activePoolSkillsCount})</span>
                </TabsTrigger>
                <TabsTrigger value="user" className="h-9 rounded-md px-3 data-[state=active]:bg-brand-accent-soft data-[state=active]:text-foreground data-[state=active]:shadow-none">
                  用户技能
                  <span className="ml-1.5 text-xs font-normal">({userSkillCount})</span>
                </TabsTrigger>
              </TabsList>
            </div>

            <div className="min-h-0 flex-1 overflow-auto pt-4">
              <TabsContent value="global" forceMount className="mt-0">
                <div className="rounded-2xl border bg-card shadow-sm">
                  <div className="space-y-1 p-4">
            {activePoolSkillsCount === 0 ? (
              <div className="py-4 text-center text-sm text-muted-foreground">暂无{isTenantMode ? "组织" : "平台"}技能</div>
            ) : isTenantMode ? (
              <>
              {ownError && (
                <div className="mb-2 rounded-lg border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">{ownError}</div>
              )}
              {ownSkills.length > 0 && (
                <>
                  <div className="mb-1 mt-1 text-xs font-medium text-muted-foreground">组织自有技能（上传/沉淀）</div>
                  {ownSkills.map(skill => (
                    <div key={skill.id} className="rounded-lg p-2.5 transition-colors hover:bg-muted/50">
                      <div className="flex items-start gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium">{skill.name}</div>
                          {skill.description && (
                            <p className="mt-0.5 whitespace-pre-wrap break-words text-xs text-muted-foreground">{skill.description}</p>
                          )}
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            onClick={() => { void openEditor({ kind: "tenantOwn", username: "", skillId: skill.id, name: skill.name }); }}
                          >
                            <Pencil className="size-3.5" />
                          </Button>
                          {isPlatformAdmin && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2 text-xs"
                              title="提升到平台技能池"
                              onClick={() => { void handlePromoteOwnToPool(skill.id); }}
                            >
                              <ArrowUpCircle className="size-3.5" />
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                            onClick={() => setDeleteTarget({ kind: "tenantOwn", username: "", skillId: skill.id, name: skill.name })}
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                          <Select
                            value={skill.exposure}
                            onValueChange={(value) => {
                              void handleUpdateOwnSkill(skill, { exposure: value as TenantOwnSkillInfo["exposure"] });
                            }}
                          >
                            <SelectTrigger className="h-8 w-36">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="all">全员开放</SelectItem>
                              <SelectItem value="allow_users">指定成员开放</SelectItem>
                              <SelectItem value="deny_users">指定成员禁用</SelectItem>
                            </SelectContent>
                          </Select>
                          <Switch
                            checked={skill.enabled}
                            onCheckedChange={(checked) => { void handleUpdateOwnSkill(skill, { enabled: checked }); }}
                            className="shrink-0"
                          />
                        </div>
                      </div>
                      {skill.exposure !== "all" && (
                        <div className="mt-3 grid gap-2 rounded-md border bg-muted/20 p-3 sm:grid-cols-2">
                          {tenantMemberOptions.map((user) => (
                            <label key={user.username} className="flex min-w-0 items-center gap-2 text-xs">
                              <Checkbox
                                checked={skill.usernames.includes(user.username)}
                                onCheckedChange={(checked) => {
                                  const usernames = checked === true
                                    ? Array.from(new Set([...skill.usernames, user.username]))
                                    : skill.usernames.filter((username: string) => username !== user.username);
                                  void handleUpdateOwnSkill(skill, { usernames });
                                }}
                              />
                              <span className="truncate">{user.realName || user.username}</span>
                              {user.realName && <span className="truncate text-muted-foreground">{user.username}</span>}
                            </label>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                  {tenantSkills.length > 0 && (
                    <div className="mb-1 mt-3 text-xs font-medium text-muted-foreground">平台技能（组织内启用范围）</div>
                  )}
                </>
              )}
              {tenantSkills.map(skill => (
                <div key={skill.id} className="rounded-lg p-2.5 transition-colors hover:bg-muted/50">
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium">{skill.name}</div>
                      {skill.description && (
                        <p className="mt-0.5 whitespace-pre-wrap break-words text-xs text-muted-foreground">{skill.description}</p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Select
                        value={skill.exposure}
                        onValueChange={(value) => {
                          void handleUpdateTenantSkill(skill, { exposure: value as TenantSkillInfo["exposure"] });
                        }}
                      >
                        <SelectTrigger className="h-8 w-36">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">全员开放</SelectItem>
                          <SelectItem value="allow_users">指定成员开放</SelectItem>
                          <SelectItem value="deny_users">指定成员禁用</SelectItem>
                        </SelectContent>
                      </Select>
                      <Switch
                        checked={skill.enabled}
                        onCheckedChange={(checked) => { void handleUpdateTenantSkill(skill, { enabled: checked }); }}
                        className="shrink-0"
                      />
                    </div>
                  </div>
                  {skill.exposure !== "all" && (
                    <div className="mt-3 grid gap-2 rounded-md border bg-muted/20 p-3 sm:grid-cols-2">
                      {tenantMemberOptions.map((user) => (
                        <label key={user.username} className="flex min-w-0 items-center gap-2 text-xs">
                          <Checkbox
                            checked={skill.usernames.includes(user.username)}
                            onCheckedChange={(checked) => {
                              const usernames = checked === true
                                ? Array.from(new Set([...skill.usernames, user.username]))
                                : skill.usernames.filter((username) => username !== user.username);
                              void handleUpdateTenantSkill(skill, { usernames });
                            }}
                          />
                          <span className="truncate">{user.realName || user.username}</span>
                          {user.realName && <span className="truncate text-muted-foreground">{user.username}</span>}
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              </>
            ) : (
              poolSkills.map(skill => (
                <div key={skill.id} className="rounded-lg p-2.5 transition-colors hover:bg-muted/50">
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium">{skill.name}</div>
                      {skill.description && (
                        <p className="mt-0.5 whitespace-pre-wrap break-words text-xs text-muted-foreground">{skill.description}</p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Select
                        value={skill.exposure}
                        onValueChange={(value) => {
                          void handleUpdatePlatformSkill(skill, { exposure: value as PoolSkillInfo["exposure"] });
                        }}
                      >
                        <SelectTrigger className="h-8 w-40">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">全平台开放</SelectItem>
                          <SelectItem value="allow_tenants">仅指定租户开放</SelectItem>
                          <SelectItem value="deny_tenants">指定租户禁用</SelectItem>
                        </SelectContent>
                      </Select>
                      <Switch
                        checked={skill.enabled}
                        onCheckedChange={(checked) => { void handleUpdatePlatformSkill(skill, { enabled: checked }); }}
                        className="shrink-0"
                      />
                    </div>
                  </div>
                  {skill.exposure !== "all" && (
                    <div className="mt-3 grid gap-2 rounded-md border bg-muted/20 p-3 sm:grid-cols-2">
                      {platformTenantOptions.map((tenant) => (
                        <label key={tenant.id} className="flex min-w-0 items-center gap-2 text-xs">
                          <Checkbox
                            checked={skill.tenantIds.includes(tenant.id)}
                            onCheckedChange={(checked) => {
                              const tenantIds = checked === true
                                ? Array.from(new Set([...skill.tenantIds, tenant.id]))
                                : skill.tenantIds.filter((tenantId) => tenantId !== tenant.id);
                              void handleUpdatePlatformSkill(skill, { tenantIds });
                            }}
                          />
                          <span className="truncate">{tenant.name}</span>
                          <span className="truncate text-muted-foreground">{tenant.id}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              ))
            )}
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="user" forceMount className="mt-0">
                <div className="rounded-2xl border bg-card shadow-sm">
                  <div className="p-4">
            {!hasCustomSkills ? (
              <div className="py-4 text-center text-sm text-muted-foreground">暂无用户技能</div>
            ) : (
              <div className="space-y-4">
                {Object.entries(visibleCustomUsers).map(([username, skills]) => {
                  if (skills.length === 0) return null;
                  return (
                    <div key={username}>
                      <div className="mb-2 text-xs font-medium text-muted-foreground">{username}</div>
                      <div className="space-y-1">
                        {skills.map(skill => (
                          <div key={skill.id} className="flex items-start gap-3 rounded-lg p-2.5 transition-colors hover:bg-muted/50">
                            <div className="min-w-0 flex-1">
                              <div className="text-sm font-medium">{skill.name}</div>
                              {skill.description && (
                                <p className="mt-0.5 whitespace-pre-wrap break-words text-xs text-muted-foreground">{skill.description}</p>
                              )}
                            </div>
                            <div className="flex shrink-0 gap-1">
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2 text-xs"
                                onClick={() => { void openEditor({ kind: "custom", username, skillId: skill.id, name: skill.name }); }}
                              >
                                <Pencil className="size-3.5" />
                                接管编辑
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2 text-xs"
                                onClick={() => handlePromote(skill.id, username)}
                              >
                                <ArrowUpCircle className="size-3.5" />
                                {isTenantMode ? "提升到组织" : "提升到全局"}
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                                onClick={() => setDeleteTarget({ kind: "custom", username, skillId: skill.id, name: skill.name })}
                              >
                                <Trash2 className="size-3.5" />
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
                  </div>
                </div>
              </TabsContent>
            </div>
          </Tabs>
        </div>
      </div>

      <Dialog open={!!editTarget} onOpenChange={(open) => { if (!open) setEditTarget(null); }}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{editTarget?.kind === "tenantOwn" ? "编辑组织技能" : "接管编辑技能"}</DialogTitle>
            <DialogDescription>
              正在编辑{editTarget?.kind === "tenantOwn" ? "组织" : ` ${editTarget?.username} `}的技能“{editTarget?.name}”。保存时会校验 SKILL.md frontmatter，且 name 必须与技能 ID 保持一致。
            </DialogDescription>
          </DialogHeader>
          {editLoading ? (
            <div className="flex h-64 items-center justify-center text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
            </div>
          ) : (
            <textarea
              autoComplete="off"
              className="min-h-96 w-full rounded-md border bg-background px-3 py-2 font-mono text-sm"
              value={editContent}
              onChange={(event) => setEditContent(event.target.value)}
              spellCheck={false}
            />
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditTarget(null)}>取消</Button>
            <Button onClick={() => { void saveEditor(); }} disabled={editLoading || editSaving}>
              {editSaving && <Loader2 className="size-4 animate-spin" />}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation dialog */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认删除</DialogTitle>
            <DialogDescription>
              确定要删除{deleteTarget?.kind === "tenantOwn" ? "组织" : ` ${deleteTarget?.username} `}的技能“{deleteTarget?.name}”吗？此操作不可撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              取消
            </Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={deleting}>
              {deleting && <Loader2 className="size-4 animate-spin" />}
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Upload skill dialog（platform → pool；tenant → 组织自有） */}
      <input
        ref={skillFileInputRef}
        type="file"
        accept=".md,text/markdown"
        className="hidden"
        onChange={(event) => { void handleSkillImport(event); }}
      />
      <input
        ref={skillZipInputRef}
        type="file"
        accept=".zip,application/zip"
        className="hidden"
        onChange={(event) => { void handleSkillImport(event); }}
      />
      {/* @ts-expect-error webkitdirectory is supported by Chromium for folder uploads but missing from React types. */}
      <input ref={skillFolderInputRef} type="file" className="hidden" multiple webkitdirectory="" onChange={(event) => { void handleSkillImport(event); }} />
      <Dialog open={importDialogOpen} onOpenChange={setImportDialogOpen}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
          <DialogHeader>
            <DialogTitle>上传技能到{isTenantMode ? "组织" : "平台"}技能池</DialogTitle>
            <DialogDescription>
              支持 SKILL.md 单文件、包含 SKILL.md 的文件夹，或包含同样结构的 zip 压缩包。SKILL.md 需要包含 name 和 description frontmatter。
              {isTenantMode ? "上传后组织成员可在自己的技能设置中启用。" : "上传后按平台/组织/成员三级范围控制开放。"}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Button
              variant="outline"
              onClick={() => skillFileInputRef.current?.click()}
              disabled={importing}
            >
              上传 SKILL.md
            </Button>
            <Button
              variant="outline"
              onClick={() => skillFolderInputRef.current?.click()}
              disabled={importing}
            >
              上传文件夹
            </Button>
            <Button
              variant="outline"
              onClick={() => skillZipInputRef.current?.click()}
              disabled={importing}
            >
              上传 zip 压缩包
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

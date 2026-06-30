import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, ArrowUpCircle, Pencil, Trash2, Zap } from "lucide-react";
import { fetchTenantSkillPool, updateTenantSkillSelections, type TenantSkillInfo } from "@agent/shared";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { SettingsPanelHeader } from "@/components/SettingsCenter/SettingsPanelHeader";
import { useUsers } from "@/components/UserManager/hooks";
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
    updateVisibility,
    promoteSkill,
    deleteCustomSkill,
    fetchCustomSkillDocument,
    updateCustomSkillDocument,
    syncSkills,
  } = useSkillAdmin();
  const { users, loading: usersLoading } = useUsers();

  const [syncing, setSyncing] = useState(false);
  const [activeTab, setActiveTab] = useState<"global" | "user">("global");
  const [deleteTarget, setDeleteTarget] = useState<{ username: string; skillId: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [editTarget, setEditTarget] = useState<{ username: string; skillId: string; name: string } | null>(null);
  const [editContent, setEditContent] = useState("");
  const [editLoading, setEditLoading] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [tenantSkills, setTenantSkills] = useState<TenantSkillInfo[]>([]);
  const [tenantLoading, setTenantLoading] = useState(false);
  const [tenantError, setTenantError] = useState<string | null>(null);

  const isTenantMode = mode === "tenant";

  const refreshTenantSkills = useCallback(async () => {
    if (!isTenantMode || !tenantIdScope) return;
    setTenantLoading(true);
    try {
      const result = await fetchTenantSkillPool(tenantIdScope);
      setTenantSkills(result.skills);
      setTenantError(null);
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

  const handleToggleVisibility = useCallback(async (skillId: string, visible: boolean) => {
    try {
      await updateVisibility({ [skillId]: visible });
    } catch {
      alert("更新失败");
    }
  }, [updateVisibility]);

  const handleToggleTenantSkill = useCallback(async (skillId: string, enabled: boolean) => {
    if (!tenantIdScope) return;
    try {
      const next = tenantSkills
        .filter((skill) => skill.id !== skillId ? skill.enabled : enabled)
        .map((skill) => skill.id);
      await updateTenantSkillSelections(tenantIdScope, next);
      await refreshTenantSkills();
    } catch (err) {
      alert(err instanceof Error ? err.message : "更新失败");
    }
  }, [refreshTenantSkills, tenantIdScope, tenantSkills]);

  const handlePromote = useCallback(async (skillId: string, sourceUser: string) => {
    try {
      await promoteSkill(skillId, sourceUser);
    } catch {
      alert("提升失败");
    }
  }, [promoteSkill]);

  const openEditor = useCallback(async (target: { username: string; skillId: string; name: string }) => {
    setEditTarget(target);
    setEditContent("");
    setEditLoading(true);
    try {
      const doc = await fetchCustomSkillDocument(target.username, target.skillId);
      setEditContent(doc.content);
    } catch (err) {
      alert(err instanceof Error ? err.message : "读取失败");
      setEditTarget(null);
    } finally {
      setEditLoading(false);
    }
  }, [fetchCustomSkillDocument]);

  const saveEditor = useCallback(async () => {
    if (!editTarget) return;
    setEditSaving(true);
    try {
      await updateCustomSkillDocument(editTarget.username, editTarget.skillId, editContent);
      setEditTarget(null);
      await refreshAll();
    } catch (err) {
      alert(err instanceof Error ? err.message : "保存失败");
    } finally {
      setEditSaving(false);
    }
  }, [editContent, editTarget, refreshAll, updateCustomSkillDocument]);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteCustomSkill(deleteTarget.username, deleteTarget.skillId);
      setDeleteTarget(null);
    } catch {
      alert("删除失败");
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, deleteCustomSkill]);

  const customUsers = customData?.users ?? {};
  const tenantUsernames = tenantIdScope
    ? new Set(users.filter((u) => u.tenantId === tenantIdScope).map((u) => u.username))
    : null;
  const visiblePoolSkills = mode === "tenant"
    ? tenantSkills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      visible: skill.enabled,
    }))
    : poolSkills;
  const visibleCustomUsers = Object.fromEntries(
    Object.entries(customUsers).filter(([username]) => !tenantUsernames || tenantUsernames.has(username)),
  );
  const userSkillCount = Object.values(visibleCustomUsers).reduce((sum, arr) => sum + arr.length, 0);
  const hasCustomSkills = userSkillCount > 0;

  if (loading || tenantLoading || (tenantIdScope && usersLoading)) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col">
      <SettingsPanelHeader
        title={isTenantMode && tenantName ? `${tenantName} · Skill 管理` : "Skill 管理"}
        description={isTenantMode ? "管理当前组织可用的 Agent Skill 与用户自建 Skill。" : "管理平台全局 Agent Skill 池，支持启用、禁用和同步。"}
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
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Zap className="mr-1.5 h-3.5 w-3.5" />
                )}
                强制同步
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => { void refreshAll(); }}
            >
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              刷新
            </Button>
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
                  全局Skills
                  <span className="ml-1.5 text-xs font-normal">({visiblePoolSkills.length})</span>
                </TabsTrigger>
                <TabsTrigger value="user" className="h-9 rounded-md px-3 data-[state=active]:bg-brand-accent-soft data-[state=active]:text-foreground data-[state=active]:shadow-none">
                  用户Skills
                  <span className="ml-1.5 text-xs font-normal">({userSkillCount})</span>
                </TabsTrigger>
              </TabsList>
            </div>

            <div className="min-h-0 flex-1 overflow-auto pt-4">
              <TabsContent value="global" forceMount className="mt-0">
                <div className="rounded-2xl border bg-card shadow-sm">
                  <div className="space-y-1 p-4">
            {visiblePoolSkills.length === 0 ? (
              <div className="py-4 text-center text-sm text-muted-foreground">暂无全局Skills</div>
            ) : (
              visiblePoolSkills.map(skill => (
                <div key={skill.id} className="flex items-start gap-3 rounded-lg p-2.5 transition-colors hover:bg-muted/50">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{skill.name}</div>
                    {skill.description && (
                      <p className="mt-0.5 whitespace-pre-wrap break-words text-xs text-muted-foreground">{skill.description}</p>
                    )}
                  </div>
                  <Switch
                    checked={skill.visible}
                    onCheckedChange={(checked) => isTenantMode
                      ? handleToggleTenantSkill(skill.id, checked)
                      : handleToggleVisibility(skill.id, checked)}
                    className="shrink-0"
                  />
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
              <div className="py-4 text-center text-sm text-muted-foreground">暂无用户Skills</div>
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
                                onClick={() => { void openEditor({ username, skillId: skill.id, name: skill.name }); }}
                              >
                                <Pencil className="mr-1 h-3.5 w-3.5" />
                                接管编辑
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2 text-xs"
                                onClick={() => handlePromote(skill.id, username)}
                              >
                                <ArrowUpCircle className="mr-1 h-3.5 w-3.5" />
                                提升到全局
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                                onClick={() => setDeleteTarget({ username, skillId: skill.id, name: skill.name })}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
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
            <DialogTitle>接管编辑 Skill</DialogTitle>
            <DialogDescription>
              正在编辑 {editTarget?.username} 的 Skill “{editTarget?.name}”。保存时会校验 SKILL.md frontmatter，且 name 必须与 Skill ID 保持一致。
            </DialogDescription>
          </DialogHeader>
          {editLoading ? (
            <div className="flex h-64 items-center justify-center text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : (
            <textarea
              className="min-h-96 w-full rounded-md border bg-background px-3 py-2 font-mono text-sm"
              value={editContent}
              onChange={(event) => setEditContent(event.target.value)}
              spellCheck={false}
            />
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditTarget(null)}>取消</Button>
            <Button onClick={() => { void saveEditor(); }} disabled={editLoading || editSaving}>
              {editSaving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
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
              确定要删除 {deleteTarget?.username} 的 Skill "{deleteTarget?.name}" 吗？此操作不可撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              取消
            </Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={deleting}>
              {deleting && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

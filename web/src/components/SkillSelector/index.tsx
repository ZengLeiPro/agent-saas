import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Loader2, Save, Trash2, Upload } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { deleteMySkill, importMySkill } from "@agent/shared";
import { SkillToggleItem } from "./SkillToggleItem";
import { useMySkills } from "./hooks";
import { SettingsPanelHeader } from "@/components/SettingsCenter/SettingsPanelHeader";

interface SkillSelectorProps {
  targetUsername?: string;
  /** 不传时不渲染顶部「返回」按钮，用于嵌入设置中心独立 section 的场景。 */
  onBack?: () => void;
  /** 设置弹窗内使用：把保存/导入按钮挂到统一标题区。 */
  headerTitle?: string;
  headerDescription?: string;
}

export function SkillSelector({ targetUsername, onBack, headerTitle, headerDescription }: SkillSelectorProps) {
  const { data, loading, error, saving, saveSelections, refresh } = useMySkills(targetUsername);
  const [localSelections, setLocalSelections] = useState<Record<string, boolean>>({});
  const [initialSelections, setInitialSelections] = useState<Record<string, boolean>>({});
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState(false);
  const [initialized, setInitialized] = useState(false);
  // 导入 Skill（仅当编辑自己的 skills 时显示入口；admin 编辑他人时隐藏）
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [importOk, setImportOk] = useState(false);
  const skillFileInputRef = useRef<HTMLInputElement>(null);
  const skillFolderInputRef = useRef<HTMLInputElement>(null);
  const skillZipInputRef = useRef<HTMLInputElement>(null);
  const canImport = !targetUsername; // 仅编辑自己时显示，admin 编辑他人路径不挂导入
  // 自建 skill 删除对话框（仅编辑自己时可用；admin 编辑他人走 SkillManager 的删除路径）
  const canDeleteCustom = !targetUsername;
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);
  // tab 切换：与 SkillManager 同款样式
  const [activeTab, setActiveTab] = useState<"system" | "custom">("system");

  useEffect(() => {
    if (!data) return;
    const selections: Record<string, boolean> = {};
    for (const s of data.poolSkills) {
      selections[s.id] = s.selected;
    }
    for (const s of data.tenantSkills ?? []) {
      selections[s.id] = s.selected;
    }
    for (const s of data.customSkills) {
      selections[s.id] = s.selected;
    }
    setLocalSelections(selections);
    setInitialSelections(selections);
    setInitialized(true);
  }, [data]);

  const dirty = initialized && Object.keys(localSelections).some(
    id => localSelections[id] !== initialSelections[id],
  );

  const toggle = useCallback((id: string, checked: boolean) => {
    setLocalSelections(prev => ({ ...prev, [id]: checked }));
  }, []);

  const handleSave = useCallback(async () => {
    const selectedSkills = Object.entries(localSelections)
      .filter(([, v]) => v)
      .map(([k]) => k);
    try {
      setSaveMsg(null);
      setSaveOk(false);
      await saveSelections(selectedSkills);
      setInitialSelections({ ...localSelections });
      setSaveMsg("已保存");
      setSaveOk(true);
      setTimeout(() => setSaveMsg(null), 2000);
    } catch (err) {
      setSaveOk(false);
      setSaveMsg(`保存失败: ${err instanceof Error ? err.message : "未知错误"}`);
    }
  }, [localSelections, saveSelections]);

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteErr(null);
    try {
      await deleteMySkill(deleteTarget.id);
      // 本地 selection 状态同步清理，避免 UI 残留孤儿 id
      setLocalSelections(prev => {
        const next = { ...prev };
        delete next[deleteTarget.id];
        return next;
      });
      setInitialSelections(prev => {
        const next = { ...prev };
        delete next[deleteTarget.id];
        return next;
      });
      setDeleteTarget(null);
      await refresh();
    } catch (err) {
      setDeleteErr(err instanceof Error ? err.message : "删除失败");
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, refresh]);

  const handleSkillImport = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    if (files.length === 0) return;
    setImporting(true);
    setImportMsg(null);
    setImportOk(false);
    try {
      const result = await importMySkill(files);
      setImportDialogOpen(false);
      setImportOk(true);
      setImportMsg(`已导入技能：${result.skill.name}`);
      await refresh();
      setTimeout(() => setImportMsg(null), 2200);
    } catch (err) {
      setImportOk(false);
      setImportMsg(`导入失败: ${err instanceof Error ? err.message : "未知错误"}`);
    } finally {
      setImporting(false);
    }
  }, [refresh]);

  const backButton = onBack ? (
    <button
      type="button"
      className="mb-4 flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
      onClick={onBack}
    >
      <ArrowLeft className="h-4 w-4" />
      返回
    </button>
  ) : null;

  if (loading || !initialized) {
    return (
      <div className="flex flex-1 flex-col">
        {backButton}
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-1 flex-col">
        {backButton}
        <div className="py-8 text-center text-sm text-destructive">{error}</div>
      </div>
    );
  }

  const poolSkills = data?.poolSkills ?? [];
  const tenantSkills = data?.tenantSkills ?? [];
  const customSkills = data?.customSkills ?? [];
  const showActions = poolSkills.length > 0 || tenantSkills.length > 0 || customSkills.length > 0 || canImport;
  const actionControls = showActions ? (
    <>
      {(poolSkills.length > 0 || customSkills.length > 0) && (
        <Button onClick={handleSave} disabled={saving || !dirty}>
          {saving ? (
            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
          ) : (
            <Save className="mr-1.5 h-4 w-4" />
          )}
          保存
        </Button>
      )}
      {canImport && (
        <Button
          variant="outline"
          onClick={() => setImportDialogOpen(true)}
          disabled={importing}
        >
          {importing ? (
            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
          ) : (
            <Upload className="mr-1.5 h-4 w-4" />
          )}
          导入技能
        </Button>
      )}
      {saveMsg && (
        <span className={cn(
          "text-sm",
          saveOk ? "text-success" : "text-destructive"
        )}>
          {saveMsg}
        </span>
      )}
      {importMsg && (
        <span className={cn(
          "text-sm",
          importOk ? "text-success" : "text-destructive"
        )}>
          {importMsg}
        </span>
      )}
    </>
  ) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {headerTitle ? (
        <SettingsPanelHeader
          title={headerTitle}
          description={headerDescription}
          actions={actionControls}
        />
      ) : null}
      {backButton}

      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as "system" | "custom")} className="flex min-h-0 flex-1 flex-col">
        <div className="mb-4 shrink-0 rounded-lg border bg-card p-1 shadow-sm">
          <TabsList className="grid h-auto w-full grid-cols-2 gap-1 bg-transparent p-0 text-muted-foreground">
            <TabsTrigger value="system" className="h-9 rounded-md px-3 data-[state=active]:bg-brand-accent-soft data-[state=active]:text-foreground data-[state=active]:shadow-none">
              系统技能
              <span className="ml-1.5 text-xs font-normal">({poolSkills.length + tenantSkills.length})</span>
            </TabsTrigger>
            <TabsTrigger value="custom" className="h-9 rounded-md px-3 data-[state=active]:bg-brand-accent-soft data-[state=active]:text-foreground data-[state=active]:shadow-none">
              自建技能
              <span className="ml-1.5 text-xs font-normal">({customSkills.length})</span>
            </TabsTrigger>
          </TabsList>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          <TabsContent value="system" forceMount className="mt-0">
            {poolSkills.length === 0 && tenantSkills.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">暂无系统技能</div>
          ) : (
            <div className="space-y-2">
              {poolSkills.map(s => (
                <SkillToggleItem
                  key={s.id}
                  name={s.name}
                  description={s.description}
                  checked={localSelections[s.id] ?? false}
                  onCheckedChange={(checked) => toggle(s.id, checked)}
                />
              ))}
              {tenantSkills.map(s => (
                <SkillToggleItem
                  key={s.id}
                  name={s.name}
                  description={s.description}
                  checked={localSelections[s.id] ?? false}
                  onCheckedChange={(checked) => toggle(s.id, checked)}
                  badge="组织"
                />
              ))}
            </div>
          )}
          </TabsContent>
          <TabsContent value="custom" forceMount className="mt-0">
            {customSkills.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">暂无自建技能，点下方「导入技能」上传 SKILL.md / 文件夹 / zip</div>
            ) : (
              <div className="space-y-2">
                {customSkills.map(s => (
                  <SkillToggleItem
                    key={s.id}
                    name={s.name}
                    description={s.description}
                    checked={localSelections[s.id] ?? false}
                    onCheckedChange={(checked) => toggle(s.id, checked)}
                    badge="自建"
                    leadingAction={canDeleteCustom ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 px-2 text-muted-foreground hover:text-destructive"
                        onClick={() => { setDeleteErr(null); setDeleteTarget({ id: s.id, name: s.name }); }}
                        aria-label={`删除 ${s.name}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    ) : undefined}
                  />
                ))}
              </div>
            )}
          </TabsContent>
        </div>
      </Tabs>

      {showActions && !headerTitle && (
        <div className="mt-3 flex shrink-0 flex-wrap items-center gap-3 border-t pt-3">
          {actionControls}
        </div>
      )}

      {canImport && (
        <>
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
                <DialogTitle>导入技能</DialogTitle>
                <DialogDescription>
                  支持 SKILL.md 单文件、包含 SKILL.md 的文件夹，或包含同样结构的 zip 压缩包。SKILL.md 需要包含 name 和 description frontmatter。
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
        </>
      )}

      {canDeleteCustom && (
        <Dialog
          open={!!deleteTarget}
          onOpenChange={(open) => { if (!open && !deleting) { setDeleteTarget(null); setDeleteErr(null); } }}
        >
          <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-sm">
            <DialogHeader>
              <DialogTitle>删除自建技能</DialogTitle>
              <DialogDescription>
                确定删除自建技能“{deleteTarget?.name}”？操作不可撤销，SKILL.md 及关联 references/scripts 会一并从你的 workspace 中移除。
              </DialogDescription>
            </DialogHeader>
            {deleteErr && <div className="text-sm text-destructive">{deleteErr}</div>}
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => { setDeleteTarget(null); setDeleteErr(null); }}
                disabled={deleting}
              >
                取消
              </Button>
              <Button
                variant="destructive"
                onClick={() => { void handleDeleteConfirm(); }}
                disabled={deleting}
              >
                {deleting && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                删除
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

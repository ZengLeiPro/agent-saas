import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, Loader2, Plus, Trash2, Upload } from "lucide-react";
import { EntityIcons } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { deleteMySkill, importMySkill } from "@agent/shared";
import type { UserSkillInfo } from "@agent/shared";
import { useMySkills } from "./hooks";
import {
  CatalogHeader,
  CapabilityDetailDrawer,
  CapabilityLogo,
  CapabilitySourceBadge,
  CatalogToolbar,
  type CapabilitySource,
} from "@/components/CapabilityCenter/CatalogUi";

interface SkillSelectorProps {
  targetUsername?: string;
  /** 不传时不渲染顶部「返回」按钮，用于嵌入设置中心独立 section 的场景。 */
  onBack?: () => void;
  /** 设置弹窗内使用：把导入按钮挂到统一标题区。 */
  headerTitle?: string;
  headerDescription?: string;
  /** 嵌入已有滚动页面时，由外层统一负责滚动。 */
  embedded?: boolean;
}

type SkillFilter = "all" | "platform" | "organization" | "personal" | "enabled";

function skillSource(skill: UserSkillInfo): CapabilitySource {
  if (skill.source === "tenant") return "organization";
  if (skill.source === "custom") return "personal";
  return "platform";
}

function sourceDescription(source: CapabilitySource): string {
  if (source === "organization") return "由当前组织提供，并按组织规则开放给成员使用。";
  if (source === "personal") return "由你创建，仅你本人可以管理和使用。";
  return "由平台统一维护，再由组织决定是否向成员开放。";
}

export function SkillSelector({ targetUsername, onBack, headerTitle, headerDescription, embedded = false }: SkillSelectorProps) {
  const { data, loading, error, saving, saveSelections, refresh } = useMySkills(targetUsername);
  const [localSelections, setLocalSelections] = useState<Record<string, boolean>>({});
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState(false);
  const [pendingSkillId, setPendingSkillId] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [query, setQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState<SkillFilter>("all");
  const [detailSkill, setDetailSkill] = useState<UserSkillInfo | null>(null);
  // 导入 Skill（仅当编辑自己的 skills 时显示入口；admin 编辑他人时隐藏）
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [importOk, setImportOk] = useState(false);
  const skillFileInputRef = useRef<HTMLInputElement>(null);
  const skillFolderInputRef = useRef<HTMLInputElement>(null);
  const skillZipInputRef = useRef<HTMLInputElement>(null);
  const canImport = !targetUsername;
  const canDeleteCustom = !targetUsername;
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;
    const selections: Record<string, boolean> = {};
    for (const skill of [...data.poolSkills, ...(data.tenantSkills ?? []), ...data.customSkills]) {
      selections[skill.id] = skill.selected;
    }
    setLocalSelections(selections);
    setInitialized(true);
  }, [data]);

  const skills = useMemo(
    () => [...(data?.poolSkills ?? []), ...(data?.tenantSkills ?? []), ...(data?.customSkills ?? [])],
    [data],
  );

  const filteredSkills = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return skills.filter((skill) => {
      const source = skillSource(skill);
      const matchesSource = activeFilter === "all"
        || (activeFilter === "enabled" ? localSelections[skill.id] === true : source === activeFilter);
      const matchesQuery = !normalizedQuery
        || skill.name.toLocaleLowerCase().includes(normalizedQuery)
        || skill.description.toLocaleLowerCase().includes(normalizedQuery);
      return matchesSource && matchesQuery;
    });
  }, [activeFilter, localSelections, query, skills]);

  const enabledCount = Object.values(localSelections).filter(Boolean).length;
  const filters = useMemo(() => [
    { value: "all" as const, label: "全部", count: skills.length },
    { value: "enabled" as const, label: "已启用", count: enabledCount },
    { value: "platform" as const, label: "平台提供", count: skills.filter((skill) => skillSource(skill) === "platform").length },
    { value: "organization" as const, label: "组织提供", count: skills.filter((skill) => skillSource(skill) === "organization").length },
    { value: "personal" as const, label: "我创建的", count: skills.filter((skill) => skillSource(skill) === "personal").length },
  ], [enabledCount, skills]);

  const toggle = useCallback(async (id: string, checked: boolean) => {
    if (saving) return;
    const previous = localSelections;
    const next = { ...localSelections, [id]: checked };
    setLocalSelections(next);
    setPendingSkillId(id);
    setSaveMsg(null);
    try {
      await saveSelections(Object.entries(next).filter(([, selected]) => selected).map(([skillId]) => skillId));
      setSaveOk(true);
      setSaveMsg(checked ? "技能已启用" : "技能已停用");
      setTimeout(() => setSaveMsg(null), 1800);
    } catch (err) {
      setLocalSelections(previous);
      setSaveOk(false);
      setSaveMsg(err instanceof Error ? err.message : "更新失败");
    } finally {
      setPendingSkillId(null);
    }
  }, [localSelections, saveSelections, saving]);

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteErr(null);
    try {
      await deleteMySkill(deleteTarget.id);
      setLocalSelections((prev) => {
        const next = { ...prev };
        delete next[deleteTarget.id];
        return next;
      });
      setDeleteTarget(null);
      setDetailSkill(null);
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
      setImportMsg(`导入失败：${err instanceof Error ? err.message : "未知错误"}`);
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
      <ArrowLeft className="size-4" />
      返回
    </button>
  ) : null;

  if (loading || !initialized) {
    return (
      <div className="flex flex-1 flex-col">
        {backButton}
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
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

  const actionControls = (
    <>
      {canImport ? (
        <Button variant="outline" onClick={() => setImportDialogOpen(true)} disabled={importing}>
          {importing ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
          导入技能
        </Button>
      ) : null}
      {saveMsg ? <span className={cn("text-sm", saveOk ? "text-success" : "text-destructive")}>{saveMsg}</span> : null}
      {importMsg ? <span className={cn("text-sm", importOk ? "text-success" : "text-destructive")}>{importMsg}</span> : null}
    </>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {headerTitle ? <CatalogHeader title={headerTitle} description={headerDescription} actions={actionControls} /> : null}
      {backButton}

      <CatalogToolbar
        query={query}
        onQueryChange={setQuery}
        searchPlaceholder="搜索技能名称或描述"
        filters={filters}
        activeFilter={activeFilter}
        onFilterChange={setActiveFilter}
        actions={!headerTitle ? actionControls : undefined}
      />

      <div className={cn("min-h-0 flex-1 pb-2", !embedded && "overflow-auto")}>
        {filteredSkills.length === 0 ? (
          <div className="rounded-2xl border border-dashed px-6 py-12 text-center text-sm text-muted-foreground">
            {skills.length === 0 ? "暂无可用技能" : "没有找到匹配的技能"}
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {filteredSkills.map((skill) => {
              const source = skillSource(skill);
              const selected = localSelections[skill.id] === true;
              return (
                <Card
                  key={skill.id}
                  className="group cursor-pointer border-border/70 transition-all hover:-translate-y-0.5 hover:border-brand-200 hover:shadow-md"
                  onClick={() => setDetailSkill(skill)}
                  onKeyDown={(event) => {
                    if ((event.target as HTMLElement).closest("button")) return;
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setDetailSkill(skill);
                    }
                  }}
                  role="button"
                  tabIndex={0}
                >
                  <CardContent className="flex min-h-40 flex-col p-4">
                    <div className="flex items-start gap-3">
                      <CapabilityLogo label={skill.name}><EntityIcons.skill className="size-5" /></CapabilityLogo>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-semibold">{skill.name}</div>
                            <div className="mt-1"><CapabilitySourceBadge source={source} /></div>
                          </div>
                          <button
                            type="button"
                            className={cn(
                              "flex size-8 shrink-0 items-center justify-center rounded-lg border transition-colors",
                              selected
                                ? "border-brand-200 bg-brand-50 text-brand-700 dark:bg-brand-900/35 dark:text-brand-200"
                                : "bg-muted/40 text-muted-foreground hover:border-brand-200 hover:bg-brand-50 hover:text-brand-700",
                            )}
                            onClick={(event) => {
                              event.stopPropagation();
                              void toggle(skill.id, !selected);
                            }}
                            disabled={saving}
                            aria-label={`${selected ? "停用" : "启用"} ${skill.name}`}
                          >
                            {pendingSkillId === skill.id ? <Loader2 className="size-4 animate-spin" /> : selected ? <Check className="size-4" /> : <Plus className="size-4" />}
                          </button>
                        </div>
                      </div>
                    </div>
                    <p className="mt-4 line-clamp-3 text-sm leading-5 text-muted-foreground">
                      {skill.description || "暂无技能说明"}
                    </p>
                    <div className="mt-auto pt-3 text-xs text-muted-foreground">点击查看详情</div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      <CapabilityDetailDrawer
        open={!!detailSkill}
        onOpenChange={(open) => { if (!open) setDetailSkill(null); }}
        title={detailSkill?.name ?? "技能详情"}
        description={detailSkill?.description}
      >
        {detailSkill ? (
          <>
            <div className="flex items-center gap-3">
              <CapabilityLogo label={detailSkill.name}><EntityIcons.skill className="size-5" /></CapabilityLogo>
              <div>
                <CapabilitySourceBadge source={skillSource(detailSkill)} />
                <div className="mt-1 text-xs text-muted-foreground">
                  {localSelections[detailSkill.id] ? "已为通用 Agent 启用" : "尚未启用"}
                </div>
              </div>
            </div>
            <div className="rounded-xl bg-muted/40 p-4 text-sm leading-6 text-muted-foreground">
              {sourceDescription(skillSource(detailSkill))}
            </div>
            <Button
              className="w-full"
              variant={localSelections[detailSkill.id] ? "outline" : "default"}
              disabled={saving}
              onClick={() => { void toggle(detailSkill.id, !localSelections[detailSkill.id]); }}
            >
              {pendingSkillId === detailSkill.id ? <Loader2 className="size-4 animate-spin" /> : localSelections[detailSkill.id] ? <Check className="size-4" /> : <Plus className="size-4" />}
              {localSelections[detailSkill.id] ? "停用技能" : "启用技能"}
            </Button>
            {canDeleteCustom && detailSkill.source === "custom" ? (
              <Button
                variant="ghost"
                className="w-full text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => { setDeleteErr(null); setDeleteTarget({ id: detailSkill.id, name: detailSkill.name }); }}
              >
                <Trash2 className="size-4" />删除自建技能
              </Button>
            ) : null}
          </>
        ) : null}
      </CapabilityDetailDrawer>

      {canImport ? (
        <>
          <input ref={skillFileInputRef} type="file" accept=".md,text/markdown" className="hidden" onChange={(event) => { void handleSkillImport(event); }} />
          <input ref={skillZipInputRef} type="file" accept=".zip,application/zip" className="hidden" onChange={(event) => { void handleSkillImport(event); }} />
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
                <Button variant="outline" onClick={() => skillFileInputRef.current?.click()} disabled={importing}>上传 SKILL.md</Button>
                <Button variant="outline" onClick={() => skillFolderInputRef.current?.click()} disabled={importing}>上传文件夹</Button>
                <Button variant="outline" onClick={() => skillZipInputRef.current?.click()} disabled={importing}>上传 zip 压缩包</Button>
              </div>
            </DialogContent>
          </Dialog>
        </>
      ) : null}

      {canDeleteCustom ? (
        <Dialog open={!!deleteTarget} onOpenChange={(open) => { if (!open && !deleting) { setDeleteTarget(null); setDeleteErr(null); } }}>
          <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-sm">
            <DialogHeader>
              <DialogTitle>删除自建技能</DialogTitle>
              <DialogDescription>
                确定删除自建技能“{deleteTarget?.name}”？操作不可撤销，SKILL.md 及关联 references/scripts 会一并从你的 workspace 中移除。
              </DialogDescription>
            </DialogHeader>
            {deleteErr ? <div className="text-sm text-destructive">{deleteErr}</div> : null}
            <DialogFooter>
              <Button variant="outline" onClick={() => { setDeleteTarget(null); setDeleteErr(null); }} disabled={deleting}>取消</Button>
              <Button variant="destructive" onClick={() => { void handleDeleteConfirm(); }} disabled={deleting}>
                {deleting ? <Loader2 className="size-4 animate-spin" /> : null}
                删除
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}

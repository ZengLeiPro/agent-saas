import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ArrowLeft, Check, ChevronRight, Loader2, Pencil, Plus, SearchX, Trash2, Upload } from "lucide-react";
import { skillCategoryClass, skillIcon } from "@/lib/skillIcons";
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
import { deleteMySkill, fetchMySkillDocument, SkillSelectionConflictError, updateMySkillDocument } from "@agent/shared";
import { governanceResourcesApi } from "@agent/shared/lib/governanceApi";
import type { UserSkillInfo } from "@agent/shared";
import { useMySkills } from "./hooks";
import {
  CatalogHeader,
  CapabilityDetailDrawer,
  CapabilityLogo,
  CapabilitySourceBadge,
  CatalogToolbar,
  CAPABILITY_EMPTY_SURFACE,
  CAPABILITY_SUBTLE_SURFACE,
  CAPABILITY_SURFACE,
  CAPABILITY_SURFACE_HOVER,
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

export function SkillSelector({
  targetUsername,
  onBack,
  headerTitle,
  headerDescription,
  embedded = false,
}: SkillSelectorProps) {
  const { data, loading, error, saving, saveSelection, refresh } = useMySkills(targetUsername);
  const [localSelections, setLocalSelections] = useState<Record<string, boolean>>({});
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState(false);
  const [pendingSkillId, setPendingSkillId] = useState<string | null>(null);
  const toggleInFlightRef = useRef(false);
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
  const [editTarget, setEditTarget] = useState<{ id: string; name: string } | null>(null);
  const [editContent, setEditContent] = useState("");
  const [editing, setEditing] = useState(false);
  const [editErr, setEditErr] = useState<string | null>(null);

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

  /**
   * 只按搜索词过滤、不含来源过滤的集合。
   * 来源 chip 的计数必须基于它，避免搜索后筛选数量仍显示全量数据。
   */
  const querySkills = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return skills;
    return skills.filter(
      (skill) =>
        skill.name.toLocaleLowerCase().includes(normalizedQuery) ||
        skill.description.toLocaleLowerCase().includes(normalizedQuery),
    );
  }, [query, skills]);

  const filteredSkills = useMemo(
    () =>
      querySkills.filter((skill) => {
        if (activeFilter === "all") return true;
        if (activeFilter === "enabled") return localSelections[skill.id] === true;
        return skillSource(skill) === activeFilter;
      }),
    [activeFilter, localSelections, querySkills],
  );

  const filters = useMemo(
    () => [
      { value: "all" as const, label: "全部", count: querySkills.length },
      {
        value: "enabled" as const,
        label: "已启用",
        count: querySkills.filter((skill) => localSelections[skill.id] === true).length,
      },
      {
        value: "platform" as const,
        label: "平台提供",
        count: querySkills.filter((skill) => skillSource(skill) === "platform").length,
      },
      {
        value: "organization" as const,
        label: "组织提供",
        count: querySkills.filter((skill) => skillSource(skill) === "organization").length,
      },
      {
        value: "personal" as const,
        label: "我创建的",
        count: querySkills.filter((skill) => skillSource(skill) === "personal").length,
      },
    ],
    [localSelections, querySkills],
  );

  const toggle = useCallback(
    async (id: string, checked: boolean) => {
      if (saving || toggleInFlightRef.current) return;
      toggleInFlightRef.current = true;
      const previous = localSelections;
      setLocalSelections({ ...localSelections, [id]: checked });
      setPendingSkillId(id);
      setSaveMsg(null);
      try {
        await saveSelection(id, checked);
        setSaveOk(true);
        setSaveMsg(checked ? "技能已启用" : "技能已停用");
        setTimeout(() => setSaveMsg(null), 1800);
      } catch (err) {
        if (!(err instanceof SkillSelectionConflictError)) setLocalSelections(previous);
        setSaveOk(false);
        setSaveMsg(err instanceof Error ? err.message : "更新失败");
      } finally {
        toggleInFlightRef.current = false;
        setPendingSkillId(null);
      }
    },
    [localSelections, saveSelection, saving],
  );

  const openEdit = useCallback(async (skill: UserSkillInfo) => {
    setEditing(true);
    setEditErr(null);
    try {
      const doc = await fetchMySkillDocument(skill.id);
      setEditContent(doc.content);
      setEditTarget({ id: skill.id, name: skill.name });
    } catch (err) {
      setEditErr(err instanceof Error ? err.message : "读取失败");
    } finally {
      setEditing(false);
    }
  }, []);

  const handleEditSave = useCallback(async () => {
    if (!editTarget) return;
    setEditing(true);
    setEditErr(null);
    try {
      await updateMySkillDocument(editTarget.id, editContent);
      setEditTarget(null);
      setDetailSkill(null);
      await refresh();
    } catch (err) {
      setEditErr(err instanceof Error ? err.message : "保存失败");
    } finally {
      setEditing(false);
    }
  }, [editContent, editTarget, refresh]);

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

  const handleSkillImport = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files || []);
      event.target.value = "";
      if (files.length === 0) return;
      setImporting(true);
      setImportMsg(null);
      setImportOk(false);
      try {
        const result = await governanceResourcesApi.importPersonalSkillPackage(files);
        setImportOk(true);
        const auditStatus = result.auditCompletion === "pending" ? "，审计记录同步中" : "";
        setImportMsg(
          result.selected === false
            ? `已导入并发布技能：${result.skill.name}（v${result.version.versionNumber}${auditStatus}），但未能自动启用，请在列表中手动启用`
            : `已导入并发布技能：${result.skill.name}（v${result.version.versionNumber}${auditStatus}）`,
        );
        await refresh();
        setTimeout(() => setImportMsg(null), 2200);
      } catch (err) {
        setImportOk(false);
        setImportMsg(`导入失败：${err instanceof Error ? err.message : "未知错误"}`);
      } finally {
        setImportDialogOpen(false);
        setImporting(false);
      }
    },
    [refresh],
  );

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

  const DetailSkillGlyph = detailSkill ? skillIcon(detailSkill.id) : null;

  const actionControls = (
    <>
      {canImport ? (
        <Button variant="outline" onClick={() => setImportDialogOpen(true)} disabled={importing}>
          {importing ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
          导入技能
        </Button>
      ) : null}
      {saveMsg ? <span className={cn("text-sm", saveOk ? "text-success" : "text-destructive")}>{saveMsg}</span> : null}
      {importMsg ? (
        <span className={cn("text-sm", importOk ? "text-success" : "text-destructive")}>{importMsg}</span>
      ) : null}
    </>
  );

  // 启用只更新卡片自身状态，不改变统一列表中的位置。
  const renderSkillCard = (skill: UserSkillInfo, index: number) => {
    const source = skillSource(skill);
    const selected = localSelections[skill.id] === true;
    const SkillGlyph = skillIcon(skill.id);
    const versionLabel = skill.governance?.version ? `v${skill.governance.version}` : "";
    return (
      <Card
        key={skill.id}
        style={{ "--i": Math.min(index, 12) } as CSSProperties}
        className={cn(
          "cap-grid-item group relative cursor-pointer overflow-hidden border-0 shadow-none",
          CAPABILITY_SURFACE,
          CAPABILITY_SURFACE_HOVER,
          selected &&
            "ring-success/30 before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-success/60",
        )}
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
        <CardContent className="flex min-h-[9.5rem] flex-col p-4">
          <div className="flex items-start gap-3">
            <CapabilityLogo
              label={skill.name}
              tone={selected ? "bg-success/10 text-success-ink ring-success/20" : skillCategoryClass(skill.id)}
            >
              <SkillGlyph className="size-5" />
            </CapabilityLogo>
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">
                    <HighlightedText text={skill.name} query={query} />
                  </div>
                  <div className="mt-1">
                    <CapabilitySourceBadge source={source} className="px-1.5 text-2xs" />
                  </div>
                </div>
                <button
                  type="button"
                  className={cn(
                    "flex size-7 shrink-0 items-center justify-center rounded-full border transition-all duration-200 ease-out active:scale-95 motion-reduce:transition-none",
                    selected
                      ? "border-success/25 bg-success/10 text-success-ink hover:bg-success/20"
                      : "border-border/70 bg-transparent text-muted-foreground hover:border-success/40 hover:bg-success/10 hover:text-success-ink",
                  )}
                  onClick={(event) => {
                    event.stopPropagation();
                    void toggle(skill.id, !selected);
                  }}
                  disabled={saving}
                  aria-label={`${selected ? "停用" : "启用"} ${skill.name}`}
                >
                  {pendingSkillId === skill.id ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : selected ? (
                    <Check className="size-4 animate-in zoom-in-50 duration-200" strokeWidth={2.5} />
                  ) : (
                    <Plus className="size-4" />
                  )}
                </button>
              </div>
            </div>
          </div>
          <p className="mt-3 min-h-10 line-clamp-2 text-sm leading-5 text-muted-foreground">
            <HighlightedText text={skill.description || "暂无技能说明"} query={query} />
          </p>
          <div className="mt-auto flex items-center justify-between gap-2 pt-3 text-2xs text-muted-foreground">
            <span className="truncate">
              {versionLabel}
              {versionLabel && selected ? " · " : ""}
              {selected ? "已启用" : ""}
            </span>
            <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-within:opacity-100">
              详情
              <ChevronRight className="size-3 transition-transform duration-200 group-hover:translate-x-0.5" />
            </span>
          </div>
        </CardContent>
      </Card>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {headerTitle ? (
        <CatalogHeader title={headerTitle} description={headerDescription} actions={actionControls} />
      ) : null}
      {backButton}

      <CatalogToolbar
        query={query}
        onQueryChange={setQuery}
        searchPlaceholder="搜索技能名称或描述"
        filters={filters}
        activeFilter={activeFilter}
        onFilterChange={setActiveFilter}
        actions={!headerTitle ? actionControls : undefined}
        sticky={embedded}
      />

      <div className={cn("min-h-0 flex-1 pb-2", !embedded && "overflow-auto")}>
        {filteredSkills.length === 0 ? (
          <div
            className={cn(
              "flex flex-col items-center px-6 py-12 text-center text-sm text-muted-foreground",
              CAPABILITY_EMPTY_SURFACE,
            )}
          >
            <SearchX className="size-8 opacity-60" aria-hidden="true" />
            <div className="mt-3 font-medium text-foreground">
              {skills.length === 0
                ? "暂无可用技能"
                : query.trim()
                  ? `没有匹配「${query.trim()}」的技能`
                  : "当前来源没有可用技能"}
            </div>
            {skills.length > 0 ? (
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                {query ? (
                  <Button type="button" variant="outline" size="sm" onClick={() => setQuery("")}>
                    清空搜索
                  </Button>
                ) : null}
                {activeFilter !== "all" ? (
                  <Button type="button" variant="outline" size="sm" onClick={() => setActiveFilter("all")}>
                    切到全部来源
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {filteredSkills.map((skill, index) => renderSkillCard(skill, index))}
          </div>
        )}
      </div>

      <CapabilityDetailDrawer
        open={!!detailSkill}
        onOpenChange={(open) => {
          if (!open) setDetailSkill(null);
        }}
        title={detailSkill?.name ?? "技能详情"}
        description={detailSkill?.description}
      >
        {detailSkill ? (
          <>
            <div className="flex items-center gap-3">
              <CapabilityLogo label={detailSkill.name}>
                {DetailSkillGlyph ? <DetailSkillGlyph className="size-5" /> : null}
              </CapabilityLogo>
              <div>
                <CapabilitySourceBadge source={skillSource(detailSkill)} />
                {localSelections[detailSkill.id] ? (
                  <div className="mt-1 flex items-center gap-1.5 text-xs font-medium text-success">
                    <span className="size-1.5 rounded-full bg-success" />
                    已为通用 Agent 启用
                  </div>
                ) : (
                  <div className="mt-1 text-xs text-muted-foreground">尚未启用</div>
                )}
              </div>
            </div>
            <div className={cn("p-4 text-sm leading-6 text-muted-foreground", CAPABILITY_SUBTLE_SURFACE)}>
              {sourceDescription(skillSource(detailSkill))}
              {detailSkill.governance ? (
                <div className="mt-2 text-xs">
                  {detailSkill.governance.status === "published"
                    ? "已发布"
                    : detailSkill.governance.status === "draft"
                      ? "草稿"
                      : "已退役"}
                  {detailSkill.governance.version ? ` · v${detailSkill.governance.version}` : ""}
                  {` · ${detailSkill.governance.source === "governance_upload" ? "治理上传" : "治理资源"}`}
                  {` · ${detailSkill.governance.scope === "personal" ? "个人" : "组织"}`}
                </div>
              ) : null}
            </div>
            <Button
              className="w-full"
              variant={localSelections[detailSkill.id] ? "outline" : "default"}
              disabled={saving}
              onClick={() => {
                void toggle(detailSkill.id, !localSelections[detailSkill.id]);
              }}
            >
              {pendingSkillId === detailSkill.id ? (
                <Loader2 className="size-4 animate-spin" />
              ) : localSelections[detailSkill.id] ? (
                <Check className="size-4" />
              ) : (
                <Plus className="size-4" />
              )}
              {localSelections[detailSkill.id] ? "停用技能" : "启用技能"}
            </Button>
            {canDeleteCustom && detailSkill.source === "custom" ? (
              <>
                <Button
                  variant="outline"
                  className="w-full"
                  disabled={editing}
                  onClick={() => {
                    void openEdit(detailSkill);
                  }}
                >
                  {editing ? <Loader2 className="size-4 animate-spin" /> : <Pencil className="size-4" />}
                  编辑 SKILL.md
                </Button>
                <Button
                  variant="ghost"
                  className="w-full text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => {
                    setDeleteErr(null);
                    setDeleteTarget({ id: detailSkill.id, name: detailSkill.name });
                  }}
                >
                  <Trash2 className="size-4" />
                  删除自建技能
                </Button>
              </>
            ) : null}
          </>
        ) : null}
      </CapabilityDetailDrawer>

      {canImport ? (
        <>
          <input
            ref={skillFileInputRef}
            type="file"
            accept=".md,text/markdown"
            className="hidden"
            onChange={(event) => {
              void handleSkillImport(event);
            }}
          />
          <input
            ref={skillZipInputRef}
            type="file"
            accept=".zip,application/zip"
            className="hidden"
            onChange={(event) => {
              void handleSkillImport(event);
            }}
          />
          <input
            ref={skillFolderInputRef}
            type="file"
            className="hidden"
            multiple
            {...({ webkitdirectory: "" } as { webkitdirectory: string })}
            onChange={(event) => {
              void handleSkillImport(event);
            }}
          />
          <Dialog open={importDialogOpen} onOpenChange={setImportDialogOpen}>
            <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
              <DialogHeader>
                <DialogTitle>导入技能</DialogTitle>
                <DialogDescription>
                  支持 SKILL.md 单文件、包含 SKILL.md 的文件夹，或包含同样结构的 zip 压缩包。最多 300 个文件（zip
                  目录不计），单个文件不超过 25MB，总计不超过 100MB。SKILL.md 需包含 name 和 description frontmatter。
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-2">
                <Button variant="outline" onClick={() => skillFileInputRef.current?.click()} disabled={importing}>
                  上传 SKILL.md
                </Button>
                <Button variant="outline" onClick={() => skillFolderInputRef.current?.click()} disabled={importing}>
                  上传文件夹
                </Button>
                <Button variant="outline" onClick={() => skillZipInputRef.current?.click()} disabled={importing}>
                  上传 zip 压缩包
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </>
      ) : null}

      {canDeleteCustom ? (
        <Dialog
          open={!!editTarget}
          onOpenChange={(open) => {
            if (!open && !editing) {
              setEditTarget(null);
              setEditErr(null);
            }
          }}
        >
          <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-3xl">
            <DialogHeader>
              <DialogTitle>编辑自建技能“{editTarget?.name}”</DialogTitle>
              <DialogDescription>修改 SKILL.md；name 必须继续与技能 ID 保持一致。</DialogDescription>
            </DialogHeader>
            <textarea
              className="min-h-[420px] w-full rounded-lg border bg-muted/30 p-3 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
              value={editContent}
              onChange={(event) => setEditContent(event.target.value)}
              disabled={editing}
            />
            {editErr ? <div className="text-sm text-destructive">{editErr}</div> : null}
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setEditTarget(null);
                  setEditErr(null);
                }}
                disabled={editing}
              >
                取消
              </Button>
              <Button
                onClick={() => {
                  void handleEditSave();
                }}
                disabled={editing}
              >
                {editing ? <Loader2 className="size-4 animate-spin" /> : null}保存
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}

      {canDeleteCustom ? (
        <Dialog
          open={!!deleteTarget}
          onOpenChange={(open) => {
            if (!open && !deleting) {
              setDeleteTarget(null);
              setDeleteErr(null);
            }
          }}
        >
          <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-sm">
            <DialogHeader>
              <DialogTitle>删除自建技能</DialogTitle>
              <DialogDescription>
                确定删除自建技能“{deleteTarget?.name}”？操作不可撤销，SKILL.md 及关联 references/scripts 会一并从你的
                workspace 中移除。
              </DialogDescription>
            </DialogHeader>
            {deleteErr ? <div className="text-sm text-destructive">{deleteErr}</div> : null}
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setDeleteTarget(null);
                  setDeleteErr(null);
                }}
                disabled={deleting}
              >
                取消
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  void handleDeleteConfirm();
                }}
                disabled={deleting}
              >
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

function HighlightedText({ text, query }: { text: string; query: string }) {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return <>{text}</>;
  const escapedQuery = normalizedQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escapedQuery})`, "gi"));
  return (
    <>
      {parts.map((part, index) =>
        part.toLocaleLowerCase() === normalizedQuery.toLocaleLowerCase() ? (
          <mark key={`${part}-${index}`} className="rounded bg-brand-100/70 px-0.5 text-inherit">
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  );
}

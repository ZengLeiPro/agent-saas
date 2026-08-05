import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useAuth } from "@/contexts/AuthContext";
import { useIsMobile } from "@/hooks/useIsMobile";
import {
  useCronJobs,
  useCronStatus,
  useRunHistory,
  useDingtalkSessions,
  useModelList,
} from "./hooks";
import { JobForm } from "./JobForm";
import { JobList } from "./JobList";
import { RunHistory } from "./RunHistory";
import type { CronJob } from "./types";
import { Button } from "@/components/ui/button";
import { SettingsPanelHeader } from "@/components/SettingsCenter/SettingsPanelHeader";
import { SettingsTwoColumn } from "@/components/SettingsCenter/SettingsTwoColumn";
import { CAPABILITY_EMPTY_SURFACE } from "@/components/CapabilityCenter/CatalogUi";
import { cn } from "@/lib/utils";
import { EntityIcons } from "@/lib/icons";
import { Switch } from "@/components/ui/switch";
import { Play, Plus, RefreshCw, Trash2 } from "lucide-react";
import { refreshAll } from "@/lib/refreshBus";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface CronManagerProps {
  onJobCountChange?: (enabled: number, total: number) => void;
  /** 桌面端全局 Header 的操作区；undefined 时在页面内渲染移动端标题与操作。 */
  headerActionsTarget?: HTMLElement | null;
}

export function CronManager({
  onJobCountChange,
  headerActionsTarget,
}: CronManagerProps) {
  const { user, authEnabled } = useAuth();
  const currentUserId = authEnabled ? user?.id : undefined;
  const canManageJob = useCallback(
    (job: CronJob) => {
      if (!currentUserId) return true;
      return job.owner === currentUserId;
    },
    [currentUserId],
  );

  const { refreshLatest: refreshStatus } = useCronStatus();
  const { jobs: allJobs, addJob, updateJob, deleteJob, runJob } = useCronJobs();

  const jobs = useMemo(() => allJobs, [allJobs]);
  useEffect(() => {
    onJobCountChange?.(jobs.filter((j) => j.enabled).length, jobs.length);
  }, [jobs, onJobCountChange]);

  const { sessions: dingtalkSessions } = useDingtalkSessions();
  const modelList = useModelList();
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);

  // 切换用户时清除不在列表中的选中项
  useEffect(() => {
    if (selectedJobId && !jobs.some((j) => j.id === selectedJobId)) {
      setSelectedJobId(null);
    }
  }, [jobs, selectedJobId]);
  const [showForm, setShowForm] = useState(false);
  const [editingJob, setEditingJob] = useState<CronJob | null>(null);
  const [showFormPanel, setShowFormPanel] = useState(false);
  const [showDetail, setShowDetail] = useState(false);
  const [formSubmitting, setFormSubmitting] = useState(false);
  const [runningJobId, setRunningJobId] = useState<string | null>(null);
  const {
    entries: runEntries,
    loading: runLoading,
    error: runError,
  } = useRunHistory(selectedJobId);

  const isMobile = useIsMobile();

  const selectedJob = useMemo(
    () =>
      selectedJobId ? jobs.find((j) => j.id === selectedJobId) : undefined,
    [jobs, selectedJobId],
  );

  const openCreate = () => {
    setEditingJob(null);
    if (isMobile) {
      setShowForm(true);
    } else {
      setShowFormPanel(true);
    }
  };

  const openEdit = (job: CronJob) => {
    setEditingJob(job);
    if (isMobile) {
      setShowForm(true);
    } else {
      setShowFormPanel(true);
    }
  };

  const handleToggle = async (job: (typeof jobs)[number]) => {
    await updateJob(job.id, { enabled: !job.enabled });
    await refreshStatus();
  };

  const handleRun = async (job: (typeof jobs)[number]) => {
    try {
      setRunningJobId(job.id);
      await runJob(job.id);
      await refreshStatus();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setRunningJobId(null);
    }
  };

  const handleDelete = async (job: (typeof jobs)[number]) => {
    await deleteJob(job.id);
    if (selectedJobId === job.id) setSelectedJobId(null);
    await refreshStatus();
  };

  const closeFormPanel = () => {
    setShowFormPanel(false);
    setEditingJob(null);
  };

  const headerActions = showFormPanel ? (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={closeFormPanel}
        disabled={formSubmitting}
      >
        取消
      </Button>
      <Button
        type="submit"
        form="cron-job-form"
        size="sm"
        disabled={formSubmitting}
      >
        {formSubmitting
          ? editingJob
            ? "保存中..."
            : "创建中..."
          : editingJob
            ? "保存"
            : "创建任务"}
      </Button>
    </>
  ) : (
    <>
      <Button size="sm" variant="outline" onClick={refreshAll}>
        <RefreshCw className="size-3.5" />
        刷新
      </Button>
      <Button size="sm" onClick={openCreate}>
        <Plus className="size-3.5" />
        新建
      </Button>
    </>
  );

  return (
    // 桌面端标题已在全局 header 里，这里不再留一整段顶部呼吸，内容直接跟上
    <div className="flex h-full min-h-0 w-full flex-col px-4 pb-4 pt-3 sm:px-6 sm:pb-6 sm:pt-4">
      {headerActionsTarget === undefined ? (
        <SettingsPanelHeader
          title="定时任务"
          description="创建和管理自动运行的 Agent 任务。"
          actions={headerActions}
        />
      ) : headerActionsTarget ? createPortal(headerActions, headerActionsTarget) : null}

      {/* 主体：桌面端全宽左右两栏，移动端沿用列表 + Dialog。 */}
      <SettingsTwoColumn
        className="min-h-0 flex-1"
        sidebarWidth={280}
        sidebarClassName="space-y-0"
        contentClassName="space-y-0"
        sidebar={(
          <div className="flex flex-col">
            <JobList
              jobs={jobs}
              selectedId={selectedJobId}
              modelList={modelList}
              currentUserId={currentUserId}
              onSelect={(id) => {
                setSelectedJobId(id);
                if (isMobile) setShowDetail(true);
              }}
              onToggle={handleToggle}
            />
          </div>
        )}
      >
        {/* 右侧面板：移动端隐藏（走独立 Dialog）。桌面端直接铺在浮动白框里——
            同为 bg-card，再套一层描边只会多出一条看不清用途的线，层次交给内部分隔线与表格框。 */}
        <div className="hidden h-full flex-col overflow-hidden md:flex">
        {showFormPanel ? (
          <>
            <div className="flex items-center gap-3 border-b border-border/60 px-6 py-3">
              <div className="shrink-0 text-base font-semibold">
                {editingJob ? "编辑定时任务" : "创建定时任务"}
              </div>
              <div className="min-w-0 truncate text-xs text-muted-foreground">
                {editingJob
                  ? "保存后将更新该任务的配置。"
                  : "创建后可在列表中启用、运行或删除。"}
              </div>
            </div>
            <div className="flex-1 overflow-auto p-6">
              <JobForm
                mode={editingJob ? "edit" : "create"}
                initialJob={editingJob ?? undefined}
                dingtalkSessions={dingtalkSessions}
                modelList={modelList}
                onSubmittingChange={setFormSubmitting}
                onSubmit={async (job) => {
                  if (editingJob) {
                    await updateJob(editingJob.id, job);
                  } else {
                    await addJob(job);
                  }
                  setShowFormPanel(false);
                  setEditingJob(null);
                  await refreshStatus();
                }}
              />
            </div>
          </>
        ) : selectedJob ? (
          <>
            {/* 单行头：任务名 + 操作。原来的「上次运行」副标题删了——
                它和下方运行历史第一行是同一条数据，多占一层高度 */}
            <div className="flex items-center justify-between gap-3 border-b border-border/60 px-6 py-3">
              <div className="min-w-0 truncate text-base font-semibold">
                {selectedJob.name}
              </div>
              {canManageJob(selectedJob) && (
                <div className="flex shrink-0 items-center gap-2">
                  {/* 「立即运行」只在详情里给：它会真跑一轮，不该出现在鼠标划过列表的路径上 */}
                  <Button
                    size="sm"
                    onClick={() => handleRun(selectedJob)}
                    disabled={
                      !selectedJob.enabled ||
                      !!selectedJob.state.runningAtMs ||
                      runningJobId === selectedJob.id
                    }
                    title={selectedJob.enabled ? "立即运行一次" : "任务已禁用，需先启用"}
                  >
                    <Play className="fill-current" />
                    {selectedJob.state.runningAtMs
                      ? "运行中"
                      : runningJobId === selectedJob.id
                        ? "提交中"
                        : "立即运行"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => openEdit(selectedJob)}
                    disabled={!!selectedJob.state.runningAtMs}
                  >
                    编辑
                  </Button>
                  {/* 删除是二次确认后才发生的动作，这里只做入口：常驻实心红会成为整页最重的元素 */}
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-destructive hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => {
                      if (confirm(`确认删除任务 "${selectedJob.name}"?`))
                        handleDelete(selectedJob);
                    }}
                    disabled={!!selectedJob.state.runningAtMs}
                  >
                    <Trash2 />
                    删除
                  </Button>
                </div>
              )}
            </div>
            <div className="flex-1 overflow-auto p-6">
              <RunHistory
                entries={runEntries}
                loading={runLoading}
                error={runError}
              />
            </div>
          </>
        ) : (
          <div className="flex h-full items-center justify-center p-6">
            <div
              className={cn(
                "flex w-full max-w-sm flex-col items-center px-6 py-12 text-center text-muted-foreground",
                CAPABILITY_EMPTY_SURFACE,
              )}
            >
              <EntityIcons.cron className="size-8" />
              <div className="mt-3 text-sm">选择左侧任务查看运行历史</div>
            </div>
          </div>
        )}
        </div>
      </SettingsTwoColumn>

      {/* 移动端任务详情 Dialog */}
      <Dialog
        open={showDetail && !!selectedJob}
        onOpenChange={(open) => {
          if (!open) setShowDetail(false);
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-hidden sm:max-w-xl">
          {selectedJob && (
            <>
              <DialogHeader>
                <DialogTitle>{selectedJob.name}</DialogTitle>
                <DialogDescription>
                  上次运行:{" "}
                  {selectedJob.state.lastRunAtMs
                    ? new Date(selectedJob.state.lastRunAtMs).toLocaleString(
                        "zh-CN",
                      )
                    : "-"}
                </DialogDescription>
              </DialogHeader>
              {canManageJob(selectedJob) && (
                <div className="flex flex-wrap items-center gap-2">
                  {/* 移动端此前只有编辑/删除：列表卡的操作靠 hover 浮现，触屏根本触发不了，
                      导致手机上既不能启停也不能手动跑。启停与运行在这里补齐。 */}
                  <label className="mr-1 inline-flex items-center gap-2 text-sm">
                    <Switch
                      checked={selectedJob.enabled}
                      disabled={!!selectedJob.state.runningAtMs}
                      onCheckedChange={() => handleToggle(selectedJob)}
                      aria-label={selectedJob.enabled ? "禁用任务" : "启用任务"}
                    />
                    {selectedJob.enabled ? "已启用" : "已禁用"}
                  </label>
                  <Button
                    size="sm"
                    onClick={() => handleRun(selectedJob)}
                    disabled={
                      !selectedJob.enabled ||
                      !!selectedJob.state.runningAtMs ||
                      runningJobId === selectedJob.id
                    }
                  >
                    <Play className="fill-current" />
                    {selectedJob.state.runningAtMs
                      ? "运行中"
                      : runningJobId === selectedJob.id
                        ? "提交中"
                        : "立即运行"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setShowDetail(false);
                      openEdit(selectedJob);
                    }}
                    disabled={!!selectedJob.state.runningAtMs}
                  >
                    编辑
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-destructive hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => {
                      if (confirm(`确认删除任务 "${selectedJob.name}"?`)) {
                        setShowDetail(false);
                        handleDelete(selectedJob);
                      }
                    }}
                    disabled={!!selectedJob.state.runningAtMs}
                  >
                    <Trash2 />
                    删除
                  </Button>
                </div>
              )}
              <div className="min-h-0 flex-1 overflow-auto">
                <RunHistory
                  entries={runEntries}
                  loading={runLoading}
                  error={runError}
                />
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* 新建/编辑任务 Dialog */}
      <Dialog
        open={showForm}
        onOpenChange={(open) => {
          setShowForm(open);
          if (!open) setEditingJob(null);
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto p-0 sm:max-w-xl">
          <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-border/60 bg-card px-6 py-4">
            <DialogHeader className="min-w-0 flex-1 space-y-1">
              <DialogTitle>
                {editingJob ? "编辑定时任务" : "创建定时任务"}
              </DialogTitle>
              <DialogDescription>
                {editingJob
                  ? "保存后将更新该任务的配置。"
                  : "创建后可在列表中启用、运行或删除。"}
              </DialogDescription>
            </DialogHeader>
            <div className="flex shrink-0 items-center gap-2 pr-8">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  setShowForm(false);
                  setEditingJob(null);
                }}
                disabled={formSubmitting}
              >
                取消
              </Button>
              <Button
                type="submit"
                form="cron-job-form"
                size="sm"
                disabled={formSubmitting}
              >
                {formSubmitting
                  ? editingJob
                    ? "保存中..."
                    : "创建中..."
                  : editingJob
                    ? "保存"
                    : "创建任务"}
              </Button>
            </div>
          </div>
          <div className="px-6 pb-6 pt-4">
            <JobForm
              mode={editingJob ? "edit" : "create"}
              initialJob={editingJob ?? undefined}
              dingtalkSessions={dingtalkSessions}
              modelList={modelList}
              onSubmittingChange={setFormSubmitting}
              onSubmit={async (job) => {
                if (editingJob) {
                  await updateJob(editingJob.id, job);
                } else {
                  await addJob(job);
                }
                setShowForm(false);
                setEditingJob(null);
                await refreshStatus();
              }}
            />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

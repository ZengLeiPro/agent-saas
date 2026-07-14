import { useCallback, useEffect, useMemo, useState } from "react";
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
import { Plus, RefreshCw, Trash2 } from "lucide-react";
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
}

export function CronManager({
  onJobCountChange,
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

  const { refresh: refreshStatus } = useCronStatus();
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

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col">
      {/* 标题：与其他设置页面保持一致的样式 */}
      <SettingsPanelHeader
        title="定时任务"
        description="创建和管理自动运行的 Agent 任务。"
        actions={(
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
        )}
      />

      {/* 主体：左右两栏（独立于标题之外），统一使用 SettingsTwoColumn 壳子 */}
      <SettingsTwoColumn
        className="min-h-0 flex-1"
        sidebarClassName="space-y-0"
        contentClassName="space-y-0"
        sidebar={(
          <div className="flex flex-col">
            <JobList
              jobs={jobs}
              selectedId={selectedJobId}
              modelList={modelList}
              currentUserId={currentUserId}
              runningJobId={runningJobId}
              onSelect={(id) => {
                setSelectedJobId(id);
                if (isMobile) setShowDetail(true);
              }}
              onToggle={handleToggle}
              onRun={handleRun}
              onEdit={openEdit}
              onDelete={handleDelete}
            />
          </div>
        )}
      >
        {/* 右侧面板：移动端隐藏（走独立 Dialog），桌面端正常显示，去掉 border-l 竖线走简约 */}
        <div className="hidden h-full flex-col overflow-hidden md:flex">
        {showFormPanel ? (
          <>
            <div className="flex items-start justify-between gap-3 border-b px-6 py-4">
              <div className="min-w-0">
                <div className="text-base font-semibold">
                  {editingJob ? "编辑定时任务" : "创建定时任务"}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {editingJob
                    ? "保存后将更新该任务的配置。"
                    : "创建后可在列表中启用、运行或删除。"}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setShowFormPanel(false);
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
            <div className="flex items-start justify-between gap-3 border-b px-6 py-4">
              <div className="min-w-0">
                <div className="truncate text-base font-semibold">
                  {selectedJob.name}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  上次:{" "}
                  {selectedJob.state.lastRunAtMs
                    ? new Date(selectedJob.state.lastRunAtMs).toLocaleString(
                        "zh-CN",
                      )
                    : "-"}
                </div>
              </div>
              {canManageJob(selectedJob) && (
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => openEdit(selectedJob)}
                    disabled={!!selectedJob.state.runningAtMs}
                  >
                    编辑
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
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
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            选择一个任务查看详情
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
                <div className="flex items-center gap-2">
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
                    variant="destructive"
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
          <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b bg-card px-6 py-4">
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

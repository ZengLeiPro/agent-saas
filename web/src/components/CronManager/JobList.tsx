import type { ModelList } from "@/types/models";
import type { CronJob } from "./types";

import {
  ArrowRight,
  Clock,
  Pencil,
  Play,
  Power,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface JobListProps {
  jobs: CronJob[];
  selectedId: string | null;
  modelList?: ModelList | null;
  currentUserId?: string;
  runningJobId?: string | null;
  onSelect: (id: string) => void;
  onToggle: (job: CronJob) => void;
  onRun: (job: CronJob) => void;
  onEdit: (job: CronJob) => void;
  onDelete: (job: CronJob) => void;
}

function resolveModelName(ref: string, modelList?: ModelList | null): string {
  if (!modelList) return ref;
  const slashIdx = ref.indexOf("/");
  if (slashIdx < 0) return ref;
  const groupId = ref.slice(0, slashIdx);
  const modelId = ref.slice(slashIdx + 1);
  const group = modelList.groups.find((g) => g.id === groupId);
  if (!group) return ref;
  const model = group.models.find((m) => m.id === modelId);
  return model ? model.name : ref;
}

function formatSchedule(job: CronJob) {
  const schedule = job.schedule;
  switch (schedule.kind) {
    case "at":
      return `一次性 · ${new Date(schedule.atMs).toLocaleString("zh-CN")}`;
    case "every": {
      const mins = Math.floor(schedule.everyMs / 60000);
      if (mins < 60) return `每 ${mins} 分钟`;
      const hours = Math.floor(mins / 60);
      if (hours < 24) return `每 ${hours} 小时`;
      return `每 ${Math.floor(hours / 24)} 天`;
    }
    case "cron":
      // 时区（如 Asia/Shanghai）通常对用户没意义，只显示 Cron 表达式
      return `Cron ${schedule.expr}`;
  }
}

/** 下次运行的相对时间：今天 HH:mm / 明天 HH:mm / M/D HH:mm */
function formatNextRun(ms?: number) {
  if (!ms) return "-";
  const d = new Date(ms);
  const now = new Date();
  const hm = d.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return `今天 ${hm}`;
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const isTomorrow =
    d.getFullYear() === tomorrow.getFullYear() &&
    d.getMonth() === tomorrow.getMonth() &&
    d.getDate() === tomorrow.getDate();
  if (isTomorrow) return `明天 ${hm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/** 状态色点 + 文本：成功 / 运行中(呼吸) / 失败 / 跳过 / 禁用 / 待运行 */
function StatusPill({ job }: { job: CronJob }) {
  if (job.state.runningAtMs) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary">
        <span className="relative flex size-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-70" />
          <span className="relative inline-flex size-1.5 rounded-full bg-primary" />
        </span>
        运行中
      </span>
    );
  }
  if (!job.enabled) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
        <span className="size-1.5 rounded-full bg-muted-foreground/60" />
        已禁用
      </span>
    );
  }
  switch (job.state.lastStatus) {
    case "ok":
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
          <span className="size-1.5 rounded-full bg-emerald-500" />
          成功
        </span>
      );
    case "error":
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-semibold text-red-700 dark:bg-red-900/30 dark:text-red-300">
          <span className="size-1.5 rounded-full bg-red-500" />
          失败
        </span>
      );
    case "skipped":
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
          <span className="size-1.5 rounded-full bg-muted-foreground/60" />
          跳过
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
          <span className="size-1.5 rounded-full bg-muted-foreground/40" />
          待运行
        </span>
      );
  }
}

interface ActionButtonProps {
  label: string;
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

/** 悬停浮现的方形操作按钮：32×32 圆角 9 */
function ActionButton({
  label,
  primary,
  danger,
  disabled,
  onClick,
  children,
}: ActionButtonProps) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        "grid size-8 place-items-center rounded-[9px] border text-xs transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-50",
        primary
          ? "border-primary bg-primary text-primary-foreground shadow-sm hover:bg-primary/90 disabled:hover:bg-primary"
          : danger
            ? "border-border bg-card text-muted-foreground hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive"
            : "border-border bg-card text-muted-foreground hover:border-brand-200 hover:bg-brand-50 hover:text-primary",
      )}
    >
      {children}
    </button>
  );
}

export function JobList({
  jobs,
  selectedId,
  modelList,
  currentUserId,
  runningJobId,
  onSelect,
  onToggle,
  onRun,
  onEdit,
  onDelete,
}: JobListProps) {
  const canManageJob = (job: CronJob) => {
    if (!currentUserId) return true; // auth 未启用
    return job.owner === currentUserId;
  };

  if (jobs.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed bg-card/60 p-8 text-center text-sm text-muted-foreground">
        暂无任务
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      {jobs.map((job) => {
        const isRunning = !!job.state.runningAtMs;
        const submitting = runningJobId === job.id;
        const manageable = canManageJob(job);
        const selected = selectedId === job.id;
        const modelLabel =
          job.payload.kind === "agentTurn" && job.payload.model
            ? resolveModelName(job.payload.model, modelList)
            : null;

        return (
          <div
            key={job.id}
            role="button"
            tabIndex={0}
            onClick={() => onSelect(job.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(job.id);
              }
            }}
            className={cn(
              "group relative cursor-pointer rounded-2xl border bg-card py-3.5 pl-4 pr-3 transition-all",
              "hover:-translate-y-0.5 hover:border-brand-200 hover:shadow-lg hover:shadow-brand-500/10",
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
              selected
                ? "border-primary/40 bg-accent/40"
                : "border-border/70",
              !job.enabled && !isRunning && "opacity-70",
            )}
          >
            {/* 主行：任务名 + 状态 */}
            <div className="flex min-w-0 items-center gap-2.5 pr-2">
              <span className="truncate text-[14.5px] font-semibold text-foreground">
                {job.name}
              </span>
              <StatusPill job={job} />
            </div>

            {/* 副行：调度 · 下次 · 模型 · (admin: 创建者) */}
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <Clock className="size-3 opacity-80" />
                {formatSchedule(job)}
              </span>
              {job.state.nextRunAtMs ? (
                <>
                  <span className="size-0.5 rounded-full bg-muted-foreground/50" />
                  <span className="inline-flex items-center gap-1.5">
                    <ArrowRight className="size-3 opacity-80" />
                    {formatNextRun(job.state.nextRunAtMs)}
                  </span>
                </>
              ) : null}
              {modelLabel ? (
                <>
                  <span className="size-0.5 rounded-full bg-muted-foreground/50" />
                  <span>{modelLabel}</span>
                </>
              ) : null}
            </div>

            {/* 描述（强制单行截断，省略号） */}
            {job.description ? (
              <div className="mt-1.5 truncate text-xs text-foreground/75">
                {job.description}
              </div>
            ) : null}

            {/* 悬停浮现的操作 */}
            {manageable && (
              <div
                onClick={(e) => e.stopPropagation()}
                className={cn(
                  // 右下角对齐；保留 14px 内边距，避免贴边并减少遮挡正文
                  "pointer-events-none absolute bottom-3.5 right-3.5 flex translate-x-1.5 translate-y-1.5 items-center gap-1.5",
                  "opacity-0 transition-all duration-200",
                  "group-hover:pointer-events-auto group-hover:translate-x-0 group-hover:translate-y-0 group-hover:opacity-100",
                  "before:pointer-events-none before:absolute before:bottom-0 before:right-full before:h-12 before:w-10 before:bg-gradient-to-l before:from-card before:to-transparent before:content-['']",
                )}
              >
                <ActionButton
                  label={submitting ? "提交中" : job.enabled ? "立即运行" : "需先启用"}
                  primary
                  disabled={isRunning || submitting || !job.enabled}
                  onClick={() => onRun(job)}
                >
                  <Play className="size-3.5 fill-current" />
                </ActionButton>
                <ActionButton
                  label="编辑"
                  disabled={isRunning}
                  onClick={() => onEdit(job)}
                >
                  <Pencil className="size-3.5" />
                </ActionButton>
                <ActionButton
                  label={job.enabled ? "禁用" : "启用"}
                  disabled={isRunning}
                  onClick={() => onToggle(job)}
                >
                  <Power className="size-3.5" />
                </ActionButton>
                <ActionButton
                  label="删除"
                  danger
                  disabled={isRunning}
                  onClick={() => {
                    if (confirm(`确认删除任务 "${job.name}"?`)) onDelete(job);
                  }}
                >
                  <Trash2 className="size-3.5" />
                </ActionButton>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

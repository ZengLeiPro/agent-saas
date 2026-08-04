import type { ModelList } from "@/types/models";
import type { CronJob } from "./types";

import { ArrowRight, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import { Switch } from "@/components/ui/switch";
import {
  CAPABILITY_EMPTY_SURFACE,
  CAPABILITY_SURFACE,
  CAPABILITY_SURFACE_HOVER,
} from "@/components/CapabilityCenter/CatalogUi";

interface JobListProps {
  jobs: CronJob[];
  selectedId: string | null;
  modelList?: ModelList | null;
  currentUserId?: string;
  onSelect: (id: string) => void;
  onToggle: (job: CronJob) => void;
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

/**
 * 任务列表卡片。
 *
 * 卡片上只有两个可点区域：整卡（选中，右栏出详情）+ 右侧启停开关。
 * 运行 / 编辑 / 删除都在右栏详情里做——它们低频且有副作用（「立即运行」会真跑一轮），
 * 放在鼠标划过路径上的悬浮按钮里太容易误触，触屏上还根本摸不到。
 */
export function JobList({
  jobs,
  selectedId,
  modelList,
  currentUserId,
  onSelect,
  onToggle,
}: JobListProps) {
  const canManageJob = (job: CronJob) => {
    if (!currentUserId) return true; // auth 未启用
    return job.owner === currentUserId;
  };

  if (jobs.length === 0) {
    return (
      <div className={cn("p-8 text-center text-sm text-muted-foreground", CAPABILITY_EMPTY_SURFACE)}>
        暂无任务
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      {jobs.map((job) => {
        const isRunning = !!job.state.runningAtMs;
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
              "relative cursor-pointer py-3.5 pl-4 pr-3.5",
              CAPABILITY_SURFACE,
              CAPABILITY_SURFACE_HOVER,
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
              // 选中态靠描边加重 + 极浅品牌底表达，不改背景层级，避免与 hover 浮起打架
              selected && "bg-primary/[0.04] ring-primary/40",
            )}
          >
            {/* 停用的任务整块信息压暗，但开关本身保持正常对比度——它还能点 */}
            <div className={cn("min-w-0", !job.enabled && !isRunning && "opacity-60")}>
              {/* 主行仅为右上角开关预留空间，后续内容保持全宽 */}
              <div className={cn("truncate text-[14.5px] font-semibold text-foreground", manageable && "pr-12")}>
                {job.name}
              </div>

              {/* 副行：调度 · 下次 · 模型 */}
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
            </div>

            {/* 启停开关：卡片上唯一的常驻操作。包一层拦住冒泡，
                否则点开关会连带触发整卡的选中、空格键也会两个都触发 */}
            {manageable && (
              <div
                className="absolute right-3.5 top-3.5"
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
              >
                <Switch
                  checked={job.enabled}
                  disabled={isRunning}
                  onCheckedChange={() => onToggle(job)}
                  aria-label={job.enabled ? `禁用任务 ${job.name}` : `启用任务 ${job.name}`}
                  title={isRunning ? "任务运行中，暂不可切换" : job.enabled ? "点击禁用" : "点击启用"}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

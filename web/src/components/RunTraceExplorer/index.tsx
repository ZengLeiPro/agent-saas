/**
 * Run 追踪（platform-admin-only）
 *
 * 数据后端：/api/admin/runtime/trace/*（见 server/src/routes/runtimeTrace.ts）
 *
 * 视图结构：
 *   [列表]  时间窗 / 状态分组筛选 + runId/sessionId 直达 → run 表格
 *   [详情]  汇总头卡 + 事件时间线（工具调用按 toolCallId 关联成行）+ 工具/成本统计
 *   [子 agent 下钻]  时间线里的 subagent_started/finished → 打开子 run 自己的时间线，
 *           下钻路径以面包屑呈现，逐层可返回
 *
 * 权限：仅在 PlatformAdminShell 挂载；后端 router 对非平台 admin 一律 403。
 */
import { useCallback, useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";
import { SettingsPanelHeader } from "@/components/SettingsCenter/SettingsPanelHeader";
import { RUN_TRACE_LABEL } from "@/components/PlatformAdmin/displayText";

import { shortId } from "./format";
import { RunDetailView } from "./RunDetailView";
import { RunListView } from "./RunListView";
import { formatAgentType, type SubagentDrillTarget } from "./TimelineItems";

/** 子 agent 下钻路径上的一层（父 run → 子 agent → 子 agent 的子 agent …） */
interface SubagentCrumb {
  runId: string;
  agentType?: string;
  description?: string;
}

export function RunTraceExplorer({
  runId,
  onRunIdChange,
}: {
  runId?: string | null;
  onRunIdChange?: (runId: string | null) => void;
}) {
  const [localRunId, setLocalRunId] = useState<string | null>(null);
  const selectedRunId = runId !== undefined ? runId : localRunId;
  const setSelectedRunId = useCallback((next: string | null) => {
    if (onRunIdChange) onRunIdChange(next);
    else setLocalRunId(next);
  }, [onRunIdChange]);

  /**
   * 子 agent 下钻栈。不进 URL：子 run 只知道自己的 runId，后端 run 摘要不返回 parentRunId，
   * 单靠 URL 无法还原「从哪个父 run 钻进来的」。因此 URL 始终指向父 run（刷新/分享落回父 run，
   * 内容正确、不是坏链），下钻层级作为会话内的 UI 状态。
   */
  const [subagentTrail, setSubagentTrail] = useState<SubagentCrumb[]>([]);

  // 换 run / 回列表时必须清空下钻栈，否则会把上一条 run 的子 agent 挂到新 run 上
  useEffect(() => {
    setSubagentTrail([]);
  }, [selectedRunId]);

  const detailOpen = selectedRunId != null;
  const activeCrumb = subagentTrail.length > 0 ? subagentTrail[subagentTrail.length - 1] : null;
  const activeRunId = activeCrumb?.runId ?? selectedRunId;

  const onDrillSubagent = useCallback((target: SubagentDrillTarget) => {
    setSubagentTrail((prev) => (
      prev.some((crumb) => crumb.runId === target.runId)
        ? prev
        : [...prev, { runId: target.runId, agentType: target.agentType, description: target.description }]
    ));
  }, []);

  const onBack = useCallback(() => {
    if (subagentTrail.length > 0) setSubagentTrail((prev) => prev.slice(0, -1));
    else setSelectedRunId(null);
  }, [setSelectedRunId, subagentTrail.length]);

  const breadcrumb = subagentTrail.length > 0 && selectedRunId != null ? (
    <nav aria-label="子 agent 下钻路径" className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
      <button
        type="button"
        className="font-mono hover:text-foreground hover:underline"
        onClick={() => setSubagentTrail([])}
      >
        父执行记录 {shortId(selectedRunId, 10)}
      </button>
      {subagentTrail.map((crumb, index) => {
        const label = `子 agent · ${formatAgentType(crumb.agentType)}${crumb.description ? `：${crumb.description}` : ""}`;
        const isCurrent = index === subagentTrail.length - 1;
        return (
          <span key={crumb.runId} className="flex min-w-0 items-center gap-1">
            <ChevronRight className="size-3 shrink-0" aria-hidden />
            {isCurrent ? (
              <span className="truncate font-medium text-foreground" aria-current="page" title={label}>{label}</span>
            ) : (
              <button
                type="button"
                className="truncate hover:text-foreground hover:underline"
                title={label}
                onClick={() => setSubagentTrail((prev) => prev.slice(0, index + 1))}
              >
                {label}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  ) : undefined;

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <SettingsPanelHeader
        title={RUN_TRACE_LABEL}
        description="排查失败时，先按组织、用户或对话筛选，再打开某次执行查看失败原因和工具调用。"
      />
      {/* 列表**压窄常驻**而不是隐藏：详情打开后仍能看到自己在哪一条、还能直接点下一条。
          列表组件始终挂载（改造前「hidden 保留筛选与滚动状态」的优点必须保住，
          不能退化成销毁重建），只是换成窄栏 + compact 列集合。 */}
      <div className="flex min-h-0 flex-1 gap-3 overflow-hidden">
        <div className={cn("min-h-0 overflow-auto", detailOpen ? "w-80 shrink-0 border-r pr-3" : "min-w-0 flex-1")}>
          <RunListView
            onSelectRun={setSelectedRunId}
            selectedRunId={selectedRunId}
            compact={detailOpen}
            onExpand={() => setSelectedRunId(null)}
          />
        </div>
        {activeRunId != null && (
          <div className="min-h-0 min-w-0 flex-1 overflow-auto">
            <RunDetailView
              runId={activeRunId}
              onBack={onBack}
              backLabel={subagentTrail.length > 0 ? "返回上一层" : "返回列表"}
              breadcrumb={breadcrumb}
              onDrillSubagent={onDrillSubagent}
            />
          </div>
        )}
      </div>
    </div>
  );
}

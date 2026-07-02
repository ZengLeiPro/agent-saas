/**
 * Run 追踪（platform-admin-only）
 *
 * 数据后端：/api/admin/runtime/trace/*（见 server/src/routes/runtimeTrace.ts）
 *
 * 视图结构：
 *   [列表]  时间窗 / 状态分组筛选 + runId/sessionId 直达 → run 表格
 *   [详情]  汇总头卡 + 事件时间线（工具调用按 toolCallId 关联成行）+ 工具/成本统计
 *
 * 权限：仅在 PlatformAdminShell 挂载；后端 router 对非平台 admin 一律 403。
 */
import { useState } from "react";

import { cn } from "@/lib/utils";
import { SettingsPanelHeader } from "@/components/SettingsCenter/SettingsPanelHeader";

import { RunDetailView } from "./RunDetailView";
import { RunListView } from "./RunListView";

export function RunTraceExplorer() {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-6xl flex-col">
      <SettingsPanelHeader
        title="Run 追踪"
        description="逐 run 复盘 Agent 执行过程：事件时间线、工具调用、审批与成本明细。"
      />
      <div className="min-h-0 flex-1 overflow-auto">
        {/* 列表保持挂载（隐藏）以保留筛选与滚动状态；详情按需挂载 */}
        <div className={cn(selectedRunId != null && "hidden")} aria-hidden={selectedRunId != null}>
          <RunListView onSelectRun={setSelectedRunId} />
        </div>
        {selectedRunId != null && (
          <RunDetailView runId={selectedRunId} onBack={() => setSelectedRunId(null)} />
        )}
      </div>
    </div>
  );
}

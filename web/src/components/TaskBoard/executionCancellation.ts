import type { TaskBoardExecution, TaskBoardExecutionStartResult, TaskBoardTask } from "@agent/shared";
import * as api from "./api";

export async function requestExecutionCancellation(
  task: TaskBoardTask,
  execution: TaskBoardExecution,
): Promise<TaskBoardExecutionStartResult | null> {
  const purpose = execution.purpose === "review" ? "复核" : execution.purpose === "merge" ? "合并" : "实施";
  if (!window.confirm(`确认终止 ${purpose}执行吗？当前运行会被取消，任务将回到可继续处理的状态。`)) {
    return null;
  }
  return api.cancelExecution(task.id, execution.id, {
    expectedVersion: task.version,
    reason: "看板维护者从任务详情终止执行",
  });
}

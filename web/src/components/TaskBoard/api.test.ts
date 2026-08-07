import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskBoardTask } from "@agent/shared";
import { authFetch } from "@/lib/authFetch";
import { executeTask, patchTask, TaskBoardConflictError } from "./api";

vi.mock("@/lib/authFetch", () => ({ authFetch: vi.fn() }));

const task: TaskBoardTask = {
  id: "task-1",
  boardId: "board-1",
  identifier: "TASK-1",
  title: "服务端最新任务",
  description: "",
  status: "todo",
  priority: "none",
  labels: [],
  sortOrder: 1_024,
  commentCount: 0,
  version: 5,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

describe("任务看板 API 错误对象", () => {
  beforeEach(() => vi.clearAllMocks());

  it("执行接口保留 task 与 execution 组合结果", async () => {
    const result = {
      task: { ...task, status: "in_progress", version: 6 },
      execution: {
        id: "execution-1",
        taskId: task.id,
        runId: "run-1",
        sessionId: "session-1",
        status: "queued",
        requestedBy: "user-1",
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      },
    };
    vi.mocked(authFetch).mockResolvedValueOnce(new Response(JSON.stringify(result), {
      status: 202,
      headers: { "content-type": "application/json" },
    }));

    await expect(executeTask(task.id, task.version)).resolves.toEqual(result);
    expect(authFetch).toHaveBeenCalledWith(
      `/api/taskboard/tasks/${task.id}/execute`,
      expect.objectContaining({ method: "POST", body: JSON.stringify({ expectedVersion: task.version }) }),
    );
  });

  it("409 保留服务端 current，供 hooks 立即同步最新版本", async () => {
    vi.mocked(authFetch).mockResolvedValueOnce(new Response(JSON.stringify({
      error: "Version conflict",
      code: "TASKBOARD_VERSION_CONFLICT",
      current: task,
    }), {
      status: 409,
      headers: { "content-type": "application/json" },
    }));

    let caught: unknown;
    try {
      await patchTask(task.id, { title: "我的修改", expectedVersion: 4 });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TaskBoardConflictError);
    expect(caught).toMatchObject({
      message: "数据已被其他操作更新，请基于最新版本重试",
      current: task,
    });
  });
});

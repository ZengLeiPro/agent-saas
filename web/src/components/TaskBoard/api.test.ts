import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskBoardTask } from "@agent/shared";
import { authFetch } from "@/lib/authFetch";
import {
  cancelIntegrationTask,
  createIntegrationBatch,
  deleteBoardMember,
  deleteTask,
  executeTask,
  fetchBoardMembers,
  fetchIntegrationSources,
  patchTask,
  resumeTask,
  TaskBoardConflictError,
  upsertBoardMember,
} from "./api";

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
        purpose: "work",
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
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ expectedVersion: task.version }),
      }),
    );
  });

  it("集成任务重跑与取消保留 merge purpose 和 CAS 版本", async () => {
    const mergeExecution = {
      task: { ...task, kind: "integration" as const, status: "in_progress" as const },
      execution: {
        id: "execution-merge",
        taskId: task.id,
        runId: "run-merge",
        sessionId: "session-merge",
        status: "queued" as const,
        purpose: "merge" as const,
        requestedBy: "user-1",
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      },
    };
    const canceled = { ...mergeExecution.task, status: "canceled" as const, version: 6 };
    vi.mocked(authFetch)
      .mockResolvedValueOnce(new Response(JSON.stringify(mergeExecution), { status: 202, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(canceled), { status: 200, headers: { "content-type": "application/json" } }));

    await expect(executeTask(task.id, task.version, "merge")).resolves.toEqual(mergeExecution);
    await expect(cancelIntegrationTask(task.id, task.version, "人工终止")).resolves.toEqual(canceled);
    expect(authFetch).toHaveBeenNthCalledWith(1, `/api/taskboard/tasks/${task.id}/execute`, expect.objectContaining({
      body: JSON.stringify({ expectedVersion: task.version, purpose: "merge" }),
    }));
    expect(authFetch).toHaveBeenNthCalledWith(2, `/api/taskboard/tasks/${task.id}/integration-cancel`, expect.objectContaining({
      body: JSON.stringify({ expectedVersion: task.version, reason: "人工终止" }),
    }));
  });

  it("阻塞恢复提交结构化决策与明确 sourceIds", async () => {
    const resumed = { ...task, kind: "integration" as const, status: "todo" as const, version: 6 };
    vi.mocked(authFetch).mockResolvedValueOnce(new Response(JSON.stringify(resumed), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    await expect(resumeTask(task.id, task.version, "批准恢复来源", ["source-1"]))
      .resolves.toEqual(resumed);
    expect(authFetch).toHaveBeenCalledWith(
      `/api/taskboard/tasks/${task.id}/resume`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ expectedVersion: task.version, decision: "批准恢复来源", sourceIds: ["source-1"] }),
      }),
    );
  });

  it("成员、人工集成与来源接口使用 V2 REST 契约", async () => {
    const member = {
      boardId: "board-1",
      userId: "user-2",
      role: "maintainer" as const,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    };
    const integrationResult = {
      task: { ...task, id: "integration-1", kind: "integration" as const },
      execution: {
        id: "execution-2",
        taskId: "integration-1",
        runId: "run-2",
        sessionId: "session-2",
        status: "queued" as const,
        purpose: "merge" as const,
        requestedBy: "user-1",
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      },
    };
    const sources = [{
      id: "source-1",
      integrationTaskId: "integration-1",
      deliveryTaskId: task.id,
      repositoryId: "repo-1",
      providerPullRequestId: "pr-1",
      reviewedSubjectDigest: "sha256:reviewed",
      order: 0,
      state: "ready" as const,
      attemptCount: 1,
      updatedAt: task.updatedAt,
    }];
    for (const [status, body] of [[200, [member]], [200, member], [204, null], [202, integrationResult], [200, sources]] as const) {
      vi.mocked(authFetch).mockResolvedValueOnce(new Response(body === null ? null : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }));
    }

    await expect(fetchBoardMembers("board-1")).resolves.toEqual([member]);
    await expect(upsertBoardMember("board-1", { userId: "user-2", role: "maintainer" })).resolves.toEqual(member);
    await expect(deleteBoardMember("board-1", "user-2")).resolves.toBeUndefined();
    await expect(createIntegrationBatch("board-1", {
      deliveryTaskIds: [task.id],
      expectedBoardVersion: 7,
    })).resolves.toEqual(integrationResult);
    await expect(fetchIntegrationSources("integration-1")).resolves.toEqual(sources);

    expect(authFetch).toHaveBeenNthCalledWith(2, "/api/taskboard/boards/board-1/members", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ userId: "user-2", role: "maintainer" }),
    }));
    expect(authFetch).toHaveBeenNthCalledWith(4, "/api/taskboard/boards/board-1/integrations", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ deliveryTaskIds: [task.id], expectedBoardVersion: 7 }),
    }));
  });

  it("删除任务使用 DELETE 并携带 CAS 版本", async () => {
    const deleted = { ...task, version: 6, deletedAt: "2026-08-01T00:00:00.000Z" };
    vi.mocked(authFetch).mockResolvedValueOnce(new Response(JSON.stringify(deleted), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    await expect(deleteTask(task.id, task.version)).resolves.toEqual(deleted);
    expect(authFetch).toHaveBeenCalledWith(
      `/api/taskboard/tasks/${task.id}`,
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify({ expectedVersion: task.version }),
      }),
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

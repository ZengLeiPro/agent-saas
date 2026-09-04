import { describe, expect, it, vi } from "vitest";
import type { AppRuntime } from "./runtime.js";
import { createTaskboardSessionReadAuthorizer } from "./taskboardSessionReadAccess.js";

const user = { userId: "collaborator", username: "bob", role: "user", tenantId: "tenant-1" } as const;

function createStore(options: { tenantId?: string; taskVisible?: boolean } = {}) {
  const getExecutionContextBySessionId = vi.fn(async () => ({
    identity: { tenantId: options.tenantId ?? user.tenantId },
    task: { id: "task-1" },
  } as never));
  const getTask = options.taskVisible === false
    ? vi.fn(async () => { throw new Error("Task not found"); })
    : vi.fn(async () => ({ id: "task-1" } as never));
  return { getExecutionContextBySessionId, getTask } as AppRuntime["taskboardExecutionStore"];
}

describe("TaskBoard session 只读授权映射", () => {
  it("关联任务对当前用户可见时允许读取", async () => {
    const store = createStore();
    await expect(createTaskboardSessionReadAuthorizer(store)(user, "session-1")).resolves.toBe(true);
    expect(store?.getTask).toHaveBeenCalledWith({
      tenantId: user.tenantId,
      ownerUserId: user.userId,
      username: user.username,
      userRole: user.role,
    }, "task-1");
  });

  it("跨租户或任务不可见时拒绝读取", async () => {
    await expect(createTaskboardSessionReadAuthorizer(createStore({ tenantId: "tenant-2" }))(user, "session-1")).resolves.toBe(false);
    await expect(createTaskboardSessionReadAuthorizer(createStore({ taskVisible: false }))(user, "session-1")).resolves.toBe(false);
  });
});

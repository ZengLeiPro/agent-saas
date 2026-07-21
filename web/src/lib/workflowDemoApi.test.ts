import { beforeEach, describe, expect, it, vi } from "vitest";

const authFetchMock = vi.hoisted(() => vi.fn());
vi.mock("./authFetch", () => ({ authFetch: authFetchMock }));

import { startWorkflowDemo } from "./workflowDemoApi";

describe("startWorkflowDemo", () => {
  beforeEach(() => authFetchMock.mockReset());

  it("用目录 ID 与稳定幂等键取得不可编辑的调度绑定", async () => {
    authFetchMock.mockResolvedValue(new Response(JSON.stringify({
      dispatchMetadata: {
        workflowDemo: {
          runId: "11111111-1111-4111-8111-111111111111",
          eventId: "event-01",
        },
      },
      awaitingExternal: false,
    }), { status: 201, headers: { "Content-Type": "application/json" } }));

    await expect(startWorkflowDemo("catalog-01", "stable-key-01")).resolves.toEqual({
      runId: "11111111-1111-4111-8111-111111111111",
      eventId: "event-01",
    });
    expect(authFetchMock).toHaveBeenCalledWith(
      "/api/workflow-demos/catalog/catalog-01/runs",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "Idempotency-Key": "stable-key-01" }),
      }),
    );
  });

  it("拒绝等待外部身份或缺少下一事件的不可执行启动结果", async () => {
    authFetchMock.mockResolvedValue(new Response(JSON.stringify({
      dispatchMetadata: null,
      awaitingExternal: true,
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await expect(startWorkflowDemo("catalog-01", "stable-key-01"))
      .rejects.toThrow("没有返回可执行的第一步");
  });
});

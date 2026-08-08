import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { authFetch } from "@/lib/authFetch";
import { RuntimeOperationsManager } from "./index";

vi.mock("@/lib/authFetch", () => ({
  authFetch: vi.fn(),
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function runtimeOperationsResponse(maxConcurrentRuns: number) {
  return {
    generatedAt: "2026-07-27T14:30:00.000Z",
    processRole: "all",
    runtimeScheduler: {
      status: "ok",
      sessionLockMode: "lease",
      maxConcurrentRuns,
      effectiveMaxConcurrentRuns: maxConcurrentRuns,
      maxConfigurableConcurrentRuns: 64,
      editable: true,
      inFlightRuns: 3,
      inFlightBackgroundRuns: 1,
      updatedAt: "2026-07-27T14:30:00.000Z",
      updatedBy: maxConcurrentRuns === 16 ? "bootstrap" : "admin",
    },
    tenantRemoteHands: {
      hands: [],
      health: [],
    },
    runtimeEventStore: {
      backend: "file",
      status: "disabled",
    },
  };
}

describe("RuntimeOperationsManager", () => {
  beforeEach(() => {
    let maxConcurrentRuns = 16;
    vi.mocked(authFetch).mockReset();
    vi.mocked(authFetch).mockImplementation(async (path, init) => {
      if (path === "/api/admin/runtime-operations/scheduler/runtime-config" && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as { maxConcurrentRuns: number };
        maxConcurrentRuns = body.maxConcurrentRuns;
        return jsonResponse({
          status: "ok",
          runtimeScheduler: runtimeOperationsResponse(maxConcurrentRuns).runtimeScheduler,
        });
      }
      return jsonResponse(runtimeOperationsResponse(maxConcurrentRuns));
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  it("平台管理员可修改顶层任务并发并热生效", async () => {
    const user = userEvent.setup();
    render(<RuntimeOperationsManager />);

    expect(await screen.findByText("顶层任务调度并发")).toBeTruthy();
    const input = screen.getByLabelText("期望并发") as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("16"));

    await user.clear(input);
    await user.type(input, "24");
    await user.click(screen.getByRole("button", { name: "保存并热生效" }));

    expect(await screen.findByText("顶层任务并发已调整为 24")).toBeTruthy();
    const patchCall = vi.mocked(authFetch).mock.calls.find((call) =>
      call[0] === "/api/admin/runtime-operations/scheduler/runtime-config" && call[1]?.method === "PATCH");
    expect(JSON.parse(String(patchCall?.[1]?.body))).toEqual({ maxConcurrentRuns: 24 });
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("不会中断正在运行的任务"));
  });
});

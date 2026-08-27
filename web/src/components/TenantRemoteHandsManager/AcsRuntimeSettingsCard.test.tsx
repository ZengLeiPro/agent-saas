import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AcsRuntimeSettingsCard } from "./AcsRuntimeSettingsCard";

const mocks = vi.hoisted(() => ({ authFetch: vi.fn() }));

vi.mock("@/lib/authFetch", () => ({ authFetch: mocks.authFetch }));

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const runtimeConfig = {
  maxRunningSandboxes: 20,
  warnRunningSandboxes: 15,
  drainDeadlineMs: 300_000,
  persisted: true,
};

describe("AcsRuntimeSettingsCard", () => {
  beforeEach(() => {
    mocks.authFetch.mockReset().mockImplementation(async (_input: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return jsonResponse({ status: "ok", runtimeConfig: JSON.parse(String(init.body)) });
      }
      return jsonResponse({ status: "ok", runtimeConfig });
    });
  });

  it("独立读取并保存 ACS 保护参数", async () => {
    render(<AcsRuntimeSettingsCard readOnly={false} />);

    const maxInput = await screen.findByLabelText("最大运行环境数");
    fireEvent.change(maxInput, { target: { value: "30" } });
    fireEvent.change(screen.getByLabelText("运行环境告警阈值"), { target: { value: "24" } });
    fireEvent.change(screen.getByLabelText("排空超时（毫秒）"), { target: { value: "600000" } });
    fireEvent.click(screen.getByRole("button", { name: "保存 ACS 配置" }));

    await waitFor(() => expect(mocks.authFetch).toHaveBeenCalledTimes(2));
    const [, init] = mocks.authFetch.mock.calls[1] as [string, RequestInit];
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({
      maxRunningSandboxes: 30,
      warnRunningSandboxes: 24,
      drainDeadlineMs: 600_000,
    });
    expect(await screen.findByText("已保存")).toBeTruthy();
  });

  it("告警阈值超过有效上限时不提交", async () => {
    render(<AcsRuntimeSettingsCard readOnly={false} />);

    await screen.findByLabelText("最大运行环境数");
    fireEvent.change(screen.getByLabelText("最大运行环境数"), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("运行环境告警阈值"), { target: { value: "11" } });
    fireEvent.click(screen.getByRole("button", { name: "保存 ACS 配置" }));

    expect(await screen.findByText("运行环境告警阈值不能大于最大运行环境数")).toBeTruthy();
    expect(mocks.authFetch).toHaveBeenCalledTimes(1);
  });
});

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SystemSettingsPanel } from "./SystemSettingsPanel";

const mocks = vi.hoisted(() => ({
  alertingStatus: vi.fn(),
  sendTestAlert: vi.fn(),
  schedulerRuntimeConfig: vi.fn(),
  updateSchedulerRuntimeConfig: vi.fn(),
}));

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ platformReadOnly: false }),
}));

vi.mock("./api", () => ({ platformAdminApi: mocks }));

const scheduler = {
  status: "ok" as const,
  sessionLockMode: "lease" as const,
  maxConcurrentRuns: 16,
  effectiveMaxConcurrentRuns: 16,
  maxConfigurableConcurrentRuns: 64,
  editable: true,
  executionEnabled: true,
  inFlightRuns: 3,
  inFlightBackgroundRuns: 1,
  foregroundReservedRuns: 10,
  updatedAt: "2026-08-27T00:00:00.000Z",
  updatedBy: "admin",
};

describe("SystemSettingsPanel", () => {
  beforeEach(() => {
    mocks.alertingStatus.mockReset().mockResolvedValue({
      configured: true,
      webhookConfigured: true,
      minSeverity: "high",
      notifyCount: 2,
    });
    mocks.schedulerRuntimeConfig.mockReset().mockResolvedValue({ runtimeScheduler: scheduler });
    mocks.updateSchedulerRuntimeConfig.mockReset().mockImplementation(async (value: number) => ({
      runtimeScheduler: { ...scheduler, maxConcurrentRuns: value, effectiveMaxConcurrentRuns: value },
    }));
    mocks.sendTestAlert.mockReset().mockResolvedValue({ status: "ok" });
  });

  it("读取并确认保存顶层任务调度并发", async () => {
    render(<SystemSettingsPanel />);

    const input = await screen.findByLabelText("期望并发");
    expect((input as HTMLInputElement).value).toBe("16");
    fireEvent.change(input, { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并热生效" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("当前期望值")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "保存并热生效" }));

    await waitFor(() => expect(mocks.updateSchedulerRuntimeConfig).toHaveBeenCalledWith(20));
    expect(await screen.findByText("顶层任务并发已调整为 20")).toBeTruthy();
  });

  it("拒绝超出后端声明上限的并发值", async () => {
    render(<SystemSettingsPanel />);

    const input = await screen.findByLabelText("期望并发");
    fireEvent.change(input, { target: { value: "65" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并热生效" }));

    expect(await screen.findByText("顶层任务并发必须是 1-64 的整数")).toBeTruthy();
    expect(mocks.updateSchedulerRuntimeConfig).not.toHaveBeenCalled();
  });
});

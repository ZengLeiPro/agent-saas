import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SettingsDirtyBoundary } from "@/components/PersonalSettings/dirtyRegistry";
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

function renderGuardedPanel(onNavigate: () => void) {
  return render(
    <SettingsDirtyBoundary>
      {({ requestNavigation }) => (
        <>
          <SystemSettingsPanel />
          <button type="button" onClick={() => requestNavigation(onNavigate)}>离开设置</button>
        </>
      )}
    </SettingsDirtyBoundary>,
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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

  it("未保存调度草稿阻止导航，放弃后恢复服务端值再继续", async () => {
    const onNavigate = vi.fn();
    renderGuardedPanel(onNavigate);

    const input = await screen.findByLabelText("期望并发");
    fireEvent.change(input, { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "离开设置" }));

    expect(await screen.findByText("有未保存的更改")).toBeTruthy();
    expect(screen.getByText(/顶层任务调度并发尚未保存/)).toBeTruthy();
    expect(onNavigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "放弃更改" }));

    await waitFor(() => expect(onNavigate).toHaveBeenCalledTimes(1));
    expect((input as HTMLInputElement).value).toBe("16");
    expect(mocks.updateSchedulerRuntimeConfig).not.toHaveBeenCalled();
  });

  it("浏览器后退时保存调度草稿后才继续历史导航", async () => {
    window.history.replaceState({ page: "source" }, "", "/settings/platform/system/source");
    window.history.pushState({ __personalSettingsV2: { source: "/settings/platform/system/source", depth: 1 } }, "", "/settings/platform/system");
    const onPopstate = vi.fn();
    window.addEventListener("popstate", onPopstate);
    renderGuardedPanel(vi.fn());

    const input = await screen.findByLabelText("期望并发");
    fireEvent.change(input, { target: { value: "20" } });
    act(() => window.history.back());

    expect(await screen.findByText("有未保存的更改")).toBeTruthy();
    expect(window.location.pathname).toBe("/settings/platform/system");
    expect(onPopstate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "保存并继续" }));

    await waitFor(() => expect(window.location.pathname).toBe("/settings/platform/system/source"));
    expect(mocks.updateSchedulerRuntimeConfig).toHaveBeenCalledWith(20);
    expect(onPopstate).toHaveBeenCalledTimes(1);
    window.removeEventListener("popstate", onPopstate);
  });

  it("浏览器后退时保存失败继续停留并保留调度草稿", async () => {
    window.history.replaceState({ page: "source" }, "", "/settings/platform/system/source");
    window.history.pushState({ __personalSettingsV2: { source: "/settings/platform/system/source", depth: 1 } }, "", "/settings/platform/system");
    mocks.updateSchedulerRuntimeConfig.mockRejectedValueOnce(new Error("调度配置保存失败"));
    const onPopstate = vi.fn();
    window.addEventListener("popstate", onPopstate);
    renderGuardedPanel(vi.fn());

    const input = await screen.findByLabelText("期望并发");
    fireEvent.change(input, { target: { value: "20" } });
    act(() => window.history.back());
    fireEvent.click(await screen.findByRole("button", { name: "保存并继续" }));

    expect(await screen.findByText("调度配置保存失败")).toBeTruthy();
    expect(window.location.pathname).toBe("/settings/platform/system");
    expect(onPopstate).not.toHaveBeenCalled();
    expect((input as HTMLInputElement).value).toBe("20");
    window.removeEventListener("popstate", onPopstate);
  });

  it("调度刷新在途时禁用输入，响应后再采用服务端值", async () => {
    let resolveRefresh!: (value: { runtimeScheduler: typeof scheduler }) => void;
    mocks.schedulerRuntimeConfig.mockResolvedValueOnce({ runtimeScheduler: scheduler }).mockImplementationOnce(() => new Promise((resolve) => { resolveRefresh = resolve; }));
    render(<SystemSettingsPanel />);

    const input = await screen.findByLabelText("期望并发");
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(true));
    resolveRefresh({ runtimeScheduler: { ...scheduler, maxConcurrentRuns: 18, effectiveMaxConcurrentRuns: 18 } });

    await waitFor(() => expect((input as HTMLInputElement).value).toBe("18"));
    expect((input as HTMLInputElement).disabled).toBe(false);
  });

  it("StrictMode 双初始 GET 的迟到旧响应不会覆盖已编辑草稿", async () => {
    const first = deferred<{ runtimeScheduler: typeof scheduler }>();
    const second = deferred<{ runtimeScheduler: typeof scheduler }>();
    mocks.schedulerRuntimeConfig.mockReset()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    render(<StrictMode><SystemSettingsPanel /></StrictMode>);
    await waitFor(() => expect(mocks.schedulerRuntimeConfig).toHaveBeenCalledTimes(2));

    act(() => second.resolve({ runtimeScheduler: { ...scheduler, maxConcurrentRuns: 18, effectiveMaxConcurrentRuns: 18 } }));
    const input = await screen.findByLabelText("期望并发");
    await waitFor(() => expect((input as HTMLInputElement).value).toBe("18"));
    fireEvent.change(input, { target: { value: "20" } });
    await act(async () => {
      first.resolve({ runtimeScheduler: { ...scheduler, maxConcurrentRuns: 12, effectiveMaxConcurrentRuns: 12 } });
      await first.promise;
      await Promise.resolve();
    });

    expect((input as HTMLInputElement).value).toBe("20");
  });

  it("保存使 StrictMode 迟到初始 GET 失效且 PATCH 结果保持权威", async () => {
    const first = deferred<{ runtimeScheduler: typeof scheduler }>();
    const second = deferred<{ runtimeScheduler: typeof scheduler }>();
    const patch = deferred<{ runtimeScheduler: typeof scheduler }>();
    mocks.schedulerRuntimeConfig.mockReset()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    mocks.updateSchedulerRuntimeConfig.mockReset().mockImplementationOnce(() => patch.promise);
    render(<StrictMode><SystemSettingsPanel /></StrictMode>);
    await waitFor(() => expect(mocks.schedulerRuntimeConfig).toHaveBeenCalledTimes(2));
    act(() => second.resolve({ runtimeScheduler: scheduler }));

    const input = await screen.findByLabelText("期望并发");
    fireEvent.change(input, { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并热生效" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "保存并热生效" }));
    await waitFor(() => expect(mocks.updateSchedulerRuntimeConfig).toHaveBeenCalledWith(20));

    await act(async () => {
      patch.resolve({ runtimeScheduler: { ...scheduler, maxConcurrentRuns: 20, effectiveMaxConcurrentRuns: 20 } });
      await patch.promise;
    });
    expect(await screen.findByText("顶层任务并发已调整为 20")).toBeTruthy();

    await act(async () => {
      first.resolve({ runtimeScheduler: { ...scheduler, maxConcurrentRuns: 12, effectiveMaxConcurrentRuns: 12 } });
      await first.promise;
      await Promise.resolve();
    });
    expect((input as HTMLInputElement).value).toBe("20");
  });
});

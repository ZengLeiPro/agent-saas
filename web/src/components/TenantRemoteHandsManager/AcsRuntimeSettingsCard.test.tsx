import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SettingsDirtyBoundary } from "@/components/PersonalSettings/dirtyRegistry";
import { refreshAll } from "@/lib/refreshBus";
import { AcsRuntimeSettingsCard } from "./AcsRuntimeSettingsCard";

const mocks = vi.hoisted(() => ({ authFetch: vi.fn() }));

vi.mock("@/lib/authFetch", () => ({ authFetch: mocks.authFetch }));

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderGuardedCard(onNavigate: () => void) {
  return render(
    <SettingsDirtyBoundary>
      {({ requestNavigation }) => (
        <>
          <AcsRuntimeSettingsCard readOnly={false} />
          <button type="button" onClick={() => requestNavigation(onNavigate)}>离开设置</button>
        </>
      )}
    </SettingsDirtyBoundary>,
  );
}

const runtimeConfig = {
  maxRunningSandboxes: 20,
  warnRunningSandboxes: 15,
  drainDeadlineMs: 300_000,
  persisted: true,
};

async function findLoadedMaxInput() {
  const input = await screen.findByLabelText("最大运行环境数");
  await waitFor(() => expect((input as HTMLInputElement).value).toBe("20"));
  return input;
}

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

    const maxInput = await findLoadedMaxInput();
    fireEvent.change(maxInput, { target: { value: "30" } });
    fireEvent.change(screen.getByLabelText("运行环境告警阈值"), { target: { value: "24" } });
    fireEvent.change(screen.getByLabelText("排空超时（毫秒）"), { target: { value: "600000" } });
    mocks.authFetch.mockResolvedValueOnce(jsonResponse({
      status: "ok",
      runtimeConfig: { ...runtimeConfig, maxRunningSandboxes: 31, warnRunningSandboxes: 24, drainDeadlineMs: 600_000 },
    }));
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
    expect((maxInput as HTMLInputElement).value).toBe("31");
  });

  it("生产 5000/4500 基线仅修改排空超时也可成功保存", async () => {
    const productionConfig = { ...runtimeConfig, maxRunningSandboxes: 5_000, warnRunningSandboxes: 4_500 };
    mocks.authFetch.mockImplementation(async (_input: string, init?: RequestInit) => {
      if (init?.method === "PATCH") return jsonResponse({ status: "ok", runtimeConfig: JSON.parse(String(init.body)) });
      return jsonResponse({ status: "ok", runtimeConfig: productionConfig });
    });
    render(<AcsRuntimeSettingsCard readOnly={false} />);

    const maxInput = await screen.findByLabelText("最大运行环境数");
    await waitFor(() => expect((maxInput as HTMLInputElement).value).toBe("5000"));
    fireEvent.change(screen.getByLabelText("排空超时（毫秒）"), { target: { value: "600000" } });
    fireEvent.click(screen.getByRole("button", { name: "保存 ACS 配置" }));

    await waitFor(() => expect(mocks.authFetch).toHaveBeenCalledTimes(2));
    const [, init] = mocks.authFetch.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      maxRunningSandboxes: 5_000,
      warnRunningSandboxes: 4_500,
      drainDeadlineMs: 600_000,
    });
    expect(screen.queryByText(/必须是 0-10000 的整数/)).toBeNull();
  });

  it("接受 10000 高位边界并拒绝 10001", async () => {
    render(<AcsRuntimeSettingsCard readOnly={false} />);

    const maxInput = await findLoadedMaxInput();
    fireEvent.change(maxInput, { target: { value: "10000" } });
    fireEvent.change(screen.getByLabelText("运行环境告警阈值"), { target: { value: "10000" } });
    fireEvent.click(screen.getByRole("button", { name: "保存 ACS 配置" }));
    await waitFor(() => expect(mocks.authFetch).toHaveBeenCalledTimes(2));

    fireEvent.change(maxInput, { target: { value: "10001" } });
    fireEvent.click(screen.getByRole("button", { name: "保存 ACS 配置" }));
    expect(await screen.findByText("最大运行环境数必须是 0-10000 的整数")).toBeTruthy();
    expect(mocks.authFetch).toHaveBeenCalledTimes(2);
  });

  it("告警阈值超过有效上限时不提交", async () => {
    render(<AcsRuntimeSettingsCard readOnly={false} />);

    await findLoadedMaxInput();
    fireEvent.change(screen.getByLabelText("最大运行环境数"), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("运行环境告警阈值"), { target: { value: "11" } });
    fireEvent.click(screen.getByRole("button", { name: "保存 ACS 配置" }));

    expect(await screen.findByText("运行环境告警阈值不能大于最大运行环境数")).toBeTruthy();
    expect(mocks.authFetch).toHaveBeenCalledTimes(1);
  });

  it("浏览器前进时放弃 ACS 草稿后才继续历史导航", async () => {
    window.history.replaceState({ __personalSettingsV2: { source: "/", depth: 1 } }, "", "/settings/platform/acs/source");
    window.history.pushState({ __personalSettingsV2: { source: "/", depth: 2 } }, "", "/settings/platform/acs");
    await act(async () => {
      await new Promise<void>((resolve) => {
        window.addEventListener("popstate", () => resolve(), { once: true });
        window.history.back();
      });
    });
    const onPopstate = vi.fn();
    window.addEventListener("popstate", onPopstate);
    renderGuardedCard(vi.fn());

    const maxInput = await findLoadedMaxInput();
    fireEvent.change(maxInput, { target: { value: "30" } });
    act(() => window.history.forward());

    expect(await screen.findByText("有未保存的更改")).toBeTruthy();
    expect(window.location.pathname).toBe("/settings/platform/acs/source");
    expect(onPopstate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "放弃更改" }));

    await waitFor(() => expect(window.location.pathname).toBe("/settings/platform/acs"));
    expect((maxInput as HTMLInputElement).value).toBe("20");
    expect(onPopstate).toHaveBeenCalledTimes(1);
    window.removeEventListener("popstate", onPopstate);
  });

  it("ACS 保存失败时继续阻止导航并保留草稿", async () => {
    const onNavigate = vi.fn();
    renderGuardedCard(onNavigate);

    const maxInput = await findLoadedMaxInput();
    fireEvent.change(maxInput, { target: { value: "30" } });
    mocks.authFetch.mockResolvedValueOnce(jsonResponse({ error: "ACS 配置保存失败" }, 500));
    fireEvent.click(screen.getByRole("button", { name: "离开设置" }));
    fireEvent.click(await screen.findByRole("button", { name: "保存并继续" }));

    expect(await screen.findByText("ACS 配置保存失败")).toBeTruthy();
    expect(onNavigate).not.toHaveBeenCalled();
    expect((maxInput as HTMLInputElement).value).toBe("30");
  });

  it("未保存 ACS 草稿不被后台刷新覆盖，放弃后恢复最新服务端配置", async () => {
    const onNavigate = vi.fn();
    renderGuardedCard(onNavigate);

    const maxInput = await findLoadedMaxInput();
    fireEvent.change(maxInput, { target: { value: "30" } });
    mocks.authFetch.mockResolvedValueOnce(jsonResponse({
      status: "ok",
      runtimeConfig: { ...runtimeConfig, maxRunningSandboxes: 40 },
    }));
    await act(async () => { await refreshAll(); });
    expect((maxInput as HTMLInputElement).value).toBe("30");
    fireEvent.click(screen.getByRole("button", { name: "离开设置" }));

    expect(await screen.findByText("有未保存的更改")).toBeTruthy();
    expect(screen.getByText(/ACS 运行保护尚未保存/)).toBeTruthy();
    expect(onNavigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "放弃更改" }));

    await waitFor(() => expect(onNavigate).toHaveBeenCalledTimes(1));
    expect((maxInput as HTMLInputElement).value).toBe("40");
    expect(mocks.authFetch).toHaveBeenCalledTimes(2);
  });

  it("干净状态后台刷新同步最新服务端配置且不产生 dirty", async () => {
    const onNavigate = vi.fn();
    renderGuardedCard(onNavigate);

    const maxInput = await findLoadedMaxInput();
    mocks.authFetch.mockResolvedValueOnce(jsonResponse({
      status: "ok",
      runtimeConfig: { ...runtimeConfig, maxRunningSandboxes: 40 },
    }));
    await act(async () => { await refreshAll(); });

    expect((maxInput as HTMLInputElement).value).toBe("40");
    fireEvent.click(screen.getByRole("button", { name: "离开设置" }));
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("有未保存的更改")).toBeNull();
  });

  it("dirty guard 保存时忽略迟到的 GET，不让旧响应覆盖 PATCH", async () => {
    const onNavigate = vi.fn();
    renderGuardedCard(onNavigate);

    const maxInput = await findLoadedMaxInput();
    fireEvent.change(maxInput, { target: { value: "30" } });
    let resolveStaleGet!: (response: Response) => void;
    mocks.authFetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveStaleGet = resolve; }));
    let refreshPromise!: Promise<void>;
    act(() => { refreshPromise = refreshAll(); });
    mocks.authFetch.mockResolvedValueOnce(jsonResponse({
      status: "ok",
      runtimeConfig: { ...runtimeConfig, maxRunningSandboxes: 30 },
    }));

    fireEvent.click(screen.getByRole("button", { name: "离开设置" }));
    fireEvent.click(await screen.findByRole("button", { name: "保存并继续" }));
    await waitFor(() => expect(onNavigate).toHaveBeenCalledTimes(1));
    expect(mocks.authFetch).toHaveBeenCalledTimes(3);

    await act(async () => {
      resolveStaleGet(jsonResponse({ status: "ok", runtimeConfig: { ...runtimeConfig, maxRunningSandboxes: 40 } }));
      await refreshPromise;
    });
    expect((maxInput as HTMLInputElement).value).toBe("30");
    expect((screen.getByRole("button", { name: "保存 ACS 配置" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

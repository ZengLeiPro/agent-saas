import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  SettingsDirtyBoundary,
  persistSettingsDraft,
  restoreSettingsDraft,
  useSettingsDirtyEntry,
} from "./dirtyRegistry";

// The editor must be a descendant of the provider, matching SettingsModal's wrapper split.
function WrappedDirtyHarness({ onNavigate }: { onNavigate: () => void }) {
  return (
    <SettingsDirtyBoundary>
      {({ requestNavigation }) => <RegisteredEditor requestNavigation={requestNavigation} onNavigate={onNavigate} />}
    </SettingsDirtyBoundary>
  );
}

function RegisteredEditor({ requestNavigation, onNavigate }: { requestNavigation: (next: () => void) => void; onNavigate: () => void }) {
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState("");
  useSettingsDirtyEntry({
    id: "test-editor",
    label: "测试编辑器",
    dirty: value !== saved,
    save: () => setSaved(value),
    discard: () => setValue(saved),
    draft: { value },
  });
  return (
    <>
      <input aria-label="草稿" value={value} onChange={(event) => setValue(event.target.value)} />
      <button onClick={() => requestNavigation(onNavigate)}>切页</button>
    </>
  );
}

beforeEach(() => sessionStorage.clear());

describe("个人设置 dirty registry", () => {
  it("切页提供保存、放弃、取消三选一，并注册 beforeunload", async () => {
    const onNavigate = vi.fn();
    render(<WrappedDirtyHarness onNavigate={onNavigate} />);
    await userEvent.type(screen.getByLabelText("草稿"), "未保存");

    const beforeUnload = new Event("beforeunload", { cancelable: true });
    fireEvent(window, beforeUnload);
    expect(beforeUnload.defaultPrevented).toBe(true);

    await userEvent.click(screen.getByRole("button", { name: "切页" }));
    expect(screen.getByRole("button", { name: "保存并继续" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "放弃更改" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "取消" })).toBeTruthy();
    expect(onNavigate).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "保存并继续" }));
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it("真实浏览器后退经过 dirty 三选一，取消留在原页，放弃后才继续", async () => {
    window.history.replaceState({ page: "source" }, "", "/settings/source");
    window.history.pushState({ __personalSettingsV2: { source: "/settings/source", depth: 1 } }, "", "/settings/current");
    const onPopstate = vi.fn();
    window.addEventListener("popstate", onPopstate);
    render(<WrappedDirtyHarness onNavigate={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("草稿"), "未保存");

    act(() => window.history.back());
    expect(await screen.findByText("有未保存的更改")).toBeTruthy();
    expect(window.location.pathname).toBe("/settings/current");
    expect(onPopstate).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(window.location.pathname).toBe("/settings/current");
    act(() => window.history.back());
    expect(await screen.findByText("有未保存的更改")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "放弃更改" }));

    await waitFor(() => expect(window.location.pathname).toBe("/settings/source"));
    expect(onPopstate).toHaveBeenCalledTimes(1);
    act(() => window.history.forward());
    await waitFor(() => expect(window.location.pathname).toBe("/settings/current"));
    act(() => window.history.back());
    await waitFor(() => expect(window.location.pathname).toBe("/settings/source"));
    expect(onPopstate).toHaveBeenCalledTimes(3);
    window.removeEventListener("popstate", onPopstate);
  });

  it("app history index 可恢复无 depth 的 Forward 并保留原页", async () => {
    window.history.replaceState({ __appHistoryIndex: 1 }, "", "/settings/current");
    window.history.pushState({ __appHistoryIndex: 2 }, "", "/settings/target");
    await act(async () => {
      await new Promise<void>((resolve) => {
        window.addEventListener("popstate", () => resolve(), { once: true });
        window.history.back();
      });
    });
    render(<WrappedDirtyHarness onNavigate={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("草稿"), "未保存");

    act(() => window.history.forward());
    expect(await screen.findByText("有未保存的更改")).toBeTruthy();
    expect(window.location.pathname).toBe("/settings/current");
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
  });

  it("旧 entry 无 app index 时不会混用 Navigation API 坐标", async () => {
    window.history.replaceState({}, "", "/settings/current");
    window.history.pushState({}, "", "/settings/target");
    await act(async () => {
      await new Promise<void>((resolve) => {
        window.addEventListener("popstate", () => resolve(), { once: true });
        window.history.back();
      });
    });
    const previousNavigation = Object.getOwnPropertyDescriptor(window, "navigation");
    Object.defineProperty(window, "navigation", {
      configurable: true,
      value: { get currentEntry() { return { index: window.location.pathname.endsWith("target") ? 8 : 7 }; } },
    });
    render(<WrappedDirtyHarness onNavigate={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("草稿"), "未保存");

    act(() => window.history.forward());
    expect(await screen.findByText("有未保存的更改")).toBeTruthy();
    expect(window.location.pathname).toBe("/settings/current");
    await userEvent.click(screen.getByRole("button", { name: "取消" }));

    if (previousNavigation) Object.defineProperty(window, "navigation", previousNavigation);
    else delete (window as Window & { navigation?: unknown }).navigation;
  });

  it("无 Navigation API 的旧无索引 Forward 仍优先守住草稿", async () => {
    window.history.replaceState({}, "", "/settings/current");
    window.history.pushState({}, "", "/settings/target");
    await act(async () => {
      await new Promise<void>((resolve) => {
        window.addEventListener("popstate", () => resolve(), { once: true });
        window.history.back();
      });
    });
    const previousNavigation = Object.getOwnPropertyDescriptor(window, "navigation");
    Object.defineProperty(window, "navigation", { configurable: true, value: undefined });
    render(<WrappedDirtyHarness onNavigate={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("草稿"), "未保存");

    act(() => window.history.forward());
    expect(await screen.findByText("有未保存的更改")).toBeTruthy();
    expect(window.location.pathname).toBe("/settings/current");
    await userEvent.click(screen.getByRole("button", { name: "放弃更改" }));
    await waitFor(() => expect(window.location.pathname).toBe("/settings/target"));

    if (previousNavigation) Object.defineProperty(window, "navigation", previousNavigation);
    else delete (window as Window & { navigation?: unknown }).navigation;
  });

  it("应用内部 synthetic popstate 不触发 dirty 对话框", async () => {
    const onPopstate = vi.fn();
    window.addEventListener("popstate", onPopstate);
    render(<WrappedDirtyHarness onNavigate={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("草稿"), "未保存");

    act(() => window.dispatchEvent(new PopStateEvent("popstate")));

    expect(onPopstate).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("有未保存的更改")).toBeNull();
    window.removeEventListener("popstate", onPopstate);
  });

  it("非 Secret 草稿可恢复，敏感字段与 Secret 草稿永不持久化", () => {
    persistSettingsDraft("normal", { displayName: "可恢复", token: "never-store", nested: { accessToken: "never-store", note: "保留" } });
    persistSettingsDraft("secret", { password: "never-store" }, { secret: true });

    expect(restoreSettingsDraft("normal")).toEqual({ displayName: "可恢复", nested: { note: "保留" } });
    expect(restoreSettingsDraft("secret", { secret: true })).toBeNull();
    expect([...Array(sessionStorage.length)].map((_, index) => sessionStorage.key(index)).join("\n"))
      .not.toContain("secret");
  });
});

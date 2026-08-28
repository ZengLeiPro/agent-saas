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

function RegisteredEditor({
  requestNavigation,
  onNavigate,
  onSave,
}: {
  requestNavigation: (next: () => void) => void;
  onNavigate: () => void;
  onSave?: () => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState("");
  useSettingsDirtyEntry({
    id: "test-editor",
    label: "测试编辑器",
    dirty: value !== saved,
    save: async () => {
      await onSave?.();
      setSaved(value);
    },
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

  it("pending save 时再次 Back/Forward 不会覆盖已确认目标", async () => {
    window.history.replaceState({ __appHistoryIndex: 1 }, "", "/settings/source");
    window.history.pushState({ __appHistoryIndex: 2 }, "", "/settings/current");
    window.history.pushState({ __appHistoryIndex: 3 }, "", "/settings/forward");
    await act(async () => {
      await new Promise<void>((resolve) => {
        window.addEventListener("popstate", () => resolve(), { once: true });
        window.history.back();
      });
    });

    let resolveSave!: () => void;
    const onSave = vi.fn(() => new Promise<void>((resolve) => { resolveSave = resolve; }));
    const syntheticTarget = vi.fn();
    render(
      <SettingsDirtyBoundary>
        {({ requestNavigation }) => (
          <RegisteredEditor requestNavigation={requestNavigation} onNavigate={syntheticTarget} onSave={onSave} />
        )}
      </SettingsDirtyBoundary>,
    );
    await userEvent.type(screen.getByLabelText("草稿"), "未保存");

    act(() => window.history.back());
    expect(await screen.findByText("有未保存的更改")).toBeTruthy();
    expect(window.location.pathname).toBe("/settings/current");

    const syntheticNavigationButton = screen.getByRole("button", { name: "切页", hidden: true });
    await userEvent.click(screen.getByRole("button", { name: "保存并继续" }));
    expect(onSave).toHaveBeenCalledTimes(1);
    fireEvent.click(syntheticNavigationButton);

    act(() => {
      window.history.forward();
      resolveSave();
    });

    await waitFor(() => expect(window.location.pathname).toBe("/settings/source"));
    expect(syntheticTarget).not.toHaveBeenCalled();
  });

  it("restore 尚未完成时连续 Back/Forward 不会把重复 app index 的额外目标误认成恢复点", async () => {
    window.history.replaceState({ __appHistoryIndex: 1 }, "", "/settings/source");
    window.history.pushState({ __appHistoryIndex: 2 }, "", "/settings/current");
    window.history.pushState({ __appHistoryIndex: 2 }, "", "/settings/forward");
    const previousNavigation = Object.getOwnPropertyDescriptor(window, "navigation");
    Object.defineProperty(window, "navigation", {
      configurable: true,
      value: {
        get currentEntry() {
          const index = window.location.pathname.endsWith("source") ? 1 : window.location.pathname.endsWith("current") ? 2 : 3;
          return { index };
        },
      },
    });
    await act(async () => {
      await new Promise<void>((resolve) => {
        window.addEventListener("popstate", () => resolve(), { once: true });
        window.history.back();
      });
    });
    render(<WrappedDirtyHarness onNavigate={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("草稿"), "未保存");

    act(() => {
      window.history.back();
      window.history.forward();
    });

    expect(await screen.findByText("有未保存的更改")).toBeTruthy();
    await waitFor(() => expect(window.location.pathname).toBe("/settings/current"));
    await userEvent.click(screen.getByRole("button", { name: "放弃更改" }));
    await waitFor(() => expect(window.location.pathname).toBe("/settings/source"));

    if (previousNavigation) Object.defineProperty(window, "navigation", previousNavigation);
    else delete (window as Window & { navigation?: unknown }).navigation;
  });

  it("无 Navigation API 且重复 app index 的跨级取消会恢复当前页并保留全部历史槽", async () => {
    window.history.replaceState({ __appHistoryIndex: 1 }, "", "/settings/source");
    window.history.pushState({ __appHistoryIndex: 2 }, "", "/settings/middle");
    window.history.pushState({ __appHistoryIndex: 2 }, "", "/settings/current");
    const previousNavigation = Object.getOwnPropertyDescriptor(window, "navigation");
    Object.defineProperty(window, "navigation", { configurable: true, value: undefined });
    render(<WrappedDirtyHarness onNavigate={vi.fn()} />);
    const draft = screen.getByLabelText("草稿");
    await userEvent.type(draft, "未保存");

    act(() => window.history.go(-2));
    expect(await screen.findByText("有未保存的更改")).toBeTruthy();
    expect(window.location.pathname).toBe("/settings/current");
    await userEvent.click(screen.getByRole("button", { name: "取消" }));

    fireEvent.change(draft, { target: { value: "" } });
    for (const [direction, expected] of [
      ["back", "/settings/middle"],
      ["back", "/settings/source"],
      ["forward", "/settings/middle"],
      ["forward", "/settings/current"],
    ] as const) {
      await act(async () => {
        await new Promise<void>((resolve) => {
          window.addEventListener("popstate", () => resolve(), { once: true });
          window.history[direction]();
        });
      });
      expect(window.location.pathname).toBe(expected);
    }

    if (previousNavigation) Object.defineProperty(window, "navigation", previousNavigation);
    else delete (window as Window & { navigation?: unknown }).navigation;
  });

  it("重复跨级 Back→取消仍用 marker 回到真正 accepted 槽", async () => {
    window.history.replaceState({ __appHistoryIndex: 1, slot: "source" }, "", "/settings/source");
    window.history.pushState({ __appHistoryIndex: 2, slot: "decoy" }, "", "/settings/current");
    window.history.pushState({ __appHistoryIndex: 2, slot: "current" }, "", "/settings/current");
    const previousNavigation = Object.getOwnPropertyDescriptor(window, "navigation");
    Object.defineProperty(window, "navigation", { configurable: true, value: undefined });
    render(<WrappedDirtyHarness onNavigate={vi.fn()} />);
    const draft = screen.getByLabelText("草稿");
    await userEvent.type(draft, "未保存");

    for (let attempt = 0; attempt < 2; attempt += 1) {
      act(() => window.history.go(-2));
      expect(await screen.findByText("有未保存的更改")).toBeTruthy();
      expect(window.history.state.slot).toBe("current");
      await userEvent.click(screen.getByRole("button", { name: "取消" }));
    }
    expect(Object.keys(window.history.state).some((key) => key.startsWith("__settingsDirtyHistoryEntry_"))).toBe(true);
    fireEvent.change(draft, { target: { value: "" } });
    await waitFor(() => {
      expect(Object.keys(window.history.state).some((key) => key.startsWith("__settingsDirtyHistoryEntry_"))).toBe(false);
    });

    if (previousNavigation) Object.defineProperty(window, "navigation", previousNavigation);
    else delete (window as Window & { navigation?: unknown }).navigation;
  });

  it("并行 Boundary 不会清除另一实例的 active marker", async () => {
    window.history.replaceState({ __appHistoryIndex: 1, slot: "source" }, "", "/settings/source");
    window.history.pushState({ __appHistoryIndex: 2, slot: "decoy" }, "", "/settings/current");
    window.history.pushState({ __appHistoryIndex: 2, slot: "current" }, "", "/settings/current");
    const previousNavigation = Object.getOwnPropertyDescriptor(window, "navigation");
    Object.defineProperty(window, "navigation", { configurable: true, value: undefined });
    render(
      <>
        <SettingsDirtyBoundary>{() => null}</SettingsDirtyBoundary>
        <WrappedDirtyHarness onNavigate={vi.fn()} />
      </>,
    );
    await userEvent.type(screen.getByLabelText("草稿"), "未保存");

    for (let attempt = 0; attempt < 2; attempt += 1) {
      act(() => window.history.go(-2));
      expect(await screen.findByText("有未保存的更改")).toBeTruthy();
      expect(window.history.state.slot).toBe("current");
      await userEvent.click(screen.getByRole("button", { name: "取消" }));
    }

    if (previousNavigation) Object.defineProperty(window, "navigation", previousNavigation);
    else delete (window as Window & { navigation?: unknown }).navigation;
  });

  it("唯一 entry 标记不会把同 href、同 app index 的旧槽误认成当前页", async () => {
    window.history.replaceState({ __appHistoryIndex: 1, slot: "source" }, "", "/settings/source");
    window.history.pushState({ __appHistoryIndex: 2, slot: "middle" }, "", "/settings/middle");
    window.history.pushState({ __appHistoryIndex: 2, slot: "decoy" }, "", "/settings/current");
    window.history.pushState({ __appHistoryIndex: 2, slot: "current" }, "", "/settings/current");
    const previousNavigation = Object.getOwnPropertyDescriptor(window, "navigation");
    Object.defineProperty(window, "navigation", { configurable: true, value: undefined });
    render(<WrappedDirtyHarness onNavigate={vi.fn()} />);
    const draft = screen.getByLabelText("草稿");
    await userEvent.type(draft, "未保存");

    act(() => window.history.go(-3));
    expect(await screen.findByText("有未保存的更改")).toBeTruthy();
    expect(window.history.state.slot).toBe("current");
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    fireEvent.change(draft, { target: { value: "" } });

    await act(async () => {
      await new Promise<void>((resolve) => {
        window.addEventListener("popstate", () => resolve(), { once: true });
        window.history.back();
      });
    });
    expect(window.location.pathname).toBe("/settings/current");
    expect(window.history.state.slot).toBe("decoy");

    if (previousNavigation) Object.defineProperty(window, "navigation", previousNavigation);
    else delete (window as Window & { navigation?: unknown }).navigation;
  });

  it("history.go 到边界不产生事件时会超时退出 traversal 而非永久拦截", async () => {
    window.history.replaceState({ __appHistoryIndex: 1 }, "", "/settings/source");
    window.history.pushState({ __appHistoryIndex: 2 }, "", "/settings/middle");
    window.history.pushState({ __appHistoryIndex: 2 }, "", "/settings/current");
    const previousNavigation = Object.getOwnPropertyDescriptor(window, "navigation");
    Object.defineProperty(window, "navigation", { configurable: true, value: undefined });
    const originalGo = window.history.go.bind(window.history);
    let goCalls = 0;
    const goSpy = vi.spyOn(window.history, "go").mockImplementation((delta = 0) => {
      goCalls += 1;
      if (goCalls === 1) originalGo(delta);
    });
    render(<WrappedDirtyHarness onNavigate={vi.fn()} />);
    const draft = screen.getByLabelText("草稿");
    await userEvent.type(draft, "未保存");

    act(() => window.history.go(-2));
    expect(await screen.findByText("有未保存的更改", {}, { timeout: 3_000 })).toBeTruthy();
    expect(window.location.pathname).toBe("/settings/current");
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    goSpy.mockRestore();
    fireEvent.change(draft, { target: { value: "" } });
    await act(async () => {
      await new Promise<void>((resolve) => {
        window.addEventListener("popstate", () => resolve(), { once: true });
        window.history.forward();
      });
    });
    expect(window.location.pathname).toBe("/settings/middle");
    await act(async () => {
      await new Promise<void>((resolve) => {
        window.addEventListener("popstate", () => resolve(), { once: true });
        window.history.forward();
      });
    });
    expect(window.location.pathname).toBe("/settings/current");
    expect(Object.keys(window.history.state).some((key) => key.startsWith("__settingsDirtyHistoryEntry_"))).toBe(false);

    if (previousNavigation) Object.defineProperty(window, "navigation", previousNavigation);
    else delete (window as Window & { navigation?: unknown }).navigation;
  });

  it.each(["保存并继续", "放弃更改"] as const)(
    "无 Navigation API 且重复 app index 的跨级跳转可经%s到达原目标",
    async (decision) => {
      window.history.replaceState({ __appHistoryIndex: 1 }, "", "/settings/source");
      window.history.pushState({ __appHistoryIndex: 2 }, "", "/settings/middle");
      window.history.pushState({ __appHistoryIndex: 2 }, "", "/settings/current");
      const previousNavigation = Object.getOwnPropertyDescriptor(window, "navigation");
      Object.defineProperty(window, "navigation", { configurable: true, value: undefined });
      render(<WrappedDirtyHarness onNavigate={vi.fn()} />);
      await userEvent.type(screen.getByLabelText("草稿"), "未保存");

      act(() => window.history.go(-2));
      expect(await screen.findByText("有未保存的更改")).toBeTruthy();
      expect(window.location.pathname).toBe("/settings/current");
      await userEvent.click(screen.getByRole("button", { name: decision }));
      await waitFor(() => expect(window.location.pathname).toBe("/settings/source"));

      await act(async () => {
        await new Promise<void>((resolve) => {
          window.addEventListener("popstate", () => resolve(), { once: true });
          window.history.forward();
        });
      });
      expect(window.location.pathname).toBe("/settings/middle");
      await act(async () => {
        await new Promise<void>((resolve) => {
          window.addEventListener("popstate", () => resolve(), { once: true });
          window.history.forward();
        });
      });
      expect(window.location.pathname).toBe("/settings/current");

      if (previousNavigation) Object.defineProperty(window, "navigation", previousNavigation);
      else delete (window as Window & { navigation?: unknown }).navigation;
    },
  );

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

  it("无坐标跨级 Forward 会逐槽向 Back 找到 accepted marker", async () => {
    window.history.replaceState({}, "", "/settings/current");
    window.history.pushState({}, "", "/settings/middle");
    window.history.pushState({}, "", "/settings/target");
    await act(async () => {
      await new Promise<void>((resolve) => {
        window.addEventListener("popstate", () => resolve(), { once: true });
        window.history.go(-2);
      });
    });
    const previousNavigation = Object.getOwnPropertyDescriptor(window, "navigation");
    Object.defineProperty(window, "navigation", { configurable: true, value: undefined });
    render(<WrappedDirtyHarness onNavigate={vi.fn()} />);
    const draft = screen.getByLabelText("草稿");
    await userEvent.type(draft, "未保存");

    act(() => window.history.go(2));
    expect(await screen.findByText("有未保存的更改")).toBeTruthy();
    expect(window.location.pathname).toBe("/settings/current");
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    fireEvent.change(draft, { target: { value: "" } });

    for (const expected of ["/settings/middle", "/settings/target"]) {
      await act(async () => {
        await new Promise<void>((resolve) => {
          window.addEventListener("popstate", () => resolve(), { once: true });
          window.history.forward();
        });
      });
      expect(window.location.pathname).toBe(expected);
    }

    if (previousNavigation) Object.defineProperty(window, "navigation", previousNavigation);
    else delete (window as Window & { navigation?: unknown }).navigation;
  });

  it("无坐标恢复只临时使用 marker，取消后原历史槽保持可达且无内部字段", async () => {
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
    const draft = screen.getByLabelText("草稿");
    await userEvent.type(draft, "未保存");
    expect(Object.keys(window.history.state).some((key) => key.startsWith("__settingsDirtyHistoryEntry_"))).toBe(true);

    act(() => window.history.forward());
    expect(await screen.findByText("有未保存的更改")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(Object.keys(window.history.state).some((key) => key.startsWith("__settingsDirtyHistoryEntry_"))).toBe(true);

    fireEvent.change(draft, { target: { value: "" } });
    await waitFor(() => {
      expect(Object.keys(window.history.state).some((key) => key.startsWith("__settingsDirtyHistoryEntry_"))).toBe(false);
    });
    await act(async () => {
      await new Promise<void>((resolve) => {
        window.addEventListener("popstate", () => resolve(), { once: true });
        window.history.forward();
      });
    });
    expect(window.location.pathname).toBe("/settings/target");
    expect(Object.keys(window.history.state).some((key) => key.startsWith("__settingsDirtyHistoryEntry_"))).toBe(false);

    if (previousNavigation) Object.defineProperty(window, "navigation", previousNavigation);
    else delete (window as Window & { navigation?: unknown }).navigation;
  });

  it("无坐标同 href 的不同 primitive state 不会误认 accepted", async () => {
    window.history.replaceState("accepted", "", "/settings/same");
    window.history.pushState("decoy", "", "/settings/same");
    window.history.pushState("target", "", "/settings/same");
    await act(async () => {
      await new Promise<void>((resolve) => {
        window.addEventListener("popstate", () => resolve(), { once: true });
        window.history.go(-2);
      });
    });
    const previousNavigation = Object.getOwnPropertyDescriptor(window, "navigation");
    Object.defineProperty(window, "navigation", { configurable: true, value: undefined });
    render(<WrappedDirtyHarness onNavigate={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("草稿"), "未保存");

    act(() => window.history.go(2));
    expect(await screen.findByText("有未保存的更改")).toBeTruthy();
    expect(window.history.state).toBe("accepted");
    await userEvent.click(screen.getByRole("button", { name: "取消" }));

    if (previousNavigation) Object.defineProperty(window, "navigation", previousNavigation);
    else delete (window as Window & { navigation?: unknown }).navigation;
  });

  it("无坐标同 href 时区分稀疏数组与显式 undefined", async () => {
    window.history.replaceState([undefined], "", "/settings/same");
    window.history.pushState(Array(1), "", "/settings/same");
    window.history.pushState(["target"], "", "/settings/same");
    await act(async () => {
      await new Promise<void>((resolve) => {
        window.addEventListener("popstate", () => resolve(), { once: true });
        window.history.go(-2);
      });
    });
    const previousNavigation = Object.getOwnPropertyDescriptor(window, "navigation");
    Object.defineProperty(window, "navigation", { configurable: true, value: undefined });
    render(<WrappedDirtyHarness onNavigate={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("草稿"), "未保存");

    act(() => window.history.go(2));
    expect(await screen.findByText("有未保存的更改")).toBeTruthy();
    expect(window.history.state).toEqual([undefined]);
    expect(Object.prototype.hasOwnProperty.call(window.history.state, 0)).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "取消" }));

    if (previousNavigation) Object.defineProperty(window, "navigation", previousNavigation);
    else delete (window as Window & { navigation?: unknown }).navigation;
  });

  it("程序化导航前清理 accepted marker，Back 栈不残留内部字段", async () => {
    window.history.replaceState({ business: "kept" }, "", "/settings/current");
    render(<WrappedDirtyHarness onNavigate={() => window.history.pushState({}, "", "/settings/other")} />);
    await userEvent.type(screen.getByLabelText("草稿"), "未保存");
    await userEvent.click(screen.getByRole("button", { name: "切页" }));
    await userEvent.click(screen.getByRole("button", { name: "放弃更改" }));
    expect(window.location.pathname).toBe("/settings/other");

    await act(async () => {
      await new Promise<void>((resolve) => {
        window.addEventListener("popstate", () => resolve(), { once: true });
        window.history.back();
      });
    });
    expect(window.history.state).toEqual({ business: "kept", __appHistoryIndex: 0 });
  });

  it("marker 往返保留循环引用与内建对象", async () => {
    const cyclic: { self?: unknown; createdAt: Date } = { createdAt: new Date("2025-01-02T03:04:05Z") };
    cyclic.self = cyclic;
    window.history.replaceState(cyclic, "", "/settings/current");
    const view = render(<WrappedDirtyHarness onNavigate={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("草稿"), "未保存");
    view.unmount();

    expect(window.history.state.self).toBe(window.history.state);
    expect(window.history.state.createdAt).toBeInstanceOf(Date);
    expect(window.history.state.createdAt.toISOString()).toBe("2025-01-02T03:04:05.000Z");
  });

  it("Boundary 在 dirty 状态卸载时清理临时 marker", async () => {
    window.history.replaceState({ business: "kept" }, "", "/settings/current");
    const view = render(<WrappedDirtyHarness onNavigate={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("草稿"), "未保存");
    expect(Object.keys(window.history.state).some((key) => key.startsWith("__settingsDirtyHistoryEntry_"))).toBe(true);

    view.unmount();
    expect(window.history.state).toEqual({ business: "kept", __appHistoryIndex: 0 });
  });

  it.each([
    ["null", null],
    ["number", 42],
    ["array", ["legacy"]],
  ] as const)("dirty fallback 不改写 %s history state 的原始类型和值", async (_label, legacyState) => {
    window.history.replaceState({ __appHistoryIndex: 1 }, "", "/settings/current");
    window.history.pushState(legacyState, "", "/settings/target");
    await act(async () => {
      await new Promise<void>((resolve) => {
        window.addEventListener("popstate", () => resolve(), { once: true });
        window.history.back();
      });
    });
    const previousNavigation = Object.getOwnPropertyDescriptor(window, "navigation");
    Object.defineProperty(window, "navigation", { configurable: true, value: undefined });
    render(<WrappedDirtyHarness onNavigate={vi.fn()} />);
    const draft = screen.getByLabelText("草稿");
    await userEvent.type(draft, "未保存");

    act(() => window.history.forward());
    expect(await screen.findByText("有未保存的更改")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    fireEvent.change(draft, { target: { value: "" } });
    await act(async () => {
      await new Promise<void>((resolve) => {
        window.addEventListener("popstate", () => resolve(), { once: true });
        window.history.forward();
      });
    });
    expect(window.history.state).toEqual(legacyState);

    if (previousNavigation) Object.defineProperty(window, "navigation", previousNavigation);
    else delete (window as Window & { navigation?: unknown }).navigation;
  });

  it.each([
    ["null", null],
    ["number", 7],
    ["array", ["accepted"]],
  ] as const)("Boundary 挂载时保持 accepted %s history state 的原始类型和值", async (_label, acceptedState) => {
    window.history.replaceState(acceptedState, "", "/settings/current");
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
    const draft = screen.getByLabelText("草稿");
    await userEvent.type(draft, "未保存");
    expect(window.history.state).toEqual(acceptedState);

    act(() => window.history.forward());
    expect(await screen.findByText("有未保存的更改")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(window.history.state).toEqual(acceptedState);

    if (previousNavigation) Object.defineProperty(window, "navigation", previousNavigation);
    else delete (window as Window & { navigation?: unknown }).navigation;
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

  it("旧无索引 entry 取消后仍保留原目标供后续 Back/Forward", async () => {
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
    const draft = screen.getByLabelText("草稿");
    await userEvent.type(draft, "未保存");

    act(() => window.history.forward());
    expect(await screen.findByText("有未保存的更改")).toBeTruthy();
    expect(window.location.pathname).toBe("/settings/current");
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(window.location.pathname).toBe("/settings/current");

    fireEvent.change(draft, { target: { value: "" } });
    await act(async () => {
      await new Promise<void>((resolve) => {
        window.addEventListener("popstate", () => resolve(), { once: true });
        window.history.forward();
      });
    });
    expect(window.location.pathname).toBe("/settings/target");
    await act(async () => {
      await new Promise<void>((resolve) => {
        window.addEventListener("popstate", () => resolve(), { once: true });
        window.history.back();
      });
    });
    expect(window.location.pathname).toBe("/settings/current");

    if (previousNavigation) Object.defineProperty(window, "navigation", previousNavigation);
    else delete (window as Window & { navigation?: unknown }).navigation;
  });

  it("dirty accepted 的 synthetic popstate 不会丢 marker 并误认重复槽", async () => {
    window.history.replaceState({ __appHistoryIndex: 1, slot: "source" }, "", "/settings/source");
    window.history.pushState({ __appHistoryIndex: 2, slot: "decoy" }, "", "/settings/current");
    window.history.pushState({ __appHistoryIndex: 2, slot: "current" }, "", "/settings/current");
    const previousNavigation = Object.getOwnPropertyDescriptor(window, "navigation");
    Object.defineProperty(window, "navigation", { configurable: true, value: undefined });
    render(<WrappedDirtyHarness onNavigate={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("草稿"), "未保存");
    window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));

    act(() => window.history.go(-2));
    expect(await screen.findByText("有未保存的更改")).toBeTruthy();
    expect(window.history.state.slot).toBe("current");
    await userEvent.click(screen.getByRole("button", { name: "取消" }));

    if (previousNavigation) Object.defineProperty(window, "navigation", previousNavigation);
    else delete (window as Window & { navigation?: unknown }).navigation;
  });

  it("无坐标同 href 的 Date state 按值辨识 accepted", async () => {
    window.history.replaceState(new Date("2025-01-01T00:00:00Z"), "", "/settings/same");
    window.history.pushState(new Date("2025-01-02T00:00:00Z"), "", "/settings/same");
    window.history.pushState(new Date("2025-01-03T00:00:00Z"), "", "/settings/same");
    await act(async () => {
      await new Promise<void>((resolve) => {
        window.addEventListener("popstate", () => resolve(), { once: true });
        window.history.go(-2);
      });
    });
    const previousNavigation = Object.getOwnPropertyDescriptor(window, "navigation");
    Object.defineProperty(window, "navigation", { configurable: true, value: undefined });
    render(<WrappedDirtyHarness onNavigate={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("草稿"), "未保存");

    act(() => window.history.go(2));
    expect(await screen.findByText("有未保存的更改")).toBeTruthy();
    expect((window.history.state as Date).toISOString()).toBe("2025-01-01T00:00:00.000Z");
    await userEvent.click(screen.getByRole("button", { name: "取消" }));

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

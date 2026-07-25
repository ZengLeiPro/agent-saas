import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HISTORY_PUSH, HISTORY_PUSH_MERGED, QUERY_MERGE_MS, useAdminUrlQuery } from "@/hooks/useAdminUrlQuery";

describe("useAdminUrlQuery", () => {
  it("updates search params without changing the current pathname", () => {
    window.history.replaceState({}, "", "/platform-admin/runs?status=failed");

    const { result } = renderHook(() => useAdminUrlQuery());

    expect(result.current.get("status")).toBe("failed");

    act(() => {
      result.current.set("cursor", "next-1");
    });

    expect(window.location.pathname).toBe("/platform-admin/runs");
    expect(result.current.get("status")).toBe("failed");
    expect(result.current.get("cursor")).toBe("next-1");

    act(() => {
      result.current.patch({ status: "running", cursor: null });
    });

    expect(window.location.pathname).toBe("/platform-admin/runs");
    expect(result.current.get("status")).toBe("running");
    expect(result.current.get("cursor")).toBeNull();
  });

  it("reacts to browser history navigation", () => {
    window.history.replaceState({}, "", "/platform-admin/sessions?q=first");
    const { result } = renderHook(() => useAdminUrlQuery());

    window.history.pushState({}, "", "/platform-admin/sessions?q=second");
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(result.current.get("q")).toBe("second");
  });
});

/**
 * S4-2 历史栈契约。
 *
 * 改造前所有筛选变更一律 replaceState，后果**不是**「下钻后返回丢筛选」（后退拿到的是
 * 被覆盖后的条目，筛选还在），而是「页内连续改了 5 次筛选，后退键一次把用户踢出整页」——
 * 撤销粒度问题。所以 push 语义只给「用户显式动作」，程序性同步仍必须 replace。
 */
describe("useAdminUrlQuery 历史栈语义", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("默认（不传 options）仍是 replaceState —— 既有调用点语义不变", () => {
    window.history.replaceState({}, "", "/platform-admin/runs");
    const pushSpy = vi.spyOn(window.history, "pushState");
    const replaceSpy = vi.spyOn(window.history, "replaceState");
    const { result } = renderHook(() => useAdminUrlQuery());

    act(() => { result.current.set("status", "failed"); });
    act(() => { result.current.patch({ cursor: "c1" }); });
    act(() => { result.current.clear(["cursor"]); });
    act(() => { result.current.replace((params) => params.set("q", "x")); });

    expect(pushSpy).not.toHaveBeenCalled();
    expect(replaceSpy.mock.calls.length).toBe(4);
    pushSpy.mockRestore();
    replaceSpy.mockRestore();
  });

  it("history:'push' 每次显式筛选各留一条历史，后退可逐步撤销", () => {
    window.history.replaceState({}, "", "/platform-admin/runs");
    const { result } = renderHook(() => useAdminUrlQuery());

    act(() => { result.current.set("status", "failed", HISTORY_PUSH); });
    act(() => { result.current.set("tenantId", "t1", HISTORY_PUSH); });

    expect(result.current.get("status")).toBe("failed");
    expect(result.current.get("tenantId")).toBe("t1");

    // 模拟浏览器后退一步：撤销最后一次筛选，而不是退出整页
    act(() => {
      window.history.replaceState({}, "", "/platform-admin/runs?status=failed");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(result.current.get("status")).toBe("failed");
    expect(result.current.get("tenantId")).toBeNull();
  });

  it("push 时 URL 未变化则不写历史（重复点同一个筛选值不产出空条目）", () => {
    window.history.replaceState({}, "", "/platform-admin/runs?status=failed");
    const pushSpy = vi.spyOn(window.history, "pushState");
    const { result } = renderHook(() => useAdminUrlQuery());

    act(() => { result.current.set("status", "failed", HISTORY_PUSH); });

    expect(pushSpy).not.toHaveBeenCalled();
    pushSpy.mockRestore();
  });

  it("文本输入 500ms 合并：一次连续输入只留一条历史记录", () => {
    vi.useFakeTimers();
    window.history.replaceState({}, "", "/platform-admin/audit");
    const pushSpy = vi.spyOn(window.history, "pushState");
    const { result } = renderHook(() => useAdminUrlQuery());

    // 逐字符打「abc」
    act(() => { result.current.set("auditUser", "a", HISTORY_PUSH_MERGED); });
    act(() => { result.current.set("auditUser", "ab", HISTORY_PUSH_MERGED); });
    act(() => { result.current.set("auditUser", "abc", HISTORY_PUSH_MERGED); });

    expect(pushSpy.mock.calls.length).toBe(1);
    expect(result.current.get("auditUser")).toBe("abc");
    pushSpy.mockRestore();
  });

  it("静默超过合并窗口后，下一段输入重新开一条历史记录", () => {
    vi.useFakeTimers();
    window.history.replaceState({}, "", "/platform-admin/audit");
    const pushSpy = vi.spyOn(window.history, "pushState");
    const { result } = renderHook(() => useAdminUrlQuery());

    act(() => { result.current.set("auditUser", "a", HISTORY_PUSH_MERGED); });
    act(() => { vi.advanceTimersByTime(QUERY_MERGE_MS + 10); });
    act(() => { result.current.set("auditUser", "ab", HISTORY_PUSH_MERGED); });

    expect(pushSpy.mock.calls.length).toBe(2);
    pushSpy.mockRestore();
  });

  it("换到另一个字段输入时另起一条历史记录（合并分组按 key 划分）", () => {
    vi.useFakeTimers();
    window.history.replaceState({}, "", "/platform-admin/audit");
    const pushSpy = vi.spyOn(window.history, "pushState");
    const { result } = renderHook(() => useAdminUrlQuery());

    act(() => { result.current.set("auditUser", "a", HISTORY_PUSH_MERGED); });
    act(() => { result.current.set("auditFrom", "2026-07-01", HISTORY_PUSH_MERGED); });

    expect(pushSpy.mock.calls.length).toBe(2);
    pushSpy.mockRestore();
  });

  it("popstate 后合并分组作废：用户动过历史栈，下一次筛选必须新开条目", () => {
    vi.useFakeTimers();
    window.history.replaceState({}, "", "/platform-admin/audit");
    const { result } = renderHook(() => useAdminUrlQuery());

    act(() => { result.current.set("auditUser", "a", HISTORY_PUSH_MERGED); });
    act(() => {
      window.history.replaceState({}, "", "/platform-admin/audit");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    const pushSpy = vi.spyOn(window.history, "pushState");
    act(() => { result.current.set("auditUser", "ab", HISTORY_PUSH_MERGED); });
    expect(pushSpy.mock.calls.length).toBe(1);
    pushSpy.mockRestore();
  });

  it("patch 的多键变更算同一条历史（一次筛选动作 = 一条记录）", () => {
    window.history.replaceState({}, "", "/tenant-admin/usage");
    const pushSpy = vi.spyOn(window.history, "pushState");
    const { result } = renderHook(() => useAdminUrlQuery());

    act(() => {
      result.current.patch({ usageRange: "custom", usageFrom: "2026-07-01T00:00", usageTo: "2026-07-31T23:59" }, HISTORY_PUSH);
    });

    expect(pushSpy.mock.calls.length).toBe(1);
    expect(result.current.get("usageRange")).toBe("custom");
    expect(result.current.get("usageFrom")).toBe("2026-07-01T00:00");
    pushSpy.mockRestore();
  });

  it("空串 / null / undefined 一律删除该 key（URL 不留空参数）", () => {
    window.history.replaceState({}, "", "/tenant-admin/usage?usageRange=90d&usageUser=alice&usageSort=totalTurns");
    const { result } = renderHook(() => useAdminUrlQuery());

    act(() => { result.current.patch({ usageRange: "", usageUser: null, usageSort: undefined }, HISTORY_PUSH); });

    expect(window.location.search).toBe("");
  });

  it("update 是通用写入口：recipe 收到的是当前真实 URL 的 params", () => {
    window.history.replaceState({}, "", "/platform-admin/runs?a=1");
    const { result } = renderHook(() => useAdminUrlQuery());

    act(() => {
      result.current.update((params) => {
        expect(params.get("a")).toBe("1");
        params.set("b", "2");
      }, HISTORY_PUSH);
    });

    expect(result.current.get("a")).toBe("1");
    expect(result.current.get("b")).toBe("2");
  });
});

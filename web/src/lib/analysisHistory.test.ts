import { afterEach, describe, expect, it, vi } from "vitest";

import { buildGovernanceUrl, governanceRoute } from "@/lib/governanceNavigation";
import { pushGovernanceUrl, replaceGovernanceUrl } from "@/lib/urlSync";
import { analysisHistoryStateForNavigation, closeAnalysisHistory, ensureAnalysisHistoryEntry, markAnalysisHistoryEntry, readAnalysisHistoryState } from "./analysisHistory";

describe("分析工作区历史", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState({}, "", "/");
  });

  it("给每个分析历史条目标记共同来源与当前深度", () => {
    window.history.replaceState({ preserved: true }, "", "/platform-admin/overview/overview");
    markAnalysisHistoryEntry("/session/session-1", 2);

    expect(readAnalysisHistoryState()).toEqual({ source: "/session/session-1", depth: 2 });
    expect(window.history.state.preserved).toBe(true);
  });

  it("治理页 push 累计深度、replace 保持深度，重复当前页不虚增", () => {
    const overviewRoute = governanceRoute("platform.overview.overview");
    window.history.replaceState({}, "", buildGovernanceUrl(overviewRoute));
    markAnalysisHistoryEntry("/session/session-1", 1);

    pushGovernanceUrl(overviewRoute);
    expect(readAnalysisHistoryState()?.depth).toBe(1);

    pushGovernanceUrl(governanceRoute("platform.runtime.runs"));
    expect(readAnalysisHistoryState()?.depth).toBe(2);

    replaceGovernanceUrl(governanceRoute("platform.runtime.runs", { entityId: "run-1" }));
    expect(readAnalysisHistoryState()?.depth).toBe(2);
  });

  it("离开分析路由时不把分析关闭语义泄漏到设置页", () => {
    window.history.replaceState({}, "", "/platform-admin/overview/overview");
    markAnalysisHistoryEntry("/session/session-1", 1);

    expect(analysisHistoryStateForNavigation("push", "/platform-admin/resource-center/models")).toEqual({});
    expect(analysisHistoryStateForNavigation("push", "/platform-admin/runtime/runs")).toMatchObject({
      analysisWorkspace: { source: "/session/session-1", depth: 2 },
    });
  });

  it("关闭多层分析导航时一次返回来源页", () => {
    const go = vi.spyOn(window.history, "go").mockImplementation(() => undefined);
    const fallback = vi.fn();
    markAnalysisHistoryEntry("/session/session-1", 3);

    closeAnalysisHistory(fallback);

    expect(go).toHaveBeenCalledWith(-3);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("带筛选的列表下钻详情再返回时不保留多余详情层", () => {
    const search = "?tenantId=acme&status=failed&hours=168";
    window.history.replaceState({}, "", `/platform-console/runtime/runs${search}`);
    markAnalysisHistoryEntry("/chat/session-1", 1);

    pushGovernanceUrl(governanceRoute("platform.runtime.runs", { entityId: "run-1", search }));
    expect(window.location.pathname).toBe("/platform-console/runtime/runs/run-1");
    expect(Object.fromEntries(new URLSearchParams(window.location.search))).toEqual({
      hours: "168",
      status: "failed",
      tenantId: "acme",
    });
    expect(readAnalysisHistoryState()?.depth).toBe(2);

    replaceGovernanceUrl(governanceRoute("platform.runtime.runs", { search }));
    expect(window.location.pathname).toBe("/platform-console/runtime/runs");
    expect(Object.fromEntries(new URLSearchParams(window.location.search))).toEqual({
      hours: "168",
      status: "failed",
      tenantId: "acme",
    });
    expect(readAnalysisHistoryState()?.depth).toBe(2);

    const go = vi.spyOn(window.history, "go").mockImplementation(() => undefined);
    closeAnalysisHistory(vi.fn());
    expect(go).toHaveBeenCalledWith(-2);
  });

  it("直接打开分析 URL 时补建可一次关闭的来源条目", () => {
    window.history.replaceState({}, "", "/platform-console/overview/overview");

    expect(ensureAnalysisHistoryEntry("/session/session-1")).toBe(true);
    expect(window.location.pathname).toBe("/platform-console/overview/overview");
    expect(readAnalysisHistoryState()).toEqual({ source: "/session/session-1", depth: 1 });
    expect(ensureAnalysisHistoryEntry("/session/session-2")).toBe(false);
  });

  it("缺少历史标记时使用显式回退", () => {
    const fallback = vi.fn();

    closeAnalysisHistory(fallback);

    expect(fallback).toHaveBeenCalledOnce();
  });
});

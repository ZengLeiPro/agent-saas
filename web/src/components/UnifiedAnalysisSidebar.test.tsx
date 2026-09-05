import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ManagementSettingsAccess } from "@/hooks/useManagementSettingsAccess";
import { governanceRoute } from "@/lib/governanceNavigation";
import { UnifiedAnalysisSidebar } from "./UnifiedAnalysisSidebar";

function access(tenantEntryAllowed: boolean, platformEntryAllowed: boolean): ManagementSettingsAccess {
  return { status: "ready", personalAllowed: true, tenantEntryAllowed, platformEntryAllowed, retry: vi.fn() };
}

function renderSidebar(currentAccess: ManagementSettingsAccess, routeId = "platform.runtime.runs") {
  const onNavigate = vi.fn();
  const onClose = vi.fn();
  render(
    <UnifiedAnalysisSidebar
      width={280}
      hidden={false}
      access={currentAccess}
      route={governanceRoute(routeId)}
      onNavigate={onNavigate}
      onClose={onClose}
      onResizeMouseDown={vi.fn()}
      onResizeDoubleClick={vi.fn()}
      footer={<div>footer</div>}
    />,
  );
  return { onNavigate, onClose };
}

describe("统一分析侧栏", () => {
  it("平台管理员按平台、组织顺序展示 9 + 4 个页面", () => {
    renderSidebar(access(true, true));

    const navigation = screen.getByLabelText("分析导航");
    expect(screen.getByText("平台分析")).toBeTruthy();
    expect(screen.getByText("组织分析")).toBeTruthy();
    expect(navigation.querySelectorAll("button")).toHaveLength(13);
    expect(navigation.textContent?.indexOf("平台分析")).toBeLessThan(navigation.textContent?.indexOf("组织分析") ?? 0);
    expect(screen.getByRole("button", { name: "运行追踪" }).getAttribute("aria-current")).toBe("page");
  });

  it("组织管理员只展示组织分析并可切换页面", () => {
    const { onNavigate } = renderSidebar(access(true, false), "organization.overview.overview");

    expect(screen.queryByText("平台分析")).toBeNull();
    expect(screen.getByText("组织分析")).toBeTruthy();
    expect(screen.getByLabelText("分析导航").querySelectorAll("button")).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: "用量与成本" }));
    expect(onNavigate).toHaveBeenCalledWith("organization.governance.usage");
  });

  it("返回按钮关闭分析工作区", () => {
    const { onClose } = renderSidebar(access(true, true));

    fireEvent.click(screen.getByRole("button", { name: "返回主界面" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

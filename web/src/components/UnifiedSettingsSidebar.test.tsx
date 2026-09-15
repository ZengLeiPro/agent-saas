import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ManagementSettingsAccess } from "@/hooks/useManagementSettingsAccess";
import { SETTINGS_SIDEBAR_WIDTH } from "@/components/SettingsCenter/settingsLayout";
import { UnifiedSettingsSidebar } from "./UnifiedSettingsSidebar";

function access(
  status: ManagementSettingsAccess["status"] = "ready",
  tenantEntryAllowed = false,
  platformEntryAllowed = false,
): ManagementSettingsAccess {
  return { status, personalAllowed: true, tenantEntryAllowed, platformEntryAllowed, retry: vi.fn() };
}

function renderSidebar(currentAccess: ManagementSettingsAccess) {
  return render(
    <UnifiedSettingsSidebar
      hidden={false}
      access={currentAccess}
      personalAgentEnabled
      target="personal"
      activeSection="account-security"
      onNavigate={vi.fn()}
      footer={<div>footer</div>}
    />,
  );
}

describe("UnifiedSettingsSidebar 权威管理分组", () => {
  it("无权时只显示个人设置，不显示组织和平台分组", () => {
    renderSidebar(access());

    expect(screen.getByText("个人设置")).toBeTruthy();
    expect(screen.queryByText("组织管理")).toBeNull();
    expect(screen.queryByText("平台运营")).toBeNull();
  });

  it("使用固定宽度、无任何收缩和拖拽入口，分组由横线隔开", () => {
    renderSidebar(access("ready", true, true));

    const navigation = screen.getByLabelText("设置导航");
    const sidebar = screen.getByTestId("unified-settings-sidebar");
    expect(sidebar.style.width).toBe(`${SETTINGS_SIDEBAR_WIDTH}px`);
    expect(sidebar.getAttribute("data-layout-width")).toBe(String(SETTINGS_SIDEBAR_WIDTH));
    expect(screen.queryByTitle("收起侧边栏")).toBeNull();
    expect(screen.queryByTitle(/拖动调整侧边栏宽度/)).toBeNull();
    expect(navigation.querySelector('[aria-expanded]')).toBeNull();
    expect(navigation.querySelector('svg.lucide-chevron-down')).toBeNull();
    expect(navigation.querySelectorAll("nav > div.border-t")).toHaveLength(3);
    const activeItem = navigation.querySelector('[aria-current="page"]');
    expect(activeItem?.className).toContain("bg-brand-accent-soft");
    expect(activeItem?.className).not.toContain("before:bg-brand-accent");
  });

  it("只按各自 snapshot allowed 显示管理分组", () => {
    const { rerender } = renderSidebar(access("ready", true, false));
    expect(screen.getAllByText("组织管理").length).toBeGreaterThan(0);
    expect(screen.queryByText("平台运营")).toBeNull();

    rerender(
      <UnifiedSettingsSidebar
        hidden={false}
        access={access("ready", false, true)}
        personalAgentEnabled
        target="personal"
        activeSection="account-security"
        onNavigate={vi.fn()}
        footer={<div>footer</div>}
      />,
    );
    expect(screen.queryByText("组织管理")).toBeNull();
    expect(screen.getByText("平台运营")).toBeTruthy();
  });

  it("个人设置页 snapshot error 显示明确重试入口", () => {
    const currentAccess = access("error");
    renderSidebar(currentAccess);

    expect(screen.getByText("管理权限验证失败")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /管理权限验证失败.*重试/ }));
    expect(currentAccess.retry).toHaveBeenCalledTimes(1);
  });

  it("个人设置页 loading 仅显示低调验证状态", () => {
    renderSidebar(access("loading"));

    expect(screen.getByRole("status").textContent).toContain("正在验证管理权限");
    expect(screen.queryByText("组织管理")).toBeNull();
    expect(screen.queryByText("平台运营")).toBeNull();
  });

  it("refreshing 保留旧 allow 分组并显示更新状态", () => {
    renderSidebar(access("refreshing", true, true));

    expect(screen.getByRole("status").textContent).toContain("正在更新管理权限");
    expect(screen.getAllByText("组织管理").length).toBeGreaterThan(0);
    expect(screen.getAllByText("平台运营").length).toBeGreaterThan(0);
  });

  it("平台权限允许时显示归并后的平台配置入口", () => {
    renderSidebar(access("ready", false, true));

    expect(screen.getByRole("button", { name: "访问控制" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "模板" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "业务系统" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "系统交付" })).toBeNull();
    expect(screen.getByLabelText("设置导航").querySelectorAll('button')).toHaveLength(21);
  });

  it("组织分组保留真实页面，组内不再用分隔线切碎", () => {
    renderSidebar(access("ready", true, false));

    for (const label of ["构建 · 调用资产", "运行", "治理 · 边界", "组织设置"]) {
      expect(screen.queryByText(label)).toBeNull();
    }
    expect(screen.getByLabelText("设置导航").querySelectorAll('[aria-hidden="true"].border-t')).toHaveLength(0);
    expect(screen.getByLabelText("设置导航").querySelectorAll('button')).toHaveLength(26);
    expect(screen.queryByRole("button", { name: "进入组织治理" })).toBeNull();
  });

  it("支持在授权范围内搜索，分组始终展开", () => {
    renderSidebar(access("ready", true, true));

    fireEvent.change(screen.getByRole("searchbox", { name: "搜索设置" }), { target: { value: "成员" } });
    expect(screen.getByRole("button", { name: "成员" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "网络出口" })).toBeNull();

    fireEvent.change(screen.getByRole("searchbox", { name: "搜索设置" }), { target: { value: "" } });
    expect(screen.getByText("平台运营").closest("button")).toBeNull();
    expect(screen.getByRole("button", { name: "网络出口" })).toBeTruthy();
  });
});

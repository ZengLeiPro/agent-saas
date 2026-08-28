import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ManagementSettingsAccess } from "@/hooks/useManagementSettingsAccess";
import { UnifiedSettingsSidebar } from "./UnifiedSettingsSidebar";

function access(
  status: ManagementSettingsAccess["status"] = "ready",
  tenantEntryAllowed = false,
  platformEntryAllowed = false,
): ManagementSettingsAccess {
  return { status, personalAllowed: true, tenantEntryAllowed, platformEntryAllowed, retry: vi.fn() };
}

function renderSidebar(currentAccess: ManagementSettingsAccess, onOpenOrganizationGovernance?: () => void) {
  return render(
    <UnifiedSettingsSidebar
      width={280}
      hidden={false}
      access={currentAccess}
      personalAgentEnabled
      target="personal"
      activeSection="account-security"
      onNavigate={vi.fn()}
      onOpenOrganizationGovernance={onOpenOrganizationGovernance}
      onResizeMouseDown={vi.fn()}
      onResizeDoubleClick={vi.fn()}
      footer={<div>footer</div>}
    />,
  );
}

describe("UnifiedSettingsSidebar 权威管理分组", () => {
  it("无权时只显示个人设置，不显示组织和平台分组", () => {
    renderSidebar(access());

    expect(screen.getByText("个人设置")).toBeTruthy();
    expect(screen.queryByText("组织管理")).toBeNull();
    expect(screen.queryByText("平台管理")).toBeNull();
  });

  it("分组间距清晰且激活项不显示左侧竖线", () => {
    renderSidebar(access("ready", true, true));

    const navigation = screen.getByLabelText("设置导航");
    expect(navigation.querySelector("nav")?.className).toContain("gap-6");
    const activeItem = navigation.querySelector('[aria-current="page"]');
    expect(activeItem?.className).toContain("bg-brand-accent-soft");
    expect(activeItem?.className).not.toContain("before:bg-brand-accent");
  });

  it("只按各自 snapshot allowed 显示管理分组", () => {
    const { rerender } = renderSidebar(access("ready", true, false));
    expect(screen.getAllByText("组织管理").length).toBeGreaterThan(0);
    expect(screen.queryByText("平台管理")).toBeNull();

    rerender(
      <UnifiedSettingsSidebar
        width={280}
        hidden={false}
        access={access("ready", false, true)}
        personalAgentEnabled
        target="personal"
        activeSection="account-security"
        onNavigate={vi.fn()}
        onResizeMouseDown={vi.fn()}
        onResizeDoubleClick={vi.fn()}
        footer={<div>footer</div>}
      />,
    );
    expect(screen.queryByText("组织管理")).toBeNull();
    expect(screen.getByText("平台管理")).toBeTruthy();
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
    expect(screen.queryByText("平台管理")).toBeNull();
  });

  it("refreshing 保留旧 allow 分组并显示更新状态", () => {
    renderSidebar(access("refreshing", true, true));

    expect(screen.getByRole("status").textContent).toContain("正在更新管理权限");
    expect(screen.getAllByText("组织管理").length).toBeGreaterThan(0);
    expect(screen.getAllByText("平台管理").length).toBeGreaterThan(0);
  });

  it("平台权限允许时显示三个补充管理入口", () => {
    renderSidebar(access("ready", false, true));

    expect(screen.getByRole("button", { name: "平台管理员" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "智能体模板" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "环境模板" })).toBeTruthy();
  });

  it("组织分组提供明确治理入口并触发独立回调", () => {
    const onOpenOrganizationGovernance = vi.fn();
    renderSidebar(access("ready", true, false), onOpenOrganizationGovernance);

    fireEvent.click(screen.getByRole("button", { name: "进入组织治理" }));
    expect(onOpenOrganizationGovernance).toHaveBeenCalledTimes(1);
  });
});

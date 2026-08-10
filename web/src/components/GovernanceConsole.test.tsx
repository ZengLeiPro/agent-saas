import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { governanceRoute } from "@/lib/governanceNavigation";
import { GovernanceConsole, getGovernanceUserMenuEntries } from "./GovernanceConsole";

const auth = vi.hoisted(() => ({
  user: { tenantId: "pantheon" },
  isPlatformAdmin: false,
}));
const tenantState = vi.hoisted(() => ({
  tenants: [
    { id: "pantheon", name: "Pantheon" },
    { id: "acme", name: "Acme" },
  ],
}));

vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => auth }));
vi.mock("@/components/TenantManager/hooks", () => ({ useTenants: () => tenantState }));

beforeEach(() => {
  auth.isPlatformAdmin = false;
  window.history.replaceState({}, "", "/");
});

describe("GovernanceConsole", () => {
  it("平台壳层侧栏只展示五个工作区，页头只展示当前工作区本地叶子，并承载既有内容", () => {
    render(
      <GovernanceConsole
        area="platform"
        route={governanceRoute("platform.runtime.runs")}
        onExit={() => undefined}
      >
        <div>复用 RunTraceExplorer 内容</div>
      </GovernanceConsole>,
    );

    const workspaceNav = screen.getByRole("navigation", { name: "平台控制台工作区" });
    expect(workspaceNav.querySelectorAll("button")).toHaveLength(5);
    expect(workspaceNav.textContent).toContain("总览");
    expect(workspaceNav.textContent).toContain("组织与商业");
    expect(workspaceNav.textContent).toContain("资源中心");
    expect(workspaceNav.textContent).toContain("运行与可观测");
    expect(workspaceNav.textContent).toContain("治理与系统");

    const localNav = screen.getByRole("navigation", { name: "运行与可观测本地导航" });
    expect(localNav.textContent).toContain("Run");
    expect(localNav.textContent).toContain("Session");
    expect(localNav.textContent).not.toContain("组织");
    expect(screen.getByText("复用 RunTraceExplorer 内容")).toBeTruthy();
  });

  it("平台管理员进入组织作用域显示常驻 banner，并从切换器过滤 pantheon", async () => {
    auth.isPlatformAdmin = true;
    window.history.replaceState({}, "", "/tenant-admin/overview?org=acme");
    render(
      <GovernanceConsole
        area="organization"
        route={governanceRoute("organization.overview.overview", { orgId: "acme" })}
        onExit={() => undefined}
      >
        <div>组织概览</div>
      </GovernanceConsole>,
    );

    expect(screen.getByText("正在以平台管理员身份管理：Acme")).toBeTruthy();
    const switcher = screen.getByRole("combobox", { name: "切换组织" });
    expect(switcher.textContent).toContain("Acme");
    expect(document.body.textContent).not.toContain("Pantheon");
    await waitFor(() => expect(window.location.search).toBe("?org=acme"));
  });
});

describe("治理用户菜单", () => {
  it("平台管理员只有个人设置、组织控制台、平台控制台三个稳定入口", () => {
    expect(getGovernanceUserMenuEntries({ isAdmin: true, isPlatformAdmin: true })).toEqual([
      { id: "settings", label: "个人设置" },
      { id: "organization", label: "组织控制台" },
      { id: "platform", label: "平台控制台" },
    ]);
  });

  it("普通成员只显示个人设置", () => {
    expect(getGovernanceUserMenuEntries({ isAdmin: false, isPlatformAdmin: false })).toEqual([
      { id: "settings", label: "个人设置" },
    ]);
  });
});

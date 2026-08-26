import { useEffect, useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import desktopLayoutSource from "@/layouts/DesktopLayout.tsx?raw";
import mobileLayoutSource from "@/layouts/MobileLayout.tsx?raw";
import type { ManagementSettingsAccess } from "@/hooks/useManagementSettingsAccess";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ManagementSettingsAccessGate } from "./ManagementSettingsAccessGate";

function access(
  status: ManagementSettingsAccess["status"],
  allowed = false,
): ManagementSettingsAccess {
  return {
    status,
    personalAllowed: true,
    tenantEntryAllowed: allowed,
    platformEntryAllowed: allowed,
    retry: vi.fn(),
  };
}

function renderGate(currentAccess: ManagementSettingsAccess, scope: "tenant" | "platform" = "tenant") {
  const onRetry = vi.fn();
  const onReturnPersonal = vi.fn();
  render(
    <ManagementSettingsAccessGate
      scope={scope}
      target={scope}
      access={currentAccess}
      onRetry={onRetry}
      onReturnPersonal={onReturnPersonal}
    >
      <div data-testid="management-content">真实管理内容</div>
    </ManagementSettingsAccessGate>,
  );
  return { onRetry, onReturnPersonal };
}

describe("ManagementSettingsAccessGate", () => {
  it.each([
    ["loading", "组织管理权限加载中"],
    ["ready", "当前账号无权访问"],
    ["error", "无法验证权限"],
  ] as const)("%s 状态不挂载管理内容并可返回个人设置", (status, message) => {
    const { onReturnPersonal } = renderGate(access(status));

    expect(screen.queryByTestId("management-content")).toBeNull();
    expect(screen.getByText(message)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "返回个人设置" }));
    expect(onReturnPersonal).toHaveBeenCalledTimes(1);
  });

  it("error 状态可重试", () => {
    const { onRetry } = renderGate(access("error"), "platform");

    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it.each(["loading", "ready", "error"] as const)("治理 canonical 在 %s 时不 mount Console 或管理 Shell", (status) => {
    const shell = vi.fn(() => <div data-testid="management-shell" />);
    const consoleView = vi.fn(() => {
      const Shell = shell;
      return <div data-testid="governance-console"><Shell /></div>;
    });
    const ConsoleView = consoleView;
    render(
      <ManagementSettingsAccessGate scope="tenant" target="tenant" access={access(status)} onRetry={vi.fn()} onReturnPersonal={vi.fn()}>
        <ConsoleView />
      </ManagementSettingsAccessGate>,
    );

    expect(consoleView).not.toHaveBeenCalled();
    expect(shell).not.toHaveBeenCalled();
    expect(screen.queryByTestId("governance-console")).toBeNull();
    expect(screen.queryByTestId("management-shell")).toBeNull();
  });

  it("ready allow 后才挂载真实管理内容", () => {
    renderGate(access("ready", true), "platform");

    expect(screen.getByTestId("management-content")).toBeTruthy();
    expect(screen.queryByText("当前账号无权访问")).toBeNull();
  });

  it("非当前 scope 不挂载内容或状态", () => {
    render(
      <ManagementSettingsAccessGate
        scope="tenant"
        target="personal"
        access={access("ready", true)}
        onRetry={vi.fn()}
        onReturnPersonal={vi.fn()}
      >
        <div data-testid="management-content" />
      </ManagementSettingsAccessGate>,
    );

    expect(screen.queryByTestId("management-content")).toBeNull();
    expect(screen.queryByTestId(/management-settings-/)).toBeNull();
  });

  it("refreshing allow 保持 child mount 并用全覆盖遮罩阻止交互", () => {
    const mounted = vi.fn();
    const unmounted = vi.fn();
    function TrackedChild() {
      useEffect(() => { mounted(); return unmounted; }, []);
      return <div data-testid="management-content" />;
    }
    const { rerender } = render(
      <ManagementSettingsAccessGate scope="tenant" target="tenant" access={access("ready", true)} onRetry={vi.fn()} onReturnPersonal={vi.fn()}>
        <TrackedChild />
      </ManagementSettingsAccessGate>,
    );
    expect(mounted).toHaveBeenCalledTimes(1);

    rerender(
      <ManagementSettingsAccessGate scope="tenant" target="tenant" access={access("refreshing", true)} onRetry={vi.fn()} onReturnPersonal={vi.fn()}>
        <TrackedChild />
      </ManagementSettingsAccessGate>,
    );
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(unmounted).not.toHaveBeenCalled();
    const content = screen.getByTestId("management-content");
    expect(content.parentElement?.hasAttribute("inert")).toBe(true);
    expect(screen.getByTestId("management-settings-refreshing").className).toContain("absolute inset-0");
  });

  it("持久 Gate 切 tenant→personal→tenant 不 remount，离开时 hidden/inert", () => {
    const mounted = vi.fn();
    const unmounted = vi.fn();
    function Draft() {
      useEffect(() => { mounted(); return unmounted; }, []);
      return <input data-testid="draft" defaultValue="未保存" />;
    }
    const gate = (target: "personal" | "tenant") => (
      <ManagementSettingsAccessGate persistAfterVisit scope="tenant" target={target} access={access("ready", true)} onRetry={vi.fn()} onReturnPersonal={vi.fn()}>
        <Draft />
      </ManagementSettingsAccessGate>
    );
    const { rerender } = render(gate("tenant"));
    expect(mounted).toHaveBeenCalledTimes(1);

    rerender(gate("personal"));
    const workspace = screen.getByTestId("management-settings-tenant-workspace");
    expect(workspace.className).toContain("hidden");
    expect(workspace.hasAttribute("inert")).toBe(true);
    expect(unmounted).not.toHaveBeenCalled();

    rerender(gate("tenant"));
    expect(mounted).toHaveBeenCalledTimes(1);
    expect((screen.getByTestId("draft") as HTMLInputElement).value).toBe("未保存");
  });

  it("持久 Gate 不预挂载未访问的 platform scope", () => {
    const mounted = vi.fn();
    function PlatformDraft() {
      useEffect(() => { mounted(); }, []);
      return <div data-testid="platform-draft" />;
    }
    const gate = (target: "personal" | "tenant" | "platform") => (
      <ManagementSettingsAccessGate persistAfterVisit scope="platform" target={target} access={access("ready", true)} onRetry={vi.fn()} onReturnPersonal={vi.fn()}>
        <PlatformDraft />
      </ManagementSettingsAccessGate>
    );
    const { rerender } = render(gate("personal"));
    rerender(gate("tenant"));
    expect(mounted).not.toHaveBeenCalled();
    expect(screen.queryByTestId("platform-draft")).toBeNull();

    rerender(gate("platform"));
    expect(mounted).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["deny", access("ready", false), "当前账号无权访问"],
    ["error", access("error", false), "无法验证权限"],
    ["context loading", access("loading", false), "组织管理权限加载中"],
  ])("refreshing 后 %s 立即 unmount child 并显示关闭状态", (_case, closedAccess, message) => {
    const unmounted = vi.fn();
    function Draft() {
      useEffect(() => () => unmounted(), []);
      return <div data-testid="management-content" />;
    }
    const { rerender } = render(
      <ManagementSettingsAccessGate persistAfterVisit scope="tenant" target="tenant" access={access("refreshing", true)} onRetry={vi.fn()} onReturnPersonal={vi.fn()}>
        <Draft />
      </ManagementSettingsAccessGate>,
    );
    expect(screen.getByTestId("management-content")).toBeTruthy();

    rerender(
      <ManagementSettingsAccessGate persistAfterVisit scope="tenant" target="tenant" access={closedAccess} onRetry={vi.fn()} onReturnPersonal={vi.fn()}>
        <Draft />
      </ManagementSettingsAccessGate>,
    );
    expect(screen.queryByTestId("management-content")).toBeNull();
    expect(unmounted).toHaveBeenCalledTimes(1);
    expect(screen.getByText(message)).toBeTruthy();
  });

  it("真实 Dialog 随持久 workspace 隐藏/刷新且恢复后释放副作用并保留状态", async () => {
    const mounted = vi.fn();
    const unmounted = vi.fn();
    function DialogWorkspace() {
      const [draft, setDraft] = useState("未保存");
      useEffect(() => { mounted(); return unmounted; }, []);
      return (
        <Dialog defaultOpen>
          <DialogContent data-testid="draft-dialog">
            <DialogTitle>编辑草稿</DialogTitle>
            <DialogDescription>验证管理工作区内的弹窗状态。</DialogDescription>
            <input data-testid="dialog-draft" value={draft} onChange={(event) => setDraft(event.target.value)} />
          </DialogContent>
        </Dialog>
      );
    }
    const gate = (target: "personal" | "tenant", status: ManagementSettingsAccess["status"] = "ready") => (
      <>
        <button data-testid="outside-dialog">外部操作</button>
        <ManagementSettingsAccessGate persistAfterVisit scope="tenant" target={target} access={access(status, true)} onRetry={vi.fn()} onReturnPersonal={vi.fn()}>
          <DialogWorkspace />
        </ManagementSettingsAccessGate>
      </>
    );
    const { rerender } = render(gate("tenant"));
    const dialog = screen.getByTestId("draft-dialog");
    const draft = screen.getByTestId("dialog-draft") as HTMLInputElement;
    const portalContainer = screen.getByTestId("management-settings-tenant-portal-container");
    expect(portalContainer.contains(dialog)).toBe(true);
    expect(mounted).toHaveBeenCalledTimes(1);
    fireEvent.change(draft, { target: { value: "保留此值" } });
    await waitFor(() => expect(document.body.style.pointerEvents).toBe("none"));

    rerender(gate("personal"));
    const workspace = screen.getByTestId("management-settings-tenant-workspace");
    expect(workspace.className).toContain("hidden");
    expect(workspace.contains(screen.getByTestId("draft-dialog"))).toBe(true);
    expect(unmounted).not.toHaveBeenCalled();
    await waitFor(() => expect(document.body.style.pointerEvents).toBe(""));
    screen.getByTestId("outside-dialog").focus();
    expect(document.activeElement).toBe(screen.getByTestId("outside-dialog"));

    rerender(gate("tenant", "refreshing"));
    expect(portalContainer.parentElement?.hasAttribute("inert")).toBe(true);
    const refreshing = screen.getByTestId("management-settings-refreshing");
    expect(refreshing.className).toContain("z-[200]");
    expect(refreshing.closest("[inert]")).toBeNull();
    expect(screen.getByTestId("draft-dialog")).toBeTruthy();
    await waitFor(() => expect(document.body.style.pointerEvents).toBe(""));

    rerender(gate("tenant"));
    expect(screen.getByTestId("dialog-draft")).toHaveProperty("value", "保留此值");
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(unmounted).not.toHaveBeenCalled();
    await waitFor(() => expect(document.body.style.pointerEvents).toBe("none"));
  });

  it("两个持久管理 Gate 反复切换时保持 Portal 稳定且不触发嵌套更新", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    function Workspace({ scope }: { scope: "tenant" | "platform" }) {
      return (
        <Dialog defaultOpen>
          <DialogContent data-testid={`${scope}-dialog`}>
            <DialogTitle>{scope} 管理</DialogTitle>
            <DialogDescription>验证 React 19 下管理工作区切换不会形成 ref 更新循环。</DialogDescription>
          </DialogContent>
        </Dialog>
      );
    }
    const gates = (target: "tenant" | "platform") => (
      <>
        <ManagementSettingsAccessGate persistAfterVisit scope="tenant" target={target} access={access("ready", true)} onRetry={vi.fn()} onReturnPersonal={vi.fn()}>
          <Workspace scope="tenant" />
        </ManagementSettingsAccessGate>
        <ManagementSettingsAccessGate persistAfterVisit scope="platform" target={target} access={access("ready", true)} onRetry={vi.fn()} onReturnPersonal={vi.fn()}>
          <Workspace scope="platform" />
        </ManagementSettingsAccessGate>
      </>
    );

    const { rerender } = render(gates("tenant"));
    for (let index = 0; index < 20; index += 1) {
      rerender(gates(index % 2 === 0 ? "platform" : "tenant"));
    }

    const tenantPortal = screen.getByTestId("management-settings-tenant-portal-container");
    const platformPortal = screen.getByTestId("management-settings-platform-portal-container");
    expect(tenantPortal.contains(screen.getByTestId("tenant-dialog"))).toBe(true);
    expect(platformPortal.contains(screen.getByTestId("platform-dialog"))).toBe(true);
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("非持久 Gate refreshing 也把 Dialog 放进 inert 边界并由遮罩覆盖", () => {
    render(
      <ManagementSettingsAccessGate scope="platform" target="platform" access={access("refreshing", true)} onRetry={vi.fn()} onReturnPersonal={vi.fn()}>
        <Dialog defaultOpen>
          <DialogContent data-testid="refreshing-dialog">
            <DialogTitle>刷新中的弹窗</DialogTitle>
            <DialogDescription>验证非持久 Gate 的 Portal 边界。</DialogDescription>
          </DialogContent>
        </Dialog>
      </ManagementSettingsAccessGate>,
    );

    const dialog = screen.getByTestId("refreshing-dialog");
    const portalContainer = screen.getByTestId("management-settings-platform-portal-container");
    expect(portalContainer.contains(dialog)).toBe(true);
    expect(dialog.closest("[inert]")).toBe(portalContainer.parentElement);
    expect(screen.getByTestId("management-settings-refreshing").className).toContain("z-[200]");
  });

  it("Gate 外普通页面 Dialog 仍默认 portal 到 body", () => {
    render(
      <Dialog defaultOpen>
        <DialogContent data-testid="ordinary-dialog">
          <DialogTitle>普通弹窗</DialogTitle>
          <DialogDescription>验证默认 Portal 容器。</DialogDescription>
        </DialogContent>
      </Dialog>,
    );

    expect(screen.getByTestId("ordinary-dialog").parentElement).toBe(document.body);
  });

  it("仅桌面统一设置的两个 Gate 启用访问后持久挂载", () => {
    expect(desktopLayoutSource.match(/\bpersistAfterVisit\b/g)).toHaveLength(2);
    expect(mobileLayoutSource).not.toContain("persistAfterVisit");
  });
});

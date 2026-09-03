import type { ComponentType } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SettingsDirtyBoundary } from "@/components/PersonalSettings/dirtyRegistry";
import type { ManagementSettingsAccess } from "@/hooks/useManagementSettingsAccess";
import { TenantAdminShell } from "./AdminShells";
import { CompanyInfoSection } from "./CompanyInfoEditor";
import { TenantInstructionsSection } from "./TenantInstructionsEditor";
import { UnifiedSettingsSidebar } from "./UnifiedSettingsSidebar";

const mocks = vi.hoisted(() => ({
  auth: {
    user: { tenantId: "acme" },
    isAdmin: true as boolean,
    isPlatformAdmin: false as boolean,
    canPlatform: (() => false) as () => boolean,
  },
  fetchCompanyInfo: vi.fn(),
  updateCompanyInfo: vi.fn(),
  fetchInstructions: vi.fn(),
  updateInstructions: vi.fn(),
}));

vi.mock("@agent/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agent/shared")>();
  return {
    ...actual,
    fetchTenantCompanyInfo: mocks.fetchCompanyInfo,
    updateTenantCompanyInfo: mocks.updateCompanyInfo,
    fetchTenantInstructions: mocks.fetchInstructions,
    updateTenantInstructions: mocks.updateInstructions,
  };
});

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => mocks.auth,
}));

vi.mock("@/components/TenantManager/hooks", () => ({
  useTenants: () => ({
    tenants: [
      { id: "pantheon", name: "万神殿" },
      { id: "acme", name: "Acme" },
      { id: "beta", name: "Beta" },
    ],
    loading: false,
  }),
}));

const access: ManagementSettingsAccess = {
  status: "ready",
  personalAllowed: true,
  tenantEntryAllowed: true,
  platformEntryAllowed: false,
  retry: vi.fn(),
};

type EditorProps = { tenantId: string; tenantName?: string };

function renderEditor(Editor: ComponentType<EditorProps>, _activeSection: "company" | "instructions") {
  const onClose = vi.fn();
  const onSwitchLeaf = vi.fn();
  render(
    <SettingsDirtyBoundary>
      {({ requestNavigation }) => (
        <>
          <Editor tenantId="acme" tenantName="Acme" />
          <UnifiedSettingsSidebar
            width={280}
            hidden={false}
            access={access}
            personalAgentEnabled
            target="tenant"
            activeSection="settings"
            onNavigate={(_target, section) => requestNavigation(() => onSwitchLeaf(section))}
            onClose={() => requestNavigation(onClose)}
            onResizeMouseDown={vi.fn()}
            onResizeDoubleClick={vi.fn()}
            footer={<div />}
          />
        </>
      )}
    </SettingsDirtyBoundary>,
  );
  return { onClose, onSwitchLeaf };
}

async function startEditing(nextContent: string) {
  fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: nextContent } });
  return input as HTMLTextAreaElement;
}

describe("组织文本编辑器未保存导航保护", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/tenant-admin/settings/company?org=acme");
    mocks.auth = {
      user: { tenantId: "acme" },
      isAdmin: true,
      isPlatformAdmin: false,
      canPlatform: () => false,
    };
    mocks.fetchCompanyInfo.mockReset().mockResolvedValue("公司信息基线");
    mocks.updateCompanyInfo.mockReset().mockResolvedValue(undefined);
    mocks.fetchInstructions.mockReset().mockResolvedValue("自定义规则基线");
    mocks.updateInstructions.mockReset().mockResolvedValue(undefined);
  });

  it.each([
    ["公司信息", CompanyInfoSection, "company" as const, "公司信息草稿", mocks.updateCompanyInfo],
    ["自定义规则", TenantInstructionsSection, "instructions" as const, "自定义规则草稿", mocks.updateInstructions],
  ])("%s 修改后切换组织分类可取消或放弃", async (_label, Editor, activeSection, draft, update) => {
    const { onSwitchLeaf } = renderEditor(Editor, activeSection);
    const input = await startEditing(draft);

    fireEvent.click(screen.getByRole("button", { name: "成员" }));
    expect(await screen.findByText("有未保存的更改")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onSwitchLeaf).not.toHaveBeenCalled();
    expect(input.value).toBe(draft);

    fireEvent.click(screen.getByRole("button", { name: "成员" }));
    fireEvent.click(await screen.findByRole("button", { name: "放弃更改" }));
    await waitFor(() => expect(onSwitchLeaf).toHaveBeenCalledWith("org-members"));
    expect(update).not.toHaveBeenCalled();
    expect(screen.getByText(activeSection === "company" ? "公司信息基线" : "自定义规则基线")).toBeTruthy();
  });

  it("公司信息草稿保存成功后才关闭设置", async () => {
    const { onClose } = renderEditor(CompanyInfoSection, "company");
    await startEditing("保存后的公司信息");

    fireEvent.click(screen.getByRole("button", { name: "返回主界面" }));
    fireEvent.click(await screen.findByRole("button", { name: "保存并继续" }));

    await waitFor(() => expect(mocks.updateCompanyInfo).toHaveBeenCalledWith("acme", "保存后的公司信息"));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("自定义规则保存失败时阻止切叶并保留草稿", async () => {
    mocks.updateInstructions.mockRejectedValueOnce(new Error("规则保存失败"));
    const { onSwitchLeaf } = renderEditor(TenantInstructionsSection, "instructions");
    const input = await startEditing("不能丢失的规则草稿");

    fireEvent.click(screen.getByRole("button", { name: "成员" }));
    fireEvent.click(await screen.findByRole("button", { name: "保存并继续" }));

    expect(await screen.findByText("保存失败: 规则保存失败")).toBeTruthy();
    expect(onSwitchLeaf).not.toHaveBeenCalled();
    expect(input.value).toBe("不能丢失的规则草稿");
    expect(screen.getByText("有未保存的更改")).toBeTruthy();
  });

  it("平台管理员切换组织时也经过真实 Shell 的未保存导航保护", async () => {
    mocks.auth = {
      user: { tenantId: "pantheon" },
      isAdmin: true,
      isPlatformAdmin: true,
      canPlatform: () => true,
    };
    render(
      <SettingsDirtyBoundary>
        {(dirtyController) => (
          <TenantAdminShell
            renderUsers={() => <div />}
            renderSkills={() => <div />}
            renderMcp={() => <div />}
            renderUsage={() => <div />}
            renderFiles={() => <div />}
            renderCompanyInfo={(tenantId, tenantName) => <CompanyInfoSection tenantId={tenantId} tenantName={tenantName} />}
            settingsOpen
            settingsContentOnly
            settingsSection="company"
            onSettingsSectionChange={() => undefined}
            onSettingsClose={() => undefined}
            dirtyController={dirtyController}
          />
        )}
      </SettingsDirtyBoundary>,
    );
    const input = await startEditing("切换组织前的公司信息草稿");

    await userEvent.click(screen.getByRole("combobox", { name: "切换组织管理目标" }));
    await userEvent.click(screen.getByRole("option", { name: "Beta" }));
    expect(await screen.findByText("有未保存的更改")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(window.location.search).toBe("?org=acme");
    expect(input.value).toBe("切换组织前的公司信息草稿");

    await userEvent.click(screen.getByRole("combobox", { name: "切换组织管理目标" }));
    await userEvent.click(screen.getByRole("option", { name: "Beta" }));
    fireEvent.click(await screen.findByRole("button", { name: "放弃更改" }));
    await waitFor(() => expect(window.location.search).toBe("?org=beta"));
  });
});

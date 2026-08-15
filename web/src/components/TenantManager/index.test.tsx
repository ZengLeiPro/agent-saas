import { useState, type ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { memoryFeatureStatusLabel, saveTenantModelScope, TenantListPanel, TenantModelPolicyPanel } from "./index";
import { DEFAULT_TENANT_SETTINGS, type Tenant, type UserInfo } from "./types";

const apiMocks = vi.hoisted(() => ({
  authFetch: vi.fn(),
  getEntitlements: vi.fn(),
  previewEntitlementScope: vi.fn(),
  updateEntitlementScope: vi.fn(),
}));

vi.mock("@/lib/authFetch", () => ({ authFetch: apiMocks.authFetch }));
vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ canPlatform: () => true }),
}));
vi.mock("@agent/shared/lib/governanceApi", () => ({
  governanceAccessApi: apiMocks,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

const tenants: Tenant[] = [
  { id: "pantheon", name: "万神殿", createdAt: "2026-07-01T01:00:00.000Z", createdBy: "system", updatedAt: "2026-07-01T01:00:00.000Z" },
  { id: "wain", name: "唯恩电气", createdAt: "2026-07-02T01:00:00.000Z", createdBy: "admin", updatedAt: "2026-07-03T01:00:00.000Z" },
  { id: "acme", name: "阿康", createdAt: "2026-07-04T01:00:00.000Z", createdBy: "admin", updatedAt: "2026-07-05T01:00:00.000Z", disabled: true },
];

function ModelPolicyHarness({ tenant }: { tenant: Tenant }) {
  const [actions, setActions] = useState<ReactNode | null>(null);
  return (
    <>
      <div>{actions}</div>
      <TenantModelPolicyPanel tenant={tenant} onActionsChange={setActions} />
    </>
  );
}

function Harness({ onReorder }: { onReorder: (ids: string[]) => Promise<void> }) {
  const [actions, setActions] = useState<ReactNode | null>(null);
  const usersByTenant = new Map<string, UserInfo[]>([
    ["wain", [{} as UserInfo, {} as UserInfo]],
  ]);
  return (
    <>
      <div>{actions}</div>
      <TenantListPanel
        tenants={tenants}
        usersByTenant={usersByTenant}
        canReorder
        platformReadOnly={false}
        onReorder={onReorder}
        onToggleDisabled={vi.fn()}
        onDelete={vi.fn()}
        onActionsChange={setActions}
      />
    </>
  );
}

describe("TenantListPanel", () => {
  it("展示单行组织表格、成员数与状态操作", () => {
    render(<Harness onReorder={vi.fn(async () => undefined)} />);

    expect(screen.getByRole("columnheader", { name: "组织名称" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Slug" })).toBeTruthy();
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    expect(rows.every(row => row.className.includes("whitespace-nowrap"))).toBe(true);
    expect(within(rows[1]!).getByText("2")).toBeTruthy();
    expect(within(rows[2]!).getByText("已禁用")).toBeTruthy();
    expect(within(rows[0]!).getByRole("button", { name: "删除" }).hasAttribute("disabled")).toBe(true);
  });

  it("支持键盘调整顺序并把完整顺序交给保存接口", async () => {
    const onReorder = vi.fn(async () => undefined);
    render(<Harness onReorder={onReorder} />);

    fireEvent.keyDown(screen.getByRole("button", { name: "调整组织 唯恩电气 的顺序" }), { key: "ArrowUp" });
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows.map(row => within(row).getAllByRole("cell")[1]?.textContent)).toEqual(["唯恩电气", "万神殿", "阿康"]);
    expect(screen.getByText("排序未保存")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保存排序" }));
    });
    expect(onReorder).toHaveBeenCalledWith(["wain", "pantheon", "acme"]);
  });
});

describe("TenantModelPolicyPanel", () => {
  it("只通过治理 Scope 保存可用模型，非 Scope 策略只读", async () => {
    apiMocks.authFetch.mockImplementation(async (path: string) => ({
      ok: true,
      json: async () => path.endsWith("/settings")
        ? {
            settings: {
              ...structuredClone(DEFAULT_TENANT_SETTINGS),
              models: { ...structuredClone(DEFAULT_TENANT_SETTINGS.models), defaultModel: "group-a/model-1" },
            },
          }
        : {
            publicModelList: {
              groups: [{
                id: "group-a",
                name: "A 组",
                models: [
                  { id: "model-1", name: "模型一" },
                  { id: "model-2", name: "模型二" },
                ],
              }],
            },
          },
    }));
    apiMocks.getEntitlements.mockResolvedValue({
      scopes: [{ resourceType: "model", mode: "selected", resourceIds: ["group-a/model-1", "group-a/model-2"], version: 7 }],
    });
    apiMocks.previewEntitlementScope.mockResolvedValue({
      previewId: `gpv1.${"a".repeat(64)}`,
      baselineDigest: "b".repeat(64),
      expiresAt: "2099-08-13T16:00:00.000Z",
      impact: { nextVersion: 8, blockers: [] },
    });
    apiMocks.updateEntitlementScope.mockResolvedValue({ changeId: "change-1" });

    render(<ModelPolicyHarness tenant={tenants[1]!} />);

    expect(await screen.findByRole("button", { name: "保存可用模型" })).toBeTruthy();
    const selects = screen.getAllByRole("combobox");
    expect(selects[0]!.hasAttribute("disabled")).toBe(false);
    expect(selects[1]!.hasAttribute("disabled")).toBe(true);
    expect(screen.getByPlaceholderText("模型一").hasAttribute("disabled")).toBe(true);

    const editableModels = screen.getAllByRole("checkbox").filter(input => !input.hasAttribute("disabled"));
    expect(editableModels).toHaveLength(2);
    fireEvent.click(editableModels[0]!);
    expect((selects[1] as HTMLSelectElement).value).toBe("group-a/model-1");
    fireEvent.click(screen.getByRole("button", { name: "保存可用模型" }));

    await waitFor(() => expect(apiMocks.updateEntitlementScope).toHaveBeenCalled());
    expect(apiMocks.authFetch).not.toHaveBeenCalledWith(
      expect.stringContaining("/settings"),
      expect.objectContaining({ method: "PATCH" }),
    );
  });
});

describe("saveTenantModelScope", () => {
  it("通过治理预览和提交保存组织可用模型", async () => {
    apiMocks.previewEntitlementScope.mockResolvedValue({
      previewId: `gpv1.${"a".repeat(64)}`,
      baselineDigest: "b".repeat(64),
      expiresAt: "2099-08-13T16:00:00.000Z",
      impact: { nextVersion: 8, blockers: [] },
    });
    apiMocks.updateEntitlementScope.mockResolvedValue({ changeId: "change-1" });

    await expect(saveTenantModelScope("tenant-a", 7, ["group-b/model-2", "group-a/model-1", "group-a/model-1"]))
      .resolves.toBe(8);

    const command = {
      expectedVersion: 7,
      mode: "selected",
      resourceIds: ["group-a/model-1", "group-b/model-2"],
    };
    expect(apiMocks.previewEntitlementScope).toHaveBeenCalledWith("model", command, "tenant-a");
    expect(apiMocks.updateEntitlementScope).toHaveBeenCalledWith("model", {
      ...command,
      previewId: `gpv1.${"a".repeat(64)}`,
      baselineDigest: "b".repeat(64),
      expiresAt: "2099-08-13T16:00:00.000Z",
    }, "tenant-a");
  });

  it("继承平台范围使用 all，治理阻断时不提交", async () => {
    apiMocks.previewEntitlementScope.mockResolvedValue({
      previewId: `gpv1.${"c".repeat(64)}`,
      baselineDigest: "d".repeat(64),
      expiresAt: "2099-08-13T16:00:00.000Z",
      impact: { nextVersion: 3, blockers: ["MODEL_IN_USE"] },
    });

    await expect(saveTenantModelScope("tenant-a", 2, [])).rejects.toThrow("MODEL_IN_USE");
    expect(apiMocks.previewEntitlementScope).toHaveBeenCalledWith("model", {
      expectedVersion: 2,
      mode: "all",
      resourceIds: [],
    }, "tenant-a");
    expect(apiMocks.updateEntitlementScope).not.toHaveBeenCalled();
  });
});

describe("memoryFeatureStatusLabel", () => {
  it("明确区分租户已开但平台总开关关闭", () => {
    expect(memoryFeatureStatusLabel({
      configured: true,
      effective: false,
      blockedBy: "platform_disabled",
    }, true)).toBe("租户已开 · 未生效：平台总开关关闭");
  });

  it("实际生效与未保存改动使用不同文案", () => {
    expect(memoryFeatureStatusLabel({ configured: true, effective: true }, true))
      .toBe("租户已开 · 实际生效");
    expect(memoryFeatureStatusLabel({ configured: true, effective: true }, false))
      .toBe("待保存");
  });
});

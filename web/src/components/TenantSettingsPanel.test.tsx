import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TenantSettingsPanel } from "./TenantSettingsPanel";
import type { ModelList } from "@/types/models";
import { DEFAULT_TENANT_ID } from "./TenantManager/types";

const mocks = vi.hoisted(() => ({
  authFetch: vi.fn(),
  getTenantSettings: vi.fn(),
  updateTenantSettings: vi.fn(),
  refreshAll: vi.fn(),
  updateTenantFeatures: vi.fn(),
}));

vi.mock("@/lib/authFetch", () => ({ authFetch: mocks.authFetch }));
vi.mock("@/lib/refreshBus", () => ({ refreshAll: mocks.refreshAll }));
vi.mock("@agent/shared/lib/governanceApi", () => ({
  governanceAccessApi: {
    getTenantSettings: mocks.getTenantSettings,
    updateTenantSettings: mocks.updateTenantSettings,
  },
}));
vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    user: { tenantId: "tenant-a" },
    isPlatformAdmin: false,
    canPlatform: () => true,
    updateTenantFeatures: mocks.updateTenantFeatures,
  }),
}));

const modelList: ModelList = {
  default: "openai-agents/doubao",
  allowCrossGroupSwitch: false,
  showGroupNames: true,
  showContextTokens: true,
  allowContextTokenDetails: false,
  groups: [
    {
      id: "openai-agents",
      name: "OpenAI Agents",
      originalName: "OpenAI Agents",
      models: [
        { id: "doubao", name: "Doubao Pro", originalName: "Doubao Pro" },
        { id: "kimi", name: "Kimi 2.6", originalName: "Kimi 2.6" },
      ],
    },
  ],
};

const baseSettings = {
  features: {
    filesEnabled: true,
    cronEnabled: true,
    mcpEnabled: true,
    customSkillsEnabled: true,
    debugModeAllowed: false,
    debugModeEnabled: false,
    autoCompactEnabled: false,
    memoryPollingEnabled: false,
    memoryPollChargesCredits: false,
    memoryConsolidationEnabled: false,
    memoryWriteDelegationEnabled: false,
    imageGenEnabled: false,
  },
  quotas: {},
  models: {
    allowedModels: [],
    allowUserModelSwitch: true,
    showGroupNames: true,
    showContextTokens: true,
    allowContextTokenDetails: false,
    displayOverrides: {} as Record<string, unknown>,
  },
  mcp: {
    allowTenantServers: true,
    allowGlobalServers: true,
    defaultEnabledServerIds: [],
  },
  branding: {},
  personalization: { firstDayGuideBarEnabled: false },
  security: { requireDingtalkBinding: false },
};

const tenantSettingsResponse = {
  tenantId: "tenant-a",
  settings: baseSettings,
  updatedAt: "2026-08-17T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getTenantSettings.mockResolvedValue(tenantSettingsResponse);
  mocks.updateTenantSettings.mockImplementation(async (_tenantId: string, command: { settings: typeof baseSettings; expectedUpdatedAt: string }) => ({
    tenantId: "tenant-a",
    settings: command.settings,
    updatedAt: "2026-08-17T00:01:00.000Z",
  }));
  mocks.authFetch.mockImplementation(async (url: string) => {
    if (url === "/api/models") {
      return { ok: true, json: async () => modelList } as Response;
    }
    return { ok: true, json: async () => ({}) } as Response;
  });
});

describe("TenantSettingsPanel model-tools 别名编辑", () => {
  it("渲染模型别名 / 展示名称编辑区，展示平台原始名与别名输入框", async () => {
    render(<TenantSettingsPanel tenantId="tenant-a" section="model-tools" />);
    expect(await screen.findByText("模型别名 / 展示名称")).toBeTruthy();
    expect(screen.getByText("Doubao Pro")).toBeTruthy();
    expect(screen.getByText("Kimi 2.6")).toBeTruthy();
    // 两个展示名称输入框 + 两个说明输入框 + 一个分组展示名称输入框
    expect(screen.getAllByLabelText("展示名称")).toHaveLength(2);
    expect(screen.getAllByLabelText("说明")).toHaveLength(2);
  });

  it("修改展示名称并保存，提交的 settings 携带 displayOverrides", async () => {
    render(<TenantSettingsPanel tenantId="tenant-a" section="model-tools" />);
    await screen.findByText("模型别名 / 展示名称");

    const displayNameInputs = screen.getAllByLabelText("展示名称");
    fireEvent.change(displayNameInputs[0]!, { target: { value: "豆包 Pro（组织）" } });
    const descriptionInputs = screen.getAllByLabelText("说明");
    fireEvent.change(descriptionInputs[1]!, { target: { value: "适合复杂任务" } });

    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    await waitFor(() => {
      expect(mocks.updateTenantSettings).toHaveBeenCalledTimes(1);
    });
    const command = mocks.updateTenantSettings.mock.calls[0]![1] as { settings: typeof baseSettings; expectedUpdatedAt: string };
    expect(command.settings.models.displayOverrides).toEqual({
      "openai-agents/doubao": { displayName: "豆包 Pro（组织）" },
      "openai-agents/kimi": { description: "适合复杂任务" },
    });
  });

  it("清空展示名称时删除对应字段而不是提交空字符串", async () => {
    const withOverride = {
      ...baseSettings,
      models: {
        ...baseSettings.models,
        displayOverrides: {
          "openai-agents/doubao": { displayName: "豆包 Pro（组织）" },
        },
      },
    };
    mocks.getTenantSettings.mockResolvedValue({ ...tenantSettingsResponse, settings: withOverride });

    render(<TenantSettingsPanel tenantId="tenant-a" section="model-tools" />);
    await screen.findByText("模型别名 / 展示名称");

    const displayNameInputs = screen.getAllByLabelText("展示名称");
    expect((displayNameInputs[0] as HTMLInputElement).value).toBe("豆包 Pro（组织）");
    fireEvent.change(displayNameInputs[0]!, { target: { value: "" } });

    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    await waitFor(() => {
      expect(mocks.updateTenantSettings).toHaveBeenCalledTimes(1);
    });
    const command = mocks.updateTenantSettings.mock.calls[0]![1] as { settings: typeof baseSettings; expectedUpdatedAt: string };
    expect(command.settings.models.displayOverrides).toEqual({});
  });

  it("默认租户也能渲染别名编辑区（不影响既有能力）", async () => {
    render(<TenantSettingsPanel tenantId={DEFAULT_TENANT_ID} section="model-tools" />);
    await screen.findByText("模型别名 / 展示名称");
    expect(screen.getAllByLabelText("展示名称")).toHaveLength(2);
  });
});

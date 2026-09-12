import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authFetch: vi.fn(),
  saveUserPreferences: vi.fn(),
  updatePreferences: vi.fn(),
}));

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    user: {
      id: "user-1",
      username: "tester",
      preferences: {
        authorizationModeEnabled: true,
        defaultModel: "openai/gpt-test",
        businessStepDisplayMode: "auto",
      },
    },
    updatePreferences: mocks.updatePreferences,
  }),
}));

vi.mock("@/lib/authFetch", () => ({ authFetch: mocks.authFetch }));

vi.mock("@agent/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agent/shared")>();
  return { ...actual, saveUserPreferences: mocks.saveUserPreferences };
});

import { GeneralSection } from "./SettingsModal";

const modelList = {
  groups: [{
    id: "openai",
    name: "OpenAI",
    models: [
      { id: "gpt-test", name: "GPT Test" },
      { id: "gpt-next", name: "GPT Next" },
    ],
  }],
  default: "openai/gpt-test",
  allowCrossGroupSwitch: true,
  showGroupNames: false,
  showContextTokens: true,
  allowContextTokenDetails: false,
};

beforeEach(() => {
  mocks.authFetch.mockReset();
  mocks.saveUserPreferences.mockReset();
  mocks.updatePreferences.mockReset();
  mocks.authFetch.mockResolvedValue({ ok: true, json: async () => modelList });
  mocks.saveUserPreferences.mockResolvedValue({
    authorizationModeEnabled: true,
    defaultModel: "openai/gpt-next",
  });
});

describe("通用设置", () => {
  it("移除已经失效的业务步骤展开偏好，同时保留默认模型保存", async () => {
    render(<GeneralSection />);

    expect(screen.queryByLabelText("业务步骤展示")).toBeNull();
    expect(screen.queryByText("智能折叠")).toBeNull();

    const trigger = await screen.findByLabelText("新建会话默认模型");
    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole("option", { name: "GPT Next" }));
    await userEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(mocks.saveUserPreferences).toHaveBeenCalledWith({
        defaultModel: "openai/gpt-next",
      });
    });
    expect(mocks.saveUserPreferences.mock.calls[0]?.[0]).not.toHaveProperty("businessStepDisplayMode");
    expect(mocks.saveUserPreferences.mock.calls[0]?.[0]).not.toHaveProperty("authorizationModeEnabled");
  });

  it("模型目录失败时显示可操作错误，而不是持续显示加载中", async () => {
    mocks.authFetch.mockRejectedValue(new Error("模型服务不可用"));
    render(<GeneralSection />);

    expect((await screen.findByRole("alert")).textContent).toContain("模型服务不可用");
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
    expect(screen.queryByText("正在加载可选模型…")).toBeNull();
  });

  it("默认模型保存失败时保留草稿并提供重试入口", async () => {
    mocks.saveUserPreferences.mockRejectedValueOnce(new Error("保存服务不可用"));
    render(<GeneralSection />);

    const trigger = await screen.findByLabelText("新建会话默认模型");
    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole("option", { name: "GPT Next" }));
    await userEvent.click(screen.getByRole("button", { name: "保存" }));

    expect((await screen.findByText("保存默认模型失败：保存服务不可用")).textContent).toContain("保存服务不可用");
    expect(screen.getByLabelText("新建会话默认模型").textContent).toContain("GPT Next");
    expect(screen.getByRole("button", { name: "重试保存" })).toBeTruthy();
  });
});

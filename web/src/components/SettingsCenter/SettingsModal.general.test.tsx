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
  groups: [{ id: "openai", name: "OpenAI", models: [{ id: "gpt-test", name: "GPT Test" }] }],
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
  mocks.authFetch.mockResolvedValue({
    ok: true,
    json: async () => modelList,
  });
  mocks.saveUserPreferences.mockResolvedValue({
    authorizationModeEnabled: true,
    defaultModel: "openai/gpt-test",
    businessStepDisplayMode: "collapsed",
  });
});

describe("通用设置的业务步骤展示偏好", () => {
  it("提供三档选项并通过既有个人偏好接口保存", async () => {
    render(<GeneralSection />);

    const trigger = await screen.findByLabelText("业务步骤展示");
    expect(trigger.textContent).toContain("智能折叠");

    await userEvent.click(trigger);
    expect(screen.getByRole("option", { name: "智能折叠" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "始终折叠" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "始终展开" })).toBeTruthy();

    await userEvent.click(screen.getByRole("option", { name: "始终折叠" }));
    await userEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(mocks.saveUserPreferences).toHaveBeenCalledWith(expect.objectContaining({
        businessStepDisplayMode: "collapsed",
      }));
    });
    expect(mocks.updatePreferences).toHaveBeenCalledWith(expect.objectContaining({
      businessStepDisplayMode: "collapsed",
    }));
  });
});

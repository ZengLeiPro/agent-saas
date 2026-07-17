import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryPollingManager } from "./index";
import { authFetch } from "@/lib/authFetch";

// 平台管理员分层治理（2026-07-18）：组件依赖 useAuth().platformReadOnly，测试无 AuthProvider，mock 为可写态
vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ platformReadOnly: false, isSuperAdmin: true, isPlatformAdmin: true }),
}));
vi.mock("@/lib/authFetch", () => ({
  authFetch: vi.fn(),
}));

const INITIAL_VIEW = {
  polling: {
    enabled: true,
    hour: 4,
    hoursSpan: 4,
    timezone: "Asia/Shanghai",
    lookbackHours: 48,
    maxTurns: 30,
    timeoutSeconds: 900,
    model: null,
  },
  configured: true,
  defaultModel: "openai/gpt-5.5",
};

const MODEL_LIST = {
  groups: [{
    id: "openai",
    name: "OpenAI",
    models: [{ id: "gpt-5.5", name: "GPT-5.5" }],
  }],
  default: "openai/gpt-5.5",
  allowCrossGroupSwitch: true,
  showGroupNames: true,
  showContextTokens: true,
  allowContextTokenDetails: false,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("MemoryPollingManager", () => {
  beforeEach(() => {
    vi.mocked(authFetch).mockReset();
    vi.mocked(authFetch).mockImplementation(async (path, init) => {
      if (path === "/api/admin/models") {
        return jsonResponse({ publicModelList: MODEL_LIST });
      }
      if (path === "/api/admin/memory-polling" && init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { polling: typeof INITIAL_VIEW.polling };
        return jsonResponse({ ...INITIAL_VIEW, polling: body.polling });
      }
      return jsonResponse(INITIAL_VIEW);
    });
  });

  it("展示完整的平台配置，并将修改后的完整配置保存到管理 API", async () => {
    const user = userEvent.setup();
    render(<MemoryPollingManager />);

    expect(await screen.findByText("每日调度")).toBeTruthy();
    expect(screen.getByLabelText("平台记忆轮询总开关")).toBeTruthy();
    expect(screen.getByLabelText("执行模型")).toBeTruthy();
    expect(screen.getByText("当前触发窗口 04:00–08:00，每个用户按 ID 稳定分散到 240 个分钟槽。")).toBeTruthy();

    const lookbackInput = screen.getByLabelText("活动回看范围（小时）");
    await user.clear(lookbackInput);
    await user.type(lookbackInput, "72");
    await user.selectOptions(screen.getByLabelText("执行模型"), "openai/gpt-5.5");
    await user.click(screen.getByRole("button", { name: "保存配置" }));

    expect(await screen.findByText("配置已保存并应用")).toBeTruthy();
    const putCall = vi.mocked(authFetch).mock.calls.find((call) =>
      call[0] === "/api/admin/memory-polling" && call[1]?.method === "PUT");
    expect(putCall).toBeTruthy();
    expect(JSON.parse(String(putCall?.[1]?.body))).toEqual({
      polling: {
        enabled: true,
        hour: 4,
        hoursSpan: 4,
        timezone: "Asia/Shanghai",
        lookbackHours: 72,
        maxTurns: 30,
        timeoutSeconds: 900,
        model: "openai/gpt-5.5",
      },
    });
  });

  it("跨日调度在前端被拦截，不发送 PUT", async () => {
    const user = userEvent.setup();
    render(<MemoryPollingManager />);
    await screen.findByText("每日调度");

    const hourInput = screen.getByLabelText("起始小时");
    await user.clear(hourInput);
    await user.type(hourInput, "23");
    const spanInput = screen.getByLabelText("调度跨度（小时）");
    await user.clear(spanInput);
    await user.type(spanInput, "2");
    await user.click(screen.getByRole("button", { name: "保存配置" }));

    expect(await screen.findByText("触发窗口不能跨越次日 00:00")).toBeTruthy();
    await waitFor(() => {
      expect(vi.mocked(authFetch).mock.calls.filter((call) => call[1]?.method === "PUT")).toHaveLength(0);
    });
  });
});

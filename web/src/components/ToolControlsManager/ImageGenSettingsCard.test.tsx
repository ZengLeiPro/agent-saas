import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { authFetch } from "@/lib/authFetch";
import { ImageGenSettingsCard } from "./ImageGenSettingsCard";

vi.mock("@/lib/authFetch", () => ({ authFetch: vi.fn() }));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function emptyConfig() {
  return { config: { enabled: false, gptImage2: null, seedream: null } };
}

describe("ImageGenSettingsCard", () => {
  beforeEach(() => { vi.mocked(authFetch).mockReset(); });

  it("在平台 UI 中启用引擎、填写连接参数和 API Key 后保存", async () => {
    const user = userEvent.setup();
    vi.mocked(authFetch)
      .mockResolvedValueOnce(jsonResponse(emptyConfig()))
      .mockResolvedValueOnce(jsonResponse({
        config: {
          enabled: true,
          gptImage2: {
            enabled: true,
            baseUrl: "https://llm.kaiyan.net/v1",
            model: "gpt-image-2",
            timeoutMs: 180000,
            apiKeyConfigured: true,
          },
          seedream: {
            enabled: false,
            baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
            model: "doubao-seedream-5-0-lite-260128",
            timeoutMs: 180000,
            apiKeyConfigured: false,
          },
        },
      }));

    render(<ImageGenSettingsCard />);

    await user.click(await screen.findByLabelText("启用平台生图能力"));
    await user.click(screen.getByLabelText("启用 GPT Image 2"));
    await user.type(screen.getAllByLabelText("API Key")[0]!, "secret-value");
    await user.click(screen.getByRole("button", { name: /保存引擎配置/ }));

    expect(await screen.findByText("已保存并热生效")).toBeTruthy();
    expect(screen.getByText("密钥已配置")).toBeTruthy();
    const putCall = vi.mocked(authFetch).mock.calls[1]!;
    expect(putCall[0]).toBe("/api/admin/image-gen-pricing/config");
    const payload = JSON.parse((putCall[1] as RequestInit).body as string);
    expect(payload.config).toEqual({
      enabled: true,
      gptImage2: {
        enabled: true,
        baseUrl: "https://llm.kaiyan.net/v1",
        model: "gpt-image-2",
        timeoutMs: 180000,
        apiKey: "secret-value",
      },
      seedream: {
        enabled: false,
        baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
        model: "doubao-seedream-5-0-lite-260128",
        timeoutMs: 180000,
      },
    });
  });

  it("已有密钥时页面不回显明文，留空保存不提交 apiKey", async () => {
    const user = userEvent.setup();
    const configured = {
      config: {
        enabled: true,
        gptImage2: {
          enabled: true,
          baseUrl: "https://llm.kaiyan.net/v1",
          model: "gpt-image-2",
          timeoutMs: 180000,
          apiKeyConfigured: true,
        },
        seedream: null,
      },
    };
    vi.mocked(authFetch)
      .mockResolvedValueOnce(jsonResponse(configured))
      .mockResolvedValueOnce(jsonResponse(configured));

    render(<ImageGenSettingsCard />);

    const keyInput = (await screen.findAllByLabelText("API Key"))[0] as HTMLInputElement;
    expect(keyInput.value).toBe("");
    expect(keyInput.placeholder).toContain("保留现有密钥");
    const modelInput = screen.getAllByLabelText("模型 ID")[0]!;
    await user.clear(modelInput);
    await user.type(modelInput, "gpt-image-2-new");
    await user.click(screen.getByRole("button", { name: /保存引擎配置/ }));

    const payload = JSON.parse((vi.mocked(authFetch).mock.calls[1]![1] as RequestInit).body as string);
    expect(payload.config.gptImage2).not.toHaveProperty("apiKey");
  });
});

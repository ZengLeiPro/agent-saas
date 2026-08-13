import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { authFetch } from "@/lib/authFetch";
import { AudioTranscribeSettingsCard } from "./AudioTranscribeSettingsCard";

const authState = vi.hoisted(() => ({ platformReadOnly: false }));

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    platformReadOnly: authState.platformReadOnly,
    isSuperAdmin: true,
    isPlatformAdmin: true,
  }),
}));
vi.mock("@/lib/authFetch", () => ({ authFetch: vi.fn() }));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function configuredResponse(overrides: Record<string, unknown> = {}) {
  return {
    config: {
      enabled: true,
      model: "fun-asr",
      ossBucket: "audio-temp",
      ossEndpoint: "https://oss-cn-hangzhou.aliyuncs.com",
      apiKeyConfigured: true,
      ossAccessKeyIdConfigured: true,
      ossAccessKeySecretConfigured: true,
    },
    pricing: { creditsPerCall: 20, costYuanPerCall: 0.08 },
    status: {
      available: true,
      platformEnabled: true,
      toolEnabled: true,
      credentialsConfigured: true,
    },
    ...overrides,
  };
}

describe("AudioTranscribeSettingsCard", () => {
  beforeEach(() => {
    authState.platformReadOnly = false;
    vi.mocked(authFetch).mockReset();
  });

  it("加载时展示各凭据的脱敏配置状态，不回显 secret", async () => {
    vi.mocked(authFetch).mockResolvedValueOnce(jsonResponse(configuredResponse()));

    render(<AudioTranscribeSettingsCard />);

    const apiKey = await screen.findByLabelText("DASHSCOPE_API_KEY") as HTMLInputElement;
    const accessKeyId = screen.getByLabelText("OSS_ACCESS_KEY_ID") as HTMLInputElement;
    const accessKeySecret = screen.getByLabelText("OSS_ACCESS_KEY_SECRET") as HTMLInputElement;

    expect(apiKey.value).toBe("");
    expect(accessKeyId.value).toBe("");
    expect(accessKeySecret.value).toBe("");
    expect(apiKey.placeholder).toContain("保留现有值");
    expect(screen.getAllByText("已配置")).toHaveLength(3);
    expect(screen.queryByDisplayValue(/secret/i)).toBeNull();
    expect(screen.getByText("平台语音转写可用")).toBeTruthy();
    expect((screen.getByLabelText("OSS_BUCKET") as HTMLInputElement).value).toBe("audio-temp");
    expect((screen.getByLabelText("OSS_ENDPOINT") as HTMLInputElement).value).toBe("https://oss-cn-hangzhou.aliyuncs.com");
  });

  it("提交完整配置与定价 payload，空 secret 表示保留、非空表示替换", async () => {
    const user = userEvent.setup();
    vi.mocked(authFetch)
      .mockResolvedValueOnce(jsonResponse(configuredResponse()))
      .mockResolvedValueOnce(jsonResponse(configuredResponse({
        config: {
          ...configuredResponse().config,
          model: "fun-asr-realtime",
        },
        pricing: { creditsPerCall: 25, costYuanPerCall: 0.1 },
      })));

    render(<AudioTranscribeSettingsCard />);

    const model = await screen.findByLabelText("模型（model）");
    await user.clear(model);
    await user.type(model, "fun-asr-realtime");
    await user.type(screen.getByLabelText("DASHSCOPE_API_KEY"), "replacement-key");
    const credits = screen.getByLabelText("积分/次");
    await user.clear(credits);
    await user.type(credits, "25");
    const cost = screen.getByLabelText("成本元/次");
    await user.clear(cost);
    await user.type(cost, "0.1");
    await user.click(screen.getByRole("button", { name: /保存语音转写配置/ }));

    expect(await screen.findByText("已保存并热生效")).toBeTruthy();
    const putCall = vi.mocked(authFetch).mock.calls[1]!;
    expect(putCall[0]).toBe("/api/admin/audio-transcribe");
    expect(putCall[1]).toMatchObject({
      method: "PUT",
      headers: { "Content-Type": "application/json" },
    });
    expect(JSON.parse((putCall[1] as RequestInit).body as string)).toEqual({
      config: {
        enabled: true,
        model: "fun-asr-realtime",
        ossBucket: "audio-temp",
        ossEndpoint: "https://oss-cn-hangzhou.aliyuncs.com",
        apiKey: "replacement-key",
        ossAccessKeyId: "",
        ossAccessKeySecret: "",
      },
      pricing: { creditsPerCall: 25, costYuanPerCall: 0.1 },
    });
  });

  it("platformReadOnly 时即使修改表单也禁止保存", async () => {
    authState.platformReadOnly = true;
    const user = userEvent.setup();
    vi.mocked(authFetch).mockResolvedValueOnce(jsonResponse(configuredResponse()));

    render(<AudioTranscribeSettingsCard />);

    const model = await screen.findByLabelText("模型（model）");
    await user.type(model, "-changed");
    const saveButton = screen.getByRole("button", { name: /保存语音转写配置/ }) as HTMLButtonElement;

    expect(saveButton.disabled).toBe(true);
    await user.click(saveButton);
    expect(vi.mocked(authFetch)).toHaveBeenCalledTimes(1);
  });
});

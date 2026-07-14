import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ImageGenPricingCard } from "./ImageGenPricingCard";
import { authFetch } from "@/lib/authFetch";

vi.mock("@/lib/authFetch", () => ({
  authFetch: vi.fn(),
}));

const DEFAULTS = {
  "gpt-image-2": { creditsPerImage: 400, costYuanPerImage: 1.5 },
  "seedream": { creditsPerImage: 100, costYuanPerImage: 0.4 },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function allDefaultView() {
  return { pricing: { ...DEFAULTS }, configured: null, defaults: { ...DEFAULTS } };
}

describe("ImageGenPricingCard", () => {
  beforeEach(() => {
    vi.mocked(authFetch).mockReset();
  });

  it("展示生效定价、默认值来源，并支持后端返回的任意引擎 key", async () => {
    vi.mocked(authFetch).mockResolvedValueOnce(jsonResponse({
      pricing: {
        "gpt-image-2": DEFAULTS["gpt-image-2"],
        "seedream": { creditsPerImage: 200, costYuanPerImage: 0.5 },
        "nano-banana": { creditsPerImage: 50, costYuanPerImage: 0.1 },
      },
      configured: {
        "seedream": { creditsPerImage: 200, costYuanPerImage: 0.5 },
        "nano-banana": { creditsPerImage: 50, costYuanPerImage: 0.1 },
      },
      defaults: { ...DEFAULTS },
    }));

    render(<ImageGenPricingCard />);

    expect(await screen.findByText("gpt-image-2")).toBeTruthy();
    // 不硬编码只认两个引擎：configured 里的任意 key 也要渲染
    expect(screen.getByText("nano-banana")).toBeTruthy();
    // 来源标记：gpt-image-2 走内置默认，seedream / nano-banana 已被管理员覆盖
    expect(screen.getAllByText("内置默认")).toHaveLength(1);
    expect(screen.getAllByText("已覆盖")).toHaveLength(2);
    // 生效值与默认参考值
    expect(screen.getAllByText(/400 积分\/张 · 成本参考 ¥1\.5\/张/).length).toBeGreaterThan(0);
    expect(screen.getByText(/当前生效：200 积分\/张 · 成本参考 ¥0\.5\/张/)).toBeTruthy();
    // 无内置默认的引擎给出提示
    expect(screen.getByText(/无内置默认/)).toBeTruthy();
  });

  it("勾选自定义并修改后保存，PUT 只提交覆盖引擎，成功后展示服务端生效值", async () => {
    const user = userEvent.setup();
    vi.mocked(authFetch)
      .mockResolvedValueOnce(jsonResponse(allDefaultView()))
      .mockResolvedValueOnce(jsonResponse({
        pricing: {
          "gpt-image-2": { creditsPerImage: 500, costYuanPerImage: 2 },
          "seedream": DEFAULTS["seedream"],
        },
        configured: { "gpt-image-2": { creditsPerImage: 500, costYuanPerImage: 2 } },
        defaults: { ...DEFAULTS },
      }));

    render(<ImageGenPricingCard />);

    await user.click(await screen.findByLabelText("自定义 gpt-image-2 定价"));
    const creditsInput = screen.getByLabelText("积分/张");
    const costInput = screen.getByLabelText("真实成本参考（元/张）");
    await user.clear(creditsInput);
    await user.type(creditsInput, "500");
    await user.clear(costInput);
    await user.type(costInput, "2");
    await user.click(screen.getByRole("button", { name: /保存定价/ }));

    expect(await screen.findByText("已保存并热生效")).toBeTruthy();
    const putCall = vi.mocked(authFetch).mock.calls[1]!;
    expect(putCall[0]).toBe("/api/admin/image-gen-pricing");
    expect(JSON.parse((putCall[1] as RequestInit).body as string)).toEqual({
      pricing: { "gpt-image-2": { creditsPerImage: 500, costYuanPerImage: 2 } },
    });
    expect(screen.getByText(/当前生效：500 积分\/张 · 成本参考 ¥2\/张/)).toBeTruthy();
  });

  it("非法输入（空值/非正数）本地校验拦截并带字段路径，不发 PUT", async () => {
    const user = userEvent.setup();
    vi.mocked(authFetch).mockResolvedValueOnce(jsonResponse(allDefaultView()));

    render(<ImageGenPricingCard />);

    await user.click(await screen.findByLabelText("自定义 seedream 定价"));
    await user.clear(screen.getByLabelText("积分/张"));
    await user.click(screen.getByRole("button", { name: /保存定价/ }));

    expect(await screen.findByText(/seedream\.creditsPerImage 必须填写为大于 0 的数字/)).toBeTruthy();
    // 仅初始 GET 一次，校验失败不应发出 PUT
    expect(vi.mocked(authFetch)).toHaveBeenCalledTimes(1);
  });

  it("展示后端 400 返回的字段路径错误信息", async () => {
    const user = userEvent.setup();
    vi.mocked(authFetch)
      .mockResolvedValueOnce(jsonResponse(allDefaultView()))
      .mockResolvedValueOnce(jsonResponse(
        { error: "imageGenTools.pricing.gpt-image-2.creditsPerImage: Number must be less than or equal to 1000000" },
        400,
      ));

    render(<ImageGenPricingCard />);

    await user.click(await screen.findByLabelText("自定义 gpt-image-2 定价"));
    const creditsInput = screen.getByLabelText("积分/张");
    await user.clear(creditsInput);
    await user.type(creditsInput, "2000000");
    await user.click(screen.getByRole("button", { name: /保存定价/ }));

    expect(await screen.findByText(/imageGenTools\.pricing\.gpt-image-2\.creditsPerImage/)).toBeTruthy();
  });

  it("取消全部自定义后保存，PUT pricing:null 整表回退内置默认", async () => {
    const user = userEvent.setup();
    vi.mocked(authFetch)
      .mockResolvedValueOnce(jsonResponse({
        pricing: { ...DEFAULTS, "seedream": { creditsPerImage: 200, costYuanPerImage: 0.5 } },
        configured: { "seedream": { creditsPerImage: 200, costYuanPerImage: 0.5 } },
        defaults: { ...DEFAULTS },
      }))
      .mockResolvedValueOnce(jsonResponse(allDefaultView()));

    render(<ImageGenPricingCard />);

    const overrideCheckbox = await screen.findByLabelText("自定义 seedream 定价");
    expect((overrideCheckbox as HTMLInputElement).checked).toBe(true);
    await user.click(overrideCheckbox);
    await user.click(screen.getByRole("button", { name: /保存定价/ }));

    expect(await screen.findByText("已保存并热生效")).toBeTruthy();
    const putCall = vi.mocked(authFetch).mock.calls[1]!;
    expect(JSON.parse((putCall[1] as RequestInit).body as string)).toEqual({ pricing: null });
  });
});

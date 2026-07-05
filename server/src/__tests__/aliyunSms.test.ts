import { afterEach, describe, expect, it, vi } from "vitest";

import { AliyunSmsSender } from "../integrations/sms/aliyunSms.js";

describe("AliyunSmsSender", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("调用 SendSms 并只把验证码放入模板变量", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ Code: "OK", RequestId: "req-1" })),
      );
    const sender = new AliyunSmsSender({
      accessKeyId: "ak-test",
      accessKeySecret: "sk-secret",
      signName: "开沿科技",
      templateCode: "SMS_123456789",
    });

    await sender.sendCode("13800001111", "123456");

    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.origin).toBe("https://dysmsapi.aliyuncs.com");
    expect(url.searchParams.get("Action")).toBe("SendSms");
    expect(url.searchParams.get("Version")).toBe("2017-05-25");
    expect(url.searchParams.get("PhoneNumbers")).toBe("13800001111");
    expect(url.searchParams.get("SignName")).toBe("开沿科技");
    expect(url.searchParams.get("TemplateCode")).toBe("SMS_123456789");
    expect(JSON.parse(url.searchParams.get("TemplateParam") ?? "{}")).toEqual({
      code: "123456",
    });
    expect(url.searchParams.get("Signature")).toBeTruthy();
    expect(url.toString()).not.toContain("sk-secret");
  });

  it("阿里云返回非 OK 时抛出清晰错误", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          Code: "isv.SMS_SIGNATURE_ILLEGAL",
          Message: "签名未审核",
        }),
      ),
    );
    const sender = new AliyunSmsSender({
      accessKeyId: "ak-test",
      accessKeySecret: "sk-secret",
      signName: "开沿科技",
      templateCode: "SMS_123456789",
    });

    await expect(sender.sendCode("13800001111", "123456")).rejects.toThrow(
      "isv.SMS_SIGNATURE_ILLEGAL",
    );
  });
});

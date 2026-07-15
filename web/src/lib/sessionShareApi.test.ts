import { describe, expect, it, vi } from "vitest";

vi.mock("../platform/webConfig", () => ({
  webConfig: {
    platform: "web",
    getBaseUrl: () => "https://api.example.com",
    getWsUrl: () => "",
  },
}));

import { publicSessionShareFileUrl } from "./sessionShareApi";

describe("公开会话分享文件 URL", () => {
  it("对 token 与路径编码后固定指向 API 域", () => {
    expect(publicSessionShareFileUrl("share 1", "assets/演示.pdf")).toBe(
      "https://api.example.com/api/share/sessions/share%201/file?path=assets%2F%E6%BC%94%E7%A4%BA.pdf",
    );
  });
});

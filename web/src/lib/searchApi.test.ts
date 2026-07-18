import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initPlatform } from "@agent/shared";
import type { PlatformDeps } from "@agent/shared";
import { searchSessions } from "./searchApi";

const BASE = "https://api.example.com";

function initFakePlatform() {
  initPlatform({
    secureStorage: {
      getItem: async () => null,
      setItem: async () => {},
      removeItem: async () => {},
    },
    platformConfig: {
      platform: "web",
      getBaseUrl: () => BASE,
      getWsUrl: () => "",
    },
  } as unknown as PlatformDeps);
}

// parseJsonResponse 依赖 content-type header 与 json/text，构造最小 Response 替身
function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? "application/json" : null) },
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  };
}

describe("searchSessions（web 通过 shared 复用）", () => {
  beforeEach(() => {
    initFakePlatform();
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => vi.unstubAllGlobals());

  it("只有 q 时 URL 仅带 q 查询参数", async () => {
    const payload = { hits: [], nextCursor: null };
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(jsonResponse(payload));

    await expect(searchSessions({ q: "订单 状态" })).resolves.toEqual(payload);
    const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${BASE}/api/search/sessions?q=%E8%AE%A2%E5%8D%95+%E7%8A%B6%E6%80%81`);
  });

  it("limit / cursor 拼入查询串", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(jsonResponse({ hits: [] }));
    await searchSessions({ q: "x", limit: 20, cursor: "c1" });

    const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain("q=x");
    expect(url).toContain("limit=20");
    expect(url).toContain("cursor=c1");
  });

  it("非 2xx 且 body 带 error 时抛该 error", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse({ error: "搜索服务不可用" }, false, 500),
    );
    await expect(searchSessions({ q: "x" })).rejects.toThrow("搜索服务不可用");
  });

  it("非 2xx 且无 error 字段时抛 HTTP 状态", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(jsonResponse({}, false, 503));
    await expect(searchSessions({ q: "x" })).rejects.toThrow("HTTP 503");
  });
});

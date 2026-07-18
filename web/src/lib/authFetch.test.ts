import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initPlatform } from "@agent/shared";
import type { PlatformDeps } from "@agent/shared";
import { authFetch, setOnUnauthorized } from "./authFetch";

const BASE = "https://api.example.com";

let storageToken: string | null;
const setItemSpy = vi.fn();

function initFakePlatform() {
  storageToken = null;
  setItemSpy.mockReset();
  initPlatform({
    secureStorage: {
      getItem: async () => storageToken,
      setItem: async (k: string, v: string) => {
        setItemSpy(k, v);
      },
      removeItem: async () => {},
    },
    platformConfig: {
      platform: "web",
      getBaseUrl: () => BASE,
      getWsUrl: () => "",
    },
  } as unknown as PlatformDeps);
}

// 最小 Response 替身：可带自定义 headers 与 status
function makeResponse(opts: { status?: number; headers?: Record<string, string>; body?: unknown } = {}) {
  const status = opts.status ?? 200;
  const headerMap = opts.headers ?? {};
  const response = {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headerMap[k] ?? headerMap[k.toLowerCase()] ?? null },
    json: vi.fn().mockResolvedValue(opts.body ?? {}),
    clone() {
      return response;
    },
  };
  return response;
}

describe("authFetch（web barrel → shared 实现）", () => {
  beforeEach(() => {
    initFakePlatform();
    setOnUnauthorized(() => {});
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => vi.unstubAllGlobals());

  it("相对路径拼接 baseUrl，有 token 时注入 Authorization", async () => {
    storageToken = "tok-123";
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(makeResponse());

    await authFetch("/api/x");

    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${BASE}/api/x`);
    expect((init.headers as Headers).get("Authorization")).toBe("Bearer tok-123");
  });

  it("无 token 时不带 Authorization 头", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(makeResponse());
    await authFetch("/api/x");
    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((init.headers as Headers).get("Authorization")).toBeNull();
  });

  it("绝对 URL 不被改写", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(makeResponse());
    await authFetch("https://other.example.com/y");
    const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://other.example.com/y");
  });

  it("401 触发 onUnauthorized", async () => {
    const onUnauth = vi.fn();
    setOnUnauthorized(onUnauth);
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(makeResponse({ status: 401 }));

    await authFetch("/api/x");
    expect(onUnauth).toHaveBeenCalledTimes(1);
  });

  it("403 且 code=USER_DISABLED 触发 onUnauthorized", async () => {
    const onUnauth = vi.fn();
    setOnUnauthorized(onUnauth);
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeResponse({ status: 403, body: { code: "USER_DISABLED" } }),
    );

    await authFetch("/api/x");
    expect(onUnauth).toHaveBeenCalledTimes(1);
  });

  it("403 但非 USER_DISABLED 不触发 onUnauthorized", async () => {
    const onUnauth = vi.fn();
    setOnUnauthorized(onUnauth);
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeResponse({ status: 403, body: { code: "FORBIDDEN" } }),
    );

    await authFetch("/api/x");
    expect(onUnauth).not.toHaveBeenCalled();
  });

  it("响应带 X-Refresh-Token 时持久化新 token（滑动过期）", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeResponse({ headers: { "X-Refresh-Token": "new-token" } }),
    );

    await authFetch("/api/x");
    expect(setItemSpy).toHaveBeenCalledWith(expect.any(String), "new-token");
  });
});

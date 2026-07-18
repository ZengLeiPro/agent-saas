import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * preload.ts 在「模块加载即执行」——import 那一刻就发起 auth/sessions 等预取。
 * 因此必须在 import 之前 stub 好 fetch / localStorage / webConfig，并用
 * vi.resetModules + 动态 import 保证每个用例拿到全新的模块级 promise。
 *
 * 只覆盖无 setTimeout 延迟、确定的首跳分支：
 * - authPreload 命中 200 → authenticated，且请求打到 /api/auth/me
 * - 401/非 5xx → unauthenticated；404 → no-auth
 * - sessionsPreload 依赖 authPreload 结果决定是否发起
 * 带随机 jitter 重试与 delay(2000) 的下游预取依赖真实时序，不做断言（见返回说明）。
 */

const BASE = "https://api.example.com";

vi.mock("../platform/webConfig", () => ({
  webConfig: { platform: "web", getBaseUrl: () => BASE, getWsUrl: () => "" },
}));

const authUser = { id: "u1", username: "alice", role: "user", tenantId: "t1" };

function stubFetchByPath(handler: (path: string) => { status: number; body?: unknown }) {
  const fetchMock = vi.fn((url: string, _init?: RequestInit) => {
    const path = url.replace(BASE, "");
    const { status, body } = handler(path);
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body ?? {}),
    } as Response);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("preload.authPreload", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("/api/auth/me 返回 200 → authenticated，并带 Bearer 头", async () => {
    localStorage.setItem("agentChat.authToken", "tok-x");
    const fetchMock = stubFetchByPath((p) =>
      p.startsWith("/api/auth/me") ? { status: 200, body: authUser } : { status: 200, body: { sessions: [] } },
    );

    const mod = await import("./preload");
    await expect(mod.authPreload).resolves.toMatchObject({ status: "authenticated", user: authUser });

    const meCall = fetchMock.mock.calls.find(([u]) => (u as string).includes("/api/auth/me"));
    expect(meCall?.[0]).toBe(`${BASE}/api/auth/me`);
    const init = meCall?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok-x");
  });

  it("无 token 时不带 Authorization 头", async () => {
    const fetchMock = stubFetchByPath(() => ({ status: 200, body: authUser }));
    const mod = await import("./preload");
    await mod.authPreload;
    const meCall = fetchMock.mock.calls.find(([u]) => (u as string).includes("/api/auth/me"));
    expect((meCall?.[1] as RequestInit).headers).toEqual({});
  });

  it("404 → no-auth", async () => {
    stubFetchByPath((p) => (p.startsWith("/api/auth/me") ? { status: 404 } : { status: 200 }));
    const mod = await import("./preload");
    await expect(mod.authPreload).resolves.toEqual({ status: "no-auth" });
  });

  it("401（非 5xx，不重试）→ unauthenticated", async () => {
    stubFetchByPath((p) => (p.startsWith("/api/auth/me") ? { status: 401 } : { status: 200 }));
    const mod = await import("./preload");
    await expect(mod.authPreload).resolves.toEqual({ status: "unauthenticated" });
  });
});

describe("preload.sessionsPreload", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("已鉴权时拉取会话列表并解析 sessions/hasMore", async () => {
    const sessions = [{ id: "s1" }];
    stubFetchByPath((p) => {
      if (p.startsWith("/api/auth/me")) return { status: 200, body: authUser };
      if (p.startsWith("/api/sessions")) return { status: 200, body: { sessions, hasMore: true } };
      return { status: 200, body: {} };
    });
    const mod = await import("./preload");
    await expect(mod.sessionsPreload).resolves.toEqual({ sessions, hasMore: true });
  });

  it("未鉴权（401）时 sessionsPreload 直接返回 null，不发 sessions 请求", async () => {
    const fetchMock = stubFetchByPath((p) =>
      p.startsWith("/api/auth/me") ? { status: 401 } : { status: 200 },
    );
    const mod = await import("./preload");
    await expect(mod.sessionsPreload).resolves.toBeNull();
    expect(fetchMock.mock.calls.some(([u]) => (u as string).includes("/api/sessions"))).toBe(false);
  });
});

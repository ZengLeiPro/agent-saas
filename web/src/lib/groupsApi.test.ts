import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initPlatform } from "@agent/shared";
import type { PlatformDeps } from "@agent/shared";
import {
  addSessionsToGroup,
  createGroup,
  deleteGroup,
  fetchGroups,
  removeSessionsFromGroup,
  updateGroup,
} from "./groupsApi";

// 注入最小 platform，让 shared authFetch 能取到 baseUrl 与（无）token；只 mock 网络边界
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

function res(body: unknown, ok = true) {
  // authFetch 会读 response.headers.get('X-Refresh-Token')，需提供 headers.get
  return {
    ok,
    status: ok ? 200 : 500,
    headers: { get: () => null },
    json: vi.fn().mockResolvedValue(body),
  };
}

describe("groupsApi（web 通过 shared 复用，mock authFetch 网络边界）", () => {
  beforeEach(() => {
    initFakePlatform();
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => vi.unstubAllGlobals());

  it("fetchGroups 成功解析 groups 数组", async () => {
    const groups = [{ id: "g1", name: "组1" }];
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(res({ groups }));

    await expect(fetchGroups()).resolves.toEqual(groups);
    expect(fetch).toHaveBeenCalledWith(
      `${BASE}/api/groups`,
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
  });

  it("fetchGroups 非 2xx 返回空数组", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(res(null, false));
    await expect(fetchGroups()).resolves.toEqual([]);
  });

  it("fetchGroups 缺 groups 字段回退空数组", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(res({}));
    await expect(fetchGroups()).resolves.toEqual([]);
  });

  it("createGroup POST 携带 name 与 sessionIds", async () => {
    const group = { id: "g2", name: "新组" };
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(res(group));

    await expect(createGroup("新组", ["s1", "s2"])).resolves.toEqual(group);
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${BASE}/api/groups`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ name: "新组", sessionIds: ["s1", "s2"] });
  });

  it("createGroup 无 sessionIds 时不带该字段，失败返回 null", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(res(null, false));
    await expect(createGroup("只名字")).resolves.toBeNull();
    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ name: "只名字" });
  });

  it("deleteGroup 对 id 编码并 DELETE，返回 ok 布尔", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(res(null, true));
    await expect(deleteGroup("g/1")).resolves.toBe(true);
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${BASE}/api/groups/g%2F1`);
    expect(init.method).toBe("DELETE");
  });

  it("updateGroup PATCH 携带 patch", async () => {
    const group = { id: "g1", name: "改名" };
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(res(group));
    await expect(updateGroup("g1", { name: "改名" })).resolves.toEqual(group);
    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ name: "改名" });
  });

  it("addSessionsToGroup 从 group 字段解包，缺失回退 null", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(res({ group: { id: "g1" } }));
    await expect(addSessionsToGroup("g1", ["s1"])).resolves.toEqual({ id: "g1" });

    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(res({}));
    await expect(addSessionsToGroup("g1", ["s1"])).resolves.toBeNull();
  });

  it("removeSessionsFromGroup DELETE 带 body，失败返回 null", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(res({ group: { id: "g1" } }));
    await expect(removeSessionsFromGroup("g1", ["s1"])).resolves.toEqual({ id: "g1" });
    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.method).toBe("DELETE");
    expect(JSON.parse(init.body)).toEqual({ sessionIds: ["s1"] });
  });
});

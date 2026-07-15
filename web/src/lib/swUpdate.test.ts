import { afterEach, describe, expect, it, vi } from "vitest";

import { clearLegacyApiCaches } from "./swUpdate";

describe("Service Worker 旧 API 缓存迁移", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("只删除旧版 api-* runtime cache，保留静态 precache", async () => {
    const deleteCache = vi.fn().mockResolvedValue(true);
    vi.stubGlobal("caches", {
      keys: vi.fn().mockResolvedValue([
        "api-sessions-list",
        "api-session-detail",
        "workbox-precache-v2-https://agent.example.com/",
      ]),
      delete: deleteCache,
    });

    await clearLegacyApiCaches();

    expect(deleteCache.mock.calls.map(([name]) => name)).toEqual([
      "api-sessions-list",
      "api-session-detail",
    ]);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const { authFetchMock } = vi.hoisted(() => ({ authFetchMock: vi.fn() }));
vi.mock("@/lib/authFetch", () => ({ authFetch: authFetchMock }));
vi.mock("@/platform/webConfig", () => ({
  webConfig: { platform: "web", getBaseUrl: () => "https://api.example.com", getWsUrl: () => "" },
}));

import {
  createArtifactShare,
  fetchPublicArtifactShare,
  getArtifactShare,
  publicArtifactContentUrl,
  revokeArtifactShare,
} from "@/lib/artifactShareApi";

describe("artifactShareApi", () => {
  beforeEach(() => {
    authFetchMock.mockReset();
  });

  it("把服务端 owner share 包装转换为前端 enabled 状态", async () => {
    authFetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ share: null }), { status: 200 }));
    await expect(getArtifactShare("artifact-1")).resolves.toEqual({ enabled: false });

    authFetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ share: { token: "t", publicPath: "/public/artifacts/t" } }), { status: 200 }));
    await expect(getArtifactShare("artifact-1")).resolves.toMatchObject({ enabled: true, token: "t" });
  });

  it("创建分享时提交强确认、有效期和下载权限", async () => {
    authFetchMock.mockResolvedValue(new Response(JSON.stringify({ share: { token: "token", publicPath: "/public/artifacts/token" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    await createArtifactShare("artifact / 1", {
      confirmPublicArtifact: true,
      expiresAt: "2026-08-29T00:00:00.000Z",
      allowDownload: false,
    });
    expect(authFetchMock).toHaveBeenCalledWith("/api/artifacts/artifact%20%2F%201/share", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        confirmPublicArtifact: true,
        expiresAt: "2026-08-29T00:00:00.000Z",
        allowDownload: false,
      }),
    }));
  });

  it("撤销使用 DELETE，公开元数据与内容均固定指向 API 域", async () => {
    authFetchMock.mockResolvedValue(new Response(JSON.stringify({ enabled: false }), { status: 200 }));
    await revokeArtifactShare("a/b");
    expect(authFetchMock).toHaveBeenCalledWith("/api/artifacts/a%2Fb/share", { method: "DELETE" });
    expect(publicArtifactContentUrl("share / token")).toBe("https://api.example.com/api/share/artifacts/share%20%2F%20token/content");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      share: { enabled: true },
      artifact: { fileName: "demo.pdf" },
    }), { status: 200 })));
    const result = await fetchPublicArtifactShare("t");
    expect(result.contentUrl).toBe("https://api.example.com/api/share/artifacts/t/content");
    vi.unstubAllGlobals();
  });
});

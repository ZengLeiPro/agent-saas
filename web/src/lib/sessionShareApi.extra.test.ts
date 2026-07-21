import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 固定分域 API base，断言 apiUrl 拼接
vi.mock("../platform/webConfig", () => ({
  webConfig: {
    platform: "web",
    getBaseUrl: () => "https://api.example.com",
    getWsUrl: () => "",
  },
}));

// mock 掉鉴权网络边界（authFetch 依赖平台注册，非本模块职责），保留被测函数本体
const authFetchMock = vi.fn();
vi.mock("@/lib/authFetch", () => ({
  authFetch: (...args: unknown[]) => authFetchMock(...args),
}));

import {
  fetchPublicSessionShare,
  getSessionShare,
  getSessionSharePreview,
  revokeSessionShare,
  updateSessionShare,
} from "./sessionShareApi";

function okJson(body: unknown) {
  return { ok: true, status: 200, json: vi.fn().mockResolvedValue(body) };
}

describe("getSessionShare", () => {
  beforeEach(() => authFetchMock.mockReset());

  it("对 sessionId 编码后请求 share 端点并解析响应", async () => {
    const summary = { enabled: true, shareId: "sh1" };
    authFetchMock.mockResolvedValue(okJson(summary));

    await expect(getSessionShare("s p/1")).resolves.toEqual(summary);
    expect(authFetchMock).toHaveBeenCalledWith("/api/sessions/s%20p%2F1/share");
  });

  it("非 2xx 时抛出后端 error 文案", async () => {
    authFetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: vi.fn().mockResolvedValue({ error: "后端炸了" }),
    });
    await expect(getSessionShare("s1")).rejects.toThrow("后端炸了");
  });

  it("非 2xx 且响应无 error 字段时回退默认文案", async () => {
    authFetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: vi.fn().mockRejectedValue(new Error("not json")),
    });
    await expect(getSessionShare("s1")).rejects.toThrow("读取分享设置失败");
  });
});

describe("updateSessionShare", () => {
  beforeEach(() => authFetchMock.mockReset());

  it("POST 必须传递公开确认与显式文件清单", async () => {
    authFetchMock.mockResolvedValue(okJson({ enabled: true }));
    await updateSessionShare("s1", { confirmPublicText: true, filePaths: ["assets/demo.pdf"] });

    expect(authFetchMock).toHaveBeenCalledWith("/api/sessions/s1/share", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmPublicText: true, filePaths: ["assets/demo.pdf"] }),
    });
  });

  it("失败时抛生成失败文案", async () => {
    authFetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: vi.fn().mockResolvedValue({}),
    });
    await expect(updateSessionShare("s1", { confirmPublicText: true, filePaths: [] }))
      .rejects.toThrow("生成分享链接失败");
  });
});

describe("getSessionSharePreview", () => {
  beforeEach(() => authFetchMock.mockReset());

  it("读取公开正文与候选文件预览", async () => {
    const preview = {
      blockCount: 2,
      files: [{ relativePath: "assets/demo.pdf", fileName: "demo.pdf" }],
      defaultExpiresAt: "2026-07-28T00:00:00.000Z",
    };
    authFetchMock.mockResolvedValue(okJson(preview));

    await expect(getSessionSharePreview("s p/1")).resolves.toEqual(preview);
    expect(authFetchMock).toHaveBeenCalledWith("/api/sessions/s%20p%2F1/share-preview");
  });

  it("预览失败时返回安全错误文案", async () => {
    authFetchMock.mockResolvedValue({
      ok: false,
      status: 422,
      json: vi.fn().mockResolvedValue({ error: "会话包含手机号，请先脱敏后再分享" }),
    });
    await expect(getSessionSharePreview("s1")).rejects.toThrow("会话包含手机号，请先脱敏后再分享");
  });
});

describe("revokeSessionShare", () => {
  beforeEach(() => authFetchMock.mockReset());

  it("DELETE 请求 share 端点", async () => {
    authFetchMock.mockResolvedValue(okJson({ enabled: false }));
    await expect(revokeSessionShare("s1")).resolves.toEqual({ enabled: false });
    expect(authFetchMock).toHaveBeenCalledWith("/api/sessions/s1/share", { method: "DELETE" });
  });

  it("失败时抛撤销失败文案", async () => {
    authFetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: vi.fn().mockResolvedValue({ error: "" }),
    });
    // error 为空串走 fallback
    await expect(revokeSessionShare("s1")).rejects.toThrow("撤销分享链接失败");
  });
});

describe("fetchPublicSessionShare（裸 fetch）", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => vi.unstubAllGlobals());

  it("走 apiUrl 拼绝对地址并带 Accept 头，成功解析", async () => {
    const body = { share: { ownerUsername: "用户", debugMode: false }, detail: {} };
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(okJson(body));

    await expect(fetchPublicSessionShare("tok 1")).resolves.toEqual(body);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.example.com/api/share/sessions/tok%201",
      { headers: { Accept: "application/json" } },
    );
  });

  it("410 抛「已失效」", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 410,
      json: vi.fn().mockResolvedValue(null),
    });
    await expect(fetchPublicSessionShare("tok")).rejects.toThrow("分享链接已失效");
  });

  it("非 410 错误抛「不存在」", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 404,
      json: vi.fn().mockResolvedValue(null),
    });
    await expect(fetchPublicSessionShare("tok")).rejects.toThrow("分享链接不存在");
  });
});

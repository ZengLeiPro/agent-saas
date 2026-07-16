import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initPlatform } from "@agent/shared";
import type { FileEntry, PlatformDeps } from "@agent/shared";
import { FileBrowser } from "./FileBrowser";
import { useFileList } from "./useFileList";
import { authFetch } from "@/lib/authFetch";

vi.mock("./useFileList", () => ({ useFileList: vi.fn() }));
vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ user: { username: "alice" } }),
}));
vi.mock("@/lib/authFetch", () => ({
  authFetch: vi.fn(),
}));

beforeAll(() => {
  initPlatform({
    secureStorage: {
      getItem: async () => "jwt-token",
      setItem: async () => {},
      removeItem: async () => {},
    },
    platformConfig: { getBaseUrl: () => "https://api.example.com" },
  } as unknown as PlatformDeps);
});

beforeEach(() => {
  vi.mocked(authFetch).mockReset();
  localStorage.clear();
});

function entry(name: string): FileEntry {
  return {
    name,
    path: `assets/${name}`,
    isDirectory: false,
    size: 1024,
    modifiedAt: 1_700_000_000_000,
    extension: name.split(".").pop() || "",
  };
}

function renderBrowser(entries: FileEntry[]) {
  vi.mocked(useFileList).mockReturnValue({
    entries,
    currentPath: "assets",
    parentPath: null,
    loading: false,
    error: null,
    refresh: vi.fn(),
  });
  return render(<FileBrowser onPreviewFile={vi.fn()} />);
}

describe("FileBrowser 文件点击", () => {
  it("图片使用带 token 的 API URL 打开 lightbox", async () => {
    renderBrowser([entry("现场图.png")]);

    fireEvent.click(screen.getByText("现场图.png"));

    const image = await screen.findByAltText("现场图.png");
    expect(image.getAttribute("src")).toBe(
      "https://api.example.com/api/file/download?path=assets%2F%E7%8E%B0%E5%9C%BA%E5%9B%BE.png&owner=alice&token=jwt-token",
    );
    expect(authFetch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "关闭预览" }));
    expect(screen.queryByAltText("现场图.png")).toBeNull();
  });

  it("不可预览文件直接使用带 token 的 URL 下载，不重放 res.url", async () => {
    const clicked: Array<{ href: string; download: string; target: string }> = [];
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        clicked.push({ href: this.href, download: this.download, target: this.target });
      });
    try {
      renderBrowser([entry("资料包.zip")]);

      fireEvent.click(screen.getByText("资料包.zip"));

      await waitFor(() => expect(clicked).toHaveLength(1));
      expect(clicked[0]).toEqual({
        href: "https://api.example.com/api/file/download?path=assets%2F%E8%B5%84%E6%96%99%E5%8C%85.zip&owner=alice&token=jwt-token",
        download: "资料包.zip",
        target: "",
      });
      expect(authFetch).not.toHaveBeenCalled();
    } finally {
      clickSpy.mockRestore();
    }
  });
});

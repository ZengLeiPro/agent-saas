import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FilePreviewActions, printFilePreviewElement } from "./FilePreviewActions";

const resolveImageSrc = vi.fn();

vi.mock("@agent/shared", () => ({
  getPreviewFileType: (filePath: string) => {
    if (/\.pdf$/i.test(filePath)) return "pdf";
    if (/\.html?$/i.test(filePath)) return "html";
    if (/\.(md|markdown)$/i.test(filePath)) return "md";
    if (/\.mp4$/i.test(filePath)) return "video";
    return "code";
  },
  resolveImageSrc: (...args: unknown[]) => resolveImageSrc(...args),
}));

vi.mock("@/platform/webConfig", () => ({
  webConfig: {
    platform: "web",
    getBaseUrl: () => "https://api.example.com",
    getWsUrl: () => "",
  },
}));

describe("FilePreviewActions", () => {
  beforeEach(() => {
    resolveImageSrc.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.classList.remove("file-preview-printing");
  });

  it("下载按钮使用强制 attachment 的跨域文件 URL", async () => {
    resolveImageSrc.mockResolvedValueOnce(
      "https://api.example.com/api/file/download?path=assets%2Fdemo.pdf&token=jwt",
    );
    let clickedHref = "";
    let downloadName = "";
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clickedHref = this.href;
      downloadName = this.download;
    });

    render(<FilePreviewActions filePath="assets/demo.pdf" />);
    fireEvent.click(screen.getByRole("button", { name: "下载文件" }));

    await waitFor(() => expect(clickedHref).toContain("download=1"));
    expect(clickedHref).toContain("path=assets%2Fdemo.pdf");
    expect(downloadName).toBe("demo.pdf");
  });

  it("文本类打印按钮把请求交给当前预览器", () => {
    const listener = vi.fn();
    window.addEventListener("agent-saas:file-preview-print", listener);

    render(<FilePreviewActions filePath="assets/demo.md" />);
    fireEvent.click(screen.getByRole("button", { name: "打印文件" }));

    expect(listener).toHaveBeenCalledTimes(1);
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({ filePath: "assets/demo.md" });
    window.removeEventListener("agent-saas:file-preview-print", listener);
  });

  it("视频预览只显示下载，不显示打印", () => {
    render(<FilePreviewActions filePath="assets/demo.mp4" />);
    expect(screen.getByRole("button", { name: "下载文件" }).textContent).toBe("");
    expect(screen.queryByRole("button", { name: "打印文件" })).toBeNull();
  });

  it("下载和打印按钮只显示图标，不渲染文字", () => {
    render(<FilePreviewActions filePath="assets/demo.md" />);
    expect(screen.getByRole("button", { name: "下载文件" }).textContent).toBe("");
    expect(screen.getByRole("button", { name: "打印文件" }).textContent).toBe("");
  });
});

describe("printFilePreviewElement", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.classList.remove("file-preview-printing");
  });

  it("调用浏览器打印时临时标记当前内容区，并在结束后清理", () => {
    const element = document.createElement("div");
    document.body.appendChild(element);
    vi.spyOn(window, "print").mockImplementation(() => {
      expect(document.body.classList.contains("file-preview-printing")).toBe(true);
      expect(element.getAttribute("data-file-preview-print-root")).toBe("true");
    });

    printFilePreviewElement(element);

    expect(document.body.classList.contains("file-preview-printing")).toBe(false);
    expect(element.hasAttribute("data-file-preview-print-root")).toBe(false);
    element.remove();
  });
});

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { FilePreviewDialog, FilePreviewPanel } from "./FilePreviewPanel";

vi.mock("@/lib/authFetch", () => ({
  authFetch: vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ content: "# demo", filename: "demo.md" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  ),
}));

vi.mock("@agent/shared", async (importOriginal) => ({
  ...await importOriginal<typeof import("@agent/shared")>(),
  resolveImageSrc: vi.fn(() => new Promise<string>(() => {})),
}));

vi.mock("@/platform/webConfig", () => ({
  webConfig: {
    platform: "web",
    getBaseUrl: () => "https://api.example.com",
    getWsUrl: () => "",
  },
}));

describe("FilePreviewDialog", () => {
  it("标题保持在左侧，纯图标下载/打印紧挨在右侧打开按钮左边", () => {
    render(
      <FilePreviewDialog
        open
        filePath="assets/demo.md"
        onClose={vi.fn()}
        onDock={vi.fn()}
      />,
    );

    const title = screen.getByText("demo.md");
    const download = screen.getByRole("button", { name: "下载文件" });
    const print = screen.getByRole("button", { name: "打印文件" });
    const dock = screen.getByRole("button", { name: /右侧打开/ });
    const close = screen.getByRole("button", { name: "Close" });

    expect(title.compareDocumentPosition(download) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(download.compareDocumentPosition(dock) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(print.compareDocumentPosition(dock) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(download.textContent).toBe("");
    expect(print.textContent).toBe("");
    expect(close.parentElement?.className).toContain("[&>button[aria-label='Close']]:top-1.5");
    expect(close.parentElement?.className).toContain("!border-0");
    expect(close.parentElement?.className).toContain("!shadow-xl");
    expect(close.parentElement?.className).toContain("outline-none");
    expect(close.parentElement?.className).toContain("h-[calc(100dvh-32px)]");
    expect(close.parentElement?.className).toContain("z-[101]");
    expect((close.parentElement as HTMLElement).style.top).toBe("50%");
    expect(close.parentElement?.className).not.toContain("900px");
  });

  it("视频预览点击弹窗外遮罩会关闭", () => {
    const onClose = vi.fn();
    render(
      <FilePreviewDialog
        open
        filePath="assets/demo.mp4"
        onClose={onClose}
      />,
    );

    const content = screen.getByRole("dialog");
    const overlay = Array.from(document.body.querySelectorAll<HTMLElement>('[data-state="open"]'))
      .find((element) => element !== content && element.className.includes("inset-0"));
    expect(overlay?.className).toContain("z-[100]");
    expect(overlay?.className).toContain("bg-black/70");

    fireEvent.pointerDown(overlay!);
    fireEvent.click(overlay!);
    expect(onClose).toHaveBeenCalled();
  });

  it("右侧预览栏提供返回弹窗预览的放大按钮", () => {
    const onExpand = vi.fn();
    render(
      <FilePreviewPanel
        filePath="assets/demo.md"
        onBack={vi.fn()}
        onExpand={onExpand}
      />,
    );

    const expand = screen.getByRole("button", { name: "放大到弹窗预览" });
    fireEvent.click(expand);
    expect(onExpand).toHaveBeenCalledTimes(1);
  });
});

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

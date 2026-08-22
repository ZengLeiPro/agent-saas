import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ARTIFACT_TEXT_MAX_BYTES,
  ArtifactContentViewer,
  selectArtifactPreviewKind,
} from "@/components/artifacts/ArtifactContentViewer";
import { HTML_SANDBOX_CSP, injectSandboxCsp } from "@/lib/htmlSandbox";

describe("ArtifactContentViewer", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:artifact-preview") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("按 MIME 优先并用扩展名兜底选择预览类型", () => {
    expect(selectArtifactPreviewKind("result.bin", "text/html; charset=utf-8")).toBe("html");
    expect(selectArtifactPreviewKind("README.md", "application/octet-stream")).toBe("markdown");
    expect(selectArtifactPreviewKind("report.pdf")).toBe("pdf");
    expect(selectArtifactPreviewKind("photo.bin", "image/png")).toBe("image");
    expect(selectArtifactPreviewKind("active.svg", "image/svg+xml")).toBe("download");
    expect(selectArtifactPreviewKind("active.svg", "image/png")).toBe("download");
    expect(selectArtifactPreviewKind("voice.mp3")).toBe("audio");
    expect(selectArtifactPreviewKind("clip.mp4")).toBe("video");
    expect(selectArtifactPreviewKind("payload.dat", "application/octet-stream")).toBe("download");
  });

  it("CSP 始终位于不可信脚本之前，不会误把 script 字符串中的 <head> 当标签", () => {
    const hostile = '<script>const marker="<head>";window.beforeCsp=1</script><html></html>';
    const injected = injectSandboxCsp(hostile);
    expect(injected.indexOf("Content-Security-Policy")).toBeLessThan(injected.indexOf("<script>"));
  });

  it("仅白名单标准 DOCTYPE 保持首位，PUBLIC/内部子集/畸形声明都位于 CSP 之后", () => {
    for (const unsafe of [
      '<!doctype html PUBLIC \"><script>window.pwned=1</script>',
      '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN" "about:legacy-compat"><html></html>',
      '<!doctype html [><script>window.pwned=1</script>]>  ',
    ]) {
      expect(injectSandboxCsp(unsafe)).toMatch(/^<meta http-equiv="Content-Security-Policy"/);
    }
    expect(injectSandboxCsp('<!doctype html><html></html>')).toMatch(/^<!doctype html><meta http-equiv="Content-Security-Policy"/i);
  });

  it("HTML 只通过 fetch + srcDoc 在 allow-scripts 沙箱中渲染并注入 CSP", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("<!doctype html><html><body><script>window.ok=1</script></body></html>", { status: 200 }));
    render(<ArtifactContentViewer contentUrl="/content" fileName="demo.html" mimeType="text/html" />);

    const frame = await screen.findByTitle("demo.html") as HTMLIFrameElement;
    expect(fetch).toHaveBeenCalledWith("/content", expect.objectContaining({ referrerPolicy: "no-referrer" }));
    expect(frame.getAttribute("src")).toBeNull();
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.getAttribute("srcdoc")).toMatch(/^<!doctype html><meta http-equiv="Content-Security-Policy"/i);
    expect(frame.getAttribute("srcdoc")).toContain(HTML_SANDBOX_CSP);
    expect(frame.getAttribute("srcdoc")).toContain("window.ok=1");
    expect(HTML_SANDBOX_CSP).toContain("connect-src 'none'");
    expect(HTML_SANDBOX_CSP).toContain("form-action 'none'");
    expect(HTML_SANDBOX_CSP).toContain("navigate-to 'none'");
  });

  it("显示 HTTP 与文本超限错误", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("missing", { status: 404 }));
    const { rerender } = render(<ArtifactContentViewer contentUrl="/missing" fileName="note.txt" mimeType="text/plain" />);
    expect((await screen.findByRole("alert")).textContent).toContain("HTTP 404");

    vi.mocked(fetch).mockResolvedValueOnce(new Response("x", { headers: { "content-length": String(ARTIFACT_TEXT_MAX_BYTES + 1) } }));
    rerender(<ArtifactContentViewer contentUrl="/huge" fileName="huge.txt" mimeType="text/plain" />);
    expect((await screen.findByRole("alert")).textContent).toContain("文本预览上限");
  });

  it("Markdown 不会自动请求第三方图片并泄露公开链接 referrer", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("![跟踪像素](https://evil.example/pixel.png)", { status: 200 }));
    render(<ArtifactContentViewer contentUrl="/markdown" fileName="README.md" mimeType="text/markdown" />);
    await waitFor(() => {
      expect(screen.getByText("[外部图片已阻止：跟踪像素]")).toBeTruthy();
    }, { timeout: 5_000 });
    expect(screen.queryByRole("img", { name: "跟踪像素" })).toBeNull();
  });

  it("即使伪装成 PNG 也不会把 SVG 活动内容放进图片预览", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(
      "<?xml version=\"1.0\"?><svg><script>alert(1)</script></svg>",
      { status: 200, headers: { "content-type": "image/png" } },
    ));
    render(<ArtifactContentViewer contentUrl="/spoofed" fileName="safe.png" mimeType="image/png" />);
    expect((await screen.findByRole("alert")).textContent).toContain("检测到 SVG 活动内容");
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("二进制预览卸载时撤销 blob URL", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(new Blob(["image"], { type: "image/png" }), { status: 200 }));
    const { unmount } = render(<ArtifactContentViewer contentUrl="/image" fileName="image.png" mimeType="image/png" />);
    await screen.findByRole("img", { name: "image.png" });
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    unmount();
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:artifact-preview"));
  });
});

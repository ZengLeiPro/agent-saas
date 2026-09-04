import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactReadGrant } from "@agent/shared";
import { ArtifactContentViewer } from "@/components/artifacts/ArtifactContentViewer";

const authFetchMock = vi.fn();
vi.mock("@agent/shared", async (importOriginal) => ({
  ...await importOriginal<typeof import("@agent/shared")>(),
  authFetchResource: (...args: unknown[]) => authFetchMock(...args),
}));

function grant(viewKind: ArtifactReadGrant["descriptor"]["viewKind"], overrides: Partial<ArtifactReadGrant["descriptor"]> = {}): ArtifactReadGrant {
  return {
    readUrl: "/api/artifacts/a/content?token=redacted",
    descriptor: {
      artifactId: "a", name: `safe.${viewKind}`, safeMime: ["markdown", "text", "source"].includes(viewKind) ? "text/plain; charset=utf-8" : `application/${viewKind}`,
      size: 4, digest: "a".repeat(64), viewKind, activeContent: false, requiresWarning: viewKind === "download-only",
      expiresAt: "2030-01-01T00:00:00.000Z", correlationId: "corr", ...overrides,
    },
  };
}

describe("M50-02 Web ArtifactContentViewer", () => {
  beforeEach(() => {
    authFetchMock.mockReset();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:artifact-preview") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  });
  afterEach(() => vi.restoreAllMocks());

  it("uses only the server grant with no-store/no-referrer and restores text position", async () => {
    authFetchMock.mockResolvedValue(new Response("safe", { headers: { "content-length": "4" } }));
    const onPositionChange = vi.fn();
    render(<ArtifactContentViewer grant={grant("text")} position={{ scrollTop: 42 }} onPositionChange={onPositionChange} />);
    const text = await screen.findByText("safe");
    expect(authFetchMock).toHaveBeenCalledWith(
      "/api/artifacts/a/content?token=redacted",
      expect.objectContaining({ cache: "no-store", referrerPolicy: "no-referrer" }),
    );
    fireEvent.scroll(text.parentElement!, { target: { scrollTop: 88 } });
    expect(onPositionChange).toHaveBeenCalledWith({ scrollTop: 88 });
  });

  it("renders Markdown at a readable width without raw HTML or remote image loading", async () => {
    authFetchMock.mockResolvedValue(new Response("# 标题\n\n<script>window.pwned=1</script>\n\n![远程图](https://evil.test/a.png)\n\n[链接](https://example.com)"));
    render(<ArtifactContentViewer grant={grant("markdown", { name: "说明.md", safeMime: "text/plain; charset=utf-8", size: 100 })} />);
    const heading = await screen.findByRole("heading", { name: "标题" });
    expect(heading.closest(`.${"max-w-\\[72ch\\]"}`)).toBeTruthy();
    expect(screen.queryByText("window.pwned=1")).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("[图片已阻止：远程图]")).toBeTruthy();
    expect(screen.getByRole("link", { name: "链接" }).getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("runs HTML only inside an opaque no-network sandbox", async () => {
    authFetchMock.mockResolvedValue(new Response("<!doctype html><script>document.body.dataset.ran='1'</script>"));
    render(<ArtifactContentViewer grant={grant("html", { name: "演示.html", safeMime: "text/html; charset=utf-8", size: 64, activeContent: true, requiresWarning: true })} />);
    const frame = await screen.findByTitle("演示.html");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("srcdoc")).toContain("connect-src 'none'");
    expect(frame.getAttribute("srcdoc")).toContain("form-action 'none'");
    expect(frame.getAttribute("srcdoc")).toContain("document.body.dataset.ran");
  });

  it("renders active source as inert text and warns only when it is downloaded", async () => {
    authFetchMock.mockResolvedValue(new Response("#!/bin/sh\necho safe"));
    render(<ArtifactContentViewer grant={grant("source", { name: "run.sh", size: 19, activeContent: true, requiresWarning: true })} />);
    expect(await screen.findByText(/echo safe/)).toBeTruthy();
    expect(screen.queryByTitle("run.sh")).toBeNull();
  });

  it("range-loads and labels large text instead of rejecting the preview", async () => {
    authFetchMock.mockResolvedValue(new Response("large prefix", { status: 206 }));
    render(<ArtifactContentViewer grant={grant("text", { size: 3 * 1024 * 1024 })} />);
    expect((await screen.findByRole("status")).textContent).toContain("仅显示前 2 MiB");
    expect(authFetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ headers: expect.objectContaining({ Range: "bytes=0-2097151" }) }),
    );
  });

  it("never executes active/download-only content", async () => {
    render(<ArtifactContentViewer grant={grant("download-only", { activeContent: true, requiresWarning: true, safeMime: "application/octet-stream" })} />);
    expect((await screen.findByRole("alert")).textContent).toContain("不能安全在线预览");
    expect(authFetchMock).not.toHaveBeenCalled();
    expect(screen.queryByTitle(/safe/)).toBeNull();
  });

  it("does not mislabel ordinary Office files as risky", async () => {
    render(<ArtifactContentViewer grant={grant("download-only", { name: "方案.docx", requiresWarning: false, safeMime: "application/octet-stream" })} />);
    expect((await screen.findByRole("alert")).textContent).toContain("暂不支持在线预览");
    expect((await screen.findByRole("alert")).textContent).not.toContain("确认风险");
  });

  it("uses sandboxed native PDF iframe backed by a revoked Blob URL", async () => {
    authFetchMock.mockResolvedValue(new Response(new Blob(["%PDF"], { type: "application/pdf" }), { status: 200 }));
    const { unmount } = render(<ArtifactContentViewer grant={grant("pdf", { name: "safe.pdf", safeMime: "application/pdf" })} />);
    const frame = await screen.findByTitle("safe.pdf");
    expect(frame.getAttribute("src")).toBe("blob:artifact-preview#page=1");
    expect(frame.getAttribute("sandbox")).toBe("");
    unmount();
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:artifact-preview"));
  });

  it("keeps signed-resource authorization failures local without logging the URL", async () => {
    authFetchMock.mockResolvedValue(new Response("", { status: 423 }));
    const failure = vi.fn();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<ArtifactContentViewer grant={grant("image", { safeMime: "image/png" })} onAuthorizationFailure={failure} />);
    expect((await screen.findByRole("alert")).textContent).toContain("HTTP 423");
    expect(failure).toHaveBeenCalledWith(423, "quarantine");
    expect(consoleSpy).not.toHaveBeenCalled();
  });
});

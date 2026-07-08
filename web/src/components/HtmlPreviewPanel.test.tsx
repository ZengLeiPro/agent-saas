import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HtmlPreviewPanel } from "./HtmlPreviewPanel";
import { authFetch } from "@/lib/authFetch";

vi.mock("@/lib/authFetch", () => ({
  authFetch: vi.fn(),
}));

describe("HtmlPreviewPanel", () => {
  beforeEach(() => {
    vi.mocked(authFetch).mockReset();
    vi.unstubAllGlobals();
  });

  it("renders workspace HTML through a srcDoc sandbox without same-origin access", async () => {
    vi.mocked(authFetch).mockResolvedValueOnce(
      new Response("<html><head></head><body><script>window.ok = true</script></body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    );

    render(<HtmlPreviewPanel filePath="assets/demo.html" onBack={vi.fn()} />);

    await waitFor(() => {
      expect(authFetch).toHaveBeenCalledWith("/api/file/download?path=assets%2Fdemo.html");
    });

    const iframe = await screen.findByTitle("demo.html");
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
    expect(iframe.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(iframe.getAttribute("srcdoc")).toContain("Content-Security-Policy");
    expect(iframe.getAttribute("srcdoc")).toContain("connect-src 'none'");
  });

  it("loads shared HTML from the share file endpoint before sandboxing it", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response("<!doctype html><html><body>share</body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<HtmlPreviewPanel filePath="assets/演示.html" shareToken="share 1" onBack={vi.fn()} />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/share/sessions/share%201/file?path=assets%2F%E6%BC%94%E7%A4%BA.html",
      );
    });

    const iframe = await screen.findByTitle("演示.html");
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
    expect(iframe.getAttribute("srcdoc")).toContain("share");
  });
});

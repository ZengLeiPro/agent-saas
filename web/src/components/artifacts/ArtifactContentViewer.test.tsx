import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactReadGrant } from "@agent/shared";
import { ArtifactContentViewer } from "@/components/artifacts/ArtifactContentViewer";

const authFetchMock = vi.fn();
vi.mock("@agent/shared", async (importOriginal) => ({
  ...await importOriginal<typeof import("@agent/shared")>(),
  authFetch: (...args: unknown[]) => authFetchMock(...args),
}));

function grant(viewKind: ArtifactReadGrant["descriptor"]["viewKind"], overrides: Partial<ArtifactReadGrant["descriptor"]> = {}): ArtifactReadGrant {
  return {
    readUrl: "/api/artifacts/a/content?token=redacted",
    descriptor: {
      artifactId: "a", name: `safe.${viewKind}`, safeMime: viewKind === "text" ? "text/plain; charset=utf-8" : `application/${viewKind}`,
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
    expect(authFetchMock).toHaveBeenCalledWith("/api/artifacts/a/content?token=redacted", expect.objectContaining({ cache: "no-store", referrerPolicy: "no-referrer" }));
    fireEvent.scroll(text, { target: { scrollTop: 88 } });
    expect(onPositionChange).toHaveBeenCalledWith({ scrollTop: 88 });
  });

  it("never executes active/download-only content", async () => {
    render(<ArtifactContentViewer grant={grant("download-only", { activeContent: true, requiresWarning: true, safeMime: "application/octet-stream" })} />);
    expect((await screen.findByRole("alert")).textContent).toContain("不能安全在线预览");
    expect(authFetchMock).not.toHaveBeenCalled();
    expect(screen.queryByTitle(/safe/)).toBeNull();
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

  it("maps authorization/quarantine failures without logging the signed URL", async () => {
    authFetchMock.mockResolvedValue(new Response("", { status: 423 }));
    const failure = vi.fn();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<ArtifactContentViewer grant={grant("image", { safeMime: "image/png" })} onAuthorizationFailure={failure} />);
    expect((await screen.findByRole("alert")).textContent).toContain("HTTP 423");
    expect(failure).toHaveBeenCalledWith(423, "quarantine");
    expect(consoleSpy).not.toHaveBeenCalled();
  });
});

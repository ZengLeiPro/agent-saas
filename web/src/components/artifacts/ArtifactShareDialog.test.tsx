import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  getArtifactShare: vi.fn(),
  createArtifactShare: vi.fn(),
  revokeArtifactShare: vi.fn(),
  publicArtifactPageUrl: vi.fn(),
}));
vi.mock("@/lib/artifactShareApi", () => apiMocks);

import { ArtifactShareDialog } from "@/components/artifacts/ArtifactShareDialog";

describe("ArtifactShareDialog", () => {
  beforeEach(() => {
    apiMocks.getArtifactShare.mockReset().mockResolvedValue({ enabled: false });
    apiMocks.createArtifactShare.mockReset().mockResolvedValue({ enabled: true, token: "share-token" });
    apiMocks.revokeArtifactShare.mockReset();
    apiMocks.publicArtifactPageUrl.mockReset().mockReturnValue("https://example.com/public/artifacts/share-token");
  });

  it("必须勾选公开确认后才能生成默认 7 天链接", async () => {
    const now = new Date("2026-08-22T08:00:00.000Z").valueOf();
    vi.spyOn(Date, "now").mockReturnValue(now);
    render(<ArtifactShareDialog open artifactId="artifact-1" fileName="report.pdf" onOpenChange={vi.fn()} />);

    const generate = await screen.findByRole("button", { name: "生成链接" }) as HTMLButtonElement;
    await waitFor(() => expect(generate.disabled).toBe(true));
    fireEvent.click(screen.getByRole("checkbox", { name: "确认公开 Artifact" }));
    expect(generate.disabled).toBe(false);
    fireEvent.click(generate);

    await waitFor(() => expect(apiMocks.createArtifactShare).toHaveBeenCalledWith("artifact-1", {
      confirmPublicArtifact: true,
      expiresAt: "2026-08-29T08:00:00.000Z",
      allowDownload: true,
    }));
    vi.restoreAllMocks();
  });
});

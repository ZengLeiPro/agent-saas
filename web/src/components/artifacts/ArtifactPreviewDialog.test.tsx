import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ArtifactPreviewDialog } from "./ArtifactPreviewDialog";

vi.mock("@/lib/artifactShareApi", () => ({
  ArtifactReadError: class ArtifactReadError extends Error {},
  getArtifactReadGrant: vi.fn(() => new Promise(() => {})),
}));

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ identity: { tenantId: "kaiyan", userId: "u1", generation: 1 } }),
}));

vi.mock("@/components/artifacts/ArtifactContentViewer", () => ({
  ArtifactContentViewer: () => <div>Artifact 内容</div>,
}));

vi.mock("@/components/artifacts/ArtifactShareDialog", () => ({
  ArtifactShareDialog: () => null,
}));

describe("ArtifactPreviewDialog", () => {
  it("桌面端提供右侧打开按钮并触发停靠", () => {
    const onDock = vi.fn();
    render(
      <ArtifactPreviewDialog
        open
        artifactId="artifact-1"
        fileName="验收报告.pdf"
        mimeType="application/pdf"
        onOpenChange={vi.fn()}
        onDock={onDock}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "在右侧预览栏打开" }));
    expect(onDock).toHaveBeenCalledTimes(1);
  });

  it("没有右侧预览能力时不显示停靠按钮", () => {
    render(
      <ArtifactPreviewDialog
        open
        artifactId="artifact-1"
        fileName="验收报告.pdf"
        onOpenChange={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: "在右侧预览栏打开" })).toBeNull();
  });
});

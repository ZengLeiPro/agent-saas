import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactReadGrant } from "@agent/shared";

import { ArtifactPreviewDialog, downloadArtifact } from "./ArtifactPreviewDialog";

const mocks = vi.hoisted(() => ({
  getArtifactReadGrant: vi.fn(),
  authFetchResource: vi.fn(),
  auth: { identity: { tenantId: "kaiyan", userId: "u1", generation: 1 } },
}));

vi.mock("@agent/shared", async (importOriginal) => ({
  ...await importOriginal<typeof import("@agent/shared")>(),
  authFetchResource: (...args: unknown[]) => mocks.authFetchResource(...args),
}));

vi.mock("@/lib/artifactShareApi", () => ({
  ArtifactReadError: class ArtifactReadError extends Error {
    constructor(readonly status: number, readonly reason?: string) { super("读取 Artifact 失败"); }
  },
  getArtifactReadGrant: (...args: unknown[]) => mocks.getArtifactReadGrant(...args),
}));

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => mocks.auth,
}));

vi.mock("@/components/artifacts/ArtifactContentViewer", () => ({
  ArtifactContentViewer: ({ grant, onAuthorizationFailure }: {
    grant: ArtifactReadGrant;
    onAuthorizationFailure: (status: number) => void;
  }) => <button onClick={() => onAuthorizationFailure(401)}>触发资源 401：{grant.readUrl}</button>,
}));

vi.mock("@/components/artifacts/ArtifactShareDialog", () => ({
  ArtifactShareDialog: () => null,
}));

function grant(readUrl = "/api/artifacts/artifact-1/content?token=grant-1"): ArtifactReadGrant {
  return {
    readUrl,
    descriptor: {
      artifactId: "artifact-1",
      name: "验收报告.pdf",
      safeMime: "application/pdf",
      size: 4,
      digest: "a".repeat(64),
      viewKind: "pdf",
      activeContent: false,
      requiresWarning: false,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      correlationId: "corr-1",
    },
  };
}

function renderDialog(onDock?: () => void) {
  return render(
    <ArtifactPreviewDialog
      open
      artifactId="artifact-1"
      fileName="验收报告.pdf"
      mimeType="application/pdf"
      onOpenChange={vi.fn()}
      onDock={onDock}
    />,
  );
}

describe("ArtifactPreviewDialog", () => {
  beforeEach(() => {
    mocks.getArtifactReadGrant.mockReset().mockImplementation(() => new Promise(() => {}));
    mocks.authFetchResource.mockReset();
    mocks.auth.identity = { tenantId: "kaiyan", userId: "u1", generation: 1 };
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:artifact-download") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  });

  it("桌面端提供右侧打开按钮并触发停靠", () => {
    const onDock = vi.fn();
    renderDialog(onDock);

    fireEvent.click(screen.getByRole("button", { name: "在右侧预览栏打开" }));
    expect(onDock).toHaveBeenCalledTimes(1);
  });

  it("没有右侧预览能力时不显示停靠按钮", () => {
    renderDialog();
    expect(screen.queryByRole("button", { name: "在右侧预览栏打开" })).toBeNull();
  });

  it("资源 401 只刷新一次，连续失败后局部提示链接失效", async () => {
    mocks.getArtifactReadGrant.mockReset().mockResolvedValue(grant());
    renderDialog();

    fireEvent.click(await screen.findByRole("button", { name: /触发资源 401/ }));
    await waitFor(() => expect(mocks.getArtifactReadGrant).toHaveBeenCalledTimes(2));
    fireEvent.click(await screen.findByRole("button", { name: /触发资源 401/ }));

    expect(await screen.findByText("文件链接已失效，请重试。")).toBeTruthy();
    expect(screen.queryByText("重新登录")).toBeNull();
  });

  it("身份切换会取消旧 grant，并只展示新身份请求结果", async () => {
    let resolveOld!: (value: ArtifactReadGrant) => void;
    const oldGrant = new Promise<ArtifactReadGrant>((resolve) => { resolveOld = resolve; });
    mocks.getArtifactReadGrant.mockReset()
      .mockReturnValueOnce(oldGrant)
      .mockResolvedValue(grant("/api/artifacts/artifact-1/content?token=new-owner"));
    const view = renderDialog();
    await waitFor(() => expect(mocks.getArtifactReadGrant).toHaveBeenCalledTimes(1));

    mocks.auth.identity = { tenantId: "kaiyan", userId: "u2", generation: 2 };
    view.rerender(
      <ArtifactPreviewDialog open artifactId="artifact-1" fileName="验收报告.pdf" onOpenChange={vi.fn()} />,
    );
    await waitFor(() => expect(mocks.getArtifactReadGrant).toHaveBeenCalledTimes(2));
    resolveOld(grant("/api/artifacts/artifact-1/content?token=old-owner"));

    expect(await screen.findByRole("button", { name: /new-owner/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /old-owner/ })).toBeNull();
  });

  it("下载内容 401 会续取一次 grant，并通过 Blob 完成下载", async () => {
    mocks.getArtifactReadGrant.mockReset().mockResolvedValue(grant());
    mocks.authFetchResource
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(new Response("file", { status: 200 }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    await downloadArtifact("artifact-1", "验收报告.pdf");

    expect(mocks.getArtifactReadGrant).toHaveBeenCalledTimes(2);
    expect(mocks.authFetchResource).toHaveBeenCalledTimes(2);
    expect(mocks.authFetchResource).toHaveBeenLastCalledWith(
      expect.stringContaining("token=grant-1"),
      expect.objectContaining({ cache: "no-store", referrerPolicy: "no-referrer" }),
    );
    expect(click).toHaveBeenCalledTimes(1);
  });
});

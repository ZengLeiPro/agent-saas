import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ManagementSettingsAccess } from "@/hooks/useManagementSettingsAccess";
import { ManagementSettingsAccessGate } from "./ManagementSettingsAccessGate";
import { ImageLightbox } from "./ImageLightbox";

function allowedAccess(status: ManagementSettingsAccess["status"]): ManagementSettingsAccess {
  return {
    status,
    personalAllowed: true,
    tenantEntryAllowed: true,
    platformEntryAllowed: false,
    retry: vi.fn(),
  };
}

describe("ImageLightbox portal boundary", () => {
  it("Gate 内使用本地容器，inactive 时隐藏，refreshing 时保持交互", () => {
    const onClose = vi.fn();
    const gate = (target: "personal" | "tenant", status: ManagementSettingsAccess["status"] = "ready") => (
      <ManagementSettingsAccessGate
        persistAfterVisit
        scope="tenant"
        target={target}
        access={allowedAccess(status)}
        onRetry={vi.fn()}
        onReturnPersonal={vi.fn()}
      >
        <ImageLightbox src="/draft.png" alt="草稿" onClose={onClose} />
      </ManagementSettingsAccessGate>
    );
    const { rerender } = render(gate("tenant"));
    const lightbox = screen.getByRole("dialog", { name: "预览图片：草稿" });
    const portalContainer = screen.getByTestId("management-settings-tenant-portal-container");
    expect(portalContainer.contains(lightbox)).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(gate("personal"));
    const workspace = screen.getByTestId("management-settings-tenant-workspace");
    expect(workspace.className).toContain("hidden");
    expect(workspace.contains(screen.getByRole("dialog", { hidden: true }))).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(gate("tenant", "refreshing"));
    expect(lightbox.closest("[inert]")).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("普通页面仍 portal 到 body 并响应 Escape", () => {
    const onClose = vi.fn();
    render(<ImageLightbox src="/ordinary.png" alt="普通图片" onClose={onClose} />);

    const lightbox = screen.getByRole("dialog", { name: "预览图片：普通图片" });
    expect(lightbox.parentElement).toBe(document.body);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

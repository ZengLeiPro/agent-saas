import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AssetLibraryDialog } from "./AssetLibraryDialog";

vi.mock("@/components/FileBrowser/useFileList", () => ({
  useFileList: () => ({
    entries: [
      { name: "资料", path: "assets/资料", isDirectory: true, size: 0, modifiedAt: 1, extension: "" },
      { name: "方案.pdf", path: "assets/方案.pdf", isDirectory: false, size: 1024, modifiedAt: 1, extension: ".pdf" },
    ],
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

vi.mock("@/components/FileBrowser/fileIcons", () => ({
  FileIconTile: () => <span data-testid="file-icon" />,
}));

describe("AssetLibraryDialog", () => {
  it("多选 assets 文件并确认添加", async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const onOpenChange = vi.fn();
    render(
      <AssetLibraryDialog
        open
        onOpenChange={onOpenChange}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /方案\.pdf/ }));
    fireEvent.click(screen.getByRole("button", { name: "添加 1 个文件" }));

    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledWith(["assets/方案.pdf"]);
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });
});

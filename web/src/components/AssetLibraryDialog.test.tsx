import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AssetLibraryDialog } from "./AssetLibraryDialog";

const mocks = vi.hoisted(() => ({ entries: [] as Array<{
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: number;
  extension: string;
}> }));

vi.mock("@/components/FileBrowser/useFileList", () => ({
  useFileList: () => ({
    entries: mocks.entries,
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

vi.mock("@/components/FileBrowser/fileIcons", () => ({
  FileIconTile: () => <span data-testid="file-icon" />,
}));

function fileEntry(index: number) {
  return {
    name: `资料-${index}.pdf`,
    path: `assets/资料-${index}.pdf`,
    isDirectory: false,
    size: 1024,
    modifiedAt: 1,
    extension: ".pdf",
  };
}

describe("AssetLibraryDialog", () => {
  beforeEach(() => {
    mocks.entries = [
      { name: "资料", path: "assets/资料", isDirectory: true, size: 0, modifiedAt: 1, extension: "" },
      { name: "方案.pdf", path: "assets/方案.pdf", isDirectory: false, size: 1024, modifiedAt: 1, extension: ".pdf" },
    ];
  });

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

  it("选择第 21 个文件时明确提示上限并保留前 20 个选择", () => {
    mocks.entries = Array.from({ length: 21 }, (_, index) => fileEntry(index + 1));
    const onConfirm = vi.fn();
    render(
      <AssetLibraryDialog
        open
        onOpenChange={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    const fileButtons = screen.getAllByRole("button").filter((button) => button.textContent?.startsWith("资料-"));
    expect(fileButtons).toHaveLength(21);
    fileButtons.forEach((button) => fireEvent.click(button));

    expect(screen.getByRole("alert").textContent).toContain("单次最多添加 20 个文件");
    expect(screen.getAllByText(/已选择 20 个/).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "添加 20 个文件" })).toBeTruthy();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

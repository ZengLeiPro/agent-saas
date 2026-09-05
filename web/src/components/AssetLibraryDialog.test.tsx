import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AssetLibraryDialog } from "./AssetLibraryDialog";

interface MockEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: number;
  extension: string;
}

const mocks = vi.hoisted(() => ({
  entries: [] as MockEntry[],
  allEntries: [] as MockEntry[],
  listCalls: [] as Array<{ path: string; recursive?: boolean }>,
}));

vi.mock("@/components/FileBrowser/useFileList", () => ({
  useFileList: (path: string, _owner?: string, recursive?: boolean) => {
    mocks.listCalls.push({ path, recursive });
    return {
      entries: recursive ? mocks.allEntries : mocks.entries,
      loading: false,
      loadingMore: false,
      error: null,
      hasMore: false,
      refresh: vi.fn(),
      loadMore: vi.fn(),
    };
  },
}));

vi.mock("@/components/FileBrowser/fileIcons", () => ({
  FileIconTile: () => <span data-testid="file-icon" />,
}));

function fileEntry(index: number): MockEntry {
  return {
    name: `资料-${index}.pdf`,
    path: `assets/资料-${index}.pdf`,
    isDirectory: false,
    size: 1024,
    modifiedAt: index,
    extension: ".pdf",
  };
}

function renderDialog(onConfirm = vi.fn()) {
  render(
    <AssetLibraryDialog
      open
      onOpenChange={vi.fn()}
      onConfirm={onConfirm}
    />,
  );
}

describe("AssetLibraryDialog", () => {
  beforeEach(() => {
    mocks.entries = [
      { name: "资料", path: "assets/资料", isDirectory: true, size: 0, modifiedAt: 1, extension: "" },
      { name: "方案.pdf", path: "assets/方案.pdf", isDirectory: false, size: 1024, modifiedAt: 1, extension: ".pdf" },
    ];
    mocks.allEntries = [];
    mocks.listCalls = [];
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

  it("所有文件视图递归读取并展示文件所在目录", () => {
    mocks.allEntries = [
      {
        name: "合同.pdf",
        path: "assets/客户资料/合同.pdf",
        isDirectory: false,
        size: 2048,
        modifiedAt: 2,
        extension: ".pdf",
      },
    ];
    renderDialog();

    fireEvent.click(screen.getAllByRole("button", { name: "所有文件" })[0]);

    expect(mocks.listCalls).toContainEqual({ path: "assets", recursive: true });
    expect(screen.getByRole("button", { name: /合同\.pdf/ }).textContent).toContain("客户资料");
  });

  it("支持按名称切换升序和降序", () => {
    mocks.entries = [
      { ...fileEntry(1), name: "B.pdf", path: "assets/B.pdf" },
      { ...fileEntry(2), name: "A.pdf", path: "assets/A.pdf" },
    ];
    renderDialog();

    const sortButton = screen.getByRole("button", { name: "按名称排序" });
    fireEvent.click(sortButton);
    expect(
      screen.getByRole("button", { name: /A\.pdf/ }).compareDocumentPosition(
        screen.getByRole("button", { name: /B\.pdf/ }),
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    fireEvent.click(sortButton);
    expect(
      screen.getByRole("button", { name: /B\.pdf/ }).compareDocumentPosition(
        screen.getByRole("button", { name: /A\.pdf/ }),
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("选择第 21 个文件时明确提示上限并保留前 20 个选择", () => {
    mocks.entries = Array.from({ length: 21 }, (_, index) => fileEntry(index + 1));
    const onConfirm = vi.fn();
    renderDialog(onConfirm);

    const fileButtons = screen.getAllByRole("button").filter((button) => button.textContent?.startsWith("资料-"));
    expect(fileButtons).toHaveLength(21);
    fileButtons.forEach((button) => fireEvent.click(button));

    expect(screen.getByRole("alert").textContent).toContain("单次最多添加 20 个文件");
    expect(screen.getAllByText(/已选择 20 个/).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "添加 20 个文件" })).toBeTruthy();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

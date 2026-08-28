import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { FileUpload } from "./FileUpload";

const imageFiles = [
  {
    originalName: "第一张图片.png",
    relativePath: "uploads/first.png",
    size: 1024,
    mimeType: "image/png",
    isImage: true,
    previewUrl: "blob:first-image",
  },
  {
    originalName: "第二张图片.png",
    relativePath: "uploads/second.png",
    size: 2048,
    mimeType: "image/png",
    isImage: true,
    previewUrl: "blob:second-image",
  },
];

describe("FileUpload 图片预览", () => {
  it("点击图片附件打开预览，且不会触发删除", () => {
    const onRemoveFile = vi.fn();
    render(<FileUpload uploadedFiles={imageFiles} onRemoveFile={onRemoveFile} />);

    fireEvent.click(screen.getByRole("button", { name: "预览图片：第一张图片.png" }));

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("img", { name: "第一张图片.png" })).toBeTruthy();
    expect(onRemoveFile).not.toHaveBeenCalled();
  });

  it("支持在多张已添加图片之间切换预览", () => {
    render(<FileUpload uploadedFiles={imageFiles} onRemoveFile={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "预览图片：第一张图片.png" }));
    fireEvent.click(screen.getByRole("button", { name: "下一张图片" }));

    expect(screen.getByRole("img", { name: "第二张图片.png" })).toBeTruthy();
  });

  it("重新打开后可通过远端地址预览没有 blob URL 的图片", async () => {
    const persistedImage = { ...imageFiles[0], previewUrl: undefined };
    const resolveFileUrl = vi.fn(async () => "/api/taskboard/tasks/task-1/attachments/attachment-1?token=test");
    render(
      <FileUpload
        uploadedFiles={[persistedImage]}
        onRemoveFile={vi.fn()}
        resolveFileUrl={resolveFileUrl}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "预览图片：第一张图片.png" }));

    const image = await screen.findByRole("img", { name: "第一张图片.png" });
    expect(image.getAttribute("src")).toBe("/api/taskboard/tasks/task-1/attachments/attachment-1?token=test");
    expect(resolveFileUrl).toHaveBeenCalledWith(persistedImage, false);
  });
});

import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { initPlatform, type PlatformDeps, type TaskBoardAttachment } from "@agent/shared";
import { TaskAttachmentList } from "./TaskAttachments";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";

beforeAll(() => {
  initPlatform({
    secureStorage: {
      getItem: async () => "test-token",
      setItem: async () => {},
      removeItem: async () => {},
    },
    platformConfig: { getBaseUrl: () => "https://api.example.com" },
  } as unknown as PlatformDeps);
});

const imageAttachment: TaskBoardAttachment = {
  attachmentId: "11111111-1111-4111-8111-111111111111",
  originalName: "现场图.png",
  relativePath: "taskboard/attachments/task-1/11111111-1111-4111-8111-111111111111-现场图.png",
  size: 123,
  mimeType: "image/png",
  isImage: true,
};

const fileAttachment: TaskBoardAttachment = {
  attachmentId: "22222222-2222-4222-8222-222222222222",
  originalName: "记录.json",
  relativePath: "taskboard/attachments/task-1/22222222-2222-4222-8222-222222222222-记录.json",
  size: 456,
  mimeType: "application/json",
  isImage: false,
};

describe("TaskAttachmentList", () => {
  it("点击评论图片时在当前页面打开预览，而不是触发下载导航", async () => {
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    try {
      render(<TaskAttachmentList taskId="task-1" attachments={[imageAttachment]} />);

      fireEvent.click(screen.getByRole("button", { name: "预览图片：现场图.png" }));

      const image = await screen.findByAltText("现场图.png");
      expect(image.getAttribute("src")).toBe(
        "https://api.example.com/api/taskboard/tasks/task-1/attachments/11111111-1111-4111-8111-111111111111?token=test-token",
      );
      expect(screen.getByRole("dialog", { name: "预览图片：现场图.png" }).parentElement).toBe(document.body);
      expect(clickSpy).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "关闭预览" }));
      expect(screen.queryByAltText("现场图.png")).toBeNull();
    } finally {
      clickSpy.mockRestore();
    }
  });

  it("任务详情 Sheet 内的预览层保留在 Sheet 中，以接收关闭操作", async () => {
    render(
      <Sheet open>
        <SheetContent data-testid="task-detail-sheet" aria-describedby={undefined}>
          <SheetTitle className="sr-only">任务详情</SheetTitle>
          <TaskAttachmentList taskId="task-1" attachments={[imageAttachment]} />
        </SheetContent>
      </Sheet>,
    );

    fireEvent.click(screen.getByRole("button", { name: "预览图片：现场图.png" }));

    const lightbox = await screen.findByRole("dialog", { name: "预览图片：现场图.png" });
    expect(screen.getByTestId("task-detail-sheet").contains(lightbox)).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "关闭预览" }));
    expect(screen.queryByRole("dialog", { name: "预览图片：现场图.png" })).toBeNull();
  });

  it("非图片附件仍按下载方式处理", async () => {
    const clicked: Array<{ href: string; download: string }> = [];
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.href, download: this.download });
    });
    try {
      render(<TaskAttachmentList taskId="task-1" attachments={[fileAttachment]} />);

      fireEvent.click(screen.getByRole("button", { name: "下载：记录.json" }));

      await waitFor(() => expect(clicked).toEqual([{
        href: "https://api.example.com/api/taskboard/tasks/task-1/attachments/22222222-2222-4222-8222-222222222222?download=1&token=test-token",
        download: "记录.json",
      }]));
    } finally {
      clickSpy.mockRestore();
    }
  });
});

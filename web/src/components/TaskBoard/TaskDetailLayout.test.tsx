import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useTaskDescriptionResize } from "./TaskDetailLayout";

function Harness() {
  const [value, setValue] = useState("");
  const { viewportRef, contentRef, textareaRef } = useTaskDescriptionResize({
    active: true,
    open: true,
    taskId: "task-1",
  });
  return (
    <div ref={viewportRef} data-testid="viewport">
      <div ref={contentRef} data-testid="content">
        <textarea ref={textareaRef} aria-label="正文" value={value} onChange={(event) => setValue(event.target.value)} />
      </div>
    </div>
  );
}

describe("任务详情布局", () => {
  it("正文输入框按内容和剩余空间伸缩，空间不足时内部滚动", () => {
    render(<Harness />);
    const textarea = screen.getByRole("textbox", { name: "正文" }) as HTMLTextAreaElement;
    const viewport = screen.getByTestId("viewport");
    const content = screen.getByTestId("content");
    let naturalHeight = 240;
    Object.defineProperty(textarea, "scrollHeight", { configurable: true, get: () => naturalHeight });
    Object.defineProperty(textarea, "offsetHeight", {
      configurable: true,
      get: () => Number.parseFloat(textarea.style.height) || 0,
    });
    Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 500 });
    Object.defineProperty(content, "scrollHeight", { configurable: true, value: 400 });

    fireEvent.change(textarea, { target: { value: "长正文".repeat(100) } });
    const constrainedHeight = Number.parseFloat(textarea.style.height);
    expect(constrainedHeight).toBeGreaterThan(100);
    expect(constrainedHeight).toBeLessThan(naturalHeight);
    expect(textarea.style.overflowY).toBe("auto");

    naturalHeight = 100;
    fireEvent.change(textarea, { target: { value: "较短正文" } });
    expect(Number.parseFloat(textarea.style.height)).toBe(100);
    expect(textarea.style.overflowY).toBe("hidden");
  });
});

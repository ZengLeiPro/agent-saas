import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DisplaySettingsMenu } from "./DisplaySettingsMenu";

describe("DisplaySettingsMenu", () => {
  it("通过一个入口设置消息宽度和字体大小", () => {
    const onFontSizeChange = vi.fn();
    const onWidthChange = vi.fn();

    render(
      <DisplaySettingsMenu
        isLarge={false}
        isWide={false}
        onFontSizeChange={onFontSizeChange}
        onWidthChange={onWidthChange}
      />,
    );

    const trigger = screen.getByRole("button", { name: "显示设置" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("dialog", { name: "显示设置" })).toBeTruthy();
    expect(screen.getByText("消息宽度")).toBeTruthy();
    expect(screen.getByText("字体大小")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "宽" }));
    fireEvent.click(screen.getByRole("button", { name: "大" }));
    expect(onWidthChange).toHaveBeenCalledWith(true);
    expect(onFontSizeChange).toHaveBeenCalledWith(true);
  });

  it("支持点击外部和 Escape 关闭", () => {
    render(
      <DisplaySettingsMenu
        isLarge={false}
        isWide={false}
        onFontSizeChange={vi.fn()}
        onWidthChange={vi.fn()}
      />,
    );

    const trigger = screen.getByRole("button", { name: "显示设置" });
    fireEvent.click(trigger);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("dialog", { name: "显示设置" })).toBeNull();

    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "显示设置" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

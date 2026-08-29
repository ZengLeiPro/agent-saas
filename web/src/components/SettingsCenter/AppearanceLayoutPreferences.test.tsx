import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppearanceLayoutPreferences } from "./AppearanceLayoutPreferences";

describe("AppearanceLayoutPreferences", () => {
  it("在外观设置中调整会话字体大小", () => {
    const onChatFontSizeChange = vi.fn();

    render(
      <AppearanceLayoutPreferences
        chatFontLarge={false}
        onChatFontSizeChange={onChatFontSizeChange}
        sidebarLayout="double"
        onSidebarLayoutChange={vi.fn()}
        showSessionListAvatar={false}
        onShowSessionListAvatarChange={vi.fn()}
      />,
    );

    expect(screen.getByText("会话字体大小")).toBeTruthy();
    expect(screen.getByRole("button", { name: "小" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "大" }));
    expect(onChatFontSizeChange).toHaveBeenCalledWith(true);
  });
});

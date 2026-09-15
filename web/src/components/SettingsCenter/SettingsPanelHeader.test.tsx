import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SettingsPanelHeader } from "./SettingsPanelHeader";

describe("SettingsPanelHeader", () => {
  it("页面说明只在标题旁 hover 显示，点击不会钉住", () => {
    render(<SettingsPanelHeader title="账户与安全" description="账号资料、安全和登录状态。" />);

    expect(screen.getByRole("heading", { level: 2, name: "账户与安全" })).toBeTruthy();
    expect(screen.queryByText("账号资料、安全和登录状态。")).toBeNull();

    const tip = screen.getByRole("button", { name: "查看说明" });
    fireEvent.pointerEnter(tip);
    expect(screen.getByRole("tooltip").textContent).toContain("账号资料、安全和登录状态。");

    fireEvent.click(tip);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("tooltip")).toBeTruthy();

    fireEvent.pointerLeave(tip);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});

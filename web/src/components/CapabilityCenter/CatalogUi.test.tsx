// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Plus } from "lucide-react";
import { CapabilityLogo, CatalogToolbar, ConnectorCatalogCard } from "./CatalogUi";

describe("ConnectorCatalogCard", () => {
  it("整卡支持键盘打开详情，快捷动作不会冒泡触发详情", () => {
    const onOpenDetail = vi.fn();
    const onAction = vi.fn();
    render(
      <ConnectorCatalogCard
        name="测试连接器"
        logo={<CapabilityLogo label="测试连接器" />}
        source="platform"
        statusLabel="未连接"
        statusClassName="text-muted-foreground"
        description="用于验证统一连接器卡片的交互。"
        metadata="官方 CLI：test"
        onOpenDetail={onOpenDetail}
        actionLabel="连接 测试连接器"
        actionIcon={<Plus />}
        onAction={onAction}
      />,
    );

    const card = screen.getByRole("button", { name: "查看 测试连接器 详情" });
    fireEvent.keyDown(card, { key: "Enter" });
    expect(onOpenDetail).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "连接 测试连接器" }));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onOpenDetail).toHaveBeenCalledTimes(1);
  });
});

describe("CatalogToolbar", () => {
  it("支持斜杠快捷键聚焦搜索框", () => {
    render(
      <CatalogToolbar
        query=""
        onQueryChange={vi.fn()}
        searchPlaceholder="搜索能力"
      />,
    );

    const input = screen.getByRole("searchbox", { name: "搜索能力" });
    fireEvent.keyDown(window, { key: "/" });
    expect(document.activeElement).toBe(input);
  });

  it("只保留一个清除按钮：原生 search 清除键被关掉，快捷键提示让位", () => {
    const { rerender } = render(
      <CatalogToolbar query="" onQueryChange={vi.fn()} searchPlaceholder="搜索能力" />,
    );
    // 空态：显示快捷键提示，没有清除按钮
    expect(screen.getByText("/")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "清空搜索" })).toBeNull();

    rerender(<CatalogToolbar query="报表" onQueryChange={vi.fn()} searchPlaceholder="搜索能力" />);
    // 有内容：只剩自定义清除按钮，且浏览器自带的 ::-webkit-search-cancel-button 已被关掉，
    // 否则输入框右侧会并排出现两个 ✕
    expect(screen.getByRole("button", { name: "清空搜索" })).toBeTruthy();
    expect(screen.queryByText("/")).toBeNull();
    expect(screen.getByRole("searchbox", { name: "搜索能力" }).className).toContain(
      "[&::-webkit-search-cancel-button]:appearance-none",
    );
  });
});

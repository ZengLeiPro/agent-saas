// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Plus } from "lucide-react";
import { CapabilityLogo, ConnectorCatalogCard } from "./CatalogUi";

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

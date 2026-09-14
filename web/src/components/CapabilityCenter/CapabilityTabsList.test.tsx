import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Tabs } from "@/components/ui/tabs";
import type { CapabilityTab } from "./navigation";
import { CapabilityTabsList } from "./CapabilityTabsList";

function ControlledCapabilityTabs({
  initialValue = "templates",
  showTemplates = true,
}: {
  initialValue?: CapabilityTab;
  showTemplates?: boolean;
}) {
  const [value, setValue] = useState<CapabilityTab>(initialValue);

  return (
    <Tabs value={value} onValueChange={(next) => setValue(next as CapabilityTab)}>
      <CapabilityTabsList activeValue={value} showTemplates={showTemplates} />
    </Tabs>
  );
}

describe("能力中心标签栏", () => {
  it("把工作流放在第一个标签", () => {
    const { container } = render(<ControlledCapabilityTabs />);

    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "工作流",
      "技能",
      "连接器",
      "专家",
    ]);
    expect(container.querySelector("svg")).toBeNull();
    expect(screen.getByRole("tablist").className).toContain("bg-card");
    expect(screen.getByRole("tablist").className).toContain("h-11");
  });

  it("未开放个人通用 Agent 时不显示工作流", () => {
    render(
      <ControlledCapabilityTabs
        initialValue="experts"
        showTemplates={false}
      />,
    );

    expect(screen.queryByRole("tab", { name: "工作流" })).toBeNull();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "技能",
      "连接器",
      "专家",
    ]);
  });

  it("切换标签时使用统一的选中背景", async () => {
    const user = userEvent.setup();
    render(<ControlledCapabilityTabs />);
    expect(screen.getByRole("tab", { name: "工作流" }).getAttribute("data-state")).toBe("active");

    await user.click(screen.getByRole("tab", { name: "连接器" }));

    expect(screen.getByRole("tab", { name: "连接器" }).getAttribute("data-state")).toBe("active");
    expect(screen.getByRole("tablist").getAttribute("data-active-tab")).toBe("connectors");
  });
});

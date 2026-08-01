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
    expect(screen.getByRole("tablist").className).toContain("bg-brand-50");
    expect(screen.getByRole("tablist").className).toContain("h-10");
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

  it("切换标签时移动同一个选中指示层", async () => {
    const user = userEvent.setup();
    const { container } = render(<ControlledCapabilityTabs />);
    const indicator = container.querySelector<HTMLElement>("[data-capability-tab-indicator]");

    expect(indicator?.style.transform).toBe("translateX(0%)");
    expect(indicator?.className).toContain("transition-transform");

    await user.click(screen.getByRole("tab", { name: "连接器" }));

    const movedIndicator = container.querySelector<HTMLElement>("[data-capability-tab-indicator]");
    expect(movedIndicator).toBe(indicator);
    expect(movedIndicator?.style.transform).toBe("translateX(200%)");
  });
});

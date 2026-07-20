import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Tabs } from "@/components/ui/tabs";
import { CapabilityTabsList } from "./CapabilityTabsList";

describe("能力中心标签栏", () => {
  it("把任务模板放在第一个标签", () => {
    const { container } = render(
      <Tabs defaultValue="templates">
        <CapabilityTabsList />
      </Tabs>,
    );

    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "任务模板",
      "专家",
      "技能",
      "连接器",
    ]);
    expect(container.querySelector("svg")).toBeNull();
    expect(screen.getByRole("tablist").className).toContain("bg-brand-50");
  });

  it("未开放个人通用 Agent 时不显示任务模板", () => {
    render(
      <Tabs defaultValue="experts">
        <CapabilityTabsList showTemplates={false} />
      </Tabs>,
    );

    expect(screen.queryByRole("tab", { name: "任务模板" })).toBeNull();
    expect(screen.getAllByRole("tab")).toHaveLength(3);
  });
});

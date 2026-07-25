/**
 * Segmented 的行为契约测试。
 *
 * 为什么值得单测：它替换了 7 处手写分段控件，其中两处（RangeSelector 的天数、
 * EfficiencyView 的 days）用的是**数字** value，而 Radix ToggleGroup 只接受 string。
 * 组件在边界做了 String() 转换并按 options 还原原类型——这层转换回归会让
 * 数字型筛选器把 7 变成 "7"，下游按 === 比较的地方会静默失配。
 *
 * 另一个必须锁的行为：分段控件恒有一个选中项，点击已选项不能变成"无选中"
 * （Radix 默认允许取消选中，组件里显式吞掉了）。
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Segmented, segmentedItemClass } from "./segmented";

const TEXT_OPTIONS = [
  { value: "usage", label: "用量" },
  { value: "efficiency", label: "效率" },
] as const;

const NUM_OPTIONS = [
  { value: 7, label: "7 天" },
  { value: 14, label: "14 天" },
  { value: 30, label: "30 天" },
] as const;

describe("Segmented", () => {
  it("渲染全部选项并标出当前选中项", () => {
    render(<Segmented value="efficiency" onChange={() => {}} options={TEXT_OPTIONS} ariaLabel="视图" />);

    const items = screen.getAllByRole("radio");
    expect(items).toHaveLength(2);
    expect(screen.getByRole("radio", { name: "效率" }).getAttribute("data-state")).toBe("on");
    expect(screen.getByRole("radio", { name: "用量" }).getAttribute("data-state")).toBe("off");
  });

  it("切换选项时按原值回调", async () => {
    const onChange = vi.fn();
    render(<Segmented value="usage" onChange={onChange} options={TEXT_OPTIONS} ariaLabel="视图" />);

    await userEvent.click(screen.getByRole("radio", { name: "效率" }));
    expect(onChange).toHaveBeenCalledWith("efficiency");
  });

  it("数字 value 回调时仍是 number，不能退化成字符串", async () => {
    const onChange = vi.fn();
    render(<Segmented value={7} onChange={onChange} options={NUM_OPTIONS} ariaLabel="天数" />);

    await userEvent.click(screen.getByRole("radio", { name: "30 天" }));

    // 关键断言：下游用 === 比较天数，收到 "30" 会静默失配
    expect(onChange).toHaveBeenCalledWith(30);
    const [received] = onChange.mock.calls[0];
    expect(typeof received).toBe("number");
  });

  it("数字 value 能正确回显选中态", () => {
    render(<Segmented value={14} onChange={() => {}} options={NUM_OPTIONS} ariaLabel="天数" />);
    expect(screen.getByRole("radio", { name: "14 天" }).getAttribute("data-state")).toBe("on");
  });

  it("点击已选中项不会产生「无选中」状态", async () => {
    const onChange = vi.fn();
    render(<Segmented value="usage" onChange={onChange} options={TEXT_OPTIONS} ariaLabel="视图" />);

    await userEvent.click(screen.getByRole("radio", { name: "用量" }));

    // Radix 默认会 emit ""（取消选中），组件必须吞掉：分段控件恒有一个选中项
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("radio", { name: "用量" }).getAttribute("data-state")).toBe("on");
  });

  it("disabled 选项不可点击", async () => {
    const onChange = vi.fn();
    render(
      <Segmented
        value="usage"
        onChange={onChange}
        options={[{ value: "usage", label: "用量" }, { value: "locked", label: "锁定", disabled: true }]}
        ariaLabel="视图"
      />,
    );

    await userEvent.click(screen.getByRole("radio", { name: "锁定" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("children 渲染在同一枚胶囊内（供自定义区间触发器复用）", () => {
    render(
      <Segmented value="usage" onChange={() => {}} options={TEXT_OPTIONS} ariaLabel="视图">
        <button type="button">自定义</button>
      </Segmented>,
    );
    const group = screen.getByRole("radiogroup", { name: "视图" });
    expect(group.contains(screen.getByRole("button", { name: "自定义" }))).toBe(true);
  });

  it("segmentedItemClass 给非 ToggleGroupItem 元素提供一致外观", () => {
    const active = segmentedItemClass({ active: true });
    const idle = segmentedItemClass();
    expect(active).toContain("bg-primary");
    expect(idle).toContain("text-muted-foreground");
    // 尺寸档位实际生效
    expect(segmentedItemClass({ size: "sm" })).toContain("px-2.5");
    expect(segmentedItemClass({ size: "lg" })).toContain("px-4");
  });
});

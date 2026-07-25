/**
 * MetricCard / MetricStat 的行为契约。
 *
 * 本次把 5 套指标卡合并到这一个文件，其中 4 套原本各自实现。合并的前提是
 * **一个都不能倒退**，因此把三条来自不同来源的能力锁进测试：
 *  - `common/MetricCard` 的键盘可达（Enter / Space），这是「指标卡即入口」的地基；
 *  - `tabular-nums`（数字对齐，属于「不得弄丢的优势」）；
 *  - `TenantAnalytics/KpiCard` 的 aurora 外观 + loading 时显示「—」而不是 0。
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Users } from "lucide-react";
import { describe, expect, it, vi } from "vitest";

import { MetricCard, MetricStat } from "./MetricCard";

describe("MetricCard · 键盘可达（指标卡即入口）", () => {
  it("有 onClick 时是 role=button 且可聚焦", () => {
    render(<MetricCard title="失败任务" value={3} onClick={() => {}} />);
    const card = screen.getByRole("button");
    expect(card.getAttribute("tabindex")).toBe("0");
  });

  it("Enter 触发 onClick", async () => {
    const onClick = vi.fn();
    render(<MetricCard title="失败任务" value={3} onClick={onClick} />);
    screen.getByRole("button").focus();
    await userEvent.keyboard("{Enter}");
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("空格键也触发（不让页面跟着滚动）", async () => {
    const onClick = vi.fn();
    render(<MetricCard title="失败任务" value={3} onClick={onClick} />);
    screen.getByRole("button").focus();
    await userEvent.keyboard(" ");
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("没有 onClick 时不伪造可交互语义", () => {
    render(<MetricCard title="失败任务" value={3} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("MetricCard · 数值呈现", () => {
  it("数值带 tabular-nums（数字对齐，既有优势不能丢）", () => {
    render(<MetricCard title="成本" value="¥12.34" />);
    expect(screen.getByText("¥12.34").getAttribute("class")).toContain("tabular-nums");
  });

  it("tone 映射到语义色 token，不写硬编码调色板", () => {
    render(<MetricCard title="失败" value={1} tone="bad" />);
    expect(screen.getByText("1").getAttribute("class")).toContain("text-destructive");
  });

  it("tone=warn / good 走 -ink（一个 token 覆盖亮暗，无需 dark:）", () => {
    const { unmount } = render(<MetricCard title="待处理" value={2} tone="warn" />);
    expect(screen.getByText("2").getAttribute("class")).toContain("text-warning-ink");
    unmount();
    render(<MetricCard title="健康" value={9} tone="good" />);
    expect(screen.getByText("9").getAttribute("class")).toContain("text-success-ink");
  });

  it("loading 时数值位显示「—」而不是 0（真 0 与缺失必须可分辨）", () => {
    render(<MetricCard title="活跃成员" value={0} loading />);
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.queryByText("0")).toBeNull();
  });

  it("descriptionClassName 可保留调用点原有的副标题观感", () => {
    render(<MetricCard title="完成率" value="98%" description="成功 100" descriptionClassName="truncate text-2xs" />);
    expect(screen.getByText("成功 100").getAttribute("class")).toContain("text-2xs");
  });
});

describe("MetricCard · aurora（客户面外观）", () => {
  it("aurora 变体渲染语义描边外壳 + 图标徽章，而不是 platform 的灰卡", () => {
    const { container } = render(
      <MetricCard variant="aurora" auroraTone="neutral" icon={Users} title="成员" value={12} description="管理员 2" />,
    );
    // S5-C 起外壳从七彩渐变改为单档语义描边——渐变类不该再出现
    expect(container.querySelector(".bg-gradient-to-br")).toBeNull();
    expect(container.querySelector(".bg-border")).toBeTruthy();
    expect(container.querySelectorAll("svg")).toHaveLength(1);
  });

  it("aurora 语气按四档语义映射，不接受调色板色名", () => {
    const { container } = render(
      <MetricCard variant="aurora" auroraTone="bad" icon={Users} title="失败任务" value={3} />,
    );
    const shell = container.firstChild as HTMLElement;
    expect(shell.className).toContain("bg-danger/30");
    expect(shell.className).not.toMatch(/rose|fuchsia|amber|emerald|cyan|indigo/);
  });

  it("aurora 下数值仍是 tabular-nums，字号是客户面的 3xl", () => {
    render(<MetricCard variant="aurora" title="对话轮次" value="1,024" />);
    const value = screen.getByText("1,024").getAttribute("class") ?? "";
    expect(value).toContain("tabular-nums");
    expect(value).toContain("text-3xl");
  });

  it("aurora 下 loading 同样显示「—」", () => {
    render(<MetricCard variant="aurora" title="活跃成员" value={0} loading />);
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("aurora 下键盘可达同样生效", async () => {
    const onClick = vi.fn();
    render(<MetricCard variant="aurora" title="成员" value={1} onClick={onClick} />);
    screen.getByRole("button").focus();
    await userEvent.keyboard("{Enter}");
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("MetricStat（密集网格形态）", () => {
  it("渲染标签 + 值，不带卡片外壳", () => {
    const { container } = render(<MetricStat label="耗时">1.2s</MetricStat>);
    expect(screen.getByText("耗时")).toBeTruthy();
    expect(screen.getByText("1.2s")).toBeTruthy();
    // 不应引入 Card 的边框/圆角外壳（保住 run 详情 6 列网格的密度）
    expect(container.querySelector(".rounded-xl")).toBeNull();
  });

  it("标签用 text-2xs（11px 密集元信息档）", () => {
    render(<MetricStat label="轮次">3</MetricStat>);
    expect(screen.getByText("轮次").getAttribute("class")).toContain("text-2xs");
  });
});

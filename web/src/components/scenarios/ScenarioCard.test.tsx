import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ScenarioItem } from "@agent/shared";

import { ScenarioCard, scenarioDemoSharePath } from "./ScenarioCard";
import { EXAMPLE_DISCLAIMER } from "./ScenarioExampleDialog";

const baseScenario: ScenarioItem = {
  id: "fin-receivable-remind",
  title: "应收回款跟踪提醒",
  role: "fin",
  industries: ["manufacturing"],
  mode: "oneshot",
  pitch: "每天一眼看清谁该催款",
  story: "上传台账 → AI 分层 → 每日提醒",
  promptTemplate: "帮我跟踪应收：{{ledger}}",
  slots: [{ key: "ledger", label: "应收台账", example: "示例台账" }],
  requires: ["upload"],
  recommendCron: false,
};

const EXAMPLE_BODY = [
  "## 示例结论",
  "",
  "| 客户 | 应收余额 |",
  "| --- | ---: |",
  "| 华跃鞋材 | 128,600.00 |",
  "",
  "## AI 做了什么",
  "",
  "1. 逐家核对台账",
  "",
  "## 换成你的资料需要什么",
  "",
  "- 上传应收台账表格",
].join("\n");

const scenarioWithExample: ScenarioItem = {
  ...baseScenario,
  exampleResult: { body: EXAMPLE_BODY, dataLabel: "synthetic" },
};

const scenarioWithDemoShare: ScenarioItem = {
  ...baseScenario,
  demoShareToken: "demo_share_token_1234567890",
};

describe("ScenarioCard · 无 exampleResult（现状不变）", () => {
  it("仍然只渲染「试一试」，点击触发 onTry", () => {
    const onTry = vi.fn();
    render(<ScenarioCard scenario={baseScenario} onTry={onTry} />);

    expect(screen.queryByRole("button", { name: "看示例结果" })).toBeNull();
    expect(screen.queryByRole("button", { name: "换成我的资料" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "试一试" }));
    expect(onTry).toHaveBeenCalledTimes(1);
    expect(onTry).toHaveBeenCalledWith(expect.objectContaining({ id: baseScenario.id }));
  });
});

describe("ScenarioCard · 有 demoShareToken", () => {
  it("进入示例双按钮形态，并生成带 scenario 的分享路径", () => {
    const onTry = vi.fn();
    render(<ScenarioCard scenario={scenarioWithDemoShare} onTry={onTry} />);

    expect(screen.getByRole("button", { name: "看示例结果" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "换成我的资料" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "试一试" })).toBeNull();
    expect(scenarioDemoSharePath(scenarioWithDemoShare)).toBe(
      "/share/demo_share_token_1234567890?scenario=fin-receivable-remind",
    );
  });
});

describe("ScenarioCard · 有 exampleResult", () => {
  it("主按钮为「看示例结果」，原预填按钮保留为「换成我的资料」", () => {
    const onTry = vi.fn();
    render(<ScenarioCard scenario={scenarioWithExample} onTry={onTry} />);

    expect(screen.getByRole("button", { name: "看示例结果" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "试一试" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "换成我的资料" }));
    expect(onTry).toHaveBeenCalledTimes(1);
    expect(onTry).toHaveBeenCalledWith(expect.objectContaining({ id: baseScenario.id }));
  });

  it("点「看示例结果」打开弹层：固定免责 banner + markdown 渲染，不误触打开详情", async () => {
    const onTry = vi.fn();
    const onOpenDetail = vi.fn();
    render(
      <ScenarioCard scenario={scenarioWithExample} onTry={onTry} onOpenDetail={onOpenDetail} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "看示例结果" }));

    // 弹层懒加载：等待免责 banner 出现（由 UI 固定渲染，不依赖 markdown 内容自带）
    expect(await screen.findByText(EXAMPLE_DISCLAIMER)).toBeTruthy();
    // markdown 结构被真实渲染：标题与表格单元格
    expect(await screen.findByRole("heading", { name: "示例结论" })).toBeTruthy();
    expect(await screen.findByText("华跃鞋材")).toBeTruthy();
    // 打开弹层不触发预填，也不误触卡片「打开详情」
    expect(onTry).not.toHaveBeenCalled();
    expect(onOpenDetail).not.toHaveBeenCalled();
  });

  it("弹层底部「换成我的资料」= 预填行为并关闭弹层", async () => {
    const onTry = vi.fn();
    render(<ScenarioCard scenario={scenarioWithExample} onTry={onTry} />);

    fireEvent.click(screen.getByRole("button", { name: "看示例结果" }));
    const dialog = await screen.findByRole("dialog");

    fireEvent.click(within(dialog).getByRole("button", { name: "换成我的资料" }));
    expect(onTry).toHaveBeenCalledTimes(1);
    expect(onTry).toHaveBeenCalledWith(expect.objectContaining({ id: baseScenario.id }));
    await waitFor(() => {
      expect(screen.queryByText(EXAMPLE_DISCLAIMER)).toBeNull();
    });
  });
});

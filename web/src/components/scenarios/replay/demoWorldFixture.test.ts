import { describe, expect, it } from "vitest";
import { demoWorldFixture } from "./demoWorldFixture";
import { hookReplayScenarioIds, loadLazyReplayScript } from "./lazyRegistry";

describe("demoWorldFixture", () => {
  it("统一演示日、订单与应收总盘", () => {
    expect(demoWorldFixture.demoDate.iso).toBe("2026-08-09");
    expect(demoWorldFixture.inTransitOrders).toMatchObject({
      count: 17,
      totalAmountCny: 4_027_000,
      totalAmountWan: 402.7,
    });
    expect(demoWorldFixture.receivables).toMatchObject({
      count: 12,
      totalAmountCny: 1_682_000,
      totalAmountWan: 168.2,
    });
    expect(demoWorldFixture.meeting).toMatchObject({
      id: "MTG-2026-0809-OPS",
      date: "2026-08-09",
      confirmedDecisionCount: 5,
      followUpCount: 5,
      ownerCount: 3,
    });
  });

  it("统一恒岳交付订单及缺料倒推输入", () => {
    const { deliveryOrder } = demoWorldFixture;
    expect(deliveryOrder).toMatchObject({
      id: "SO-2026-1027",
      customer: "恒岳重工",
      amountCny: 864_000,
      amountWan: 86.4,
      promisedDeliveryDate: "2026-08-15",
    });
    expect(deliveryOrder.material).toMatchObject({
      model: "6204-RS",
      requiredQuantity: 400,
      shortageQuantity: 400,
      stockQuantity: 0,
      supplierVerbalDeliveryDate: "2026-08-12",
      assemblyDays: 3,
    });
    expect(deliveryOrder.material.requiredQuantity - deliveryOrder.material.stockQuantity)
      .toBe(deliveryOrder.material.shortageQuantity);
  });

  it("统一海川报告与客诉在演示日的账龄", () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const reportOverdueDays = (
      Date.parse(demoWorldFixture.demoDate.iso) - Date.parse(demoWorldFixture.haichuanReport.promisedDate)
    ) / dayMs;
    const complaintSuspendedDays = (
      Date.parse(demoWorldFixture.demoDate.iso) - Date.parse(demoWorldFixture.openComplaint.openedDate)
    ) / dayMs;

    expect(demoWorldFixture.haichuanReport.code).toBe("A02");
    expect(reportOverdueDays).toBe(demoWorldFixture.haichuanReport.overdueDays);
    expect(complaintSuspendedDays).toBe(demoWorldFixture.openComplaint.suspendedDays);
  });

  it("10 个 hook 不再出现本批已知冲突口径", async () => {
    const scripts = await Promise.all(
      hookReplayScenarioIds().map((scenarioId) => loadLazyReplayScript(scenarioId)!),
    );
    const text = scripts.flatMap((script) => [
      ...Object.values(script.artifacts ?? {}),
      ...script.steps.flatMap((step) => [
        ...step.blocks,
        ...(step.approval?.approvedBlocks ?? []),
        ...(step.approval?.rejectedBlocks ?? []),
      ]).map((block) => block.content ?? ""),
    ]).join("\n");

    for (const stale of [
      "¥1,842 万",
      "¥168.4 万",
      "拖了 38 天",
      "挂起 8 天",
      "现有 60 件",
      "装配 2 天",
      "5 条待办、4 位责任人",
      "88 分",
      "复购窗口大概率",
    ]) {
      expect(text, `仍残留冲突口径：${stale}`).not.toContain(stale);
    }
  });
});

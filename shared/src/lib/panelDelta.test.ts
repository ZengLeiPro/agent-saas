import { describe, expect, it } from "vitest";
import { derivePanelPulse } from "./panelDelta";


describe("derivePanelPulse", () => {
  it("显式 pulse 优先于自动推导", () => {
    expect(derivePanelPulse([
      { op: "rowUpdate", view: "orders", id: "r1", set: { state: "hit" } },
      { op: "pulse", view: "orders", ids: ["r2"], kind: "scan" },
    ])).toEqual({ op: "pulse", view: "orders", ids: ["r2"], kind: "scan" });
  });

  it("从 rows/cards/table/feed 的结构化写操作推导稳定对象 ID", () => {
    expect(derivePanelPulse([
      { op: "rowUpdate", view: "orders", id: "r1", set: { state: "hit" } },
      { op: "rowInsert", view: "orders", row: { id: "r2", text: "新增订单" } },
    ])).toEqual({ op: "pulse", view: "orders", ids: ["r1", "r2"], kind: "new" });
    expect(derivePanelPulse([{ op: "cardUpdate", view: "cards", id: "c1", set: { tone: "warn" } }])?.ids).toEqual(["c1"]);
    expect(derivePanelPulse([{ op: "cellFlag", view: "table", rowId: "t1", colKey: "amount", tone: "warn" }])?.ids).toEqual(["t1"]);
    expect(derivePanelPulse([{ op: "feedAppend", view: "feed", item: { id: "f1", from: "ai", text: "已发送" } }])?.ids).toEqual(["f1"]);
  });

  it("多视图写入优先当前可见视图", () => {
    expect(derivePanelPulse([
      { op: "rowUpdate", view: "orders", id: "r1", set: { state: "hit" } },
      { op: "feedAppend", view: "audit", item: { id: "a1", from: "ai", text: "已留痕" } },
    ], "orders")).toEqual({ op: "pulse", view: "orders", ids: ["r1"], kind: "hit" });
  });

  it("rowsSet 与 statsSet 生成扫描变化，纯导航 patch 不伪造变化", () => {
    expect(derivePanelPulse([{ op: "rowsSet", view: "orders", rows: [{ id: "r1", text: "订单" }] }]))
      .toEqual({ op: "pulse", view: "orders", ids: ["r1"], kind: "scan" });
    expect(derivePanelPulse([{ op: "statsSet", view: "stats", items: [{ k: "风险订单", v: "3" }] }]))
      .toEqual({ op: "pulse", view: "stats", ids: ["风险订单"], kind: "scan" });
    expect(derivePanelPulse([{ op: "focus", view: "orders" }, { op: "toolbar", view: "orders", sub: "只切换视图" }]))
      .toBeNull();
  });
});

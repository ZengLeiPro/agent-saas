import type { SystemPanelSnapshot } from "@agent/shared";
import { demoWorldFixture } from "./demoWorldFixture";
import type { ReplayScript } from "./types";

/**
 * 采购 quick：先甄别真缺口，再把原厂、替代与加急采购的代价摆到审批人面前。
 *
 * 这个场景不判断哪张销售订单会晚；交付风险由 deliveryRiskDailyScript 负责。
 * 这里回答采购岗的四个问题：缺口是否真实、该催谁、三条采购路径各付什么代价、
 * 今天批准并执行哪条采购动作。内容均为虚构示例。
 */

const ACTION_BOARD_PATH = "assets/demo/今日缺口采购行动板.html";

const ACTION_BOARD_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<style>
  :root { --brand:#2E56E1; --ink:#0f172a; --muted:#64748b; --line:#e2e8f0; --ok:#15803d; --warn:#b45309; --deny:#b91c1c; }
  * { box-sizing:border-box; }
  body { margin:0; padding:20px; font:14px/1.65 "PingFang SC","Microsoft YaHei",system-ui,sans-serif; color:var(--ink); background:#fff; }
  .bar { padding:7px 10px; border:1px solid var(--line); border-radius:7px; background:#f8fafc; color:var(--muted); font-size:12px; margin-bottom:14px; }
  h1 { margin:0 0 3px; font-size:17px; }
  .sub { margin:0 0 15px; color:var(--muted); font-size:12px; }
  .stats { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; margin-bottom:14px; }
  .stat { padding:9px 10px; border:1px solid var(--line); border-radius:8px; }
  .stat b { display:block; font-size:18px; }
  .stat span { color:var(--muted); font-size:12px; }
  table { width:100%; border-collapse:collapse; font-size:12.5px; margin-bottom:15px; }
  th,td { border:1px solid var(--line); padding:7px 9px; text-align:left; vertical-align:top; }
  th { background:#f8fafc; color:var(--muted); font-weight:500; }
  h2 { margin:16px 0 7px; font-size:13px; color:var(--brand); }
  .ok { color:var(--ok); font-weight:600; }
  .warn { color:var(--warn); font-weight:600; }
  .deny { color:var(--deny); font-weight:600; }
  .box { border:1px solid var(--line); border-radius:8px; padding:11px 13px; margin-bottom:12px; }
  .box ul { margin:5px 0; padding-left:20px; }
  .foot { color:var(--muted); font-size:11px; margin-top:14px; }
</style></head><body>
<div class="bar">采购行动板 · ${demoWorldFixture.demoDate.iso} · 待有权人确认</div>
<h1>今日缺口采购行动板</h1>
<p class="sub">只处理真实缺口与采购动作；不判断销售订单是否延期</p>
<div class="stats">
  <div class="stat"><b>5</b><span>系统预警</span></div>
  <div class="stat"><b>2</b><span>真实缺口</span></div>
  <div class="stat"><b>3</b><span>已排除误报</span></div>
  <div class="stat"><b>2</b><span>今日待批动作</span></div>
</div>
<h2>真实缺口与建议动作</h2>
<table>
  <tr><th>缺口</th><th>核对事实</th><th>今日建议</th><th>审批后终态</th></tr>
  <tr>
    <td>${demoWorldFixture.deliveryOrder.material.name} ${demoWorldFixture.deliveryOrder.material.model}<br><span class="deny">缺 ${demoWorldFixture.deliveryOrder.material.shortageQuantity} 件</span></td>
    <td>需求 ${demoWorldFixture.deliveryOrder.material.requiredQuantity}、现库 ${demoWorldFixture.deliveryOrder.material.stockQuantity}；华矩传动仅口头称 ${demoWorldFixture.deliveryOrder.material.supplierVerbalDeliveryShort} 到货；绑定 ${demoWorldFixture.deliveryOrder.id} / ${demoWorldFixture.deliveryOrder.customer} / ¥${demoWorldFixture.deliveryOrder.amountWan.toFixed(1)} 万 / 交期 ${demoWorldFixture.deliveryOrder.promisedDeliveryShort}；装配 ${demoWorldFixture.deliveryOrder.material.assemblyDays} 天</td>
    <td>先催原厂在 16:00 前补发货凭据；若仍无凭据，启用已授权的 400 件加急采购，金额上限 ¥42,000</td>
    <td class="warn">待确认</td>
  </tr>
  <tr>
    <td>PC 阻燃粒子 V0<br><span class="deny">缺 1.2 吨</span></td>
    <td>需求 1.8 吨、现库 0.6 吨；08-16 用料，当前无采购在途</td>
    <td>今天向聚源新材下 1.2 吨正常采购，¥19,800/吨，合计 ¥23,760，承诺 08-14 到货</td>
    <td class="warn">待确认</td>
  </tr>
</table>
<h2>6204-RS 三条路径的代价</h2>
<table>
  <tr><th>路径</th><th>现金代价</th><th>时间与业务代价</th><th>本次建议</th></tr>
  <tr><td>催原厂既有 PO</td><td>不新增采购额；既有 400 件 × ¥78 = ¥31,200</td><td>华矩只有口头 ${demoWorldFixture.deliveryOrder.material.supplierVerbalDeliveryShort} 到货，没凭据就不能当可靠在途</td><td class="ok">首选，设 16:00 凭据门槛</td></tr>
  <tr><td>替代 6204-2RS</td><td>现库 120 件；补买 280 件 × ¥92 = ¥25,760，比原规格同量贵 ¥3,920</td><td>要做 2 天质量确认并取得客户书面认可；原厂到货后还会形成重复库存</td><td>保留备选，本次不启用</td></tr>
  <tr><td>加急采购原规格</td><td>400 件 × ¥105 = ¥42,000，比原合同多 ¥10,800；原 PO 未取消前现金敞口合计 ¥73,200</td><td>新宁机电可 08-10 到货；需要审批金额上限并防止重复到货</td><td class="warn">仅在 16:00 无原厂凭据时触发</td></tr>
</table>
<div class="box">
  <b>批准口径</b>
  <ul>
    <li>批准 PC 粒子正常采购 ¥23,760，审批后立即建单。</li>
    <li>批准 6204-RS 条件加急额度上限 ¥42,000；16:00 前先催华矩，取得有效发货凭据则不触发新单。</li>
    <li>替代料只保留测算，不改 BOM、不占用客户认可。</li>
  </ul>
</div>
<p class="foot">虚构回放。金额、供应商、订单与物料均为演示数据；审批前不形成新的采购承诺。</p>
</body></html>`;

const ACTION_BOARD_SIZE_BYTES = new TextEncoder().encode(ACTION_BOARD_HTML).length;

/** 面板底稿：真实缺口 / 供应商与在途 / 采购行动板 / 持续跟踪 / 操作留痕 */
const PANEL_BASE: SystemPanelSnapshot = {
  title: "企业系统实况",
  live: true,
  activeView: "gaps",
  foot: "已连接：物料台账 · 采购台账 · 供应商协同 · 审批中心（演示）",
  views: [
    {
      key: "gaps",
      label: "真实缺口",
      winTitle: "物料台账 · 需求、库存与可信在途",
      toolbar: { title: "未来 14 天物料预警", sub: "尚未甄别" },
      widget: {
        kind: "table",
        cols: [
          { key: "item", label: "物料" },
          { key: "need", label: "需求 / 现库" },
          { key: "gap", label: "缺口" },
          { key: "state", label: "判定", align: "right" },
        ],
        rows: [],
        empty: { title: "尚未读取物料预警" },
      },
    },
    {
      key: "suppliers",
      label: "供应商与在途",
      winTitle: "采购台账 · 供应商承诺与凭据",
      toolbar: { title: "供应商与在途采购", sub: "尚未核对" },
      widget: { kind: "rows", rows: [], empty: { title: "尚未读取采购台账" } },
    },
    {
      key: "board",
      label: "采购行动板",
      winTitle: "今日采购行动 · 路径、代价与审批",
      toolbar: { title: "今日采购行动", sub: "尚未生成" },
      widget: {
        kind: "table",
        cols: [
          { key: "target", label: "对象" },
          { key: "path", label: "路径" },
          { key: "cost", label: "现金代价" },
          { key: "state", label: "状态", align: "right" },
        ],
        rows: [],
        empty: { title: "尚未形成采购建议" },
      },
    },
    {
      key: "monitor",
      label: "持续跟踪",
      winTitle: "采购行动 · 凭据、到货与条件触发",
      toolbar: { title: "持续跟踪", sub: "尚未启用" },
      widget: { kind: "feed", items: [], empty: { title: "暂无跟踪事件" } },
    },
    {
      key: "audit",
      label: "操作留痕",
      winTitle: "操作留痕 · 本次采购判断",
      toolbar: { title: "本次会话的系统动作", sub: "0 条" },
      widget: { kind: "feed", items: [], empty: { title: "尚无系统动作" } },
    },
  ],
};

export const materialShortageScript: ReplayScript = {
  scenarioId: "catalog-hook-material-shortage",
  title: "真缺料该催谁，今天批哪条采购动作",
  mode: "quick",
  artifacts: { [ACTION_BOARD_PATH]: ACTION_BOARD_HTML },

  steps: [
    {
      caption: "摊平需求、库存与可信在途",
      blocks: [
        {
          id: "ms1-prompt",
          kind: "prompt",
          title: "用户消息",
          defaultOpen: true,
          content: "这 5 条采购预警，哪些真要处理？",
        },
        {
          id: "ms1-tool",
          kind: "tool_use",
          title: "InventoryDemandReconcile",
          defaultOpen: true,
          toolName: "InventoryDemandReconcile",
          toolId: "t-reconcile",
          content: JSON.stringify({ date: demoWorldFixture.demoDate.iso, horizonDays: 14, alerts: 5 }),
          executionStatus: "completed",
          durationMs: 1260,
          presentation: {
            title: "把需求、现库、在检品和采购在途摊到同一时点",
            detail: [
              { k: "系统预警", v: "5 项" },
              { k: "倒排口径", v: "需求 − 现库 − 有凭据的在途；在检品单独核对" },
              { tree: "├", k: "订单关联", v: `${demoWorldFixture.deliveryOrder.id} · ${demoWorldFixture.deliveryOrder.customer} · ¥${demoWorldFixture.deliveryOrder.amountWan.toFixed(1)} 万 · 交期 ${demoWorldFixture.deliveryOrder.promisedDeliveryShort}` },
              { tree: "└", k: "岗位边界", v: "这里只判断采购缺口与动作，不下订单延期结论" },
            ],
            status: "ok",
            panelBase: PANEL_BASE,
            panel: [
              { op: "focus", view: "gaps" },
              { op: "toolbar", view: "gaps", title: "未来 14 天物料预警", sub: "5 项 · 等待凭据甄别" },
              { op: "tableRowInsert", view: "gaps", row: { id: "g-6204", cells: { item: `${demoWorldFixture.deliveryOrder.material.name} ${demoWorldFixture.deliveryOrder.material.model}`, need: `需求 ${demoWorldFixture.deliveryOrder.material.requiredQuantity} · 现库 ${demoWorldFixture.deliveryOrder.material.stockQuantity}`, gap: `${demoWorldFixture.deliveryOrder.material.shortageQuantity} 件`, state: "待甄别" } } },
              { op: "tableRowInsert", view: "gaps", row: { id: "g-pc", cells: { item: "PC 阻燃粒子 V0", need: "需求 1.8 · 现库 0.6 吨", gap: "1.2 吨", state: "待甄别" } } },
              { op: "tableRowInsert", view: "gaps", row: { id: "g-steel", cells: { item: "冷轧钢板 SPCC 1.2mm", need: "需求 620 kg", gap: "系统报缺", state: "待甄别" } } },
              { op: "tableRowInsert", view: "gaps", row: { id: "g-bolt", cells: { item: "不锈钢紧固件 M6×20", need: "需求 5,000 件", gap: "系统报缺", state: "待甄别" } } },
              { op: "tableRowInsert", view: "gaps", row: { id: "g-ring", cells: { item: "密封圈 NBR O-25", need: "需求 2,400 件", gap: "系统报缺", state: "待甄别" } } },
              { op: "feedAppend", view: "audit", item: { id: "ma-1", from: "AI 同事", time: "13:58:12", text: "读取需求、库存、在检品与采购在途（只读）" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "1 条" },
            ],
          },
        },
        {
          id: "ms1-result",
          kind: "tool_result",
          title: "InventoryDemandReconcile 结果",
          defaultOpen: false,
          toolName: "InventoryDemandReconcile",
          toolId: "t-reconcile",
          content: "alerts=5 demandHorizon=14d stockSnapshot=ok inspectionLots=3 openPO=1",
        },
        {
          id: "ms1-text",
          kind: "text",
          title: "采购口径",
          defaultOpen: true,
          content: `五条预警先不直接变成采购单。我会先剔除在检品漏算，再核已有 PO 的发货凭据。${demoWorldFixture.deliveryOrder.id} 只用来说明缺口影响范围；“哪张订单会晚”仍由交付风险场景判断。`,
        },
      ],
    },

    {
      caption: "甄别出 2 个真缺口并锁定该催的人",
      blocks: [
        {
          id: "ms2-tool",
          kind: "tool_use",
          title: "ShortageTruthCheck",
          defaultOpen: true,
          toolName: "ShortageTruthCheck",
          toolId: "t-truth",
          content: JSON.stringify({ alerts: 5, requireTransitEvidence: true }),
          executionStatus: "completed",
          durationMs: 1740,
          presentation: {
            title: "5 条预警甄别完成：2 个真缺口，3 个误报",
            detail: [
              { section: "真实缺口" },
              { risk: "high", text: `${demoWorldFixture.deliveryOrder.material.name} ${demoWorldFixture.deliveryOrder.material.model} 缺 ${demoWorldFixture.deliveryOrder.material.shortageQuantity} 件`, action: `需求 ${demoWorldFixture.deliveryOrder.material.requiredQuantity}、现库 ${demoWorldFixture.deliveryOrder.material.stockQuantity}；华矩传动只口头称 ${demoWorldFixture.deliveryOrder.material.supplierVerbalDeliveryShort} 到货，无发货单号；装配需 ${demoWorldFixture.deliveryOrder.material.assemblyDays} 天` },
              { indent: 1, text: `绑定 ${demoWorldFixture.deliveryOrder.id} / ${demoWorldFixture.deliveryOrder.customer} / ¥${demoWorldFixture.deliveryOrder.amountWan.toFixed(1)} 万 / 交期 ${demoWorldFixture.deliveryOrder.promisedDeliveryShort}，采购今天要向华矩拿到可验证凭据` },
              { risk: "medium", text: "PC 阻燃粒子 V0 缺 1.2 吨", action: "需求 1.8 吨、现库 0.6 吨，08-16 用料，当前无采购在途；今天下正常采购仍可按 08-14 到货" },
              { section: "已排除误报" },
              { verdict: "pass", text: "冷轧钢板 SPCC 1.2mm", note: "08-08 到货 800 kg，正在检验，系统未计入" },
              { verdict: "pass", text: "不锈钢紧固件 M6×20", note: "08-08 到货 8,000 件，正在检验" },
              { verdict: "pass", text: "密封圈 NBR O-25", note: "08-07 到货 3,000 件，正在检验" },
            ],
            status: "warn",
            panel: [
              { op: "focus", view: "gaps" },
              { op: "toolbar", view: "gaps", title: "真实缺口甄别", sub: "真缺口 2 · 误报 3" },
              { op: "tableRowUpdate", view: "gaps", id: "g-6204", set: { cells: { state: "真实缺口" } } },
              { op: "cellFlag", view: "gaps", rowId: "g-6204", colKey: "state", tone: "deny", flag: "缺 400" },
              { op: "tableRowUpdate", view: "gaps", id: "g-pc", set: { cells: { state: "真实缺口" } } },
              { op: "cellFlag", view: "gaps", rowId: "g-pc", colKey: "state", tone: "warn", flag: "缺 1.2 吨" },
              { op: "tableRowUpdate", view: "gaps", id: "g-steel", set: { cells: { gap: "在检 800 kg", state: "误报" } } },
              { op: "cellFlag", view: "gaps", rowId: "g-steel", colKey: "state", tone: "pass", flag: "已排除" },
              { op: "tableRowUpdate", view: "gaps", id: "g-bolt", set: { cells: { gap: "在检 8,000 件", state: "误报" } } },
              { op: "cellFlag", view: "gaps", rowId: "g-bolt", colKey: "state", tone: "pass", flag: "已排除" },
              { op: "tableRowUpdate", view: "gaps", id: "g-ring", set: { cells: { gap: "在检 3,000 件", state: "误报" } } },
              { op: "cellFlag", view: "gaps", rowId: "g-ring", colKey: "state", tone: "pass", flag: "已排除" },
              { op: "rowInsert", view: "suppliers", row: { id: "s-huaju", text: "华矩传动 · PO-2026-0886", sub: `${demoWorldFixture.deliveryOrder.material.model} ${demoWorldFixture.deliveryOrder.material.shortageQuantity} 件 · 口头 ${demoWorldFixture.deliveryOrder.material.supplierVerbalDeliveryShort} 到货 · 无发货凭据`, state: "hit", tone: "warn", badge: { text: "今天催", tone: "warn" } } },
              { op: "rowInsert", view: "suppliers", row: { id: "s-pc", text: "聚源新材 · PC 阻燃粒子 V0", sub: "可供 1.2 吨 · ¥19,800/吨 · 08-14 到货", badge: { text: "待下单", tone: "pending" } } },
              { op: "toolbar", view: "suppliers", title: "供应商与在途采购", sub: "该催 1 家 · 该下单 1 家" },
              { op: "feedAppend", view: "audit", item: { id: "ma-2", from: "AI 同事", time: "13:59:46", text: "甄别 5 条预警：真实缺口 2，误报 3；未创建采购单" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "2 条" },
            ],
          },
        },
        {
          id: "ms2-text",
          kind: "text",
          title: "采购结论",
          defaultOpen: true,
          content: `今天真正要动的是两项：${demoWorldFixture.deliveryOrder.material.model} 找华矩补发货凭据，PC 粒子向聚源新材下 1.2 吨正常采购。其余三项是系统漏算在检品，不应重复买。`,
        },
      ],
    },

    {
      caption: "算清原厂、替代与加急采购的代价",
      blocks: [
        {
          id: "ms3-tool",
          kind: "tool_use",
          title: "ProcurementOptionCompare",
          defaultOpen: true,
          toolName: "ProcurementOptionCompare",
          toolId: "t-options",
          content: JSON.stringify({ item: demoWorldFixture.deliveryOrder.material.model, quantity: demoWorldFixture.deliveryOrder.material.shortageQuantity, routes: ["original", "substitute", "expedite"] }),
          executionStatus: "completed",
          durationMs: 1430,
          presentation: {
            title: "6204-RS 三路代价与 PC 粒子正常采购测算",
            detail: [
              { verdict: "pass", text: "原厂既有 PO：先催华矩", note: "新增采购额 ¥0；既有合同额 ¥31,200。代价是到货日目前只有口头承诺，16:00 前必须补发货凭据" },
              { verdict: "pending", text: "替代 6204-2RS：120 件现库 + 补买 280 件", note: "补买 ¥25,760，比原规格同量贵 ¥3,920；还要 2 天质量确认和客户书面认可" },
              { verdict: "warn", text: "加急采购原规格：新宁机电 400 件", note: "总额 ¥42,000，比原合同多 ¥10,800；原 PO 未取消前现金敞口合计 ¥73,200，但可 08-10 到货" },
              { verdict: "pass", text: "PC 阻燃粒子 V0：聚源新材 1.2 吨", note: "¥19,800/吨，总额 ¥23,760，承诺 08-14 到货；正常采购即可，不必付加急费" },
              { insight: "建议今天批准两件事：PC 粒子立即正常下单；6204-RS 先催原厂，并给 16:00 无凭据时的加急采购设置 ¥42,000 条件额度", label: "采购建议" },
            ],
            status: "warn",
            panel: [
              { op: "focus", view: "board" },
              { op: "toolbar", view: "board", title: "今日采购行动 · 路径与代价", sub: "4 个方案 · 2 项建议待批" },
              { op: "tableRowInsert", view: "board", row: { id: "b-original", cells: { target: "6204-RS", path: "催原厂既有 PO", cost: "新增 ¥0", state: "建议首选" } } },
              { op: "cellFlag", view: "board", rowId: "b-original", colKey: "state", tone: "pass", flag: "16:00 门槛" },
              { op: "tableRowInsert", view: "board", row: { id: "b-substitute", cells: { target: "6204-RS", path: "替代 6204-2RS", cost: "补买 ¥25,760", state: "保留备选" } } },
              { op: "tableRowInsert", view: "board", row: { id: "b-expedite", cells: { target: "6204-RS", path: "加急原规格", cost: "上限 ¥42,000", state: "条件触发" } } },
              { op: "cellFlag", view: "board", rowId: "b-expedite", colKey: "state", tone: "warn", flag: "待审批" },
              { op: "tableRowInsert", view: "board", row: { id: "b-pc", cells: { target: "PC 粒子 1.2 吨", path: "正常采购", cost: "¥23,760", state: "今天下单" } } },
              { op: "cellFlag", view: "board", rowId: "b-pc", colKey: "state", tone: "warn", flag: "待审批" },
              { op: "feedAppend", view: "audit", item: { id: "ma-3", from: "AI 同事", time: "14:01:18", text: "完成原厂、替代、加急采购与 PC 正常采购的现金和时间代价测算" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "3 条" },
            ],
          },
        },
        {
          id: "ms3-text",
          kind: "text",
          title: "建议",
          defaultOpen: true,
          content: "我不建议现在同时买三路。原厂先设一个硬凭据门槛，PC 粒子正常下单；替代料留在备选位，加急单只在门槛失守时触发。这样既不赌一句口头承诺，也不先把重复库存和 ¥73,200 现金敞口全背上。",
        },
      ],
    },

    {
      caption: "生成今日缺口采购行动板",
      blocks: [
        {
          id: "ms4-tool",
          kind: "tool_use",
          title: "PurchaseBoardBuild",
          defaultOpen: true,
          toolName: "PurchaseBoardBuild",
          toolId: "t-board",
          content: JSON.stringify({ date: demoWorldFixture.demoDate.iso, realGaps: 2, recommendedActions: 2 }),
          executionStatus: "completed",
          durationMs: 920,
          presentation: {
            title: "采购行动板已生成，停在审批前",
            detail: [
              { k: "真实缺口", v: "2 项；三条误报已注明排除依据" },
              { k: "待批动作", v: "PC 粒子正常采购 ¥23,760；6204-RS 条件加急额度上限 ¥42,000" },
              { tree: "├", k: "先行动作", v: "催华矩在 16:00 前给有效发货凭据" },
              { tree: "└", k: "当前写入", v: "采购单 0 张 · 对外催办 0 条 · 条件额度未生效" },
            ],
            status: "waiting",
            panel: [
              { op: "focus", view: "board" },
              { op: "toolbar", view: "board", title: "今日采购行动", sub: "行动板已生成 · 等待审批" },
              { op: "feedAppend", view: "audit", item: { id: "ma-4", from: "AI 同事", time: "14:02:26", text: "生成《今日缺口采购行动板》，采购系统零写入" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "4 条" },
            ],
          },
        },
        {
          id: "ms4-text",
          kind: "text",
          title: "行动板",
          defaultOpen: true,
          content: [
            "今天该批什么、每条路要付什么代价，已经放在同一张板上：",
            "",
            `[FILE]{"filePath":"${ACTION_BOARD_PATH}","fileName":"今日缺口采购行动板.html","fileSize":${ACTION_BOARD_SIZE_BYTES}}[/FILE]`,
            "",
            "现在还没有创建采购单，也没有向供应商发出承诺。下一步确认的是采购动作与金额上限，不是订单交期结论。",
          ].join("\n"),
        },
      ],
    },

    {
      caption: "有权人批准两条今日采购动作",
      blocks: [],
      approval: {
        title: "今日缺口采购动作 · 需有权人确认",
        description: "确认后会创建 PC 粒子采购单、催办既有轴承 PO，并启用 16:00 条件加急额度。责任、金额和触发条件均需明确批准。",
        facts: [
          { label: "PC 粒子", value: "聚源新材 1.2 吨 × ¥19,800 = ¥23,760；08-14 到货" },
          { label: "6204-RS 先催", value: "华矩 PO-2026-0886；16:00 前提供发货单号与物流单号" },
          { label: "条件加急", value: "16:00 无有效凭据才向新宁机电采购 400 件；金额上限 ¥42,000" },
          { label: "不启用", value: "6204-2RS 替代路线本次不改 BOM、不采购" },
        ],
        approveLabel: "批准并执行",
        rejectLabel: "退回调整",
        approvedBlocks: [
          {
            id: "ms5-human",
            kind: "prompt",
            title: "用户消息",
            defaultOpen: true,
            content: "按行动板执行：PC 粒子今天下单；轴承先催华矩，16:00 还拿不到有效发货凭据，就在 ¥42,000 上限内向新宁机电加急采购 400 件。替代料先不动。",
          },
          {
            id: "ms5-approval",
            kind: "tool_use",
            title: "Approval",
            defaultOpen: true,
            toolName: "Approval",
            toolId: "t-approval",
            content: JSON.stringify({ board: `PROC-${demoWorldFixture.demoDate.compact}`, pcAmount: 23_760, conditionalExpediteCap: 42_000 }),
            executionStatus: "completed",
            durationMs: 330,
            presentation: {
              title: "采购动作已批准：立即 1 条，条件触发 1 条",
              detail: [
                { verdict: "pass", text: "立即执行", note: "PC 粒子 1.2 吨正常采购，金额 ¥23,760" },
                { verdict: "pass", text: "先催后判", note: "华矩 16:00 凭据门槛；无凭据才启用 ¥42,000 加急额度" },
                { verdict: "pass", text: "明确不做", note: "替代料不启用；三条误报不采购" },
                { tree: "└", k: "留痕", v: "审批人、金额上限、条件表达式与失效时间均已记录" },
              ],
              status: "ok",
              receipt: { id: `APR-PROC-${demoWorldFixture.demoDate.compact}`, system: "审批中心", readBack: true },
              panel: [
                { op: "focus", view: "board" },
                { op: "tableRowUpdate", view: "board", id: "b-original", set: { cells: { state: "已批准催办" } } },
                { op: "tableRowUpdate", view: "board", id: "b-expedite", set: { cells: { state: "条件额度生效" } } },
                { op: "tableRowUpdate", view: "board", id: "b-pc", set: { cells: { state: "已批准下单" } } },
                { op: "feedAppend", view: "audit", item: { id: "ma-5", from: "采购负责人 刘志强", time: "14:18:42", text: "批准 PC 粒子采购 ¥23,760，并批准 6204-RS 条件加急额度上限 ¥42,000" } },
                { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "5 条" },
              ],
            },
          },
          {
            id: "ms5-actions",
            kind: "tool_use",
            title: "PurchaseActionDispatch",
            defaultOpen: true,
            toolName: "PurchaseActionDispatch",
            toolId: "t-dispatch",
            content: JSON.stringify({ createPO: "PC-V0-1.2T", chasePO: "PO-2026-0886", condition: "no-valid-proof@16:00" }),
            executionStatus: "completed",
            durationMs: 1080,
            presentation: {
              title: "PC 粒子已下单，轴承催办与条件门槛已启动",
              detail: [
                { verdict: "pass", text: "PO-2026-0901 已创建并回读", note: "PC 阻燃粒子 V0 1.2 吨 · 聚源新材 · ¥23,760 · 08-14 到货" },
                { verdict: "pass", text: "华矩催办已送达", note: "要求 16:00 前提供发货单号与物流单号；14:21 对方已读" },
                { verdict: "pending", text: "条件加急额度等待判定", note: "16:00 自动核验凭据；满足凭据则不创建新单，否则在 ¥42,000 上限内触发" },
              ],
              status: "warn",
              receipt: { id: "PO-2026-0901", system: "采购台账", readBack: true },
              panel: [
                { op: "focus", view: "monitor" },
                { op: "toolbar", view: "monitor", title: "采购行动持续跟踪", sub: "2 条动作运行中 · 16:00 条件核验" },
                { op: "feedAppend", view: "monitor", item: { id: "mon-pc", from: "采购台账", time: "14:20:03", text: "PO-2026-0901 已创建：PC 阻燃粒子 V0 1.2 吨，聚源新材确认 08-14 到货", card: { title: "PC 粒子正常采购", body: "¥23,760 · 已回读 · 等待到货", meta: [{ text: "第二个真缺口已行动", tone: "pass" }] } } },
                { op: "feedAppend", view: "monitor", item: { id: "mon-bearing", from: "供应商协同", time: "14:21:10", text: "华矩已读催办：16:00 前补发货单号与物流单号", card: { title: "6204-RS 原厂凭据门槛", body: "若 16:00 仍无有效凭据，条件加急额度才会触发", meta: [{ text: "等待凭据", tone: "warn" }] } } },
                { op: "tableRowUpdate", view: "board", id: "b-pc", set: { cells: { state: "PO 已创建" } } },
                { op: "feedAppend", view: "audit", item: { id: "ma-6", from: "AI 同事", time: "14:21:10", text: "创建 PC 粒子采购单 PO-2026-0901；催办华矩；启用 16:00 条件核验" } },
                { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "6 条" },
              ],
            },
          },
        ],
        rejectedBlocks: [
          {
            id: "ms5-reject",
            kind: "tool_use",
            title: "ApprovalReject",
            defaultOpen: true,
            toolName: "ApprovalReject",
            toolId: "t-reject",
            content: JSON.stringify({ board: `PROC-${demoWorldFixture.demoDate.compact}`, decision: "rejected" }),
            executionStatus: "completed",
            durationMs: 220,
            presentation: {
              title: "采购行动被退回，所有外部动作保持关闭",
              detail: [
                { verdict: "pass", text: "采购台账零写入", note: "PC 粒子采购单未创建，条件加急额度未生效" },
                { verdict: "pass", text: "供应商零触达", note: "未向华矩催办，也未向聚源或新宁发出采购承诺" },
                { warn: "行动板与测算保留，可修改金额、供应商或触发条件后重新提交" },
              ],
              status: "blocked",
              panel: [
                { op: "focus", view: "audit" },
                { op: "feedAppend", view: "audit", item: { id: "ma-reject", from: "采购负责人 刘志强", time: "14:18:42", text: "今日采购行动被退回：采购单 0，供应商触达 0，条件额度未生效" } },
                { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "5 条" },
              ],
            },
          },
          {
            id: "ms5-reject-text",
            kind: "text",
            title: "退回说明",
            defaultOpen: true,
            content: "已停在审批点：没有创建 PC 粒子采购单，没有催华矩，也没有启用轴承加急额度。行动板仍可下载；修改后需要重新确认，不沿用本次退回前的授权。",
          },
        ],
      },
    },

    {
      caption: "回读两项缺口的采购终态",
      blocks: [
        {
          id: "ms6-tool",
          kind: "tool_use",
          title: "ProcurementReadBack",
          defaultOpen: true,
          toolName: "ProcurementReadBack",
          toolId: "t-readback",
          content: JSON.stringify({ purchaseOrders: ["PO-2026-0886", "PO-2026-0901"], checkpoint: "2026-08-09T16:10:00+08:00" }),
          executionStatus: "completed",
          durationMs: 1040,
          presentation: {
            title: "16:10 回读：两个真缺口都有动作，条件加急未误触发",
            detail: [
              { verdict: "pass", text: "6204-RS 原厂在途已补凭据", note: "华矩 15:46 上传发货单 FH-88917 与物流单号，承诺到货仍为 08-12；400 件、现库 0、装配 3 天口径未改" },
              { verdict: "pass", text: "条件加急采购未触发", note: "16:00 核验命中有效凭据，新宁机电 400 件新单未创建，¥42,000 额度自动失效" },
              { verdict: "pass", text: "PC 粒子采购已被供应商接受", note: "PO-2026-0901 · 1.2 吨 · ¥23,760 · 聚源新材确认 08-14 到货" },
              { verdict: "pass", text: "替代料仍未启用", note: "6204-2RS 未采购、未改 BOM、未发起客户认可" },
              { insight: "采购场景已经回答“真缺口、催谁、代价、今天批什么”；是否影响 08-15 交付仍交给订单交付场景判断", label: "岗位分工" },
            ],
            status: "ok",
            panel: [
              { op: "focus", view: "monitor" },
              { op: "toolbar", view: "monitor", title: "采购行动持续跟踪", sub: "6204 凭据已补 · PC 已下单 · 等待到货签收" },
              { op: "feedAppend", view: "monitor", item: { id: "mon-proof", from: "华矩传动", time: "15:46:22", text: "上传发货单 FH-88917 与物流单号；400 件，承诺 08-12 到货", card: { title: "6204-RS 在途凭据已补齐", body: "16:00 条件核验通过，加急采购不触发", meta: [{ text: "继续跟踪签收", tone: "pass" }] } } },
              { op: "feedAppend", view: "monitor", item: { id: "mon-condition", from: "条件执行器", time: "16:00:03", text: "检测到有效发货凭据，关闭新宁机电加急采购分支；未创建新单" } },
              { op: "tableRowUpdate", view: "board", id: "b-original", set: { cells: { state: "凭据已补" } } },
              { op: "cellFlag", view: "board", rowId: "b-original", colKey: "state", tone: "pass", flag: "跟踪到货" },
              { op: "tableRowUpdate", view: "board", id: "b-expedite", set: { cells: { state: "未触发" } } },
              { op: "cellFlag", view: "board", rowId: "b-expedite", colKey: "state", tone: "pass", flag: "零新单" },
              { op: "tableRowUpdate", view: "board", id: "b-pc", set: { cells: { state: "供应商已接单" } } },
              { op: "cellFlag", view: "board", rowId: "b-pc", colKey: "state", tone: "pass", flag: "待 08-14 到货" },
              { op: "feedAppend", view: "audit", item: { id: "ma-7", from: "AI 同事", time: "16:10:06", text: "回读两张 PO、供应商凭据与条件额度：6204 跟踪中，PC 已下单，加急未触发" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "7 条" },
            ],
          },
        },
        {
          id: "ms6-result",
          kind: "tool_result",
          title: "ProcurementReadBack 结果",
          defaultOpen: false,
          toolName: "ProcurementReadBack",
          toolId: "t-readback",
          content: "realGaps=2 bearingProof=valid pcPO=accepted conditionalExpedite=not-triggered substitute=inactive monitor=active",
        },
        {
          id: "ms6-text",
          kind: "text",
          title: "采购终态",
          defaultOpen: true,
          content: [
            "## 本次会话改变了什么",
            "",
            "| 系统 | 终态 | 核对依据 |",
            "| --- | --- | --- |",
            `| 物料台账 | ${demoWorldFixture.deliveryOrder.material.model} 需求 ${demoWorldFixture.deliveryOrder.material.requiredQuantity}、现库 ${demoWorldFixture.deliveryOrder.material.stockQuantity}、缺口 ${demoWorldFixture.deliveryOrder.material.shortageQuantity}；PC 粒子缺 1.2 吨 | 两项真实缺口均保留到到货签收，不用动作状态冒充库存 |`,
            `| 采购台账 | PO-2026-0886 已补 400 件发货凭据；PO-2026-0901 已创建并由聚源接受 | 原厂到货 ${demoWorldFixture.deliveryOrder.material.supplierVerbalDeliveryShort}；PC 到货 08-14 |`,
            "| 条件额度 | 6204-RS 加急额度 ¥42,000 于 16:00 自动失效 | 已取得有效发货凭据，新宁机电新单 0 张 |",
            "| 持续跟踪 | 6204-RS 跟到 08-12 签收，PC 粒子跟到 08-14 签收 | 未签收前不自动销项 |",
            "",
            "## 本次会话没有做什么",
            "",
            "- 没有判断或修改 SO-2026-1027 的交付日期；采购只提供缺口和采购动作，订单会不会晚由交付场景判断；",
            "- 没有启用 6204-2RS，也没有改 BOM 或代替客户完成书面认可；",
            "- 没有为三条误报重复采购；在检品仍按原检验流程入库；",
            "- 没有因为批准了额度就强行创建加急单；凭据满足条件后，新宁机电采购分支保持零写入。",
          ].join("\n"),
        },
      ],
    },
  ],

  sources: [
    {
      blockRef: "step1.tool.InventoryDemandReconcile",
      producer: "租户物料、库存、检验与排产数据连接器",
      state: "missing",
      gap: "真实环境需把需求、现库、在检品和采购在途按同一快照时间关联；目前没有统一连接器和可信在途字段。",
    },
    {
      blockRef: "step2.tool.ShortageTruthCheck",
      producer: "采购缺口甄别规则",
      state: "missing",
      gap: "无发货凭据不计可信在途、在检品单独扣减等口径尚未产品化为可配置规则。",
    },
    {
      blockRef: "step3.tool.ProcurementOptionCompare",
      producer: "采购价格、替代料与供应商交期连接器",
      state: "missing",
      gap: "三条路径的价格、库存、质量确认和客户认可条件分散在不同台账，暂不能自动形成同口径成本对比。",
    },
    {
      blockRef: "step4.tool.PurchaseBoardBuild",
      producer: "Agent 生成 HTML 采购行动板",
      state: "exists",
    },
    {
      blockRef: "step4.artifact.今日缺口采购行动板",
      producer: "Agent 生成 HTML 采购行动板",
      state: "exists",
    },
    {
      blockRef: "step5.tool.Approval",
      producer: "业务审批执行器",
      state: "needs-change",
      gap: "现有审批能记录同意或退回，但金额上限、条件表达式和自动失效时间还不能结构化绑定到采购动作。",
    },
    {
      blockRef: "step5.tool.PurchaseActionDispatch",
      producer: "采购台账与供应商协同连接器",
      state: "needs-change",
      gap: "需支持采购单创建后回读、既有 PO 催办回执以及条件满足时不创建新单的幂等执行。",
    },
    {
      blockRef: "step5.tool.ApprovalReject",
      producer: "业务审批执行器（退回分支）",
      state: "needs-change",
      gap: "退回事件存在，但采购单零写入、供应商零触达和条件额度未生效尚无统一的可验证回执。",
    },
    {
      blockRef: "step6.tool.ProcurementReadBack",
      producer: "采购台账、供应商凭据与条件执行器回读",
      state: "missing",
      gap: "跨系统回读需要稳定 PO 编号、供应商附件对象和条件执行日志；当前只能由人工逐项核对。",
    },
  ],
};

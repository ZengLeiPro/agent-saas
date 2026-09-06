import type { SystemPanelSnapshot } from "../../lib/systemPanel";
import { demoWorldFixture } from "./demoWorldFixture";
import type { ReplayScript } from "./types";

/**
 * 剧本：每天 08:00 把当天有交付风险的在途订单挑出来（跟单岗）。
 *
 * 骨架照 complianceGateScript 抄，开场照 deadlineWatchScript 的排程起手：
 *   ① 主动拒绝——第 4 步「直接改承诺交期」被拦截，给合规改期路径，不悄悄动单；
 *   ② 视角切换——第 5 步产物就是跟单和生产计划早上打开的那份晨报；
 *   ③ 跨系统核对——终态用一张表把四处记录摆在一起；
 *   ④ 可下载产物——交付风险晨报 HTML，右侧预览 + 本地下载。
 * 外加：判定逐条给倒推依据（不给黑箱结论），人可以改掉 AI 拟的对外口径并被记账。
 *
 * 内容为示例数据，不对应任何真实企业、订单、采购单或人员。
 */

const MORNING_REPORT_PATH = "assets/demo/交付风险晨报.html";

const MORNING_REPORT_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<style>
  :root { --brand: #2E56E1; --ink: #0f172a; --muted: #64748b; --line: #e2e8f0; --ok: #15803d; --warn: #b45309; --deny: #b91c1c; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 20px; font: 14px/1.7 "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; color: var(--ink); background: #fff; }
  .bar { display: flex; align-items: center; gap: 10px; padding: 6px 10px; border: 1px solid var(--line); border-radius: 6px; background: #f8fafc; color: var(--muted); font-size: 12px; margin-bottom: 16px; }
  .tag { padding: 1px 6px; border-radius: 4px; background: #eef2ff; color: var(--brand); font-weight: 600; }
  h1 { margin: 0 0 4px; font-size: 16px; }
  .sub { margin: 0 0 14px; color: var(--muted); font-size: 12px; }
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 16px; }
  .stat { border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; }
  .stat b { display: block; font-size: 18px; line-height: 1.4; }
  .stat span { color: var(--muted); font-size: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 16px; }
  th, td { border: 1px solid var(--line); padding: 7px 10px; text-align: left; vertical-align: top; }
  th { background: #f8fafc; color: var(--muted); font-weight: 500; }
  .ok { color: var(--ok); font-weight: 600; }
  .warn { color: var(--warn); font-weight: 600; }
  .deny { color: var(--deny); font-weight: 600; }
  .note { color: var(--muted); font-size: 12px; }
  .box { border: 1px solid var(--line); border-left: 3px solid var(--deny); border-radius: 8px; padding: 12px; margin-bottom: 12px; }
  .box.mid { border-left-color: var(--warn); }
  .box h2 { margin: 0 0 8px; font-size: 13px; }
  .box ul { margin: 0; padding-left: 18px; }
  .box li { margin-bottom: 4px; }
  .chain { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 4px; font-size: 12px; }
  .chain i { font-style: normal; border: 1px solid var(--line); border-radius: 999px; padding: 2px 9px; background: #f8fafc; }
  .chain i.hit { border-color: #fca5a5; background: #fef2f2; color: var(--deny); font-weight: 600; }
  .foot { margin-top: 14px; color: var(--muted); font-size: 12px; }
</style></head><body>
<div class="bar"><span class="tag">无人值守</span><span>每日 08:00 交付风险巡检 · 批次 DR-2026-0809 · 本轮无人工发起</span></div>

<h1>交付风险晨报 · ${demoWorldFixture.demoDate.iso}</h1>
<p class="sub">生成时间 ${demoWorldFixture.demoDate.iso} 08:07 · 覆盖 ${demoWorldFixture.inTransitOrders.count} 张在途订单，合计 ¥${demoWorldFixture.inTransitOrders.totalAmountWan.toFixed(1)} 万 · 下一轮巡检 2026-08-10 08:00</p>

<div class="stats">
  <div class="stat"><b class="deny">1</b><span>高危 · 已确定赶不上</span></div>
  <div class="stat"><b class="warn">1</b><span>中危 · 还来得及</span></div>
  <div class="stat"><b class="ok">15</b><span>正常</span></div>
  <div class="stat"><b>2</b><span>系统预警核为误报</span></div>
</div>

<table>
  <tr><th>订单</th><th>客户 / 金额</th><th>承诺交期</th><th>风险</th><th>卡点</th></tr>
  <tr>
    <td>${demoWorldFixture.deliveryOrder.id}<br><span class="note">精密结构件 2,400 件</span></td>
    <td>${demoWorldFixture.deliveryOrder.customer}<br><span class="note">￥${demoWorldFixture.deliveryOrder.amountCny.toLocaleString("en-US")}</span></td>
    <td>${demoWorldFixture.deliveryOrder.promisedDeliveryDate}</td>
    <td class="deny">高危</td>
    <td>${demoWorldFixture.deliveryOrder.material.name} ${demoWorldFixture.deliveryOrder.material.model} 需求 ${demoWorldFixture.deliveryOrder.material.requiredQuantity} 件、缺口 ${demoWorldFixture.deliveryOrder.material.shortageQuantity} 件、现库 ${demoWorldFixture.deliveryOrder.material.stockQuantity}；PO-2026-0886 口头承诺 ${demoWorldFixture.deliveryOrder.material.supplierVerbalDeliveryDate} 到货，无发货单号</td>
  </tr>
  <tr>
    <td>SO-2026-1033<br><span class="note">注塑件 5,600 件</span></td>
    <td>蓝谷自动化<br><span class="note">￥312,000</span></td>
    <td>2026-08-22</td>
    <td class="warn">中危</td>
    <td>图纸 GD-1033-B 客户未确认，约定 8-06 回复已拖 3 天</td>
  </tr>
  <tr>
    <td>SO-2026-1041</td>
    <td>启润电子<br><span class="note">￥178,000</span></td>
    <td>2026-08-19</td>
    <td class="ok">正常</td>
    <td class="note">系统标黄，核后为误报：在途料 8-08 已到，在检验中</td>
  </tr>
  <tr>
    <td>SO-2026-1044</td>
    <td>海川机械<br><span class="note">￥256,000</span></td>
    <td>2026-08-26</td>
    <td class="ok">正常</td>
    <td class="note">系统标黄，核后为误报：排产已前移 2 天，工时有余量</td>
  </tr>
  <tr>
    <td>其余 13 张在途订单</td>
    <td class="note">合计 ￥2,417,000</td>
    <td>2026-08-18 至 2026-09-14</td>
    <td class="ok">正常</td>
    <td class="note">物料齐套、排产已锁、无客户待办卡点</td>
  </tr>
</table>

<div class="box">
  <h2>高危单倒推 · ${demoWorldFixture.deliveryOrder.id}（${demoWorldFixture.deliveryOrder.customer}）</h2>
  <div class="chain">
    <i>承诺交期 ${demoWorldFixture.deliveryOrder.promisedDeliveryDate}</i><i>物流 1 天 → 8-14 发货</i><i>出货检验 1 天 → 8-13 完工</i><i>装配 ${demoWorldFixture.deliveryOrder.material.assemblyDays} 天 → 8-10 上料</i><i class="hit">轴承口头承诺到货 ${demoWorldFixture.deliveryOrder.material.supplierVerbalDeliveryDate}</i>
  </div>
  <ul>
    <li><b>缺口 2 天</b>：最晚上料日 8-10，轴承最早 ${demoWorldFixture.deliveryOrder.material.supplierVerbalDeliveryDate} 才到，按现有工艺路线完工日落在 8-17，比承诺交期晚 2 天。</li>
    <li><b>到货承诺不成立</b>：PO-2026-0886 采购单上华矩传动 8-05 口头回复「${demoWorldFixture.deliveryOrder.material.supplierVerbalDeliveryDate} 到」，采购系统里没有发货单号、没有物流单号、没有发货照片，三样都没有的到货日不能当计划输入用。</li>
    <li><b>替代料未启用</b>：库内有替代型号 6204-2RS 共 120 件，但数量不够，且换型号须客户书面认可 —— 这两条都不是跟单岗能定的，本报告只列事实。</li>
  </ul>
</div>

<div class="box mid">
  <h2>中危单 · SO-2026-1033（蓝谷自动化）</h2>
  <ul>
    <li>图纸 GD-1033-B 于 8-04 发出，约定 8-06 回复，至今 3 天无确认。</li>
    <li>排产锁定窗口 8-12：8-12 前确认不影响 8-22 交期；每晚 1 天，完工日顺延 1 天。</li>
    <li>还有 3 天缓冲，今天只需要一条催确认的话，不用惊动排产。</li>
  </ul>
</div>

<div class="box mid">
  <h2>今日动作与复查</h2>
  <ul>
    <li><b>催货 PO-2026-0886</b> — 任务派给采购，要求 8-10 12:00 前拿到发货单号或明确的不能到货答复；拿不到即视同 8-12 不到货，按 8-17 完工重排。</li>
    <li><b>排产口径</b> — 补班或插单方案由生产计划出，未出方案前不向客户给任何新日期。</li>
    <li><b>承诺交期</b> — 保持 ${demoWorldFixture.deliveryOrder.promisedDeliveryDate} 不变。改期须销售向客户取得书面确认后，由跟单在订单中心提交改期申请。</li>
    <li><b>复查点</b> — 今日 14:00 查发货单号；2026-08-10 08:00 本巡检自动续查，仍无单号则升级给生产计划与销售。</li>
  </ul>
</div>

<p class="foot">示例内容，不对应任何真实企业、订单、采购单或人员。本表的到货日一律以发货单号或物流单号为准，不以口头承诺代替。</p>
</body></html>`;

const MORNING_REPORT_SIZE_BYTES = new TextEncoder().encode(MORNING_REPORT_HTML).length;

/** 面板底稿：订单中心 / 物料与库存 / 企业 IM / 权限矩阵 / 操作留痕 */
const PANEL_BASE: SystemPanelSnapshot = {
  title: "企业系统实况",
  live: true,
  activeView: "orders",
  foot: "已连接：订单中心 · 物料与库存 · 企业 IM · 权限矩阵（演示）",
  views: [
    {
      key: "orders",
      label: "订单中心",
      winTitle: "订单中心 · 在途订单",
      toolbar: { title: "在途订单", sub: "等待每日排程触发" },
      widget: {
        kind: "table",
        cols: [
          { key: "so", label: "订单" },
          { key: "cust", label: "客户" },
          { key: "due", label: "承诺交期" },
          { key: "risk", label: "风险", align: "right" },
        ],
        rows: [],
        empty: { title: "尚未开始巡检" },
      },
    },
    {
      key: "materials",
      label: "物料与库存",
      winTitle: "物料与库存 · 缺口与在途",
      toolbar: { title: "缺口物料与在途采购", sub: "尚未核对" },
      widget: {
        kind: "table",
        cols: [
          { key: "item", label: "物料" },
          { key: "need", label: "缺口" },
          { key: "po", label: "在途采购" },
          { key: "eta", label: "到货依据", align: "right" },
        ],
        rows: [],
        empty: { title: "尚未读取物料缺口" },
      },
    },
    {
      key: "im",
      label: "企业 IM",
      winTitle: "企业 IM · 任务派发与群通知",
      toolbar: { title: "已发出的消息", sub: "0 条" },
      widget: { kind: "feed", items: [], empty: { title: "本轮尚未发出任何消息" } },
    },
    {
      key: "rights",
      label: "权限矩阵",
      winTitle: "权限矩阵 · 跟单岗可执行动作",
      toolbar: { title: "权限矩阵 · 由 IT 依岗位表维护", sub: "只读" },
      widget: {
        kind: "table",
        cols: [
          { key: "act", label: "数据域 / 动作" },
          { key: "grant", label: "本岗位授权" },
          { key: "owner", label: "授权来源", align: "right" },
        ],
        rows: [],
        empty: { title: "尚未触达权限判定" },
      },
    },
    {
      key: "audit",
      label: "操作留痕",
      winTitle: "操作留痕 · 本轮巡检",
      toolbar: { title: "本轮巡检的系统动作", sub: "0 条" },
      widget: { kind: "feed", items: [], empty: { title: "尚无系统动作" } },
    },
  ],
};

export const deliveryRiskDailyScript: ReplayScript = {
  scenarioId: "catalog-hook-delivery-risk-daily",
  title: "每天 8 点挑出有交付风险的订单",
  mode: "quick",
  artifacts: { [MORNING_REPORT_PATH]: MORNING_REPORT_HTML },

  steps: [
    {
      caption: "08:00 排程自己起手",
      blocks: [
        {
          id: "dr1-trigger",
          kind: "text",
          title: "定时任务触发",
          defaultOpen: true,
          replayInstant: true,
          content: [
            "每天 08:00 交付风险巡检已启动，批次 DR-2026-0809。",
            "这一轮没有人提问。排程到点自己发起：拉全部在途订单 → 按承诺交期倒推每一单的最晚上料日与完工日 → 谁赶不上就挑出来，赶得上的不打扰你。",
          ].join("\n"),
        },
        {
          id: "dr1-tool",
          kind: "tool_use",
          title: "OrderScan",
          defaultOpen: true,
          toolName: "OrderScan",
          toolId: "t-scan",
          content: JSON.stringify({ batch: "DR-2026-0809", trigger: "cron 0 8 * * *" }),
          executionStatus: "completed",
          durationMs: 1280,
          presentation: {
            title: "扫描订单中心的在途订单",
            detail: [
              { k: "触发方式", v: "每日 08:00 排程 · 无人工介入" },
              { k: "在途订单", v: `${demoWorldFixture.inTransitOrders.count} 张 · 合计 ¥${demoWorldFixture.inTransitOrders.totalAmountWan.toFixed(1)} 万` },
              { k: "交期在 14 天内", v: "6 张" },
              { tree: "├", k: "系统已标黄", v: "4 张（待逐张核实，标黄不等于有风险）" },
              { tree: "└", k: "上轮遗留", v: "0 张（08-08 批次已全部闭环）" },
            ],
            status: "ok",
            panelBase: PANEL_BASE,
            panel: [
              { op: "focus", view: "orders" },
              { op: "toolbar", view: "orders", title: `在途订单 · 批次 DR-2026-${demoWorldFixture.demoDate.compact}`, sub: `${demoWorldFixture.inTransitOrders.count} 张在途 · 6 张 14 天内交付` },
              { op: "tableRowInsert", view: "orders", row: { id: "so-1027", cells: { so: demoWorldFixture.deliveryOrder.id, cust: demoWorldFixture.deliveryOrder.customer, due: demoWorldFixture.deliveryOrder.promisedDeliveryDate, risk: "待判定" } } },
              { op: "tableRowInsert", view: "orders", row: { id: "so-1033", cells: { so: "SO-2026-1033", cust: "蓝谷自动化", due: "2026-08-22", risk: "待判定" } } },
              { op: "tableRowInsert", view: "orders", row: { id: "so-1041", cells: { so: "SO-2026-1041", cust: "启润电子", due: "2026-08-19", risk: "待判定" } } },
              { op: "tableRowInsert", view: "orders", row: { id: "so-1044", cells: { so: "SO-2026-1044", cust: "海川机械", due: "2026-08-26", risk: "待判定" } } },
              { op: "tableRowInsert", view: "orders", row: { id: "so-rest", cells: { so: "其余 13 张", cust: "多客户", due: "08-18 至 09-14", risk: "待判定" } } },
              { op: "pulse", view: "orders", ids: ["so-1027", "so-1033", "so-1041", "so-1044"], kind: "scan" },
              { op: "feedAppend", view: "audit", item: { id: "ad-1", from: "AI 同事", time: "08:00:02", text: `排程触发巡检批次 DR-2026-${demoWorldFixture.demoDate.compact}，读取订单中心在途订单 ${demoWorldFixture.inTransitOrders.count} 张（只读）` } },
              { op: "toolbar", view: "audit", title: "本轮巡检的系统动作", sub: "1 条" },
            ],
          },
        },
        {
          id: "dr1-result",
          kind: "tool_result",
          title: "OrderScan 结果",
          defaultOpen: false,
          toolName: "OrderScan",
          toolId: "t-scan",
          content: "batch=DR-2026-0809 open_orders=17 due_in_14d=6 flagged=4 carryover=0",
        },
        {
          id: "dr1-text",
          kind: "text",
          title: "业务进展",
          defaultOpen: true,
          content: `${demoWorldFixture.inTransitOrders.count} 张在途订单都拉出来了，其中 6 张交期在 14 天内。系统自己标黄了 4 张，我不直接用这个结果——标黄只看交期近不近，不看料到没到。接下来我按每张单的承诺交期往回倒推：物流、检验、装配各占几天，算出最晚上料日，再拿它和物料实际到货日比。`,
        },
      ],
    },

    {
      caption: "逐张倒推，挑出真有风险的两张",
      blocks: [
        {
          id: "dr2-tool",
          kind: "tool_use",
          title: "RiskAssess",
          defaultOpen: true,
          toolName: "RiskAssess",
          toolId: "t-risk",
          content: JSON.stringify({ batch: "DR-2026-0809", orders: 17 }),
          executionStatus: "completed",
          durationMs: 2140,
          presentation: {
            title: "按承诺交期倒推每张单的完工日",
            detail: [
              { section: `判定结果 · ${demoWorldFixture.inTransitOrders.count} 张` },
              {
                risk: "high",
                text: `${demoWorldFixture.deliveryOrder.id} ${demoWorldFixture.deliveryOrder.customer} ￥${demoWorldFixture.deliveryOrder.amountCny.toLocaleString("en-US")} · 承诺交期 ${demoWorldFixture.deliveryOrder.promisedDeliveryDate}`,
                action: `倒推最晚上料日 08-10；${demoWorldFixture.deliveryOrder.material.name} ${demoWorldFixture.deliveryOrder.material.model} 需求/缺口 ${demoWorldFixture.deliveryOrder.material.requiredQuantity} 件、现库 ${demoWorldFixture.deliveryOrder.material.stockQuantity}，口头承诺到货 ${demoWorldFixture.deliveryOrder.material.supplierVerbalDeliveryDate}，完工落在 08-17，晚 2 天`,
              },
              {
                risk: "medium",
                text: "SO-2026-1033 蓝谷自动化 ￥312,000 · 承诺交期 08-22",
                action: "图纸 GD-1033-B 约定 08-06 回复，已拖 3 天；排产锁定窗口 08-12，今天催确认还来得及",
              },
              { verdict: "pass", text: "SO-2026-1041 启润电子", note: "系统标黄是误报——在途料 08-08 已到，正在检验，08-11 可上线" },
              { verdict: "pass", text: "SO-2026-1044 海川机械", note: "系统标黄是误报——排产已前移 2 天，本周工时有 34 小时余量" },
              { verdict: "pass", text: "其余 13 张", note: "物料齐套、排产已锁、无客户侧待办卡点" },
              { insight: "只有 1027 是真赶不上，1033 是还来得及但今天必须动一下；另外 15 张不用你管", label: "结论" },
            ],
            status: "warn",
            panel: [
              { op: "focus", view: "orders" },
              { op: "toolbar", view: "orders", title: "在途订单 · 风险判定完成", sub: "高危 1 · 中危 1 · 正常 15" },
              { op: "tableRowUpdate", view: "orders", id: "so-1027", set: { cells: { so: demoWorldFixture.deliveryOrder.id, cust: demoWorldFixture.deliveryOrder.customer, due: demoWorldFixture.deliveryOrder.promisedDeliveryDate, risk: "高危 · 缺料" }, tone: "deny" } },
              { op: "cellFlag", view: "orders", rowId: "so-1027", colKey: "risk", tone: "deny", flag: "晚 2 天" },
              { op: "tableRowUpdate", view: "orders", id: "so-1033", set: { cells: { so: "SO-2026-1033", cust: "蓝谷自动化", due: "2026-08-22", risk: "中危 · 待客户确认" }, tone: "warn" } },
              { op: "cellFlag", view: "orders", rowId: "so-1033", colKey: "risk", tone: "warn", flag: "拖 3 天" },
              { op: "tableRowUpdate", view: "orders", id: "so-1041", set: { cells: { so: "SO-2026-1041", cust: "启润电子", due: "2026-08-19", risk: "正常" }, tone: "pass" } },
              { op: "cellFlag", view: "orders", rowId: "so-1041", colKey: "risk", tone: "pass", flag: "误报" },
              { op: "tableRowUpdate", view: "orders", id: "so-1044", set: { cells: { so: "SO-2026-1044", cust: "海川机械", due: "2026-08-26", risk: "正常" }, tone: "pass" } },
              { op: "cellFlag", view: "orders", rowId: "so-1044", colKey: "risk", tone: "pass", flag: "误报" },
              { op: "tableRowUpdate", view: "orders", id: "so-rest", set: { cells: { so: "其余 13 张", cust: "多客户", due: "08-18 至 09-14", risk: "正常" }, tone: "pass" } },
              { op: "feedAppend", view: "audit", item: { id: "ad-2", from: "AI 同事", time: "08:00:41", text: `倒推 ${demoWorldFixture.inTransitOrders.count} 张在途订单完工日：高危 1 · 中危 1 · 正常 15，其中 2 张系统标黄经核为误报` } },
              { op: "toolbar", view: "audit", title: "本轮巡检的系统动作", sub: "2 条" },
            ],
          },
        },
        {
          id: "dr2-text",
          kind: "text",
          title: "业务进展",
          defaultOpen: true,
          content: [
            "两张单要动，理由都摆在下面：",
            "",
            `1. **${demoWorldFixture.deliveryOrder.id} ${demoWorldFixture.deliveryOrder.customer}，赶不上**。承诺 ${demoWorldFixture.deliveryOrder.promisedDeliveryDate} 交，往回扣：物流 1 天、出货检验 1 天、装配 ${demoWorldFixture.deliveryOrder.material.assemblyDays} 天，最晚 08-10 就得上料。${demoWorldFixture.deliveryOrder.material.name} ${demoWorldFixture.deliveryOrder.material.model} 需求/缺口 ${demoWorldFixture.deliveryOrder.material.shortageQuantity} 件、现库 ${demoWorldFixture.deliveryOrder.material.stockQuantity}，采购单上的口头到货日是 ${demoWorldFixture.deliveryOrder.material.supplierVerbalDeliveryDate}，比上料日晚 2 天，完工顺推到 08-17。`,
            "2. **SO-2026-1033 蓝谷，还来得及**。图纸 08-04 发出去，说好 08-06 回，到今天拖了 3 天。排产锁定窗口在 08-12，今天催一句就行，不用惊动排产。",
            "",
            "另外 2 张系统标了黄的，我核过是误报：启润那张的在途料昨天已经到厂在检验，海川那张排产还前移了 2 天。这两张不用你管，我也不写进今天的动作里。",
          ].join("\n"),
        },
      ],
    },

    {
      caption: "核缺料在途，发现到货承诺没有凭据",
      blocks: [
        {
          id: "dr3-tool",
          kind: "tool_use",
          title: "MaterialTrace",
          defaultOpen: true,
          toolName: "MaterialTrace",
          toolId: "t-material",
          content: JSON.stringify({ order: demoWorldFixture.deliveryOrder.id, item: demoWorldFixture.deliveryOrder.material.model, shortage: demoWorldFixture.deliveryOrder.material.shortageQuantity }),
          executionStatus: "completed",
          durationMs: 1620,
          presentation: {
            title: `追查 ${demoWorldFixture.deliveryOrder.id} 的缺料在途情况`,
            detail: [
              { k: "缺口物料", v: `${demoWorldFixture.deliveryOrder.material.name} ${demoWorldFixture.deliveryOrder.material.model} · 需求 ${demoWorldFixture.deliveryOrder.material.requiredQuantity} 件 · 缺口 ${demoWorldFixture.deliveryOrder.material.shortageQuantity} 件 · 现库 ${demoWorldFixture.deliveryOrder.material.stockQuantity}` },
              { k: "在途采购单", v: `PO-2026-0886 · 华矩传动 · ${demoWorldFixture.deliveryOrder.material.shortageQuantity} 件` },
              { tree: "├", k: "采购单到货日", v: `填的是 ${demoWorldFixture.deliveryOrder.material.supplierVerbalDeliveryDate}，来源是 08-05 电话口头回复` },
              { tree: "├", k: "发货单号", v: "无" },
              { tree: "└", k: "物流单号", v: "无" },
              { warn: `没有发货单号、没有物流单号，${demoWorldFixture.deliveryOrder.material.supplierVerbalDeliveryDate} 这个日期眼下只是一句话，不能当排产输入用` },
              { verdict: "pending", text: "替代型号 6204-2RS 库存 120 件", note: "数量不够，且换型号须客户书面认可 —— 这条不归我判，只登记" },
              { insight: `按最坏情况准备：若 ${demoWorldFixture.deliveryOrder.material.supplierVerbalDeliveryDate} 到货不成立，完工日还会继续后移`, label: "判定" },
            ],
            status: "waiting",
            panel: [
              { op: "focus", view: "materials" },
              { op: "toolbar", view: "materials", title: `缺口物料与在途采购 · ${demoWorldFixture.deliveryOrder.id}`, sub: "1 项缺口 · 到货依据不足" },
              { op: "tableRowInsert", view: "materials", row: { id: "mt-6204", cells: { item: `${demoWorldFixture.deliveryOrder.material.name} ${demoWorldFixture.deliveryOrder.material.model}`, need: `需求 ${demoWorldFixture.deliveryOrder.material.requiredQuantity} · 现库 ${demoWorldFixture.deliveryOrder.material.stockQuantity} · 缺口 ${demoWorldFixture.deliveryOrder.material.shortageQuantity}`, po: "PO-2026-0886 · 华矩传动", eta: `口头 ${demoWorldFixture.deliveryOrder.material.supplierVerbalDeliveryDate} · 无单号` }, tone: "deny", flags: { eta: { tone: "deny", flag: "无凭据" } } } },
              { op: "tableRowInsert", view: "materials", row: { id: "mt-alt", cells: { item: "替代型号 6204-2RS", need: "库存 120 件", po: "无需采购", eta: "须客户书面认可" }, tone: "pending", flags: { eta: { tone: "warn", flag: "不归我判" } } } },
              { op: "pulse", view: "materials", ids: ["mt-6204"], kind: "hit" },
              { op: "cellFlag", view: "orders", rowId: "so-1027", colKey: "due", tone: "warn", flag: "完工预估 08-17" },
              { op: "feedAppend", view: "audit", item: {
                id: "ad-3",
                from: "AI 同事",
                time: "08:01:26",
                text: `核对 PO-2026-0886 在途记录：无发货单号、无物流单号，到货日 ${demoWorldFixture.deliveryOrder.material.supplierVerbalDeliveryDate} 缺少凭据`,
                card: { title: "到货承诺未证实", body: "口头承诺不写进排产输入；已挂今日 14:00 与明日 08:00 两个复查点", meta: [{ text: "未改任何日期", tone: "pass" }, { text: "已挂复查", tone: "info" }] },
              } },
              { op: "toolbar", view: "audit", title: "本轮巡检的系统动作", sub: "3 条" },
            ],
          },
        },
        {
          id: "dr3-text",
          kind: "text",
          title: "为什么我不认这个到货日",
          defaultOpen: true,
          content: [
            `采购单上 ${demoWorldFixture.deliveryOrder.material.supplierVerbalDeliveryDate} 这个日期，往回查只有一条 08-05 的电话记录，供应商那边没出发货单号、没有物流单号，仓库也没收到发货通知。**这三样都没有的到货日，我不写进排产输入**。`,
            "",
            `所以 08-17 这个完工预估，是按「${demoWorldFixture.deliveryOrder.material.supplierVerbalDeliveryDate} 真能到」算出来的最好情况。真到不了，还要继续往后移。`,
            "",
            "库里有替代型号 6204-2RS 共 120 件，数量不够，而且换型号要客户书面认可 —— 换不换是你和销售的事，我只把这条事实登记下来，不替你做主。",
          ].join("\n"),
        },
      ],
    },

    {
      caption: "想直接改交期，被拦住",
      blocks: [
        {
          id: "dr4-prompt",
          kind: "prompt",
          title: "用户消息",
          defaultOpen: true,
          content: `那简单，你把 ${demoWorldFixture.deliveryOrder.id} 的交期从 ${demoWorldFixture.deliveryOrder.promisedDeliveryDate} 改成 2026-08-18，风险不就没了吗？先改了再说。`,
        },
        {
          id: "dr4-tool",
          kind: "tool_use",
          title: "DueDateAmend",
          defaultOpen: true,
          toolName: "DueDateAmend",
          toolId: "t-amend",
          content: JSON.stringify({ order: demoWorldFixture.deliveryOrder.id, from: demoWorldFixture.deliveryOrder.promisedDeliveryDate, to: "2026-08-18" }),
          executionStatus: "completed",
          durationMs: 240,
          presentation: {
            title: "承诺交期变更 · 权限判定",
            detail: [
              { k: "请求动作", v: `改写 ${demoWorldFixture.deliveryOrder.id} 承诺交期 ${demoWorldFixture.deliveryOrder.promisedDeliveryDate} → 2026-08-18` },
              { k: "动作性质", v: "对客户的书面承诺变更" },
              { k: "本岗位授权", v: "跟单可标记风险，不可改承诺交期" },
              { verdict: "fail", text: "越权，按权限矩阵拒绝", note: "订单未做任何改动 · 拦截已记账" },
            ],
            status: "blocked",
            panel: [
              { op: "focus", view: "rights" },
              { op: "toolbar", view: "rights", title: "权限矩阵 · 跟单岗可执行动作", sub: "命中 1 条拒绝" },
              { op: "tableRowInsert", view: "rights", row: { id: "rt-read", cells: { act: "在途订单与排产查询", grant: "允许", owner: "岗位表" } } },
              { op: "tableRowInsert", view: "rights", row: { id: "rt-flag", cells: { act: "订单风险标记", grant: "允许", owner: "岗位表" } } },
              { op: "tableRowInsert", view: "rights", row: { id: "rt-due", cells: { act: "客户承诺交期变更", grant: "拒绝", owner: "须客户书面确认" }, tone: "deny" } },
              { op: "cellFlag", view: "rights", rowId: "rt-due", colKey: "grant", tone: "deny", flag: "无授权" },
              { op: "tableRowInsert", view: "rights", row: { id: "rt-price", cells: { act: "供应商合同与结算价", grant: "拒绝", owner: "采购部" } } },
              { op: "feedAppend", view: "audit", item: {
                id: "ad-4",
                from: "AI 同事",
                time: "08:06:10",
                text: "承诺交期变更请求被权限矩阵拦截，订单中心零写入",
                card: { title: "越权动作已拦截", body: "改承诺交期属于对客户的承诺变更，须走获批改期流程；已给出合规路径", meta: [{ text: "订单未改", tone: "pass" }, { text: "已记账", tone: "info" }] },
              } },
              { op: "toolbar", view: "audit", title: "本轮巡检的系统动作", sub: "4 条" },
            ],
          },
        },
        {
          id: "dr4-text",
          kind: "text",
          title: "回复",
          defaultOpen: true,
          content: [
            `**这个我不能改，也不会绕过去**。${demoWorldFixture.deliveryOrder.promisedDeliveryDate} 是写给客户的承诺日期，在系统里改掉它不等于风险没了，只等于客户还按 ${demoWorldFixture.deliveryOrder.promisedDeliveryDate} 等货、我们自己的账变成了 2026-08-18 —— 到时候更难收场。右侧权限矩阵里这一行是明确拒绝的，订单我一个字没动。`,
            "",
            "要缓解风险，有两条正规路：",
            "",
            `1. 先不改期：让生产计划出补班或插单方案，看能不能把装配的 ${demoWorldFixture.deliveryOrder.material.assemblyDays} 天压到 2 天。能压下来，${demoWorldFixture.deliveryOrder.promisedDeliveryDate} 还保得住；`,
            "2. 确实要改期：由销售拿着缺料事实向客户说明并取得书面确认，然后你在订单中心提交改期申请，走完审批我再更新排产。",
            "",
            "我建议先走第 1 条 —— 今天离最晚上料日还有 1 天，方案出得来的话不必惊动客户。",
          ].join("\n"),
        },
      ],
    },

    {
      caption: "生成今天的交付风险晨报",
      blocks: [
        {
          id: "dr5-tool",
          kind: "tool_use",
          title: "Write",
          defaultOpen: true,
          toolName: "Write",
          toolId: "t-report",
          content: JSON.stringify({ file_path: MORNING_REPORT_PATH }),
          executionStatus: "completed",
          durationMs: 1380,
          presentation: {
            title: "生成 08-09 交付风险晨报",
            detail: [
              { k: "产物", v: "交付风险晨报（HTML · 自包含）" },
              { k: "覆盖", v: `${demoWorldFixture.inTransitOrders.count} 张在途订单 · 风险 / 卡点 / 依据三列分开` },
              { tree: "├", k: "高危", v: `${demoWorldFixture.deliveryOrder.id} · 附倒推链与缺口 2 天的算法` },
              { tree: "├", k: "中危", v: "SO-2026-1033 · 附排产锁定窗口 08-12" },
              { tree: "└", k: "误报说明", v: "2 张系统标黄单，写明为什么不算风险" },
            ],
            status: "ok",
            panel: [
              { op: "focus", view: "audit" },
              { op: "feedAppend", view: "audit", item: {
                id: "ad-5",
                from: "AI 同事",
                time: "08:07:35",
                text: "生成交付风险晨报 DR-2026-0809，尚未发送给任何人",
                card: { title: "晨报已生成", body: "高危 1 · 中危 1 · 正常 15；发不发、发给谁，等你确认", meta: [{ text: "未对外发出", tone: "pass" }] },
              } },
              { op: "toolbar", view: "audit", title: "本轮巡检的系统动作", sub: "5 条" },
            ],
          },
        },
        {
          id: "dr5-text",
          kind: "text",
          title: "回复",
          defaultOpen: true,
          content: [
            "晨报出来了。它跟系统那张标黄清单最大的差别是**每条风险后面都跟着依据**，你可以逐条核我算得对不对：",
            "",
            `[FILE]{"filePath":"${MORNING_REPORT_PATH}","fileName":"交付风险晨报.html","fileSize":${MORNING_REPORT_SIZE_BYTES}}[/FILE]`,
            "",
            "这份现在只在你手上，我没有发给任何人。下面两条消息要不要发出去，你说了算。",
          ].join("\n"),
        },
      ],
    },

    {
      caption: "两条消息交人确认后再发",
      blocks: [],
      approval: {
        title: "催货任务与风险预警 · 需跟单确认后才发出",
        description: "确认后才会派发催货任务、才会在项目群发预警。群里有客户方人员，对外口径由人定，AI 不自行发出。",
        facts: [
          { label: "高危订单", value: `${demoWorldFixture.deliveryOrder.id} · ${demoWorldFixture.deliveryOrder.customer} · ￥${demoWorldFixture.deliveryOrder.amountCny.toLocaleString("en-US")} · 承诺交期 ${demoWorldFixture.deliveryOrder.promisedDeliveryDate}` },
          { label: "消息一 · 催货", value: "发给 采购 刘志强：PO-2026-0886 缺发货单号，请 08-10 12:00 前给到单号或明确答复" },
          { label: "消息二 · 预警", value: `发到 ${demoWorldFixture.deliveryOrder.customer}项目群：轴承到货存在 2 天缺口，完工预估 08-17，正在制定补班方案` },
          { label: "群成员", value: "本方 6 人 + 客户方 3 人（含采购部 郑海峰）" },
          { label: "AI 自动执行", value: "0 项 · 两条都停在这里等你" },
        ],
        approveLabel: "确认发出",
        rejectLabel: "退回修改",
        approvedBlocks: [
          {
            id: "dr6-human",
            kind: "prompt",
            title: "用户消息",
            defaultOpen: true,
            content: "催货那条照发，刘志强那边不用改。但群预警先别发 —— 那个群里有郑海峰他们的人，我们自己排产口径都还没定，先说完工 08-17 等于把话说死了。你把这条内容私聊发给吴国栋，等他给补班方案，我再决定要不要跟客户讲。",
          },
          {
            id: "dr6-tool",
            kind: "tool_use",
            title: "Approval",
            defaultOpen: true,
            toolName: "Approval",
            toolId: "t-approve",
            content: JSON.stringify({ batch: "DR-2026-0809", decision: "approved", messages: 2 }),
            executionStatus: "completed",
            durationMs: 360,
            presentation: {
              title: "已按你的口径发出 · 含人工修改 1 项",
              detail: [
                { k: "审批结果", v: "确认发出" },
                { k: "人工决定", v: "采纳 1 项 · 修改 1 项 · 自动执行 0 项" },
                { tree: "├", k: "采纳", v: "催货任务原文发给刘志强 · 回执 TD-1207 · 08:23 已读" },
                { tree: "├", k: "修改", v: "群预警改为私聊生产计划 吴国栋 · 恒岳项目群 0 条消息" },
                { tree: "└", k: "留痕", v: "AI 原拟的群发口径与这处改动逐条留档" },
              ],
              status: "ok",
              receipt: { id: "TD-1207", system: "企业 IM · 任务派发", readBack: true },
              panel: [
                { op: "focus", view: "im" },
                { op: "toolbar", view: "im", title: "已发出的消息", sub: "2 条 · 群消息 0 条" },
                { op: "feedAppend", view: "im", item: {
                  id: "im-po",
                  from: "AI 同事",
                  time: "08:22:14",
                  text: `@刘志强 PO-2026-0886 ${demoWorldFixture.deliveryOrder.material.name} ${demoWorldFixture.deliveryOrder.material.model} ${demoWorldFixture.deliveryOrder.material.shortageQuantity} 件，采购单写 ${demoWorldFixture.deliveryOrder.material.supplierVerbalDeliveryDate} 到货，但系统里没有发货单号和物流单号。`,
                  card: { title: "催货任务 TD-1207", body: `请 08-10 12:00 前给到发货单号，或明确答复到不了；这批料绑 ${demoWorldFixture.deliveryOrder.id}，最晚上料日 08-10`, meta: [{ text: "已送达", tone: "pass" }, { text: "08:23 已读", tone: "info" }] },
                } },
                { op: "feedAppend", view: "im", item: {
                  id: "im-wu",
                  from: "AI 同事",
                  time: "08:22:31",
                  text: `@吴国栋 私聊：${demoWorldFixture.deliveryOrder.id} 轴承到货比最晚上料日晚 2 天，完工预估 08-17。想先跟你对齐补班或插单的可能，再决定要不要跟客户说。`,
                  card: { title: "私聊 · 未进项目群", body: "按跟单要求改为先内部对齐；恒岳项目群本轮未发任何消息", meta: [{ text: "口径以人为准", tone: "info" }, { text: "群内 0 条", tone: "pass" }] },
                } },
                { op: "cellFlag", view: "materials", rowId: "mt-6204", colKey: "po", tone: "warn", flag: "已催 · 待回单号" },
                { op: "cellFlag", view: "orders", rowId: "so-1027", colKey: "risk", tone: "deny", flag: "已挂催货" },
                { op: "feedAppend", view: "audit", item: {
                  id: "ad-6",
                  from: "周晓芸",
                  time: "08:22:40",
                  text: "确认发出：采纳 1 项（催货任务）、修改 1 项（群预警改私聊）、AI 自动发出 0 条",
                  card: { title: "人审记录", body: "采纳 1 · 修改 1 · 自动执行 0", meta: [{ text: "对外口径由人定", tone: "pass" }] },
                } },
                { op: "toolbar", view: "audit", title: "本轮巡检的系统动作", sub: "6 条" },
              ],
            },
          },
          {
            id: "dr6-text",
            kind: "text",
            title: "审批结果",
            defaultOpen: true,
            content: "按你说的办了：催货任务原文发给刘志强，回执 TD-1207，他 08:23 已读；那条预警没有进恒岳项目群，改成私聊给了吴国栋，客户那边今天不会看到任何关于 08-17 的说法。我原来拟的群发版本只留在留痕里作对照。吴国栋回补班方案之前，这一单我不会再对外说话。",
          },
        ],
        rejectedBlocks: [
          {
            id: "dr6-rejected-tool",
            kind: "tool_use",
            title: "Approval",
            defaultOpen: true,
            toolName: "Approval",
            toolId: "t-reject",
            content: JSON.stringify({ batch: "DR-2026-0809", decision: "rejected" }),
            executionStatus: "completed",
            durationMs: 280,
            presentation: {
              title: "两条消息被退回 · 一条都没发出去",
              detail: [
                { k: "审批结果", v: "退回修改" },
                { k: "催货任务", v: "未派发，刘志强未收到任何消息" },
                { k: "群预警", v: "未发送，恒岳项目群 0 条消息" },
                { tree: "├", k: "业务系统", v: "订单中心、物料与库存均无写入" },
                { tree: "└", k: "晨报", v: "仍在，可随时下载或改完重发" },
              ],
              status: "blocked",
              panel: [
                { op: "focus", view: "im" },
                { op: "toolbar", view: "im", title: "已发出的消息", sub: "0 条" },
                { op: "feedAppend", view: "im", item: {
                  id: "im-hold",
                  from: "AI 同事",
                  time: "08:22:14",
                  text: "两条消息均未发出，停在审批点等待重新提交。",
                  card: { title: "对外动作全部停住", body: `${demoWorldFixture.deliveryOrder.id} 的风险仍在，最晚上料日 08-10；明早 08:00 巡检会把这一单重新推给你`, meta: [{ text: "零对外消息", tone: "pass" }, { text: "退回已记账", tone: "info" }] },
                } },
                { op: "feedAppend", view: "audit", item: { id: "ad-6r", from: "周晓芸", time: "08:22:40", text: "催货任务与群预警退回修改：未派发、未群发，业务系统零写入" } },
                { op: "toolbar", view: "audit", title: "本轮巡检的系统动作", sub: "6 条" },
              ],
            },
          },
          {
            id: "dr6-rejected-text",
            kind: "text",
            title: "退回说明",
            defaultOpen: true,
            content: "停住了：催货任务没派、群里没发，刘志强和客户那边什么都没收到，订单和物料记录也没有任何改动。晨报还在你手上，随时能下载。风险本身没有消失 —— 最晚上料日就是明天 08-10，改好口径再点一次确认，仍要走这道门。",
          },
        ],
      },
    },

    {
      caption: "回读终态并交账",
      blocks: [
        {
          id: "dr7-tool",
          kind: "tool_use",
          title: "DeliveryReadBack",
          defaultOpen: true,
          toolName: "DeliveryReadBack",
          toolId: "t-readback",
          content: JSON.stringify({ batch: "DR-2026-0809" }),
          executionStatus: "completed",
          durationMs: 1140,
          presentation: {
            title: "回读四处记录，核对说法是否一致",
            detail: [
              { k: "回读方式", v: "按单号逐个反查，不用本轮巡检的缓存" },
              { verdict: "pass", text: "订单中心", note: `${demoWorldFixture.deliveryOrder.id} 承诺交期仍是 ${demoWorldFixture.deliveryOrder.promisedDeliveryDate}，只多了一个风险标记` },
              { verdict: "pass", text: "物料与库存", note: "PO-2026-0886 标「到货承诺未证实」，替代料未启用" },
              { verdict: "pass", text: "企业 IM", note: "催货任务 TD-1207 已读；恒岳项目群 0 条消息" },
              { verdict: "pass", text: "操作留痕", note: "6 条动作，含 1 次拦截与 1 次人工改口径" },
              { insight: "四处口径一致；风险未消除，已带责任人与复查点转入明日巡检", label: "结论" },
            ],
            status: "ok",
            panel: [
              { op: "focus", view: "orders" },
              { op: "toolbar", view: "orders", title: "在途订单 · 批次终态", sub: "高危 1 已挂催货 · 中危 1 待客户确认" },
              { op: "feedAppend", view: "audit", item: { id: "ad-7", from: "AI 同事", time: "08:23:02", text: "回读订单中心 / 物料与库存 / 企业 IM / 操作留痕，四处状态一致；批次 DR-2026-0809 结束，2 张单转入明日续查" } },
              { op: "toolbar", view: "audit", title: "本轮巡检的系统动作", sub: "7 条" },
            ],
          },
        },
        {
          id: "dr7-text",
          kind: "text",
          title: "本轮巡检改变了什么",
          defaultOpen: true,
          content: [
            "## 本轮巡检改变了什么",
            "",
            "| 系统 | 终态 | 依据 |",
            "| --- | --- | --- |",
            `| 订单中心 | ${demoWorldFixture.deliveryOrder.id} 挂「交付风险 · 高」，承诺交期仍为 ${demoWorldFixture.deliveryOrder.promisedDeliveryDate} | 风险标记 RISK-1027-${demoWorldFixture.demoDate.compact}，回读一致 |`,
            "| 物料与库存 | PO-2026-0886 标「到货承诺未证实」，替代料未启用 | 无发货单号、无物流单号 |",
            "| 企业 IM | 催货任务 TD-1207 已送达刘志强并已读；恒岳项目群 0 条 | 送达回执 08:23，群预警按你的要求扣下 |",
            "| 操作留痕 | 本轮 6 条动作，含 1 次拦截、1 次人工改口径 | 越权改期请求与群改私聊均已记账 |",
            "",
            "## 本轮巡检没有做什么",
            "",
            `- 没有改动任何交期承诺：${demoWorldFixture.deliveryOrder.id} 仍是 ${demoWorldFixture.deliveryOrder.promisedDeliveryDate}，改期请求在权限矩阵处被拦下，订单零写入；`,
            "- 没有跳过采购直接找供应商：催货只发给刘志强，我没有联系华矩传动的任何人；",
            "- 没有向客户透露完工 08-17：群预警按你的口径改成了内部私聊，客户方今天看不到这个日期；",
            "- 没有启用替代型号：6204-2RS 只登记为可选项，换型须客户书面认可，不是我能定的；",
            "- 没有把 15 张正常单也报给你：其中 2 张系统标黄的，我核过是误报，理由写在晨报里备查。",
            "",
            `这就是我每天 08:00 自动做的事 —— ${demoWorldFixture.inTransitOrders.count} 张单我都看，只有真赶不上的才叫你。明早 08:00 这一轮会接着今天的卡点续查：刘志强 12:00 前给不出发货单号，我会直接升级给吴国栋和张明远。`,
          ].join("\n"),
        },
      ],
    },
  ],

  // 治理条款：state != exists 的条目就是「演示到真实」的距离。
  // 这条场景最贵的不是倒推逻辑，而是订单 / 物料台账的读取——那一段今天完全不存在。
  sources: [
    {
      blockRef: "step1.trigger.CronJob",
      producer: "定时任务调度器（server/src/cron）",
      state: "needs-change",
      gap: "按 cron 表达式定点发起 Agent 会话的能力已经有，但定时会话不产出 presentation / panelBase，右侧面板全空；且没有「批次」这种跨轮次状态载体，今天的卡点明早续查只能靠 Agent 重读上下文自己推断",
    },
    {
      blockRef: "step1.tool.OrderScan",
      producer: "租户业务数据连接器",
      state: "missing",
      gap: "通用的在途订单读取连接器不存在。订单散在客户自建 ERP 或订单系统里，今天只能读手工导出的表格，且没有「承诺交期 / 排产状态 / 系统预警位」这类结构化字段",
    },
    {
      blockRef: "step2.tool.RiskAssess",
      producer: "交付倒推规则集",
      state: "missing",
      gap: "物流 / 检验 / 装配各占几天是按产品族定的工艺参数，产品里没有可版本化的规则集与生效日期，现在全靠 Agent 临场推理；「系统标黄是不是误报」的复核逻辑同样无处安放",
    },
    {
      blockRef: "step3.tool.MaterialTrace",
      producer: "租户业务数据连接器",
      state: "missing",
      gap: "物料缺口、采购在途、发货单号三处数据分属库存与采购两个系统，均无连接器；「到货日有没有凭据」这个判断需要采购单的字段级来源标记，客户系统里通常也没有",
    },
    {
      blockRef: "step4.tool.DueDateAmend",
      producer: "数据域与动作门禁",
      state: "needs-change",
      gap: "门禁形态已在客户 POC 验证（loop 外独立判定 + 前端预设话术），但只覆盖读取范围，尚未产品化为「哪些写动作本岗位不可执行」的动作级矩阵",
    },
    {
      blockRef: "step5.tool.Write",
      producer: "Write 工具执行器",
      state: "needs-change",
      gap: "写文件本身已有，但不产出 presentation；产物摘要与留痕 feed 需由执行器统一补一层",
    },
    {
      blockRef: "step6.tool.Approval",
      producer: "业务审批执行器 + 钉钉 DWS 连接器",
      state: "needs-change",
      gap: "待办派发与群消息走 DWS 已经能发，但「人把群发改成私聊」这类口径改动没有结构化字段，只能落自由文本；送达与已读回执也需要 DWS 侧补一层回读才能进 ToolReceipt",
    },
    {
      blockRef: "step7.tool.DeliveryReadBack",
      producer: "业务终态回读器",
      state: "missing",
      gap: "跨系统回读要先有订单、物料、消息三处连接器；在此之前「四处口径一致」只能靠 Agent 自查，没有机器可验的一致性断言",
    },
    {
      blockRef: "step5.artifact.交付风险晨报",
      producer: "Agent 生成 HTML 产物",
      state: "exists",
    },
  ],
};

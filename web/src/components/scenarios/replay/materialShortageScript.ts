import type { SystemPanelSnapshot } from "@agent/shared";
import type { ReplayScript } from "./types";

/**
 * 场景剧本：哪些物料再不催就要断料了。
 *
 * 岗位视角是采购刘志强。骨架照《场景演示剧本写作规范》的四要素：
 *   ① 主动拒绝——第 4 步「直接下加急单」被权限矩阵拦住，给两条正规路径；
 *   ② 视角切换——第 6 步产物就是供应商此刻在邮箱里打开的那封催货函；
 *   ③ 跨系统核对——终态用一张表把四个系统的说法摆在一起；
 *   ④ 可下载产物——断料风险与催货清单 HTML，右侧预览 + 本地下载。
 * 判断力的看点在第 2 步：系统静态预警报了 5 项，其中 3 项是误报，Agent 主动纠正；
 * 第 3 步把「催原厂 vs 用替代料」两条路的代价算清楚，但明确不替人拍板。
 *
 * 内容为虚构示例，不对应任何真实企业、订单或供应商。
 */

const SHORTAGE_LIST_PATH = "assets/demo/断料风险与催货清单.html";
const CHASE_LETTER_PATH = "assets/demo/催货函-华矩传动.html";

const DOC_CSS = `
  :root { --brand: #2E56E1; --ink: #0f172a; --muted: #64748b; --line: #e2e8f0; --ok: #15803d; --warn: #b45309; --deny: #b91c1c; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 20px; font: 14px/1.7 "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; color: var(--ink); background: #fff; }
  .bar { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border: 1px solid var(--line); border-radius: 6px; background: #f8fafc; color: var(--muted); font-size: 12px; margin-bottom: 16px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #cbd5e1; }
  h1 { margin: 0 0 4px; font-size: 16px; }
  .sub { margin: 0 0 16px; color: var(--muted); font-size: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 14px; }
  th, td { border: 1px solid var(--line); padding: 7px 10px; text-align: left; vertical-align: top; }
  th { background: #f8fafc; color: var(--muted); font-weight: 500; }
  .ok { color: var(--ok); font-weight: 600; }
  .warn { color: var(--warn); font-weight: 600; }
  .deny { color: var(--deny); font-weight: 600; }
  .box { border: 1px solid var(--line); border-radius: 8px; padding: 12px; margin-bottom: 12px; }
  .box h2 { margin: 0 0 8px; font-size: 13px; }
  .kv { display: grid; grid-template-columns: 96px 1fr; gap: 4px 12px; font-size: 13px; }
  .kv span:nth-child(odd) { color: var(--muted); }
  .lead { border-left: 3px solid var(--brand); padding-left: 10px; margin: 0 0 12px; font-size: 13px; }
  ol, ul { margin: 0; padding-left: 18px; font-size: 13px; }
  li { margin-bottom: 4px; }
  .foot { margin-top: 14px; color: var(--muted); font-size: 12px; }
`;

const SHORTAGE_LIST_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<style>${DOC_CSS}</style></head><body>
<div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span>澜达精密制造 · 采购部 · 断料风险与催货清单 · 2026-08-09</span></div>

<h1>断料风险与催货清单</h1>
<p class="sub">澜达精密制造有限公司 · 采购部 刘志强 · 2026-08-09 生成 · 覆盖未来 14 天排产需求</p>

<p class="lead">系统静态预警共报 5 项。逐项倒排（需求 − 现有库存 − 可信在途）后，真缺口 2 项、误报 3 项。误报的共同原因是静态预警不计入「已到货未检验」的量。</p>

<table>
  <tr><th>物料</th><th>需求 / 缺口</th><th>击穿日</th><th>判定</th><th>依据</th></tr>
  <tr><td>精密轴承 6204-RS</td><td>需 400 件 / 缺 400 件</td><td>8-12</td><td class="deny">高危</td><td>在途 PO-2026-0886 无发货单号，不计入可信在途</td></tr>
  <tr><td>PC 阻燃粒子 V0</td><td>需 1.8 吨 / 缺 1.2 吨</td><td>8-16</td><td class="warn">临界</td><td>采购周期 7 天，今天下单才赶得上 8-16 用料</td></tr>
  <tr><td>冷轧钢板 SPCC 1.2mm</td><td>需 620 kg / 不缺</td><td>—</td><td class="ok">误报</td><td>PO-2026-0891 于 8-08 到货 800 kg，在检验中</td></tr>
  <tr><td>不锈钢紧固件 M6×20</td><td>需 5000 件 / 不缺</td><td>—</td><td class="ok">误报</td><td>PO-2026-0893 于 8-08 到货 8000 件，在检验中</td></tr>
  <tr><td>密封圈 NBR O-25</td><td>需 2400 件 / 不缺</td><td>—</td><td class="ok">误报</td><td>PO-2026-0894 于 8-07 到货 3000 件，在检验中</td></tr>
</table>

<div class="box">
  <h2>高危项 · 精密轴承 6204-RS</h2>
  <div class="kv">
    <span>绑定订单</span><span>SO-2026-1027 · 恒岳重工 · ¥86.4 万 · 交期 8-15</span>
    <span>在途采购</span><span>PO-2026-0886 · 华矩传动 · 承诺到货 8-12 · 至今无发货单号</span>
    <span>击穿逻辑</span><span>现有库存 60 件，8-12 起装配日耗 130 件，8-12 当天见底</span>
    <span>连带影响</span><span>轴承晚到 1 天，SO-2026-1027 交期缓冲即归零</span>
  </div>
</div>

<div class="box">
  <h2>两条路的代价</h2>
  <table>
    <tr><th>方案</th><th>要做的事</th><th>对交期的影响</th><th>风险</th></tr>
    <tr><td>路 A · 催原厂华矩传动</td><td>发正式催货函，要发货单号与到货日</td><td>若 8-12 到货，装配 2 天，8-15 仍剩 1 天缓冲</td><td>PO-2026-0886 至今无发货单号，承诺不可信</td></tr>
    <tr><td>路 B · 改用替代型号 6204-2RZ</td><td>库存 120 件，仍缺 280 件；需恒岳书面认可 BOM 变更</td><td>近三次客户认可平均 4 个工作日，比催原厂更慢</td><td>动客户合同技术附件，且缺口只补上 30%</td></tr>
  </table>
  <p class="sub" style="margin:0">这两条路怎么选不在本清单里给结论：路 B 要动客户合同附件，属于商务决定，需要采购与生产计划共同拍板。</p>
</div>

<div class="box">
  <h2>今天要决定的两件事</h2>
  <ol>
    <li>华矩传动 PO-2026-0886 是否发第 2 次催办函（函稿已备好，需人工确认才会发出）。</li>
    <li>PC 阻燃粒子是否今天向新宏钢材下单（7 天周期，晚一天即错过 8-16 用料）。</li>
  </ol>
</div>

<p class="foot">示例内容，不对应任何真实企业、订单或供应商。</p>
</body></html>`;

const CHASE_LETTER_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<style>${DOC_CSS}</style></head><body>
<div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span>华矩传动 · 收件箱 · 来自 澜达精密制造有限公司</span></div>

<h1>关于 PO-2026-0886 到货进度的催办函</h1>
<p class="sub">收件人：华矩传动 客户经理 · 发件人：澜达精密制造有限公司 采购部 刘志强 · 送达 2026-08-09 14:22</p>

<div class="box">
  <h2>采购单信息</h2>
  <div class="kv">
    <span>采购单号</span><span>PO-2026-0886</span>
    <span>物料</span><span>精密轴承 6204-RS × 400 件</span>
    <span>合同交期</span><span>2026-08-12（交期条款 4.1 条）</span>
    <span>当前状态</span><span class="warn">未收到发货单号，到货进度未知</span>
  </div>
</div>

<p class="lead">贵司与我司合作三年，履约一向稳定。本单物料已排入我司 8-12 起的装配计划，现距合同交期仅剩 3 天，我方台账中尚无本单的发货记录，特此函询。</p>

<div class="box">
  <h2>请协助确认</h2>
  <ol>
    <li>本单是否已发货。若已发货，请提供发货单号与承运信息。</li>
    <li>若尚未发货，请给出明确到货日，以便我方同步调整装配排程。</li>
    <li>如整批交付确有困难，可否先行分批发出 400 件中的首批，以覆盖 8-12 起的日耗。</li>
  </ol>
  <p class="sub" style="margin:8px 0 0">回复时限：2026-08-10 18:00 前。请直接回复本函，或联系采购部刘志强。</p>
</div>

<table>
  <tr><th>项目</th><th>我方记录</th></tr>
  <tr><td>下单日期</td><td>2026-07-24</td></tr>
  <tr><td>合同承诺到货</td><td>2026-08-12</td></tr>
  <tr><td>已催办次数</td><td>第 2 次（首次 2026-08-04）</td></tr>
  <tr><td>影响范围</td><td>我方一张在产订单的装配排程</td></tr>
</table>

<p class="foot">示例内容，不对应任何真实企业、采购单或供应商。</p>
</body></html>`;

const SHORTAGE_LIST_SIZE_BYTES = new TextEncoder().encode(SHORTAGE_LIST_HTML).length;
const CHASE_LETTER_SIZE_BYTES = new TextEncoder().encode(CHASE_LETTER_HTML).length;

/** 面板底稿：物料与库存 / 订单中心 / 采购在途 / 权限矩阵 / 函件与回执 / 操作留痕 */
const PANEL_BASE: SystemPanelSnapshot = {
  title: "企业系统实况",
  live: true,
  activeView: "material",
  foot: "已连接：物料与库存 · 订单中心 · 采购单台账 · 待办中心（演示）",
  views: [
    {
      key: "material",
      label: "物料与库存",
      winTitle: "物料与库存 · 未来 14 天缺口倒排",
      toolbar: { title: "物料与库存 · 未来 14 天需求倒排", sub: "尚未读取" },
      widget: {
        kind: "table",
        cols: [
          { key: "item", label: "物料" },
          { key: "gap", label: "需求缺口" },
          { key: "date", label: "击穿日" },
          { key: "state", label: "判定", align: "right" },
        ],
        rows: [],
        empty: { title: "尚未读取物料台账" },
      },
    },
    {
      key: "orders",
      label: "订单中心",
      winTitle: "订单中心 · 受缺料影响的在产订单",
      toolbar: { title: "订单中心 · 与缺口物料关联的在产订单", sub: "只读" },
      widget: {
        kind: "table",
        cols: [
          { key: "so", label: "订单" },
          { key: "cust", label: "客户" },
          { key: "due", label: "交期" },
          { key: "risk", label: "影响", align: "right" },
        ],
        rows: [],
        empty: { title: "尚未关联任何订单" },
      },
    },
    {
      key: "po",
      label: "采购在途",
      winTitle: "采购单台账 · 在途与到货记录",
      toolbar: { title: "采购单台账 · 在途与到货记录", sub: "尚未读取" },
      widget: { kind: "rows", rows: [], empty: { title: "尚未读取采购单" } },
    },
    {
      key: "rights",
      label: "权限矩阵",
      winTitle: "权限矩阵 · 本人可执行的动作",
      toolbar: { title: "权限矩阵 · 由 IT 依岗位表维护", sub: "只读" },
      widget: {
        kind: "table",
        cols: [
          { key: "action", label: "动作域" },
          { key: "grant", label: "本人授权" },
          { key: "owner", label: "授权来源", align: "right" },
        ],
        rows: [],
        empty: { title: "尚未触达权限判定" },
      },
    },
    {
      key: "letters",
      label: "函件与回执",
      winTitle: "对外函件与内部同步 · 送达回执",
      toolbar: { title: "对外函件与内部同步", sub: "尚未发出" },
      widget: { kind: "feed", items: [], empty: { title: "尚未发出任何函件" } },
    },
    {
      key: "audit",
      label: "操作留痕",
      winTitle: "操作留痕 · 本次会话",
      toolbar: { title: "本次会话的系统动作", sub: "0 条" },
      widget: { kind: "feed", items: [], empty: { title: "尚无系统动作" } },
    },
  ],
};

export const materialShortageScript: ReplayScript = {
  scenarioId: "catalog-hook-material-shortage",
  title: "哪些物料再不催就要断料了",
  mode: "quick",
  artifacts: {
    [SHORTAGE_LIST_PATH]: SHORTAGE_LIST_HTML,
    [CHASE_LETTER_PATH]: CHASE_LETTER_HTML,
  },

  steps: [
    {
      caption: "读库存、在途与 14 天需求",
      blocks: [
        {
          id: "ms1-prompt",
          kind: "prompt",
          title: "用户消息",
          defaultOpen: true,
          content: "哪些物料再不催就要断料了？系统天天弹预警，我看不出来哪几个是真要命的。",
        },
        {
          id: "ms1-tool",
          kind: "tool_use",
          title: "InventoryQuery",
          defaultOpen: true,
          toolName: "InventoryQuery",
          toolId: "t-inventory",
          content: JSON.stringify({ scope: "material", horizonDays: 14 }),
          executionStatus: "completed",
          durationMs: 1120,
          presentation: {
            title: "读取库存、在途采购与未来 14 天排产需求",
            detail: [
              { k: "在管物料", v: "38 项" },
              { k: "在途采购单", v: "11 张" },
              { tree: "├", k: "需求来源", v: "未来 14 天排产计划，覆盖 9 张在产销售订单" },
              { tree: "├", k: "系统静态预警", v: "5 项待判定" },
              { tree: "└", k: "倒排口径", v: "需求 − 现有库存 − 可信在途" },
            ],
            status: "ok",
            panelBase: PANEL_BASE,
            panel: [
              { op: "focus", view: "material" },
              { op: "toolbar", view: "material", title: "物料与库存 · 未来 14 天需求倒排", sub: "38 项在管 · 静态预警 5 项" },
              { op: "tableRowInsert", view: "material", row: { id: "m-bearing", cells: { item: "精密轴承 6204-RS", gap: "需 400 · 缺 400 件", date: "8-12", state: "待判定" } } },
              { op: "tableRowInsert", view: "material", row: { id: "m-pc", cells: { item: "PC 阻燃粒子 V0", gap: "需 1.8 · 缺 1.2 吨", date: "8-16", state: "待判定" } } },
              { op: "tableRowInsert", view: "material", row: { id: "m-steel", cells: { item: "冷轧钢板 SPCC 1.2mm", gap: "需 620 kg", date: "8-14", state: "待判定" } } },
              { op: "tableRowInsert", view: "material", row: { id: "m-bolt", cells: { item: "不锈钢紧固件 M6×20", gap: "需 5000 件", date: "8-15", state: "待判定" } } },
              { op: "tableRowInsert", view: "material", row: { id: "m-oring", cells: { item: "密封圈 NBR O-25", gap: "需 2400 件", date: "8-18", state: "待判定" } } },
              { op: "feedAppend", view: "audit", item: { id: "au-1", from: "AI 同事", time: "13:58:12", text: "读取物料库存、在途采购单与未来 14 天排产需求（只读）" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "1 条" },
            ],
          },
        },
        {
          id: "ms1-result",
          kind: "tool_result",
          title: "InventoryQuery 结果",
          defaultOpen: false,
          toolName: "InventoryQuery",
          toolId: "t-inventory",
          content: "materials=38 openPO=11 demandOrders=9 staticAlerts=5 horizon=14d",
        },
        {
          id: "ms1-text",
          kind: "text",
          title: "业务进展",
          defaultOpen: true,
          content: "三份数据都拿到了：38 项在管物料、11 张在途采购单、未来 14 天的排产需求。系统的静态预警报了 5 项，我不直接采信——它按「库存低于安全线」算，不看在途是否可信、也不算已到货还没检验的量。我逐项倒排一遍再告诉你哪几项是真的。",
        },
      ],
    },

    {
      caption: "倒排缺口：2 项真缺、3 项误报",
      blocks: [
        {
          id: "ms2-tool",
          kind: "tool_use",
          title: "ShortageForecast",
          defaultOpen: true,
          toolName: "ShortageForecast",
          toolId: "t-forecast",
          content: JSON.stringify({ alerts: 5, method: "backward-scheduling" }),
          executionStatus: "completed",
          durationMs: 1860,
          presentation: {
            title: "按排产倒排逐项判定 5 条预警",
            detail: [
              { section: "真缺口 2 项" },
              { risk: "high", text: "精密轴承 6204-RS 缺 400 件", action: "现有 60 件，8-12 起日耗 130 件，当天见底；绑定 SO-2026-1027（恒岳重工，交期 8-15）" },
              { indent: 1, text: "⚠ 在途 PO-2026-0886（华矩传动）承诺 8-12 到货，但台账里至今没有发货单号，这张在途我不计入可信库存" },
              { risk: "medium", text: "PC 阻燃粒子 V0 缺 1.2 吨", action: "8-16 用料，新宏钢材采购周期 7 天，今天下单才赶得上" },
              { section: "系统报了但不是缺口 3 项" },
              { verdict: "pass", text: "冷轧钢板 SPCC 1.2mm", note: "PO-2026-0891 已于 8-08 到货 800 kg，正在检验，静态预警没把在检品算作库存" },
              { verdict: "pass", text: "不锈钢紧固件 M6×20", note: "PO-2026-0893 已于 8-08 到货 8000 件，正在检验" },
              { verdict: "pass", text: "密封圈 NBR O-25", note: "PO-2026-0894 已于 8-07 到货 3000 件，正在检验" },
              { insight: "5 条预警里只有 2 条要你今天动手；另外 3 条是静态口径漏算在检品造成的，不用管", label: "结论" },
            ],
            status: "warn",
            panel: [
              { op: "focus", view: "material" },
              { op: "toolbar", view: "material", title: "物料与库存 · 倒排判定完成", sub: "真缺口 2 · 误报 3" },
              { op: "tableRowUpdate", view: "material", id: "m-bearing", set: { cells: { item: "精密轴承 6204-RS", gap: "需 400 · 缺 400 件", date: "8-12", state: "高危" }, tone: "warn" } },
              { op: "cellFlag", view: "material", rowId: "m-bearing", colKey: "state", tone: "deny", flag: "8-12 击穿" },
              { op: "tableRowUpdate", view: "material", id: "m-pc", set: { cells: { item: "PC 阻燃粒子 V0", gap: "需 1.8 · 缺 1.2 吨", date: "8-16", state: "临界" } } },
              { op: "cellFlag", view: "material", rowId: "m-pc", colKey: "state", tone: "warn", flag: "今天须下单" },
              { op: "tableRowUpdate", view: "material", id: "m-steel", set: { cells: { state: "误报" } } },
              { op: "cellFlag", view: "material", rowId: "m-steel", colKey: "state", tone: "pass", flag: "已到检验中" },
              { op: "tableRowUpdate", view: "material", id: "m-bolt", set: { cells: { state: "误报" } } },
              { op: "cellFlag", view: "material", rowId: "m-bolt", colKey: "state", tone: "pass", flag: "已到检验中" },
              { op: "tableRowUpdate", view: "material", id: "m-oring", set: { cells: { state: "误报" } } },
              { op: "cellFlag", view: "material", rowId: "m-oring", colKey: "state", tone: "pass", flag: "已到检验中" },
              { op: "rowsSet", view: "po", rows: [
                { id: "p-0886", text: "PO-2026-0886 · 华矩传动 · 精密轴承 6204-RS ×400", sub: "承诺到货 8-12 · 无发货单号 · 首次催办 8-04", tone: "warn", badge: { text: "在途不可信", tone: "warn" } },
                { id: "p-0891", text: "PO-2026-0891 · 新宏钢材 · 冷轧钢板 SPCC ×800 kg", sub: "8-08 到货，检验中", tone: "pass", badge: { text: "已到货", tone: "pass" } },
                { id: "p-0893", text: "PO-2026-0893 · 盛通五金 · 紧固件 M6×20 ×8000", sub: "8-08 到货，检验中", tone: "pass", badge: { text: "已到货", tone: "pass" } },
                { id: "p-0894", text: "PO-2026-0894 · 盛通五金 · 密封圈 NBR O-25 ×3000", sub: "8-07 到货，检验中", tone: "pass", badge: { text: "已到货", tone: "pass" } },
              ] },
              { op: "toolbar", view: "po", title: "采购单台账 · 在途与到货记录", sub: "在途 1 · 已到检验 3" },
              { op: "feedAppend", view: "audit", item: { id: "au-2", from: "AI 同事", time: "13:58:41", text: "按排产倒排判定 5 条静态预警：真缺口 2 · 误报 3" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "2 条" },
            ],
          },
        },
        {
          id: "ms2-text",
          kind: "text",
          title: "业务进展",
          defaultOpen: true,
          content: [
            "5 条预警里，**只有 2 条是真的**：",
            "",
            "1. **精密轴承 6204-RS**，缺 400 件。现有库存 60 件，8-12 起装配日耗 130 件，当天就见底。它挂在 SO-2026-1027（恒岳重工，¥86.4 万，交期 8-15）上，这是这个月最不能出事的一张单。在途那张 PO-2026-0886 华矩传动承诺 8-12 到货，但台账里至今没有发货单号——没有单号的承诺我不当库存算。",
            "2. **PC 阻燃粒子 V0**，缺 1.2 吨。8-16 要用，新宏钢材的采购周期是 7 天，今天不下单就来不及。",
            "",
            "另外 3 条（冷轧钢板、紧固件、密封圈）是误报：货 8-07 到 8-08 都已经进厂了，还在检验中。系统的静态口径不把在检品算库存，所以年年报这个。",
          ].join("\n"),
        },
      ],
    },

    {
      caption: "催原厂还是用替代料，把账算给你",
      blocks: [
        {
          id: "ms3-tool",
          kind: "tool_use",
          title: "SubstituteCheck",
          defaultOpen: true,
          toolName: "SubstituteCheck",
          toolId: "t-substitute",
          content: JSON.stringify({ item: "6204-RS", qty: 400, order: "SO-2026-1027" }),
          executionStatus: "completed",
          durationMs: 1440,
          presentation: {
            title: "轴承缺口的两条路及其代价",
            detail: [
              "轴承这 400 件有两条路，代价不一样，账算给你看",
              { section: "路 A · 催原厂华矩传动" },
              { tree: "├", k: "要做的事", v: "发正式催货函，要发货单号与明确到货日" },
              { tree: "├", k: "对交期的影响", v: "若 8-12 到货，装配需 2 天，8-15 交期还剩 1 天缓冲" },
              { tree: "└", k: "风险", v: "PO-2026-0886 至今无发货单号，这个承诺目前不可信" },
              { section: "路 B · 改用替代型号 6204-2RZ" },
              { tree: "├", k: "现有库存", v: "120 件，只够 400 件需求的 30%，仍缺 280 件" },
              { tree: "├", k: "硬前提", v: "与恒岳的合同技术附件 3.2 条：BOM 变更需客户书面认可" },
              { tree: "└", k: "历史耗时", v: "近三次客户认可平均 4 个工作日，比催原厂更慢" },
              { warn: "这两条路怎么选我不替你拍：路 B 要动客户合同附件，属于商务决定；路 A 是赌华矩这次会履约。依据我摆齐了，选择要你和吴国栋定" },
              { insight: "如果要我排个先后：今天先催原厂（可逆、不动合同），同时今天就把认可流程报给恒岳当 B 计划，别等到 8-12 才启动", label: "我的建议" },
            ],
            status: "warn",
            panel: [
              { op: "focus", view: "orders" },
              { op: "toolbar", view: "orders", title: "订单中心 · 与缺口物料关联的在产订单", sub: "1 张受影响" },
              { op: "tableRowInsert", view: "orders", row: { id: "o-1027", cells: { so: "SO-2026-1027", cust: "恒岳重工", due: "8-15", risk: "缺轴承 400 件" }, tone: "warn" } },
              { op: "cellFlag", view: "orders", rowId: "o-1027", colKey: "risk", tone: "deny", flag: "高危" },
              { op: "tableRowInsert", view: "orders", row: { id: "o-1033", cells: { so: "SO-2026-1033", cust: "蓝谷自动化", due: "8-22", risk: "不受影响" } } },
              { op: "cellFlag", view: "material", rowId: "m-steel", colKey: "state", tone: "info", flag: "已排除" },
              { op: "cellFlag", view: "material", rowId: "m-bolt", colKey: "state", tone: "info", flag: "已排除" },
              { op: "cellFlag", view: "material", rowId: "m-oring", colKey: "state", tone: "info", flag: "已排除" },
              { op: "feedAppend", view: "audit", item: { id: "au-3", from: "AI 同事", time: "13:59:20", text: "核对替代型号 6204-2RZ 库存与恒岳合同技术附件认可条款（只读）" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "3 条" },
            ],
          },
        },
        {
          id: "ms3-text",
          kind: "text",
          title: "业务进展",
          defaultOpen: true,
          content: [
            "替代料这条路没有你想的那么好走：**6204-2RZ 库存只有 120 件**，补不上 400 件的缺，还得走恒岳的书面认可（合同技术附件 3.2 条写死的），近三次认可平均要 4 个工作日——比催原厂还慢。",
            "",
            "**这个选择我不替你做**。路 B 要动客户的合同附件，是商务决定，得你和吴国栋一起拍。我能做的是把两边的账算清楚，再把催货的材料备好。",
          ].join("\n"),
        },
      ],
    },
    {
      caption: "直接下加急单被拦截",
      blocks: [
        {
          id: "ms4-prompt",
          kind: "prompt",
          title: "用户消息",
          defaultOpen: true,
          content: "别等了，你直接给华矩下个加急单，把 400 件补上。",
        },
        {
          id: "ms4-tool",
          kind: "tool_use",
          title: "PurchaseOrderDraft",
          defaultOpen: true,
          toolName: "PurchaseOrderDraft",
          toolId: "t-po-draft",
          content: JSON.stringify({ supplier: "华矩传动", item: "6204-RS", qty: 400, urgent: true }),
          executionStatus: "completed",
          durationMs: 240,
          presentation: {
            title: "新增加急采购单 · 权限判定",
            detail: [
              { k: "请求动作", v: "向华矩传动新增加急采购单 400 件" },
              { k: "本人岗位", v: "采购（刘志强）" },
              { verdict: "fail", text: "按权限矩阵拒绝，未创建任何采购单", note: "新增采购单会形成对外付款义务，属于承诺类动作 · 拦截已记账" },
              { indent: 1, text: "⚠ 我也没有向华矩发出任何询价或口头意向，避免变成事实上的承诺" },
            ],
            status: "blocked",
            panel: [
              { op: "focus", view: "rights" },
              { op: "toolbar", view: "rights", title: "权限矩阵 · 本人可执行的动作", sub: "命中 1 条拒绝" },
              { op: "tableRowInsert", view: "rights", row: { id: "r-read", cells: { action: "查询库存 / 在途 / 排产需求", grant: "允许", owner: "岗位表" } } },
              { op: "tableRowInsert", view: "rights", row: { id: "r-letter", cells: { action: "起草对外函件（人审后发出）", grant: "允许", owner: "岗位表" } } },
              { op: "tableRowInsert", view: "rights", row: { id: "r-po", cells: { action: "新增采购单与付款承诺", grant: "拒绝", owner: "总经理办公会" }, tone: "deny" } },
              { op: "cellFlag", view: "rights", rowId: "r-po", colKey: "grant", tone: "deny", flag: "无授权" },
              { op: "tableRowInsert", view: "rights", row: { id: "r-bom", cells: { action: "变更 BOM 与启用替代料", grant: "拒绝", owner: "技术与质量" } } },
              { op: "feedAppend", view: "audit", item: {
                id: "au-4",
                from: "AI 同事",
                time: "14:00:03",
                text: "加急采购单请求被权限矩阵拦截，采购系统零写入",
                card: { title: "承诺类动作已拦截", body: "动作域「新增采购单与付款承诺」对采购岗无授权；已给出正规路径", meta: [{ text: "未创建单据", tone: "pass" }, { text: "已记账", tone: "info" }] },
              } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "4 条" },
            ],
          },
        },
        {
          id: "ms4-text",
          kind: "text",
          title: "回复",
          defaultOpen: true,
          content: [
            "**这条我不能做**。新增采购单等于替公司对华矩形成付款义务，右侧权限矩阵里这一行对采购岗是明确拒绝的——我没有创建任何单据，也没有向华矩发过询价或口头意向，免得变成事实上的承诺。",
            "",
            "能走的有两条：",
            "",
            "1. 我把催货函和证据整理好，你审完再发。这是催既有的 PO-2026-0886，不产生新的采购承诺；",
            "2. 如果确实要加急补单，在审批系统发起《紧急采购申请》，沈总批完之后由你本人在采购系统下单。",
            "",
            "我先按第 1 条把材料备好？",
          ].join("\n"),
        },
      ],
    },

    {
      caption: "生成断料风险与催货清单",
      blocks: [
        {
          id: "ms5-tool",
          kind: "tool_use",
          title: "ReportBuild",
          defaultOpen: true,
          toolName: "ReportBuild",
          toolId: "t-report",
          content: JSON.stringify({ doc: "断料风险与催货清单", date: "2026-08-09" }),
          executionStatus: "completed",
          durationMs: 1320,
          presentation: {
            title: "生成断料风险与催货清单",
            detail: [
              { k: "清单", v: "断料风险与催货清单 · 8-09" },
              { k: "覆盖", v: "5 项预警 · 2 项真缺口 · 3 项误报及原因" },
              { tree: "├", k: "催货对象", v: "华矩传动 PO-2026-0886（将是第 2 次催办）" },
              { tree: "├", k: "待你决定", v: "PC 阻燃粒子今天是否向新宏钢材下单" },
              { tree: "└", k: "写入情况", v: "清单只是文档，未写入任何业务系统" },
            ],
            status: "ok",
            panel: [
              { op: "focus", view: "po" },
              { op: "toolbar", view: "po", title: "采购单台账 · 在途与到货记录", sub: "1 张列入催货清单" },
              { op: "rowUpdate", view: "po", id: "p-0886", set: { sub: "承诺到货 8-12 · 无发货单号 · 已列入今日催货清单", state: "hit", badge: { text: "待你确认催办", tone: "pending" } } },
              { op: "feedAppend", view: "audit", item: { id: "au-5", from: "AI 同事", time: "14:01:47", text: "生成《断料风险与催货清单 · 8-09》，未写入业务系统" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "5 条" },
            ],
          },
        },
        {
          id: "ms5-text",
          kind: "text",
          title: "回复",
          defaultOpen: true,
          content: [
            "清单成稿了，你可以先下载核一遍：",
            "",
            `[FILE]{"filePath":"${SHORTAGE_LIST_PATH}","fileName":"断料风险与催货清单.html","fileSize":${SHORTAGE_LIST_SIZE_BYTES}}[/FILE]`,
            "",
            "里面两件事等你拍：华矩这张催不催、PC 粒子今天下不下单。催货函我按你们合同里的交期条款拟好了，但要你确认才会发出去——**我不会自己把函发给供应商**。",
          ].join("\n"),
        },
      ],
    },
    {
      caption: "催货函发不发，你来定",
      blocks: [],
      approval: {
        title: "对外催货函与内部同步 · 需你确认",
        description: "确认后才会把函件发给供应商，并给生产计划同步排产风险。这一步会向公司外部发出文件，必须由你明确确认。",
        facts: [
          { label: "对外函件", value: "《关于 PO-2026-0886 到货进度的催办函》致 华矩传动" },
          { label: "援引依据", value: "PO-2026-0886 交期条款 4.1 条 · 合同承诺到货 8-12" },
          { label: "要求回复", value: "8-10 18:00 前给发货单号或明确到货日" },
          { label: "内部同步", value: "给吴国栋 1 条排产风险提醒，含 SO-2026-1027 影响" },
        ],
        approveLabel: "确认发出",
        rejectLabel: "退回修改",
        approvedBlocks: [
          {
            id: "ms6-human",
            kind: "prompt",
            title: "用户消息",
            defaultOpen: true,
            content: "函可以发，但把「逾期将按合同追究违约责任」那句删掉——华矩合作三年了，先给对方台阶下。改成请他们今天内给发货单号或者明确到货日。给吴国栋那条按你写的发。",
          },
          {
            id: "ms6-approve-tool",
            kind: "tool_use",
            title: "Approval",
            defaultOpen: true,
            toolName: "Approval",
            toolId: "t-approve",
            content: JSON.stringify({ po: "PO-2026-0886", decision: "approved" }),
            executionStatus: "completed",
            durationMs: 300,
            presentation: {
              title: "已确认发出 · 含人工修改 1 项",
              detail: [
                { k: "审批结果", v: "确认发出" },
                { k: "人工采纳", v: "1 项——给吴国栋的排产风险同步，按原文发送" },
                { k: "人工修改", v: "1 项——催货函删去违约责任措辞，改为请对方今日内给发货单号或到货日" },
                { tree: "├", k: "记账口径", v: "采纳 1 项 · 修改 1 项 · 自动执行 0 项" },
                { tree: "└", k: "留痕", v: "原稿与改后稿都已留存，改动点单独记录" },
              ],
              status: "ok",
              receipt: { id: "PO-2026-0886", system: "采购单台账", readBack: true },
              panel: [
                { op: "focus", view: "letters" },
                { op: "toolbar", view: "letters", title: "对外函件与内部同步", sub: "1 封已确认 · 待发出" },
                { op: "feedAppend", view: "audit", item: {
                  id: "au-6",
                  from: "刘志强",
                  time: "14:20:36",
                  text: "确认发出：采纳 1 项、修改 1 项（删去违约责任措辞）、自动执行 0 项",
                  card: { title: "人审记录", body: "采纳 1 · 修改 1 · 自动执行 0", meta: [{ text: "AI 未自行发函", tone: "pass" }] },
                } },
                { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "6 条" },
              ],
            },
          },
          {
            id: "ms6-dispatch-tool",
            kind: "tool_use",
            title: "Dispatch",
            defaultOpen: true,
            toolName: "Dispatch",
            toolId: "t-dispatch",
            content: JSON.stringify({ letter: "PO-2026-0886", notify: "吴国栋" }),
            executionStatus: "completed",
            durationMs: 980,
            presentation: {
              title: "催货函送达，排产风险已同步",
              detail: [
                { k: "催货函", v: "14:22 送达华矩传动客户经理 · 14:31 对方已读" },
                { k: "内部同步", v: "待办 TD-1207 已建给吴国栋 · 14:22 已读" },
                { tree: "├", k: "采购单台账", v: "PO-2026-0886 追加第 2 次催办记录，回读通过" },
                { tree: "└", k: "复查", v: "8-10 18:00 对方未回复，我会再提醒你一次" },
              ],
              status: "ok",
              receipt: { id: "TD-1207", system: "待办中心", readBack: true },
              panel: [
                { op: "focus", view: "letters" },
                { op: "toolbar", view: "letters", title: "对外函件与内部同步", sub: "已送达 2 条" },
                { op: "feedAppend", view: "letters", item: {
                  id: "l-letter",
                  from: "AI 同事",
                  time: "14:22",
                  text: "《关于 PO-2026-0886 到货进度的催办函》已按改后稿发出",
                  card: { title: "催货函 · 致华矩传动", body: "援引 PO-2026-0886 交期条款 4.1 条，请于 8-10 18:00 前提供发货单号或明确到货日", meta: [{ text: "14:31 对方已读", tone: "pass" }] },
                } },
                { op: "feedAppend", view: "letters", item: {
                  id: "l-sync",
                  from: "AI 同事",
                  time: "14:22",
                  text: "排产风险同步已送达吴国栋",
                  card: { title: "待办 TD-1207 · 排产风险", body: "6204-RS 缺 400 件，8-12 击穿；SO-2026-1027 交期 8-15 缓冲将归零", meta: [{ text: "14:22 已读", tone: "pass" }] },
                } },
                { op: "rowUpdate", view: "po", id: "p-0886", set: { sub: "承诺到货 8-12 · 已催办 2 次 · 待对方给发货单号", badge: { text: "已催办 2 次", tone: "warn" } } },
                { op: "feedAppend", view: "audit", item: { id: "au-7", from: "AI 同事", time: "14:22:10", text: "发出催货函并写入 PO-2026-0886 催办记录；创建待办 TD-1207 给吴国栋，均回读校验通过" } },
                { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "7 条" },
              ],
            },
          },
          {
            id: "ms6-approve-text",
            kind: "text",
            title: "发送结果",
            defaultOpen: true,
            content: [
              "函按你改的口径发出去了，14:31 华矩那边点开了。**下面这份就是他们此刻在邮箱里看到的样子**，你可以核一遍措辞：",
              "",
              `[FILE]{"filePath":"${CHASE_LETTER_PATH}","fileName":"催货函-华矩传动.html","fileSize":${CHASE_LETTER_SIZE_BYTES}}[/FILE]`,
              "",
              "吴国栋的排产风险同步也送到了（TD-1207，14:22 已读）。8-10 18:00 前对方还没给发货单号的话，我再提醒你一次。",
            ].join("\n"),
          },
        ],
        rejectedBlocks: [
          {
            id: "ms6-reject-tool",
            kind: "tool_use",
            title: "Approval",
            defaultOpen: true,
            toolName: "Approval",
            toolId: "t-reject",
            content: JSON.stringify({ po: "PO-2026-0886", decision: "rejected" }),
            executionStatus: "completed",
            durationMs: 260,
            presentation: {
              title: "已退回 · 没有向任何人发出东西",
              detail: [
                { k: "审批结果", v: "退回修改" },
                { k: "对外函件", v: "未发出，华矩传动侧无任何记录" },
                { k: "内部同步", v: "未发送，吴国栋未收到待办" },
                { tree: "├", k: "采购单台账", v: "PO-2026-0886 无写入，催办次数仍是 1 次" },
                { tree: "└", k: "留痕", v: "退回时间、退回人与当时函稿版本已记录" },
              ],
              status: "blocked",
              panel: [
                { op: "focus", view: "letters" },
                { op: "toolbar", view: "letters", title: "对外函件与内部同步", sub: "未发出" },
                { op: "feedAppend", view: "letters", item: {
                  id: "l-hold",
                  from: "AI 同事",
                  time: "14:22",
                  text: "催货函停在待发状态，未向任何供应商发出",
                  card: { title: "函件已停住", body: "审批未通过，对外链路保持关闭；函稿与证据保留在会话里", meta: [{ text: "零对外发送", tone: "pass" }, { text: "已记账", tone: "info" }] },
                } },
                { op: "feedAppend", view: "audit", item: { id: "au-reject", from: "刘志强", time: "14:22:10", text: "催货函被退回：未发出任何函件，采购单台账与待办中心均无写入" } },
                { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "6 条" },
              ],
            },
          },
          {
            id: "ms6-reject-text",
            kind: "text",
            title: "退回说明",
            defaultOpen: true,
            content: "已经停在发函这一步：没有向华矩发出任何函件，吴国栋那条也没发，采购单台账没有写入。断料风险与催货清单还在，你可以直接下载。口径改好之后重新提交，仍然要你再确认一次才会发。",
          },
        ],
      },
    },
    {
      caption: "跨系统核对终态",
      blocks: [
        {
          id: "ms7-tool",
          kind: "tool_use",
          title: "ReadBack",
          defaultOpen: true,
          toolName: "ReadBack",
          toolId: "t-readback",
          content: JSON.stringify({ po: "PO-2026-0886", todo: "TD-1207" }),
          executionStatus: "completed",
          durationMs: 1060,
          presentation: {
            title: "回读四个系统，核对说法是否一致",
            detail: [
              { k: "回读方式", v: "按单号逐个反查，不用本次会话的缓存" },
              { verdict: "pass", text: "物料与库存", note: "6204-RS 缺口仍是 400 件，击穿日仍是 8-12 · 安全库存参数未改" },
              { verdict: "pass", text: "采购单台账", note: "PO-2026-0886 第 2 次催办记录已在 · 无新增采购单" },
              { verdict: "pass", text: "待办中心", note: "TD-1207 已送达吴国栋 · 14:22 已读" },
              { verdict: "pass", text: "函件与回执", note: "1 封已送达 · 14:31 对方已读" },
              { insight: "四方说法一致。但缺口本身还在——它解不解得开，取决于华矩 8-12 是不是真的到货", label: "结论" },
            ],
            status: "warn",
            panel: [
              { op: "focus", view: "material" },
              { op: "toolbar", view: "material", title: "物料与库存 · 终态回读", sub: "缺口未变 · 已进入催货中" },
              { op: "tableRowUpdate", view: "material", id: "m-bearing", set: { cells: { state: "催货中" } } },
              { op: "cellFlag", view: "material", rowId: "m-bearing", colKey: "state", tone: "warn", flag: "催货中" },
              { op: "tableRowUpdate", view: "material", id: "m-pc", set: { cells: { state: "待你决定" } } },
              { op: "cellFlag", view: "material", rowId: "m-pc", colKey: "state", tone: "pending", flag: "待下单" },
              { op: "feedAppend", view: "audit", item: { id: "au-8", from: "AI 同事", time: "14:23:05", text: "回读物料与库存 / 采购单台账 / 待办中心 / 函件回执，四方状态一致" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "8 条" },
            ],
          },
        },
        {
          id: "ms7-text",
          kind: "text",
          title: "本次会话改变了什么",
          defaultOpen: true,
          content: [
            "## 本次会话改变了什么",
            "",
            "| 系统 | 终态 | 依据 |",
            "| --- | --- | --- |",
            "| 物料与库存 | 6204-RS 缺口 400 件，击穿日仍是 8-12 | 未启用替代料，安全库存参数原样 |",
            "| 采购单台账 | PO-2026-0886 追加第 2 次催办记录 | 催货函 14:22 送达，14:31 对方已读 |",
            "| 待办中心 | TD-1207 排产风险已送达吴国栋 | 14:22 已读 |",
            "| 操作留痕 | 8 条动作，其中写操作 2 条 | 加急下单请求被拦截，采购系统零写入 |",
            "",
            "## 本次会话没有做什么",
            "",
            "- 没有下任何新采购单：加急补单的请求在权限矩阵处被拦下，我也没向华矩发过询价或口头意向；",
            "- 没有启用替代型号 6204-2RZ：动 BOM 要恒岳书面认可，这个取舍留给你和吴国栋，我只算了两条路的账；",
            "- 没有改安全库存参数：8-12 这个击穿日是按现有参数算出来的，我不会为了让预警变绿去动阈值；",
            "- 没有替你向华矩承诺加价、补偿或任何新的商务条件。",
          ].join("\n"),
        },
        {
          id: "ms7-upgrade",
          kind: "text",
          title: "接下来",
          defaultOpen: true,
          content: "这次是你问我才跑的。以后每周三上午我可以自动把未来 14 天的需求倒排一遍，只有出现两周内击穿的物料才叫你，剩下那些静态误报我自己对平就行——想开的时候跟我说一声。",
        },
      ],
    },
  ],

  // 治理条款：state != exists 的条目就是「演示到真实」的距离
  sources: [
    {
      blockRef: "step1.tool.InventoryQuery",
      producer: "租户业务数据连接器",
      state: "missing",
      gap: "物料库存、在途采购、排产需求分属三张业务台账，目前没有通用连接器；真实会话拿不到这三份数据对齐到同一时点的快照",
    },
    {
      blockRef: "step2.tool.ShortageForecast",
      producer: "租户业务数据连接器",
      state: "missing",
      gap: "倒排要逐张核对采购单的发货记录与检验状态，属于台账读取；另外「可信在途」的判定口径（无发货单号不计入）需要成为可配置规则，现在只能靠临场推理",
    },
    {
      blockRef: "step3.tool.SubstituteCheck",
      producer: "租户业务数据连接器",
      state: "missing",
      gap: "替代料库存在物料台账、BOM 变更认可条款在合同附件，两者都要连接器；合同附件目前也没有可检索的结构化存放位置",
    },
    {
      blockRef: "step4.tool.PurchaseOrderDraft",
      producer: "独立范围门禁（动作域）",
      state: "needs-change",
      gap: "门禁形态已在客户 POC 验证（loop 外独立判定 + 前端预设话术），但只覆盖数据域；「承诺类动作」这类动作域权限矩阵尚未产品化",
    },
    {
      blockRef: "step5.tool.ReportBuild",
      producer: "Agent 生成 HTML 产物",
      state: "exists",
    },
    {
      blockRef: "step6.tool.Approval",
      producer: "业务审批执行器",
      state: "needs-change",
      gap: "HITL 审批事件在 runtime 已成对记录，但「人改了哪一条、原稿是什么」没有结构化字段，「采纳 1 · 修改 1 · 自动执行 0」目前只能落在自由文本里",
    },
    {
      blockRef: "step6.tool.Dispatch",
      producer: "钉钉 DWS 连接器",
      state: "needs-change",
      gap: "待办创建与已读回执能力存在，需改造成输出这份送达摘要；对外催货函的送达与已读状态还要另接企业邮箱侧，目前不在能力范围内",
    },
    {
      blockRef: "step7.tool.ReadBack",
      producer: "租户业务数据连接器",
      state: "missing",
      gap: "跨系统回读要先有各台账连接器；在此之前终态核对表只能人工整理，也就没有「按单号反查、不用缓存」这个可信度保证",
    },
    {
      blockRef: "step5.artifact.断料风险与催货清单",
      producer: "Agent 生成 HTML 产物",
      state: "exists",
    },
    {
      blockRef: "step6.artifact.催货函",
      producer: "Agent 生成 HTML 产物",
      state: "exists",
    },
  ],
};

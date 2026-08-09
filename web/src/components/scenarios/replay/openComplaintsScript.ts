import type { SystemPanelSnapshot } from "@agent/shared";
import type { ReplayScript } from "./types";

/**
 * 钩子剧本 H7：今天还有哪些客诉没闭环。
 *
 * 岗位视角是跟单/客服周晓芸，四要素落点：
 *   ① 主动拒绝——第 4 步「先跟客户说是运输问题」被停住，质检复判没出结论就不预设归因；
 *   ② 视角切换——第 6 步产物是客户此刻在消息里看到的那张进度卡；
 *   ③ 跨系统核对——第 7 步一张表把四个系统的说法摆在一起；
 *   ④ 可下载产物——未结盘点与今日行动清单，右侧预览 + 本地下载。
 * 外加：人可以改掉 AI 的措辞并被记账（第 6 步），退回不是死路（rejectedBlocks）。
 *
 * 内容为虚构示例，不对应任何真实企业、工单或批次。
 */

const ACTION_LIST_PATH = "assets/demo/客诉未结盘点与今日行动.html";
const CUSTOMER_VIEW_PATH = "assets/demo/客户收到的进度回复.html";

const ACTION_LIST_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<style>
  :root { --brand: #2E56E1; --ink: #0f172a; --muted: #64748b; --line: #e2e8f0; --ok: #15803d; --warn: #b45309; --deny: #b91c1c; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 20px; font: 14px/1.7 "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; color: var(--ink); background: #fff; }
  .bar { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border: 1px solid var(--line); border-radius: 6px; background: #f8fafc; color: var(--muted); font-size: 12px; margin-bottom: 16px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #cbd5e1; }
  h1 { margin: 0 0 4px; font-size: 16px; }
  .sub { margin: 0 0 16px; color: var(--muted); font-size: 12px; }
  h2 { margin: 0 0 8px; font-size: 13px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 14px; }
  th, td { border: 1px solid var(--line); padding: 7px 10px; text-align: left; vertical-align: top; }
  th { background: #f8fafc; color: var(--muted); font-weight: 500; }
  .ok { color: var(--ok); font-weight: 600; }
  .warn { color: var(--warn); font-weight: 600; }
  .deny { color: var(--deny); font-weight: 600; }
  .box { border: 1px solid var(--line); border-radius: 8px; padding: 12px; margin-bottom: 12px; }
  .box.hot { border-left: 3px solid var(--deny); }
  .kv { display: grid; grid-template-columns: 104px 1fr; gap: 4px 12px; font-size: 13px; }
  .kv span:nth-child(odd) { color: var(--muted); }
  ol { margin: 0; padding-left: 18px; }
  li { margin-bottom: 6px; }
  .foot { margin-top: 14px; color: var(--muted); font-size: 12px; }
</style></head><body>
<div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span>客诉工单 / 未结盘点 / 2026-08-09</span></div>

<h1>客诉未结盘点与今日行动</h1>
<p class="sub">澜达精密制造 · 跟单 周晓芸 · 统计时点 2026-08-09 16:20 · 未结工单 8 个</p>

<h2>一、未结工单全量</h2>
<table>
  <tr><th>工单</th><th>客户</th><th>问题</th><th>挂起</th><th>档位</th></tr>
  <tr><td>NC-2026-0092</td><td>启润电子</td><td>外观不良（表面凹点）</td><td>6 天</td><td class="deny">今天必须动</td></tr>
  <tr><td>NC-2026-0095</td><td>海川机械</td><td>外包装破损</td><td>2 天</td><td class="warn">今天必须回</td></tr>
  <tr><td>NC-2026-0088</td><td>恒岳重工</td><td>尺寸超差 2 件</td><td>4 天</td><td class="ok">按流程走</td></tr>
  <tr><td>NC-2026-0093</td><td>海川机械</td><td>交付短装 12 件</td><td>3 天</td><td class="ok">按流程走</td></tr>
  <tr><td>NC-2026-0090</td><td>蓝谷自动化</td><td>装配干涉</td><td>5 天</td><td class="ok">等客户回</td></tr>
  <tr><td>NC-2026-0096</td><td>蓝谷自动化</td><td>说明书缺页</td><td>1 天</td><td class="ok">等客户回</td></tr>
  <tr><td>NC-2026-0091</td><td>启润电子</td><td>标签错印</td><td>3 天</td><td class="ok">待客户关单</td></tr>
  <tr><td>NC-2026-0094</td><td>恒岳重工</td><td>表面划痕 1 件</td><td>2 天</td><td class="ok">待质检收口</td></tr>
</table>

<div class="box hot">
  <h2>二、最高危：NC-2026-0092 启润电子</h2>
  <div class="kv">
    <span>建单</span><span>2026-08-03 · 已挂起 6 天</span>
    <span>卡在哪</span><span>复判申请 08-06 提交后无人认领，静置 3 天</span>
    <span>扩散面</span><span>同批 B20260722 另有 300 件在恒岳重工仓库，尚未上线</span>
    <span>技术线索</span><span>不良位置集中在 2#、4# 穴，与模具穴位对得上</span>
  </div>
</div>

<div class="box">
  <h2>三、批次 B20260722 流向</h2>
  <table>
    <tr><th>去向</th><th>数量</th><th>状态</th><th>关联订单</th></tr>
    <tr><td>启润电子</td><td>450 件</td><td class="deny">已交付 · 客诉中</td><td>SO-2026-1019</td></tr>
    <tr><td>恒岳重工</td><td>300 件</td><td class="warn">已交付 · 未上线</td><td>SO-2026-1027 首批</td></tr>
    <tr><td>本厂待检区</td><td>300 件</td><td class="ok">未发出 · 可现场复核</td><td>—</td></tr>
  </table>
</div>

<div class="box">
  <h2>四、今天必须做的两件事</h2>
  <ol>
    <li>给质检负责人派限时复判任务，08-10 12:00 前出结论——这是 0092 唯一的卡点。</li>
    <li>给启润电子何丽回一条进度，说清下一个时间点。原因待复判结论，本次不作任何归因。</li>
  </ol>
</div>

<div class="box">
  <h2>五、留给人决定的事</h2>
  <ol>
    <li>恒岳重工那 300 件要不要提前打招呼，涉及对第二家客户主动披露，需要销售与总经理定口径。</li>
    <li>若复判判定为模具穴位问题，是否整批召回复检，涉及成本与交期取舍，不由我拟定。</li>
  </ol>
</div>

<p class="foot">示例内容，工单号、批次号与客户均为虚构，不对应任何真实企业。</p>
</body></html>`;

const CUSTOMER_VIEW_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<style>
  :root { --brand: #2E56E1; --ink: #0f172a; --muted: #64748b; --line: #e2e8f0; --ok: #15803d; --warn: #b45309; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 20px; font: 14px/1.7 "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; color: var(--ink); background: #f1f5f9; }
  .phone { max-width: 460px; margin: 0 auto; background: #fff; border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
  .top { padding: 10px 14px; background: #f8fafc; border-bottom: 1px solid var(--line); font-size: 12px; color: var(--muted); }
  .top b { display: block; color: var(--ink); font-size: 13px; margin-bottom: 2px; }
  .msg { padding: 14px; }
  .card { border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
  .card .hd { padding: 10px 12px; background: #eef2ff; border-bottom: 1px solid var(--line); font-size: 13px; font-weight: 600; }
  .card .bd { padding: 12px; font-size: 13px; }
  .kv { display: grid; grid-template-columns: 88px 1fr; gap: 4px 12px; font-size: 13px; margin-top: 10px; }
  .kv span:nth-child(odd) { color: var(--muted); }
  .steps { margin: 12px 0 0; padding: 0; list-style: none; font-size: 13px; }
  .steps li { padding-left: 18px; position: relative; margin-bottom: 6px; }
  .steps li::before { content: ""; position: absolute; left: 4px; top: 8px; width: 7px; height: 7px; border-radius: 50%; background: #cbd5e1; }
  .steps li.done::before { background: var(--ok); }
  .steps li.now::before { background: var(--brand); }
  .tail { padding: 10px 14px; border-top: 1px solid var(--line); font-size: 12px; color: var(--muted); }
</style></head><body>
<div class="phone">
  <div class="top"><b>澜达精密制造 · 周晓芸</b>发给 启润电子 何丽 · 2026-08-09 16:52</div>
  <div class="msg">
    <div class="card">
      <div class="hd">NC-2026-0092 处理进度更新</div>
      <div class="bd">
        <p>何工，您反馈的表面凹点问题，进度同步给您：</p>
        <ul class="steps">
          <li class="done">08-03 收到反馈，样件已留存</li>
          <li class="done">08-09 已完成同批次流向排查，涉及范围已锁定</li>
          <li class="now">08-10 12:00 前完成质检复判</li>
          <li>08-10 15:00 前把书面结论和处理方案发给您</li>
        </ul>
        <div class="kv">
          <span>工单</span><span>NC-2026-0092</span>
          <span>关联订单</span><span>SO-2026-1019</span>
          <span>对接人</span><span>周晓芸（跟单）</span>
          <span>下个节点</span><span>2026-08-10 15:00</span>
        </div>
        <p style="margin-top:12px">原因结论要等复判出来，我不先给判断。到点没给您，您直接找我。</p>
      </div>
    </div>
  </div>
  <div class="tail">这是客户此刻在消息里看到的样子 · 示例内容，虚构工单与客户</div>
</div>
</body></html>`;

const ACTION_LIST_SIZE_BYTES = new TextEncoder().encode(ACTION_LIST_HTML).length;
const CUSTOMER_VIEW_SIZE_BYTES = new TextEncoder().encode(CUSTOMER_VIEW_HTML).length;

/** 面板底稿：客诉工单 / 订单中心 / 待办中心 / 企业 IM / 操作留痕 */
const PANEL_BASE: SystemPanelSnapshot = {
  title: "企业系统实况",
  live: true,
  activeView: "complaints",
  foot: "已连接：客诉工单 · 订单中心 · 待办中心 · 企业 IM（演示）",
  views: [
    {
      key: "complaints",
      label: "客诉工单",
      winTitle: "客诉工单 · 未结清单",
      toolbar: { title: "客诉工单 · 未结", sub: "尚未读取" },
      widget: {
        kind: "table",
        cols: [
          { key: "no", label: "工单" },
          { key: "customer", label: "客户" },
          { key: "issue", label: "问题" },
          { key: "days", label: "挂起", align: "right" },
        ],
        rows: [],
        empty: { title: "尚未读取客诉工单" },
      },
    },
    {
      key: "orders",
      label: "订单中心",
      winTitle: "订单中心 · 批次流向",
      toolbar: { title: "批次流向与关联订单", sub: "尚未追溯" },
      widget: { kind: "rows", rows: [], empty: { title: "尚未追溯任何批次" } },
    },
    {
      key: "todos",
      label: "待办中心",
      winTitle: "待办中心 · 本次会话相关",
      toolbar: { title: "待办中心", sub: "尚未创建" },
      widget: { kind: "rows", rows: [], empty: { title: "尚未创建任何待办" } },
    },
    {
      key: "im",
      label: "企业 IM",
      winTitle: "企业 IM · 对外与对内消息",
      toolbar: { title: "对外消息通道", sub: "尚未发出" },
      widget: { kind: "feed", items: [], empty: { title: "尚无消息" } },
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

export const openComplaintsScript: ReplayScript = {
  scenarioId: "catalog-hook-open-complaints",
  title: "今天还有哪些客诉没闭环",
  mode: "quick",
  artifacts: {
    [ACTION_LIST_PATH]: ACTION_LIST_HTML,
    [CUSTOMER_VIEW_PATH]: CUSTOMER_VIEW_HTML,
  },

  steps: [
    {
      caption: "读取未结客诉工单",
      blocks: [
        {
          id: "oc1-prompt",
          kind: "prompt",
          title: "用户消息",
          defaultOpen: true,
          content: "今天还有哪些客诉没闭环？帮我盘一遍，别让哪个客户一直等着我们。",
        },
        {
          id: "oc1-tool",
          kind: "tool_use",
          title: "ComplaintQuery",
          defaultOpen: true,
          toolName: "ComplaintQuery",
          toolId: "t-complaints",
          content: JSON.stringify({ status: "open", owner: "周晓芸" }),
          executionStatus: "completed",
          durationMs: 780,
          presentation: {
            title: "读取客诉工单未结清单",
            detail: [
              { k: "查询范围", v: "客诉工单 · 状态未结 · 本人跟单" },
              { k: "命中", v: "8 个工单 · 最早 08-03 建单" },
              { tree: "├", k: "涉及客户", v: "4 家（启润电子 / 海川机械 / 恒岳重工 / 蓝谷自动化）" },
              { tree: "└", k: "关联订单", v: "6 张，用于批次与交付核对" },
            ],
            status: "ok",
            panelBase: PANEL_BASE,
            panel: [
              { op: "focus", view: "complaints" },
              { op: "toolbar", view: "complaints", title: "客诉工单 · 未结", sub: "8 个待判" },
              { op: "tableRowInsert", view: "complaints", row: { id: "nc-92", cells: { no: "NC-2026-0092", customer: "启润电子", issue: "外观不良（表面凹点）", days: "6 天" } } },
              { op: "tableRowInsert", view: "complaints", row: { id: "nc-95", cells: { no: "NC-2026-0095", customer: "海川机械", issue: "外包装破损", days: "2 天" } } },
              { op: "tableRowInsert", view: "complaints", row: { id: "nc-88", cells: { no: "NC-2026-0088", customer: "恒岳重工", issue: "尺寸超差 2 件", days: "4 天" } } },
              { op: "tableRowInsert", view: "complaints", row: { id: "nc-93", cells: { no: "NC-2026-0093", customer: "海川机械", issue: "交付短装 12 件", days: "3 天" } } },
              { op: "tableRowInsert", view: "complaints", row: { id: "nc-90", cells: { no: "NC-2026-0090", customer: "蓝谷自动化", issue: "装配干涉", days: "5 天" } } },
              { op: "tableRowInsert", view: "complaints", row: { id: "nc-96", cells: { no: "NC-2026-0096", customer: "蓝谷自动化", issue: "说明书缺页", days: "1 天" } } },
              { op: "tableRowInsert", view: "complaints", row: { id: "nc-91", cells: { no: "NC-2026-0091", customer: "启润电子", issue: "标签错印", days: "3 天" } } },
              { op: "tableRowInsert", view: "complaints", row: { id: "nc-94", cells: { no: "NC-2026-0094", customer: "恒岳重工", issue: "表面划痕 1 件", days: "2 天" } } },
              { op: "feedAppend", view: "audit", item: { id: "au-1", from: "AI 同事", time: "16:20:11", text: "读取客诉工单未结清单 8 条与 6 张关联订单（只读）" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "1 条" },
            ],
          },
        },
        {
          id: "oc1-result",
          kind: "tool_result",
          title: "ComplaintQuery 结果",
          defaultOpen: false,
          toolName: "ComplaintQuery",
          toolId: "t-complaints",
          content: "open=8 customers=4 orders=6 oldest=NC-2026-0092",
        },
        {
          id: "oc1-text",
          kind: "text",
          title: "业务进展",
          defaultOpen: true,
          content: "8 个未结工单都在这儿了。挂得最久的是 6 天，不过挂得久不等于最该急——我按「会不会扩散、会不会伤客户关系」排一遍，每条给你理由。",
        },
      ],
    },

    {
      caption: "按扩散风险排序，逐条给理由",
      blocks: [
        {
          id: "oc2-tool",
          kind: "tool_use",
          title: "ComplaintTriage",
          defaultOpen: true,
          toolName: "ComplaintTriage",
          toolId: "t-triage",
          content: JSON.stringify({ tickets: 8, dims: ["扩散面", "挂起天数", "客户影响"] }),
          executionStatus: "completed",
          durationMs: 1620,
          presentation: {
            title: "按扩散面与客户影响重排 8 个工单",
            detail: [
              { risk: "high", text: "NC-2026-0092 启润电子 外观不良 · 挂起 6 天", action: "同批 B20260722 还有 300 件在恒岳重工仓库没上线，问题会扩散到第二家客户" },
              { risk: "medium", text: "NC-2026-0095 海川机械 外包装破损 · 挂起 2 天", action: "货值只有 ¥1,800，但对接人是 OPP-2026-0311 二期商机的决策人，晾着会伤谈判气氛" },
              { verdict: "pass", text: "NC-2026-0088 / NC-2026-0093", note: "恒岳与海川的补件已在途，08-11 到货，按流程走就行" },
              { verdict: "pending", text: "NC-2026-0090 / NC-2026-0096", note: "球在蓝谷自动化那边，等客户回确认，我们没有卡点" },
              { verdict: "pending", text: "NC-2026-0091 / NC-2026-0094", note: "一个待客户关单，一个待质检收口，都在正常时限内" },
              { warn: "0092 真正卡住的地方不是我们没处理，是复判申请 08-06 提交后没人认领，静置了 3 天" },
              { insight: "今天要动的只有 2 个：0092 得有人接复判，0095 得有一条回复。其余 6 个不用你操心", label: "结论" },
            ],
            status: "warn",
            panel: [
              { op: "focus", view: "complaints" },
              { op: "toolbar", view: "complaints", title: "客诉工单 · 按风险重排", sub: "高危 1 · 当天回 1 · 正常 6" },
              { op: "tableRowUpdate", view: "complaints", id: "nc-92", set: { tone: "deny" } },
              { op: "cellFlag", view: "complaints", rowId: "nc-92", colKey: "days", tone: "deny", flag: "最高危" },
              { op: "tableRowUpdate", view: "complaints", id: "nc-95", set: { tone: "warn" } },
              { op: "cellFlag", view: "complaints", rowId: "nc-95", colKey: "days", tone: "warn", flag: "当天回" },
              { op: "feedAppend", view: "audit", item: { id: "au-2", from: "AI 同事", time: "16:20:39", text: "按扩散面与客户影响重排 8 个工单：高危 1 · 当天回 1 · 正常 6" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "2 条" },
            ],
          },
        },
        {
          id: "oc2-text",
          kind: "text",
          title: "业务进展",
          defaultOpen: true,
          content: [
            "排完之后，**今天真正要动的只有两个**：",
            "",
            "1. **NC-2026-0092 启润电子**，挂 6 天。它排第一不是因为挂得久，是因为同一批 B20260722 还有 300 件在恒岳重工仓库放着——那批一旦上线，我们就有第二起客诉。卡点也很具体：复判申请 08-06 提交，到今天没人认领，静置 3 天。",
            "2. **NC-2026-0095 海川机械**，包装破损，货值 ¥1,800。按损失算它排不上号，但对接人就是 OPP-2026-0311 二期商机那条线上的人，晾两天不回，谈判桌上的气氛是要还的。",
            "",
            "剩下 6 个我看过了：两个补件在途 08-11 到货，两个等蓝谷自动化回确认，两个在正常时限内。**这 6 个今天不用你管**，我盯着到期就行。",
          ].join("\n"),
        },
      ],
    },

    {
      caption: "追溯同批次流向",
      blocks: [
        {
          id: "oc3-tool",
          kind: "tool_use",
          title: "BatchTrace",
          defaultOpen: true,
          toolName: "BatchTrace",
          toolId: "t-trace",
          content: JSON.stringify({ ticket: "NC-2026-0092", batch: "B20260722" }),
          executionStatus: "completed",
          durationMs: 1340,
          presentation: {
            title: "追溯批次 B20260722 的去向",
            detail: [
              { k: "批次", v: "B20260722 · 07-22 注塑 · 共 1,050 件" },
              { fields: [
                { k: "启润电子", v: "450 件 · 已交付 · 客诉中" },
                { k: "恒岳重工", v: "300 件 · 已交付 · 未上线" },
                { k: "本厂待检区", v: "300 件 · 未发出" },
              ] },
              { tree: "├", k: "关联订单", v: "SO-2026-1019 启润电子 / SO-2026-1027 恒岳重工首批" },
              { tree: "└", k: "共同特征", v: "不良集中在 2#、4# 穴，与模具穴位对得上" },
              { warn: "恒岳那 300 件现在还没上线，这个时间窗口拦得住；SO-2026-1027 余量 08-15 交付，一旦客户提前投产就来不及了" },
              { insight: "0092 不是一个客户的工单，它是一个批次的问题，处理口径要按批次来定", label: "结论" },
            ],
            status: "warn",
            panel: [
              { op: "focus", view: "orders" },
              { op: "toolbar", view: "orders", title: "批次 B20260722 流向", sub: "3 个去向 · 1,050 件" },
              { op: "rowsSet", view: "orders", rows: [
                { id: "tr-qr", text: "启润电子 450 件", sub: "SO-2026-1019 · 已交付 · 正在客诉", tone: "deny", state: "hit", badge: { text: "已发生", tone: "deny" } },
                { id: "tr-hy", text: "恒岳重工 300 件", sub: "SO-2026-1027 首批 · 07-28 已发 · 客户尚未上线", tone: "warn", state: "hit", badge: { text: "可拦截", tone: "warn" } },
                { id: "tr-wh", text: "本厂待检区 300 件", sub: "未发出 · 可现场抽检复核", tone: "info", badge: { text: "在手", tone: "info" } },
              ] },
              { op: "feedAppend", view: "audit", item: { id: "au-3", from: "AI 同事", time: "16:21:08", text: "追溯批次 B20260722，锁定 3 个去向共 1,050 件（只读）" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "3 条" },
            ],
          },
        },
        {
          id: "oc3-text",
          kind: "text",
          title: "业务进展",
          defaultOpen: true,
          content: [
            "追溯结果是这次盘点里最要紧的一条：**这不是一个客户的工单，是一个批次的问题**。",
            "",
            "- 启润电子 450 件已经装机，问题已经发生；",
            "- 恒岳重工 300 件在他们仓库躺着，还没上线——这 300 件是我们现在唯一还拦得住的部分；",
            "- 我们自己待检区还有 300 件没发，可以马上抽检验证。",
            "",
            "不良位置集中在 2#、4# 穴，和模具穴位对得上。**但这只是线索，不是结论**——是不是模具问题得质检复判说了算，我不替他们下判断。",
          ].join("\n"),
        },
      ],
    },

    {
      caption: "对外预设归因被停住",
      blocks: [
        {
          id: "oc4-prompt",
          kind: "prompt",
          title: "用户消息",
          defaultOpen: true,
          content: "那先给启润回一句吧，就说质检确认了是运输环节磕碰造成的，我们下批注意，把客户先安抚住。",
        },
        {
          id: "oc4-tool",
          kind: "tool_use",
          title: "CustomerReply",
          defaultOpen: true,
          toolName: "CustomerReply",
          toolId: "t-reply-block",
          content: JSON.stringify({ to: "启润电子 何丽", ticket: "NC-2026-0092", claim: "运输磕碰" }),
          executionStatus: "completed",
          durationMs: 240,
          presentation: {
            title: "对外回复 · 归因口径校验",
            detail: [
              { k: "拟发对象", v: "启润电子 何丽（供应链）" },
              { k: "拟发口径", v: "把外观不良归因为运输磕碰" },
              { k: "复判状态", v: "申请中 · 结论未出" },
              { verdict: "fail", text: "这条我停住了，没有发出", note: "复判结论还没出，这句话等于我们替质检先下了定论" },
              { indent: 0, text: "⚠ 追溯已显示不良集中在 2#、4# 穴，运输归因大概率会被推翻；推翻一次，后面每一句解释客户都要打折扣" },
              { insight: "现在能对外说的是进度和时间点，不是原因", label: "替代路径" },
            ],
            status: "blocked",
            panel: [
              { op: "focus", view: "im" },
              { op: "toolbar", view: "im", title: "对外消息通道", sub: "1 条草稿被停住" },
              { op: "feedAppend", view: "im", item: {
                id: "im-hold",
                from: "AI 同事",
                time: "16:21:30",
                text: "拟发启润电子 何丽的归因回复未发出",
                card: {
                  title: "草稿已停住 · 未发送",
                  body: "内容包含「质检确认为运输磕碰」，与当前复判状态不符；已改为按进度口径重拟",
                  meta: [{ text: "未发送", tone: "pass" }, { text: "已记账", tone: "info" }],
                },
              } },
              { op: "feedAppend", view: "audit", item: { id: "au-4", from: "AI 同事", time: "16:21:30", text: "对外归因回复被口径校验停住，未向客户发出任何消息" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "4 条" },
            ],
          },
        },
        {
          id: "oc4-text",
          kind: "text",
          title: "回复",
          defaultOpen: true,
          content: [
            "**这句我不发**。不是不想帮你安抚客户，是这句话现在没有依据：复判结论还没出，「运输磕碰」是我们自己替质检说的。",
            "",
            "而且我刚追溯完，不良集中在 2#、4# 穴——真按穴位查下去，运输这个说法很可能站不住。**一旦被推翻，何丽后面再听我们说什么都会打个折扣**，比现在晚回两天的代价大得多。",
            "",
            "能发的是这两种：",
            "",
            "1. 只讲进度和下一个时间点：告诉何丽复判 08-10 12:00 前出结论、当天 15:00 前给她书面答复，原因等结论；",
            "2. 如果你想更主动，我可以加一句我们已经排查了同批次流向、范围已经锁定——这是事实，不涉及责任归属。",
            "",
            "两种都不认责、也不甩锅。你选一个，我按你选的拟。",
          ].join("\n"),
        },
      ],
    },

    {
      caption: "生成未结盘点与今日行动",
      blocks: [
        {
          id: "oc5-tool",
          kind: "tool_use",
          title: "ReportBuild",
          defaultOpen: true,
          toolName: "ReportBuild",
          toolId: "t-report",
          content: JSON.stringify({ doc: "客诉未结盘点与今日行动", date: "2026-08-09" }),
          executionStatus: "completed",
          durationMs: 1180,
          presentation: {
            title: "生成《客诉未结盘点与今日行动》",
            detail: [
              { k: "覆盖", v: "8 个未结工单 · 分三档" },
              { k: "今天必须动", v: "2 项（0092 复判认领 / 0095 回复）" },
              { tree: "├", k: "可以等", v: "6 项，各自写清在等谁、等到哪天" },
              { tree: "└", k: "留给人定", v: "2 项，恒岳 300 件是否提前打招呼、是否整批复检" },
              { section: "对外口径" },
              { verdict: "pass", text: "全文不含责任归因", note: "只写进度、范围与时间点" },
            ],
            status: "ok",
            panel: [
              { op: "focus", view: "audit" },
              { op: "feedAppend", view: "audit", item: {
                id: "au-5",
                from: "AI 同事",
                time: "16:22:04",
                text: "生成《客诉未结盘点与今日行动》，含 8 个工单分档与 2 项留给人决定的事",
                card: {
                  title: "产物已生成",
                  body: "未结盘点 8 条 · 今日行动 2 条 · 留给人定 2 条",
                  meta: [{ text: "可下载", tone: "pass" }, { text: "未对外发出", tone: "info" }],
                },
              } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "5 条" },
            ],
          },
        },
        {
          id: "oc5-text",
          kind: "text",
          title: "回复",
          defaultOpen: true,
          content: [
            "盘点做完了，一页纸拿走：",
            "",
            `[FILE]{"filePath":"${ACTION_LIST_PATH}","fileName":"客诉未结盘点与今日行动.html","fileSize":${ACTION_LIST_SIZE_BYTES}}[/FILE]`,
            "",
            "里面有一节叫「留给人决定的事」，两条都不是我该拍的：恒岳重工那 300 件要不要提前打招呼，这是对第二家客户主动披露，得销售和沈总定口径；万一复判判成模具问题，整批要不要召回复检，那是成本和交期的取舍。**我把位置和时间窗口标出来，判断交给你**。",
          ].join("\n"),
        },
      ],
    },

    {
      caption: "两条动作等你确认",
      blocks: [],
      approval: {
        title: "跨部门与对外动作 · 需你确认",
        description: "确认后我会建一条质检复判待办、给启润电子发一条进度回复，并在两张工单上各追加一条进展记录。这三处都会改动业务系统，我不自行发出。",
        facts: [
          { label: "动作 1", value: "给质检负责人建限时复判待办 · 08-10 12:00 前出结论" },
          { label: "动作 2", value: "给启润电子何丽发进度回复 · 只讲进度与时间点" },
          { label: "涉及批次", value: "B20260722 · 启润 450 件已交付 / 恒岳 300 件未上线" },
          { label: "回复口径", value: "不含任何责任归因，原因待复判结论" },
        ],
        approveLabel: "确认发出",
        rejectLabel: "退回修改",
        approvedBlocks: [
          {
            id: "oc6-human",
            kind: "prompt",
            title: "用户消息",
            defaultOpen: true,
            content: "待办可以，就按 12 点。回复那条我改一下：别写「争取本周内答复」，直接写 08-10 15:00 前给她书面结论；还有「我司高度重视」那句删掉，何丽不吃这套，她只要时间点。",
          },
          {
            id: "oc6-approve",
            kind: "tool_use",
            title: "Approval",
            defaultOpen: true,
            toolName: "Approval",
            toolId: "t-approve",
            content: JSON.stringify({ ticket: "NC-2026-0092", decision: "approved", edits: 1 }),
            executionStatus: "completed",
            durationMs: 360,
            presentation: {
              title: "已确认 · 含人工修改 1 项",
              detail: [
                { k: "审批结果", v: "确认发出" },
                { k: "人工采纳", v: "1 项——质检复判待办，08-10 12:00 截止" },
                { k: "人工修改", v: "1 项——答复时限由「争取本周内」改为 08-10 15:00 前，并删去客套句" },
                { tree: "├", k: "记账", v: "采纳 1 项 · 修改 1 项 · 自动执行 0 项" },
                { tree: "└", k: "留痕", v: "原草稿与改后版本都保留，可逐字比对" },
              ],
              status: "ok",
              receipt: { id: "TD-1207", system: "待办中心", readBack: true },
              panel: [
                { op: "focus", view: "todos" },
                { op: "toolbar", view: "todos", title: "待办中心", sub: "新增 1 条 · 已回读" },
                { op: "rowsSet", view: "todos", rows: [
                  { id: "td-1207", text: "TD-1207 复判 NC-2026-0092 表面凹点", sub: "责任人：质检负责人 · 截止 08-10 12:00 · 关联批次 B20260722", tone: "pass", state: "hit", badge: { text: "已创建", tone: "pass" } },
                ] },
                { op: "feedAppend", view: "audit", item: {
                  id: "au-6",
                  from: "周晓芸",
                  time: "16:52:02",
                  text: "确认发出：采纳 1 项、修改 1 项（答复时限改为 08-10 15:00 前并删客套句）",
                  card: {
                    title: "人审记录",
                    body: "采纳 1 · 修改 1 · 自动执行 0",
                    meta: [{ text: "AI 未自行发出", tone: "pass" }],
                  },
                } },
                { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "6 条" },
              ],
            },
          },
          {
            id: "oc6-dispatch",
            kind: "tool_use",
            title: "Dispatch",
            defaultOpen: true,
            toolName: "Dispatch",
            toolId: "t-dispatch",
            content: JSON.stringify({ to: "启润电子 何丽", ticket: "NC-2026-0092", deadline: "2026-08-10 15:00" }),
            executionStatus: "completed",
            durationMs: 940,
            presentation: {
              title: "进度回复已送达客户",
              detail: [
                { k: "收件人", v: "启润电子 何丽（供应链）" },
                { k: "送达时间", v: "08-09 16:52 · 已读" },
                { tree: "├", k: "承诺节点", v: "08-10 12:00 复判出结论 · 15:00 前书面答复" },
                { tree: "└", k: "工单回写", v: "0092 追加「复判已派单」，0095 转「已回复待关闭」" },
                { verdict: "pass", text: "全文无责任归因", note: "按你改后的版本发出，客套句已删" },
              ],
              status: "ok",
              receipt: { id: "MSG-2026-3391", system: "企业 IM", readBack: true },
              panel: [
                { op: "focus", view: "im" },
                { op: "toolbar", view: "im", title: "对外消息通道", sub: "1 条已送达 · 1 条仍停住" },
                { op: "feedAppend", view: "im", item: {
                  id: "im-sent",
                  from: "周晓芸",
                  time: "16:52:18",
                  text: "已发送 NC-2026-0092 处理进度更新给何丽",
                  card: {
                    title: "NC-2026-0092 处理进度更新",
                    body: "08-10 12:00 前完成复判，15:00 前把书面结论和处理方案发给您。原因结论要等复判出来，我不先给判断。",
                    meta: [{ text: "已送达", tone: "pass" }, { text: "已读", tone: "info" }],
                  },
                } },
                { op: "tableRowUpdate", view: "complaints", id: "nc-92", set: { cells: { days: "复判中" }, tone: "pending" } },
                { op: "cellFlag", view: "complaints", rowId: "nc-92", colKey: "days", tone: "pending", flag: "已派单" },
                { op: "tableRowUpdate", view: "complaints", id: "nc-95", set: { cells: { days: "已回复" }, tone: "pass" } },
                { op: "cellFlag", view: "complaints", rowId: "nc-95", colKey: "days", tone: "pass", flag: "待关闭" },
                { op: "feedAppend", view: "audit", item: { id: "au-7", from: "AI 同事", time: "16:52:18", text: "发送客户进度回复并回写两张工单进展记录，回执 MSG-2026-3391 已回读" } },
                { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "7 条" },
              ],
            },
          },
          {
            id: "oc6-text",
            kind: "text",
            title: "审批结果",
            defaultOpen: true,
            content: [
              "两条都按你改后的口径发出去了。**这是何丽此刻在消息里看到的样子**：",
              "",
              `[FILE]{"filePath":"${CUSTOMER_VIEW_PATH}","fileName":"客户收到的进度回复.html","fileSize":${CUSTOMER_VIEW_SIZE_BYTES}}[/FILE]`,
              "",
              "「争取本周内」已经换成 08-10 15:00 前，客套句删掉了。TD-1207 挂在质检负责人名下，08-10 12:00 截止——到点没动静我会先提醒他，还不动就来找你。",
            ].join("\n"),
          },
        ],
        rejectedBlocks: [
          {
            id: "oc6-reject",
            kind: "tool_use",
            title: "Approval",
            defaultOpen: true,
            toolName: "Approval",
            toolId: "t-reject",
            content: JSON.stringify({ ticket: "NC-2026-0092", decision: "rejected" }),
            executionStatus: "completed",
            durationMs: 260,
            presentation: {
              title: "已退回 · 什么都没有发出",
              detail: [
                { k: "审批结果", v: "退回修改" },
                { k: "客户回复", v: "未发送" },
                { k: "待办中心", v: "未创建任何待办" },
                { tree: "├", k: "客诉工单", v: "无写入，8 条仍为未结" },
                { tree: "└", k: "留痕", v: "退回时间、退回人与当时的草稿版本已记录" },
                { warn: "0092 的复判还是没人认领，扩散窗口继续缩小——退回不解决这条，只是把决定权留给你" },
              ],
              status: "blocked",
              panel: [
                { op: "focus", view: "todos" },
                { op: "toolbar", view: "todos", title: "待办中心", sub: "未创建" },
                { op: "rowsSet", view: "todos", rows: [
                  { id: "td-hold", text: "质检复判待办未创建", sub: "审批退回，跨部门派单未发生", tone: "warn", badge: { text: "已停住", tone: "warn" } },
                ] },
                { op: "feedAppend", view: "audit", item: { id: "au-reject", from: "周晓芸", time: "16:52:02", text: "退回修改：未创建待办、未发送任何对外回复、工单无写入" } },
                { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "6 条" },
              ],
            },
          },
          {
            id: "oc6-reject-text",
            kind: "text",
            title: "退回说明",
            defaultOpen: true,
            content: "停在确认点了：没建待办、没给何丽发任何消息、8 张工单一条也没动。盘点清单还在，你可以自己拿去发，或者告诉我哪句要改，我重拟一版再来问你。",
          },
        ],
      },
    },

    {
      caption: "跨系统核对终态",
      blocks: [
        {
          id: "oc7-tool",
          kind: "tool_use",
          title: "ReadBack",
          defaultOpen: true,
          toolName: "ReadBack",
          toolId: "t-readback",
          content: JSON.stringify({ scope: ["客诉工单", "待办中心", "企业 IM", "订单中心"] }),
          executionStatus: "completed",
          durationMs: 1020,
          presentation: {
            title: "回读四个系统，核对说法是否对得上",
            detail: [
              { k: "回读方式", v: "按单号逐个反查，不用本次会话的缓存" },
              { verdict: "pass", text: "客诉工单", note: "0092 复判中 · 0095 已回复待关闭 · 其余 6 条未结未动" },
              { verdict: "pass", text: "待办中心", note: "TD-1207 · 责任人质检负责人 · 08-10 12:00 截止" },
              { verdict: "pass", text: "企业 IM", note: "1 条已送达已读 · 1 条归因草稿仍为未发送" },
              { verdict: "pass", text: "订单中心", note: "只读追溯，SO-2026-1019 与 SO-2026-1027 均无写入" },
              { insight: "四方一致，没有半路停下的动作", label: "结论" },
            ],
            status: "ok",
            panel: [
              { op: "focus", view: "complaints" },
              { op: "toolbar", view: "complaints", title: "客诉工单 · 终态回读", sub: "四方一致" },
              { op: "feedAppend", view: "audit", item: { id: "au-8", from: "AI 同事", time: "16:53:10", text: "回读客诉工单 / 待办中心 / 企业 IM / 订单中心，四方状态一致" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "8 条" },
            ],
          },
        },
        {
          id: "oc7-text",
          kind: "text",
          title: "本次会话改变了什么",
          defaultOpen: true,
          content: [
            "## 本次会话改变了什么",
            "",
            "| 系统 | 终态 | 依据 |",
            "| --- | --- | --- |",
            "| 客诉工单 | NC-2026-0092 转复判中，NC-2026-0095 转已回复待关闭，其余 6 条未动 | 两条进展记录回写 |",
            "| 待办中心 | 新增 TD-1207，责任人质检负责人，08-10 12:00 截止 | 待办回执已回读 |",
            "| 企业 IM | 1 条进度回复已送达并已读；1 条归因草稿保持未发送 | 送达回执 MSG-2026-3391 |",
            "| 订单中心 | 无写入，仅读取批次 B20260722 的三个去向 | 只读追溯留痕 |",
            "",
            "## 本次会话没有做什么",
            "",
            "- 没有对外认责，也没有否认责任：复判结论没出来之前，谁的问题这句话我一个字都不说；",
            "- 没有承诺任何赔偿、退换或折让：这类口子只能你和销售一起开，我连草稿都没拟；",
            "- 没有通知恒岳重工那 300 件：对第二家客户主动披露涉及口径和商务判断，我只把位置和时间窗口标出来，交给你和沈总定；",
            "- 没有替质检下结论：2#、4# 穴那条只是线索，写进清单时也标着「线索」两个字。",
          ].join("\n"),
        },
        {
          id: "oc7-next",
          kind: "text",
          title: "接下来",
          defaultOpen: true,
          content: "以后这件事不用你记着问——我可以每天 17:00 自动盘一遍未结客诉，只有冒出新的高危、或者哪张工单卡住超过 2 天才叫你，其余的整理成清单放着。想开随时跟我说一声。",
        },
      ],
    },
  ],

  // 治理条款：state != exists 的条目就是「演示到真实」的距离
  sources: [
    {
      blockRef: "step1.tool.ComplaintQuery",
      producer: "租户业务数据连接器",
      state: "missing",
      gap: "没有通用的业务数据连接器；读客诉工单台账目前只能靠客户自建查询或数据库只读账号，且都不产出业务语义摘要",
    },
    {
      blockRef: "step2.tool.ComplaintTriage",
      producer: "Agent 分析（会话内推理）",
      state: "exists",
    },
    {
      blockRef: "step3.tool.BatchTrace",
      producer: "租户业务数据连接器",
      state: "missing",
      gap: "批次追溯要同时读生产批次、发货记录与订单，三张表的连接器都不存在；真实落地前这一步只能人工查",
    },
    {
      blockRef: "step4.tool.CustomerReply",
      producer: "对外口径门禁（独立于会话的判定）",
      state: "needs-change",
      gap: "门禁形态已在客户 POC 验证过（会话外独立判定 + 前端预设话术），但「结论未出不得对外归因」这类业务规则尚未产品化为可配置规则集",
    },
    {
      blockRef: "step5.tool.ReportBuild",
      producer: "Agent 生成 HTML 产物",
      state: "exists",
    },
    {
      blockRef: "step6.tool.Approval",
      producer: "业务审批执行器 + 钉钉 DWS 连接器（待办创建）",
      state: "needs-change",
      gap: "人审事件在 runtime 已成对记录、钉钉待办也能建，但「人改了哪一条」没有结构化字段，采纳与修改的计数现在只能落在自由文本里",
    },
    {
      blockRef: "step6.tool.Dispatch",
      producer: "钉钉 DWS 连接器（消息发送与工单进展回写）",
      state: "needs-change",
      gap: "消息发送能力存在，但送达与已读回执、以及回写客诉工单进展记录这两段需要改造才会输出本摘要",
    },
    {
      blockRef: "step7.tool.ReadBack",
      producer: "业务终态回读器",
      state: "missing",
      gap: "跨系统回读依赖各系统连接器先就位；在那之前终态核对表只能人工整理",
    },
    {
      blockRef: "step5.artifact.客诉未结盘点与今日行动",
      producer: "Agent 生成 HTML 产物",
      state: "exists",
    },
    {
      blockRef: "step6.artifact.客户收到的进度回复",
      producer: "Agent 生成 HTML 产物",
      state: "exists",
    },
  ],
};

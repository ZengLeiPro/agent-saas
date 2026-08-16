import type { SystemPanelSnapshot } from "@agent/shared";
import type { ReplayScript } from "./types";

/**
 * 剧本三：到期事项追到提交回执。
 *
 * 骨架照 complianceGateScript 抄，但换了一条更难演的主线——无人值守：
 *   ① 起手不是用户提问，是每天 07:00 的排程自己发起；
 *   ② 主动停下——提交成功不等于办成，没有权威回执就死活不写「已完成」；
 *   ③ 需要人拍板的那一项走审批门禁，人可以改掉 AI 拟的对外口径；
 *   ④ 可下载产物——到期事项台账 / 巡检日报，回执单独占一列。
 * 外加升级动作：临期未回执的指派到人 + 写死下次复查时间，不是发条消息就算完。
 *
 * 内容为示例数据，不对应任何真实企业、申报批次、专利或合同。
 */

const WATCH_REPORT_PATH = "assets/demo/到期事项巡检日报.html";

const WATCH_REPORT_HTML = `<!doctype html>
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
  .box { border: 1px solid var(--line); border-left: 3px solid var(--warn); border-radius: 8px; padding: 12px; margin-bottom: 12px; }
  .box h2 { margin: 0 0 8px; font-size: 13px; }
  .box ul { margin: 0; padding-left: 18px; }
  .box li { margin-bottom: 4px; }
  .foot { margin-top: 14px; color: var(--muted); font-size: 12px; }
</style></head><body>
<div class="bar"><span class="tag">无人值守</span><span>每日 07:00 到期事项巡检 · 批次 WATCH-2026-0726 · 本轮无人工发起</span></div>

<h1>到期事项台账 · 巡检日报</h1>
<p class="sub">生成时间 2026-07-26 09:42 · 覆盖 5 项在办事项 · 下一轮巡检 2026-07-27 07:00</p>

<div class="stats">
  <div class="stat"><b class="ok">2</b><span>已确认办结</span></div>
  <div class="stat"><b class="warn">2</b><span>已提交 · 未确认</span></div>
  <div class="stat"><b class="deny">1</b><span>未提交 · 缺件</span></div>
  <div class="stat"><b>2</b><span>已升级到人</span></div>
</div>

<table>
  <tr><th>事项</th><th>法定 / 合同时限</th><th>材料状态</th><th>提交状态</th><th>回执状态</th></tr>
  <tr>
    <td>社保公积金申报<br><span style="color:#64748b">SI-2026-07 · 87 人 · 318,470.26 元</span></td>
    <td>2026-07-28（剩 2 天）</td><td class="ok">齐套</td>
    <td class="ok">已提交 07:02</td><td class="ok">已受理 SI-20260726-004173</td>
  </tr>
  <tr>
    <td>专利年费（第 7 年）<br><span style="color:#64748b">ZL201820447153 · 2,000 元</span></td>
    <td>2026-08-03（剩 8 天）</td><td class="ok">齐套</td>
    <td class="ok">已提交 07:02</td><td class="ok">缴费通知书 CN-2026-0726-0083</td>
  </tr>
  <tr>
    <td>出口退税申报<br><span style="color:#64748b">TR-2026-06 · 12 票 · 486,230.50 元</span></td>
    <td>2026-07-31（剩 5 天）</td><td class="ok">齐套</td>
    <td class="ok">已提交 07:02</td><td class="warn">未返回 · 仅有流水号 SB2026072600317</td>
  </tr>
  <tr>
    <td>客户框架合同续签<br><span style="color:#64748b">HT-2023-0918 · Vestholm Industri AB（瑞典）</span></td>
    <td>2026-08-01 前发函（剩 6 天）</td><td class="ok">齐套</td>
    <td class="ok">已用印并寄出 OA-SEAL-2026-0774</td><td class="warn">待对方签回 EMS EA283916477CN</td>
  </tr>
  <tr>
    <td>高新企业年度发展情况报表<br><span style="color:#64748b">GR202435001188</span></td>
    <td>2026-08-31（剩 36 天）</td><td class="deny">缺件：研发费用辅助账</td>
    <td class="deny">未提交</td><td>—</td>
  </tr>
</table>

<div class="box">
  <h2>升级与复查（未确认 / 未提交项）</h2>
  <ul>
    <li><b>出口退税 TR-2026-06</b> — 已升级关务主管、财务负责人。复查点 07-26 14:00、07-27 07:00；07-28 17:00 仍无《出口退税申报受理通知书》即转人工到办税服务厅当面确认，为 07-31 申报期截止预留 3 天重报窗口。</li>
    <li><b>客户框架合同续签 HT-2023-0918</b> — 用印口径经有权人修改后发出（账期 60 天、额度 200 万元、新增汇率条款）。对方签回前不计入办结，复查点 07-29 07:00。</li>
    <li><b>高新企业年度报表 GR202435001188</b> — 已升级研发管理岗、财务共享中心，要求 07-29 前提供 2026 上半年研发费用辅助账。复查点 07-29 07:00；材料到位当轮巡检自动续办。</li>
  </ul>
</div>

<p class="foot">示例内容，不对应任何真实企业、申报批次、专利或合同。回执状态一律以主管机关或对方出具的凭据为准，本表不以「已提交」代替「已办结」。</p>
</body></html>`;

const WATCH_REPORT_SIZE_BYTES = new TextEncoder().encode(WATCH_REPORT_HTML).length;

/** 面板底稿：到期台账 / 提交与回执 / 协同通知 / 操作留痕 */
const PANEL_BASE: SystemPanelSnapshot = {
  title: "企业系统实况",
  live: true,
  activeView: "ledger",
  foot: "已连接：到期事项台账 · 申报平台 · OA 用印 · 协同通知（演示）",
  views: [
    {
      key: "ledger",
      label: "到期台账",
      winTitle: "到期事项台账 · 法定与合同时限",
      toolbar: { title: "到期事项台账", sub: "等待每日排程触发" },
      widget: {
        kind: "table",
        cols: [
          { key: "item", label: "事项" },
          { key: "due", label: "法定 / 合同时限" },
          { key: "left", label: "剩余" },
          { key: "state", label: "状态", align: "right" },
        ],
        rows: [],
        empty: { title: "尚未开始巡检" },
      },
    },
    {
      key: "filing",
      label: "提交与回执",
      winTitle: "申报提交与回执追踪",
      toolbar: { title: "提交与回执追踪", sub: "本批次 0 项已提交" },
      widget: {
        kind: "table",
        cols: [
          { key: "item", label: "事项" },
          { key: "channel", label: "提交渠道" },
          { key: "ticket", label: "提交 / 受理编号" },
          { key: "receipt", label: "回执", align: "right" },
        ],
        rows: [],
        empty: { title: "本批次尚无提交" },
      },
    },
    {
      key: "notify",
      label: "协同通知",
      winTitle: "协同通知 · 责任人与复查排程",
      toolbar: { title: "已发出的通知", sub: "0 条" },
      widget: { kind: "feed", items: [], empty: { title: "尚未发出通知" } },
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

export const deadlineWatchScript: ReplayScript = {
  scenarioId: "catalog-deadline-to-receipt-watch",
  title: "到期事项追到提交回执",
  mode: "hero",
  artifacts: { [WATCH_REPORT_PATH]: WATCH_REPORT_HTML },

  steps: [
    {
      caption: "07:00 排程自己起手",
      blocks: [
        {
          id: "d1-trigger",
          kind: "text",
          title: "定时任务触发",
          defaultOpen: true,
          replayInstant: true,
          content: [
            "07:00 到期事项巡检已启动，批次 WATCH-2026-0726。",
            "这一轮没有人提问、没有人点开对话框。排程到点自己发起：扫全部带法定或合同时限的在办事项 → 逐项核材料是否齐套 → 齐套的按批准渠道提交 → 然后一直盯回执。",
          ].join("\n"),
        },
        {
          id: "d1-tool",
          kind: "tool_use",
          title: "DeadlineScan",
          defaultOpen: true,
          toolName: "DeadlineScan",
          toolId: "t-scan",
          content: JSON.stringify({ batch: "WATCH-2026-0726", trigger: "cron 0 7 * * *" }),
          executionStatus: "completed",
          durationMs: 1320,
          presentation: {
            title: "扫描到期事项台账",
            detail: [
              { k: "触发方式", v: "每日 07:00 排程 · 无人工介入" },
              { k: "在办事项", v: "5 项（法定时限 4 · 合同时限 1）" },
              { k: "进入预警区", v: "3 项 · 剩余不足 10 天" },
              { tree: "├", k: "最紧迫", v: "社保公积金申报 · 2026-07-28 · 剩 2 天" },
              { tree: "└", k: "上轮遗留", v: "0 项（07-25 批次已全部闭环）" },
            ],
            status: "ok",
            panelBase: PANEL_BASE,
            panel: [
              { op: "focus", view: "ledger" },
              { op: "toolbar", view: "ledger", title: "到期事项台账 · 批次 WATCH-2026-0726", sub: "5 项在办 · 3 项预警" },
              { op: "tableRowInsert", view: "ledger", row: { id: "it-social", cells: { item: "社保公积金申报 · SI-2026-07", due: "2026-07-28", left: "2 天", state: "待核材料" }, tone: "warn" } },
              { op: "tableRowInsert", view: "ledger", row: { id: "it-tax", cells: { item: "出口退税申报 · TR-2026-06", due: "2026-07-31", left: "5 天", state: "待核材料" }, tone: "warn" } },
              { op: "tableRowInsert", view: "ledger", row: { id: "it-contract", cells: { item: "客户框架合同续签 · HT-2023-0918", due: "2026-08-01 前发函", left: "6 天", state: "待核材料" }, tone: "warn" } },
              { op: "tableRowInsert", view: "ledger", row: { id: "it-patent", cells: { item: "专利年费（第 7 年） · ZL201820447153", due: "2026-08-03", left: "8 天", state: "待核材料" } } },
              { op: "tableRowInsert", view: "ledger", row: { id: "it-hitech", cells: { item: "高新企业年度发展情况报表 · GR202435001188", due: "2026-08-31", left: "36 天", state: "待核材料" } } },
              { op: "pulse", view: "ledger", ids: ["it-social", "it-tax", "it-contract"], kind: "scan" },
              { op: "feedAppend", view: "audit", item: { id: "aw-1", from: "AI 同事", time: "07:00:02", text: "排程触发巡检批次 WATCH-2026-0726，读取到期事项台账 5 项（只读）" } },
              { op: "toolbar", view: "audit", title: "本轮巡检的系统动作", sub: "1 条" },
            ],
          },
        },
        {
          id: "d1-result",
          kind: "tool_result",
          title: "DeadlineScan 结果",
          defaultOpen: false,
          toolName: "DeadlineScan",
          toolId: "t-scan",
          content: "batch=WATCH-2026-0726 items=5 warning=3 carryover=0",
        },
        {
          id: "d1-text",
          kind: "text",
          title: "业务进展",
          defaultOpen: true,
          content: "台账拉齐了：5 项在办，3 项掉进 10 天预警区，最紧的社保申报只剩 2 天。接下来我先逐项看材料齐不齐——**缺件的绝不硬提交**，报错退回比压着不报更难收拾，尤其是征期内只能报一次的那几项。",
        },
      ],
    },

    {
      caption: "逐项核材料齐套",
      blocks: [
        {
          id: "d2-tool",
          kind: "tool_use",
          title: "MaterialCheck",
          defaultOpen: true,
          toolName: "MaterialCheck",
          toolId: "t-material",
          content: JSON.stringify({ batch: "WATCH-2026-0726", items: 5 }),
          executionStatus: "completed",
          durationMs: 2260,
          presentation: {
            title: "按各事项的必备件清单核对齐套",
            detail: [
              { verdict: "pass", text: "社保公积金申报", note: "人员增减表（3 增 1 减）、缴费基数表已复核 → 齐套" },
              { verdict: "pass", text: "出口退税申报", note: "报关单 12 票、增值税专票 9 张、收汇核销 12 笔逐笔匹配 → 齐套" },
              { verdict: "pass", text: "专利年费 ZL201820447153", note: "缴费信息表、专利登记簿副本齐备 → 齐套" },
              { verdict: "warn", text: "客户框架合同续签", note: "材料齐套，但续签口径与用印须有权人拍板 → 转审批门禁" },
              { verdict: "fail", text: "高新企业年度报表", note: "2026 上半年研发费用辅助账尚未结转，导不出 → 缺件，不提交" },
              { insight: "齐套 3 项直接提交；1 项转人审；1 项宁可挂着也不用估算数凑报表", label: "结论" },
            ],
            status: "warn",
            panel: [
              { op: "focus", view: "ledger" },
              { op: "toolbar", view: "ledger", title: "到期事项台账 · 材料齐套核验", sub: "齐套 3 · 转审批 1 · 缺件 1" },
              { op: "tableRowUpdate", view: "ledger", id: "it-social", set: { cells: { item: "社保公积金申报 · SI-2026-07", due: "2026-07-28", left: "2 天", state: "齐套" }, tone: "pass" } },
              { op: "cellFlag", view: "ledger", rowId: "it-social", colKey: "state", tone: "pass", flag: "可提交" },
              { op: "tableRowUpdate", view: "ledger", id: "it-tax", set: { cells: { item: "出口退税申报 · TR-2026-06", due: "2026-07-31", left: "5 天", state: "齐套" }, tone: "pass" } },
              { op: "cellFlag", view: "ledger", rowId: "it-tax", colKey: "state", tone: "pass", flag: "可提交" },
              { op: "tableRowUpdate", view: "ledger", id: "it-patent", set: { cells: { item: "专利年费（第 7 年） · ZL201820447153", due: "2026-08-03", left: "8 天", state: "齐套" }, tone: "pass" } },
              { op: "cellFlag", view: "ledger", rowId: "it-patent", colKey: "state", tone: "pass", flag: "可提交" },
              { op: "tableRowUpdate", view: "ledger", id: "it-contract", set: { cells: { item: "客户框架合同续签 · HT-2023-0918", due: "2026-08-01 前发函", left: "6 天", state: "待人拍板" }, tone: "pending" } },
              { op: "cellFlag", view: "ledger", rowId: "it-contract", colKey: "state", tone: "warn", flag: "转审批" },
              { op: "tableRowUpdate", view: "ledger", id: "it-hitech", set: { cells: { item: "高新企业年度发展情况报表 · GR202435001188", due: "2026-08-31", left: "36 天", state: "缺研发费用辅助账" }, tone: "deny" } },
              { op: "cellFlag", view: "ledger", rowId: "it-hitech", colKey: "state", tone: "deny", flag: "缺件" },
              { op: "feedAppend", view: "audit", item: { id: "aw-2", from: "AI 同事", time: "07:00:35", text: "核对 5 项必备件清单：齐套 3 · 转审批 1 · 缺件 1，缺件项不进入提交队列" } },
              { op: "toolbar", view: "audit", title: "本轮巡检的系统动作", sub: "2 条" },
            ],
          },
        },
        {
          id: "d2-text",
          kind: "text",
          title: "业务进展",
          defaultOpen: true,
          content: [
            "3 项可以直接走提交，另外两项卡在完全不同的地方：",
            "",
            "1. 合同续签卡在**人**——账期怎么谈、章由谁用，这不是材料问题，我不替你定；",
            "2. 高新年报卡在**上游数据**——财务共享中心 6 月还没结转，辅助账系统里根本导不出来，凑一份估算数交上去比晚交更危险。",
            "",
            "这两项我都不往前推，后面单独安排人和复查时间。",
          ].join("\n"),
        },
      ],
    },

    {
      caption: "齐套项按批准渠道提交",
      blocks: [
        {
          id: "d3-tool",
          kind: "tool_use",
          title: "FilingSubmit",
          defaultOpen: true,
          toolName: "FilingSubmit",
          toolId: "t-submit",
          content: JSON.stringify({ batch: "WATCH-2026-0726", items: ["SI-2026-07", "ZL201820447153", "TR-2026-06"] }),
          executionStatus: "completed",
          durationMs: 4180,
          presentation: {
            title: "提交 3 项齐套事项",
            detail: [
              { k: "提交项", v: "3 项 · 各走本事项的既定报送渠道" },
              { tree: "├", k: "社保公积金", v: "电子税务局社保模块 · 受理号 SI-20260726-004173 · 318,470.26 元" },
              { tree: "├", k: "专利年费", v: "专利事务代理缴费通道 · 缴费通知书 CN-2026-0726-0083 · 2,000 元" },
              { tree: "└", k: "出口退税", v: "电子税务局退税申报 · 流水号 SB2026072600317 · 受理回执待返" },
            ],
            status: "ok",
            receipt: { id: "SI-20260726-004173", system: "电子税务局 · 社保申报", readBack: true },
            panel: [
              { op: "focus", view: "filing" },
              { op: "toolbar", view: "filing", title: "提交与回执追踪 · WATCH-2026-0726", sub: "已提交 3 · 已回执 2" },
              { op: "tableRowInsert", view: "filing", row: { id: "fl-social", cells: { item: "社保公积金申报", channel: "电子税务局 · 社保模块", ticket: "SI-20260726-004173", receipt: "已受理" }, tone: "pass", flags: { receipt: { tone: "pass", flag: "已回执" } } } },
              { op: "tableRowInsert", view: "filing", row: { id: "fl-patent", cells: { item: "专利年费（第 7 年）", channel: "专利事务代理缴费通道", ticket: "CN-2026-0726-0083", receipt: "缴费通知书已出" }, tone: "pass", flags: { receipt: { tone: "pass", flag: "已回执" } } } },
              { op: "tableRowInsert", view: "filing", row: { id: "fl-tax", cells: { item: "出口退税申报", channel: "电子税务局 · 退税申报", ticket: "SB2026072600317", receipt: "待返" }, tone: "pending", flags: { receipt: { tone: "pending", flag: "待回执" } } } },
              { op: "tableRowUpdate", view: "ledger", id: "it-social", set: { cells: { item: "社保公积金申报 · SI-2026-07", due: "2026-07-28", left: "2 天", state: "已办结" }, tone: "pass" } },
              { op: "cellFlag", view: "ledger", rowId: "it-social", colKey: "state", tone: "pass", flag: "凭回执" },
              { op: "tableRowUpdate", view: "ledger", id: "it-patent", set: { cells: { item: "专利年费（第 7 年） · ZL201820447153", due: "2026-08-03", left: "8 天", state: "已办结" }, tone: "pass" } },
              { op: "cellFlag", view: "ledger", rowId: "it-patent", colKey: "state", tone: "pass", flag: "凭回执" },
              { op: "tableRowUpdate", view: "ledger", id: "it-tax", set: { cells: { item: "出口退税申报 · TR-2026-06", due: "2026-07-31", left: "5 天", state: "已提交" }, tone: "pending" } },
              { op: "cellFlag", view: "ledger", rowId: "it-tax", colKey: "state", tone: "pending", flag: "未确认" },
              { op: "feedAppend", view: "audit", item: { id: "aw-3", from: "AI 同事", time: "07:02:14", text: "提交 3 项申报；社保与专利年费回读受理编号与金额一致，出口退税仅返回流水号" } },
              { op: "toolbar", view: "audit", title: "本轮巡检的系统动作", sub: "3 条" },
            ],
          },
        },
        {
          id: "d3-result",
          kind: "tool_result",
          title: "FilingSubmit 结果",
          defaultOpen: false,
          toolName: "FilingSubmit",
          toolId: "t-submit",
          content: "submitted=3 accepted=2 pending_receipt=1\nSI-2026-07 -> SI-20260726-004173 (accepted)\nZL201820447153 -> CN-2026-0726-0083 (accepted)\nTR-2026-06 -> SB2026072600317 (submitted, no receipt)",
        },
        {
          id: "d3-text",
          kind: "text",
          title: "业务进展",
          defaultOpen: true,
          content: [
            "社保和专利年费这两项，平台当场就把受理编号返回来了，我按编号回查了一遍，人数、金额、所属期都对得上，可以算办结。",
            "",
            "出口退税那一笔不一样：它只回了 **SB2026072600317**，这是申报流水号，只证明报文送达了。能证明税局受理的是《出口退税申报受理通知书》，那份还没出。486,230.50 元、12 票报关单，这一项我先不动它的状态。",
          ].join("\n"),
        },
      ],
    },

    {
      caption: "回执没到就不写完成",
      blocks: [
        {
          id: "d4-tool",
          kind: "tool_use",
          title: "ReceiptPoll",
          defaultOpen: true,
          toolName: "ReceiptPoll",
          toolId: "t-poll",
          content: JSON.stringify({ item: "TR-2026-06", flowNo: "SB2026072600317", attempts: 3 }),
          executionStatus: "completed",
          durationMs: 1560,
          presentation: {
            title: "追踪出口退税受理回执",
            detail: [
              { k: "追踪事项", v: "出口退税申报 TR-2026-06 · 486,230.50 元" },
              { k: "已提交", v: "07:02:14 · 流水号 SB2026072600317" },
              { k: "轮询", v: "3 次（07:12 / 08:00 / 09:00）· 均未取得受理通知书" },
              { tree: "├", k: "平台状态", v: "批量核定中，《出口退税申报受理通知书》未生成" },
              { tree: "└", k: "本项判定", v: "已提交 · 未确认 —— 不计入已办结，不写入台账完成态" },
            ],
            status: "waiting",
            panel: [
              { op: "focus", view: "filing" },
              { op: "toolbar", view: "filing", title: "提交与回执追踪 · WATCH-2026-0726", sub: "已提交 3 · 已回执 2 · 等待 1" },
              { op: "tableRowUpdate", view: "filing", id: "fl-tax", set: { cells: { item: "出口退税申报", channel: "电子税务局 · 退税申报", ticket: "SB2026072600317", receipt: "轮询 3 次 · 仍未返回" }, tone: "pending", flags: { receipt: { tone: "warn", flag: "已提交·未确认" } } } },
              { op: "pulse", view: "filing", ids: ["fl-tax"], kind: "hit" },
              { op: "tableRowUpdate", view: "ledger", id: "it-tax", set: { cells: { item: "出口退税申报 · TR-2026-06", due: "2026-07-31", left: "5 天", state: "已提交 · 未确认" }, tone: "warn" } },
              { op: "cellFlag", view: "ledger", rowId: "it-tax", colKey: "state", tone: "warn", flag: "不计办结" },
              { op: "feedAppend", view: "audit", item: {
                id: "aw-4",
                from: "AI 同事",
                time: "09:00:06",
                text: "出口退税回执第 3 次轮询仍为空，状态保持「已提交 · 未确认」，未写入任何完成标记",
                card: { title: "拒绝把提交写成办结", body: "证据只有申报流水号，缺《出口退税申报受理通知书》；复查已排 14:00 与次日 07:00", meta: [{ text: "未标完成", tone: "pass" }, { text: "已挂复查", tone: "info" }] },
              } },
              { op: "toolbar", view: "audit", title: "本轮巡检的系统动作", sub: "4 条" },
            ],
          },
        },
        {
          id: "d4-text",
          kind: "text",
          title: "为什么停在这里",
          defaultOpen: true,
          content: [
            "这一项我停住，不往下写。",
            "",
            "**提交成功不等于办成**。我手上只有报文送达的流水号，主管机关那份受理通知书没出来，我就没有任何凭据说这笔退税报进去了。**没有回执，我不会把它标成已完成**——台账上它就是「已提交 · 未确认」，右侧那一行也不会变绿。",
            "",
            "距申报期截止只剩 5 天（2026-07-31）。复查我已经排进去了：今天 14:00、明天 07:00 各查一次；到 07-28 17:00 还拿不到回执，我不再等系统，直接转人工去办税服务厅当面确认——留 3 天足够重报一次。",
          ].join("\n"),
        },
      ],
    },

    {
      caption: "续签口径与用印交人拍板",
      blocks: [],
      approval: {
        title: "客户框架合同续签 · 需有权人确认口径并用印",
        description: "确认后才会用印并向对方发出续签函。续签口径与用印都构成对外承诺，AI 不代拍、不代章。",
        facts: [
          { label: "合同", value: "HT-2023-0918 · Vestholm Industri AB（瑞典）" },
          { label: "时限", value: "须于 2026-08-01 前发出续签函（剩 6 天）" },
          { label: "AI 拟定口径", value: "年度框架额度 240 万元 · 付款账期 90 天" },
          { label: "拟定依据", value: "对方 2026-06-18 邮件提出账期诉求" },
          { label: "用印", value: "合同专用章 · 续签函 1 份" },
        ],
        approveLabel: "确认口径并用印",
        rejectLabel: "退回重拟",
        approvedBlocks: [
          {
            id: "d5-human",
            kind: "prompt",
            title: "用户消息",
            defaultOpen: true,
            content: "账期不能放到 90 天，按原合同 60 天不变——他们 6 月那封邮件是试探。额度先报 200 万，谈得下来再加。另外补一条汇率条款：欧元兑人民币跌破 7.40 双方重谈价格。这三处改完可以用印。",
          },
          {
            id: "d5-tool",
            kind: "tool_use",
            title: "Approval",
            defaultOpen: true,
            toolName: "Approval",
            toolId: "t-approve",
            content: JSON.stringify({ contract: "HT-2023-0918", decision: "approved", seal: true }),
            executionStatus: "completed",
            durationMs: 380,
            presentation: {
              title: "用印已确认 · 含人工修改 2 项、新增 1 项",
              detail: [
                { k: "审批结果", v: "确认口径并用印" },
                { k: "人工采纳", v: "续签主体、有效期一年、交货条款照旧" },
                { k: "人工修改", v: "账期 90 天 → 60 天；框架额度 240 万 → 200 万元" },
                { tree: "├", k: "人工新增", v: "汇率条款：欧元兑人民币跌破 7.40 触发价格重谈" },
                { tree: "└", k: "留痕", v: "AI 原拟口径与三处改动逐条留档，用印记录可回溯" },
              ],
              status: "ok",
              receipt: { id: "OA-SEAL-2026-0774", system: "OA 用印审批", readBack: true },
              panel: [
                { op: "focus", view: "ledger" },
                { op: "tableRowUpdate", view: "ledger", id: "it-contract", set: { cells: { item: "客户框架合同续签 · HT-2023-0918", due: "2026-08-01 前发函", left: "6 天", state: "已用印 · 待签回" }, tone: "pending" } },
                { op: "cellFlag", view: "ledger", rowId: "it-contract", colKey: "state", tone: "warn", flag: "待对方签回" },
                { op: "tableRowInsert", view: "filing", row: { id: "fl-contract", cells: { item: "客户框架合同续签函", channel: "OA 用印 → EMS 寄出", ticket: "OA-SEAL-2026-0774 / EA283916477CN", receipt: "待对方签回" }, tone: "pending", flags: { receipt: { tone: "warn", flag: "已提交·未确认" } } } },
                { op: "toolbar", view: "filing", title: "提交与回执追踪 · WATCH-2026-0726", sub: "已提交 4 · 已回执 2 · 等待 2" },
                { op: "feedAppend", view: "audit", item: {
                  id: "aw-5",
                  from: "外贸部负责人",
                  time: "09:36:41",
                  text: "确认用印：采纳 3 项、修改 2 项（账期 90→60 天、额度 240→200 万）、新增汇率条款 1 条",
                  card: { title: "人审记录", body: "采纳 3 · 修改 2 · 新增 1 · AI 自行发函 0", meta: [{ text: "AI 未代章", tone: "pass" }, { text: "口径以人为准", tone: "info" }] },
                } },
                { op: "toolbar", view: "audit", title: "本轮巡检的系统动作", sub: "5 条" },
              ],
            },
          },
          {
            id: "d5-text",
            kind: "text",
            title: "审批结果",
            defaultOpen: true,
            content: "三处改动全按你的原话落进续签函：账期回到 60 天、额度改 200 万、汇率条款补进第 7 条，我原来那版只留在留痕里作对照。用印单 OA-SEAL-2026-0774 已回读核对，函件今天下午 EMS 寄出（EA283916477CN）。对方签回之前，这一项同样不写「已完成」。",
          },
        ],
        rejectedBlocks: [
          {
            id: "d5-rejected-tool",
            kind: "tool_use",
            title: "Approval",
            defaultOpen: true,
            toolName: "Approval",
            toolId: "t-reject",
            content: JSON.stringify({ contract: "HT-2023-0918", decision: "rejected" }),
            executionStatus: "completed",
            durationMs: 300,
            presentation: {
              title: "续签口径被退回 · 未用印、未发函",
              detail: [
                { k: "审批结果", v: "退回重拟" },
                { k: "用印", v: "未用印，OA 用印单已作废" },
                { k: "对外动作", v: "续签函未生成、未寄出，对方未收到任何文件" },
                { tree: "├", k: "合同状态", v: "保持「待续签」，台账无写入" },
                { tree: "└", k: "留痕", v: "退回时间、退回人与当时拟定口径已归档" },
              ],
              status: "blocked",
              panel: [
                { op: "focus", view: "ledger" },
                { op: "tableRowUpdate", view: "ledger", id: "it-contract", set: { cells: { item: "客户框架合同续签 · HT-2023-0918", due: "2026-08-01 前发函", left: "6 天", state: "退回重拟" }, tone: "warn" } },
                { op: "cellFlag", view: "ledger", rowId: "it-contract", colKey: "state", tone: "deny", flag: "未提交" },
                { op: "feedAppend", view: "notify", item: {
                  id: "nt-reject",
                  from: "AI 同事",
                  time: "09:36:41",
                  text: "续签口径被退回，明早 07:00 巡检会重新推送这一项",
                  card: { title: "续签函未发出", body: "发函时限 2026-08-01，剩 6 天；口径改定后需再次用印审批", meta: [{ text: "未用印", tone: "pass" }, { text: "退回已记账", tone: "info" }] },
                } },
                { op: "toolbar", view: "notify", title: "已发出的通知", sub: "1 条" },
                { op: "feedAppend", view: "audit", item: { id: "aw-5r", from: "外贸部负责人", time: "09:36:41", text: "续签口径退回重拟：未用印、未生成续签函、台账无写入" } },
                { op: "toolbar", view: "audit", title: "本轮巡检的系统动作", sub: "5 条" },
              ],
            },
          },
          {
            id: "d5-rejected-text",
            kind: "text",
            title: "退回说明",
            defaultOpen: true,
            content: "已停在用印前一步：章没有用，续签函没有生成，对方那边什么都没收到。退回记录进了留痕，我那版口径也留着，方便你对着改。发函时限是 2026-08-01，还剩 6 天——明早 07:00 的巡检会把这一项重新推给你，改定后仍要再走一次这道门。",
          },
        ],
      },
    },

    {
      caption: "临期未结的升级到人",
      blocks: [
        {
          id: "d6-tool",
          kind: "tool_use",
          title: "EscalationNotify",
          defaultOpen: true,
          toolName: "EscalationNotify",
          toolId: "t-escalate",
          content: JSON.stringify({ batch: "WATCH-2026-0726", escalate: ["TR-2026-06", "GR202435001188"] }),
          executionStatus: "completed",
          durationMs: 1140,
          presentation: {
            title: "升级 2 项并写入复查排程",
            detail: [
              { k: "升级项", v: "2 项 · 均已指派到人并锁定复查时间" },
              { tree: "├", k: "出口退税 TR-2026-06", v: "关务主管 + 财务负责人 · 复查 14:00 与次日 07:00" },
              { tree: "├", k: "高新年报 GR202435001188", v: "研发管理岗 + 财务共享中心 · 07-29 前提供辅助账" },
              { tree: "└", k: "兜底动作", v: "07-28 17:00 无退税回执转办税服务厅人工确认" },
            ],
            status: "warn",
            panel: [
              { op: "focus", view: "notify" },
              { op: "toolbar", view: "notify", title: "已发出的通知", sub: "2 条 · 均带复查时间" },
              { op: "feedAppend", view: "notify", item: {
                id: "nt-tax",
                from: "AI 同事",
                time: "09:41:20",
                text: "@关务主管 @财务负责人 出口退税 TR-2026-06 已提交但未取得受理回执，申报期 07-31 截止。",
                card: { title: "出口退税 · 已提交未确认", body: "流水号 SB2026072600317 · 486,230.50 元 · 12 票报关单；复查 07-26 14:00 / 07-27 07:00；07-28 17:00 仍无回执转人工窗口", meta: [{ text: "剩 5 天", tone: "warn" }, { text: "已指派", tone: "info" }] },
              } },
              { op: "feedAppend", view: "notify", item: {
                id: "nt-hitech",
                from: "AI 同事",
                time: "09:41:26",
                text: "@研发管理岗 @财务共享中心 高新年度报表缺 2026 上半年研发费用辅助账，请于 07-29 前导出。",
                card: { title: "高新年报 · 未提交缺件", body: "GR202435001188 · 时限 08-31；材料到位后当轮巡检自动续办，复查点 07-29 07:00", meta: [{ text: "剩 36 天", tone: "info" }, { text: "已指派", tone: "info" }] },
              } },
              { op: "tableRowUpdate", view: "ledger", id: "it-hitech", set: { cells: { item: "高新企业年度发展情况报表 · GR202435001188", due: "2026-08-31", left: "36 天", state: "缺件 · 已指派" }, tone: "warn" } },
              { op: "cellFlag", view: "ledger", rowId: "it-hitech", colKey: "state", tone: "warn", flag: "07-29 复查" },
              { op: "cellFlag", view: "ledger", rowId: "it-tax", colKey: "left", tone: "warn", flag: "已升级" },
              { op: "feedAppend", view: "audit", item: { id: "aw-6", from: "AI 同事", time: "09:41:30", text: "发出 2 条升级通知并写入 3 个复查时点；兜底转人工规则已挂载" } },
              { op: "toolbar", view: "audit", title: "本轮巡检的系统动作", sub: "6 条" },
            ],
          },
        },
        {
          id: "d6-text",
          kind: "text",
          title: "业务进展",
          defaultOpen: true,
          content: [
            "两项都指了人、定了时间，不是发条消息就算交待过去了。",
            "",
            "退税那笔的兜底写死在排程里：07-28 17:00 我再查一次，还拿不到受理通知书就不再等系统，直接提醒关务主管去窗口当面确认。高新年报的辅助账卡在 6 月结转，复查点定在 07-29 07:00——时限 08-31 看着还远，但辅助账补不齐，8 月底照样交不上。",
          ].join("\n"),
        },
      ],
    },

    {
      caption: "生成台账巡检日报",
      blocks: [
        {
          id: "d7-tool",
          kind: "tool_use",
          title: "Write",
          defaultOpen: true,
          toolName: "Write",
          toolId: "t-report",
          content: JSON.stringify({ file_path: WATCH_REPORT_PATH }),
          executionStatus: "completed",
          durationMs: 1480,
          presentation: {
            title: "生成到期事项台账与巡检日报",
            detail: [
              { k: "产物", v: "到期事项巡检日报（HTML · 自包含）" },
              { k: "覆盖事项", v: "5 项 · 材料 / 提交 / 回执三段状态分列" },
              { tree: "├", k: "已确认办结", v: "2 项，均凭主管机关编号" },
              { tree: "└", k: "未确认或未提交", v: "3 项，逐项写明卡点与下次动作" },
            ],
            status: "ok",
            panel: [
              { op: "focus", view: "audit" },
              { op: "feedAppend", view: "audit", item: {
                id: "aw-7",
                from: "AI 同事",
                time: "09:42:05",
                text: "生成巡检日报并抄送财务负责人、关务主管",
                card: { title: "巡检日报已生成", body: "回执状态独立成列：已提交 ≠ 已办结，两者在台账、日报、通知三处口径一致", meta: [{ text: "办结 2", tone: "pass" }, { text: "未确认 2", tone: "warn" }, { text: "未提交 1", tone: "deny" }] },
              } },
              { op: "toolbar", view: "audit", title: "本轮巡检的系统动作", sub: "7 条" },
              { op: "feedAppend", view: "notify", item: { id: "nt-report", from: "AI 同事", time: "09:42:08", text: "巡检日报已抄送财务负责人、关务主管；明早 07:00 在同一份台账上续写" } },
              { op: "toolbar", view: "notify", title: "已发出的通知", sub: "3 条" },
            ],
          },
        },
        {
          id: "d7-text",
          kind: "text",
          title: "回复",
          defaultOpen: true,
          content: [
            "日报出来了。它跟一般台账最大的差别是**回执单独占一列**——谁真办完了、谁只是把东西发出去了，一眼分得清：",
            "",
            `[FILE]{"filePath":"${WATCH_REPORT_PATH}","fileName":"到期事项巡检日报.html","fileSize":${WATCH_REPORT_SIZE_BYTES}}[/FILE]`,
            "",
            "已抄送财务负责人和关务主管。明早 07:00 那一轮会在同一份台账上续写，不会另起一张表，未结的三项会带着今天的卡点直接接上。",
          ].join("\n"),
        },
      ],
    },

    {
      caption: "回读终态并交账",
      blocks: [
        {
          id: "d8-tool",
          kind: "tool_use",
          title: "LedgerReadBack",
          defaultOpen: true,
          toolName: "LedgerReadBack",
          toolId: "t-readback",
          content: JSON.stringify({ batch: "WATCH-2026-0726" }),
          executionStatus: "completed",
          durationMs: 1220,
          presentation: {
            title: "回读四处记录，核对口径是否一致",
            detail: [
              { k: "回读范围", v: "到期台账 / 申报平台 / OA 用印 / 通知记录" },
              { verdict: "pass", text: "已确认办结 2 项", note: "均按受理编号回查金额与所属期一致" },
              { verdict: "pending", text: "已提交未确认 2 项", note: "出口退税受理回执、续签函对方签回" },
              { verdict: "fail", text: "未提交 1 项", note: "高新年报缺件，已指派并排定复查" },
              { verdict: "pass", text: "口径一致性", note: "台账 / 日报 / 通知三处对未结项的表述完全一致" },
              { insight: "已提交 ≠ 已办结：没有回执的一律不记完成", label: "结论" },
            ],
            status: "warn",
            panel: [
              { op: "focus", view: "ledger" },
              { op: "toolbar", view: "ledger", title: "到期事项台账 · 批次终态", sub: "办结 2 · 未确认 2 · 未提交 1" },
              { op: "feedAppend", view: "audit", item: { id: "aw-8", from: "AI 同事", time: "09:42:30", text: "回读台账 / 申报平台 / OA 用印 / 通知记录，四处状态一致；批次 WATCH-2026-0726 结束，3 项转入明日续办" } },
              { op: "toolbar", view: "audit", title: "本轮巡检的系统动作", sub: "8 条" },
            ],
          },
        },
        {
          id: "d8-text",
          kind: "text",
          title: "本次巡检改变了什么",
          defaultOpen: true,
          content: [
            "## 本次巡检改变了什么",
            "",
            "| 事项 | 终态 | 依据 |",
            "| --- | --- | --- |",
            "| 社保公积金申报 SI-2026-07 | 已办结 | 受理号 SI-20260726-004173，318,470.26 元回读一致 |",
            "| 专利年费 ZL201820447153 | 已办结 | 缴费通知书 CN-2026-0726-0083，第 7 年 2,000 元已缴 |",
            "| 出口退税申报 TR-2026-06 | 已提交 · 未确认 | 仅有流水号 SB2026072600317，受理通知书未出 |",
            "| 客户框架合同续签 HT-2023-0918 | 已用印 · 待对方签回 | 用印单 OA-SEAL-2026-0774，EMS EA283916477CN |",
            "| 高新企业年度报表 GR202435001188 | 未提交 · 缺件 | 研发费用辅助账未结转，已指派并排 07-29 复查 |",
            "",
            "## 本次巡检没有做什么",
            "",
            "- 没有把未回执的写成已完成：出口退税和续签函都只记「已提交」，台账、日报、通知三处口径一致；",
            "- 没有替人用印：合同专用章由有权人在 OA 里确认后才动，AI 全程不持章、不代发函；",
            "- 没有越权提交：高新年报缺研发费用辅助账，宁可挂着也不用估算数凑一份报表报上去；",
            "- 没有改动人拍板的口径：账期 60 天、额度 200 万、汇率条款三处以人的原话为准，我原拟的版本只作留痕对照；",
            "- 没有关掉任何一项：3 项未结全部带责任人和复查时点转入 2026-07-27 07:00 那一轮。",
          ].join("\n"),
        },
      ],
    },
  ],

  // 治理条款：state != exists 的条目就是「演示到真实」的距离。
  // 这条场景最贵的不是巡检逻辑，而是对外提交与回执抓取——那一段今天完全不存在。
  sources: [
    {
      blockRef: "step1.trigger.CronJob",
      producer: "定时任务调度器（server/src/cron）",
      state: "needs-change",
      gap: "按 cron 表达式定点发起 Agent 会话的能力已经有（executor 直接 runAgent），但定时会话不产出 presentation / panelBase，右侧面板全空；且没有「批次事项」这种跨轮次状态载体——等回执、超时升级、明日续办目前只能靠 Agent 每轮重读上下文自己推断",
    },
    {
      blockRef: "step1.tool.DeadlineScan",
      producer: "到期事项台账连接器",
      state: "missing",
      gap: "到期台账本身不在产品内，事项散在 ERP、合同系统、知识产权代理平台、税务台账各处；今天只能读客户手工导出的表格，且没有「法定时限 / 剩余天数 / 预警区」的结构化字段",
    },
    {
      blockRef: "step2.tool.MaterialCheck",
      producer: "必备件清单校验器",
      state: "missing",
      gap: "每类事项要哪些附件、附件由哪个系统出、什么算「齐套」，没有可版本化的清单，现在全靠 Agent 临场推理；判断「6 月研发费用是否已结转」还要读财务共享中心，无连接器",
    },
    {
      blockRef: "step3.tool.FilingSubmit",
      producer: "对外申报提交连接器",
      state: "missing",
      gap: "电子税务局、社保申报平台、专利缴费通道这类对外提交连接器一个都没有。对外提交是不可撤回动作，落地前还需要提交前置确认、幂等键、失败重报窗口这三件套，产品里均不存在",
    },
    {
      blockRef: "step4.tool.ReceiptPoll",
      producer: "回执抓取与轮询器",
      state: "missing",
      gap: "受理通知书 / 缴费通知书的抓取没有连接器；更要紧的是 ToolReceipt 只有 id / system / readBack，缺「已提交但未确认」这个中间态字段，waiting 状态今天只能靠 status 表达，无法结构化落库供下一轮巡检续查",
    },
    {
      blockRef: "step5.tool.Approval",
      producer: "业务审批执行器 + OA 用印集成",
      state: "needs-change",
      gap: "HITL 审批事件 runtime 已成对记录，但「人改了哪一条口径」没有结构化字段，只能落自由文本；用印环节还需接 OA 用印审批（含印章类型、用印份数），该连接器不存在",
    },
    {
      blockRef: "step6.tool.EscalationNotify",
      producer: "升级策略引擎 + 通知渠道（DWS）",
      state: "needs-change",
      gap: "排下次复查可以复用 CronJob，钉钉群 / 工作通知可以走 DWS，但「多久没回执升级给谁、升几级、兜底转人工」这套事项级策略没有配置载体，现在只能写死在提示词里",
    },
    {
      blockRef: "step7.tool.Write",
      producer: "Write 工具执行器",
      state: "needs-change",
      gap: "写文件本身已有，但不产出 presentation；产物摘要、抄送记录与留痕 feed 需由执行器统一补一层",
    },
    {
      blockRef: "step8.tool.LedgerReadBack",
      producer: "事项终态回读器",
      state: "missing",
      gap: "跨系统回读要先有各系统连接器；在此之前「台账 / 日报 / 通知三处口径一致」只能靠 Agent 自查，没有机器可验的一致性断言",
    },
    {
      blockRef: "step7.artifact.到期事项巡检日报",
      producer: "Agent 生成 HTML 产物",
      state: "exists",
    },
  ],
};

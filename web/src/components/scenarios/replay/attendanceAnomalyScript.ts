import type { SystemPanelSnapshot } from "@agent/shared";
import { demoWorldFixture } from "./demoWorldFixture";
import type { ReplayScript } from "./types";

/**
 * 钩子场景：今天考勤有什么异常需要我处理。
 *
 * 岗位视角是人事 林悦。核心不是「把异常都找出来」，而是**把大多数假异常对平掉**，
 * 只把真需要人判断的两件交上去——判断力在于敢说「这 24 条不用你看」。
 *
 * 四要素：
 *   ① 主动拒绝——第 4 步要病假原因明细被拦，给最小必要的替代路径；
 *   ② 视角切换——第 5 步产物后半页就是主管与员工屏幕上会看到的原文；
 *   ③ 跨系统核对——第 7 步把考勤 / 待办 / 企业 IM / 审批流四方终态摆在一起；
 *   ④ 可下载产物——《今日考勤异常处理单》HTML，右侧预览 + 本地下载。
 * 外加：人改掉 AI 的一项（群发改私发）并被记账，退回不是死路。
 *
 * 内容为示例数据，不对应任何真实企业、员工或考勤记录。
 */

const HANDLE_SHEET_PATH = "assets/demo/今日考勤异常处理单.html";

const HANDLE_SHEET_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<style>
  :root { --brand: #2E56E1; --ink: #0f172a; --muted: #64748b; --line: #e2e8f0; --ok: #15803d; --warn: #b45309; --deny: #b91c1c; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 20px; font: 14px/1.7 "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; color: var(--ink); background: #fff; }
  .bar { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border: 1px solid var(--line); border-radius: 6px; background: #f8fafc; color: var(--muted); font-size: 12px; margin-bottom: 16px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #cbd5e1; }
  h1 { margin: 0 0 4px; font-size: 16px; }
  .sub { margin: 0 0 16px; color: var(--muted); font-size: 12px; }
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 16px; }
  .stat { border: 1px solid var(--line); border-radius: 8px; padding: 10px; }
  .stat b { display: block; font-size: 20px; line-height: 1.2; }
  .stat span { color: var(--muted); font-size: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 14px; }
  th, td { border: 1px solid var(--line); padding: 7px 10px; text-align: left; vertical-align: top; }
  th { background: #f8fafc; color: var(--muted); font-weight: 500; }
  .ok { color: var(--ok); font-weight: 600; }
  .warn { color: var(--warn); font-weight: 600; }
  .deny { color: var(--deny); font-weight: 600; }
  .box { border: 1px solid var(--line); border-radius: 8px; padding: 12px; margin-bottom: 12px; }
  .box h2 { margin: 0 0 8px; font-size: 13px; }
  .screen { border: 1px solid var(--line); border-left: 3px solid var(--brand); border-radius: 6px; padding: 10px 12px; margin-bottom: 10px; background: #f8fafc; }
  .screen .who { color: var(--muted); font-size: 12px; margin-bottom: 6px; }
  .screen p { margin: 0 0 6px; font-size: 13px; }
  .foot { margin-top: 14px; color: var(--muted); font-size: 12px; }
</style></head><body>
<div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span>考勤系统 / 今日异常处理单 / ${demoWorldFixture.demoDate.iso}</span></div>

<h1>今日考勤异常处理单 · ${demoWorldFixture.demoDate.iso}</h1>
<p class="sub">澜达精密制造有限公司 · 人事 林悦 · 生成时间 09:06</p>

<div class="stats">
  <div class="stat"><b>318</b><span>今日应出勤</span></div>
  <div class="stat"><b>27</b><span>系统标记待确认</span></div>
  <div class="stat"><b class="ok">24</b><span>已自动对平</span></div>
  <div class="stat"><b class="warn">3</b><span>需人工判断</span></div>
</div>

<div class="box">
  <h2>一、需要你处理的（2 件）</h2>
  <table>
    <tr><th>对象</th><th>事实</th><th>为什么算异常</th><th>建议动作</th></tr>
    <tr>
      <td>注塑二组<br>工号 P-2318 / P-2407</td>
      <td>8-07、8-08、8-09 连续 3 天无打卡记录</td>
      <td class="deny">审批流内查无请假 / 调休 / 出差单据，工时也无补录；同组本周赶 ${demoWorldFixture.deliveryOrder.id} 交付</td>
      <td>今日 18:00 前由排班负责人核实原因，性质未核实前不定性</td>
    </tr>
    <tr>
      <td>装配一组<br>工号 Q-1156</td>
      <td>近 7 天累计加班 38.5 小时，连续出勤 12 天</td>
      <td class="warn">超公司自定的每周 36 小时加班上限 2.5 小时，属健康提醒级，非纪律问题</td>
      <td>本人私下提醒 + 本周内安排一天调休</td>
    </tr>
  </table>
</div>

<div class="box">
  <h2>二、已自动对平的 24 条（依据留档，无须逐条看）</h2>
  <table>
    <tr><th>类别</th><th>条数</th><th>对平依据</th></tr>
    <tr><td>迟到但在弹性内</td><td>11</td><td class="ok">全部在 8:34 前到岗，考勤制度为 8:30 上班 + 5 分钟弹性</td></tr>
    <tr><td>打卡缺失但有已批出差 / 外勤单</td><td>6</td><td class="ok">含销售 张明远 8-09 上午拜访海川机械，出差单 8-08 18:20 已批</td></tr>
    <tr><td>已批调休 / 年假</td><td>4</td><td class="ok">单据与考勤日期逐条对上</td></tr>
    <tr><td>车间门禁重复刷卡</td><td>3</td><td class="ok">同一人同一分钟两条记录，取首条</td></tr>
  </table>
</div>

<div class="box">
  <h2>三、待你确认后发出的两条原文（对方屏幕上的样子）</h2>
  <div class="screen">
    <div class="who">吴国栋 · 待办中心 · 收到时看到的卡片</div>
    <p><b>核实注塑二组连续缺勤（8-09 18:00 前回填）</b></p>
    <p>早班工号 P-2318、P-2407 于 8-07 至 ${demoWorldFixture.demoDate.short} 连续 3 天无打卡，审批流内无任何请假 / 调休 / 出差单据。该组本周承接 ${demoWorldFixture.deliveryOrder.id} 精密结构件赶工（${demoWorldFixture.deliveryOrder.promisedDeliveryDate} 交付，剩余 3,200 件），早班缺 2 人日产上限由 640 件降至 533 件。</p>
    <p>请核实两人实际情况并回填：① 是否已口头请假未补单；② 是否需要今日补员。缺勤性质以你核实结果为准，人事不预设结论。</p>
  </div>
  <div class="screen">
    <div class="who">工号 Q-1156 · 企业 IM 私聊 · 收到时看到的消息</div>
    <p>你好，人事这边看到你近 7 天累计加班 38.5 小时、连续出勤 12 天，已经超过公司每周 36 小时的上限。</p>
    <p>这条不是提醒你哪里做得不对，是提醒你歇一歇。本周内挑一天调休，需要协调排班的话告诉我，我来对接。</p>
  </div>
</div>

<p class="foot">本单据仅作核实依据，缺勤性质以主管核实结果为准。示例内容，不对应任何真实员工与考勤记录。</p>
</body></html>`;

const HANDLE_SHEET_SIZE_BYTES = new TextEncoder().encode(HANDLE_SHEET_HTML).length;

/** 面板底稿：考勤系统 / 审批流 / 待办中心 / 企业 IM / 权限矩阵 / 操作留痕 */
const PANEL_BASE: SystemPanelSnapshot = {
  title: "企业系统实况",
  live: true,
  activeView: "attendance",
  foot: "已连接：考勤系统 · 审批流 · 待办中心 · 企业 IM（演示）",
  views: [
    {
      key: "attendance",
      label: "考勤系统",
      winTitle: "考勤系统 · 今日异常",
      toolbar: { title: `考勤系统 · ${demoWorldFixture.demoDate.iso}`, sub: "尚未读取" },
      widget: {
        kind: "table",
        cols: [
          { key: "who", label: "人员" },
          { key: "dept", label: "部门 / 班次" },
          { key: "flag", label: "系统标记" },
          { key: "state", label: "分拣", align: "right" },
        ],
        rows: [],
        empty: { title: "尚未读取今日考勤" },
      },
    },
    {
      key: "approval",
      label: "审批流",
      winTitle: "审批流 · 请假 / 出差 / 调休单据",
      toolbar: { title: "审批流 · 对平依据", sub: "只读" },
      widget: { kind: "rows", rows: [], empty: { title: "尚未核对任何单据" } },
    },
    {
      key: "todo",
      label: "待办中心",
      winTitle: "待办中心 · 本次会话创建",
      toolbar: { title: "待办中心", sub: "0 条" },
      widget: { kind: "rows", rows: [], empty: { title: "尚未创建任何待办" } },
    },
    {
      key: "im",
      label: "企业 IM",
      winTitle: "企业 IM · 发送与送达",
      toolbar: { title: "企业 IM", sub: "尚未发出" },
      widget: { kind: "feed", items: [], empty: { title: "尚未发出任何消息" } },
    },
    {
      key: "rights",
      label: "权限矩阵",
      winTitle: "权限矩阵 · 人事岗可访问范围",
      toolbar: { title: "权限矩阵 · 由 IT 依岗位表维护", sub: "只读" },
      widget: {
        kind: "table",
        cols: [
          { key: "domain", label: "数据域" },
          { key: "grant", label: "本岗授权" },
          { key: "owner", label: "授权来源", align: "right" },
        ],
        rows: [],
        empty: { title: "尚未触达权限判定" },
      },
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

export const attendanceAnomalyScript: ReplayScript = {
  scenarioId: "catalog-hook-attendance-anomaly",
  title: "今天考勤有什么异常需要我处理",
  mode: "quick",
  artifacts: { [HANDLE_SHEET_PATH]: HANDLE_SHEET_HTML },

  steps: [
    {
      caption: "读取今日考勤",
      blocks: [
        {
          id: "a1-prompt",
          kind: "prompt",
          title: "用户消息",
          defaultOpen: true,
          content: "今天考勤有啥异常？",
        },
        {
          id: "a1-tool",
          kind: "tool_use",
          title: "AttendanceQuery",
          defaultOpen: true,
          toolName: "AttendanceQuery",
          toolId: "t-att",
          content: JSON.stringify({ date: demoWorldFixture.demoDate.iso, scope: "all" }),
          executionStatus: "completed",
          durationMs: 780,
          presentation: {
            title: "读取今日考勤记录",
            detail: [
              { k: "统计日期", v: `${demoWorldFixture.demoDate.iso}（周日排班日）` },
              { k: "应出勤", v: "318 人（在册 320，2 人产假）" },
              { tree: "├", k: "打卡完整", v: "291 人" },
              { tree: "└", k: "系统标记待确认", v: "27 条，尚未分拣" },
              "先拿审批流把能对平的对平掉，再挑真的给你。",
            ],
            status: "ok",
            panelBase: PANEL_BASE,
            panel: [
              { op: "focus", view: "attendance" },
              { op: "toolbar", view: "attendance", title: `考勤系统 · ${demoWorldFixture.demoDate.iso}`, sub: "27 条待分拣" },
              { op: "tableRowInsert", view: "attendance", row: { id: "at-2318", cells: { who: "工号 P-2318", dept: "注塑二组 · 早班", flag: "连续未打卡", state: "待分拣" } } },
              { op: "tableRowInsert", view: "attendance", row: { id: "at-2407", cells: { who: "工号 P-2407", dept: "注塑二组 · 早班", flag: "连续未打卡", state: "待分拣" } } },
              { op: "tableRowInsert", view: "attendance", row: { id: "at-zmy", cells: { who: "张明远", dept: "销售部 · 常白班", flag: "上午无打卡", state: "待分拣" } } },
              { op: "tableRowInsert", view: "attendance", row: { id: "at-1156", cells: { who: "工号 Q-1156", dept: "装配一组 · 两班倒", flag: "加班累计超阈", state: "待分拣" } } },
              { op: "tableRowInsert", view: "attendance", row: { id: "at-rest", cells: { who: "其余 23 条", dept: "全公司 9 个部门", flag: "迟到 / 重复刷卡 / 外勤偏差", state: "待分拣" } } },
              { op: "feedAppend", view: "audit", item: { id: "au-1", from: "AI 同事", time: "09:02:11", text: `读取 ${demoWorldFixture.demoDate.iso} 全公司考勤记录 318 条（只读）` } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "1 条" },
            ],
          },
        },
        {
          id: "a1-result",
          kind: "tool_result",
          title: "AttendanceQuery 结果",
          defaultOpen: false,
          toolName: "AttendanceQuery",
          toolId: "t-att",
          content: `date=${demoWorldFixture.demoDate.iso} due=318 complete=291 flagged=27`,
        },
        {
          id: "a1-text",
          kind: "text",
          title: "业务进展",
          defaultOpen: true,
          content:
            "今天应出勤 318 人，打卡完整 291 人，系统标记了 27 条待确认。这 27 条里绝大多数是制度内的正常情况，我逐条拿审批流对一遍，只把对不平的交给你。",
        },
      ],
    },

    {
      caption: "拿审批流对平，只留真的",
      blocks: [
        {
          id: "a2-tool",
          kind: "tool_use",
          title: "AnomalyTriage",
          defaultOpen: true,
          toolName: "AnomalyTriage",
          toolId: "t-triage",
          content: JSON.stringify({ date: demoWorldFixture.demoDate.iso, flagged: 27 }),
          executionStatus: "completed",
          durationMs: 1620,
          presentation: {
            title: "27 条标记逐条对平审批单据",
            detail: [
              { section: "自动对平 24 条" },
              { verdict: "pass", text: "迟到 11 条", note: "全部在 8:34 前到岗 · 制度为 8:30 上班 + 5 分钟弹性" },
              { verdict: "pass", text: "打卡缺失 6 条", note: "均有已批出差 / 外勤单 · 含张明远 8-09 上午拜访海川机械" },
              { verdict: "pass", text: "调休与年假 4 条", note: "单据日期与考勤日期逐条对上" },
              { verdict: "pass", text: "重复刷卡 3 条", note: "同一人同一分钟两条记录 · 取首条" },
              { section: "交给你判断 3 条" },
              { verdict: "fail", text: "注塑二组 P-2318 / P-2407", note: "8-07 至 8-09 连续 3 天无打卡 · 审批流内 0 条单据" },
              { verdict: "warn", text: "装配一组 Q-1156", note: "近 7 天加班 38.5 小时 · 超每周 36 小时上限 · 健康提醒级" },
              { insight: "真正要你动手的只有 2 件，其余 25 条我已经替你结掉", label: "结论" },
            ],
            status: "ok",
            panel: [
              { op: "focus", view: "approval" },
              { op: "toolbar", view: "approval", title: "审批流 · 对平依据", sub: "命中 21 条 · 查无 2 条" },
              { op: "rowsSet", view: "approval", rows: [
                { id: "ap-flex", text: "弹性到岗内 · 11 条", sub: "8:30 上班 + 5 分钟弹性，最晚到岗 8:34", tone: "pass", badge: { text: "已对平", tone: "pass" } },
                { id: "ap-travel", text: "出差 / 外勤已批 · 6 条", sub: "含张明远 8-09 上午拜访海川机械，出差单 8-08 18:20 已批", tone: "pass", state: "hit", badge: { text: "已对平", tone: "pass" } },
                { id: "ap-leave", text: "调休 / 年假已批 · 4 条", sub: "单据日期与考勤日期逐条对上", tone: "pass", badge: { text: "已对平", tone: "pass" } },
                { id: "ap-dup", text: "门禁重复刷卡 · 3 条", sub: "同一人同一分钟两条记录，取首条", tone: "pass", badge: { text: "已对平", tone: "pass" } },
                { id: "ap-none", text: "注塑二组 2 人 · 8-07 至 8-09", sub: "请假 / 调休 / 出差 / 补录，四类单据全部查无", tone: "warn", state: "hit", badge: { text: "查无单据", tone: "deny" } },
                { id: "ap-ot", text: "装配一组 Q-1156 · 加班已报备", sub: "单据合规，但累计时长超公司自定上限", tone: "pending", badge: { text: "提醒级", tone: "warn" } },
              ] },
              { op: "toolbar", view: "attendance", title: `考勤系统 · ${demoWorldFixture.demoDate.iso}`, sub: "自动对平 24 · 需人工 3" },
              { op: "tableRowUpdate", view: "attendance", id: "at-zmy", set: { cells: { state: "自动对平" }, tone: "pass" } },
              { op: "cellFlag", view: "attendance", rowId: "at-zmy", colKey: "state", tone: "pass", flag: "有出差单" },
              { op: "tableRowUpdate", view: "attendance", id: "at-rest", set: { cells: { state: "自动对平 23 条" }, tone: "pass" } },
              { op: "cellFlag", view: "attendance", rowId: "at-rest", colKey: "state", tone: "pass", flag: "制度内" },
              { op: "tableRowUpdate", view: "attendance", id: "at-2318", set: { cells: { state: "需你处理" }, tone: "warn" } },
              { op: "cellFlag", view: "attendance", rowId: "at-2318", colKey: "state", tone: "deny", flag: "查无单据" },
              { op: "tableRowUpdate", view: "attendance", id: "at-2407", set: { cells: { state: "需你处理" }, tone: "warn" } },
              { op: "cellFlag", view: "attendance", rowId: "at-2407", colKey: "state", tone: "deny", flag: "查无单据" },
              { op: "tableRowUpdate", view: "attendance", id: "at-1156", set: { cells: { state: "提醒级" } } },
              { op: "cellFlag", view: "attendance", rowId: "at-1156", colKey: "state", tone: "warn", flag: "健康提醒" },
              { op: "feedAppend", view: "audit", item: { id: "au-2", from: "AI 同事", time: "09:02:44", text: "对平 27 条考勤标记：自动对平 24 条，转人工 3 条，原始打卡记录未修改" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "2 条" },
            ],
          },
        },
        {
          id: "a2-text",
          kind: "text",
          title: "业务进展",
          defaultOpen: true,
          content: [
            "27 条里 **24 条不用你看**，每一类都有对得上的单据：",
            "",
            "1. 11 条迟到全部在 8:34 之前到岗，制度是 8:30 上班加 5 分钟弹性，按制度就是正常出勤；",
            "2. 6 条打卡缺失都有已批的出差或外勤单——比如张明远今天上午没打卡，出差单 8-08 18:20 就批了，去向是海川机械。系统把它报成异常，但它不该占用你的时间；",
            "3. 4 条是已批的调休和年假，单据日期和考勤日期逐条对得上；",
            "4. 3 条是车间门禁重复刷卡，同一个人同一分钟两条记录。",
            "",
            "**真正要你处理的是 2 件**：",
            "",
            "- 注塑二组 工号 P-2318、P-2407，8-07 到 8-09 连续 3 天无打卡，请假、调休、出差、工时补录四类单据全部查无。没有任何单据的连续缺勤，我不敢替你结掉；",
            "- 装配一组 工号 Q-1156，近 7 天累计加班 38.5 小时、连续出勤 12 天，超过公司自己定的每周 36 小时上限 2.5 小时。这条不是纪律问题，是健康提醒。",
          ].join("\n"),
        },
      ],
    },

    {
      caption: "深挖注塑二组：缺勤撞上赶工",
      blocks: [
        {
          id: "a3-tool",
          kind: "tool_use",
          title: "ShiftAnalysis",
          defaultOpen: true,
          toolName: "ShiftAnalysis",
          toolId: "t-shift",
          content: JSON.stringify({ team: "注塑二组", shift: "早班", date: demoWorldFixture.demoDate.iso }),
          executionStatus: "completed",
          durationMs: 1180,
          presentation: {
            title: "把缺勤放回排班与产线任务里看",
            detail: [
              { fields: [
                { k: "班组编制", v: "12 人 / 早班" },
                { k: "今日在岗", v: "10 人" },
                { k: "本周任务", v: demoWorldFixture.deliveryOrder.id },
                { k: "交付日", v: demoWorldFixture.deliveryOrder.promisedDeliveryDate },
              ] },
              { k: "订单", v: `${demoWorldFixture.deliveryOrder.customer} 精密结构件 ¥${demoWorldFixture.deliveryOrder.amountWan.toFixed(1)} 万` },
              { tree: "├", k: "剩余产量", v: "3,200 件 · 剩 5 个工作日" },
              { tree: "├", k: "需要日产", v: "640 件 / 天" },
              { tree: "└", k: "缺 2 人后日产上限", v: "533 件 / 天（-16.7%）" },
              { risk: "high", text: "连续 3 天无单据缺勤 × 在赶的交付订单，两件事叠在一起", action: "今天核实，不要等到下周一" },
              { warn: "缺勤性质我不判断——是旷工、口头请假没补单，还是别的原因，要主管问过本人才算数" },
            ],
            status: "warn",
            panel: [
              { op: "focus", view: "attendance" },
              { op: "toolbar", view: "attendance", title: "考勤系统 · 注塑二组早班", sub: `编制 12 · 在岗 10 · 承接 ${demoWorldFixture.deliveryOrder.id}` },
              { op: "tableRowUpdate", view: "attendance", id: "at-2318", set: { cells: { flag: "8-07 至 8-09 连续 3 天" } } },
              { op: "tableRowUpdate", view: "attendance", id: "at-2407", set: { cells: { flag: "8-07 至 8-09 连续 3 天" } } },
              { op: "cellFlag", view: "attendance", rowId: "at-zmy", colKey: "state", tone: "info", flag: "已对平" },
              { op: "cellFlag", view: "attendance", rowId: "at-rest", colKey: "state", tone: "info", flag: "已对平" },
              { op: "pulse", view: "attendance", ids: ["at-2318", "at-2407"], kind: "hit" },
              { op: "feedAppend", view: "audit", item: { id: "au-3", from: "AI 同事", time: "09:03:26", text: `关联注塑二组排班与在制订单 ${demoWorldFixture.deliveryOrder.id}，评估缺勤对交付的影响（只读）` } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "3 条" },
            ],
          },
        },
        {
          id: "a3-text",
          kind: "text",
          title: "业务进展",
          defaultOpen: true,
          content: [
            `这两个人缺得不巧。注塑二组早班编制 12 人，今天在岗 10 人；这个组本周承接的是 ${demoWorldFixture.deliveryOrder.id}，${demoWorldFixture.deliveryOrder.customer}的精密结构件，¥${demoWorldFixture.deliveryOrder.amountWan.toFixed(1)} 万，${demoWorldFixture.deliveryOrder.promisedDeliveryDate} 交付，还剩 3,200 件、5 个工作日，需要日产 640 件。`,
            "",
            "少 2 个人，早班日产上限只到 533 件。**单看缺勤不算急，单看订单也还追得上，两件事撞在一起才是风险**——这也是我建议今天就核实、别拖到下周一的唯一理由。",
            "",
            "缺勤性质我不下结论：是旷工、是口头请过假没补单，还是家里出了事，得主管问过本人才算数。我这里只有「三天没打卡、四类单据查无」这个事实。",
          ].join("\n"),
        },
      ],
    },

    {
      caption: "要病假原因明细，被拦截",
      blocks: [
        {
          id: "a4-prompt",
          kind: "prompt",
          title: "用户消息",
          defaultOpen: true,
          content: "把这两个人的请假历史和病假原因明细也调出来，我看看是不是老毛病。",
        },
        {
          id: "a4-tool",
          kind: "tool_use",
          title: "HRRecordQuery",
          defaultOpen: true,
          toolName: "HRRecordQuery",
          toolId: "t-hr",
          content: JSON.stringify({ staff: ["P-2318", "P-2407"], fields: ["sickLeaveReason", "diagnosis"] }),
          executionStatus: "completed",
          durationMs: 190,
          presentation: {
            title: "病假原因与诊断材料 · 权限判定",
            detail: [
              { k: "请求数据域", v: "病假原因、诊断材料" },
              { k: "本人岗位", v: "人事（考勤管理）" },
              { verdict: "fail", text: "按个人健康信息最小必要原则拒绝", note: "未读取任何病因内容 · 拦截已记账" },
              { verdict: "pass", text: "可给的部分照给", note: "请假次数与天数属考勤事实，不涉及病因" },
            ],
            status: "blocked",
            panel: [
              { op: "focus", view: "rights" },
              { op: "toolbar", view: "rights", title: "权限矩阵 · 人事岗可访问范围", sub: "命中 1 条拒绝" },
              { op: "tableRowInsert", view: "rights", row: { id: "r-clock", cells: { domain: "考勤打卡与排班", grant: "允许", owner: "岗位表" } } },
              { op: "tableRowInsert", view: "rights", row: { id: "r-doc", cells: { domain: "请假单据状态与天数", grant: "允许", owner: "岗位表" } } },
              { op: "tableRowInsert", view: "rights", row: { id: "r-med", cells: { domain: "病假原因与诊断材料", grant: "拒绝", owner: "健康信息最小化" }, tone: "deny" } },
              { op: "cellFlag", view: "rights", rowId: "r-med", colKey: "grant", tone: "deny", flag: "不可调阅" },
              { op: "tableRowInsert", view: "rights", row: { id: "r-pay", cells: { domain: "薪酬与绩效明细", grant: "拒绝", owner: "薪酬专员" } } },
              { op: "tableRowInsert", view: "rights", row: { id: "r-chat", cells: { domain: "员工私人会话", grant: "拒绝", owner: "全员不可调阅" } } },
              { op: "feedAppend", view: "audit", item: {
                id: "au-4",
                from: "AI 同事",
                time: "09:04:02",
                text: "病假原因与诊断材料调阅被拦截，未读取任何健康信息",
                card: { title: "调阅请求已拦截", body: "数据域「病假原因与诊断材料」对人事考勤岗不开放；已给出可用的替代口径", meta: [{ text: "未读取病因", tone: "pass" }, { text: "已记账", tone: "info" }] },
              } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "4 条" },
            ],
          },
        },
        {
          id: "a4-text",
          kind: "text",
          title: "回复",
          defaultOpen: true,
          content: [
            "**病因这一层我不能调，也不会绕过去**。诊断材料和病假原因属于个人健康信息，查勤要判断的是「请没请、请了几天、单据批没批」，不需要知道人得的是什么病——右侧权限矩阵这一行是明确拒绝的，我没有读取任何内容。",
            "",
            "能给你的和该走的路：",
            "",
            "1. 次数和天数照给：P-2318 近 6 个月请病假 3 次共 4 天，P-2407 是 1 次共 1 天，单据都批过，和这三天连续缺勤对不上；",
            "2. 缺勤原因让吴国栋直接问本人，这本来也比翻记录准；",
            "3. 万一后面真要用到医疗信息（比如走长期病假流程），走《特殊情形调阅》，由你和员工本人同时知情之后再说。",
            "",
            "先把今天这两件办掉？我把处理单出出来。",
          ].join("\n"),
        },
      ],
    },

    {
      caption: "生成今日考勤异常处理单",
      blocks: [
        {
          id: "a5-tool",
          kind: "tool_use",
          title: "DocBuild",
          defaultOpen: true,
          toolName: "DocBuild",
          toolId: "t-doc",
          content: JSON.stringify({ doc: "今日考勤异常处理单", date: demoWorldFixture.demoDate.iso }),
          executionStatus: "completed",
          durationMs: 1340,
          presentation: {
            title: "出一页纸处理单，含两条待发原文",
            detail: [
              { no: 1, text: "需要处理的 2 件：事实 / 为什么算异常 / 建议动作 三列并排" },
              { no: 2, text: "已对平的 24 条按类归并，依据留档备查" },
              { no: 3, text: "两条待发消息的原文全文，就是对方屏幕上会看到的样子" },
              { k: "格式", v: "单文件网页 · 可直接下载转发" },
              { tree: "└", k: "发送状态", v: "两条都还没发，等你定" },
            ],
            status: "ok",
            panel: [
              { op: "focus", view: "audit" },
              { op: "feedAppend", view: "audit", item: {
                id: "au-5",
                from: "AI 同事",
                time: "09:06:18",
                text: `生成《今日考勤异常处理单 · ${demoWorldFixture.demoDate.iso}》，未向任何人发送`,
                card: { title: "处理单已生成", body: "需处理 2 件 · 提醒 1 件 · 已对平 24 条依据留档", meta: [{ text: "可下载", tone: "info" }, { text: "尚未发送", tone: "pending" }] },
              } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "5 条" },
              { op: "toolbar", view: "im", title: "企业 IM", sub: "草稿 2 条 · 已发 0 条" },
            ],
          },
        },
        {
          id: "a5-text",
          kind: "text",
          title: "回复",
          defaultOpen: true,
          content: [
            "处理单出好了，一页纸，你可以直接拿去跟吴国栋对：",
            "",
            `[FILE]{"filePath":"${HANDLE_SHEET_PATH}","fileName":"今日考勤异常处理单.html","fileSize":${HANDLE_SHEET_SIZE_BYTES}}[/FILE]`,
            "",
            "后半页是**对方屏幕上会看到的样子**——吴国栋点开待办时的卡片原文、Q-1156 收到提醒时的私聊原文，一字不差都在里面。发不发由你定，我一条都还没发出去。",
          ].join("\n"),
        },
      ],
    },

    {
      caption: "下发前由你确认",
      blocks: [],
      approval: {
        title: "两条消息下发 · 需你确认",
        description: "确认后才会创建待办并发出提醒。这一步会写入待办中心并向人发消息，必须由你明确确认。",
        facts: [
          { label: "待办 1 · 收件人", value: "吴国栋（注塑二组排班负责人）" },
          { label: "待办 1 · 内容", value: "核实 P-2318 / P-2407 连续 3 天缺勤原因，8-09 18:00 前回填" },
          { label: "提醒 2 · 收件人", value: "工号 Q-1156" },
          { label: "提醒 2 · 发送方式", value: "装配一组班组群（我的建议，可改）" },
          { label: "考勤原始记录", value: "不修改" },
        ],
        approveLabel: "确认下发",
        rejectLabel: "退回修改",
        approvedBlocks: [
          {
            id: "a6-human",
            kind: "prompt",
            title: "用户消息",
            defaultOpen: true,
            content: "待办照发。但那条关怀提醒别发班组群，私发给他本人——发群里就成通报了，人家会以为自己犯了错。",
          },
          {
            id: "a6-tool",
            kind: "tool_use",
            title: "Approval",
            defaultOpen: true,
            toolName: "Approval",
            toolId: "t-approve",
            content: JSON.stringify({ decision: "approved", channelChanged: true }),
            executionStatus: "completed",
            durationMs: 360,
            presentation: {
              title: "已按你的口径下发 · 含人工修改 1 项",
              detail: [
                "采纳 1 项 · 修改 1 项 · 自动执行 0 项",
                { k: "采纳", v: "给吴国栋的核实待办，原文照发" },
                { k: "修改", v: "关怀提醒 班组群 → 私聊本人" },
                { tree: "├", k: "待办回执", v: "TD-1206 · 截止 8-09 18:00 · 回读校验通过" },
                { tree: "├", k: "私聊送达", v: "09:14 已送达 Q-1156 本人" },
                { tree: "└", k: "留痕", v: "原建议、修改点、下发人都已记录" },
              ],
              status: "ok",
              receipt: { id: "TD-1206", system: "待办中心", readBack: true },
              panel: [
                { op: "focus", view: "im" },
                { op: "toolbar", view: "im", title: "企业 IM · 发送与送达", sub: "私聊 1 条 · 班组群 0 条" },
                { op: "feedAppend", view: "im", item: {
                  id: "im-1",
                  from: "AI 同事 → 工号 Q-1156（私聊）",
                  time: "09:14",
                  text: "人事这边看到你近 7 天累计加班 38.5 小时、连续出勤 12 天，超过公司每周 36 小时的上限。这条不是说你哪里做得不对，是提醒你歇一歇，本周内挑一天调休。",
                  card: { title: "已送达 · 仅本人可见", body: "按你的要求改为私聊，班组群未发送", meta: [{ text: "私聊", tone: "pass" }, { text: "群发已取消", tone: "info" }] },
                } },
                { op: "toolbar", view: "todo", title: "待办中心", sub: "1 条" },
                { op: "rowInsert", view: "todo", row: { id: "td-1206", text: "TD-1206 核实注塑二组连续缺勤", sub: "责任人 吴国栋 · 截止 8-09 18:00 · 附排产影响说明", tone: "pass", state: "hit", badge: { text: "回读通过", tone: "pass" } } },
                { op: "feedAppend", view: "audit", item: {
                  id: "au-6",
                  from: "林悦（人事）",
                  time: "09:14:07",
                  text: "确认下发：采纳 1 项、修改 1 项（关怀提醒由班组群改为私聊）、自动执行 0 项",
                  card: { title: "人审记录", body: "采纳 1 · 修改 1 · 自动执行 0", meta: [{ text: "AI 未自行发送", tone: "pass" }] },
                } },
                { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "6 条" },
              ],
            },
          },
          {
            id: "a6-text",
            kind: "text",
            title: "下发结果",
            defaultOpen: true,
            content:
              "两条都按你的口径走了：吴国栋的核实待办 TD-1206 已建，截止今天 18:00，回读校验通过；关怀提醒 09:14 私聊送达 Q-1156 本人，班组群里一个字都没发。你改的这处我记下了，以后这类提醒默认走私聊。",
          },
        ],
        rejectedBlocks: [
          {
            id: "a6-rejected-tool",
            kind: "tool_use",
            title: "Approval",
            defaultOpen: true,
            toolName: "Approval",
            toolId: "t-reject",
            content: JSON.stringify({ decision: "rejected" }),
            executionStatus: "completed",
            durationMs: 240,
            presentation: {
              title: "下发被退回 · 没有联系任何人",
              detail: [
                { k: "审批结果", v: "退回修改" },
                { k: "待办中心", v: "0 条新增" },
                { k: "企业 IM", v: "两条都停在草稿，未发出" },
                { tree: "└", k: "留痕", v: "退回时间、退回人与当时的消息版本已记录" },
              ],
              status: "blocked",
              panel: [
                { op: "focus", view: "todo" },
                { op: "toolbar", view: "todo", title: "待办中心", sub: "0 条" },
                { op: "rowsSet", view: "todo", rows: [
                  { id: "td-hold", text: "未创建任何待办", sub: "两条消息停在草稿，处理单仍可下载", tone: "warn", badge: { text: "已停住", tone: "warn" } },
                ] },
                { op: "feedAppend", view: "audit", item: { id: "au-reject", from: "林悦（人事）", time: "09:14:07", text: "下发被退回：待办中心无新增，企业 IM 未发出任何消息" } },
              ],
            },
          },
          {
            id: "a6-rejected-text",
            kind: "text",
            title: "退回说明",
            defaultOpen: true,
            content:
              "停在下发点了：没建待办，也没给任何人发消息，两条原文还是草稿。处理单你照样能下载，改完措辞或换个收件人再叫我，重新提交仍然要你点一次。",
          },
        ],
      },
    },

    {
      caption: "跨系统核对终态",
      blocks: [
        {
          id: "a7-tool",
          kind: "tool_use",
          title: "ReadBack",
          defaultOpen: true,
          toolName: "ReadBack",
          toolId: "t-readback",
          content: JSON.stringify({ date: demoWorldFixture.demoDate.iso }),
          executionStatus: "completed",
          durationMs: 920,
          presentation: {
            title: "回读四个系统，核对说法是否一致",
            detail: [
              { k: "回读方式", v: "按对象 ID 逐个反查，不用本次会话的缓存" },
              { verdict: "pass", text: "考勤系统", note: "27 条标记已分拣 · 原始打卡记录 0 处修改" },
              { verdict: "pass", text: "待办中心", note: "TD-1206 存在 · 责任人吴国栋 · 截止 8-09 18:00" },
              { verdict: "pass", text: "企业 IM", note: "私聊 1 条已送达 · 班组群 0 条" },
              { verdict: "pass", text: "审批流", note: "只读查询 · 无新增无修改" },
              { insight: "四方一致，没有悬着的动作", label: "结论" },
            ],
            status: "ok",
            panel: [
              { op: "focus", view: "attendance" },
              { op: "toolbar", view: "attendance", title: "考勤系统 · 终态回读", sub: "四方一致 · 原始记录未改" },
              { op: "feedAppend", view: "audit", item: { id: "au-7", from: "AI 同事", time: "09:15:02", text: "回读考勤系统 / 待办中心 / 企业 IM / 审批流，四方状态一致" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "7 条" },
            ],
          },
        },
        {
          id: "a7-text",
          kind: "text",
          title: "本次会话改变了什么",
          defaultOpen: true,
          content: [
            "## 本次会话改变了什么",
            "",
            "| 系统 | 终态 | 依据 |",
            "| --- | --- | --- |",
            "| 考勤系统 | 27 条标记分拣完毕：对平 24 · 转人工 2 · 提醒 1 | 分拣结果回读，原始打卡记录 0 处修改 |",
            "| 待办中心 | 新增 1 条 TD-1206，责任人吴国栋，截止 8-09 18:00 | 待办回读校验通过 |",
            "| 企业 IM | 私聊 1 条已送达 Q-1156，班组群 0 条 | 09:14 送达回执 |",
            "| 审批流 | 无新增、无修改 | 只读查询留痕 |",
            "",
            "## 本次会话没有做什么",
            "",
            "- 没有查任何人的病因：病假原因与诊断材料在权限矩阵处被拦，零读取；",
            "- 没有给任何人记异常或处分：缺勤性质等吴国栋核实完再说，我只报事实；",
            "- 没有改考勤数据：24 条对平只是分拣标记，原始打卡记录一个字节都没动；",
            "- 没有把关怀提醒发进班组群：按你的要求改成了私聊。",
            "",
            "以后这件事可以不用你开口——每天 9:00 我自动分拣一遍，全部对平就不打扰你，只有真需要你处理的才叫你。想开随时说一声就行。",
          ].join("\n"),
        },
      ],
    },
  ],

  // 治理条款：state != exists 的条目就是「演示到真实」的距离
  sources: [
    {
      blockRef: "step1.tool.AttendanceQuery",
      producer: "钉钉 DWS 连接器（考勤查询）",
      state: "needs-change",
      gap: "打卡明细能取到，但「按日产出应出勤 / 打卡完整 / 待确认条数」的当日汇总摘要需要新增输出",
    },
    {
      blockRef: "step2.tool.AnomalyTriage",
      producer: "钉钉 DWS 连接器（审批单查询）+ 考勤分拣规则",
      state: "needs-change",
      gap: "单条审批单可查，但「按人×日期把考勤缺口与请假/出差/调休单批量对平」没有现成输出；弹性分钟数、加班阈值这些口径也还没有可版本化的规则集与生效日期",
    },
    {
      blockRef: "step3.tool.ShiftAnalysis",
      producer: "租户业务数据连接器（排班与在制订单）",
      state: "missing",
      gap: "排班表与订单剩余产量分属两个业务系统，当前没有通用连接器能把它们关联到同一个班组上；这一步的因果链现在只能人工拼",
    },
    {
      blockRef: "step4.tool.HRRecordQuery",
      producer: "独立范围门禁",
      state: "needs-change",
      gap: "门禁形态已验证（loop 外独立判定 + 前端预设话术），但按数据域细分到「请假天数可查、病因不可查」这种字段级最小化矩阵尚未产品化",
    },
    {
      blockRef: "step5.tool.DocBuild",
      producer: "Agent 生成 HTML 产物",
      state: "exists",
    },
    {
      blockRef: "step5.artifact.今日考勤异常处理单",
      producer: "Agent 生成 HTML 产物",
      state: "exists",
    },
    {
      blockRef: "step6.tool.Approval",
      producer: "钉钉 DWS 连接器（待办创建 + IM 发送）",
      state: "needs-change",
      gap: "建待办与发消息都能做，但「采纳几项、人改了哪一项、自动执行几项」没有结构化字段，现在只能落在自由文本里；发送渠道被人改掉这件事也没有回写成偏好",
    },
    {
      blockRef: "step7.tool.ReadBack",
      producer: "业务终态回读器",
      state: "missing",
      gap: "跨系统回读要先有各系统连接器；在此之前终态核对表只能人工整理，也就没法证明「原始打卡记录 0 处修改」",
    },
  ],
};

import type { SystemPanelSnapshot } from "@agent/shared";
import { demoWorldFixture } from "./demoWorldFixture";
import type { ReplayScript } from "./types";

/**
 * 会后追办 quick：只接已确认决议，不重复生产证据化会议记录。
 *
 * meetingActionScript 负责事实、决定与行动的可追溯记录；本场景从确认后的决议起步，
 * 找出责任人与期限缺口，交回给人补齐，经确认批量创建追办事项，并持续监测到完成或升级。
 * 内容均为虚构示例。
 */

const FOLLOW_UP_BOARD_PATH = "assets/demo/经营会会后追办看板.html";

const FOLLOW_UP_BOARD_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<style>
  :root { --brand:#2E56E1; --ink:#0f172a; --muted:#64748b; --line:#e2e8f0; --ok:#15803d; --warn:#b45309; --deny:#b91c1c; }
  * { box-sizing:border-box; }
  body { margin:0; padding:20px; font:14px/1.65 "PingFang SC","Microsoft YaHei",system-ui,sans-serif; color:var(--ink); background:#fff; }
  .bar { padding:7px 10px; border:1px solid var(--line); border-radius:7px; background:#f8fafc; color:var(--muted); font-size:12px; margin-bottom:14px; }
  h1 { margin:0 0 3px; font-size:17px; }
  .sub { margin:0 0 14px; color:var(--muted); font-size:12px; }
  .stats { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; margin-bottom:14px; }
  .stat { padding:9px 10px; border:1px solid var(--line); border-radius:8px; }
  .stat b { display:block; font-size:18px; }
  .stat span { color:var(--muted); font-size:12px; }
  table { width:100%; border-collapse:collapse; font-size:12.5px; margin-bottom:15px; }
  th,td { border:1px solid var(--line); padding:7px 9px; text-align:left; vertical-align:top; }
  th { background:#f8fafc; color:var(--muted); font-weight:500; }
  .owner { color:var(--brand); font-weight:600; }
  .pending { color:var(--warn); font-weight:600; }
  .rule { border:1px solid var(--line); border-radius:8px; padding:11px 13px; margin-bottom:10px; }
  .rule b { color:var(--brand); }
  .foot { color:var(--muted); font-size:11px; margin-top:14px; }
</style></head><body>
<div class="bar">${demoWorldFixture.meeting.title} · ${demoWorldFixture.meeting.date} · 会后追办待确认</div>
<h1>经营会会后追办看板</h1>
<p class="sub">输入为已确认决议；产物是行动清单和追办规则，不是另一份会议纪要</p>
<div class="stats">
  <div class="stat"><b>${demoWorldFixture.meeting.confirmedDecisionCount}</b><span>已确认决议</span></div>
  <div class="stat"><b>${demoWorldFixture.meeting.followUpCount}</b><span>待建追办</span></div>
  <div class="stat"><b>${demoWorldFixture.meeting.ownerCount}</b><span>责任人</span></div>
  <div class="stat"><b>2</b><span>人工补齐字段</span></div>
</div>
<table>
  <tr><th>追办</th><th>确认后的行动</th><th>责任人</th><th>期限</th><th>审批前状态</th></tr>
  <tr><td>FU-0809-01</td><td>出具 ${demoWorldFixture.deliveryOrder.id} 书面交付方案</td><td class="owner">周晓芸</td><td>08-10 12:00</td><td class="pending">待确认</td></tr>
  <tr><td>FU-0809-02</td><td>取得华矩 6204-RS 400 件有效发货凭据</td><td class="owner">刘志强</td><td>08-09 16:00</td><td class="pending">待确认</td></tr>
  <tr><td>FU-0809-03</td><td>完成蓝谷应收催收口径并回报</td><td class="owner">陈静</td><td>08-10 18:00</td><td class="pending">待确认</td></tr>
  <tr><td>FU-0809-04</td><td>完成蓝谷账期与信用额度重评</td><td class="owner">陈静</td><td>08-13 18:00 <small>人工补齐</small></td><td class="pending">待确认</td></tr>
  <tr><td>FU-0809-05</td><td>完成启润客诉复判并给处理结论</td><td class="owner">周晓芸 <small>人工补齐</small></td><td>08-10 12:00</td><td class="pending">待确认</td></tr>
</table>
<div class="rule"><b>提醒规则</b>：到期前 2 小时提醒责任人；24 小时内仍未读则补发一次。</div>
<div class="rule"><b>升级规则</b>：到期未完成立即升级给沈建国；升级不等于完成，原责任人仍需闭环。</div>
<div class="rule"><b>停止条件</b>：有完成回执才销项；被升级的事项持续监测，直到完成或由有权人取消。</div>
<p class="foot">虚构回放。人员、决议、日期与业务对象均为演示数据；审批前不会创建待办或发送提醒。</p>
</body></html>`;

const FOLLOW_UP_BOARD_SIZE_BYTES = new TextEncoder().encode(FOLLOW_UP_BOARD_HTML).length;

/** 面板底稿：已确认决议 / 追办事项 / 监测事件 / 升级队列 / 操作留痕 */
const PANEL_BASE: SystemPanelSnapshot = {
  title: "企业系统实况",
  live: true,
  activeView: "decisions",
  foot: "已连接：决议台账 · 待办中心 · 提醒服务 · 升级队列（演示）",
  views: [
    {
      key: "decisions",
      label: "已确认决议",
      winTitle: "决议台账 · 会后可执行项",
      toolbar: { title: "已确认决议", sub: "尚未读取" },
      widget: {
        kind: "table",
        cols: [
          { key: "id", label: "追办" },
          { key: "action", label: "行动" },
          { key: "owner", label: "责任人" },
          { key: "due", label: "期限", align: "right" },
        ],
        rows: [],
        empty: { title: "尚未读取已确认决议" },
      },
    },
    {
      key: "todos",
      label: "追办事项",
      winTitle: "待办中心 · 经营会追办",
      toolbar: { title: "会后追办事项", sub: "尚未创建" },
      widget: {
        kind: "table",
        cols: [
          { key: "item", label: "待办" },
          { key: "owner", label: "责任人" },
          { key: "due", label: "期限" },
          { key: "state", label: "状态", align: "right" },
        ],
        rows: [],
        empty: { title: "审批前不创建追办事项" },
      },
    },
    {
      key: "monitor",
      label: "持续监测",
      winTitle: "提醒服务 · 临期、逾期与完成回执",
      toolbar: { title: "追办监测事件", sub: "尚未启用" },
      widget: { kind: "feed", items: [], empty: { title: "暂无监测事件" } },
    },
    {
      key: "escalations",
      label: "升级队列",
      winTitle: "升级队列 · 逾期未完成事项",
      toolbar: { title: "逾期升级", sub: "0 条" },
      widget: { kind: "rows", rows: [], empty: { title: "暂无逾期升级" } },
    },
    {
      key: "audit",
      label: "操作留痕",
      winTitle: "操作留痕 · 会后追办",
      toolbar: { title: "本次会话的系统动作", sub: "0 条" },
      widget: { kind: "feed", items: [], empty: { title: "尚无系统动作" } },
    },
  ],
};

export const meetingTodosScript: ReplayScript = {
  scenarioId: "catalog-hook-meeting-todos",
  title: "会后追办：责任人、期限和升级一个不漏",
  mode: "quick",
  artifacts: { [FOLLOW_UP_BOARD_PATH]: FOLLOW_UP_BOARD_HTML },

  steps: [
    {
      caption: "读取已确认决议，不重做会议记录",
      blocks: [
        {
          id: "mt1-prompt",
          kind: "prompt",
          title: "用户消息",
          defaultOpen: true,
          content: "把经营会的决议建成待办，缺信息再问我。",
        },
        {
          id: "mt1-tool",
          kind: "tool_use",
          title: "ConfirmedDecisionQuery",
          defaultOpen: true,
          toolName: "ConfirmedDecisionQuery",
          toolId: "t-decisions",
          content: JSON.stringify({ meeting: demoWorldFixture.meeting.id, status: "confirmed", executableOnly: true }),
          executionStatus: "completed",
          durationMs: 980,
          presentation: {
            title: "读取已确认决议中的 5 条可执行项",
            detail: [
              { k: "会议", v: `${demoWorldFixture.meeting.title} · ${demoWorldFixture.meeting.date} · ${demoWorldFixture.meeting.durationMinutes} 分钟 · ${demoWorldFixture.meeting.participantCount} 人` },
              { k: "输入对象", v: `${demoWorldFixture.meeting.id} · 已确认决议 ${demoWorldFixture.meeting.confirmedDecisionCount} 条` },
              { tree: "├", k: "处理范围", v: "只取可执行项、责任人、期限与业务对象" },
              { tree: "└", k: "本场景产物", v: "追办看板与待办，不另做会议记录" },
            ],
            status: "ok",
            panelBase: PANEL_BASE,
            panel: [
              { op: "focus", view: "decisions" },
              { op: "toolbar", view: "decisions", title: `${demoWorldFixture.meeting.title} · 已确认决议`, sub: "可执行项 5 · 待检查字段完整性" },
              { op: "tableRowInsert", view: "decisions", row: { id: "d-01", cells: { id: "FU-0809-01", action: `出具 ${demoWorldFixture.deliveryOrder.id} 书面交付方案`, owner: "周晓芸", due: "08-10 12:00" } } },
              { op: "tableRowInsert", view: "decisions", row: { id: "d-02", cells: { id: "FU-0809-02", action: "取得华矩 6204-RS 发货凭据", owner: "刘志强", due: "08-09 16:00" } } },
              { op: "tableRowInsert", view: "decisions", row: { id: "d-03", cells: { id: "FU-0809-03", action: "完成蓝谷应收催收口径并回报", owner: "陈静", due: "08-10 18:00" } } },
              { op: "tableRowInsert", view: "decisions", row: { id: "d-04", cells: { id: "FU-0809-04", action: "蓝谷账期与信用额度重评", owner: "陈静", due: "缺失" }, tone: "warn" } },
              { op: "tableRowInsert", view: "decisions", row: { id: "d-05", cells: { id: "FU-0809-05", action: "启润客诉复判并给处理结论", owner: "缺失", due: "08-10 12:00" }, tone: "warn" } },
              { op: "feedAppend", view: "audit", item: { id: "ta-1", from: "AI 同事", time: "10:12:06", text: "读取已确认决议 5 条（只读），未创建待办" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "1 条" },
            ],
          },
        },
        {
          id: "mt1-result",
          kind: "tool_result",
          title: "ConfirmedDecisionQuery 结果",
          defaultOpen: false,
          toolName: "ConfirmedDecisionQuery",
          toolId: "t-decisions",
          content: "meeting=MTG-2026-0809-OPS confirmed=5 executable=5 todos=0",
        },
        {
          id: "mt1-text",
          kind: "text",
          title: "追办起点",
          defaultOpen: true,
          content: "这里直接从已确认决议起步。接下来只检查行动能不能真正分派：责任人是谁、什么时候到期、逾期升级给谁。",
        },
      ],
    },

    {
      caption: "识别责任人与期限缺口",
      blocks: [
        {
          id: "mt2-tool",
          kind: "tool_use",
          title: "FollowUpGapCheck",
          defaultOpen: true,
          toolName: "FollowUpGapCheck",
          toolId: "t-gaps",
          content: JSON.stringify({ meeting: demoWorldFixture.meeting.id, requiredFields: ["owner", "dueAt", "escalationOwner"] }),
          executionStatus: "completed",
          durationMs: 740,
          presentation: {
            title: "5 条可执行项中发现 2 个关键字段缺口",
            detail: [
              { verdict: "pass", text: "FU-0809-01 / 02 / 03 可直接分派", note: "责任人和期限齐全" },
              { warn: "FU-0809-04 有责任人陈静，但只写了“本周完成”，没有可执行的截止时点" },
              { warn: "FU-0809-05 有 08-10 12:00 的期限，但责任人为空" },
              { tree: "├", k: "已知责任人", v: "周晓芸、刘志强、陈静，共 3 人" },
              { tree: "└", k: "当前动作", v: "保持待办 0 条，不猜负责人、不把模糊时间写成期限" },
            ],
            status: "warn",
            panel: [
              { op: "focus", view: "decisions" },
              { op: "toolbar", view: "decisions", title: `${demoWorldFixture.meeting.title} · 追办字段检查`, sub: "完整 3 · 缺口 2 · 待办 0" },
              { op: "cellFlag", view: "decisions", rowId: "d-04", colKey: "due", tone: "warn", flag: "待人补齐" },
              { op: "cellFlag", view: "decisions", rowId: "d-05", colKey: "owner", tone: "warn", flag: "待人补齐" },
              { op: "feedAppend", view: "audit", item: { id: "ta-2", from: "AI 同事", time: "10:12:52", text: "检查 5 条追办字段：完整 3，责任人缺口 1，期限缺口 1；未代填" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "2 条" },
            ],
          },
        },
        {
          id: "mt2-text",
          kind: "text",
          title: "需要人补的两项",
          defaultOpen: true,
          content: [
            "需要你补两格，我不会替参会人承诺：",
            "",
            "1. 蓝谷账期与信用额度重评：陈静负责，但“本周完成”缺具体截止时间；",
            "2. 启润客诉复判：期限是 08-10 12:00，但没有责任人。",
            "",
            "这两格补齐后，5 条追办会明确落到 3 位责任人名下。",
          ].join("\n"),
        },
      ],
    },

    {
      caption: "人补齐两格并生成追办看板",
      blocks: [
        {
          id: "mt3-human",
          kind: "prompt",
          title: "用户消息",
          defaultOpen: true,
          content: "信用额度重评还是陈静负责，截止 8 月 13 日 18:00。启润客诉复判给周晓芸，8 月 10 日 12:00 不变。逾期都升级给我。",
        },
        {
          id: "mt3-tool",
          kind: "tool_use",
          title: "FollowUpBoardBuild",
          defaultOpen: true,
          toolName: "FollowUpBoardBuild",
          toolId: "t-board",
          content: JSON.stringify({ meeting: demoWorldFixture.meeting.id, patches: ["FU-0809-04.dueAt", "FU-0809-05.owner"], escalationOwner: "沈建国" }),
          executionStatus: "completed",
          durationMs: 1050,
          presentation: {
            title: "5 条追办已到人到期，生成审批前行动板",
            detail: [
              { k: "追办总数", v: "5 条" },
              { k: "责任人", v: "3 人 · 周晓芸 2 条 / 刘志强 1 条 / 陈静 2 条" },
              { k: "人工补齐", v: "2 格 · FU-0809-04 期限 / FU-0809-05 责任人" },
              { tree: "├", k: "提醒", v: "到期前 2 小时提醒责任人" },
              { tree: "├", k: "升级", v: "到期未完成立即升级给沈建国，原责任人不变" },
              { tree: "└", k: "当前写入", v: "待办 0 条 · 提醒 0 条 · 等待确认" },
            ],
            status: "waiting",
            panel: [
              { op: "focus", view: "decisions" },
              { op: "toolbar", view: "decisions", title: `${demoWorldFixture.meeting.title} · 追办字段已补齐`, sub: "5 条 · 3 位责任人 · 等待确认" },
              { op: "tableRowUpdate", view: "decisions", id: "d-04", set: { cells: { due: "08-13 18:00" } } },
              { op: "cellFlag", view: "decisions", rowId: "d-04", colKey: "due", tone: "info", flag: "人工补齐" },
              { op: "tableRowUpdate", view: "decisions", id: "d-05", set: { cells: { owner: "周晓芸" } } },
              { op: "cellFlag", view: "decisions", rowId: "d-05", colKey: "owner", tone: "info", flag: "人工补齐" },
              { op: "feedAppend", view: "audit", item: { id: "ta-3", from: "总经理 沈建国", time: "10:14:20", text: "补齐 FU-0809-04 期限与 FU-0809-05 责任人；生成追办看板，尚未下发" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "3 条" },
            ],
          },
        },
        {
          id: "mt3-text",
          kind: "text",
          title: "追办看板",
          defaultOpen: true,
          content: [
            "5 条行动现在都能分派，责任人合计 3 位。行动清单与提醒、升级规则在这里：",
            "",
            `[FILE]{"filePath":"${FOLLOW_UP_BOARD_PATH}","fileName":"经营会会后追办看板.html","fileSize":${FOLLOW_UP_BOARD_SIZE_BYTES}}[/FILE]`,
            "",
            "这只是审批前看板。确认前待办中心仍是 0 条，也没有给任何人发提醒。",
          ].join("\n"),
        },
      ],
    },

    {
      caption: "确认 5 条责任人与期限后批量建追办",
      blocks: [],
      approval: {
        title: "会后追办责任人与期限 · 需有权人确认",
        description: "确认后批量创建 5 条追办并启用提醒、逾期升级。请逐条核对责任人和期限。",
        facts: [
          { label: "FU-0809-01", value: `周晓芸 · 08-10 12:00 · ${demoWorldFixture.deliveryOrder.id} 书面交付方案` },
          { label: "FU-0809-02", value: "刘志强 · 08-09 16:00 · 华矩 6204-RS 发货凭据" },
          { label: "FU-0809-03", value: "陈静 · 08-10 18:00 · 蓝谷应收催收口径" },
          { label: "FU-0809-04", value: "陈静 · 08-13 18:00 · 蓝谷账期与信用额度重评" },
          { label: "FU-0809-05", value: "周晓芸 · 08-10 12:00 · 启润客诉复判结论" },
        ],
        approveLabel: "确认并创建追办",
        rejectLabel: "退回调整",
        approvedBlocks: [
          {
            id: "mt4-human",
            kind: "prompt",
            title: "用户消息",
            defaultOpen: true,
            content: "这 5 条责任人和期限都对，按 3 位责任人批量创建。到期前 2 小时提醒，逾期立刻升级给我；升级后别当成完成，继续盯。",
          },
          {
            id: "mt4-approval",
            kind: "tool_use",
            title: "Approval",
            defaultOpen: true,
            toolName: "Approval",
            toolId: "t-approval",
            content: JSON.stringify({ meeting: demoWorldFixture.meeting.id, todos: 5, owners: 3, decision: "approved" }),
            executionStatus: "completed",
            durationMs: 310,
            presentation: {
              title: "责任人与期限已确认：5 条追办，3 位责任人",
              detail: [
                { verdict: "pass", text: "责任人确认", note: "周晓芸 2 条 / 刘志强 1 条 / 陈静 2 条" },
                { verdict: "pass", text: "期限确认", note: "5 条均有明确时点，最近到期 08-09 16:00" },
                { verdict: "pass", text: "升级口径确认", note: "逾期升级给沈建国；升级不销项，原责任人继续负责" },
                { tree: "└", k: "审批前自动执行", v: "0 条" },
              ],
              status: "ok",
              receipt: { id: "APR-MTG-0809-01", system: "审批中心", readBack: true },
              panel: [
                { op: "focus", view: "audit" },
                { op: "feedAppend", view: "audit", item: { id: "ta-4", from: "总经理 沈建国", time: "10:18:36", text: "确认 5 条追办的责任人与期限；批准批量创建并启用提醒、升级" } },
                { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "4 条" },
              ],
            },
          },
          {
            id: "mt4-create",
            kind: "tool_use",
            title: "BatchTodoCreate",
            defaultOpen: true,
            toolName: "BatchTodoCreate",
            toolId: "t-create",
            content: JSON.stringify({ source: demoWorldFixture.meeting.id, todos: ["FU-0809-01", "FU-0809-02", "FU-0809-03", "FU-0809-04", "FU-0809-05"] }),
            executionStatus: "completed",
            durationMs: 1180,
            presentation: {
              title: "5 条追办已批量创建并逐条回读",
              detail: [
                { k: "待办编号", v: "TD-3001 … TD-3005" },
                { k: "分派", v: "5 条 · 3 位责任人 · 已接收 5" },
                { tree: "├", k: "幂等校验", v: "按会议 ID + 追办 ID 去重，无重复创建" },
                { tree: "└", k: "业务对象", v: "每条待办保留原追办编号，完成回执可反向销项" },
              ],
              status: "ok",
              receipt: { id: "TD-3001…TD-3005", system: "待办中心", readBack: true },
              panel: [
                { op: "focus", view: "todos" },
                { op: "toolbar", view: "todos", title: "经营会会后追办", sub: "5 条 · 3 位责任人 · 已接收 5" },
                { op: "tableRowInsert", view: "todos", row: { id: "td-3001", cells: { item: `TD-3001 ${demoWorldFixture.deliveryOrder.id} 书面交付方案`, owner: "周晓芸", due: "08-10 12:00", state: "已接收" } } },
                { op: "tableRowInsert", view: "todos", row: { id: "td-3002", cells: { item: "TD-3002 华矩 6204-RS 发货凭据", owner: "刘志强", due: "08-09 16:00", state: "已接收" } } },
                { op: "cellFlag", view: "todos", rowId: "td-3002", colKey: "due", tone: "warn", flag: "今天到期" },
                { op: "tableRowInsert", view: "todos", row: { id: "td-3003", cells: { item: "TD-3003 蓝谷应收催收口径", owner: "陈静", due: "08-10 18:00", state: "已接收" } } },
                { op: "tableRowInsert", view: "todos", row: { id: "td-3004", cells: { item: "TD-3004 蓝谷信用额度重评", owner: "陈静", due: "08-13 18:00", state: "已接收" } } },
                { op: "tableRowInsert", view: "todos", row: { id: "td-3005", cells: { item: "TD-3005 启润客诉复判结论", owner: "周晓芸", due: "08-10 12:00", state: "已接收" } } },
                { op: "feedAppend", view: "audit", item: { id: "ta-5", from: "AI 同事", time: "10:19:02", text: "创建 TD-3001…TD-3005 并逐条回读；5 条、3 位责任人一致" } },
                { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "5 条" },
              ],
            },
          },
          {
            id: "mt4-monitor",
            kind: "tool_use",
            title: "FollowUpMonitorEnable",
            defaultOpen: true,
            toolName: "FollowUpMonitorEnable",
            toolId: "t-monitor-enable",
            content: JSON.stringify({ todos: 5, remindBeforeHours: 2, escalateOnOverdue: true, stopOn: "completion-or-authorized-cancel" }),
            executionStatus: "completed",
            durationMs: 420,
            presentation: {
              title: "持续追办已启用",
              detail: [
                { k: "监测对象", v: "TD-3001 … TD-3005" },
                { k: "临期", v: "到期前 2 小时提醒责任人" },
                { k: "逾期", v: "立即升级给沈建国，原责任人继续负责" },
                { tree: "└", k: "销项", v: "只认完成回执或有权人取消；提醒已发、事项已升级都不算完成" },
              ],
              status: "ok",
              receipt: { id: "MON-MTG-0809", system: "提醒服务", readBack: true },
              panel: [
                { op: "focus", view: "monitor" },
                { op: "toolbar", view: "monitor", title: "追办监测事件", sub: "监测 5 条 · 规则已启用" },
                { op: "feedAppend", view: "monitor", item: { id: "mon-start", from: "提醒服务", time: "10:19:10", text: "持续追办已启用：5 条事项，到期前 2 小时提醒，逾期立即升级", card: { title: "MON-MTG-0809", body: "完成或有权人取消才停止；升级不销项", meta: [{ text: "运行中", tone: "pass" }] } } },
                { op: "feedAppend", view: "audit", item: { id: "ta-6", from: "AI 同事", time: "10:19:10", text: "启用 5 条追办的临期提醒、逾期升级与完成回执监测" } },
                { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "6 条" },
              ],
            },
          },
        ],
        rejectedBlocks: [
          {
            id: "mt4-reject",
            kind: "tool_use",
            title: "ApprovalReject",
            defaultOpen: true,
            toolName: "ApprovalReject",
            toolId: "t-reject",
            content: JSON.stringify({ meeting: demoWorldFixture.meeting.id, decision: "rejected" }),
            executionStatus: "completed",
            durationMs: 230,
            presentation: {
              title: "追办下发被退回，待办与监测均未创建",
              detail: [
                { verdict: "pass", text: "待办中心零写入", note: "TD-3001…TD-3005 均未创建" },
                { verdict: "pass", text: "提醒与升级未启用", note: "3 位责任人没有收到任何通知" },
                { warn: "追办看板和两处人工补齐仍保留；调整后重新提交，仍需逐条确认" },
              ],
              status: "blocked",
              panel: [
                { op: "focus", view: "audit" },
                { op: "feedAppend", view: "audit", item: { id: "ta-reject", from: "总经理 沈建国", time: "10:18:36", text: "追办下发被退回：待办 0，提醒 0，升级规则未启用" } },
                { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "4 条" },
              ],
            },
          },
          {
            id: "mt4-reject-text",
            kind: "text",
            title: "退回说明",
            defaultOpen: true,
            content: "已停在确认点：5 条追办都没创建，3 位责任人没收到提醒，逾期升级也没有启用。看板仍可下载；调整责任人或期限后需要重新确认。",
          },
        ],
      },
    },

    {
      caption: "持续监测临期、完成与逾期升级",
      blocks: [
        {
          id: "mt5-tool",
          kind: "tool_use",
          title: "FollowUpCheckpoint",
          defaultOpen: true,
          toolName: "FollowUpCheckpoint",
          toolId: "t-checkpoint",
          content: JSON.stringify({ monitor: "MON-MTG-0809", checkpoint: "2026-08-10T16:05:00+08:00" }),
          executionStatus: "completed",
          durationMs: 1160,
          presentation: {
            title: "08-10 16:05 追办检查：完成 2，临期 1，进行中 1，逾期升级 1",
            detail: [
              { verdict: "pass", text: "TD-3001 已完成", note: `${demoWorldFixture.deliveryOrder.id} 书面交付方案 · 周晓芸 · 11:48 提交回执` },
              { verdict: "pass", text: "TD-3002 已完成", note: "华矩发货单与物流单号 · 刘志强 · 08-09 15:46 提交回执" },
              { verdict: "pending", text: "TD-3003 临期", note: "陈静 · 18:00 到期 · 16:00 提醒已读，当前处理中" },
              { verdict: "pending", text: "TD-3004 进行中", note: "陈静 · 08-13 18:00 到期，尚未进入提醒窗口" },
              { verdict: "warn", text: "TD-3005 已逾期并升级", note: "周晓芸 · 12:00 到期未完成 · 12:01 升级给沈建国；仍保持未完成" },
            ],
            status: "warn",
            panel: [
              { op: "focus", view: "todos" },
              { op: "toolbar", view: "todos", title: "经营会会后追办", sub: "完成 2 · 临期 1 · 进行中 1 · 升级 1" },
              { op: "tableRowUpdate", view: "todos", id: "td-3001", set: { cells: { state: "已完成" } } },
              { op: "cellFlag", view: "todos", rowId: "td-3001", colKey: "state", tone: "pass", flag: "11:48 回执" },
              { op: "tableRowUpdate", view: "todos", id: "td-3002", set: { cells: { state: "已完成" } } },
              { op: "cellFlag", view: "todos", rowId: "td-3002", colKey: "state", tone: "pass", flag: "15:46 回执" },
              { op: "tableRowUpdate", view: "todos", id: "td-3003", set: { cells: { state: "临期处理中" } } },
              { op: "cellFlag", view: "todos", rowId: "td-3003", colKey: "state", tone: "warn", flag: "已提醒" },
              { op: "tableRowUpdate", view: "todos", id: "td-3004", set: { cells: { state: "进行中" } } },
              { op: "tableRowUpdate", view: "todos", id: "td-3005", set: { cells: { state: "逾期升级" } } },
              { op: "cellFlag", view: "todos", rowId: "td-3005", colKey: "state", tone: "deny", flag: "仍未完成" },
              { op: "feedAppend", view: "monitor", item: { id: "mon-remind-3", from: "提醒服务", time: "16:00:02", text: "TD-3003 将于 18:00 到期，提醒陈静；16:02 已读" } },
              { op: "feedAppend", view: "monitor", item: { id: "mon-overdue-5", from: "升级服务", time: "12:01:04", text: "TD-3005 到期未完成，已升级给沈建国；周晓芸仍为责任人", card: { title: "启润客诉复判已升级", body: "升级不是完成，监测继续运行", meta: [{ text: "逾期", tone: "warn" }, { text: "待闭环", tone: "info" }] } } },
              { op: "rowInsert", view: "escalations", row: { id: "esc-3005", text: "TD-3005 启润客诉复判结论", sub: "原责任人 周晓芸 · 08-10 12:00 到期 · 仍未完成", state: "hit", tone: "warn", badge: { text: "已升级沈建国", tone: "warn" } } },
              { op: "toolbar", view: "escalations", title: "逾期升级", sub: "1 条 · 持续监测中" },
              { op: "feedAppend", view: "audit", item: { id: "ta-7", from: "提醒服务", time: "16:05:00", text: "追办检查：完成 2，临期提醒 1，进行中 1，逾期升级 1" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "7 条" },
            ],
          },
        },
        {
          id: "mt5-text",
          kind: "text",
          title: "追办进展",
          defaultOpen: true,
          content: "系统没有把“提醒已发”或“已经升级”写成完成。TD-3005 仍挂在周晓芸名下，同时进入沈建国的升级队列；其余未到期事项继续按各自期限监测。",
        },
      ],
    },

    {
      caption: "回读持续追办终态",
      blocks: [
        {
          id: "mt6-tool",
          kind: "tool_use",
          title: "FollowUpReadBack",
          defaultOpen: true,
          toolName: "FollowUpReadBack",
          toolId: "t-readback",
          content: JSON.stringify({ monitor: "MON-MTG-0809", checkpoint: "2026-08-13T18:05:00+08:00", todos: ["TD-3001", "TD-3002", "TD-3003", "TD-3004", "TD-3005"] }),
          executionStatus: "completed",
          durationMs: 1080,
          presentation: {
            title: "终态回读：4 条完成，1 条保持升级并继续追办",
            detail: [
              { verdict: "pass", text: "完成 4 条", note: "TD-3001 / 3002 / 3003 / 3004 均有责任人提交的完成回执" },
              { verdict: "warn", text: "升级 1 条", note: "TD-3005 仍未完成，升级队列保留，沈建国与周晓芸均可见" },
              { verdict: "pass", text: "责任人与数量一致", note: "5 条追办覆盖周晓芸、刘志强、陈静 3 人；没有重复创建" },
              { verdict: "pass", text: "监测仍在运行", note: "仅对 TD-3005 继续每日检查，完成回执到达后才销项" },
              { insight: "会后追办的终点不是发布一份文档，而是每条行动完成，或在逾期时有明确升级接手", label: "业务结果" },
            ],
            status: "warn",
            panel: [
              { op: "focus", view: "todos" },
              { op: "toolbar", view: "todos", title: "经营会会后追办 · 终态回读", sub: "完成 4 · 升级 1 · 监测 1" },
              { op: "tableRowUpdate", view: "todos", id: "td-3003", set: { cells: { state: "已完成" } } },
              { op: "cellFlag", view: "todos", rowId: "td-3003", colKey: "state", tone: "pass", flag: "08-10 17:20" },
              { op: "tableRowUpdate", view: "todos", id: "td-3004", set: { cells: { state: "已完成" } } },
              { op: "cellFlag", view: "todos", rowId: "td-3004", colKey: "state", tone: "pass", flag: "08-13 17:40" },
              { op: "feedAppend", view: "monitor", item: { id: "mon-final", from: "提醒服务", time: "18:05:00", text: "终态回读：4 条完成；TD-3005 保持升级并继续每日追办" } },
              { op: "feedAppend", view: "audit", item: { id: "ta-8", from: "AI 同事", time: "18:05:00", text: "回读待办、完成回执、提醒事件与升级队列：4 条完成，1 条升级未完成" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "8 条" },
            ],
          },
        },
        {
          id: "mt6-result",
          kind: "tool_result",
          title: "FollowUpReadBack 结果",
          defaultOpen: false,
          toolName: "FollowUpReadBack",
          toolId: "t-readback",
          content: "todos=5 owners=3 completed=4 escalatedOpen=1 duplicates=0 monitorActive=1",
        },
        {
          id: "mt6-text",
          kind: "text",
          title: "会后追办终态",
          defaultOpen: true,
          content: [
            "## 本次会话改变了什么",
            "",
            "| 系统 | 终态 | 核对依据 |",
            "| --- | --- | --- |",
            `| 已确认决议 | ${demoWorldFixture.meeting.confirmedDecisionCount} 条可执行项均有责任人和期限 | 人工补齐 2 格，明确标记补齐人和时间 |`,
            "| 待办中心 | TD-3001…TD-3005 共 5 条，覆盖 3 位责任人；完成 4 条 | 4 份完成回执逐条反向关联原追办 ID |",
            "| 提醒服务 | 临期提醒按到期前 2 小时执行 | 已读回执只记为提醒送达，不冒充完成 |",
            "| 升级队列 | TD-3005 逾期升级给沈建国，原责任人周晓芸不变 | 状态仍为未完成，持续每日监测 |",
            "",
            "## 本次会话没有做什么",
            "",
            "- 没有重新整理会议记录或再发布一份纪要；输入从已确认决议开始，产物是追办看板和行动清单；",
            "- 没有猜责任人或把“本周完成”当成可执行期限；两处缺口均由人补齐后才进入审批；",
            "- 没有在确认前创建待办或通知 3 位责任人；退回分支保持业务系统零写入；",
            "- 没有把已提醒、已读或已升级当成完成；TD-3005 会继续追办，直到完成回执或有权人取消。",
          ].join("\n"),
        },
      ],
    },
  ],

  sources: [
    {
      blockRef: "step1.tool.ConfirmedDecisionQuery",
      producer: "已确认决议台账连接器",
      state: "missing",
      gap: "产品里还没有独立的已确认决议对象与可执行项查询接口；当前只能从会议材料人工整理。",
    },
    {
      blockRef: "step2.tool.FollowUpGapCheck",
      producer: "会后追办字段完整性规则",
      state: "missing",
      gap: "责任人、明确期限、升级人的必填校验尚未产品化，也不能阻止模糊日期直接进入待办。",
    },
    {
      blockRef: "step3.tool.FollowUpBoardBuild",
      producer: "Agent 生成 HTML 追办看板",
      state: "exists",
    },
    {
      blockRef: "step3.artifact.经营会会后追办看板",
      producer: "Agent 生成 HTML 追办看板",
      state: "exists",
    },
    {
      blockRef: "step4.tool.Approval",
      producer: "业务审批执行器",
      state: "needs-change",
      gap: "审批事件已存在，但逐条绑定责任人、期限与升级规则，以及记录人补了哪一格，仍缺结构化字段。",
    },
    {
      blockRef: "step4.tool.BatchTodoCreate",
      producer: "钉钉待办连接器",
      state: "needs-change",
      gap: "可创建待办，但缺会议 ID + 追办 ID 的幂等键、批量回读和完成回执反向关联。",
    },
    {
      blockRef: "step4.tool.FollowUpMonitorEnable",
      producer: "提醒与升级调度器",
      state: "missing",
      gap: "临期提醒、逾期升级、升级不销项和按完成回执停止的组合规则尚未形成可持久化监测对象。",
    },
    {
      blockRef: "step4.tool.ApprovalReject",
      producer: "业务审批执行器（退回分支）",
      state: "needs-change",
      gap: "退回有事件记录，但待办零写入、通知零发送、监测未启用还不能形成统一回执。",
    },
    {
      blockRef: "step5.tool.FollowUpCheckpoint",
      producer: "待办、提醒与升级事件聚合器",
      state: "missing",
      gap: "跨系统聚合完成回执、临期提醒与逾期升级，并保证升级不等于完成，当前没有统一投影。",
    },
    {
      blockRef: "step6.tool.FollowUpReadBack",
      producer: "会后追办终态回读器",
      state: "missing",
      gap: "需要按稳定待办 ID 回读状态、完成回执、提醒事件和升级队列；当前只能人工逐项核对。",
    },
  ],
};

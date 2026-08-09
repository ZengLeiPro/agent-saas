import type { SystemPanelSnapshot } from "@agent/shared";
import type { ReplayScript } from "./types";

/**
 * 钩子剧本：刚开完的经营会，把该办的事都盯起来。
 *
 * 与《会议事实、决定与行动引用可追溯》是两个场景——那一份是目录里的完整版，
 * 这一份是七步短版：口语化入口、决议编号 MTG-0812-#、一次审批门禁收口。
 * 四要素分别落在：
 *   ① 主动拒绝——第 4 步会末那句「回头单聊」不进纪要、不建待办；
 *   ② 视角切换——第 5 步产物就是 8 位参会人点开纪要看到的那一页；
 *   ③ 跨系统核对——第 7 步把决议台账、待办中心、企业 IM 三方摆在一起；
 *   ④ 可下载产物——纪要与决议清单 HTML，右侧预览 + 本地下载。
 * 外加两条：人改掉 AI 的一项并被记账（第 6 步），退回不是死路（rejectedBlocks）。
 *
 * 内容为虚构示例，不对应任何真实企业、会议或人员。
 */

const MINUTES_PATH = "assets/demo/澜达8-12经营会纪要与决议清单.html";

const MINUTES_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<style>
  :root { --brand: #2E56E1; --ink: #0f172a; --muted: #64748b; --line: #e2e8f0; --ok: #15803d; --warn: #b45309; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 20px; font: 14px/1.7 "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; color: var(--ink); background: #fff; }
  .bar { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border: 1px solid var(--line); border-radius: 6px; background: #f8fafc; color: var(--muted); font-size: 12px; margin-bottom: 16px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #cbd5e1; }
  h1 { margin: 0 0 4px; font-size: 16px; }
  .sub { margin: 0 0 16px; color: var(--muted); font-size: 12px; }
  h2.sec { margin: 18px 0 8px; font-size: 13px; color: var(--brand); }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; margin-bottom: 14px; }
  th, td { border: 1px solid var(--line); padding: 7px 9px; text-align: left; vertical-align: top; }
  th { background: #f8fafc; color: var(--muted); font-weight: 500; }
  .no { color: var(--brand); font-weight: 600; white-space: nowrap; }
  .tag { display: inline-block; margin-left: 4px; padding: 0 5px; border-radius: 3px; background: rgba(100, 116, 139, .14); color: var(--muted); font-size: 11px; }
  .hold { color: var(--warn); font-weight: 600; }
  .box { border: 1px solid var(--line); border-radius: 8px; padding: 12px; margin-bottom: 12px; }
  .box h2 { margin: 0 0 8px; font-size: 13px; }
  .box p { margin: 0 0 8px; font-size: 13px; }
  .box p:last-child { margin-bottom: 0; }
  .kv { display: grid; grid-template-columns: 84px 1fr; gap: 4px 12px; font-size: 13px; }
  .kv span:nth-child(odd) { color: var(--muted); }
  .foot { margin-top: 14px; color: var(--muted); font-size: 12px; }
</style></head><body>
<div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span>minutes.landa-precision.internal / meeting / 2026-0812-OPS / v0.9</span></div>

<h1>澜达精密制造有限公司 · 8 月经营会 纪要与决议清单</h1>
<p class="sub">2026-08-12 09:00–09:47 · 主持：总经理 沈建国 · 参会 8 人 · 待确认稿 v0.9（10:24 生成）</p>

<div class="box">
  <h2>会议事实（5 条，均带片段定位）</h2>
  <div class="kv">
    <span>恒岳交付</span><span>SO-2026-1027 ¥86.4 万，8-15 交付，精密轴承缺 400 件 · 出处 S-0042 [00:07:15]</span>
    <span>蓝谷应收</span><span>AR-2026-0058 ¥23.6 万，逾期 18 天 · 出处 S-0071 [00:13:40]</span>
    <span>启润客诉</span><span>NC-2026-0092 外观不良，挂起 6 天未复判 · 出处 S-0108 [00:22:06]</span>
    <span>海川商机</span><span>OPP-2026-0311 ¥120 万二期模具，报价后 22 天无回应 · 出处 S-0150 [00:31:52]</span>
    <span>7 月出货</span><span>¥612 万，环比 -4.3%；8 月在手订单 ¥1,047 万 · 出处 S-0018 [00:03:28]</span>
  </div>
</div>

<h2 class="sec">决议（3 条）</h2>
<table>
  <tr><th>编号</th><th>决议内容</th><th>责任人</th><th>到期</th><th>出处 / 来源</th></tr>
  <tr><td class="no">MTG-0812-1</td><td>蓝谷自动化在 AR-2026-0058 结清前暂停新单排产</td><td>陈静（财务）</td><td>2026-08-14</td><td>S-0079 [00:15:11]</td></tr>
  <tr><td class="no">MTG-0812-2</td><td>客诉复判时限压到 48 小时内出结论，本月起执行</td><td>周晓芸（跟单）<span class="tag">会后补充</span></td><td>2026-08-13<span class="tag">会后补充</span></td><td>S-0119 [00:24:33]，责任人与到期非会上原话</td></tr>
  <tr><td class="no">MTG-0812-3</td><td>恒岳交付风险专项，8-13 前给客户书面交付方案</td><td>周晓芸（跟单）</td><td>2026-08-13</td><td>S-0055 [00:09:47]</td></tr>
</table>

<h2 class="sec">行动项（6 条 · 待确认下发）</h2>
<table>
  <tr><th>序号</th><th>行动项</th><th>责任人</th><th>到期</th><th>来源</th><th>下发状态</th></tr>
  <tr><td class="no">1</td><td>出具 SO-2026-1027 书面交付方案并发恒岳郑海峰</td><td>周晓芸</td><td>08-13</td><td>MTG-0812-3</td><td class="hold">待确认</td></tr>
  <tr><td class="no">2</td><td>核实精密轴承 400 件到货时点并回报</td><td>刘志强</td><td>08-12 18:00</td><td>MTG-0812-3</td><td class="hold">待确认</td></tr>
  <tr><td class="no">3</td><td>蓝谷 AR-2026-0058 催收口径与张明远对齐后再联系</td><td>陈静</td><td>08-14</td><td>MTG-0812-1</td><td class="hold">待确认</td></tr>
  <tr><td class="no">4</td><td>蓝谷账期与信用额度重评</td><td>陈静</td><td>08-19<span class="tag">会后补充</span></td><td>MTG-0812-1</td><td class="hold">待确认</td></tr>
  <tr><td class="no">5</td><td>NC-2026-0092 复判结论出具并回复启润何丽</td><td>周晓芸</td><td>08-13 12:00</td><td>MTG-0812-2</td><td class="hold">待确认</td></tr>
  <tr><td class="no">6</td><td>海川 OPP-2026-0311 本周内当面拜访王志刚</td><td>张明远</td><td>08-15</td><td>会上自由讨论，未形成决议</td><td class="hold">待确认</td></tr>
</table>

<div class="box">
  <h2>出处与补充记录</h2>
  <p><b>MTG-0812-3 原话</b>（片段 S-0055，00:09:47–00:10:26，说话人：总经理 沈建国）：「恒岳这单不能拖。八月十三号之前给客户一个书面的交付方案，写清楚哪天到料、哪天出货，别让人家自己猜。」</p>
  <p><b>MTG-0812-2 补充</b>（2026-08-12 10:18，补充人：总经理办公室）：会上定了 48 小时时限，但没有人认领。责任人「周晓芸」与到期「08-13」为会后确认，非会上原话，已与片段 S-0119 分层存放。</p>
  <p><b>行动项 4 补充</b>（2026-08-12 10:18，补充人：总经理办公室）：会上原话为「找个时间重新评一下」，未给期限；到期「08-19」为会后确认。</p>
  <p><b>未记录事项 1 处</b>：会末有一句「回头单聊」的私下沟通安排，识别为会外事项，未写入本纪要、未创建待办、未进跟进群。</p>
</div>

<p class="foot">本稿为下发前版本：6 条行动项均未创建待办、未群发。记账：采纳 0 项 · 修改 0 项 · 自动执行 0 项。示例内容，虚构企业、人员与数据，不对应任何真实会议。</p>
</body></html>`;

const MINUTES_SIZE_BYTES = new TextEncoder().encode(MINUTES_HTML).length;

/** 面板底稿：会议听记 / 待办中心 / 企业 IM / 权限矩阵 / 操作留痕 */
const PANEL_BASE: SystemPanelSnapshot = {
  title: "企业系统实况",
  live: true,
  activeView: "meeting",
  foot: "已连接：会议听记 · 待办中心 · 企业 IM · 权限矩阵（演示）",
  views: [
    {
      key: "meeting",
      label: "会议听记",
      winTitle: "会议听记 · 8 月经营会",
      toolbar: { title: "8 月经营会 · 2026-08-12", sub: "尚未读取" },
      widget: { kind: "rows", rows: [], empty: { title: "尚未读取会议听记" } },
    },
    {
      key: "todos",
      label: "待办中心",
      winTitle: "待办中心 · 经营会行动项",
      toolbar: { title: "经营会行动项", sub: "尚未下发" },
      widget: {
        kind: "table",
        cols: [
          { key: "item", label: "行动项" },
          { key: "owner", label: "责任人" },
          { key: "due", label: "到期" },
          { key: "state", label: "状态", align: "right" },
        ],
        rows: [],
        empty: { title: "尚未创建任何待办" },
      },
    },
    {
      key: "im",
      label: "企业 IM",
      winTitle: "企业 IM · 8 月经营会跟进群",
      toolbar: { title: "8 月经营会跟进群", sub: "9 人 · 尚无播报" },
      widget: { kind: "feed", items: [], empty: { title: "尚未向群内发布任何内容" } },
    },
    {
      key: "rights",
      label: "权限矩阵",
      winTitle: "权限矩阵 · 本场会议可记录范围",
      toolbar: { title: "权限矩阵 · 由 IT 依会议纪要规则维护", sub: "只读" },
      widget: {
        kind: "table",
        cols: [
          { key: "domain", label: "内容域" },
          { key: "grant", label: "可否记录" },
          { key: "owner", label: "规则来源", align: "right" },
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

export const meetingTodosScript: ReplayScript = {
  scenarioId: "catalog-hook-meeting-todos",
  title: "刚开完的经营会，把该办的事都盯起来",
  mode: "quick",
  artifacts: { [MINUTES_PATH]: MINUTES_HTML },

  steps: [
    {
      caption: "读取经营会听记",
      blocks: [
        {
          id: "mt1-prompt",
          kind: "prompt",
          title: "用户消息",
          defaultOpen: true,
          content: "刚开完的经营会，把该办的事都盯起来。听记应该出来了，沈总下午要问进度。",
        },
        {
          id: "mt1-tool",
          kind: "tool_use",
          title: "MeetingTranscript",
          defaultOpen: true,
          toolName: "MeetingTranscript",
          toolId: "t-transcript",
          content: JSON.stringify({ meeting: "2026-0812-OPS", withAttachments: true }),
          executionStatus: "completed",
          durationMs: 1040,
          presentation: {
            title: "读取 8 月经营会听记",
            detail: [
              { k: "会议", v: "8 月经营会 · 2026-08-12 09:00–09:47" },
              { k: "听记", v: "47 分钟 · 转写 216 片段 · 说话人 8 位" },
              { tree: "├", k: "随附材料", v: "会议议程 1 份" },
              { tree: "└", k: "处理授权", v: "主持人（总经理 沈建国）已授权整理" },
            ],
            status: "ok",
            panelBase: PANEL_BASE,
            panel: [
              { op: "focus", view: "meeting" },
              { op: "toolbar", view: "meeting", title: "8 月经营会 · 2026-08-12", sub: "47 分钟 · 216 片段" },
              { op: "rowInsert", view: "meeting", row: { id: "m-audio", text: "会议听记 · 47 分钟", sub: "216 个转写片段 · 8 位说话人 · 带时点", meta: "已授权" } },
              { op: "rowInsert", view: "meeting", row: { id: "m-agenda", text: "8 月经营会议程.pdf", sub: "总经理办公室 08-11 上传", meta: "0.6 MB" } },
              { op: "rowInsert", view: "meeting", row: { id: "m-roster", text: "参会 8 人", sub: "沈建国 / 张明远 / 赵一楠 / 周晓芸 / 陈静 / 刘志强 / 吴国栋 / 苏婷", meta: "全员到齐" } },
              { op: "feedAppend", view: "audit", item: { id: "au-1", from: "AI 同事", time: "10:12:06", text: "读取 8 月经营会听记与 1 份随附材料（只读）" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "1 条" },
            ],
          },
        },
        {
          id: "mt1-result",
          kind: "tool_result",
          title: "MeetingTranscript 结果",
          defaultOpen: false,
          toolName: "MeetingTranscript",
          toolId: "t-transcript",
          content: "meeting=2026-0812-OPS duration=47min segments=216 speakers=8 attachments=1",
        },
        {
          id: "mt1-text",
          kind: "text",
          title: "业务进展",
          defaultOpen: true,
          content: "47 分钟的听记在手上了。经营会的价值不在纪要本身，在会后有没有人真的去办——所以我按事实、决定、行动分三层拆：决定给编号，行动给责任人和期限。会上没说清的，我原样交给你，不自己补。",
        },
      ],
    },

    {
      caption: "三层抽取，交出两处缺口",
      blocks: [
        {
          id: "mt2-tool",
          kind: "tool_use",
          title: "MinutesExtract",
          defaultOpen: true,
          toolName: "MinutesExtract",
          toolId: "t-extract",
          content: JSON.stringify({ meeting: "2026-0812-OPS", layers: ["fact", "decision", "action"] }),
          executionStatus: "completed",
          durationMs: 1980,
          presentation: {
            title: "按事实 / 决定 / 行动三层抽取",
            detail: [
              { section: "抽取结果" },
              { verdict: "pass", text: "事实 5 条", note: "恒岳 SO-2026-1027 ¥86.4 万 8-15 交付 · 蓝谷 AR-2026-0058 逾期 18 天 · 启润 NC-2026-0092 挂起 6 天 · 海川 OPP-2026-0311 停 22 天 · 7 月出货 ¥612 万环比 -4.3%，全部带片段定位" },
              { verdict: "pass", text: "决议 3 条", note: "MTG-0812-1 蓝谷暂停排产 / MTG-0812-2 客诉复判 48 小时 / MTG-0812-3 恒岳书面交付方案" },
              { verdict: "pass", text: "行动项 6 条", note: "其中 4 条的责任人与期限能从会上原话直接落下来" },
              { section: "主动交出的缺口" },
              { warn: "决议② 客诉复判 48 小时缺责任人——会上没人认领，不替你补" },
              { warn: "行动项 4 蓝谷信用额度重评只说了「找个时间」，那不是期限" },
            ],
            status: "warn",
            panel: [
              { op: "focus", view: "meeting" },
              { op: "toolbar", view: "meeting", title: "8 月经营会 · 抽取结果", sub: "事实 5 · 决议 3 · 行动 6 · 缺口 2" },
              { op: "rowInsert", view: "meeting", row: { id: "m-fact", text: "事实 5 条 · 全部带片段定位", sub: "SO-2026-1027 / AR-2026-0058 / NC-2026-0092 / OPP-2026-0311 / 7 月出货 ¥612 万", state: "hit", badge: { text: "可核对", tone: "pass" } } },
              { op: "rowInsert", view: "meeting", row: { id: "m-decision", text: "决议 3 条 · MTG-0812-1…3", sub: "蓝谷暂停排产 · 客诉复判 48 小时 · 恒岳书面交付方案", state: "hit", badge: { text: "已编号", tone: "pass" } } },
              { op: "rowInsert", view: "meeting", row: { id: "m-gap", text: "2 处缺口，我不替你补", sub: "决议② 无人认领责任人 · 行动项 4 只说了「找个时间」", tone: "warn", badge: { text: "待补", tone: "warn" } } },
              { op: "feedAppend", view: "audit", item: { id: "au-2", from: "AI 同事", time: "10:13:41", text: "三层抽取完成：事实 5 · 决议 3 · 行动 6 · 缺口 2（未写入任何系统）" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "2 条" },
            ],
          },
        },
        {
          id: "mt2-result",
          kind: "tool_result",
          title: "MinutesExtract 结果",
          defaultOpen: false,
          toolName: "MinutesExtract",
          toolId: "t-extract",
          content: "facts=5 decisions=3 actions=6 gaps=2 ids=MTG-0812-1..3",
        },
        {
          id: "mt2-text",
          kind: "text",
          title: "业务进展",
          defaultOpen: true,
          content: [
            "先说**我抽不出来的两条**，这两处我不补：",
            "",
            "1. **决议② 客诉复判压到 48 小时** —— 时限定了，但从头到尾没人认领。听记里最接近的一句是「这个我们回头安排一下」，那不是责任人承诺，我不能把它写成责任人。",
            "2. **行动项 4 蓝谷账期与信用额度重评** —— 有责任人（陈静），但没有时间点。原话是「找个时间重新评一下」，「找个时间」不是期限。",
            "",
            "其余 4 条行动项的责任人和期限都能从会上原话直接落下来，我按原话记，一个字没加。",
          ].join("\n"),
        },
      ],
    },

    {
      caption: "口头补齐缺口并写入决议台账",
      blocks: [
        {
          id: "mt3-prompt",
          kind: "prompt",
          title: "用户消息",
          defaultOpen: true,
          content: "决议②的责任人是周晓芸，客诉复判归她盯，13 号前给结论。行动项 4 那条信用额度重评，给到 8 月 19 号。这两条我刚跟沈总当面确认过。",
        },
        {
          id: "mt3-tool",
          kind: "tool_use",
          title: "DecisionLedger",
          defaultOpen: true,
          toolName: "DecisionLedger",
          toolId: "t-ledger",
          content: JSON.stringify({ ledger: "MTG-0812", fill: ["MTG-0812-2.owner", "MTG-0812-2.due", "action-4.due"] }),
          executionStatus: "completed",
          durationMs: 720,
          presentation: {
            title: "回填缺口并写入决议台账",
            detail: [
              { k: "决议②", v: "责任人 周晓芸（跟单）· 到期 2026-08-13" },
              { k: "行动项 4", v: "到期 2026-08-19 · 责任人陈静为会上原话，未改" },
              { quote: "这个我们回头安排一下", source: "S-0119 [00:24:33] · 会上原话，与「周晓芸」分层存放" },
              { tree: "├", k: "来源分层", v: "2 处补充记为「会后补充」，与会上原话分开存放" },
              { tree: "└", k: "台账版本", v: "MTG-0812 v0.9 草稿 · 补充人与补充时间绑定到本版本" },
            ],
            status: "ok",
            receipt: { id: "MTG-0812-v0.9", system: "决议台账", readBack: true },
            panel: [
              { op: "focus", view: "meeting" },
              { op: "toolbar", view: "meeting", title: "8 月经营会 · 抽取结果", sub: "事实 5 · 决议 3 · 行动 6 · 缺口 0" },
              { op: "rowUpdate", view: "meeting", id: "m-fact", set: { state: "normal", badge: { text: "已核对", tone: "info" } } },
              { op: "rowUpdate", view: "meeting", id: "m-decision", set: { state: "normal", badge: { text: "已编号", tone: "info" } } },
              { op: "rowUpdate", view: "meeting", id: "m-gap", set: { text: "2 处缺口已补齐", sub: "标注为「会后补充」，不混进会上原话", state: "hit", tone: "pass", badge: { text: "已补齐", tone: "pass" } } },
              { op: "rowInsert", view: "meeting", row: { id: "m-ledger", text: "决议台账 MTG-0812 · v0.9", sub: "会后补充 2 处 · 补充人：总经理办公室 · 08-12 10:18", meta: "草稿", badge: { text: "未下发", tone: "pending" } } },
              { op: "feedAppend", view: "audit", item: { id: "au-3", from: "AI 同事", time: "10:18:22", text: "写入决议台账 MTG-0812 v0.9 并回读校验通过：补齐 2 处，全部标记为会后补充" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "3 条" },
            ],
          },
        },
        {
          id: "mt3-result",
          kind: "tool_result",
          title: "DecisionLedger 结果",
          defaultOpen: false,
          toolName: "DecisionLedger",
          toolId: "t-ledger",
          content: "ledger=MTG-0812 version=v0.9 filled=3 provenance=post-meeting readBack=ok",
        },
        {
          id: "mt3-text",
          kind: "text",
          title: "业务进展",
          defaultOpen: true,
          content: "两处都回填了，也都打上了「会后补充」的标记。为什么要费这个事：会上原话带着片段号和时间码，是能当场核对的；你刚给的责任人和期限是散会之后定的。这两种东西混在同一张表里，下个月追进度时没人分得清哪句是沈总当场说的、哪句是后来补的，所以我把它们分开放。",
        },
      ],
    },

    {
      caption: "会外单聊不进纪要",
      blocks: [
        {
          id: "mt4-prompt",
          kind: "prompt",
          title: "用户消息",
          defaultOpen: true,
          content: "对了，沈总散会前说了句「小王那个事回头单聊」，这个也一起记上吧，免得忘了。",
        },
        {
          id: "mt4-tool",
          kind: "tool_use",
          title: "MinutesScope",
          defaultOpen: true,
          toolName: "MinutesScope",
          toolId: "t-scope",
          content: JSON.stringify({ meeting: "2026-0812-OPS", segment: "S-0208", action: "record" }),
          executionStatus: "completed",
          durationMs: 240,
          presentation: {
            title: "会末一句话的记录范围判定",
            detail: [
              { k: "请求记录", v: "会末片段 S-0208「小王那个事回头单聊」" },
              { k: "判定", v: "会外私下沟通，不属于本场会议的决议范围" },
              { indent: 0, text: "⚠ 无业务对象、无责任人、无期限，抽不出可落地的行动项" },
              { verdict: "fail", text: "不写入纪要，不创建待办", note: "未记录任何内容 · 判定已记账" },
            ],
            status: "blocked",
            panel: [
              { op: "focus", view: "rights" },
              { op: "toolbar", view: "rights", title: "权限矩阵 · 本场会议可记录范围", sub: "命中 1 条拒绝" },
              { op: "tableRowInsert", view: "rights", row: { id: "g-record", cells: { domain: "会议听记（本场）", grant: "允许", owner: "主持人授权" } } },
              { op: "tableRowInsert", view: "rights", row: { id: "g-decision", cells: { domain: "决议与行动项", grant: "允许", owner: "会议纪要规则" } } },
              { op: "tableRowInsert", view: "rights", row: { id: "g-private", cells: { domain: "会外单聊安排", grant: "拒绝", owner: "会议纪要规则" }, tone: "deny" } },
              { op: "cellFlag", view: "rights", rowId: "g-private", colKey: "grant", tone: "deny", flag: "不予记录" },
              { op: "tableRowInsert", view: "rights", row: { id: "g-chat", cells: { domain: "员工私聊会话", grant: "拒绝", owner: "权限矩阵" } } },
              { op: "rowUpdate", view: "meeting", id: "m-gap", set: { state: "normal", badge: { text: "已补齐", tone: "info" } } },
              { op: "feedAppend", view: "audit", item: {
                id: "au-4",
                from: "AI 同事",
                time: "10:19:05",
                text: "会末片段 S-0208 判定为会外事项，未写入纪要、未创建待办",
                card: { title: "已识别为会外事项", body: "「回头单聊」属私下沟通安排，不进纪要、不进跟进群", meta: [{ text: "未记录内容", tone: "pass" }, { text: "已记账", tone: "info" }] },
              } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "4 条" },
            ],
          },
        },
        {
          id: "mt4-text",
          kind: "text",
          title: "回复",
          defaultOpen: true,
          content: [
            "**这句我不记**。「单聊」这两个字本身就说明沈总没打算把它放进这场会——而且这句话里没有业务对象、没有责任人、没有期限，我抽不出任何一条能落地的行动项，硬记进去也是一行谁都不知道该干什么的字。",
            "",
            "强行写进纪要有两个坏处：一是把一次私下沟通变成跟进群里 9 个人都看得见的事项；二是万一「小王那个事」是人事或私人安排，我等于替沈总公开了他没打算公开的东西。",
            "",
            "真要跟进的话有两条路：请沈总会外单独发起，或者下次会上正式提出、当场认领责任人和期限，那时候我再记。右侧留痕里我只留了一行「已识别为会外事项」，内容本身没有落到任何地方。",
          ].join("\n"),
        },
      ],
    },

    {
      caption: "生成纪要与决议清单",
      blocks: [
        {
          id: "mt5-tool",
          kind: "tool_use",
          title: "MinutesCompose",
          defaultOpen: true,
          toolName: "MinutesCompose",
          toolId: "t-compose",
          content: JSON.stringify({ ledger: "MTG-0812", version: "v0.9", format: "html" }),
          executionStatus: "completed",
          durationMs: 1360,
          presentation: {
            title: "生成 8-12 经营会纪要与决议清单",
            detail: [
              { k: "文档", v: "8-12 经营会纪要与决议清单 · v0.9 待确认稿" },
              { k: "内容", v: "事实 5 条 · 决议 3 条（MTG-0812-1…3）· 行动项 6 条" },
              { tree: "├", k: "交叉引用", v: "SO-2026-1027 · AR-2026-0058 · NC-2026-0092 · OPP-2026-0311" },
              { tree: "└", k: "下发状态", v: "6 条行动项均未创建待办 · 未群发，等你确认" },
            ],
            status: "waiting",
            panel: [
              { op: "focus", view: "meeting" },
              { op: "toolbar", view: "meeting", title: "8 月经营会 · 纪要与决议清单", sub: "v0.9 待确认稿 · 待下发 6 条" },
              { op: "rowUpdate", view: "meeting", id: "m-ledger", set: { text: "纪要与决议清单 v0.9（待确认稿）", sub: "决议 3 条 · 行动项 6 条 · 一条都还没下发", state: "hit", tone: "pending", badge: { text: "待确认", tone: "pending" } } },
              { op: "toolbar", view: "todos", title: "经营会行动项", sub: "0 条 · 等待确认" },
              { op: "feedAppend", view: "audit", item: { id: "au-5", from: "AI 同事", time: "10:24:10", text: "生成纪要与决议清单 v0.9 待确认稿；未创建待办、未群发" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "5 条" },
            ],
          },
        },
        {
          id: "mt5-text",
          kind: "text",
          title: "回复",
          defaultOpen: true,
          content: [
            "纪要和决议清单出好了，**这份就是 8 位参会人点开会看到的那一页**：",
            "",
            `[FILE]{"filePath":"${MINUTES_PATH}","fileName":"澜达8-12经营会纪要与决议清单.html","fileSize":${MINUTES_SIZE_BYTES}}[/FILE]`,
            "",
            "三条决议都有编号，MTG-0812-1 到 MTG-0812-3。编号背后绑着三样东西：会上原话的片段定位、责任人与期限、以及这条决议牵着的业务单号。往后谁问「恒岳那份书面交付方案是谁定的、几号定的」，从 SO-2026-1027 就能一路点回 8 月 12 日会上第 10 分钟沈总那句原话。",
            "",
            "现在它还是待确认稿：6 条行动项一条都没下发，没进任何人的待办，跟进群里也是安静的。",
          ].join("\n"),
        },
      ],
    },

    {
      caption: "有权人确认下发",
      blocks: [],
      approval: {
        title: "下发行动项并群发纪要 · 需有权人确认",
        description: "确认后才会创建待办、发布纪要版本并向跟进群播报。这一步会改变业务系统，必须由有权人明确确认。",
        facts: [
          { label: "会议纪要", value: "MTG-0812 v0.9 待确认稿 · 决议 3 条" },
          { label: "待创建待办", value: "6 条 · 覆盖 4 位责任人" },
          { label: "最近到期", value: "08-12 18:00 · 轴承到货时点回报（刘志强）" },
          { label: "群发范围", value: "8 月经营会跟进群 9 人" },
        ],
        approveLabel: "确认下发",
        rejectLabel: "退回修改",
        approvedBlocks: [
          {
            id: "mt6-human",
            kind: "prompt",
            title: "用户消息",
            defaultOpen: true,
            content: "第 6 条别下待办。海川王总那边我自己打个电话——报价压了 22 天没回音，这时候让张明远追上去反而掉价。这条从清单里去掉，我线下处理。其余 5 条照发。",
          },
          {
            id: "mt6-approve",
            kind: "tool_use",
            title: "Approval",
            defaultOpen: true,
            toolName: "Approval",
            toolId: "t-approve",
            content: JSON.stringify({ ledger: "MTG-0812", decision: "approved", edits: 1 }),
            executionStatus: "completed",
            durationMs: 310,
            presentation: {
              title: "下发已确认 · 含人工修改 1 项",
              detail: [
                { k: "审批结果", v: "确认下发" },
                { k: "记账", v: "采纳 5 项 · 修改 1 项 · 自动执行 0 项" },
                { no: 1, text: "行动项 6「海川 OPP-2026-0311 本周内当面拜访」改为总经理线下处理，不创建待办、不进群" },
                { tree: "├", k: "原建议", v: "张明远 · 08-15 前当面拜访；保留在 v0.9 待确认稿中，未删除" },
                { tree: "└", k: "留痕", v: "修改人、修改时间与生效版本 v1.0 一并记录" },
              ],
              status: "ok",
              receipt: { id: "APR-0812-01", system: "审批中心", readBack: true },
              panel: [
                { op: "focus", view: "meeting" },
                { op: "toolbar", view: "meeting", title: "8 月经营会 · 纪要与决议清单", sub: "v1.0 发布版 · 人工修改 1 项" },
                { op: "rowUpdate", view: "meeting", id: "m-ledger", set: { text: "纪要与决议清单 v1.0（发布版）", sub: "人工修改 1 项 · 修改人：总经理 沈建国 · 08-12 10:31", meta: "已定稿", state: "hit", tone: "pass", badge: { text: "定稿", tone: "pass" } } },
                { op: "feedAppend", view: "audit", item: {
                  id: "au-6",
                  from: "总经理 沈建国",
                  time: "10:31:48",
                  text: "确认下发：采纳 5 项、修改 1 项（行动项 6 改为线下处理）、自动执行 0 项",
                  card: { title: "人审记录", body: "采纳 5 · 修改 1 · 自动执行 0；AI 原建议保留在 v0.9 待确认稿", meta: [{ text: "AI 未自行下发", tone: "pass" }, { text: "原建议已留档", tone: "info" }] },
                } },
                { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "6 条" },
              ],
            },
          },
          {
            id: "mt6-todo",
            kind: "tool_use",
            title: "TodoDispatch",
            defaultOpen: true,
            toolName: "TodoDispatch",
            toolId: "t-todo",
            content: JSON.stringify({ ledger: "MTG-0812", version: "v1.0", todos: 5 }),
            executionStatus: "completed",
            durationMs: 1120,
            presentation: {
              title: "创建待办 · 5 条 · 4 位责任人",
              detail: [
                { k: "创建", v: "TD-1204 … TD-1208 · 逐条回读校验通过 · 无重复创建" },
                { k: "最近到期", v: "TD-1205 今天 18:00 · 刘志强 · 轴承 400 件到货时点回报" },
                { tree: "├", k: "未创建", v: "行动项 6 · 总经理线下处理，待办中心留一行「线下处理」备查" },
                { tree: "└", k: "到期提醒", v: "到期前 2 小时提醒责任人，逾期升级给总经理" },
              ],
              status: "ok",
              receipt: { id: "TD-1204…1208", system: "待办中心", readBack: true },
              panel: [
                { op: "focus", view: "todos" },
                { op: "toolbar", view: "todos", title: "经营会行动项 · 已下发", sub: "5 条 · 已接收 5 · 线下处理 1" },
                { op: "tableRowInsert", view: "todos", row: { id: "td-1204", cells: { item: "TD-1204 出具 SO-2026-1027 书面交付方案", owner: "周晓芸（跟单）", due: "08-13", state: "已接收" } } },
                { op: "tableRowInsert", view: "todos", row: { id: "td-1205", cells: { item: "TD-1205 核实精密轴承 400 件到货时点", owner: "刘志强（采购）", due: "08-12 18:00", state: "已接收" } } },
                { op: "cellFlag", view: "todos", rowId: "td-1205", colKey: "due", tone: "warn", flag: "今天到期" },
                { op: "tableRowInsert", view: "todos", row: { id: "td-1206", cells: { item: "TD-1206 蓝谷 AR-2026-0058 催收口径与张明远对齐", owner: "陈静（财务）", due: "08-14", state: "已接收" } } },
                { op: "tableRowInsert", view: "todos", row: { id: "td-1207", cells: { item: "TD-1207 蓝谷账期与信用额度重评", owner: "陈静（财务）", due: "08-19", state: "已接收" } } },
                { op: "cellFlag", view: "todos", rowId: "td-1207", colKey: "due", tone: "info", flag: "会后补充" },
                { op: "tableRowInsert", view: "todos", row: { id: "td-1208", cells: { item: "TD-1208 NC-2026-0092 复判结论并回复启润", owner: "周晓芸（跟单）", due: "08-13 12:00", state: "已接收" } } },
                { op: "tableRowInsert", view: "todos", row: { id: "td-none", cells: { item: "海川 OPP-2026-0311 当面拜访", owner: "沈建国（总经理）", due: "—", state: "未创建" }, tone: "info" } },
                { op: "cellFlag", view: "todos", rowId: "td-none", colKey: "state", tone: "info", flag: "改为线下处理" },
                { op: "feedAppend", view: "audit", item: { id: "au-7", from: "AI 同事", time: "10:31:59", text: "创建 5 条待办 TD-1204…1208 并逐条回读；行动项 6 未创建，按总经理决定线下处理" } },
                { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "7 条" },
              ],
            },
          },
          {
            id: "mt6-broadcast",
            kind: "tool_use",
            title: "GroupBroadcast",
            defaultOpen: false,
            toolName: "GroupBroadcast",
            toolId: "t-broadcast",
            content: JSON.stringify({ group: "8 月经营会跟进", card: "decision-summary" }),
            executionStatus: "completed",
            durationMs: 390,
            presentation: {
              title: "向跟进群播报决议卡 · 9 人",
              detail: [
                { k: "播报内容", v: "纪要 v1.0 发布通知 + 决议卡 1 张（标注含人工修改 1 项）" },
                { tree: "└", k: "未播报", v: "行动项 6 不在卡片里，群里 9 人看不到这条" },
              ],
              status: "ok",
              receipt: { id: "IM-0812-1", system: "企业 IM", readBack: true },
              panel: [
                { op: "focus", view: "im" },
                { op: "toolbar", view: "im", title: "8 月经营会跟进群", sub: "9 人 · 1 条播报" },
                { op: "feedAppend", view: "im", item: {
                  id: "im-1",
                  from: "AI 同事",
                  time: "10:32:14",
                  text: "@全体成员 8-12 经营会纪要 v1.0 已发布，5 条行动项已按责任人下发到各位待办。",
                  card: { title: "8 月经营会 · 决议与行动项", body: "决议 3 条（MTG-0812-1…3）· 行动项 5 条 · 最近到期今天 18:00（TD-1205 轴承到货时点回报）", meta: [{ text: "v1.0 已发布", tone: "pass" }, { text: "含人工修改 1 项", tone: "warn" }] },
                } },
                { op: "feedAppend", view: "audit", item: { id: "au-8", from: "AI 同事", time: "10:32:14", text: "发布纪要 v1.0；向 8 月经营会跟进群播报 1 条决议卡（9 人可见）" } },
                { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "8 条" },
              ],
            },
          },
          {
            id: "mt6-text",
            kind: "text",
            title: "审批结果",
            defaultOpen: true,
            content: [
              "5 条待办已经躺进各人的待办中心，编号 TD-1204 到 TD-1208。最近的一条是刘志强今天 18:00 到期的轴承到货核实——它卡着 MTG-0812-3 那份交付方案，先有到货时点才写得出「哪天出货」。",
              "",
              "第 6 条按你说的撤了，待办中心里留了一行「改为线下处理」，不是删干净。**我的原建议也没有被覆盖掉**，它还在你刚下载的那份待确认稿里。往后海川这单要是真丢了，翻得到当时我建议派人去、你决定自己打电话——这不是给谁记账，是让下一次的判断有依据。",
              "",
              "群里那张决议卡写着「含人工修改 1 项」，参会人看到的版本和你批的是同一份，不存在对内一套、对外一套。",
            ].join("\n"),
          },
        ],
        rejectedBlocks: [
          {
            id: "mt6-rejected-tool",
            kind: "tool_use",
            title: "Approval",
            defaultOpen: true,
            toolName: "Approval",
            toolId: "t-reject",
            content: JSON.stringify({ ledger: "MTG-0812", decision: "rejected" }),
            executionStatus: "completed",
            durationMs: 250,
            presentation: {
              title: "下发被退回 · 没有任何东西发出去",
              detail: [
                { k: "审批结果", v: "退回修改" },
                { k: "待办中心", v: "未创建 · 0 条" },
                { k: "会议纪要", v: "未发布 · 停在 v0.9 待确认稿" },
                { k: "跟进群", v: "未播报 · 9 人无感知" },
                { tree: "└", k: "留痕", v: "退回人、退回时间与当时稿件版本已记账，等待重新提交" },
              ],
              status: "blocked",
              panel: [
                { op: "focus", view: "todos" },
                { op: "toolbar", view: "todos", title: "经营会行动项", sub: "未下发 · 退回已记账" },
                { op: "toolbar", view: "im", title: "8 月经营会跟进群", sub: "9 人 · 未播报" },
                { op: "rowUpdate", view: "meeting", id: "m-ledger", set: { sub: "审批退回，停在 v0.9 待确认稿 · 退回时间 08-12 10:31", tone: "warn", badge: { text: "已退回", tone: "warn" } } },
                { op: "feedAppend", view: "audit", item: { id: "au-reject", from: "总经理 沈建国", time: "10:31:48", text: "下发被退回：待办未创建、纪要未发布、跟进群未播报，稿件停在 v0.9" } },
                { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "6 条" },
              ],
            },
          },
          {
            id: "mt6-rejected-text",
            kind: "text",
            title: "退回说明",
            defaultOpen: true,
            content: "停住了：待办 0 条、纪要停在 v0.9 待确认稿、跟进群没收到任何东西，9 位参会人对此无感知。退回这件事本身也记了账——谁退的、什么时候退的、退的是哪一版。你把要改的地方说清楚我重出一稿，仍然要你再确认一次，不会因为「上次已经看过」就自动放行。清单你现在还能下载，它没有因为退回而消失。",
          },
        ],
      },
    },

    {
      caption: "跨系统核对终态",
      blocks: [
        {
          id: "mt7-tool",
          kind: "tool_use",
          title: "ReadBack",
          defaultOpen: true,
          toolName: "ReadBack",
          toolId: "t-readback",
          content: JSON.stringify({ ledger: "MTG-0812", version: "v1.0" }),
          executionStatus: "completed",
          durationMs: 980,
          presentation: {
            title: "回读三个系统，核对说法是否一致",
            detail: [
              { k: "回读方式", v: "按对象编号逐个反查，不用本次会话的缓存" },
              { verdict: "pass", text: "决议台账", note: "MTG-0812-1…3 均可解析 · 版本 v1.0 · 会后补充 2 处分层可见" },
              { verdict: "pass", text: "待办中心", note: "TD-1204…1208 五条状态为已接收，无重复创建；1 条标记线下处理" },
              { verdict: "pass", text: "企业 IM", note: "播报 1 条，卡片内容与 v1.0 决议表逐条比对一致" },
              { insight: "三方一致，无未决动作", label: "结论" },
            ],
            status: "ok",
            panel: [
              { op: "focus", view: "audit" },
              { op: "toolbar", view: "meeting", title: "8 月经营会 · 终态回读", sub: "决议 3 条 · 三方一致" },
              { op: "feedAppend", view: "audit", item: { id: "au-9", from: "AI 同事", time: "10:32:40", text: "回读决议台账 / 待办中心 / 企业 IM，三方状态一致，无未决任务" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "9 条" },
            ],
          },
        },
        {
          id: "mt7-result",
          kind: "tool_result",
          title: "ReadBack 结果",
          defaultOpen: false,
          toolName: "ReadBack",
          toolId: "t-readback",
          content: "ledger=v1.0 decisions=3 todos=5/5 accepted offline=1 broadcast=1 consistent=true pending=0",
        },
        {
          id: "mt7-text",
          kind: "text",
          title: "本次会话改变了什么",
          defaultOpen: true,
          content: [
            "## 本次会话改变了什么",
            "",
            "| 系统 | 终态 | 依据 |",
            "| --- | --- | --- |",
            "| 决议台账 | MTG-0812-1…3 三条决议定稿为 v1.0 | 每条绑定片段定位与业务单号 |",
            "| 待办中心 | TD-1204…1208 五条已下发并回读，4 位责任人已接收 | 到期前 2 小时提醒，逾期升级给总经理 |",
            "| 企业 IM | 8 月经营会跟进群 1 条决议卡，9 人可见 | 卡片标注「含人工修改 1 项」 |",
            "",
            "## 本次会话没有做什么",
            "",
            "- 没有替你补缺口：决议② 的责任人、行动项 4 的期限都是你补的，单独标为会后补充，不和会上原话混放；",
            "- 没有记录单聊：会末那句「回头单聊」既没进纪要，也没建待办，留痕里只有一行「已识别为会外事项」；",
            "- 没有替任何人确认完成时间：5 条待办的期限都来自会上原话或你的口头补充，我没有替谁承诺哪天能做完；",
            "- 没有自动下发：待办创建、纪要发布、群播报三件事卡在同一个确认点后面，自动执行 0 项；",
            "- 没有碰业务单据：SO-2026-1027、AR-2026-0058、NC-2026-0092、OPP-2026-0311 只被引用，单据本身一个字没动。",
          ].join("\n"),
        },
        {
          id: "mt7-next",
          kind: "text",
          title: "接下来",
          defaultOpen: true,
          content: "这套盯法可以常驻：到期前我提醒责任人，逾期了直接升级给你，你不用记着哪条该催——想让它跑起来，随时说一声就行。",
        },
      ],
    },
  ],

  // 治理条款：state != exists 的条目就是「演示到真实」的距离
  sources: [
    {
      blockRef: "step1.tool.MeetingTranscript",
      producer: "钉钉 DWS 连接器",
      state: "needs-change",
      gap: "DWS 能取到听记文本，但返回里没有「片段编号 + 起止时间 + 说话人」的结构化字段，出处定位要靠产品侧自建片段索引；也不产出 presentation",
    },
    {
      blockRef: "step2.tool.MinutesExtract",
      producer: "Agent 三层抽取（事实 / 决定 / 行动）",
      state: "exists",
    },
    {
      blockRef: "step3.tool.DecisionLedger",
      producer: "租户业务数据连接器（决议台账写入 + 回读）",
      state: "missing",
      gap: "决议台账这个业务对象在产品里不存在，「会上原话 / 会后补充」的来源分层、版本号与补充人绑定都无处落；写后回读回执同样没有产出方",
    },
    {
      blockRef: "step4.tool.MinutesScope",
      producer: "会议记录范围门禁",
      state: "needs-change",
      gap: "拒绝话术与替代路径已有可复用形态，但「哪些片段属于会外事项」目前靠 Agent 临场判断，没有可配置的记录范围规则与判定留痕",
    },
    {
      blockRef: "step5.tool.MinutesCompose",
      producer: "Agent 生成 HTML 产物",
      state: "exists",
    },
    {
      blockRef: "step6.tool.Approval",
      producer: "业务审批执行器",
      state: "needs-change",
      gap: "审批事件在 runtime 已成对记录，但「人改了哪一条、原建议是什么、改成什么」没有结构化字段，只能落在自由文本里",
    },
    {
      blockRef: "step6.tool.TodoDispatch",
      producer: "钉钉 DWS 连接器",
      state: "needs-change",
      gap: "DWS 可创建待办，但「待办 ↔ 决议编号」的反向索引、写后回读回执、到期提醒与逾期升级都没有产品化配置",
    },
    {
      blockRef: "step6.tool.GroupBroadcast",
      producer: "钉钉 DWS 连接器",
      state: "needs-change",
      gap: "DWS 可发群消息，但决议卡模板与「播报内容 ↔ 纪要版本」的绑定校验不存在，播报后也不回读",
    },
    {
      blockRef: "step6.tool.ApprovalReject",
      producer: "业务审批执行器（退回分支）",
      state: "needs-change",
      gap: "退回分支只有事件记录，缺「本次退回时稿件停在哪一版」的快照绑定，重新提交时无法自动比出改了什么",
    },
    {
      blockRef: "step7.tool.ReadBack",
      producer: "租户业务数据连接器（终态回读）",
      state: "missing",
      gap: "跨系统回读要先有决议台账、待办、群消息三方的稳定对象编号；在此之前终态核对表只能人工整理",
    },
    {
      blockRef: "step5.artifact.澜达8-12经营会纪要与决议清单",
      producer: "Agent 生成 HTML 产物",
      state: "exists",
    },
  ],
};

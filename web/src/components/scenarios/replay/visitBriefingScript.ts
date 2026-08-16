import type { SystemPanelSnapshot } from "@agent/shared";
import { demoWorldFixture } from "./demoWorldFixture";
import type { ReplayScript } from "./types";

/**
 * 剧本：明天要见客户，帮我快速拉齐。
 *
 * 岗位视角是销售。四要素落位：
 *   ① 主动拒绝——第 4 步要查联系人个人背景被拦下，给公开信息的替代路径；
 *   ② 视角切换——第 6 步产物就是客户此刻在手机上收到的那条消息；
 *   ③ 跨系统核对——终态用一张表把五个系统的说法摆在一起；
 *   ④ 可下载产物——拜访简报一页纸，右侧预览 + 本地下载。
 * 外加：第 2 步主动交出「我方欠客户一份报告」，第 6 步人改掉 AI 的一项并被记账。
 *
 * 内容为示例数据，不对应任何真实企业、订单或商机。
 */

const BRIEFING_PATH = "assets/demo/海川机械拜访简报.html";

const BRIEFING_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<style>
  :root { --brand: #2E56E1; --ink: #0f172a; --muted: #64748b; --line: #e2e8f0; --ok: #15803d; --warn: #b45309; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 20px; font: 14px/1.7 "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; color: var(--ink); background: #fff; }
  .bar { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border: 1px solid var(--line); border-radius: 6px; background: #f8fafc; color: var(--muted); font-size: 12px; margin-bottom: 16px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #cbd5e1; }
  h1 { margin: 0 0 4px; font-size: 16px; }
  .sub { margin: 0 0 16px; color: var(--muted); font-size: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 4px; }
  th, td { border: 1px solid var(--line); padding: 7px 10px; text-align: left; vertical-align: top; }
  th { background: #f8fafc; color: var(--muted); font-weight: 500; }
  .ok { color: var(--ok); font-weight: 600; }
  .warn { color: var(--warn); font-weight: 600; }
  .box { border: 1px solid var(--line); border-radius: 8px; padding: 12px; margin-bottom: 12px; }
  .box.alert { border-color: #fcd34d; background: #fffbeb; }
  .box h2 { margin: 0 0 8px; font-size: 13px; }
  .kv { display: grid; grid-template-columns: 88px 1fr; gap: 4px 12px; font-size: 13px; }
  .kv span:nth-child(odd) { color: var(--muted); }
  ul { margin: 0; padding-left: 18px; font-size: 13px; }
  li { margin-bottom: 4px; }
  .foot { margin-top: 14px; color: var(--muted); font-size: 12px; }
</style></head><body>
<div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span>拜访简报 / OPP-2026-0311 / 2026-08-10</span></div>

<h1>海川机械 · 拜访简报</h1>
<p class="sub">拜访人 张明远 · 对象 王志刚 副总（拍板人）· 时间 2026-08-10 10:30 · 地点 海川机械</p>

<div class="box">
  <h2>一、这趟去解决什么</h2>
  <div class="kv">
    <span>主线</span><span>OPP-2026-0311 二期模具 ¥120 万，停在「方案已报」22 天</span>
    <span>我方欠账</span><span>${demoWorldFixture.haichuanReport.code} ${demoWorldFixture.haichuanReport.name}，承诺 ${demoWorldFixture.haichuanReport.promisedDate} 前给，截至 ${demoWorldFixture.demoDate.iso} 逾期 ${demoWorldFixture.haichuanReport.overdueDays} 天</span>
    <span>关联客诉</span><span>${demoWorldFixture.openComplaint.id} ${demoWorldFixture.openComplaint.issue}，${demoWorldFixture.openComplaint.openedDate} 受理，已挂起 ${demoWorldFixture.openComplaint.suspendedDays} 天</span>
    <span>来源</span><span>《本周客户推进清单》${demoWorldFixture.demoDate.short} 第 1 条 · 待办 TD-1181</span>
  </div>
</div>

<div class="box">
  <h2>二、可以主动拿出来讲的三个数</h2>
  <table>
    <tr><th>事实</th><th>数据</th><th>怎么用</th></tr>
    <tr><td>一期交付</td><td>SO-2026-0418 ¥78.5 万，承诺 4-25 / 实交 4-28</td><td class="ok">延期 3 天，验收一次通过，可主动交底</td></tr>
    <tr><td>一期质量</td><td>交付后零质量客诉</td><td class="ok">二期扩量的直接依据</td></tr>
    <tr><td>回款</td><td>6-27 全额结清，账期 60 天内</td><td class="ok">说明双方履约都干净</td></tr>
  </table>
</div>

<div class="box">
  <h2>三、他大概率会问的三件事</h2>
  <table>
    <tr><th>他会问</th><th>为什么会问</th><th>怎么答</th></tr>
    <tr><td>样件报告到底什么时候给</td><td>8-05 群里问过一次，我方未回</td><td class="warn">先认账，当面交纸质版，给出后续节点</td></tr>
    <tr><td>二期这个价还能不能再降</td><td>方案报出 22 天未动，价格是常见卡点</td><td>只给依据：一期单价 ¥1,860/套、整单折让 4.2%、二期量约 1,400 套；<b>底线由张明远现场定</b></td></tr>
    <tr><td>包装破损那批怎么算</td><td>${demoWorldFixture.openComplaint.id} 挂起 ${demoWorldFixture.openComplaint.suspendedDays} 天</td><td class="warn">只讲处理进度与时间点，不预设责任归属</td></tr>
  </table>
</div>

<div class="box">
  <h2>四、明天带的东西</h2>
  <ul>
    <li>${demoWorldFixture.haichuanReport.code} ${demoWorldFixture.haichuanReport.name} 纸质版 ×2（待办 TD-1191，8-10 08:30 前备好）</li>
    <li>一期履约一页纸：交期、验收、回款三行数据</li>
    <li>二期方案原件（7-18 已发版本，不带新报价）</li>
  </ul>
</div>

<div class="box alert">
  <h2>五、这两件我不替你决定</h2>
  <ul>
    <li>二期降价底线：我只提供一期成交条件与二期估算量，毛利明细不在销售岗位的可读范围，也没有读取。</li>
    <li>包装客诉的责任归属：质检复判结论未出，现场不要认，也不要否认。</li>
  </ul>
</div>

<p class="foot">示例内容，不对应任何真实企业、订单或商机。</p>
</body></html>`;

const BRIEFING_SIZE_BYTES = new TextEncoder().encode(BRIEFING_HTML).length;
const CLIENT_VIEW_PATH = "assets/demo/拜访确认消息-客户端视图.html";

const CLIENT_VIEW_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<style>
  :root { --ink: #0f172a; --muted: #64748b; --line: #e2e8f0; --bubble: #2E56E1; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 20px; font: 14px/1.7 "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; color: var(--ink); background: #f1f5f9; }
  .phone { max-width: 380px; margin: 0 auto; background: #fff; border: 1px solid var(--line); border-radius: 18px; overflow: hidden; }
  .top { padding: 10px 14px; background: #f8fafc; border-bottom: 1px solid var(--line); font-size: 12px; color: var(--muted); display: flex; justify-content: space-between; }
  .who { padding: 12px 14px 4px; font-size: 13px; font-weight: 600; }
  .who small { display: block; font-weight: 400; color: var(--muted); font-size: 12px; margin-top: 2px; }
  .chat { padding: 12px 14px 18px; }
  .stamp { text-align: center; color: var(--muted); font-size: 11px; margin: 6px 0 10px; }
  .msg { background: var(--bubble); color: #fff; border-radius: 12px 12px 12px 4px; padding: 10px 12px; font-size: 13px; line-height: 1.75; }
  .msg ol { margin: 6px 0 0; padding-left: 18px; }
  .receipt { margin-top: 6px; font-size: 11px; color: var(--muted); }
  .card { margin-top: 12px; border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; font-size: 12px; }
  .card b { display: block; font-size: 13px; margin-bottom: 4px; }
  .card span { color: var(--muted); }
  .foot { max-width: 380px; margin: 12px auto 0; color: var(--muted); font-size: 12px; text-align: center; }
</style></head><body>
<div class="phone">
  <div class="top"><span>企业 IM · 外部联系人</span><span>16:51</span></div>
  <div class="who">澜达精密 · 张明远<small>王志刚（海川机械 副总）的会话窗口</small></div>
  <div class="chat">
    <div class="stamp">${demoWorldFixture.demoDate.iso} 16:42</div>
    <div class="msg">
      王总您好，我是澜达张明远。明天上午 10:30 我准时到贵司，主要两件事：
      <ol>
        <li>把 ${demoWorldFixture.haichuanReport.code} ${demoWorldFixture.haichuanReport.name}当面给您，之前拖了，抱歉；</li>
        <li>同步 ${demoWorldFixture.openComplaint.id} 包装那批的处理进度。</li>
      </ol>
      会后如果方便，想看一下二期产线的节拍要求。
    </div>
    <div class="receipt">16:42 送达 · 16:51 已读</div>
    <div class="card">
      <b>拜访确认 · 2026-08-10 10:30</b>
      <span>地点 海川机械 · 参与人 王志刚 / 张明远 · 携带 ${demoWorldFixture.haichuanReport.code} ${demoWorldFixture.haichuanReport.name}</span>
    </div>
  </div>
</div>
<p class="foot">示例内容，不对应任何真实企业与联系人。</p>
</body></html>`;

const CLIENT_VIEW_SIZE_BYTES = new TextEncoder().encode(CLIENT_VIEW_HTML).length;

/** 面板底稿：CRM / 沟通时间线 / 订单中心 / 权限矩阵 / 待办与消息 / 操作留痕 */
const PANEL_BASE: SystemPanelSnapshot = {
  title: "企业系统实况",
  live: true,
  activeView: "crm",
  foot: "已连接：CRM 客户与商机 · 订单中心 · 待办中心 · 企业 IM（演示）",
  views: [
    {
      key: "crm",
      label: "CRM 客户与商机",
      winTitle: "CRM · 海川机械 客户与商机",
      toolbar: { title: "CRM · 海川机械", sub: "尚未读取" },
      widget: {
        kind: "table",
        cols: [
          { key: "item", label: "对象" },
          { key: "value", label: "关键信息" },
          { key: "state", label: "状态", align: "right" },
        ],
        rows: [],
        empty: { title: "尚未读取客户档案" },
      },
    },
    {
      key: "timeline",
      label: "历史沟通时间线",
      winTitle: "沟通记录 · 海川机械 近 4 个月",
      toolbar: { title: "沟通记录 · 海川机械", sub: "尚未读取" },
      widget: { kind: "rows", rows: [], empty: { title: "尚未读取沟通记录" } },
    },
    {
      key: "orders",
      label: "订单中心",
      winTitle: "订单中心 · 海川机械往来订单",
      toolbar: { title: "订单中心 · 海川机械", sub: "尚未读取" },
      widget: {
        kind: "table",
        cols: [
          { key: "no", label: "单号" },
          { key: "info", label: "内容" },
          { key: "state", label: "履约", align: "right" },
        ],
        rows: [],
        empty: { title: "尚未读取历史订单" },
      },
    },
    {
      key: "rights",
      label: "权限矩阵",
      winTitle: "权限矩阵 · 本人可访问范围",
      toolbar: { title: "权限矩阵 · 由 IT 依岗位表维护", sub: "只读" },
      widget: {
        kind: "table",
        cols: [
          { key: "domain", label: "数据域" },
          { key: "grant", label: "本人授权" },
          { key: "owner", label: "授权来源", align: "right" },
        ],
        rows: [],
        empty: { title: "尚未触达权限判定" },
      },
    },
    {
      key: "dispatch",
      label: "待办与消息",
      winTitle: "待办中心与企业 IM · 分发与回执",
      toolbar: { title: "待办与对外消息", sub: "尚未发出" },
      widget: { kind: "feed", items: [], empty: { title: "尚未创建待办，也未发出任何消息" } },
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
export const visitBriefingScript: ReplayScript = {
  scenarioId: "catalog-hook-visit-briefing",
  title: "明天要见客户，帮我快速拉齐",
  mode: "quick",
  artifacts: {
    [BRIEFING_PATH]: BRIEFING_HTML,
    [CLIENT_VIEW_PATH]: CLIENT_VIEW_HTML,
  },

  steps: [
    {
      caption: "拉齐这家客户的往来底账",
      blocks: [
        {
          id: "v1-prompt",
          kind: "prompt",
          title: "用户消息",
          defaultOpen: true,
          content: "明天见海川王总，帮我做个简报。",
        },
        {
          id: "v1-tool",
          kind: "tool_use",
          title: "CustomerLookup",
          defaultOpen: true,
          toolName: "CustomerLookup",
          toolId: "t-lookup",
          content: JSON.stringify({ customer: "海川机械", scope: ["crm", "orders", "timeline"], window: "120d" }),
          executionStatus: "completed",
          durationMs: 1120,
          presentation: {
            title: "读取客户档案、往来订单与沟通记录",
            detail: [
              { k: "客户", v: "海川机械 · A 级 · 已合作 1 期" },
              { k: "对接人", v: "王志刚 副总（拍板人）" },
              { tree: "├", k: "在跟商机", v: "OPP-2026-0311 二期模具 ¥120 万" },
              { tree: "├", k: "历史订单", v: "SO-2026-0418 一期模具 ¥78.5 万，已结清" },
              { tree: "└", k: "沟通记录", v: "近 4 个月 8 条，最近一条 8-05" },
            ],
            status: "ok",
            panelBase: PANEL_BASE,
            panel: [
              { op: "focus", view: "crm" },
              { op: "toolbar", view: "crm", title: "CRM · 海川机械", sub: "客户 1 · 商机 1 · 联系人 1" },
              { op: "tableRowInsert", view: "crm", row: { id: "c-account", cells: { item: "客户", value: "海川机械 · A 级 · 首次成交 2026-02", state: "活跃" } } },
              { op: "tableRowInsert", view: "crm", row: { id: "c-opp", cells: { item: "商机 OPP-2026-0311", value: "二期模具 ¥120 万 · 阶段「方案已报」", state: "停留 22 天" } } },
              { op: "tableRowInsert", view: "crm", row: { id: "c-contact", cells: { item: "联系人", value: "王志刚 副总 · 决策角色：拍板", state: "唯一对接人" } } },
              { op: "tableRowInsert", view: "crm", row: { id: "c-follow", cells: { item: "最近跟进", value: "8-05 客户来问，我方未回复", state: "待处理" } } },
              { op: "rowsSet", view: "timeline", rows: [
                { id: "t-0428", text: "04-28 一期交付验收通过", sub: "承诺 4-25 / 实交 4-28，延期 3 天，一次验收通过", tone: "pass" },
                { id: "t-0718a", text: "07-18 现场沟通 · 提交二期方案", sub: "OPP-2026-0311 ¥120 万，王志刚当场表示回去过会", tone: "info" },
                { id: "t-0718b", text: `${demoWorldFixture.haichuanReport.promisedDate} 我方承诺 · 提供 ${demoWorldFixture.haichuanReport.code} ${demoWorldFixture.haichuanReport.name}`, sub: `截至 ${demoWorldFixture.demoDate.iso} 已逾期 ${demoWorldFixture.haichuanReport.overdueDays} 天`, tone: "warn" },
                { id: "t-0725", text: "07-25 电话未接通", sub: "无留言记录", tone: "pending" },
                { id: "t-0729", text: "07-29 消息跟进 · 无回复", sub: "内容为二期方案是否有反馈", tone: "pending" },
                { id: "t-0801", text: `${demoWorldFixture.openComplaint.openedDate} 客诉 ${demoWorldFixture.openComplaint.id} 受理`, sub: `一期批次${demoWorldFixture.openComplaint.issue}，状态：处理中`, tone: "warn" },
                { id: "t-0805", text: "08-05 王志刚追问「样件报告还要多久」", sub: "我方未回复，已过 4 天", tone: "deny" },
                { id: "t-0808", text: "08-08 约定 8-10 上午到访", sub: "地点海川机械，参与人王志刚", tone: "info" },
              ] },
              { op: "tableRowInsert", view: "orders", row: { id: "o-418", cells: { no: "SO-2026-0418", info: "一期模具 ¥78.5 万 · 承诺 4-25 / 实交 4-28", state: "已验收结清" } } },
              { op: "tableRowInsert", view: "orders", row: { id: "o-terms", cells: { no: "成交条件", info: "单价 ¥1,860/套 · 整单折让 4.2% · 账期 60 天", state: "一期基准" } } },
              { op: "tableRowInsert", view: "orders", row: { id: "o-quality", cells: { no: "质量记录", info: "一期交付后无质量类客诉", state: "良好" } } },
              { op: "feedAppend", view: "audit", item: { id: "au-1", from: "AI 同事", time: "16:20:07", text: "读取 CRM 客户与商机、订单中心、沟通记录（只读，本人名下客户）" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "1 条" },
            ],
          },
        },
        {
          id: "v1-result",
          kind: "tool_result",
          title: "CustomerLookup 结果",
          defaultOpen: false,
          toolName: "CustomerLookup",
          toolId: "t-lookup",
          content: "account=海川机械 opp=OPP-2026-0311 stage_days=22 orders=1 touches=8 open_nc=1",
        },
        {
          id: "v1-text",
          kind: "text",
          title: "业务进展",
          defaultOpen: true,
          content: "档案、订单和 8 条沟通记录都拿到了。我按「明天现场用得上」的标准筛一遍，先把你占理的地方和欠客户的地方分开摆给你。",
        },
      ],
    },

    {
      caption: "关键事实，含我方欠客户的一项",
      blocks: [
        {
          id: "v2-tool",
          kind: "tool_use",
          title: "FactReview",
          defaultOpen: true,
          toolName: "FactReview",
          toolId: "t-facts",
          content: JSON.stringify({ account: "海川机械", checkOwnCommitments: true }),
          executionStatus: "completed",
          durationMs: 1480,
          presentation: {
            title: "梳理关键事实并回查我方承诺",
            detail: [
              { verdict: "pass", text: "一期履约站得住", note: "延期 3 天 · 一次验收通过 · 6-27 回款结清 · 零质量客诉" },
              { verdict: "warn", text: "OPP-2026-0311 停留 22 天", note: "7-18 报方案后阶段未动一格，期间客户主动来过一次" },
              { verdict: "fail", text: `${demoWorldFixture.haichuanReport.code} ${demoWorldFixture.haichuanReport.name}逾期 ${demoWorldFixture.haichuanReport.overdueDays} 天`, note: `${demoWorldFixture.haichuanReport.promisedDate} 承诺提供，截至 ${demoWorldFixture.demoDate.iso} 仍未兑现` },
              { verdict: "warn", text: `${demoWorldFixture.openComplaint.id} 挂起 ${demoWorldFixture.openComplaint.suspendedDays} 天未闭环`, note: `${demoWorldFixture.openComplaint.issue}，金额小，但对方是拍板人` },
              { insight: "商机停滞的原因在我方，不在客户意愿", label: "结论" },
            ],
            status: "warn",
            panel: [
              { op: "focus", view: "timeline" },
              { op: "toolbar", view: "timeline", title: "沟通记录 · 海川机械", sub: "命中 2 条我方欠账" },
              { op: "rowUpdate", view: "timeline", id: "t-0718b", set: { state: "hit", badge: { text: `逾期 ${demoWorldFixture.haichuanReport.overdueDays} 天`, tone: "deny" } } },
              { op: "rowUpdate", view: "timeline", id: "t-0805", set: { state: "hit", badge: { text: "未回复", tone: "deny" } } },
              { op: "rowUpdate", view: "timeline", id: "t-0801", set: { badge: { text: "未闭环", tone: "warn" } } },
              { op: "rowUpdate", view: "timeline", id: "t-0428", set: { badge: { text: "可主动讲", tone: "pass" } } },
              { op: "cellFlag", view: "crm", rowId: "c-opp", colKey: "state", tone: "warn", flag: "卡在我方" },
              { op: "feedAppend", view: "audit", item: { id: "au-2", from: "AI 同事", time: "16:20:38", text: `回查我方历史承诺，发现 1 项到期未兑现（${demoWorldFixture.haichuanReport.code} ${demoWorldFixture.haichuanReport.name}）` } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "2 条" },
            ],
          },
        },
        {
          id: "v2-text",
          kind: "text",
          title: "业务进展",
          defaultOpen: true,
          content: [
            "三条事实，按明天现场的用处排序：",
            "",
            "1. **一期履约站得住脚**。SO-2026-0418 承诺 4-25、实交 4-28，延期 3 天，验收一次通过，6-27 全额结清，交付后零质量客诉。这是明天唯一可以主动摆出来的东西。",
            "2. **二期停了 22 天，卡点在我们这边**。7-18 报完方案阶段就没动过，中间 8-05 王志刚在群里问「样件报告还要多久」，我方没回。不是客户没兴趣，是我们欠他东西。",
            `3. **${demoWorldFixture.haichuanReport.code} ${demoWorldFixture.haichuanReport.name}逾期 ${demoWorldFixture.haichuanReport.overdueDays} 天**。承诺 ${demoWorldFixture.haichuanReport.promisedDate} 前给，截至 ${demoWorldFixture.demoDate.iso} 还没给。明天他大概率一开口就是这个，建议你先认，别等他提。`,
            "",
            `另外 ${demoWorldFixture.openComplaint.id} ${demoWorldFixture.openComplaint.issue} ${demoWorldFixture.openComplaint.openedDate} 受理，挂起 ${demoWorldFixture.openComplaint.suspendedDays} 天还没闭环。金额不大，但明天坐对面的是拍板的人，这种事容易被当成态度问题。`,
          ].join("\n"),
        },
      ],
    },

    {
      caption: "预判他会问什么",
      blocks: [
        {
          id: "v3-tool",
          kind: "tool_use",
          title: "QuestionForecast",
          defaultOpen: true,
          toolName: "QuestionForecast",
          toolId: "t-forecast",
          content: JSON.stringify({ opportunity: "OPP-2026-0311", basis: ["history", "open_items"] }),
          executionStatus: "completed",
          durationMs: 1260,
          presentation: {
            title: "按历史问法与未结事项预判现场问题",
            detail: [
              { no: 1, text: "样件报告什么时候给 —— 依据：8-05 他已经问过一次，我方未回" },
              { no: 2, text: "二期这个价还能不能再降 —— 依据：方案报出 22 天未动，一期有 4.2% 折让先例" },
              { no: 3, text: `包装破损那批怎么算 —— 依据：${demoWorldFixture.openComplaint.id} 挂起 ${demoWorldFixture.openComplaint.suspendedDays} 天仍在处理中` },
              { section: "价格问题的可用依据" },
              { tree: "├", k: "一期单价", v: "¥1,860/套 · 整单折让 4.2%" },
              { tree: "├", k: "二期估算量", v: "约 1,400 套，比一期多 46%" },
              { tree: "└", k: "账期", v: "一期 60 天，二期方案沿用" },
              { warn: "毛利明细在财务数据域，本岗位无授权，我没有读取；降价底线不由我给" },
            ],
            status: "ok",
            panel: [
              { op: "focus", view: "orders" },
              { op: "toolbar", view: "orders", title: "订单中心 · 海川机械", sub: "一期成交条件已调出" },
              { op: "cellFlag", view: "orders", rowId: "o-terms", colKey: "info", tone: "info", flag: "谈价依据" },
              { op: "cellFlag", view: "orders", rowId: "o-418", colKey: "state", tone: "pass", flag: "可主动讲" },
              { op: "feedAppend", view: "audit", item: { id: "au-3", from: "AI 同事", time: "16:21:12", text: "调取一期成交条件用于谈价依据；未读取成本与毛利数据" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "3 条" },
            ],
          },
        },
        {
          id: "v3-text",
          kind: "text",
          title: "业务进展",
          defaultOpen: true,
          content: [
            "按他过去的问法和现在挂着的事，我押这三个问题：",
            "",
            "1. 「样件报告到底什么时候给？」——这是我方欠账，唯一站得住的答法是当面把纸质版交了，再给一个明确的后续节点，别再用「尽快」。",
            "2. 「二期这个价还能不能再降？」——我能给的只有依据：一期单价 ¥1,860/套、整单折让 4.2%、账期 60 天，二期量按 1,400 套估、比一期多 46%。**底线要你自己定**，我不替你拍——毛利明细在财务域，我没有读，也不该读。",
            `3. 「包装破损那批怎么算？」——${demoWorldFixture.openComplaint.id} 还没闭环，质检复判结论没出。现场只讲进度和时间点，不认责任也不否认，一句话都别多说。`,
            "",
            "第 1 条不解决，后面两条都不用谈——他现在对我们的信任缺口就在这。",
          ].join("\n"),
        },
      ],
    },
    {
      caption: "查客户个人背景被拦下",
      blocks: [
        {
          id: "v4-prompt",
          kind: "prompt",
          title: "用户消息",
          defaultOpen: true,
          content: "顺便帮我查下王总的个人背景，家里什么情况、平时有什么爱好，明天好投其所好。",
        },
        {
          id: "v4-tool",
          kind: "tool_use",
          title: "ContactProfile",
          defaultOpen: true,
          toolName: "ContactProfile",
          toolId: "t-profile",
          content: JSON.stringify({ contact: "王志刚", fields: ["family", "hobby", "background"] }),
          executionStatus: "completed",
          durationMs: 190,
          presentation: {
            title: "联系人个人信息 · 权限判定",
            detail: [
              { k: "请求数据域", v: "联系人家庭情况与个人偏好" },
              { k: "本人岗位", v: "销售（本人名下客户）" },
              { verdict: "fail", text: "越出业务范围，按权限矩阵拒绝", note: "未发起任何检索 · 拦截已记账" },
              { indent: 0, text: "⚠ 个人信息最小化：即便公开渠道能搜到，也不进客户档案" },
            ],
            status: "blocked",
            panel: [
              { op: "focus", view: "rights" },
              { op: "toolbar", view: "rights", title: "权限矩阵 · 本人可访问范围", sub: "命中 1 条拒绝" },
              { op: "tableRowInsert", view: "rights", row: { id: "r-crm", cells: { domain: "本人名下客户与商机", grant: "允许", owner: "岗位表" } } },
              { op: "tableRowInsert", view: "rights", row: { id: "r-order", cells: { domain: "历史订单与成交条件", grant: "允许", owner: "岗位表" } } },
              { op: "tableRowInsert", view: "rights", row: { id: "r-nc", cells: { domain: "本客户客诉工单", grant: "允许", owner: "岗位表" } } },
              { op: "tableRowInsert", view: "rights", row: { id: "r-person", cells: { domain: "联系人家庭与个人偏好", grant: "拒绝", owner: "个人信息最小化原则" }, tone: "deny" } },
              { op: "cellFlag", view: "rights", rowId: "r-person", colKey: "grant", tone: "deny", flag: "不在业务范围" },
              { op: "tableRowInsert", view: "rights", row: { id: "r-margin", cells: { domain: "成本与毛利明细", grant: "拒绝", owner: "财务部" } } },
              { op: "feedAppend", view: "audit", item: {
                id: "au-4",
                from: "AI 同事",
                time: "16:21:44",
                text: "联系人个人背景查询被拦截，未发起任何检索",
                card: { title: "越界请求已拦截", body: "数据域「联系人家庭与个人偏好」不在业务范围；已给出公开信息替代路径", meta: [{ text: "零检索", tone: "pass" }, { text: "已记账", tone: "info" }] },
              } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "4 条" },
            ],
          },
        },
        {
          id: "v4-text",
          kind: "text",
          title: "回复",
          defaultOpen: true,
          content: [
            "**这条我不查，也不会绕**。王总的家庭情况和个人爱好属于个人信息，不在业务范围内——右侧权限矩阵这一行是明确拒绝的，我没有发起任何检索。这类东西就算公开渠道能扒到，也不该进客户档案。",
            "",
            "能查的有两条，你要哪条我就去拉：",
            "",
            "1. 公开工商信息：海川机械的股东结构、对外投资、近三年经营异常记录；",
            "2. 公开报道与官网动态：他们二季度新投产的产线、公开的招标与获奖信息——这些当破冰话题更自然，也经得起对方追问来源。",
            "",
            "说实话，明天不需要这些。你手里那三个履约数据比任何私人话题都管用。",
          ].join("\n"),
        },
      ],
    },

    {
      caption: "生成拜访简报",
      blocks: [
        {
          id: "v5-tool",
          kind: "tool_use",
          title: "BriefingCompose",
          defaultOpen: true,
          toolName: "BriefingCompose",
          toolId: "t-brief",
          content: JSON.stringify({ account: "海川机械", visitAt: "2026-08-10", pages: 1 }),
          executionStatus: "completed",
          durationMs: 2140,
          presentation: {
            title: "汇成一页纸拜访简报",
            detail: [
              { k: "结构", v: "去解决什么 / 可主动讲的三个数 / 预判三问 / 要带的东西 / 不替你决定的" },
              { tree: "├", k: "引用", v: `《本周客户推进清单》${demoWorldFixture.demoDate.short} 第 1 条 · 待办 TD-1181` },
              { tree: "├", k: "已标红", v: `${demoWorldFixture.haichuanReport.code} ${demoWorldFixture.haichuanReport.name}逾期 ${demoWorldFixture.haichuanReport.overdueDays} 天` },
              { tree: "└", k: "留白", v: "二期降价底线、客诉责任归属，两处均未给结论" },
              { insight: "简报只是材料，没有写进任何业务系统", label: "范围" },
            ],
            status: "ok",
            panel: [
              { op: "focus", view: "audit" },
              { op: "feedAppend", view: "audit", item: {
                id: "au-5",
                from: "AI 同事",
                time: "16:22:26",
                text: "生成《海川机械拜访简报》一页纸；本步未写入任何业务系统",
                card: { title: "拜访简报已生成", body: "含 3 个可主动讲的数据、3 个预判问题、2 处明确不替人决定", meta: [{ text: "仅文档产出", tone: "info" }] },
              } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "5 条" },
            ],
          },
        },
        {
          id: "v5-text",
          kind: "text",
          title: "回复",
          defaultOpen: true,
          content: [
            "简报出来了，一页纸，路上十分钟能看完：",
            "",
            `[FILE]{"filePath":"${BRIEFING_PATH}","fileName":"海川机械拜访简报.html","fileSize":${BRIEFING_SIZE_BYTES}}[/FILE]`,
            "",
            "里面第一条接的是你上周那份《本周客户推进清单》的第 1 条（待办 TD-1181），所以编号对得上，不用重新对一遍。",
            "",
            "最后有两件事我留白了：二期降价底线、包装客诉的责任归属。前者要你现场判断，后者要等质检复判结论，我都没有替你写答案。",
          ].join("\n"),
        },
      ],
    },
    {
      caption: "建待办、发确认消息（需你确认）",
      blocks: [],
      approval: {
        title: "建 1 条待办 + 向客户发 1 条消息 · 需你确认",
        description: "待办写进待办中心，消息直接发到客户手上，两件都会离开我们自己的系统。确认前我不会动。",
        facts: [
          { label: "待办", value: `8-10 08:30 前备好 ${demoWorldFixture.haichuanReport.code} ${demoWorldFixture.haichuanReport.name}纸质版 ×2 · 责任人 张明远` },
          { label: "发送对象", value: "王志刚（海川机械 副总）· 企业 IM 外部联系人" },
          { label: "消息草稿", value: `王总您好，我是澜达张明远。明天上午 10:00 我准时到贵司，主要三件事：① 把 ${demoWorldFixture.haichuanReport.code} ${demoWorldFixture.haichuanReport.name}当面给您，之前拖了，抱歉；② 同步 ${demoWorldFixture.openComplaint.id} 包装那批的处理进度；③ 二期方案的报价我们还可以再谈谈。会后如果方便，想看一下二期产线的节拍要求。` },
          { label: "不改什么", value: "商机阶段、订单、客诉状态一律不动" },
        ],
        approveLabel: "确认发出",
        rejectLabel: "退回修改",
        approvedBlocks: [
          {
            id: "v6-human",
            kind: "prompt",
            title: "用户消息",
            defaultOpen: true,
            content: "待办和发消息都可以。但第③条把价格那句删掉——底线我还没定，不能先把口子开在消息里。另外时间改成 10:30，我路上要一个小时。",
          },
          {
            id: "v6-tool",
            kind: "tool_use",
            title: "Approval",
            defaultOpen: true,
            toolName: "Approval",
            toolId: "t-approve",
            content: JSON.stringify({ todo: "TD-1191", message: "王志刚", decision: "approved-with-edits" }),
            executionStatus: "completed",
            durationMs: 340,
            presentation: {
              title: "已确认发出 · 含人工修改 1 项",
              detail: [
                { k: "审批结果", v: "采纳 2 项 · 修改 1 项 · 自动执行 0 项" },
                { tree: "├", k: "采纳", v: "建待办 TD-1191、向王志刚发确认消息" },
                { tree: "├", k: "修改", v: "删去「报价还可以再谈」一句，到访时间 10:00 → 10:30" },
                { tree: "├", k: "待办回执", v: "TD-1191 · 8-10 08:30 到期 · 回读通过" },
                { tree: "└", k: "消息回执", v: "16:42 送达 · 16:51 已读" },
                { insight: "价格口径由人把关，AI 未替任何一方作出让价表述", label: "记账" },
              ],
              status: "ok",
              receipt: { id: "TD-1191", system: "待办中心", readBack: true },
              panel: [
                { op: "focus", view: "dispatch" },
                { op: "toolbar", view: "dispatch", title: "待办与对外消息", sub: "待办 1 · 已发消息 1" },
                { op: "feedAppend", view: "dispatch", item: {
                  id: "d-todo",
                  from: "待办中心",
                  time: "16:42",
                  text: `TD-1191 · 8-10 08:30 前备好 ${demoWorldFixture.haichuanReport.code} ${demoWorldFixture.haichuanReport.name}纸质版 ×2`,
                  card: { title: "待办已创建", body: "责任人 张明远 · 关联 OPP-2026-0311", meta: [{ text: "回读通过", tone: "pass" }] },
                } },
                { op: "feedAppend", view: "dispatch", item: {
                  id: "d-msg",
                  from: "企业 IM",
                  time: "16:42",
                  text: `已发给王志刚：明天 10:30 到访，带 ${demoWorldFixture.haichuanReport.code} ${demoWorldFixture.haichuanReport.name}，同步 ${demoWorldFixture.openComplaint.id} 进度`,
                  card: { title: "消息已送达", body: "价格相关表述已按你的要求删去", meta: [{ text: "16:42 送达", tone: "pass" }, { text: "16:51 已读", tone: "pass" }] },
                } },
                { op: "cellFlag", view: "crm", rowId: "c-follow", colKey: "state", tone: "pass", flag: "已回复" },
                { op: "feedAppend", view: "audit", item: {
                  id: "au-6",
                  from: "张明远",
                  time: "16:42:03",
                  text: "确认发出：采纳 2 项、修改 1 项（删价格表述、到访时间 10:00 → 10:30）、自动执行 0 项",
                  card: { title: "人审记录", body: "采纳 2 · 修改 1 · 自动执行 0", meta: [{ text: "AI 未自行发出", tone: "pass" }] },
                } },
                { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "6 条" },
              ],
            },
          },
          {
            id: "v6-text",
            kind: "text",
            title: "审批结果",
            defaultOpen: true,
            content: [
              "两件都办完了，你改的地方我按新口径执行：价格那句整段删掉，到访时间改成 10:30。**下面这份就是王总此刻在手机上看到的样子**，你可以先核一遍：",
              "",
              `[FILE]{"filePath":"${CLIENT_VIEW_PATH}","fileName":"拜访确认消息-客户端视图.html","fileSize":${CLIENT_VIEW_SIZE_BYTES}}[/FILE]`,
              "",
              "16:42 送达，16:51 已读，他没有回消息——按他的习惯，明天见面直接说就行，不用再追一条。",
            ].join("\n"),
          },
        ],
        rejectedBlocks: [
          {
            id: "v6-rejected-tool",
            kind: "tool_use",
            title: "Approval",
            defaultOpen: true,
            toolName: "Approval",
            toolId: "t-reject",
            content: JSON.stringify({ todo: "TD-1191", message: "王志刚", decision: "rejected" }),
            executionStatus: "completed",
            durationMs: 260,
            presentation: {
              title: "已退回 · 待办没建，消息也没发",
              detail: [
                { k: "审批结果", v: "退回修改" },
                { k: "对外消息", v: "未发送，客户侧没有任何痕迹" },
                { k: "待办中心", v: "无写入" },
                { tree: "└", k: "留痕", v: "退回时间、退回人与当时的消息草稿版本已记录" },
                { insight: "拜访简报不受影响，仍可下载", label: "仍然可用" },
              ],
              status: "blocked",
              panel: [
                { op: "focus", view: "dispatch" },
                { op: "toolbar", view: "dispatch", title: "待办与对外消息", sub: "未发出" },
                { op: "feedAppend", view: "dispatch", item: {
                  id: "d-hold",
                  from: "待办与消息",
                  time: "16:42",
                  text: "消息未发送，待办未创建",
                  card: { title: "已停在确认点", body: "客户侧零痕迹，我方系统零写入", meta: [{ text: "已停住", tone: "warn" }] },
                } },
                { op: "feedAppend", view: "audit", item: { id: "au-6r", from: "张明远", time: "16:42:03", text: "退回：未创建待办、未发出任何对外消息" } },
                { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "6 条" },
              ],
            },
          },
          {
            id: "v6-rejected-text",
            kind: "text",
            title: "退回说明",
            defaultOpen: true,
            content: "停住了：待办没建，消息没发，客户那边看不到任何东西。简报还在，你照样能带着去。改完消息口径再叫我，重新发仍然要你点一次确认。",
          },
        ],
      },
    },
    {
      caption: "跨系统核对终态",
      blocks: [
        {
          id: "v7-tool",
          kind: "tool_use",
          title: "ReadBack",
          defaultOpen: true,
          toolName: "ReadBack",
          toolId: "t-readback",
          content: JSON.stringify({ account: "海川机械", objects: ["OPP-2026-0311", "TD-1191", "MSG-王志刚"] }),
          executionStatus: "completed",
          durationMs: 980,
          presentation: {
            title: "回读五个系统，核对说法是否一致",
            detail: [
              { k: "回读方式", v: "按对象 ID 逐个反查，不用本次会话的缓存" },
              { verdict: "pass", text: "CRM 客户与商机", note: "OPP-2026-0311 仍在「方案已报」· 无写入" },
              { verdict: "pass", text: "订单中心", note: "SO-2026-0418 只读 · 成交条件未改动" },
              { verdict: "pass", text: "待办中心", note: "TD-1191 · 8-10 08:30 到期 · 回读通过" },
              { verdict: "pass", text: "企业 IM", note: "1 条外发 · 16:42 送达 · 16:51 已读" },
              { verdict: "pass", text: "操作留痕", note: "7 条动作，含 1 次拦截、0 次自动执行" },
              { insight: "五方一致，写入只发生在你确认过的那两处", label: "结论" },
            ],
            status: "ok",
            panel: [
              { op: "focus", view: "crm" },
              { op: "toolbar", view: "crm", title: "CRM · 海川机械 终态回读", sub: "商机阶段未动 · 五方一致" },
              { op: "cellFlag", view: "crm", rowId: "c-opp", colKey: "state", tone: "info", flag: "未改动" },
              { op: "feedAppend", view: "audit", item: { id: "au-7", from: "AI 同事", time: "16:43:10", text: "回读 CRM / 订单中心 / 待办中心 / 企业 IM / 操作留痕，五方状态一致" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "7 条" },
            ],
          },
        },
        {
          id: "v7-text",
          kind: "text",
          title: "本次会话改变了什么",
          defaultOpen: true,
          content: [
            "## 本次会话改变了什么",
            "",
            "| 系统 | 终态 | 依据 |",
            "| --- | --- | --- |",
            "| CRM 客户与商机 | 无写入，OPP-2026-0311 仍在「方案已报」 | 终态回读，阶段与停留天数未改 |",
            "| 订单中心 | 无写入，仅读取一期成交条件 | SO-2026-0418 记录未变更 |",
            "| 待办中心 | 新增 1 条 TD-1191，8-10 08:30 到期 | 回执 TD-1191 回读通过 |",
            "| 企业 IM | 1 条外发消息，价格表述已按你的要求删去 | 16:42 送达 · 16:51 已读 |",
            "| 操作留痕 | 7 条动作，含 1 次拦截 | 拦截处零检索，全程 0 次自动执行 |",
            "",
            "## 本次会话没有做什么",
            "",
            "- 没有替你承诺价格：草稿里那句「报价还可以再谈」被你删掉后就没再出现，发出去的消息一个字没提价格；",
            "- 没有联系这家客户的其他人：整场只给王志刚发了一条，通讯录里其他联系人没有碰；",
            "- 没有查任何人的个人背景：家庭与爱好那条在权限矩阵处被拦下，零检索；",
            "- 没有动商机阶段和客诉状态：二期要不要往前推、包装那批怎么定责，都等你明天回来说。",
          ].join("\n"),
        },
        {
          id: "v7-upgrade",
          kind: "text",
          title: "下次可以更省事",
          defaultOpen: true,
          content: "这种局要是常有，可以让我盯着你的日程——会面前 1 小时自动把对方的简报推给你，你不用开口，随时说一声就行。",
        },
      ],
    },
  ],

  // 治理条款：state != exists 的条目就是「演示到真实」的距离
  sources: [
    {
      blockRef: "step1.tool.CustomerLookup",
      producer: "租户业务数据连接器",
      state: "missing",
      gap: "通用业务数据连接器不存在；读客户档案、往来订单与沟通记录目前只能靠客户自建 API 或数据库只读账号，且都不产出业务语义摘要",
    },
    {
      blockRef: "step2.tool.FactReview",
      producer: "Agent 分析（读入数据后的事实梳理）",
      state: "exists",
    },
    {
      blockRef: "step3.tool.QuestionForecast",
      producer: "Agent 分析（历史问法与未结事项推断）",
      state: "exists",
    },
    {
      blockRef: "step4.tool.ContactProfile",
      producer: "独立范围门禁",
      state: "needs-change",
      gap: "门禁形态已验证（会话外独立判定 + 预设话术），但尚未产品化为可按数据域配置的权限矩阵，个人信息这类「公开渠道搜得到但不该进档案」的判定也还没有规则位",
    },
    {
      blockRef: "step5.tool.BriefingCompose",
      producer: "Agent 生成文档产物",
      state: "exists",
    },
    {
      blockRef: "step5.artifact.海川机械拜访简报",
      producer: "Agent 生成 HTML 产物",
      state: "exists",
    },
    {
      blockRef: "step6.tool.Approval",
      producer: "钉钉 DWS 连接器（待办创建 + IM 消息发送）",
      state: "needs-change",
      gap: "待办与消息发送能力已有，但要改造成回放里这份摘要：缺「送达/已读回执回读」与「人改了哪一条」的结构化字段，现在只能落在自由文本里",
    },
    {
      blockRef: "step6.tool.ApprovalReject",
      producer: "人审门禁执行器",
      state: "needs-change",
      gap: "退回态 runtime 已成对记账，但「退回时哪些系统零写入」目前没有可回读的结构化证明，客户只能相信文案",
    },
    {
      blockRef: "step6.artifact.拜访确认消息客户端视图",
      producer: "钉钉 DWS 连接器（消息回执）",
      state: "needs-change",
      gap: "对方视角这一屏需要真实的送达与已读时间戳回读；当前消息发送接口只返回发送成功，不回吐已读状态",
    },
    {
      blockRef: "step7.tool.ReadBack",
      producer: "业务终态回读器",
      state: "missing",
      gap: "跨系统回读需要先有各系统连接器；在此之前终态核对表只能是人工整理",
    },
  ],
};


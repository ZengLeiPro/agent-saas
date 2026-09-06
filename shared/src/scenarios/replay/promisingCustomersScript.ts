import type { SystemPanelSnapshot } from "../../lib/systemPanel";
import { demoWorldFixture } from "./demoWorldFixture";
import type { ReplayScript } from "./types";

/**
 * 钩子场景 H1：分析一下我手上哪些客户最值得推进。
 *
 * 岗位视角＝销售张明远。核心价值不是给商机制造一个伪精确总分，
 * 而是把金额、阶段停留、最近互动和我方未兑现承诺四维证据摊开，
 * 排出本周推进顺序，并让销售修改后再创建待办。
 *
 * 内容为示例数据，不对应任何真实企业、客户或商机。
 */

const PLAN_PATH = "assets/demo/本周客户推进清单.html";

const PLAN_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<style>
  :root { --brand: #2E56E1; --ink: #0f172a; --muted: #64748b; --line: #e2e8f0; --ok: #15803d; --warn: #b45309; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 20px; font: 14px/1.7 "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; color: var(--ink); background: #fff; }
  .bar { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border: 1px solid var(--line); border-radius: 6px; background: #f8fafc; color: var(--muted); font-size: 12px; margin-bottom: 16px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #cbd5e1; }
  h1 { margin: 0 0 4px; font-size: 16px; }
  .sub { margin: 0 0 16px; color: var(--muted); font-size: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 14px; }
  th, td { border: 1px solid var(--line); padding: 7px 10px; text-align: left; vertical-align: top; }
  th { background: #f8fafc; color: var(--muted); font-weight: 500; }
  .rank { font-weight: 700; color: var(--brand); }
  .ok { color: var(--ok); font-weight: 600; }
  .warn { color: var(--warn); font-weight: 600; }
  .box { border: 1px solid var(--line); border-radius: 8px; padding: 12px; margin-bottom: 12px; }
  .box h2 { margin: 0 0 8px; font-size: 13px; }
  .kv { display: grid; grid-template-columns: 96px 1fr; gap: 4px 12px; font-size: 13px; }
  .kv span:nth-child(odd) { color: var(--muted); }
  ul { margin: 6px 0 0; padding-left: 18px; }
  li { margin-bottom: 4px; }
  .tl { border-left: 2px solid var(--line); margin: 6px 0 0; padding-left: 12px; }
  .tl div { margin-bottom: 6px; font-size: 13px; }
  .tl b { color: var(--brand); font-weight: 600; }
  .say { border-left: 3px solid var(--brand); background: #f8fafc; padding: 8px 12px; margin: 6px 0 0; font-size: 13px; }
  .foot { margin-top: 14px; color: var(--muted); font-size: 12px; }
</style></head><body>
<div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span>本周客户推进清单 · PLAN-0809-03</span></div>

<h1>本周客户推进清单 · 张明远</h1>
<p class="sub">编号 PLAN-0809-03 · 生成于 ${demoWorldFixture.demoDate.iso} · 覆盖名下 23 个在跟商机，合计 ¥473.0 万</p>

<table>
  <tr><th>优先级</th><th>商机</th><th>金额</th><th>为什么是现在</th><th>本周动作</th></tr>
  <tr>
    <td class="rank">1</td>
    <td>OPP-2026-0311<br>海川机械 · 王志刚</td>
    <td>¥120.0 万</td>
    <td class="warn">停在「方案已报」22 天，是该阶段正常周期的 2.2 倍；我方欠客户 ${demoWorldFixture.haichuanReport.promisedDate} 承诺的 ${demoWorldFixture.haichuanReport.code} ${demoWorldFixture.haichuanReport.name}，已逾期 ${demoWorldFixture.haichuanReport.overdueDays} 天</td>
    <td>先补交样件测试报告，再约二期方案面谈</td>
  </tr>
  <tr>
    <td class="rank">2</td>
    <td>OPP-2026-0342<br>${demoWorldFixture.deliveryOrder.customer} · 郑海峰</td>
    <td>¥68.0 万</td>
    <td>${demoWorldFixture.deliveryOrder.id} 正在交付（${demoWorldFixture.deliveryOrder.promisedDeliveryDate} 交期），客户去年 8 月同期下过一次年度补单，本月存在复购线索，但只有一个历史样本，仍需当面验证</td>
    <td>先跟生产计划确认产能窗口，交付稳住再谈复购</td>
  </tr>
  <tr>
    <td class="rank">3</td>
    <td>OPP-2026-0338<br>蓝谷自动化 · 顾云帆</td>
    <td>¥45.0 万</td>
    <td class="warn">商务谈判阶段仅停 6 天，本身健康；但 AR-2026-0058 ¥23.6 万已逾期 18 天，回款不清会先伤信任</td>
    <td>与财务对齐回款口径，再推进新单条款</td>
  </tr>
</table>

<div class="box">
  <h2>换到王志刚的位置，看这 22 天</h2>
  <div class="tl">
    <div><b>07-18</b> 收到我方二期模具方案，报价 ¥120.0 万</div>
    <div><b>07-21</b> 回复「内部先评审」，此后无主动联系</div>
    <div><b>${demoWorldFixture.haichuanReport.promisedDate}</b> 我方承诺补一份 ${demoWorldFixture.haichuanReport.code} ${demoWorldFixture.haichuanReport.name} —— <span class="warn">截至 ${demoWorldFixture.demoDate.iso} 已逾期 ${demoWorldFixture.haichuanReport.overdueDays} 天</span></div>
    <div><b>${demoWorldFixture.demoDate.short}</b> 他这边看到的事实：方案报了、承诺没兑现、22 天没人跟进</div>
  </div>
  <p class="sub" style="margin:8px 0 0">这 22 天的沉默，未必是客户不想推，也可能是我们先停了。</p>
</div>

<div class="box">
  <h2>话术要点</h2>
  <p><b>海川机械 · 王志刚</b></p>
  <div class="say">开场先认账，不要先问进度：「王总，答应您的 ${demoWorldFixture.haichuanReport.code} ${demoWorldFixture.haichuanReport.name}我这边压住了，先给您补上。二期方案如果内部评审有卡点，我这周过去当面过一遍。」</div>
  <ul>
    <li>先给东西，再要答复 —— 承诺没兑现之前追进度，只会把沉默拉长</li>
    <li>不主动提降价；对方若先提，只回「我带一期的实际交付数据过去一起看」</li>
  </ul>
  <p style="margin-top:12px"><b>${demoWorldFixture.deliveryOrder.customer} · 郑海峰</b></p>
  <div class="say">「郑工，${demoWorldFixture.deliveryOrder.id} 这批 ${demoWorldFixture.deliveryOrder.promisedDeliveryDate} 准时交，我盯着。年度补单如果还是这个时间点走，我提前把产能排进去。」</div>
  <ul><li>交付没稳之前不谈新单，谈了也不落地</li></ul>
  <p style="margin-top:12px"><b>蓝谷自动化 · 顾云帆</b></p>
  <div class="say">「顾工，新一轮配件方案我这边准备好了。财务那边 AR-2026-0058 还挂着 ¥23.6 万，我们一起把这笔理清楚，后面走流程会顺。」</div>
  <ul><li>回款和新单同一次谈，不要分两次开口</li></ul>
</div>

<div class="box">
  <h2>建议先放一放（本周不投入）</h2>
  <table style="margin:0">
    <tr><th>商机</th><th>金额</th><th>理由</th></tr>
    <tr><td>OPP-2026-0298 海川机械 备件</td><td>¥18.0 万</td><td>与 OPP-2026-0311 同一决策人王志刚；同时推两件事会稀释二期这条主线</td></tr>
    <tr><td>OPP-2026-0290 Feldmann GmbH</td><td>¥30.0 万</td><td>停在「方案已报」41 天；卡点是对方要的认证材料我方本月拿不出，本周投入换不来进展</td></tr>
  </table>
</div>

<div class="box">
  <h2>我不替你判断的两件事</h2>
  <ul>
    <li>恒岳的复购窗口只有去年 8 月一个历史样本，一个样本不构成规律，这条判断请你自己掂量</li>
    <li>蓝谷是「先催款还是先谈新单」，涉及客户关系取舍，我只把两边的事实摆出来</li>
  </ul>
</div>

<p class="foot">示例内容，不对应任何真实企业、客户或商机。数据来自演示环境。</p>
</body></html>`;

/** 真实字节数：模块加载时按 UTF-8 编码计算，与 [FILE] 标记里写的值同源 */
const PLAN_SIZE_BYTES = new TextEncoder().encode(PLAN_HTML).length;

/** 面板底稿：CRM 客户与商机 / 待办中心 / 权限矩阵 / 操作留痕 */
const PANEL_BASE: SystemPanelSnapshot = {
  title: "企业系统实况",
  live: true,
  activeView: "crm",
  foot: "已连接：CRM 客户与商机 · 待办中心 · 权限矩阵 · 操作留痕（演示）",
  views: [
    {
      key: "crm",
      label: "CRM 客户与商机",
      winTitle: "CRM 客户与商机 · 张明远名下",
      toolbar: { title: "CRM 客户与商机 · 张明远名下", sub: "尚未读取" },
      widget: {
        kind: "table",
        cols: [
          { key: "cust", label: "客户" },
          { key: "opp", label: "商机 · 金额" },
          { key: "stage", label: "阶段 · 停留" },
          { key: "score", label: "四维判断", align: "right" },
        ],
        rows: [],
        empty: { title: "尚未读取客户与商机" },
      },
    },
    {
      key: "todo",
      label: "待办中心",
      winTitle: "待办中心 · 张明远",
      toolbar: { title: "待办中心 · 张明远", sub: "本周 0 条跟进待办" },
      widget: { kind: "rows", rows: [], empty: { title: "本周还没有跟进待办" } },
    },
    {
      key: "rights",
      label: "权限矩阵",
      winTitle: "权限矩阵 · 本人可访问范围",
      toolbar: { title: "权限矩阵 · 由销售负责人依岗位表维护", sub: "只读" },
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
      key: "audit",
      label: "操作留痕",
      winTitle: "操作留痕 · 本次会话",
      toolbar: { title: "本次会话的系统动作", sub: "0 条" },
      widget: { kind: "feed", items: [], empty: { title: "尚无系统动作" } },
    },
  ],
};

export const promisingCustomersScript: ReplayScript = {
  scenarioId: "catalog-hook-promising-customers",
  title: "分析我手上哪些客户最值得推进",
  mode: "quick",
  artifacts: { [PLAN_PATH]: PLAN_HTML },

  steps: [
    {
      caption: "读取名下客户与商机",
      blocks: [
        {
          id: "p1-prompt",
          kind: "prompt",
          title: "用户消息",
          defaultOpen: true,
          content: "哪些客户最值得先跟？",
        },
        {
          id: "p1-tool",
          kind: "tool_use",
          title: "CRMQuery",
          defaultOpen: true,
          toolName: "CRMQuery",
          toolId: "t-crm",
          content: JSON.stringify({ owner: "张明远", scope: "opportunities" }),
          executionStatus: "completed",
          durationMs: 920,
          presentation: {
            title: "读取名下客户与在跟商机",
            detail: [
              { k: "范围", v: "张明远名下 · 23 个在跟商机" },
              { k: "合计金额", v: "¥473.0 万 · 均值 ¥20.6 万" },
              { tree: "├", k: "交付中订单", v: `${demoWorldFixture.deliveryOrder.id} ${demoWorldFixture.deliveryOrder.customer} ¥${demoWorldFixture.deliveryOrder.amountWan.toFixed(1)} 万 · ${demoWorldFixture.deliveryOrder.promisedDeliveryDate} 交期` },
              { tree: "├", k: "停留超 20 天", v: "2 个 · OPP-2026-0311、OPP-2026-0290" },
              { tree: "└", k: "读取方式", v: "只读，未改动任何商机字段" },
            ],
            status: "ok",
            panelBase: PANEL_BASE,
            panel: [
              { op: "focus", view: "crm" },
              { op: "toolbar", view: "crm", title: "CRM 客户与商机 · 张明远名下", sub: "23 个商机 · ¥473.0 万" },
              { op: "tableRowInsert", view: "crm", row: { id: "o-0311", cells: { cust: "海川机械 · 王志刚", opp: "OPP-2026-0311 · ¥120.0 万", stage: "方案已报 · 22 天", score: "—" } } },
              { op: "tableRowInsert", view: "crm", row: { id: "o-0342", cells: { cust: `${demoWorldFixture.deliveryOrder.customer} · 郑海峰`, opp: "OPP-2026-0342 · ¥68.0 万", stage: "需求确认 · 9 天", score: "—" } } },
              { op: "tableRowInsert", view: "crm", row: { id: "o-0338", cells: { cust: "蓝谷自动化 · 顾云帆", opp: "OPP-2026-0338 · ¥45.0 万", stage: "商务谈判 · 6 天", score: "—" } } },
              { op: "tableRowInsert", view: "crm", row: { id: "o-0298", cells: { cust: "海川机械 · 王志刚", opp: "OPP-2026-0298 · ¥18.0 万", stage: "初步接触 · 12 天", score: "—" } } },
              { op: "tableRowInsert", view: "crm", row: { id: "o-0290", cells: { cust: "Feldmann GmbH · Stefan Feldmann", opp: "OPP-2026-0290 · ¥30.0 万", stage: "方案已报 · 41 天", score: "—" } } },
              { op: "tableRowInsert", view: "crm", row: { id: "o-rest", cells: { cust: "其余 18 个客户", opp: "18 个商机 · ¥192.0 万", stage: "多在初步接触 · 均 15 天", score: "—" } } },
              { op: "feedAppend", view: "audit", item: { id: "au-1", from: "AI 同事", time: "09:06:12", text: "读取 CRM 中张明远名下 23 个客户与商机（只读）" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "1 条" },
            ],
          },
        },
        {
          id: "p1-result",
          kind: "tool_result",
          title: "CRMQuery 结果",
          defaultOpen: false,
          toolName: "CRMQuery",
          toolId: "t-crm",
          content: "owner=张明远 opportunities=23 amount=4730000 stalled_gt_20d=2",
        },
        {
          id: "p1-text",
          kind: "text",
          title: "业务进展",
          defaultOpen: true,
          content: "名下 23 个商机都拿到了，合计 ¥473.0 万。我不按金额直接排——金额大不等于该现在推。下面把四个因子逐维摊开，不合成一个看似精确的成交分；排完把每一条的理由摆给你看。",
        },
      ],
    },

    {
      caption: "四个因子逐维画像",
      blocks: [
        {
          id: "p2-tool",
          kind: "tool_use",
          title: "OpportunityEvidenceProfile",
          defaultOpen: true,
          toolName: "OpportunityEvidenceProfile",
          toolId: "t-profile",
          content: JSON.stringify({ owner: "张明远", factors: ["amount", "stage_idle", "last_touch", "open_promise"] }),
          executionStatus: "completed",
          durationMs: 1580,
          presentation: {
            title: "按四个因子逐维画像，不合成伪精确总分",
            detail: [
              "四个因子逐维保留原始证据，只做高 / 中 / 低相对优先级，不把它冒充成交概率",
              { tree: "├", k: "① 金额", v: "商机金额与名下均值 ¥20.6 万对照" },
              { tree: "├", k: "② 阶段停留", v: "实际停留天数与该阶段正常周期对照（方案已报 = 10 天）" },
              { tree: "├", k: "③ 最近互动", v: "距最后一次有效沟通的天数，超 14 天开始扣分" },
              { tree: "└", k: "④ 承诺未兑现", v: "我方欠客户的事项，欠 1 项即进高优先" },
              { no: 1, text: "OPP-2026-0311 海川机械 · 高优先：金额 5.8 倍均值 · 停留 2.2 倍周期 · 我方欠 1 项" },
              { no: 2, text: `OPP-2026-0342 ${demoWorldFixture.deliveryOrder.customer} · 高优先：金额 3.3 倍均值 · 停留在正常区间 · 交付中订单托底` },
              { no: 3, text: "OPP-2026-0338 蓝谷自动化 · 中优先：阶段最靠后 · 但绑着一笔逾期 18 天的应收" },
              { no: 4, text: "低优先：OPP-2026-0298 会稀释海川主线；OPP-2026-0290 缺本月拿不出的认证材料；其余 18 个暂无线索要求本周优先" },
              { warn: `OPP-2026-0311 的扣分里有一条是我方原因：${demoWorldFixture.haichuanReport.promisedDate} 答应王志刚的 ${demoWorldFixture.haichuanReport.code} ${demoWorldFixture.haichuanReport.name}，截至 ${demoWorldFixture.demoDate.iso} 已逾期 ${demoWorldFixture.haichuanReport.overdueDays} 天` },
            ],
            status: "warn",
            panel: [
              { op: "focus", view: "crm" },
              { op: "toolbar", view: "crm", title: "CRM 客户与商机 · 已按四维证据分组", sub: "23 个商机 · 高 2 · 中 1 · 低 20" },
              { op: "tableRowUpdate", view: "crm", id: "o-0311", set: { cells: { score: "高 · 先补欠账" } } },
              { op: "cellFlag", view: "crm", rowId: "o-0311", colKey: "score", tone: "warn", flag: "含我方欠项" },
              { op: "tableRowUpdate", view: "crm", id: "o-0342", set: { cells: { score: "高 · 交付托底" } } },
              { op: "tableRowUpdate", view: "crm", id: "o-0338", set: { cells: { score: "中 · 先协同财务" } } },
              { op: "cellFlag", view: "crm", rowId: "o-0338", colKey: "score", tone: "warn", flag: "绑逾期应收" },
              { op: "tableRowUpdate", view: "crm", id: "o-0298", set: { cells: { score: "低 · 稀释主线" } } },
              { op: "tableRowUpdate", view: "crm", id: "o-0290", set: { cells: { score: "低 · 材料不齐" } } },
              { op: "tableRowUpdate", view: "crm", id: "o-rest", set: { cells: { score: "低 · 暂不优先" } } },
              { op: "feedAppend", view: "audit", item: { id: "au-2", from: "AI 同事", time: "09:06:41", text: "按金额 / 阶段停留 / 最近互动 / 承诺未兑现四维证据为 23 个商机分组，未合成总分" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "2 条" },
            ],
          },
        },
        {
          id: "p2-text",
          kind: "text",
          title: "业务进展",
          defaultOpen: true,
          content: [
            `四维证据摊开后，先说一条我自己查出来的事：**海川机械这 22 天没有推进，至少有一项我方欠账在制造阻力**。${demoWorldFixture.haichuanReport.promisedDate} 你答应王志刚补一份 ${demoWorldFixture.haichuanReport.code} ${demoWorldFixture.haichuanReport.name}，CRM 的承诺台账里这条还挂着未完成，截至 ${demoWorldFixture.demoDate.iso} 已逾期 ${demoWorldFixture.haichuanReport.overdueDays} 天。`,
            "",
            "这条会直接改变本周的打法——追进度之前，得先把欠的东西给出去。",
          ].join("\n"),
        },
      ],
    },

    {
      caption: "排出前三，并说清放一放的两个",
      blocks: [
        {
          id: "p3-tool",
          kind: "tool_use",
          title: "PriorityRank",
          defaultOpen: true,
          toolName: "PriorityRank",
          toolId: "t-rank",
          content: JSON.stringify({ owner: "张明远", top: 3 }),
          executionStatus: "completed",
          durationMs: 640,
          presentation: {
            title: "排出本周前三与建议放一放的两个",
            detail: [
              { no: 1, text: "OPP-2026-0311 海川机械 ¥120.0 万 · 本周第一优先" },
              { indent: 1, text: `金额是名下最大一笔；停在「方案已报」22 天，是该阶段正常周期 10 天的 2.2 倍；我方还欠一份 ${demoWorldFixture.haichuanReport.promisedDate} 承诺的 ${demoWorldFixture.haichuanReport.code} ${demoWorldFixture.haichuanReport.name}` },
              { no: 2, text: `OPP-2026-0342 ${demoWorldFixture.deliveryOrder.customer} ¥68.0 万 · 第二优先` },
              { indent: 1, text: `${demoWorldFixture.deliveryOrder.id} 正在交付，${demoWorldFixture.deliveryOrder.promisedDeliveryDate} 交期；去年 8 月同期客户下过一次年度补单，复购窗口可能就在本月` },
              { no: 3, text: "OPP-2026-0338 蓝谷自动化 ¥45.0 万 · 第三优先" },
              { indent: 1, text: "商机本身只停 6 天，健康；但 AR-2026-0058 ¥23.6 万逾期 18 天，回款不理清会先伤合作信任" },
              { insight: "两个建议先放一放：OPP-2026-0298（与二期同一决策人，会稀释主线）、OPP-2026-0290（卡在我方本月拿不出的认证材料）", label: "取舍" },
            ],
            status: "ok",
            panel: [
              { op: "focus", view: "crm" },
              { op: "toolbar", view: "crm", title: "CRM 客户与商机 · 本周推进排序", sub: "前三已标记 · 2 个建议放一放" },
              { op: "cellFlag", view: "crm", rowId: "o-0311", colKey: "score", tone: "pass", flag: "第 1 优先" },
              { op: "cellFlag", view: "crm", rowId: "o-0342", colKey: "score", tone: "pass", flag: "第 2 优先" },
              { op: "cellFlag", view: "crm", rowId: "o-0338", colKey: "score", tone: "pass", flag: "第 3 优先" },
              { op: "tableRowUpdate", view: "crm", id: "o-0298", set: { tone: "pending" } },
              { op: "cellFlag", view: "crm", rowId: "o-0298", colKey: "score", tone: "pending", flag: "本周放一放" },
              { op: "tableRowUpdate", view: "crm", id: "o-0290", set: { tone: "pending" } },
              { op: "cellFlag", view: "crm", rowId: "o-0290", colKey: "score", tone: "pending", flag: "本周放一放" },
              { op: "feedAppend", view: "audit", item: { id: "au-3", from: "AI 同事", time: "09:07:05", text: "输出本周推进排序：前三 + 2 个建议放一放，仅标记不改动商机字段" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "3 条" },
            ],
          },
        },
        {
          id: "p3-text",
          kind: "text",
          title: "结论",
          defaultOpen: true,
          content: [
            "本周把力气按这个顺序放：",
            "",
            `1. **海川机械 OPP-2026-0311**，¥120.0 万。理由不是它最大，是它最不该停：22 天卡在「方案已报」，而这个阶段的正常周期是 10 天；更关键的是我方欠着 ${demoWorldFixture.haichuanReport.code} ${demoWorldFixture.haichuanReport.name}，截至 ${demoWorldFixture.demoDate.iso} 已逾期 ${demoWorldFixture.haichuanReport.overdueDays} 天。先补交，再约面谈。`,
            `2. **${demoWorldFixture.deliveryOrder.customer} OPP-2026-0342**，¥68.0 万。${demoWorldFixture.deliveryOrder.id} 这批 ${demoWorldFixture.deliveryOrder.promisedDeliveryDate} 交期正在交付，客户手上有你在履约的证据，这是谈复购最好的时机。`,
            "3. **蓝谷自动化 OPP-2026-0338**，¥45.0 万。商机本身很顺，问题在旁边：AR-2026-0058 ¥23.6 万逾期 18 天。回款不谈清楚就推新单，两件事都会拖。",
            "",
            "另外两个我建议这周先放一放：",
            "",
            "- **OPP-2026-0298 海川备件 ¥18.0 万**，决策人也是王志刚。同一个人身上同时推两件事，二期这条主线会被稀释；",
            "- **OPP-2026-0290 Feldmann GmbH ¥30.0 万**，停了 41 天，卡点是对方要的认证材料我方本月拿不出来。这周投入换不来进展，不如等材料齐了再启动。",
            "",
            "有一条我给的把握不足，先说清楚：恒岳的复购窗口，我只找到去年 8 月一个历史样本。一个样本不构成规律，这条要你自己掂量。",
          ].join("\n"),
        },
      ],
    },

    {
      caption: "越权追问被拦截",
      blocks: [
        {
          id: "p4-prompt",
          kind: "prompt",
          title: "用户消息",
          defaultOpen: true,
          content: "顺便看下赵一楠手里的启润电子现在什么进展，能不能也一起分析下？我怕两边撞车。",
        },
        {
          id: "p4-tool",
          kind: "tool_use",
          title: "ScopeGate",
          defaultOpen: true,
          toolName: "ScopeGate",
          toolId: "t-scope",
          content: JSON.stringify({ requested: "启润电子", owner: "赵一楠", requester: "张明远" }),
          executionStatus: "completed",
          durationMs: 180,
          presentation: {
            title: "同事名下客户 · 权限判定",
            detail: [
              { k: "请求对象", v: "启润电子（联系人 何丽）" },
              { k: "客户归属", v: "赵一楠 · 非本人名下" },
              { verdict: "fail", text: "超出可分析范围，按权限矩阵拒绝", note: "未读取任何商机数据 · 拦截已记账" },
            ],
            status: "blocked",
            panel: [
              { op: "focus", view: "rights" },
              { op: "toolbar", view: "rights", title: "权限矩阵 · 本人可访问范围", sub: "命中 1 条拒绝" },
              { op: "tableRowInsert", view: "rights", row: { id: "r-own", cells: { domain: "本人名下客户与商机", grant: "允许", owner: "岗位表" } } },
              { op: "tableRowInsert", view: "rights", row: { id: "r-peer", cells: { domain: "同事名下客户与商机", grant: "拒绝", owner: "销售负责人" }, tone: "deny" } },
              { op: "cellFlag", view: "rights", rowId: "r-peer", colKey: "grant", tone: "deny", flag: "无授权" },
              { op: "tableRowInsert", view: "rights", row: { id: "r-team", cells: { domain: "全公司商机汇总", grant: "拒绝", owner: "销售负责人" } } },
              { op: "tableRowInsert", view: "rights", row: { id: "r-priv", cells: { domain: "客户联系人个人信息", grant: "受限", owner: "合规" } } },
              { op: "feedAppend", view: "audit", item: {
                id: "au-4",
                from: "AI 同事",
                time: "09:07:38",
                text: "对同事名下客户的分析请求被权限矩阵拦截，未发生任何数据读取",
                card: { title: "越权请求已拦截", body: "启润电子归属赵一楠，不在本人可分析范围；已给出两条合规路径", meta: [{ text: "未读取数据", tone: "pass" }, { text: "已记账", tone: "info" }] },
              } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "4 条" },
            ],
          },
        },
        {
          id: "p4-text",
          kind: "text",
          title: "回复",
          defaultOpen: true,
          content: [
            "**这条我不能看，也不会绕**。启润电子挂在赵一楠名下，我只能分析你名下的客户——右侧权限矩阵里这一行是明确拒绝的，我一条商机数据都没有读。",
            "",
            "想拿到这个信息，有两条正经路径：",
            "",
            "1. 让赵一楠自己发起一次同样的分析，他名下的客户他随时能看，结果他直接发你；",
            "2. 如果确实要跨人看，请销售负责人给你开一次范围授权，授权生效后我就能读。",
            "",
            "撞车这个担心是对的，但用不着看他的数据：你名下这三条里没有启润电子，本周的动作不会碰到他的客户。",
          ].join("\n"),
        },
      ],
    },

    {
      caption: "生成本周客户推进清单",
      blocks: [
        {
          id: "p5-tool",
          kind: "tool_use",
          title: "PlanCompose",
          defaultOpen: true,
          toolName: "PlanCompose",
          toolId: "t-plan",
          content: JSON.stringify({ owner: "张明远", planNo: "PLAN-0809-03" }),
          executionStatus: "completed",
          durationMs: 1320,
          presentation: {
            title: "编排《本周客户推进清单》",
            detail: [
              { k: "清单编号", v: `PLAN-${demoWorldFixture.demoDate.compact}-03 · ${demoWorldFixture.demoDate.iso}` },
              { k: "覆盖", v: "前三优先 + 2 个建议放一放" },
              { tree: "├", k: "每条含", v: "为什么是现在 · 本周动作 · 话术要点" },
              { tree: "├", k: "特别一段", v: "换到王志刚的位置看这 22 天" },
              { tree: "└", k: "示弱区", v: "2 条我不替你判断的事，已单列" },
            ],
            status: "ok",
            panel: [
              { op: "focus", view: "crm" },
              { op: "toolbar", view: "crm", title: "CRM 客户与商机 · 已生成推进清单", sub: "PLAN-0809-03 · 商机字段未改动" },
              { op: "feedAppend", view: "audit", item: { id: "au-5", from: "AI 同事", time: "09:08:20", text: "生成推进清单 PLAN-0809-03（本地产物，未写入任何业务系统）" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "5 条" },
            ],
          },
        },
        {
          id: "p5-text",
          kind: "text",
          title: "回复",
          defaultOpen: true,
          content: [
            "清单做好了，可以直接带去周会讲：",
            "",
            `[FILE]{"filePath":"${PLAN_PATH}","fileName":"本周客户推进清单.html","fileSize":${PLAN_SIZE_BYTES}}[/FILE]`,
            "",
            "里面有一段我特意换了个角度写：**换到王志刚的位置看这 22 天**——他那边看到的是方案报了、我们答应的报告没给、22 天没人跟进。你先看这一段，再决定周一怎么开口。",
            "",
            "清单编号 PLAN-0809-03，下次问「上周那份清单」我能直接调出来。",
          ].join("\n"),
        },
      ],
    },

    {
      caption: "创建跟进待办需你确认",
      blocks: [],
      approval: {
        title: "创建 3 条跟进待办并同步日程 · 需你确认",
        description: "确认后会在待办中心创建 3 条待办，并在你的日程上占 3 个时间块。这一步会改变业务系统，必须由你明确确认。",
        facts: [
          { label: "待办 1", value: "8-10 周一 09:30 前给王志刚发样件测试报告，并约二期方案面谈" },
          { label: "待办 2", value: "8-11 前与吴国栋确认恒岳复购的产能窗口，再联系郑海峰" },
          { label: "待办 3", value: "8-12 前与陈静对齐 AR-2026-0058 回款口径，再谈蓝谷新单" },
          { label: "写入范围", value: "待办中心 3 条 + 我的日程 3 个时间块" },
          { label: "不会改动", value: "商机阶段 · 客户归属 · 任何对外消息" },
        ],
        approveLabel: "确认创建",
        rejectLabel: "退回修改",
        approvedBlocks: [
          {
            id: "p6-human",
            kind: "prompt",
            title: "用户消息",
            defaultOpen: true,
            content: "后两条可以。第一条改一下：王志刚周一上午在客户现场开会，约拜访改到周三下午两点；样件测试报告我周一先发过去，不等见面。",
          },
          {
            id: "p6-tool",
            kind: "tool_use",
            title: "Approval",
            defaultOpen: true,
            toolName: "Approval",
            toolId: "t-approve",
            content: JSON.stringify({ planNo: "PLAN-0809-03", decision: "approved", modified: 1 }),
            executionStatus: "completed",
            durationMs: 420,
            presentation: {
              title: "待办已创建 · 含人工修改 1 项",
              detail: [
                { k: "人审记账", v: "采纳 2 项 · 修改 1 项 · 自动执行 0 项" },
                { k: "修改内容", v: "拜访时间 8-10 周一上午 → 8-12 周三 14:00" },
                { tree: "├", k: "TD-1181", v: "8-10 09:30 前发送样件测试报告 · 拜访另约周三 14:00" },
                { tree: "├", k: "TD-1182", v: "8-11 前与吴国栋确认恒岳产能窗口" },
                { tree: "├", k: "TD-1183", v: "8-12 前与陈静对齐蓝谷回款口径" },
                { tree: "└", k: "日程", v: "3 个时间块已占，周三 14:00 这块按你的时间落位" },
              ],
              status: "ok",
              receipt: { id: "TD-1181", system: "待办中心", readBack: true },
              panel: [
                { op: "focus", view: "todo" },
                { op: "toolbar", view: "todo", title: "待办中心 · 张明远", sub: "本周 3 条跟进待办 · 已同步日程" },
                { op: "rowsSet", view: "todo", rows: [
                  { id: "td-1181", text: "TD-1181 · 给王志刚发样件测试报告", sub: "8-10 09:30 前 · 拜访改约 8-12 周三 14:00", tone: "pass", state: "hit", badge: { text: "人工改期", tone: "warn" } },
                  { id: "td-1182", text: "TD-1182 · 与吴国栋确认恒岳产能窗口", sub: `8-11 前 · 关联 ${demoWorldFixture.deliveryOrder.id} 与 OPP-2026-0342`, tone: "pass", badge: { text: "已创建", tone: "pass" } },
                  { id: "td-1183", text: "TD-1183 · 与陈静对齐蓝谷回款口径", sub: "8-12 前 · 关联 AR-2026-0058", tone: "pass", badge: { text: "已创建", tone: "pass" } },
                  { id: "td-cal", text: "已同步到我的日程 · 3 个时间块", sub: "回执 CAL-0809-07 · 周三 14:00 为人工改期后的时间", tone: "info", badge: { text: "日程回执", tone: "info" } },
                ] },
                { op: "feedAppend", view: "audit", item: {
                  id: "au-6",
                  from: "张明远",
                  time: "09:09:14",
                  text: "确认创建 3 条跟进待办并同步日程：采纳 2 项、修改 1 项（拜访改到 8-12 周三 14:00）",
                  card: { title: "人审记录", body: "采纳 2 · 修改 1 · 自动执行 0", meta: [{ text: "AI 未自行写入", tone: "pass" }] },
                } },
                { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "6 条" },
              ],
            },
          },
          {
            id: "p6-text",
            kind: "text",
            title: "确认结果",
            defaultOpen: true,
            content: "三条都建好了：TD-1181 到 TD-1183。你改的那处我按新口径落的——报告周一发，拜访排在 8-12 周三 14:00，日程上这个时间块已经占住。清单 PLAN-0809-03 里的时间也同步改了。",
          },
        ],
        rejectedBlocks: [
          {
            id: "p6-rejected-tool",
            kind: "tool_use",
            title: "Approval",
            defaultOpen: true,
            toolName: "Approval",
            toolId: "t-reject",
            content: JSON.stringify({ planNo: "PLAN-0809-03", decision: "rejected" }),
            executionStatus: "completed",
            durationMs: 260,
            presentation: {
              title: "创建被退回 · 未写入任何系统",
              detail: [
                { k: "审批结果", v: "退回修改" },
                { k: "待办中心", v: "0 条写入" },
                { k: "我的日程", v: "未占用任何时间块" },
                { tree: "└", k: "留痕", v: "退回时间与当时的清单版本已记录" },
              ],
              status: "blocked",
              panel: [
                { op: "focus", view: "todo" },
                { op: "toolbar", view: "todo", title: "待办中心 · 张明远", sub: "本周 0 条跟进待办" },
                { op: "rowsSet", view: "todo", rows: [
                  { id: "td-hold", text: "3 条跟进待办未创建", sub: "审批未通过，待办中心与日程均无写入", tone: "warn", badge: { text: "已停住", tone: "warn" } },
                ] },
                { op: "feedAppend", view: "audit", item: { id: "au-reject", from: "张明远", time: "09:09:14", text: "退回待办创建：待办中心与日程零写入，清单产物保留" } },
              ],
            },
          },
          {
            id: "p6-rejected-text",
            kind: "text",
            title: "退回说明",
            defaultOpen: true,
            content: "已停在这里：待办一条没建，日程一个时间块没占。清单 PLAN-0809-03 还在，你随时能下载带走；改好时间口径再提交，我还是会先问你一次。",
          },
        ],
      },
    },

    {
      caption: "回读系统终态",
      blocks: [
        {
          id: "p7-tool",
          kind: "tool_use",
          title: "ReadBack",
          defaultOpen: true,
          toolName: "ReadBack",
          toolId: "t-readback",
          content: JSON.stringify({ owner: "张明远", planNo: "PLAN-0809-03" }),
          executionStatus: "completed",
          durationMs: 990,
          presentation: {
            title: "回读三个系统，核对说法是否一致",
            detail: [
              { k: "回读方式", v: "按对象编号逐个反查，不用本次会话的缓存" },
              { verdict: "pass", text: "CRM 客户与商机", note: "23 个商机字段与会话开始时一致 · 新增 3 条跟进记录" },
              { verdict: "pass", text: "待办中心", note: "TD-1181 / TD-1182 / TD-1183 · 责任人张明远" },
              { verdict: "pass", text: "我的日程", note: "3 个时间块 · 周三 14:00 为人工改期后的时间" },
              { insight: "三方一致，无未决动作；本次对外零触达", label: "结论" },
            ],
            status: "ok",
            panel: [
              { op: "focus", view: "audit" },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "7 条 · 含 1 条拦截" },
              { op: "feedAppend", view: "audit", item: { id: "au-7", from: "AI 同事", time: "09:09:52", text: "回读 CRM / 待办中心 / 日程，三方状态一致；本次未向任何客户发出消息" } },
            ],
          },
        },
        {
          id: "p7-text",
          kind: "text",
          title: "本次会话改变了什么",
          defaultOpen: true,
          content: [
            "## 本次会话改变了什么",
            "",
            "| 系统 | 终态 | 依据 |",
            "| --- | --- | --- |",
            "| CRM 客户与商机 | 23 个商机字段零改动，新增 3 条跟进记录 | 回读 OPP-2026-0311 / 0342 / 0338 |",
            "| 待办中心 | 3 条跟进待办 TD-1181~TD-1183，责任人张明远 | 创建回执 + 回读校验通过 |",
            "| 我的日程 | 3 个时间块，其中 8-12 周三 14:00 为人工改期 | 日程回执 CAL-0809-07 |",
            "| 操作留痕 | 7 条动作，含 1 条越权拦截 | 本次会话留痕 |",
            "",
            "## 本次会话没有做什么",
            "",
            "- 没有给任何客户发消息：王志刚、郑海峰、顾云帆那边今天什么都没收到，清单和待办都停在你这边；",
            "- 没有动商机阶段和金额：OPP-2026-0311 仍是「方案已报」，字段一个没改；",
            "- 没有碰同事的客户：启润电子在权限矩阵处被拦下，零读取；",
            "- 没有替你关掉任何商机：建议放一放的那两个只是排序靠后，既没关闭也没降级。",
          ].join("\n"),
        },
        {
          id: "p7-next",
          kind: "text",
          title: "下一步",
          defaultOpen: true,
          content: "以后可以让我每周一早上自动跑一遍，把优先级变化、新出现的停滞商机和我方欠客户的事直接推给你，随时说一声就行。",
        },
      ],
    },
  ],

  // 治理条款：state != exists 的条目就是「演示到真实」的距离
  sources: [
    {
      blockRef: "step1.tool.CRMQuery",
      producer: "租户业务数据连接器",
      state: "missing",
      gap: "通用的租户业务数据连接器不存在；读 CRM 客户与商机目前只能走客户自建 API 或数据库只读账号，且都不产出业务语义摘要",
    },
    {
      blockRef: "step2.tool.OpportunityEvidenceProfile",
      producer: "租户业务数据连接器（互动记录与承诺台账）",
      state: "missing",
      gap: "四因子里的「最近互动」「承诺未兑现」需要沟通记录与承诺台账两张表；这两张表在多数租户的 CRM 里根本没落库，连接器之外还要先有数据口径",
    },
    {
      blockRef: "step3.tool.PriorityRank",
      producer: "Agent 分析产出（排序与取舍说明）",
      state: "exists",
    },
    {
      blockRef: "step4.tool.ScopeGate",
      producer: "独立数据范围门禁",
      state: "needs-change",
      gap: "门禁判定形态已存在，但「按岗位归属做客户行级过滤」的规则表尚未产品化，现在只能判数据域、判不了归属人",
    },
    {
      blockRef: "step5.tool.PlanCompose",
      producer: "Agent 生成 HTML 产物",
      state: "exists",
    },
    {
      blockRef: "step6.tool.Approval",
      producer: "钉钉 DWS 连接器（待办创建与日程同步）",
      state: "needs-change",
      gap: "待办与日程写入能力已存在，但要改造成本步这种「批量提交 + 人工逐条改 + 回执回读」的摘要输出；另外「人改了哪一条」目前没有结构化字段",
    },
    {
      blockRef: "step7.tool.ReadBack",
      producer: "租户业务数据连接器（终态回读）",
      state: "missing",
      gap: "跨系统回读要先有各系统连接器；在此之前终态核对表只能人工整理，做不到按编号反查",
    },
    {
      blockRef: "step5.artifact.本周客户推进清单",
      producer: "Agent 生成 HTML 产物",
      state: "exists",
    },
  ],
};

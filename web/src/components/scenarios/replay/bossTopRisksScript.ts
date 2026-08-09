import type { SystemPanelSnapshot } from "@agent/shared";
import { demoWorldFixture } from "./demoWorldFixture";
import type { ReplayScript } from "./types";

/**
 * 钩子剧本：总经理从同一个入口追问经营风险。
 *
 * 回放不再拼接交付、应收、客诉三个独立故事，而是回答一个管理问题：
 * 从昨天到今天，哪些风险新增、恶化或解除，哪些取舍必须升级给老板。
 * 内容为虚构示例，不对应任何真实企业、订单或人员。
 */

const world = demoWorldFixture;
const RISK_BRIEF_PATH = `assets/demo/${world.demoDate.compact}-本日经营风险变化.html`;

const RISK_BRIEF_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<style>
  :root { --ink:#0f172a; --muted:#64748b; --line:#e2e8f0; --blue:#2e56e1; --red:#b91c1c; --amber:#b45309; --green:#15803d; }
  * { box-sizing:border-box; }
  body { margin:0; padding:22px; color:var(--ink); background:#fff; font:14px/1.65 "PingFang SC","Microsoft YaHei",system-ui,sans-serif; }
  .bar { padding:7px 10px; margin-bottom:16px; border:1px solid var(--line); border-radius:7px; color:var(--muted); background:#f8fafc; font-size:12px; }
  h1 { margin:0 0 3px; font-size:20px; }
  h2 { margin:18px 0 8px; font-size:15px; }
  .sub,.note { color:var(--muted); font-size:12px; }
  .stats { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; margin:14px 0; }
  .stat { padding:10px; border:1px solid var(--line); border-radius:8px; }
  .stat b { display:block; font-size:17px; }
  .stat span { color:var(--muted); font-size:12px; }
  table { width:100%; border-collapse:collapse; font-size:12px; }
  th,td { padding:8px 9px; border:1px solid var(--line); text-align:left; vertical-align:top; }
  th { color:var(--muted); background:#f8fafc; font-weight:500; }
  .bad { color:var(--red); font-weight:600; }
  .warn { color:var(--amber); font-weight:600; }
  .ok { color:var(--green); font-weight:600; }
  .box { margin-top:12px; padding:11px 13px; border-left:3px solid var(--blue); background:#f8fafc; }
  ul { margin:6px 0; padding-left:20px; }
  .foot { margin-top:18px; padding-top:10px; border-top:1px solid var(--line); color:var(--muted); font-size:11px; }
</style></head><body>
<div class="bar">经营晨检 / ${world.demoDate.iso} / 昨日 18:00 → 今日 07:50</div>
<h1>本日经营风险变化</h1>
<p class="sub">给总经理的决策页 · 只展示相较昨日发生变化的事项</p>

<div class="stats">
  <div class="stat"><b>${world.inTransitOrders.count} 张</b><span>在途订单 · ¥${world.inTransitOrders.totalAmountWan} 万</span></div>
  <div class="stat"><b>${world.receivables.count} 笔</b><span>未结应收 · ¥${world.receivables.totalAmountWan} 万</span></div>
  <div class="stat"><b class="bad">新增 1</b><span>今日进入升级队列</span></div>
  <div class="stat"><b class="ok">解除 1</b><span>有新证据支持移出</span></div>
</div>

<h2>昨日 → 今日变化</h2>
<table>
<thead><tr><th>变化</th><th>事项与当前负责人</th><th>暴露额</th><th>预计损失区间</th><th>置信度 / 证据新鲜度</th><th>为什么今天升级</th></tr></thead>
<tbody>
<tr><td class="bad">恶化</td><td>${world.deliveryOrder.id} · ${world.deliveryOrder.customer}<br>负责人：交付经理 周晓芸</td><td>¥${world.deliveryOrder.amountWan} 万</td><td>¥12~28 万</td><td>72% · 07:18 更新</td><td>供应商到料口径由 08-10 滑到 ${world.deliveryOrder.material.supplierVerbalDeliveryShort}，距 ${world.deliveryOrder.promisedDeliveryShort} 交付只剩 0 天装配缓冲；替代采购上限超出负责人权限。</td></tr>
<tr><td class="bad">新增</td><td>AR-2026-0061 · 蓝谷智造<br>负责人：财务经理 陈静</td><td>¥58.6 万</td><td>¥4~9.8 万</td><td>61% · 07:42 更新</td><td>客户首次书面提出 ¥9.8 万质量扣款，同时有 ¥42 万新单待放行；是否暂缓新单需要总经理取舍。</td></tr>
<tr><td class="ok">解除</td><td>${world.openComplaint.id} · ${world.openComplaint.customer}<br>负责人：客服经理 张明远</td><td>昨日 ¥6.8 万</td><td>残余 ¥0~0.8 万</td><td>88% · 07:26 更新</td><td>客户签收补发件并确认关闭，工单与签收回执一致；移出老板升级队列，保留 48 小时观察。</td></tr>
</tbody></table>

<div class="box"><strong>口径提醒</strong>：今日仍在升级队列的暴露额为 ¥145.0 万，它表示受影响业务规模，不是预计会损失的钱。按现有证据估算的损失区间为 ¥16~37.8 万；区间会随书面到料确认与扣款凭证更新。</div>

<h2>若老板今天不介入</h2>
<ul>
  <li>09:30 前拿不到书面到料确认，替代采购窗口可能关闭；交付项的预计损失区间可能扩大到 ¥20~36 万。</li>
  <li>¥42 万新单若照常放行，应收暴露额可能由 ¥58.6 万升至 ¥100.6 万；这仍不是损失，但会削弱谈判与回款抓手。</li>
  <li>以上是下行情景，不是必然结果；责任人仍会执行现有催料与对账动作。</li>
</ul>

<h2>建议老板决定的有限介入</h2>
<table>
<thead><tr><th>决策</th><th>授权边界</th><th>负责人</th><th>退出条件</th></tr></thead>
<tbody>
<tr><td>交付保底</td><td>若 09:30 前无书面确认，授权替代采购与加急物流合计不超过 ¥6.5 万</td><td>周晓芸</td><td>取得书面到料承诺或完成替代下单即退出</td></tr>
<tr><td>回款止扩</td><td>暂缓蓝谷 ¥42 万新单至 08-10 12:00，不取消订单，不改账期</td><td>陈静</td><td>扣款凭证核清并由财务负责人复核后放行</td></tr>
</tbody></table>

<p class="foot">本页为虚构回放产物。置信度是对当前证据支持程度的演示评分，不代表审计保证；所有金额均使用同一演示账套。</p>
</body></html>`;

const RISK_BRIEF_SIZE_BYTES = new TextEncoder().encode(RISK_BRIEF_HTML).length;

/** 面板底稿：变化清单 / 订单 / 应收 / 老板决策 / 责任动作 / 操作留痕 */
const PANEL_BASE: SystemPanelSnapshot = {
  title: "企业系统实况",
  live: true,
  activeView: "delta",
  foot: "已连接：经营快照 · 订单中心 · 应收台账 · 审批中心 · 责任动作板（演示）",
  views: [
    {
      key: "delta",
      label: "风险变化",
      winTitle: `经营风险变化 · ${world.demoDate.iso}`,
      toolbar: { title: "昨日 18:00 → 今日 07:50", sub: "尚未读取" },
      widget: {
        kind: "table",
        cols: [
          { key: "change", label: "变化" },
          { key: "object", label: "事项" },
          { key: "exposure", label: "暴露额", align: "right" },
          { key: "state", label: "状态", align: "right" },
        ],
        rows: [],
        empty: { title: "尚未生成风险变化" },
      },
    },
    {
      key: "orders",
      label: "订单中心",
      winTitle: "订单中心 · 在途订单",
      toolbar: { title: "在途订单", sub: "尚未读取" },
      widget: {
        kind: "table",
        cols: [
          { key: "no", label: "订单" },
          { key: "cust", label: "客户" },
          { key: "due", label: "交期" },
          { key: "state", label: "证据", align: "right" },
        ],
        rows: [],
        empty: { title: "尚未读取订单" },
      },
    },
    {
      key: "ar",
      label: "应收台账",
      winTitle: "应收台账 · 未结应收",
      toolbar: { title: "未结应收", sub: "尚未读取" },
      widget: {
        kind: "table",
        cols: [
          { key: "no", label: "单号" },
          { key: "cust", label: "客户" },
          { key: "amount", label: "金额" },
          { key: "state", label: "变化", align: "right" },
        ],
        rows: [],
        empty: { title: "尚未读取应收" },
      },
    },
    {
      key: "decisions",
      label: "老板决策",
      winTitle: "审批中心 · 有限介入",
      toolbar: { title: "待决策", sub: "0 项" },
      widget: { kind: "rows", rows: [], empty: { title: "尚无待决策事项" } },
    },
    {
      key: "actions",
      label: "责任动作",
      winTitle: "责任动作板 · 今日",
      toolbar: { title: "责任动作", sub: "尚未创建" },
      widget: { kind: "rows", rows: [], empty: { title: "尚无授权动作" } },
    },
    {
      key: "audit",
      label: "操作留痕",
      winTitle: "操作留痕 · 本次会话",
      toolbar: { title: "系统动作", sub: "0 条" },
      widget: { kind: "feed", items: [], empty: { title: "推进后显示动作" } },
    },
  ],
};

export const bossTopRisksScript: ReplayScript = {
  scenarioId: "catalog-hook-boss-top-risks",
  title: "这个月经营风险，今天有什么变化需要我拍板",
  mode: "hero",
  artifacts: { [RISK_BRIEF_PATH]: RISK_BRIEF_HTML },

  steps: [
    {
      caption: "对比昨日与今日经营快照",
      blocks: [
        {
          id: "b1-tool",
          kind: "tool_use",
          title: "DailyDeltaQuery",
          defaultOpen: true,
          toolName: "DailyDeltaQuery",
          toolId: "t-delta-query",
          content: JSON.stringify({ baselineAt: "2026-08-08T18:00:00+08:00", currentAt: "2026-08-09T07:50:00+08:00" }),
          executionStatus: "completed",
          durationMs: 1380,
          presentation: {
            title: "同口径读取两份快照",
            detail: [
              { k: "演示日期", v: world.demoDate.iso },
              { k: "订单底盘", v: `${world.inTransitOrders.count} 张在途 · ¥${world.inTransitOrders.totalAmountWan} 万` },
              { k: "应收底盘", v: `${world.receivables.count} 笔未结 · ¥${world.receivables.totalAmountWan} 万` },
              { k: "比较窗口", v: "昨日 18:00 → 今日 07:50 · 字段与阈值一致" },
              { insight: "只保留发生变化的事项；存量高风险但无新变化的不重复打扰老板", label: "筛选口径" },
            ],
            status: "ok",
            panelBase: PANEL_BASE,
            panel: [
              { op: "focus", view: "delta" },
              { op: "toolbar", view: "delta", title: "昨日 18:00 → 今日 07:50", sub: "3 项发生变化" },
              { op: "tableRowInsert", view: "delta", row: { id: "d-delivery", cells: { change: "恶化", object: `${world.deliveryOrder.id} · ${world.deliveryOrder.customer}`, exposure: `¥${world.deliveryOrder.amountWan} 万`, state: "待升级" }, tone: "deny" } },
              { op: "tableRowInsert", view: "delta", row: { id: "d-ar", cells: { change: "新增", object: "AR-2026-0061 · 蓝谷智造", exposure: "¥58.6 万", state: "待升级" }, tone: "deny" } },
              { op: "tableRowInsert", view: "delta", row: { id: "d-complaint", cells: { change: "解除", object: `${world.openComplaint.id} · ${world.openComplaint.customer}`, exposure: "昨日 ¥6.8 万", state: "移出" }, tone: "pass" } },
              { op: "toolbar", view: "orders", title: `在途订单 · ${world.inTransitOrders.count} 张`, sub: `合计 ¥${world.inTransitOrders.totalAmountWan} 万` },
              { op: "tableRowInsert", view: "orders", row: { id: "so-1027", cells: { no: world.deliveryOrder.id, cust: world.deliveryOrder.customer, due: world.deliveryOrder.promisedDeliveryShort, state: "到料口径滑期" }, tone: "warn" } },
              { op: "toolbar", view: "ar", title: `未结应收 · ${world.receivables.count} 笔`, sub: `合计 ¥${world.receivables.totalAmountWan} 万` },
              { op: "tableRowInsert", view: "ar", row: { id: "ar-61", cells: { no: "AR-2026-0061", cust: "蓝谷智造", amount: "¥58.6 万", state: "新增争议" }, tone: "warn" } },
              { op: "feedAppend", view: "audit", item: { id: "au-b1", from: "AI 同事", time: "07:50:18", text: "按同口径完成昨日与今日快照差分，命中 3 项变化" } },
              { op: "toolbar", view: "audit", title: "系统动作", sub: "1 条" },
            ],
          },
        },
        {
          id: "b1-text",
          kind: "text",
          title: "回复",
          defaultOpen: true,
          content: `我不先报“金额最大的三件事”，而是先看从昨天到今天发生了什么。${world.inTransitOrders.count} 张在途订单合计 ¥${world.inTransitOrders.totalAmountWan} 万、${world.receivables.count} 笔未结应收合计 ¥${world.receivables.totalAmountWan} 万；同口径差分后只有 3 项需要解释：新增 1、恶化 1、解除 1。`,
        },
      ],
    },

    {
      caption: "判定新增、恶化与解除",
      blocks: [
        {
          id: "b2-tool",
          kind: "tool_use",
          title: "RiskDeltaClassify",
          defaultOpen: true,
          toolName: "RiskDeltaClassify",
          toolId: "t-risk-classify",
          content: JSON.stringify({ changes: [world.deliveryOrder.id, "AR-2026-0061", world.openComplaint.id], includeEvidenceFreshness: true }),
          executionStatus: "completed",
          durationMs: 920,
          presentation: {
            title: "把业务暴露与预计损失分开",
            detail: [
              { verdict: "fail", text: `恶化 · ${world.deliveryOrder.id}`, note: `暴露 ¥${world.deliveryOrder.amountWan} 万；预计损失 ¥12~28 万；置信度 72%；证据 07:18；负责人 周晓芸` },
              { verdict: "fail", text: "新增 · AR-2026-0061", note: "暴露 ¥58.6 万；预计损失 ¥4~9.8 万；置信度 61%；证据 07:42；负责人 陈静" },
              { verdict: "pass", text: `解除 · ${world.openComplaint.id}`, note: "昨日暴露 ¥6.8 万；残余损失 ¥0~0.8 万；置信度 88%；证据 07:26；负责人 张明远" },
              { insight: "今日仍在升级队列的暴露额 ¥145.0 万，不等于预计损失；当前损失估计合计 ¥16~37.8 万", label: "金额口径" },
            ],
            status: "ok",
            panel: [
              { op: "focus", view: "delta" },
              { op: "cellFlag", view: "delta", rowId: "d-delivery", colKey: "change", tone: "deny", flag: "较昨日恶化" },
              { op: "cellFlag", view: "delta", rowId: "d-ar", colKey: "change", tone: "deny", flag: "今日新增" },
              { op: "cellFlag", view: "delta", rowId: "d-complaint", colKey: "change", tone: "pass", flag: "证据支持解除" },
              { op: "feedAppend", view: "audit", item: { id: "au-b2", from: "AI 同事", time: "07:51:04", text: "完成风险变化判定，并记录预计损失区间、置信度、证据时间与当前负责人" } },
              { op: "toolbar", view: "audit", title: "系统动作", sub: "2 条" },
            ],
          },
        },
        {
          id: "b2-text",
          kind: "text",
          title: "判断",
          defaultOpen: true,
          content: [
            "今天真正升级给你的只有两项。不是因为它们的暴露额大，而是普通责任人已经碰到授权边界：交付负责人无权批 ¥6.5 万保底采购，财务负责人无权决定是否暂缓一张 ¥42 万新单。",
            "",
            `第三项 ${world.openComplaint.id} 有客户签收与关闭确认两份新证据，今天从升级队列解除，只保留 48 小时观察。解除也写进日报，避免昨天的风险今天还被重复汇报。`,
          ].join("\n"),
        },
      ],
    },

    {
      caption: "推演老板不介入的下行情景",
      blocks: [
        {
          id: "b3-tool",
          kind: "tool_use",
          title: "InterventionScenario",
          defaultOpen: true,
          toolName: "InterventionScenario",
          toolId: "t-intervention-scenario",
          content: JSON.stringify({ activeExposureWan: 145, compare: ["no_intervention", "limited_intervention"] }),
          executionStatus: "completed",
          durationMs: 1040,
          presentation: {
            title: "不介入与有限介入的代价",
            detail: [
              { k: "交付 · 不介入", v: "09:30 后替代采购窗口可能关闭；预计损失区间可能扩大到 ¥20~36 万" },
              { k: "回款 · 不介入", v: "¥42 万新单若放行，暴露额可能由 ¥58.6 万升至 ¥100.6 万；不是新增预计损失" },
              { k: "有限介入", v: "保底采购封顶 ¥6.5 万 + 暂缓新单至 08-10 12:00；不取消订单、不改账期" },
              { insight: "下行情景用于说明今天为什么升级，不是对损失的承诺；责任人的常规催料与对账仍会继续", label: "边界" },
            ],
            status: "ok",
            panel: [
              { op: "focus", view: "decisions" },
              { op: "toolbar", view: "decisions", title: "待老板取舍", sub: "2 项 · 尚未授权" },
              { op: "rowsSet", view: "decisions", rows: [
                { id: "decision-delivery", text: "交付保底 · 授权上限 ¥6.5 万", sub: "仅在 09:30 前仍无书面到料确认时启用 · 负责人周晓芸", tone: "warn", badge: { text: "待决定", tone: "warn" } },
                { id: "decision-ar", text: "回款止扩 · 暂缓 ¥42 万新单", sub: "至 08-10 12:00 · 核清扣款凭证后由财务复核放行", tone: "warn", badge: { text: "待决定", tone: "warn" } },
              ] },
              { op: "feedAppend", view: "audit", item: { id: "au-b3", from: "AI 同事", time: "07:52:20", text: "完成不介入与有限介入推演，未创建授权或待办" } },
              { op: "toolbar", view: "audit", title: "系统动作", sub: "3 条" },
            ],
          },
        },
        {
          id: "b3-text",
          kind: "text",
          title: "为什么今天找你",
          defaultOpen: true,
          content: "如果你不介入，团队不是停工，而是只能继续现有催料和对账。今天找你，是因为两个带时限的窗口正在关闭：一个决定是否用最多 ¥6.5 万买交付确定性，一个决定是否先控制新增 ¥42 万暴露。",
        },
      ],
    },

    {
      caption: "生成本日风险决策页",
      blocks: [
        {
          id: "b4-tool",
          kind: "tool_use",
          title: "ReportBuild",
          defaultOpen: true,
          toolName: "ReportBuild",
          toolId: "t-risk-report",
          content: JSON.stringify({ doc: "本日经营风险变化", date: world.demoDate.iso }),
          executionStatus: "completed",
          durationMs: 1180,
          presentation: {
            title: "生成本日经营风险变化决策页",
            detail: [
              { k: "变化", v: "新增 1 · 恶化 1 · 解除 1" },
              { k: "活跃暴露额", v: "¥145.0 万 · 已标明不等于预计损失" },
              { k: "预计损失", v: "¥16~37.8 万 · 每项附置信度与证据时间" },
              { k: "待老板决定", v: "2 项有限介入 · 均有金额、时限、负责人和退出条件" },
            ],
            status: "ok",
            panel: [
              { op: "focus", view: "delta" },
              { op: "feedAppend", view: "audit", item: { id: "au-b4", from: "AI 同事", time: "07:53:12", text: "生成《本日经营风险变化》，未写入订单、应收或客诉单据" } },
              { op: "toolbar", view: "audit", title: "系统动作", sub: "4 条" },
            ],
          },
        },
        {
          id: "b4-text",
          kind: "text",
          title: "决策材料",
          defaultOpen: true,
          content: [
            "决策页已经按“昨天发生了什么变化”整理，不把暴露额当损失，也没有把已解除事项继续算进升级队列：",
            "",
            `[FILE]{"filePath":"${RISK_BRIEF_PATH}","fileName":"本日经营风险变化.html","fileSize":${RISK_BRIEF_SIZE_BYTES}}[/FILE]`,
            "",
            "下一步不是改通知措辞，而是由你决定要不要介入，以及愿意给多大的授权边界。",
          ].join("\n"),
        },
      ],
    },

    {
      caption: "老板决定是否有限介入",
      blocks: [
        {
          id: "b5-gate",
          kind: "tool_use",
          title: "DecisionGate",
          defaultOpen: true,
          toolName: "DecisionGate",
          toolId: "t-boss-decision-gate",
          content: JSON.stringify({ package: "limited_intervention", decisions: 2 }),
          executionStatus: "completed",
          durationMs: 280,
          presentation: {
            title: "等待总经理决定介入取舍",
            detail: [
              { k: "交付授权", v: "条件触发 · 替代采购与加急物流合计封顶 ¥6.5 万" },
              { k: "回款授权", v: "暂缓蓝谷 ¥42 万新单至 08-10 12:00" },
              { k: "审批影响", v: "批准后创建 2 张授权动作卡；退回则维持现状，不写业务单据" },
              { insight: "这是资源与风险敞口的取舍，不是让老板润色一条通知", label: "决策性质" },
            ],
            status: "waiting",
            panel: [
              { op: "focus", view: "decisions" },
              { op: "feedAppend", view: "audit", item: { id: "au-b5", from: "AI 同事", time: "07:54:03", text: "有限介入方案进入总经理审批，当前未授权、未写入" } },
              { op: "toolbar", view: "audit", title: "系统动作", sub: "5 条" },
            ],
          },
        },
      ],
      approval: {
        title: "是否批准有限介入方案",
        description: "批准代表接受两项带上限、时限与退出条件的授权；不是修改提醒话术。退回后责任人仍执行常规动作，可调整授权边界后再次提交。",
        facts: [
          { label: "交付项", value: "09:30 前无书面确认才启用 · 支出封顶 ¥6.5 万" },
          { label: "回款项", value: "暂缓 ¥42 万新单至 08-10 12:00 · 不取消订单" },
          { label: "活跃暴露额", value: "¥145.0 万 · 不等于预计损失" },
          { label: "预计损失区间", value: "¥16~37.8 万 · 当前证据下的估计" },
          { label: "当前负责人", value: "周晓芸 / 陈静" },
        ],
        approveLabel: "批准有限介入",
        rejectLabel: "退回调整边界",
        approvedBlocks: [
          {
            id: "b5-approved-tool",
            kind: "tool_use",
            title: "InterventionAuthorize",
            defaultOpen: true,
            toolName: "InterventionAuthorize",
            toolId: "t-intervention-authorize",
            content: JSON.stringify({ decisionId: "DEC-2026-0809-01", approved: true, authorizations: 2 }),
            executionStatus: "completed",
            durationMs: 860,
            presentation: {
              title: "有限介入已批准 · 授权边界已落卡",
              detail: [
                { verdict: "pass", text: "交付保底授权", note: "AUTH-0810 · 条件触发 · 上限 ¥6.5 万 · 周晓芸 · 今日 12:00 到期" },
                { verdict: "pass", text: "回款止扩授权", note: "AUTH-0811 · 暂缓新单至 08-10 12:00 · 陈静" },
                { k: "原始单据", v: "订单交期、应收账期、客诉状态均未由本次审批改写" },
                { insight: "审批决定、授权范围、批准人与退出条件已记录", label: "留痕" },
              ],
              status: "ok",
              panel: [
                { op: "focus", view: "actions" },
                { op: "toolbar", view: "actions", title: "责任动作", sub: "2 张授权卡 · 生效中" },
                { op: "rowsSet", view: "actions", rows: [
                  { id: "auth-810", text: "AUTH-0810 · 交付保底", sub: "周晓芸 · 条件触发 · 上限 ¥6.5 万 · 今日 12:00 到期", tone: "pass", badge: { text: "已授权", tone: "pass" } },
                  { id: "auth-811", text: "AUTH-0811 · 回款止扩", sub: "陈静 · 暂缓蓝谷新单至 08-10 12:00", tone: "pass", badge: { text: "已授权", tone: "pass" } },
                ] },
                { op: "rowsUpdate", view: "decisions", ids: ["decision-delivery", "decision-ar"], set: { tone: "pass", badge: { text: "已批准", tone: "pass" } } },
                { op: "feedAppend", view: "audit", item: { id: "au-b5a", from: "总经理 沈建国", time: "07:54:42", text: "批准有限介入：2 项授权按金额、时限与退出条件落卡" } },
                { op: "toolbar", view: "audit", title: "系统动作", sub: "6 条" },
              ],
            },
          },
          {
            id: "b5-approved-text",
            kind: "text",
            title: "审批结果",
            defaultOpen: true,
            content: "两项有限介入已经按原边界落卡：周晓芸拿到条件触发的 ¥6.5 万封顶授权，陈静拿到暂缓蓝谷新单的时限授权。没有替任何负责人下业务结论，也没有直接改订单交期或应收账期。",
          },
        ],
        rejectedBlocks: [
          {
            id: "b5-rejected-tool",
            kind: "tool_use",
            title: "Approval",
            defaultOpen: true,
            toolName: "Approval",
            toolId: "t-intervention-reject",
            content: JSON.stringify({ decisionId: "DEC-2026-0809-01", decision: "rejected" }),
            executionStatus: "completed",
            durationMs: 260,
            presentation: {
              title: "方案已退回 · 未授予任何新增权限",
              detail: [
                { k: "授权卡", v: "0 张创建" },
                { k: "业务单据", v: "订单、应收与客诉均无写入" },
                { k: "现有动作", v: "责任人的催料与对账继续，不因退回中断" },
                { insight: "退回原因与原方案已记录，可调整金额、时限或只批准其中一项后重提", label: "后续" },
              ],
              status: "blocked",
              panel: [
                { op: "focus", view: "decisions" },
                { op: "rowsUpdate", view: "decisions", ids: ["decision-delivery", "decision-ar"], set: { tone: "warn", badge: { text: "待调整", tone: "warn" } } },
                { op: "feedAppend", view: "audit", item: { id: "au-b5r", from: "总经理 沈建国", time: "07:54:42", text: "有限介入方案退回调整；0 张授权卡创建，业务单据无写入" } },
                { op: "toolbar", view: "audit", title: "系统动作", sub: "6 条" },
              ],
            },
          },
          {
            id: "b5-rejected-text",
            kind: "text",
            title: "退回说明",
            defaultOpen: true,
            content: "已停在授权前：责任人的常规催料和对账继续，但没有新增支出权限，也没有暂缓新单。风险决策页仍可下载；可以只改金额上限、暂缓时限或拆成单项，再重新提交给你决定。",
          },
        ],
      },
    },

    {
      caption: "回读授权与业务终态",
      blocks: [
        {
          id: "b6-tool",
          kind: "tool_use",
          title: "ReadBack",
          defaultOpen: true,
          toolName: "ReadBack",
          toolId: "t-boss-readback",
          content: JSON.stringify({ decision: "DEC-2026-0809-01", authorizations: ["AUTH-0810", "AUTH-0811"], businessObjects: [world.deliveryOrder.id, "AR-2026-0061", world.openComplaint.id] }),
          executionStatus: "completed",
          durationMs: 980,
          presentation: {
            title: "按对象编号回读终态",
            detail: [
              { verdict: "pass", text: "审批中心", note: "DEC-2026-0809-01 已批准 · 2 项有限介入" },
              { verdict: "pass", text: "责任动作板", note: "AUTH-0810 / AUTH-0811 的负责人、上限、时限与退出条件一致" },
              { verdict: "pass", text: "订单与应收", note: "原交期与原账期未被本次会话改写" },
              { verdict: "pass", text: "风险变化页", note: "新增 1 · 恶化 1 · 解除 1；证据时间均在册" },
            ],
            status: "ok",
            panel: [
              { op: "focus", view: "actions" },
              { op: "toolbar", view: "actions", title: "责任动作 · 终态回读", sub: "2/2 一致" },
              { op: "feedAppend", view: "audit", item: { id: "au-b6", from: "AI 同事", time: "07:55:30", text: "回读审批、授权动作与原始业务对象，2 项授权一致，业务字段无意外改写" } },
              { op: "toolbar", view: "audit", title: "系统动作", sub: "7 条" },
            ],
          },
        },
        {
          id: "b6-text",
          kind: "text",
          title: "本次会话终态",
          defaultOpen: true,
          content: [
            "## 跨系统核对",
            "",
            "| 系统 | 终态 | 核对依据 |",
            "| --- | --- | --- |",
            "| 经营风险变化 | 新增 1、恶化 1、解除 1 | 昨日 18:00 与今日 07:50 同口径差分 |",
            "| 审批中心 | DEC-2026-0809-01 已批准 | 有限介入 2 项，批准人与边界在册 |",
            "| 责任动作板 | AUTH-0810 / AUTH-0811 生效 | 负责人、金额上限、时限、退出条件回读一致 |",
            `| 订单中心 | ${world.deliveryOrder.id} 交期仍为 ${world.deliveryOrder.promisedDeliveryShort} | 本次仅授权条件性保底动作 |`,
            "| 应收台账 | AR-2026-0061 账期未改 | 新单暂缓是授权动作，不是改账 |",
            "",
            "## 本次会话没有做什么",
            "",
            "- 没有把 ¥145.0 万暴露额说成必然损失，也没有把 ¥16~37.8 万区间包装成承诺；",
            "- 没有读取私人聊天、个人通讯或其他与经营证据无关的数据；",
            "- 没有替负责人下采购单、取消客户订单、修改交期或改应收账期；",
            "- 没有让老板润色通知，老板审批的是是否介入以及授权到什么边界。",
          ].join("\n"),
        },
      ],
    },
  ],

  sources: [
    {
      blockRef: "step1.tool.DailyDeltaQuery",
      producer: "租户业务数据连接器",
      state: "missing",
      gap: "缺少能按同一时间点回放订单、应收与客诉快照并做字段级差分的统一连接器；当前只能人工导出后比对",
    },
    {
      blockRef: "step2.tool.RiskDeltaClassify",
      producer: "Agent 风险变化判定（会话内分析）",
      state: "exists",
    },
    {
      blockRef: "step3.tool.InterventionScenario",
      producer: "Agent 情景推演（会话内分析）",
      state: "exists",
    },
    {
      blockRef: "step4.tool.ReportBuild",
      producer: "Agent 生成 HTML 产物",
      state: "exists",
    },
    {
      blockRef: "step4.artifact.本日经营风险变化",
      producer: "Agent 生成 HTML 产物",
      state: "exists",
    },
    {
      blockRef: "step5.tool.DecisionGate",
      producer: "审批范围门禁",
      state: "needs-change",
      gap: "审批门禁可阻断执行，但金额上限、触发条件、时限与退出条件还没有统一的结构化策略模型",
    },
    {
      blockRef: "step5.tool.InterventionAuthorize",
      producer: "审批中心与责任动作板连接器",
      state: "missing",
      gap: "尚无连接器能把一笔审批拆成带条件、上限和退出条件的授权卡，并在写后按编号回读",
    },
    {
      blockRef: "step5.tool.Approval",
      producer: "审批中心",
      state: "needs-change",
      gap: "退回留痕可记录，但按金额、时限或单项拆分后重提仍需人工整理",
    },
    {
      blockRef: "step6.tool.ReadBack",
      producer: "业务终态回读器",
      state: "missing",
      gap: "缺少跨审批中心、责任动作板、订单与应收的统一对象回读器，当前无法自动证明授权边界与业务终态一致",
    },
  ],
};

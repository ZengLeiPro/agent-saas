import type { SystemPanelSnapshot } from "@agent/shared";
import type { ReplayScript } from "./types";

/**
 * 剧本：这周的获客内容数据怎么样，哪条值得加推。
 *
 * 岗位视角＝市场 苏婷。四要素落位：
 *   ① 主动拒绝——第 4 步「直接下单投流」被付费动作门禁拦下，给两条替代路径；
 *   ② 视角切换——第 6 步产物是销售张明远此刻在待办里点开线索看到的那张卡；
 *   ③ 跨系统核对——终态用一张表把内容看板 / 线索台账 / 待办中心 / 企业 IM 摆在一起；
 *   ④ 可下载产物——本周复盘与加推方案 HTML，右侧预览 + 本地下载。
 * 外加：人可以改掉 AI 的分配结论并被记账（第 6 步），退回不是死路（rejectedBlocks）。
 *
 * 内容为虚构示例，不对应任何真实企业、内容或线索。
 */

const REVIEW_PATH = "assets/demo/本周内容复盘与加推方案.html";
const LEAD_CARD_PATH = "assets/demo/线索派发卡-张明远.html";

const DOC_CSS = `
  :root { --brand: #2E56E1; --ink: #0f172a; --muted: #64748b; --line: #e2e8f0; --ok: #15803d; --warn: #b45309; --deny: #b91c1c; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 20px; font: 14px/1.7 "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; color: var(--ink); background: #fff; }
  .bar { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border: 1px solid var(--line); border-radius: 6px; background: #f8fafc; color: var(--muted); font-size: 12px; margin-bottom: 16px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #cbd5e1; }
  h1 { margin: 0 0 4px; font-size: 16px; }
  .sub { margin: 0 0 16px; color: var(--muted); font-size: 12px; }
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 14px; }
  .stat { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; }
  .stat b { display: block; font-size: 18px; }
  .stat span { color: var(--muted); font-size: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 14px; }
  th, td { border: 1px solid var(--line); padding: 7px 10px; text-align: left; vertical-align: top; }
  th { background: #f8fafc; color: var(--muted); font-weight: 500; }
  td.num { text-align: right; }
  .ok { color: var(--ok); font-weight: 600; }
  .warn { color: var(--warn); font-weight: 600; }
  .deny { color: var(--deny); font-weight: 600; }
  .box { border: 1px solid var(--line); border-radius: 8px; padding: 12px; margin-bottom: 12px; }
  .box h2 { margin: 0 0 8px; font-size: 13px; }
  .kv { display: grid; grid-template-columns: 108px 1fr; gap: 4px 12px; font-size: 13px; }
  .kv span:nth-child(odd) { color: var(--muted); }
  ul { margin: 6px 0 0; padding-left: 18px; }
  li { margin-bottom: 4px; }
  .foot { margin-top: 14px; color: var(--muted); font-size: 12px; }
`;

const REVIEW_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<style>${DOC_CSS}</style></head><body>
<div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span>市场部内部文档 · 本周内容复盘 · 2026-08-03 ~ 2026-08-09</span></div>

<h1>本周内容复盘与加推方案</h1>
<p class="sub">统计口径：8-03 00:00 ~ 8-09 12:00 · 三平台 12 条内容 · 整理人：市场 苏婷 · AI 同事协助</p>

<div class="stats">
  <div class="stat"><b>12</b><span>本周发布内容</span></div>
  <div class="stat"><b>1,126</b><span>落地页访问</span></div>
  <div class="stat"><b>9</b><span>留资</span></div>
  <div class="stat"><b>0.8%</b><span>整体留资率</span></div>
</div>

<table>
  <tr><th>内容</th><th>平台</th><th>播放 / 阅读</th><th>落地页</th><th>留资</th><th>留资率</th><th>判定</th></tr>
  <tr><td>C-0806 注塑车间实拍：从粒料到结构件</td><td>视频号</td><td class="num">19,300</td><td class="num">194</td><td class="num">6</td><td class="num">3.1%</td><td class="ok">建议加推</td></tr>
  <tr><td>C-0803 20 秒看懂精密结构件</td><td>抖音</td><td class="num">48,600</td><td class="num">312</td><td class="num">0</td><td class="num">0%</td><td class="deny">不建议加推</td></tr>
  <tr><td>C-0808 模具报价怎么算</td><td>抖音</td><td class="num">22,400</td><td class="num">41</td><td class="num">0</td><td class="num">0%</td><td class="warn">数据存疑，本周不排名</td></tr>
  <tr><td>C-0801 模具试模常踩的 7 个坑</td><td>公众号</td><td class="num">1,240</td><td class="num">86</td><td class="num">1</td><td class="num">1.2%</td><td>维持</td></tr>
  <tr><td>其余 8 条（合计）</td><td>三平台</td><td class="num">31,500</td><td class="num">493</td><td class="num">2</td><td class="num">0.4%</td><td>维持</td></tr>
</table>

<div class="box">
  <h2>判定理由</h2>
  <ul>
    <li><b>C-0806 值得加推</b>：本周 9 条留资里它占 6 条；留资率 3.1% 是整体 0.8% 的 3.9 倍；6 条留资中 4 条在视频第 42 秒（车间产能镜头）后两分钟内提交；来源行业里汽配与家电结构件 5 条，与主营重合。</li>
    <li><b>C-0803 不建议加推</b>：播放 48,600 是本周最高，落地页也进了 312 人，但留资 0；停留中位数 8 秒、完播率 6%。它带来的是泛流量，热闹但不获客，加推只会把预算摊薄。</li>
    <li><b>C-0808 先排除再判断</b>：22,400 播放里 78% 集中在 02:00–04:00，落地页点击率 0.18%，约为该平台同类内容的九分之一。这条本周不参与排名，也不建议基于它做任何结论。</li>
  </ul>
</div>

<div class="box">
  <h2>加推方案（待预算审批，尚未产生任何费用）</h2>
  <div class="kv">
    <span>可用预算池</span><span>¥8,000（市场部本周剩余）</span>
    <span>主投</span><span>C-0806 原片加推 ¥5,000 · 定向：汽配 / 家电结构件采购与研发岗</span>
    <span>变体 A</span><span>¥1,500 · 换开头 3 秒：车间全景改为「一颗粒料到成品」的对比镜头</span>
    <span>变体 B</span><span>¥1,500 · 换标题关键词：「注塑车间」改为「精密结构件 打样」</span>
    <span>止损线</span><span>第 3 天留资低于 4 条即停投，剩余预算退回</span>
  </div>
  <ul>
    <li>预期：按本周 3.1% 留资率外推，¥5,000 主投约对应 8~15 条留资。这是外推不是承诺，加推人群比自然流量宽，留资率通常会被稀释。</li>
    <li>两个变体没有历史数据，我给不出区间，只能各用 ¥1,500 小额试，第 3 天用留资数对比再决定谁继续。</li>
  </ul>
</div>

<div class="box">
  <h2>本周 9 条留资去向</h2>
  <ul>
    <li>6 条来自 C-0806，联系方式与需求完整，建议建档并分配给销售跟进。</li>
    <li>1 条来自 C-0801，与台账里已有线索为同一手机号，标记为重复，挂到原线索下不新建。</li>
    <li>1 条只填了公司名与行业，没有任何联系方式，无法建档。</li>
    <li>1 条备注写明是在校学生做课题咨询，不作为商机建档。</li>
  </ul>
</div>

<p class="foot">示例内容，数据与线索均为虚构，不对应任何真实企业或个人。本方案未产生任何投放动作与费用。</p>
</body></html>`;

const LEAD_CARD_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<style>${DOC_CSS}
  .card { border: 1px solid var(--line); border-radius: 10px; padding: 12px; margin-bottom: 10px; }
  .card h3 { margin: 0 0 6px; font-size: 14px; }
  .tag { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; background: #eef2ff; color: var(--brand); margin-left: 6px; }
  .why { margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--line); color: var(--muted); font-size: 12px; }
</style></head><body>
<div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span>待办中心 · 张明远 · 新线索首次联系（4 条）</span></div>

<h1>线索派发卡 · 张明远</h1>
<p class="sub">派发时间 2026-08-09 14:36 · 首次联系时限 2026-08-10 18:00 · 来源：本周视频号内容 C-0806</p>

<div class="card">
  <h3>LEAD-2026-0331 · 汽配结构件 · 江苏苏州<span class="tag">TD-1204</span></h3>
  <div class="kv">
    <span>提交时间</span><span>08-06 21:14</span>
    <span>需求</span><span>注塑模具打样，问最小起订与打样周期</span>
    <span>联系方式</span><span>手机尾号 4021（完整号码在线索详情页，需点开查看）</span>
  </div>
  <p class="why">派给你的原因：汽配结构件是你名下客户最集中的行业，同类需求你有现成报价口径。</p>
</div>

<div class="card">
  <h3>LEAD-2026-0333 · 汽配结构件 · 浙江宁波<span class="tag">TD-1206</span></h3>
  <div class="kv">
    <span>提交时间</span><span>08-07 14:05</span>
    <span>需求</span><span>现有模具改模，问能不能接别家开的模</span>
    <span>联系方式</span><span>手机尾号 2318</span>
  </div>
  <p class="why">派给你的原因：改模是你今年做过 3 次的场景，接别家模具的判断标准你最清楚。</p>
</div>

<div class="card">
  <h3>LEAD-2026-0335 · 家电结构件 · 广东佛山<span class="tag">TD-1208</span></h3>
  <div class="kv">
    <span>提交时间</span><span>08-08 16:20</span>
    <span>需求</span><span>年度供应商入围，问体系认证与产能</span>
    <span>联系方式</span><span>手机尾号 5142</span>
  </div>
  <p class="why">派给你的原因：入围类需求要带体系材料，这套材料上次也是你走的流程。</p>
</div>

<div class="card">
  <h3>LEAD-2026-0336 · 汽配结构件 · 安徽芜湖<span class="tag">TD-1209</span></h3>
  <div class="kv">
    <span>提交时间</span><span>08-09 08:05</span>
    <span>需求</span><span>注塑件报价，已给出图纸编号与年用量 12 万件</span>
    <span>联系方式</span><span>手机尾号 3374</span>
  </div>
  <p class="why">派给你的原因：给了年用量的线索优先级最高，这条今天就值得打。</p>
</div>

<p class="foot">示例内容，线索与联系方式均为虚构。完整联系方式按最小必要原则不在卡片上展示。</p>
</body></html>`;

const REVIEW_SIZE_BYTES = new TextEncoder().encode(REVIEW_HTML).length;
const LEAD_CARD_SIZE_BYTES = new TextEncoder().encode(LEAD_CARD_HTML).length;

/** 面板底稿：内容数据看板 / 线索台账 / 待办中心 / 权限矩阵 / 企业 IM / 操作留痕 */
const PANEL_BASE: SystemPanelSnapshot = {
  title: "企业系统实况",
  live: true,
  activeView: "content",
  foot: "已连接：内容数据看板 · 线索台账 · 待办中心 · 企业 IM（演示）",
  views: [
    {
      key: "content",
      label: "内容数据看板",
      winTitle: "内容数据看板 · 本周发布",
      toolbar: { title: "内容数据看板 · 8-03 ~ 8-09", sub: "尚未读取" },
      widget: {
        kind: "table",
        cols: [
          { key: "item", label: "内容" },
          { key: "ch", label: "平台" },
          { key: "reach", label: "播放/阅读", align: "right" },
          { key: "lead", label: "留资", align: "right" },
        ],
        rows: [],
        empty: { title: "尚未读取内容数据" },
      },
    },
    {
      key: "leads",
      label: "线索台账",
      winTitle: "CRM 线索台账 · 本周留资",
      toolbar: { title: "线索台账 · 本周留资", sub: "尚未读取" },
      widget: { kind: "rows", rows: [], empty: { title: "尚未读取留资明细" } },
    },
    {
      key: "todo",
      label: "待办中心",
      winTitle: "待办中心 · 线索首次联系",
      toolbar: { title: "待办中心", sub: "尚未创建任何待办" },
      widget: { kind: "rows", rows: [], empty: { title: "尚无待办" } },
    },
    {
      key: "rights",
      label: "权限矩阵",
      winTitle: "权限矩阵 · 本人可执行范围",
      toolbar: { title: "权限矩阵 · 由 IT 依岗位表维护", sub: "只读" },
      widget: {
        kind: "table",
        cols: [
          { key: "domain", label: "动作域" },
          { key: "grant", label: "本人授权" },
          { key: "owner", label: "授权来源", align: "right" },
        ],
        rows: [],
        empty: { title: "尚未触达权限判定" },
      },
    },
    {
      key: "im",
      label: "企业 IM",
      winTitle: "企业 IM · 分配通知",
      toolbar: { title: "分配通知", sub: "0 条" },
      widget: { kind: "feed", items: [], empty: { title: "尚未发出任何通知" } },
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

export const contentPerformanceScript: ReplayScript = {
  scenarioId: "catalog-hook-content-performance",
  title: "本周获客内容复盘与加推判断",
  mode: "quick",
  artifacts: {
    [REVIEW_PATH]: REVIEW_HTML,
    [LEAD_CARD_PATH]: LEAD_CARD_HTML,
  },

  steps: [
    {
      caption: "读取本周内容数据",
      blocks: [
        {
          id: "p1-prompt",
          kind: "prompt",
          title: "用户消息",
          defaultOpen: true,
          content: "这周的获客内容数据怎么样？哪条值得加推，你帮我看看。",
        },
        {
          id: "p1-tool",
          kind: "tool_use",
          title: "ContentBoardQuery",
          defaultOpen: true,
          toolName: "ContentBoardQuery",
          toolId: "t-board",
          content: JSON.stringify({ range: "2026-08-03/2026-08-09", channels: ["视频号", "抖音", "公众号"] }),
          executionStatus: "completed",
          durationMs: 920,
          presentation: {
            title: "读取本周三平台内容数据",
            detail: [
              { k: "统计口径", v: "8-03 00:00 ~ 8-09 12:00" },
              { k: "本周内容", v: "12 条 · 视频号 4 · 抖音 5 · 公众号 3" },
              { tree: "├", k: "落地页访问", v: "1,126 次" },
              { tree: "├", k: "留资", v: "9 条" },
              { tree: "└", k: "整体留资率", v: "0.8%（9 / 1,126）" },
            ],
            status: "ok",
            panelBase: PANEL_BASE,
            panel: [
              { op: "focus", view: "content" },
              { op: "toolbar", view: "content", title: "内容数据看板 · 8-03 ~ 8-09", sub: "12 条 · 留资 9" },
              { op: "tableRowInsert", view: "content", row: { id: "ct-0803", cells: { item: "C-0803 20 秒看懂精密结构件", ch: "抖音", reach: "48,600", lead: "0" } } },
              { op: "tableRowInsert", view: "content", row: { id: "ct-0808", cells: { item: "C-0808 模具报价怎么算", ch: "抖音", reach: "22,400", lead: "0" } } },
              { op: "tableRowInsert", view: "content", row: { id: "ct-0806", cells: { item: "C-0806 注塑车间实拍", ch: "视频号", reach: "19,300", lead: "6" } } },
              { op: "tableRowInsert", view: "content", row: { id: "ct-0801", cells: { item: "C-0801 模具试模常踩的 7 个坑", ch: "公众号", reach: "1,240", lead: "1" } } },
              { op: "tableRowInsert", view: "content", row: { id: "ct-rest", cells: { item: "其余 8 条（合计）", ch: "三平台", reach: "31,500", lead: "2" } } },
              { op: "feedAppend", view: "audit", item: { id: "au-1", from: "AI 同事", time: "14:02:11", text: "读取内容数据看板本周 12 条内容与留资明细（只读）" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "1 条" },
            ],
          },
        },
        {
          id: "p1-result",
          kind: "tool_result",
          title: "ContentBoardQuery 结果",
          defaultOpen: false,
          toolName: "ContentBoardQuery",
          toolId: "t-board",
          content: "items=12 channels=3 landing=1126 leads=9",
        },
        {
          id: "p1-text",
          kind: "text",
          title: "业务进展",
          defaultOpen: true,
          content: "本周 12 条内容、1,126 次落地页访问、9 条留资都拿到了。播放量最高的那条不一定是带客户来的那条，我按「留资从哪来」逐条拆一遍再给你结论。",
        },
      ],
    },

    {
      caption: "归因判断：哪条真带来留资",
      blocks: [
        {
          id: "p2-tool",
          kind: "tool_use",
          title: "AttributionCheck",
          defaultOpen: true,
          toolName: "AttributionCheck",
          toolId: "t-attr",
          content: JSON.stringify({ range: "2026-08-03/2026-08-09", by: "content" }),
          executionStatus: "completed",
          durationMs: 1580,
          presentation: {
            title: "按内容逐条归因留资",
            detail: [
              { verdict: "pass", text: "C-0806 注塑车间实拍", note: "留资 6/9 · 留资率 3.1% · 是整体 0.8% 的 3.9 倍" },
              { verdict: "fail", text: "C-0803 20 秒看懂精密结构件", note: "播放 48,600 最高 · 落地页 312 · 留资 0 · 停留中位数 8 秒" },
              { verdict: "warn", text: "C-0808 模具报价怎么算", note: "播放 78% 落在 02:00–04:00 · 落地页点击率 0.18% · 数据存疑" },
              { verdict: "pass", text: "C-0801 与其余 8 条", note: "合计留资 3 条 · 维持现状，不加推也不下架" },
              { insight: "值得加推的只有 C-0806 一条；C-0803 热闹但不获客；C-0808 先排除再判断", label: "结论" },
            ],
            status: "warn",
            panel: [
              { op: "focus", view: "content" },
              { op: "toolbar", view: "content", title: "内容数据看板 · 归因完成", sub: "加推 1 · 不加推 1 · 存疑 1" },
              { op: "tableRowUpdate", view: "content", id: "ct-0806", set: { tone: "pass" } },
              { op: "cellFlag", view: "content", rowId: "ct-0806", colKey: "lead", tone: "pass", flag: "6/9 留资" },
              { op: "tableRowUpdate", view: "content", id: "ct-0803", set: { tone: "deny" } },
              { op: "cellFlag", view: "content", rowId: "ct-0803", colKey: "lead", tone: "deny", flag: "0 留资" },
              { op: "tableRowUpdate", view: "content", id: "ct-0808", set: { tone: "warn" } },
              { op: "cellFlag", view: "content", rowId: "ct-0808", colKey: "reach", tone: "warn", flag: "数据存疑" },
              { op: "feedAppend", view: "audit", item: { id: "au-2", from: "AI 同事", time: "14:03:40", text: "按内容归因本周 9 条留资：C-0806 贡献 6 条；C-0808 标记为数据存疑，不计入本周排名" } },
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
            "本周真正带来客户的是 **C-0806 注塑车间实拍**，理由是三条硬数据：",
            "",
            "1. 9 条留资里它占 6 条，留资率 3.1%，是整体 0.8% 的 3.9 倍；",
            "2. 6 条留资中有 4 条是在视频第 42 秒（车间产能那段镜头）之后两分钟内提交的，说明打动人的是产能画面，不是开头；",
            "3. 来源行业里汽配、家电结构件占 5 条，跟我们主营重合，不是泛人群。",
            "",
            "**C-0803 我建议不要加推**。它播放 48,600 是本周最高，落地页也进了 312 人，但留资 0，停留中位数只有 8 秒、完播率 6%——热闹不获客，加推等于把预算摊到不会下单的人身上。",
            "",
            "还有一条要先说：**C-0808 的数据我不敢用**。22,400 播放里 78% 集中在凌晨 02:00 到 04:00，落地页点击率 0.18%，大概只有该平台同类内容的九分之一。这条本周不进排名，也别拿它做任何结论——我建议你让平台那边核一下流量来源。",
          ].join("\n"),
        },
      ],
    },

    {
      caption: "加推方案与不确定性",
      blocks: [
        {
          id: "p3-tool",
          kind: "tool_use",
          title: "BoostPlan",
          defaultOpen: true,
          toolName: "BoostPlan",
          toolId: "t-plan",
          content: JSON.stringify({ target: "C-0806", budgetPool: 8000 }),
          executionStatus: "completed",
          durationMs: 1340,
          presentation: {
            title: "为 C-0806 推演加推方案",
            detail: [
              { section: "预算分配 · 池子 ¥8,000" },
              { k: "主投", v: "C-0806 原片 ¥5,000 · 定向汽配与家电结构件采购、研发岗" },
              { tree: "├", k: "变体 A", v: "¥1,500 · 换开头 3 秒，改成粒料到成品的对比镜头" },
              { tree: "├", k: "变体 B", v: "¥1,500 · 换标题关键词，「注塑车间」改为「精密结构件 打样」" },
              { tree: "└", k: "止损线", v: "第 3 天留资低于 4 条即停投，剩余预算退回" },
              { no: 1, text: "主投预期 8~15 条留资：按本周 3.1% 外推，再按人群变宽打折" },
              { warn: "两个变体没有历史数据，我给不出预期区间，只能各 ¥1,500 小额试" },
              { warn: "本步未产生任何投放动作与费用，方案停在待审批状态" },
            ],
            status: "waiting",
            panel: [
              { op: "focus", view: "content" },
              { op: "toolbar", view: "content", title: "内容数据看板 · 加推候选", sub: "C-0806 · 变体 2 个（未发布）" },
              { op: "cellFlag", view: "content", rowId: "ct-0806", colKey: "item", tone: "info", flag: "加推候选" },
              { op: "feedAppend", view: "audit", item: { id: "au-3", from: "AI 同事", time: "14:05:02", text: "生成 C-0806 加推方案与两个变体方向，未发起任何投放动作" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "3 条" },
            ],
          },
        },
        {
          id: "p3-text",
          kind: "text",
          title: "业务进展",
          defaultOpen: true,
          content: [
            "方案是这样：¥8,000 的池子里，拿 ¥5,000 加推 C-0806 原片，剩下 ¥3,000 拆成两个变体各 ¥1,500 试水。",
            "",
            "预期我得说清楚**边界**。主投按本周 3.1% 的留资率外推是 12~18 条，但加推的人群比自然流量宽，留资率通常会被稀释，所以我给的是 **8~15 条**这个区间，不是 12~18。这是外推，不是承诺——所以我配了止损线：第 3 天留资低于 4 条就停，剩下的钱退回来。",
            "",
            "两个变体我**给不出预期**，它们没有任何历史数据可参照。别把预算压在变体上，各 ¥1,500 跑三天，用留资数说话再决定谁继续。",
          ].join("\n"),
        },
      ],
    },

    {
      caption: "投流下单被拦截",
      blocks: [
        {
          id: "p4-prompt",
          kind: "prompt",
          title: "用户消息",
          defaultOpen: true,
          content: "行，就按这个来。你直接去下单投流吧，¥5,000 那条今天就投出去。",
        },
        {
          id: "p4-tool",
          kind: "tool_use",
          title: "AdSpend",
          defaultOpen: true,
          toolName: "AdSpend",
          toolId: "t-spend",
          content: JSON.stringify({ target: "C-0806", amount: 5000, action: "purchase" }),
          executionStatus: "completed",
          durationMs: 240,
          presentation: {
            title: "投放下单与支付 · 权限判定",
            detail: [
              { k: "请求动作", v: "付费投放下单 ¥5,000" },
              { k: "本人岗位", v: "市场（内容运营）" },
              { k: "制度阈值", v: "单笔市场费用超 ¥2,000 需总经理审批" },
              { verdict: "fail", text: "越权，按权限矩阵拒绝", note: "未发起任何下单与支付 · 拦截已记账" },
            ],
            status: "blocked",
            panel: [
              { op: "focus", view: "rights" },
              { op: "toolbar", view: "rights", title: "权限矩阵 · 本人可执行范围", sub: "命中 1 条拒绝" },
              { op: "tableRowInsert", view: "rights", row: { id: "r-read", cells: { domain: "内容数据与留资明细", grant: "允许", owner: "岗位表" } } },
              { op: "tableRowInsert", view: "rights", row: { id: "r-lead", cells: { domain: "线索建档与分配", grant: "允许（需确认）", owner: "岗位表" } } },
              { op: "tableRowInsert", view: "rights", row: { id: "r-spend", cells: { domain: "投放下单与支付", grant: "拒绝", owner: "财务与总经理" }, tone: "deny" } },
              { op: "cellFlag", view: "rights", rowId: "r-spend", colKey: "grant", tone: "deny", flag: "无授权" },
              { op: "tableRowInsert", view: "rights", row: { id: "r-export", cells: { domain: "客户联系方式导出", grant: "拒绝", owner: "数据合规" } } },
              { op: "feedAppend", view: "audit", item: {
                id: "au-4",
                from: "AI 同事",
                time: "14:06:18",
                text: "投放下单请求被权限矩阵拦截，未发生任何支付动作",
                card: { title: "花钱动作已拦截", body: "单笔 ¥5,000 超出 ¥2,000 审批阈值；已给出正规申请路径", meta: [{ text: "未花一分钱", tone: "pass" }, { text: "已记账", tone: "info" }] },
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
            "**这条我不能替你下单**。花钱的动作我没有授权，单笔超 ¥2,000 的市场费用要总经理审批——右侧权限矩阵里「投放下单与支付」这一行是明确拒绝的，我没有发起任何下单，也没有碰支付。",
            "",
            "两条路你挑：",
            "",
            "1. 在审批中心发起《市场费用申请》，金额 ¥8,000，把下面这份复盘当附件，沈总批完你自己下单，或者授权后我来执行；",
            "2. 先不花钱验证——C-0806 置顶、加进合集、在几个行业群里分发一轮，三天后看自然留资涨不涨。要是自然量就能起来，这 ¥5,000 可以省。",
            "",
            "我建议先走第 2 条：变体值不值得投，免费流量三天就能给答案。",
          ].join("\n"),
        },
      ],
    },

    {
      caption: "生成本周复盘与加推方案",
      blocks: [
        {
          id: "p5-tool",
          kind: "tool_use",
          title: "ReportBuild",
          defaultOpen: true,
          toolName: "ReportBuild",
          toolId: "t-report",
          content: JSON.stringify({ doc: "本周内容复盘与加推方案", range: "2026-08-03/2026-08-09" }),
          executionStatus: "completed",
          durationMs: 1460,
          presentation: {
            title: "生成本周内容复盘与加推方案",
            detail: [
              { k: "覆盖内容", v: "12 条 · 三平台" },
              { k: "含判定理由", v: "加推 1 · 不加推 1 · 数据存疑 1" },
              { tree: "├", k: "加推方案", v: "预算分配 + 两个变体 + 止损线，标注为待审批" },
              { tree: "└", k: "留资去向", v: "9 条逐条给出建档或不建档的理由" },
            ],
            status: "ok",
            panel: [
              { op: "focus", view: "leads" },
              { op: "toolbar", view: "leads", title: "线索台账 · 本周留资", sub: "9 条 · 可建档 6" },
              { op: "rowsSet", view: "leads", rows: [
                { id: "l-1", text: "汽配结构件 · 江苏苏州", sub: "8-06 21:14 · 注塑模具打样 · 来源 C-0806 · 手机尾号 4021", tone: "pass", badge: { text: "可建档", tone: "pass" } },
                { id: "l-2", text: "家电结构件 · 江苏苏州", sub: "8-07 09:32 · 小批量结构件 · 来源 C-0806 · 手机尾号 7756", tone: "pass", badge: { text: "可建档", tone: "pass" } },
                { id: "l-3", text: "汽配结构件 · 浙江宁波", sub: "8-07 14:05 · 现有模具改模 · 来源 C-0806 · 手机尾号 2318", tone: "pass", badge: { text: "可建档", tone: "pass" } },
                { id: "l-4", text: "医疗器械外壳 · 上海", sub: "8-08 10:47 · 外观件试产 · 来源 C-0806 · 手机尾号 6690", tone: "pass", badge: { text: "可建档", tone: "pass" } },
                { id: "l-5", text: "家电结构件 · 广东佛山", sub: "8-08 16:20 · 年度供应商入围 · 来源 C-0806 · 手机尾号 5142", tone: "pass", badge: { text: "可建档", tone: "pass" } },
                { id: "l-6", text: "汽配结构件 · 安徽芜湖", sub: "8-09 08:05 · 注塑件报价，年用量 12 万件 · 来源 C-0806 · 手机尾号 3374", tone: "pass", badge: { text: "可建档", tone: "pass" } },
                { id: "l-skip", text: "另有 3 条留资不建档", sub: "1 条与台账已有线索同手机号（来源 C-0801） · 1 条只填公司名无联系方式 · 1 条备注为在校学生课题咨询", tone: "info", badge: { text: "不建档", tone: "info" } },
              ] },
              { op: "feedAppend", view: "audit", item: { id: "au-5", from: "AI 同事", time: "14:08:44", text: "生成《本周内容复盘与加推方案》，读取留资明细 9 条并逐条判定建档资格" } },
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
            "复盘做好了，数据、判定理由、加推方案和留资去向都在里面，直接可以当费用申请的附件：",
            "",
            `[FILE]{"filePath":"${REVIEW_PATH}","fileName":"本周内容复盘与加推方案.html","fileSize":${REVIEW_SIZE_BYTES}}[/FILE]`,
            "",
            "顺带把 9 条留资也过了一遍：**6 条可以建档**，都来自 C-0806，联系方式和需求完整。另外 3 条我没放进去，逐条说理由——1 条跟台账里已有线索是同一个手机号，应该挂到原线索下而不是新建；1 条只填了公司名，没有任何联系方式；还有 1 条备注写明是在校学生做课题。这三条你要是不同意我的判断，现在说，我改。",
          ].join("\n"),
        },
      ],
    },

    {
      caption: "线索建档与分配 · 需你确认",
      blocks: [],
      approval: {
        title: "把 6 条留资建档并分配给销售 · 需你确认",
        description: "确认后才会把线索写进台账、创建跟进待办并通知销售。这一步会改变业务系统，我不会自己决定。",
        facts: [
          { label: "待建档线索", value: "6 条 · 全部来自 C-0806" },
          { label: "分配规则", value: "汽配与家电结构件归张明远，其余行业归赵一楠" },
          { label: "默认分配", value: "张明远 5 条 · 赵一楠 1 条" },
          { label: "写入范围", value: "仅线索台账与待办中心，不动客户与商机主数据" },
          { label: "首次联系时限", value: "8-10 18:00 前" },
        ],
        approveLabel: "确认建档并分配",
        rejectLabel: "退回修改",
        approvedBlocks: [
          {
            id: "p6-human",
            kind: "prompt",
            title: "用户消息",
            defaultOpen: true,
            content: "第 2 条那个苏州做家电结构件的改给赵一楠，他周三周四正好跑苏州，能顺路上门。其他 5 条按你分的来。",
          },
          {
            id: "p6-tool",
            kind: "tool_use",
            title: "Approval",
            defaultOpen: true,
            toolName: "Approval",
            toolId: "t-approve",
            content: JSON.stringify({ leads: 6, decision: "approved" }),
            executionStatus: "completed",
            durationMs: 480,
            presentation: {
              title: "建档与分配已确认 · 含人工修改 1 项",
              detail: [
                { k: "审批结果", v: "确认建档" },
                { k: "人工采纳", v: "5 项分配结论" },
                { k: "人工修改", v: "1 项——LEAD-2026-0332 由张明远改为赵一楠" },
                { tree: "├", k: "修改依据", v: "赵一楠本周三、四在苏州，可上门" },
                { tree: "└", k: "记账口径", v: "采纳 5 项 · 修改 1 项 · 自动执行 0 项" },
              ],
              status: "ok",
              receipt: { id: "LEAD-2026-0331~0336", system: "线索台账", readBack: true },
              panel: [
                { op: "focus", view: "leads" },
                { op: "toolbar", view: "leads", title: "线索台账 · 已建档", sub: "6 条 · 张明远 4 · 赵一楠 2" },
                { op: "rowUpdate", view: "leads", id: "l-1", set: { sub: "LEAD-2026-0331 · 负责人 张明远 · 8-10 18:00 前首次联系", badge: { text: "已建档", tone: "pass" }, state: "hit" } },
                { op: "rowUpdate", view: "leads", id: "l-2", set: { sub: "LEAD-2026-0332 · 负责人 赵一楠（苏婷改派） · 8-10 18:00 前首次联系", badge: { text: "已改派", tone: "info" }, state: "hit" } },
                { op: "rowUpdate", view: "leads", id: "l-3", set: { sub: "LEAD-2026-0333 · 负责人 张明远 · 8-10 18:00 前首次联系", badge: { text: "已建档", tone: "pass" } } },
                { op: "rowUpdate", view: "leads", id: "l-4", set: { sub: "LEAD-2026-0334 · 负责人 赵一楠 · 8-10 18:00 前首次联系", badge: { text: "已建档", tone: "pass" } } },
                { op: "rowUpdate", view: "leads", id: "l-5", set: { sub: "LEAD-2026-0335 · 负责人 张明远 · 8-10 18:00 前首次联系", badge: { text: "已建档", tone: "pass" } } },
                { op: "rowUpdate", view: "leads", id: "l-6", set: { sub: "LEAD-2026-0336 · 负责人 张明远 · 8-10 18:00 前首次联系", badge: { text: "已建档", tone: "pass" } } },
                { op: "feedAppend", view: "audit", item: {
                  id: "au-6",
                  from: "市场 苏婷",
                  time: "14:36:02",
                  text: "确认建档 6 条线索：采纳 5 项分配、修改 1 项（LEAD-2026-0332 改派赵一楠）",
                  card: { title: "人审记录", body: "采纳 5 · 修改 1 · 自动执行 0", meta: [{ text: "AI 未自行写入", tone: "pass" }] },
                } },
                { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "6 条" },
              ],
            },
          },
          {
            id: "p6-todo",
            kind: "tool_use",
            title: "TodoDispatch",
            defaultOpen: true,
            toolName: "TodoDispatch",
            toolId: "t-todo",
            content: JSON.stringify({ todos: 6, notify: ["张明远", "赵一楠"] }),
            executionStatus: "completed",
            durationMs: 760,
            presentation: {
              title: "创建跟进待办并通知两位销售",
              detail: [
                { k: "待办", v: "6 条 · TD-1204 ~ TD-1209" },
                { k: "到期时间", v: "8-10 18:00" },
                { tree: "├", k: "张明远", v: "4 条 · TD-1204 / 1206 / 1208 / 1209" },
                { tree: "├", k: "赵一楠", v: "2 条 · TD-1205 / 1207" },
                { tree: "└", k: "通知", v: "2 条已送达，联系方式留在线索详情页，未随通知外发" },
              ],
              status: "ok",
              receipt: { id: "TD-1204~1209", system: "待办中心", readBack: true },
              panel: [
                { op: "focus", view: "todo" },
                { op: "toolbar", view: "todo", title: "待办中心 · 线索首次联系", sub: "6 条 · 8-10 18:00 到期" },
                { op: "rowsSet", view: "todo", rows: [
                  { id: "td-1204", text: "TD-1204 联系 LEAD-2026-0331（汽配 · 苏州）", sub: "张明远 · 8-10 18:00 到期", tone: "pending", badge: { text: "待处理", tone: "info" } },
                  { id: "td-1205", text: "TD-1205 联系 LEAD-2026-0332（家电 · 苏州）", sub: "赵一楠 · 8-10 18:00 到期 · 可顺路上门", tone: "pending", state: "hit", badge: { text: "改派后创建", tone: "info" } },
                  { id: "td-1206", text: "TD-1206 联系 LEAD-2026-0333（汽配 · 宁波）", sub: "张明远 · 8-10 18:00 到期", tone: "pending", badge: { text: "待处理", tone: "info" } },
                  { id: "td-1207", text: "TD-1207 联系 LEAD-2026-0334（医疗器械外壳 · 上海）", sub: "赵一楠 · 8-10 18:00 到期", tone: "pending", badge: { text: "待处理", tone: "info" } },
                  { id: "td-1208", text: "TD-1208 联系 LEAD-2026-0335（家电 · 佛山）", sub: "张明远 · 8-10 18:00 到期", tone: "pending", badge: { text: "待处理", tone: "info" } },
                  { id: "td-1209", text: "TD-1209 联系 LEAD-2026-0336（汽配 · 芜湖 · 年用量 12 万件）", sub: "张明远 · 8-10 18:00 到期 · 优先", tone: "pending", badge: { text: "优先", tone: "warn" } },
                ] },
                { op: "feedAppend", view: "im", item: { id: "im-1", from: "AI 同事", time: "14:36:31", text: "@张明远 本周视频号内容带来的 4 条留资已分到你名下，待办 TD-1204 / 1206 / 1208 / 1209，8-10 18:00 前完成首次联系。" } },
                { op: "feedAppend", view: "im", item: { id: "im-2", from: "AI 同事", time: "14:36:31", text: "@赵一楠 2 条留资已分到你名下，待办 TD-1205 / 1207。其中 LEAD-2026-0332 在苏州，苏婷指名给你，你这周三四在苏州可以顺路上门。" } },
                { op: "toolbar", view: "im", title: "分配通知", sub: "2 条已送达" },
                { op: "feedAppend", view: "audit", item: { id: "au-7", from: "AI 同事", time: "14:36:31", text: "创建待办 TD-1204~1209 并回读校验通过；向张明远、赵一楠各发 1 条分配通知" } },
                { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "7 条" },
              ],
            },
          },
          {
            id: "p6-text",
            kind: "text",
            title: "审批结果",
            defaultOpen: true,
            content: [
              "建好了，你改的那条按新口径执行：LEAD-2026-0332 归赵一楠，最终张明远 4 条、赵一楠 2 条，6 条跟进待办都挂在 8-10 18:00 到期。",
              "",
              "**下面这份就是张明远此刻在待办里点开线索看到的样子**，每条都写了为什么派给他：",
              "",
              `[FILE]{"filePath":"${LEAD_CARD_PATH}","fileName":"线索派发卡-张明远.html","fileSize":${LEAD_CARD_SIZE_BYTES}}[/FILE]`,
              "",
              "完整手机号没有写进卡片和通知里，销售要点进线索详情页才看得到，这样联系方式不会顺着群消息扩散出去。",
            ].join("\n"),
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
            content: JSON.stringify({ leads: 6, decision: "rejected" }),
            executionStatus: "completed",
            durationMs: 260,
            presentation: {
              title: "建档被退回 · 没有写进任何系统",
              detail: [
                { k: "审批结果", v: "退回修改" },
                { k: "线索台账", v: "无写入，6 条留在待分配池" },
                { k: "待办与通知", v: "未创建，两位销售未收到任何消息" },
                { tree: "└", k: "留痕", v: "退回时间、退回人与当时的分配草案已记录" },
              ],
              status: "blocked",
              panel: [
                { op: "focus", view: "leads" },
                { op: "toolbar", view: "leads", title: "线索台账 · 待分配池", sub: "6 条待分配 · 未建档" },
                { op: "rowsUpdate", view: "leads", ids: ["l-1", "l-2", "l-3", "l-4", "l-5", "l-6"], set: { badge: { text: "待分配", tone: "warn" }, tone: "warn" } },
                { op: "feedAppend", view: "audit", item: { id: "au-reject", from: "市场 苏婷", time: "14:36:02", text: "建档被退回：线索台账无写入，未创建待办，未发出任何通知" } },
              ],
            },
          },
          {
            id: "p6-rejected-text",
            kind: "text",
            title: "退回说明",
            defaultOpen: true,
            content: "停住了：6 条线索还在待分配池，台账没有任何写入，两位销售也没收到消息。复盘方案不受影响，仍然可以下载。分配规则你想怎么改，告诉我，我重排一版再提交给你确认。",
          },
        ],
      },
    },

    {
      caption: "跨系统核对终态",
      blocks: [
        {
          id: "p7-tool",
          kind: "tool_use",
          title: "ReadBack",
          defaultOpen: true,
          toolName: "ReadBack",
          toolId: "t-readback",
          content: JSON.stringify({ leads: "LEAD-2026-0331~0336", todos: "TD-1204~1209" }),
          executionStatus: "completed",
          durationMs: 1120,
          presentation: {
            title: "回读四个系统，核对说法是否一致",
            detail: [
              { k: "回读方式", v: "按线索号与待办号逐个反查，不用本次会话的缓存" },
              { verdict: "pass", text: "内容数据看板", note: "12 条已判定 · C-0808 标为数据存疑，不计入本周排名" },
              { verdict: "pass", text: "线索台账", note: "6 条已建档 · 张明远 4 · 赵一楠 2" },
              { verdict: "pass", text: "待办中心", note: "TD-1204~1209 共 6 条 · 均 8-10 18:00 到期" },
              { verdict: "pass", text: "企业 IM", note: "2 条分配通知已送达并已读" },
              { insight: "四方一致；投放预算为零，加推方案停在待审批", label: "结论" },
            ],
            status: "ok",
            panel: [
              { op: "focus", view: "leads" },
              { op: "toolbar", view: "leads", title: "线索台账 · 终态回读", sub: "四方一致" },
              { op: "feedAppend", view: "audit", item: { id: "au-8", from: "AI 同事", time: "14:38:05", text: "回读内容数据看板 / 线索台账 / 待办中心 / 企业 IM，四方状态一致" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "8 条" },
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
            "| 内容数据看板 | 12 条已判定：加推 1 条、不加推 1 条、存疑 1 条 | C-0808 凌晨时段占 78%，本周不排名 |",
            "| 线索台账 | 6 条已建档，张明远 4 条 · 赵一楠 2 条 | LEAD-2026-0331~0336 回读通过 |",
            "| 待办中心 | 6 条首次联系待办，8-10 18:00 到期 | TD-1204~1209 回读通过 |",
            "| 企业 IM | 2 条分配通知已送达并已读 | 张明远 4 条 / 赵一楠 2 条 |",
            "",
            "## 本次会话没有做什么",
            "",
            "- 没有花一分钱：¥8,000 加推方案停在待审批，下单与支付这两个动作我没有授权，也没有发起；",
            "- 没有删改任何内容：C-0803 只是不建议加推、C-0808 只是标注数据存疑，两条内容都还在，原始数据一条没动；",
            "- 没有替你承诺效果：8~15 条留资是外推区间不是承诺，两个变体我明说了给不出区间；",
            "- 没有让联系方式外流：通知和派发卡上只有手机尾号，完整号码留在线索详情页。",
          ].join("\n"),
        },
        {
          id: "p7-tail",
          kind: "text",
          title: "下一步",
          defaultOpen: true,
          content: "以后每周一早上我可以自动跑一遍这个复盘，把值得加推的那条、当周留资和像 C-0808 这样的异常数据一起摆到你桌上，你随时说一声就行。",
        },
      ],
    },
  ],

  // 治理条款：state != exists 的条目就是「演示到真实」的距离
  sources: [
    {
      blockRef: "step1.tool.ContentBoardQuery",
      producer: "租户业务数据连接器",
      state: "missing",
      gap: "没有通用的租户业务数据连接器；内容看板与留资明细今天只能靠人工导表，且导出的表不带按内容编号聚合的口径",
    },
    {
      blockRef: "step2.tool.AttributionCheck",
      producer: "Agent 归因分析（会话内推理）",
      state: "exists",
    },
    {
      blockRef: "step3.tool.BoostPlan",
      producer: "Agent 方案推演（会话内推理）",
      state: "exists",
    },
    {
      blockRef: "step4.tool.AdSpend",
      producer: "付费动作范围门禁",
      state: "needs-change",
      gap: "门禁形态（loop 外独立判定 + 前端预设话术）已验证，但金额阈值与可执行动作清单尚未做成可配置矩阵，现在只能写死在提示词里",
    },
    {
      blockRef: "step5.tool.ReportBuild",
      producer: "Agent 生成 HTML 产物",
      state: "exists",
    },
    {
      blockRef: "step5.artifact.本周内容复盘与加推方案",
      producer: "Agent 生成 HTML 产物",
      state: "exists",
    },
    {
      blockRef: "step6.tool.Approval",
      producer: "租户业务数据连接器（线索建档写入 + 回读）",
      state: "missing",
      gap: "线索写入与写后回读都没有连接器；另外「人改了哪一条分配」目前只能落在自由文本里，没有结构化字段可统计",
    },
    {
      blockRef: "step6.tool.TodoDispatch",
      producer: "钉钉 DWS 连接器",
      state: "needs-change",
      gap: "建待办与发通知的能力已经有了，但要输出这份「6 条待办 + 2 条通知 + 送达回执」的业务摘要，需要改造返回值",
    },
    {
      blockRef: "step6.artifact.线索派发卡",
      producer: "Agent 生成 HTML 产物",
      state: "exists",
    },
    {
      blockRef: "step7.tool.ReadBack",
      producer: "业务终态回读器",
      state: "missing",
      gap: "跨系统回读要先有各系统连接器；在此之前终态核对表只能靠人工逐个系统截图核对",
    },
  ],
};

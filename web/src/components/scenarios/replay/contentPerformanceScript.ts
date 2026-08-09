import type { SystemPanelSnapshot } from "@agent/shared";
import { demoWorldFixture } from "./demoWorldFixture";
import type { ReplayScript } from "./types";

/**
 * 钩子剧本：市场负责人问「这周哪条内容值得加推」。
 *
 * 回放先排除异常流量，再把自然表现拆成观察、假设和证据缺口，最后用
 * 72 小时小流量随机对照实验决定是否值得放量。内容为虚构示例。
 */

const world = demoWorldFixture;
const REVIEW_PATH = `assets/demo/${world.demoDate.compact}-内容加推增量实验方案.html`;

const REVIEW_HTML = `<!doctype html>
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
<div class="bar">内容增长实验 / ${world.demoDate.iso} / 本周 08-03 → ${world.demoDate.short}</div>
<h1>哪条内容值得加推：异常检测与 72 小时增量实验</h1>
<p class="sub">先清洗流量，再用小预算验证增量；本页不承诺线索数量或 ROI</p>

<div class="stats">
  <div class="stat"><b>12 条</b><span>本周内容样本</span></div>
  <div class="stat"><b>31,260</b><span>清洗后有效会话</span></div>
  <div class="stat"><b class="warn">7,488</b><span>凌晨异常会话已剔除</span></div>
  <div class="stat"><b>¥3,000</b><span>实验预算上限</span></div>
</div>

<h2>一、先处理异常，再比较内容</h2>
<table>
<thead><tr><th>内容</th><th>原始观察</th><th>清洗处理</th><th>清洗后观察</th><th>当前结论</th></tr></thead>
<tbody>
<tr><td>C-0808 · 工厂夜景短片</td><td>9,600 次会话；78% 发生在 00:00~04:00</td><td>剔除 7,488 次异常会话：92% 停留不足 2 秒，来源高度集中</td><td>2,112 次有效会话；0 条有效线索</td><td class="bad">不进入候选排名</td></tr>
<tr><td>C-0806 · 小批量结构件报价</td><td>4,280 次自然会话；6 次表单提交</td><td>通过设备、来源与停留质量检查</td><td>4 条有效线索；自然有效线索率 0.093%</td><td class="warn">候选，但未证明付费增量</td></tr>
<tr><td>C-0802 · 常规工艺指南</td><td>3,960 次自然会话；3 次表单提交</td><td>通过质量检查</td><td>2 条有效线索；自然有效线索率 0.051%</td><td>作为同期内容参照</td></tr>
</tbody></table>

<div class="box"><strong>观察</strong>：C-0806 的清洗后自然表现优于本周其他内容。<br><strong>假设</strong>：向相同目标受众增加 C-0806 曝光，可能带来更多有效线索。<br><strong>还缺的证据</strong>：没有历史 paid 基线，也没有随机对照；自然流量中的先后关系不能证明内容造成了留资，更不能据此承诺预算会换来多少线索或 ROI。</div>

<h2>二、72 小时小流量增量实验</h2>
<table>
<thead><tr><th>项目</th><th>约束</th></tr></thead>
<tbody>
<tr><td>周期</td><td>08-10 09:00 至 08-13 09:00，共 72 小时；不足样本时不自动延长</td></tr>
<tr><td>随机分组</td><td>符合目标行业与地域的受众随机 50/50；对照组不展示 C-0806，实验组展示 C-0806；同期统计背景自然线索</td></tr>
<tr><td>预算上限</td><td>总计不超过 ¥3,000，只用于实验组曝光；达到上限自动停</td></tr>
<tr><td>最小分析样本</td><td>每组至少 1,200 次有效落地页会话；未达到只报“证据不足”，不放量</td></tr>
<tr><td>有效线索</td><td>公司、联系方式、项目需求三项完整且同意联系；去重并排除机器人、无效号码、招聘/学生咨询、既有客服请求；销售 24 小时内确认行业与需求匹配</td></tr>
<tr><td>止损线</td><td>累计花费达 ¥900 仍为 0 条有效线索，或异常流量占比超过 20%，或已有至少 3 条有效线索后单条成本高于 ¥600，立即暂停</td></tr>
<tr><td>放量门槛</td><td>完整跑满 72 小时；两组均达到最小样本；实验组至少 8 条有效线索；有效线索率相对对照提升至少 30%；单条有效线索成本不高于 ¥450</td></tr>
</tbody></table>

<p class="note">全部门槛同时满足才提出下一轮预算申请；本实验只回答“是否观察到增量”，不据此承诺收入、回款或 ROI。</p>

<h2>三、审批与终止边界</h2>
<ul>
  <li>人工审批决定是否启动实验，以及预算上限是否为 ¥3,000。</li>
  <li>批准只创建实验、锁定预算上限和自动止损规则，不批量创建或分配 CRM 线索。</li>
  <li>退回后保持 ¥0 花费，可修改周期、样本、预算或门槛后重新提交。</li>
</ul>

<p class="foot">虚构回放产物。统一演示账套日期为 ${world.demoDate.iso}；账套另含 ${world.inTransitOrders.count} 张在途订单（¥${world.inTransitOrders.totalAmountWan} 万）与 ${world.receivables.count} 笔未结应收（¥${world.receivables.totalAmountWan} 万），这些经营事实仅用于统一演示世界，不进入内容效果计算。</p>
</body></html>`;

const REVIEW_SIZE_BYTES = new TextEncoder().encode(REVIEW_HTML).length;

/** 面板底稿：内容看板 / 流量质量 / 实验设计 / 预算台账 / 实验监控 / 操作留痕 */
const PANEL_BASE: SystemPanelSnapshot = {
  title: "企业系统实况",
  live: true,
  activeView: "content",
  foot: "已连接：内容数据看板 · 流量质量分析 · 实验平台 · 预算台账（演示）",
  views: [
    {
      key: "content",
      label: "内容看板",
      winTitle: "内容数据看板 · 本周发布",
      toolbar: { title: "内容数据看板 · 08-03 至 08-09", sub: "尚未读取" },
      widget: {
        kind: "table",
        cols: [
          { key: "item", label: "内容" },
          { key: "sessions", label: "原始会话", align: "right" },
          { key: "forms", label: "表单", align: "right" },
          { key: "state", label: "状态", align: "right" },
        ],
        rows: [],
        empty: { title: "尚未读取内容数据" },
      },
    },
    {
      key: "quality",
      label: "流量质量",
      winTitle: "流量质量 · 异常检测",
      toolbar: { title: "异常检测", sub: "尚未运行" },
      widget: { kind: "rows", rows: [], empty: { title: "尚无检测结果" } },
    },
    {
      key: "experiment",
      label: "实验设计",
      winTitle: "增量实验 · EXP-2026-0809-01",
      toolbar: { title: "实验设计", sub: "尚未创建" },
      widget: { kind: "rows", rows: [], empty: { title: "尚无实验" } },
    },
    {
      key: "budget",
      label: "预算台账",
      winTitle: "市场实验预算台账",
      toolbar: { title: "本次实验预算", sub: "¥0" },
      widget: {
        kind: "stats",
        cols: 3,
        items: [
          { k: "授权上限", v: "¥0" },
          { k: "已花费", v: "¥0" },
          { k: "剩余额度", v: "¥0" },
        ],
      },
    },
    {
      key: "monitor",
      label: "实验监控",
      winTitle: "实验监控 · 样本与止损",
      toolbar: { title: "实验监控", sub: "未启动" },
      widget: { kind: "rows", rows: [], empty: { title: "实验启动后显示" } },
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

export const contentPerformanceScript: ReplayScript = {
  scenarioId: "catalog-hook-content-performance",
  title: "本周获客内容复盘与加推判断",
  mode: "hero",
  artifacts: { [REVIEW_PATH]: REVIEW_HTML },

  steps: [
    {
      caption: "读取本周内容原始样本",
      blocks: [
        {
          id: "p1-tool",
          kind: "tool_use",
          title: "ContentBoardQuery",
          defaultOpen: true,
          toolName: "ContentBoardQuery",
          toolId: "t-content-query",
          content: JSON.stringify({ range: "2026-08-03/2026-08-09", include: ["sessions", "forms", "traffic_quality"] }),
          executionStatus: "completed",
          durationMs: 1160,
          presentation: {
            title: "读取 12 条内容的原始数据",
            detail: [
              { k: "演示日期", v: world.demoDate.iso },
              { k: "内容样本", v: "12 条 · 08-03 至 08-09" },
              { k: "原始会话", v: "38,748 次 · 尚未剔除异常" },
              { insight: "原始播放或会话数暂不排名；先处理流量质量，再比较有效会话与有效线索", label: "口径边界" },
            ],
            status: "ok",
            panelBase: PANEL_BASE,
            panel: [
              { op: "focus", view: "content" },
              { op: "toolbar", view: "content", title: "内容数据看板 · 08-03 至 08-09", sub: "12 条 · 原始口径" },
              { op: "tableRowInsert", view: "content", row: { id: "c-0808", cells: { item: "C-0808 · 工厂夜景短片", sessions: "9,600", forms: "0", state: "待质检" }, tone: "warn" } },
              { op: "tableRowInsert", view: "content", row: { id: "c-0806", cells: { item: "C-0806 · 小批量结构件报价", sessions: "4,280", forms: "6", state: "待质检" }, tone: "warn" } },
              { op: "tableRowInsert", view: "content", row: { id: "c-0802", cells: { item: "C-0802 · 常规工艺指南", sessions: "3,960", forms: "3", state: "待质检" } } },
              { op: "feedAppend", view: "audit", item: { id: "au-p1", from: "AI 同事", time: "14:20:18", text: "读取本周 12 条内容原始数据，尚未进行表现排名" } },
              { op: "toolbar", view: "audit", title: "系统动作", sub: "1 条" },
            ],
          },
        },
        {
          id: "p1-text",
          kind: "text",
          title: "回复",
          defaultOpen: true,
          content: `数据先拉齐了，但我现在不会按播放量选加推。12 条内容的原始会话里有一段明显的凌晨异常，先清洗再比较。演示日期为 ${world.demoDate.iso}；本轮只使用内容、流量和有效线索数据。`,
        },
      ],
    },

    {
      caption: "先剔除凌晨异常流量",
      blocks: [
        {
          id: "p2-tool",
          kind: "tool_use",
          title: "TrafficQualityCheck",
          defaultOpen: true,
          toolName: "TrafficQualityCheck",
          toolId: "t-traffic-quality",
          content: JSON.stringify({ item: "C-0808", rules: ["time_cluster", "dwell_time", "referrer_concentration", "device_duplication"] }),
          executionStatus: "completed",
          durationMs: 860,
          presentation: {
            title: "C-0808 凌晨流量不进入排名",
            detail: [
              { k: "异常时段", v: "00:00~04:00 占 78% · 7,488 次会话" },
              { k: "行为特征", v: "92% 停留不足 2 秒 · 来源高度集中 · 无有效线索" },
              { k: "处理", v: "保留原始数据，分析层剔除 7,488 次会话；不删除内容" },
              { k: "清洗后样本", v: "12 条内容 · 31,260 次有效会话" },
              { insight: "异常检测只说明这批流量不可信，不说明内容本身好或坏", label: "证据边界" },
            ],
            status: "ok",
            panel: [
              { op: "focus", view: "quality" },
              { op: "toolbar", view: "quality", title: "异常检测", sub: "剔除 7,488 次异常会话" },
              { op: "rowsSet", view: "quality", rows: [
                { id: "q-time", text: "凌晨集中", sub: "C-0808 的 78% 会话发生在 00:00~04:00", tone: "deny", badge: { text: "异常", tone: "deny" } },
                { id: "q-dwell", text: "停留异常", sub: "92% 不足 2 秒，且来源高度集中", tone: "deny", badge: { text: "异常", tone: "deny" } },
                { id: "q-action", text: "分析层剔除", sub: "7,488 次会话不进入候选排名；原始数据与内容保留", tone: "pass", badge: { text: "已处理", tone: "pass" } },
              ] },
              { op: "cellFlag", view: "content", rowId: "c-0808", colKey: "state", tone: "deny", flag: "异常流量已剔除" },
              { op: "feedAppend", view: "audit", item: { id: "au-p2", from: "AI 同事", time: "14:21:06", text: "完成流量质量检查，C-0808 的 7,488 次凌晨异常会话不进入排名" } },
              { op: "toolbar", view: "audit", title: "系统动作", sub: "2 条" },
            ],
          },
        },
        {
          id: "p2-text",
          kind: "text",
          title: "异常处理结论",
          defaultOpen: true,
          content: "C-0808 看起来最热闹，但 78% 流量集中在凌晨，且绝大多数停留不足 2 秒。我保留原始记录，只在分析层剔除 7,488 次异常会话；它不进入本周加推候选。",
        },
      ],
    },

    {
      caption: "区分观察、假设与待验证证据",
      blocks: [
        {
          id: "p3-tool",
          kind: "tool_use",
          title: "IncrementalExperimentDesign",
          defaultOpen: true,
          toolName: "IncrementalExperimentDesign",
          toolId: "t-experiment-design",
          content: JSON.stringify({ candidate: "C-0806", design: "randomized_holdout", durationHours: 72, budgetCapCny: 3000 }),
          executionStatus: "completed",
          durationMs: 1120,
          presentation: {
            title: "把“值得试”改写成可证伪实验",
            detail: [
              { k: "观察", v: "C-0806 清洗后 4,280 次自然会话、6 次表单、4 条有效线索；自然有效线索率 0.093%" },
              { k: "假设", v: "向同类目标受众增加 C-0806 曝光，可能带来高于背景自然水平的有效线索" },
              { k: "证据缺口", v: "无历史 paid 基线、无随机对照；自然表现不能外推付费线索量，也不能承诺 ROI" },
              { k: "实验样本", v: "72 小时 · 受众随机 50/50 · 每组至少 1,200 次有效落地页会话" },
              { k: "预算与止损", v: "上限 ¥3,000；花费 ¥900 仍 0 条有效线索等条件触发自动暂停" },
              { k: "放量门槛", v: "跑满周期 + 样本达标 + 实验组≥8 条有效线索 + 相对提升≥30% + 单条成本≤¥450" },
              { insight: "有效线索须信息完整、去重、排除无效意图，并由销售在 24 小时内确认行业与需求匹配", label: "有效线索定义" },
            ],
            status: "ok",
            panel: [
              { op: "focus", view: "experiment" },
              { op: "toolbar", view: "experiment", title: "增量实验草案 · EXP-2026-0809-01", sub: "待审批" },
              { op: "rowsSet", view: "experiment", rows: [
                { id: "exp-window", text: "周期 · 72 小时", sub: "08-10 09:00 → 08-13 09:00 · 不自动延长", tone: "info", badge: { text: "固定周期", tone: "info" } },
                { id: "exp-sample", text: "样本 · 随机 50/50", sub: "对照不展示 C-0806，实验组展示；每组至少 1,200 次有效会话", tone: "info", badge: { text: "有对照", tone: "info" } },
                { id: "exp-stop", text: "止损 · 三条自动规则", sub: "¥900 零有效线索 / 异常占比>20% / 至少 3 条后单条成本>¥600", tone: "warn", badge: { text: "自动暂停", tone: "warn" } },
                { id: "exp-scale", text: "放量 · 五项门槛同时满足", sub: "周期、样本、有效线索数、相对提升、单条成本", tone: "pass", badge: { text: "不达标不放量", tone: "pass" } },
              ] },
              { op: "cellFlag", view: "content", rowId: "c-0806", colKey: "state", tone: "warn", flag: "候选 · 待增量验证" },
              { op: "feedAppend", view: "audit", item: { id: "au-p3", from: "AI 同事", time: "14:22:40", text: "生成 72 小时随机对照实验草案，预算与止损尚未获批" } },
              { op: "toolbar", view: "audit", title: "系统动作", sub: "3 条" },
            ],
          },
        },
        {
          id: "p3-text",
          kind: "text",
          title: "加推判断",
          defaultOpen: true,
          content: [
            "现在最多只能说：C-0806 值得进入小流量实验，不能说它已经被证明值得放量。4 条自然有效线索是观察，不是付费增量证据。",
            "",
            "我没有 paid 基线，所以不外推 ¥3,000 会带来几条线索，也不承诺 ROI。要补的证据，是同一时段、同一受众下的随机对照差异。",
          ].join("\n"),
        },
      ],
    },

    {
      caption: "生成加推增量实验方案",
      blocks: [
        {
          id: "p4-tool",
          kind: "tool_use",
          title: "ReportBuild",
          defaultOpen: true,
          toolName: "ReportBuild",
          toolId: "t-content-report",
          content: JSON.stringify({ doc: "内容加推增量实验方案", candidate: "C-0806", date: world.demoDate.iso }),
          executionStatus: "completed",
          durationMs: 1220,
          presentation: {
            title: "生成内容加推增量实验方案",
            detail: [
              { k: "异常处理", v: "C-0808 凌晨异常会话 7,488 次已从分析口径剔除" },
              { k: "候选内容", v: "C-0806 · 仅标记为待验证假设" },
              { k: "实验周期", v: "72 小时 · 随机 50/50 · 每组至少 1,200 次有效会话" },
              { k: "审批边界", v: "预算上限 ¥3,000 · 启动前需人工确认" },
              { k: "主线范围", v: "只创建实验与监控，不批量分配 CRM 线索" },
            ],
            status: "ok",
            panel: [
              { op: "focus", view: "experiment" },
              { op: "feedAppend", view: "audit", item: { id: "au-p4", from: "AI 同事", time: "14:23:28", text: "生成《内容加推增量实验方案》，当前花费仍为 ¥0" } },
              { op: "toolbar", view: "audit", title: "系统动作", sub: "4 条" },
            ],
          },
        },
        {
          id: "p4-text",
          kind: "text",
          title: "实验材料",
          defaultOpen: true,
          content: [
            "方案把样本口径、有效线索定义、72 小时周期、预算上限、止损线和放量门槛放在一页里，可以直接拿去审批：",
            "",
            `[FILE]{"filePath":"${REVIEW_PATH}","fileName":"内容加推增量实验方案.html","fileSize":${REVIEW_SIZE_BYTES}}[/FILE]`,
            "",
            "批准前不会启动投放，也不会顺带创建或分配 CRM 线索。",
          ].join("\n"),
        },
      ],
    },

    {
      caption: "人工决定是否启动实验与预算",
      blocks: [
        {
          id: "p5-gate",
          kind: "tool_use",
          title: "ExperimentApprovalGate",
          defaultOpen: true,
          toolName: "ExperimentApprovalGate",
          toolId: "t-experiment-gate",
          content: JSON.stringify({ experimentId: "EXP-2026-0809-01", budgetCapCny: 3000 }),
          executionStatus: "completed",
          durationMs: 260,
          presentation: {
            title: "等待人工确认实验与预算上限",
            detail: [
              { k: "实验", v: "EXP-2026-0809-01 · C-0806 随机对照" },
              { k: "周期", v: "72 小时 · 08-10 09:00 开始" },
              { k: "预算上限", v: "¥3,000 · 达上限自动停" },
              { k: "当前花费", v: "¥0" },
              { insight: "批准只启动受控实验；下一轮是否放量仍需重新审批", label: "审批范围" },
            ],
            status: "waiting",
            panel: [
              { op: "focus", view: "budget" },
              { op: "toolbar", view: "budget", title: "本次实验预算", sub: "待审批 · 当前 ¥0" },
              { op: "feedAppend", view: "audit", item: { id: "au-p5", from: "AI 同事", time: "14:24:10", text: "增量实验与 ¥3,000 预算上限进入人工审批，尚未启动或花费" } },
              { op: "toolbar", view: "audit", title: "系统动作", sub: "5 条" },
            ],
          },
        },
      ],
      approval: {
        title: "是否启动 72 小时小流量增量实验",
        description: "批准后创建实验、锁定 ¥3,000 上限并启用自动止损。该审批不承诺线索数量或 ROI，也不包含 CRM 批量分配。",
        facts: [
          { label: "候选内容", value: "C-0806 · 当前只是待验证假设" },
          { label: "实验周期", value: "72 小时 · 08-10 09:00 至 08-13 09:00" },
          { label: "样本", value: "随机 50/50 · 每组至少 1,200 次有效会话" },
          { label: "预算上限", value: "¥3,000 · 达上限自动停" },
          { label: "止损", value: "¥900 零有效线索等三条规则自动暂停" },
          { label: "放量", value: "五项门槛同时满足后另行申请，不自动放量" },
        ],
        approveLabel: "批准实验与预算",
        rejectLabel: "退回调整实验",
        approvedBlocks: [
          {
            id: "p5-approved-tool",
            kind: "tool_use",
            title: "ExperimentLaunch",
            defaultOpen: true,
            toolName: "ExperimentLaunch",
            toolId: "t-experiment-launch",
            content: JSON.stringify({ experimentId: "EXP-2026-0809-01", approvedBudgetCny: 3000, startsAt: "2026-08-10T09:00:00+08:00" }),
            executionStatus: "completed",
            durationMs: 940,
            presentation: {
              title: "实验已创建 · 等待定时启动",
              detail: [
                { verdict: "pass", text: "实验平台", note: "EXP-2026-0809-01 已创建 · 08-10 09:00 启动 · 72 小时" },
                { verdict: "pass", text: "预算台账", note: "授权上限 ¥3,000 · 当前已花费 ¥0" },
                { verdict: "pass", text: "自动止损", note: "3 条规则已启用；命中任一立即暂停" },
                { k: "CRM", v: "0 条线索创建或分配；有效线索只在实验监控中计数" },
                { insight: "放量未授权；实验结束后只有同时满足五项门槛才会生成下一轮申请", label: "执行边界" },
              ],
              status: "ok",
              panel: [
                { op: "focus", view: "monitor" },
                { op: "toolbar", view: "monitor", title: "实验监控 · EXP-2026-0809-01", sub: "已创建 · 08-10 09:00 启动" },
                { op: "rowsSet", view: "monitor", rows: [
                  { id: "m-sample", text: "样本进度", sub: "对照 0 / 1,200 · 实验 0 / 1,200", tone: "info", badge: { text: "未开始", tone: "info" } },
                  { id: "m-spend", text: "预算进度", sub: "¥0 / ¥3,000", tone: "pass", badge: { text: "上限已锁", tone: "pass" } },
                  { id: "m-stop", text: "自动止损", sub: "三条规则已启用", tone: "pass", badge: { text: "已启用", tone: "pass" } },
                  { id: "m-scale", text: "自动放量", sub: "关闭；实验后另行审批", tone: "pass", badge: { text: "未授权", tone: "pass" } },
                ] },
                { op: "statsSet", view: "budget", items: [
                  { k: "授权上限", v: "¥3,000", tone: "info" },
                  { k: "已花费", v: "¥0", tone: "pass" },
                  { k: "剩余额度", v: "¥3,000", tone: "info" },
                ] },
                { op: "toolbar", view: "budget", title: "本次实验预算", sub: "上限已锁 · 尚未花费" },
                { op: "feedAppend", view: "audit", item: { id: "au-p5a", from: "市场 苏婷", time: "14:24:42", text: "批准 EXP-2026-0809-01 与 ¥3,000 上限；实验已创建，实际花费 ¥0" } },
                { op: "toolbar", view: "audit", title: "系统动作", sub: "6 条" },
              ],
            },
          },
          {
            id: "p5-approved-text",
            kind: "text",
            title: "审批结果",
            defaultOpen: true,
            content: "实验已创建，08-10 09:00 按 50/50 随机分组启动，预算硬上限 ¥3,000、三条止损规则都已落入监控。当前实际花费还是 ¥0，CRM 也没有新增或分配任何线索。",
          },
        ],
        rejectedBlocks: [
          {
            id: "p5-rejected-tool",
            kind: "tool_use",
            title: "Approval",
            defaultOpen: true,
            toolName: "Approval",
            toolId: "t-experiment-reject",
            content: JSON.stringify({ experimentId: "EXP-2026-0809-01", decision: "rejected" }),
            executionStatus: "completed",
            durationMs: 240,
            presentation: {
              title: "实验已退回 · ¥0 花费",
              detail: [
                { k: "实验平台", v: "未创建实验" },
                { k: "预算台账", v: "未锁定额度 · 已花费 ¥0" },
                { k: "内容与 CRM", v: "无写入、无分配" },
                { insight: "方案文件仍可下载；可修改预算、周期、样本或门槛后重新提交", label: "后续" },
              ],
              status: "blocked",
              panel: [
                { op: "focus", view: "budget" },
                { op: "toolbar", view: "budget", title: "本次实验预算", sub: "已退回 · ¥0" },
                { op: "feedAppend", view: "audit", item: { id: "au-p5r", from: "市场 苏婷", time: "14:24:42", text: "实验方案退回调整；未创建实验、未锁预算、实际花费 ¥0" } },
                { op: "toolbar", view: "audit", title: "系统动作", sub: "6 条" },
              ],
            },
          },
          {
            id: "p5-rejected-text",
            kind: "text",
            title: "退回说明",
            defaultOpen: true,
            content: "已经停住：实验没创建，预算没锁定，也没有任何花费。方案文件仍在；可以只调整 ¥3,000 上限、72 小时周期、最小样本或止损门槛，再重新提交确认。",
          },
        ],
      },
    },

    {
      caption: "回读实验、预算与监控终态",
      blocks: [
        {
          id: "p6-tool",
          kind: "tool_use",
          title: "ReadBack",
          defaultOpen: true,
          toolName: "ReadBack",
          toolId: "t-content-readback",
          content: JSON.stringify({ experimentId: "EXP-2026-0809-01", budgetLedger: true, monitorRules: true }),
          executionStatus: "completed",
          durationMs: 920,
          presentation: {
            title: "按实验编号回读终态",
            detail: [
              { verdict: "pass", text: "内容看板", note: "C-0808 异常会话保留原始记录但不进入排名；C-0806 标为待增量验证" },
              { verdict: "pass", text: "实验平台", note: "EXP-2026-0809-01 · 72 小时 · 随机 50/50 · 尚未开始" },
              { verdict: "pass", text: "预算台账", note: "上限 ¥3,000 · 已花费 ¥0 · 余额 ¥3,000" },
              { verdict: "pass", text: "监控规则", note: "最小样本、有效线索定义、3 条止损与 5 项放量门槛均一致" },
              { insight: "没有 paid 结果前不评价增量或 ROI；放量仍需下一次人工审批", label: "结论" },
            ],
            status: "ok",
            panel: [
              { op: "focus", view: "monitor" },
              { op: "toolbar", view: "monitor", title: "实验监控 · 终态回读", sub: "规则一致 · 待启动" },
              { op: "feedAppend", view: "audit", item: { id: "au-p6", from: "AI 同事", time: "14:25:20", text: "回读内容口径、实验、预算与监控规则，终态一致" } },
              { op: "toolbar", view: "audit", title: "系统动作", sub: "7 条" },
            ],
          },
        },
        {
          id: "p6-text",
          kind: "text",
          title: "本次会话终态",
          defaultOpen: true,
          content: [
            "## 跨系统核对",
            "",
            "| 系统 | 终态 | 核对依据 |",
            "| --- | --- | --- |",
            "| 内容数据看板 | C-0808 异常流量不排名；C-0806 为待验证候选 | 原始数据保留，分析口径剔除 7,488 次异常会话 |",
            "| 实验平台 | EXP-2026-0809-01 已创建，08-10 09:00 启动 | 72 小时、随机 50/50、每组至少 1,200 次有效会话 |",
            "| 预算台账 | 上限 ¥3,000，实际花费 ¥0 | 达上限自动停止 |",
            "| 实验监控 | 3 条止损与 5 项放量门槛已启用 | 有效线索定义与方案一致 |",
            "| CRM | 0 条新增、0 条分配 | 不属于本次实验主线 |",
            "",
            "## 本次会话没有做什么",
            "",
            "- 没有把自然流量中的先后关系当成内容带来留资的因果证据；",
            "- 没有把自然有效线索率外推成预算可购买的线索数量，也没有承诺 ROI；",
            "- 没有让凌晨异常流量进入候选排名，也没有删除原始内容或原始数据；",
            "- 没有批量创建、分配 CRM 线索，也没有授权实验结束后自动放量。",
          ].join("\n"),
        },
      ],
    },
  ],

  sources: [
    {
      blockRef: "step1.tool.ContentBoardQuery",
      producer: "租户业务数据连接器",
      state: "missing",
      gap: "缺少统一读取多平台内容会话、表单与流量质量字段的连接器；当前需人工导表并统一内容编号",
    },
    {
      blockRef: "step2.tool.TrafficQualityCheck",
      producer: "流量质量检测器",
      state: "missing",
      gap: "尚无跨平台统一的时段集中、停留、来源与设备重复检测器，异常规则目前只能在导出数据上离线执行",
    },
    {
      blockRef: "step3.tool.IncrementalExperimentDesign",
      producer: "Agent 实验方案设计（会话内分析）",
      state: "exists",
    },
    {
      blockRef: "step4.tool.ReportBuild",
      producer: "Agent 生成 HTML 产物",
      state: "exists",
    },
    {
      blockRef: "step4.artifact.内容加推增量实验方案",
      producer: "Agent 生成 HTML 产物",
      state: "exists",
    },
    {
      blockRef: "step5.tool.ExperimentApprovalGate",
      producer: "付费实验审批门禁",
      state: "needs-change",
      gap: "审批可阻断花费，但预算硬上限、自动止损与禁止自动放量还没有统一的结构化策略模型",
    },
    {
      blockRef: "step5.tool.ExperimentLaunch",
      producer: "投放实验平台与预算台账连接器",
      state: "missing",
      gap: "尚无连接器能创建随机留出实验、锁定预算上限、同步止损规则并按实验编号回读；真实环境仍需人工配置",
    },
    {
      blockRef: "step5.tool.Approval",
      producer: "审批中心",
      state: "needs-change",
      gap: "退回留痕可以记录，但预算、周期、样本与门槛的结构化修改和重提仍需人工整理",
    },
    {
      blockRef: "step6.tool.ReadBack",
      producer: "业务终态回读器",
      state: "missing",
      gap: "缺少跨内容看板、实验平台、预算台账与监控规则的统一回读器，当前无法自动证明执行配置与批准方案一致",
    },
  ],
};

import type { SystemPanelSnapshot } from "@agent/shared";
import type { ReplayScript } from "./types";

/**
 * 钩子剧本：总经理问「这个月经营上最该担心的三件事是什么」。
 *
 * 骨架照 complianceGateScript 抄，四要素齐：
 *   ① 主动拒绝——第 4 步要调员工私聊被拦截，给合规替代路径；
 *   ② 视角切换——第 5 步产物就是总经理手上那张风险一页纸；
 *   ③ 跨系统核对——终态用一张表把四个系统的说法摆在一起；
 *   ④ 可下载产物——《8 月经营风险一页纸》HTML，右侧预览 + 本地下载。
 * 外加两条：人可以改掉 AI 的措辞并被记账（第 6 步），退回不是死路（rejectedBlocks）。
 *
 * 内容为虚构示例，不对应任何真实企业、订单或人员。
 */

const RISK_BRIEF_PATH = "assets/demo/8月经营风险一页纸.html";

const RISK_BRIEF_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<style>
  :root { --brand: #2E56E1; --ink: #0f172a; --muted: #64748b; --line: #e2e8f0; --ok: #15803d; --warn: #b45309; --deny: #b91c1c; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 20px; font: 14px/1.7 "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; color: var(--ink); background: #fff; }
  .bar { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border: 1px solid var(--line); border-radius: 6px; background: #f8fafc; color: var(--muted); font-size: 12px; margin-bottom: 16px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #cbd5e1; }
  h1 { margin: 0 0 4px; font-size: 17px; }
  .sub { margin: 0 0 16px; color: var(--muted); font-size: 12px; }
  .rank { border: 1px solid var(--line); border-left: 3px solid var(--deny); border-radius: 8px; padding: 12px 14px; margin-bottom: 12px; }
  .rank.mid { border-left-color: var(--warn); }
  .rank h2 { margin: 0 0 6px; font-size: 14px; }
  .tag { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 11px; margin-left: 6px; vertical-align: 1px; }
  .tag.high { background: #fee2e2; color: var(--deny); }
  .tag.mid { background: #fef3c7; color: var(--warn); }
  .kv { display: grid; grid-template-columns: 84px 1fr; gap: 4px 12px; font-size: 13px; }
  .kv span:nth-child(odd) { color: var(--muted); }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 14px; }
  th, td { border: 1px solid var(--line); padding: 7px 10px; text-align: left; vertical-align: top; }
  th { background: #f8fafc; color: var(--muted); font-weight: 500; }
  .box { border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; margin-bottom: 12px; background: #f8fafc; }
  .box h2 { margin: 0 0 8px; font-size: 13px; }
  .box ul { margin: 0; padding-left: 18px; }
  .ok { color: var(--ok); font-weight: 600; }
  .foot { margin-top: 14px; color: var(--muted); font-size: 12px; }
</style></head><body>
<div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span>内部文件 · 澜达精密制造有限公司 · 总经理阅</span></div>

<h1>8 月经营风险一页纸</h1>
<p class="sub">统计口径 2026-08-01 至 08-09 · 数据来自订单中心 / 应收台账 / 客诉工单 / 考勤系统 · 生成时间 08-09 09:26</p>

<div class="rank">
  <h2>第一件 · 恒岳重工 SO-2026-1027 交付风险<span class="tag high">高</span></h2>
  <div class="kv">
    <span>金额</span><span>¥86.4 万 · 精密结构件</span>
    <span>合同交期</span><span>2026-08-15（距今 6 天）</span>
    <span>越线在哪</span><span>精密轴承 6204-RS 需 400 件，现库 0；补料单 PO-2026-0886 只有口头承诺 8-12 到货，系统里查不到发货单号</span>
    <span>连带影响</span><span>注塑二组 8-13 至 8-14 两班装配已排定，缺料一天，交期顺延一天</span>
    <span>建议</span><span>8-11 17:00 前拿到补料与排产两套方案，由跟单周晓芸主责</span>
  </div>
</div>

<div class="rank">
  <h2>第二件 · 蓝谷自动化 AR-2026-0058 逾期<span class="tag high">高</span></h2>
  <div class="kv">
    <span>金额</span><span>¥23.6 万 · 到期日 2026-07-22</span>
    <span>逾期</span><span>18 天，公司账期红线为 15 天</span>
    <span>越线在哪</span><span>逾期期间对方又下新单 SO-2026-1033，敞口从 ¥23.6 万扩大到在谈的 ¥41.2 万</span>
    <span>连带影响</span><span>新单排产会占用 8 月下旬产能，而旧账未清</span>
    <span>建议</span><span>8-12 前出回款方案，财务陈静主责，口径先与销售张明远对齐再对外</span>
  </div>
</div>

<div class="rank mid">
  <h2>第三件 · 启润电子 NC-2026-0092 客诉挂起<span class="tag mid">中</span></h2>
  <div class="kv">
    <span>状态</span><span>2026-08-03 受理，挂起 6 天，卡在质检复判 3 天</span>
    <span>越线在哪</span><span>客诉挂起超过 5 天的公司上限；同批次 B20260722 另有 300 件已在恒岳重工仓库</span>
    <span>连带影响</span><span>一旦复判判定为批次问题，第一件事的客户会同时收到质量问题</span>
    <span>建议</span><span>周五前给出处理方案，客户负责人张明远主责</span>
  </div>
</div>

<table>
  <tr><th>域</th><th>当月数</th><th>是否需要总经理介入</th></tr>
  <tr><td>交付</td><td>在途订单 17 单 · ¥1,842 万</td><td>1 单需要（SO-2026-1027）</td></tr>
  <tr><td>回款</td><td>未结应收 12 笔 · ¥168.4 万</td><td>1 笔需要（AR-2026-0058）</td></tr>
  <tr><td>质量</td><td>未闭环客诉 8 件</td><td>1 件需要（NC-2026-0092）</td></tr>
  <tr><td>人员</td><td>当月考勤异常 3 例 · 在岗 318 人</td><td class="ok">不需要，主管层已处理</td></tr>
</table>

<div class="box">
  <h2>本月不建议你分心的两件事</h2>
  <ul>
    <li>销售线索量：8 月至今新增 14 条，上月同期 17 条；近 6 个月月均 15.8 条、区间 13~19 条，本月仍在波动内。</li>
    <li>海川机械客诉 NC-2026-0095（包装破损）：损失金额 ¥1,800，跟单已回复并补发，无扩散面。</li>
  </ul>
</div>

<div class="box">
  <h2>这份材料的边界</h2>
  <ul>
    <li>三条判定全部基于业务单据字段（交期、账期、挂起天数、批次流向），不含任何人的私人会话内容。</li>
    <li>建议只到「谁在什么时间前给出方案」为止，具体处置由责任人决定。</li>
  </ul>
</div>

<p class="foot">示例内容，不对应任何真实企业、订单或人员。</p>
</body></html>`;

const RISK_BRIEF_SIZE_BYTES = new TextEncoder().encode(RISK_BRIEF_HTML).length;

/** 面板底稿：经营快照 / 订单中心 / 应收台账 / 客诉工单 / 权限矩阵 / 操作留痕 */
const PANEL_BASE: SystemPanelSnapshot = {
  title: "企业系统实况",
  live: true,
  activeView: "overview",
  foot: "已连接：订单中心 · 应收台账 · 客诉工单 · 待办中心（演示）",
  views: [
    {
      key: "overview",
      label: "经营快照",
      winTitle: "经营快照 · 2026 年 8 月",
      toolbar: { title: "经营快照 · 08-01 至 08-09", sub: "尚未取数" },
      widget: { kind: "stats", cols: 4, items: [] },
    },
    {
      key: "orders",
      label: "订单中心",
      winTitle: "订单中心 · 在途订单",
      toolbar: { title: "订单中心 · 在途订单", sub: "尚未读取" },
      widget: {
        kind: "table",
        cols: [
          { key: "no", label: "订单" },
          { key: "cust", label: "客户" },
          { key: "due", label: "交期" },
          { key: "state", label: "状态", align: "right" },
        ],
        rows: [],
        empty: { title: "尚未读取订单中心" },
      },
    },
    {
      key: "ar",
      label: "应收台账",
      winTitle: "应收台账 · 未结应收",
      toolbar: { title: "应收台账 · 未结应收", sub: "尚未读取" },
      widget: {
        kind: "table",
        cols: [
          { key: "no", label: "单号" },
          { key: "cust", label: "客户" },
          { key: "amount", label: "金额" },
          { key: "state", label: "账期", align: "right" },
        ],
        rows: [],
        empty: { title: "尚未读取应收台账" },
      },
    },
    {
      key: "nc",
      label: "客诉工单",
      winTitle: "客诉工单 · 未闭环",
      toolbar: { title: "客诉工单 · 未闭环", sub: "尚未读取" },
      widget: {
        kind: "table",
        cols: [
          { key: "no", label: "工单" },
          { key: "cust", label: "客户" },
          { key: "days", label: "挂起" },
          { key: "state", label: "风险", align: "right" },
        ],
        rows: [],
        empty: { title: "尚未读取客诉工单" },
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
      key: "audit",
      label: "操作留痕",
      winTitle: "操作留痕 · 本次会话",
      toolbar: { title: "本次会话的系统动作", sub: "0 条" },
      widget: { kind: "feed", items: [], empty: { title: "尚无系统动作" } },
    },
  ],
};

export const bossTopRisksScript: ReplayScript = {
  scenarioId: "catalog-hook-boss-top-risks",
  title: "这个月经营上最该担心的三件事",
  mode: "quick",
  artifacts: { [RISK_BRIEF_PATH]: RISK_BRIEF_HTML },

  steps: [
    {
      caption: "跨域读取当月经营快照",
      blocks: [
        {
          id: "b1-prompt",
          kind: "prompt",
          title: "用户消息",
          defaultOpen: true,
          content: "这个月经营上最该担心的三件事是什么？我时间不多，别给我铺报表，直接说该我管哪几件。",
        },
        {
          id: "b1-tool",
          kind: "tool_use",
          title: "OpsSnapshot",
          defaultOpen: true,
          toolName: "OpsSnapshot",
          toolId: "t-snapshot",
          content: JSON.stringify({ period: "2026-08", domains: ["delivery", "receivable", "quality", "people"] }),
          executionStatus: "completed",
          durationMs: 1420,
          presentation: {
            title: "读取交付 / 回款 / 质量 / 人员四个域的当月数",
            detail: [
              "只读取业务单据，不改动任何单据",
              { k: "统计口径", v: "2026-08-01 至 08-09 · 全公司" },
              { tree: "├", k: "交付", v: "在途订单 17 单 · ¥1,842 万" },
              { tree: "├", k: "回款", v: "未结应收 12 笔 · ¥168.4 万" },
              { tree: "├", k: "质量", v: "未闭环客诉 8 件" },
              { tree: "└", k: "人员", v: "当月考勤异常 3 例 · 在岗 318 人" },
            ],
            status: "ok",
            panelBase: PANEL_BASE,
            panel: [
              { op: "focus", view: "overview" },
              { op: "toolbar", view: "overview", title: "经营快照 · 08-01 至 08-09", sub: "四域已取数" },
              { op: "statsSet", view: "overview", items: [
                { k: "在途订单", v: "17 单 · ¥1,842 万" },
                { k: "未结应收", v: "12 笔 · ¥168.4 万" },
                { k: "未闭环客诉", v: "8 件" },
                { k: "考勤异常", v: "3 例 / 318 人" },
              ] },
              { op: "toolbar", view: "orders", title: "订单中心 · 在途订单", sub: "17 单" },
              { op: "tableRowInsert", view: "orders", row: { id: "o-1027", cells: { no: "SO-2026-1027", cust: "恒岳重工", due: "08-15", state: "在产" } } },
              { op: "tableRowInsert", view: "orders", row: { id: "o-1033", cells: { no: "SO-2026-1033", cust: "蓝谷自动化", due: "08-28", state: "待确认图纸" } } },
              { op: "tableRowInsert", view: "orders", row: { id: "o-1041", cells: { no: "SO-2026-1041", cust: "海川机械", due: "09-05", state: "在产" } } },
              { op: "tableRowInsert", view: "orders", row: { id: "o-rest", cells: { no: "其余 14 单", cust: "—", due: "09-02 起", state: "按计划" } } },
              { op: "toolbar", view: "ar", title: "应收台账 · 未结应收", sub: "12 笔 · ¥168.4 万" },
              { op: "tableRowInsert", view: "ar", row: { id: "ar-58", cells: { no: "AR-2026-0058", cust: "蓝谷自动化", amount: "¥23.6 万", state: "逾期 18 天" } } },
              { op: "tableRowInsert", view: "ar", row: { id: "ar-44", cells: { no: "AR-2026-0044", cust: "恒岳重工", amount: "¥12.0 万", state: "临期 3 天" } } },
              { op: "tableRowInsert", view: "ar", row: { id: "ar-rest", cells: { no: "其余 10 笔", cust: "—", amount: "¥132.8 万", state: "账期内" } } },
              { op: "toolbar", view: "nc", title: "客诉工单 · 未闭环", sub: "8 件" },
              { op: "tableRowInsert", view: "nc", row: { id: "nc-92", cells: { no: "NC-2026-0092", cust: "启润电子", days: "6 天", state: "待复判" } } },
              { op: "tableRowInsert", view: "nc", row: { id: "nc-95", cells: { no: "NC-2026-0095", cust: "海川机械", days: "2 天", state: "已回复" } } },
              { op: "tableRowInsert", view: "nc", row: { id: "nc-rest", cells: { no: "其余 6 件", cust: "—", days: "≤ 3 天", state: "处理中" } } },
              { op: "feedAppend", view: "audit", item: { id: "au-1", from: "AI 同事", time: "09:21:08", text: "读取订单中心 / 应收台账 / 客诉工单 / 考勤系统当月数据（只读）" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "1 条" },
            ],
          },
        },
        {
          id: "b1-result",
          kind: "tool_result",
          title: "OpsSnapshot 结果",
          defaultOpen: false,
          toolName: "OpsSnapshot",
          toolId: "t-snapshot",
          content: "orders=17 receivables=12 complaints=8 attendance_exceptions=3 period=2026-08-01..2026-08-09",
        },
        {
          id: "b1-text",
          kind: "text",
          title: "业务进展",
          defaultOpen: true,
          content: "四个域的数都拿到了。我不会把 17 单、12 笔、8 件全铺给你——先按「越过了哪条线」筛一遍，只把该你管的挑出来，剩下的我会说清为什么不用你管。",
        },
      ],
    },

    {
      caption: "筛出三件真正越线的事",
      blocks: [
        {
          id: "b2-tool",
          kind: "tool_use",
          title: "RiskRank",
          defaultOpen: true,
          toolName: "RiskRank",
          toolId: "t-rank",
          content: JSON.stringify({ period: "2026-08", pick: 3 }),
          executionStatus: "completed",
          durationMs: 1860,
          presentation: {
            title: "按「越线 + 有责任人 + 不介入会恶化」三条同时命中筛选",
            detail: [
              { risk: "high", text: "SO-2026-1027 恒岳重工 ¥86.4 万 · 合同交期 08-15", action: "轴承 6204-RS 缺 400 件，补料承诺查不到发货单号，只剩 6 天" },
              { risk: "high", text: "AR-2026-0058 蓝谷自动化 ¥23.6 万 · 逾期 18 天", action: "超账期红线 15 天，且逾期期间又下新单，敞口在扩大" },
              { risk: "medium", text: "NC-2026-0092 启润电子外观不良 · 挂起 6 天", action: "超挂起上限 5 天，同批次另有 300 件在恒岳仓库" },
              { warn: "考勤那 3 例已由主管层处理完，不进这张表" },
              { insight: "线索量下滑我看到了，本月不用你管：8 月至今新增 14 条，上月同期 17 条，近 6 个月月均 15.8 条、区间 13~19 条，仍在正常波动内", label: "取舍" },
            ],
            status: "warn",
            panel: [
              { op: "focus", view: "overview" },
              { op: "toolbar", view: "overview", title: "经营快照 · 08-01 至 08-09", sub: "越线 3 件" },
              { op: "statsSet", view: "overview", items: [
                { k: "在途订单", v: "17 单 · 越线 1", tone: "warn" },
                { k: "未结应收", v: "12 笔 · 越线 1", tone: "warn" },
                { k: "未闭环客诉", v: "8 件 · 越线 1", tone: "warn" },
                { k: "考勤异常", v: "3 例 · 已对平", tone: "pass" },
              ] },
              { op: "tableRowUpdate", view: "orders", id: "o-1027", set: { cells: { state: "交付高危" }, tone: "warn" } },
              { op: "cellFlag", view: "orders", rowId: "o-1027", colKey: "state", tone: "deny", flag: "越线" },
              { op: "tableRowUpdate", view: "ar", id: "ar-58", set: { cells: { state: "逾期 18 天 · 超红线" }, tone: "warn" } },
              { op: "cellFlag", view: "ar", rowId: "ar-58", colKey: "state", tone: "deny", flag: "越线" },
              { op: "cellFlag", view: "ar", rowId: "ar-44", colKey: "state", tone: "info", flag: "提醒级" },
              { op: "tableRowUpdate", view: "nc", id: "nc-92", set: { cells: { state: "批次扩散面" }, tone: "warn" } },
              { op: "cellFlag", view: "nc", rowId: "nc-92", colKey: "state", tone: "warn", flag: "越线" },
              { op: "cellFlag", view: "nc", rowId: "nc-95", colKey: "state", tone: "pass", flag: "已闭环回复" },
              { op: "feedAppend", view: "audit", item: { id: "au-2", from: "AI 同事", time: "09:22:47", text: "对 37 条在途业务对象做阈值判定，命中越线 3 件" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "2 条" },
            ],
          },
        },
        {
          id: "b2-text",
          kind: "text",
          title: "业务进展",
          defaultOpen: true,
          content: [
            "三件，按该你管的顺序排：",
            "",
            "1. **恒岳重工 SO-2026-1027，¥86.4 万，8-15 交付**。它排第一不是因为金额最大，是因为只剩 6 天而缺口还没堵上：精密轴承 6204-RS 要 400 件，现库 0，补料单 PO-2026-0886 只有口头承诺 8-12 到货，系统里没有发货单号。",
            "2. **蓝谷自动化 AR-2026-0058，¥23.6 万，逾期 18 天**。公司账期红线是 15 天，已经过线 3 天；更要紧的是逾期期间对方又下了新单 SO-2026-1033，敞口从 ¥23.6 万往在谈的 ¥41.2 万走。",
            "3. **启润电子 NC-2026-0092，挂起 6 天**。挂起上限是 5 天，卡在质检复判已经 3 天；同批次 B20260722 还有 300 件在恒岳仓库——万一复判判成批次问题，第一件事的那个客户会同时收到质量问题。",
            "",
            "**销售线索量下滑我看到了，但这个月不用你管**：8 月至今 14 条、上月同期 17 条，近 6 个月月均 15.8 条、区间 13~19 条，还在波动内。考勤那 3 例主管层已经处理完了，我也没往上放。",
          ].join("\n"),
        },
      ],
    },

    {
      caption: "深挖第一件的因果链",
      blocks: [
        {
          id: "b3-tool",
          kind: "tool_use",
          title: "DeliveryTrace",
          defaultOpen: true,
          toolName: "DeliveryTrace",
          toolId: "t-trace",
          content: JSON.stringify({ order: "SO-2026-1027" }),
          executionStatus: "completed",
          durationMs: 1240,
          presentation: {
            title: "沿「缺料 → 排产 → 交期」倒推 SO-2026-1027",
            detail: [
              { no: 1, text: "缺料：精密轴承 6204-RS 需 400 件，现库 0，安全库存击穿日 08-12" },
              { no: 2, text: "在途：补料单 PO-2026-0886 供应商口头承诺 08-12 到货，系统内无发货单号" },
              { no: 3, text: "排产：注塑二组 08-13 至 08-14 两班装配已排定，缺料一天则顺延一天" },
              { no: 4, text: "交期：08-15 是合同承诺日，顺延即违约，对方对接人是采购部郑海峰" },
              { verdict: "fail", text: "最脆弱的一环是 PO-2026-0886", note: "没有发货单号 = 承诺不可核实，整条链条都压在这一环上" },
              { insight: "今早 08:00 的交付风险巡检已经把这一单标成高危，两次判定指向同一处缺口", label: "对照" },
            ],
            status: "warn",
            panel: [
              { op: "focus", view: "orders" },
              { op: "toolbar", view: "orders", title: "订单中心 · SO-2026-1027 因果链", sub: "缺口锁定在补料环节" },
              { op: "tableRowUpdate", view: "orders", id: "o-1027", set: { cells: { due: "08-15 · 剩 6 天", state: "缺料 400 件" }, tone: "warn" } },
              { op: "cellFlag", view: "orders", rowId: "o-1027", colKey: "due", tone: "deny", flag: "6 天" },
              { op: "cellFlag", view: "orders", rowId: "o-1027", colKey: "state", tone: "deny", flag: "补料无单号" },
              { op: "tableRowUpdate", view: "orders", id: "o-1033", set: { cells: { state: "待确认图纸" }, tone: "info" } },
              { op: "feedAppend", view: "audit", item: { id: "au-3", from: "AI 同事", time: "09:23:35", text: "回溯 SO-2026-1027 的物料、排产与交期链路，定位缺口在 PO-2026-0886" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "3 条" },
            ],
          },
        },
        {
          id: "b3-text",
          kind: "text",
          title: "业务进展",
          defaultOpen: true,
          content: [
            "这一单的问题不在生产，在补料那一环。装配班次已经排好了，8-13、8-14 两班，只等 400 件轴承；轴承在 PO-2026-0886 上，供应商说 8-12 到，但系统里没有发货单号——也就是说这个「到货日」目前只是一句话，谁都核不了。",
            "",
            "所以顺序是：先把 8-12 这个承诺坐实（要发货单号），坐实不了就得当天启动第二套排产。**这两条路怎么选我不替你拍**——换替代型号要客户书面认可，这属于对外承诺，得你和销售一起定。",
          ].join("\n"),
        },
      ],
    },

    {
      caption: "调阅员工私聊被拦截",
      blocks: [
        {
          id: "b4-prompt",
          kind: "prompt",
          title: "用户消息",
          defaultOpen: true,
          content: "把这几个负责人最近的聊天记录调出来给我看看，我倒要看看是不是消极怠工。",
        },
        {
          id: "b4-tool",
          kind: "tool_use",
          title: "IMArchiveQuery",
          defaultOpen: true,
          toolName: "IMArchiveQuery",
          toolId: "t-im",
          content: JSON.stringify({ scope: "private_conversations", members: ["周晓芸", "陈静", "张明远"] }),
          executionStatus: "completed",
          durationMs: 240,
          presentation: {
            title: "员工个人会话记录 · 权限判定",
            detail: [
              { k: "请求数据域", v: "员工个人会话记录" },
              { k: "涉及人员", v: "周晓芸 · 陈静 · 张明远" },
              { verdict: "fail", text: "不在授权范围，按权限矩阵拒绝", note: "未读取任何会话内容 · 拦截已记账" },
              { warn: "个人会话即便由管理员身份发起也不放行，这条规则对所有岗位一致" },
            ],
            status: "blocked",
            panel: [
              { op: "focus", view: "rights" },
              { op: "toolbar", view: "rights", title: "权限矩阵 · 本人可访问范围", sub: "命中 1 条拒绝" },
              { op: "tableRowInsert", view: "rights", row: { id: "r-order", cells: { domain: "订单与交付进度", grant: "允许", owner: "岗位表" } } },
              { op: "tableRowInsert", view: "rights", row: { id: "r-ar", cells: { domain: "应收与账期", grant: "允许", owner: "岗位表" } } },
              { op: "tableRowInsert", view: "rights", row: { id: "r-trace", cells: { domain: "业务留痕与待办完成率", grant: "允许", owner: "岗位表" } } },
              { op: "tableRowInsert", view: "rights", row: { id: "r-im", cells: { domain: "员工个人会话", grant: "拒绝", owner: "公司制度 · 不可授权" }, tone: "deny" } },
              { op: "cellFlag", view: "rights", rowId: "r-im", colKey: "grant", tone: "deny", flag: "不可授权" },
              { op: "tableRowInsert", view: "rights", row: { id: "r-health", cells: { domain: "病假与医疗信息", grant: "拒绝", owner: "公司制度 · 不可授权" } } },
              { op: "feedAppend", view: "audit", item: {
                id: "au-4",
                from: "AI 同事",
                time: "09:24:12",
                text: "调阅员工个人会话的请求被权限矩阵拦截，未发生任何内容读取",
                card: { title: "越权请求已拦截", body: "数据域「员工个人会话」对任何岗位都不开放；已给出可用的替代口径", meta: [{ text: "未读取内容", tone: "pass" }, { text: "已记账", tone: "info" }] },
              } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "4 条" },
            ],
          },
        },
        {
          id: "b4-text",
          kind: "text",
          title: "回复",
          defaultOpen: true,
          content: [
            "**这个我不能查，也不会绕**。员工个人会话在权限矩阵里是对所有岗位关闭的，不是你级别不够——是这条数据域不开放授权，我一个字都没读。",
            "",
            "但你想知道的那件事，用业务留痕能答，而且更准：",
            "",
            "1. 近 30 天待办按时完成率：周晓芸 92%（26/28）、陈静 88%（22/25）、张明远 79%（19/24）；",
            "2. 三件事各自的停滞点都在单据上——NC-2026-0092 卡在质检复判 3 天，不在跟单手里；AR-2026-0058 的催收动作 7-28 之后没有新留痕，这条确实是空档。",
            "",
            "要不要我把「催收动作空档 12 天」也写进这次的督办里？",
          ].join("\n"),
        },
      ],
    },

    {
      caption: "生成经营风险一页纸",
      blocks: [
        {
          id: "b5-tool",
          kind: "tool_use",
          title: "ReportBuild",
          defaultOpen: true,
          toolName: "ReportBuild",
          toolId: "t-report",
          content: JSON.stringify({ template: "monthly-risk-onepager", period: "2026-08" }),
          executionStatus: "completed",
          durationMs: 2180,
          presentation: {
            title: "生成《8 月经营风险一页纸》",
            detail: [
              { k: "篇幅", v: "一页 · 三件事各一块" },
              { tree: "├", k: "每块内容", v: "金额 / 越线在哪 / 连带影响 / 建议由谁在何时前给方案" },
              { tree: "├", k: "附带", v: "四域全量数与「不建议你分心的两件事」" },
              { tree: "└", k: "边界声明", v: "判定只用业务单据字段，不含任何私人会话内容" },
              { insight: "这份材料只到「谁在什么时间前给方案」为止，具体怎么处置留给责任人", label: "口径" },
            ],
            status: "ok",
            panel: [
              { op: "focus", view: "overview" },
              { op: "toolbar", view: "overview", title: "经营快照 · 08-01 至 08-09", sub: "一页纸已生成 · 尚未下发" },
              { op: "feedAppend", view: "audit", item: { id: "au-5", from: "AI 同事", time: "09:26:04", text: "生成《8 月经营风险一页纸》，仅本地产物，未向任何人发送" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "5 条" },
            ],
          },
        },
        {
          id: "b5-text",
          kind: "text",
          title: "回复",
          defaultOpen: true,
          content: [
            "一页纸做好了，你在会上直接投出来就行：",
            "",
            `[FILE]{"filePath":"${RISK_BRIEF_PATH}","fileName":"8月经营风险一页纸.html","fileSize":${RISK_BRIEF_SIZE_BYTES}}[/FILE]`,
            "",
            "它现在只是一份文件，还没发给任何人。要不要我按这三件事各下一条督办给责任人，抄送你？督办会写进待办中心，属于会改系统的动作，得你点头。",
          ].join("\n"),
        },
      ],
    },

    {
      caption: "下发三条督办需你确认",
      blocks: [],
      approval: {
        title: "向三位责任人下发督办 · 需你确认",
        description: "确认后才会在待办中心创建督办并通知到本人。这一步会写入业务系统，必须由你明确确认。",
        facts: [
          { label: "督办一 · 周晓芸", value: "SO-2026-1027 恒岳交付风险：8-11 17:00 前给出补料坐实与备用排产两套方案" },
          { label: "督办二 · 陈静", value: "AR-2026-0058 蓝谷逾期 18 天：8-12 前出回款方案，对外口径先与张明远对齐" },
          { label: "督办三 · 张明远", value: "NC-2026-0092 启润客诉挂起 6 天：限期整改，说明批次扩散面处置" },
          { label: "抄送", value: "沈建国（本人）· 三条均不改动原始单据" },
        ],
        approveLabel: "确认下发",
        rejectLabel: "退回修改",
        approvedBlocks: [
          {
            id: "b6-human",
            kind: "prompt",
            title: "用户消息",
            defaultOpen: true,
            content: "前两条照发。第三条把「限期整改」改掉——张明远又不是犯了错，写成「周五前给我处理方案」就行，我不想一上来就压人。",
          },
          {
            id: "b6-tool",
            kind: "tool_use",
            title: "Approval",
            defaultOpen: true,
            toolName: "Approval",
            toolId: "t-approve",
            content: JSON.stringify({ decision: "approved", todos: 3, modified: 1 }),
            executionStatus: "completed",
            durationMs: 980,
            presentation: {
              title: "督办已下发 · 含人工修改 1 项",
              detail: [
                { k: "人审记账", v: "采纳 2 项 · 修改 1 项 · 自动执行 0 项" },
                { k: "修改点", v: "督办三措辞「限期整改」→「周五前给我处理方案」，期限落为 08-14 18:00" },
                { tree: "├", k: "TD-1201", v: "周晓芸 · SO-2026-1027 · 截止 08-11 17:00" },
                { tree: "├", k: "TD-1202", v: "陈静 · AR-2026-0058 · 截止 08-12 18:00" },
                { tree: "└", k: "TD-1203", v: "张明远 · NC-2026-0092 · 截止 08-14 18:00" },
                { insight: "原始单据一律未改：交期、账期、客诉定级都是原值，只加了跟踪标记", label: "边界" },
              ],
              status: "ok",
              receipt: { id: "TD-1201/1202/1203", system: "待办中心", readBack: true },
              panel: [
                { op: "focus", view: "audit" },
                { op: "feedAppend", view: "audit", item: {
                  id: "au-6a",
                  from: "沈建国",
                  time: "09:28:31",
                  text: "确认下发：采纳 2 条原文，修改 1 条措辞后下发",
                  card: { title: "人审记录", body: "采纳 2 · 修改 1 · 自动执行 0", meta: [{ text: "AI 未自行下发", tone: "pass" }, { text: "措辞由人改定", tone: "info" }] },
                } },
                { op: "feedAppend", view: "audit", item: {
                  id: "au-6b",
                  from: "待办中心",
                  time: "09:28:33",
                  text: "TD-1201 已送达周晓芸，TD-1202 已送达陈静，TD-1203 已送达张明远，均抄送沈建国",
                  card: { title: "3 条督办回执", body: "回读校验通过 · 原始业务单据无写入", meta: [{ text: "TD-1201", tone: "pass" }, { text: "TD-1202", tone: "pass" }, { text: "TD-1203", tone: "pass" }] },
                } },
                { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "7 条" },
                { op: "cellFlag", view: "orders", rowId: "o-1027", colKey: "state", tone: "warn", flag: "已督办" },
                { op: "cellFlag", view: "ar", rowId: "ar-58", colKey: "state", tone: "warn", flag: "已督办" },
                { op: "cellFlag", view: "nc", rowId: "nc-92", colKey: "state", tone: "warn", flag: "已督办" },
              ],
            },
          },
          {
            id: "b6-text",
            kind: "text",
            title: "审批结果",
            defaultOpen: true,
            content: "三条都到人了，第三条按你的话改了：措辞换成「周五前给我处理方案」，期限落成 8-14 18:00。原文和你改的地方都在留痕里，谁改的、改成什么，回头都查得到。",
          },
        ],
        rejectedBlocks: [
          {
            id: "b6-rejected-tool",
            kind: "tool_use",
            title: "Approval",
            defaultOpen: true,
            toolName: "Approval",
            toolId: "t-reject",
            content: JSON.stringify({ decision: "rejected" }),
            executionStatus: "completed",
            durationMs: 260,
            presentation: {
              title: "督办被退回 · 没有通知任何人",
              detail: [
                { k: "审批结果", v: "退回修改" },
                { k: "待办中心", v: "0 条创建" },
                { k: "业务单据", v: "订单 / 应收 / 客诉均无写入" },
                { tree: "└", k: "留痕", v: "退回时间、退回人与当时的督办文案版本已记录" },
                { insight: "一页纸仍然可下载，你也可以自己在会上说，不一定要走系统", label: "退路" },
              ],
              status: "blocked",
              panel: [
                { op: "focus", view: "audit" },
                { op: "feedAppend", view: "audit", item: {
                  id: "au-6r",
                  from: "沈建国",
                  time: "09:28:31",
                  text: "督办下发被退回：待办中心 0 条创建，三个业务系统均无写入",
                  card: { title: "退回已记账", body: "等待文案修改后重新提交，仍需再次确认", meta: [{ text: "未通知任何人", tone: "pass" }] },
                } },
                { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "6 条" },
              ],
            },
          },
          {
            id: "b6-rejected-text",
            kind: "text",
            title: "退回说明",
            defaultOpen: true,
            content: "停住了：三条督办一条都没建，周晓芸、陈静、张明远谁也没收到消息，业务单据也没动。风险一页纸还在，你随时可以下载。改完文案跟我说一声，我重新提交，还是要你再点一次头。",
          },
        ],
      },
    },

    {
      caption: "跨系统核对终态",
      blocks: [
        {
          id: "b7-tool",
          kind: "tool_use",
          title: "ReadBack",
          defaultOpen: true,
          toolName: "ReadBack",
          toolId: "t-readback",
          content: JSON.stringify({ objects: ["SO-2026-1027", "AR-2026-0058", "NC-2026-0092", "TD-1201", "TD-1202", "TD-1203"] }),
          executionStatus: "completed",
          durationMs: 1320,
          presentation: {
            title: "回读四个系统，核对说法是否对得上",
            detail: [
              { k: "回读方式", v: "按对象编号逐个反查，不用本次会话的缓存" },
              { verdict: "pass", text: "订单中心", note: "SO-2026-1027 交期仍为 08-15，新增高风险跟踪标记" },
              { verdict: "pass", text: "应收台账", note: "AR-2026-0058 账期未改，新增专项跟进标记" },
              { verdict: "pass", text: "客诉工单", note: "NC-2026-0092 定级未改，新增总经理关注标记" },
              { verdict: "pass", text: "待办中心", note: "TD-1201 / 1202 / 1203 三条在册，责任人与截止时间与审批一致" },
              { insight: "四方一致，无未决动作；本次会话对原始业务单据零写入", label: "结论" },
            ],
            status: "ok",
            panel: [
              { op: "focus", view: "overview" },
              { op: "toolbar", view: "overview", title: "经营快照 · 终态回读", sub: "四方一致" },
              { op: "statsSet", view: "overview", items: [
                { k: "越线事项", v: "3 件 · 全部有人有期限", tone: "pass" },
                { k: "已发督办", v: "3 条 · 抄送你", tone: "pass" },
                { k: "单据改动", v: "0 处", tone: "pass" },
                { k: "越权拦截", v: "1 次 · 已记账", tone: "info" },
              ] },
              { op: "feedAppend", view: "audit", item: { id: "au-7", from: "AI 同事", time: "09:29:10", text: "回读订单中心 / 应收台账 / 客诉工单 / 待办中心，四方状态一致" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "8 条" },
            ],
          },
        },
        {
          id: "b7-text",
          kind: "text",
          title: "本次会话改变了什么",
          defaultOpen: true,
          content: [
            "## 本次会话改变了什么",
            "",
            "| 系统 | 终态 | 依据 |",
            "| --- | --- | --- |",
            "| 订单中心 | SO-2026-1027 加高风险跟踪标记，交期仍为 08-15 | 督办 TD-1201 · 责任人周晓芸 |",
            "| 应收台账 | AR-2026-0058 加专项跟进标记，账期未变 | 督办 TD-1202 · 责任人陈静 |",
            "| 客诉工单 | NC-2026-0092 加总经理关注标记，定级未变 | 督办 TD-1203 · 责任人张明远 |",
            "| 待办中心 | 新增 3 条督办，均抄送你，回读校验通过 | 人审记账：采纳 2 · 修改 1 · 自动执行 0 |",
            "| 操作留痕 | 8 条动作在册，含 1 次越权拦截 | 本次会话全部动作可回溯 |",
            "",
            "## 本次会话没有做什么",
            "",
            "- 没有绕过责任人直接指挥一线：三条督办都发给责任人本人并抄送你，没有跳级派活，也没有替谁承诺完成时间；",
            "- 没有看任何人的私聊：调阅个人会话的请求在权限矩阵处被拦下，零内容读取，替代口径用的是待办完成率与业务留痕；",
            "- 没有改任何业务单据：恒岳的交期、蓝谷的账期、启润客诉的定级都保持原值，我只加了跟踪标记；",
            "- 没有替你做取舍之外的判断：补料还是换替代型号、蓝谷新单接不接，这两件我只摆了代价，没有替你选。",
          ].join("\n"),
        },
        {
          id: "b7-upgrade",
          kind: "text",
          title: "回复",
          defaultOpen: true,
          content: "以后可以让我每天早上 7:30 先把这三件事的进展跑一遍，全部按计划推进就不打扰你，越线了才叫你——随时说一声就行。",
        },
      ],
    },
  ],

  // 治理条款：state != exists 的条目就是「演示到真实」的距离
  sources: [
    {
      blockRef: "step1.tool.OpsSnapshot",
      producer: "租户业务数据连接器",
      state: "missing",
      gap: "跨订单 / 应收 / 客诉 / 考勤四个域的统一取数连接器不存在；今天要么逐个系统导出，要么走只读账号自己拼，且都不产出业务语义摘要",
    },
    {
      blockRef: "step2.tool.RiskRank",
      producer: "Agent 阈值判定（会话内分析）",
      state: "exists",
    },
    {
      blockRef: "step3.tool.DeliveryTrace",
      producer: "租户业务数据连接器",
      state: "missing",
      gap: "物料、采购在途与排产班次分属三张台账，缺少按订单串起来的关联取数；因果链现在只能靠人拼",
    },
    {
      blockRef: "step4.tool.IMArchiveQuery",
      producer: "独立范围门禁（数据域权限矩阵）",
      state: "needs-change",
      gap: "门禁判定形态已验证，但「哪些数据域对任何岗位都不可授权」还没做成可配置的矩阵，目前靠提示词约束，不可审计",
    },
    {
      blockRef: "step5.tool.ReportBuild",
      producer: "Agent 生成 HTML 产物",
      state: "exists",
    },
    {
      blockRef: "step5.artifact.8月经营风险一页纸",
      producer: "Agent 生成 HTML 产物",
      state: "exists",
    },
    {
      blockRef: "step6.tool.Approval",
      producer: "钉钉 DWS 连接器（待办批量创建与抄送）",
      state: "needs-change",
      gap: "批量建待办与抄送能力存在，但「人改了哪一条、原文是什么」没有结构化字段，回执也不带回读校验，现在只能落在自由文本里",
    },
    {
      blockRef: "step7.tool.ReadBack",
      producer: "业务终态回读器",
      state: "missing",
      gap: "跨系统回读要先有各系统连接器；在此之前终态核对表只能人工整理，也就无法证明「说的和系统里的一致」",
    },
  ],
};

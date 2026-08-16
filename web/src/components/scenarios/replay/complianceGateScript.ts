import type { SystemPanelSnapshot } from "@agent/shared";
import type { ReplayScript } from "./types";

/**
 * 剧本二：合规证据核齐并由有权人放行。
 *
 * 这一份是「四要素模板」的参照实现，后续场景照这个骨架写：
 *   ① 主动拒绝——第 3 步越权追问被拦截，给替代路径，而不是假装查不到；
 *   ② 视角切换——第 6 步产物就是报关行/客户此刻打开的那个页面；
 *   ③ 跨系统核对——终态用一张表把四个系统的说法摆在一起；
 *   ④ 可下载产物——证据包清单 HTML，右侧预览 + 本地下载。
 * 外加两条从客户演示稿里学来的：人可以改掉 AI 的结论并被记账（第 5 步），
 * 退回不是死路（rejectedBlocks）。
 *
 * 内容为示例数据，不对应任何真实企业、订单或证书。
 */

const EVIDENCE_PACK_PATH = "assets/demo/出口合规证据包.html";

const EVIDENCE_PACK_HTML = `<!doctype html>
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
  .ok { color: var(--ok); font-weight: 600; }
  .warn { color: var(--warn); font-weight: 600; }
  .box { border: 1px solid var(--line); border-radius: 8px; padding: 12px; margin-bottom: 12px; }
  .box h2 { margin: 0 0 8px; font-size: 13px; }
  .kv { display: grid; grid-template-columns: 96px 1fr; gap: 4px 12px; font-size: 13px; }
  .kv span:nth-child(odd) { color: var(--muted); }
  .foot { margin-top: 14px; color: var(--muted); font-size: 12px; }
</style></head><body>
<div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span>evidence.example-partner.com / pack / SO-2026-0731</span></div>

<h1>Export Compliance Evidence Pack · 出口合规证据包</h1>
<p class="sub">Order SO-2026-0731 · Destination: Germany (EU) · Released 2026-07-26</p>

<div class="box">
  <h2>Shipment · 货物信息</h2>
  <div class="kv">
    <span>Order</span><span>SO-2026-0731</span>
    <span>Product</span><span>X7 Industrial Controller ×120</span>
    <span>Consignee</span><span>Nordlicht Automation GmbH</span>
    <span>Incoterms</span><span>FOB Xiamen</span>
  </div>
</div>

<table>
  <tr><th>Document</th><th>No.</th><th>Valid until</th><th>Status</th></tr>
  <tr><td>CE Declaration of Conformity</td><td>CE-X7-2026-014</td><td>2027-05-30</td><td class="ok">Valid</td></tr>
  <tr><td>EMC Test Report</td><td>EMC-2026-0512</td><td>2028-05-12</td><td class="ok">Valid</td></tr>
  <tr><td>Certificate of Origin</td><td>CO-2026-1188</td><td>2026-10-31</td><td class="ok">Valid（renewed 07-26）</td></tr>
  <tr><td>RoHS Statement</td><td>ROHS-X7-2026</td><td>2027-01-15</td><td class="ok">Valid</td></tr>
</table>

<div class="box">
  <h2>Release · 放行记录</h2>
  <div class="kv">
    <span>Released by</span><span>Compliance Manager（有权人）</span>
    <span>Basis</span><span>Export Compliance Policy §4.2</span>
    <span>Note</span><span>Certificate of Origin renewed before release; previous version superseded.</span>
  </div>
</div>

<p class="foot">Demo content. Fictional order, certificates and parties. 示例内容，不对应任何真实订单或证书。</p>
</body></html>`;

const EVIDENCE_PACK_SIZE_BYTES = new TextEncoder().encode(EVIDENCE_PACK_HTML).length;

/** 面板底稿：证据台账 / 权限矩阵 / 分发与回执 / 操作留痕 */
const PANEL_BASE: SystemPanelSnapshot = {
  title: "企业系统实况",
  live: true,
  activeView: "evidence",
  foot: "已连接：ERP · 合规证据台账 · 权限矩阵 · 分发链路（演示）",
  views: [
    {
      key: "evidence",
      label: "证据台账",
      winTitle: "合规证据台账 · 出口订单",
      toolbar: { title: "合规证据台账 · SO-2026-0731", sub: "尚未核对" },
      widget: {
        kind: "table",
        cols: [
          { key: "doc", label: "证据" },
          { key: "no", label: "编号" },
          { key: "state", label: "核验", align: "right" },
        ],
        rows: [],
        empty: { title: "尚未读取证据台账" },
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
      label: "分发与回执",
      winTitle: "受控分发链路 · 对外交付",
      toolbar: { title: "受控分发链路", sub: "尚未放行" },
      widget: { kind: "rows", rows: [], empty: { title: "尚未生成任何对外链接" } },
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

export const complianceGateScript: ReplayScript = {
  scenarioId: "catalog-compliance-evidence-gate-loop",
  title: "合规证据核齐并由有权人放行",
  mode: "hero",
  artifacts: { [EVIDENCE_PACK_PATH]: EVIDENCE_PACK_HTML },

  steps: [
    {
      caption: "读取订单与证据台账",
      blocks: [
        {
          id: "c1-prompt",
          kind: "prompt",
          title: "用户消息",
          defaultOpen: true,
          content: "这批 X7 发德国，合规材料齐了吗？",
        },
        {
          id: "c1-tool",
          kind: "tool_use",
          title: "ERPQuery",
          defaultOpen: true,
          toolName: "ERPQuery",
          toolId: "t-order",
          content: JSON.stringify({ order: "SO-2026-0731" }),
          executionStatus: "completed",
          durationMs: 860,
          presentation: {
            title: "读取出口订单与证据台账",
            detail: [
              { k: "订单", v: "SO-2026-0731 · X7 控制器 ×120" },
              { k: "目的地", v: "德国（欧盟）" },
              { tree: "├", k: "收货方", v: "Nordlicht Automation GmbH" },
              { tree: "└", k: "台账证据", v: "4 项，待逐项核验" },
            ],
            status: "ok",
            panelBase: PANEL_BASE,
            panel: [
              { op: "focus", view: "evidence" },
              { op: "toolbar", view: "evidence", title: "合规证据台账 · SO-2026-0731", sub: "4 项待核验" },
              { op: "tableRowInsert", view: "evidence", row: { id: "ev-ce", cells: { doc: "CE 符合性声明", no: "CE-X7-2026-014", state: "待核验" } } },
              { op: "tableRowInsert", view: "evidence", row: { id: "ev-emc", cells: { doc: "EMC 检测报告", no: "EMC-2026-0512", state: "待核验" } } },
              { op: "tableRowInsert", view: "evidence", row: { id: "ev-co", cells: { doc: "原产地证", no: "CO-2025-0904", state: "待核验" } } },
              { op: "tableRowInsert", view: "evidence", row: { id: "ev-rohs", cells: { doc: "RoHS 声明", no: "ROHS-X7-2026", state: "待核验" } } },
              { op: "feedAppend", view: "audit", item: { id: "au-1", from: "AI 同事", time: "09:12:04", text: "读取 ERP 订单 SO-2026-0731 与合规证据台账（只读）" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "1 条" },
            ],
          },
        },
        {
          id: "c1-result",
          kind: "tool_result",
          title: "ERPQuery 结果",
          defaultOpen: false,
          toolName: "ERPQuery",
          toolId: "t-order",
          content: "order=SO-2026-0731 items=120 destination=DE evidence=4",
        },
        {
          id: "c1-text",
          kind: "text",
          title: "业务进展",
          defaultOpen: true,
          content: "订单和台账都拿到了：4 项证据在册。我按目的地（欧盟）和产品类别逐项核验有效期与主体，再告诉你能不能放行。",
        },
      ],
    },

    {
      caption: "逐项核验，暴露两个缺口",
      blocks: [
        {
          id: "c2-tool",
          kind: "tool_use",
          title: "EvidenceCheck",
          defaultOpen: true,
          toolName: "EvidenceCheck",
          toolId: "t-check",
          content: JSON.stringify({ order: "SO-2026-0731", rules: "EU-2026" }),
          executionStatus: "completed",
          durationMs: 1740,
          presentation: {
            title: "按欧盟准入规则逐项核验",
            detail: [
              { verdict: "pass", text: "CE 符合性声明", note: "有效期至 2027-05-30 · 主体与出口商一致" },
              { verdict: "pass", text: "EMC 检测报告", note: "型号与本批次一致" },
              { verdict: "fail", text: "原产地证 CO-2025-0904", note: "2026-06-30 已过期 · 硬条件，必须换新证" },
              { verdict: "warn", text: "RoHS 声明", note: "签署主体是母公司，与出口商不一致 → 需人工判断" },
              { insight: "现在不能放行：1 项硬缺口 + 1 项待人判", label: "结论" },
            ],
            status: "warn",
            panel: [
              { op: "focus", view: "evidence" },
              { op: "toolbar", view: "evidence", title: "合规证据台账 · SO-2026-0731", sub: "通过 2 · 不通过 1 · 待人判 1" },
              { op: "tableRowUpdate", view: "evidence", id: "ev-ce", set: { cells: { state: "通过" } } },
              { op: "cellFlag", view: "evidence", rowId: "ev-ce", colKey: "state", tone: "pass", flag: "通过" },
              { op: "tableRowUpdate", view: "evidence", id: "ev-emc", set: { cells: { state: "通过" } } },
              { op: "cellFlag", view: "evidence", rowId: "ev-emc", colKey: "state", tone: "pass", flag: "通过" },
              { op: "tableRowUpdate", view: "evidence", id: "ev-co", set: { cells: { state: "已过期" }, tone: "warn" } },
              { op: "cellFlag", view: "evidence", rowId: "ev-co", colKey: "state", tone: "deny", flag: "已过期" },
              { op: "tableRowUpdate", view: "evidence", id: "ev-rohs", set: { cells: { state: "主体不符" } } },
              { op: "cellFlag", view: "evidence", rowId: "ev-rohs", colKey: "state", tone: "warn", flag: "待人判" },
              { op: "feedAppend", view: "audit", item: { id: "au-2", from: "AI 同事", time: "09:12:21", text: "按 EU-2026 规则核验 4 项证据：通过 2 · 不通过 1 · 待人工判断 1" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "2 条" },
            ],
          },
        },
        {
          id: "c2-text",
          kind: "text",
          title: "业务进展",
          defaultOpen: true,
          content: [
            "现在**不能放行**，卡在两处：",
            "",
            "1. **原产地证已过期**（CO-2025-0904，2026-06-30 到期）。这项是硬条件，必须换新证。",
            "2. **RoHS 声明的签署主体是母公司**，与本次出口商主体不一致。这一条我不替你判断——集团授权关系不在我能读到的资料里，需要合规负责人确认。",
            "",
            "其余两项（CE、EMC）核验通过，有效期和型号都对得上。",
          ].join("\n"),
        },
      ],
    },

    {
      caption: "越权追问被拦截",
      blocks: [
        {
          id: "c3-prompt",
          kind: "prompt",
          title: "用户消息",
          defaultOpen: true,
          content: "顺便把这批货的成本和毛利拉给我，我看看还能不能压价。",
        },
        {
          id: "c3-tool",
          kind: "tool_use",
          title: "FinanceQuery",
          defaultOpen: true,
          toolName: "FinanceQuery",
          toolId: "t-finance",
          content: JSON.stringify({ order: "SO-2026-0731", fields: ["cost", "margin"] }),
          executionStatus: "completed",
          durationMs: 210,
          presentation: {
            title: "成本与毛利数据 · 权限判定",
            detail: [
              { k: "请求数据域", v: "订单成本与毛利" },
              { k: "本人岗位", v: "外贸业务（出口合规）" },
              { verdict: "fail", text: "越权，按权限矩阵拒绝", note: "未读取任何数据 · 拦截已记账" },
            ],
            status: "blocked",
            panel: [
              { op: "focus", view: "rights" },
              { op: "toolbar", view: "rights", title: "权限矩阵 · 本人可访问范围", sub: "命中 1 条拒绝" },
              { op: "tableRowInsert", view: "rights", row: { id: "r-order", cells: { domain: "订单与货物信息", grant: "允许", owner: "岗位表" } } },
              { op: "tableRowInsert", view: "rights", row: { id: "r-evidence", cells: { domain: "合规证据与证书", grant: "允许", owner: "岗位表" } } },
              { op: "tableRowInsert", view: "rights", row: { id: "r-cost", cells: { domain: "成本与毛利", grant: "拒绝", owner: "财务部" }, tone: "deny" } },
              { op: "cellFlag", view: "rights", rowId: "r-cost", colKey: "grant", tone: "deny", flag: "无授权" },
              { op: "tableRowInsert", view: "rights", row: { id: "r-hr", cells: { domain: "薪酬与人事", grant: "拒绝", owner: "HR" } } },
              { op: "feedAppend", view: "audit", item: {
                id: "au-3",
                from: "AI 同事",
                time: "09:13:02",
                text: "成本与毛利查询被权限矩阵拦截，未发生任何数据读取",
                card: { title: "越权请求已拦截", body: "数据域「成本与毛利」对本岗位无授权；已给出合规申请路径", meta: [{ text: "未读取数据", tone: "pass" }, { text: "已记账", tone: "info" }] },
              } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "3 条" },
            ],
          },
        },
        {
          id: "c3-text",
          kind: "text",
          title: "回复",
          defaultOpen: true,
          content: [
            "**这条我不能查，也不会绕**。成本与毛利属于财务数据域，你的岗位没有授权——右侧权限矩阵里这一行是明确拒绝的，我没有读取任何数据。",
            "",
            "如果确实需要，有两条正规路径：",
            "",
            "1. 在审批系统发起《数据访问申请》，选「订单成本」数据域，财务部审批后我就能读；",
            "2. 或者请财务同事把可对外的价格区间直接给你，不涉及成本明细。",
            "",
            "我们先把放行这件事办完？原产地证还等着换新。",
          ].join("\n"),
        },
      ],
    },

    {
      caption: "补齐证据并重新核验",
      blocks: [
        {
          id: "c4-tool",
          kind: "tool_use",
          title: "EvidenceCheck",
          defaultOpen: true,
          toolName: "EvidenceCheck",
          toolId: "t-recheck",
          content: JSON.stringify({ order: "SO-2026-0731", recheck: ["CO"] }),
          executionStatus: "completed",
          durationMs: 940,
          presentation: {
            title: "新原产地证到账后重新核验",
            detail: [
              { k: "新证编号", v: "CO-2026-1188" },
              { k: "有效期至", v: "2026-10-31" },
              { tree: "├", k: "主体核对", v: "与出口商一致" },
              { tree: "└", k: "旧证处置", v: "标记作废，保留在留痕中" },
            ],
            status: "ok",
            receipt: { id: "CO-2026-1188", system: "合规证据台账", readBack: true },
            panel: [
              { op: "focus", view: "evidence" },
              { op: "toolbar", view: "evidence", title: "合规证据台账 · SO-2026-0731", sub: "通过 3 · 待人判 1" },
              { op: "tableRowUpdate", view: "evidence", id: "ev-co", set: { cells: { no: "CO-2026-1188", state: "通过" }, tone: "pass" } },
              { op: "cellFlag", view: "evidence", rowId: "ev-co", colKey: "state", tone: "pass", flag: "已换新" },
              { op: "feedAppend", view: "audit", item: { id: "au-4", from: "AI 同事", time: "09:41:35", text: "写入新原产地证 CO-2026-1188 并回读校验通过；旧证标记作废" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "4 条" },
            ],
          },
        },
        {
          id: "c4-text",
          kind: "text",
          title: "业务进展",
          defaultOpen: true,
          content: "新原产地证已写入台账并回读校验通过。现在只剩 RoHS 主体那一条要你们自己拍——材料我整理好了，下一步必须由有权人明确放行，我不会自动越过。",
        },
      ],
    },

    {
      caption: "有权人放行",
      blocks: [],
      approval: {
        title: "出口合规放行 · 需有权人确认",
        description: "放行后才会生成对外证据包与受控链接。这一步会改变业务系统，必须由有权人明确确认。",
        facts: [
          { label: "订单", value: "SO-2026-0731 · 德国" },
          { label: "证据状态", value: "通过 3 · 待人判 1（RoHS 主体）" },
          { label: "放行依据", value: "《出口合规管理办法》4.2 条" },
          { label: "链接有效期", value: "72 小时 · 下载 2 次" },
        ],
        approveLabel: "确认放行",
        rejectLabel: "退回修改",
        approvedBlocks: [
          {
            id: "c5-human",
            kind: "prompt",
            title: "用户消息",
            defaultOpen: true,
            content: "RoHS 这条我确认：母公司授权书在合规柜里，是有效的，按通过算。但链接有效期改成 48 小时，别给 72。",
          },
          {
            id: "c5-tool",
            kind: "tool_use",
            title: "Approval",
            defaultOpen: true,
            toolName: "Approval",
            toolId: "t-approve",
            content: JSON.stringify({ order: "SO-2026-0731", decision: "released" }),
            executionStatus: "completed",
            durationMs: 320,
            presentation: {
              title: "放行已确认 · 含人工修改 1 项",
              detail: [
                { k: "审批结果", v: "放行" },
                { k: "人工采纳", v: "3 项核验结论" },
                { k: "人工修改", v: "1 项——链接有效期 72 小时 → 48 小时" },
                { tree: "├", k: "人工补充", v: "RoHS 主体依据母公司授权书，判定通过" },
                { tree: "└", k: "留痕", v: "放行人、依据条款、原结论与修改点均已记录" },
              ],
              status: "ok",
              receipt: { id: "AP-2026-0442", system: "审批中心", readBack: true },
              panel: [
                { op: "focus", view: "evidence" },
                { op: "tableRowUpdate", view: "evidence", id: "ev-rohs", set: { cells: { state: "人工判定通过" }, tone: "pass" } },
                { op: "cellFlag", view: "evidence", rowId: "ev-rohs", colKey: "state", tone: "pass", flag: "人工判定" },
                { op: "toolbar", view: "evidence", title: "合规证据台账 · SO-2026-0731", sub: "全部通过 · 已放行" },
                { op: "feedAppend", view: "audit", item: {
                  id: "au-5",
                  from: "合规负责人",
                  time: "09:44:10",
                  text: "确认放行：采纳 3 项、修改 1 项（有效期 72h → 48h）、补充 1 项人工判定依据",
                  card: { title: "人审记录", body: "采纳 3 · 修改 1 · 自动放行 0", meta: [{ text: "AI 未自行放行", tone: "pass" }] },
                } },
                { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "5 条" },
              ],
            },
          },
          {
            id: "c5-text",
            kind: "text",
            title: "审批结果",
            defaultOpen: true,
            content: "放行已记录，你改的两处我都按新口径执行：RoHS 记为人工判定通过（附授权书依据），对外链接有效期改为 48 小时。",
          },
        ],
        rejectedBlocks: [
          {
            id: "c5-rejected-tool",
            kind: "tool_use",
            title: "Approval",
            defaultOpen: true,
            toolName: "Approval",
            toolId: "t-reject",
            content: JSON.stringify({ order: "SO-2026-0731", decision: "rejected" }),
            executionStatus: "completed",
            durationMs: 280,
            presentation: {
              title: "放行被退回 · 未对外发出任何东西",
              detail: [
                { k: "审批结果", v: "退回修改" },
                { k: "对外链接", v: "未生成" },
                { k: "业务系统", v: "证据台账无写入" },
                { tree: "└", k: "留痕", v: "退回时间、退回人与当时材料版本已记录" },
              ],
              status: "blocked",
              panel: [
                { op: "focus", view: "dispatch" },
                { op: "toolbar", view: "dispatch", title: "受控分发链路", sub: "未放行" },
                { op: "rowsSet", view: "dispatch", rows: [
                  { id: "d-hold", text: "对外链接未生成", sub: "审批未通过，分发链路保持关闭", tone: "warn", badge: { text: "已停住", tone: "warn" } },
                ] },
                { op: "feedAppend", view: "audit", item: { id: "au-reject", from: "合规负责人", time: "09:44:10", text: "放行被退回：未生成任何对外链接，证据台账无写入" } },
              ],
            },
          },
          {
            id: "c5-rejected-text",
            kind: "text",
            title: "退回说明",
            defaultOpen: true,
            content: "已停在放行点：没有生成对外链接，证据台账也没有任何写入。退回记录已留痕，补充材料后重新提交，仍需要再次明确放行。",
          },
        ],
      },
    },

    {
      caption: "生成对外证据包",
      blocks: [
        {
          id: "c6-tool",
          kind: "tool_use",
          title: "Dispatch",
          defaultOpen: true,
          toolName: "Dispatch",
          toolId: "t-dispatch",
          content: JSON.stringify({ order: "SO-2026-0731", ttlHours: 48 }),
          executionStatus: "completed",
          durationMs: 1260,
          presentation: {
            title: "生成受控证据包与对外链接",
            detail: [
              { k: "证据包", v: "4 份文件 · 均为放行版本" },
              { k: "对外链接", v: "48 小时 · 下载 2 次" },
              { tree: "├", k: "收件方", v: "Nordlicht Automation GmbH（德国）" },
              { tree: "└", k: "复查", v: "48 小时后自动复查下载与到期状态" },
            ],
            status: "ok",
            receipt: { id: "PACK-SO-2026-0731", system: "受控分发链路", readBack: true },
            panel: [
              { op: "focus", view: "dispatch" },
              { op: "toolbar", view: "dispatch", title: "受控分发链路 · 已放行", sub: "1 个有效链接" },
              { op: "rowsSet", view: "dispatch", rows: [
                { id: "d-link", text: "evidence.example-partner.com/pack/SO-2026-0731", sub: "48 小时内有效 · 下载 0/2", tone: "pass", state: "hit", badge: { text: "已生成", tone: "pass" } },
                { id: "d-to", text: "收件方：Nordlicht Automation GmbH", sub: "德国 · 报关行抄送", tone: "info" },
                { id: "d-recheck", text: "48 小时后自动复查", sub: "未下载或临近到期会提醒负责人", tone: "pending", badge: { text: "已挂载", tone: "info" } },
              ] },
              { op: "feedAppend", view: "audit", item: { id: "au-6", from: "AI 同事", time: "09:44:58", text: "生成受控证据包 PACK-SO-2026-0731 并回读校验；48 小时复查任务已挂载" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "6 条" },
            ],
          },
        },
        {
          id: "c6-text",
          kind: "text",
          title: "回复",
          defaultOpen: true,
          content: [
            "证据包已生成并发出。**下面这份就是对方此刻打开链接看到的页面**，你可以先自己核一遍再让客户点：",
            "",
            `[FILE]{"filePath":"${EVIDENCE_PACK_PATH}","fileName":"出口合规证据包.html","fileSize":${EVIDENCE_PACK_SIZE_BYTES}}[/FILE]`,
            "",
            "链接 48 小时有效、最多下载 2 次；48 小时后我会自动复查一次下载情况和证书临期状态。",
          ].join("\n"),
        },
      ],
    },

    {
      caption: "跨系统核对终态",
      blocks: [
        {
          id: "c7-tool",
          kind: "tool_use",
          title: "ReadBack",
          defaultOpen: true,
          toolName: "ReadBack",
          toolId: "t-readback",
          content: JSON.stringify({ order: "SO-2026-0731" }),
          executionStatus: "completed",
          durationMs: 1080,
          presentation: {
            title: "回读四个系统，核对说法是否一致",
            detail: [
              { k: "回读方式", v: "按对象 ID 逐个反查，不用本次会话的缓存" },
              { verdict: "pass", text: "ERP 订单", note: "SO-2026-0731 · 合规状态：已放行" },
              { verdict: "pass", text: "证据台账", note: "4 项全部有效 · 旧证已作废" },
              { verdict: "pass", text: "审批系统", note: "放行单 AP-2026-0442 · 含 1 项人工修改" },
              { verdict: "pass", text: "分发链路", note: "1 个有效链接 · 48 小时 · 下载 0/2" },
              { insight: "四方一致，无未决动作", label: "结论" },
            ],
            status: "ok",
            panel: [
              { op: "focus", view: "evidence" },
              { op: "toolbar", view: "evidence", title: "合规证据台账 · 终态回读", sub: "四方一致" },
              { op: "feedAppend", view: "audit", item: { id: "au-7", from: "AI 同事", time: "09:45:30", text: "回读 ERP / 证据台账 / 审批系统 / 分发链路，四方状态一致" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "7 条" },
            ],
          },
        },
        {
          id: "c7-text",
          kind: "text",
          title: "本次会话改变了什么",
          defaultOpen: true,
          content: [
            "## 本次会话改变了什么",
            "",
            "| 系统 | 终态 | 依据 |",
            "| --- | --- | --- |",
            "| ERP 订单 | 合规状态：已放行 | 放行单 AP-2026-0442 |",
            "| 合规证据台账 | 4 项有效，旧原产地证作废 | CO-2026-1188 回读通过 |",
            "| 审批系统 | 1 张放行单，含 1 项人工修改 | 有效期 72h → 48h |",
            "| 分发链路 | 1 个 48 小时链接，下载 0/2 | 48 小时后自动复查 |",
            "",
            "## 本次会话没有做什么",
            "",
            "- 没有读取成本与毛利：越权请求在权限矩阵处被拦截，零数据读取；",
            "- 没有自行放行：RoHS 主体这条由合规负责人判定，AI 不替人拍板；",
            "- 没有改动旧证：旧原产地证只标作废，原件与历史记录保留可查。",
          ].join("\n"),
        },
      ],
    },
  ],

  // 治理条款：state != exists 的条目就是「演示到真实」的距离
  sources: [
    {
      blockRef: "step1.tool.ERPQuery",
      producer: "ERP 连接器（MCP / 自建集成）",
      state: "missing",
      gap: "当前没有 ERP 连接器；真实会话读订单要么走客户自建 API，要么走 Shell + 数据库只读账号，且两者都不产出业务语义摘要",
    },
    {
      blockRef: "step2.tool.EvidenceCheck",
      producer: "合规规则执行器",
      state: "missing",
      gap: "规则判定当前靠 Agent 临场推理，没有可版本化的规则集与判定台账；要做成产品必须先有规则版本与生效日期",
    },
    {
      blockRef: "step3.tool.FinanceQuery",
      producer: "独立范围门禁（唯恩批次已验证形态）",
      state: "needs-change",
      gap: "门禁形态已在唯恩 POC 验证（loop 外独立 LLM 判定 + 前端预设话术），但尚未产品化为可配置的数据域权限矩阵",
    },
    {
      blockRef: "step4.tool.EvidenceCheck",
      producer: "合规证据台账（写入 + 回读）",
      state: "missing",
      gap: "写后回读这套契约 ToolReceipt 已有字段，但没有任何连接器在真实会话里产出它",
    },
    {
      blockRef: "step5.tool.Approval",
      producer: "业务审批执行器",
      state: "needs-change",
      gap: "HITL 审批事件在 runtime 已成对记录，但「人改了哪一条」目前没有结构化字段，只能落在自由文本里",
    },
    {
      blockRef: "step6.tool.Dispatch",
      producer: "受控分发链路",
      state: "missing",
      gap: "对外受控链接（有效期 / 下载次数 / 到期复查）产品里尚不存在，需要新建；这是瑞芯微演示里最有说服力的一屏，也是最贵的一块",
    },
    {
      blockRef: "step7.tool.ReadBack",
      producer: "业务终态回读器",
      state: "missing",
      gap: "跨系统回读需要先有各系统连接器；在此之前终态核对表只能是人工整理",
    },
    {
      blockRef: "step6.artifact.出口合规证据包",
      producer: "Agent 生成 HTML 产物",
      state: "exists",
    },
  ],
};

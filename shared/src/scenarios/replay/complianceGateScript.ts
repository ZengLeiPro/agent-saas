import type { SystemPanelSnapshot } from "../../lib/systemPanel";
import type { ReplayScript } from "./types";

/**
 * D2：多源证据精确绑定到业务对象，由专业责任人核定后放行原业务门禁。
 *
 * 核心不是“文件齐了”，而是每份证据都与主体、对象、用途、期间和 revision
 * 精确绑定；错主体、过期或版本不符时原业务门禁保持 HOLD。批准只对当前绑定
 * 生效，对象变化后旧批准自动失效。
 *
 * 内容为示例数据，不对应任何真实企业、订单或证书。
 */

const EVIDENCE_PACK_PATH = "assets/demo/证据与放行绑定快照.html";

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

<h1>Evidence Binding & Release Snapshot · 证据与放行绑定快照</h1>
<p class="sub">Order SO-2026-0731 R3 · X7 Hardware B2 · Destination: Germany (EU) · Released 2026-07-26</p>

<div class="box">
  <h2>Shipment · 货物信息</h2>
  <div class="kv">
    <span>Exporter</span><span>Example Precision Equipment Co., Ltd.（示例主体）</span>
    <span>Order</span><span>SO-2026-0731 · Revision R3</span>
    <span>Product</span><span>X7 Industrial Controller ×120 · Hardware B2</span>
    <span>Consignee</span><span>Nordlicht Automation GmbH</span>
    <span>Use / period</span><span>EU industrial use · Shipment window 2026-07-29</span>
  </div>
</div>

<table>
  <tr><th>Document</th><th>No.</th><th>Valid until</th><th>Status</th></tr>
  <tr><td>CE Declaration of Conformity</td><td>CE-X7-2026-014</td><td>2027-05-30</td><td class="ok">Valid</td></tr>
  <tr><td>EMC Test Report</td><td>EMC-2026-0512</td><td>2028-05-12</td><td class="ok">Valid</td></tr>
  <tr><td>Certificate of Origin</td><td>CO-2026-1188</td><td>2026-10-31</td><td class="ok">Valid（renewed 07-26）</td></tr>
  <tr><td>RoHS Statement</td><td>ROHS-GROUP-2026</td><td>2027-01-15</td><td class="ok">Valid（subject authorization bound）</td></tr>
</table>

<div class="box">
  <h2>Release · 放行记录</h2>
  <div class="kv">
    <span>Released by</span><span>Compliance Manager（有权人）</span>
    <span>Decision</span><span>Accepted · No waiver</span>
    <span>Basis</span><span>Export Compliance Policy EU-2026.07 §4.2</span>
    <span>Binding</span><span>Order R3 · X7 Hardware B2 · EU industrial use · Shipment window 2026-07-29</span>
    <span>Invalidation</span><span>Any subject, object, use, period or revision change resets the gate to HOLD.</span>
  </div>
</div>

<p class="foot">Demo content. Fictional order, certificates and parties. 示例内容，不对应任何真实订单或证书。</p>
</body></html>`;

const EVIDENCE_PACK_SIZE_BYTES = new TextEncoder().encode(EVIDENCE_PACK_HTML).length;

/** 面板底稿：证据台账 / 原业务门禁 / 操作留痕 */
const PANEL_BASE: SystemPanelSnapshot = {
  title: "企业系统实况",
  live: true,
  activeView: "evidence",
  foot: "已连接：ERP · 合规证据台账 · PLM/QMS · 审批中心（演示）",
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
      key: "dispatch",
      label: "业务门禁",
      winTitle: "ERP · 出运门禁",
      toolbar: { title: "出运门禁 · SO-2026-0731", sub: "尚未核验" },
      widget: { kind: "rows", rows: [], empty: { title: "尚未读取原业务门禁" } },
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
  title: "多源证据核齐，原业务门禁放行",
  mode: "hero",
  artifacts: { [EVIDENCE_PACK_PATH]: EVIDENCE_PACK_HTML },

  steps: [
    {
      caption: "一句话触发，自动读取业务对象",
      blocks: [
        {
          id: "c1-prompt",
          kind: "prompt",
          title: "用户消息",
          defaultOpen: true,
          content: "X7 这批货周三要报关，帮我确认能不能放；条件不齐就先卡住。",
        },
        {
          id: "c1-tool",
          kind: "tool_use",
          title: "ERPQuery",
          defaultOpen: true,
          toolName: "ERPQuery",
          toolId: "t-order",
          content: JSON.stringify({ 业务对象: "SO-2026-0731", 读取: ["订单", "产品版本", "证据台账", "出运门禁"] }),
          executionStatus: "completed",
          durationMs: 860,
          presentation: {
            title: "从 ERP、PLM/QMS 与证据台账读取企业上下文",
            detail: [
              { k: "主体", v: "示例精工设备有限公司 · 出口主体" },
              { k: "对象", v: "SO-2026-0731 R3 · X7 控制器 ×120 · 硬件 B2" },
              { k: "用途", v: "德国工业设备报关与交付" },
              { tree: "├", k: "期间", v: "装运窗口 2026-07-29" },
              { tree: "├", k: "规则版本", v: "出口放行规则 EU-2026.07" },
              { tree: "└", k: "原业务门禁", v: "HOLD · 等待证据核定" },
            ],
            status: "ok",
            panelBase: PANEL_BASE,
            panel: [
              { op: "focus", view: "evidence" },
              { op: "toolbar", view: "evidence", title: "合规证据台账 · SO-2026-0731 R3", sub: "4 项待绑定五要素" },
              { op: "tableRowInsert", view: "evidence", row: { id: "ev-ce", cells: { doc: "CE 符合性声明", no: "CE-X7-2026-014", state: "待核验" } } },
              { op: "tableRowInsert", view: "evidence", row: { id: "ev-emc", cells: { doc: "EMC 检测报告", no: "EMC-2026-0512", state: "待核验" } } },
              { op: "tableRowInsert", view: "evidence", row: { id: "ev-co", cells: { doc: "原产地证", no: "CO-2025-0904", state: "待核验" } } },
              { op: "tableRowInsert", view: "evidence", row: { id: "ev-rohs", cells: { doc: "RoHS 声明", no: "ROHS-GROUP-2026", state: "待核验" } } },
              { op: "rowsSet", view: "dispatch", rows: [
                { id: "gate-shipment", text: "SO-2026-0731 R3 · X7 硬件 B2", sub: "证据尚未核定，原业务门禁保持关闭", tone: "warn", badge: { text: "HOLD", tone: "warn" } },
              ] },
              { op: "feedAppend", view: "audit", item: { id: "au-1", from: "AI 同事", time: "09:12:04", text: "读取 ERP、PLM/QMS 与证据台账；原出运门禁为 HOLD" } },
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
          content: "业务对象 SO-2026-0731；订单版本 R3；产品版本 X7-B2；出运门禁 HOLD；候选证据 4 项。",
        },
        {
          id: "c1-text",
          kind: "text",
          title: "业务进展",
          defaultOpen: true,
          content: "你不用上传文件。我已经从企业系统取回订单、产品版本、用途、装运窗口、规则版本和 4 项候选证据。接下来逐份判断它们能不能证明**这一个业务对象**。",
        },
      ],
    },

    {
      caption: "逐项精确绑定，暴露两个硬缺口",
      blocks: [
        {
          id: "c2-tool",
          kind: "tool_use",
          title: "EvidenceCheck",
          defaultOpen: true,
          toolName: "EvidenceCheck",
          toolId: "t-check",
          content: JSON.stringify({ 业务对象: "SO-2026-0731", 订单版本: "R3", 产品版本: "B2", 规则版本: "EU-2026.07" }),
          executionStatus: "completed",
          durationMs: 1740,
          presentation: {
            title: "按主体、对象、用途、期间和版本逐项绑定",
            detail: [
              { verdict: "pass", text: "CE 符合性声明", note: "出口主体 · X7 B2 · 欧盟工业用途 · 有效期内" },
              { verdict: "pass", text: "EMC 检测报告", note: "X7 硬件 B2 · 覆盖本次用途和装运期间" },
              { verdict: "fail", text: "原产地证 CO-2025-0904", note: "2026-06-30 已过期，不覆盖 07-29 装运窗口" },
              { verdict: "fail", text: "RoHS 声明 ROHS-GROUP-2026", note: "签署主体是集团母公司，不是本次出口主体" },
              { insight: "文件都在，但 2 项不能用于本次业务对象；ERP 门禁继续 HOLD", label: "结论" },
            ],
            status: "blocked",
            panel: [
              { op: "focus", view: "evidence" },
              { op: "toolbar", view: "evidence", title: "证据绑定 · SO-2026-0731 R3", sub: "精确匹配 2 · 不适用 2" },
              { op: "tableRowUpdate", view: "evidence", id: "ev-ce", set: { cells: { state: "通过" } } },
              { op: "cellFlag", view: "evidence", rowId: "ev-ce", colKey: "state", tone: "pass", flag: "通过" },
              { op: "tableRowUpdate", view: "evidence", id: "ev-emc", set: { cells: { state: "通过" } } },
              { op: "cellFlag", view: "evidence", rowId: "ev-emc", colKey: "state", tone: "pass", flag: "通过" },
              { op: "tableRowUpdate", view: "evidence", id: "ev-co", set: { cells: { state: "期间不符" }, tone: "warn" } },
              { op: "cellFlag", view: "evidence", rowId: "ev-co", colKey: "state", tone: "deny", flag: "已过期" },
              { op: "tableRowUpdate", view: "evidence", id: "ev-rohs", set: { cells: { state: "主体不符" }, tone: "warn" } },
              { op: "cellFlag", view: "evidence", rowId: "ev-rohs", colKey: "state", tone: "deny", flag: "不适用" },
              { op: "focus", view: "dispatch" },
              { op: "toolbar", view: "dispatch", title: "ERP 出运门禁 · SO-2026-0731", sub: "2 项硬缺口" },
              { op: "rowsSet", view: "dispatch", rows: [
                { id: "gate-shipment", text: "订单 R3 · X7 硬件 B2", sub: "过期证据 + 错主体证据未解决", tone: "warn", badge: { text: "HOLD", tone: "warn" } },
              ] },
              { op: "feedAppend", view: "audit", item: { id: "au-2", from: "AI 同事", time: "09:12:21", text: "发现过期与错主体证据；未触碰 ERP 门禁，维持 HOLD" } },
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
            "现在**不能放行**。不是少了两个文件名，而是两份材料不能证明这批货：",
            "",
            "1. **原产地证已过期**，没有覆盖本次 07-29 装运窗口；",
            "2. **RoHS 声明主体不符**，签署主体不是本次出口主体。",
            "",
            "其余两项与主体、对象、用途、期间和版本全部对上。两个硬缺口解决前，ERP 继续保持 **HOLD**。",
          ].join("\n"),
        },
      ],
    },

    {
      caption: "新证据到账后自动重新核验",
      blocks: [
        {
          id: "c4-tool",
          kind: "tool_use",
          title: "EvidenceCheck",
          defaultOpen: true,
          toolName: "EvidenceCheck",
          toolId: "t-recheck",
          content: JSON.stringify({ 业务对象: "SO-2026-0731", 订单版本: "R3", 产品版本: "B2", 重新读取证据: true }),
          executionStatus: "completed",
          durationMs: 940,
          presentation: {
            title: "文档库出现新版本，按同一适用范围重新核验",
            detail: [
              { k: "新原产地证", v: "CO-2026-1188 · 覆盖 07-29 装运窗口" },
              { k: "主体授权书", v: "AUTH-GROUP-2026 · 明确覆盖出口主体与 X7 B2" },
              { tree: "├", k: "旧版本", v: "保留历史，不再作为本次放行依据" },
              { tree: "└", k: "重核结果", v: "4 项与五要素精确匹配" },
              { insight: "硬条件已满足；仍须合规负责人选择接受、豁免或拒绝", label: "下一步" },
            ],
            status: "waiting",
            receipt: { id: "CO-2026-1188", system: "合规证据台账", readBack: true },
            panel: [
              { op: "focus", view: "evidence" },
              { op: "toolbar", view: "evidence", title: "证据绑定 · SO-2026-0731 R3", sub: "4 项精确匹配 · 待专业核定" },
              { op: "tableRowUpdate", view: "evidence", id: "ev-co", set: { cells: { no: "CO-2026-1188", state: "通过" }, tone: "pass" } },
              { op: "cellFlag", view: "evidence", rowId: "ev-co", colKey: "state", tone: "pass", flag: "已换新" },
              { op: "tableRowUpdate", view: "evidence", id: "ev-rohs", set: { cells: { state: "授权关系已绑定" }, tone: "pass" } },
              { op: "cellFlag", view: "evidence", rowId: "ev-rohs", colKey: "state", tone: "pass", flag: "主体匹配" },
              { op: "feedAppend", view: "audit", item: { id: "au-3", from: "AI 同事", time: "09:41:35", text: "检测到 2 份新证据并重核：4 项精确匹配，等待专业核定" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "3 条" },
            ],
          },
        },
        {
          id: "c4-text",
          kind: "text",
          title: "业务进展",
          defaultOpen: true,
          content: "新材料由系统自动发现并重核，不需要业务员重新上传或说明来龙去脉。硬条件已经齐，但最后的专业判断仍留给合规负责人：接受、说明豁免依据，或者拒绝。",
        },
      ],
    },

    {
      caption: "合规负责人核定",
      blocks: [],
      approval: {
        title: "出口放行核定 · 接受 / 豁免 / 拒绝",
        description: "AI 只整理匹配事实，不替代专业责任。接受后才会写回原 ERP 门禁；若需豁免，必须补充依据后重新提交。",
        facts: [
          { label: "适用对象", value: "SO-2026-0731 R3 · X7 硬件 B2" },
          { label: "适用范围", value: "出口主体 · 德国工业用途 · 07-29 装运窗口" },
          { label: "证据状态", value: "4 项精确匹配 · 旧证据不参与本次核定" },
          { label: "建议决定", value: "接受 · 无需豁免" },
        ],
        approveLabel: "接受并提交放行",
        rejectLabel: "拒绝，保持 HOLD",
        approvedBlocks: [
          {
            id: "c5-human",
            kind: "prompt",
            title: "合规负责人决定",
            defaultOpen: true,
            content: "接受这 4 项证据，不使用豁免。只按订单 R3、X7 硬件 B2 和本次装运窗口放行。",
          },
          {
            id: "c5-tool",
            kind: "tool_use",
            title: "ProfessionalReview",
            defaultOpen: true,
            toolName: "ProfessionalReview",
            toolId: "t-approve",
            content: JSON.stringify({ 业务对象: "SO-2026-0731 R3 / X7 B2", 决定: "接受", 豁免: "无" }),
            executionStatus: "completed",
            durationMs: 320,
            presentation: {
              title: "专业核定已记录 · 接受，无豁免",
              detail: [
                { k: "决定", v: "接受 4 项证据" },
                { k: "豁免", v: "无" },
                { tree: "├", k: "绑定范围", v: "订单 R3 · X7 B2 · 07-29" },
                { tree: "└", k: "批准单", v: "AP-2026-0442" },
              ],
              status: "ok",
              receipt: { id: "AP-2026-0442", system: "审批中心", readBack: true },
              panel: [
                { op: "focus", view: "evidence" },
                { op: "toolbar", view: "evidence", title: "证据绑定 · SO-2026-0731 R3", sub: "已接受 · 无豁免 · 待写回门禁" },
                { op: "feedAppend", view: "audit", item: {
                  id: "au-4",
                  from: "合规负责人",
                  time: "09:44:10",
                  text: "接受 4 项证据，无豁免；批准单绑定订单 R3 / X7 B2 / 07-29",
                  card: { title: "专业核定", body: "接受 4 · 豁免 0 · AI 自动放行 0", meta: [{ text: "旧批准不可跨版本", tone: "info" }] },
                } },
                { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "4 条" },
              ],
            },
          },
          {
            id: "c5-text",
            kind: "text",
            title: "核定结果",
            defaultOpen: true,
            content: "决定已留痕：**接受，无豁免**。下一步只把这次核定写回原 ERP 出运门禁；批准范围不会自动扩大到后续订单或新产品版本。",
          },
        ],
        rejectedBlocks: [
          {
            id: "c5-rejected-tool",
            kind: "tool_use",
            title: "ProfessionalReview",
            defaultOpen: true,
            toolName: "ProfessionalReview",
            toolId: "t-reject",
            content: JSON.stringify({ 业务对象: "SO-2026-0731 R3 / X7 B2", 决定: "拒绝" }),
            executionStatus: "completed",
            durationMs: 280,
            presentation: {
              title: "专业核定已拒绝 · 原业务门禁保持 HOLD",
              detail: [
                { k: "决定", v: "拒绝" },
                { k: "ERP 门禁", v: "未写入，继续 HOLD" },
                { tree: "├", k: "对外动作", v: "未生成、未发送" },
                { tree: "└", k: "后续", v: "补充拒绝原因对应的证据后重新提交" },
              ],
              status: "blocked",
              panel: [
                { op: "focus", view: "dispatch" },
                { op: "toolbar", view: "dispatch", title: "ERP 出运门禁 · SO-2026-0731", sub: "专业核定已拒绝" },
                { op: "rowsSet", view: "dispatch", rows: [
                  { id: "gate-shipment", text: "订单 R3 · X7 硬件 B2", sub: "未写回任何放行动作；补证后需重新核定", tone: "warn", badge: { text: "HOLD", tone: "warn" } },
                ] },
                { op: "feedAppend", view: "audit", item: { id: "au-reject", from: "合规负责人", time: "09:44:10", text: "拒绝本次核定；ERP 未写入，原门禁继续 HOLD" } },
              ],
            },
          },
          {
            id: "c5-rejected-text",
            kind: "text",
            title: "拒绝后的下文",
            defaultOpen: true,
            content: "流程停在专业核定点：没有写回 ERP，也没有产生任何对外动作。拒绝决定和当时的证据版本已留痕；补证后重新匹配五要素，再发起一次新的核定。",
          },
        ],
      },
    },

    {
      caption: "批准后写回原业务门禁",
      blocks: [
        {
          id: "c6-tool",
          kind: "tool_use",
          title: "BusinessGateWrite",
          defaultOpen: true,
          toolName: "BusinessGateWrite",
          toolId: "t-gate-write",
          content: JSON.stringify({ 业务对象: "SO-2026-0731 R3 / X7 B2", 批准单: "AP-2026-0442", 目标状态: "RELEASED" }),
          executionStatus: "completed",
          durationMs: 1260,
          presentation: {
            title: "依据专业核定写回 ERP 出运门禁",
            detail: [
              { k: "业务对象", v: "SO-2026-0731 R3 · X7 硬件 B2" },
              { k: "门禁变化", v: "HOLD → RELEASED" },
              { tree: "├", k: "依据", v: "AP-2026-0442 · 接受，无豁免" },
              { tree: "└", k: "失效条件", v: "五要素任一变化，自动恢复 HOLD" },
            ],
            status: "ok",
            receipt: { id: "ERP-GATE-SO-2026-0731-R3", system: "ERP 出运门禁", readBack: true },
            panel: [
              { op: "focus", view: "dispatch" },
              { op: "toolbar", view: "dispatch", title: "ERP 出运门禁 · SO-2026-0731", sub: "订单 R3 · X7 硬件 B2" },
              { op: "rowsSet", view: "dispatch", rows: [
                { id: "gate-shipment", text: "订单 R3 · X7 硬件 B2", sub: "AP-2026-0442 · 仅当前五要素范围有效", tone: "pass", state: "hit", badge: { text: "RELEASED", tone: "pass" } },
                { id: "gate-invalidation", text: "变更失效规则已启用", sub: "主体、对象、用途、期间或版本变化即恢复 HOLD", tone: "info" },
              ] },
              { op: "feedAppend", view: "audit", item: { id: "au-5", from: "AI 同事", time: "09:44:58", text: "依据 AP-2026-0442 写回 ERP：出运门禁 HOLD → RELEASED" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "5 条" },
            ],
          },
        },
        {
          id: "c6-text",
          kind: "text",
          title: "业务结果",
          defaultOpen: true,
          content: [
            "原 ERP 出运门禁已经写入 **RELEASED**，不是另建一个任务或只生成一份报告。下面是本次证据与业务对象的绑定快照：",
            "",
            `[FILE]{"filePath":"${EVIDENCE_PACK_PATH}","fileName":"证据与放行绑定快照.html","fileSize":${EVIDENCE_PACK_SIZE_BYTES}}[/FILE]`,
            "",
            "快照记录了这次放行究竟适用于哪个主体、对象、用途、期间和版本；下一步再绕过会话缓存，从各权威源独立回读。",
          ].join("\n"),
        },
      ],
    },

    {
      caption: "独立回读终态与版本失效规则",
      blocks: [
        {
          id: "c7-tool",
          kind: "tool_use",
          title: "BusinessGateReadBack",
          defaultOpen: true,
          toolName: "BusinessGateReadBack",
          toolId: "t-readback",
          content: JSON.stringify({ 业务对象: "SO-2026-0731", 回读方式: "绕过会话缓存，从权威源重新读取" }),
          executionStatus: "completed",
          durationMs: 1080,
          presentation: {
            title: "绕过会话缓存，从各权威源重新读取",
            detail: [
              { verdict: "pass", text: "ERP 出运门禁", note: "RELEASED · 绑定订单 R3 / X7 B2" },
              { verdict: "pass", text: "受控文档库", note: "4 项当前证据 · 五要素精确匹配" },
              { verdict: "pass", text: "PLM/QMS", note: "当前投产版本仍为 X7 硬件 B2" },
              { verdict: "pass", text: "审批中心", note: "AP-2026-0442 · 接受，无豁免" },
              { k: "变更失效校验", v: "若订单变为 R4 或产品变为 B3，旧批准不匹配，门禁自动回到 HOLD" },
              { insight: "四方一致；当前对象已放行，旧批准不可跨对象或跨版本复用", label: "终态" },
            ],
            status: "ok",
            panel: [
              { op: "focus", view: "dispatch" },
              { op: "toolbar", view: "dispatch", title: "ERP 出运门禁 · 独立回读", sub: "四方一致 · RELEASED" },
              { op: "feedAppend", view: "audit", item: { id: "au-6", from: "AI 同事", time: "09:45:30", text: "绕过会话缓存回读 ERP、文档库、PLM/QMS 与审批中心：四方一致" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "6 条" },
            ],
          },
        },
        {
          id: "c7-text",
          kind: "text",
          title: "终态核对",
          defaultOpen: true,
          content: [
            "## 跨系统终态核对",
            "",
            "| 权威来源 | 独立回读终态 | 绑定依据 |",
            "| --- | --- | --- |",
            "| ERP 出运门禁 | **RELEASED** | SO-2026-0731 R3 · X7 硬件 B2 |",
            "| 受控文档库 | 4 项当前证据，全部精确匹配 | 主体 / 对象 / 用途 / 期间 / 版本 |",
            "| PLM/QMS | 当前投产版本仍为 B2 | 产品版本未变化 |",
            "| 审批中心 | 接受，无豁免 | AP-2026-0442 |",
            "| 变更失效规则 | 已启用 | 五要素任一变化，旧批准失效并恢复 HOLD |",
            "",
            "## 本次会话没有做什么",
            "",
            "- 没有让业务员上传 Excel、证书或重新解释企业内部规则；",
            "- 没有把过期证据、错主体证据当成“文件已存在”而放过；",
            "- 没有由 AI 替代合规负责人作专业核定，也没有默认使用豁免；",
            "- 没有把审批当成终态：批准后写回并独立回读的是原 ERP 出运门禁；",
            "- 没有让本次批准覆盖订单 R4、产品 B3 或其他主体与用途。",
          ].join("\n"),
        },
      ],
    },
  ],

  // 治理条款：state != exists 的条目就是「演示到真实」的距离
  sources: [
    {
      blockRef: "step1.tool.ERPQuery",
      producer: "企业上下文解析器（ERP + PLM/QMS + 证据台账）",
      state: "missing",
      gap: "尚缺把主体、对象、用途、期间、revision 与生效规则拼成稳定业务关联键的产出方",
    },
    {
      blockRef: "step2.tool.EvidenceCheck",
      producer: "证据适用性规则执行器",
      state: "missing",
      gap: "当前没有可版本化、可审计的五要素精确绑定与 HOLD 判定执行器",
    },
    {
      blockRef: "step3.tool.EvidenceCheck",
      producer: "证据变更监听与重核执行器",
      state: "missing",
      gap: "尚不能在文档新版本出现后关联原业务对象，并自动重跑同一版五要素规则",
    },
    {
      blockRef: "step4.tool.ProfessionalReview",
      producer: "专业核定执行器",
      state: "needs-change",
      gap: "HITL 已能记录同意与退回，但尚缺接受、豁免、拒绝三值及绑定范围的结构化留痕",
    },
    {
      blockRef: "step5.tool.BusinessGateWrite",
      producer: "ERP 业务门禁写入器",
      state: "missing",
      gap: "尚无按批准单和对象 revision 幂等写回原业务门禁的连接器",
    },
    {
      blockRef: "step6.tool.BusinessGateReadBack",
      producer: "跨系统终态回读器",
      state: "missing",
      gap: "需要各权威源连接器、绕过会话缓存的独立查询，以及对象变化后自动撤销旧批准的状态机",
    },
    {
      blockRef: "step5.artifact.证据与放行绑定快照",
      producer: "Agent 生成 HTML 产物",
      state: "exists",
    },
  ],
};

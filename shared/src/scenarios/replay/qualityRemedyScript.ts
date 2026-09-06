import type { SystemPanelSnapshot } from "../../lib/systemPanel";
import type { ReplayScript } from "./types";

/**
 * D4：把客户问题推进到补救兑现、客户确认与防复发验证。
 *
 * Agent 可以关联订单、批次、资产和服务证据，也可以区分质量缺陷线索与
 * 服务争议，但不替质量、客服、财务或法务定责，更不会自动判定召回。
 * 终态不是 8D 文档，而是钱、货、工单、客户确认和下一批验证彼此一致。
 *
 * 内容均为演示数据，不对应任何真实企业、客户、订单或批次。
 */

const REMEDY_RECEIPT_PATH = "assets/demo/客诉补救与验证回执.html";

const REMEDY_RECEIPT_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<style>
  :root { --brand: #2E56E1; --ink: #0f172a; --muted: #64748b; --line: #e2e8f0; --ok: #15803d; --warn: #b45309; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 20px; font: 14px/1.7 "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; color: var(--ink); background: #fff; }
  .bar { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border: 1px solid var(--line); border-radius: 6px; background: #f8fafc; color: var(--muted); font-size: 12px; margin-bottom: 16px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #cbd5e1; }
  h1 { margin: 0 0 4px; font-size: 16px; }
  .sub { margin: 0 0 16px; color: var(--muted); font-size: 12px; }
  .status { display: inline-block; padding: 2px 8px; border-radius: 999px; color: var(--ok); background: #ecfdf5; font-size: 12px; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin: 14px 0; }
  th, td { border: 1px solid var(--line); padding: 7px 10px; text-align: left; vertical-align: top; }
  th { background: #f8fafc; color: var(--muted); font-weight: 500; }
  .ok { color: var(--ok); font-weight: 600; }
  .box { border: 1px solid var(--line); border-radius: 8px; padding: 12px; margin-top: 12px; }
  .box h2 { margin: 0 0 8px; font-size: 13px; }
  .kv { display: grid; grid-template-columns: 108px 1fr; gap: 4px 12px; font-size: 13px; }
  .kv span:nth-child(odd) { color: var(--muted); }
  .foot { margin-top: 14px; color: var(--muted); font-size: 12px; }
</style></head><body>
<div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span>service.demo / case / CS-2026-0147</span></div>

<h1>客诉补救与验证回执</h1>
<p class="sub">澜星自动化（演示客户） · CS-2026-0147 · 伺服驱动模组 SDM-42</p>
<span class="status">补救已兑现 · 客户已确认</span>

<table>
  <tr><th>事项</th><th>执行结果</th><th>可核对回执</th></tr>
  <tr><td>故障设备</td><td>4 台模组更换完成，连续运行 72 小时无停机</td><td class="ok">FS-2026-0811-06</td></tr>
  <tr><td>退换物流</td><td>4 台替换件已签收，4 台故障件已进入隔离区</td><td class="ok">RMA-2026-381</td></tr>
  <tr><td>服务补救</td><td>服务额度 ¥12,800 已入客户账户</td><td class="ok">CR-2026-0946</td></tr>
  <tr><td>客户确认</td><td>生产恢复，补救内容与金额均确认无误</td><td class="ok">ACK-2026-2218</td></tr>
</table>

<div class="box">
  <h2>防复发验证</h2>
  <div class="kv">
    <span>受影响批次</span><span>B20260728 · 已停止继续流转</span>
    <span>下批验证</span><span>B20260818 · 锁扣保持力 30/30 通过，首批 200 件通过</span>
    <span>观察窗口</span><span>14 天 · 40 台已投用设备无同症状复发</span>
    <span>复开规则</span><span>同批次、同故障码或客户否认恢复，自动重开原案件</span>
  </div>
</div>

<p class="foot">本页是补救执行与验证回执，不是责任认定书或召回结论。示例内容，不对应任何真实客户。</p>
</body></html>`;

const REMEDY_RECEIPT_SIZE_BYTES = new TextEncoder().encode(REMEDY_RECEIPT_HTML).length;

/** 面板底稿：案件 / 影响范围 / 质量与服务 / 补救执行 / 客户沟通 / 操作留痕 */
const PANEL_BASE: SystemPanelSnapshot = {
  title: "企业系统实况",
  live: true,
  activeView: "case",
  foot: "已连接：CRM/合同 · QMS/CMMS · OMS/WMS/支付 · 客户门户（演示）",
  views: [
    {
      key: "case",
      label: "客诉案件",
      winTitle: "客诉案件 · CS-2026-0147",
      toolbar: { title: "客诉案件 · CS-2026-0147", sub: "尚未关联业务对象" },
      widget: {
        kind: "table",
        cols: [
          { key: "object", label: "对象" },
          { key: "fact", label: "当前事实" },
          { key: "state", label: "状态", align: "right" },
        ],
        rows: [],
        empty: { title: "尚未读取案件上下文" },
      },
    },
    {
      key: "impact",
      label: "影响范围",
      winTitle: "批次与资产 · 影响范围",
      toolbar: { title: "批次 B20260728", sub: "尚未追溯" },
      widget: { kind: "rows", rows: [], empty: { title: "尚未关联批次流向" } },
    },
    {
      key: "quality",
      label: "质量与服务",
      winTitle: "QMS / CMMS · 证据与判定",
      toolbar: { title: "质量与服务证据", sub: "尚未核对" },
      widget: { kind: "rows", rows: [], empty: { title: "尚未读取质量与服务记录" } },
    },
    {
      key: "remedy",
      label: "补救执行",
      winTitle: "OMS / WMS / 支付 / 现场服务",
      toolbar: { title: "补救执行", sub: "尚未批准" },
      widget: { kind: "rows", rows: [], empty: { title: "尚无补救动作" } },
    },
    {
      key: "customer",
      label: "客户确认",
      winTitle: "客户门户 · 沟通与确认",
      toolbar: { title: "客户沟通", sub: "尚未发出" },
      widget: { kind: "feed", items: [], empty: { title: "尚无客户消息" } },
    },
    {
      key: "audit",
      label: "操作留痕",
      winTitle: "操作留痕 · 本次案件",
      toolbar: { title: "本次案件的系统动作", sub: "0 条" },
      widget: { kind: "feed", items: [], empty: { title: "尚无系统动作" } },
    },
  ],
};

export const qualityRemedyScript: ReplayScript = {
  scenarioId: "catalog-customer-issue-resolution-loop",
  title: "客诉不是关单，补救兑现后再验证",
  mode: "hero",
  artifacts: { [REMEDY_RECEIPT_PATH]: REMEDY_RECEIPT_HTML },

  steps: [
    {
      caption: "一句话接管客诉，自动读取企业上下文",
      blocks: [
        {
          id: "qr1-prompt",
          kind: "prompt",
          title: "用户消息",
          defaultOpen: true,
          content: "这条投诉别只关单，推进到补救兑现且不再复发。",
        },
        {
          id: "qr1-tool",
          kind: "tool_use",
          title: "EnterpriseContextRead",
          defaultOpen: true,
          toolName: "EnterpriseContextRead",
          toolId: "t-context",
          content: JSON.stringify({ caseId: "CS-2026-0147", include: ["合同权益", "订单批次", "QMS", "CMMS", "OMS/WMS", "支付", "客户沟通"] }),
          executionStatus: "completed",
          durationMs: 1280,
          presentation: {
            title: "自动关联订单、权益、批次、服务与客户原始反馈",
            detail: [
              { k: "客户问题", v: "4 台 SDM-42 间歇停机，已影响 2 个班次" },
              { k: "订单权益", v: "SO-2026-1186 · 24 个月质保 · 8 小时响应 SLA" },
              { k: "业务对象", v: "序列号 S42186—S42189 · 批次 B20260728" },
              { tree: "├", k: "客户诉求", v: "先恢复生产，再核服务补救与损失" },
              { tree: "├", k: "当前争议", v: "现场报告写“电压波动”，但没有测量原始值" },
              { tree: "└", k: "现有状态", v: "客服准备关单，退款、换货、复检均未执行" },
            ],
            status: "warn",
            panelBase: PANEL_BASE,
            panel: [
              { op: "focus", view: "case" },
              { op: "toolbar", view: "case", title: "客诉案件 · CS-2026-0147", sub: "已关联 7 类企业上下文" },
              { op: "tableRowInsert", view: "case", row: { id: "case-order", cells: { object: "订单与权益", fact: "SO-2026-1186 · 质保内 · SLA 已超 6 小时", state: "已确认" }, tone: "warn" } },
              { op: "tableRowInsert", view: "case", row: { id: "case-assets", cells: { object: "设备", fact: "S42186—S42189 · 间歇停机", state: "4 台" } } },
              { op: "tableRowInsert", view: "case", row: { id: "case-batch", cells: { object: "批次", fact: "B20260728 · 共 60 台", state: "待追溯" }, tone: "warn" } },
              { op: "tableRowInsert", view: "case", row: { id: "case-remedy", cells: { object: "补救", fact: "换货 / 服务补救 / 客户确认", state: "均未执行" }, tone: "deny" } },
              { op: "feedAppend", view: "audit", item: { id: "au-1", from: "AI 同事", time: "08-10 09:20", text: "读取合同、订单、QMS、CMMS、OMS/WMS、支付与客户线程（只读）" } },
              { op: "toolbar", view: "audit", title: "本次案件的系统动作", sub: "1 条" },
            ],
          },
        },
        {
          id: "qr1-result",
          kind: "tool_result",
          title: "EnterpriseContextRead 结果",
          defaultOpen: false,
          toolName: "EnterpriseContextRead",
          toolId: "t-context",
          content: "case=CS-2026-0147 order=SO-2026-1186 assets=4 batch=B20260728 entitlement=in_warranty sla_breach=6h",
        },
        {
          id: "qr1-text",
          kind: "text",
          title: "业务进展",
          defaultOpen: true,
          content: "这不是让我写一份客诉报告。我已经直接从企业系统拿到客户原话、合同权益、4 台设备、批次、服务记录和当前钱货状态。现在客服想关单，但客户尚未恢复生产，任何补救也没有兑现。",
        },
      ],
    },

    {
      caption: "关联影响范围，拆开质量线索与服务争议",
      blocks: [
        {
          id: "qr2-tool",
          kind: "tool_use",
          title: "IssueScopeAnalysis",
          defaultOpen: true,
          toolName: "IssueScopeAnalysis",
          toolId: "t-scope",
          content: JSON.stringify({ caseId: "CS-2026-0147", batch: "B20260728", preserveUncertainty: true }),
          executionStatus: "completed",
          durationMs: 1840,
          presentation: {
            title: "把单张工单还原成批次、资产与服务三条线",
            detail: [
              { risk: "high", text: "影响范围不是 4 台，而是同批 60 台", action: "客户 A 8 台已投用（4 台故障）· 客户 B 32 台待启用 · 本仓 20 台" },
              { verdict: "pending", text: "质量缺陷线索", note: "4 台同批同故障码，QMS 留样锁扣保持力接近下限；需取样确认" },
              { verdict: "fail", text: "“客户电压波动”归因", note: "CMMS 报告没有电压原始值，不能据此把责任归给客户" },
              { verdict: "pass", text: "服务争议可单独确认", note: "合同要求 8 小时响应，实际晚 6 小时；是否给服务补救由客服与财务决定" },
              { warn: "现有证据不足以自动定责，也不足以判断是否需要召回；这两件事必须保留给质量与法务" },
              { insight: "先把 20 台在库品隔离、补齐 6 台抽检和现场日志，再提交最小补救方案", label: "安全推进路径" },
            ],
            status: "waiting",
            panel: [
              { op: "focus", view: "impact" },
              { op: "toolbar", view: "impact", title: "批次 B20260728 · 影响范围", sub: "60 台 · 3 个去向" },
              { op: "rowsSet", view: "impact", rows: [
                { id: "impact-a", text: "澜星自动化（演示客户）8 台", sub: "已投用 · 4 台故障 / 4 台仍运行", tone: "deny", state: "hit", badge: { text: "已发生", tone: "deny" } },
                { id: "impact-b", text: "另一演示客户 32 台", sub: "已签收 · 尚未启用", tone: "warn", badge: { text: "可拦截", tone: "warn" } },
                { id: "impact-stock", text: "本仓 20 台", sub: "未出库 · 可立即隔离与抽检", tone: "info", badge: { text: "在手", tone: "info" } },
              ] },
              { op: "focus", view: "quality" },
              { op: "toolbar", view: "quality", title: "质量与服务证据", sub: "线索 2 · 争议 1 · 待补证 2" },
              { op: "rowsSet", view: "quality", rows: [
                { id: "q-code", text: "4 台出现同一故障码 E-17", sub: "同批次、同连接器位置", tone: "warn", badge: { text: "质量线索", tone: "warn" } },
                { id: "q-voltage", text: "“现场电压波动”没有原始记录", sub: "不得作为定责依据", tone: "deny", badge: { text: "证据不足", tone: "deny" } },
                { id: "q-sla", text: "服务响应比合同 SLA 晚 6 小时", sub: "事实可确认，补救金额待审批", tone: "warn", badge: { text: "服务争议", tone: "warn" } },
              ] },
              { op: "feedAppend", view: "audit", item: { id: "au-2", from: "AI 同事", time: "08-10 09:22", text: "追溯 60 台批次流向；区分质量线索、服务事实与待定责任" } },
              { op: "toolbar", view: "audit", title: "本次案件的系统动作", sub: "2 条" },
            ],
          },
        },
        {
          id: "qr2-text",
          kind: "text",
          title: "业务进展",
          defaultOpen: true,
          content: [
            "这件事已经拆清楚了：",
            "",
            "- **质量线索**：4 台同批、同故障码，留样数据也贴近下限，但现在只能说需要调查，不能直接判根因；",
            "- **服务争议**：晚响应 6 小时是合同与工单都能证明的事实，可以单独补救；",
            "- **责任与召回**：现有证据都不够，我不会替质量或法务下结论。",
            "",
            "真正暴露的范围是 60 台，不是投诉里的 4 台。好消息是 52 台还没发生故障，其中 20 台还在我们仓库，先隔离和抽检来得及。",
          ].join("\n"),
        },
      ],
    },

    {
      caption: "先隔离可控范围，补齐最少必要证据",
      blocks: [
        {
          id: "qr3-tool",
          kind: "tool_use",
          title: "ContainmentAndEvidence",
          defaultOpen: true,
          toolName: "ContainmentAndEvidence",
          toolId: "t-contain",
          content: JSON.stringify({ batch: "B20260728", stockHold: 20, sample: 6, requestFieldLogs: true }),
          executionStatus: "completed",
          durationMs: 2260,
          presentation: {
            title: "按预设质量规则隔离库存，并补齐判断所需证据",
            detail: [
              { verdict: "pass", text: "WMS 在库 20 台进入 QA-HOLD", note: "未删除、未报废、未向客户承诺，等待有权人处置" },
              { verdict: "fail", text: "仓内抽检 6 台，2 台锁扣保持力低于规格", note: "QMS 原始值 17.8N / 18.1N，规格下限 18.5N" },
              { verdict: "pass", text: "客户补回 4 台序列号、告警日志与现场电压曲线", note: "电压处于设备允许范围" },
              { tree: "├", k: "质量判断", v: "质量工程师已接管批次不符合项，根因仍在调查" },
              { tree: "└", k: "外部动作", v: "尚未通知第二客户，也未批准换货、退款或召回" },
              { insight: "隔离和证据已经到位，可以把每个岗位只该决定的那一小块送审", label: "下一步" },
            ],
            status: "waiting",
            receipt: { id: "QH-2026-0738", system: "QMS / WMS", readBack: true },
            panel: [
              { op: "focus", view: "impact" },
              { op: "toolbar", view: "impact", title: "批次 B20260728 · 临时控制", sub: "20 台已隔离 · 32 台待决定" },
              { op: "rowsSet", view: "impact", rows: [
                { id: "impact-a", text: "澜星自动化（演示客户）8 台", sub: "4 台故障已停用 · 4 台受控运行", tone: "deny", badge: { text: "待补救", tone: "deny" } },
                { id: "impact-b", text: "另一演示客户 32 台", sub: "尚未启用 · 等待联签后的预防检查方案", tone: "warn", badge: { text: "待决定", tone: "warn" } },
                { id: "impact-stock", text: "本仓 20 台", sub: "QH-2026-0738 · QA-HOLD · 禁止出库", tone: "pass", state: "hit", badge: { text: "已隔离", tone: "pass" } },
              ] },
              { op: "focus", view: "quality" },
              { op: "toolbar", view: "quality", title: "质量与服务证据", sub: "硬证据已补齐 · 根因待质量签发" },
              { op: "rowsSet", view: "quality", rows: [
                { id: "q-sample", text: "仓内抽检 6 台 · 2 台不符合", sub: "锁扣保持力 17.8N / 18.1N，低于 18.5N", tone: "deny", badge: { text: "QMS 原始值", tone: "deny" } },
                { id: "q-field", text: "现场电压曲线处于允许范围", sub: "原“电压波动”说法不再作为当前依据", tone: "pass", badge: { text: "已补证", tone: "pass" } },
                { id: "q-owner", text: "批次不符合项 NCR-2026-0316", sub: "质量工程师已接管 · 根因调查中", tone: "pending", badge: { text: "未定责", tone: "info" } },
              ] },
              { op: "feedAppend", view: "audit", item: { id: "au-3", from: "AI 同事", time: "08-10 10:08", text: "隔离在库 20 台并回读 QA-HOLD；补齐抽检、序列号、日志与电压曲线" } },
              { op: "toolbar", view: "audit", title: "本次案件的系统动作", sub: "3 条" },
            ],
          },
        },
        {
          id: "qr3-text",
          kind: "text",
          title: "业务进展",
          defaultOpen: true,
          content: "能立即止住的部分已经止住：20 台在库品处于 QA-HOLD，系统已反查确认不能出库。抽检也拿到了 2 台不符合的原始值。接下来不是让一个领导笼统批“同意处理”，而是让质量、客服、财务、法务各自只决定本岗那一项。",
        },
      ],
    },

    {
      caption: "质量、客服、财务与法务做最窄联签",
      blocks: [],
      approval: {
        title: "客诉最小补救方案 · 四岗联签",
        description: "四个岗位分别只核定本岗事项。联签通过后才会发货、派工、入账和对外发送；责任认定与召回判断不在本次自动动作里。",
        facts: [
          { label: "质量", value: "保持批次 HOLD；4 台故障件换回；另一客户 32 台启用前逐台检查；下批加严验证" },
          { label: "客服", value: "08-11 上门更换；只承诺恢复与进度，不预设根因或责任" },
          { label: "财务", value: "因已确认的 SLA 超时，客户服务账户补入 ¥12,800 额度" },
          { label: "法务", value: "本次是临时补救，不构成损失责任或召回认定；若范围扩大另行升级" },
        ],
        approveLabel: "确认四岗联签并执行",
        rejectLabel: "退回重拟",
        approvedBlocks: [
          {
            id: "qr4-approved",
            kind: "tool_use",
            title: "Approval",
            defaultOpen: true,
            toolName: "Approval",
            toolId: "t-approve",
            content: JSON.stringify({ caseId: "CS-2026-0147", decision: "approved", approvals: ["quality", "service", "finance", "legal"] }),
            executionStatus: "completed",
            durationMs: 420,
            presentation: {
              title: "四岗联签已齐 · 每项批准绑定具体对象和动作",
              detail: [
                { verdict: "pass", text: "质量负责人", note: "批次 HOLD、4 台换回、32 台启用前检查、下批加严验证" },
                { verdict: "pass", text: "客服负责人", note: "08-11 上门更换与客户沟通口径" },
                { verdict: "pass", text: "财务负责人", note: "服务额度 ¥12,800，依据 SLA 超时事实" },
                { verdict: "pass", text: "法务负责人", note: "临时补救可执行；责任与召回仍为待定项" },
                { insight: "批准只覆盖这四项，不允许把“联签通过”扩张成自动定责或批次召回", label: "权限边界" },
              ],
              status: "ok",
              receipt: { id: "AP-2026-0517", system: "审批中心", readBack: true },
              panel: [
                { op: "focus", view: "remedy" },
                { op: "toolbar", view: "remedy", title: "补救执行 · AP-2026-0517", sub: "4 项已批准 · 等待执行" },
                { op: "rowsSet", view: "remedy", rows: [
                  { id: "r-replace", text: "4 台换货 + 08-11 上门更换", sub: "质量 / 客服已批", tone: "pass", badge: { text: "可执行", tone: "pass" } },
                  { id: "r-inspect", text: "另一客户 32 台启用前逐台检查", sub: "质量 / 法务已批", tone: "pass", badge: { text: "可执行", tone: "pass" } },
                  { id: "r-credit", text: "服务额度 ¥12,800", sub: "客服 / 财务已批", tone: "pass", badge: { text: "可入账", tone: "pass" } },
                  { id: "r-recall", text: "批次召回与责任认定", sub: "不在本次批准范围", tone: "pending", badge: { text: "未决定", tone: "info" } },
                ] },
                { op: "feedAppend", view: "audit", item: { id: "au-4", from: "审批中心", time: "08-10 11:36", text: "质量 / 客服 / 财务 / 法务四岗联签完成；责任与召回仍未判定" } },
                { op: "toolbar", view: "audit", title: "本次案件的系统动作", sub: "4 条" },
              ],
            },
          },
          {
            id: "qr4-approved-text",
            kind: "text",
            title: "联签结果",
            defaultOpen: true,
            content: "四个岗位各自的批准都齐了。我现在只执行四张批准单覆盖的动作：隔离维持、换货与上门、启用前检查、服务额度入账。责任认定和召回判断没有被偷塞进“同意处理”四个字里。",
          },
        ],
        rejectedBlocks: [
          {
            id: "qr4-rejected",
            kind: "tool_use",
            title: "Approval",
            defaultOpen: true,
            toolName: "Approval",
            toolId: "t-reject",
            content: JSON.stringify({ caseId: "CS-2026-0147", decision: "rejected" }),
            executionStatus: "completed",
            durationMs: 300,
            presentation: {
              title: "补救方案被退回 · 隔离保留，外部动作均未发生",
              detail: [
                { k: "换货与派工", v: "未创建" },
                { k: "服务额度", v: "未入账" },
                { k: "客户消息", v: "未发送" },
                { tree: "├", k: "批次隔离", v: "继续保持 QA-HOLD，防止风险扩散" },
                { tree: "└", k: "案件状态", v: "等待按退回意见重拟，再走四岗联签" },
              ],
              status: "blocked",
              panel: [
                { op: "focus", view: "remedy" },
                { op: "toolbar", view: "remedy", title: "补救执行", sub: "联签退回 · 零外部动作" },
                { op: "rowsSet", view: "remedy", rows: [
                  { id: "r-hold", text: "在库 20 台继续 QA-HOLD", sub: "临时隔离保留，不因退回而释放", tone: "warn", badge: { text: "仍隔离", tone: "warn" } },
                  { id: "r-none", text: "换货 / 派工 / 入账 / 对外消息", sub: "均未执行，等待重拟", tone: "pending", badge: { text: "已停住", tone: "info" } },
                ] },
                { op: "feedAppend", view: "audit", item: { id: "au-reject", from: "审批中心", time: "08-10 11:36", text: "补救方案退回：零外部动作；QA-HOLD 保留；等待重拟" } },
                { op: "toolbar", view: "audit", title: "本次案件的系统动作", sub: "4 条" },
              ],
            },
          },
          {
            id: "qr4-rejected-text",
            kind: "text",
            title: "退回说明",
            defaultOpen: true,
            content: "已经停在执行前：没发货、没派工、没入账、没给任何客户发消息。20 台在库品仍保持 QA-HOLD，不会因为方案退回重新流出去。按退回意见改完后，我会重新走四岗联签。",
          },
        ],
      },
    },

    {
      caption: "把批准的补救真正写入各权威系统",
      blocks: [
        {
          id: "qr5-tool",
          kind: "tool_use",
          title: "RemedyExecute",
          defaultOpen: true,
          toolName: "RemedyExecute",
          toolId: "t-remedy",
          content: JSON.stringify({ caseId: "CS-2026-0147", approval: "AP-2026-0517", idempotencyKey: "CS-2026-0147-R1" }),
          executionStatus: "completed",
          durationMs: 2480,
          presentation: {
            title: "换货、派工、客户沟通和服务补救已按批准范围执行",
            detail: [
              { verdict: "pass", text: "OMS / WMS", note: "4 台已检替换件出库，RMA-2026-381 建立；故障件回收标签已生成" },
              { verdict: "pass", text: "CMMS", note: "现场工单 FS-2026-0811-06 · 08-11 09:00 到场" },
              { verdict: "pass", text: "客户门户", note: "恢复计划已送达并已读；另一客户同意启用前逐台检查" },
              { verdict: "pass", text: "支付 / 财务", note: "服务额度 CR-2026-0946 · ¥12,800 · POSTED" },
              { tree: "└", k: "幂等核对", v: "同一案件、同一批准、同一动作键，无重复发货或重复入账" },
              { insight: "“已提交”不是完成；案件进入等待签收、维修、入账与客户确认状态", label: "当前状态" },
            ],
            status: "waiting",
            receipt: { id: "EXEC-CS-2026-0147-R1", system: "补救协调层", readBack: true },
            panel: [
              { op: "focus", view: "remedy" },
              { op: "toolbar", view: "remedy", title: "补救执行 · CS-2026-0147", sub: "4 类动作已发起 · 等待客观回执" },
              { op: "rowsSet", view: "remedy", rows: [
                { id: "r-replace", text: "RMA-2026-381 · 4 台替换件", sub: "已出库 · 物流在途 · 等待签收", tone: "pending", badge: { text: "在途", tone: "info" } },
                { id: "r-service", text: "FS-2026-0811-06 · 上门更换", sub: "工程师已接单 · 08-11 09:00", tone: "pending", badge: { text: "已派工", tone: "info" } },
                { id: "r-inspect", text: "另一客户 32 台启用前检查", sub: "客户已读并接受 · 08-12 开始", tone: "pending", badge: { text: "待执行", tone: "info" } },
                { id: "r-credit", text: "CR-2026-0946 · ¥12,800", sub: "客户服务账户已入账", tone: "pass", badge: { text: "POSTED", tone: "pass" } },
              ] },
              { op: "focus", view: "customer" },
              { op: "toolbar", view: "customer", title: "客户沟通", sub: "2 家已送达 · 0 条责任结论" },
              { op: "feedAppend", view: "customer", item: { id: "cu-plan", from: "客服负责人", time: "08-10 12:04", text: "补救计划已发给澜星自动化（演示客户）", card: { title: "恢复计划", body: "4 台换货已发出；08-11 09:00 上门；服务额度 ¥12,800 已入账。根因调查与责任认定另行通知。", meta: [{ text: "已送达", tone: "pass" }, { text: "已读", tone: "info" }] } } },
              { op: "feedAppend", view: "audit", item: { id: "au-5", from: "AI 同事", time: "08-10 12:05", text: "按 AP-2026-0517 执行换货、派工、检查、入账与客户沟通，并逐项回读" } },
              { op: "toolbar", view: "audit", title: "本次案件的系统动作", sub: "5 条" },
            ],
          },
        },
        {
          id: "qr5-result",
          kind: "tool_result",
          title: "RemedyExecute 结果",
          defaultOpen: false,
          toolName: "RemedyExecute",
          toolId: "t-remedy",
          content: "rma=RMA-2026-381 field_service=FS-2026-0811-06 credit=CR-2026-0946 status=WAITING_FOR_RECOVERY",
        },
        {
          id: "qr5-text",
          kind: "text",
          title: "业务进展",
          defaultOpen: true,
          content: "批准的动作都已经进入权威系统，但我现在不会说“客诉已解决”。替换件还要签收，工程师还要完成更换，生产还要恢复，客户也要确认。案件已经转入持久等待；任何一项失败都会从原案件继续，不会另起一张失去上下文的新工单。",
        },
      ],
    },

    {
      caption: "验证补救兑现，并用下一批和观察窗防复发",
      blocks: [
        {
          id: "qr6-tool",
          kind: "tool_use",
          title: "RemedyVerify",
          defaultOpen: true,
          toolName: "RemedyVerify",
          toolId: "t-verify",
          content: JSON.stringify({ caseId: "CS-2026-0147", verify: ["签收", "维修", "入账", "客户确认", "下批验证", "观察窗"] }),
          executionStatus: "completed",
          durationMs: 1960,
          presentation: {
            title: "两周后恢复案件，独立回读补救与防复发证据",
            detail: [
              { verdict: "pass", text: "澜星自动化 4 台", note: "替换签收、上门更换完成，连续运行 72 小时无停机" },
              { verdict: "pass", text: "另一客户 32 台", note: "启用前检查发现 3 台保持力不足，已预防更换；投用后无停机" },
              { verdict: "pass", text: "服务额度", note: "¥12,800 已入客户账户，客户确认金额无误" },
              { verdict: "pass", text: "下批 B20260818", note: "锁扣保持力 30/30 通过，首批 200 件检验通过" },
              { verdict: "pass", text: "14 天观察窗", note: "40 台已投用设备无 E-17 同症状复发" },
              { tree: "└", k: "复开条件", v: "同批次、同故障码或客户否认恢复，会自动重开 CS-2026-0147" },
              { insight: "补救兑现、客户确认和防复发验证都已成立，才允许进入已验证解决", label: "成功谓词" },
            ],
            status: "ok",
            receipt: { id: "ACK-2026-2218", system: "客户门户 / QMS / CMMS", readBack: true },
            panel: [
              { op: "focus", view: "remedy" },
              { op: "toolbar", view: "remedy", title: "补救执行 · 独立回读", sub: "钱、货、服务均已兑现" },
              { op: "rowsSet", view: "remedy", rows: [
                { id: "r-replace", text: "RMA-2026-381 · 4 台替换", sub: "已签收 · 已安装 · 故障件已回收", tone: "pass", state: "hit", badge: { text: "完成", tone: "pass" } },
                { id: "r-service", text: "FS-2026-0811-06 · 上门更换", sub: "连续运行 72 小时无停机", tone: "pass", badge: { text: "已验证", tone: "pass" } },
                { id: "r-inspect", text: "另一客户 32 台启用前检查", sub: "3 台预防更换 · 投用后无停机", tone: "pass", badge: { text: "完成", tone: "pass" } },
                { id: "r-credit", text: "CR-2026-0946 · ¥12,800", sub: "客户账户已入账并确认", tone: "pass", badge: { text: "SETTLED", tone: "pass" } },
              ] },
              { op: "focus", view: "quality" },
              { op: "toolbar", view: "quality", title: "质量与服务证据", sub: "下批验证通过 · 观察窗通过" },
              { op: "rowsSet", view: "quality", rows: [
                { id: "q-root", text: "质量负责人签发根因：锁扣成型参数漂移", sub: "NCR-2026-0316 · 人工签发，不由 Agent 判定", tone: "pass", badge: { text: "已签发", tone: "pass" } },
                { id: "q-next", text: "B20260818 加严验证", sub: "30/30 保持力通过 · 首批 200 件通过", tone: "pass", badge: { text: "有效", tone: "pass" } },
                { id: "q-observe", text: "14 天观察窗", sub: "40 台在用设备无 E-17 复发", tone: "pass", badge: { text: "通过", tone: "pass" } },
              ] },
              { op: "focus", view: "customer" },
              { op: "toolbar", view: "customer", title: "客户确认", sub: "恢复、金额与观察结果均已确认" },
              { op: "feedAppend", view: "customer", item: { id: "cu-ack", from: "澜星自动化（演示客户）", time: "08-24 10:16", text: "4 台更换后产线运行正常，服务额度已看到，可以按此结果结案。", card: { title: "客户确认 ACK-2026-2218", body: "生产已恢复 · 金额无误 · 同意进入已验证解决", meta: [{ text: "已确认", tone: "pass" }, { text: "可复开", tone: "info" }] } } },
              { op: "feedAppend", view: "audit", item: { id: "au-6", from: "AI 同事", time: "08-24 10:18", text: "独立回读补救、客户确认、下批检验与 14 天观察窗；成功谓词全部成立" } },
              { op: "toolbar", view: "audit", title: "本次案件的系统动作", sub: "6 条" },
            ],
          },
        },
        {
          id: "qr6-text",
          kind: "text",
          title: "补救与验证回执",
          defaultOpen: true,
          content: [
            "现在才具备结案条件：补救真的发生了，客户确认恢复了，下一个批次也证明改动有效。下面这份是客户可核对的执行与验证回执，不是 8D 文档：",
            "",
            `[FILE]{"filePath":"${REMEDY_RECEIPT_PATH}","fileName":"客诉补救与验证回执.html","fileSize":${REMEDY_RECEIPT_SIZE_BYTES}}[/FILE]`,
            "",
            "如果观察窗内再出现同批次、同故障码，或者客户否认恢复，系统会重开原案件并带回全部上下文，不会新建一张互不相干的工单。",
          ].join("\n"),
        },
      ],
    },

    {
      caption: "跨系统核对终态",
      blocks: [
        {
          id: "qr7-tool",
          kind: "tool_use",
          title: "ReadBack",
          defaultOpen: true,
          toolName: "ReadBack",
          toolId: "t-readback",
          content: JSON.stringify({ caseId: "CS-2026-0147", bypassSessionCache: true }),
          executionStatus: "completed",
          durationMs: 1120,
          presentation: {
            title: "按业务对象逐源反查，不采信“步骤已执行”的自述",
            detail: [
              { verdict: "pass", text: "CRM / 客服案件", note: "CS-2026-0147 · RESOLVED_VERIFIED · 可按原关联键重开" },
              { verdict: "pass", text: "QMS / WMS", note: "B20260728 停止流转；下批 B20260818 验证通过" },
              { verdict: "pass", text: "OMS / CMMS", note: "4 台换回签收、现场更换与 72 小时验证完成" },
              { verdict: "pass", text: "支付 / 财务", note: "CR-2026-0946 · ¥12,800 · SETTLED" },
              { verdict: "pass", text: "客户门户", note: "ACK-2026-2218 · 恢复、金额和结案均已确认" },
              { insight: "五方一致，无未决补救；责任与召回没有被伪装成已判定", label: "终态" },
            ],
            status: "ok",
            panel: [
              { op: "focus", view: "case" },
              { op: "toolbar", view: "case", title: "客诉案件 · 终态回读", sub: "五方一致 · 已验证解决" },
              { op: "tableRowUpdate", view: "case", id: "case-order", set: { cells: { state: "权益兑现" }, tone: "pass" } },
              { op: "cellFlag", view: "case", rowId: "case-order", colKey: "state", tone: "pass", flag: "完成" },
              { op: "tableRowUpdate", view: "case", id: "case-assets", set: { cells: { fact: "4 台换回 · 72 小时无停机", state: "已恢复" }, tone: "pass" } },
              { op: "cellFlag", view: "case", rowId: "case-assets", colKey: "state", tone: "pass", flag: "已验证" },
              { op: "tableRowUpdate", view: "case", id: "case-batch", set: { cells: { fact: "旧批停止流转 · 下批验证通过", state: "有效" }, tone: "pass" } },
              { op: "cellFlag", view: "case", rowId: "case-batch", colKey: "state", tone: "pass", flag: "防复发" },
              { op: "tableRowUpdate", view: "case", id: "case-remedy", set: { cells: { fact: "钱、货、服务、客户确认一致", state: "已兑现" }, tone: "pass" } },
              { op: "cellFlag", view: "case", rowId: "case-remedy", colKey: "state", tone: "pass", flag: "完成" },
              { op: "feedAppend", view: "audit", item: { id: "au-7", from: "AI 同事", time: "08-24 10:19", text: "绕过会话缓存，回读 CRM / QMS / WMS / OMS / CMMS / 支付 / 客户门户，终态一致" } },
              { op: "toolbar", view: "audit", title: "本次案件的系统动作", sub: "7 条" },
            ],
          },
        },
        {
          id: "qr7-text",
          kind: "text",
          title: "本次案件终态",
          defaultOpen: true,
          content: [
            "## 跨系统终态核对",
            "",
            "| 权威系统 | 最终状态 | 独立证据 |",
            "| --- | --- | --- |",
            "| CRM / 客服案件 | `RESOLVED_VERIFIED`，保留关联键与复开规则 | CS-2026-0147 回读 |",
            "| QMS / WMS | 旧批 B20260728 停止流转；下批 B20260818 验证通过 | NCR-2026-0316 / QH-2026-0738 |",
            "| OMS / CMMS | 4 台换回、签收、安装，连续运行 72 小时 | RMA-2026-381 / FS-2026-0811-06 |",
            "| 支付 / 财务 | 服务额度 ¥12,800 已入账并确认 | CR-2026-0946 · `SETTLED` |",
            "| 客户门户 | 恢复、金额和结案均已确认 | ACK-2026-2218 |",
            "| 观察窗口 | 14 天内 40 台在用设备无 E-17 复发 | 遥测与工单反查 |",
            "",
            "## 本次案件没有做什么",
            "",
            "- 没有把 8D 文档写完当成结案：文件不等于换货签收、入账、恢复和客户确认；",
            "- 没有自动定责：质量根因由质量负责人签发，服务补救只依据已确认的 SLA 超时事实；",
            "- 没有自动判定召回：影响范围与证据已提交法务和质量，召回仍按适用规则另行决定；",
            "- 没有用“接口请求成功”冒充完成：每个动作都从原系统重新读取，钱、货、服务和客户确认缺一不可；",
            "- 没有把复发切成新工单：同批次、同故障码或客户否认恢复，会重开原案件并继承完整证据链。",
          ].join("\n"),
        },
      ],
    },
  ],

  // 治理条款：state != exists 的条目就是「演示到真实」的距离
  sources: [
    {
      blockRef: "step1.tool.EnterpriseContextRead",
      producer: "租户业务系统连接器（CRM / 合同 / QMS / CMMS / OMS / WMS / 支付）",
      state: "missing",
      gap: "当前没有跨七类系统按案件关联键聚合企业上下文的通用连接器；真实落地需要客户系统 API、对象映射与权限模型",
    },
    {
      blockRef: "step2.tool.IssueScopeAnalysis",
      producer: "Agent 分析（会话内推理）",
      state: "exists",
    },
    {
      blockRef: "step3.tool.ContainmentAndEvidence",
      producer: "QMS / WMS 隔离与证据请求执行器",
      state: "missing",
      gap: "产品尚无可配置的质量隔离规则、批次 HOLD 写入、现场证据请求与动作后回读契约",
    },
    {
      blockRef: "step4.tool.Approval.approved",
      producer: "跨岗位业务审批执行器",
      state: "needs-change",
      gap: "HITL 审批事件已存在，但还不能把质量、客服、财务、法务四个岗位的批准分别绑定到对象版本、动作摘要与权限范围",
    },
    {
      blockRef: "step4.tool.Approval.rejected",
      producer: "跨岗位业务审批执行器",
      state: "needs-change",
      gap: "退回事件已有基础形态，但尚缺“保留临时隔离、撤销未执行动作、按意见重拟后重新联签”的结构化恢复状态",
    },
    {
      blockRef: "step5.tool.RemedyExecute",
      producer: "补救协调层 + OMS / WMS / CMMS / 支付 / 客户消息连接器",
      state: "missing",
      gap: "跨系统幂等执行、部分成功补偿、持久等待和钱货服务回执目前没有统一业务协调层",
    },
    {
      blockRef: "step6.tool.RemedyVerify",
      producer: "案件恢复器 + QMS 有效性验证 + 客户确认",
      state: "missing",
      gap: "尚无跨天恢复后自动重读权威系统、计算恢复谓词、挂载观察窗和按同一关联键复开的产品能力",
    },
    {
      blockRef: "step7.tool.ReadBack",
      producer: "跨系统业务终态回读器",
      state: "missing",
      gap: "终态核对依赖各系统连接器先具备按对象 ID 独立回读的能力；当前只能由 Agent 临时整理",
    },
    {
      blockRef: "step6.artifact.客诉补救与验证回执",
      producer: "Agent 生成 HTML 产物",
      state: "exists",
    },
  ],
};

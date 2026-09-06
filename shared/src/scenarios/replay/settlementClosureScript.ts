import type { SystemPanelSnapshot } from "../../lib/systemPanel";
import type { ReplayScript } from "./types";

/**
 * D5：多方结算与关账。
 *
 * 标准订单、退款、费率和已绑定履约凭据由确定性规则匹配；Agent 只接管跨期、
 * 未知费用、主体错配、部分验收和争议。任何对外争议、会计期间调整与付款动作
 * 都经过职责分离审批，终态以平台、银行和 ERP 的独立回读为准。
 *
 * 内容为示例数据，不对应任何真实企业、平台、订单或银行账户。
 */

const EVIDENCE_PATH = "assets/demo/多方结算关账证据包.html";

const EVIDENCE_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<style>
  :root { --brand:#2E56E1; --ink:#0f172a; --muted:#64748b; --line:#e2e8f0; --ok:#15803d; --warn:#b45309; --bad:#b91c1c; }
  * { box-sizing:border-box; }
  body { margin:0; padding:22px; color:var(--ink); background:#fff; font:14px/1.65 "PingFang SC","Microsoft YaHei",system-ui,sans-serif; }
  .bar { margin-bottom:16px; padding:7px 10px; border:1px solid var(--line); border-radius:7px; background:#f8fafc; color:var(--muted); font-size:12px; }
  h1 { margin:0 0 4px; font-size:18px; }
  .sub { margin:0 0 16px; color:var(--muted); font-size:12px; }
  .stats { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; margin-bottom:16px; }
  .stat { padding:10px; border:1px solid var(--line); border-radius:8px; }
  .stat b { display:block; font-size:18px; }
  .stat span { color:var(--muted); font-size:12px; }
  table { width:100%; margin-bottom:16px; border-collapse:collapse; font-size:13px; }
  th,td { padding:8px 10px; border:1px solid var(--line); text-align:left; vertical-align:top; }
  th { background:#f8fafc; color:var(--muted); font-weight:500; }
  .ok { color:var(--ok); font-weight:600; }
  .warn { color:var(--warn); font-weight:600; }
  .bad { color:var(--bad); font-weight:600; }
  .box { margin-bottom:12px; padding:12px; border:1px solid var(--line); border-radius:8px; }
  .box h2 { margin:0 0 8px; font-size:14px; }
  .box ul { margin:0; padding-left:18px; }
  .foot { color:var(--muted); font-size:12px; }
</style></head><body>
<div class="bar">结算批次 SET-2026-07-018 · 演示数据 · 证据冻结时间 2026-08-04 16:32</div>
<h1>曜石家居用品有限公司 · 7 月多方结算证据包</h1>
<p class="sub">星河电商平台 × 云桥银行 × 星云 ERP · 币种 CNY</p>
<div class="stats">
  <div class="stat"><b>¥1,237,800.00</b><span>退款后订单净额</span></div>
  <div class="stat"><b>¥1,181,946.00</b><span>合同口径应结总额</span></div>
  <div class="stat"><b class="bad">¥26,480.80</b><span>银行入账差额</span></div>
  <div class="stat"><b class="warn">5</b><span>需判断的异常类型</span></div>
</div>
<table>
  <tr><th>异常</th><th>金额</th><th>绑定证据</th><th>建议处置</th></tr>
  <tr><td>跨期订单</td><td>¥8,380.80</td><td>订单 OR-77821 · 8 月结算规则</td><td class="warn">转次月在途，不发争议</td></tr>
  <tr><td>未知增长服务费</td><td>¥6,200.00</td><td>合同价卡无对应条款</td><td class="bad">正式争议</td></tr>
  <tr><td>费用主体错配</td><td>¥4,800.00</td><td>账单主体与合同主体不一致</td><td class="bad">争议 + 贷项通知</td></tr>
  <tr><td>部分验收留款</td><td>¥7,100.00</td><td>POD 仅覆盖 60%</td><td class="warn">等完整验收后释放</td></tr>
  <tr><td>上期争议已认未付</td><td>¥2,400.00</td><td>平台贷项 CN-2026-0617</td><td class="warn">追银行实收回执</td></tr>
</table>
<div class="box">
  <h2>拟执行单据</h2>
  <ul>
    <li>争议单 DR-2026-0731-018：¥11,000.00，覆盖未知费用与主体错配；</li>
    <li>贷项通知申请 CR-REQ-2026-0731-006：¥4,800.00；</li>
    <li>平台佣金发票 INV-PF-2026-0731：¥36,874.80，价卡匹配；</li>
    <li>物流发票 INV-LG-2026-0731：¥18,720.00，已在平台净额扣除；</li>
    <li>付款草案 PAY-2026-0804-092：¥18,720.00，因可能重复付款保持 HOLD。</li>
  </ul>
</div>
<p class="foot">示例内容，不对应任何真实企业、平台、订单或银行账户。审批前不发送争议、不改账、不付款。</p>
</body></html>`;

const EVIDENCE_SIZE = new TextEncoder().encode(EVIDENCE_HTML).length;

const PANEL_BASE: SystemPanelSnapshot = {
  title: "企业系统实况",
  live: true,
  activeView: "ledger",
  foot: "已连接：合同价卡 · 订单/POD · 平台账单 · 银行 · ERP/AR/AP（演示）",
  views: [
    {
      key: "ledger",
      label: "结算核对",
      winTitle: "多方结算台账 · 2026 年 7 月",
      toolbar: { title: "结算批次 SET-2026-07-018", sub: "尚未读取" },
      widget: {
        kind: "table",
        cols: [
          { key: "source", label: "权威来源" },
          { key: "amount", label: "金额" },
          { key: "state", label: "核对", align: "right" },
        ],
        rows: [],
        empty: { title: "尚未读取结算上下文" },
      },
    },
    {
      key: "exceptions",
      label: "异常队列",
      winTitle: "结算异常 · 需判断事项",
      toolbar: { title: "异常队列", sub: "0 项" },
      widget: {
        kind: "table",
        cols: [
          { key: "issue", label: "异常" },
          { key: "amount", label: "金额" },
          { key: "owner", label: "责任方" },
          { key: "state", label: "状态", align: "right" },
        ],
        rows: [],
        empty: { title: "确定性匹配后才进入异常队列" },
      },
    },
    {
      key: "documents",
      label: "结算单据",
      winTitle: "争议、贷项、发票与付款草案",
      toolbar: { title: "结算单据", sub: "尚未生成" },
      widget: {
        kind: "table",
        cols: [
          { key: "doc", label: "单据" },
          { key: "amount", label: "金额" },
          { key: "state", label: "状态", align: "right" },
        ],
        rows: [],
        empty: { title: "没有待处理单据" },
      },
    },
    {
      key: "receipts",
      label: "权威回执",
      winTitle: "平台与银行回执",
      toolbar: { title: "外部回执", sub: "0 项确认" },
      widget: {
        kind: "table",
        cols: [
          { key: "receipt", label: "回执" },
          { key: "source", label: "来源" },
          { key: "amount", label: "金额" },
          { key: "state", label: "状态", align: "right" },
        ],
        rows: [],
        empty: { title: "尚未收到外部回执" },
      },
    },
    {
      key: "audit",
      label: "操作留痕",
      winTitle: "本次结算处理留痕",
      toolbar: { title: "系统动作", sub: "0 条" },
      widget: { kind: "feed", items: [], empty: { title: "尚无系统动作" } },
    },
  ],
};

export const settlementClosureScript: ReplayScript = {
  scenarioId: "catalog-settlement-reconciliation-to-cash-loop",
  title: "多方结算追到关账",
  mode: "hero",
  artifacts: { [EVIDENCE_PATH]: EVIDENCE_HTML },

  steps: [
    {
      caption: "一句话拉齐六类企业上下文",
      blocks: [
        {
          id: "s1-prompt",
          kind: "prompt",
          title: "用户消息",
          defaultOpen: true,
          content: "平台、银行和 ERP 为什么对不上？把异常追到关账。",
        },
        {
          id: "s1-tool",
          kind: "tool_use",
          title: "SettlementContextRead",
          defaultOpen: true,
          toolName: "SettlementContextRead",
          toolId: "t-context",
          content: JSON.stringify({ entity: "曜石家居用品有限公司", period: "2026-07", batch: "SET-2026-07-018" }),
          executionStatus: "completed",
          durationMs: 1480,
          presentation: {
            title: "自动读取合同、履约、账单、银行与 ERP",
            detail: [
              { k: "合同与价卡", v: "平台佣金 3% · 物流费按已绑定 POD 结算" },
              { k: "订单与退款", v: "订单总额 ¥1,284,600.00 · 退款 ¥46,800.00" },
              { k: "平台账单", v: "应付 ¥1,157,865.20 · 含上期贷项 ¥2,400.00" },
              { k: "银行实收", v: "¥1,155,465.20 · 比平台应付少 ¥2,400.00" },
              { tree: "├", k: "ERP/AR", v: "合同口径应结 ¥1,181,946.00" },
              { tree: "└", k: "ERP/AP", v: "存在物流付款草案 ¥18,720.00" },
              { insight: "银行比 ERP 少 ¥26,480.80；先按权威证据逐笔对齐，不要求用户上传 Excel", label: "当前差额" },
            ],
            status: "ok",
            panelBase: PANEL_BASE,
            panel: [
              { op: "focus", view: "ledger" },
              { op: "toolbar", view: "ledger", title: "结算批次 SET-2026-07-018", sub: "6 类权威来源已读取" },
              { op: "tableRowInsert", view: "ledger", row: { id: "l-contract", cells: { source: "合同价卡 + 订单/退款/POD", amount: "¥1,181,946.00", state: "应结口径" } } },
              { op: "tableRowInsert", view: "ledger", row: { id: "l-platform", cells: { source: "星河平台账单", amount: "¥1,157,865.20", state: "差 ¥24,080.80" }, tone: "warn" } },
              { op: "tableRowInsert", view: "ledger", row: { id: "l-bank", cells: { source: "云桥银行实收", amount: "¥1,155,465.20", state: "差 ¥26,480.80" }, tone: "warn" } },
              { op: "tableRowInsert", view: "ledger", row: { id: "l-erp", cells: { source: "星云 ERP/AR/AP", amount: "¥1,181,946.00", state: "待清分" } } },
              { op: "feedAppend", view: "audit", item: { id: "a1", from: "AI 同事", time: "14:03:12", text: "只读拉取合同价卡、订单/退款/POD、平台账单、银行流水和 ERP/AR/AP" } },
              { op: "toolbar", view: "audit", title: "系统动作", sub: "1 条 · 全部只读" },
            ],
          },
        },
        {
          id: "s1-text",
          kind: "text",
          title: "业务进展",
          defaultOpen: true,
          content: "六类上下文已自动拉齐。银行实收比 ERP 合同口径少 ¥26,480.80；平台账单又比银行多 ¥2,400.00。接下来先让确定性规则消化标准项，只把需要业务判断的例外交给 Agent。",
        },
      ],
    },

    {
      caption: "标准项确定性匹配，只留下例外",
      blocks: [
        {
          id: "s2-tool",
          kind: "tool_use",
          title: "DeterministicReconcile",
          defaultOpen: true,
          toolName: "DeterministicReconcile",
          toolId: "t-match",
          content: JSON.stringify({ batch: "SET-2026-07-018", ruleVersion: "PRICECARD-2026.03", tolerance: 0.01 }),
          executionStatus: "completed",
          durationMs: 2100,
          presentation: {
            title: "标准订单、退款、费率与凭据已按规则匹配",
            detail: [
              { verdict: "pass", text: "订单与退款", note: "124 笔标准订单 + 3 笔标准退款逐笔匹配" },
              { verdict: "pass", text: "平台佣金", note: "¥36,874.80 = 当期平台基数 × 3%" },
              { verdict: "pass", text: "物流费用", note: "¥18,720.00 与合同价卡、POD 和发票一致" },
              { verdict: "fail", text: "例外队列", note: "跨期、未知费用、主体错配、部分验收、上期争议 5 类" },
              { insight: "标准项不让模型自由发挥；Agent 只解释规则无法直接裁定的例外", label: "分工" },
            ],
            status: "warn",
            panel: [
              { op: "focus", view: "exceptions" },
              { op: "toolbar", view: "exceptions", title: "异常队列 · SET-2026-07-018", sub: "5 类 · 人民币" },
              { op: "tableRowInsert", view: "exceptions", row: { id: "ex-cross", cells: { issue: "跨期订单", amount: "¥8,380.80", owner: "财务", state: "待定期间" } } },
              { op: "tableRowInsert", view: "exceptions", row: { id: "ex-unknown", cells: { issue: "未知增长服务费", amount: "¥6,200.00", owner: "平台", state: "无合同依据" }, tone: "warn" } },
              { op: "tableRowInsert", view: "exceptions", row: { id: "ex-entity", cells: { issue: "费用主体错配", amount: "¥4,800.00", owner: "平台", state: "主体不符" }, tone: "warn" } },
              { op: "tableRowInsert", view: "exceptions", row: { id: "ex-partial", cells: { issue: "部分验收留款", amount: "¥7,100.00", owner: "业务", state: "POD 60%" } } },
              { op: "tableRowInsert", view: "exceptions", row: { id: "ex-old", cells: { issue: "上期争议已认未付", amount: "¥2,400.00", owner: "平台/银行", state: "缺实收" }, tone: "warn" } },
              { op: "pulse", view: "exceptions", ids: ["ex-cross", "ex-unknown", "ex-entity", "ex-partial", "ex-old"], kind: "scan" },
              { op: "feedAppend", view: "audit", item: { id: "a2", from: "确定性核对器", time: "14:03:14", text: "规则匹配标准订单、退款、佣金与物流费；5 类例外转入判断队列" } },
              { op: "toolbar", view: "audit", title: "系统动作", sub: "2 条 · 尚无写入" },
            ],
          },
        },
        {
          id: "s2-text",
          kind: "text",
          title: "业务判断",
          defaultOpen: true,
          content: "大部分流水已经按价卡和业务键自动对平。真正需要处理的是 5 类例外：跨期要改期间，未知费用要找合同依据，主体错配要退回正确主体，部分验收要等完整 POD，上期争议则必须追到银行实收。",
        },
      ],
    },

    {
      caption: "形成证据包与待审单据",
      blocks: [
        {
          id: "s3-tool",
          kind: "tool_use",
          title: "SettlementExceptionReview",
          defaultOpen: true,
          toolName: "SettlementExceptionReview",
          toolId: "t-review",
          content: JSON.stringify({ batch: "SET-2026-07-018", requireEvidenceBinding: true, createDraftsOnly: true }),
          executionStatus: "completed",
          durationMs: 1860,
          presentation: {
            title: "例外已绑定证据，生成草案但未对外发送",
            detail: [
              { k: "跨期", v: "¥8,380.80 · 转 8 月结算在途，不发争议" },
              { k: "正式争议草案", v: "¥11,000.00 · 未知费用 ¥6,200.00 + 主体错配 ¥4,800.00" },
              { k: "贷项通知申请", v: "¥4,800.00 · 要求回到正确合同主体" },
              { k: "部分验收", v: "¥7,100.00 · 完整 POD 到账前继续 HOLD" },
              { tree: "├", k: "发票", v: "佣金 ¥36,874.80 + 物流 ¥18,720.00 · 均已匹配" },
              { tree: "└", k: "付款草案", v: "物流 ¥18,720.00 · 平台已净额扣除，疑似重复付款" },
              { insight: "需业务负责人确认验收事实，财务负责人再批准争议、期间调整与付款拦截", label: "职责分离" },
            ],
            status: "waiting",
            panel: [
              { op: "focus", view: "documents" },
              { op: "toolbar", view: "documents", title: "结算单据 · 草案", sub: "审批前不可外发、记账或付款" },
              { op: "tableRowInsert", view: "documents", row: { id: "doc-dispute", cells: { doc: "争议单 DR-2026-0731-018", amount: "¥11,000.00", state: "待审批" }, tone: "warn" } },
              { op: "tableRowInsert", view: "documents", row: { id: "doc-credit", cells: { doc: "贷项申请 CR-REQ-2026-0731-006", amount: "¥4,800.00", state: "待审批" }, tone: "warn" } },
              { op: "tableRowInsert", view: "documents", row: { id: "doc-invoice1", cells: { doc: "佣金发票 INV-PF-2026-0731", amount: "¥36,874.80", state: "匹配" } } },
              { op: "tableRowInsert", view: "documents", row: { id: "doc-invoice2", cells: { doc: "物流发票 INV-LG-2026-0731", amount: "¥18,720.00", state: "匹配" } } },
              { op: "tableRowInsert", view: "documents", row: { id: "doc-payment", cells: { doc: "付款草案 PAY-2026-0804-092", amount: "¥18,720.00", state: "疑似重复 · HOLD" }, tone: "warn" } },
              { op: "feedAppend", view: "audit", item: { id: "a3", from: "AI 同事", time: "14:04:02", text: "生成证据包、争议/贷项/发票/付款草案；所有外部和账务动作停在审批前" } },
              { op: "toolbar", view: "audit", title: "系统动作", sub: "3 条 · 草案态" },
            ],
          },
        },
        {
          id: "s3-text",
          kind: "text",
          title: "待审材料",
          defaultOpen: true,
          content: [
            "证据和单据已经按异常对象冻结，财务不用再手工拼截图。下面这份材料能直接交给业务负责人和财务负责人核定：",
            "",
            `[FILE]{"filePath":"${EVIDENCE_PATH}","fileName":"多方结算关账证据包.html","fileSize":${EVIDENCE_SIZE}}[/FILE]`,
            "",
            "现在仍是草案：没有向平台发争议，没有改 ERP 期间，也没有执行付款。",
          ].join("\n"),
        },
      ],
    },

    {
      caption: "业务与财务职责分离审批",
      blocks: [],
      approval: {
        title: "结算处置核定 · 业务事实与财务动作分离",
        description: "业务负责人先确认 POD 与费用归属；财务负责人再决定争议金额、会计期间、发票入账和重复付款拦截。AI 不得自批对外或资金动作。",
        facts: [
          { label: "业务确认", value: "部分验收 60% 属实；完整 POD 正在补签" },
          { label: "对外争议", value: "¥11,000.00 · 未知费用 + 主体错配" },
          { label: "期间处理", value: "¥8,380.80 转入 8 月结算在途" },
          { label: "资金门禁", value: "物流付款草案 ¥18,720.00 保持 HOLD，防止重复付款" },
        ],
        approveLabel: "财务批准并执行处置",
        rejectLabel: "退回补证，不执行",
        approvedBlocks: [
          {
            id: "s4-approved-tool",
            kind: "tool_use",
            title: "SeparationOfDutiesApproval",
            defaultOpen: true,
            toolName: "SeparationOfDutiesApproval",
            toolId: "t-approval",
            content: JSON.stringify({ batch: "SET-2026-07-018", businessApproval: "BIZ-2026-0804-041", financeApproval: "FIN-2026-0804-126" }),
            executionStatus: "completed",
            durationMs: 410,
            presentation: {
              title: "两岗审批链已完成，执行范围被锁定",
              detail: [
                { k: "业务负责人", v: "BIZ-2026-0804-041 · 验收事实与费用归属" },
                { k: "财务负责人", v: "FIN-2026-0804-126 · 争议、期间、入账与付款门禁" },
                { tree: "├", k: "允许", v: "发争议、请求贷项、转跨期、登记发票、拦截重复付款" },
                { tree: "└", k: "不允许", v: "AI 自批、扩大争议金额、释放真实付款" },
              ],
              status: "ok",
              receipt: { id: "FIN-2026-0804-126", system: "审批中心", readBack: true },
              panel: [
                { op: "focus", view: "documents" },
                { op: "toolbar", view: "documents", title: "结算单据 · 已批准范围", sub: "两岗审批完成 · 待执行" },
                { op: "feedAppend", view: "audit", item: { id: "a4", from: "审批中心", time: "14:12:26", text: "业务与财务两岗分别核定；执行范围锁定为 FIN-2026-0804-126" } },
                { op: "toolbar", view: "audit", title: "系统动作", sub: "4 条 · 两岗已核定" },
              ],
            },
          },
        ],
        rejectedBlocks: [
          {
            id: "s4-rejected-tool",
            kind: "tool_use",
            title: "SettlementApprovalRejected",
            defaultOpen: true,
            toolName: "SettlementApprovalRejected",
            toolId: "t-rejected",
            content: JSON.stringify({ batch: "SET-2026-07-018", decision: "return_for_evidence" }),
            executionStatus: "completed",
            durationMs: 260,
            presentation: {
              title: "审批已退回，所有动作保持草案或 HOLD",
              detail: [
                { k: "平台争议", v: "未发送" },
                { k: "ERP 调整", v: "未写入" },
                { k: "发票与贷项", v: "未入账、未申请" },
                { tree: "├", k: "付款草案", v: "仍为 HOLD，未付款" },
                { tree: "└", k: "重新提交", v: "补齐退回原因对应的证据后重新核定" },
              ],
              status: "blocked",
              panel: [
                { op: "focus", view: "documents" },
                { op: "toolbar", view: "documents", title: "结算单据 · 审批退回", sub: "没有执行任何对外、账务或资金动作" },
                { op: "feedAppend", view: "audit", item: { id: "a4r", from: "财务负责人", time: "14:12:26", text: "退回补证；争议未发、ERP 未改、付款未执行" } },
              ],
            },
          },
          {
            id: "s4-rejected-text",
            kind: "text",
            title: "退回后的下文",
            defaultOpen: true,
            content: "流程停在职责分离审批点。退回原因、证据版本和草案编号继续保留；补证后重新提交，不会沿用这次未生效的批准范围。",
          },
        ],
      },
    },

    {
      caption: "按批准范围写入原业务系统",
      blocks: [
        {
          id: "s5-tool",
          kind: "tool_use",
          title: "SettlementActionWrite",
          defaultOpen: true,
          toolName: "SettlementActionWrite",
          toolId: "t-write",
          content: JSON.stringify({ batch: "SET-2026-07-018", approval: "FIN-2026-0804-126", idempotencyKey: "SET-2026-07-018-v1" }),
          executionStatus: "completed",
          durationMs: 2280,
          presentation: {
            title: "争议、贷项、跨期、发票和付款门禁已分别落位",
            detail: [
              { k: "平台", v: "争议 DR-2026-0731-018 已提交 ¥11,000.00" },
              { k: "贷项", v: "CR-REQ-2026-0731-006 已提交 ¥4,800.00" },
              { k: "ERP/AR", v: "¥8,380.80 转 8 月结算在途" },
              { k: "ERP/AP", v: "两张发票已登记；物流付款草案保持 HOLD" },
              { tree: "├", k: "部分验收", v: "¥7,100.00 仍等待完整 POD" },
              { tree: "└", k: "上期争议", v: "¥2,400.00 继续等待银行实收" },
              { insight: "内部处置已写入；外部平台接受与银行到账仍是未知，不能提前关账", label: "当前状态" },
            ],
            status: "waiting",
            receipt: { id: "DR-2026-0731-018", system: "星河平台", readBack: false },
            panel: [
              { op: "focus", view: "documents" },
              { op: "tableRowUpdate", view: "documents", id: "doc-dispute", set: { cells: { state: "已提交 · 待平台受理" } } },
              { op: "tableRowUpdate", view: "documents", id: "doc-credit", set: { cells: { state: "已提交 · 待贷项" } } },
              { op: "tableRowUpdate", view: "documents", id: "doc-invoice1", set: { cells: { state: "已登记" } } },
              { op: "tableRowUpdate", view: "documents", id: "doc-invoice2", set: { cells: { state: "已登记 · 已净额扣除" } } },
              { op: "cellFlag", view: "documents", rowId: "doc-payment", colKey: "state", tone: "deny", flag: "HOLD" },
              { op: "tableRowInsert", view: "receipts", row: { id: "rc-dispute", cells: { receipt: "DR-2026-0731-018", source: "星河平台", amount: "¥11,000.00", state: "待受理" }, tone: "warn" } },
              { op: "tableRowInsert", view: "receipts", row: { id: "rc-pod", cells: { receipt: "完整 POD", source: "履约系统", amount: "¥7,100.00", state: "待补签" }, tone: "warn" } },
              { op: "tableRowInsert", view: "receipts", row: { id: "rc-old", cells: { receipt: "CN-2026-0617", source: "银行", amount: "¥2,400.00", state: "待实收" }, tone: "warn" } },
              { op: "toolbar", view: "receipts", title: "外部回执", sub: "3 项等待确认" },
              { op: "feedAppend", view: "audit", item: { id: "a5", from: "AI 同事", time: "14:13:06", text: "按 FIN-2026-0804-126 写入争议、贷项、跨期与发票；重复付款继续 HOLD" } },
              { op: "toolbar", view: "audit", title: "系统动作", sub: "5 条 · 等外部终态" },
            ],
          },
        },
        {
          id: "s5-text",
          kind: "text",
          title: "业务进展",
          defaultOpen: true,
          content: "批准范围已经分别写进平台和 ERP，但这还不是关账：平台是否接受争议、完整 POD 是否生效、银行是否真实到账，都要拿到权威回执后再判定。",
        },
      ],
    },

    {
      caption: "持续等待平台与银行权威回执",
      blocks: [
        {
          id: "s6-tool",
          kind: "tool_use",
          title: "ExternalReceiptWait",
          defaultOpen: true,
          toolName: "ExternalReceiptWait",
          toolId: "t-wait",
          content: JSON.stringify({ dispute: "DR-2026-0731-018", credit: "CR-REQ-2026-0731-006", bankAllocation: ["2026-07", "2026-06-dispute"] }),
          executionStatus: "completed",
          durationMs: 980,
          presentation: {
            title: "平台已接受处置，银行补款仍在途",
            detail: [
              { verdict: "pass", text: "平台争议", note: "接受 ¥11,000.00 · 回执 PF-RCPT-2026-0805-771" },
              { verdict: "pass", text: "贷项通知", note: "CR-2026-0805-092 · 主体错配已冲回" },
              { verdict: "pass", text: "完整 POD", note: "POD-OR-77904-R2 · ¥7,100.00 已释放" },
              { verdict: "fail", text: "银行实收", note: "补款 ¥20,500.00 尚未到账；上期 ¥2,400.00 也未分配" },
              { insight: "平台点了完成不等于资金到账；维持待关账并在下一银行回单到达时自动续跑", label: "门禁" },
            ],
            status: "waiting",
            receipt: { id: "PF-RCPT-2026-0805-771", system: "星河平台", readBack: true },
            panel: [
              { op: "focus", view: "receipts" },
              { op: "tableRowUpdate", view: "receipts", id: "rc-dispute", set: { cells: { receipt: "PF-RCPT-2026-0805-771", state: "已接受 · 待付款" }, tone: "pass" } },
              { op: "tableRowUpdate", view: "receipts", id: "rc-pod", set: { cells: { receipt: "POD-OR-77904-R2", state: "已释放 · 待付款" }, tone: "pass" } },
              { op: "toolbar", view: "receipts", title: "外部回执", sub: "平台 2 项确认 · 银行仍在途" },
              { op: "feedAppend", view: "audit", item: { id: "a6", from: "回执监听器", time: "10:08:41", text: "平台接受争议并释放部分验收款；银行未到账，批次继续待关账" } },
              { op: "toolbar", view: "audit", title: "系统动作", sub: "6 条 · 未提前关账" },
            ],
          },
        },
        {
          id: "s6-text",
          kind: "text",
          title: "等待中的判断",
          defaultOpen: true,
          content: "平台已经接受 ¥11,000.00 争议并释放 ¥7,100.00，但银行还没有这两笔补款。系统继续把批次标成**待关账**，不会因为网页显示“已处理”就把应收写成已到账。",
        },
      ],
    },

    {
      caption: "独立回读后完成关账",
      blocks: [
        {
          id: "s7-tool",
          kind: "tool_use",
          title: "SettlementAuthoritativeReadBack",
          defaultOpen: true,
          toolName: "SettlementAuthoritativeReadBack",
          toolId: "t-readback",
          content: JSON.stringify({ batch: "SET-2026-07-018", bypassSessionCache: true, allocateByReceipt: true }),
          executionStatus: "completed",
          durationMs: 1640,
          presentation: {
            title: "绕过会话缓存，平台、银行与 ERP 已一致",
            detail: [
              { verdict: "pass", text: "银行回单 BK-2026-0806-4381", note: "补款 ¥20,500.00 已实收" },
              { verdict: "pass", text: "7 月结算", note: "¥1,173,565.20 已入账并清分" },
              { verdict: "pass", text: "6 月争议", note: "¥2,400.00 单独分配至上期 AR" },
              { verdict: "pass", text: "8 月在途", note: "¥8,380.80 保留为跨期结算，不冒充差错" },
              { verdict: "pass", text: "重复付款门禁", note: "PAY-2026-0804-092 仍为 HOLD，未出款" },
              { insight: "当期已关账；跨期金额有明确归属，外部争议与上期应收均有权威回执", label: "终态" },
            ],
            status: "ok",
            receipt: { id: "BK-2026-0806-4381", system: "云桥银行", readBack: true },
            panel: [
              { op: "focus", view: "receipts" },
              { op: "tableRowUpdate", view: "receipts", id: "rc-dispute", set: { cells: { state: "¥11,000.00 已实收" }, tone: "pass" } },
              { op: "tableRowUpdate", view: "receipts", id: "rc-pod", set: { cells: { state: "¥7,100.00 已实收" }, tone: "pass" } },
              { op: "tableRowUpdate", view: "receipts", id: "rc-old", set: { cells: { receipt: "BK-2026-0806-4381", state: "¥2,400.00 已实收" }, tone: "pass" } },
              { op: "toolbar", view: "receipts", title: "权威回执 · 独立回读", sub: "¥20,500.00 已实收并完成清分" },
              { op: "focus", view: "ledger" },
              { op: "tableRowUpdate", view: "ledger", id: "l-platform", set: { cells: { amount: "¥1,175,965.20", state: "含上期贷项" }, tone: "pass" } },
              { op: "tableRowUpdate", view: "ledger", id: "l-bank", set: { cells: { amount: "¥1,175,965.20", state: "已实收" }, tone: "pass" } },
              { op: "tableRowUpdate", view: "ledger", id: "l-erp", set: { cells: { amount: "¥1,173,565.20", state: "7 月已关账" }, tone: "pass" } },
              { op: "toolbar", view: "ledger", title: "结算批次 SET-2026-07-018", sub: "7 月关账完成 · 跨期有归属" },
              { op: "feedAppend", view: "audit", item: { id: "a7", from: "独立回读器", time: "16:32:18", text: "绕过会话缓存回读平台、银行、ERP/AR/AP；当期一致并关账" } },
              { op: "toolbar", view: "audit", title: "系统动作", sub: "7 条 · 关账闭环" },
            ],
          },
        },
        {
          id: "s7-text",
          kind: "text",
          title: "跨系统终态核对",
          defaultOpen: true,
          content: [
            "## 跨系统终态核对",
            "",
            "| 权威来源 | 独立回读终态 | 金额与依据 |",
            "| --- | --- | --- |",
            "| 合同价卡 + 订单/POD | 7 月应结 **¥1,173,565.20** | 合同口径 ¥1,181,946.00 − 跨期净额 ¥8,380.80 |",
            "| 星河平台 | 争议、贷项、部分验收均已处理 | PF-RCPT-2026-0805-771 · 总付款 ¥1,175,965.20 |",
            "| 云桥银行 | 补款 ¥20,500.00 已实收 | BK-2026-0806-4381 · 总入账 ¥1,175,965.20 |",
            "| 星云 ERP/AR | 7 月 ¥1,173,565.20 已清分关账 | 6 月争议 ¥2,400.00 单独核销 |",
            "| 星云 ERP/AP | 物流付款草案保持 HOLD | 平台已净额扣除，未重复付款 |",
            "| 8 月结算在途 | ¥8,380.80 有明确归属 | OR-77821 · 不计作 7 月差错 |",
            "",
            "## 本次会话没有做什么",
            "",
            "- 没有要求财务上传 Excel、银行回单或手工解释内部价卡；",
            "- 没有让模型重算标准订单、退款和费率，也没有把跨期金额冒充差错；",
            "- 没有由 AI 自批争议、改账或付款，业务事实与财务动作由不同岗位核定；",
            "- 没有把平台页面的“已处理”当成银行到账，也没有在权威回单前提前关账；",
            "- 没有执行疑似重复的 ¥18,720.00 物流付款草案。",
          ].join("\n"),
        },
      ],
    },
  ],

  sources: [
    {
      blockRef: "step1.tool.SettlementContextRead",
      producer: "企业结算上下文聚合器",
      state: "missing",
      gap: "尚缺统一读取合同价卡、订单/退款/POD、平台账单、银行与 ERP/AR/AP 的业务关联键",
    },
    {
      blockRef: "step2.tool.DeterministicReconcile",
      producer: "确定性结算匹配器",
      state: "missing",
      gap: "尚缺按版本化价卡、订单键、退款键和履约凭据执行逐笔匹配的规则引擎",
    },
    {
      blockRef: "step3.tool.SettlementExceptionReview",
      producer: "结算例外分析与单据草拟器",
      state: "missing",
      gap: "尚缺把跨期、费用条款、主体和验收状态绑定到同一结算对象的产出方",
    },
    {
      blockRef: "step3.artifact.多方结算关账证据包",
      producer: "Agent 生成 HTML 产物",
      state: "exists",
    },
    {
      blockRef: "step4.tool.SeparationOfDutiesApproval",
      producer: "职责分离审批执行器",
      state: "needs-change",
      gap: "HITL 已有同意与退回，仍需业务事实、财务动作和资金权限的分岗签署与范围锁定",
    },
    {
      blockRef: "step4.tool.SettlementApprovalRejected",
      producer: "审批退回留痕执行器",
      state: "needs-change",
      gap: "仍需确保退回时跨平台争议、ERP 调整和付款动作原子化地保持未执行",
    },
    {
      blockRef: "step5.tool.SettlementActionWrite",
      producer: "结算动作编排器",
      state: "missing",
      gap: "尚缺按批准范围幂等写入平台争议、贷项、ERP 跨期、发票与付款门禁的连接器",
    },
    {
      blockRef: "step6.tool.ExternalReceiptWait",
      producer: "平台与银行回执监听器",
      state: "missing",
      gap: "尚缺跨平台回执订阅、银行入账匹配和持久化等待后的自动续跑",
    },
    {
      blockRef: "step7.tool.SettlementAuthoritativeReadBack",
      producer: "多方结算权威回读器",
      state: "missing",
      gap: "需要绕过会话缓存独立回读平台、银行和 ERP，并按期间与业务对象完成资金清分",
    },
  ],
};

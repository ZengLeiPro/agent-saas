import type { SystemPanelSnapshot } from "../../lib/systemPanel";
import type { ReplayScript } from "./types";

/**
 * D1：合同 / SOW 到唯一开工基线。
 *
 * 示例数据全部虚构。这个场景不把“建了项目”当成功，而是把电子签、CRM、
 * 项目资源与 ERP 预算里的冲突先锁成 HOLD；只有销售/法务、交付、财务分别
 * 确认自己的窄口取舍后，才把同一个获批版本写入三个下游系统并独立回读。
 */

const BASELINE_PACK_PATH = "assets/demo/项目开工基线确认单.html";

const BASELINE_PACK_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<style>
  :root { --brand:#2E56E1; --ink:#0f172a; --muted:#64748b; --line:#e2e8f0; --ok:#15803d; --warn:#b45309; }
  * { box-sizing:border-box; }
  body { margin:0; padding:22px; color:var(--ink); background:#fff; font:14px/1.7 "PingFang SC","Microsoft YaHei",system-ui,sans-serif; }
  .bar { display:flex; gap:10px; align-items:center; margin-bottom:18px; padding:7px 10px; border:1px solid var(--line); border-radius:7px; color:var(--muted); background:#f8fafc; font-size:12px; }
  .tag { padding:1px 7px; border-radius:4px; color:var(--brand); background:#eef2ff; font-weight:600; }
  h1 { margin:0 0 4px; font-size:18px; }
  .sub { margin:0 0 16px; color:var(--muted); font-size:12px; }
  .summary { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; margin-bottom:16px; }
  .summary div { padding:9px 10px; border:1px solid var(--line); border-radius:8px; }
  .summary b { display:block; font-size:15px; }
  .summary span { color:var(--muted); font-size:12px; }
  table { width:100%; border-collapse:collapse; margin-bottom:15px; font-size:13px; }
  th,td { padding:8px 10px; border:1px solid var(--line); text-align:left; vertical-align:top; }
  th { color:var(--muted); background:#f8fafc; font-weight:500; }
  .ok { color:var(--ok); font-weight:600; }
  .warn { color:var(--warn); font-weight:600; }
  .box { margin-bottom:12px; padding:12px; border:1px solid var(--line); border-left:3px solid var(--brand); border-radius:8px; }
  .box h2 { margin:0 0 7px; font-size:13px; }
  .box ul { margin:0; padding-left:18px; }
  .foot { margin-top:14px; color:var(--muted); font-size:12px; }
</style></head><body>
<div class="bar"><span class="tag">获批版本</span><span>项目开工基线 · BL-2026-042-R1 · 生成于 2026-08-24 10:18</span></div>
<h1>星港智造集团 · 华东两基地售后协同平台</h1>
<p class="sub">控制来源：电子签合同 ES-2026-041 修订版 C3 + SOW 修订版 4</p>

<div class="summary">
  <div><b>128 万元</b><span>合同含税金额</span></div>
  <div><b>2026-11-30</b><span>正式上线</span></div>
  <div><b>2 个基地</b><span>一期交付范围</span></div>
  <div><b class="ok">允许开工</b><span>三岗组合审批通过</span></div>
</div>

<table>
  <tr><th>控制项</th><th>获批口径</th><th>原冲突</th><th>处理结果</th></tr>
  <tr><td>交付范围</td><td>华东一厂、华东二厂；培训 8 场；迁移近 3 年数据</td><td>CRM 仍是单基地、培训 6 场</td><td class="ok">以签约 SOW 修订版 4 覆盖</td></tr>
  <tr><td>正式上线</td><td>2026-11-30</td><td>项目模板按 12-15 排产</td><td class="ok">增配集成工程师 10 个工作日</td></tr>
  <tr><td>成本预算</td><td>114 万元</td><td>ERP 原批 105 万元</td><td class="ok">财务追加 9 万元</td></tr>
  <tr><td>付款节点</td><td>签约 30% / 试点验收 40% / 终验 30%</td><td>CRM 沿用旧报价节点</td><td class="ok">按合同 C3 固化</td></tr>
</table>

<div class="box">
  <h2>组合审批留痕</h2>
  <ul>
    <li>销售 / 法务：确认合同 C3 与 SOW 4 为唯一商业承诺来源，CRM 旧报价不再控制交付。</li>
    <li>交付负责人：确认调入 1 名集成工程师，共 10 个工作日，不压缩测试与验收。</li>
    <li>财务负责人：批准成本预算由 105 万元调整为 114 万元，付款节点按合同执行。</li>
  </ul>
</div>

<div class="box">
  <h2>下游引用</h2>
  <ul>
    <li>CRM 商机 / 合同视图：BL-2026-042-R1</li>
    <li>项目管理计划：BL-2026-042-R1</li>
    <li>ERP 项目预算：BL-2026-042-R1</li>
  </ul>
</div>

<p class="foot">演示数据，不对应任何真实企业、客户、合同或项目。开工状态以三个下游系统独立回读一致为准。</p>
</body></html>`;

const BASELINE_PACK_SIZE_BYTES = new TextEncoder().encode(BASELINE_PACK_HTML).length;

const PANEL_BASE: SystemPanelSnapshot = {
  title: "企业系统实况",
  live: true,
  activeView: "contract",
  foot: "已连接：电子签 · CRM · 项目管理 · ERP 预算 · 开工基线（演示）",
  views: [
    {
      key: "contract",
      label: "电子签合同",
      winTitle: "电子签 · 已签合同与 SOW",
      toolbar: { title: "电子签合同", sub: "尚未读取" },
      widget: {
        kind: "table",
        cols: [
          { key: "doc", label: "文件" },
          { key: "revision", label: "修订版" },
          { key: "state", label: "签署状态", align: "right" },
        ],
        rows: [],
        empty: { title: "尚未读取签约文件" },
      },
    },
    {
      key: "crm",
      label: "CRM 承诺",
      winTitle: "CRM · 报价与客户承诺",
      toolbar: { title: "CRM 商机 / 合同视图", sub: "尚未读取" },
      widget: { kind: "rows", rows: [], empty: { title: "尚未读取 CRM" } },
    },
    {
      key: "ppm",
      label: "项目资源",
      winTitle: "项目管理 · 资源与里程碑",
      toolbar: { title: "项目资源模板", sub: "尚未读取" },
      widget: { kind: "rows", rows: [], empty: { title: "尚未读取资源计划" } },
    },
    {
      key: "erp",
      label: "ERP 预算",
      winTitle: "ERP · 项目成本预算",
      toolbar: { title: "项目预算", sub: "尚未读取" },
      widget: { kind: "rows", rows: [], empty: { title: "尚未读取预算" } },
    },
    {
      key: "baseline",
      label: "开工基线",
      winTitle: "开工基线 · 唯一控制版本",
      toolbar: { title: "项目开工门禁", sub: "尚未建立" },
      widget: { kind: "rows", rows: [], empty: { title: "尚未形成开工基线" } },
    },
    {
      key: "audit",
      label: "操作留痕",
      winTitle: "操作留痕 · 本次开工准备",
      toolbar: { title: "本次会话的系统动作", sub: "0 条" },
      widget: { kind: "feed", items: [], empty: { title: "尚无系统动作" } },
    },
  ],
};

export const contractBaselineScript: ReplayScript = {
  scenarioId: "catalog-contract-sow-to-approved-baseline-loop",
  title: "合同签完，项目按唯一基线真正开工",
  mode: "hero",
  artifacts: { [BASELINE_PACK_PATH]: BASELINE_PACK_HTML },

  steps: [
    {
      caption: "自动拉齐四处企业事实",
      blocks: [
        {
          id: "cb1-prompt",
          kind: "prompt",
          title: "用户消息",
          defaultOpen: true,
          content: "合同签了，把项目真正立起来；冲突没解决别开工。",
        },
        {
          id: "cb1-tool",
          kind: "tool_use",
          title: "BusinessContextRead",
          defaultOpen: true,
          toolName: "BusinessContextRead",
          toolId: "t-context",
          content: JSON.stringify({ project: "华东两基地售后协同平台", sources: ["电子签", "CRM", "项目管理", "ERP"] }),
          executionStatus: "completed",
          durationMs: 1680,
          presentation: {
            title: "读取签约事实、客户承诺、资源与预算",
            detail: [
              { k: "电子签", v: "合同 ES-2026-041 修订版 C3 + SOW 修订版 4 · 均已签署" },
              { k: "CRM", v: "报价修订版 7 · 仍保留谈判前口径" },
              { k: "项目资源", v: "标准模板可支撑 12-15 上线" },
              { k: "ERP 预算", v: "已批准成本预算 105 万元" },
              { insight: "四处不是同一个版本，先核冲突，不创建开工任务", label: "判断" },
            ],
            status: "warn",
            panelBase: PANEL_BASE,
            panel: [
              { op: "focus", view: "contract" },
              { op: "toolbar", view: "contract", title: "电子签合同 · ES-2026-041", sub: "2 份文件 · 已签署" },
              { op: "tableRowInsert", view: "contract", row: { id: "doc-contract", cells: { doc: "项目合同", revision: "C3", state: "已签署" }, tone: "pass", flags: { state: { tone: "pass", flag: "控制来源" } } } },
              { op: "tableRowInsert", view: "contract", row: { id: "doc-sow", cells: { doc: "工作说明书 SOW", revision: "4", state: "已签署" }, tone: "pass", flags: { state: { tone: "pass", flag: "控制来源" } } } },
              { op: "toolbar", view: "crm", title: "CRM 商机 / 合同视图", sub: "报价修订版 7" },
              { op: "rowsSet", view: "crm", rows: [
                { id: "crm-price", text: "报价金额 118 万元", sub: "报价修订版 7 · 尚未同步签约结果", tone: "warn" },
                { id: "crm-scope", text: "单基地 · 培训 6 场", sub: "计划上线 2026-12-15", tone: "warn" },
              ] },
              { op: "toolbar", view: "ppm", title: "项目资源模板", sub: "标准交付资源" },
              { op: "rowsSet", view: "ppm", rows: [
                { id: "ppm-team", text: "项目经理 1 · 实施 2", sub: "当前资源可支撑 2026-12-15 上线", tone: "info" },
              ] },
              { op: "toolbar", view: "erp", title: "ERP 项目预算", sub: "已批 105 万元" },
              { op: "rowsSet", view: "erp", rows: [
                { id: "erp-budget", text: "成本预算 105 万元", sub: "沿用单基地报价测算", tone: "warn" },
              ] },
              { op: "feedAppend", view: "audit", item: { id: "cb-au-1", from: "AI 同事", time: "10:03:12", text: "只读拉取电子签、CRM、项目资源与 ERP 预算；未创建项目、未占用资源" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "1 条" },
            ],
          },
        },
        {
          id: "cb1-text",
          kind: "text",
          title: "业务进展",
          defaultOpen: true,
          content: "四处事实都拿到了，但它们讲的不是同一笔生意。我先按签约版本逐项对差异；在差异归零前，不创建项目、不占资源，也不放成本预算。",
        },
      ],
    },

    {
      caption: "发现三类冲突，开工保持 HOLD",
      blocks: [
        {
          id: "cb2-tool",
          kind: "tool_use",
          title: "BaselineDiff",
          defaultOpen: true,
          toolName: "BaselineDiff",
          toolId: "t-diff",
          content: JSON.stringify({ control: ["ES-2026-041-C3", "SOW-4"], compare: ["CRM-Q7", "PPM-TEMPLATE", "ERP-105"] }),
          executionStatus: "completed",
          durationMs: 1120,
          presentation: {
            title: "按签约版本比对三个下游系统",
            detail: [
              { verdict: "fail", text: "范围与金额冲突", note: "签约 128 万元、双基地、培训 8 场；CRM 仍是 118 万元、单基地、培训 6 场" },
              { verdict: "fail", text: "里程碑与资源冲突", note: "合同要求 11-30 上线；标准资源只支撑 12-15" },
              { verdict: "fail", text: "成本预算冲突", note: "签约范围预测成本 114 万元；ERP 仅批准 105 万元，缺口 9 万元" },
              { insight: "三个冲突都影响履约，开工门禁保持 HOLD", label: "结论" },
            ],
            status: "blocked",
            panel: [
              { op: "focus", view: "baseline" },
              { op: "toolbar", view: "baseline", title: "项目开工门禁", sub: "HOLD · 3 项冲突" },
              { op: "rowsSet", view: "baseline", rows: [
                { id: "bl-gate", text: "开工状态：HOLD", sub: "范围 / 资源 / 预算尚未统一", tone: "warn", state: "hit", badge: { text: "禁止开工", tone: "warn" } },
                { id: "bl-scope", text: "范围与金额", sub: "签约版本与 CRM 报价版本不一致", tone: "warn" },
                { id: "bl-plan", text: "里程碑与资源", sub: "11-30 与 12-15 相差 15 天", tone: "warn" },
                { id: "bl-cost", text: "成本预算", sub: "预测 114 万元 · 已批 105 万元", tone: "warn" },
              ] },
              { op: "cellFlag", view: "contract", rowId: "doc-contract", colKey: "revision", tone: "pass", flag: "以 C3 为准" },
              { op: "pulse", view: "baseline", ids: ["bl-scope", "bl-plan", "bl-cost"], kind: "scan" },
              { op: "feedAppend", view: "audit", item: { id: "cb-au-2", from: "AI 同事", time: "10:03:31", text: "识别 3 项履约冲突，建立开工 HOLD；未向 CRM、项目管理或 ERP 写入" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "2 条" },
            ],
          },
        },
        {
          id: "cb2-text",
          kind: "text",
          title: "为什么不能直接建项目",
          defaultOpen: true,
          content: [
            "现在开工，交付团队会按 12 月 15 日和单基地排资源，客户却握着 11 月 30 日、双基地的已签合同；财务预算还少 9 万元。",
            "",
            "所以门禁已经锁在 **HOLD**。这不是让三拨人重审整份合同，只把三个有代价的冲突送到对应岗位拍板。",
          ].join("\n"),
        },
      ],
    },

    {
      caption: "形成唯一基线草案与窄口取舍",
      blocks: [
        {
          id: "cb3-tool",
          kind: "tool_use",
          title: "BaselineDraft",
          defaultOpen: true,
          toolName: "BaselineDraft",
          toolId: "t-draft",
          content: JSON.stringify({ project: "华东两基地售后协同平台", target: "BL-2026-042-R1" }),
          executionStatus: "completed",
          durationMs: 960,
          presentation: {
            title: "生成开工基线草案，只保留三项人审",
            detail: [
              { k: "控制版本", v: "合同 C3 + SOW 4" },
              { k: "交付基线", v: "双基地 · 培训 8 场 · 近 3 年数据 · 11-30 上线" },
              { k: "资源取舍", v: "调入集成工程师 1 名，共 10 个工作日" },
              { k: "预算取舍", v: "成本预算 105 万元 → 114 万元" },
              { tree: "└", k: "待审批", v: "销售/法务确认承诺 · 交付确认资源 · 财务确认预算" },
            ],
            status: "waiting",
            panel: [
              { op: "focus", view: "baseline" },
              { op: "toolbar", view: "baseline", title: "开工基线草案 · BL-2026-042-R1", sub: "待三岗组合审批" },
              { op: "rowsSet", view: "baseline", rows: [
                { id: "bl-gate", text: "开工状态：HOLD", sub: "草案已形成，等待三个窄口决定", tone: "pending", badge: { text: "待审批", tone: "warn" } },
                { id: "bl-scope", text: "商业承诺", sub: "128 万元 · 双基地 · 培训 8 场 · 合同 C3 / SOW 4", tone: "pass" },
                { id: "bl-plan", text: "交付计划", sub: "11-30 上线 · 增配集成工程师 10 个工作日", tone: "pending" },
                { id: "bl-cost", text: "成本预算", sub: "114 万元 · 需追加 9 万元", tone: "pending" },
              ] },
              { op: "feedAppend", view: "audit", item: { id: "cb-au-3", from: "AI 同事", time: "10:05:02", text: "生成基线草案 BL-2026-042-R1；只提交 3 项冲突，不要求重复审核已签条款" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "3 条" },
            ],
          },
        },
        {
          id: "cb3-text",
          kind: "text",
          title: "送审说明",
          defaultOpen: true,
          content: "草案已经把 37 条无争议条款带过，只剩三个决定：销售/法务认不认合同 C3 与 SOW 4 为唯一承诺，交付是否调入 1 名工程师，财务是否追加 9 万元。有人退回时，我会按批注重算替代版本，不会把流程掐断。",
        },
      ],
    },

    {
      caption: "三岗组合审批冲突项",
      blocks: [],
      approval: {
        title: "项目开工基线 · 三岗组合审批",
        description: "只确认会改变履约结果的三项取舍。全部通过后才写 CRM、项目管理和 ERP；任一退回则保持 HOLD，并生成修订版继续送审。",
        facts: [
          { label: "销售 / 法务", value: "以合同 C3 + SOW 4 覆盖 CRM 报价修订版 7" },
          { label: "交付负责人", value: "调入 1 名集成工程师，共 10 个工作日，守住 11-30" },
          { label: "财务负责人", value: "成本预算由 105 万元调整为 114 万元" },
          { label: "当前门禁", value: "HOLD · 三个下游系统均未写入" },
        ],
        approveLabel: "三岗确认并发布",
        rejectLabel: "退回一个取舍",
        approvedBlocks: [
          {
            id: "cb4-approved-tool",
            kind: "tool_use",
            title: "CompositeApproval",
            defaultOpen: true,
            toolName: "CompositeApproval",
            toolId: "t-approve",
            content: JSON.stringify({ baseline: "BL-2026-042-R1", decisions: 3, outcome: "approved" }),
            executionStatus: "completed",
            durationMs: 540,
            presentation: {
              title: "三个窄口决定均已确认",
              detail: [
                { verdict: "pass", text: "销售 / 法务", note: "合同 C3 + SOW 4 为唯一商业承诺来源" },
                { verdict: "pass", text: "交付负责人", note: "集成工程师 10 个工作日已锁定，不压缩测试" },
                { verdict: "pass", text: "财务负责人", note: "追加 9 万元，成本预算调整为 114 万元" },
                { insight: "基线获批；下一步才开始逐系统写入", label: "结果" },
              ],
              status: "ok",
              receipt: { id: "BL-2026-042-R1", system: "组合审批", readBack: true },
              panel: [
                { op: "focus", view: "baseline" },
                { op: "toolbar", view: "baseline", title: "开工基线 · BL-2026-042-R1", sub: "已批准 · 待下游发布" },
                { op: "rowsSet", view: "baseline", rows: [
                  { id: "bl-gate", text: "开工状态：待发布", sub: "三岗已批准，尚未完成三个下游写入", tone: "pending", badge: { text: "未开工", tone: "warn" } },
                  { id: "bl-scope", text: "商业承诺", sub: "销售 / 法务已确认 · 合同 C3 / SOW 4", tone: "pass" },
                  { id: "bl-plan", text: "交付计划", sub: "交付已确认 · 11-30 + 增配 10 个工作日", tone: "pass" },
                  { id: "bl-cost", text: "成本预算", sub: "财务已确认 · 114 万元", tone: "pass" },
                ] },
                { op: "feedAppend", view: "audit", item: { id: "cb-au-4", from: "组合审批", time: "10:11:18", text: "销售/法务、交付、财务分别确认 3 项取舍；基线获批，但尚未写下游系统" } },
                { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "4 条" },
              ],
            },
          },
          {
            id: "cb4-approved-text",
            kind: "text",
            title: "审批结果",
            defaultOpen: true,
            content: "三岗都确认了，但项目还不能算开工。现在只是基线获批，CRM、项目管理和 ERP 还没引用它；我接下来逐个写入，并且每写一个就从原系统回读一次。",
          },
        ],
        rejectedBlocks: [
          {
            id: "cb4-rejected-tool",
            kind: "tool_use",
            title: "BaselineRework",
            defaultOpen: true,
            toolName: "BaselineRework",
            toolId: "t-rework",
            content: JSON.stringify({ baseline: "BL-2026-042-R1", outcome: "returned", nextRevision: "R2" }),
            executionStatus: "completed",
            durationMs: 620,
            presentation: {
              title: "退回批注已接住，改走 R2 修订",
              detail: [
                { k: "对外与下游动作", v: "CRM、项目管理、ERP 均未写入" },
                { k: "开工状态", v: "继续 HOLD" },
                { k: "修订动作", v: "保留已同意两项，只重算被退回的取舍" },
                { tree: "└", k: "下一步", v: "形成 BL-2026-042-R2 后重新送原岗位确认" },
              ],
              status: "blocked",
              panel: [
                { op: "focus", view: "baseline" },
                { op: "toolbar", view: "baseline", title: "开工基线 · 退回修订", sub: "HOLD · R2 编制中" },
                { op: "rowsSet", view: "baseline", rows: [
                  { id: "bl-gate", text: "开工状态：HOLD", sub: "退回未发布，三个下游系统零写入", tone: "warn", badge: { text: "禁止开工", tone: "warn" } },
                  { id: "bl-rework", text: "BL-2026-042-R2 编制中", sub: "只重算被退回项，已确认项保留并带版本留痕", tone: "pending" },
                ] },
                { op: "feedAppend", view: "audit", item: { id: "cb-au-4r", from: "AI 同事", time: "10:11:18", text: "组合审批退回：未写入任何下游系统；R1 封存，按批注生成 R2 继续送审" } },
                { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "4 条" },
              ],
            },
          },
          {
            id: "cb4-rejected-text",
            kind: "text",
            title: "退回后的下文",
            defaultOpen: true,
            content: "已停在发布之前：CRM、项目管理和 ERP 都没有写入，开工仍是 HOLD。R1 连同退回批注封存，我只重算被退回的那一个取舍，形成 R2 后重新送原岗位确认；另外两项不用重审。",
          },
        ],
      },
    },

    {
      caption: "让 CRM 只认获批基线",
      blocks: [
        {
          id: "cb5-tool",
          kind: "tool_use",
          title: "CRMWrite",
          defaultOpen: true,
          toolName: "CRMWrite",
          toolId: "t-crm-write",
          content: JSON.stringify({ project: "华东两基地售后协同平台", baseline: "BL-2026-042-R1" }),
          executionStatus: "completed",
          durationMs: 880,
          presentation: {
            title: "更新 CRM 承诺并绑定获批基线",
            detail: [
              { k: "基线引用", v: "BL-2026-042-R1" },
              { k: "客户承诺", v: "128 万元 · 双基地 · 培训 8 场 · 11-30 上线" },
              { k: "旧报价", v: "修订版 7 保留历史，不再控制交付" },
              { tree: "└", k: "回读", v: "CRM 合同视图已返回同一基线引用" },
            ],
            status: "ok",
            receipt: { id: "CRM-BL-2026-042-R1", system: "CRM", readBack: true },
            panel: [
              { op: "focus", view: "crm" },
              { op: "toolbar", view: "crm", title: "CRM 商机 / 合同视图", sub: "已绑定 BL-2026-042-R1" },
              { op: "rowsSet", view: "crm", rows: [
                { id: "crm-baseline", text: "客户承诺 · BL-2026-042-R1", sub: "128 万元 · 双基地 · 培训 8 场 · 11-30 上线", tone: "pass", badge: { text: "已回读", tone: "pass" } },
                { id: "crm-history", text: "报价修订版 7", sub: "保留历史 · 不再控制交付", tone: "info" },
              ] },
              { op: "feedAppend", view: "audit", item: { id: "cb-au-5", from: "AI 同事", time: "10:13:40", text: "写入 CRM 并独立回读：客户承诺已引用 BL-2026-042-R1；旧报价保留历史" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "5 条" },
            ],
          },
        },
        {
          id: "cb5-text",
          kind: "text",
          title: "业务进展",
          defaultOpen: true,
          content: "CRM 已经从“谈判时的报价”切到“签约后的唯一承诺”，旧版没有删除，只是不再驱动交付。项目管理和预算还没写完，所以开工状态仍不能变成 READY。",
        },
      ],
    },

    {
      caption: "发布项目计划与成本预算",
      blocks: [
        {
          id: "cb6-tool",
          kind: "tool_use",
          title: "BaselinePublish",
          defaultOpen: true,
          toolName: "BaselinePublish",
          toolId: "t-publish",
          content: JSON.stringify({ baseline: "BL-2026-042-R1", targets: ["项目管理", "ERP"] }),
          executionStatus: "completed",
          durationMs: 1540,
          presentation: {
            title: "把同一基线发布到项目管理与 ERP",
            detail: [
              { verdict: "pass", text: "项目管理", note: "11-30 里程碑、双基地范围与增配资源已生效" },
              { verdict: "pass", text: "ERP", note: "成本预算 114 万元、付款节点 30/40/30 已生效" },
              { k: "共同引用", v: "BL-2026-042-R1" },
              { insight: "三个下游均已写入，仍需独立终态核对后才开门", label: "当前状态" },
            ],
            status: "ok",
            receipt: { id: "PUB-BL-2026-042-R1", system: "项目管理 / ERP", readBack: true },
            panel: [
              { op: "focus", view: "ppm" },
              { op: "toolbar", view: "ppm", title: "项目计划 · BL-2026-042-R1", sub: "资源与里程碑已生效" },
              { op: "rowsSet", view: "ppm", rows: [
                { id: "ppm-plan", text: "正式上线 2026-11-30", sub: "双基地 · 培训 8 场 · 迁移近 3 年数据", tone: "pass", badge: { text: "已回读", tone: "pass" } },
                { id: "ppm-resource", text: "项目经理 1 · 实施 2 · 集成工程师 1", sub: "集成工程师增配 10 个工作日", tone: "pass" },
              ] },
              { op: "toolbar", view: "erp", title: "ERP 项目预算 · BL-2026-042-R1", sub: "预算与付款节点已生效" },
              { op: "rowsSet", view: "erp", rows: [
                { id: "erp-budget", text: "成本预算 114 万元", sub: "原批 105 万元 + 追加 9 万元", tone: "pass", badge: { text: "已回读", tone: "pass" } },
                { id: "erp-pay", text: "付款节点 30% / 40% / 30%", sub: "签约 / 试点验收 / 终验", tone: "pass" },
              ] },
              { op: "feedAppend", view: "audit", item: { id: "cb-au-6", from: "AI 同事", time: "10:16:22", text: "项目管理与 ERP 写入 BL-2026-042-R1，并分别回读里程碑、资源、预算与付款节点" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "6 条" },
            ],
          },
        },
        {
          id: "cb6-text",
          kind: "text",
          title: "业务进展",
          defaultOpen: true,
          content: "项目计划和成本预算都已经写入并各自回读。此刻三个下游看起来一致，但我不会用刚才的写入结果给自己作证；下一步从原系统重新查询，再决定开工门禁能不能变绿。",
        },
      ],
    },

    {
      caption: "生成获批开工基线确认单",
      blocks: [
        {
          id: "cb7-tool",
          kind: "tool_use",
          title: "Write",
          defaultOpen: true,
          toolName: "Write",
          toolId: "t-pack",
          content: JSON.stringify({ file_path: BASELINE_PACK_PATH, baseline: "BL-2026-042-R1" }),
          executionStatus: "completed",
          durationMs: 980,
          presentation: {
            title: "生成可交付的开工基线确认单",
            detail: [
              { k: "产物", v: "项目开工基线确认单（HTML · 自包含）" },
              { k: "控制内容", v: "范围、里程碑、资源、预算、付款节点" },
              { k: "审批留痕", v: "销售/法务、交付、财务三个窄口决定" },
              { tree: "└", k: "下游引用", v: "CRM / 项目管理 / ERP 均列明 BL-2026-042-R1" },
            ],
            status: "ok",
            panel: [
              { op: "focus", view: "baseline" },
              { op: "toolbar", view: "baseline", title: "开工基线 · BL-2026-042-R1", sub: "确认单已生成 · 等待独立回读" },
              { op: "rowsSet", view: "baseline", rows: [
                { id: "bl-gate", text: "开工状态：待终态核对", sub: "三个下游已写入，尚未独立证明一致", tone: "pending", badge: { text: "未开门", tone: "warn" } },
                { id: "bl-pack", text: "项目开工基线确认单", sub: "范围 / 资源 / 预算 / 审批 / 下游引用可带走", tone: "pass", badge: { text: "已生成", tone: "pass" } },
              ] },
              { op: "feedAppend", view: "audit", item: { id: "cb-au-7", from: "AI 同事", time: "10:17:04", text: "生成项目开工基线确认单；未以确认单替代原系统终态" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "7 条" },
            ],
          },
        },
        {
          id: "cb7-text",
          kind: "text",
          title: "可带走的确认单",
          defaultOpen: true,
          content: [
            "这份确认单把签约来源、三个冲突怎么处理、谁拍了什么板和下游引用放在一起，交付、财务或客户成功都能直接核：",
            "",
            `[FILE]{"filePath":"${BASELINE_PACK_PATH}","fileName":"项目开工基线确认单.html","fileSize":${BASELINE_PACK_SIZE_BYTES}}[/FILE]`,
            "",
            "它是交接材料，不是开工凭据。能不能开工，以接下来从 CRM、项目管理和 ERP 独立回读的结果为准。",
          ].join("\n"),
        },
      ],
    },

    {
      caption: "独立回读同一版本后开门",
      blocks: [
        {
          id: "cb8-tool",
          kind: "tool_use",
          title: "BaselineReadBack",
          defaultOpen: true,
          toolName: "BaselineReadBack",
          toolId: "t-readback",
          content: JSON.stringify({ baseline: "BL-2026-042-R1", freshRead: true, systems: ["电子签", "CRM", "项目管理", "ERP"] }),
          executionStatus: "completed",
          durationMs: 1320,
          presentation: {
            title: "从四个原系统重新查询，不使用会话缓存",
            detail: [
              { verdict: "pass", text: "电子签", note: "合同 C3 + SOW 4 · 签署完整，控制来源未变化" },
              { verdict: "pass", text: "CRM", note: "客户承诺引用 BL-2026-042-R1" },
              { verdict: "pass", text: "项目管理", note: "里程碑、范围和资源引用 BL-2026-042-R1" },
              { verdict: "pass", text: "ERP", note: "预算与付款节点引用 BL-2026-042-R1" },
              { insight: "控制来源与三个下游一致，开工门禁变为 READY", label: "终态" },
            ],
            status: "ok",
            receipt: { id: "READY-BL-2026-042-R1", system: "项目开工门禁", readBack: true },
            panel: [
              { op: "focus", view: "baseline" },
              { op: "toolbar", view: "baseline", title: "开工基线 · BL-2026-042-R1", sub: "READY · 四处独立回读一致" },
              { op: "rowsSet", view: "baseline", rows: [
                { id: "bl-gate", text: "开工状态：READY", sub: "电子签控制来源 + 三个下游独立回读一致", tone: "pass", state: "hit", badge: { text: "允许开工", tone: "pass" } },
                { id: "bl-scope", text: "商业承诺", sub: "128 万元 · 双基地 · 培训 8 场 · 11-30", tone: "pass" },
                { id: "bl-plan", text: "项目计划", sub: "资源已锁定 · 不压缩测试与验收", tone: "pass" },
                { id: "bl-cost", text: "成本预算", sub: "114 万元 · 付款 30% / 40% / 30%", tone: "pass" },
              ] },
              { op: "feedAppend", view: "audit", item: { id: "cb-au-8", from: "AI 同事", time: "10:18:26", text: "独立回读电子签、CRM、项目管理与 ERP；全部指向 BL-2026-042-R1，开工门禁变为 READY" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "8 条" },
            ],
          },
        },
        {
          id: "cb8-text",
          kind: "text",
          title: "本次会话改变了什么",
          defaultOpen: true,
          content: [
            "## 本次会话改变了什么",
            "",
            "| 系统 | 独立回读终态 | 控制依据 |",
            "| --- | --- | --- |",
            "| 电子签 | 合同 C3 与 SOW 4 已签署，内容未变化 | 签署记录 ES-2026-041 |",
            "| CRM | 128 万元、双基地、培训 8 场、11-30 上线 | BL-2026-042-R1 |",
            "| 项目管理 | 11-30 里程碑与增配资源已生效 | BL-2026-042-R1 |",
            "| ERP | 成本预算 114 万元，付款节点 30% / 40% / 30% | BL-2026-042-R1 |",
            "| 开工门禁 | READY，允许按获批基线开工 | 四处独立回读一致 |",
            "",
            "## 本次会话没有做什么",
            "",
            "- 没有拿旧报价直接建项目：CRM 修订版 7 只保留历史，不再控制交付；",
            "- 没有替三岗拍板：商业承诺、资源调配和预算追加分别由对应岗位确认；",
            "- 没有在 HOLD 时占资源或放预算：三个下游系统直到组合审批通过后才写入；",
            "- 没有删除任何旧版本：合同、SOW、报价和 R1 审批过程都保留可追溯；",
            "- 没有用写入回执给自己作证：READY 来自重新查询四个原系统后的独立核对。",
          ].join("\n"),
        },
      ],
    },
  ],

  sources: [
    {
      blockRef: "step1.tool.BusinessContextRead",
      producer: "电子签 / CRM / 项目管理 / ERP 企业上下文连接器",
      state: "missing",
      gap: "当前没有把四个系统按同一项目对象与版本关系联合读取的连接器；真实落地需要客户系统 API、对象映射和只读权限。",
    },
    {
      blockRef: "step2.tool.BaselineDiff",
      producer: "受控版本与承诺差异判定器",
      state: "missing",
      gap: "当前缺项目级对象 ID、控制来源优先级和可版本化差异规则；Agent 临场比对无法作为开工门禁。",
    },
    {
      blockRef: "step3.tool.BaselineDraft",
      producer: "项目开工基线编制器",
      state: "missing",
      gap: "产品内没有统一承载范围、里程碑、资源、预算与付款节点的基线对象，也没有 HOLD 到 READY 的业务门禁。",
    },
    {
      blockRef: "step4.tool.CompositeApproval",
      producer: "平台 HITL + 组合审批执行器",
      state: "needs-change",
      gap: "平台已有单次人审事件，但缺按销售/法务、交付、财务分别收集决定并汇合的组合审批，以及字段级修改留痕。",
    },
    {
      blockRef: "step4.tool.BaselineRework",
      producer: "基线退回与修订管理器",
      state: "missing",
      gap: "当前退回只能停在自由文本，缺 R1 封存、仅重算被退回项、继承已批准项并生成 R2 的确定性修订流程。",
    },
    {
      blockRef: "step5.tool.CRMWrite",
      producer: "CRM 连接器（写入 + 独立回读）",
      state: "missing",
      gap: "当前没有客户 CRM 的合同承诺写入适配器，也缺旧报价保留历史但解除交付控制的版本语义。",
    },
    {
      blockRef: "step6.tool.BaselinePublish",
      producer: "项目管理 / ERP 发布连接器",
      state: "missing",
      gap: "项目资源、里程碑与成本预算仍缺双系统幂等写入、部分成功补偿和相同基线版本引用。",
    },
    {
      blockRef: "step7.tool.Write",
      producer: "Write 工具执行器",
      state: "needs-change",
      gap: "写文件能力已有，但真实执行器尚不会自动汇总审批留痕、系统回执并生成面向业务的开工基线确认单。",
    },
    {
      blockRef: "step7.artifact.项目开工基线确认单",
      producer: "Agent 生成 HTML 产物",
      state: "exists",
    },
    {
      blockRef: "step8.tool.BaselineReadBack",
      producer: "项目开工终态回读器",
      state: "missing",
      gap: "跨系统独立回读依赖前三类连接器；当前没有机器可验的断言证明 CRM、项目管理和 ERP 引用同一获批 revision。",
    },
  ],
};

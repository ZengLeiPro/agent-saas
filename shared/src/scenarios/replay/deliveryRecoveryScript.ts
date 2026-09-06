import type { SystemPanelSnapshot } from "../../lib/systemPanel";
import { demoWorldFixture } from "./demoWorldFixture";
import type { ReplayScript } from "./types";

/**
 * D3 Hero：供给 / 交付异常从真实缺口推进到恢复并回读终态。
 *
 * 与相邻剧本的分工：
 * - deliveryRiskDailyScript 负责从全部在途订单里识别风险；
 * - materialShortageScript 负责采购岗判断真实缺口与采购动作；
 * - 本剧本从一张已确认高危的订单继续往下，直到原承诺兑现或正式重承诺。
 *
 * 规则与优化器负责倒排、约束校验和候选求解；Agent 只解释跨系统例外、组织询证、
 * 把不可逆动作收口到最窄人审，并在执行后独立回读。内容均为虚构演示数据。
 */

const RECOVERY_PLAN_PATH = "assets/demo/恒岳重工交付恢复执行单.html";

const RECOVERY_PLAN_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<style>
  :root { --brand:#2E56E1; --ink:#0f172a; --muted:#64748b; --line:#e2e8f0; --ok:#15803d; --warn:#b45309; --deny:#b91c1c; }
  * { box-sizing:border-box; }
  body { margin:0; padding:20px; font:14px/1.65 "PingFang SC","Microsoft YaHei",system-ui,sans-serif; color:var(--ink); background:#fff; }
  .bar { padding:7px 10px; border:1px solid var(--line); border-radius:7px; background:#f8fafc; color:var(--muted); font-size:12px; margin-bottom:14px; }
  h1 { margin:0 0 3px; font-size:17px; }
  .sub { margin:0 0 15px; color:var(--muted); font-size:12px; }
  .stats { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; margin-bottom:15px; }
  .stat { border:1px solid var(--line); border-radius:8px; padding:9px 10px; }
  .stat b { display:block; font-size:17px; }
  .stat span { color:var(--muted); font-size:12px; }
  table { width:100%; border-collapse:collapse; font-size:12.5px; margin-bottom:15px; }
  th,td { border:1px solid var(--line); padding:7px 9px; text-align:left; vertical-align:top; }
  th { background:#f8fafc; color:var(--muted); font-weight:500; }
  h2 { margin:16px 0 7px; font-size:13px; color:var(--brand); }
  .ok { color:var(--ok); font-weight:600; }
  .warn { color:var(--warn); font-weight:600; }
  .deny { color:var(--deny); font-weight:600; }
  .box { border:1px solid var(--line); border-radius:8px; padding:11px 13px; margin-bottom:12px; }
  .box ul { margin:5px 0; padding-left:20px; }
  .foot { color:var(--muted); font-size:11px; margin-top:14px; }
</style></head><body>
<div class="bar">交付恢复执行单 · ${demoWorldFixture.deliveryOrder.id} · 等待联审授权</div>
<h1>${demoWorldFixture.deliveryOrder.customer}订单交付恢复方案</h1>
<p class="sub">目标：守住 08-14 18:00 装车窗口与 ${demoWorldFixture.deliveryOrder.promisedDeliveryShort} 客户到货承诺</p>
<div class="stats">
  <div class="stat"><b class="deny">${demoWorldFixture.deliveryOrder.material.shortageQuantity} 件</b><span>同规格料真实缺口</span></div>
  <div class="stat"><b>08-10 12:30</b><span>最晚质量放行</span></div>
  <div class="stat"><b>¥17,600</b><span>恢复增量成本</span></div>
  <div class="stat"><b class="ok">08-15</b><span>目标到货日不变</span></div>
</div>
<h2>三条候选与裁决</h2>
<table>
  <tr><th>路径</th><th>已核事实</th><th>约束结果</th><th>裁决</th></tr>
  <tr><td>同规格加急 + 补班</td><td>新宁机电 400 件、08-10 09:30 到厂；IQC 预留 2.5 小时；补班 ¥6,800；TMS 08-14 18:00 车位已暂留</td><td>08-10 12:30 前质量放行即可进入恢复排产</td><td class="ok">推荐</td></tr>
  <tr><td>替代 6204-2RS</td><td>现库 120 件、仍缺 280 件；需 2 天质量确认和客户书面认可</td><td>赶不上 08-10 最晚上料门槛，且会改变客户认可规格</td><td class="deny">本轮禁用</td></tr>
  <tr><td>改期到 08-18</td><td>销售可发起正式重承诺</td><td>仅在 08-10 12:30 质量放行失败时启用</td><td class="warn">失败补偿</td></tr>
</table>
<h2>批准后写入</h2>
<table>
  <tr><th>系统</th><th>动作</th><th>写后校验</th></tr>
  <tr><td>SRM / 采购</td><td>新建新宁机电同规格 PO，金额上限 ¥42,000；华矩旧 PO 取消</td><td>新 PO 已接受、旧 PO 取消回执均存在，禁止双到货</td></tr>
  <tr><td>MRP / 生产</td><td>发布恢复排产 R2，授权补班 ¥6,800</td><td>完工目标 08-13 20:00，仍引用订单承诺版本 R3</td></tr>
  <tr><td>WMS / QMS</td><td>预留 08-10 到货与 IQC 窗口</td><td>只有检验通过后才把 400 件标为 AVAILABLE</td></tr>
  <tr><td>TMS</td><td>保留 08-14 18:00 装车位</td><td>物料放行失败则自动释放，不形成空驶</td></tr>
</table>
<div class="box">
  <b>失败补偿</b>
  <ul>
    <li>08-10 12:30 前未形成 QMS 放行回执：冻结恢复排产，不用“已到厂”冒充可用。</li>
    <li>立即把 08-18 正式重承诺方案交给销售负责人；客户书面接受前，ERP 承诺日仍为 ${demoWorldFixture.deliveryOrder.promisedDeliveryShort}。</li>
    <li>任一 PO 写入失败：停止后续动作并核对旧 PO 是否已取消，避免双买或断供。</li>
  </ul>
</div>
<p class="foot">演示回放。客户、供应商、订单、金额与回执均为虚构数据；审批前不会形成采购、补班或运输承诺。</p>
</body></html>`;

const RECOVERY_PLAN_SIZE_BYTES = new TextEncoder().encode(RECOVERY_PLAN_HTML).length;

/** 订单承诺 / 供给与质量 / 候选方案 / 执行写回 / 跨天跟踪 / 审计，共 6 个视图。 */
const PANEL_BASE: SystemPanelSnapshot = {
  title: "企业系统实况",
  live: true,
  activeView: "order",
  foot: "已连接：ERP/MRP · WMS/QMS · SRM/TMS · 合同与客户承诺（演示）",
  views: [
    {
      key: "order",
      label: "订单与承诺",
      winTitle: "ERP · 订单、合同与交付基线",
      toolbar: { title: `${demoWorldFixture.deliveryOrder.id} · ${demoWorldFixture.deliveryOrder.customer}`, sub: "尚未核对" },
      widget: {
        kind: "table",
        cols: [
          { key: "object", label: "业务对象" },
          { key: "version", label: "生效版本" },
          { key: "commitment", label: "承诺 / 门槛" },
          { key: "state", label: "状态", align: "right" },
        ],
        rows: [],
        empty: { title: "尚未读取订单与承诺" },
      },
    },
    {
      key: "supply",
      label: "供给与质量",
      winTitle: "MRP / WMS / QMS / SRM · 可信供给",
      toolbar: { title: "物料缺口与供给凭据", sub: "尚未核对" },
      widget: {
        kind: "table",
        cols: [
          { key: "source", label: "来源" },
          { key: "fact", label: "客观事实" },
          { key: "constraint", label: "约束" },
          { key: "state", label: "结论", align: "right" },
        ],
        rows: [],
        empty: { title: "尚未读取供给与质量状态" },
      },
    },
    {
      key: "options",
      label: "恢复方案",
      winTitle: "约束优化器 · 路径、代价与失败补偿",
      toolbar: { title: "交付恢复候选", sub: "尚未求解" },
      widget: {
        kind: "table",
        cols: [
          { key: "route", label: "候选路径" },
          { key: "cost", label: "增量代价" },
          { key: "deadline", label: "时间约束" },
          { key: "state", label: "裁决", align: "right" },
        ],
        rows: [],
        empty: { title: "尚未形成恢复候选" },
      },
    },
    {
      key: "execution",
      label: "执行写回",
      winTitle: "恢复执行单 · 跨系统写入与回执",
      toolbar: { title: "跨系统执行", sub: "审批前零写入" },
      widget: { kind: "rows", rows: [], empty: { title: "尚无系统写入" } },
    },
    {
      key: "monitor",
      label: "跨天跟踪",
      winTitle: "跨天跟踪 · 供应、质量、生产与物流",
      toolbar: { title: "恢复链路", sub: "尚未启动" },
      widget: { kind: "feed", items: [], empty: { title: "尚无跨天事件" } },
    },
    {
      key: "audit",
      label: "操作留痕",
      winTitle: "操作留痕 · 本次恢复案件",
      toolbar: { title: "本次会话的系统动作", sub: "0 条" },
      widget: { kind: "feed", items: [], empty: { title: "尚无系统动作" } },
    },
  ],
};

export const deliveryRecoveryScript: ReplayScript = {
  scenarioId: "catalog-order-delivery-defender-loop",
  title: "交付异常从真实缺口恢复到客户签收",
  mode: "hero",
  artifacts: { [RECOVERY_PLAN_PATH]: RECOVERY_PLAN_HTML },

  steps: [
    {
      caption: "从合同承诺倒排真实缺口",
      blocks: [
        {
          id: "rec1-prompt",
          kind: "prompt",
          title: "用户消息",
          defaultOpen: true,
          content: "周五这批订单还守得住？",
        },
        {
          id: "rec1-tool",
          kind: "tool_use",
          title: "DeliveryContextRead",
          defaultOpen: true,
          toolName: "DeliveryContextRead",
          toolId: "t-context",
          content: JSON.stringify({
            order: demoWorldFixture.deliveryOrder.id,
            sources: ["ERP", "MRP", "WMS", "QMS", "SRM", "TMS", "contract", "customer-commitment"],
          }),
          executionStatus: "completed",
          durationMs: 2280,
          presentation: {
            title: "倒排完成：周五 08-14 装车窗口守不住，缺口是真缺口",
            detail: [
              { k: "客户承诺", v: `合同 R3：${demoWorldFixture.deliveryOrder.promisedDeliveryDate} 到货 · 不接受拆单` },
              { k: "物流门槛", v: "TMS 最晚 08-14 18:00 装车，翌日到达" },
              { k: "生产门槛", v: `装配 ${demoWorldFixture.deliveryOrder.material.assemblyDays} 天 + 出货检验 1 天，物料最晚 08-10 15:00 质量放行` },
              { tree: "├", k: "MRP / WMS", v: `${demoWorldFixture.deliveryOrder.material.model} 需求 ${demoWorldFixture.deliveryOrder.material.requiredQuantity}、现库 ${demoWorldFixture.deliveryOrder.material.stockQuantity}、真实缺口 ${demoWorldFixture.deliveryOrder.material.shortageQuantity} 件` },
              { tree: "├", k: "SRM", v: `华矩 PO-2026-0886 只口头承诺 ${demoWorldFixture.deliveryOrder.material.supplierVerbalDeliveryShort} 到货，无发货与物流凭据` },
              { tree: "└", k: "QMS", v: "替代型号 6204-2RS 未批准，不能当作可用库存" },
              { insight: "当前可信供给为 0；即使华矩 08-12 真到，也晚于 08-10 最晚上料门槛 2 天", label: "真实缺口" },
            ],
            status: "warn",
            panelBase: PANEL_BASE,
            panel: [
              { op: "focus", view: "order" },
              { op: "toolbar", view: "order", title: `${demoWorldFixture.deliveryOrder.id} · 交付基线`, sub: "承诺与倒排门槛已核对" },
              { op: "tableRowInsert", view: "order", row: { id: "o-contract", cells: { object: "销售合同", version: "R3 · 生效", commitment: `${demoWorldFixture.deliveryOrder.promisedDeliveryShort} 客户到货`, state: "未变更" } } },
              { op: "tableRowInsert", view: "order", row: { id: "o-order", cells: { object: demoWorldFixture.deliveryOrder.id, version: "ERP 当前版", commitment: "08-14 18:00 装车", state: "高危" }, tone: "deny" } },
              { op: "cellFlag", view: "order", rowId: "o-order", colKey: "state", tone: "deny", flag: "缺料 2 天" },
              { op: "tableRowInsert", view: "order", row: { id: "o-mrp", cells: { object: "恢复排产", version: "尚未创建", commitment: "08-10 15:00 物料放行", state: "未满足" }, tone: "warn" } },
              { op: "feedAppend", view: "audit", item: { id: "ra-1", from: "AI 同事", time: "08-09 09:02", text: "读取 ERP/MRP、WMS/QMS、SRM/TMS、合同与客户承诺，确认 400 件同规格料真实缺口（只读）" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "1 条" },
            ],
          },
        },
        {
          id: "rec1-result",
          kind: "tool_result",
          title: "DeliveryContextRead 结果",
          defaultOpen: false,
          toolName: "DeliveryContextRead",
          toolId: "t-context",
          content: "order=SO-2026-1027 contract=R3 promised=2026-08-15 shipCutoff=2026-08-14T18:00 material=6204-RS required=400 available=0 trustedTransit=0 releaseDeadline=2026-08-10T15:00",
        },
        {
          id: "rec1-text",
          kind: "text",
          title: "当前判断",
          defaultOpen: true,
          content: `如果你说的是周五 08-14 的装车窗口，**按当前状态守不住**。${demoWorldFixture.deliveryOrder.id} 对 ${demoWorldFixture.deliveryOrder.customer} 的正式承诺仍是 ${demoWorldFixture.deliveryOrder.promisedDeliveryShort} 到货；倒排后，${demoWorldFixture.deliveryOrder.material.model} 最晚要在 08-10 15:00 完成质量放行，但目前可信可用量是 0。华矩口头说 ${demoWorldFixture.deliveryOrder.material.supplierVerbalDeliveryShort} 到，不仅没有发货凭据，即使真到也晚 2 天。下面我让规则与优化器先求可行路径，再只解释需要跨部门决定的例外。`,
        },
      ],
    },

    {
      caption: "规则与优化器求出三条路径",
      blocks: [
        {
          id: "rec2-tool",
          kind: "tool_use",
          title: "DeliveryRecoveryOptimize",
          defaultOpen: true,
          toolName: "DeliveryRecoveryOptimize",
          toolId: "t-optimize",
          content: JSON.stringify({
            order: demoWorldFixture.deliveryOrder.id,
            objective: "keep-customer-commitment",
            hardConstraints: ["same-spec-or-customer-approval", "quality-release-before-use", "no-double-supply", "tms-cutoff"],
          }),
          executionStatus: "completed",
          durationMs: 1840,
          presentation: {
            title: "约束求解：1 条可恢复、1 条不满足规格门槛、1 条改期兜底",
            detail: [
              { verdict: "pass", text: "A · 同规格加急采购 + 补班", note: "若 08-10 12:30 前质量放行 400 件，08-13 20:00 可完工，08-14 18:00 可装车" },
              { verdict: "fail", text: "B · 替代 6204-2RS", note: "现库仅 120 件，补量后仍需 2 天质量确认和客户书面认可，赶不上最晚上料门槛" },
              { verdict: "pending", text: "C · 正式重承诺到 08-18", note: "物料恢复失败时的补偿路径；必须由销售取得客户书面接受，不能先改 ERP 日期" },
              { k: "优化器只做什么", v: "倒排、资源约束、成本与可行性求解" },
              { k: "Agent 只解释什么", v: "旧 PO 取消、质量放行、补班授权、客户规格与对外承诺之间的跨系统例外" },
            ],
            status: "warn",
            panel: [
              { op: "focus", view: "options" },
              { op: "toolbar", view: "options", title: "交付恢复候选 · 初次求解", sub: "可恢复 1 · 不可行 1 · 兜底 1" },
              { op: "tableRowInsert", view: "options", row: { id: "opt-a", cells: { route: "A 同规格加急 + 补班", cost: "待询证", deadline: "08-10 12:30 放行", state: "条件可行" } } },
              { op: "cellFlag", view: "options", rowId: "opt-a", colKey: "state", tone: "pass", flag: "优先询证" },
              { op: "tableRowInsert", view: "options", row: { id: "opt-b", cells: { route: "B 替代 6204-2RS", cost: "需补量与验证", deadline: "至少晚 2 天", state: "不可行" }, tone: "deny" } },
              { op: "cellFlag", view: "options", rowId: "opt-b", colKey: "state", tone: "deny", flag: "规格门槛" },
              { op: "tableRowInsert", view: "options", row: { id: "opt-c", cells: { route: "C 重承诺 08-18", cost: "客户影响", deadline: "需书面接受", state: "失败兜底" } } },
              { op: "feedAppend", view: "audit", item: { id: "ra-2", from: "约束优化器", time: "08-09 09:03", text: "按合同 R3、工艺时长、质量门槛、供给与运输窗口求解 3 条恢复路径" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "2 条" },
            ],
          },
        },
        {
          id: "rec2-text",
          kind: "text",
          title: "跨系统例外",
          defaultOpen: true,
          content: "优化器给出的 A 路径只是“数学上可行”，还不能执行。它同时要求四件事成立：新供应商同规格料按时到厂、QMS 在 12:30 前放行、华矩旧 PO 取消避免双到货、生产接受 ¥6,800 补班并保住 TMS 车位。我现在并行向这些系统和责任方询证；拿不到客观回执的条件，不会包装成方案。",
        },
      ],
    },

    {
      caption: "并行询证供给、调拨、质量、产能与运力",
      blocks: [
        {
          id: "rec3-tool",
          kind: "tool_use",
          title: "RecoveryInquiryFanout",
          defaultOpen: true,
          toolName: "RecoveryInquiryFanout",
          toolId: "t-inquiry",
          content: JSON.stringify({
            order: demoWorldFixture.deliveryOrder.id,
            inquiries: ["same-spec-supply", "old-po-cancel", "warehouse-transfer", "substitute-release", "iqc-slot", "overtime", "transport-slot"],
            commitment: "non-binding-inquiry-only",
          }),
          executionStatus: "completed",
          durationMs: 3260,
          presentation: {
            title: "7 路询证回齐：A 路径可执行，B 路径保持关闭",
            detail: [
              { verdict: "pass", text: "新宁机电 · 同规格 6204-RS 400 件", note: "¥105/件，合计 ¥42,000；08-10 09:30 专车到厂；批次证书已回传；报价保留至 11:00" },
              { verdict: "pass", text: "华矩传动 · 旧 PO-2026-0886", note: "确认尚未发货；08-09 10:30 前取消免违约，已给取消回执草案" },
              { verdict: "fail", text: "跨仓调拨", note: "三处仓库同规格可用量均为 0；不能用别的仓库名掩盖真实缺口" },
              { verdict: "fail", text: "替代 6204-2RS", note: "QMS 仍未放行，且客户认可缺失；本轮不启用" },
              { verdict: "pass", text: "QMS / 生产 / TMS", note: "IQC 09:45—12:15 已预留；补班 ¥6,800 可 08-13 20:00 完工；08-14 18:00 车位暂留" },
              { insight: "增量成本 ¥17,600：同规格采购价差 ¥10,800 + 补班 ¥6,800；不改变客户认可规格，也不改交期", label: "可执行方案" },
            ],
            status: "ok",
            receipt: { id: "INQ-1027-0809", system: "供应商协同与内部询证", readBack: true },
            panel: [
              { op: "focus", view: "supply" },
              { op: "toolbar", view: "supply", title: "供给与质量 · 询证回齐", sub: "同规格可恢复 · 调拨 0 · 替代禁用" },
              { op: "tableRowInsert", view: "supply", row: { id: "sup-old", cells: { source: "华矩 · PO-0886", fact: "尚未发货", constraint: "10:30 前可无责取消", state: "可取消" } } },
              { op: "tableRowInsert", view: "supply", row: { id: "sup-new", cells: { source: "新宁 · 同规格", fact: "400 件 · 08-10 09:30", constraint: "¥42,000 · 11:00 失效", state: "已询证" }, tone: "pass" } },
              { op: "cellFlag", view: "supply", rowId: "sup-new", colKey: "state", tone: "pass", flag: "批次证书齐" },
              { op: "tableRowInsert", view: "supply", row: { id: "sup-transfer", cells: { source: "三处仓库调拨", fact: "同规格可用量 0", constraint: "无可调拨库存", state: "关闭" } } },
              { op: "tableRowInsert", view: "supply", row: { id: "sup-alt", cells: { source: "6204-2RS 替代", fact: "现库 120", constraint: "QMS + 客户认可缺失", state: "禁用" }, tone: "deny" } },
              { op: "tableRowInsert", view: "supply", row: { id: "sup-qms", cells: { source: "QMS / 生产 / TMS", fact: "IQC、补班、车位均有窗口", constraint: "须先审批再占用", state: "待授权" } } },
              { op: "tableRowUpdate", view: "options", id: "opt-a", set: { cells: { cost: "增量 ¥17,600", state: "已核可执行" } } },
              { op: "cellFlag", view: "options", rowId: "opt-a", colKey: "state", tone: "pass", flag: "推荐" },
              { op: "feedAppend", view: "audit", item: { id: "ra-3", from: "AI 同事", time: "08-09 09:11", text: "并行完成供给、旧 PO、调拨、替代、IQC、补班与运输 7 路询证；尚未创建 PO 或占用资源" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "3 条" },
            ],
          },
        },
        {
          id: "rec3-text",
          kind: "text",
          title: "询证结论",
          defaultOpen: true,
          content: "现在 A 路径已经从“可能”变成“可执行”：同规格料、质量窗口、产能和车位都有明确对象与时点，旧 PO 也能无责取消。跨仓调拨没有货，替代料缺 QMS 与客户认可，我把这两条关掉；不会为了显得方案多而把不可行路线也送你审批。当前仍是询证态，采购单 0 张、补班 0 小时、正式车位 0 个。",
        },
      ],
    },

    {
      caption: "形成带失败补偿的恢复执行单",
      blocks: [
        {
          id: "rec4-tool",
          kind: "tool_use",
          title: "RecoveryPlanBuild",
          defaultOpen: true,
          toolName: "RecoveryPlanBuild",
          toolId: "t-plan",
          content: JSON.stringify({
            order: demoWorldFixture.deliveryOrder.id,
            selectedRoute: "same-spec-expedite-and-overtime",
            incrementalCost: 17_600,
            fallback: "customer-recommit-2026-08-18-if-qms-not-released-by-2026-08-10T12:30",
          }),
          executionStatus: "completed",
          durationMs: 980,
          presentation: {
            title: "恢复执行单已生成，所有写动作停在联审前",
            detail: [
              { k: "推荐路径", v: "新宁同规格加急 400 件 + 生产补班 + 保留 08-14 车位" },
              { k: "授权金额", v: "采购 ¥42,000 + 补班 ¥6,800；相对原计划增量 ¥17,600" },
              { k: "硬门槛", v: "08-10 12:30 前 QMS 必须回读 RELEASED；到厂不等于可用" },
              { tree: "├", k: "旧 PO", v: "新 PO 创建前先取得华矩取消回执，禁止双到货" },
              { tree: "└", k: "失败补偿", v: "门槛失守即冻结排产与车位，转销售办理 08-18 正式重承诺" },
              { k: "当前系统写入", v: "采购 0 · 补班 0 · 正式车位 0 · 客户承诺未变" },
            ],
            status: "waiting",
            panel: [
              { op: "focus", view: "options" },
              { op: "toolbar", view: "options", title: "交付恢复候选 · 已收口", sub: "推荐 1 · 禁用 1 · 失败兜底 1" },
              { op: "tableRowUpdate", view: "options", id: "opt-a", set: { cells: { state: "等待联审" } } },
              { op: "cellFlag", view: "options", rowId: "opt-a", colKey: "state", tone: "warn", flag: "未执行" },
              { op: "feedAppend", view: "audit", item: { id: "ra-4", from: "AI 同事", time: "08-09 09:14", text: "生成交付恢复执行单，绑定金额、门槛、写入顺序与失败补偿；业务系统零写入" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "4 条" },
            ],
          },
        },
        {
          id: "rec4-text",
          kind: "text",
          title: "恢复执行单",
          defaultOpen: true,
          content: [
            "我把可执行路径、金额、系统写入顺序和失败补偿放在一张执行单里。它不是一份分析报告：下一步批准后会按这些对象 ID 真正写回；退回则一项都不写。",
            "",
            `[FILE]{"filePath":"${RECOVERY_PLAN_PATH}","fileName":"恒岳重工交付恢复执行单.html","fileSize":${RECOVERY_PLAN_SIZE_BYTES}}[/FILE]`,
            "",
            `恢复目标仍是 ${demoWorldFixture.deliveryOrder.promisedDeliveryShort} 到货，不通过改 ERP 日期让风险消失。`,
          ].join("\n"),
        },
      ],
    },

    {
      caption: "采购与计划做一次最窄联审后执行",
      blocks: [],
      approval: {
        title: "交付恢复执行 · 采购与计划联审",
        description: "确认后才会取消旧 PO、创建同规格加急 PO、发布恢复排产并锁定运输窗口。客户规格与交期不变，不需要质量或销售替你批准；QMS 仍以客观检验结果独立放行。",
        facts: [
          { label: "订单", value: `${demoWorldFixture.deliveryOrder.id} · ${demoWorldFixture.deliveryOrder.customer} · ¥${demoWorldFixture.deliveryOrder.amountWan.toFixed(1)} 万 · 承诺 ${demoWorldFixture.deliveryOrder.promisedDeliveryShort}` },
          { label: "采购授权", value: "新宁 6204-RS 400 件，上限 ¥42,000；先取得华矩 PO-2026-0886 取消回执" },
          { label: "生产授权", value: "补班 ¥6,800；仅在 QMS 08-10 12:30 前放行后启用" },
          { label: "失败补偿", value: "QMS 门槛失守则冻结排产、释放车位，并把 08-18 重承诺方案交销售办理" },
          { label: "明确不做", value: "不启用替代料、不改 BOM、不改 ERP 承诺日、不直接向客户承诺新日期" },
        ],
        approveLabel: "联审通过并执行",
        rejectLabel: "退回调整",
        approvedBlocks: [
          {
            id: "rec5-human",
            kind: "prompt",
            title: "用户消息",
            defaultOpen: true,
            content: "联审通过：同规格加急采购上限 ¥42,000，补班 ¥6,800；先取消华矩旧 PO，再创建新宁新 PO。QMS 过了才能上料，过不了就停住转 08-18 重承诺，别自己改客户日期。",
          },
          {
            id: "rec5-approval",
            kind: "tool_use",
            title: "Approval",
            defaultOpen: true,
            toolName: "Approval",
            toolId: "t-approval",
            content: JSON.stringify({
              order: demoWorldFixture.deliveryOrder.id,
              decision: "approved",
              purchaseCap: 42_000,
              overtimeCap: 6_800,
              qmsGate: "2026-08-10T12:30:00+08:00",
            }),
            executionStatus: "completed",
            durationMs: 360,
            presentation: {
              title: "恢复方案联审通过，授权边界已绑定",
              detail: [
                { verdict: "pass", text: "采购授权", note: "同规格 400 件，上限 ¥42,000；旧 PO 取消回执是新 PO 的前置条件" },
                { verdict: "pass", text: "生产授权", note: "补班上限 ¥6,800；QMS 未放行则不得启用" },
                { verdict: "pass", text: "失败补偿", note: "08-10 12:30 门槛失守即停，转 08-18 正式重承诺" },
                { verdict: "pass", text: "未授权", note: "替代料、BOM 变更、客户交期变更均不在本次授权内" },
              ],
              status: "ok",
              receipt: { id: "APR-DR-1027-0809", system: "审批中心", readBack: true },
              panel: [
                { op: "focus", view: "execution" },
                { op: "toolbar", view: "execution", title: "跨系统执行", sub: "联审通过 · 正在按前置关系写入" },
                { op: "rowInsert", view: "execution", row: { id: "ex-approval", text: "审批 APR-DR-1027-0809", sub: "采购上限 ¥42,000 · 补班上限 ¥6,800 · QMS 门槛 08-10 12:30", tone: "pass", badge: { text: "已回读", tone: "pass" } } },
                { op: "feedAppend", view: "audit", item: { id: "ra-5", from: "采购负责人 刘志强 / 计划负责人 吴国栋", time: "08-09 09:22", text: "联审通过交付恢复方案；替代料、BOM 与客户交期变更未授权" } },
                { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "5 条" },
              ],
            },
          },
          {
            id: "rec5-execute",
            kind: "tool_use",
            title: "DeliveryRecoveryExecute",
            defaultOpen: true,
            toolName: "DeliveryRecoveryExecute",
            toolId: "t-execute",
            content: JSON.stringify({
              order: demoWorldFixture.deliveryOrder.id,
              sequence: ["cancel-PO-2026-0886", "create-PO-2026-0912", "publish-MRP-R2", "reserve-IQC", "reserve-TMS"],
              idempotencyKey: "DR-SO-2026-1027-R1",
            }),
            executionStatus: "completed",
            durationMs: 2440,
            presentation: {
              title: "5 项写入完成并逐项回读，恢复链路进入跨天等待",
              detail: [
                { verdict: "pass", text: "SRM · 华矩旧 PO 已取消", note: "回执 CN-PO-0886；尚未发货，取消费用 ¥0" },
                { verdict: "pass", text: "采购 · 新宁新 PO 已接受", note: "PO-2026-0912 · 6204-RS 400 件 · ¥42,000 · 08-10 09:30 到厂" },
                { verdict: "pass", text: "MRP · 恢复排产 R2 已发布", note: "引用合同 R3；只有 QMS RELEASED 才启用补班与上料" },
                { verdict: "pass", text: "QMS / TMS · 窗口已锁定", note: "IQC 09:45—12:15；08-14 18:00 车位 TS-814-27" },
                { insight: "采购、排产、质量和运输已进入同一个恢复案件；当前仍不能宣称物料可用", label: "执行状态" },
              ],
              status: "waiting",
              receipt: { id: "DR-SO-2026-1027-R1", system: "交付恢复台账", readBack: true },
              panel: [
                { op: "focus", view: "execution" },
                { op: "toolbar", view: "execution", title: "跨系统执行", sub: "5 项写入已回读 · 等待 08-10 到货与 QMS" },
                { op: "rowInsert", view: "execution", row: { id: "ex-old-po", text: "SRM · PO-2026-0886 已取消", sub: "回执 CN-PO-0886 · 尚未发货 · 取消费用 ¥0", tone: "pass", badge: { text: "已回读", tone: "pass" } } },
                { op: "rowInsert", view: "execution", row: { id: "ex-new-po", text: "采购 · PO-2026-0912 已创建", sub: "新宁机电 · 同规格 400 件 · ¥42,000 · 08-10 09:30", tone: "pass", badge: { text: "供应商已接受", tone: "pass" } } },
                { op: "rowInsert", view: "execution", row: { id: "ex-mrp", text: "MRP · 恢复排产 R2 已发布", sub: "QMS RELEASED 是补班与上料前置门槛", tone: "info", badge: { text: "条件生效", tone: "info" } } },
                { op: "rowInsert", view: "execution", row: { id: "ex-slots", text: "QMS / TMS · 两个窗口已锁定", sub: "IQC 08-10 09:45—12:15 · 车位 TS-814-27", tone: "info", badge: { text: "待事件", tone: "pending" } } },
                { op: "toolbar", view: "monitor", title: "恢复链路", sub: "跨天等待已启动 · 下个门槛 08-10 12:30" },
                { op: "feedAppend", view: "monitor", item: { id: "mon-start", from: "交付恢复台账", time: "08-09 09:24", text: "恢复案件 DR-SO-2026-1027-R1 已启动", card: { title: "等待客观终态", body: "到厂 → IQC 放行 → 生产完工 → TMS 装车 → 客户签收；任一门槛失守都会停住并升级", meta: [{ text: "持续等待", tone: "info" }, { text: "可恢复", tone: "pass" }] } } },
                { op: "tableRowUpdate", view: "order", id: "o-mrp", set: { cells: { version: "R2 · 已发布", state: "等待 QMS" } } },
                { op: "feedAppend", view: "audit", item: { id: "ra-6", from: "AI 同事", time: "08-09 09:24", text: "按前置关系取消旧 PO、创建新 PO、发布 MRP R2、锁定 IQC 与 TMS 窗口，并逐项回读" } },
                { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "6 条" },
              ],
            },
          },
        ],
        rejectedBlocks: [
          {
            id: "rec5-reject",
            kind: "tool_use",
            title: "ApprovalReject",
            defaultOpen: true,
            toolName: "ApprovalReject",
            toolId: "t-reject",
            content: JSON.stringify({ order: demoWorldFixture.deliveryOrder.id, decision: "rejected" }),
            executionStatus: "completed",
            durationMs: 240,
            presentation: {
              title: "恢复方案被退回，所有跨系统动作保持关闭",
              detail: [
                { verdict: "pass", text: "采购系统零写入", note: "华矩旧 PO 未取消，新宁新 PO 未创建" },
                { verdict: "pass", text: "生产与质量零占用", note: "补班未启用，IQC 窗口未锁定" },
                { verdict: "pass", text: "运输与客户承诺未动", note: "TMS 车位未锁，ERP 仍为 08-15" },
                { warn: "询证与执行单保留；修改金额、路径或失败门槛后必须重新联审" },
              ],
              status: "blocked",
              panel: [
                { op: "focus", view: "execution" },
                { op: "toolbar", view: "execution", title: "跨系统执行", sub: "方案已退回 · 零写入" },
                { op: "rowsSet", view: "execution", rows: [
                  { id: "ex-reject", text: "执行链路未启动", sub: "旧 PO 未取消 · 新 PO 未创建 · 补班 / IQC / TMS 均未占用", tone: "warn", badge: { text: "已停住", tone: "warn" } },
                ] },
                { op: "feedAppend", view: "audit", item: { id: "ra-reject", from: "联审人", time: "08-09 09:22", text: "交付恢复方案被退回：采购、生产、质量、运输和客户承诺均零写入" } },
                { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "5 条" },
              ],
            },
          },
          {
            id: "rec5-reject-text",
            kind: "text",
            title: "退回说明",
            defaultOpen: true,
            content: "已停在联审点：华矩旧 PO 没取消，新宁新 PO 没创建，补班、IQC 和车位都没有占用，客户承诺仍是 08-15。询证证据和执行单保留；改完金额、路径或失败门槛后，需要重新提交，不能沿用这次被退回的授权。",
          },
        ],
      },
    },

    {
      caption: "跨天等待到物料可用、生产完工和物流签收",
      blocks: [
        {
          id: "rec6-tool",
          kind: "tool_use",
          title: "RecoveryMonitorResume",
          defaultOpen: true,
          toolName: "RecoveryMonitorResume",
          toolId: "t-monitor",
          content: JSON.stringify({
            caseId: "DR-SO-2026-1027-R1",
            checkpoints: ["supplier-arrival", "qms-release", "production-complete", "tms-departure", "customer-pod"],
          }),
          executionStatus: "completed",
          durationMs: 3180,
          presentation: {
            title: "跨天恢复完成：物料客观可用，原承诺日客户已签收",
            detail: [
              { verdict: "pass", text: "08-10 09:26 · 同规格料到厂", note: "到货单 GR-6204-0810；型号、数量与 PO 一致，但此时仍未记为可用" },
              { verdict: "pass", text: "08-10 12:08 · QMS 放行", note: "IQC-6204-0810 检验通过；WMS AVAILABLE 400；MRP 已分配到本订单" },
              { verdict: "pass", text: "08-13 20:06 · 生产完工", note: "2,400 件全部完工；出货检验 08-14 10:20 通过" },
              { verdict: "pass", text: "08-14 17:42 · TMS 装车离厂", note: "车位 TS-814-27；运单 WB-814-1027；预计 08-15 14:00" },
              { verdict: "pass", text: "08-15 14:32 · 客户签收", note: "POD-1027-0815；数量 2,400，异常 0；没有触发改期分支" },
              { insight: "终态来自 WMS/QMS、MRP、TMS 和客户 POD 的独立回执，不用“任务完成”代替业务完成", label: "恢复结果" },
            ],
            status: "ok",
            receipt: { id: "POD-1027-0815", system: "TMS · 客户签收回执", readBack: true },
            panel: [
              { op: "focus", view: "monitor" },
              { op: "toolbar", view: "monitor", title: "恢复链路 · 已完成", sub: "物料已放行 · 已完工 · 已签收" },
              { op: "feedAppend", view: "monitor", item: { id: "mon-arrive", from: "WMS", time: "08-10 09:26", text: "新宁同规格 6204-RS 400 件到厂；GR-6204-0810 已收货，等待 IQC" } },
              { op: "feedAppend", view: "monitor", item: { id: "mon-qms", from: "QMS / WMS", time: "08-10 12:08", text: "IQC-6204-0810 检验通过；WMS 状态 AVAILABLE 400，MRP 已分配", card: { title: "物料已客观可用", body: "不是“供应商说到了”，而是 QMS 放行 + WMS 可用量 + MRP 分配三方回读一致", meta: [{ text: "RELEASED", tone: "pass" }, { text: "400 件", tone: "info" }] } } },
              { op: "feedAppend", view: "monitor", item: { id: "mon-production", from: "MRP / QMS", time: "08-14 10:20", text: "08-13 20:06 完工 2,400 件；08-14 10:20 出货检验通过" } },
              { op: "feedAppend", view: "monitor", item: { id: "mon-tms", from: "TMS", time: "08-14 17:42", text: "运单 WB-814-1027 已装车离厂；车位 TS-814-27 正常兑现" } },
              { op: "feedAppend", view: "monitor", item: { id: "mon-pod", from: demoWorldFixture.deliveryOrder.customer, time: "08-15 14:32", text: "签收回执 POD-1027-0815：2,400 件，异常 0", card: { title: "原承诺已兑现", body: "客户在 08-15 正式签收；08-18 重承诺分支未触发", meta: [{ text: "已签收", tone: "pass" }] } } },
              { op: "tableRowUpdate", view: "order", id: "o-order", set: { cells: { state: "已签收" }, tone: "pass" } },
              { op: "cellFlag", view: "order", rowId: "o-order", colKey: "state", tone: "pass", flag: "08-15" },
              { op: "tableRowUpdate", view: "order", id: "o-mrp", set: { cells: { state: "R2 已完成" }, tone: "pass" } },
              { op: "feedAppend", view: "audit", item: { id: "ra-7", from: "持续运行器", time: "08-15 14:33", text: "跨天恢复案件完成：QMS/WMS 物料可用、MRP 完工、TMS 离厂、客户 POD 签收均取得独立回执" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "7 条" },
            ],
          },
        },
        {
          id: "rec6-result",
          kind: "tool_result",
          title: "RecoveryMonitorResume 结果",
          defaultOpen: false,
          toolName: "RecoveryMonitorResume",
          toolId: "t-monitor",
          content: "case=DR-SO-2026-1027-R1 qms=RELEASED wmsAvailable=400 mrp=COMPLETED tms=DEPARTED pod=POD-1027-0815 recommitBranch=NOT_TRIGGERED",
        },
        {
          id: "rec6-text",
          kind: "text",
          title: "跨天结果",
          defaultOpen: true,
          content: "恢复链路已经越过了三个不能靠文案冒充的终态：08-10 QMS 放行后 WMS 才把 400 件标为 AVAILABLE；08-13 生产实际完工；08-15 客户用 POD-1027-0815 签收 2,400 件。原承诺守住了，所以 08-18 重承诺分支没有触发。最后我不用本轮缓存，再按对象 ID 反查各系统是否说法一致。",
        },
      ],
    },

    {
      caption: "独立回读跨系统终态",
      blocks: [
        {
          id: "rec7-tool",
          kind: "tool_use",
          title: "DeliveryRecoveryReadBack",
          defaultOpen: true,
          toolName: "DeliveryRecoveryReadBack",
          toolId: "t-readback",
          content: JSON.stringify({
            order: demoWorldFixture.deliveryOrder.id,
            caseId: "DR-SO-2026-1027-R1",
            receipts: ["CN-PO-0886", "PO-2026-0912", "IQC-6204-0810", "MRP-R2", "WB-814-1027", "POD-1027-0815"],
            useSessionCache: false,
          }),
          executionStatus: "completed",
          durationMs: 1460,
          presentation: {
            title: "六处权威记录回读一致，恢复案件可关闭",
            detail: [
              { k: "回读方式", v: "按订单、PO、批次、排产、运单和 POD 独立反查，不使用本轮缓存" },
              { verdict: "pass", text: "合同 / ERP", note: `承诺版本仍为 R3，${demoWorldFixture.deliveryOrder.promisedDeliveryShort} 到货；没有用改日期消除风险` },
              { verdict: "pass", text: "SRM / 采购", note: "旧 PO-2026-0886 已取消，新 PO-2026-0912 已完成；无重复到货与重复应付" },
              { verdict: "pass", text: "QMS / WMS / MRP", note: "400 件同规格料检验放行并消耗；恢复排产 R2 完成 2,400 件" },
              { verdict: "pass", text: "TMS / 客户", note: "WB-814-1027 已离厂，POD-1027-0815 于 08-15 14:32 签收，异常 0" },
              { verdict: "pass", text: "失败补偿", note: "08-18 重承诺分支未触发；客户侧没有第二个 ETA" },
              { insight: "供给、质量、生产、物流和客户承诺一致；案件 DR-SO-2026-1027-R1 关闭", label: "终态" },
            ],
            status: "ok",
            receipt: { id: "CLOSE-DR-1027-R1", system: "交付恢复台账", readBack: true },
            panel: [
              { op: "focus", view: "order" },
              { op: "toolbar", view: "order", title: `${demoWorldFixture.deliveryOrder.id} · 终态回读`, sub: "合同、订单、供给、生产、物流与 POD 一致" },
              { op: "tableRowUpdate", view: "order", id: "o-contract", set: { cells: { state: "已兑现" }, tone: "pass" } },
              { op: "cellFlag", view: "order", rowId: "o-contract", colKey: "state", tone: "pass", flag: "POD 08-15" },
              { op: "toolbar", view: "execution", title: "跨系统执行", sub: "恢复案件已关闭 · 六处回执一致" },
              { op: "rowInsert", view: "execution", row: { id: "ex-close", text: "案件 DR-SO-2026-1027-R1 已关闭", sub: "旧 PO 取消 · 新 PO 完成 · QMS 放行 · MRP 完工 · TMS 离厂 · 客户签收", tone: "pass", badge: { text: "终态一致", tone: "pass" } } },
              { op: "feedAppend", view: "audit", item: { id: "ra-8", from: "AI 同事", time: "08-15 14:35", text: "独立回读合同/ERP、SRM/采购、QMS/WMS/MRP、TMS/POD，六处记录一致；关闭恢复案件" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "8 条" },
            ],
          },
        },
        {
          id: "rec7-text",
          kind: "text",
          title: "本次恢复改变了什么",
          defaultOpen: true,
          content: [
            "## 本次恢复改变了什么",
            "",
            "| 系统 | 权威终态 | 核对依据 |",
            "| --- | --- | --- |",
            `| 合同 / ERP | ${demoWorldFixture.deliveryOrder.id} 仍引用合同 R3，承诺 ${demoWorldFixture.deliveryOrder.promisedDeliveryShort}，已兑现 | 客户 POD-1027-0815，08-15 14:32 签收 |`,
            "| SRM / 采购 | 华矩 PO-2026-0886 已取消；新宁 PO-2026-0912 已完成 | CN-PO-0886 + PO 收货/结算状态；无双到货、无重复应付 |",
            `| QMS / WMS | ${demoWorldFixture.deliveryOrder.material.model} 400 件检验通过并由 AVAILABLE 转为已消耗 | IQC-6204-0810；不是用“已到厂”冒充可用 |`,
            "| MRP / 生产 | 恢复排产 R2 实际完成 2,400 件，出货检验通过 | 完工 08-13 20:06；出货检验 08-14 10:20 |",
            "| TMS / 客户 | 运单已离厂，客户按原承诺签收，异常 0 | WB-814-1027 + POD-1027-0815 |",
            "| 失败补偿 | 08-18 正式重承诺分支未触发 | QMS 在 08-10 12:30 门槛前放行；客户侧只有一个 ETA |",
            "",
            "## 本次恢复没有做什么",
            "",
            "- 没有修改客户承诺日来消除系统里的红灯：合同和 ERP 始终保持 08-15，最终用客户签收证明兑现；",
            "- 没有启用 6204-2RS、修改 BOM 或代替客户认可规格：替代路径因 QMS 与客户门槛不满足而保持关闭；",
            "- 没有把供应商口头承诺、物料到厂或任务已完成写成业务终态：只有 QMS RELEASED + WMS AVAILABLE 才算物料客观可用；",
            "- 没有让两张 PO 同时生效：先回读华矩取消，再创建新宁 PO，最终无重复库存和重复应付；",
            "- 没有让 Agent 决定确定性的排产与成本结果：规则与优化器给候选，采购和计划只批准金额与资源，Agent 负责解释并追完跨系统例外。",
          ].join("\n"),
        },
      ],
    },
  ],

  sources: [
    {
      blockRef: "step1.tool.DeliveryContextRead",
      producer: "ERP/MRP、WMS/QMS、SRM/TMS 与合同承诺连接器",
      state: "missing",
      gap: "当前没有能按统一订单 ID 和生效版本关联合同承诺、可信供给、质量状态、排产门槛与物流窗口的租户连接器。",
    },
    {
      blockRef: "step2.tool.DeliveryRecoveryOptimize",
      producer: "可版本化交付约束规则与恢复优化器",
      state: "missing",
      gap: "工艺时长、质量门槛、供应约束、资源成本和失败补偿尚未产品化为可版本化的确定性规则与求解器。",
    },
    {
      blockRef: "step3.tool.RecoveryInquiryFanout",
      producer: "供应商协同、跨仓库存、QMS、排产与 TMS 并行询证器",
      state: "missing",
      gap: "缺少跨七类对象并行询证、区分非约束性询问与正式承诺、并把每条回执绑定到同一恢复案件的能力。",
    },
    {
      blockRef: "step4.tool.RecoveryPlanBuild",
      producer: "Agent 生成交付恢复执行单",
      state: "exists",
    },
    {
      blockRef: "step4.artifact.恒岳重工交付恢复执行单",
      producer: "Agent 生成自包含 HTML 产物",
      state: "exists",
    },
    {
      blockRef: "step5.tool.Approval",
      producer: "业务审批执行器",
      state: "needs-change",
      gap: "现有审批能记录同意或退回，但还不能结构化绑定采购金额、补班上限、QMS 时间门槛、失败补偿与未授权动作。",
    },
    {
      blockRef: "step5.tool.DeliveryRecoveryExecute",
      producer: "跨系统幂等写入与补偿编排器",
      state: "missing",
      gap: "缺少旧 PO 取消成功后再建新 PO、条件排产、质量门禁、运力占用以及部分失败时自动停住和补偿的统一执行器。",
    },
    {
      blockRef: "step5.tool.ApprovalReject",
      producer: "业务审批执行器（退回分支）",
      state: "needs-change",
      gap: "退回事件存在，但采购、生产、质量、运输和客户承诺五处零写入尚不能形成统一可验证回执。",
    },
    {
      blockRef: "step6.tool.RecoveryMonitorResume",
      producer: "持久恢复案件与跨天事件续跑器",
      state: "missing",
      gap: "当前缺少按业务对象持久等待多天、跨会话从供应到 QMS、生产、TMS 与 POD 逐门槛恢复并在失败时切换补偿分支的运行时。",
    },
    {
      blockRef: "step7.tool.DeliveryRecoveryReadBack",
      producer: "交付恢复终态独立回读器",
      state: "missing",
      gap: "需要稳定的合同 revision、PO、检验批、排产版本、运单和 POD 对象 ID，以及不依赖会话缓存的跨系统一致性断言。",
    },
  ],
};

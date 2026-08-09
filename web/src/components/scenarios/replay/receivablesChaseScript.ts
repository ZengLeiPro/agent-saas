import type { SystemPanelSnapshot } from "@agent/shared";
import { demoWorldFixture } from "./demoWorldFixture";
import type { ReplayScript } from "./types";

/**
 * 钩子场景 H5：哪些应收该催了，顺手把催款话术拟好。
 *
 * 岗位视角是财务陈静，四要素按参照实现（complianceGateScript）的骨架落位：
 *   ① 主动拒绝——第 4 步「直接发给客户」被拦下，对外催收必须先跟销售对齐再走审批；
 *   ② 视角切换——第 5 步产物就是客户项目经理此刻在自己邮箱里看到的那封函；
 *   ③ 跨系统核对——终态用一张表把应收台账 / 企业邮箱 / CRM 三边说法摆在一起；
 *   ④ 可下载产物——对账催款函 HTML，右侧预览 + 本地下载。
 * 外加两条：人可以改掉 AI 的结论并被记账（第 6 步销售补了一句话），退回不是死路。
 *
 * 内容为虚构示例，不对应任何真实企业、往来款或函件。
 */

const DUNNING_LETTER_PATH = "assets/demo/对账催款函-蓝谷自动化.html";

const DUNNING_LETTER_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<style>
  :root { --brand: #2E56E1; --ink: #0f172a; --muted: #64748b; --line: #e2e8f0; --ok: #15803d; --warn: #b45309; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 20px; font: 14px/1.7 "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; color: var(--ink); background: #f1f5f9; }
  .mail { max-width: 760px; margin: 0 auto; background: #fff; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
  .bar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: #f8fafc; border-bottom: 1px solid var(--line); color: var(--muted); font-size: 12px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #cbd5e1; }
  .unread { margin-left: auto; color: var(--brand); font-weight: 600; }
  .head { padding: 16px 20px 12px; border-bottom: 1px solid var(--line); }
  h1 { margin: 0 0 10px; font-size: 16px; line-height: 1.5; }
  .kv { display: grid; grid-template-columns: 60px 1fr; gap: 4px 12px; font-size: 12px; }
  .kv span:nth-child(odd) { color: var(--muted); }
  .body { padding: 16px 20px 20px; }
  .body p { margin: 0 0 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin: 4px 0 14px; }
  th, td { border: 1px solid var(--line); padding: 7px 10px; text-align: left; vertical-align: top; }
  th { background: #f8fafc; color: var(--muted); font-weight: 500; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .warn { color: var(--warn); font-weight: 600; }
  .total td { background: #f8fafc; font-weight: 600; }
  .box { border: 1px solid var(--line); border-left: 3px solid var(--brand); border-radius: 6px; padding: 10px 12px; margin-bottom: 14px; font-size: 13px; }
  .box b { font-weight: 600; }
  .sign { color: var(--muted); font-size: 13px; }
  .foot { margin: 0; padding: 10px 20px 16px; color: var(--muted); font-size: 12px; border-top: 1px solid var(--line); }
</style></head><body>
<div class="mail">
  <div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span>收件箱 · 顾云帆（蓝谷自动化 项目部）</span><span class="unread">未读 · 今天 10:41</span></div>

  <div class="head">
    <h1>【对账函】AR-2026-0058 · 截至 ${demoWorldFixture.demoDate.iso} 应收余额 ¥236,000.00</h1>
    <div class="kv">
      <span>发件人</span><span>陈静 · 澜达精密制造有限公司 财务部</span>
      <span>收件人</span><span>顾云帆 · 蓝谷自动化 项目部</span>
      <span>抄送</span><span>张明远 · 澜达精密制造有限公司 销售部</span>
      <span>时间</span><span>${demoWorldFixture.demoDate.iso} 10:41</span>
    </div>
  </div>

  <div class="body">
    <p>顾工，您好：</p>
    <p>附上双方截至 ${demoWorldFixture.demoDate.iso} 的往来对账，烦请核对确认。</p>

    <table>
      <tr><th>应收单</th><th>对应订单</th><th>开票日</th><th>到期日</th><th>金额</th><th>状态</th></tr>
      <tr>
        <td>AR-2026-0058</td><td>SO-2026-0996</td><td>2026-06-22</td><td>2026-07-22</td>
        <td class="num">¥236,000.00</td><td class="warn">已逾期 18 天</td>
      </tr>
      <tr class="total">
        <td colspan="4">本次待确认合计</td><td class="num">¥236,000.00</td><td>—</td>
      </tr>
    </table>

    <div class="box">
      <div><b>结算依据</b>：合同约定账期 30 天，发票已于 2026-06-22 开出并由贵司签收。</div>
      <div><b>希望确认日</b>：2026-08-14 前回复对账结果</div>
      <div><b>希望付款日</b>：2026-08-21 前完成付款</div>
    </div>

    <p>如果对上述金额、票据或到货签收有任何异议，请直接回复本邮件，我们当天核对并给你答复；若确认无误，也麻烦回一句，我这边同步安排后续开票。</p>
    <p>另外，二期合作方案我们本周内会一起带过去，当面把交付节奏和结算安排一次过一遍。</p>

    <p class="sign">陈静<br>澜达精密制造有限公司 · 财务部</p>
  </div>

  <p class="foot">示例内容，公司、人员、订单与往来款项均为虚构，不对应任何真实业务。</p>
</div>
</body></html>`;

const DUNNING_LETTER_SIZE_BYTES = new TextEncoder().encode(DUNNING_LETTER_HTML).length;

/** 面板底稿：应收台账 / CRM 客户与商机 / 企业邮箱 / 权限矩阵 / 操作留痕 */
const PANEL_BASE: SystemPanelSnapshot = {
  title: "企业系统实况",
  live: true,
  activeView: "ar",
  foot: "已连接：应收台账 · CRM 客户与商机 · 企业邮箱 · 权限矩阵（演示）",
  views: [
    {
      key: "ar",
      label: "应收台账",
      winTitle: "应收台账 · 未结款项",
      toolbar: { title: "应收台账 · 未结款项", sub: "尚未读取" },
      widget: {
        kind: "table",
        cols: [
          { key: "bill", label: "应收单" },
          { key: "cust", label: "客户" },
          { key: "amt", label: "金额", align: "right" },
          { key: "state", label: "账龄", align: "right" },
        ],
        rows: [],
        empty: { title: "尚未读取应收台账" },
      },
    },
    {
      key: "crm",
      label: "CRM 客户与商机",
      winTitle: "CRM · 客户往来与在谈商机",
      toolbar: { title: "CRM · 客户往来与在谈商机", sub: "尚未核对" },
      widget: { kind: "rows", rows: [], empty: { title: "尚未核对客户与商机状态" } },
    },
    {
      key: "mail",
      label: "企业邮箱",
      winTitle: "企业邮箱 · 对外函件",
      toolbar: { title: "企业邮箱 · 对外函件", sub: "0 封草稿 · 0 封已发出" },
      widget: { kind: "feed", items: [], empty: { title: "尚无任何草稿或已发函件" } },
    },
    {
      key: "rights",
      label: "权限矩阵",
      winTitle: "权限矩阵 · 本人可执行动作",
      toolbar: { title: "权限矩阵 · 由 IT 依岗位表维护", sub: "只读" },
      widget: {
        kind: "table",
        cols: [
          { key: "action", label: "动作" },
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

export const receivablesChaseScript: ReplayScript = {
  scenarioId: "catalog-hook-receivables-chase",
  title: "该催的应收挑出来，催款话术一并拟好",
  mode: "quick",
  artifacts: { [DUNNING_LETTER_PATH]: DUNNING_LETTER_HTML },

  steps: [
    {
      caption: "读取应收台账未结款项",
      blocks: [
        {
          id: "r1-prompt",
          kind: "prompt",
          title: "用户消息",
          defaultOpen: true,
          content: "月底快到了，哪些应收该催了？帮我把催款话术也拟好。",
        },
        {
          id: "r1-tool",
          kind: "tool_use",
          title: "ARLedgerQuery",
          defaultOpen: true,
          toolName: "ARLedgerQuery",
          toolId: "t-ar-ledger",
          content: JSON.stringify({ ledger: "AR", status: "open", asOf: demoWorldFixture.demoDate.iso }),
          executionStatus: "completed",
          durationMs: 920,
          presentation: {
            title: "读取应收台账未结款项",
            detail: [
              { k: "统计口径", v: `截至 ${demoWorldFixture.demoDate.iso} · 已开票未收讫` },
              { k: "未结笔数", v: `${demoWorldFixture.receivables.count} 笔 · 合计 ¥${demoWorldFixture.receivables.totalAmountWan.toFixed(1)} 万` },
              { tree: "├", k: "已逾期", v: "1 笔 · ¥23.6 万" },
              { tree: "├", k: "7 天内到期", v: "1 笔 · ¥12.0 万" },
              { tree: "└", k: "账期内", v: "10 笔 · ¥132.6 万" },
              "面板按到期日升序展开最近 5 笔，其余 7 笔到期日均在 9 月之后。",
            ],
            status: "ok",
            panelBase: PANEL_BASE,
            panel: [
              { op: "focus", view: "ar" },
              { op: "toolbar", view: "ar", title: "应收台账 · 未结款项", sub: `${demoWorldFixture.receivables.count} 笔 · ¥${demoWorldFixture.receivables.totalAmountWan.toFixed(1)} 万 · 显示到期最近 5 笔` },
              { op: "tableRowInsert", view: "ar", row: { id: "ar-0058", cells: { bill: "AR-2026-0058", cust: "蓝谷自动化", amt: "¥23.6 万", state: "07-22 到期" } } },
              { op: "tableRowInsert", view: "ar", row: { id: "ar-0044", cells: { bill: "AR-2026-0044", cust: demoWorldFixture.deliveryOrder.customer, amt: "¥12.0 万", state: "08-12 到期" } } },
              { op: "tableRowInsert", view: "ar", row: { id: "ar-0051", cells: { bill: "AR-2026-0051", cust: "海川机械", amt: "¥8.4 万", state: "08-25 到期" } } },
              { op: "tableRowInsert", view: "ar", row: { id: "ar-0063", cells: { bill: "AR-2026-0063", cust: "启润电子", amt: "¥5.2 万", state: "08-28 到期" } } },
              { op: "tableRowInsert", view: "ar", row: { id: "ar-0037", cells: { bill: "AR-2026-0037", cust: "Feldmann GmbH", amt: "¥31.5 万", state: "09-10 到期" } } },
              { op: "feedAppend", view: "audit", item: { id: "au-1", from: "AI 同事", time: "10:02:11", text: `读取应收台账 ${demoWorldFixture.receivables.count} 笔未结款项（只读），未修改任何账期或金额` } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "1 条" },
            ],
          },
        },
        {
          id: "r1-result",
          kind: "tool_result",
          title: "ARLedgerQuery 结果",
          defaultOpen: false,
          toolName: "ARLedgerQuery",
          toolId: "t-ar-ledger",
          content: `open=${demoWorldFixture.receivables.count} total=${demoWorldFixture.receivables.totalAmountCny} overdue=1 dueIn7d=1 asOf=${demoWorldFixture.demoDate.iso}`,
        },
        {
          id: "r1-text",
          kind: "text",
          title: "业务进展",
          defaultOpen: true,
          content: `${demoWorldFixture.receivables.count} 笔未结都拿到了。我按到期日、账龄和这家客户当前在谈的事情逐笔判一遍，再决定谁该催、催到哪一档。`,
        },
      ],
    },

    {
      caption: "逐笔分档，只挑该催的",
      blocks: [
        {
          id: "r2-tool",
          kind: "tool_use",
          title: "AgingTriage",
          defaultOpen: true,
          toolName: "AgingTriage",
          toolId: "t-triage",
          content: JSON.stringify({ scope: "open-ar", crossCheck: ["crm-opportunity", "complaint"] }),
          executionStatus: "completed",
          durationMs: 1580,
          presentation: {
            title: "按账龄与客户在谈事项逐笔分档",
            detail: [
              { verdict: "fail", text: "AR-2026-0058 蓝谷自动化 ¥23.6 万", note: "账期 30 天，06-22 开票、07-22 到期，今天已逾期 18 天 · 该催" },
              { verdict: "warn", text: `AR-2026-0044 ${demoWorldFixture.deliveryOrder.customer} ¥12.0 万`, note: "08-12 到期，还有 3 天 · 提醒级，不进催收" },
              { verdict: "pending", text: "AR-2026-0063 启润电子 ¥5.2 万", note: "08-28 到期在账期内，且 NC-2026-0092 客诉挂了 6 天未闭环 · 本轮不催" },
              { verdict: "pass", text: "AR-2026-0051 海川机械 ¥8.4 万", note: "08-25 到期，账期内 · 不动" },
              { verdict: "pass", text: "AR-2026-0037 Feldmann GmbH ¥31.5 万", note: "09-10 到期，账期内 · 不动" },
              { warn: "蓝谷这笔有口径冲突：同一家客户的 SO-2026-1033 二期结构件正在张明远手里谈，图纸确认中。财务单线发催款，会和销售正在推的事撞车。" },
              { insight: `${demoWorldFixture.receivables.count} 笔里只有 1 笔真的该催，1 笔只需提醒；其余 10 笔现在动只会消耗客户关系`, label: "结论" },
            ],
            status: "warn",
            panel: [
              { op: "focus", view: "ar" },
              { op: "toolbar", view: "ar", title: "应收台账 · 分档结果", sub: "该催 1 · 提醒 1 · 不动 10" },
              { op: "tableRowUpdate", view: "ar", id: "ar-0058", set: { cells: { state: "逾期 18 天" }, tone: "warn" } },
              { op: "cellFlag", view: "ar", rowId: "ar-0058", colKey: "state", tone: "deny", flag: "该催" },
              { op: "tableRowUpdate", view: "ar", id: "ar-0044", set: { cells: { state: "剩 3 天" } } },
              { op: "cellFlag", view: "ar", rowId: "ar-0044", colKey: "state", tone: "warn", flag: "提醒" },
              { op: "cellFlag", view: "ar", rowId: "ar-0051", colKey: "state", tone: "pass", flag: "账期内" },
              { op: "cellFlag", view: "ar", rowId: "ar-0063", colKey: "state", tone: "pending", flag: "客诉未结" },
              { op: "cellFlag", view: "ar", rowId: "ar-0037", colKey: "state", tone: "pass", flag: "账期内" },
              { op: "rowInsert", view: "crm", row: {
                id: "crm-lg",
                text: "蓝谷自动化 · 顾云帆（项目经理）",
                sub: "负责人 张明远 · SO-2026-1033 二期结构件在谈，图纸确认中",
                tone: "warn",
                state: "hit",
                badge: { text: "催收有冲突", tone: "warn" },
              } },
              { op: "rowInsert", view: "crm", row: {
                id: "crm-hy",
                text: `${demoWorldFixture.deliveryOrder.customer} · 郑海峰（采购部）`,
                sub: `负责人 赵一楠 · ${demoWorldFixture.deliveryOrder.id} 交付中，${demoWorldFixture.deliveryOrder.promisedDeliveryDate} 交期`,
                tone: "info",
              } },
              { op: "rowInsert", view: "crm", row: {
                id: "crm-qr",
                text: "启润电子 · 何丽（供应链）",
                sub: "NC-2026-0092 外观不良客诉未闭环 6 天",
                tone: "pending",
                badge: { text: "客诉未结", tone: "warn" },
              } },
              { op: "toolbar", view: "crm", title: "CRM · 客户往来与在谈商机", sub: "3 家已核对" },
              { op: "feedAppend", view: "audit", item: { id: "au-2", from: "AI 同事", time: "10:03:40", text: `${demoWorldFixture.receivables.count} 笔应收逐笔分档：该催 1 · 提醒 1 · 不动 10；并核对 CRM 在谈商机与未结客诉` } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "2 条" },
            ],
          },
        },
        {
          id: "r2-text",
          kind: "text",
          title: "业务进展",
          defaultOpen: true,
          content: [
            "这一轮真正该催的只有一笔：",
            "",
            "1. **蓝谷自动化 AR-2026-0058 ¥23.6 万**，合同账期 30 天，06-22 开票、07-22 到期，今天 08-09，逾期 18 天。金额是本月未结里最大的一笔逾期，理由充分。",
            `2. **${demoWorldFixture.deliveryOrder.customer} AR-2026-0044 ¥12.0 万** 08-12 才到期，还有 3 天，这笔发的是到期提醒，不是催款——恒岳的 ${demoWorldFixture.deliveryOrder.id} 正卡在 ${demoWorldFixture.deliveryOrder.promisedDeliveryDate} 交期上，这时候提钱容易被当成施压。`,
            "",
            "另外三笔我建议现在别动，理由分开说：海川 08-25、Feldmann 09-10 都在账期内，提前催没有依据；启润 AR-2026-0063 虽然也在账期内，但它的 NC-2026-0092 客诉挂了 6 天还没闭环，客诉未了先催款，回款没催来、客诉先升级。",
            "",
            "还有一件你必须先知道的事：蓝谷的 SO-2026-1033 二期正在张明远手里谈，图纸还在确认。财务这边一封催款函过去，销售那边的推进节奏就乱了——所以下面的话术我按「要跟销售对齐」的前提写。",
          ].join("\n"),
        },
      ],
    },

    {
      caption: "话术分三档起草",
      blocks: [
        {
          id: "r3-tool",
          kind: "tool_use",
          title: "DraftCompose",
          defaultOpen: true,
          toolName: "DraftCompose",
          toolId: "t-draft",
          content: JSON.stringify({ target: "AR-2026-0058", tiers: ["first", "second", "escalation"] }),
          executionStatus: "completed",
          durationMs: 2140,
          presentation: {
            title: "按催收档位起草三份话术",
            detail: [
              { section: "档位一 · 首催（合作伙伴口吻）" },
              { k: "适用", v: "逾期 1~7 天，只做提醒，不提任何后果" },
              { tree: "└", k: "本次", v: "不适用——已逾期 18 天，用首催会显得没看过账" },
              { section: "档位二 · 再催（对账函）" },
              { k: "适用", v: "逾期 8~30 天，用对账事实说话，给确认日与付款日" },
              { tree: "└", k: "本次", v: "选这一档 · 确认日 08-14、付款日 08-21" },
              { section: "档位三 · 升级（法务口径）" },
              { k: "适用", v: "逾期 30 天以上，或再催后无回应" },
              { tree: "└", k: "本次", v: "不发——逾期 18 天没到这一档，且蓝谷 6 月那笔逾期 9 天后已付清，履约记录不差" },
              { insight: "三份都给你，但我只建议发第二档；升级函这次不该出现在收件人面前", label: "取舍" },
            ],
            status: "ok",
            panel: [
              { op: "focus", view: "mail" },
              { op: "toolbar", view: "mail", title: "企业邮箱 · 对外函件", sub: "3 份草稿 · 0 封已发出" },
              { op: "feedAppend", view: "mail", item: {
                id: "mail-d1",
                from: "AI 同事",
                time: "10:05:12",
                text: "草稿 · 首催话术（不建议本次使用）",
                card: { title: "档位一 · 首催", body: "「货款到期日是 7-22，麻烦帮忙看一下付款安排」——口吻最轻，适用逾期一周内", meta: [{ text: "未发送", tone: "info" }, { text: "本次不适用", tone: "pending" }] },
              } },
              { op: "feedAppend", view: "mail", item: {
                id: "mail-d2",
                from: "AI 同事",
                time: "10:05:19",
                text: "草稿 · 再催对账函（建议本次使用）",
                card: { title: "档位二 · 再催对账函", body: "附对账明细 + 确认日 08-14 + 付款日 08-21，全程只陈述事实，不带情绪", meta: [{ text: "未发送", tone: "info" }, { text: "建议采用", tone: "pass" }] },
              } },
              { op: "feedAppend", view: "mail", item: {
                id: "mail-d3",
                from: "AI 同事",
                time: "10:05:24",
                text: "草稿 · 升级函（本次不建议发送）",
                card: { title: "档位三 · 升级", body: "含合同违约条款与法务抄送口径；逾期 18 天用它属于过度施压", meta: [{ text: "未发送", tone: "info" }, { text: "不建议", tone: "deny" }] },
              } },
              { op: "feedAppend", view: "audit", item: { id: "au-3", from: "AI 同事", time: "10:05:30", text: "生成三档催收话术草稿，均停留在草稿状态，未进入发送队列" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "3 条" },
            ],
          },
        },
        {
          id: "r3-text",
          kind: "text",
          title: "业务进展",
          defaultOpen: true,
          content: [
            "三档话术都写好了，放在草稿里，一封都没发。",
            "",
            "**这次我建议用第二档对账函**。逾期 18 天配再催，档位是对得上的：首催太轻，显得我们自己没看账；升级函太重——蓝谷 6 月那笔逾期 9 天后是自己付清的，履约记录没有坏到要动法务口径，这一封发出去，二期的谈判气氛会直接掉下来。",
            "",
            "**升级函这次不建议发**，我把它留在草稿里，等再催过了 7 天还没回应再说。",
          ].join("\n"),
        },
      ],
    },

    {
      caption: "直接发给客户被拦下",
      blocks: [
        {
          id: "r4-prompt",
          kind: "prompt",
          title: "用户消息",
          defaultOpen: true,
          content: "行，第二档就挺好，直接发给蓝谷顾云帆吧。",
        },
        {
          id: "r4-tool",
          kind: "tool_use",
          title: "MailSend",
          defaultOpen: true,
          toolName: "MailSend",
          toolId: "t-send-blocked",
          content: JSON.stringify({ draft: "tier2", to: "顾云帆", bill: "AR-2026-0058" }),
          executionStatus: "completed",
          durationMs: 240,
          presentation: {
            title: "对外发函 · 规则判定",
            detail: [
              { k: "请求动作", v: "向客户联系人直接发出催收函件" },
              { k: "本人岗位", v: "财务（应收管理）" },
              { verdict: "fail", text: "已拦截，未进入发送队列", note: "对外催收需销售对齐 + 有权人审批 · 邮件正文与收件人均未提交" },
              { indent: 0, text: "⚠ 蓝谷同时是在谈客户（SO-2026-1033，负责人 张明远），单线发函的风险不只是流程问题" },
            ],
            status: "blocked",
            panel: [
              { op: "focus", view: "rights" },
              { op: "toolbar", view: "rights", title: "权限矩阵 · 本人可执行动作", sub: "命中 1 条限制" },
              { op: "tableRowInsert", view: "rights", row: { id: "rt-read", cells: { action: "应收台账查询", grant: "允许", owner: "岗位表" } } },
              { op: "tableRowInsert", view: "rights", row: { id: "rt-draft", cells: { action: "催收话术起草", grant: "允许", owner: "岗位表" } } },
              { op: "tableRowInsert", view: "rights", row: { id: "rt-send", cells: { action: "对外催收函发送", grant: "需对齐 + 审批", owner: "销售负责人" }, tone: "deny" } },
              { op: "cellFlag", view: "rights", rowId: "rt-send", colKey: "grant", tone: "deny", flag: "不可单线发出" },
              { op: "tableRowInsert", view: "rights", row: { id: "rt-terms", cells: { action: "账期与信用额度变更", grant: "拒绝", owner: "财务负责人" } } },
              { op: "toolbar", view: "mail", title: "企业邮箱 · 对外函件", sub: "3 份草稿 · 0 封已发出" },
              { op: "feedAppend", view: "audit", item: {
                id: "au-4",
                from: "AI 同事",
                time: "10:06:02",
                text: "对外发函请求被规则拦截，邮件未进入发送队列",
                card: { title: "对外动作已拦截", body: "催收函涉及在谈客户，需先与销售对齐口径并由有权人放行", meta: [{ text: "未发出任何邮件", tone: "pass" }, { text: "已记账", tone: "info" }] },
              } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "4 条" },
            ],
          },
        },
        {
          id: "r4-text",
          kind: "text",
          title: "回复",
          defaultOpen: true,
          content: [
            "**这一封我不能直接发出去**。对客户的催收函属于对外动作，右侧规则里这一行写得很清楚：需要先和客户负责人对齐口径，再由有权人放行，财务这边不能单线发。我没有把邮件放进发送队列，收件人栏也没填过。",
            "",
            "这不只是流程。蓝谷现在是张明远手上在谈的客户，二期图纸还在确认——你这封函先到，顾云帆下一通电话就会打给张明远问「你们到底是要合作还是要钱」，两个口径撞在一起，钱和单子都容易折。",
            "",
            "正规路子有两条：",
            "",
            "1. 我把对账事实和函件草稿抄给张明远，他确认口径后走一次放行，放行通过我立刻发；",
            "2. 或者你先让张明远在他那条线上口头提一次回款，等他反馈再决定函要不要发。",
            "",
            "我建议走第一条，逾期 18 天了，书面对账该有了。要我把放行单提上去吗？",
          ].join("\n"),
        },
      ],
    },

    {
      caption: "生成客户视角的对账催款函",
      blocks: [
        {
          id: "r5-tool",
          kind: "tool_use",
          title: "LetterBuild",
          defaultOpen: true,
          toolName: "LetterBuild",
          toolId: "t-letter",
          content: JSON.stringify({ tier: "second", bill: "AR-2026-0058", preview: "recipient-view" }),
          executionStatus: "completed",
          durationMs: 1360,
          presentation: {
            title: "按客户视角渲染这封函的样子",
            detail: [
              { k: "函件档位", v: "再催 · 对账函" },
              { k: "对账明细", v: "AR-2026-0058 · SO-2026-0996 · ¥236,000.00" },
              { tree: "├", k: "确认日", v: "2026-08-14 前回复对账结果" },
              { tree: "├", k: "付款日", v: "2026-08-21 前完成付款" },
              { tree: "└", k: "预览口径", v: "顾云帆在自己邮箱里打开时看到的排版与措辞" },
              { warn: "这是预览，函件尚未发出；收件人栏在放行前不会被填写" },
            ],
            status: "waiting",
            panel: [
              { op: "focus", view: "mail" },
              { op: "toolbar", view: "mail", title: "企业邮箱 · 对外函件", sub: "3 份草稿 · 1 份待放行 · 0 封已发出" },
              { op: "feedAppend", view: "mail", item: {
                id: "mail-preview",
                from: "AI 同事",
                time: "10:07:44",
                text: "对账函已成稿，等待放行",
                card: { title: "【对账函】AR-2026-0058 · ¥236,000.00", body: "收件人 顾云帆 · 抄送 张明远；确认日 08-14、付款日 08-21", meta: [{ text: "待放行", tone: "warn" }, { text: "尚未发出", tone: "pending" }] },
              } },
              { op: "feedAppend", view: "audit", item: { id: "au-5", from: "AI 同事", time: "10:07:50", text: "生成对账函客户视角预览，函件仍停留在待放行状态" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "5 条" },
            ],
          },
        },
        {
          id: "r5-text",
          kind: "text",
          title: "回复",
          defaultOpen: true,
          content: [
            "函写好了。**下面这份就是顾云帆在自己邮箱里打开时看到的样子**，你先自己读一遍，觉得哪句硬了随时改：",
            "",
            `[FILE]{"filePath":"${DUNNING_LETTER_PATH}","fileName":"对账催款函-蓝谷自动化.html","fileSize":${DUNNING_LETTER_SIZE_BYTES}}[/FILE]`,
            "",
            "措辞上我做了两个选择：全程只摆对账事实、不写「否则」；把确认日和付款日分开给（08-14 确认、08-21 付款），对方好安排流程，我们也有了下一次跟进的时间锚点。",
            "",
            "它现在还停在待放行，收件人栏是空的。",
          ].join("\n"),
        },
      ],
    },

    {
      caption: "销售对齐口径并放行",
      blocks: [],
      approval: {
        title: "对外发出对账函 · 需销售对齐后放行",
        description: "放行后函件才会发往客户联系人并抄送销售。这一步会对客户产生实际动作，必须由有权人明确确认。",
        facts: [
          { label: "应收单", value: "AR-2026-0058 · 蓝谷自动化" },
          { label: "金额与账龄", value: "¥236,000.00 · 逾期 18 天" },
          { label: "函件档位", value: "再催 · 对账函（升级函不发）" },
          { label: "收件与抄送", value: "顾云帆（客户项目经理）· 抄送 张明远" },
          { label: "函件要求", value: "08-14 前确认对账、08-21 前付款" },
        ],
        approveLabel: "确认放行",
        rejectLabel: "退回修改",
        approvedBlocks: [
          {
            id: "r6-human",
            kind: "prompt",
            title: "用户消息",
            defaultOpen: true,
            content: "口径我这边认，金额和日期都对。但结尾加一句：二期合作方案我们本周内一起带过去。别让客户觉得我们只惦记着钱。",
          },
          {
            id: "r6-approve",
            kind: "tool_use",
            title: "Approval",
            defaultOpen: true,
            toolName: "Approval",
            toolId: "t-approve",
            content: JSON.stringify({ bill: "AR-2026-0058", decision: "released" }),
            executionStatus: "completed",
            durationMs: 340,
            presentation: {
              title: "放行已确认 · 含人工修改 1 项",
              detail: [
                { k: "审批结果", v: "放行" },
                { k: "人审记账", v: "采纳 3 项 · 修改 1 项 · 自动执行 0 项" },
                { tree: "├", k: "采纳", v: "档位选再催、确认日 08-14、付款日 08-21" },
                { tree: "├", k: "修改", v: "结尾加一句二期合作方案本周内一起带过去（张明远补）" },
                { tree: "└", k: "留痕", v: "放行人、原措辞与改后措辞均已记录" },
              ],
              status: "ok",
              receipt: { id: "AP-2026-0517", system: "审批中心", readBack: true },
              panel: [
                { op: "focus", view: "crm" },
                { op: "rowUpdate", view: "crm", id: "crm-lg", set: {
                  sub: "负责人 张明远 已对齐口径 · 再催函经放行后发出",
                  tone: "pass",
                  badge: { text: "口径已对齐", tone: "pass" },
                } },
                { op: "toolbar", view: "crm", title: "CRM · 客户往来与在谈商机", sub: "蓝谷口径已对齐" },
                { op: "feedAppend", view: "audit", item: {
                  id: "au-6",
                  from: "张明远（销售）",
                  time: "10:22:35",
                  text: "确认放行：采纳 3 项、修改 1 项（结尾补二期合作方案一句）",
                  card: { title: "人审记录", body: "采纳 3 · 修改 1 · 自动执行 0", meta: [{ text: "AI 未自行发函", tone: "pass" }] },
                } },
                { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "6 条" },
              ],
            },
          },
          {
            id: "r6-send",
            kind: "tool_use",
            title: "MailSend",
            defaultOpen: true,
            toolName: "MailSend",
            toolId: "t-send",
            content: JSON.stringify({ bill: "AR-2026-0058", to: "顾云帆", cc: "张明远" }),
            executionStatus: "completed",
            durationMs: 1180,
            presentation: {
              title: "对账函已发出并回写跟进记录",
              detail: [
                { k: "收件人", v: "顾云帆 · 蓝谷自动化 项目部" },
                { k: "抄送", v: "张明远 · 销售部" },
                { tree: "├", k: "送达状态", v: "10:41 已送达对方邮箱" },
                { tree: "├", k: "CRM 跟进", v: "已按 AR-2026-0058 写入一条再催记录" },
                { tree: "└", k: "复查", v: "08-14 未收到确认回复会提醒你和张明远" },
              ],
              status: "ok",
              receipt: { id: "MAIL-20260809-0342", system: "企业邮箱", readBack: true },
              panel: [
                { op: "focus", view: "mail" },
                { op: "toolbar", view: "mail", title: "企业邮箱 · 对外函件", sub: "1 封已发出 · 已送达" },
                { op: "feedAppend", view: "mail", item: {
                  id: "mail-sent",
                  from: "陈静（财务）",
                  time: "10:41:06",
                  text: `【对账函】AR-2026-0058 · 截至 ${demoWorldFixture.demoDate.iso} 应收余额 ¥236,000.00`,
                  card: { title: "已送达 · 顾云帆（抄送 张明远）", body: "含对账明细、确认日 08-14、付款日 08-21，以及二期合作方案的当面沟通安排", meta: [{ text: "已送达", tone: "pass" }, { text: "含人工补充 1 句", tone: "info" }] },
                } },
                { op: "tableRowUpdate", view: "ar", id: "ar-0058", set: { cells: { state: "再催已发" }, tone: "pass" } },
                { op: "cellFlag", view: "ar", rowId: "ar-0058", colKey: "state", tone: "pass", flag: "08-14 待确认" },
                { op: "rowInsert", view: "crm", row: {
                  id: "crm-log",
                  text: "跟进记录 · AR-2026-0058 再催（对账函）",
                  sub: `${demoWorldFixture.demoDate.iso} 10:41 陈静发出、张明远抄送 · 下一动作 08-14 核对客户确认`,
                  tone: "pass",
                  state: "hit",
                  badge: { text: "已写入", tone: "pass" },
                } },
                { op: "feedAppend", view: "audit", item: { id: "au-7", from: "AI 同事", time: "10:41:12", text: "发出对账函 MAIL-20260809-0342 并回读送达状态；CRM 跟进记录写入回读通过" } },
                { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "7 条" },
              ],
            },
          },
          {
            id: "r6-text",
            kind: "text",
            title: "审批结果",
            defaultOpen: true,
            content: "函按你改的版本发出去了，结尾那句二期合作方案我原样保留，没有替你润色。收件人顾云帆、抄送张明远，10:41 已送达；CRM 里同步落了一条跟进记录。08-14 前如果没等到确认回复，我会同时提醒你和张明远。",
          },
        ],
        rejectedBlocks: [
          {
            id: "r6-rejected-tool",
            kind: "tool_use",
            title: "Approval",
            defaultOpen: true,
            toolName: "Approval",
            toolId: "t-reject",
            content: JSON.stringify({ bill: "AR-2026-0058", decision: "rejected" }),
            executionStatus: "completed",
            durationMs: 260,
            presentation: {
              title: "放行被退回 · 未向客户发出任何东西",
              detail: [
                { k: "审批结果", v: "退回修改" },
                { k: "对外函件", v: "未发出，收件人栏仍为空" },
                { k: "业务系统", v: "应收台账与 CRM 均无写入" },
                { tree: "└", k: "留痕", v: "退回时间、退回人与当时函件版本已记录" },
              ],
              status: "blocked",
              panel: [
                { op: "focus", view: "mail" },
                { op: "toolbar", view: "mail", title: "企业邮箱 · 对外函件", sub: "3 份草稿 · 1 份被退回 · 0 封已发出" },
                { op: "feedAppend", view: "mail", item: {
                  id: "mail-hold",
                  from: "AI 同事",
                  time: "10:22:35",
                  text: "对账函已退回，停在待放行状态",
                  card: { title: "未发出任何函件", body: "客户侧收不到任何消息；三档话术与对账函都留在草稿里", meta: [{ text: "已停住", tone: "warn" }] },
                } },
                { op: "feedAppend", view: "audit", item: { id: "au-reject", from: "张明远（销售）", time: "10:22:35", text: "放行被退回：未发出任何对外函件，应收台账与 CRM 无写入" } },
              ],
            },
          },
          {
            id: "r6-rejected-text",
            kind: "text",
            title: "退回说明",
            defaultOpen: true,
            content: "已停在放行点：客户那边什么都没收到，应收台账和 CRM 也没有任何写入。三档话术和这封对账函都还在，你随时可以下载带走，或者改完措辞再提一次放行。",
          },
        ],
      },
    },

    {
      caption: "跨系统核对终态",
      blocks: [
        {
          id: "r7-tool",
          kind: "tool_use",
          title: "ReadBack",
          defaultOpen: true,
          toolName: "ReadBack",
          toolId: "t-readback",
          content: JSON.stringify({ bill: "AR-2026-0058" }),
          executionStatus: "completed",
          durationMs: 1040,
          presentation: {
            title: "回读三个系统，核对说法是否一致",
            detail: [
              { k: "回读方式", v: "按单据号逐个反查，不用本次会话的缓存" },
              { verdict: "pass", text: "应收台账", note: "AR-2026-0058 · 再催已发，账期与金额未变" },
              { verdict: "pass", text: "企业邮箱", note: "1 封已送达 · 3 份草稿仍未发出" },
              { verdict: "pass", text: "CRM 客户与商机", note: "1 条再催跟进记录 · 商机阶段未改动" },
              { insight: "三方一致，唯一未决动作是 08-14 的客户确认回复", label: "结论" },
            ],
            status: "ok",
            panel: [
              { op: "focus", view: "ar" },
              { op: "toolbar", view: "ar", title: "应收台账 · 终态回读", sub: "三方一致 · 1 项待客户确认" },
              { op: "feedAppend", view: "audit", item: { id: "au-8", from: "AI 同事", time: "10:42:20", text: "回读应收台账 / 企业邮箱 / CRM，三方状态一致" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "8 条" },
            ],
          },
        },
        {
          id: "r7-text",
          kind: "text",
          title: "本次会话改变了什么",
          defaultOpen: true,
          content: [
            "## 本次会话改变了什么",
            "",
            "| 系统 | 终态 | 依据 |",
            "| --- | --- | --- |",
            "| 应收台账 | AR-2026-0058 标记为再催已发，08-14 待客户确认 | 放行单 AP-2026-0517 |",
            "| 企业邮箱 | 1 封对账函已送达顾云帆，抄送张明远 | 回执 MAIL-20260809-0342 |",
            "| CRM 客户与商机 | 新增 1 条再催跟进记录，商机阶段未动 | 跟进记录回读通过 |",
            "| 审批中心 | 1 张放行单，含 1 项人工修改 | 采纳 3 · 修改 1 · 自动执行 0 |",
            "",
            "## 本次会话没有做什么",
            "",
            "- 没有发升级函：逾期 18 天不到那一档，法务口径的草稿留在邮箱里没动；",
            "- 没有绕开销售：直接发给客户的请求被拦下，函件是张明远对齐口径、明确放行之后才出去的；",
            "- 没有改账期或金额：应收台账只更新了催收状态，账期、金额、信用额度一个字没碰；",
            "- 没有惊动另外 10 家客户：账期内的 10 笔一封没发，启润那笔在客诉闭环前我不会催。",
          ].join("\n"),
        },
        {
          id: "r7-upgrade",
          kind: "text",
          title: "下一步",
          defaultOpen: true,
          content: "以后每周一、周四早上我可以自动把应收盘一遍，只把该催的那几笔和有口径冲突的挑出来给你，话术照样先拟好等你放行，随时说一声就行。",
        },
      ],
    },
  ],

  // 治理条款：state != exists 的条目就是「演示到真实」的距离
  sources: [
    {
      blockRef: "step1.tool.ARLedgerQuery",
      producer: "租户业务数据连接器（应收台账）",
      state: "missing",
      gap: "没有通用的业务数据连接器；真实会话读应收台账只能走客户自建接口或数据库只读账号，且两者都不产出账龄口径的业务摘要",
    },
    {
      blockRef: "step2.tool.AgingTriage",
      producer: "租户业务数据连接器（CRM 商机 + 客诉工单交叉读）",
      state: "missing",
      gap: "分档结论依赖同时读应收、在谈商机与未结客诉三处数据，这三处的连接器都不存在；账龄阈值也还没有可版本化的规则集与生效日期",
    },
    {
      blockRef: "step3.tool.DraftCompose",
      producer: "Agent 起草（催收话术分档）",
      state: "exists",
    },
    {
      blockRef: "step4.tool.MailSend",
      producer: "对外动作门禁",
      state: "needs-change",
      gap: "门禁形态已在客户 POC 验证（会话外独立判定 + 前端预设话术），但尚未产品化为可配置的对外动作矩阵，「在谈客户需销售对齐」这类业务规则目前无处配置",
    },
    {
      blockRef: "step5.tool.LetterBuild",
      producer: "Agent 生成 HTML 产物",
      state: "exists",
    },
    {
      blockRef: "step6.tool.Approval",
      producer: "业务审批执行器",
      state: "needs-change",
      gap: "人审事件在 runtime 已成对记录，但「人改了哪一条、原措辞是什么」没有结构化字段，采纳/修改计数只能落在自由文本里",
    },
    {
      blockRef: "step6.tool.MailSend",
      producer: "企业邮箱发件连接器（含送达回执回读）",
      state: "missing",
      gap: "对外发件与送达回执产品里不存在；CRM 跟进记录的写后回读同样缺连接器，ToolReceipt 字段已有但无人产出",
    },
    {
      blockRef: "step7.tool.ReadBack",
      producer: "业务终态回读器",
      state: "missing",
      gap: "跨系统回读要先有应收 / 邮箱 / CRM 三个连接器；在此之前终态核对表只能靠人工整理",
    },
    {
      blockRef: "step5.artifact.对账催款函",
      producer: "Agent 生成 HTML 产物",
      state: "exists",
    },
  ],
};

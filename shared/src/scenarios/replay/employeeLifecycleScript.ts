import type { SystemPanelSnapshot } from "../../lib/systemPanel";
import type { ReplayScript } from "./types";

/**
 * D6 Hero：员工离职从一句业务要求推进到身份、资产、客户与职责的可验证交接。
 *
 * 演示对象与数据均为虚构。Agent 负责跨系统归集、解释例外与追踪终态；
 * 人员生效时间、业务接手人、个人身份撤权和 legal hold 分别由对应岗位批准。
 */

const HANDOVER_PATH = "assets/demo/周铭离职交接执行单.html";

const HANDOVER_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<style>
  :root{--brand:#2E56E1;--ink:#0f172a;--muted:#64748b;--line:#e2e8f0;--ok:#15803d;--warn:#b45309;--deny:#b91c1c}
  *{box-sizing:border-box}body{margin:0;padding:22px;font:14px/1.65 "PingFang SC","Microsoft YaHei",system-ui,sans-serif;color:var(--ink);background:#fff}
  h1{margin:0 0 4px;font-size:18px}.sub,.foot{color:var(--muted);font-size:12px}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:16px 0}
  .stat,.box{border:1px solid var(--line);border-radius:9px;padding:10px 12px}.stat b{display:block;font-size:17px}.stat span{color:var(--muted);font-size:12px}
  table{width:100%;border-collapse:collapse;margin:10px 0 16px;font-size:12.5px}th,td{border:1px solid var(--line);padding:7px 9px;text-align:left;vertical-align:top}th{background:#f8fafc;color:var(--muted)}
  h2{margin:17px 0 7px;color:var(--brand);font-size:14px}.ok{color:var(--ok);font-weight:600}.warn{color:var(--warn);font-weight:600}.deny{color:var(--deny);font-weight:600}
</style></head><body>
<h1>周铭离职交接执行单</h1>
<div class="sub">澜星智造（演示）· 生效时间 2026-08-28 18:00 · 案件 LC-20260828-017</div>
<div class="stats">
  <div class="stat"><b>6 类</b><span>权威系统已归集</span></div>
  <div class="stat"><b class="deny">3 项</b><span>直接授权须撤销</span></div>
  <div class="stat"><b class="warn">4 项</b><span>业务职责须移交</span></div>
  <div class="stat"><b>1 项</b><span>legal hold 保留</span></div>
</div>
<h2>生效边界</h2>
<table><tr><th>批准岗位</th><th>只批准什么</th><th>不会替谁决定</th></tr>
<tr><td>人力负责人</td><td>离职生效时间、HRIS 状态、工资与考勤截止</td><td>不选客户或项目接手人</td></tr>
<tr><td>直属经理</td><td>客户、项目和审批职责的接手人</td><td>不批准个人身份撤权</td></tr>
<tr><td>IT 管理员</td><td>个人账号、直接授权、token 与资产回收</td><td>不删除 legal hold 内容</td></tr>
<tr><td>法务负责人</td><td>邮箱和文件的保留范围与期限</td><td>不延长在职访问权限</td></tr></table>
<h2>对象级执行清单</h2>
<table><tr><th>对象</th><th>批准后动作</th><th>完成凭据</th><th>失败时</th></tr>
<tr><td>SSO / SCIM 个人身份</td><td>08-28 18:00 停用；结束活跃会话</td><td>IAM disable event + session revoke</td><td>身份未停用则案件不关闭</td></tr>
<tr><td>CRM 导出权限、代码发布角色、云访问密钥</td><td>按对象撤权并失效 token</td><td>各系统独立读回 DENIED / REVOKED</td><td>单项失败只重试该对象</td></tr>
<tr><td>客户、项目、审批职责</td><td>分别转给林乔、顾屿与宋宁</td><td>客户主数据、项目台账、OA 角色回读</td><td>无人接手项保持阻断</td></tr>
<tr><td>共享报表身份 svc-sales-report</td><td class="warn">排除自动撤权；由 IT 确认新 owner 后轮换凭据</td><td>owner + secret version 双回读</td><td>不把共享账号当个人账号删除</td></tr>
<tr><td>邮箱与项目文件</td><td class="warn">legal hold 下保留 7 年，取消本人访问但不删除内容</td><td>法务保全单 LH-2026-031</td><td>删除动作一律阻断</td></tr>
<tr><td>MacBook 与硬件密钥</td><td>登记归还、隔离、验收</td><td>资产库签收 + MDM 隔离</td><td>未归还保持案件开放</td></tr></table>
<div class="box"><b>关闭条件</b>：不是“离职工单完成”，而是 HRIS 已离职、个人身份不可登录、直接授权逐项撤销、客户与职责已有 owner、共享身份已人工交接、legal hold 仍有效、资产已签收且 MDM 隔离，八类回读全部一致。</div>
<p class="foot">演示回放。公司、人员、客户、项目、账号、设备与回执均为虚构数据。</p>
</body></html>`;

const HANDOVER_SIZE_BYTES = new TextEncoder().encode(HANDOVER_HTML).length;

const PANEL_BASE: SystemPanelSnapshot = {
  title: "企业系统实况",
  live: true,
  activeView: "people",
  foot: "已连接：HRIS/OA · IAM/SSO/SCIM · SaaS 与 token · CRM/项目 · 资产/MDM · 法务保全（演示）",
  views: [
    {
      key: "people",
      label: "人员基线",
      winTitle: "HRIS / OA · 人员与生效时间",
      toolbar: { title: "周铭 · 离职事件", sub: "尚未核对" },
      widget: {
        kind: "table",
        cols: [
          { key: "object", label: "对象" },
          { key: "owner", label: "当前归属" },
          { key: "target", label: "目标状态" },
          { key: "state", label: "状态", align: "right" },
        ],
        rows: [],
        empty: { title: "尚未读取人员与职责" },
      },
    },
    {
      key: "identity",
      label: "身份权限",
      winTitle: "IAM / SSO / SCIM · 个人身份与直接授权",
      toolbar: { title: "身份、授权与 token", sub: "尚未核对" },
      widget: {
        kind: "table",
        cols: [
          { key: "system", label: "系统" },
          { key: "grant", label: "身份 / 授权" },
          { key: "method", label: "授予方式" },
          { key: "state", label: "状态", align: "right" },
        ],
        rows: [],
        empty: { title: "尚未读取身份与直接授权" },
      },
    },
    {
      key: "business",
      label: "业务交接",
      winTitle: "CRM / 项目 / OA · 客户、项目与审批职责",
      toolbar: { title: "业务对象 owner", sub: "尚未核对" },
      widget: {
        kind: "table",
        cols: [
          { key: "object", label: "业务对象" },
          { key: "current", label: "当前负责人" },
          { key: "next", label: "接手人" },
          { key: "state", label: "状态", align: "right" },
        ],
        rows: [],
        empty: { title: "尚未读取客户、项目和审批职责" },
      },
    },
    {
      key: "assets",
      label: "资产回收",
      winTitle: "资产库 / MDM · 设备与硬件凭据",
      toolbar: { title: "待回收资产", sub: "尚未核对" },
      widget: { kind: "rows", rows: [], empty: { title: "尚未读取资产台账" } },
    },
    {
      key: "hold",
      label: "法务保全",
      winTitle: "法务保全 · 邮箱与文件留置",
      toolbar: { title: "legal hold", sub: "尚未核对" },
      widget: { kind: "rows", rows: [], empty: { title: "尚未读取保全要求" } },
    },
    {
      key: "audit",
      label: "执行留痕",
      winTitle: "离职交接案件 · 动作与权威回执",
      toolbar: { title: "案件 LC-20260828-017", sub: "0 条" },
      widget: { kind: "feed", items: [], empty: { title: "尚无系统动作" } },
    },
  ],
};

export const employeeLifecycleScript: ReplayScript = {
  scenarioId: "catalog-employee-lifecycle-transition-loop",
  title: "员工离职从权限清点到责任与资产终态",
  mode: "hero",
  artifacts: { [HANDOVER_PATH]: HANDOVER_HTML },

  steps: [
    {
      caption: "自动归集离职对象与生效边界",
      blocks: [
        {
          id: "life1-prompt",
          kind: "prompt",
          title: "用户消息",
          defaultOpen: true,
          content: "周铭周五离职，把账号、资产、客户项目和审批职责全部交接。",
        },
        {
          id: "life1-tool",
          kind: "tool_use",
          title: "EmployeeLifecycleRead",
          defaultOpen: true,
          toolName: "EmployeeLifecycleRead",
          toolId: "life-context",
          content: JSON.stringify({
            employeeId: "EMP-0048",
            effectiveAt: "2026-08-28T18:00:00+08:00",
            sources: ["HRIS", "OA", "IAM/SSO/SCIM", "SaaS", "token-vault", "asset/MDM", "CRM", "project", "legal-hold"],
          }),
          executionStatus: "completed",
          durationMs: 2410,
          presentation: {
            title: "六类权威系统已归集，离职事件不能只停一个 OA 账号",
            detail: [
              { k: "人员事件", v: "EMP-0048 周铭 · 08-28 18:00 生效 · 直属经理韩卓" },
              { k: "个人身份", v: "SSO 主身份 1 个、直接授权 3 项、活跃 token 2 个" },
              { k: "业务责任", v: "重点客户 2 家、在交项目 1 个、OA 审批角色 1 个" },
              { tree: "├", k: "共享身份", v: "svc-sales-report 由周铭维护，但不是周铭个人账号" },
              { tree: "├", k: "法务保全", v: "LH-2026-031 要求邮箱和项目文件保留 7 年，禁止删除" },
              { tree: "└", k: "资产", v: "MacBook NB-0317、硬件密钥 YK-092 待归还" },
              { insight: "停 SSO 只能切断主入口，3 项直接授权、共享身份、业务 owner 与两件资产仍会留下真实风险", label: "新判断" },
            ],
            status: "warn",
            panelBase: PANEL_BASE,
            panel: [
              { op: "focus", view: "people" },
              { op: "toolbar", view: "people", title: "周铭 · 离职事件", sub: "HRIS/OA 已核对 · 生效时间 08-28 18:00" },
              { op: "tableRowInsert", view: "people", row: { id: "p-event", cells: { object: "EMP-0048 · 周铭", owner: "渠道业务部", target: "08-28 18:00 离职", state: "待批准" }, tone: "warn" } },
              { op: "tableRowInsert", view: "people", row: { id: "p-manager", cells: { object: "直属经理", owner: "韩卓", target: "确认接手人", state: "待办" }, tone: "warn" } },
              { op: "rowInsert", view: "hold", row: { id: "h-legal", text: "LH-2026-031 · 邮箱与项目文件", sub: "保留 7 年 · 禁止删除 · 只取消本人访问", tone: "warn", badge: { text: "legal hold", tone: "warn" } } },
              { op: "feedAppend", view: "audit", item: { id: "la-1", from: "AI 同事", time: "08-24 09:06", text: "只读归集 HRIS/OA、身份权限、业务 owner、资产与法务保全，未修改任何系统" } },
              { op: "toolbar", view: "audit", title: "案件 LC-20260828-017", sub: "1 条 · 全部只读" },
            ],
          },
        },
        {
          id: "life1-result",
          kind: "tool_result",
          title: "EmployeeLifecycleRead 结果",
          defaultOpen: false,
          toolName: "EmployeeLifecycleRead",
          toolId: "life-context",
          content: "employee=EMP-0048 effectiveAt=2026-08-28T18:00:00+08:00 directGrants=3 tokens=2 sharedIdentity=1 businessOwners=4 assets=2 legalHold=LH-2026-031",
        },
        {
          id: "life1-text",
          kind: "text",
          title: "风险不是一张离职单",
          defaultOpen: true,
          content: "我已经按员工 ID 和生效时间把六类权威系统串起来了。最容易漏的不是 SSO，而是绕过 SCIM 的 3 项直接授权，以及仍挂在周铭名下的客户、项目和审批职责。另有一个共享报表身份不能自动当个人账号撤掉；邮箱与项目文件还被 legal hold 明确要求保留。",
        },
      ],
    },

    {
      caption: "定位直接授权、共享身份与无人接手职责",
      blocks: [
        {
          id: "life2-tool",
          kind: "tool_use",
          title: "LifecycleRiskAnalyze",
          defaultOpen: true,
          toolName: "LifecycleRiskAnalyze",
          toolId: "life-analyze",
          content: JSON.stringify({ employeeId: "EMP-0048", correlateBy: ["employeeId", "identityId", "ownerId"], classifySharedIdentity: true }),
          executionStatus: "completed",
          durationMs: 1950,
          presentation: {
            title: "找到 3 项直接授权、1 个共享身份和 2 项无人接手职责",
            detail: [
              { verdict: "fail", text: "直接授权", note: "CRM 批量导出、代码库发布角色、云访问密钥 AK-7F2；均不随 SCIM 自动撤销" },
              { verdict: "fail", text: "无人接手", note: "客户海岳设备与项目 PX-219 尚未指定新 owner；离职后会形成服务与审批断点" },
              { verdict: "pass", text: "已有接手候选", note: "客户云启材料拟转林乔；OA 价格特批拟转宋宁" },
              { verdict: "warn", text: "共享身份", note: "svc-sales-report 供晨报作业使用，排除自动撤权，需 IT 指定新 owner 并轮换凭据" },
              { verdict: "warn", text: "法务保全", note: "legal hold 阻止邮箱和项目文件删除，但不阻止取消周铭本人访问" },
              { insight: "权限撤销与业务交接必须按对象执行；一处失败时不能把整个案件显示为完成", label: "执行原则" },
            ],
            status: "blocked",
            panel: [
              { op: "focus", view: "identity" },
              { op: "toolbar", view: "identity", title: "身份、授权与 token", sub: "3 项 direct grant · 1 个共享身份" },
              { op: "tableRowInsert", view: "identity", row: { id: "i-sso", cells: { system: "IAM / SSO", grant: "EMP-0048 主身份", method: "SCIM", state: "待停用" }, tone: "warn" } },
              { op: "tableRowInsert", view: "identity", row: { id: "i-crm", cells: { system: "CRM", grant: "批量导出", method: "direct grant", state: "高风险" }, tone: "deny" } },
              { op: "tableRowInsert", view: "identity", row: { id: "i-repo", cells: { system: "代码库", grant: "release-maintainer", method: "direct grant", state: "高风险" }, tone: "deny" } },
              { op: "tableRowInsert", view: "identity", row: { id: "i-ak", cells: { system: "云控制台", grant: "AK-7F2", method: "direct token", state: "高风险" }, tone: "deny" } },
              { op: "tableRowInsert", view: "identity", row: { id: "i-shared", cells: { system: "报表作业", grant: "svc-sales-report", method: "shared identity", state: "排除自动撤权" }, tone: "warn" } },
              { op: "focus", view: "business" },
              { op: "tableRowInsert", view: "business", row: { id: "b-customer1", cells: { object: "客户 · 海岳设备", current: "周铭", next: "尚未指定", state: "阻断" }, tone: "deny" } },
              { op: "tableRowInsert", view: "business", row: { id: "b-project", cells: { object: "项目 · PX-219", current: "周铭", next: "尚未指定", state: "阻断" }, tone: "deny" } },
              { op: "tableRowInsert", view: "business", row: { id: "b-customer2", cells: { object: "客户 · 云启材料", current: "周铭", next: "林乔", state: "待批准" }, tone: "warn" } },
              { op: "tableRowInsert", view: "business", row: { id: "b-approval", cells: { object: "OA · 价格特批", current: "周铭", next: "宋宁", state: "待批准" }, tone: "warn" } },
              { op: "feedAppend", view: "audit", item: { id: "la-2", from: "AI 同事", time: "08-24 09:08", text: "按 employeeId/identityId/ownerId 交叉分析，识别绕过 SCIM 的授权、共享身份及无人接手职责（只读）" } },
              { op: "toolbar", view: "audit", title: "案件 LC-20260828-017", sub: "2 条 · 全部只读" },
            ],
          },
        },
        {
          id: "life2-text",
          kind: "text",
          title: "需要人决定的四个边界",
          defaultOpen: true,
          content: "我不会让一个泛化审批替四个岗位做决定：人力只确认生效时间，直属经理只确认客户、项目与审批接手人，IT 只批准个人身份和直接授权撤销，法务只确认 legal hold。共享身份继续运行与否也不会从“当前维护人”自动推断。",
        },
      ],
    },

    {
      caption: "生成对象级交接单并提交四岗联审",
      blocks: [
        {
          id: "life3-tool",
          kind: "tool_use",
          title: "LifecyclePlanBuild",
          defaultOpen: true,
          toolName: "LifecyclePlanBuild",
          toolId: "life-plan",
          content: JSON.stringify({ employeeId: "EMP-0048", caseId: "LC-20260828-017", output: HANDOVER_PATH }),
          executionStatus: "completed",
          durationMs: 1280,
          presentation: {
            title: "对象级交接单已生成，关闭条件绑定到权威回执",
            detail: [
              { k: "人力边界", v: "08-28 18:00 生效；HRIS 与考勤工资截止" },
              { k: "经理边界", v: "海岳设备→林乔、PX-219→顾屿、云启材料→林乔、价格特批→宋宁" },
              { k: "IT 边界", v: "主身份、活跃会话、3 项直接授权、2 个 token、两件资产" },
              { k: "法务边界", v: "LH-2026-031 继续有效；取消本人访问，不删除邮箱和项目文件" },
              { warn: "共享身份 svc-sales-report 只做人工 owner 交接与凭据轮换，不进入自动撤权批次" },
            ],
            status: "waiting",
            receipt: { id: "PLAN-LC-20260828-017-R1", system: "交接编排台账", readBack: true },
            panel: [
              { op: "focus", view: "audit" },
              { op: "feedAppend", view: "audit", item: { id: "la-3", from: "AI 同事", time: "08-24 09:10", text: "生成对象级执行单 PLAN-LC-20260828-017-R1；审批前零写入" } },
              { op: "toolbar", view: "audit", title: "案件 LC-20260828-017", sub: "3 条 · 等待四岗联审" },
            ],
          },
        },
        {
          id: "life3-text",
          kind: "text",
          title: "离职交接执行单",
          defaultOpen: true,
          content: `我把每个对象、批准人、失败边界和关闭凭据写进了执行单。四个岗位可以在一处联审，但彼此不能越权代批。\n\n[FILE]{"filePath":"${HANDOVER_PATH}","fileName":"周铭离职交接执行单.html","fileSize":${HANDOVER_SIZE_BYTES}}[/FILE]`,
        },
      ],
    },

    {
      caption: "四个岗位只批准自己的边界后执行",
      blocks: [],
      approval: {
        title: "员工离职交接 · 四岗最窄联审",
        description: "四个岗位分别确认自己的业务边界。通过后按 08-28 18:00 生效；共享身份与 legal hold 内容不会进入个人身份自动撤权批次。",
        facts: [
          { label: "人力负责人", value: "确认 EMP-0048 于 08-28 18:00 离职，HRIS、考勤与工资按该时点截止" },
          { label: "直属经理", value: "客户海岳设备/云启材料→林乔；项目 PX-219→顾屿；价格特批→宋宁" },
          { label: "IT 管理员", value: "撤销主身份、会话、3 项直接授权与 2 个 token；登记两件资产回收" },
          { label: "法务负责人", value: "LH-2026-031 保留邮箱与项目文件 7 年，只取消本人访问，禁止删除" },
          { label: "明确排除", value: "svc-sales-report 不自动撤权；待 IT 指定新 owner 后单独轮换凭据" },
        ],
        approveLabel: "四岗确认并按时执行",
        rejectLabel: "退回补接手人",
        approvedBlocks: [
          {
            id: "life4-approval",
            kind: "tool_use",
            title: "Approval",
            defaultOpen: true,
            toolName: "Approval",
            toolId: "life-approval",
            content: JSON.stringify({ caseId: "LC-20260828-017", approvals: ["HR", "manager", "IT", "legal"], decision: "approved" }),
            executionStatus: "completed",
            durationMs: 430,
            presentation: {
              title: "四个岗位的授权边界已绑定，未授权动作保持关闭",
              detail: [
                { verdict: "pass", text: "人力", note: "08-28 18:00 生效时间已确认" },
                { verdict: "pass", text: "直属经理", note: "四项业务职责接手人已确认" },
                { verdict: "pass", text: "IT", note: "个人身份、direct grants、token 与资产回收已授权" },
                { verdict: "pass", text: "法务", note: "保留 7 年；删除邮箱与项目文件未获授权" },
                { verdict: "warn", text: "共享身份", note: "排除自动撤权，进入 IT 人工交接队列" },
              ],
              status: "ok",
              receipt: { id: "APR-LC-017-R1", system: "审批中心", readBack: true },
              panel: [
                { op: "focus", view: "audit" },
                { op: "feedAppend", view: "audit", item: { id: "la-4", from: "人力 / 直属经理 / IT / 法务", time: "08-24 09:18", text: "四岗联审通过；每项授权已绑定岗位、对象与未授权边界" } },
                { op: "toolbar", view: "audit", title: "案件 LC-20260828-017", sub: "4 条 · 等待生效时点" },
              ],
            },
          },
          {
            id: "life4-execute",
            kind: "tool_use",
            title: "LifecycleExecute",
            defaultOpen: true,
            toolName: "LifecycleExecute",
            toolId: "life-execute",
            content: JSON.stringify({
              caseId: "LC-20260828-017",
              effectiveAt: "2026-08-28T18:00:00+08:00",
              exclude: ["svc-sales-report", "legal-hold-content"],
              idempotencyKey: "LC-20260828-017-R1",
            }),
            executionStatus: "completed",
            durationMs: 3220,
            presentation: {
              title: "权限与职责写入已回读，设备未归还使案件保持开放",
              detail: [
                { verdict: "pass", text: "HRIS / IAM", note: "离职状态生效；SSO 已停用，12 个活跃会话结束" },
                { verdict: "pass", text: "direct grants / token", note: "CRM 导出、代码发布、AK-7F2 与 2 个 token 均回读为 REVOKED" },
                { verdict: "pass", text: "客户 / 项目 / OA", note: "四项职责已分别写入林乔、顾屿和宋宁名下" },
                { verdict: "pass", text: "legal hold", note: "LH-2026-031 仍 ACTIVE；周铭本人访问已取消，内容未删除" },
                { verdict: "warn", text: "共享身份", note: "未自动撤权；等待 IT 确认新 owner 与轮换凭据" },
                { verdict: "fail", text: "资产", note: "NB-0317 与 YK-092 尚未签收，案件不能关闭" },
              ],
              status: "waiting",
              receipt: { id: "RUN-LC-017-R1", system: "交接编排台账", readBack: true },
              panel: [
                { op: "focus", view: "identity" },
                { op: "tableRowUpdate", view: "identity", id: "i-sso", set: { cells: { state: "DISABLED" }, tone: "pass" } },
                { op: "tableRowUpdate", view: "identity", id: "i-crm", set: { cells: { state: "REVOKED" }, tone: "pass" } },
                { op: "tableRowUpdate", view: "identity", id: "i-repo", set: { cells: { state: "REVOKED" }, tone: "pass" } },
                { op: "tableRowUpdate", view: "identity", id: "i-ak", set: { cells: { state: "REVOKED" }, tone: "pass" } },
                { op: "focus", view: "business" },
                { op: "tableRowUpdate", view: "business", id: "b-customer1", set: { cells: { next: "林乔", state: "已转交" }, tone: "pass" } },
                { op: "tableRowUpdate", view: "business", id: "b-project", set: { cells: { next: "顾屿", state: "已转交" }, tone: "pass" } },
                { op: "tableRowUpdate", view: "business", id: "b-customer2", set: { cells: { state: "已转交" }, tone: "pass" } },
                { op: "tableRowUpdate", view: "business", id: "b-approval", set: { cells: { state: "已转交" }, tone: "pass" } },
                { op: "focus", view: "assets" },
                { op: "rowsSet", view: "assets", rows: [
                  { id: "a-mac", text: "MacBook NB-0317", sub: "尚未归还 · MDM 保持远程锁定待命", tone: "warn", badge: { text: "待签收", tone: "warn" } },
                  { id: "a-key", text: "硬件密钥 YK-092", sub: "尚未归还 · 认证绑定已撤销", tone: "warn", badge: { text: "待签收", tone: "warn" } },
                ] },
                { op: "feedAppend", view: "audit", item: { id: "la-5", from: "交接编排器", time: "08-28 18:04", text: "个人权限与业务职责已写入并回读；共享身份、两件资产仍待处理，案件保持 OPEN" } },
                { op: "toolbar", view: "audit", title: "案件 LC-20260828-017", sub: "5 条 · OPEN" },
              ],
            },
          },
        ],
        rejectedBlocks: [
          {
            id: "life4-reject",
            kind: "tool_use",
            title: "ApprovalReject",
            defaultOpen: true,
            toolName: "ApprovalReject",
            toolId: "life-reject",
            content: JSON.stringify({ caseId: "LC-20260828-017", decision: "rejected", reason: "project-owner-missing" }),
            executionStatus: "completed",
            durationMs: 260,
            presentation: {
              title: "联审被退回，权限、职责与资产流程全部保持未执行",
              detail: [
                { verdict: "pass", text: "身份零写入", note: "SSO、direct grants、token 均保持原状态" },
                { verdict: "pass", text: "业务 owner 零写入", note: "客户、项目与 OA 角色没有使用半套接手方案" },
                { verdict: "pass", text: "内容与资产零动作", note: "legal hold 内容未删除，资产回收未伪造签收" },
                { warn: "补齐 PX-219 接手人后必须重新走四岗联审；被退回的授权不可复用" },
              ],
              status: "blocked",
              panel: [
                { op: "focus", view: "audit" },
                { op: "feedAppend", view: "audit", item: { id: "la-reject", from: "直属经理", time: "08-24 09:18", text: "退回：PX-219 尚无接手人；身份、职责、内容和资产均零写入" } },
                { op: "toolbar", view: "audit", title: "案件 LC-20260828-017", sub: "4 条 · 已退回" },
              ],
            },
          },
          {
            id: "life4-reject-text",
            kind: "text",
            title: "退回后的下文",
            defaultOpen: true,
            content: "流程停在联审点，SSO、3 项直接授权、2 个 token、四项业务职责和两件资产都没有变。legal hold 内容也没有删除。补齐 PX-219 接手人后需要重新提交，不能拿这次被退回的决定继续执行。",
          },
        ],
      },
    },

    {
      caption: "追到共享身份移交与资产签收",
      blocks: [
        {
          id: "life5-tool",
          kind: "tool_use",
          title: "LifecycleExceptionResolve",
          defaultOpen: true,
          toolName: "LifecycleExceptionResolve",
          toolId: "life-resolve",
          content: JSON.stringify({
            caseId: "LC-20260828-017",
            events: ["shared-identity-owner-confirmed", "secret-rotated", "asset-received", "mdm-isolated"],
          }),
          executionStatus: "completed",
          durationMs: 2180,
          presentation: {
            title: "两项未决例外取得权威回执，案件具备关闭条件",
            detail: [
              { verdict: "pass", text: "共享身份", note: "IT 人工确认 owner=蒋闻；secret version 从 18 轮换到 19，旧凭据失效" },
              { verdict: "pass", text: "MacBook NB-0317", note: "资产库 08-31 10:22 签收；MDM 10:24 回读 ISOLATED" },
              { verdict: "pass", text: "硬件密钥 YK-092", note: "资产库 08-31 10:22 签收；认证绑定保持 REVOKED" },
              { verdict: "pass", text: "案件状态", note: "从 OPEN 更新为 READY_TO_CLOSE；尚待最终独立回读" },
              { insight: "共享身份不是被自动删掉，而是经 IT 人工确定业务 owner 后完成凭据轮换", label: "例外闭环" },
            ],
            status: "ok",
            receipt: { id: "EXC-LC-017-0831", system: "交接编排台账", readBack: true },
            panel: [
              { op: "focus", view: "identity" },
              { op: "tableRowUpdate", view: "identity", id: "i-shared", set: { cells: { state: "owner=蒋闻 · v19" }, tone: "pass" } },
              { op: "focus", view: "assets" },
              { op: "rowsSet", view: "assets", rows: [
                { id: "a-mac", text: "MacBook NB-0317", sub: "08-31 10:22 已签收 · MDM 10:24 ISOLATED", tone: "pass", badge: { text: "已回读", tone: "pass" } },
                { id: "a-key", text: "硬件密钥 YK-092", sub: "08-31 10:22 已签收 · 认证绑定 REVOKED", tone: "pass", badge: { text: "已回读", tone: "pass" } },
              ] },
              { op: "feedAppend", view: "audit", item: { id: "la-6", from: "IT / 资产管理员", time: "08-31 10:25", text: "共享身份 owner 与 secret version 已回读；两件资产已签收并完成设备隔离" } },
              { op: "toolbar", view: "audit", title: "案件 LC-20260828-017", sub: "6 条 · READY_TO_CLOSE" },
            ],
          },
        },
        {
          id: "life5-text",
          kind: "text",
          title: "未决项已经清零",
          defaultOpen: true,
          content: "案件在设备未归还时一直保持 OPEN。现在资产库和 MDM 已分别给出签收与隔离回执；共享身份也不是自动删除，而是由 IT 明确新 owner 后轮换凭据。下一步我会绕开本轮缓存，分别从各权威系统按对象 ID 反查终态。",
        },
      ],
    },

    {
      caption: "独立回读人员、权限、职责、保全与资产终态",
      blocks: [
        {
          id: "life6-tool",
          kind: "tool_use",
          title: "LifecycleReadBack",
          defaultOpen: true,
          toolName: "LifecycleReadBack",
          toolId: "life-readback",
          content: JSON.stringify({
            caseId: "LC-20260828-017",
            useSessionCache: false,
            objectIds: ["EMP-0048", "IAM-991", "AK-7F2", "PX-219", "LH-2026-031", "NB-0317", "YK-092", "svc-sales-report"],
          }),
          executionStatus: "completed",
          durationMs: 1760,
          presentation: {
            title: "八类权威对象回读一致，离职交接案件可关闭",
            detail: [
              { k: "回读方式", v: "按员工、身份、授权、业务对象、保全单、资产和共享身份分别查询，不使用会话缓存" },
              { verdict: "pass", text: "HRIS / IAM", note: "离职状态 EFFECTIVE；SSO 登录 DENIED；活跃会话 0" },
              { verdict: "pass", text: "SaaS / token", note: "3 项 direct grant 与 2 个 token 均为 REVOKED" },
              { verdict: "pass", text: "CRM / 项目 / OA", note: "四项业务对象均有新 owner，无职责悬空" },
              { verdict: "pass", text: "法务 / 资产", note: "legal hold ACTIVE 且本人访问取消；两件资产已签收并隔离" },
              { verdict: "pass", text: "共享身份", note: "owner=蒋闻，secret v19；没有被误当个人账号删除" },
              { insight: "关闭依据来自八类权威对象的一致终态，不是离职工单上的“已完成”标签", label: "业务终态" },
            ],
            status: "ok",
            receipt: { id: "CLOSE-LC-20260828-017", system: "交接编排台账", readBack: true },
            panel: [
              { op: "focus", view: "people" },
              { op: "tableRowUpdate", view: "people", id: "p-event", set: { cells: { state: "EFFECTIVE" }, tone: "pass" } },
              { op: "tableRowUpdate", view: "people", id: "p-manager", set: { cells: { target: "4 项职责均已接手", state: "已完成" }, tone: "pass" } },
              { op: "focus", view: "hold" },
              { op: "rowsSet", view: "hold", rows: [
                { id: "h-legal", text: "LH-2026-031 · 邮箱与项目文件", sub: "ACTIVE · 保留 7 年 · 周铭访问已取消 · 内容未删除", tone: "pass", badge: { text: "保全有效", tone: "pass" } },
              ] },
              { op: "feedAppend", view: "audit", item: { id: "la-7", from: "AI 同事", time: "08-31 10:28", text: "独立回读八类权威对象，全部达到关闭条件；案件 CLOSED" } },
              { op: "toolbar", view: "audit", title: "案件 LC-20260828-017", sub: "7 条 · CLOSED" },
            ],
          },
        },
        {
          id: "life6-text",
          kind: "text",
          title: "离职交接终态",
          defaultOpen: true,
          content: [
            "## 跨系统终态核对",
            "",
            "| 权威系统 | 对象 | 回读终态 | 关闭依据 |",
            "| --- | --- | --- | --- |",
            "| HRIS / OA | EMP-0048 · 周铭 | 离职 EFFECTIVE；考勤工资截止 08-28 18:00 | HRIS 人员事件 + OA 生效记录 |",
            "| IAM / SSO / SCIM | IAM-991 | 登录 DENIED；活跃会话 0 | IAM disable event + session revoke |",
            "| CRM / 代码库 / 云控制台 | 3 项 direct grant、2 个 token | 全部 REVOKED | 各系统按 grant/token ID 独立查询 |",
            "| CRM / 项目 / OA | 2 家客户、PX-219、价格特批 | 林乔、顾屿、宋宁分别接手；无人悬空 | 对象 owner 与审批角色回读 |",
            "| 报表作业 | svc-sales-report | owner=蒋闻；secret v19，旧凭据失效 | IT 人工确认 + 凭据库版本 |",
            "| 法务保全 | LH-2026-031 | ACTIVE；周铭访问取消；内容保留 7 年 | 法务保全单 + 邮箱/文件权限回读 |",
            "| 资产库 / MDM | NB-0317、YK-092 | 已签收；设备 ISOLATED；认证绑定 REVOKED | 资产签收单 + MDM / IAM 状态 |",
            "| 交接编排台账 | LC-20260828-017 | CLOSED | 上述八类对象全部满足，非工单自证 |",
            "",
            "## 本次交接没有做什么",
            "",
            "- 没有只停 SSO 就宣称权限清零：绕过 SCIM 的直接授权和 token 都按对象撤销并回读；",
            "- 没有把 svc-sales-report 当作个人账号自动删除：它由 IT 指定新 owner 后轮换凭据；",
            "- 没有删除邮箱或项目文件：legal hold 明确阻止删除，只取消周铭本人访问；",
            "- 没有在设备未归还时关闭案件：直到资产库签收和 MDM 隔离回执同时出现，状态才从 OPEN 进入可关闭；",
            "- 没有让一个审批人代替所有岗位决定：人力、直属经理、IT、法务只批准各自边界。",
          ].join("\n"),
        },
      ],
    },
  ],

  sources: [
    {
      blockRef: "step1.tool.EmployeeLifecycleRead",
      producer: "HRIS/OA、IAM/SSO/SCIM、SaaS、资产、业务系统与法务保全连接器",
      state: "missing",
      gap: "当前没有按 employeeId、identityId 与 ownerId 统一关联人员事件、个人身份、直接授权、资产、业务责任和 legal hold 的租户连接器。",
    },
    {
      blockRef: "step2.tool.LifecycleRiskAnalyze",
      producer: "身份图谱与业务对象 owner 分析器",
      state: "missing",
      gap: "缺少区分 SCIM 授权、直接授权、共享身份和无人接手职责的确定性归类与对象级风险计算。",
    },
    {
      blockRef: "step3.tool.LifecyclePlanBuild",
      producer: "Agent 生成对象级离职交接计划",
      state: "exists",
    },
    {
      blockRef: "step3.artifact.周铭离职交接执行单",
      producer: "Agent 生成自包含 HTML 产物",
      state: "exists",
    },
    {
      blockRef: "step4.tool.Approval",
      producer: "业务审批执行器",
      state: "needs-change",
      gap: "现有审批尚不能把 HR、直属经理、IT、法务各自的对象范围、失败边界和未授权动作绑定为同一离职案件。",
    },
    {
      blockRef: "step4.tool.LifecycleExecute",
      producer: "员工生命周期跨系统幂等执行器",
      state: "missing",
      gap: "缺少按生效时点撤权、逐项转 owner、保留 legal hold、排除共享身份并在部分失败时保持案件开放的统一执行器。",
    },
    {
      blockRef: "step4.tool.ApprovalReject",
      producer: "业务审批执行器（退回分支）",
      state: "needs-change",
      gap: "退回事件存在，但身份、业务 owner、保全与资产四类零写入尚不能形成统一的可验证回执。",
    },
    {
      blockRef: "step5.tool.LifecycleExceptionResolve",
      producer: "员工生命周期异常队列与跨天续跑器",
      state: "missing",
      gap: "缺少在主执行完成后持续追踪共享身份人工交接、资产签收和 MDM 隔离，并只重试未完成对象的持久运行时。",
    },
    {
      blockRef: "step6.tool.LifecycleReadBack",
      producer: "员工生命周期终态独立回读器",
      state: "missing",
      gap: "需要稳定的员工、身份、grant、token、业务对象、保全单、资产和共享身份对象 ID，以及不依赖会话缓存的跨系统一致性断言。",
    },
  ],
};

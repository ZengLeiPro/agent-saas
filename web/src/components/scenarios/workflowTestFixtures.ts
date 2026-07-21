import type { CatalogScenarioPublic, WorkflowLibraryPublicV3 } from "@agent/shared";

export function makeWorkflowScenario(
  id: string,
  overrides: Partial<CatalogScenarioPublic> = {},
): CatalogScenarioPublic {
  return {
    id,
    workflowId: `workflow-${id}`,
    roleViewIds: ["sales-view"],
    title: `业务结果 ${id}`,
    value: "把业务对象推进到可回读的终态",
    shortChain: ["读取状态", "判断异常", "执行动作", "重新回读"],
    roleIds: ["sales"],
    industryTags: ["manufacturing"],
    industryVerticals: ["机械装备"],
    businessModels: ["生产制造"],
    maturityLevels: ["已有单体系统"],
    goalTags: ["推进成交"],
    triggerBadge: "业务事件",
    actionBadge: "会写系统",
    humanApprovalSummary: "关键动作需确认",
    detail: {
      event: "收到新的业务事件",
      reads: ["读取 CRM 与订单状态"],
      decides: "结合企业规则判断下一动作",
      acts: ["写入受控状态", "通知责任人"],
      approval: "高风险动作由负责人确认",
      beforeAfter: "从待处理变为已回读确认",
      followUp: "等待反馈并在超时后升级",
      valueProof: "目标系统回读与业务指标共同证明完成",
    },
    launch: {
      sampleAvailable: false,
      isolatedDemoAvailable: false,
      startMode: "chat",
      starterMessage: "请启动这个工作流，并先说明需要的资料。",
    },
    primaryType: "LOOP",
    readiness: "D0_CURRENT",
    cta: { primary: "立即试一试" },
    demo: { evidenceLevel: "design_only" },
    featured: false,
    ...overrides,
  };
}

export function makeWorkflowLibrary(scenarios: CatalogScenarioPublic[]): WorkflowLibraryPublicV3 {
  return {
    schemaVersion: 3,
    workflowContractVersion: 2,
    updatedAt: "2026-07-21",
    roles: [
      { id: "sales", name: "销售", sort: 1 },
      { id: "finance", name: "财务", sort: 2 },
    ],
    scenarios,
    deferredObjects: [],
    workflows: scenarios.map((scenario) => ({
      id: scenario.workflowId,
      definitionVersion: 1,
      primaryType: scenario.primaryType,
      readiness: scenario.readiness,
      summary: {
        jobToBeDone: "推进业务对象到终态",
        objective: "减少遗漏",
        lossIfIgnored: "收入或交付受损",
        trigger: "业务事件触发",
        observe: ["读取业务系统"],
        judge: "结合规则与上下文判断",
        uncertainty: "证据不足时等待或转人工",
        act: ["执行受控动作"],
        approval: "关键动作人审",
        wait: "等待业务反馈",
        escalation: "超时升级",
        verify: "动作后重新读取",
        outcome: "业务对象进入终态",
        proof: "系统回读与业务指标",
      },
      capabilities: [{ id: "current", kind: "CURRENT", required: true, label: "当前能力" }],
    })),
    skins: [],
    roleViews: [],
    demos: [],
    aliases: [],
  };
}

export function makeWorkflowSkin(
  workflowId: string,
  overrides: Partial<WorkflowLibraryPublicV3["skins"][number]> = {},
): WorkflowLibraryPublicV3["skins"][number] {
  return {
    id: `skin-${workflowId}`,
    workflowId,
    title: "生产制造版本",
    industryVerticals: ["机械装备/自动化"],
    businessModels: ["生产制造"],
    readiness: "D1_CONNECTOR",
    objectLabels: [{ key: "order", label: "生产订单与交期承诺" }],
    rules: ["交期承诺必须结合产能与缺料状态"],
    systems: ["ERP、MES"],
    evidenceRequired: ["订单、排程与回读状态"],
    ownership: {
      primaryOwner: "生产计划负责人",
      collaborators: ["销售负责人"],
      strongApprovalRoles: ["生产负责人"],
      approvalReason: "对外交期承诺需要负责人确认",
    },
    terminal: {
      successState: "交期承诺已写入并获得回读确认",
      readback: "重新查询订单与排程状态",
    },
    operations: [{
      target: "生产订单",
      operation: "写入交期承诺",
      approval: "生产负责人确认",
      readback: "查询订单最新交期",
      successState: "交期已确认",
      failureState: "交期未写入或与排程冲突",
      compensation: "撤回承诺并转人工重排",
    }],
    metrics: ["按期交付率"],
    evidenceStatus: "本地流程证据已核",
    maturityProfiles: [
      { level: "Excel/钉钉为主", deliveryPath: "钉钉表格与人工确认", readiness: "D1_CONNECTOR", cta: "接入我的系统" },
      { level: "已有单体系统", deliveryPath: "连接 ERP/MES", readiness: "D1_CONNECTOR", cta: "接入我的系统" },
      { level: "多系统已集成", deliveryPath: "复用既有集成总线", readiness: "D1_CONNECTOR", cta: "接入我的系统" },
    ],
    ...overrides,
  };
}

import {
  workflowLibraryPublicV3Schema,
  type CatalogScenarioPublic,
  type WorkflowLibraryFileV3,
  type WorkflowLibraryPublicV3,
} from "../schemas/workflowScenario.js";

function ctaFor(
  readiness: CatalogScenarioPublic["readiness"],
  hasPublishedDemo: boolean,
): CatalogScenarioPublic["cta"] {
  if (readiness === "D0_CURRENT") {
    return { primary: hasPublishedDemo ? "用示例数据体验" : "立即试一试" };
  }
  if (readiness === "D1_CONNECTOR") {
    return { primary: "接入我的系统", secondary: "查看工作流" };
  }
  return { primary: "预约落地诊断", secondary: "查看行业演示" };
}

function startModeFor(
  readiness: CatalogScenarioPublic["readiness"],
  hasPublishedDemo: boolean,
): CatalogScenarioPublic["launch"]["startMode"] {
  if (readiness === "D0_CURRENT") return hasPublishedDemo ? "replay" : "chat";
  if (readiness === "D1_CONNECTOR") return "connector";
  return "diagnosis";
}

const PUBLIC_STAGE_LABELS: Record<string, string> = {
  "business-context": "业务事实与上下文",
  decision: "判断与取舍",
  action: "系统动作与协作",
  verification: "结果回读与验证",
};

const SKIN_EVIDENCE_STATUS_LABELS = {
  local_verified: "本地流程证据已核",
  external_process_verified: "外部流程证据已核",
  regulatory_only: "当前主要依据监管规则",
  interview_required: "需要客户访谈核验",
} as const;

const MATURITY_LEVEL_LABELS = {
  M0_FRAGMENTED: "Excel/钉钉为主",
  M1_SYSTEMED: "已有单体系统",
  M2_INTEGRATED: "多系统已集成",
} as const;

/**
 * 显式逐字段投影。这里故意不使用 spread/rest：新增 internal 字段时，
 * 它不会自动进入客户响应；新增公开字段必须同步修改 projection 与 public schema。
 */
export function projectWorkflowLibraryPublic(
  library: WorkflowLibraryFileV3,
): WorkflowLibraryPublicV3 {
  const workflowById = new Map(library.workflows.map((workflow) => [workflow.id, workflow]));
  const roleIdByRoleViewId = new Map(
    library.workflows.flatMap((workflow) => (
      workflow.roleViews.map((roleView) => [roleView.id, roleView.roleId] as const)
    )),
  );
  const scenarios: CatalogScenarioPublic[] = library.catalogScenarios
    .filter((scenario) => scenario.internal.enabled)
    .map((scenario) => {
      const workflow = workflowById.get(scenario.workflowId);
      if (!workflow || !workflow.internal.enabled || workflow.internal.reviewStatus === "deferred") {
        throw new Error(`目录 ${scenario.id} 引用了不可发布的 Workflow`);
      }
      const launch: CatalogScenarioPublic["launch"] = {
        sampleAvailable: false,
        isolatedDemoAvailable: workflow.readiness !== "D0_CURRENT"
          && library.demos.some((demo) => (
            demo.id === scenario.internal.defaultDemoId
            && demo.environment.kind === "isolated_stateful"
          )),
        startMode: startModeFor(workflow.readiness, false),
        starterMessage: `请启动「${scenario.public.title}」。先说明当前可直接完成的范围，以及需要我提供哪些资料；不要假设已经连接未配置的系统。`,
      };
      if (scenario.public.launch.inputHint) launch.inputHint = scenario.public.launch.inputHint;

      const projectedScenario: CatalogScenarioPublic = {
        id: scenario.id,
        workflowId: scenario.workflowId,
        roleViewIds: scenario.roleViewIds.map((id) => id),
        title: scenario.public.title,
        value: scenario.public.value,
        shortChain: scenario.public.shortChain.map((step) => step),
        roleIds: scenario.public.roleIds.map((id) => id),
        industryTags: scenario.public.industryTags.map((id) => id),
        industryVerticals: scenario.public.industryVerticals.map((id) => id),
        businessModels: scenario.public.businessModels.map((id) => id),
        maturityLevels: scenario.public.maturityLevels.map((id) => id),
        goalTags: scenario.public.goalTags.map((id) => id),
        triggerBadge: scenario.public.triggerBadge,
        actionBadge: scenario.public.actionBadge,
        humanApprovalSummary: scenario.public.humanApprovalSummary,
        detail: {
          event: scenario.public.detail.event,
          reads: scenario.public.detail.reads.map((item) => item),
          decides: scenario.public.detail.decides,
          acts: scenario.public.detail.acts.map((item) => item),
          approval: scenario.public.detail.approval,
          beforeAfter: scenario.public.detail.beforeAfter,
          followUp: scenario.public.detail.followUp,
          valueProof: scenario.public.detail.valueProof,
        },
        launch,
        primaryType: workflow.primaryType,
        readiness: workflow.readiness,
        cta: ctaFor(workflow.readiness, false),
        demo: {
          evidenceLevel: "design_only",
        },
        featured: scenario.internal.hero?.featured === true,
        ...(scenario.internal.hero?.featured && scenario.internal.hero.order
          ? { featuredOrder: scenario.internal.hero.order }
          : {}),
      };
      if (scenario.skinId) projectedScenario.skinId = scenario.skinId;
      return projectedScenario;
    });

  const projected = {
    schemaVersion: 3 as const,
    workflowContractVersion: 2 as const,
    updatedAt: library.updatedAt,
    roles: [...library.roles]
      .sort((left, right) => left.sort - right.sort)
      .map((role) => ({ id: role.id, name: role.name, sort: role.sort })),
    scenarios,
    deferredObjects: library.deferredObjects.map((item) => ({
      id: item.id,
      kind: item.kind,
      reason: item.reason,
      status: item.status,
    })),
    workflows: library.workflows
      .filter((workflow) => workflow.internal.enabled && workflow.internal.reviewStatus !== "deferred")
      .map((workflow) => ({
        id: workflow.id,
        definitionVersion: workflow.definitionVersion,
        primaryType: workflow.primaryType,
        readiness: workflow.readiness,
        summary: {
          jobToBeDone: workflow.publicSummary.jobToBeDone,
          objective: workflow.publicSummary.objective,
          lossIfIgnored: workflow.publicSummary.lossIfIgnored,
          trigger: workflow.publicSummary.trigger,
          observe: workflow.publicSummary.observe.map((item) => item),
          judge: workflow.publicSummary.judge,
          uncertainty: workflow.publicSummary.uncertainty,
          act: workflow.publicSummary.act.map((item) => item),
          approval: workflow.publicSummary.approval,
          wait: workflow.publicSummary.wait,
          escalation: workflow.publicSummary.escalation,
          verify: workflow.publicSummary.verify,
          outcome: workflow.publicSummary.outcome,
          proof: workflow.publicSummary.proof,
        },
        capabilities: workflow.capabilityRequirements.map((capability) => ({
          id: capability.id,
          kind: capability.kind,
          required: capability.required,
          label: capability.publicLabel,
        })),
      })),
    skins: library.workflows
      .filter((workflow) => workflow.internal.enabled && workflow.internal.reviewStatus !== "deferred")
      .flatMap((workflow) => {
        return workflow.skins.map((skin) => ({
          id: skin.id,
          workflowId: workflow.id,
          title: skin.title,
          industryVerticals: skin.industryVerticals.map((item) => item),
          businessModels: skin.businessModels.map((item) => item),
          readiness: skin.readinessOverride ?? workflow.readiness,
          objectLabels: skin.objectLabels.map((item) => ({ key: item.key, label: item.label })),
          rules: skin.rules.map((rule) => rule.description),
          systems: skin.systemsAndEvidence.systems.map((item) => item),
          evidenceRequired: skin.systemsAndEvidence.evidence.map((item) => item),
          ownership: {
            primaryOwner: skin.ownership.primaryOwner,
            collaborators: skin.ownership.collaboratorRoles.map((item) => item),
            strongApprovalRoles: skin.ownership.strongApprovalRoles.map((item) => item),
            approvalReason: skin.ownership.approvalReason,
          },
          terminal: {
            successState: skin.terminal.successState,
            readback: skin.terminal.readback,
          },
          operations: skin.operationAdapters.map((adapter) => ({
            target: adapter.target,
            operation: adapter.operation,
            approval: adapter.approval,
            readback: adapter.readback,
            successState: adapter.successState,
            failureState: adapter.failureState,
            compensation: adapter.compensation,
          })),
          metrics: skin.metrics.map((item) => item),
          evidenceStatus: SKIN_EVIDENCE_STATUS_LABELS[skin.evidence.status],
          maturityProfiles: skin.maturityProfiles.map((profile) => ({
            level: MATURITY_LEVEL_LABELS[profile.level],
            deliveryPath: profile.deliveryPath,
            readiness: profile.readiness,
            cta: profile.cta,
          })),
        }));
      }),
    roleViews: library.workflows
      .filter((workflow) => workflow.internal.enabled && workflow.internal.reviewStatus !== "deferred")
      .flatMap((workflow) => {
        const actionById = new Map(workflow.runtime.act.map((action) => [action.id, action.publicLabel]));
        return workflow.roleViews.map((roleView) => ({
          id: roleView.id,
          workflowId: workflow.id,
          roleId: roleView.roleId,
          title: roleView.title,
          responsibilities: roleView.responsibilities.map((item) => item),
          visibleStages: roleView.visibleStageIds.map((id) => PUBLIC_STAGE_LABELS[id] ?? "业务阶段"),
          actions: roleView.permittedActionRefs.map((id) => {
            const label = actionById.get(id);
            if (!label) throw new Error(`岗位视图 ${roleView.id} 引用了不存在的动作`);
            return label;
          }),
          approvalSummary: roleView.approvalPolicyRefs.length > 0
            ? "本岗位涉及的写入或承诺需要按授权确认"
            : "本岗位以查看和协作为主",
        }));
      }),
    // 公开运行事实只由 Server 在查询时从不可变 WorkflowDemoStore 动态注入。
    demos: [],
    aliases: library.scenarioAliases.map((alias) => {
      const roleId = alias.roleViewId ? roleIdByRoleViewId.get(alias.roleViewId) : undefined;
      if (alias.roleViewId && !roleId) throw new Error(`旧入口 ${alias.legacySlug} 角色视图无效`);
      const projectedAlias: WorkflowLibraryPublicV3["aliases"][number] = alias.resolution === "catalog"
        ? {
            legacySlug: alias.legacySlug,
            resolution: "catalog",
            targetCatalogScenarioId: alias.targetCatalogScenarioId,
            ...(alias.skinId ? { skinId: alias.skinId } : {}),
            ...(alias.roleViewId ? { roleViewId: alias.roleViewId } : {}),
            ...(roleId ? { roleId } : {}),
          }
        : {
            legacySlug: alias.legacySlug,
            resolution: "deferred",
            deferredObjectId: alias.deferredObjectId,
            ...(alias.roleViewId ? { roleViewId: alias.roleViewId } : {}),
            ...(roleId ? { roleId } : {}),
          };
      return projectedAlias;
    }),
  };

  // public schema 负责递归 typed sanitize；命中 hard block 或未知字段时抛错，API fail closed。
  return workflowLibraryPublicV3Schema.parse(projected);
}

export type ResolvedScenarioSlug = {
  resolution: "catalog";
  scenario: CatalogScenarioPublic;
  resolvedFromLegacySlug?: string;
  skinId?: string;
  roleViewId?: string;
  roleId?: string;
} | {
  resolution: "deferred";
  deferredObject: WorkflowLibraryPublicV3["deferredObjects"][number];
  resolvedFromLegacySlug: string;
  roleViewId?: string;
  roleId?: string;
};

/** canonical 优先、alias 次之，只解析一跳；不模糊匹配。 */
export function resolveScenarioSlug(
  library: WorkflowLibraryPublicV3,
  slug: string,
): ResolvedScenarioSlug | null {
  const canonical = library.scenarios.find((scenario) => scenario.id === slug);
  if (canonical) return { resolution: "catalog", scenario: canonical };

  const alias = library.aliases.find((item) => item.legacySlug === slug);
  if (!alias) return null;
  if (alias.resolution === "deferred") {
    const deferredObject = library.deferredObjects.find((item) => item.id === alias.deferredObjectId);
    if (!deferredObject) return null;
    const resolved: ResolvedScenarioSlug = {
      resolution: "deferred",
      deferredObject,
      resolvedFromLegacySlug: slug,
    };
    if (alias.roleViewId) resolved.roleViewId = alias.roleViewId;
    if (alias.roleId) resolved.roleId = alias.roleId;
    return resolved;
  }
  const scenario = library.scenarios.find((item) => item.id === alias.targetCatalogScenarioId);
  if (!scenario) return null;
  const resolved: ResolvedScenarioSlug = {
    resolution: "catalog",
    scenario,
    resolvedFromLegacySlug: slug,
  };
  if (alias.skinId) resolved.skinId = alias.skinId;
  if (alias.roleViewId) resolved.roleViewId = alias.roleViewId;
  if (alias.roleId) resolved.roleId = alias.roleId;
  return resolved;
}

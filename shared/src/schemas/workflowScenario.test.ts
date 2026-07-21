import { describe, expect, it } from "vitest";
import { projectWorkflowLibraryPublic } from "../security/projectWorkflowPublic.js";
import {
  demoManifestRecordSchema,
  workflowDefinitionRecordSchema,
  workflowLibraryFileV3Schema,
  workflowPublicTextSchema,
} from "./workflowScenario.js";

function createDefinition() {
  return {
    id: "verified-artifact-create",
    definitionVersion: 1,
    primaryType: "CREATE",
    executionType: "CREATE",
    triggerMode: "manual",
    readiness: "D0_CURRENT",
    publicSummary: {
      jobToBeDone: "把资料做成可核验成果",
      objective: "得到唯一可用版本",
      lossIfIgnored: "错误版本会造成返工",
      trigger: "用户提交资料后开始",
      observe: ["读取已授权资料"],
      judge: "区分事实、假设和待确认项",
      uncertainty: "缺关键证据时停止并请人补充",
      act: ["创建并验证成果"],
      approval: "高风险内容由有权人确认",
      wait: "资料齐全时无需等待",
      escalation: "无法确认时交给业务负责人",
      verify: "重新读取成果并校验版本和摘要",
      outcome: "获得可直接使用的成果",
      proof: "成果内容、版本和校验记录一致",
    },
    capabilityRequirements: [{
      id: "current-files",
      kind: "CURRENT",
      required: true,
      publicLabel: "文件读取与成果生成",
    }],
    runtime: {
      jobToBeDone: "把资料做成可核验成果",
      business: {
        objective: "得到唯一可用版本",
        lossMechanism: "错误版本会造成返工",
        objectType: "artifact",
        terminalStates: ["VERIFIED"],
      },
      trigger: [{
        id: "manual-start",
        kind: "manual",
        sourceRef: "user",
        eventName: "start",
        conditionRef: "input-ready",
      }],
      observe: {
        sources: [{
          id: "uploaded-files",
          kind: "file",
          required: true,
          freshness: "current-run",
          sourceOfTruthRef: "artifact-input",
          publicLabel: "已授权资料",
        }],
        requiredContextRefs: [],
      },
      judge: {
        ruleRefs: ["deterministic-checks"],
        aiDecisions: [{
          id: "evidence-judgment",
          question: "哪些结论被资料支持",
          evidenceRefs: ["uploaded-files"],
          outputSchemaRef: "claim-ledger",
        }],
        outputSchemaRef: "artifact-contract",
      },
      uncertainty: {
        onMissingEvidence: "ASK",
        onConflict: "HANDOFF",
        maxClarifications: 2,
      },
      act: [{
        id: "create-artifact",
        targetRef: "artifact-store",
        operationRef: "internal-operation-probe",
        mutation: false,
        risk: "low",
        permissionRef: "artifact-permission",
        receiptSchemaRef: "artifact-receipt",
        publicLabel: "创建成果",
        artifact: true,
      }],
      approval: [],
      permission: [{
        id: "artifact-permission",
        actorRef: "current-user",
        resourceRef: "current-case",
        actions: ["create"],
        scopeBoundaryRef: "current-case-only",
      }],
      idempotency: [],
      wait: { waitingStates: [], resumeSignals: [] },
      escalation: [],
      verify: {
        checks: [{
          id: "verify-artifact",
          kind: "artifact",
          targetRef: "create-artifact",
          required: true,
          publicLabel: "重新读取并核对成果",
        }],
        sourceOfTruthRefs: ["artifact-store"],
        successState: "VERIFIED",
        failureStates: ["VERIFY_FAILED"],
      },
      retry: [],
      compensation: [],
      handoff: {
        whenRefs: ["verify-failed"],
        toRoleIds: ["sales"],
        contextBundleRef: "handoff-bundle",
        requiredAcknowledgement: true,
      },
      memory: {
        readScopes: [],
        writeScopes: [],
        writePolicyRef: "confirmed-only",
        retentionRef: "case-policy",
      },
      outcome: {
        metric: "关键事实可追溯率",
        baseline: "unknown",
        measurementWindow: "每次成果",
        successConditionRef: "artifact-verified",
        ownerRoleId: "sales",
      },
      proof: {
        evidenceTypes: ["artifact-hash"],
        sourceOfTruthRefs: ["artifact-store"],
        freshness: "本次运行",
        requiredForCompletion: true,
      },
    },
    skins: [],
    roleViews: [{
      id: "sales-view",
      roleId: "sales",
      title: "销售视图",
      responsibilities: ["确认成果用途"],
      visibleStageIds: ["VERIFIED"],
      permittedActionRefs: ["create-artifact"],
      approvalPolicyRefs: [],
    }],
    internal: {
      enabled: true,
      source: "internal-source-probe",
      owner: "产品团队",
      reviewStatus: "approved",
    },
  };
}

function createLibrary() {
  const definition = createDefinition();
  return {
    schemaVersion: 3,
    workflowContractVersion: 2,
    updatedAt: "2026-07-21",
    roles: [{ id: "sales", name: "销售", sort: 1 }],
    legacyRoles: [{ id: "sales", name: "销售", sort: 1 }],
    workflows: [definition],
    deferredObjects: [{
      id: "deferred-follow-up",
      kind: "workflow",
      reason: "缺少可验证的状态化执行环境",
      status: "deferred",
    }],
    catalogScenarios: [{
      id: "verified-artifact-create",
      workflowId: "verified-artifact-create",
      roleViewIds: ["sales-view"],
      public: {
        title: "生成可核验成果",
        value: "把资料变成有来源、有版本的成果",
        shortChain: ["提交资料", "核对事实", "生成成果"],
        roleIds: ["sales"],
        industryTags: ["service"],
        industryVerticals: [],
        businessModels: [],
        maturityLevels: ["files-first"],
        goalTags: ["推进成交"],
        triggerBadge: "资料到齐后开始",
        actionBadge: "创建并验证 Skill 成果",
        humanApprovalSummary: "高风险内容由有权人确认",
        detail: {
          event: "需要一份可用成果",
          reads: ["已授权资料"],
          decides: "区分事实和假设",
          acts: ["创建成果"],
          approval: "高风险内容人工确认",
          beforeAfter: "从散乱资料变成唯一版本",
          followUp: "需要业务写入时进入后续流程",
          valueProof: "版本和校验记录一致",
        },
        launch: { sampleAvailable: false, inputHint: "上传资料开始" },
      },
      internal: {
        enabled: true,
        source: "catalog-source-probe",
        cannotPromise: ["internal-cannot-promise-probe"],
        internalNotes: "internal-notes-probe",
      },
    }],
    demos: [{
      id: "verified-artifact-demo",
      workflowId: "verified-artifact-create",
      catalogScenarioId: "verified-artifact-create",
      definitionVersion: 1,
      primaryType: "CREATE",
      environment: { kind: "current_real", dataLabel: "synthetic" },
      status: "planned",
      publication: { status: "private" },
      public: {
        title: "成果演示",
        environmentLabel: "合成数据",
        before: [],
        timeline: [],
        after: [],
        evidence: [],
      },
      internal: {
        tenantRef: "tenant-probe",
        accountRef: "account-probe",
        runIds: ["run-id-probe"],
        businessObjectRefs: [],
        idempotencyKeyHashes: [],
        beforeSnapshotRefs: [],
        timelineEventRefs: [],
        afterSnapshotRefs: [],
        evidenceRefs: [],
        reviewedBy: [],
      },
    }],
    scenarioAliases: [{
      legacySlug: "legacy-artifact",
      resolution: "catalog",
      targetCatalogScenarioId: "verified-artifact-create",
      roleViewId: "sales-view",
      legacyCompatRef: "legacy-artifact-compat",
    }],
    workflowAliases: [],
    legacyCompatibility: [{
      id: "legacy-artifact-compat",
      legacySlug: "legacy-artifact",
      resolution: "catalog",
      targetCatalogScenarioId: "verified-artifact-create",
      legacyScenario: {
        id: "legacy-artifact",
        title: "旧成果",
        role: "sales",
        industries: ["service"],
        mode: "oneshot",
        pitch: "生成旧成果",
        story: "资料到成果",
        promptTemplate: "请处理 {{target}}",
        slots: [{ key: "target", label: "资料", example: "演示资料" }],
        requires: ["upload"],
        recommendCron: false,
      },
      legacyCronSupported: false,
    }],
  };
}

describe("Workflow v3 schema", () => {
  it("对客户自然语言做替换并对 hard block fail closed", () => {
    expect(workflowPublicTextSchema.parse("启用 Skills")).toBe("启用 技能");
    expect(() => workflowPublicTextSchema.parse("显示 prompt 内容")).toThrow();
  });

  it("拒绝缺 Artifact 验证的 CREATE", () => {
    const definition = createDefinition();
    definition.runtime.verify.checks = [];
    expect(workflowDefinitionRecordSchema.safeParse(definition).success).toBe(false);
  });

  it("拒绝 readiness 低于必需连接能力", () => {
    const definition = createDefinition();
    definition.capabilityRequirements = [{
      id: "crm-connector",
      kind: "STANDARD_CONNECTOR",
      required: true,
      publicLabel: "业务系统连接",
    }];
    expect(workflowDefinitionRecordSchema.safeParse(definition).success).toBe(false);
  });

  it("用 executionType 与 triggerMode 独立表达执行结构和触发方式", () => {
    const definition = createDefinition();
    definition.executionType = "ACT";
    expect(workflowDefinitionRecordSchema.safeParse(definition).success).toBe(false);
    definition.executionType = "CREATE";
    expect(workflowDefinitionRecordSchema.safeParse(definition).success).toBe(true);

    definition.triggerMode = "event-driven";
    expect(workflowDefinitionRecordSchema.safeParse(definition).success).toBe(false);
    definition.runtime.trigger[0]!.kind = "event";
    expect(workflowDefinitionRecordSchema.safeParse(definition).success).toBe(true);
  });

  it("严格解析并用白名单投影，planned Demo 与 internal probe 均不公开", () => {
    const library = workflowLibraryFileV3Schema.parse(createLibrary());
    const projected = projectWorkflowLibraryPublic(library);
    const serialized = JSON.stringify(projected);

    expect(projected.scenarios).toHaveLength(1);
    expect(projected.scenarios[0]?.actionBadge).toContain("技能");
    expect(projected.demos).toHaveLength(0);
    expect(projected.aliases[0]?.roleId).toBe("sales");
    expect(serialized).not.toContain("internal-source-probe");
    expect(serialized).not.toContain("internal-operation-probe");
    expect(serialized).not.toContain("run-id-probe");
    expect(serialized).not.toContain("cannot-promise-probe");
  });

  it("strict schema 拒绝未知字段", () => {
    const library = createLibrary();
    Object.assign(library.catalogScenarios[0]!.public.detail, { debugToolOutput: "probe" });
    expect(workflowLibraryFileV3Schema.safeParse(library).success).toBe(false);
  });

  it("允许只读 Workflow action 绑定 operation、permission 与 receipt 而不伪造幂等策略", () => {
    const base = createLibrary().demos[0]!;
    const demo = {
      ...base,
      public: {
        ...base.public,
        timeline: [{
          id: "resolve-subject",
          label: "消歧业务对象",
          summary: "读取稳定标识并确认当前业务对象。",
          state: "业务对象已确认",
        }],
      },
      internal: {
        ...base.internal,
        timelineEventRefs: ["resolve-subject"],
        executionPlan: [{
          eventId: "resolve-subject",
          phase: "judge",
          actorRole: "workflow-demo-runner",
          targetObjectId: "subject-bundle",
          mutation: false,
          approvalRequired: false,
          workflowActionId: "resolve-subject",
          operationRef: "operation:resolve-subject",
          permissionRef: "permission-resolve-subject",
          receiptSchemaRef: "receipt:resolve-subject:v1",
          expectedState: "业务对象已确认",
        }],
      },
    };

    expect(demoManifestRecordSchema.safeParse(demo).success).toBe(true);
    demo.internal.executionPlan[0]!.mutation = true;
    expect(demoManifestRecordSchema.safeParse(demo).success).toBe(false);
  });
});

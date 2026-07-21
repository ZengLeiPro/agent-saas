import express from "express";
import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { scenarioLibraryFileSchema } from "../../../shared/src/index.js";
import {
  sanitizeRole,
  sanitizeScenario,
} from "../../../shared/src/security/sanitizeCustomerFacingText.js";
import { createScenariosRouter } from "../routes/scenarios.js";
import {
  createRetryableWorkflowLibraryLoader,
  loadWorkflowLibraryV3,
  parseWorkflowLibraryV3,
  resolveLoadedScenarioSlug,
  WORKFLOW_LIBRARY_HERO_IDS,
  WorkflowLibraryError,
} from "../data/scenarios/workflowLibrary.js";
import type {
  WorkflowDemoPublishedReplay,
  WorkflowDemoStore,
} from "../data/workflowDemos/store.js";

const roleIds = Array.from({ length: 8 }, (_, index) => `role-${index + 1}`);

function suffix(index: number): string {
  return String(index + 1).padStart(2, "0");
}

const PUBLIC_API_FORBIDDEN_KEY = /^(?:source|salesPitch|cannotPromise|token|secret|runId|eventId|replayId|tenantId|owner|ownerId|reviewerUserId|publisherUserId|contentHash|evidenceHash|digest)$/i;
const PUBLIC_API_FORBIDDEN_VALUE = /(?:run-runtime|hash-runtime|evidence-runtime|independent-reviewer|independent-publisher)/i;
const PUBLIC_API_FORBIDDEN_TECHNICAL_COPY = /\b(?:hash|bytes|claimId|evidenceRef|sourceVersion|ref|asset)\b/i;
const PUBLIC_API_FORBIDDEN_MACHINE_COPY = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/;
const PUBLIC_API_FORBIDDEN_LOWER_CAMEL_COPY = /\b[a-z][a-z0-9]*(?:[A-Z][A-Za-z0-9]*)+\b/;
const PUBLIC_API_FORBIDDEN_RAW_FIELD_COPY = /\b(?:event|message|stage|rule|schema|diff|lot|brief|revision|hold|booking|customer|order|authority|certificate|specification|retest|defect|cutoff|enforcement|BOMRevision|materialShortage|inventory|supplierCommitment|substitute|inspection|logistics|riskCase|faultCode|serviceCase|sparePart|fieldAction|telemetry|customerConfirmation|knowledgeRevision)\b/i;

function findForbiddenPublicApiValues(value: unknown, path: string[] = []): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findForbiddenPublicApiValues(item, [...path, String(index)]));
  }
  if (!value || typeof value !== "object") {
    return typeof value === "string" && PUBLIC_API_FORBIDDEN_VALUE.test(value)
      ? [`${path.join(".")}:value=${value}`]
      : [];
  }
  return Object.entries(value).flatMap(([key, child]) => {
    const nextPath = [...path, key];
    return [
      ...(PUBLIC_API_FORBIDDEN_KEY.test(key) ? [`${nextPath.join(".")}:key`] : []),
      ...findForbiddenPublicApiValues(child, nextPath),
    ];
  });
}

function findForbiddenCustomerCopyValues(value: unknown, path: string[] = []): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findForbiddenCustomerCopyValues(item, [...path, String(index)]));
  }
  if (!value || typeof value !== "object") {
    return typeof value === "string"
      && /[\u3400-\u9fff]/u.test(value)
      && (PUBLIC_API_FORBIDDEN_TECHNICAL_COPY.test(value)
        || PUBLIC_API_FORBIDDEN_MACHINE_COPY.test(value)
        || PUBLIC_API_FORBIDDEN_LOWER_CAMEL_COPY.test(value)
        || PUBLIC_API_FORBIDDEN_RAW_FIELD_COPY.test(value))
      ? [`${path.join(".")}:value=${value}`]
      : [];
  }
  return Object.entries(value).flatMap(([key, child]) => (
    findForbiddenCustomerCopyValues(child, [...path, key])
  ));
}

function buildWorkflow(index: number) {
  const serial = suffix(index);
  const isCreate = index < 6;
  const actionId = `action-${serial}`;
  const permissionId = `permission-${serial}`;
  const idempotencyId = `idempotency-${serial}`;
  const capabilityId = `capability-${serial}`;
  return {
    id: `workflow-${serial}`,
    definitionVersion: 1,
    primaryType: isCreate ? "CREATE" : "ACT",
    executionType: isCreate ? "CREATE" : "ACT",
    triggerMode: "manual",
    readiness: isCreate ? "D0_CURRENT" : "D1_CONNECTOR",
    publicSummary: {
      jobToBeDone: "把业务输入处理成可核验的结果",
      objective: "减少遗漏并形成明确终态",
      lossIfIgnored: "关键信息可能遗漏，责任无法闭环",
      trigger: "收到新的业务对象",
      observe: ["读取业务对象和审批规则"],
      judge: "结合证据判断下一步动作",
      uncertainty: "证据不足时暂停并请负责人确认",
      act: [isCreate ? "生成可复核成果" : "更新隔离业务对象"],
      approval: "高风险动作由责任人确认",
      wait: "需要反馈时保持待确认状态",
      escalation: "超过期限后升级给负责人",
      verify: "动作后重新读取业务对象",
      outcome: "业务对象进入明确终态",
      proof: "以回执和回读结果作为证明",
    },
    capabilityRequirements: [{
      id: capabilityId,
      kind: isCreate ? "CURRENT" : "STANDARD_CONNECTOR",
      required: true,
      publicLabel: isCreate ? "当前能力" : "标准系统接入",
      ...(!isCreate ? { connectorRef: `connector-${serial}` } : {}),
    }],
    runtime: {
      jobToBeDone: "处理业务对象并验证终态",
      business: {
        objective: "形成可核验结果",
        lossMechanism: "遗漏会造成业务损失",
        objectType: `object-${serial}`,
        terminalStates: ["DONE"],
      },
      trigger: [{
        id: `trigger-${serial}`,
        kind: "manual",
        sourceRef: `source-${serial}`,
        eventName: `event-${serial}`,
        conditionRef: `condition-${serial}`,
      }],
      observe: {
        sources: [{
          id: `observe-${serial}`,
          kind: "business-system",
          required: true,
          freshness: "current",
          sourceOfTruthRef: `truth-${serial}`,
          publicLabel: "业务系统记录",
        }],
        requiredContextRefs: [`context-${serial}`],
      },
      judge: {
        ruleRefs: [`rule-${serial}`],
        aiDecisions: [{
          id: `decision-${serial}`,
          question: "证据是否足以执行下一步",
          evidenceRefs: [`evidence-${serial}`],
          outputSchemaRef: `decision-output-${serial}`,
        }],
        outputSchemaRef: `judge-output-${serial}`,
      },
      uncertainty: {
        onMissingEvidence: "BLOCK",
        onConflict: "HANDOFF",
      },
      act: [{
        id: actionId,
        targetRef: `target-${serial}`,
        operationRef: `operation-${serial}`,
        mutation: !isCreate,
        risk: "low",
        permissionRef: permissionId,
        ...(!isCreate ? { idempotencyRef: idempotencyId } : {}),
        receiptSchemaRef: `receipt-${serial}`,
        publicLabel: isCreate ? "生成成果" : "更新业务对象",
        ...(isCreate ? { artifact: true } : {}),
      }],
      approval: [],
      permission: [{
        id: permissionId,
        actorRef: `actor-${serial}`,
        resourceRef: `resource-${serial}`,
        actions: [`operation-${serial}`],
        scopeBoundaryRef: `scope-${serial}`,
      }],
      idempotency: isCreate ? [] : [{
        id: idempotencyId,
        actionId,
        scope: `scope-${serial}`,
        keyTemplateRef: `key-template-${serial}`,
        onDuplicate: "return_original",
      }],
      wait: { waitingStates: [], resumeSignals: [] },
      escalation: [],
      verify: {
        checks: [{
          id: `verify-${serial}`,
          kind: isCreate ? "artifact" : "readback",
          targetRef: actionId,
          required: true,
          publicLabel: isCreate ? "成果可读取" : "状态回读一致",
        }],
        sourceOfTruthRefs: [`truth-${serial}`],
        successState: "DONE",
        failureStates: ["FAILED"],
      },
      retry: [],
      compensation: [],
      handoff: {
        whenRefs: [`handoff-${serial}`],
        toRoleIds: [roleIds[index % roleIds.length]],
        contextBundleRef: `bundle-${serial}`,
        requiredAcknowledgement: true,
      },
      memory: {
        readScopes: [`memory-read-${serial}`],
        writeScopes: [`memory-write-${serial}`],
        writePolicyRef: `memory-policy-${serial}`,
        retentionRef: `retention-${serial}`,
      },
      outcome: {
        metric: "终态完成率",
        baseline: "待建立基线",
        measurementWindow: "本次业务周期",
        successConditionRef: `success-${serial}`,
        ownerRoleId: roleIds[index % roleIds.length],
      },
      proof: {
        evidenceTypes: [isCreate ? "artifact" : "readback"],
        sourceOfTruthRefs: [`truth-${serial}`],
        freshness: "本次运行",
        requiredForCompletion: true,
      },
    },
    skins: Array.from({ length: index < 26 ? 3 : 2 }, (_, skinIndex) => {
      const evidenceCardId = `evidence-card-${serial}-${skinIndex + 1}`;
      return {
        id: `skin-${serial}-${skinIndex + 1}`,
        title: `行业版本 ${skinIndex + 1}`,
        industryVerticals: ["制造业"],
        businessModels: ["生产制造"],
        objectLabels: [{ key: `object-${serial}`, label: "业务对象" }],
        ruleRefs: [`rule-${serial}`],
        rules: [{
          id: `rule-${serial}`,
          description: "按业务凭证与企业规则判断",
          appliesWhen: "业务对象进入待处理状态",
          sourceEvidenceCardIds: [evidenceCardId],
        }],
        systemsAndEvidence: {
          systems: ["隔离业务系统"],
          evidence: ["业务单据与动作回执"],
        },
        ownership: {
          primaryOwner: "业务负责人",
          collaboratorRoles: ["协作岗位"],
          strongApprovalRoles: ["审批负责人"],
          approvalReason: "高风险动作必须由责任人确认",
        },
        terminal: {
          successState: "业务对象已完成并复核",
          readback: "重新读取业务对象确认最终状态",
        },
        operationAdapters: [{
          actionRef: actionId,
          target: "隔离业务对象",
          operation: isCreate ? "生成可复核成果" : "更新业务对象状态",
          permission: "仅允许授权岗位执行",
          approval: "按风险规则发起人工确认",
          idempotencyKey: "同一业务对象与动作只执行一次",
          receipt: "保存动作回执",
          readback: "动作后重新读取业务对象",
          successState: "业务对象已完成并复核",
          failureState: "动作未生效，等待人工接管",
          compensation: "保留原状态并通知责任人",
        }],
        metrics: ["终态完成率"],
        evidence: {
          status: "interview_required",
          sourceEvidenceCardIds: [evidenceCardId],
          assumptionsToValidate: ["客户系统字段和审批角色待确认"],
          lastValidatedAt: "2026-07-21",
        },
        maturityProfiles: [
          { level: "M0_FRAGMENTED", deliveryPath: "先整理业务单据再接入", readiness: "D1_CONNECTOR", cta: "接入我的系统" },
          { level: "M1_SYSTEMED", deliveryPath: "连接现有单体系统", readiness: "D1_CONNECTOR", cta: "接入我的系统" },
          { level: "M2_INTEGRATED", deliveryPath: "复用已有系统接口", readiness: "D1_CONNECTOR", cta: "接入我的系统" },
        ],
        capabilityRequirementRefs: [capabilityId],
        actionBindingRefs: [actionId],
        approvalPolicyRefs: [],
      };
    }),
    roleViews: Array.from({ length: index < 27 ? 4 : 3 }, (_, viewIndex) => ({
      id: viewIndex === 0 ? `view-${serial}` : `view-${serial}-${viewIndex + 1}`,
      roleId: roleIds[(index + viewIndex) % roleIds.length],
      title: `岗位工作视图 ${viewIndex + 1}`,
      responsibilities: ["查看状态并处理异常"],
      visibleStageIds: ["DONE"],
      permittedActionRefs: [actionId],
      approvalPolicyRefs: [],
    })),
    internal: {
      enabled: true,
      source: `internal-probe-${serial}`,
      owner: "产品团队",
      reviewStatus: "approved",
    },
  };
}

function targetForLegacy(index: number): string {
  if (index === 0) return "catalog-07";
  return `catalog-${suffix(index % 28)}`;
}

function buildLibraryFixture(): Record<string, unknown> {
  const workflows = Array.from({ length: 28 }, (_, index) => buildWorkflow(index));
  const catalogScenarios = workflows.map((workflow, index) => ({
    id: `catalog-${suffix(index)}`,
    workflowId: workflow.id,
    roleViewIds: workflow.roleViews.map((view) => view.id),
    public: {
      title: `业务结果 ${index + 1}`,
      value: "让责任人及时得到可核验结果",
      shortChain: ["接收业务事件", "判断并执行", "回读确认终态"],
      roleIds: [roleIds[index % roleIds.length]],
      industryTags: ["manufacturing"],
      industryVerticals: ["all"],
      businessModels: ["general"],
      maturityLevels: ["integrated"],
      goalTags: ["保交付"],
      triggerBadge: "业务事件触发",
      actionBadge: index < 6 ? "生成成果" : "更新业务对象",
      humanApprovalSummary: "按风险要求确认",
      detail: {
        event: "新的业务对象进入处理队列",
        reads: ["业务对象与企业规则"],
        decides: "证据是否足以推进",
        acts: [index < 6 ? "生成成果" : "更新隔离业务对象"],
        approval: "高风险动作由责任人确认",
        beforeAfter: "从待处理变为已核验",
        followUp: "持续复查最终状态",
        valueProof: "以成果哈希或系统回读作为证明",
      },
      launch: { sampleAvailable: true, inputHint: "使用合成示例体验" },
    },
    internal: {
      enabled: true,
      source: `catalog-source-${suffix(index)}`,
      defaultDemoId: index === 0
        ? "demo-planned"
        : (index === 1 ? "demo-private" : undefined),
      ...(index < 12
        ? {
            hero: {
              featured: true,
              designScore: 80 + (index % 6),
              scoreStatus: "design_only_not_runtime",
              order: index + 1,
              veto: {
                missingBusinessEndState: false,
                noAgentNecessity: false,
                noCredibleDemo: false,
                readinessMismatch: false,
              },
            },
          }
        : {}),
    },
  }));
  const demos = [
    {
      id: "demo-planned",
      workflowId: "workflow-01",
      catalogScenarioId: "catalog-01",
      definitionVersion: 1,
      primaryType: "CREATE",
      environment: { kind: "current_real", dataLabel: "synthetic" },
      status: "planned",
      publication: { status: "private" },
      public: {
        title: "已核验成果示例",
        environmentLabel: "合成数据环境",
        before: [{ id: "before-01", label: "处理前", state: "待处理" }],
        timeline: [
          { id: "event-01", label: "接收资料", summary: "输入资料已冻结", state: "待生成" },
          { id: "event-02", label: "生成成果", summary: "成果文件已生成", state: "待复核" },
          { id: "event-03", label: "独立验证", summary: "成果已重新读取并复核", state: "已核验" },
        ],
        after: [{ id: "after-01", label: "处理后", state: "已核验" }],
        evidence: [
          { id: "proof-01", kind: "artifact", label: "成果校验值", summary: "内容校验值与成果版本一致" },
          { id: "proof-02", kind: "readback", label: "独立回读", summary: "重新读取的成果与批准版本一致" },
        ],
      },
      internal: {
        tenantRef: "internal-demo-tenant",
        accountRef: "internal-demo-account",
        runIds: ["internal-run"],
        businessObjectRefs: ["internal-object"],
        idempotencyKeyHashes: ["internal-key-hash"],
        beforeSnapshotRefs: ["internal-before"],
        timelineEventRefs: ["internal-event"],
        afterSnapshotRefs: ["internal-after"],
        evidenceRefs: ["internal-evidence"],
        executionPlan: [
          { eventId: "event-01", phase: "trigger", actorRole: "operator", targetObjectId: "before-01", mutation: false, approvalRequired: false, expectedState: "待生成" },
          { eventId: "event-02", phase: "act", actorRole: "agent", targetObjectId: "before-01", mutation: false, approvalRequired: false, expectedState: "待复核" },
          { eventId: "event-03", phase: "verify", actorRole: "reviewer", targetObjectId: "before-01", mutation: false, approvalRequired: false, expectedState: "已核验" },
        ],
        reviewedBy: [],
      },
    },
    {
      id: "demo-private",
      workflowId: "workflow-02",
      catalogScenarioId: "catalog-02",
      definitionVersion: 1,
      primaryType: "CREATE",
      environment: { kind: "current_real", dataLabel: "synthetic" },
      status: "planned",
      publication: { status: "private" },
      public: {
        title: "尚未完成的示例",
        environmentLabel: "合成数据环境",
        before: [],
        timeline: [],
        after: [],
        evidence: [],
      },
      internal: {
        tenantRef: "private-tenant",
        accountRef: "private-account",
        runIds: [],
        businessObjectRefs: [],
        idempotencyKeyHashes: [],
        beforeSnapshotRefs: [],
        timelineEventRefs: [],
        afterSnapshotRefs: [],
        evidenceRefs: [],
        reviewedBy: [],
      },
    },
  ];
  const deferredObjects = Array.from({ length: 5 }, (_, index) => ({
    id: `deferred-${suffix(index)}`,
    kind: index % 2 === 0 ? "workflow" : "create",
    reason: "该旧入口已后置，保留诚实状态说明",
    status: "deferred",
  }));
  const scenarioAliases = Array.from({ length: 53 }, (_, index) => ({
    legacySlug: `legacy-${suffix(index)}`,
    legacyCompatRef: `compat-${suffix(index)}`,
    ...(index < 47
      ? {
          resolution: "catalog",
          targetCatalogScenarioId: targetForLegacy(index),
        }
      : {
          resolution: "deferred",
          deferredObjectId: `deferred-${suffix((index - 47) % 5)}`,
        }),
  }));
  const legacyCompatibility = scenarioAliases.map((alias, index) => ({
    id: `compat-${suffix(index)}`,
    legacySlug: alias.legacySlug,
    ...(index < 47
      ? { resolution: "catalog", targetCatalogScenarioId: targetForLegacy(index) }
      : {
          resolution: "deferred",
          deferredObjectId: `deferred-${suffix((index - 47) % 5)}`,
        }),
    legacyScenario: {
      id: alias.legacySlug,
      title: `旧场景 ${index + 1}`,
      role: roleIds[index % roleIds.length],
      industries: ["all"],
      mode: index < 2 ? "recurring" : "oneshot",
      pitch: "兼容旧版客户入口",
      story: "接收业务对象 → 处理 → 验证",
      promptTemplate: "请处理这份业务资料。",
      slots: [],
      requires: [],
      recommendCron: index < 2,
      ...(index < 2
        ? {
            signalAdaptation: {
              dailyEmptyStreakToWeekly: 3,
              userNoOpenStreakToPause: 7,
              emptyContentFallback: "无异常时不打扰",
            },
            pushSlot: {
              channel: "ding_work_notification",
              target: "self",
              humanReviewRequired: false,
            },
          }
        : {}),
    },
    legacyCronSupported: index === 0,
    ...(index === 0
      ? { demoId: "demo-planned" }
      : (index === 1 ? { demoId: "demo-private" } : {})),
  }));
  return {
    schemaVersion: 3,
    workflowContractVersion: 2,
    updatedAt: "2026-07-21",
    roles: roleIds.map((id, index) => ({ id, name: `岗位 ${index + 1}`, sort: index + 1 })),
    legacyRoles: roleIds.map((id, index) => ({
      id,
      name: `岗位 ${index + 1}`,
      sort: index + 1,
      roleWelcomeMessage: `岗位 ${index + 1} 欢迎语`,
    })),
    workflows,
    catalogScenarios,
    deferredObjects,
    demos,
    scenarioAliases,
    workflowAliases: [],
    legacyCompatibility,
  };
}

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function startV3Server(
  loader: () => Promise<ReturnType<typeof parseWorkflowLibraryV3>>,
  cronService?: {
    add(...args: never[]): Promise<never>;
    runNow(...args: never[]): Promise<never>;
  },
  workflowDemoStore?: WorkflowDemoStore,
): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { sub: "user-1", username: "alice", role: "user", tenantId: "kaiyan" };
    next();
  });
  app.use("/api/scenarios", createScenariosRouter({
    v3Loader: loader,
    roleKit: { libraryVersion: "v3" },
    ...(cronService ? { cronService: cronService as never } : {}),
    ...(workflowDemoStore ? { workflowDemoStore } : {}),
  }));
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

describe("Workflow V3 library", () => {
  it("does not cache a rejected cold-start load forever", async () => {
    const loaded = parseWorkflowLibraryV3(buildLibraryFixture());
    let attempts = 0;
    const getLibrary = createRetryableWorkflowLibraryLoader(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient cold-start failure");
      return loaded;
    });

    await expect(getLibrary()).rejects.toThrow("transient cold-start failure");
    await expect(getLibrary()).resolves.toBe(loaded);
    await expect(getLibrary()).resolves.toBe(loaded);
    expect(attempts).toBe(2);
  });

  it("keeps the production V1 client contract while removing internal-only fields", async () => {
    const v1Path = resolve(import.meta.dirname, "../data/scenarios/scenario-library-v1.json");
    const v3Path = resolve(import.meta.dirname, "../data/scenarios/workflow-library-v3.json");
    const rawV1 = scenarioLibraryFileSchema.parse(
      JSON.parse(await readFile(v1Path, "utf8")) as unknown,
    );
    const expected = {
      roles: [...rawV1.roles]
        .sort((left, right) => left.sort - right.sort)
        .map((role) => sanitizeRole({ ...role }).scenario),
      scenarios: rawV1.scenarios
        .filter((scenario) => scenario.enabled === true)
        .map((scenario) => {
          const {
            source: _source,
            enabled: _enabled,
            salesPitch: _salesPitch,
            cannotPromise: _cannotPromise,
            ...publicScenario
          } = scenario;
          return sanitizeScenario(publicScenario).scenario;
        }),
    };

    const loaded = await loadWorkflowLibraryV3(v3Path);
    expect(loaded.legacy.roles).toEqual(expected.roles);
    expect(loaded.legacy.scenarios).toEqual(expected.scenarios);
    expect(findForbiddenPublicApiValues(loaded.legacy)).toEqual([]);
    expect(loaded.legacy.scenarios.map((scenario) => scenario.id)).toEqual(
      rawV1.scenarios.filter((scenario) => scenario.enabled === true).map((scenario) => scenario.id),
    );
    expect(loaded.internal.catalogScenarios
      .filter((scenario) => scenario.internal.hero?.featured)
      .sort((left, right) => left.internal.hero!.order! - right.internal.hero!.order!)
      .map((scenario) => scenario.workflowId)).toEqual(WORKFLOW_LIBRARY_HERO_IDS);
    expect(loaded.internal.workflows.filter((workflow) => workflow.executionType === "LOOP")).toHaveLength(22);
    expect(loaded.internal.workflows.filter((workflow) => workflow.triggerMode === "scheduled")).toHaveLength(3);
    expect(loaded.internal.workflows
      .filter((workflow) => workflow.primaryType === "ACT")
      .every((workflow) => workflow.executionType === "LOOP")).toBe(true);
    expect(loaded.internal.workflows
      .filter((workflow) => workflow.primaryType === "WATCH")
      .every((workflow) => workflow.executionType === "LOOP")).toBe(true);
  });

  it("pins the domain terminal contracts that passed design and Demo review", async () => {
    const v3Path = resolve(import.meta.dirname, "../data/scenarios/workflow-library-v3.json");
    const loaded = await loadWorkflowLibraryV3(v3Path);
    const reviewedContracts = new Map<string, { success: string; terminals: string[] }>([
      ["lead-to-opportunity-loop", {
        success: "QUALIFIED_OPPORTUNITY_CREATED",
        terminals: ["QUALIFIED_OPPORTUNITY_CREATED", "NURTURED", "DISQUALIFIED", "SUPPRESSED"],
      }],
      ["opportunity-commitment-progress-loop", {
        success: "SUCCEEDED_ORDER_OR_CONTRACT",
        terminals: ["SUCCEEDED_ORDER_OR_CONTRACT", "SUCCEEDED_WON", "CONTROLLED_LOST", "CONTROLLED_PAUSED"],
      }],
      ["technical-inquiry-to-approved-quote-loop", {
        success: "ORDER_COMMITTED_VERIFIED",
        terminals: ["ORDER_COMMITTED_VERIFIED", "CUSTOMER_DECLINED_RECORDED", "QUOTE_EXPIRED_REVIEW_REQUIRED", "NEEDS_HUMAN"],
      }],
      ["credit-exception-to-order-release-loop", {
        success: "RELEASED_VERIFIED",
        terminals: ["RELEASED_VERIFIED", "HELD_ACTIONABLE"],
      }],
      ["contract-sow-to-approved-baseline-loop", {
        success: "BASELINE_APPROVED_VERIFIED",
        terminals: ["BASELINE_APPROVED_VERIFIED"],
      }],
      ["controlled-version-release-loop", {
        success: "RELEASED_VERIFIED",
        terminals: ["RELEASED_VERIFIED", "COMPENSATED_VERIFIED", "NEEDS_HUMAN"],
      }],
      ["order-delivery-defender-loop", {
        success: "RISK_CLEARED_VERIFIED",
        terminals: ["RISK_CLEARED_VERIFIED", "APPROVED_REBASE_VERIFIED", "DELIVERED_VERIFIED", "ACCEPTED_VERIFIED", "NEEDS_HUMAN"],
      }],
      ["client-evidence-readiness-loop", {
        success: "READY_CONFIRMED",
        terminals: ["READY_CONFIRMED", "RESCHEDULED_APPROVED", "HANDOFF_REQUIRED"],
      }],
      ["customer-issue-resolution-loop", {
        success: "RESOLVED_VERIFIED",
        terminals: ["RESOLVED_VERIFIED", "RESTORED_CONFIRMED", "REMEDY_SETTLED_CONFIRMED", "FORMAL_DISPUTE_HANDOFF", "NEEDS_HUMAN"],
      }],
      ["management-exception-closure-loop", {
        success: "RECOVERED_VERIFIED",
        terminals: ["RECOVERED_VERIFIED", "RISK_ACCEPTED_UNTIL_REVIEW", "NEEDS_HUMAN"],
      }],
      ["scope-change-margin-guard-loop", {
        success: "CHANGE_APPLIED_VERIFIED",
        terminals: ["IN_SCOPE_ROUTED_VERIFIED", "CHANGE_DECLINED_BASELINE_PRESERVED", "CHANGE_APPLIED_VERIFIED"],
      }],
      ["acceptance-to-cash-loop", {
        success: "CASH_RECONCILED_VERIFIED",
        terminals: ["CASH_RECONCILED_VERIFIED", "NEEDS_HUMAN"],
      }],
      ["settlement-reconciliation-to-cash-loop", {
        success: "RECONCILED_VERIFIED",
        terminals: ["RECONCILED_VERIFIED", "NEEDS_HUMAN"],
      }],
      ["inventory-rebalance-loop", {
        success: "REBALANCED_VERIFIED",
        terminals: ["REBALANCED_VERIFIED", "COMPENSATED_VERIFIED", "NEEDS_HUMAN"],
      }],
      ["supply-gap-closure-loop", {
        success: "MATERIAL_READY_VERIFIED",
        terminals: [
          "MATERIAL_READY_VERIFIED",
          "APPROVED_ALTERNATIVE_READY_VERIFIED",
          "APPROVED_TRANSFER_READY_VERIFIED",
          "CONTROLLED_HANDOFF_VERIFIED",
          "NEEDS_HUMAN",
        ],
      }],
      ["supplier-sourcing-to-approved-po-loop", {
        success: "PO_CONFIRMED_VERIFIED",
        terminals: ["PO_CONFIRMED_VERIFIED", "NEEDS_HUMAN"],
      }],
      ["payables-exception-to-payment-settlement-loop", {
        success: "PAYMENT_SETTLED_RECONCILED",
        terminals: ["PAYMENT_SETTLED_RECONCILED", "FORMAL_HOLD_VERIFIED", "NEEDS_HUMAN"],
      }],
      ["compliance-evidence-gate-loop", {
        success: "RELEASED_VERIFIED",
        terminals: ["HELD_VERIFIED", "RELEASED_VERIFIED", "REVOKED_REHELD", "COMPENSATED_VERIFIED", "NEEDS_HUMAN"],
      }],
      ["quality-nonconformance-loop", {
        success: "RELEASED_VERIFIED",
        terminals: ["RELEASED_VERIFIED", "DISPOSITION_COMPLETED_VERIFIED", "NEEDS_HUMAN"],
      }],
      ["deadline-to-receipt-watch", {
        success: "AUTHORITATIVE_STATUS_VERIFIED",
        terminals: [
          "SUBMITTED_ACCEPTED",
          "RENEWED_VERIFIED",
          "SERVICE_VERIFIED",
          "PAID_SETTLED",
          "AUTHORITATIVE_STATUS_VERIFIED",
          "APPROVED_EXCEPTION_VERIFIED",
          "NEEDS_HUMAN",
        ],
      }],
      ["requisition-to-authorized-hire-loop", {
        success: "AUTHORIZED_HIRE_READY_FOR_ONBOARDING",
        terminals: ["AUTHORIZED_HIRE_READY_FOR_ONBOARDING", "REQUISITION_CLOSED_UNFILLED", "NEEDS_HUMAN"],
      }],
      ["evidence-backed-research-create", {
        success: "REVIEWED_RESEARCH_ARTIFACT",
        terminals: ["VERIFIED_RESEARCH_ARTIFACT", "REVIEWED_RESEARCH_ARTIFACT", "NEEDS_HUMAN"],
      }],
      ["customer-visit-preparation-create", {
        success: "READY_FOR_VISIT",
        terminals: ["READY_FOR_VISIT", "BLOCKED_CRITICAL_GAP", "NEEDS_HUMAN"],
      }],
      ["evidence-backed-communication-create", {
        success: "REVIEWED_COMMUNICATION_ARTIFACT",
        terminals: ["VERIFIED_COMMUNICATION_ARTIFACT", "REVIEWED_COMMUNICATION_ARTIFACT", "NEEDS_HUMAN"],
      }],
      ["approved-content-asset-create", {
        success: "APPROVED_CONTENT_ASSET",
        terminals: ["APPROVED_CONTENT_ASSET"],
      }],
      ["meeting-action-record-create", {
        success: "REVIEWED_MEETING_ACTION_RECORD",
        terminals: ["VERIFIED_MEETING_ACTION_RECORD", "REVIEWED_MEETING_ACTION_RECORD", "NEEDS_HUMAN"],
      }],
      ["evidence-backed-deliverable-create", {
        success: "REVIEWED_CUSTOMER_READY_ARTIFACT",
        terminals: ["VALIDATED_INTERNAL_ARTIFACT", "REVIEWED_CUSTOMER_READY_ARTIFACT", "QUALIFIED_REVIEW_PACKAGE", "NEEDS_HUMAN"],
      }],
      ["employee-lifecycle-transition-loop", {
        success: "MOVED_VERIFIED",
        terminals: ["JOINED_VERIFIED", "MOVED_VERIFIED", "LEFT_VERIFIED", "FORMAL_EXCEPTION_HANDOFF", "NEEDS_HUMAN"],
      }],
    ]);

    for (const [workflowId, expected] of reviewedContracts) {
      const workflow = loaded.internal.workflows.find((candidate) => candidate.id === workflowId);
      expect(workflow, workflowId).toBeDefined();
      expect(workflow?.runtime.business.terminalStates, workflowId).toEqual(expected.terminals);
      expect(workflow?.runtime.verify.successState, workflowId).toBe(expected.success);
      expect(workflow?.runtime.outcome.successConditionRef, workflowId).toBe(`success:${workflowId}:${expected.success}`);
    }
  });

  it("keeps every customer action summary aligned with the complete runtime action contract", async () => {
    const v3Path = resolve(import.meta.dirname, "../data/scenarios/workflow-library-v3.json");
    const loaded = await loadWorkflowLibraryV3(v3Path);

    for (const workflow of loaded.internal.workflows) {
      expect(workflow.publicSummary.act, workflow.id).toEqual(
        workflow.runtime.act.map((action) => action.publicLabel),
      );
    }
  });

  it("strictly parses 28 workflows, 28 catalog scenarios and 53 legacy aliases", () => {
    const loaded = parseWorkflowLibraryV3(buildLibraryFixture());
    expect(loaded.public.workflows).toHaveLength(28);
    expect(loaded.public.scenarios).toHaveLength(28);
    expect(loaded.public.deferredObjects).toHaveLength(5);
    expect(loaded.public.aliases).toHaveLength(53);
    expect(loaded.legacy.scenarios).toHaveLength(53);
    expect(loaded.legacy.roles[0]?.roleWelcomeMessage).toBe("岗位 1 欢迎语");
    expect(loaded.public.demos).toEqual([]);

    for (const alias of loaded.public.aliases.filter((item) => item.resolution === "catalog")) {
      const resolved = resolveLoadedScenarioSlug(loaded, alias.legacySlug);
      expect(resolved?.resolution).toBe("catalog");
      if (resolved?.resolution === "catalog") {
        expect(resolved.scenario.id).toBe(alias.targetCatalogScenarioId);
        expect(resolved.resolvedFromLegacySlug).toBe(alias.legacySlug);
      }
    }
    expect(loaded.public.aliases.filter((item) => item.resolution === "deferred")).toHaveLength(6);
    for (const alias of loaded.public.aliases.filter((item) => item.resolution === "deferred")) {
      const resolved = resolveLoadedScenarioSlug(loaded, alias.legacySlug);
      expect(resolved?.resolution).toBe("deferred");
      if (resolved?.resolution === "deferred") {
        expect(resolved.deferredObject.id).toBe(alias.deferredObjectId);
        expect(resolved.resolvedFromLegacySlug).toBe(alias.legacySlug);
      }
    }
    const canonical = resolveLoadedScenarioSlug(loaded, "catalog-01");
    expect(canonical?.resolution).toBe("catalog");
    if (canonical?.resolution === "catalog") {
      expect(canonical.scenario.id).toBe("catalog-01");
    }
    expect(resolveLoadedScenarioSlug(loaded, "missing")).toBeNull();
  });

  it("never projects static Demo plans as runtime replay evidence", () => {
    const loaded = parseWorkflowLibraryV3(buildLibraryFixture());
    const publicJson = JSON.stringify(loaded.public);
    expect(publicJson).not.toContain("internal-probe");
    expect(loaded.public.scenarios[0]?.demo).toEqual({ evidenceLevel: "design_only" });
    expect(loaded.public.demos).toEqual([]);
    expect(publicJson).not.toContain("internal-run");
    expect(loaded.legacy.scenarios[0]).not.toHaveProperty("demoShareToken");
    expect(loaded.legacy.scenarios[1]).not.toHaveProperty("demoShareToken");
  });

  it("rejects unknown fields and hard-blocked nested customer text", () => {
    const unknown = buildLibraryFixture() as { workflows: Array<Record<string, unknown>> };
    unknown.workflows[0]!.debugToolOutput = "should fail";
    expect(() => parseWorkflowLibraryV3(unknown)).toThrow(WorkflowLibraryError);

    const blocked = buildLibraryFixture() as {
      catalogScenarios: Array<{ public: { detail: { reads: string[] } } }>;
    };
    blocked.catalogScenarios[0]!.public.detail.reads[0] = "读取内部 prompt";
    expect(() => parseWorkflowLibraryV3(blocked)).toThrow(
      expect.objectContaining({ code: "WORKFLOW_LIBRARY_PUBLICATION_BLOCKED" }),
    );

    for (const field of ["industryVerticals", "businessModels", "maturityLevels"] as const) {
      const visibleRef = buildLibraryFixture() as {
        catalogScenarios: Array<{ public: Record<typeof field, string[]> }>;
      };
      visibleRef.catalogScenarios[0]!.public[field][0] = "internal prompt probe";
      expect(() => parseWorkflowLibraryV3(visibleRef)).toThrow(
        expect.objectContaining({ code: "WORKFLOW_LIBRARY_PUBLICATION_BLOCKED" }),
      );
    }
  });

  it("rejects machine states and internal operation words from customer copy", () => {
    const machineState = buildLibraryFixture() as {
      workflows: Array<{ publicSummary: { lossIfIgnored: string } }>;
    };
    machineState.workflows[0]!.publicSummary.lossIfIgnored = "未处理会进入 WATCH_ESCALATED";
    expect(() => parseWorkflowLibraryV3(machineState)).toThrow(
      expect.objectContaining({ code: "WORKFLOW_LIBRARY_INVALID" }),
    );

    const operation = buildLibraryFixture() as {
      catalogScenarios: Array<{ public: { detail: { acts: string[] } } }>;
    };
    operation.catalogScenarios[0]!.public.detail.acts[0] = "CRM update state";
    expect(() => parseWorkflowLibraryV3(operation)).toThrow(
      expect.objectContaining({ code: "WORKFLOW_LIBRARY_INVALID" }),
    );

    const technicalCopy = buildLibraryFixture() as {
      catalogScenarios: Array<{ public: { detail: { reads: string[] } } }>;
    };
    technicalCopy.catalogScenarios[0]!.public.detail.reads[0] = "重新读取文件 hash 并核对";
    expect(() => parseWorkflowLibraryV3(technicalCopy)).toThrow(
      expect.objectContaining({ code: "WORKFLOW_LIBRARY_INVALID" }),
    );

    const rawFieldCopy = buildLibraryFixture() as {
      catalogScenarios: Array<{ public: { detail: { reads: string[] } } }>;
    };
    rawFieldCopy.catalogScenarios[0]!.public.detail.reads[0] = "CPQ：quoteId、版本与状态";
    expect(() => parseWorkflowLibraryV3(rawFieldCopy)).toThrow(
      expect.objectContaining({ code: "WORKFLOW_LIBRARY_INVALID" }),
    );

    const rawEventCopy = buildLibraryFixture() as {
      catalogScenarios: Array<{ public: { detail: { reads: string[] } } }>;
    };
    rawEventCopy.catalogScenarios[0]!.public.detail.reads[0] = "CRM：event";
    expect(() => parseWorkflowLibraryV3(rawEventCopy)).toThrow(
      expect.objectContaining({ code: "WORKFLOW_LIBRARY_INVALID" }),
    );
  });
});

describe("Workflow V3 scenario routes", () => {
  it("recovers when eager cold-start warmup fails once", async () => {
    const loaded = parseWorkflowLibraryV3(buildLibraryFixture());
    let attempts = 0;
    const { server, baseUrl } = await startV3Server(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient eager warmup failure");
      return loaded;
    });
    try {
      const v3 = await fetch(`${baseUrl}/api/scenarios/v3`);
      expect(v3.status).toBe(200);
      await expect(v3.json()).resolves.toMatchObject({
        schemaVersion: 3,
        scenarios: expect.arrayContaining([
          expect.objectContaining({ id: "catalog-01" }),
        ]),
      });
      expect(attempts).toBe(2);
    } finally {
      await stopServer(server);
    }
  });

  it("returns V3 config, strict public DTO and legacy compatibility projection", async () => {
    const loaded = parseWorkflowLibraryV3(buildLibraryFixture());
    const { server, baseUrl } = await startV3Server(async () => loaded);
    try {
      const config = await fetch(`${baseUrl}/api/scenarios/config`);
      await expect(config.json()).resolves.toMatchObject({
        libraryVersion: "v3",
        capabilities: { workflowCatalogV3: true },
      });
      const v3 = await fetch(`${baseUrl}/api/scenarios/v3`);
      expect(v3.status).toBe(200);
      const v3Json = await v3.json() as { scenarios: unknown[]; aliases: unknown[] };
      expect(v3Json.scenarios).toHaveLength(28);
      expect(v3Json.aliases).toHaveLength(53);
      expect(findForbiddenPublicApiValues(v3Json)).toEqual([]);
      expect(findForbiddenCustomerCopyValues(v3Json)).toEqual([]);

      const legacy = await fetch(`${baseUrl}/api/scenarios`);
      expect(legacy.status).toBe(200);
      const legacyJson = await legacy.json() as { scenarios: unknown[] };
      expect(legacyJson.scenarios).toHaveLength(53);
      expect(findForbiddenPublicApiValues(legacyJson)).toEqual([]);

      const resolved = await fetch(`${baseUrl}/api/scenarios/v3/resolve/legacy-01`);
      expect(resolved.status).toBe(200);
      await expect(resolved.json()).resolves.toMatchObject({
        scenario: { id: "catalog-07" },
        resolvedFromLegacySlug: "legacy-01",
      });

      const deferred = await fetch(`${baseUrl}/api/scenarios/v3/resolve/legacy-48`);
      expect(deferred.status).toBe(200);
      await expect(deferred.json()).resolves.toMatchObject({
        resolution: "deferred",
        deferredObject: {
          id: "deferred-01",
          status: "deferred",
          reason: "该旧入口已后置，保留诚实状态说明",
        },
        resolvedFromLegacySlug: "legacy-48",
      });
    } finally {
      await stopServer(server);
    }
  });

  it("enriches the public catalog only from independently published runtime replays", async () => {
    const loaded = parseWorkflowLibraryV3(buildLibraryFixture());
    const planned = loaded.internal.demos.find((demo) => demo.id === "demo-planned")!;
    const replayId = "00000000-0000-4000-8000-000000000002";
    const published = {
      snapshot: {
        replayId,
        runId: "run-runtime-02",
        demoId: "demo-runtime-02",
        workflowId: "workflow-02",
        catalogScenarioId: "catalog-02",
        definitionVersion: "1",
        contentHash: "hash-runtime-02",
        replay: {
          id: "demo-runtime-02",
          workflowId: "workflow-02",
          catalogScenarioId: "catalog-02",
          primaryType: "CREATE",
          environment: planned.environment,
          title: planned.public.title,
          environmentLabel: planned.public.environmentLabel,
          before: planned.public.before,
          timeline: planned.public.timeline,
          after: planned.public.after,
          evidence: planned.public.evidence,
          replayVersion: 1,
          status: "passed",
          startedAt: "2026-07-21T08:00:00.000Z",
          completedAt: "2026-07-21T08:01:00.000Z",
          verification: {
            readBackVerified: true,
            beforeObjectCount: 1,
            afterObjectCount: 1,
            eventCount: 3,
            receiptCount: 1,
            verifiedAt: "2026-07-21T08:01:00.000Z",
            evidenceHash: "evidence-runtime-02",
          },
        },
        createdAt: "2026-07-21T08:01:00.000Z",
      },
      review: {
        replayId,
        reviewerUserId: "independent-reviewer",
        decision: "approved",
        contentHash: "hash-runtime-02",
        reviewedAt: "2026-07-21T08:02:00.000Z",
      },
      publication: {
        replayId,
        publisherUserId: "independent-publisher",
        publishedAt: "2026-07-21T08:03:00.000Z",
      },
    } satisfies WorkflowDemoPublishedReplay;
    const workflowDemoStore = {
      getLatestPublishedByCatalog: async (catalogScenarioId: string) => (
        catalogScenarioId === "catalog-02" ? published : null
      ),
    } as unknown as WorkflowDemoStore;
    const { server, baseUrl } = await startV3Server(
      async () => loaded,
      undefined,
      workflowDemoStore,
    );
    try {
      const response = await fetch(`${baseUrl}/api/scenarios/v3`);
      expect(response.status).toBe(200);
      const body = await response.json() as {
        scenarios: Array<{
          id: string;
          demo: { evidenceLevel: string; sharePath?: string };
          launch: { sampleAvailable: boolean };
        }>;
        demos: unknown[];
      };
      const scenario = body.scenarios.find((item) => item.id === "catalog-02");
      expect(scenario).toMatchObject({
        demo: {
          evidenceLevel: "workflow_replay",
          sharePath: `/workflow-replays/${replayId}`,
        },
        launch: { sampleAvailable: true },
      });
      expect(body.demos).toEqual([]);
      expect(findForbiddenPublicApiValues(body)).toEqual([]);
      expect(findForbiddenCustomerCopyValues(body)).toEqual([]);
    } finally {
      await stopServer(server);
    }
  });

  it("fails closed without exposing V3 validation details", async () => {
    const { server, baseUrl } = await startV3Server(async () => {
      throw new Error("prompt SECRET_INTERNAL_PROBE");
    });
    try {
      const response = await fetch(`${baseUrl}/api/scenarios/v3`);
      expect(response.status).toBe(500);
      const body = JSON.stringify(await response.json());
      expect(body).toContain("workflow_catalog_unavailable");
      expect(body).not.toContain("SECRET_INTERNAL_PROBE");
      expect(body).not.toContain("prompt");
    } finally {
      await stopServer(server);
    }
  });

  it("allows legacy Cron only when compatibility explicitly permits it", async () => {
    const loaded = parseWorkflowLibraryV3(buildLibraryFixture());
    let addCalls = 0;
    const cronService = {
      async add() {
        addCalls += 1;
        return {
          id: "cron-1",
          name: "cron",
          enabled: true,
          schedule: { kind: "cron", expr: "0 8 * * *", tz: "Asia/Shanghai" },
          payload: { kind: "agentTurn", message: "message" },
          notify: { enabled: false, channel: "none", onSuccess: false, onError: false },
          createdAtMs: 1,
          updatedAtMs: 1,
          state: {},
        };
      },
      async runNow() {
        return { ran: true };
      },
    };
    const { server, baseUrl } = await startV3Server(async () => loaded, cronService as never);
    const body = {
      monitorTargets: ["测试对象"],
      signalAdaptation: {
        dailyEmptyStreakToWeekly: 3,
        userNoOpenStreakToPause: 5,
        emptyContentFallback: "本周行业热点摘要",
      },
      pushSlot: {
        channel: "ding_work_notification",
        target: "self",
        humanReviewRequired: false,
      },
    };
    try {
      const unsupported = await fetch(`${baseUrl}/api/scenarios/create-cron`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, scenarioId: "legacy-02" }),
      });
      expect(unsupported.status).toBe(409);
      await expect(unsupported.json()).resolves.toMatchObject({
        error: "LEGACY_CRON_NOT_SUPPORTED",
      });
      expect(addCalls).toBe(0);

      const supported = await fetch(`${baseUrl}/api/scenarios/create-cron`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, scenarioId: "legacy-01" }),
      });
      expect(supported.status).toBe(200);
      expect(addCalls).toBe(1);
    } finally {
      await stopServer(server);
    }
  });
});

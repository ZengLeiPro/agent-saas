import { z } from "zod";
import { sanitizeCustomerFacingText } from "../security/sanitizeCustomerFacingText.js";
import {
  industryTypeSchema,
  scenarioItemSchema,
  scenarioRoleSchema,
} from "./roleKit.js";

const rawTextSchema = z.string().trim().min(1).max(20_000);
const idSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const refSchema = z.string().trim().min(1).max(240);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * 仅用于客户自然语言叶子。ID、ref、URL、hash、token 必须使用独立 schema，
 * 避免术语替换破坏机器字段；命中 hard block 时整份 public DTO fail closed。
 */
export const workflowPublicTextSchema = z.string().trim().min(1).max(20_000).transform((value, ctx) => {
  const result = sanitizeCustomerFacingText(value);
  if (!result.safeToPublish) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "客户文案命中发布红线",
    });
    return z.NEVER;
  }
  return result.output;
});

export const workflowPrimaryTypeSchema = z.enum(["CREATE", "WATCH", "ACT", "LOOP"]);
/** 执行结构与目录主体验解耦：WATCH/ACT 只要含等待恢复，执行上就是 LOOP。 */
export const workflowExecutionTypeSchema = z.enum(["CREATE", "ACT", "LOOP"]);
export const workflowTriggerModeSchema = z.enum(["manual", "event-driven", "scheduled"]);
export const workflowEntryKindSchema = z.enum(["user_request", "business_event", "scheduled_trigger"]);
export const workflowReadinessSchema = z.enum(["D0_CURRENT", "D1_CONNECTOR", "D2_PROJECT"]);
export const workflowCapabilityKindSchema = z.enum([
  "CURRENT",
  "STANDARD_CONNECTOR",
  "PROJECT_INTEGRATION",
]);
export const workflowRiskSchema = z.enum(["low", "medium", "high", "critical"]);
export const workflowGoalTagSchema = z.enum([
  "找客户",
  "推进成交",
  "追回款",
  "保交付",
  "控库存",
  "降客诉",
  "提人效",
  "控风险",
]);

const roleV3Schema = z.object({
  id: idSchema,
  name: rawTextSchema,
  sort: z.number().int().min(0),
}).strict();

const publicRoleV3Schema = z.object({
  id: idSchema,
  name: workflowPublicTextSchema,
  sort: z.number().int().min(0),
}).strict();

const capabilityRequirementSchema = z.object({
  id: idSchema,
  kind: workflowCapabilityKindSchema,
  required: z.boolean(),
  publicLabel: rawTextSchema,
  connectorRef: refSchema.optional(),
}).strict();

const workflowTriggerSchema = z.object({
  id: idSchema,
  kind: z.enum(["manual", "schedule", "event", "message", "file", "system"]),
  sourceRef: refSchema,
  eventName: refSchema,
  conditionRef: refSchema,
}).strict();

const observeSourceSchema = z.object({
  id: idSchema,
  kind: refSchema,
  required: z.boolean(),
  freshness: refSchema,
  sourceOfTruthRef: refSchema,
  publicLabel: rawTextSchema,
}).strict();

const aiDecisionContractSchema = z.object({
  id: idSchema,
  question: rawTextSchema,
  evidenceRefs: z.array(refSchema).min(1),
  outputSchemaRef: refSchema,
}).strict();

const workflowActionSchema = z.object({
  id: idSchema,
  targetRef: refSchema,
  operationRef: refSchema,
  mutation: z.boolean(),
  risk: workflowRiskSchema,
  approvalRef: refSchema.optional(),
  permissionRef: refSchema,
  idempotencyRef: refSchema.optional(),
  receiptSchemaRef: refSchema,
  publicLabel: rawTextSchema,
  artifact: z.boolean().optional(),
}).strict();

const approvalPolicySchema = z.object({
  id: idSchema,
  required: z.boolean(),
  whenRef: refSchema,
  approverRoleIds: z.array(idSchema),
  expiresAfter: refSchema.optional(),
  denyState: refSchema,
}).strict();

const permissionPolicySchema = z.object({
  id: idSchema,
  actorRef: refSchema,
  resourceRef: refSchema,
  actions: z.array(refSchema).min(1),
  scopeBoundaryRef: refSchema,
}).strict();

const idempotencyPolicySchema = z.object({
  id: idSchema,
  actionId: idSchema,
  scope: refSchema,
  keyTemplateRef: refSchema,
  onDuplicate: z.enum(["return_original", "reject_conflict", "handoff"]),
}).strict();

const waitPolicySchema = z.object({
  waitingStates: z.array(refSchema),
  resumeSignals: z.array(refSchema),
  reminderPolicyRef: refSchema.optional(),
  maxWait: refSchema.optional(),
  escalationRef: refSchema.optional(),
}).strict();

const escalationPolicySchema = z.object({
  id: idSchema,
  whenRef: refSchema,
  toRoleIds: z.array(idSchema).min(1),
  actionRef: refSchema,
  severity: workflowRiskSchema,
}).strict();

const verificationCheckSchema = z.object({
  id: idSchema,
  kind: z.enum(["artifact", "readback", "state", "receipt", "cycle", "safety"]),
  targetRef: refSchema,
  required: z.boolean(),
  publicLabel: rawTextSchema,
}).strict();

const verificationContractSchema = z.object({
  checks: z.array(verificationCheckSchema).min(1),
  sourceOfTruthRefs: z.array(refSchema).min(1),
  successState: refSchema,
  failureStates: z.array(refSchema).min(1),
}).strict();

const retryPolicySchema = z.object({
  operationRef: refSchema,
  retryableErrorRefs: z.array(refSchema),
  maxAttempts: z.number().int().min(0).max(20),
  backoffRef: refSchema,
}).strict();

const compensationPolicySchema = z.object({
  actionId: idSchema,
  onFailureRef: refSchema,
  compensationActionRef: refSchema,
}).strict();

const humanHandoffPolicySchema = z.object({
  whenRefs: z.array(refSchema).min(1),
  toRoleIds: z.array(idSchema).min(1),
  contextBundleRef: refSchema,
  requiredAcknowledgement: z.boolean(),
}).strict();

const memoryContractSchema = z.object({
  readScopes: z.array(refSchema),
  writeScopes: z.array(refSchema),
  writePolicyRef: refSchema,
  retentionRef: refSchema,
}).strict();

const outcomeContractSchema = z.object({
  metric: rawTextSchema,
  baseline: rawTextSchema,
  measurementWindow: rawTextSchema,
  successConditionRef: refSchema,
  ownerRoleId: idSchema,
}).strict();

const proofContractSchema = z.object({
  evidenceTypes: z.array(refSchema).min(1),
  sourceOfTruthRefs: z.array(refSchema).min(1),
  freshness: rawTextSchema,
  requiredForCompletion: z.boolean(),
}).strict();

const workflowRuntimeSchema = z.object({
  jobToBeDone: rawTextSchema,
  business: z.object({
    objective: rawTextSchema,
    lossMechanism: rawTextSchema,
    objectType: refSchema,
    terminalStates: z.array(refSchema).min(1),
  }).strict(),
  trigger: z.array(workflowTriggerSchema).min(1),
  observe: z.object({
    sources: z.array(observeSourceSchema).min(1),
    requiredContextRefs: z.array(refSchema),
    freshnessPolicyRef: refSchema.optional(),
  }).strict(),
  judge: z.object({
    ruleRefs: z.array(refSchema),
    aiDecisions: z.array(aiDecisionContractSchema).min(1),
    outputSchemaRef: refSchema,
  }).strict(),
  uncertainty: z.object({
    onMissingEvidence: z.enum(["WAIT", "ASK", "HANDOFF", "BLOCK"]),
    onConflict: z.enum(["WAIT", "ASK", "HANDOFF", "BLOCK"]),
    confidenceThreshold: z.number().min(0).max(1).optional(),
    maxClarifications: z.number().int().min(0).max(20).optional(),
  }).strict(),
  act: z.array(workflowActionSchema).min(1),
  approval: z.array(approvalPolicySchema),
  permission: z.array(permissionPolicySchema).min(1),
  idempotency: z.array(idempotencyPolicySchema),
  wait: waitPolicySchema,
  escalation: z.array(escalationPolicySchema),
  verify: verificationContractSchema,
  retry: z.array(retryPolicySchema),
  compensation: z.array(compensationPolicySchema),
  handoff: humanHandoffPolicySchema,
  memory: memoryContractSchema,
  outcome: outcomeContractSchema,
  proof: proofContractSchema,
}).strict();

const workflowPublicSummaryRawSchema = z.object({
  jobToBeDone: rawTextSchema,
  objective: rawTextSchema,
  lossIfIgnored: rawTextSchema,
  trigger: rawTextSchema,
  observe: z.array(rawTextSchema).min(1),
  judge: rawTextSchema,
  uncertainty: rawTextSchema,
  act: z.array(rawTextSchema).min(1),
  approval: rawTextSchema,
  wait: rawTextSchema,
  escalation: rawTextSchema,
  verify: rawTextSchema,
  outcome: rawTextSchema,
  proof: rawTextSchema,
}).strict();

export const workflowPublicSummarySchema = z.object({
  jobToBeDone: workflowPublicTextSchema,
  objective: workflowPublicTextSchema,
  lossIfIgnored: workflowPublicTextSchema,
  trigger: workflowPublicTextSchema,
  observe: z.array(workflowPublicTextSchema).min(1),
  judge: workflowPublicTextSchema,
  uncertainty: workflowPublicTextSchema,
  act: z.array(workflowPublicTextSchema).min(1),
  approval: workflowPublicTextSchema,
  wait: workflowPublicTextSchema,
  escalation: workflowPublicTextSchema,
  verify: workflowPublicTextSchema,
  outcome: workflowPublicTextSchema,
  proof: workflowPublicTextSchema,
}).strict();

const workflowSkinRuleSchema = z.object({
  id: refSchema,
  description: rawTextSchema,
  appliesWhen: rawTextSchema,
  sourceEvidenceCardIds: z.array(refSchema).min(1),
}).strict();

const workflowSkinOperationAdapterSchema = z.object({
  actionRef: idSchema,
  target: rawTextSchema,
  operation: rawTextSchema,
  permission: rawTextSchema,
  approval: rawTextSchema,
  idempotencyKey: rawTextSchema,
  receipt: rawTextSchema,
  readback: rawTextSchema,
  successState: rawTextSchema,
  failureState: rawTextSchema,
  compensation: rawTextSchema,
}).strict();

const workflowSkinMaturityProfileSchema = z.object({
  level: z.enum(["M0_FRAGMENTED", "M1_SYSTEMED", "M2_INTEGRATED"]),
  deliveryPath: rawTextSchema,
  readiness: z.enum(["D1_CONNECTOR", "D2_PROJECT"]),
  cta: z.enum(["接入我的系统", "预约落地诊断"]),
}).strict();

const workflowSkinSchema = z.object({
  id: idSchema,
  title: rawTextSchema,
  industryVerticals: z.array(refSchema),
  businessModels: z.array(refSchema),
  readinessOverride: z.enum(["D1_CONNECTOR", "D2_PROJECT"]).optional(),
  objectLabels: z.array(z.object({ key: refSchema, label: rawTextSchema }).strict()),
  ruleRefs: z.array(refSchema).min(1),
  rules: z.array(workflowSkinRuleSchema).min(1),
  systemsAndEvidence: z.object({
    systems: z.array(rawTextSchema).min(1),
    evidence: z.array(rawTextSchema).min(1),
  }).strict(),
  ownership: z.object({
    primaryOwner: rawTextSchema,
    collaboratorRoles: z.array(rawTextSchema).min(1),
    strongApprovalRoles: z.array(rawTextSchema).min(1),
    approvalReason: rawTextSchema,
  }).strict(),
  terminal: z.object({
    successState: rawTextSchema,
    readback: rawTextSchema,
  }).strict(),
  operationAdapters: z.array(workflowSkinOperationAdapterSchema).min(1),
  metrics: z.array(rawTextSchema).min(1),
  evidence: z.object({
    status: z.enum(["local_verified", "external_process_verified", "regulatory_only", "interview_required"]),
    sourceEvidenceCardIds: z.array(refSchema).min(1),
    assumptionsToValidate: z.array(rawTextSchema).min(1),
    lastValidatedAt: dateSchema,
  }).strict(),
  maturityProfiles: z.array(workflowSkinMaturityProfileSchema).length(3),
  capabilityRequirementRefs: z.array(idSchema),
  actionBindingRefs: z.array(refSchema),
  approvalPolicyRefs: z.array(refSchema),
}).strict();

const workflowRoleViewSchema = z.object({
  id: idSchema,
  roleId: idSchema,
  title: rawTextSchema,
  responsibilities: z.array(rawTextSchema).min(1),
  visibleStageIds: z.array(refSchema),
  permittedActionRefs: z.array(refSchema),
  approvalPolicyRefs: z.array(refSchema),
}).strict();

export const workflowDefinitionRecordSchema = z.object({
  id: idSchema,
  definitionVersion: z.number().int().min(1),
  primaryType: workflowPrimaryTypeSchema,
  executionType: workflowExecutionTypeSchema,
  triggerMode: workflowTriggerModeSchema,
  readiness: workflowReadinessSchema,
  publicSummary: workflowPublicSummaryRawSchema,
  capabilityRequirements: z.array(capabilityRequirementSchema).min(1),
  runtime: workflowRuntimeSchema,
  skins: z.array(workflowSkinSchema),
  roleViews: z.array(workflowRoleViewSchema).min(1),
  internal: z.object({
    enabled: z.boolean(),
    source: refSchema,
    owner: rawTextSchema,
    reviewStatus: z.enum(["draft", "approved", "deferred"]),
    notes: rawTextSchema.optional(),
  }).strict(),
}).strict().superRefine((definition, ctx) => {
  const mutationActions = definition.runtime.act.filter((action) => action.mutation);
  const artifactActions = definition.runtime.act.filter((action) => action.artifact === true);
  const idempotentActionIds = new Set(definition.runtime.idempotency.map((item) => item.actionId));
  const idempotencyIds = new Set(definition.runtime.idempotency.map((item) => item.id));
  const permissionIds = new Set(definition.runtime.permission.map((item) => item.id));
  const approvalIds = new Set(definition.runtime.approval.map((item) => item.id));
  const verifiedTargets = new Set(definition.runtime.verify.checks.map((item) => item.targetRef));
  const actionIds = new Set(definition.runtime.act.map((item) => item.id));
  const capabilityIds = new Set(definition.capabilityRequirements.map((item) => item.id));
  const hasWaitResume = definition.runtime.wait.waitingStates.length > 0
    || definition.runtime.wait.resumeSignals.length > 0;
  const expectedExecutionType = definition.primaryType === "CREATE"
    ? "CREATE"
    : hasWaitResume
      ? "LOOP"
      : "ACT";
  if (definition.executionType !== expectedExecutionType) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `executionType 应为 ${expectedExecutionType}（由写动作与等待/恢复契约决定）`,
    });
  }
  const triggerKinds = new Set(definition.runtime.trigger.map((item) => item.kind));
  const expectedTriggerMode = triggerKinds.has("schedule")
    ? "scheduled"
    : [...triggerKinds].some((kind) => kind !== "manual")
      ? "event-driven"
      : "manual";
  if (definition.triggerMode !== expectedTriggerMode) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `triggerMode 应为 ${expectedTriggerMode}（由 trigger.kind 决定）`,
    });
  }

  for (const action of mutationActions) {
    if (!permissionIds.has(action.permissionRef)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `写动作 ${action.id} 缺权限策略` });
    }
    if (!action.idempotencyRef
      || !idempotencyIds.has(action.idempotencyRef)
      || !idempotentActionIds.has(action.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `写动作 ${action.id} 缺幂等策略` });
    }
    if (!verifiedTargets.has(action.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `写动作 ${action.id} 缺动作后回读验证` });
    }
    if ((action.risk === "high" || action.risk === "critical")
      && (!action.approvalRef || !approvalIds.has(action.approvalRef))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `高风险动作 ${action.id} 缺人审策略` });
    }
  }

  if (definition.primaryType === "CREATE" && artifactActions.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "CREATE 必须产生可验证 Artifact" });
  }
  if (definition.primaryType === "CREATE"
    && !definition.runtime.verify.checks.some((item) => item.kind === "artifact")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "CREATE 必须验证 Artifact" });
  }
  if (definition.primaryType === "WATCH") {
    const hasNonManualTrigger = definition.runtime.trigger.some((item) => item.kind !== "manual");
    const hasCycleCheck = definition.runtime.verify.checks.some((item) => item.kind === "cycle");
    if (!hasNonManualTrigger || !hasCycleCheck || definition.runtime.business.terminalStates.length < 2) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "WATCH 必须含非人工触发与周期验证" });
    }
  }
  if (definition.primaryType === "ACT" && mutationActions.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "ACT 必须包含写动作" });
  }
  if (definition.primaryType === "LOOP") {
    if (mutationActions.length === 0
      || definition.runtime.wait.waitingStates.length === 0
      || definition.runtime.wait.resumeSignals.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "LOOP 必须包含写动作、等待状态与恢复信号" });
    }
  }

  const readinessRank = { D0_CURRENT: 0, D1_CONNECTOR: 1, D2_PROJECT: 2 } as const;
  const capabilityRank = { CURRENT: 0, STANDARD_CONNECTOR: 1, PROJECT_INTEGRATION: 2 } as const;
  const highestRequiredCapability = Math.max(
    0,
    ...definition.capabilityRequirements
      .filter((item) => item.required)
      .map((item) => capabilityRank[item.kind]),
  );
  if (readinessRank[definition.readiness] !== highestRequiredCapability) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "readiness 与必需能力最高等级不一致" });
  }
  for (const skin of definition.skins) {
    const effectiveSkinReadiness = skin.readinessOverride ?? definition.readiness;
    if (skin.readinessOverride && readinessRank[skin.readinessOverride] < readinessRank[definition.readiness]) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `皮肤 ${skin.id} 不得降低成熟度` });
    }
    const ruleIds = new Set(skin.rules.map((rule) => rule.id));
    if (ruleIds.size !== skin.rules.length
      || skin.ruleRefs.length !== ruleIds.size
      || skin.ruleRefs.some((ref) => !ruleIds.has(ref))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `皮肤 ${skin.id} 规则引用必须与可解析规则一一对应` });
    }
    const maturityLevels = new Set(skin.maturityProfiles.map((profile) => profile.level));
    if (maturityLevels.size !== 3
      || !maturityLevels.has("M0_FRAGMENTED")
      || !maturityLevels.has("M1_SYSTEMED")
      || !maturityLevels.has("M2_INTEGRATED")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `皮肤 ${skin.id} 必须覆盖 M0/M1/M2 三种成熟度` });
    }
    for (const profile of skin.maturityProfiles) {
      if (readinessRank[profile.readiness] < readinessRank[effectiveSkinReadiness]) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `皮肤 ${skin.id} 的 ${profile.level} 不得降低成熟度` });
      }
      const expectedCta = profile.readiness === "D2_PROJECT" ? "预约落地诊断" : "接入我的系统";
      if (profile.cta !== expectedCta) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `皮肤 ${skin.id} 的 ${profile.level} CTA 与成熟度不一致` });
      }
    }
    for (const ref of skin.capabilityRequirementRefs) {
      if (!capabilityIds.has(ref)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `皮肤 ${skin.id} 能力引用无效` });
    }
    for (const ref of skin.actionBindingRefs) {
      if (!actionIds.has(ref)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `皮肤 ${skin.id} 动作引用无效` });
    }
    const adapterActionRefs = new Set<string>();
    for (const adapter of skin.operationAdapters) {
      if (!skin.actionBindingRefs.includes(adapter.actionRef) || !actionIds.has(adapter.actionRef)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `皮肤 ${skin.id} 行业动作适配器引用无效` });
      }
      if (adapterActionRefs.has(adapter.actionRef)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `皮肤 ${skin.id} 行业动作适配器重复` });
      }
      adapterActionRefs.add(adapter.actionRef);
    }
    for (const ref of skin.approvalPolicyRefs) {
      if (!approvalIds.has(ref)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `皮肤 ${skin.id} 审批引用无效` });
    }
  }
  for (const roleView of definition.roleViews) {
    for (const ref of roleView.permittedActionRefs) {
      if (!actionIds.has(ref)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `岗位视图 ${roleView.id} 动作引用无效` });
    }
    for (const ref of roleView.approvalPolicyRefs) {
      if (!approvalIds.has(ref)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `岗位视图 ${roleView.id} 审批引用无效` });
    }
  }
});

const catalogDetailRawSchema = z.object({
  event: rawTextSchema,
  reads: z.array(rawTextSchema).min(1),
  decides: rawTextSchema,
  acts: z.array(rawTextSchema).min(1),
  approval: rawTextSchema,
  beforeAfter: rawTextSchema,
  followUp: rawTextSchema,
  valueProof: rawTextSchema,
}).strict();

const presentationSurfaceKindSchema = z.enum([
  "crm_table",
  "erp_table",
  "im_thread",
  "mail_panel",
  "approval_card",
  "browser_panel",
  "task_list",
  "finance_ledger",
  "summary",
]);

const presentationItemStateSchema = z.enum([
  "neutral",
  "pending",
  "active",
  "success",
  "warning",
]);

const presentationPublicRawSchema = z.object({
  version: z.literal(1),
  dataLabel: z.literal("合成场景演示"),
  limitation: rawTextSchema,
  chapters: z.array(z.object({
    id: idSchema,
    title: rawTextSchema,
    narration: rawTextSchema,
    result: rawTextSchema,
    interaction: z.object({
      kind: z.enum(["next", "confirm"]),
      label: rawTextSchema,
    }).strict(),
    surface: z.object({
      kind: presentationSurfaceKindSchema,
      title: rawTextSchema,
      subtitle: rawTextSchema.optional(),
      items: z.array(z.object({
        label: rawTextSchema,
        value: rawTextSchema,
        state: presentationItemStateSchema,
        changed: z.boolean().optional(),
      }).strict()).min(1).max(8),
    }).strict(),
  }).strict()).min(6).max(9),
}).strict();

const catalogPublicRawSchema = z.object({
  title: rawTextSchema,
  value: rawTextSchema,
  shortChain: z.array(rawTextSchema).min(3).max(6),
  roleIds: z.array(idSchema).min(1),
  industryTags: z.array(industryTypeSchema).min(1),
  industryVerticals: z.array(refSchema),
  businessModels: z.array(refSchema),
  maturityLevels: z.array(refSchema).min(1),
  goalTags: z.array(workflowGoalTagSchema).min(1),
  triggerBadge: rawTextSchema,
  actionBadge: rawTextSchema,
  humanApprovalSummary: rawTextSchema,
  detail: catalogDetailRawSchema,
  launch: z.object({
    sampleAvailable: z.boolean(),
    inputHint: rawTextSchema.optional(),
    entry: z.object({
      kind: workflowEntryKindSchema,
      content: rawTextSchema,
    }).strict(),
  }).strict(),
  presentation: presentationPublicRawSchema.optional(),
}).strict();

export const catalogScenarioPublicSchema = z.object({
  id: idSchema,
  workflowId: idSchema,
  skinId: idSchema.optional(),
  roleViewIds: z.array(idSchema),
  title: workflowPublicTextSchema,
  value: workflowPublicTextSchema,
  shortChain: z.array(workflowPublicTextSchema).min(3).max(6),
  roleIds: z.array(idSchema).min(1),
  industryTags: z.array(industryTypeSchema).min(1),
  industryVerticals: z.array(workflowPublicTextSchema),
  businessModels: z.array(workflowPublicTextSchema),
  maturityLevels: z.array(workflowPublicTextSchema).min(1),
  goalTags: z.array(workflowGoalTagSchema).min(1),
  triggerBadge: workflowPublicTextSchema,
  actionBadge: workflowPublicTextSchema,
  humanApprovalSummary: workflowPublicTextSchema,
  detail: z.object({
    event: workflowPublicTextSchema,
    reads: z.array(workflowPublicTextSchema).min(1),
    decides: workflowPublicTextSchema,
    acts: z.array(workflowPublicTextSchema).min(1),
    approval: workflowPublicTextSchema,
    beforeAfter: workflowPublicTextSchema,
    followUp: workflowPublicTextSchema,
    valueProof: workflowPublicTextSchema,
  }).strict(),
  launch: z.object({
    sampleAvailable: z.boolean(),
    inputHint: workflowPublicTextSchema.optional(),
    startMode: z.enum(["chat", "replay", "connector", "diagnosis"]),
    entry: z.object({
      kind: workflowEntryKindSchema,
      content: workflowPublicTextSchema,
    }).strict(),
    starterMessage: workflowPublicTextSchema,
  }).strict(),
  primaryType: workflowPrimaryTypeSchema,
  readiness: workflowReadinessSchema,
  cta: z.object({
    primary: workflowPublicTextSchema,
    secondary: workflowPublicTextSchema.optional(),
  }).strict(),
  presentation: z.object({
    version: z.literal(1),
    dataLabel: z.literal("合成场景演示"),
    limitation: workflowPublicTextSchema,
    chapters: z.array(z.object({
      id: idSchema,
      title: workflowPublicTextSchema,
      narration: workflowPublicTextSchema,
      result: workflowPublicTextSchema,
      interaction: z.object({
        kind: z.enum(["next", "confirm"]),
        label: workflowPublicTextSchema,
      }).strict(),
      surface: z.object({
        kind: presentationSurfaceKindSchema,
        title: workflowPublicTextSchema,
        subtitle: workflowPublicTextSchema.optional(),
        items: z.array(z.object({
          label: workflowPublicTextSchema,
          value: workflowPublicTextSchema,
          state: presentationItemStateSchema,
          changed: z.boolean().optional(),
        }).strict()).min(1).max(8),
      }).strict(),
    }).strict()).min(6).max(9),
  }).strict().optional(),
  featured: z.boolean(),
  featuredOrder: z.number().int().min(1).optional(),
}).strict();

const heroReviewSchema = z.object({
  featured: z.boolean(),
  designScore: z.number().int().min(0).max(100),
  scoreStatus: z.enum(["design_only_not_runtime", "runtime_verified"]),
  order: z.number().int().min(1).optional(),
  veto: z.object({
    missingBusinessEndState: z.boolean(),
    noAgentNecessity: z.boolean(),
    noCredibleDemo: z.boolean(),
    readinessMismatch: z.boolean(),
  }).strict(),
}).strict().superRefine((hero, ctx) => {
  if (hero.featured && (!hero.order || hero.designScore < 80 || Object.values(hero.veto).some(Boolean))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Hero 必须达到 80 分、无否决项且有明确顺序" });
  }
  if (!hero.featured && hero.order) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "非 Hero 不得声明 Hero 顺序" });
  }
});

const compositionStepSchema = z.object({
  workflowId: idSchema,
  skinId: idSchema.optional(),
  entryConditionRef: refSchema,
  exitState: refSchema,
  required: z.boolean(),
  order: z.number().int().min(0),
}).strict();

export const catalogScenarioRecordSchema = z.object({
  id: idSchema,
  workflowId: idSchema,
  skinId: idSchema.optional(),
  roleViewIds: z.array(idSchema),
  composition: z.array(compositionStepSchema).optional(),
  public: catalogPublicRawSchema,
  internal: z.object({
    enabled: z.boolean(),
    source: refSchema,
    salesPitch: rawTextSchema.optional(),
    cannotPromise: z.array(rawTextSchema).optional(),
    legacyCompatRef: refSchema.optional(),
    internalNotes: rawTextSchema.optional(),
    hero: heroReviewSchema.optional(),
  }).strict(),
}).strict();

const workflowSkinPublicSchema = z.object({
  id: idSchema,
  workflowId: idSchema,
  title: workflowPublicTextSchema,
  industryVerticals: z.array(workflowPublicTextSchema),
  businessModels: z.array(workflowPublicTextSchema),
  readiness: workflowReadinessSchema,
  objectLabels: z.array(z.object({
    key: refSchema,
    label: workflowPublicTextSchema,
  }).strict()),
  rules: z.array(workflowPublicTextSchema).min(1),
  systems: z.array(workflowPublicTextSchema).min(1),
  evidenceRequired: z.array(workflowPublicTextSchema).min(1),
  ownership: z.object({
    primaryOwner: workflowPublicTextSchema,
    collaborators: z.array(workflowPublicTextSchema).min(1),
    strongApprovalRoles: z.array(workflowPublicTextSchema).min(1),
    approvalReason: workflowPublicTextSchema,
  }).strict(),
  terminal: z.object({
    successState: workflowPublicTextSchema,
    readback: workflowPublicTextSchema,
  }).strict(),
  operations: z.array(z.object({
    target: workflowPublicTextSchema,
    operation: workflowPublicTextSchema,
    approval: workflowPublicTextSchema,
    readback: workflowPublicTextSchema,
    successState: workflowPublicTextSchema,
    failureState: workflowPublicTextSchema,
    compensation: workflowPublicTextSchema,
  }).strict()).min(1),
  metrics: z.array(workflowPublicTextSchema).min(1),
  evidenceStatus: z.enum(["本地流程证据已核", "外部流程证据已核", "当前主要依据监管规则", "需要客户访谈核验"]),
  maturityProfiles: z.array(z.object({
    level: z.enum(["Excel/钉钉为主", "已有单体系统", "多系统已集成"]),
    deliveryPath: workflowPublicTextSchema,
    readiness: workflowReadinessSchema,
    cta: workflowPublicTextSchema,
  }).strict()).length(3),
}).strict();

const workflowRoleViewPublicSchema = z.object({
  id: idSchema,
  workflowId: idSchema,
  roleId: idSchema,
  title: workflowPublicTextSchema,
  responsibilities: z.array(workflowPublicTextSchema).min(1),
  visibleStages: z.array(workflowPublicTextSchema),
  actions: z.array(workflowPublicTextSchema),
  approvalSummary: workflowPublicTextSchema,
}).strict();


const legacyScenarioAliasBaseSchema = z.object({
  legacySlug: idSchema,
  roleViewId: idSchema.optional(),
  legacyCompatRef: refSchema,
});

export const legacyScenarioAliasRecordSchema = z.discriminatedUnion("resolution", [
  legacyScenarioAliasBaseSchema.extend({
    resolution: z.literal("catalog"),
    targetCatalogScenarioId: idSchema,
    skinId: idSchema.optional(),
  }).strict(),
  legacyScenarioAliasBaseSchema.extend({
    resolution: z.literal("deferred"),
    deferredObjectId: idSchema,
  }).strict(),
]);

export const workflowAliasRecordSchema = z.object({
  aliasId: idSchema,
  targetWorkflowId: idSchema,
}).strict();

const legacyScenarioCompatibilityBaseSchema = z.object({
  id: idSchema,
  legacySlug: idSchema,
  /** V1 公开形态的完整快照，保证 N/N+1 期间旧 Web 不丢引导元数据。 */
  legacyScenario: scenarioItemSchema,
  legacyCronSupported: z.boolean(),
});

export const legacyScenarioCompatibilityRecordSchema = z.discriminatedUnion("resolution", [
  legacyScenarioCompatibilityBaseSchema.extend({
    resolution: z.literal("catalog"),
    targetCatalogScenarioId: idSchema,
  }).strict(),
  legacyScenarioCompatibilityBaseSchema.extend({
    resolution: z.literal("deferred"),
    deferredObjectId: idSchema,
  }).strict(),
]);

export const deferredWorkflowObjectSchema = z.object({
  id: idSchema,
  kind: z.enum(["workflow", "create"]),
  reason: rawTextSchema,
  status: z.literal("deferred"),
}).strict();

export const workflowLibraryFileV3Schema = z.object({
  schemaVersion: z.literal(3),
  workflowContractVersion: z.literal(2),
  updatedAt: dateSchema,
  roles: z.array(roleV3Schema).min(1),
  /** N/N+1 期间供旧 /api/scenarios 显式投影，不进入 V3 公开 DTO。 */
  legacyRoles: z.array(scenarioRoleSchema.strict()).min(1),
  workflows: z.array(workflowDefinitionRecordSchema).min(1),
  catalogScenarios: z.array(catalogScenarioRecordSchema).min(1),
  deferredObjects: z.array(deferredWorkflowObjectSchema).min(1),
  scenarioAliases: z.array(legacyScenarioAliasRecordSchema).min(1),
  workflowAliases: z.array(workflowAliasRecordSchema),
  legacyCompatibility: z.array(legacyScenarioCompatibilityRecordSchema).min(1),
}).strict().superRefine((library, ctx) => {
  const unique = (values: string[], path: string) => {
    if (new Set(values).size !== values.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message: `${path} 存在重复 ID` });
    }
  };
  unique(library.roles.map((item) => item.id), "roles");
  unique(library.legacyRoles.map((item) => item.id), "legacyRoles");
  unique(library.workflows.map((item) => item.id), "workflows");
  unique(library.catalogScenarios.map((item) => item.id), "catalogScenarios");
  unique(library.deferredObjects.map((item) => item.id), "deferredObjects");
  unique(library.scenarioAliases.map((item) => item.legacySlug), "scenarioAliases");
  unique(library.legacyCompatibility.map((item) => item.legacySlug), "legacyCompatibility");

  const workflowIds = new Set(library.workflows.map((item) => item.id));
  const catalogIds = new Set(library.catalogScenarios.map((item) => item.id));
  const deferredObjectIds = new Set(library.deferredObjects.map((item) => item.id));
  const roleIds = new Set(library.roles.map((item) => item.id));
  const legacyRoleIds = new Set(library.legacyRoles.map((item) => item.id));
  const allSkinIds = library.workflows.flatMap((item) => item.skins.map((skin) => skin.id));
  const allRoleViewIds = library.workflows.flatMap((item) => item.roleViews.map((view) => view.id));
  const skinIds = new Set(allSkinIds);
  const roleViewIds = new Set(allRoleViewIds);
  unique(allSkinIds, "workflow skins");
  unique(allRoleViewIds, "workflow role views");

  if (roleIds.size !== legacyRoleIds.size || [...roleIds].some((id) => !legacyRoleIds.has(id))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "legacyRoles 必须与 roles 使用完全相同的角色 ID" });
  }

  for (const item of library.catalogScenarios) {
    if (!workflowIds.has(item.workflowId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `目录 ${item.id} 引用了不存在的 Workflow` });
    }
    for (const roleId of item.public.roleIds) {
      if (!roleIds.has(roleId)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `目录 ${item.id} 角色引用无效` });
    }
    const workflow = library.workflows.find((candidate) => candidate.id === item.workflowId);
    if (workflow) {
      const expectedEntryKind = workflow.executionType === "CREATE"
        ? "user_request"
        : workflow.triggerMode === "scheduled"
          ? "scheduled_trigger"
          : "business_event";
      if (item.public.launch.entry.kind !== expectedEntryKind) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `目录 ${item.id} 的入口类型应为 ${expectedEntryKind}`,
        });
      }
    }
    const workflowSkinIds = new Set(workflow?.skins.map((skin) => skin.id) ?? []);
    const workflowRoleViewIds = new Set(workflow?.roleViews.map((view) => view.id) ?? []);
    if (item.skinId && !workflowSkinIds.has(item.skinId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `目录 ${item.id} 皮肤不属于目标 Workflow` });
    }
    for (const roleViewId of item.roleViewIds) {
      if (!workflowRoleViewIds.has(roleViewId)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `目录 ${item.id} 岗位视图不属于目标 Workflow` });
      }
    }
    const presentation = item.public.presentation;
    if (presentation) {
      const chapterIds = presentation.chapters.map((chapter) => chapter.id);
      if (new Set(chapterIds).size !== chapterIds.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `目录 ${item.id} 的演示章节 ID 不得重复` });
      }
    }
  }
  for (const workflow of library.workflows) {
    for (const roleView of workflow.roleViews) {
      if (!roleIds.has(roleView.roleId)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `岗位视图 ${roleView.id} 岗位引用无效` });
    }
    for (const approval of workflow.runtime.approval) {
      for (const roleId of approval.approverRoleIds) {
        if (!roleIds.has(roleId)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `审批 ${approval.id} 岗位引用无效` });
      }
    }
    for (const escalation of workflow.runtime.escalation) {
      for (const roleId of escalation.toRoleIds) {
        if (!roleIds.has(roleId)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `升级 ${escalation.id} 岗位引用无效` });
      }
    }
    for (const roleId of workflow.runtime.handoff.toRoleIds) {
      if (!roleIds.has(roleId)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Workflow ${workflow.id} 接管岗位引用无效` });
    }
    if (!roleIds.has(workflow.runtime.outcome.ownerRoleId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Workflow ${workflow.id} 指标责任岗位引用无效` });
    }
  }
  for (const alias of library.scenarioAliases) {
    if (alias.resolution === "catalog" && !catalogIds.has(alias.targetCatalogScenarioId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `旧入口 ${alias.legacySlug} 目标无效` });
    }
    if (alias.resolution === "deferred" && !deferredObjectIds.has(alias.deferredObjectId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `旧入口 ${alias.legacySlug} 后置目标无效` });
    }
    if (alias.resolution === "catalog" && alias.skinId && !skinIds.has(alias.skinId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `旧入口 ${alias.legacySlug} 皮肤无效` });
    }
    if (alias.roleViewId && !roleViewIds.has(alias.roleViewId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `旧入口 ${alias.legacySlug} 岗位视图无效` });
    }
    if (alias.resolution === "catalog") {
      const catalog = library.catalogScenarios.find((item) => item.id === alias.targetCatalogScenarioId);
      const workflow = library.workflows.find((item) => item.id === catalog?.workflowId);
      if (alias.skinId && !workflow?.skins.some((skin) => skin.id === alias.skinId)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `旧入口 ${alias.legacySlug} 皮肤不属于目标 Workflow` });
      }
      if (alias.roleViewId && !workflow?.roleViews.some((view) => view.id === alias.roleViewId)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `旧入口 ${alias.legacySlug} 岗位视图不属于目标 Workflow` });
      }
    }
  }
  for (const alias of library.workflowAliases) {
    if (!workflowIds.has(alias.targetWorkflowId) || workflowIds.has(alias.aliasId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Workflow alias ${alias.aliasId} 非单跳或目标无效` });
    }
  }
  for (const record of library.legacyCompatibility) {
    if (record.resolution === "catalog" && !catalogIds.has(record.targetCatalogScenarioId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `兼容记录 ${record.legacySlug} 目标无效` });
    }
    if (record.resolution === "deferred" && !deferredObjectIds.has(record.deferredObjectId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `兼容记录 ${record.legacySlug} 后置目标无效` });
    }
  }
});

export const workflowLibraryPublicV3Schema = z.object({
  schemaVersion: z.literal(3),
  workflowContractVersion: z.literal(2),
  updatedAt: dateSchema,
  roles: z.array(publicRoleV3Schema),
  scenarios: z.array(catalogScenarioPublicSchema),
  deferredObjects: z.array(z.object({
    id: idSchema,
    kind: z.enum(["workflow", "create"]),
    reason: workflowPublicTextSchema,
    status: z.literal("deferred"),
  }).strict()),
  workflows: z.array(z.object({
    id: idSchema,
    definitionVersion: z.number().int().min(1),
    primaryType: workflowPrimaryTypeSchema,
    readiness: workflowReadinessSchema,
    summary: workflowPublicSummarySchema,
    capabilities: z.array(z.object({
      id: idSchema,
      kind: workflowCapabilityKindSchema,
      required: z.boolean(),
      label: workflowPublicTextSchema,
    }).strict()),
  }).strict()),
  skins: z.array(workflowSkinPublicSchema),
  roleViews: z.array(workflowRoleViewPublicSchema),
  aliases: z.array(z.discriminatedUnion("resolution", [
    z.object({
      legacySlug: idSchema,
      resolution: z.literal("catalog"),
      targetCatalogScenarioId: idSchema,
      skinId: idSchema.optional(),
      roleViewId: idSchema.optional(),
      roleId: idSchema.optional(),
    }).strict(),
    z.object({
      legacySlug: idSchema,
      resolution: z.literal("deferred"),
      deferredObjectId: idSchema,
      roleViewId: idSchema.optional(),
      roleId: idSchema.optional(),
    }).strict(),
  ])),
}).strict();

export type WorkflowLibraryFileV3 = z.infer<typeof workflowLibraryFileV3Schema>;
export type WorkflowLibraryPublicV3 = z.infer<typeof workflowLibraryPublicV3Schema>;
export type WorkflowExecutionType = z.infer<typeof workflowExecutionTypeSchema>;
export type WorkflowTriggerMode = z.infer<typeof workflowTriggerModeSchema>;
export type WorkflowDefinitionRecord = z.infer<typeof workflowDefinitionRecordSchema>;
export type CatalogScenarioRecord = z.infer<typeof catalogScenarioRecordSchema>;
export type CatalogScenarioPublic = z.infer<typeof catalogScenarioPublicSchema>;

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  projectWorkflowLibraryPublic,
  resolveScenarioSlug,
  workflowLibraryFileV3Schema,
  type ResolvedScenarioSlug,
  type WorkflowLibraryFileV3,
  type WorkflowLibraryPublicV3,
} from "../../../../shared/src/index.js";
import type {
  ScenarioItemInternal,
  ScenarioLibraryResponse,
  ScenarioRole,
} from "../../../../shared/src/types/scenario.js";
import {
  sanitizeRole,
  sanitizeScenario,
} from "../../../../shared/src/security/sanitizeCustomerFacingText.js";

export const WORKFLOW_LIBRARY_EXPECTED_COUNTS = Object.freeze({
  roles: 8,
  legacyRoles: 8,
  workflows: 28,
  createWorkflows: 6,
  statefulWorkflows: 22,
  catalogScenarios: 28,
  deferredObjects: 5,
  scenarioAliases: 53,
  catalogAliases: 47,
  deferredAliases: 6,
  legacyCompatibility: 53,
  skins: 82,
  roleViews: 111,
  roleViewAssignments: 111,
  heroes: 12,
});

export const WORKFLOW_LIBRARY_HERO_IDS = Object.freeze([
  "technical-inquiry-to-approved-quote-loop",
  "lead-to-opportunity-loop",
  "controlled-version-release-loop",
  "order-delivery-defender-loop",
  "acceptance-to-cash-loop",
  "quality-nonconformance-loop",
  "customer-issue-resolution-loop",
  "inventory-rebalance-loop",
  "scope-change-margin-guard-loop",
  "payables-exception-to-payment-settlement-loop",
  "employee-lifecycle-transition-loop",
  "management-exception-closure-loop",
] as const);

export class WorkflowLibraryError extends Error {
  readonly code: "WORKFLOW_LIBRARY_INVALID" | "WORKFLOW_LIBRARY_PUBLICATION_BLOCKED";

  constructor(
    code: WorkflowLibraryError["code"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkflowLibraryError";
    this.code = code;
  }
}

export interface LoadedWorkflowLibraryV3 {
  readonly internal: WorkflowLibraryFileV3;
  readonly public: WorkflowLibraryPublicV3;
  readonly contentSha256: string;
  readonly legacy: ScenarioLibraryResponse;
}

function assertCount(label: string, actual: number, expected: number): void {
  if (actual !== expected) {
    throw new WorkflowLibraryError(
      "WORKFLOW_LIBRARY_INVALID",
      `${label} count mismatch: expected ${expected}, received ${actual}`,
    );
  }
}

function assertUnique(label: string, values: readonly string[]): void {
  if (new Set(values).size !== values.length) {
    throw new WorkflowLibraryError(
      "WORKFLOW_LIBRARY_INVALID",
      `${label} contains duplicate IDs`,
    );
  }
}

const CUSTOMER_COPY_MACHINE_PATTERN = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/;
const CUSTOMER_COPY_INTERNAL_WORD_PATTERN = /\b(?:create|update|submit|assign|send|release|compensate|readback|revision|case|owner|digest|hash|bytes|claimId|evidenceRef|sourceVersion|ref|manifest|ledger|verdict|asset|workflow|replay|runtime|canonical|evidence|approval|readiness)\b/i;
const CUSTOMER_COPY_LOWER_CAMEL_PATTERN = /\b[a-z][a-z0-9]*(?:[A-Z][A-Za-z0-9]*)+\b/;
const CUSTOMER_COPY_RAW_FIELD_WORD_PATTERN = /\b(?:event|message|stage|rule|schema|diff|lot|brief|hold|booking|customer|order|authority|certificate|specification|retest|defect|cutoff|enforcement|BOMRevision|materialShortage|inventory|supplierCommitment|substitute|inspection|logistics|riskCase|faultCode|serviceCase|sparePart|fieldAction|telemetry|customerConfirmation|knowledgeRevision)\b/i;

function assertCustomerCopy(label: string, values: readonly string[]): void {
  const invalid = values.find((value) => (
    value.startsWith("jobToBeDone：")
    || CUSTOMER_COPY_MACHINE_PATTERN.test(value)
    || CUSTOMER_COPY_INTERNAL_WORD_PATTERN.test(value)
    || CUSTOMER_COPY_LOWER_CAMEL_PATTERN.test(value)
    || CUSTOMER_COPY_RAW_FIELD_WORD_PATTERN.test(value)
  ));
  if (invalid) {
    throw new WorkflowLibraryError(
      "WORKFLOW_LIBRARY_INVALID",
      `customer copy contains internal state or operation text: ${label}`,
    );
  }
}

function textLeaves(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(textLeaves);
  if (value && typeof value === "object") return Object.values(value).flatMap(textLeaves);
  return [];
}

/**
 * 当前首批冻结数据的跨对象守恒门禁。数量不写进通用 Zod schema，后续合法扩容时
 * 只需在发布批次中显式更新这里与对应测试，不会把 schemaVersion 误当业务数量版本。
 */
export function lintWorkflowLibraryV3(library: WorkflowLibraryFileV3): void {
  const counts = WORKFLOW_LIBRARY_EXPECTED_COUNTS;
  assertCount("roles", library.roles.length, counts.roles);
  assertCount("legacy roles", library.legacyRoles.length, counts.legacyRoles);
  assertCount("workflows", library.workflows.length, counts.workflows);
  assertCount(
    "create workflows",
    library.workflows.filter((item) => item.primaryType === "CREATE").length,
    counts.createWorkflows,
  );
  assertCount(
    "stateful workflows",
    library.workflows.filter((item) => item.primaryType !== "CREATE").length,
    counts.statefulWorkflows,
  );
  assertCount(
    "D0 workflows",
    library.workflows.filter((item) => item.readiness === "D0_CURRENT").length,
    counts.createWorkflows,
  );
  assertCount(
    "D1 workflows",
    library.workflows.filter((item) => item.readiness === "D1_CONNECTOR").length,
    counts.statefulWorkflows,
  );
  assertCount(
    "D2 workflows",
    library.workflows.filter((item) => item.readiness === "D2_PROJECT").length,
    0,
  );
  for (const workflow of library.workflows) {
    if ((workflow.primaryType === "CREATE") !== (workflow.readiness === "D0_CURRENT")) {
      throw new WorkflowLibraryError(
        "WORKFLOW_LIBRARY_INVALID",
        `frozen workflow type/readiness mismatch: ${workflow.id}`,
      );
    }
  }
  assertCount("catalog scenarios", library.catalogScenarios.length, counts.catalogScenarios);
  assertCount("deferred objects", library.deferredObjects.length, counts.deferredObjects);
  assertCount("scenario aliases", library.scenarioAliases.length, counts.scenarioAliases);
  assertCount(
    "catalog aliases",
    library.scenarioAliases.filter((item) => item.resolution === "catalog").length,
    counts.catalogAliases,
  );
  assertCount(
    "deferred aliases",
    library.scenarioAliases.filter((item) => item.resolution === "deferred").length,
    counts.deferredAliases,
  );
  assertCount("legacy compatibility", library.legacyCompatibility.length, counts.legacyCompatibility);
  assertCount("workflow skins", library.workflows.reduce((sum, item) => sum + item.skins.length, 0), counts.skins);
  assertCount("workflow role views", library.workflows.reduce((sum, item) => sum + item.roleViews.length, 0), counts.roleViews);
  assertCount("catalog role view assignments", library.catalogScenarios.reduce((sum, item) => sum + item.roleViewIds.length, 0), counts.roleViewAssignments);
  const heroes = library.catalogScenarios.filter((item) => item.internal.hero?.featured === true);
  assertCount("hero workflows", heroes.length, counts.heroes);
  assertUnique("hero order", heroes.map((item) => String(item.internal.hero!.order)));

  if (new Set(library.legacyCompatibility.map((item) => item.id)).size
    !== library.legacyCompatibility.length) {
    throw new WorkflowLibraryError(
      "WORKFLOW_LIBRARY_INVALID",
      "legacy compatibility contains duplicate IDs",
    );
  }

  const workflowById = new Map(library.workflows.map((item) => [item.id, item] as const));
  const catalogById = new Map(library.catalogScenarios.map((item) => [item.id, item] as const));
  const roleIds = new Set(library.roles.map((item) => item.id));
  const legacyRoleIds = new Set(library.legacyRoles.map((item) => item.id));
  if (roleIds.size !== legacyRoleIds.size || [...roleIds].some((id) => !legacyRoleIds.has(id))) {
    throw new WorkflowLibraryError(
      "WORKFLOW_LIBRARY_INVALID",
      "legacy role IDs must exactly match V3 role IDs",
    );
  }
  const skinOwnerById = new Map<string, string>();
  const roleViewOwnerById = new Map<string, string>();
  for (const workflow of library.workflows) {
    if (!workflow.internal.enabled || workflow.internal.reviewStatus !== "approved") {
      throw new WorkflowLibraryError(
        "WORKFLOW_LIBRARY_INVALID",
        `frozen workflow is not publishable: ${workflow.id}`,
      );
    }
    const actionIds = workflow.runtime.act.map((item) => item.id);
    const permissionIds = workflow.runtime.permission.map((item) => item.id);
    const approvalIds = workflow.runtime.approval.map((item) => item.id);
    const idempotencyIds = workflow.runtime.idempotency.map((item) => item.id);
    const capabilityIds = workflow.capabilityRequirements.map((item) => item.id);
    assertUnique(`${workflow.id}.actions`, actionIds);
    assertUnique(`${workflow.id}.permissions`, permissionIds);
    assertUnique(`${workflow.id}.approvals`, approvalIds);
    assertUnique(`${workflow.id}.idempotency`, idempotencyIds);
    assertUnique(`${workflow.id}.capabilities`, capabilityIds);
    assertUnique(`${workflow.id}.triggers`, workflow.runtime.trigger.map((item) => item.id));
    assertUnique(`${workflow.id}.observe`, workflow.runtime.observe.sources.map((item) => item.id));
    assertUnique(`${workflow.id}.decisions`, workflow.runtime.judge.aiDecisions.map((item) => item.id));
    assertUnique(`${workflow.id}.verification`, workflow.runtime.verify.checks.map((item) => item.id));
    assertUnique(`${workflow.id}.escalations`, workflow.runtime.escalation.map((item) => item.id));

    const actionSet = new Set(actionIds);
    const permissionSet = new Set(permissionIds);
    const approvalSet = new Set(approvalIds);
    const idempotencySet = new Set(idempotencyIds);
    const capabilitySet = new Set(capabilityIds);
    assertCustomerCopy(`${workflow.id}.publicSummary`, textLeaves(workflow.publicSummary));
    assertCustomerCopy(
      `${workflow.id}.publicActionLabels`,
      workflow.runtime.act.map((item) => item.publicLabel),
    );
    for (const action of workflow.runtime.act) {
      if (!permissionSet.has(action.permissionRef)
        || (action.approvalRef && !approvalSet.has(action.approvalRef))
        || (action.idempotencyRef && !idempotencySet.has(action.idempotencyRef))) {
        throw new WorkflowLibraryError(
          "WORKFLOW_LIBRARY_INVALID",
          `workflow action has an invalid policy reference: ${workflow.id}/${action.id}`,
        );
      }
    }
    for (const policy of workflow.runtime.idempotency) {
      if (!actionSet.has(policy.actionId)) {
        throw new WorkflowLibraryError(
          "WORKFLOW_LIBRARY_INVALID",
          `idempotency policy references an unknown action: ${workflow.id}/${policy.id}`,
        );
      }
    }
    for (const skin of workflow.skins) {
      assertCustomerCopy(`${skin.id}.public`, [skin.title, ...skin.objectLabels.map((item) => item.label)]);
      if (skinOwnerById.has(skin.id)) {
        throw new WorkflowLibraryError(
          "WORKFLOW_LIBRARY_INVALID",
          `duplicate workflow skin ID: ${skin.id}`,
        );
      }
      skinOwnerById.set(skin.id, workflow.id);
      if (skin.capabilityRequirementRefs.some((id) => !capabilitySet.has(id))
        || skin.actionBindingRefs.some((id) => !actionSet.has(id))
        || skin.approvalPolicyRefs.some((id) => !approvalSet.has(id))) {
        throw new WorkflowLibraryError(
          "WORKFLOW_LIBRARY_INVALID",
          `workflow skin has an invalid policy reference: ${skin.id}`,
        );
      }
    }
    for (const view of workflow.roleViews) {
      assertCustomerCopy(`${view.id}.public`, [view.title, ...view.responsibilities]);
      if (!roleIds.has(view.roleId)) {
        throw new WorkflowLibraryError(
          "WORKFLOW_LIBRARY_INVALID",
          `workflow role view references an unknown role: ${view.id}`,
        );
      }
      if (roleViewOwnerById.has(view.id)) {
        throw new WorkflowLibraryError(
          "WORKFLOW_LIBRARY_INVALID",
          `duplicate workflow role view ID: ${view.id}`,
        );
      }
      roleViewOwnerById.set(view.id, workflow.id);
      if (view.permittedActionRefs.some((id) => !actionSet.has(id))
        || view.approvalPolicyRefs.some((id) => !approvalSet.has(id))) {
        throw new WorkflowLibraryError(
          "WORKFLOW_LIBRARY_INVALID",
          `workflow role view has an invalid action/policy reference: ${view.id}`,
        );
      }
    }
  }
  for (const scenario of library.catalogScenarios) {
    assertCustomerCopy(`${scenario.id}.public`, textLeaves(scenario.public));
    const workflow = workflowById.get(scenario.workflowId);
    if (!scenario.internal.enabled
      || !workflow?.internal.enabled
      || workflow.internal.reviewStatus !== "approved") {
      throw new WorkflowLibraryError(
        "WORKFLOW_LIBRARY_INVALID",
        `frozen catalog scenario is not publishable: ${scenario.id}`,
      );
    }
    if (scenario.skinId && skinOwnerById.get(scenario.skinId) !== scenario.workflowId) {
      throw new WorkflowLibraryError(
        "WORKFLOW_LIBRARY_INVALID",
        `catalog scenario skin does not belong to its workflow: ${scenario.id}`,
      );
    }
    for (const viewId of scenario.roleViewIds) {
      if (roleViewOwnerById.get(viewId) !== scenario.workflowId) {
        throw new WorkflowLibraryError(
          "WORKFLOW_LIBRARY_INVALID",
          `catalog scenario role view does not belong to its workflow: ${scenario.id}`,
        );
      }
    }
    for (const step of scenario.composition ?? []) {
      const stepWorkflow = workflowById.get(step.workflowId);
      if (!stepWorkflow || !stepWorkflow.runtime.business.terminalStates.includes(step.exitState)) {
        throw new WorkflowLibraryError(
          "WORKFLOW_LIBRARY_INVALID",
          `catalog composition references an invalid terminal state: ${scenario.id}`,
        );
      }
      if (step.skinId && skinOwnerById.get(step.skinId) !== step.workflowId) {
        throw new WorkflowLibraryError(
          "WORKFLOW_LIBRARY_INVALID",
          `catalog composition skin does not belong to its workflow: ${scenario.id}`,
        );
      }
    }
    if (scenario.internal.defaultDemoId
      && !library.demos.some((demo) => demo.id === scenario.internal.defaultDemoId
        && demo.catalogScenarioId === scenario.id)) {
      throw new WorkflowLibraryError(
        "WORKFLOW_LIBRARY_INVALID",
        `catalog scenario default Demo is invalid: ${scenario.id}`,
      );
    }
  }

  const compositionGraph = new Map<string, Set<string>>();
  for (const scenario of library.catalogScenarios) {
    const dependencies = compositionGraph.get(scenario.workflowId) ?? new Set<string>();
    for (const step of scenario.composition ?? []) dependencies.add(step.workflowId);
    compositionGraph.set(scenario.workflowId, dependencies);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visitComposition = (workflowId: string): void => {
    if (visiting.has(workflowId)) {
      throw new WorkflowLibraryError(
        "WORKFLOW_LIBRARY_INVALID",
        `catalog composition contains a cycle at workflow: ${workflowId}`,
      );
    }
    if (visited.has(workflowId)) return;
    visiting.add(workflowId);
    for (const dependency of compositionGraph.get(workflowId) ?? []) {
      visitComposition(dependency);
    }
    visiting.delete(workflowId);
    visited.add(workflowId);
  };
  for (const workflowId of compositionGraph.keys()) visitComposition(workflowId);

  const canonicalIds = new Set(library.catalogScenarios.map((item) => item.id));
  const deferredObjectIds = new Set(library.deferredObjects.map((item) => item.id));
  for (const alias of library.scenarioAliases) {
    if (canonicalIds.has(alias.legacySlug)) {
      throw new WorkflowLibraryError(
        "WORKFLOW_LIBRARY_INVALID",
        `legacy slug conflicts with canonical scenario: ${alias.legacySlug}`,
      );
    }
    if (alias.resolution === "deferred") {
      if (!deferredObjectIds.has(alias.deferredObjectId)) {
        throw new WorkflowLibraryError(
          "WORKFLOW_LIBRARY_INVALID",
          `legacy slug points to an unknown deferred object: ${alias.legacySlug}`,
        );
      }
      if (alias.roleViewId && !roleViewOwnerById.has(alias.roleViewId)) {
        throw new WorkflowLibraryError(
          "WORKFLOW_LIBRARY_INVALID",
          `deferred legacy slug role view is invalid: ${alias.legacySlug}`,
        );
      }
      continue;
    }
    const target = catalogById.get(alias.targetCatalogScenarioId);
    const workflow = target ? workflowById.get(target.workflowId) : undefined;
    if (!target?.internal.enabled
      || !workflow?.internal.enabled
      || workflow.internal.reviewStatus !== "approved") {
      throw new WorkflowLibraryError(
        "WORKFLOW_LIBRARY_INVALID",
        `legacy slug points to an unpublished scenario: ${alias.legacySlug}`,
      );
    }
    if (alias.skinId && skinOwnerById.get(alias.skinId) !== target.workflowId) {
      throw new WorkflowLibraryError(
        "WORKFLOW_LIBRARY_INVALID",
        `legacy slug skin does not belong to its target workflow: ${alias.legacySlug}`,
      );
    }
    if (alias.roleViewId && roleViewOwnerById.get(alias.roleViewId) !== target.workflowId) {
      throw new WorkflowLibraryError(
        "WORKFLOW_LIBRARY_INVALID",
        `legacy slug role view does not belong to its target workflow: ${alias.legacySlug}`,
      );
    }
  }

  const aliasSlugs = new Set(library.scenarioAliases.map((item) => item.legacySlug));
  const compatibilitySlugs = new Set(
    library.legacyCompatibility.map((item) => item.legacySlug),
  );
  if (aliasSlugs.size !== compatibilitySlugs.size
    || [...aliasSlugs].some((slug) => !compatibilitySlugs.has(slug))) {
    throw new WorkflowLibraryError(
      "WORKFLOW_LIBRARY_INVALID",
      "scenario aliases and legacy compatibility slugs must match exactly",
    );
  }

  const aliasBySlug = new Map(
    library.scenarioAliases.map((item) => [item.legacySlug, item] as const),
  );
  for (const record of library.legacyCompatibility) {
    const alias = aliasBySlug.get(record.legacySlug);
    const sameResolution = alias?.resolution === record.resolution;
    const sameTarget = alias?.resolution === "catalog" && record.resolution === "catalog"
      ? alias.targetCatalogScenarioId === record.targetCatalogScenarioId
      : alias?.resolution === "deferred" && record.resolution === "deferred"
        ? alias.deferredObjectId === record.deferredObjectId
        : false;
    if (!alias || !sameResolution || !sameTarget) {
      throw new WorkflowLibraryError(
        "WORKFLOW_LIBRARY_INVALID",
        `legacy compatibility target mismatch: ${record.legacySlug}`,
      );
    }
    if (record.legacyCronSupported
      && (record.legacyScenario.mode !== "recurring"
        || !record.legacyScenario.recommendCron)) {
      throw new WorkflowLibraryError(
        "WORKFLOW_LIBRARY_INVALID",
        `legacy cron support is inconsistent: ${record.legacySlug}`,
      );
    }
    if (record.legacyScenario.id !== record.legacySlug) {
      throw new WorkflowLibraryError(
        "WORKFLOW_LIBRARY_INVALID",
        `legacy compatibility snapshot ID mismatch: ${record.legacySlug}`,
      );
    }
    if (!roleIds.has(record.legacyScenario.role)) {
      throw new WorkflowLibraryError(
        "WORKFLOW_LIBRARY_INVALID",
        `legacy compatibility references an unknown role: ${record.legacySlug}`,
      );
    }
  }

  if (new Set(library.workflowAliases.map((item) => item.aliasId)).size
    !== library.workflowAliases.length) {
    throw new WorkflowLibraryError(
      "WORKFLOW_LIBRARY_INVALID",
      "workflow aliases contain duplicate IDs",
    );
  }
  for (const demo of library.demos) {
    const workflow = workflowById.get(demo.workflowId);
    const scenario = catalogById.get(demo.catalogScenarioId);
    if (!workflow
      || !scenario
      || scenario.workflowId !== workflow.id
      || demo.definitionVersion !== workflow.definitionVersion
      || demo.primaryType !== workflow.primaryType
      || (demo.skinId && skinOwnerById.get(demo.skinId) !== workflow.id)) {
      throw new WorkflowLibraryError(
        "WORKFLOW_LIBRARY_INVALID",
        `Demo contract does not match its workflow/catalog: ${demo.id}`,
      );
    }
    const actionById = new Map(workflow.runtime.act.map((action) => [action.id, action] as const));
    for (const step of demo.internal.executionPlan ?? []) {
      if (step.mutation
        && step.phase !== "approval"
        && step.phase !== "resume"
        && !step.workflowActionId) {
        throw new WorkflowLibraryError(
          "WORKFLOW_LIBRARY_INVALID",
          `Demo Agent mutation is not bound to a frozen workflow action: ${demo.id}/${step.eventId}`,
        );
      }
      if (!step.workflowActionId) continue;
      const action = actionById.get(step.workflowActionId);
      if (!action
        || step.operationRef !== action.operationRef
        || step.permissionRef !== action.permissionRef
        || step.approvalPolicyRef !== action.approvalRef
        || step.receiptSchemaRef !== action.receiptSchemaRef
        || step.workflowIdempotencyPolicyRef !== action.idempotencyRef) {
        throw new WorkflowLibraryError(
          "WORKFLOW_LIBRARY_INVALID",
          `Demo action binding does not match frozen workflow: ${demo.id}/${step.eventId}`,
        );
      }
    }
  }
}

function projectLegacyScenario(
  _library: WorkflowLibraryFileV3,
  record: WorkflowLibraryFileV3["legacyCompatibility"][number],
): ScenarioItemInternal {
  const legacy = record.legacyScenario;
  const candidate: ScenarioItemInternal = {
    id: legacy.id,
    title: legacy.title,
    role: legacy.role,
    industries: legacy.industries.map((item) => item),
    mode: legacy.mode,
    pitch: legacy.pitch,
    story: legacy.story,
    // 旧 Web 仍依赖这些引导字段。V3 主路径不再展示长提示语，
    // 但 N/N+1 期间不能以“安全收缩”为由破坏旧客户端回滚兼容。
    promptTemplate: legacy.promptTemplate,
    slots: legacy.slots.map((item) => ({ ...item })),
    requires: legacy.requires.map((item) => item),
    recommendCron: legacy.recommendCron,
    ...(legacy.welcomeMessage ? { welcomeMessage: legacy.welcomeMessage } : {}),
    ...(legacy.industryFocus ? { industryFocus: legacy.industryFocus.map((item) => item) } : {}),
    ...(legacy.dataDependencyLevel ? { dataDependencyLevel: legacy.dataDependencyLevel } : {}),
    ...(legacy.firstAhaMode ? { firstAhaMode: legacy.firstAhaMode } : {}),
    ...(legacy.day1PathSteps ? { day1PathSteps: legacy.day1PathSteps.map((item) => ({ ...item })) } : {}),
    ...(legacy.skillCandidates ? { skillCandidates: legacy.skillCandidates.map((item) => ({ ...item })) } : {}),
    ...(legacy.activationFallback ? { activationFallback: { ...legacy.activationFallback } } : {}),
    ...(legacy.signalAdaptation ? { signalAdaptation: { ...legacy.signalAdaptation } } : {}),
    ...(legacy.pushSlot ? { pushSlot: { ...legacy.pushSlot } } : {}),
    ...(legacy.humanAuditPolicy ? { humanAuditPolicy: legacy.humanAuditPolicy } : {}),
    ...(legacy.exampleResult ? { exampleResult: { ...legacy.exampleResult } } : {}),
    enabled: true,
  };

  return candidate;
}

/** V3 compatibility 显式投影旧 Web 所需的 53 条形态。 */
export function projectLegacyScenarioLibrary(
  library: WorkflowLibraryFileV3,
): ScenarioLibraryResponse {
  const roles: ScenarioRole[] = [...library.legacyRoles]
    .sort((left, right) => left.sort - right.sort)
    .map((role) => ({ ...role }));
  const sanitizedRoles = roles.map((role) => {
    const report = sanitizeRole({ ...role });
    if (!report.safeToPublish) {
      throw new WorkflowLibraryError(
        "WORKFLOW_LIBRARY_PUBLICATION_BLOCKED",
        `legacy role publication blocked: ${role.id}`,
      );
    }
    return report.scenario as ScenarioRole;
  });
  const scenarios = library.legacyCompatibility.map((record) => {
    const candidate = projectLegacyScenario(library, record);
    const report = sanitizeScenario({ ...candidate });
    if (!report.safeToPublish) {
      throw new WorkflowLibraryError(
        "WORKFLOW_LIBRARY_PUBLICATION_BLOCKED",
        `legacy scenario publication blocked: ${record.legacySlug}`,
      );
    }
    const { enabled: _enabled, source: _source, salesPitch: _salesPitch, ...publicScenario } =
      report.scenario as ScenarioItemInternal;
    return publicScenario;
  });
  return { roles: sanitizedRoles, scenarios };
}

export async function loadWorkflowLibraryV3(
  dataPath: string,
): Promise<LoadedWorkflowLibraryV3> {
  let source: string;
  try {
    source = await readFile(dataPath, "utf-8");
  } catch (error) {
    throw new WorkflowLibraryError(
      "WORKFLOW_LIBRARY_INVALID",
      "workflow library file could not be read",
      { cause: error },
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(source) as unknown;
  } catch (error) {
    throw new WorkflowLibraryError(
      "WORKFLOW_LIBRARY_INVALID",
      "workflow library JSON is invalid",
      { cause: error },
    );
  }

  return parseWorkflowLibraryV3(raw, source);
}

/** 测试与构建工具可直接校验内存对象，不需要创建临时文件。 */
export function parseWorkflowLibraryV3(
  raw: unknown,
  source = JSON.stringify(raw),
): LoadedWorkflowLibraryV3 {
  const parsed = workflowLibraryFileV3Schema.safeParse(raw);
  if (!parsed.success) {
    const issueSummary = parsed.error.issues
      .slice(0, 12)
      .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
      .join("; ");
    throw new WorkflowLibraryError(
      "WORKFLOW_LIBRARY_INVALID",
      `workflow library schema validation failed (${parsed.error.issues.length} issues): ${issueSummary}`,
    );
  }

  lintWorkflowLibraryV3(parsed.data);
  try {
    const publicLibrary = projectWorkflowLibraryPublic(parsed.data);
    assertCount("public workflows", publicLibrary.workflows.length, WORKFLOW_LIBRARY_EXPECTED_COUNTS.workflows);
    assertCount("public catalog scenarios", publicLibrary.scenarios.length, WORKFLOW_LIBRARY_EXPECTED_COUNTS.catalogScenarios);
    assertCount("public deferred objects", publicLibrary.deferredObjects.length, WORKFLOW_LIBRARY_EXPECTED_COUNTS.deferredObjects);
    assertCount("public aliases", publicLibrary.aliases.length, WORKFLOW_LIBRARY_EXPECTED_COUNTS.scenarioAliases);
    const legacy = projectLegacyScenarioLibrary(parsed.data);
    assertCount("legacy scenarios", legacy.scenarios.length, WORKFLOW_LIBRARY_EXPECTED_COUNTS.legacyCompatibility);
    return {
      internal: parsed.data,
      public: publicLibrary,
      contentSha256: createHash("sha256").update(source).digest("hex"),
      legacy,
    };
  } catch (error) {
    if (error instanceof WorkflowLibraryError) throw error;
    throw new WorkflowLibraryError(
      "WORKFLOW_LIBRARY_PUBLICATION_BLOCKED",
      "workflow library public projection was blocked",
      { cause: error },
    );
  }
}

export function resolveLoadedScenarioSlug(
  library: LoadedWorkflowLibraryV3,
  slug: string,
): ResolvedScenarioSlug | null {
  return resolveScenarioSlug(library.public, slug);
}

export function findLegacyCompatibility(
  library: WorkflowLibraryFileV3,
  slug: string,
): WorkflowLibraryFileV3["legacyCompatibility"][number] | undefined {
  return library.legacyCompatibility.find((record) => record.legacySlug === slug);
}

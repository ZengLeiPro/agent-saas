import { z } from 'zod';

import {
  agentProfileContextModuleSchema,
  parseAgentRuntimeProfileConfig,
  type AgentProfileContextModule,
  type AgentRuntimeProfileConfig,
} from '../agentProfiles/types.js';

export const ORG_AGENT_RUNTIME_POLICY_SCHEMA_VERSION = 1 as const;

const stringIdListSchema = z.array(z.string().trim().min(1).max(160)).max(500);
const executionTargetSchema = z.enum([
  'server-local',
  'server-container',
  'server-remote',
  'client',
]);
const capabilityPolicySchema = z.enum(['inherit', 'disabled']);
const executionModeSchema = z.enum(['direct', 'dispatcher']);
const workerModelSchema = z.discriminatedUnion('strategy', [
  z.object({ strategy: z.literal('inherit') }).strict(),
  z.object({
    strategy: z.literal('fixed'),
    modelRef: z.string().trim().min(1).max(200),
  }).strict(),
]);

/**
 * Agent-local policy is deliberately unable to grant executable capabilities.
 * It may select model/context/memory behavior, while the shared `org_agent`
 * Runtime Profile remains the upper bound for tools, MCP, execution and boolean
 * capability surfaces.
 */
export const orgAgentRuntimePolicySchema = z.object({
  schemaVersion: z.literal(ORG_AGENT_RUNTIME_POLICY_SCHEMA_VERSION),
  executionMode: executionModeSchema.default('direct'),
  workerModel: workerModelSchema.default({ strategy: 'inherit' }),
  context: z.object({
    /** null inherits the shared Profile module set; an array explicitly selects non-security context modules. */
    modules: z.array(agentProfileContextModuleSchema).max(4).nullable().default(null),
  }).strict().default({ modules: null }),
  model: z.discriminatedUnion('strategy', [
    z.object({ strategy: z.literal('inherit') }).strict(),
    z.object({
      strategy: z.literal('fixed'),
      modelRef: z.string().trim().min(1).max(200),
    }).strict(),
  ]).default({ strategy: 'inherit' }),
  memory: z.object({
    scope: z.enum(['inherit', 'full', 'search_only', 'none']).default('inherit'),
  }).strict().default({ scope: 'inherit' }),
  limits: z.object({
    maxTurns: z.number().int().min(1).max(1_000).nullable().default(null),
  }).strict().default({ maxTurns: null }),
  capabilities: z.object({
    shell: capabilityPolicySchema.default('inherit'),
    backgroundTasks: capabilityPolicySchema.default('inherit'),
    interaction: capabilityPolicySchema.default('inherit'),
    subagents: capabilityPolicySchema.default('inherit'),
    scheduling: capabilityPolicySchema.default('inherit'),
  }).strict().default({
    shell: 'inherit',
    backgroundTasks: 'inherit',
    interaction: 'inherit',
    subagents: 'inherit',
    scheduling: 'inherit',
  }),
  tools: z.object({
    allowlist: stringIdListSchema.nullable().default(null),
    denylist: stringIdListSchema.default([]),
  }).strict().default({ allowlist: null, denylist: [] }),
  mcp: z.object({
    serverAllowlist: stringIdListSchema.nullable().default(null),
    toolAllowlist: stringIdListSchema.nullable().default(null),
    denyServers: stringIdListSchema.default([]),
    denyTools: stringIdListSchema.default([]),
  }).strict().default({
    serverAllowlist: null,
    toolAllowlist: null,
    denyServers: [],
    denyTools: [],
  }),
  apps: z.object({
    systemAllowlist: stringIdListSchema.nullable().default(null),
    capabilityAllowlist: stringIdListSchema.nullable().default(null),
    denySystems: stringIdListSchema.default([]),
    denyCapabilities: stringIdListSchema.default([]),
  }).strict().default({
    systemAllowlist: null,
    capabilityAllowlist: null,
    denySystems: [],
    denyCapabilities: [],
  }),
  execution: z.object({
    allowedTargets: z.array(executionTargetSchema).max(4).nullable().default(null),
  }).strict().default({ allowedTargets: null }),
}).strict().superRefine((policy, ctx) => {
  if (policy.executionMode === 'dispatcher') {
    if (policy.capabilities.backgroundTasks === 'disabled') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['capabilities', 'backgroundTasks'],
        message: '前台调度器必须启用后台任务能力',
      });
    }
    if (policy.capabilities.subagents === 'disabled') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['capabilities', 'subagents'],
        message: '前台调度器必须启用子 Agent 能力',
      });
    }
  }
  // Keep the Profile invariant at the policy boundary too. A null allowlist can
  // inherit workspace tools, so denying the readiness gate would be unsafe.
  const workspaceTools = new Set(['Read', 'Write', 'Edit', 'Shell']);
  const exposesWorkspaceTool = policy.tools.allowlist === null
    || policy.tools.allowlist.some(name => workspaceTools.has(name));
  if (!exposesWorkspaceTool) return;
  if (policy.tools.denylist.includes('WaitForWorkspaceReady')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['tools', 'denylist'],
      message: '可见工作区工具时不能禁止 WaitForWorkspaceReady',
    });
  }
  if (policy.tools.allowlist && !policy.tools.allowlist.includes('WaitForWorkspaceReady')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['tools', 'allowlist'],
      message: '显式工具允许列表包含工作区工具时必须包含 WaitForWorkspaceReady',
    });
  }
});

export type OrgAgentRuntimePolicy = z.infer<typeof orgAgentRuntimePolicySchema>;

export const DEFAULT_ORG_AGENT_RUNTIME_POLICY = Object.freeze({
  schemaVersion: ORG_AGENT_RUNTIME_POLICY_SCHEMA_VERSION,
  executionMode: 'direct',
  workerModel: { strategy: 'inherit' },
  context: { modules: null },
  model: { strategy: 'inherit' },
  memory: { scope: 'inherit' },
  limits: { maxTurns: null },
  capabilities: {
    shell: 'inherit',
    backgroundTasks: 'inherit',
    interaction: 'inherit',
    subagents: 'inherit',
    scheduling: 'inherit',
  },
  tools: { allowlist: null, denylist: [] },
  mcp: {
    serverAllowlist: null,
    toolAllowlist: null,
    denyServers: [],
    denyTools: [],
  },
  apps: {
    systemAllowlist: null,
    capabilityAllowlist: null,
    denySystems: [],
    denyCapabilities: [],
  },
  execution: { allowedTargets: null },
} satisfies OrgAgentRuntimePolicy);

/** Parse API/governance input and return a canonical, detached policy. */
export function parseOrgAgentRuntimePolicy(input: unknown): OrgAgentRuntimePolicy {
  const parsed = orgAgentRuntimePolicySchema.parse(input);
  return {
    ...parsed,
    workerModel: { ...parsed.workerModel },
    context: {
      modules: parsed.context.modules ? uniqueSorted(parsed.context.modules) : null,
    },
    capabilities: { ...parsed.capabilities },
    tools: {
      allowlist: parsed.tools.allowlist ? uniqueSorted(parsed.tools.allowlist) : null,
      denylist: uniqueSorted(parsed.tools.denylist),
    },
    mcp: {
      serverAllowlist: parsed.mcp.serverAllowlist ? uniqueSorted(parsed.mcp.serverAllowlist) : null,
      toolAllowlist: parsed.mcp.toolAllowlist ? uniqueSorted(parsed.mcp.toolAllowlist) : null,
      denyServers: uniqueSorted(parsed.mcp.denyServers),
      denyTools: uniqueSorted(parsed.mcp.denyTools),
    },
    apps: {
      systemAllowlist: parsed.apps.systemAllowlist
        ? uniqueSorted(parsed.apps.systemAllowlist)
        : null,
      capabilityAllowlist: parsed.apps.capabilityAllowlist
        ? uniqueSorted(parsed.apps.capabilityAllowlist)
        : null,
      denySystems: uniqueSorted(parsed.apps.denySystems),
      denyCapabilities: uniqueSorted(parsed.apps.denyCapabilities),
    },
    execution: {
      allowedTargets: parsed.execution.allowedTargets
        ? uniqueSorted(parsed.execution.allowedTargets)
        : null,
    },
  };
}

/**
 * Legacy file records may have no policy. Invalid/corrupt policy data falls back
 * to the immutable inherit-only policy, preserving the former shared-profile
 * behavior instead of accidentally granting a capability.
 */
export function normalizeOrgAgentRuntimePolicy(input: unknown): OrgAgentRuntimePolicy {
  const parsed = orgAgentRuntimePolicySchema.safeParse(input ?? DEFAULT_ORG_AGENT_RUNTIME_POLICY);
  return parseOrgAgentRuntimePolicy(parsed.success ? parsed.data : DEFAULT_ORG_AGENT_RUNTIME_POLICY);
}

/**
 * Merge an Agent-local policy into the shared `org_agent` Profile. Context,
 * memory and model are explicit Agent-level selections; executable capability,
 * tool, MCP and execution surfaces are inherited or narrowed. The returned
 * config is re-parsed by the Profile schema so cross-field rules (notably the
 * mandatory WaitForWorkspaceReady gate) cannot be bypassed by an intersection.
 */
/** 合并 `apps` 名单；结果无任何限制时返回空对象（不写 `apps` 键）。 */
function mergeAppsPolicy(
  shared: AgentRuntimeProfileConfig['apps'],
  policy: OrgAgentRuntimePolicy['apps'],
): Pick<AgentRuntimeProfileConfig, 'apps'> | Record<string, never> {
  const merged = {
    systemAllowlist: intersectNullable(shared?.systemAllowlist ?? null, policy.systemAllowlist),
    capabilityAllowlist: intersectNullable(
      shared?.capabilityAllowlist ?? null,
      policy.capabilityAllowlist,
    ),
    denySystems: union(shared?.denySystems ?? [], policy.denySystems),
    denyCapabilities: union(shared?.denyCapabilities ?? [], policy.denyCapabilities),
  };
  const unrestricted = merged.systemAllowlist === null
    && merged.capabilityAllowlist === null
    && merged.denySystems.length === 0
    && merged.denyCapabilities.length === 0;
  return unrestricted ? {} : { apps: merged };
}

export function mergeOrgAgentRuntimePolicy(
  shared: AgentRuntimeProfileConfig,
  input: OrgAgentRuntimePolicy | undefined,
): AgentRuntimeProfileConfig {
  const policy = normalizeOrgAgentRuntimePolicy(input);
  const contextModules = policy.context.modules === null
    ? [...shared.context.modules]
    : [...policy.context.modules];
  const memoryScope = policy.memory.scope === 'inherit'
    ? shared.memory.scope
    : policy.memory.scope;
  const sharedMaxTurns = shared.limits.maxTurns;
  const policyMaxTurns = policy.limits.maxTurns;
  const maxTurns = sharedMaxTurns === null
    ? policyMaxTurns
    : policyMaxTurns === null
      ? sharedMaxTurns
      : Math.min(sharedMaxTurns, policyMaxTurns);

  return parseAgentRuntimeProfileConfig({
    ...shared,
    context: {
      ...shared.context,
      modules: contextModules,
    },
    model: policy.model.strategy === 'fixed'
      ? { strategy: 'fixed', modelRef: policy.model.modelRef }
      : { ...shared.model },
    memory: { scope: memoryScope },
    limits: { maxTurns },
    capabilities: {
      shell: shared.capabilities.shell && policy.capabilities.shell !== 'disabled',
      backgroundTasks: shared.capabilities.backgroundTasks
        && policy.capabilities.backgroundTasks !== 'disabled',
      interaction: shared.capabilities.interaction && policy.capabilities.interaction !== 'disabled',
      subagents: shared.capabilities.subagents && policy.capabilities.subagents !== 'disabled',
      scheduling: shared.capabilities.scheduling && policy.capabilities.scheduling !== 'disabled',
    },
    tools: {
      allowlist: intersectNullable(shared.tools.allowlist, policy.tools.allowlist),
      denylist: union(shared.tools.denylist, policy.tools.denylist),
    },
    mcp: {
      serverAllowlist: intersectNullable(shared.mcp.serverAllowlist, policy.mcp.serverAllowlist),
      toolAllowlist: intersectNullable(shared.mcp.toolAllowlist, policy.mcp.toolAllowlist),
      denyServers: union(shared.mcp.denyServers, policy.mcp.denyServers),
      denyTools: union(shared.mcp.denyTools, policy.mcp.denyTools),
    },
    // 组织 Profile 侧 `apps` 是 optional（不进 config digest，见 agentProfiles/types.ts）：
    // 双方都没有限制时**整块不输出**，合并结果与本次改动前逐字节一致。
    ...mergeAppsPolicy(shared.apps, policy.apps),
    execution: {
      allowedTargets: intersectNullable(
        shared.execution.allowedTargets,
        policy.execution.allowedTargets,
      ),
    },
  });
}

/** Dispatcher front desk inherits Profile tools; Agent-local tool policy only narrows Workers. */
export function mergeOrgAgentFrontRuntimePolicy(
  shared: AgentRuntimeProfileConfig,
  input: OrgAgentRuntimePolicy | undefined,
): AgentRuntimeProfileConfig {
  const policy = normalizeOrgAgentRuntimePolicy(input);
  const merged = mergeOrgAgentRuntimePolicy(shared, policy);
  return policy.executionMode === 'dispatcher'
    ? { ...merged, tools: structuredClone(shared.tools) }
    : merged;
}

/**
 * Worker inherits the organization Agent's narrowed runtime policy. A dedicated
 * Worker model overrides the front-desk model; otherwise the normal Agent model
 * strategy remains authoritative. Dispatcher-only fields do not grant tools.
 */
export function mergeOrgAgentWorkerRuntimePolicy(
  shared: AgentRuntimeProfileConfig,
  input: OrgAgentRuntimePolicy | undefined,
): AgentRuntimeProfileConfig {
  const policy = normalizeOrgAgentRuntimePolicy(input);
  return mergeOrgAgentRuntimePolicy(shared, {
    ...policy,
    model: policy.workerModel.strategy === 'fixed'
      ? { strategy: 'fixed', modelRef: policy.workerModel.modelRef }
      : policy.model,
  });
}

/** MVP convention: knowledge ids are tenant-owned skill ids at runtime. */
export function resolveOrgAgentRuntimeSkillIds(agent: {
  allowedSkills: readonly string[];
  allowedKnowledge?: readonly string[];
}): string[] {
  return uniqueInOrder([...(agent.allowedSkills ?? []), ...(agent.allowedKnowledge ?? [])]);
}

function intersectNullable<T extends string>(
  left: readonly T[] | null,
  right: readonly T[] | null,
): T[] | null {
  if (left === null && right === null) return null;
  if (left === null) return uniqueSorted(right ?? []);
  if (right === null) return uniqueSorted(left);
  return intersect(left, right);
}

function intersect<T extends string>(left: readonly T[], right: readonly T[]): T[] {
  const rightSet = new Set(right);
  return uniqueSorted(left.filter(value => rightSet.has(value)));
}

function union<T extends string>(left: readonly T[], right: readonly T[]): T[] {
  return uniqueSorted([...left, ...right]);
}

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function uniqueInOrder(values: readonly string[]): string[] {
  return [...new Set(values.filter(value => value.length > 0))];
}

// Explicitly keep this import-used type visible in generated declarations.
export type OrgAgentRuntimeContextModule = AgentProfileContextModule;

import { createHash, randomUUID } from 'node:crypto';

import { z } from 'zod';

export const AGENT_PROFILE_SCHEMA_VERSION = 1 as const;

export const agentProfileContextModuleSchema = z.enum([
  'company_info',
  'runtime_memory',
  'personal_context',
]);

const stringIdListSchema = z.array(z.string().trim().min(1).max(160)).max(500);

export const agentRuntimeProfileConfigSchema = z.object({
  schemaVersion: z.literal(AGENT_PROFILE_SCHEMA_VERSION),
  context: z.object({
    systemInstructions: z.string().max(200_000).default(''),
    modules: z.array(agentProfileContextModuleSchema).max(3).default([
      'company_info',
      'runtime_memory',
      'personal_context',
    ]),
  }).strict(),
  skills: z.object({
    // 只在平台/组织/个人治理后的有效技能集中调整推荐顺序，不自行授予技能。
    defaultSkillIds: stringIdListSchema.default([]),
    allowlist: stringIdListSchema.nullable().default(null),
    denylist: stringIdListSchema.default([]),
  }).strict(),
  mcp: z.object({
    serverAllowlist: stringIdListSchema.nullable().default(null),
    toolAllowlist: stringIdListSchema.nullable().default(null),
    denyServers: stringIdListSchema.default([]),
    denyTools: stringIdListSchema.default([]),
  }).strict(),
  memory: z.object({
    scope: z.enum(['full', 'search_only', 'none', 'maintenance']).default('full'),
  }).strict(),
  model: z.discriminatedUnion('strategy', [
    z.object({ strategy: z.literal('inherit') }).strict(),
    z.object({
      strategy: z.literal('fixed'),
      modelRef: z.string().trim().min(1).max(200),
    }).strict(),
  ]),
  limits: z.object({
    maxTurns: z.number().int().min(1).max(1_000).nullable().default(null),
  }).strict(),
  capabilities: z.object({
    shell: z.boolean().default(true),
    backgroundTasks: z.boolean().default(true),
    interaction: z.boolean().default(true),
    subagents: z.boolean().default(true),
    scheduling: z.boolean().default(true),
  }).strict(),
  tools: z.object({
    allowlist: stringIdListSchema.nullable().default(null),
    denylist: stringIdListSchema.default([]),
  }).strict(),
  execution: z.object({
    allowedTargets: z.array(z.enum([
      'server-local',
      'server-container',
      'server-remote',
      'client',
    ])).max(4).nullable().default(null),
  }).strict(),
}).strict().superRefine((config, ctx) => {
  const workspaceTools = new Set(['Read', 'Write', 'Edit', 'List', 'Glob', 'Grep', 'Shell']);
  const exposesWorkspaceTool = config.tools.allowlist === null
    || config.tools.allowlist.some((name) => workspaceTools.has(name));
  if (!exposesWorkspaceTool) return;
  if (config.tools.denylist.includes('WaitForWorkspaceReady')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['tools', 'denylist'],
      message: '可见工作区工具时不能禁止 WaitForWorkspaceReady',
    });
  }
  if (config.tools.allowlist && !config.tools.allowlist.includes('WaitForWorkspaceReady')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['tools', 'allowlist'],
      message: '显式工具允许列表包含工作区工具时必须包含 WaitForWorkspaceReady',
    });
  }
});

export type AgentRuntimeProfileConfig = z.infer<typeof agentRuntimeProfileConfigSchema>;
export type AgentProfileContextModule = z.infer<typeof agentProfileContextModuleSchema>;

export type AgentRuntimeProfileStatus = 'draft' | 'published' | 'archived';

export interface AgentRuntimeProfile {
  profileId: string;
  profileKey: string;
  name: string;
  description: string;
  purpose: string;
  status: AgentRuntimeProfileStatus;
  systemProfile: boolean;
  draftConfig: AgentRuntimeProfileConfig;
  draftDigest: string;
  revision: number;
  latestVersion?: AgentRuntimeProfileVersionSummary;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
  archivedBy?: string;
  archivedAt?: string;
}

export interface AgentRuntimeProfileVersionSummary {
  profileVersionId: string;
  profileId: string;
  versionNumber: number;
  configDigest: string;
  publishedBy: string;
  publishedAt: string;
}

export interface AgentRuntimeProfileVersion extends AgentRuntimeProfileVersionSummary {
  configSchemaVersion: number;
  config: AgentRuntimeProfileConfig;
}

export type AgentProfileBindingKey =
  | 'main'
  | 'org_agent'
  | 'memory_poll'
  | 'subagent_general'
  | 'subagent_explore'
  | 'background_general'
  | 'background_explore';

export const AGENT_PROFILE_BINDING_KEYS = [
  'main',
  'org_agent',
  'memory_poll',
  'subagent_general',
  'subagent_explore',
  'background_general',
  'background_explore',
] as const satisfies readonly AgentProfileBindingKey[];

export interface AgentRuntimeProfileBinding {
  bindingKey: AgentProfileBindingKey;
  profileId: string;
  updatedBy: string;
  updatedAt: string;
}

export interface ResolvedAgentRuntimeProfile {
  bindingKey: AgentProfileBindingKey;
  profile: AgentRuntimeProfile;
  version: AgentRuntimeProfileVersion;
  source: 'database' | 'builtin';
}

export interface AgentProfileSessionBinding {
  profileId: string;
  profileKey: string;
  profileVersionId: string;
  profileVersionNumber: number;
  profileConfigDigest: string;
  profileBindingKey: AgentProfileBindingKey;
  profileResolution: 'database' | 'builtin' | 'compatibility';
}

export interface CreateAgentRuntimeProfileInput {
  profileKey: string;
  name: string;
  description?: string;
  purpose?: string;
  config?: AgentRuntimeProfileConfig;
  actor: string;
}

export interface UpdateAgentRuntimeProfileDraftInput {
  name?: string;
  description?: string;
  purpose?: string;
  config?: AgentRuntimeProfileConfig;
  expectedRevision: number;
  actor: string;
}

export interface AgentRuntimeProfileStore {
  readonly durable: boolean;
  init(): Promise<void>;
  listProfiles(): Promise<AgentRuntimeProfile[]>;
  getProfile(profileId: string): Promise<AgentRuntimeProfile | null>;
  createProfile(input: CreateAgentRuntimeProfileInput): Promise<AgentRuntimeProfile>;
  copyProfile(profileId: string, input: CreateAgentRuntimeProfileInput): Promise<AgentRuntimeProfile>;
  updateDraft(profileId: string, input: UpdateAgentRuntimeProfileDraftInput): Promise<AgentRuntimeProfile>;
  publish(profileId: string, expectedRevision: number, actor: string): Promise<AgentRuntimeProfileVersion>;
  archive(profileId: string, expectedRevision: number, actor: string): Promise<AgentRuntimeProfile>;
  listVersions(profileId: string): Promise<AgentRuntimeProfileVersion[]>;
  getVersion(profileVersionId: string): Promise<AgentRuntimeProfileVersion | null>;
  listBindings(): Promise<AgentRuntimeProfileBinding[]>;
  updateBinding(bindingKey: AgentProfileBindingKey, profileId: string, actor: string): Promise<AgentRuntimeProfileBinding>;
  resolveBinding(bindingKey: AgentProfileBindingKey): Promise<ResolvedAgentRuntimeProfile | null>;
}

export class AgentRuntimeProfileError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'NOT_FOUND'
      | 'CONFLICT'
      | 'INVALID_CONFIG'
      | 'NOT_DURABLE'
      | 'SYSTEM_PROFILE'
      | 'PROFILE_ARCHIVED'
      | 'PROFILE_NOT_PUBLISHED',
  ) {
    super(message);
    this.name = 'AgentRuntimeProfileError';
  }
}

export function parseAgentRuntimeProfileConfig(value: unknown): AgentRuntimeProfileConfig {
  const parsed = agentRuntimeProfileConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new AgentRuntimeProfileError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`).join('; '),
      'INVALID_CONFIG',
    );
  }
  return normalizeAgentRuntimeProfileConfig(parsed.data);
}

export function normalizeAgentRuntimeProfileConfig(config: AgentRuntimeProfileConfig): AgentRuntimeProfileConfig {
  return {
    ...config,
    context: {
      ...config.context,
      modules: uniqueSorted(config.context.modules),
    },
    skills: {
      defaultSkillIds: uniqueSorted(config.skills.defaultSkillIds),
      allowlist: config.skills.allowlist ? uniqueSorted(config.skills.allowlist) : null,
      denylist: uniqueSorted(config.skills.denylist),
    },
    mcp: {
      serverAllowlist: config.mcp.serverAllowlist ? uniqueSorted(config.mcp.serverAllowlist) : null,
      toolAllowlist: config.mcp.toolAllowlist ? uniqueSorted(config.mcp.toolAllowlist) : null,
      denyServers: uniqueSorted(config.mcp.denyServers),
      denyTools: uniqueSorted(config.mcp.denyTools),
    },
    tools: {
      allowlist: config.tools.allowlist ? uniqueSorted(config.tools.allowlist) : null,
      denylist: uniqueSorted(config.tools.denylist),
    },
    execution: {
      allowedTargets: config.execution.allowedTargets ? uniqueSorted(config.execution.allowedTargets) : null,
    },
  };
}

export function digestAgentRuntimeProfileConfig(config: AgentRuntimeProfileConfig): string {
  return createHash('sha256').update(canonicalJson(config)).digest('hex');
}

export function newAgentProfileId(): string {
  return `arp_${randomUUID()}`;
}

export function newAgentProfileVersionId(): string {
  return `arpv_${randomUUID()}`;
}

export function assertAgentProfileKey(value: string): string {
  const key = value.trim();
  if (!/^[a-z][a-z0-9_-]{1,63}$/.test(key)) {
    throw new AgentRuntimeProfileError('Profile key 必须为 2-64 位小写字母、数字、下划线或连字符，且以字母开头', 'INVALID_CONFIG');
  }
  return key;
}

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

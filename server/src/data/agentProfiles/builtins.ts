import {
  AGENT_PROFILE_SCHEMA_VERSION,
  digestAgentRuntimeProfileConfig,
  normalizeAgentRuntimeProfileConfig,
  type AgentProfileBindingKey,
  type AgentRuntimeProfile,
  type AgentRuntimeProfileBinding,
  type AgentRuntimeProfileConfig,
  type AgentRuntimeProfileVersion,
} from './types.js';
import { SUBAGENT_MAX_TURNS } from '../../runtime/subagent/subagentLimits.js';

const ALL_CONTEXT = ['company_info', 'runtime_memory', 'personal_context'] as const;

function baseConfig(overrides: Partial<AgentRuntimeProfileConfig> = {}): AgentRuntimeProfileConfig {
  return {
    schemaVersion: AGENT_PROFILE_SCHEMA_VERSION,
    context: {
      systemInstructions: '',
      modules: [...ALL_CONTEXT],
    },
    skills: { defaultSkillIds: [], allowlist: null, denylist: [] },
    mcp: { serverAllowlist: null, toolAllowlist: null, denyServers: [], denyTools: [] },
    memory: { scope: 'full' },
    model: { strategy: 'inherit' },
    limits: { maxTurns: null },
    capabilities: {
      shell: true,
      backgroundTasks: true,
      interaction: true,
      subagents: true,
      scheduling: true,
    },
    tools: { allowlist: null, denylist: [] },
    execution: { allowedTargets: null },
    ...overrides,
  };
}

const MEMORY_TOOLS = [
  'Edit',
  'Glob',
  'Grep',
  'List',
  'MemoryList',
  'MemorySearch',
  'Read',
  'UserActivityList',
  'WaitForWorkspaceReady',
  'Write',
];

const EXPLORE_TOOLS = [
  'Glob',
  'Grep',
  'MemorySearch',
  'Read',
  'WaitForWorkspaceReady',
  'WebFetch',
  'WebSearch',
];

export interface BuiltinAgentProfileDefinition {
  profileId: string;
  profileKey: string;
  name: string;
  description: string;
  purpose: string;
  config: AgentRuntimeProfileConfig;
}

export const BUILTIN_AGENT_PROFILES: readonly BuiltinAgentProfileDefinition[] = [
  {
    profileId: 'arp_system_default_interactive',
    profileKey: 'default_interactive',
    name: '默认交互 Agent',
    description: '个人主 Agent 的兼容运行预设。',
    purpose: '主 Agent、多轮交互与普通定时任务',
    config: baseConfig(),
  },
  {
    profileId: 'arp_system_org_agent',
    profileKey: 'org_agent_default',
    name: '专职 Agent 默认',
    description: '公司级专职 Agent 的默认运行预设，仍与专职 Agent 自身技能、受众和门禁取交集。',
    purpose: '公司级专职 Agent',
    config: baseConfig({
      context: { systemInstructions: '', modules: ['company_info'] },
      memory: { scope: 'none' },
    }),
  },
  {
    profileId: 'arp_system_memory_poll',
    profileKey: 'memory_poll',
    name: '记忆轮询',
    description: '记忆维护专用预设；代码层继续强制记忆路径写入 guard。',
    purpose: '每日记忆轮询与记忆维护 hook',
    config: baseConfig({
      context: { systemInstructions: '', modules: [] },
      memory: { scope: 'maintenance' },
      limits: { maxTurns: 30 },
      capabilities: {
        shell: false,
        backgroundTasks: false,
        interaction: false,
        subagents: false,
        scheduling: false,
      },
      tools: { allowlist: MEMORY_TOOLS, denylist: [] },
    }),
  },
  {
    profileId: 'arp_system_subagent_explore',
    profileKey: 'subagent_explore',
    name: '子 Agent · Explore',
    description: '只读代码与资料侦察；代码层不可放宽写入、Shell、交互、嵌套和排程限制。',
    purpose: '只读子 Agent',
    config: baseConfig({
      memory: { scope: 'search_only' },
      limits: { maxTurns: SUBAGENT_MAX_TURNS },
      capabilities: {
        shell: false,
        backgroundTasks: false,
        interaction: false,
        subagents: false,
        scheduling: false,
      },
      tools: { allowlist: EXPLORE_TOOLS, denylist: [] },
    }),
  },
  {
    profileId: 'arp_system_subagent_general',
    profileKey: 'subagent_general',
    name: '子 Agent · General',
    description: '通用子 Agent；代码层不可放宽嵌套、交互和排程限制。',
    purpose: '通用前台子 Agent',
    config: baseConfig({
      limits: { maxTurns: SUBAGENT_MAX_TURNS },
      capabilities: {
        shell: true,
        backgroundTasks: false,
        interaction: false,
        subagents: false,
        scheduling: false,
      },
      tools: {
        allowlist: null,
        denylist: [
          'Agent',
          'AskUserQuestion',
          'BackgroundTaskCancel',
          'BackgroundTaskList',
          'BackgroundTaskStatus',
          'BashOutput',
          'CronList',
          'CronManage',
          'KillBash',
          'UpdateCompanyInfo',
        ],
      },
    }),
  },
] as const;

export const BUILTIN_AGENT_PROFILE_BINDINGS: Readonly<Record<AgentProfileBindingKey, string>> = {
  main: 'arp_system_default_interactive',
  org_agent: 'arp_system_org_agent',
  memory_poll: 'arp_system_memory_poll',
  subagent_general: 'arp_system_subagent_general',
  subagent_explore: 'arp_system_subagent_explore',
  background_general: 'arp_system_subagent_general',
  background_explore: 'arp_system_subagent_explore',
};

export function builtinProfileVersionId(profileId: string): string {
  return `arpv_builtin_${profileId.slice('arp_system_'.length)}_v1`;
}

export function createBuiltinAgentProfileRecords(now = new Date().toISOString()): {
  profiles: AgentRuntimeProfile[];
  versions: AgentRuntimeProfileVersion[];
  bindings: AgentRuntimeProfileBinding[];
} {
  const versions = BUILTIN_AGENT_PROFILES.map((definition): AgentRuntimeProfileVersion => {
    const config = normalizeAgentRuntimeProfileConfig(definition.config);
    return {
      profileVersionId: builtinProfileVersionId(definition.profileId),
      profileId: definition.profileId,
      versionNumber: 1,
      configSchemaVersion: AGENT_PROFILE_SCHEMA_VERSION,
      config,
      configDigest: digestAgentRuntimeProfileConfig(config),
      publishedBy: 'system',
      publishedAt: now,
    };
  });
  const versionByProfileId = new Map(versions.map((version) => [version.profileId, version]));
  const profiles = BUILTIN_AGENT_PROFILES.map((definition): AgentRuntimeProfile => {
    const version = versionByProfileId.get(definition.profileId)!;
    return {
      profileId: definition.profileId,
      profileKey: definition.profileKey,
      name: definition.name,
      description: definition.description,
      purpose: definition.purpose,
      status: 'published',
      systemProfile: true,
      draftConfig: version.config,
      draftDigest: version.configDigest,
      revision: 1,
      latestVersion: version,
      createdBy: 'system',
      createdAt: now,
      updatedBy: 'system',
      updatedAt: now,
    };
  });
  const bindings = Object.entries(BUILTIN_AGENT_PROFILE_BINDINGS).map(([bindingKey, profileId]) => ({
    bindingKey: bindingKey as AgentProfileBindingKey,
    profileId,
    updatedBy: 'system',
    updatedAt: now,
  }));
  return { profiles, versions, bindings };
}

export function getBuiltinProfileByBinding(bindingKey: AgentProfileBindingKey): {
  profile: AgentRuntimeProfile;
  version: AgentRuntimeProfileVersion;
} {
  const records = createBuiltinAgentProfileRecords('2026-07-22T00:00:00.000Z');
  const profileId = BUILTIN_AGENT_PROFILE_BINDINGS[bindingKey];
  const profile = records.profiles.find((item) => item.profileId === profileId)!;
  const version = records.versions.find((item) => item.profileId === profileId)!;
  return { profile, version };
}

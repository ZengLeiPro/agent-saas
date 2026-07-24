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

const MEMORY_TOOLS_V1 = [
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

const MEMORY_TOOLS = [
  'Edit',
  'MemoryList',
  'MemorySearch',
  'Read',
  'Shell',
  'UserActivityList',
  'WaitForWorkspaceReady',
  'Write',
];

const EXPLORE_TOOLS_V1 = [
  'Glob',
  'Grep',
  'MemorySearch',
  'Read',
  'WaitForWorkspaceReady',
  'WebFetch',
  'WebSearch',
];

const EXPLORE_TOOLS = [
  'MemorySearch',
  'Read',
  'Shell',
  'WaitForWorkspaceReady',
  'WebFetch',
  'WebSearch',
];

const SHELL_FIRST_PROFILE_PUBLISHED_AT = '2026-07-24T17:04:00.000Z';

function memoryPollConfig(tools: string[], shell: boolean, allowedTargets: AgentRuntimeProfileConfig['execution']['allowedTargets']): AgentRuntimeProfileConfig {
  return baseConfig({
    context: { systemInstructions: '', modules: [] },
    memory: { scope: 'maintenance' },
    limits: { maxTurns: 30 },
    capabilities: {
      shell,
      backgroundTasks: false,
      interaction: false,
      subagents: false,
      scheduling: false,
    },
    tools: { allowlist: tools, denylist: [] },
    execution: { allowedTargets },
  });
}

function exploreConfig(tools: string[], shell: boolean): AgentRuntimeProfileConfig {
  return baseConfig({
    memory: { scope: 'search_only' },
    limits: { maxTurns: SUBAGENT_MAX_TURNS },
    capabilities: {
      shell,
      backgroundTasks: false,
      interaction: false,
      subagents: false,
      scheduling: false,
    },
    tools: { allowlist: tools, denylist: [] },
  });
}

export interface BuiltinAgentProfileDefinition {
  profileId: string;
  profileKey: string;
  name: string;
  description: string;
  purpose: string;
  versionNumber?: number;
  previousVersions?: readonly {
    versionNumber: number;
    config: AgentRuntimeProfileConfig;
    publishedAt?: string;
  }[];
  publishedAt?: string;
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
    description: '记忆维护专用预设；Write/Edit 继续强制记忆路径 guard，Shell 固定在隔离运行时执行。',
    purpose: '每日记忆轮询与记忆维护 hook',
    versionNumber: 2,
    previousVersions: [{
      versionNumber: 1,
      config: memoryPollConfig(MEMORY_TOOLS_V1, false, null),
    }],
    publishedAt: SHELL_FIRST_PROFILE_PUBLISHED_AT,
    config: memoryPollConfig(MEMORY_TOOLS, true, ['server-remote']),
  },
  {
    profileId: 'arp_system_subagent_explore',
    profileKey: 'subagent_explore',
    name: '子 Agent · Explore',
    description: '搜索与定位专用子 Agent；Shell 可用，但仍禁用交互、嵌套、排程与后台任务。',
    purpose: '搜索定位子 Agent',
    versionNumber: 2,
    previousVersions: [{
      versionNumber: 1,
      config: exploreConfig(EXPLORE_TOOLS_V1, false),
    }],
    publishedAt: SHELL_FIRST_PROFILE_PUBLISHED_AT,
    config: exploreConfig(EXPLORE_TOOLS, true),
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

export function builtinProfileVersionId(profileId: string, versionNumber = 1): string {
  return `arpv_builtin_${profileId.slice('arp_system_'.length)}_v${versionNumber}`;
}

export function createBuiltinAgentProfileRecords(now = new Date().toISOString()): {
  profiles: AgentRuntimeProfile[];
  versions: AgentRuntimeProfileVersion[];
  bindings: AgentRuntimeProfileBinding[];
} {
  const versions = BUILTIN_AGENT_PROFILES.flatMap((definition): AgentRuntimeProfileVersion[] => [
    ...(definition.previousVersions ?? []),
    { versionNumber: definition.versionNumber ?? 1, config: definition.config, publishedAt: definition.publishedAt },
  ].map((source) => {
    const config = normalizeAgentRuntimeProfileConfig(source.config);
    return {
      profileVersionId: builtinProfileVersionId(definition.profileId, source.versionNumber),
      profileId: definition.profileId,
      versionNumber: source.versionNumber,
      configSchemaVersion: AGENT_PROFILE_SCHEMA_VERSION,
      config,
      configDigest: digestAgentRuntimeProfileConfig(config),
      publishedBy: 'system',
      publishedAt: source.publishedAt ?? now,
    };
  }));
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
  const version = records.versions.find((item) => item.profileVersionId === profile.latestVersion?.profileVersionId)!;
  return { profile, version };
}

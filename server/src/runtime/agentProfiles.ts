import type {
  AuthorizedToolCall,
  ExecutionTargetKind,
  ToolCallContext,
  ToolDescriptor,
  ToolResult,
  ToolRuntime,
} from '../agent/toolRuntime.js';
import { parseMcpToolKey } from '../mcp/clientManager.js';
import {
  getBuiltinProfileByBinding,
} from '../data/agentProfiles/builtins.js';
import {
  AgentRuntimeProfileError,
  digestAgentRuntimeProfileConfig,
  type AgentProfileBindingKey,
  type AgentProfileSessionBinding,
  type AgentRuntimeProfile,
  type AgentRuntimeProfileConfig,
  type AgentRuntimeProfileStore,
  type AgentRuntimeProfileVersion,
  type ResolvedAgentRuntimeProfile,
} from '../data/agentProfiles/types.js';
import type { RuntimeSessionRecord } from './sessionCatalog.js';

export type AgentProfileScene = AgentProfileBindingKey;

export interface BoundAgentRuntimeProfile {
  binding: AgentProfileSessionBinding;
  profile: AgentRuntimeProfile;
  version: AgentRuntimeProfileVersion;
}

/**
 * Runtime resolver owns the "new session may read latest / existing session may not"
 * boundary. It intentionally has no mutable current-version cache: a pinned session
 * resolves only by immutable version id; a new session resolves the binding once.
 */
export class AgentRuntimeProfileResolver {
  readonly activatedAtMs = Date.now();

  constructor(readonly store: AgentRuntimeProfileStore) {}

  async resolveForSession(args: {
    existingSession: RuntimeSessionRecord | null | undefined;
    bindingKey: AgentProfileBindingKey;
  }): Promise<BoundAgentRuntimeProfile> {
    const pinned = args.existingSession?.profileVersionId;
    if (pinned) return this.resolvePinned(args.existingSession!, args.bindingKey);

    // Web enqueue creates SessionMeta before central dispatch. Records created before
    // this process activated are historical and bind the immutable compatibility v1,
    // never the administrator's current latest version.
    const createdAtMs = args.existingSession?.createdAt
      ? Date.parse(args.existingSession.createdAt)
      : Number.NaN;
    const historicalUnbound = !!args.existingSession
      && Number.isFinite(createdAtMs)
      && createdAtMs < this.activatedAtMs;
    if (historicalUnbound) {
      const builtin = getBuiltinProfileByBinding(args.bindingKey);
      return this.toBound({
        bindingKey: args.bindingKey,
        profile: builtin.profile,
        version: builtin.version,
        source: 'builtin',
      }, 'compatibility');
    }

    const resolved = await this.store.resolveBinding(args.bindingKey);
    if (!resolved) {
      const builtin = getBuiltinProfileByBinding(args.bindingKey);
      return this.toBound({
        bindingKey: args.bindingKey,
        profile: builtin.profile,
        version: builtin.version,
        source: 'builtin',
      }, 'builtin');
    }
    return this.toBound(resolved, resolved.source);
  }

  bindSessionRecord(
    session: RuntimeSessionRecord,
    bound: BoundAgentRuntimeProfile,
  ): RuntimeSessionRecord {
    return {
      ...session,
      ...bound.binding,
    };
  }

  private async resolvePinned(
    session: RuntimeSessionRecord,
    expectedBindingKey: AgentProfileBindingKey,
  ): Promise<BoundAgentRuntimeProfile> {
    if (session.profileBindingKey && session.profileBindingKey !== expectedBindingKey) {
      throw new AgentRuntimeProfileError(
        `会话 Profile 场景不一致：已绑定 ${session.profileBindingKey}，当前入口为 ${expectedBindingKey}`,
        'CONFLICT',
      );
    }
    const builtin = getBuiltinProfileByBinding(expectedBindingKey);
    let profile: AgentRuntimeProfile | null = null;
    let version: AgentRuntimeProfileVersion | null = null;
    let source: 'database' | 'builtin' = 'database';
    if (session.profileVersionId === builtin.version.profileVersionId) {
      profile = builtin.profile;
      version = builtin.version;
      source = 'builtin';
    } else {
      version = await this.store.getVersion(session.profileVersionId!);
      if (version) profile = await this.store.getProfile(version.profileId);
    }
    if (!profile || !version) {
      throw new AgentRuntimeProfileError(
        `会话绑定的 Profile 版本不存在：${session.profileVersionId}`,
        'NOT_FOUND',
      );
    }
    if ((session.profileId && session.profileId !== version.profileId)
      || (session.profileKey && session.profileKey !== profile.profileKey)
      || (session.profileVersionNumber && session.profileVersionNumber !== version.versionNumber)) {
      throw new AgentRuntimeProfileError('会话 Profile 身份字段与不可变版本不一致', 'CONFLICT');
    }
    const digest = digestAgentRuntimeProfileConfig(version.config);
    if (digest !== version.configDigest || session.profileConfigDigest !== version.configDigest) {
      throw new AgentRuntimeProfileError('会话 Profile 摘要校验失败，已拒绝切换到其他版本', 'CONFLICT');
    }
    return this.toBound({ expected: expectedBindingKey, bindingKey: expectedBindingKey, profile, version, source }, session.profileResolution ?? source);
  }

  private toBound(
    resolved: ResolvedAgentRuntimeProfile & { expected?: AgentProfileBindingKey },
    resolution: AgentProfileSessionBinding['profileResolution'],
  ): BoundAgentRuntimeProfile {
    return {
      profile: resolved.profile,
      version: resolved.version,
      binding: {
        profileId: resolved.profile.profileId,
        profileKey: resolved.profile.profileKey,
        profileVersionId: resolved.version.profileVersionId,
        profileVersionNumber: resolved.version.versionNumber,
        profileConfigDigest: resolved.version.configDigest,
        profileBindingKey: resolved.bindingKey,
        profileResolution: resolution,
      },
    };
  }
}

export function profileRunMetadata(bound: BoundAgentRuntimeProfile): Record<string, unknown> {
  return {
    profile: {
      profileId: bound.binding.profileId,
      profileKey: bound.binding.profileKey,
      profileVersionId: bound.binding.profileVersionId,
      versionNumber: bound.binding.profileVersionNumber,
      configDigest: bound.binding.profileConfigDigest,
      bindingKey: bound.binding.profileBindingKey,
      resolution: bound.binding.profileResolution,
      shellEnabledByProfile: bound.version.config.capabilities.shell,
    },
  };
}

export function resolveAgentProfileBindingKey(args: {
  toolProfile?: 'memory_poll';
  orgAgentId?: string;
}): AgentProfileBindingKey {
  if (args.toolProfile === 'memory_poll') return 'memory_poll';
  if (args.orgAgentId) return 'org_agent';
  return 'main';
}

export function resolveAgentProfileMaxTurns(
  profile: AgentRuntimeProfileConfig,
  currentMaxTurns: number | undefined,
): number | undefined {
  const limit = profile.limits.maxTurns ?? undefined;
  if (limit === undefined) return currentMaxTurns;
  return currentMaxTurns === undefined ? limit : Math.min(currentMaxTurns, limit);
}

export function assertAgentProfileExecutionTarget(
  config: AgentRuntimeProfileConfig,
  target: ExecutionTargetKind,
): void {
  if (config.execution.allowedTargets && !config.execution.allowedTargets.includes(target)) {
    throw new AgentRuntimeProfileError(`Profile 不允许执行环境 ${target}`, 'INVALID_CONFIG');
  }
}

const GENERAL_HARD_DENY = new Set([
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
]);

const EXPLORE_HARD_ALLOW = new Set([
  'Read',
  'Shell',
  'WebSearch',
  'WebFetch',
  'MemorySearch',
  'WaitForWorkspaceReady',
]);

export function applyAgentRuntimeProfile(
  runtime: ToolRuntime,
  bound: BoundAgentRuntimeProfile,
): ToolRuntime {
  return new AgentProfileFilteredToolRuntime(runtime, bound);
}

class AgentProfileFilteredToolRuntime implements ToolRuntime {
  constructor(
    private readonly inner: ToolRuntime,
    private readonly bound: BoundAgentRuntimeProfile,
  ) {}

  list(context?: ToolCallContext): ToolDescriptor[] {
    return this.inner.list(context).filter((descriptor) => this.isAllowed(descriptor));
  }

  async invoke<TInput>(call: AuthorizedToolCall<TInput>, context: ToolCallContext): Promise<ToolResult> {
    const descriptor = this.inner.list(context).find(
      (candidate) => candidate.id === call.toolId || candidate.name === call.toolId,
    );
    if (!descriptor || !this.isAllowed(descriptor)) {
      throw new Error(`工具 ${call.toolId} 不在 Agent Profile ${this.bound.binding.profileKey} 的有效工具集内`);
    }
    if (descriptor.id === 'Shell' || descriptor.name === 'Shell') {
      const input = call.input as { mode?: string } | undefined;
      if (input?.mode === 'background' && !this.bound.version.config.capabilities.backgroundTasks) {
        throw new Error('当前 Agent Profile 不允许后台 Shell 任务');
      }
    }
    return this.inner.invoke(call, context);
  }

  private isAllowed(descriptor: ToolDescriptor): boolean {
    const config = this.bound.version.config;
    const names = new Set([descriptor.id, descriptor.name]);
    const matches = (set: ReadonlySet<string>) => [...names].some((name) => set.has(name));

    // Scene constraints are non-removable code policy. Profile may only narrow them.
    const scene = this.bound.binding.profileBindingKey;
    if (scene === 'subagent_explore' || scene === 'background_explore') {
      if (!matches(EXPLORE_HARD_ALLOW)) return false;
    }
    if (scene === 'subagent_general' || scene === 'background_general') {
      if (matches(GENERAL_HARD_DENY)) return false;
    }

    if (!config.capabilities.shell && matches(new Set(['Shell', 'BashOutput', 'KillBash']))) return false;
    if (!config.capabilities.backgroundTasks && matches(new Set([
      'BackgroundTaskCancel', 'BackgroundTaskList', 'BackgroundTaskStatus', 'BashOutput', 'KillBash',
    ]))) return false;
    if (!config.capabilities.interaction && matches(new Set(['AskUserQuestion']))) return false;
    if (!config.capabilities.subagents && matches(new Set(['Agent']))) return false;
    if (!config.capabilities.scheduling && matches(new Set(['CronList', 'CronManage']))) return false;

    if (config.memory.scope === 'none' && matches(new Set(['MemorySearch', 'MemoryList']))) return false;
    if (config.memory.scope === 'search_only' && matches(new Set(['MemoryList']))) return false;

    if (config.tools.allowlist && ![...names].some((name) => config.tools.allowlist!.includes(name))) return false;
    if ([...names].some((name) => config.tools.denylist.includes(name))) return false;

    const mcp = parseMcpToolKey(descriptor.id) ?? parseMcpToolKey(descriptor.name);
    if (mcp) {
      if (config.mcp.serverAllowlist && !config.mcp.serverAllowlist.includes(mcp.serverName)) return false;
      if (config.mcp.toolAllowlist && !config.mcp.toolAllowlist.includes(mcp.toolName)
        && !config.mcp.toolAllowlist.includes(descriptor.id)) return false;
      if (config.mcp.denyServers.includes(mcp.serverName)) return false;
      if (config.mcp.denyTools.includes(mcp.toolName) || config.mcp.denyTools.includes(descriptor.id)) return false;
    }
    return true;
  }
}

export function filterAgentProfileSkills<T extends { id: string; name: string }>(
  skills: readonly T[],
  config: AgentRuntimeProfileConfig,
): T[] {
  const allowed = config.skills.allowlist ? new Set(config.skills.allowlist) : null;
  const denied = new Set(config.skills.denylist);
  const priority = new Map(config.skills.defaultSkillIds.map((id, index) => [id, index]));
  return skills
    .filter((skill) => (
      (!allowed || allowed.has(skill.id) || allowed.has(skill.name))
      && !denied.has(skill.id)
      && !denied.has(skill.name)
    ))
    .map((skill, index) => ({ skill, index }))
    .sort((left, right) => {
      const leftPriority = priority.get(left.skill.id) ?? priority.get(left.skill.name) ?? Number.MAX_SAFE_INTEGER;
      const rightPriority = priority.get(right.skill.id) ?? priority.get(right.skill.name) ?? Number.MAX_SAFE_INTEGER;
      return leftPriority - rightPriority || left.index - right.index;
    })
    .map(({ skill }) => skill);
}

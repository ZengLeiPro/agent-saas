/**
 * WP3 Phase A：`runtime.apps.*` 与 `tools.allowlist` 对 `app__` 工具的判定
 * （规范 §6.1「专职 Agent」段；锚点地图 A4/A5）。
 *
 * 两条必须钉死的事实：
 * 1. `apps.*` 的 allow/deny 与 `mcp.*` 同构，名单里写规范化后的分段或完整工具名；
 * 2. `tools.allowlist` 非空时会**静默滤掉**未列名的 `app__*` —— 这是最容易踩的坑，
 *    组织管理员改了工具白名单就会莫名其妙丢掉整套定制系统能力。
 */
import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { toolName as buildAppToolName } from '@kaiyan/ky-app-contract';

import type {
  AuthorizedToolCall,
  ToolDescriptor,
  ToolResult,
  ToolRuntime,
} from '../agent/toolRuntime.js';
import {
  digestAgentRuntimeProfileConfig,
  type AgentRuntimeProfileConfig,
} from '../data/agentProfiles/types.js';
import { getBuiltinProfileByBinding } from '../data/agentProfiles/builtins.js';
import { DEFAULT_ORG_AGENT_RUNTIME_POLICY } from '../data/orgAgents/runtimePolicy.js';
import { mergeOrgAgentRuntimePolicy } from '../data/orgAgents/runtimePolicy.js';
import { applyAgentRuntimeProfile } from './agentProfiles.js';

const ERP_SEARCH = buildAppToolName('demo-erp', 'order.search');
const ERP_CREATE = buildAppToolName('demo-erp', 'order.create');
const CRM_SEARCH = buildAppToolName('demo-crm', 'lead.search');

function appDescriptor(name: string): ToolDescriptor {
  return {
    id: name,
    name,
    displayName: name,
    description: '外部定制系统能力',
    schema: z.object({}).passthrough(),
    risk: 'safe',
    approvalMode: 'web',
    auditCategory: `app.${name}`,
  };
}

class StaticToolRuntime implements ToolRuntime {
  constructor(private readonly descriptors: ToolDescriptor[]) {}
  list(): ToolDescriptor[] {
    return this.descriptors;
  }
  async invoke<TInput>(call: AuthorizedToolCall<TInput>): Promise<ToolResult> {
    return { content: `${call.toolId}:ok` };
  }
}

function boundWith(config: AgentRuntimeProfileConfig) {
  const main = getBuiltinProfileByBinding('main');
  return {
    profile: main.profile,
    version: { ...main.version, config },
    binding: {
      profileId: main.profile.profileId,
      profileKey: main.profile.profileKey,
      profileVersionId: main.version.profileVersionId,
      profileVersionNumber: 1,
      profileConfigDigest: digestAgentRuntimeProfileConfig(config),
      profileBindingKey: 'main' as const,
      profileResolution: 'builtin' as const,
    },
  };
}

function visibleTools(config: AgentRuntimeProfileConfig): string[] {
  const inner = new StaticToolRuntime([ERP_SEARCH, ERP_CREATE, CRM_SEARCH].map(appDescriptor));
  return applyAgentRuntimeProfile(inner, boundWith(config))
    .list()
    .map((tool) => tool.name);
}

function baseConfig(): AgentRuntimeProfileConfig {
  return structuredClone(getBuiltinProfileByBinding('main').version.config);
}

describe('runtime.apps.* 对 app__ 工具的过滤', () => {
  it('缺省（apps 未设置）不限制任何定制系统能力', () => {
    expect(visibleTools(baseConfig())).toEqual([ERP_SEARCH, ERP_CREATE, CRM_SEARCH]);
  });

  it('systemAllowlist 只放行列名系统（写规范化后的分段）', () => {
    const config = baseConfig();
    config.apps = {
      systemAllowlist: ['demo_erp'],
      capabilityAllowlist: null,
      denySystems: [],
      denyCapabilities: [],
    };
    expect(visibleTools(config)).toEqual([ERP_SEARCH, ERP_CREATE]);
  });

  it('capabilityAllowlist 接受能力分段，也接受完整工具名', () => {
    const bySegment = baseConfig();
    bySegment.apps = {
      systemAllowlist: null,
      capabilityAllowlist: ['order_search'],
      denySystems: [],
      denyCapabilities: [],
    };
    expect(visibleTools(bySegment)).toEqual([ERP_SEARCH]);

    const byToolName = baseConfig();
    byToolName.apps = {
      systemAllowlist: null,
      capabilityAllowlist: [CRM_SEARCH],
      denySystems: [],
      denyCapabilities: [],
    };
    expect(visibleTools(byToolName)).toEqual([CRM_SEARCH]);
  });

  it('denySystems / denyCapabilities 优先于允许列表', () => {
    const config = baseConfig();
    config.apps = {
      systemAllowlist: null,
      capabilityAllowlist: [ERP_SEARCH, ERP_CREATE, CRM_SEARCH],
      denySystems: ['demo_crm'],
      denyCapabilities: ['order_create'],
    };
    expect(visibleTools(config)).toEqual([ERP_SEARCH]);
  });

  it('apps 名单不影响非 app__ 工具', () => {
    const config = baseConfig();
    config.apps = {
      systemAllowlist: ['demo_erp'],
      capabilityAllowlist: null,
      denySystems: [],
      denyCapabilities: [],
    };
    const inner = new StaticToolRuntime([
      appDescriptor(CRM_SEARCH),
      {
        ...appDescriptor('mcp__github__search_code'),
        id: 'mcp__github__search_code',
        name: 'mcp__github__search_code',
      },
    ]);
    const names = applyAgentRuntimeProfile(inner, boundWith(config))
      .list()
      .map((tool) => tool.name);
    expect(names).toEqual(['mcp__github__search_code']);
  });

  it('tools.allowlist 非空时静默滤掉所有未列名的 app__ 工具', () => {
    const config = baseConfig();
    // WaitForWorkspaceReady 是 schema 的交叉校验要求，与本用例无关但必须带上。
    config.tools.allowlist = ['WaitForWorkspaceReady', ERP_SEARCH];
    expect(visibleTools(config)).toEqual([ERP_SEARCH]);

    const noneListed = baseConfig();
    noneListed.tools.allowlist = ['WaitForWorkspaceReady', 'Read'];
    expect(visibleTools(noneListed)).toEqual([]);
  });
});

describe('组织 Profile ∩ Agent policy 的 apps 合并', () => {
  it('双方都不限制时合并结果不含 apps 键（内建 Profile 的 config digest 不变）', () => {
    const shared = baseConfig();
    const merged = mergeOrgAgentRuntimePolicy(shared, DEFAULT_ORG_AGENT_RUNTIME_POLICY);
    expect(merged.apps).toBeUndefined();
    expect(digestAgentRuntimeProfileConfig(merged)).toBe(digestAgentRuntimeProfileConfig(shared));
  });

  it('允许列表取交集、拒绝列表取并集', () => {
    const shared = baseConfig();
    shared.apps = {
      systemAllowlist: ['demo_erp', 'demo_crm'],
      capabilityAllowlist: null,
      denySystems: [],
      denyCapabilities: ['order_create'],
    };
    const merged = mergeOrgAgentRuntimePolicy(shared, {
      ...DEFAULT_ORG_AGENT_RUNTIME_POLICY,
      apps: {
        systemAllowlist: ['demo_erp'],
        capabilityAllowlist: null,
        denySystems: ['demo_wms'],
        denyCapabilities: [],
      },
    });
    expect(merged.apps).toEqual({
      systemAllowlist: ['demo_erp'],
      capabilityAllowlist: null,
      denySystems: ['demo_wms'],
      denyCapabilities: ['order_create'],
    });
  });
});

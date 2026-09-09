import { describe, expect, it } from 'vitest';

import { makeAccount, makeGroupBinding } from '../__tests__/agentDwsAccountsRoutes.fixtures.js';
import { deriveGroupDwsReadiness } from './agentDwsReadiness.js';

const tools = new Set([
  'Agent',
  'BackgroundTask',
  'DwsBusiness',
  'ContextSearch',
  'ContextGet',
  'WebSearch',
  'WebFetch',
  'Read',
  'Glob',
  'Grep',
  'Artifact',
]);

function readyInput() {
  return {
    tenantId: 'tenant-a',
    account: makeAccount({
      status: 'active',
      runtimeStatus: 'ready',
      runtimeLeaseActive: true,
      profileId: 'corp-a:ding-a',
      corpId: 'corp-a',
      dingtalkUserId: 'ding-a',
    }),
    binding: makeGroupBinding({
      effectiveConfig: {
        ...makeGroupBinding().effectiveConfig,
        capabilities: { skillIds: ['skill-ready'], toolNames: [], dwsResourceIds: [] },
      },
    }),
    agent: {
      id: 'oa-sales',
      tenantId: 'tenant-a',
      enabled: true,
      allowedSkills: ['skill-ready'] as string[],
      allowedKnowledge: [] as string[],
      runtime: { executionMode: 'dispatcher' },
    },
    runtimeV2Ready: true as boolean | undefined,
    contextCeiling: {
      available: true,
      publishedSourceIds: [] as string[],
      channelSourceIds: [] as string[],
    },
    channelToolNames: tools,
  };
}

describe('Agent DWS readiness', () => {
  it('全部权威依赖满足时返回组合 ready', () => {
    const readiness = deriveGroupDwsReadiness(readyInput());
    expect(readiness.status).toBe('ready');
    expect(readiness.checks.every((item) => item.severity === 'ready')).toBe(true);
  });

  it('skill、source 和空能力分别判定，不把 source 当 skill', () => {
    const empty = readyInput();
    empty.binding.effectiveConfig.capabilities.skillIds = [];
    expect(
      deriveGroupDwsReadiness(empty).checks.find((item) => item.code === 'worker.capability')
        ?.severity,
    ).toBe('blocking');

    const sourceAsSkill = readyInput();
    sourceAsSkill.binding.effectiveConfig.capabilities.skillIds = ['source-only'];
    sourceAsSkill.contextCeiling.publishedSourceIds = ['source-only'];
    sourceAsSkill.contextCeiling.channelSourceIds = ['source-only'];
    expect(
      deriveGroupDwsReadiness(sourceAsSkill).checks.find(
        (item) => item.code === 'worker.capability',
      )?.severity,
    ).toBe('blocking');
  });

  it.each(['ContextSearch', 'ContextGet'])('Context 仅配置 %s 时 worker 未就绪', (toolName) => {
    const input = readyInput();
    input.binding.effectiveConfig.knowledge = { contextEnabled: true, sourceIds: ['source-a'] };
    input.binding.effectiveConfig.capabilities = {
      skillIds: [],
      toolNames: [toolName],
      dwsResourceIds: [],
    };
    input.contextCeiling.publishedSourceIds = ['source-a'];
    input.contextCeiling.channelSourceIds = ['source-a'];
    expect(
      deriveGroupDwsReadiness(input).checks.find((item) => item.code === 'worker.capability')
        ?.severity,
    ).toBe('blocking');
  });

  it('binding 的 Agent 或 identity generation 不匹配账号时 fail closed', () => {
    const wrongAgent = readyInput();
    wrongAgent.binding.agentId = 'other-agent';
    expect(
      deriveGroupDwsReadiness(wrongAgent).checks.find((item) => item.code === 'binding.active')
        ?.severity,
    ).toBe('blocking');

    const staleIdentity = readyInput();
    staleIdentity.binding.accountIdentity = {
      ...staleIdentity.binding.accountIdentity!,
      identityUpdatedAt: '2026-01-01T00:00:00.000Z',
    };
    expect(
      deriveGroupDwsReadiness(staleIdentity).checks.find((item) => item.code === 'binding.active')
        ?.severity,
    ).toBe('blocking');
  });

  it.each([
    [
      'account.authorization',
      (input: ReturnType<typeof readyInput>) => {
        input.account.profileId = 'forged-profile';
      },
    ],
    [
      'stream.ready',
      (input: ReturnType<typeof readyInput>) => {
        input.account.runtimeStatus = 'starting';
      },
    ],
    [
      'stream.lease',
      (input: ReturnType<typeof readyInput>) => {
        input.account.runtimeLeaseActive = false;
      },
    ],
    [
      'agent.enabled',
      (input: ReturnType<typeof readyInput>) => {
        input.agent.enabled = false;
      },
    ],
    [
      'agent.dispatcher',
      (input: ReturnType<typeof readyInput>) => {
        input.agent.runtime.executionMode = 'direct';
      },
    ],
    [
      'runtime.v2',
      (input: ReturnType<typeof readyInput>) => {
        input.runtimeV2Ready = false;
      },
    ],
    [
      'binding.active',
      (input: ReturnType<typeof readyInput>) => {
        input.binding.activationState = 'shadow';
      },
    ],
    [
      'binding.live_deny',
      (input: ReturnType<typeof readyInput>) => {
        input.binding.policy.liveDeny = true;
      },
    ],
    [
      'context.dependencies',
      (input: ReturnType<typeof readyInput>) => {
        input.binding.effectiveConfig.knowledge = { contextEnabled: true, sourceIds: ['source-a'] };
      },
    ],
    [
      'worker.capability',
      (input: ReturnType<typeof readyInput>) => {
        input.binding.effectiveConfig.capabilities.skillIds = ['unpublished-skill'];
      },
    ],
    [
      'completion.delivery',
      (input: ReturnType<typeof readyInput>) => {
        input.binding.policy.completion = 'silent';
      },
    ],
  ])('单因子异常只需稳定定位 %s', (code, mutate) => {
    const input = readyInput();
    mutate(input);
    const readiness = deriveGroupDwsReadiness(input);
    expect(readiness.status).toBe('blocked');
    expect(readiness.checks.find((item) => item.code === code)?.severity).toBe('blocking');
  });

  it('缺少租约、runtime 或 Context 权威证据时为 unknown 且不泄漏身份', () => {
    const input = readyInput();
    input.account.runtimeLeaseActive = undefined;
    input.runtimeV2Ready = undefined;
    input.binding.effectiveConfig.knowledge = {
      contextEnabled: true,
      sourceIds: ['secret-source'],
    };
    input.binding.effectiveConfig.capabilities.toolNames = ['ContextSearch', 'ContextGet'];
    input.contextCeiling.available = false;
    const serialized = JSON.stringify(deriveGroupDwsReadiness(input));
    expect(serialized).toContain('"status":"unknown"');
    expect(serialized).not.toContain('secret-source');
    expect(serialized).not.toContain('corp-a');
    expect(serialized).not.toContain('ding-a');
  });

  it('串租户 Agent 只返回通用 blocker 文案', () => {
    const input = readyInput();
    input.agent.tenantId = 'tenant-secret';
    const serialized = JSON.stringify(deriveGroupDwsReadiness(input));
    expect(serialized).toContain('不属于当前组织');
    expect(serialized).not.toContain('tenant-secret');
  });
});

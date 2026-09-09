import { parseOrgAgentRuntimePolicy } from '../../data/orgAgents/runtimePolicy.js';
import type { OrgAgentEffectiveExecutionContext } from './orgAgentExecutionContext.js';

export const orgAgentChannelFixture = {
  bindingId: 'binding-1',
  accountId: 'account-1',
  agentId: 'agent-1',
  conversationSpaceId: 'space-1',
  workConversationId: 'wc-1',
  policyRevision: 3,
  agentPrincipal: {
    kind: 'org_agent' as const,
    tenantId: 'tenant-1',
    agentId: 'agent-1',
    accountId: 'account-1',
    workspaceId: 'ws_tenant-1__agent_agent-1',
  },
  externalActorAssurance: 'mapped' as const,
  allowedToolNames: ['Agent'],
  allowedSkillIds: [],
  allowedSourceIds: [],
  dwsResourceIds: [],
  sharedContext: { instructions: '', memories: [] },
  contextEnabled: false,
  taskVisibility: 'conversation' as const,
  actorRole: 'member' as const,
  triggerRoles: [],
  approvalRoles: [],
  externalActor: {
    kind: 'external_user' as const,
    provider: 'dingtalk' as const,
    corpId: 'corp-1',
    openId: 'caller-1',
    assurance: 'mapped' as const,
    mappedUserId: 'user-1',
    role: 'member' as const,
  },
  channelPrincipal: {
    provider: 'dingtalk' as const,
    accountId: 'account-1',
    conversationId: 'group-1',
    kind: 'group' as const,
  },
};

export function liveOrgAgentBindingFixture() {
  return {
    bindingId: 'binding-1',
    tenantId: 'tenant-1',
    accountId: 'account-1',
    agentId: 'agent-1',
    workspaceId: 'ws_tenant-1__agent_agent-1',
    revision: 3,
    enabled: true,
    activationState: 'active',
    policy: { enabled: true, liveDeny: false },
    effectiveConfig: {
      identity: {},
      instructions: { system: '' },
      knowledge: { contextEnabled: false, sourceIds: [] },
      capabilities: { skillIds: [], toolNames: [], dwsResourceIds: [] },
      memory: { readAgent: true, readConversation: true, adminWriteConversation: true },
      access: { triggerRoles: [], approvalRoles: [] },
      speech: { proactive: false, requireMention: true },
    },
  };
}

export function durableOrgAgentAttemptFixture(overrides: Record<string, unknown> = {}) {
  const timestamp = new Date().toISOString();
  return {
    attemptId: 'attempt-1',
    runtimeRunId: 'run-1',
    attemptNo: 1,
    status: 'failed',
    publishState: 'rejected',
    checkpoint: { runtimeRunId: 'run-1', status: 'failed', finishedAt: timestamp },
    resultEnvelope: {
      status: 'failed',
      summary: '上一轮已定位异常行',
      facts: [{ key: 'checkedRows', value: '120' }],
      artifacts: [],
      writeScope: ['/old-task'],
    },
    ...overrides,
  };
}

export function orgAgentExecutionContextFixture(
  overrides: Partial<OrgAgentEffectiveExecutionContext> = {},
): OrgAgentEffectiveExecutionContext {
  return {
    version: 1,
    revisions: { binding: 3, agentUpdatedAt: '2026-09-08T00:00:00.000Z' },
    agent: {
      id: 'agent-1',
      name: '员工',
      instructions: '员工指令',
      runtime: parseOrgAgentRuntimePolicy({ schemaVersion: 1 }),
    },
    channel: {
      bindingId: 'binding-1',
      workConversationId: 'wc-1',
      instructions: '群指令',
      systemContext: '群上下文',
      memories: [],
    },
    capabilities: {
      toolNames: ['Agent'],
      skillIds: [],
      sourceIds: ['source-a'],
      dwsResourceIds: [],
      contextEnabled: true,
    },
    model: { modelRef: 'models/model' },
    task: { goal: '执行', acceptance: ['完成'] },
    ...overrides,
  };
}

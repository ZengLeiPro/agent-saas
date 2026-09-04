import { describe, expect, it } from 'vitest';

import type { OrgAgentEffectiveConfig } from '../data/orgGroupAgents/index.js';
import {
  groupDwsCapabilityError,
  groupWorkspaceUpdateSchema,
  mergeGroupWorkspaceEffectiveConfig,
} from './agentDwsGroupWorkspaceSchemas.js';

describe('群工作台配置合并与校验', () => {
  it('旧客户端省略新增字段时保留当前配置', () => {
    const current = {
      identity: {},
      instructions: { system: '仅处理已审批供应商' },
      knowledge: { contextEnabled: false, sourceIds: [] },
      capabilities: {
        skillIds: [],
        toolNames: ['DwsBusiness'],
        dwsResourceIds: ['doc:doc-a'],
      },
      memory: { readAgent: false, readConversation: false, adminWriteConversation: false },
      access: { triggerRoles: [], approvalRoles: [] },
      speech: { proactive: false, requireMention: true },
    } as OrgAgentEffectiveConfig;
    const parsed = groupWorkspaceUpdateSchema.parse({
      conversationId: 'group-a',
      expectedRevision: 1,
      enabled: false,
      policy: {
        enabled: true,
        membership: 'members',
        guest: 'deny',
        taskVisibility: 'conversation',
        completion: 'reply_to_work_conversation',
        liveDeny: false,
      },
      effectiveConfig: {
        identity: {},
        knowledge: { contextEnabled: false, sourceIds: [] },
        capabilities: { skillIds: [], toolNames: ['DwsBusiness'] },
        access: { triggerRoles: [], approvalRoles: [] },
        speech: { proactive: false, requireMention: true },
      },
    });

    expect(mergeGroupWorkspaceEffectiveConfig(current, parsed.effectiveConfig)).toMatchObject({
      instructions: current.instructions,
      capabilities: { dwsResourceIds: ['doc:doc-a'] },
      memory: current.memory,
    });
  });

  it('前置 schema 与激活校验都只接受 doc:<nodeId>', () => {
    const parsed = groupWorkspaceUpdateSchema.safeParse({
      conversationId: 'group-a', expectedRevision: 1, enabled: true,
      policy: {
        enabled: true, membership: 'members', guest: 'deny', taskVisibility: 'conversation',
        completion: 'reply_to_work_conversation', liveDeny: false,
      },
      effectiveConfig: {
        identity: {}, instructions: { system: '' },
        knowledge: { contextEnabled: false, sourceIds: [] },
        capabilities: {
          skillIds: [], toolNames: ['DwsBusiness'], dwsResourceIds: ['drive:folder-a'],
        },
        memory: { readAgent: true, readConversation: true, adminWriteConversation: true },
        access: { triggerRoles: [], approvalRoles: ['org_admin'] },
        speech: { proactive: false, requireMention: true },
      },
    });
    expect(parsed.success).toBe(false);
    const invalid = {
      identity: {}, instructions: { system: '' },
      knowledge: { contextEnabled: false, sourceIds: [] },
      capabilities: {
        skillIds: [], toolNames: ['DwsBusiness'], dwsResourceIds: ['wiki:space-a'],
      },
      memory: { readAgent: true, readConversation: true, adminWriteConversation: true },
      access: { triggerRoles: [], approvalRoles: ['org_admin'] },
      speech: { proactive: false, requireMention: true },
    } as OrgAgentEffectiveConfig;
    expect(groupDwsCapabilityError(invalid, true)).toBe(
      '共享群 DWS 资源目前仅支持 doc:<nodeId>',
    );
  });

  it('旧配置缺少 DWS 资源时仍允许紧急停用或 live deny', () => {
    const legacy = {
      identity: {},
      instructions: { system: '' },
      knowledge: { contextEnabled: false, sourceIds: [] },
      capabilities: { skillIds: [], toolNames: ['DwsBusiness'], dwsResourceIds: [] },
      memory: { readAgent: true, readConversation: true, adminWriteConversation: true },
      access: { triggerRoles: [], approvalRoles: [] },
      speech: { proactive: false, requireMention: true },
    } as OrgAgentEffectiveConfig;
    expect(groupDwsCapabilityError(legacy, false)).toBeUndefined();
    expect(groupDwsCapabilityError(legacy, true)).toBe(
      '启用群聊 DwsBusiness 必须显式配置可访问的 DWS 资源',
    );
    const withResource = {
      ...legacy,
      capabilities: { ...legacy.capabilities, dwsResourceIds: ['doc:doc-a'] },
    };
    expect(groupDwsCapabilityError(withResource, true)).toBe(
      '启用 DwsBusiness 时必须允许组织管理员审批',
    );
  });
});

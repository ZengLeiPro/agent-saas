import { describe, expect, it } from 'vitest';

import type { AgentDwsAccountRecord } from '../data/agentDwsAccounts/index.js';
import type { AgentDwsInboxRecord } from '../data/agentDwsMessages/index.js';
import type { SharedGroupContext } from './orgAgentSharedGroupContext.js';
import { buildSystemContext } from './personalMessageRouter.js';

describe('buildSystemContext', () => {
  it('把绑定版本中的管理员指令注入组织群会话', () => {
    const context = buildSystemContext(
      { displayName: '采购助理' } as AgentDwsAccountRecord,
      { eventType: 'user_im_message_receive_at', payload: {} } as AgentDwsInboxRecord,
      {
        binding: {
          conversationSpaceId: 'space-a',
          effectiveConfig: {
            identity: { displayName: '采购助理' },
            instructions: { system: '只处理已审批供应商。' },
          },
        },
        workConversation: { workConversationId: 'wc-a' },
        externalActor: { kind: 'external_user', assurance: 'mapped' },
        requester: null,
        visibleWorkOrders: [],
        memories: [],
      } as unknown as SharedGroupContext,
    );

    expect(context).toContain('当前群管理员指令：只处理已审批供应商。');
    expect(context).toContain('当前工作空间：space-a；当前话题：wc-a。');
  });

  it('完整保留已接受的 20000 字符群指令及其段落结构', () => {
    const instructions = `第一条：只处理已审批供应商。\n\n- 保留列表结构\n${'规'.repeat(19_950)}`;
    expect(instructions.length).toBeLessThanOrEqual(20_000);
    const context = buildSystemContext(
      { displayName: '采购助理' } as AgentDwsAccountRecord,
      { eventType: 'user_im_message_receive_at', payload: {} } as AgentDwsInboxRecord,
      {
        binding: {
          conversationSpaceId: 'space-a',
          effectiveConfig: {
            identity: { displayName: '采购助理' },
            instructions: { system: instructions },
          },
        },
        workConversation: { workConversationId: 'wc-a' },
        externalActor: { kind: 'external_user', assurance: 'mapped' },
        requester: null,
        visibleWorkOrders: [],
        memories: [],
      } as unknown as SharedGroupContext,
    );

    expect(context).toContain(`当前群管理员指令：${instructions}`);
    expect(context).toContain('\n\n- 保留列表结构\n');
    expect(context).not.toContain('超出部分未注入');
  });

  it('对历史超限指令显式提示截断而不是静默丢弃', () => {
    const context = buildSystemContext(
      { displayName: '采购助理' } as AgentDwsAccountRecord,
      { eventType: 'user_im_message_receive_at', payload: {} } as AgentDwsInboxRecord,
      {
        binding: {
          conversationSpaceId: 'space-a',
          effectiveConfig: {
            identity: { displayName: '采购助理' },
            instructions: { system: '规'.repeat(20_100) },
          },
        },
        workConversation: { workConversationId: 'wc-a' },
        externalActor: { kind: 'external_user', assurance: 'mapped' },
        requester: null,
        visibleWorkOrders: [],
        memories: [],
      } as unknown as SharedGroupContext,
    );

    expect(context).toContain('超出部分未注入');
    expect(context).not.toContain('规'.repeat(20_001));
  });

  it('历史超限指令不会在 Unicode 代理对中间截断', () => {
    const context = buildSystemContext(
      { displayName: '采购助理' } as AgentDwsAccountRecord,
      { eventType: 'user_im_message_receive_at', payload: {} } as AgentDwsInboxRecord,
      {
        binding: {
          conversationSpaceId: 'space-a',
          effectiveConfig: {
            identity: { displayName: '采购助理' },
            instructions: { system: `a${'😀'.repeat(11_000)}` },
          },
        },
        workConversation: { workConversationId: 'wc-a' },
        externalActor: { kind: 'external_user', assurance: 'mapped' },
        requester: null,
        visibleWorkOrders: [],
        memories: [],
      } as unknown as SharedGroupContext,
    );
    const markerIndex = context.indexOf('\n[管理员指令超出当前');
    expect(markerIndex).toBeGreaterThan(0);
    const beforeMarker = context.slice(0, markerIndex);
    const lastCodeUnit = beforeMarker.charCodeAt(beforeMarker.length - 1);
    const previousCodeUnit = beforeMarker.charCodeAt(beforeMarker.length - 2);
    expect(lastCodeUnit >= 0xdc00 && lastCodeUnit <= 0xdfff).toBe(true);
    expect(previousCodeUnit >= 0xd800 && previousCodeUnit <= 0xdbff).toBe(true);
  });
});

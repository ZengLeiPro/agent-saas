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
});

import { describe, expect, it, vi } from 'vitest';

import type {
  OrgAgentChannelBinding,
  OrgAgentWorkConversation,
  OrgGroupAgentStore,
} from '../data/orgGroupAgents/index.js';
import { loadConfiguredMemories } from './orgAgentSharedGroupContext.js';

const conversation = { workConversationId: 'wc-a' } as OrgAgentWorkConversation;

function binding(readAgent: boolean, readConversation: boolean): OrgAgentChannelBinding {
  return {
    tenantId: 'tenant-a',
    agentId: 'agent-a',
    bindingId: 'binding-a',
    effectiveConfig: { memory: { readAgent, readConversation } },
  } as OrgAgentChannelBinding;
}

describe('loadConfiguredMemories', () => {
  it('两个读取开关均关闭时不查询记忆', async () => {
    const listMemories = vi.fn();
    await expect(
      loadConfiguredMemories(
        { listMemories } as unknown as Pick<OrgGroupAgentStore, 'listMemories'>,
        binding(false, false),
        conversation,
      ),
    ).resolves.toEqual([]);
    expect(listMemories).not.toHaveBeenCalled();
  });

  it('只读取 effective config 明确开放的记忆范围', async () => {
    const listMemories = vi.fn().mockResolvedValue([{ memoryId: 'memory-a' }]);
    const result = await loadConfiguredMemories(
      { listMemories } as unknown as Pick<OrgGroupAgentStore, 'listMemories'>,
      binding(false, true),
      conversation,
    );
    expect(result).toHaveLength(1);
    expect(listMemories).toHaveBeenCalledOnce();
    expect(listMemories).toHaveBeenCalledWith(
      expect.objectContaining({
        memoryScope: 'conversation',
        bindingId: 'binding-a',
        workConversationId: 'wc-a',
      }),
    );
  });
});

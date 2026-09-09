import { describe, expect, it, vi } from 'vitest';
import type { ToolCallContext } from '../../agent/toolRuntime.js';
import {
  BusinessSystemsCatalogToolProvider,
  BUSINESS_SYSTEMS_LIST_TOOL_ID,
} from './toolProvider.js';

const context: ToolCallContext = {
  channelContext: {
    channel: 'web',
    user: { id: 'user-1', username: 'demo', role: 'user', tenantId: 'tenant-1' },
  },
  workspace: { root: '/tmp/workspace', executionTarget: 'server-local' },
};

describe('BusinessSystemsCatalogToolProvider', () => {
  it('只从可信上下文读取身份并返回未就绪系统', async () => {
    const listForUser = vi
      .fn()
      .mockResolvedValue([{ name: '演示 ERP', canUseAgent: false, message: 'Agent 能力待完成' }]);
    const provider = new BusinessSystemsCatalogToolProvider({ listForUser });
    expect(provider.list(context).map((item) => item.id)).toEqual([BUSINESS_SYSTEMS_LIST_TOOL_ID]);
    const result = await provider.invoke(
      {
        toolId: BUSINESS_SYSTEMS_LIST_TOOL_ID,
        input: {},
        authorization: { approved: true, source: 'policy_auto' },
      },
      context,
    );
    expect(listForUser).toHaveBeenCalledWith('tenant-1', 'user-1');
    expect(result?.content).toContain('演示 ERP');
    expect(result?.content).toContain('canUseAgent');
  });

  it('Schema 不接受模型传入 tenantId 或 userId', async () => {
    const provider = new BusinessSystemsCatalogToolProvider({ listForUser: vi.fn() });
    await expect(
      provider.invoke(
        {
          toolId: BUSINESS_SYSTEMS_LIST_TOOL_ID,
          input: { tenantId: 'other' },
          authorization: { approved: true, source: 'policy_auto' },
        },
        context,
      ),
    ).rejects.toThrow();
  });
});

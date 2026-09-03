import { describe, expect, it, vi } from 'vitest';

import { AgentToolProvider } from '../runtime/subagent/agentToolProvider.js';
import type { SubagentOutcome } from '../runtime/subagent/subagentRunner.js';

describe('AgentToolProvider finalization ordering', () => {
  it('结果后处理完成后才写 subagent_finished，避免 finished 与 tool_result 之间留下故障窗口', async () => {
    const order: string[] = [];
    const outcome: SubagentOutcome = {
      status: 'completed',
      text: '完成',
      totalTokens: 10,
      toolUseCount: 1,
      turnCount: 1,
      durationMs: 20,
      childSessionId: 'child-session',
      childRunId: 'child-run',
      model: 'test-model',
    };
    const provider = new AgentToolProvider({
      config: {} as never,
      executionTransportRegistry: {} as never,
      tenantHandResolver: {} as never,
      parentProviders: [],
      runSubagentImpl: async (params) => {
        await params.onChildRunCreated?.({
          childSessionId: outcome.childSessionId,
          childRunId: outcome.childRunId,
          model: outcome.model,
        });
        return outcome;
      },
    });
    const internals = provider as unknown as {
      resolveParentEventStore: () => Promise<unknown>;
      appendParentEvent: (_binding: unknown, event: { type: string }) => Promise<void>;
      formatOutcome: () => Promise<string>;
    };
    internals.resolveParentEventStore = vi.fn(async () => ({}));
    internals.appendParentEvent = vi.fn(async (_binding, event) => {
      order.push(event.type);
    });
    internals.formatOutcome = vi.fn(async () => {
      order.push('format_outcome');
      return '完成';
    });

    const result = await provider.invoke(
      {
        toolId: 'Agent',
        input: { description: '验证终态', prompt: '执行验证' },
        authorization: { approved: true, source: 'policy_auto' },
      },
      {
        runId: 'parent-run',
        sessionId: 'parent-session',
        toolCallId: 'agent-call',
        workspace: { root: '/tmp', sessionId: 'parent-session', tenantId: 'tenant' },
        channelContext: {},
      } as never,
    );

    expect(result).toEqual({ content: '完成' });
    expect(order).toEqual(['subagent_started', 'format_outcome', 'subagent_finished']);
  });
});

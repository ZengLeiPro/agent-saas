import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';

import type {
  AuthorizedToolCall,
  ToolCallContext,
  ToolDescriptor,
  ToolResult,
  ToolRuntime,
} from '../agent/toolRuntime.js';
import { applyOrgAgentExecutionMode } from '../runtime/dispatcherMode.js';

function descriptor(name: string): ToolDescriptor {
  return {
    id: name,
    name,
    displayName: name,
    description: name,
    schema: z.object({ mode: z.string().optional() }),
    risk: 'safe',
    approvalMode: 'never',
    auditCategory: 'test',
  };
}

const context = {
  channelContext: { channel: 'dingtalk' },
  workspace: { root: '/workspace', executionTarget: 'server-remote' },
} as ToolCallContext;

describe('dispatcher runtime tool boundary', () => {
  it('direct 模式完全保持原工具面', () => {
    const runtime = fakeRuntime(['Agent', 'Read', 'Shell']);
    expect(applyOrgAgentExecutionMode(runtime, 'direct').list(context).map(tool => tool.name))
      .toEqual(['Agent', 'Read', 'Shell']);
  });

  it('dispatcher 只暴露调度工具并在 invoke 再次拒绝执行工具与 foreground Agent', async () => {
    const runtime = fakeRuntime([
      'Agent', 'BackgroundTask', 'AskUserQuestion', 'TodoWrite', 'SessionContext',
      'Read', 'Write', 'Edit', 'Shell', 'WebSearch', 'Skill', 'CronManage', 'DwsTool',
    ]);
    const dispatcher = applyOrgAgentExecutionMode(runtime, 'dispatcher');
    expect(dispatcher.list(context).map(tool => tool.name)).toEqual([
      'Agent', 'BackgroundTask', 'AskUserQuestion', 'TodoWrite', 'SessionContext',
    ]);

    await expect(dispatcher.invoke(call('Read', {}), context))
      .rejects.toThrow(/前台调度器不允许/);
    await expect(dispatcher.invoke(call('Agent', { mode: 'foreground' }), context))
      .rejects.toThrow(/background Worker/);
    await expect(dispatcher.invoke(call('Agent', { mode: 'background' }), context))
      .resolves.toEqual({ content: 'ok' });

    const completion = applyOrgAgentExecutionMode(runtime, 'dispatcher', true);
    expect(completion.list(context).map(tool => tool.name)).toEqual([
      'AskUserQuestion', 'TodoWrite', 'SessionContext',
    ]);
    await expect(completion.invoke(call('Agent', { mode: 'background' }), context))
      .rejects.toThrow(/前台调度器不允许/);
  });
});

function call(toolId: string, input: unknown): AuthorizedToolCall<unknown> {
  return { toolId, input, authorization: { approved: true, source: 'policy_auto' } };
}

function fakeRuntime(names: string[]): ToolRuntime {
  const invoke = vi.fn(async (): Promise<ToolResult> => ({ content: 'ok' }));
  return {
    list: () => names.map(descriptor),
    invoke,
  };
}

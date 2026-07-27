import { describe, expect, it } from 'vitest';
import {
  buildContextBreakdownSnapshot,
  calibrateContextBreakdown,
  estimateContextTokens,
} from '../runtime/contextBreakdown.js';
import { z } from 'zod';
import type { ToolDescriptor } from '../agent/toolRuntime.js';

function descriptor(overrides: Partial<ToolDescriptor> = {}): ToolDescriptor {
  return {
    id: 'Read',
    name: 'Read',
    displayName: 'Read',
    description: '读取文件',
    schema: z.object({ path: z.string() }),
    category: 'workspace',
    risk: 'safe',
    approvalMode: 'never',
    auditCategory: 'test',
    ...overrides,
  };
}

describe('contextBreakdown', () => {
  it('按系统 section、历史角色、记忆、当前消息和工具定义构成快照', () => {
    const descriptors = new Map<string, ToolDescriptor>([
      ['Read', descriptor()],
      ['mcp.search', descriptor({
        id: 'mcp.search',
        name: 'mcp.search',
        displayName: 'Notion Search',
        category: undefined,
        mcp: { serverName: 'notion', serverDisplayName: 'Notion' },
      })],
    ]);
    const snapshot = buildContextBreakdownSnapshot({
      instructionSections: [
        { key: 'platform', name: '平台规则', content: '必须遵守规则' },
        { key: 'persona', name: '人格', content: '简洁回答' },
      ],
      instructions: 'fallback',
      memoryContext: '用户喜欢简洁回答',
      historyMessages: [
        { role: 'user', content: '之前的问题' },
        { role: 'assistant', content: '之前的回答', reasoning_content: '思考过程' },
        { role: 'tool', tool_call_id: 'call-1', content: '工具结果' },
      ],
      currentUserContent: [
        { type: 'text', text: '当前问题' },
        {
          type: 'image_attachment',
          attachmentId: 'att-1',
          displayName: '图片.png',
          relativePath: 'uploads/图片.png',
          mimeType: 'image/png',
          sizeBytes: 3,
          detail: 'high',
        },
      ],
      attachmentCount: 1,
      tools: [
        { id: 'Read', name: 'Read', description: '读取文件', parameters: { type: 'object' } },
        {
          id: 'mcp.search',
          name: 'mcp.search',
          description: '搜索 Notion',
          parameters: { type: 'object' },
          mcpServer: {
            serverName: 'notion',
            namespace: 'notion',
            displayName: 'Notion',
            description: 'Notion MCP',
          },
        },
      ],
      descriptorsByName: descriptors,
    });

    expect(snapshot.breakdown.categories.map((item) => item.key)).toEqual(expect.arrayContaining([
      'system_prompt',
      'memory',
      'history',
      'current_user',
      'attachments',
      'tool_definitions',
    ]));
    expect(snapshot.breakdown.categories.find((item) => item.key === 'system_prompt')?.children).toHaveLength(2);
    expect(snapshot.breakdown.categories.find((item) => item.key === 'history')?.children?.map((item) => item.key)).toEqual(expect.arrayContaining([
      'history_user',
      'history_assistant',
      'history_reasoning',
      'history_tool_results',
    ]));
    expect(snapshot.memoryFiles).toEqual([{ path: 'MEMORY.md', type: '长期记忆', tokens: expect.any(Number) }]);
    expect(snapshot.mcpTools).toEqual([
      expect.objectContaining({ name: 'mcp.search', serverName: 'notion', isLoaded: true }),
    ]);
    expect(snapshot.breakdown.estimatedTokens).toBeGreaterThan(estimateContextTokens('fallback'));
  });

  it('用 provider 当前上下文总量生成未归因差额，不缩放估算分类', () => {
    const base = {
      method: 'utf8_bytes_v1' as const,
      estimatedTokens: 100,
      unattributedTokens: 0,
      categories: [{
        key: 'system_prompt',
        name: '系统提示语',
        tokens: 100,
        color: '#000',
        accuracy: 'estimated' as const,
      }],
    };

    const calibrated = calibrateContextBreakdown(base, { inputTokens: 140, outputTokens: 10 }, 160);
    expect(calibrated.providerInputTokens).toBe(140);
    expect(calibrated.providerContextTokens).toBe(160);
    expect(calibrated.unattributedTokens).toBe(50);
    expect(calibrated.categories).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: 'current_assistant_output',
        tokens: 10,
        accuracy: 'provider',
      }),
      expect.objectContaining({
        key: 'unattributed',
        tokens: 50,
        accuracy: 'derived',
      }),
    ]));
  });
});

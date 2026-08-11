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

    expect(snapshot.breakdown.categories.map((item) => item.key)).toEqual([
      'system_prompt',
      'tool_definitions',
      'memory',
      'history',
      'current_user',
      'attachments',
    ]);
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

  it('纯文本消息不虚增附件与视觉输入 token', () => {
    const snapshot = buildContextBreakdownSnapshot({
      instructions: '系统规则',
      historyMessages: [{ role: 'user', content: [{ type: 'text', text: '历史问题' }] }],
      currentUserContent: [{ type: 'text', text: '当前问题' }],
      tools: [],
      descriptorsByName: new Map(),
    });

    expect(snapshot.breakdown.categories.find((item) => item.key === 'attachments')).toBeUndefined();
    expect(snapshot.breakdown.categories.find((item) => item.key === 'history')?.children
      ?.find((item) => item.key === 'history_attachments')).toBeUndefined();
  });

  it('按估算占比将分项校准到 provider 当前上下文总量', () => {
    const base = {
      method: 'utf8_bytes_v1' as const,
      estimatedTokens: 100,
      unattributedTokens: 0,
      categories: [
        {
          key: 'system_prompt',
          name: '系统提示语',
          tokens: 60,
          color: '#000',
          accuracy: 'estimated' as const,
          children: [
            { key: 'system:a', name: '规则 A', tokens: 30, color: '#000', accuracy: 'estimated' as const },
            { key: 'system:b', name: '规则 B', tokens: 30, color: '#000', accuracy: 'estimated' as const },
          ],
        },
        {
          key: 'memory',
          name: '长期记忆',
          tokens: 20,
          color: '#000',
          accuracy: 'estimated' as const,
        },
        {
          key: 'tool_definitions',
          name: '工具定义',
          tokens: 20,
          color: '#000',
          accuracy: 'estimated' as const,
          children: [{
            key: 'tool_definitions_mcp',
            name: 'MCP 工具',
            tokens: 20,
            color: '#000',
            accuracy: 'estimated' as const,
            children: [
              { key: 'tool:a', name: '工具 A', tokens: 5, color: '#000', accuracy: 'estimated' as const },
              { key: 'tool:b', name: '工具 B', tokens: 15, color: '#000', accuracy: 'estimated' as const },
            ],
          }],
        },
      ],
      memoryFiles: [{ path: 'MEMORY.md', type: '长期记忆', tokens: 20 }],
      mcpTools: [
        { name: '工具 A', serverName: '测试', tokens: 5 },
        { name: '工具 B', serverName: '测试', tokens: 15 },
      ],
    };

    const calibrated = calibrateContextBreakdown(base, { inputTokens: 140, outputTokens: 10 }, 150);
    expect(calibrated.providerInputTokens).toBe(140);
    expect(calibrated.providerContextTokens).toBe(150);
    expect(calibrated.unattributedTokens).toBe(0);
    expect(calibrated.categories.map((item) => [item.key, item.tokens])).toEqual([
      ['system_prompt', 84],
      ['memory', 28],
      ['tool_definitions', 28],
      ['current_assistant_output', 10],
    ]);
    expect(calibrated.categories[0].children?.map((item) => item.tokens)).toEqual([42, 42]);
    expect(calibrated.memoryFiles?.map((item) => item.tokens)).toEqual([28]);
    expect(calibrated.mcpTools?.map((item) => item.tokens)).toEqual([7, 21]);
    expect(calibrated.categories.reduce((sum, item) => sum + item.tokens, 0)).toBe(150);
  });

  it('没有估算分项时将真实输入保留为未归因差额', () => {
    const calibrated = calibrateContextBreakdown({
      method: 'utf8_bytes_v1',
      estimatedTokens: 0,
      unattributedTokens: 0,
      categories: [],
    }, { inputTokens: 40, outputTokens: 5 }, 45);

    expect(calibrated.unattributedTokens).toBe(40);
    expect(calibrated.categories.map((item) => [item.key, item.tokens])).toEqual([
      ['current_assistant_output', 5],
      ['unattributed', 40],
    ]);
  });
});

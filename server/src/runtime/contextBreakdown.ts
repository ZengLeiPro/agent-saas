import type { ToolDescriptor } from '../agent/toolRuntime.js';
import type {
  ContextUsageBreakdown,
  ContextUsageCategory,
} from '../types/index.js';
import type {
  InstructionSection,
  ModelChatMessage,
  ModelToolDefinition,
  ModelUsage,
  ModelUserContent,
} from './types.js';

const BYTES_PER_ESTIMATED_TOKEN = 3;
const COLORS = {
  system: '#8B5CF6',
  memory: '#10B981',
  user: '#3B82F6',
  assistant: '#06B6D4',
  reasoning: '#F59E0B',
  toolCall: '#EC4899',
  toolResult: '#EF4444',
  current: '#2563EB',
  attachment: '#14B8A6',
  tools: '#6366F1',
  unattributed: '#94A3B8',
} as const;

export interface ContextBreakdownSnapshot {
  breakdown: ContextUsageBreakdown;
  memoryFiles: Array<{ path: string; type: string; tokens: number }>;
  mcpTools: Array<{ name: string; serverName: string; tokens: number; isLoaded?: boolean }>;
}

export function estimateContextTokens(value: unknown): number {
  if (value === undefined || value === null || value === '') return 0;
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  return Math.max(1, Math.ceil(Buffer.byteLength(serialized, 'utf8') / BYTES_PER_ESTIMATED_TOKEN));
}

function category(
  key: string,
  name: string,
  tokens: number,
  color: string,
  children?: ContextUsageCategory[],
): ContextUsageCategory {
  return {
    key,
    name,
    tokens,
    color,
    accuracy: 'estimated',
    ...(children?.length ? { children } : {}),
  };
}

function contentTokens(content: ModelUserContent): number {
  if (Array.isArray(content) && content.length === 0) return 0;
  return estimateContextTokens(content);
}

function buildHistoryCategories(messages: ModelChatMessage[]): ContextUsageCategory[] {
  let userTokens = 0;
  let attachmentTokens = 0;
  let assistantTokens = 0;
  let reasoningTokens = 0;
  let toolCallTokens = 0;
  let toolResultTokens = 0;

  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'user') {
      if (Array.isArray(message.content)) {
        userTokens += contentTokens(message.content.filter((part) => part.type === 'text'));
        attachmentTokens += contentTokens(message.content.filter((part) => part.type !== 'text'));
      } else {
        userTokens += contentTokens(message.content);
      }
      continue;
    }
    if (message.role === 'tool') {
      toolResultTokens += estimateContextTokens(message);
      continue;
    }
    if (message.role === 'additional_tools') {
      toolCallTokens += estimateContextTokens(message.tools);
      continue;
    }
    assistantTokens += estimateContextTokens(message.content);
    reasoningTokens += estimateContextTokens(message.reasoning_content);
    toolCallTokens += estimateContextTokens(message.tool_calls);
  }

  return [
    category('history_user', '历史用户消息', userTokens, COLORS.user),
    category('history_attachments', '历史附件与视觉输入', attachmentTokens, COLORS.attachment),
    category('history_assistant', '历史助手回复', assistantTokens, COLORS.assistant),
    category('history_reasoning', '历史思考内容', reasoningTokens, COLORS.reasoning),
    category('history_tool_calls', '历史工具调用', toolCallTokens, COLORS.toolCall),
    category('history_tool_results', '历史工具结果', toolResultTokens, COLORS.toolResult),
  ].filter((item) => item.tokens > 0);
}

function buildToolCategories(
  tools: ModelToolDefinition[],
  descriptorsByName: Map<string, ToolDescriptor>,
): { category?: ContextUsageCategory; mcpTools: ContextBreakdownSnapshot['mcpTools'] } {
  const builtInChildren: ContextUsageCategory[] = [];
  const mcpChildren: ContextUsageCategory[] = [];
  const mcpTools: ContextBreakdownSnapshot['mcpTools'] = [];

  for (const tool of tools) {
    const descriptor = descriptorsByName.get(tool.id) ?? descriptorsByName.get(tool.name);
    const tokens = estimateContextTokens({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      ...(tool.deferLoading ? { defer_loading: true } : {}),
    });
    const isMcp = !!tool.mcpServer || !!descriptor?.mcp;
    const child = category(
      `tool:${tool.id}`,
      tool.name,
      tokens,
      isMcp ? COLORS.toolCall : COLORS.tools,
    );
    if (tool.deferLoading) child.isDeferred = true;

    if (isMcp) {
      mcpChildren.push(child);
      mcpTools.push({
        name: tool.name,
        serverName: tool.mcpServer?.serverName ?? descriptor?.mcp?.serverName ?? 'MCP',
        tokens,
        isLoaded: !tool.deferLoading,
      });
    } else {
      builtInChildren.push(child);
    }
  }

  const children: ContextUsageCategory[] = [];
  if (builtInChildren.length) {
    children.push(category(
      'tool_definitions_builtin',
      '内置工具',
      builtInChildren.reduce((sum, item) => sum + item.tokens, 0),
      COLORS.tools,
      builtInChildren,
    ));
  }
  if (mcpChildren.length) {
    children.push(category(
      'tool_definitions_mcp',
      'MCP 工具',
      mcpChildren.reduce((sum, item) => sum + item.tokens, 0),
      COLORS.toolCall,
      mcpChildren,
    ));
  }

  const tokens = children.reduce((sum, item) => sum + item.tokens, 0);
  return {
    ...(tokens > 0 ? {
      category: category('tool_definitions', '工具定义', tokens, COLORS.tools, children),
    } : {}),
    mcpTools,
  };
}

export function buildContextBreakdownSnapshot(params: {
  instructionSections?: InstructionSection[];
  instructions: string;
  memoryContext?: string;
  historyMessages: ModelChatMessage[];
  currentUserContent: ModelUserContent;
  attachmentCount?: number;
  tools: ModelToolDefinition[];
  descriptorsByName: Map<string, ToolDescriptor>;
}): ContextBreakdownSnapshot {
  const systemChildren = (params.instructionSections?.length
    ? params.instructionSections
    : [{ key: 'system_prompt', name: '系统提示语', content: params.instructions }])
    .map((section) => category(
      `system:${section.key}`,
      section.name,
      estimateContextTokens(section.content),
      COLORS.system,
    ))
    .filter((item) => item.tokens > 0);
  const systemTokens = systemChildren.reduce((sum, item) => sum + item.tokens, 0);

  const memoryTokens = estimateContextTokens(params.memoryContext);
  const historyChildren = buildHistoryCategories(params.historyMessages);
  const historyTokens = historyChildren.reduce((sum, item) => sum + item.tokens, 0);
  const currentTextContent = Array.isArray(params.currentUserContent)
    ? params.currentUserContent.filter((part) => part.type === 'text')
    : params.currentUserContent;
  const currentAttachmentContent = Array.isArray(params.currentUserContent)
    ? params.currentUserContent.filter((part) => part.type !== 'text')
    : [];
  const currentTokens = contentTokens(currentTextContent);
  const attachmentTokens = contentTokens(currentAttachmentContent)
    + (params.attachmentCount ? estimateContextTokens({ attachmentCount: params.attachmentCount }) : 0);
  const toolData = buildToolCategories(params.tools, params.descriptorsByName);

  const categories: ContextUsageCategory[] = [
    category('system_prompt', '系统提示语', systemTokens, COLORS.system, systemChildren),
    ...(toolData.category ? [toolData.category] : []),
    category('memory', '长期记忆', memoryTokens, COLORS.memory),
    category('history', '历史消息', historyTokens, COLORS.assistant, historyChildren),
    category('current_user', '当前用户消息', currentTokens, COLORS.current),
    category('attachments', '附件与视觉输入', attachmentTokens, COLORS.attachment),
  ].filter((item) => item.tokens > 0);

  const memoryFiles = memoryTokens > 0
    ? [{ path: 'MEMORY.md', type: '长期记忆', tokens: memoryTokens }]
    : [];
  return {
    breakdown: {
      method: 'utf8_bytes_v1',
      estimatedTokens: categories.reduce((sum, item) => sum + item.tokens, 0),
      unattributedTokens: 0,
      categories,
      memoryFiles,
      mcpTools: toolData.mcpTools,
      capturedAt: new Date().toISOString(),
    },
    memoryFiles,
    mcpTools: toolData.mcpTools,
  };
}

function allocateProportionalTokens(weights: number[], targetTotal: number): number[] {
  const normalizedWeights = weights.map((weight) => Math.max(0, Math.floor(weight)));
  const weightTotal = normalizedWeights.reduce((sum, weight) => sum + weight, 0);
  const target = Math.max(0, Math.floor(targetTotal));
  if (weightTotal === 0 || target === 0) return normalizedWeights.map(() => 0);

  const exactValues = normalizedWeights.map((weight) => (weight / weightTotal) * target);
  const allocated = exactValues.map((value) => Math.floor(value));
  const remainder = target - allocated.reduce((sum, value) => sum + value, 0);
  const remainderOrder = exactValues
    .map((value, index) => ({ index, fraction: value - allocated[index] }))
    .sort((left, right) => right.fraction - left.fraction || left.index - right.index);
  for (let index = 0; index < remainder; index++) {
    allocated[remainderOrder[index].index] += 1;
  }
  return allocated;
}

function calibrateCategories(
  categories: ContextUsageCategory[],
  targetTotal: number,
): ContextUsageCategory[] {
  const allocated = allocateProportionalTokens(
    categories.map((item) => item.tokens),
    targetTotal,
  );
  return categories.map((item, index) => ({
    ...item,
    tokens: allocated[index],
    ...(item.children?.length
      ? { children: calibrateCategories(item.children, allocated[index]) }
      : {}),
  }));
}

function calibrateTokenItems<T extends { tokens: number }>(items: T[], targetTotal: number): T[] {
  const allocated = allocateProportionalTokens(items.map((item) => item.tokens), targetTotal);
  return items.map((item, index) => ({ ...item, tokens: allocated[index] }));
}

export function calibrateContextBreakdown(
  breakdown: ContextUsageBreakdown,
  usage: ModelUsage | undefined,
  currentContextTokens?: number,
): ContextUsageBreakdown {
  const providerInputTokens = usage?.inputTokens;
  if (typeof providerInputTokens !== 'number' || !Number.isFinite(providerInputTokens)) {
    return breakdown;
  }
  const providerUncachedInputTokens = Math.max(0, providerInputTokens - (usage?.cacheReadInputTokens ?? 0));
  const providerContextTokens = Math.max(0, Math.floor(typeof currentContextTokens === 'number'
    ? currentContextTokens
    : providerUncachedInputTokens
      + (usage?.cacheReadInputTokens ?? 0)
      + (usage?.cacheCreationInputTokens ?? 0)
      + (usage?.outputTokens ?? 0)));
  const outputTokens = Math.max(0, Math.floor(usage?.outputTokens ?? 0));
  const providerContextInputTokens = Math.max(0, providerContextTokens - outputTokens);
  const estimatedCategories = breakdown.categories.filter((item) => (
    item.key !== 'current_assistant_output' && item.key !== 'unattributed'
  ));
  const estimatedCategoryTotal = estimatedCategories.reduce((sum, item) => sum + item.tokens, 0);
  const categories = estimatedCategoryTotal > 0
    ? calibrateCategories(estimatedCategories, providerContextInputTokens)
    : [];
  const unattributedTokens = estimatedCategoryTotal > 0 ? 0 : providerContextInputTokens;

  if (outputTokens > 0) {
    categories.push({
      key: 'current_assistant_output',
      name: '本轮 Agent 输出',
      tokens: outputTokens,
      color: COLORS.assistant,
      accuracy: 'provider',
    });
  }
  if (unattributedTokens > 0) {
    categories.push({
      key: 'unattributed',
      name: '协议及未归因开销',
      tokens: unattributedTokens,
      color: COLORS.unattributed,
      accuracy: 'derived',
    });
  }

  const calibratedMemoryTokens = categories.find((item) => item.key === 'memory')?.tokens ?? 0;
  const calibratedMcpTokens = categories
    .find((item) => item.key === 'tool_definitions')
    ?.children?.find((item) => item.key === 'tool_definitions_mcp')?.tokens ?? 0;
  const memoryFiles = calibrateTokenItems(breakdown.memoryFiles ?? [], calibratedMemoryTokens);
  const mcpTools = calibrateTokenItems(breakdown.mcpTools ?? [], calibratedMcpTokens);

  return {
    ...breakdown,
    providerInputTokens,
    providerContextTokens,
    unattributedTokens,
    categories,
    memoryFiles,
    mcpTools,
  };
}

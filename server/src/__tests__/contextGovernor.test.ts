import { afterEach, describe, expect, it } from 'vitest';

import { configureModelPricing } from '../data/usage/pricing.js';
import {
  estimateModelMessageTokens,
  governModelRequestMessages,
} from '../runtime/contextGovernor.js';
import type { ModelChatMessage } from '../runtime/types.js';

describe('context governor', () => {
  afterEach(() => configureModelPricing(undefined));

  it('每轮都限制最新工具结果，不依赖跨 run 投影', () => {
    const messages: ModelChatMessage[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'inspect files' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'Read', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call-1', content: 'X'.repeat(300_000) },
    ];
    const result = governModelRequestMessages(messages, 'unconfigured-model', 1);
    expect(result.forceSynthesis).toBe(false);
    const last = result.messages.at(-1);
    expect(last?.role).toBe('tool');
    expect(last?.role === 'tool' ? last.content.length : Infinity).toBeLessThanOrEqual(16_000);
  });

  it('达到配置阈值时丢弃较早历史并要求收束', () => {
    configureModelPricing({
      groups: [{ models: [{ value: 'small-context-model', context_window: 1_000, auto_compact_threshold: 0.5 }] }],
    });
    const messages: ModelChatMessage[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'old question' },
      { role: 'assistant', content: 'A'.repeat(2_000) },
      { role: 'user', content: 'current task' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call-2', type: 'function', function: { name: 'Read', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call-2', content: 'recent evidence' },
    ];
    expect(estimateModelMessageTokens(messages)).toBeGreaterThan(500);
    const result = governModelRequestMessages(messages, 'small-context-model', 3);
    expect(result.forceSynthesis).toBe(true);
    expect(result.droppedMessages).toBeGreaterThan(0);
    expect(JSON.stringify(result.messages)).not.toContain('old question');
    expect(JSON.stringify(result.messages)).toContain('current task');
    expect(JSON.stringify(result.messages)).toContain('recent evidence');
  });

  it('Responses 远端累计上下文达到阈值时，即使本地增量很小也要求断链收束', () => {
    configureModelPricing({
      groups: [{ models: [{ value: 'relay-model', context_window: 10_000, auto_compact_threshold: 0.8 }] }],
    });
    const messages: ModelChatMessage[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'current task' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'Read', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call-1', content: 'small increment' },
    ];
    const result = governModelRequestMessages(messages, 'relay-model', 1, 8_500);
    expect(result.forceSynthesis).toBe(true);
    expect(result.triggerTokens).toBe(8_500);
  });
});

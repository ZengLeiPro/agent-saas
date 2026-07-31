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

  it('达到配置阈值时丢弃更早历史，但保留当前任务、上一轮结论与最近工具证据', () => {
    configureModelPricing({
      groups: [{ models: [{ value: 'small-context-model', context_window: 1_000, auto_compact_threshold: 0.5 }] }],
    });
    const messages: ModelChatMessage[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'ancient question' },
      { role: 'assistant', content: 'A'.repeat(2_000) },
      { role: 'user', content: 'previous question' },
      { role: 'assistant', content: 'previous conclusion' },
      { role: 'user', content: 'current task' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call-2', type: 'function', function: { name: 'Read', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call-2', content: 'recent evidence' },
    ];
    expect(estimateModelMessageTokens(messages)).toBeGreaterThan(500);
    const result = governModelRequestMessages(messages, 'small-context-model', 5);
    expect(result.forceSynthesis).toBe(true);
    expect(result.droppedMessages).toBeGreaterThan(0);
    expect(JSON.stringify(result.messages)).not.toContain('ancient question');
    expect(JSON.stringify(result.messages)).toContain('previous question');
    expect(JSON.stringify(result.messages)).toContain('previous conclusion');
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

  it('同一 provider 模型名跨组复用时，按 modelRef 隔离 context_window', () => {
    configureModelPricing({
      groups: [
        { id: 'codex', models: [{ id: 'sol-high', value: 'gpt-5.6-sol' }] },
        {
          id: 'kaiyan-llm',
          models: [{
            id: 'sol-high',
            value: 'gpt-5.6-sol',
            context_window: 372_000,
            auto_compact_threshold: 0.8,
          }],
        },
      ],
    });
    const messages: ModelChatMessage[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'current task' },
    ];

    expect(governModelRequestMessages(
      messages,
      'gpt-5.6-sol',
      1,
      303_666,
      'codex/sol-high',
    ).forceSynthesis).toBe(false);
    expect(governModelRequestMessages(
      messages,
      'gpt-5.6-sol',
      1,
      303_666,
      'kaiyan-llm/sol-high',
    ).forceSynthesis).toBe(true);
  });
});

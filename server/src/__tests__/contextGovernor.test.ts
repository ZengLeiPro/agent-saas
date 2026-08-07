import { afterEach, describe, expect, it } from 'vitest';

import { configureModelPricing } from '../data/usage/pricing.js';
import { governModelRequestMessages } from '../runtime/contextGovernor.js';
import type { ModelChatMessage } from '../runtime/types.js';

describe('context governor', () => {
  afterEach(() => configureModelPricing(undefined));

  it('请求前不再重写已经确定的模型可见历史', () => {
    const messages: ModelChatMessage[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'inspect files' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'Read', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call-1', content: 'X'.repeat(300_000) },
    ];
    const result = governModelRequestMessages(messages, 'unconfigured-model', 1);
    expect(result.shouldCompactBeforeRequest).toBe(false);
    expect(result.messages).toBe(messages);
    expect(result.messages).toEqual(messages);
  });

  it('真实上下文达到配置阈值时只要求收束，不丢弃或改写历史', () => {
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
    const result = governModelRequestMessages(messages, 'small-context-model', 5, 600);
    expect(result.shouldCompactBeforeRequest).toBe(true);
    expect(result.triggerTokens).toBe(600);
    expect(result.droppedMessages).toBe(0);
    expect(result.messages).toBe(messages);
    expect(JSON.stringify(result.messages)).toContain('ancient question');
    expect(JSON.stringify(result.messages)).toContain('previous question');
    expect(JSON.stringify(result.messages)).toContain('previous conclusion');
    expect(JSON.stringify(result.messages)).toContain('current task');
    expect(JSON.stringify(result.messages)).toContain('recent evidence');
  });

  it('不做字节估算：本地消息体积巨大但 provider 真实值低于阈值时不触发（回归 737ab4a3）', () => {
    configureModelPricing({
      groups: [{
        id: 'codex',
        models: [{ id: 'sol-high', value: 'gpt-5.6-sol', context_window: 272_000, auto_compact_threshold: 0.8 }],
      }],
    });
    const messages: ModelChatMessage[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'fix the bug' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'Shell', arguments: '{}' } }] },
      // 代码/英文内容 ~5.2 bytes/token：673KB 字节 ≈ 真实 129K tokens。
      // 旧字节估算(÷3)会得出 ~224K > 217,600 提前触发；新口径必须只信真实值。
      { role: 'tool', tool_call_id: 'call-1', content: 'const x = 1;\n'.repeat(50_000) },
    ];
    const result = governModelRequestMessages(messages, 'gpt-5.6-sol', 1, 129_072, 'codex/sol-high');
    expect(result.shouldCompactBeforeRequest).toBe(false);
    expect(result.triggerTokens).toBe(129_072);
    expect(result.thresholdTokens).toBe(217_600);
  });

  it('首轮尚无 provider usage 时不触发', () => {
    configureModelPricing({
      groups: [{ models: [{ value: 'small-context-model', context_window: 1_000, auto_compact_threshold: 0.5 }] }],
    });
    const messages: ModelChatMessage[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'X'.repeat(100_000) },
    ];
    const result = governModelRequestMessages(messages, 'small-context-model', 1, undefined);
    expect(result.shouldCompactBeforeRequest).toBe(false);
    expect(result.triggerTokens).toBe(0);
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
    expect(result.shouldCompactBeforeRequest).toBe(true);
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
    ).shouldCompactBeforeRequest).toBe(false);
    expect(governModelRequestMessages(
      messages,
      'gpt-5.6-sol',
      1,
      303_666,
      'kaiyan-llm/sol-high',
    ).shouldCompactBeforeRequest).toBe(true);
  });
});

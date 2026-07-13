/**
 * LLM 话题门禁 service 测试（agent/guardrail.ts；2026-07 唯恩批次）
 *
 * 覆盖（计划测试 5-7）：
 *   - 三态 verdict 解析；markdown 代码块包裹 JSON 走正则兜底
 *   - 主模型超时 → fallback 命中；全链失败 → fail_open 且 source='fail_open'
 *   - onUsage 回调收到 usage（记账 channel='guardrail' 的数据源）
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  checkTopicScope,
  extractRecentUserMessages,
  type GuardrailCheckInput,
  type GuardrailModelConfig,
} from '../agent/guardrail.js';

type QueueEntry = { content: string | null } | { hangUntilAbort: true } | Error;

// 用 mock 隔离上游：拦截 OpenAI client，不真打网。
// hangUntilAbort 条目挂起到 AbortSignal 触发（模拟超时），验证 per-attempt 超时回落。
vi.mock('openai', () => {
  const responseQueue: Map<string, QueueEntry[]> = (globalThis as any).__guardrailResponseQueue ??= new Map();
  const createCalls: Array<{
    model: string;
    temperature?: number;
    max_tokens?: number;
    messages?: Array<{ role: string; content: string }>;
  }> =
    (globalThis as any).__guardrailCreateCalls ??= [];
  class MockOpenAI {
    constructor(_opts: { apiKey: string }) {}
    chat = {
      completions: {
        create: async (
          req: {
            model: string;
            temperature?: number;
            max_tokens?: number;
            messages?: Array<{ role: string; content: string }>;
          },
          opts?: { signal?: AbortSignal },
        ) => {
          createCalls.push({
            model: req.model,
            temperature: req.temperature,
            max_tokens: req.max_tokens,
            messages: req.messages,
          });
          const queue = responseQueue.get(req.model) ?? [];
          const next = queue.shift();
          if (next instanceof Error) throw next;
          if (next && 'hangUntilAbort' in next) {
            return new Promise((_resolve, reject) => {
              opts?.signal?.addEventListener('abort', () => reject(new Error('Request was aborted')));
            });
          }
          return {
            id: 'mock-' + req.model,
            choices: [{ message: { content: next?.content ?? '' }, finish_reason: 'stop' }],
            usage: {
              prompt_tokens: 42,
              completion_tokens: 6,
              total_tokens: 48,
              prompt_tokens_details: { cached_tokens: 12 },
            },
          };
        },
      },
    };
  }
  return { default: MockOpenAI };
});

function queueResponse(model: string, entry: QueueEntry) {
  const queue: Map<string, QueueEntry[]> = (globalThis as any).__guardrailResponseQueue;
  if (!queue.has(model)) queue.set(model, []);
  queue.get(model)!.push(entry);
}

function createCalls(): Array<{
  model: string;
  temperature?: number;
  max_tokens?: number;
  messages?: Array<{ role: string; content: string }>;
}> {
  return (globalThis as any).__guardrailCreateCalls;
}

function checkInput(overrides: Partial<GuardrailCheckInput> = {}): GuardrailCheckInput {
  return {
    message: '帮我写周报',
    scopeDescription: '唯恩电气重载连接器产品选型问答',
    strictness: 'strict',
    recentUserMessages: [],
    ...overrides,
  };
}

const MAIN: GuardrailModelConfig = { model: 'guard-main', connection: { apiKey: 'test-key' } };
const FALLBACK: GuardrailModelConfig = { model: 'guard-fallback', connection: { apiKey: 'test-key' } };

describe('checkTopicScope', () => {
  afterEach(() => {
    ((globalThis as any).__guardrailResponseQueue as Map<string, QueueEntry[]>)?.clear();
    createCalls().length = 0;
  });

  it('三态 verdict 解析（严格 JSON 输出）', async () => {
    for (const verdict of ['in_scope', 'off_topic', 'uncertain'] as const) {
      queueResponse('guard-main', { content: `{"verdict":"${verdict}"}` });
      const result = await checkTopicScope(checkInput(), [MAIN]);
      expect(result).toMatchObject({ verdict, source: 'model', model: 'guard-main' });
    }
    // 调用参数按计划锁定：temperature 0 / max_tokens 48
    expect(createCalls()[0]).toMatchObject({ temperature: 0, max_tokens: 48 });
  });

  it('门禁 prompt 只传最近用户消息，并把合理简短接续明确列为 in_scope', async () => {
    queueResponse('guard-main', { content: '{"verdict":"in_scope"}' });
    await checkTopicScope(checkInput({
      message: '第二个呢',
      recentUserMessages: ['帮我推荐两款重载连接器', '先比较一下额定电流'],
    }), [MAIN]);

    const messages = createCalls()[0].messages ?? [];
    expect(messages.map((message) => message.role)).toEqual(['system', 'user']);
    const prompt = messages[1].content;
    expect(prompt).toContain('<最近用户消息>');
    expect(prompt).toContain('用户：帮我推荐两款重载连接器');
    expect(prompt).toContain('用户：先比较一下额定电流');
    expect(prompt).not.toContain('助手：');
    expect(prompt).toContain('只要结合最近用户消息与话题范围看似存在合理延续关系');
    expect(prompt).toContain('不得因消息以「继续」等衔接词开头而忽略其后的完整范围外意图');
  });

  it('markdown 代码块包裹 JSON 走 fenced block 解析（F12 收紧后仍支持）', async () => {
    queueResponse('guard-main', { content: '```json\n{"verdict":"off_topic"}\n```' });
    const result = await checkTopicScope(checkInput(), [MAIN]);
    expect(result.verdict).toBe('off_topic');
    expect(result.source).toBe('model');
  });

  it('F12: 长解释文本（>200 字符）夹带 verdict 字样 → 不误匹配，按该模型失败回落', async () => {
    const longExplanation = '让我先分析一下这个问题的性质和上下文背景。'.repeat(10)
      + '按照格式要求本应输出 {"verdict":"off_topic"}，但我想先解释一下原因……';
    expect(longExplanation.length).toBeGreaterThan(200);
    queueResponse('guard-main', { content: longExplanation });
    queueResponse('guard-fallback', { content: '{"verdict":"in_scope"}' });
    const result = await checkTopicScope(checkInput(), [MAIN, FALLBACK]);
    // 主模型长文本中夹带的 verdict 不作数（视为解析失败）→ 回落 fallback 模型判定
    expect(result).toMatchObject({ verdict: 'in_scope', source: 'model', model: 'guard-fallback' });
    expect(createCalls().map((c) => c.model)).toEqual(['guard-main', 'guard-fallback']);
  });

  it('configs 空数组（门禁未激活）→ 不调模型直接 fail_open', async () => {
    const result = await checkTopicScope(checkInput(), []);
    expect(result).toMatchObject({ verdict: 'in_scope', source: 'fail_open' });
    expect(createCalls()).toHaveLength(0);
  });

  it('主模型超时 → fallback 命中', async () => {
    queueResponse('guard-main', { hangUntilAbort: true });
    queueResponse('guard-fallback', { content: '{"verdict":"off_topic"}' });
    const result = await checkTopicScope(checkInput(), [MAIN, FALLBACK], { timeoutMs: 50 });
    expect(result).toMatchObject({ verdict: 'off_topic', source: 'model', model: 'guard-fallback' });
    expect(createCalls().map((c) => c.model)).toEqual(['guard-main', 'guard-fallback']);
  });

  it('全链失败（报错 + 不可解析）→ fail_open 且 source=fail_open', async () => {
    queueResponse('guard-main', new Error('upstream 500'));
    queueResponse('guard-fallback', { content: '我觉得这个问题不错，让我来回答你……' });
    const result = await checkTopicScope(checkInput(), [MAIN, FALLBACK], { timeoutMs: 50 });
    expect(result).toMatchObject({ verdict: 'in_scope', source: 'fail_open' });
    expect(result.model).toBeUndefined();
  });

  it('onUsage 回调收到 usage（token 记账数据源）', async () => {
    queueResponse('guard-main', { content: '{"verdict":"in_scope"}' });
    const usages: Array<{ model: string; usage: Record<string, number> }> = [];
    await checkTopicScope(checkInput(), [MAIN], {
      onUsage: (model, usage) => {
        usages.push({ model, usage: usage as unknown as Record<string, number> });
      },
    });
    expect(usages).toHaveLength(1);
    expect(usages[0].model).toBe('guard-main');
    expect(usages[0].usage).toMatchObject({
      inputTokens: 42,
      outputTokens: 6,
      cacheReadInputTokens: 12,
      apiRequestCount: 1,
    });
  });
});

describe('extractRecentUserMessages', () => {
  it('只读取最后两条真实用户消息，忽略 assistant、thinking、tool_use 和 tool_result', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'guardrail-user-messages-'));
    const transcriptPath = join(dir, 'session.jsonl');
    const lines = [
      { type: 'user', message: { role: 'user', content: '[2026/07/13 周一 19:00] 第一条用户问题' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '内部思考' }, { type: 'text', text: '第一条助手回复' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Search' }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: '工具结果' }] } },
      { type: 'user', message: { role: 'user', content: '第二条用户问题' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '第二条助手回复' }] } },
      { type: 'user', message: { role: 'user', content: '第三条用户问题' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '不要把这条助手回复传给门禁' }] } },
    ];

    try {
      await writeFile(transcriptPath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf-8');
      await expect(extractRecentUserMessages(transcriptPath, 2)).resolves.toEqual([
        '第二条用户问题',
        '第三条用户问题',
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

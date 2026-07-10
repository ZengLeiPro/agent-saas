/**
 * LLM 话题门禁 service 测试（agent/guardrail.ts；2026-07 唯恩批次）
 *
 * 覆盖（计划测试 5-7）：
 *   - 三态 verdict 解析；markdown 代码块包裹 JSON 走正则兜底
 *   - 主模型超时 → fallback 命中；全链失败 → fail_open 且 source='fail_open'
 *   - onUsage 回调收到 usage（记账 channel='guardrail' 的数据源）
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { checkTopicScope, type GuardrailCheckInput, type GuardrailModelConfig } from '../agent/guardrail.js';

type QueueEntry = { content: string | null } | { hangUntilAbort: true } | Error;

// 用 mock 隔离上游：拦截 OpenAI client，不真打网。
// hangUntilAbort 条目挂起到 AbortSignal 触发（模拟超时），验证 per-attempt 超时回落。
vi.mock('openai', () => {
  const responseQueue: Map<string, QueueEntry[]> = (globalThis as any).__guardrailResponseQueue ??= new Map();
  const createCalls: Array<{ model: string; temperature?: number; max_tokens?: number }> =
    (globalThis as any).__guardrailCreateCalls ??= [];
  class MockOpenAI {
    constructor(_opts: { apiKey: string }) {}
    chat = {
      completions: {
        create: async (
          req: { model: string; temperature?: number; max_tokens?: number },
          opts?: { signal?: AbortSignal },
        ) => {
          createCalls.push({ model: req.model, temperature: req.temperature, max_tokens: req.max_tokens });
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

function createCalls(): Array<{ model: string; temperature?: number; max_tokens?: number }> {
  return (globalThis as any).__guardrailCreateCalls;
}

function checkInput(overrides: Partial<GuardrailCheckInput> = {}): GuardrailCheckInput {
  return {
    message: '帮我写周报',
    scopeDescription: '唯恩电气重载连接器产品选型问答',
    strictness: 'strict',
    recentDialog: [],
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

  it('markdown 代码块包裹 JSON 走正则兜底', async () => {
    queueResponse('guard-main', { content: '```json\n{"verdict":"off_topic"}\n```' });
    const result = await checkTopicScope(checkInput(), [MAIN]);
    expect(result.verdict).toBe('off_topic');
    expect(result.source).toBe('model');
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

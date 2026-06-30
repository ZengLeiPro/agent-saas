import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { extractTitleContext, generateTitleWithFallback } from '../agent/titleGenerator.js';

// 用 mock 隔离上游：直接拦截 OpenAI client，不真打网。
vi.mock('openai', () => {
  // 每个 config.model 对应的下一次返回值。测试里 push 进去，client 调用时 shift 出来。
  const responseQueue: Map<string, Array<{ content: string | null } | Error>> = (globalThis as any).__titleResponseQueue ??= new Map();
  class MockOpenAI {
    apiKey: string;
    constructor(opts: { apiKey: string }) {
      this.apiKey = opts.apiKey;
    }
    chat = {
      completions: {
        create: async (req: { model: string }) => {
          const queue = responseQueue.get(req.model) ?? [];
          const next = queue.shift();
          if (next instanceof Error) throw next;
          const content = next?.content ?? '';
          return {
            id: 'mock-' + req.model,
            choices: [{ message: { content }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          };
        },
      },
    };
  }
  return { default: MockOpenAI };
});

function queueResponse(model: string, content: string | null) {
  const queue: Map<string, Array<{ content: string | null } | Error>> = (globalThis as any).__titleResponseQueue;
  if (!queue.has(model)) queue.set(model, []);
  queue.get(model)!.push({ content });
}

function queueError(model: string, err: Error) {
  const queue: Map<string, Array<{ content: string | null } | Error>> = (globalThis as any).__titleResponseQueue;
  if (!queue.has(model)) queue.set(model, []);
  queue.get(model)!.push(err);
}

function resetResponses() {
  const queue: Map<string, Array<{ content: string | null } | Error>> = (globalThis as any).__titleResponseQueue;
  queue?.clear();
}

/**
 * 写一个 transcript jsonl 临时文件，逐行 JSON.stringify。
 * transcript 的真实格式与 Claude Code SDK 一致：`{type:'user'|'assistant', message:{content}}`.
 */
async function writeTranscript(lines: Array<Record<string, unknown>>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'title-ctx-'));
  const path = join(dir, 'transcript.jsonl');
  await writeFile(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return path;
}

describe('extractTitleContext', () => {
  const created: string[] = [];
  afterEach(async () => {
    for (const p of created) {
      await rm(p, { recursive: true, force: true }).catch(() => {});
    }
    created.length = 0;
  });

  it('从 string content 抽取 user/assistant 文本', async () => {
    const path = await writeTranscript([
      { type: 'user', message: { content: '帮我写一份合同' } },
      { type: 'assistant', message: { content: '好的，请告诉我对方公司名称' } },
    ]);
    created.push(path);

    const ctx = await extractTitleContext(path);
    expect(ctx.userMessages).toEqual(['帮我写一份合同']);
    expect(ctx.assistantReplies).toEqual(['好的，请告诉我对方公司名称']);
  });

  it('从 array content 取第一个 text block', async () => {
    const path = await writeTranscript([
      {
        type: 'user',
        message: {
          content: [
            { type: 'text', text: '请总结这份附件' },
            { type: 'image', source: 'x' },
          ],
        },
      },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: '好的，正在阅读' },
            { type: 'tool_use', name: 'Read' },
          ],
        },
      },
    ]);
    created.push(path);

    const ctx = await extractTitleContext(path);
    expect(ctx.userMessages[0]).toBe('请总结这份附件');
    expect(ctx.assistantReplies[0]).toBe('好的，正在阅读');
  });

  it('剥离 <memory-context>、[用户消息]、时间戳前缀', async () => {
    const raw =
      '<memory-context>\n[长期记忆]\n...some bytes...\n</memory-context>\n' +
      '[2026/06/24 周三 14:08] [用户消息] 自动命名是否有 bug？';
    const path = await writeTranscript([{ type: 'user', message: { content: raw } }]);
    created.push(path);

    const ctx = await extractTitleContext(path);
    // [用户消息] 优先于时间戳剥离——marker 位置在时间戳之后，
    // 实现先去 memory-context，再去 [用户消息]，再去时间戳。
    // 因此 marker 之后的剩余文本被取到，再去掉时间戳前缀（marker 在时间戳之后，
    // 剩余是 "自动命名是否有 bug？"）。
    expect(ctx.userMessages[0]).toBe('自动命名是否有 bug？');
  });

  it('多轮取前 N 条（默认 2）', async () => {
    const path = await writeTranscript([
      { type: 'user', message: { content: 'a' } },
      { type: 'assistant', message: { content: 'A' } },
      { type: 'user', message: { content: 'b' } },
      { type: 'assistant', message: { content: 'B' } },
      { type: 'user', message: { content: 'c' } },
      { type: 'assistant', message: { content: 'C' } },
    ]);
    created.push(path);

    const ctx = await extractTitleContext(path);
    expect(ctx.userMessages).toEqual(['a', 'b']);
    expect(ctx.assistantReplies).toEqual(['A', 'B']);
  });

  it('rounds=1 只取首轮', async () => {
    const path = await writeTranscript([
      { type: 'user', message: { content: 'first' } },
      { type: 'assistant', message: { content: 'FIRST' } },
      { type: 'user', message: { content: 'second' } },
      { type: 'assistant', message: { content: 'SECOND' } },
    ]);
    created.push(path);

    const ctx = await extractTitleContext(path, 1);
    expect(ctx.userMessages).toEqual(['first']);
    expect(ctx.assistantReplies).toEqual(['FIRST']);
  });

  it('截断到 1000 字符', async () => {
    const long = 'x'.repeat(1500);
    const path = await writeTranscript([
      { type: 'user', message: { content: long } },
      { type: 'assistant', message: { content: long } },
    ]);
    created.push(path);

    const ctx = await extractTitleContext(path);
    expect(ctx.userMessages[0].length).toBe(1000);
    expect(ctx.assistantReplies[0].length).toBe(1000);
  });

  it('跳过无法 JSON.parse 的行 + 空行', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'title-ctx-'));
    const path = join(dir, 'transcript.jsonl');
    created.push(dir);
    await writeFile(
      path,
      [
        '',
        '{not json',
        JSON.stringify({ type: 'user', message: { content: 'hello' } }),
        '',
        JSON.stringify({ type: 'assistant', message: { content: 'world' } }),
      ].join('\n'),
    );

    const ctx = await extractTitleContext(path);
    expect(ctx.userMessages).toEqual(['hello']);
    expect(ctx.assistantReplies).toEqual(['world']);
  });

  it('空 transcript 返回空数组', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'title-ctx-'));
    const path = join(dir, 'transcript.jsonl');
    created.push(dir);
    await writeFile(path, '');

    const ctx = await extractTitleContext(path);
    expect(ctx.userMessages).toEqual([]);
    expect(ctx.assistantReplies).toEqual([]);
  });
});

describe('generateTitleWithFallback', () => {
  const config = (model: string) => ({
    model,
    connection: { apiKey: 'sk-test', baseUrl: 'http://test' },
  });

  afterEach(() => {
    resetResponses();
  });

  it('configs 为空直接 return null（不抛）', async () => {
    const title = await generateTitleWithFallback('u', 'a', []);
    expect(title).toBeNull();
  });

  it('主模型返回正常内容，不调 fallback', async () => {
    queueResponse('main', '会话标题');
    queueResponse('fb', '不该被用到');
    const title = await generateTitleWithFallback('用户提问', 'agent 回复', [
      config('main'),
      config('fb'),
    ]);
    expect(title).toBe('会话标题');
  });

  it('主模型返回空 content，落到 fallback 1', async () => {
    queueResponse('main', '');
    queueResponse('fb', '回落生成的标题');
    const title = await generateTitleWithFallback('u', 'a', [config('main'), config('fb')]);
    expect(title).toBe('回落生成的标题');
  });

  it('主模型抛错，落到 fallback 1', async () => {
    queueError('main', new Error('upstream 503'));
    queueResponse('fb', '回落标题');
    const title = await generateTitleWithFallback('u', 'a', [config('main'), config('fb')]);
    expect(title).toBe('回落标题');
  });

  it('主和 fallback 全部返回空，最终 null', async () => {
    queueResponse('main', '');
    queueResponse('fb1', '');
    queueResponse('fb2', '');
    const title = await generateTitleWithFallback('u', 'a', [
      config('main'),
      config('fb1'),
      config('fb2'),
    ]);
    expect(title).toBeNull();
  });
});

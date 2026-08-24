import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  extractTitleContext,
  generateTitleWithFallback,
  shouldGenerateTitleFromFirstMessage,
} from '../agent/titleGenerator.js';
import { AGENT_LEGACY_TRANSCRIPTS_ROOT } from '../data/transcripts/projectKey.js';

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
async function makeTranscriptDir(): Promise<string> {
  await mkdir(AGENT_LEGACY_TRANSCRIPTS_ROOT, { recursive: true });
  return mkdtemp(join(AGENT_LEGACY_TRANSCRIPTS_ROOT, 'title-ctx-'));
}

async function writeTranscript(lines: Array<Record<string, unknown>>): Promise<string> {
  const dir = await makeTranscriptDir();
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
    const dir = await makeTranscriptDir();
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
    const dir = await makeTranscriptDir();
    const path = join(dir, 'transcript.jsonl');
    created.push(dir);
    await writeFile(path, '');

    const ctx = await extractTitleContext(path);
    expect(ctx.userMessages).toEqual([]);
    expect(ctx.assistantReplies).toEqual([]);
  });
});

describe('shouldGenerateTitleFromFirstMessage', () => {
  it('中文字数超过 20 才触发，标点与英文不计入中文字符数', () => {
    expect(shouldGenerateTitleFromFirstMessage(`${'中'.repeat(20)}，test`)).toBe(false);
    expect(shouldGenerateTitleFromFirstMessage(`${'中'.repeat(21)}，test`)).toBe(true);
  });

  it('英文单词数超过 20 才触发，连字符和缩写按一个词计算', () => {
    const twentyWords = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty';
    expect(shouldGenerateTitleFromFirstMessage(twentyWords)).toBe(false);
    expect(shouldGenerateTitleFromFirstMessage(`${twentyWords} twenty-one`)).toBe(true);
  });

  it('中英文分别计数，任一语言超过阈值即可触发', () => {
    expect(shouldGenerateTitleFromFirstMessage('中文 mixed words stay below the independent counters')).toBe(false);
    expect(shouldGenerateTitleFromFirstMessage('中文'.repeat(11))).toBe(true);
  });
});

describe('generateTitleWithFallback', () => {
  const config = (model: string) => ({
    model,
    connection: { apiKey: 'sk-test', baseUrl: 'http://test' },
  });
  const codexConfig = {
    model: 'gpt-codex',
    protocol: 'responses' as const,
    responsesTransport: 'codex_subscription' as const,
  };

  afterEach(() => {
    resetResponses();
    vi.unstubAllGlobals();
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

  it('计费授权拒绝向上抛出，不误当 provider 失败继续 fallback', async () => {
    queueResponse('main', '不应调用');
    queueResponse('fb', '不应回落');
    const beforeModelCall = vi.fn(async () => { throw new Error('BILLING_RUN_LIMIT_EXCEEDED'); });

    await expect(generateTitleWithFallback('u', 'a', [config('main'), config('fb')], undefined, undefined, {
      beforeModelCall,
    })).rejects.toThrow(/BILLING_RUN_LIMIT_EXCEEDED/);
    expect(beforeModelCall).toHaveBeenCalledTimes(1);
    expect(beforeModelCall).toHaveBeenCalledWith('main');
  });

  it('usage 入账失败向上抛出，不继续产生 fallback 成本', async () => {
    queueResponse('main', '标题');
    queueResponse('fb', '不应回落');
    const onUsage = vi.fn(async () => { throw new Error('billing usage write failed'); });

    await expect(generateTitleWithFallback('u', 'a', [config('main'), config('fb')], undefined, undefined, {
      onUsage,
    })).rejects.toThrow(/billing usage write failed/);
    expect(onUsage).toHaveBeenCalledTimes(1);
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

  it('Responses 协议从 message.output_text 提取标题并使用独立输出预算', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
      id: 'resp-title',
      status: 'completed',
      output: [{
        type: 'message',
        content: [{ type: 'output_text', text: 'Responses生成标题' }],
      }],
      usage: {
        input_tokens: 20,
        output_tokens: 40,
        input_tokens_details: { cached_tokens: 5 },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const onUsage = vi.fn();

    const title = await generateTitleWithFallback('u', 'a', [{
      ...config('responses-model'),
      protocol: 'responses',
    }], undefined, undefined, { onUsage });

    expect(title).toBe('Responses生成标题');
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      model: 'responses-model',
      max_output_tokens: 512,
      store: false,
      stream: false,
    });
    expect(onUsage).toHaveBeenCalledWith('responses-model', expect.objectContaining({
      inputTokens: 20,
      outputTokens: 40,
      cacheReadInputTokens: 5,
    }));
  });

  it('Responses 只有 reasoning 没有文本时静默回落到下一模型', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      id: 'resp-incomplete',
      status: 'incomplete',
      output: [{ type: 'reasoning', status: 'incomplete' }],
      usage: { input_tokens: 20, output_tokens: 512 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    queueResponse('chat-backup', '备用模型标题');

    const title = await generateTitleWithFallback('u', 'a', [
      { ...config('responses-main'), protocol: 'responses' },
      config('chat-backup'),
    ]);

    expect(title).toBe('备用模型标题');
  });

  it('Codex subscription 通过 Runtime adapter 生成标题并记录 usage', async () => {
    const stream = vi.fn(async function* (request: any, context: any) {
      await context.authorizeModelTurn?.();
      expect(request).toMatchObject({
        model: 'gpt-codex',
        tools: [],
        toolChoice: 'none',
        maxOutputTokens: 512,
      });
      expect(request.previousResponseId).toBeUndefined();
      expect(context).toMatchObject({ sessionId: 'session-title', tenantId: 'tenant-title' });
      yield { type: 'text_delta' as const, content: 'Codex' };
      yield {
        type: 'completed' as const,
        content: 'Codex生成标题',
        toolCalls: [],
        terminalStatus: 'completed' as const,
        finishReason: 'stop',
        responseId: 'resp-codex-title',
        usage: { inputTokens: 30, outputTokens: 8, cacheReadInputTokens: 4, apiRequestCount: 1 },
      };
    });
    const modelAdapterFactory = vi.fn(() => ({ stream }));
    const beforeModelCall = vi.fn();
    const onUsage = vi.fn();

    const title = await generateTitleWithFallback('用户问题', 'Agent 回复', [{
      ...codexConfig,
      modelRef: 'codex/gpt-codex',
      providerOptions: { protocol: 'responses', responsesTransport: 'codex_subscription' },
    }], undefined, undefined, {
      modelAdapterFactory,
      runtimeContext: { sessionId: 'session-title', tenantId: 'tenant-title', cwd: '/workspace/title' },
      beforeModelCall,
      onUsage,
    });

    expect(title).toBe('Codex生成标题');
    expect(modelAdapterFactory).toHaveBeenCalledWith({}, expect.objectContaining({
      protocol: 'responses',
      responsesTransport: 'codex_subscription',
      disableResponseChaining: true,
      preStreamRetryDelaysMs: [],
    }));
    expect(beforeModelCall).toHaveBeenCalledOnce();
    expect(onUsage).toHaveBeenCalledWith('gpt-codex', expect.objectContaining({ inputTokens: 30, outputTokens: 8 }));
  });

  it('Codex subscription adapter 失败时继续普通模型 fallback', async () => {
    const modelAdapterFactory = vi.fn(() => ({
      stream: async function* () { throw new Error('Codex subscription 尚未完成账号授权'); },
    }));
    queueResponse('chat-backup', '普通模型回落标题');

    const title = await generateTitleWithFallback('u', 'a', [
      codexConfig,
      config('chat-backup'),
    ], undefined, undefined, {
      modelAdapterFactory,
      runtimeContext: { sessionId: 'session-title', cwd: '/workspace/title' },
    });

    expect(title).toBe('普通模型回落标题');
  });

  it('Codex 的计费授权拒绝向上抛出，不误当 provider 失败 fallback', async () => {
    const modelAdapterFactory = vi.fn(() => ({
      stream: async function* (_request: any, context: any) {
        await context.authorizeModelTurn?.();
        yield { type: 'completed' as const, content: '不应生成', toolCalls: [], terminalStatus: 'completed' as const };
      },
    }));
    const beforeModelCall = vi.fn(async () => { throw new Error('BILLING_RUN_LIMIT_EXCEEDED'); });
    queueResponse('chat-backup', '不应回落');

    await expect(generateTitleWithFallback('u', 'a', [
      codexConfig,
      config('chat-backup'),
    ], undefined, undefined, {
      modelAdapterFactory,
      runtimeContext: { sessionId: 'session-title', cwd: '/workspace/title' },
      beforeModelCall,
    })).rejects.toThrow(/BILLING_RUN_LIMIT_EXCEEDED/);
    expect(beforeModelCall).toHaveBeenCalledOnce();
  });

  it('Codex 失败终态先记录已产生的 usage，再继续 fallback', async () => {
    const modelAdapterFactory = vi.fn(() => ({
      stream: async function* () {
        yield {
          type: 'completed' as const,
          content: '',
          toolCalls: [],
          terminalStatus: 'failed' as const,
          errorMessage: 'upstream failed after usage',
          usage: { inputTokens: 40, outputTokens: 6, apiRequestCount: 1 },
        };
      },
    }));
    const onUsage = vi.fn();
    queueResponse('chat-backup', '失败后回落标题');

    const title = await generateTitleWithFallback('u', 'a', [
      codexConfig,
      config('chat-backup'),
    ], undefined, undefined, {
      modelAdapterFactory,
      runtimeContext: { sessionId: 'session-title', cwd: '/workspace/title' },
      onUsage,
    });

    expect(title).toBe('失败后回落标题');
    expect(onUsage).toHaveBeenNthCalledWith(1, 'gpt-codex', expect.objectContaining({ inputTokens: 40, outputTokens: 6 }));
  });

  it('Codex 失败终态的 usage 入账失败时不继续 fallback', async () => {
    const modelAdapterFactory = vi.fn(() => ({
      stream: async function* (_request: any, context: any) {
        await context.authorizeModelTurn?.();
        yield {
          type: 'completed' as const,
          content: '',
          toolCalls: [],
          terminalStatus: 'failed' as const,
          usage: { inputTokens: 40, outputTokens: 6, apiRequestCount: 1 },
        };
      },
    }));
    const beforeModelCall = vi.fn();
    queueResponse('chat-backup', '不应调用');

    await expect(generateTitleWithFallback('u', 'a', [
      codexConfig,
      config('chat-backup'),
    ], undefined, undefined, {
      modelAdapterFactory,
      runtimeContext: { sessionId: 'session-title', cwd: '/workspace/title' },
      beforeModelCall,
      onUsage: async () => { throw new Error('usage write failed'); },
    })).rejects.toThrow(/usage write failed/);
    expect(beforeModelCall).toHaveBeenCalledTimes(1);
  });

  it('Codex 凭据获取不响应 AbortSignal 时仍按标题超时回落', async () => {
    const modelAdapterFactory = vi.fn(() => ({
      stream: async function* () { await new Promise<never>(() => {}); },
    }));
    queueResponse('chat-backup', '超时回落标题');
    queueResponse('chat-backup', '悬挂期间直接回落标题');

    const title = await generateTitleWithFallback('u', 'a', [
      codexConfig,
      config('chat-backup'),
    ], undefined, undefined, {
      modelAdapterFactory,
      runtimeContext: { sessionId: 'session-title', cwd: '/workspace/title' },
      timeoutMs: 5,
    });

    expect(title).toBe('超时回落标题');

    const secondTitle = await generateTitleWithFallback('u2', 'a2', [
      { ...codexConfig, modelRef: 'codex/renamed-alias' },
      config('chat-backup'),
    ], undefined, undefined, {
      modelAdapterFactory,
      runtimeContext: { sessionId: 'session-title-2', cwd: '/workspace/title' },
      timeoutMs: 5,
    });
    expect(secondTitle).toBe('悬挂期间直接回落标题');
    expect(modelAdapterFactory).toHaveBeenCalledOnce();
  });

  it('Codex 流结束但没有 completed 终态时丢弃 delta 并回落', async () => {
    const modelAdapterFactory = vi.fn(() => ({
      stream: async function* () { yield { type: 'text_delta' as const, content: '未完成标题' }; },
    }));
    queueResponse('chat-backup', '无终态回落标题');

    const title = await generateTitleWithFallback('u', 'a', [
      codexConfig,
      config('chat-backup'),
    ], undefined, undefined, {
      modelAdapterFactory,
      runtimeContext: { sessionId: 'session-title', cwd: '/workspace/title' },
    });

    expect(title).toBe('无终态回落标题');
  });
});

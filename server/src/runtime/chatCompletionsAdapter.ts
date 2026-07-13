import { createHash } from 'crypto';

import type {
  ModelAdapter,
  ModelChatMessage,
  ModelEvent,
  ModelRequest,
  ModelToolCall,
  ModelToolDefinition,
  ModelUsage,
  RunContext,
  RuntimeConnection,
} from './types.js';
import type { ModelProviderOptions } from '../types/index.js';
import { createLogger } from '../utils/logger.js';
import {
  defendUserMessageText,
  detectDsmlLeak,
  detectMojibake,
  unescapeDeepseekArguments,
} from './agentPlanDefense.js';

const logger = createLogger('Cache');
const CHAT_COMPLETIONS_MAX_FETCH_ATTEMPTS = 3;
const CHAT_COMPLETIONS_RETRY_DELAYS_MS = [250, 1_000] as const;
const RETRYABLE_CHAT_COMPLETIONS_HTTP_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504]);

/**
 * O4：prompt_cache_key 改"内容指纹"。
 *
 * 原实现 `prompt_cache_key = sessionId` 的问题：
 * - 同用户跨 session 前缀字节相同（system + tools 一致），却被路由到不同机器 → 缓存伪失效；
 * - 同 sessionId 内 PERSONA / cwd / skill 启用列表变动后 system 变了，仍路由到旧机器 → 缓存伪共享。
 *
 * 改为：hash(model + system_content + sorted_tool_names) 的前 32 hex 字符。
 * - 前缀真正相同的请求 → 同 key → 同台机器 → 高命中；
 * - 前缀变了 → key 变 → 自动换路由，不与失效缓存抢同一台。
 *
 * sessionId 不再参与 — OpenAI 文档允许任意稳定字符串，前缀真值已足够。
 */
function computePromptCacheKey(
  model: string,
  messages: ModelChatMessage[],
  tools: ModelToolDefinition[],
): string {
  const systemContent = messages.find((m) => m.role === 'system')?.content ?? '';
  const toolSignature = tools.map((t) => t.name).sort().join(',');
  return createHash('sha256')
    .update(`${model}\n${systemContent}\n${toolSignature}`)
    .digest('hex')
    .slice(0, 32);
}

export class ChatCompletionsModelAdapter implements ModelAdapter {
  constructor(
    private readonly connection: Required<RuntimeConnection>,
    private readonly providerOptions: ModelProviderOptions = {},
  ) {}

  async *stream(request: ModelRequest, context: RunContext): AsyncIterable<ModelEvent> {
    // ⚠️ P0.3 Cross-API 防御：Chat Completions 端点收到 previous_response_id 会 HTTP 200 静默忽略，
    // 调试时极易误判为「模型记忆差」。要么 dispatcher 路由错配（应走 ResponsesApiAdapter），
    // 要么调用方误填字段。直接抛错暴露问题。
    if (request.previousResponseId) {
      throw new Error(
        'ChatCompletionsModelAdapter does not support previous_response_id. '
        + 'Use ResponsesApiAdapter for cross-step reasoning chain (RFC v1 §3.1).',
      );
    }
    // A3/B2/B4/G1 — user 通道防御 + 时间戳注入：对所有 user role message 走 defendUserMessageText
    // （平台注入上下文块只保留 escape）。与 ResponsesApiAdapter 对齐，保持跨协议一致行为。
    const sessionIdShort = context.sessionId ? context.sessionId.slice(0, 8) : undefined;
    const defendedMessages: ModelChatMessage[] = request.messages.map((m) => (
      m.role === 'user'
        ? { ...m, content: defendUserMessageText(m.content, sessionIdShort) }
        : m
    ));

    const body = {
      model: request.model,
      messages: defendedMessages,
      tools: request.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      })),
      tool_choice: request.toolChoice ?? 'auto',
      // D3：parallel_tool_calls 在火山 /chat/completions silent ignored（主报告 D3 实测）。
      // 删除原 `parallel_tool_calls: false` 死字段；如需真正串行需走 instructions + client 端丢 fc。
      stream: true,
      stream_options: { include_usage: true },
      // prompt_cache_key（O4）：用 (model + system + tool 名单) 的内容指纹做路由亲和键。
      // 前缀真正字节相同的请求 → 同 key → 同台机器，最大化 OpenAI 自动前缀缓存命中率；
      // PERSONA / cwd / skill 列表变动等让 system 变化的事件会自动换 key，避免缓存伪共享。
      // 非 OpenAI 的兼容端点会忽略该字段（无害）。
      // 注：cache key 用原始 request.messages 而非 defendedMessages — defended 后的 user message
      // 含时间戳前缀（每分钟变），会冲掉缓存命中，所以保持用原始内容指纹做路由。
      // disablePromptCacheKey=true 时不传（保留给「兼容层拒绝该字段」的极少数端点用；
      // 主流兼容端点都是 silent ignore，默认传即可）。
      ...(this.providerOptions.disablePromptCacheKey
        ? {}
        : { prompt_cache_key: computePromptCacheKey(request.model, request.messages, request.tools) }),
      ...(this.providerOptions.extraBody ?? {}),
      ...(this.providerOptions.thinking !== undefined ? { thinking: this.providerOptions.thinking } : {}),
      ...(this.providerOptions.reasoningEffort !== undefined ? { reasoning_effort: this.providerOptions.reasoningEffort } : {}),
    };
    const signal = request.signal ?? context.signal;
    const response = await fetchChatCompletionsWithRetry(chatCompletionsUrl(this.connection.baseUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.connection.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    }, {
      model: request.model,
      sessionId: context.sessionId,
      signal,
    });
    if (!response.body) {
      throw new Error('Chat Completions response body is empty.');
    }

    let content = '';
    let usage: ModelUsage | undefined;
    let finishReason: string | undefined;
    const toolByIndex = new Map<number, ModelToolCall>();
    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          for (const data of parseSseData(block)) {
            if (data === '[DONE]') continue;
            const event = JSON.parse(data) as Record<string, any>;
            if (event.usage) {
              usage = mergeUsage(usage, normalizeChatUsage(event.usage));
            }
            const choice = event.choices?.[0];
            const delta = choice?.delta;
            if (typeof choice?.finish_reason === 'string' && choice.finish_reason) {
              finishReason = choice.finish_reason;
            }
            const reasoning = getReasoningDelta(delta);
            if (reasoning) {
              yield { type: 'thinking_delta', content: reasoning };
            }
            if (typeof delta?.content === 'string' && delta.content) {
              content += delta.content;
              yield { type: 'text_delta', content: delta.content };
            }
            for (const toolDelta of delta?.tool_calls ?? []) {
              mergeToolDelta(toolByIndex, toolDelta);
            }
          }
          boundary = buffer.indexOf('\n\n');
        }
      }
      const tail = buffer.trim();
      if (tail) {
        for (const data of parseSseData(tail)) {
          if (data === '[DONE]') continue;
          const event = JSON.parse(data) as Record<string, any>;
          if (event.usage) usage = mergeUsage(usage, normalizeChatUsage(event.usage));
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (usage) {
      const input = usage.inputTokens ?? 0;
      const cached = usage.cacheReadInputTokens ?? 0;
      // OpenAI 语义：cached_tokens 是 prompt_tokens(input) 的子集，命中率 = cached / input。
      const hitPct = input > 0 ? Math.round((cached / input) * 1000) / 10 : 0;
      const sid = context.sessionId ? context.sessionId.slice(0, 8) : '-';
      logger.info(`命中率 session=${sid} model=${request.model} input=${input} cached=${cached} hit=${hitPct}%`);
    }

    // E3 DSML reject（与 ResponsesApiAdapter 对齐，二轮加固：preview 写日志不 throw）
    if (detectDsmlLeak(content)) {
      const preview = content.slice(0, 200).replace(/\n/g, '\\n');
      const sessionLabel = context.sessionId ? context.sessionId.slice(0, 8) : '-';
      logger.warn(
        `DSML 泄漏到 chat completions content — model=${request.model} session=${sessionLabel} preview="${preview}"`,
      );
      throw new Error('模型输出格式异常（DSML 模板未被服务端解析），已中断本轮。');
    }

    // C1 mojibake warn（与 ResponsesApiAdapter 对齐）
    {
      const moji = detectMojibake(content);
      if (moji.hit) {
        const preview = content.slice(0, 200).replace(/\n/g, '\\n');
        logger.warn(
          `Mojibake 检测命中 chat completions content。samples=${moji.sampleCount} `
          + `model=${request.model} session=${context.sessionId?.slice(0, 8) ?? '-'} preview="${preview}"`,
        );
      }
    }

    const rawToolCalls = Array.from(toolByIndex.values());
    const validToolCallsRaw = rawToolCalls.filter((call) => call.name);
    if (rawToolCalls.length > validToolCallsRaw.length) {
      const dropped = rawToolCalls.filter((call) => !call.name);
      logger.warn(
        `丢弃无 name 的 tool_call（疑似 provider 流缺失 function.name）count=${dropped.length} ids=${dropped.map((c) => c.id).join(',')}`,
      );
    }
    // D1 deepseek arguments unescape（仅在 providerOptions 标记开启的模型路径）
    const validToolCalls = this.providerOptions.applyDeepseekArgumentUnescape
      ? validToolCallsRaw.map((c) => ({ ...c, arguments: unescapeDeepseekArguments(c.arguments) }))
      : validToolCallsRaw;

    yield {
      type: 'completed',
      content,
      toolCalls: validToolCalls,
      ...(usage ? { usage } : {}),
      ...(finishReason ? { finishReason } : {}),
      responseChained: false,
      responseMode: 'full',
    };
  }
}

async function fetchChatCompletionsWithRetry(
  url: string,
  init: RequestInit,
  context: { model: string; sessionId?: string; signal?: AbortSignal },
): Promise<Response> {
  for (let attempt = 1; attempt <= CHAT_COMPLETIONS_MAX_FETCH_ATTEMPTS; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (err) {
      if (isAbortError(err, context.signal)) throw err;
      if (attempt >= CHAT_COMPLETIONS_MAX_FETCH_ATTEMPTS) throw err;
      logger.warn(formatChatRetryLog('network error', attempt, context, err));
      await waitForChatRetry(CHAT_COMPLETIONS_RETRY_DELAYS_MS[attempt - 1] ?? 0, context.signal);
      continue;
    }

    if (response.ok) return response;

    const text = await response.text().catch(() => '');
    const message = `Chat Completions HTTP ${response.status}: ${text.slice(0, 1000)}`;
    if (!RETRYABLE_CHAT_COMPLETIONS_HTTP_STATUSES.has(response.status)
      || attempt >= CHAT_COMPLETIONS_MAX_FETCH_ATTEMPTS) {
      throw new Error(message);
    }

    logger.warn(formatChatRetryLog(`HTTP ${response.status}`, attempt, context, message));
    await waitForChatRetry(CHAT_COMPLETIONS_RETRY_DELAYS_MS[attempt - 1] ?? 0, context.signal);
  }

  throw new Error('Chat Completions request failed before receiving a response.');
}

function formatChatRetryLog(
  reason: string,
  attempt: number,
  context: { model: string; sessionId?: string },
  detail: unknown,
): string {
  const session = context.sessionId ? context.sessionId.slice(0, 8) : '-';
  const nextAttempt = attempt + 1;
  const detailText = detail instanceof Error ? detail.message : String(detail);
  return `Chat Completions ${reason}; retry ${nextAttempt}/${CHAT_COMPLETIONS_MAX_FETCH_ATTEMPTS} `
    + `model=${context.model} session=${session} detail=${detailText.slice(0, 300)}`;
}

function isAbortError(err: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true;
  return err instanceof Error && err.name === 'AbortError';
}

async function waitForChatRetry(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (ms <= 0) return;
  if (signal?.aborted) throw createAbortError();
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timer);
      reject(createAbortError());
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function createAbortError(): Error {
  const err = new Error('Chat Completions request aborted');
  err.name = 'AbortError';
  return err;
}

function getReasoningDelta(delta: Record<string, any> | undefined): string {
  const value = delta?.reasoning_content ?? delta?.reasoningContent ?? delta?.reasoning;
  return typeof value === 'string' ? value : '';
}

function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (trimmed.endsWith('/chat/completions')) return trimmed;
  return `${trimmed}/chat/completions`;
}

function parseSseData(block: string): string[] {
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    dataLines.push(line.slice('data:'.length).trimStart());
  }
  return dataLines.length > 0 ? [dataLines.join('\n').trim()] : [];
}

function mergeToolDelta(toolByIndex: Map<number, ModelToolCall>, toolDelta: any): void {
  const index = Number.isFinite(Number(toolDelta?.index)) ? Number(toolDelta.index) : 0;
  const current = toolByIndex.get(index) ?? {
    id: `tool_${index}`,
    name: '',
    arguments: '',
  };
  if (toolDelta?.id) current.id = String(toolDelta.id);
  if (toolDelta?.function?.name) current.name += String(toolDelta.function.name);
  if (toolDelta?.function?.arguments) current.arguments += String(toolDelta.function.arguments);
  toolByIndex.set(index, current);
}

function normalizeChatUsage(raw: Record<string, any>): ModelUsage {
  const inputTokens = numberOrZero(raw.prompt_tokens ?? raw.input_tokens);
  const outputTokens = numberOrZero(raw.completion_tokens ?? raw.output_tokens);
  const promptDetails = raw.prompt_tokens_details ?? raw.input_tokens_details;
  const cacheReadInputTokens = numberOrZero(promptDetails?.cached_tokens);
  // 详见 responsesApiAdapter.normalizeResponsesUsage 里的注释——observability 字段，
  // outputTokens 已覆盖计费。
  const completionDetails = raw.completion_tokens_details ?? raw.output_tokens_details;
  const reasoningTokens = numberOrZero(completionDetails?.reasoning_tokens);
  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens: 0,
    reasoningTokens,
  };
}

function mergeUsage(a: ModelUsage | undefined, b: ModelUsage): ModelUsage {
  return {
    inputTokens: (a?.inputTokens ?? 0) + (b.inputTokens ?? 0),
    outputTokens: (a?.outputTokens ?? 0) + (b.outputTokens ?? 0),
    cacheReadInputTokens: (a?.cacheReadInputTokens ?? 0) + (b.cacheReadInputTokens ?? 0),
    cacheCreationInputTokens: (a?.cacheCreationInputTokens ?? 0) + (b.cacheCreationInputTokens ?? 0),
    reasoningTokens: (a?.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0),
  };
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

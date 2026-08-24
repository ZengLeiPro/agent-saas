import { createHash, randomUUID } from 'crypto';

import { ModelProviderError } from './types.js';
import type {
  ModelAdapter,
  ModelChatMessage,
  ModelEvent,
  ModelRequest,
  ModelToolCall,
  ModelToolDefinition,
  ModelUsage,
  ModelRetryReason,
  RunContext,
  RuntimeConnection,
} from './types.js';
import type { ModelProviderOptions } from '../types/index.js';
import { resolveModelOutputTransactionMode } from './modelOutputTransaction.js';
import { createLogger } from '../utils/logger.js';
import {
  defendUserMessageText,
  detectDsmlLeak,
  detectMojibake,
  unescapeDeepseekArguments,
} from './agentPlanDefense.js';
import { modelSupportsImage, readImagePartOrPlaceholder, toTextOnlyContent } from './imageAttachments.js';
import { ToolCallRepairStreamGate, toolCallRepairProviderLabel } from './toolCallRepair.js';
import { classifyModelFailure } from './runtimeFailure.js';

const logger = createLogger('Cache');
const CHAT_COMPLETIONS_RETRY_DELAYS_MS = [250, 1_000] as const;
const RETRYABLE_CHAT_COMPLETIONS_HTTP_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504]);

class ChatCompletionsHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryable: boolean,
    readonly code?: string,
  ) {
    super(`Chat Completions HTTP ${status}`);
    this.name = 'ChatCompletionsHttpError';
  }
}

class ChatCompletionsAttemptError extends Error {
  constructor(
    readonly outcome: 'parse_error' | 'stream_error',
    readonly usage: ModelUsage | undefined,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'ChatCompletionsAttemptError';
  }
}

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
  const toolSignature = tools
    .map((tool) => `${tool.mcpServer?.namespace ?? '-'}:${tool.name}:${tool.deferLoading === true ? 'deferred' : 'eager'}`)
    .sort()
    .join(',');
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
    const outputTransactionMode = resolveModelOutputTransactionMode(context.channelContext);
    const retryDelaysMs = this.providerOptions.preStreamRetryDelaysMs
      ?? [...CHAT_COMPLETIONS_RETRY_DELAYS_MS];
    const modelRequestId = randomUUID();
    let transientRetryIndex = 0;
    let attempt = 0;

    while (true) {
      attempt += 1;
      const attemptId = randomUUID();
      const clientRequestId = randomUUID();
      const startedAt = Date.now();
      let startedRecorded = false;
      let hasDeliveredOutput = false;
      const bufferedOutput: Array<Extract<ModelEvent,
        { type: 'thinking_delta' | 'text_delta' }>> = [];
      let completed: Extract<ModelEvent, { type: 'completed' }> | undefined;
      try {
        for await (const event of this.streamAttempt(request, context, async (requestBodyBytes) => {
          startedRecorded = true;
          await context.recordModelRequestDiagnostic?.({
            type: 'started',
            modelRequestId,
            attemptId,
            attempt,
            clientRequestId,
            model: request.model,
            protocol: 'chat_completions',
            responseMode: 'full',
            outputTransactionMode,
            maxOutputTokens: request.maxOutputTokens ?? this.providerOptions.maxOutputTokens ?? 0,
            requestBodyBytes,
            toolsCount: request.tools.length,
            hasPreviousResponseId: false,
          });
        })) {
          if (event.type === 'completed') {
            completed = event;
          } else if (
            outputTransactionMode === 'terminal_buffered'
            && (event.type === 'thinking_delta' || event.type === 'text_delta')
          ) {
            bufferedOutput.push(event);
          } else {
            if (event.type === 'thinking_delta' || event.type === 'text_delta') {
              hasDeliveredOutput = true;
            }
            yield event;
          }
        }
        if (!completed) throw new Error('Chat Completions stream completed without completion event');
        if (startedRecorded) {
          await context.recordModelRequestDiagnostic?.({
            type: 'finished',
            modelRequestId,
            attemptId,
            attempt,
            outcome: 'completed',
            durationMs: Date.now() - startedAt,
            outputTransactionMode,
            hasDeliveredOutput,
            officialTerminalReceived: true,
            ...(completed.usage ? { usage: completed.usage } : {}),
          });
        }
        for (const event of bufferedOutput) yield event;
        yield completed;
        return;
      } catch (error) {
        if (!startedRecorded) throw error;
        const aborted = isAbortError(error, request.signal ?? context.signal);
        const retryable = !aborted && isRetryableChatAttemptError(error);
        const replaySafe = !hasDeliveredOutput
          || outputTransactionMode === 'terminal_buffered'
          || outputTransactionMode === 'replaceable_draft';
        const retryDelayMs = retryable && replaySafe
          ? retryDelaysMs[transientRetryIndex]
          : undefined;
        const willRetry = retryDelayMs !== undefined;
        const retryBlockedReason = willRetry
          ? undefined
          : aborted
            ? 'aborted' as const
            : !retryable
              ? 'permanent_error' as const
              : !replaySafe
                ? 'irreversible_output_delivered' as const
                : 'retry_budget_exhausted' as const;
        const usage = error instanceof ChatCompletionsAttemptError ? error.usage : undefined;
        const recorded = await context.recordModelRequestDiagnostic?.({
          type: 'finished',
          modelRequestId,
          attemptId,
          attempt,
          outcome: aborted
            ? 'aborted'
            : error instanceof ChatCompletionsAttemptError
              ? error.outcome
              : error instanceof ChatCompletionsHttpError
                ? 'http_error'
                : 'network_error',
          durationMs: Date.now() - startedAt,
          outputTransactionMode,
          hasDeliveredOutput,
          officialTerminalReceived: false,
          errorCode: aborted
            ? 'MODEL_REQUEST_ABORTED'
            : error instanceof ChatCompletionsHttpError
              ? error.code ?? `HTTP_${error.status}`
              : error instanceof ChatCompletionsAttemptError && error.outcome === 'parse_error'
                ? 'MODEL_STREAM_PARSE_ERROR'
                : 'MODEL_STREAM_READ_ERROR',
          errorMessage: compactChatDiagnostic(error),
          ...(usage ? { usage } : {}),
          ...(willRetry
            ? { willRetry: true, retryReason: chatRetryReason(error) }
            : { retryBlockedReason }),
        });
        if (recorded === false && usage) {
          throw new Error('MODEL_USAGE_DIAGNOSTIC_PERSIST_FAILED');
        }
        if (!willRetry) {
          if (error instanceof ChatCompletionsHttpError) {
            const failureProtocol = classifyModelFailure(error.code, retryBlockedReason);
            throw new ModelProviderError(
              error.message,
              error.status,
              error.code ?? `HTTP_${error.status}`,
              modelRequestId,
              attemptId,
              0,
              failureProtocol?.failureKind,
              failureProtocol?.recoveryAction,
            );
          }
          throw error;
        }
        transientRetryIndex += 1;
        logger.warn(
          `Chat Completions transient failure; retry ${transientRetryIndex}/${retryDelaysMs.length} `
          + `model=${request.model} session=${context.sessionId.slice(0, 8)} detail=${compactChatDiagnostic(error)}`,
        );
        if (hasDeliveredOutput && outputTransactionMode === 'replaceable_draft') {
          yield { type: 'draft_reset', attempt };
        }
        await waitForChatRetry(retryDelayMs, request.signal ?? context.signal);
      }
    }
  }

  private async *streamAttempt(
    request: ModelRequest,
    context: RunContext,
    beforeRequest: (requestBodyBytes: number) => Promise<void>,
  ): AsyncIterable<ModelEvent> {
    // ⚠️ P0.3 Cross-API 防御：Chat Completions 端点收到 previous_response_id 会 HTTP 200 静默忽略，
    // 调试时极易误判为「模型记忆差」。要么 dispatcher 路由错配（应走 ResponsesApiAdapter），
    // 要么调用方误填字段。直接抛错暴露问题。
    if (request.previousResponseId) {
      throw new Error(
        'ChatCompletionsModelAdapter does not support previous_response_id. '
        + 'Use ResponsesApiAdapter for cross-step reasoning chain (RFC v1 §3.1).',
      );
    }
    // A3/B2/B4 — 对所有 user role message 做确定性防御。时间戳已在 runtime 入站时固化，
    // adapter 不得读取当前时钟改写历史，否则 full replay 的 prompt prefix 会失稳。
    // 平台注入上下文块只保留 escape；与 ResponsesApiAdapter 对齐。
    const sessionIdShort = context.sessionId ? context.sessionId.slice(0, 8) : undefined;
    const defendedMessages = (await Promise.all(request.messages
      .filter((message) => message.role !== 'additional_tools')
      .map(async (message): Promise<Array<Record<string, unknown>>> => {
      if (message.role === 'assistant' && message.tool_calls) {
        return [{
          ...message,
          tool_calls: message.tool_calls.map((call) => ({
            id: call.id,
            type: call.type,
            function: call.function,
          })),
        }];
      }
      if (message.role === 'tool' && message.images?.length) {
        const visualContent: Array<Record<string, unknown>> = [];
        if (!modelSupportsImage(this.providerOptions.inputModalities)) {
          visualContent.push({
            type: 'text',
            text: defendUserMessageText('[Read 返回了图片，但当前模型未启用视觉输入，无法查看图片内容。]', sessionIdShort),
          });
        } else {
          for (const image of message.images) {
            const dataUrl = await readImagePartOrPlaceholder(context.cwd, image);
            if (typeof dataUrl !== 'string') {
              visualContent.push({ type: 'text', text: defendUserMessageText(dataUrl.placeholder, sessionIdShort) });
              continue;
            }
            visualContent.push({
              type: 'image_url',
              image_url: { url: dataUrl, detail: image.detail },
            });
          }
        }
        return [message, { role: 'user', content: visualContent }];
      }
      if (message.role !== 'user') return [message];
      if (typeof message.content === 'string') {
        return [{ ...message, content: defendUserMessageText(message.content, sessionIdShort) }];
      }
      if (!modelSupportsImage(this.providerOptions.inputModalities)) {
        return [{
          ...message,
          content: defendUserMessageText(toTextOnlyContent(message.content), sessionIdShort),
        }];
      }
      const content: Array<Record<string, unknown>> = [];
      for (const part of message.content) {
        if (part.type === 'vision_summary') continue;
        if (part.type === 'text') {
          content.push({ type: 'text', text: defendUserMessageText(part.text, sessionIdShort) });
          continue;
        }
        const dataUrl = await readImagePartOrPlaceholder(context.cwd, part);
        if (typeof dataUrl !== 'string') {
          content.push({ type: 'text', text: defendUserMessageText(dataUrl.placeholder, sessionIdShort) });
          continue;
        }
        content.push({
          type: 'image_url',
          image_url: {
            url: dataUrl,
            detail: part.detail === 'original' ? 'high' : part.detail,
          },
        });
      }
      return [{ ...message, content }];
      }))).flat();

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
    const serializedBody = JSON.stringify(body);
    await context.authorizeModelTurn?.();
    await beforeRequest(Buffer.byteLength(serializedBody, 'utf8'));
    const response = await fetchChatCompletions(chatCompletionsUrl(this.connection.baseUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.connection.apiKey}`,
        'content-type': 'application/json',
      },
      body: serializedBody,
      signal,
    }, { signal });
    if (!response.body) {
      throw new Error('Chat Completions response body is empty.');
    }

    let content = '';
    let usage: ModelUsage | undefined;
    let finishReason: string | undefined;
    const toolByIndex = new Map<number, ModelToolCall>();
    const toolCallRepairMode = this.providerOptions.toolCallRepair ?? 'off';
    const toolCallRepair = new ToolCallRepairStreamGate(toolCallRepairMode);
    const toolCallRepairRequestSeed = createHash('sha256').update(JSON.stringify({
      runId: context.runId,
      model: request.model,
      messages: request.messages,
      toolNames: request.tools.map((tool) => tool.name),
    })).digest('hex');
    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = '';
    let sawDone = false;
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
            if (data === '[DONE]') {
              sawDone = true;
              continue;
            }
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
              for (const visibleDelta of toolCallRepair.push(delta.content)) {
                yield { type: 'text_delta', content: visibleDelta };
              }
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
          if (data === '[DONE]') {
            sawDone = true;
            continue;
          }
          const event = JSON.parse(data) as Record<string, any>;
          if (event.usage) usage = mergeUsage(usage, normalizeChatUsage(event.usage));
        }
      }
    } catch (err) {
      // A partial marker may be the only user-visible evidence before an abort/read/parse error.
      // Release it unchanged so repair mode cannot permanently swallow an incomplete attempt.
      for (const visibleDelta of toolCallRepair.abort()) {
        yield { type: 'text_delta', content: visibleDelta };
      }
      throw new ChatCompletionsAttemptError(
        err instanceof SyntaxError ? 'parse_error' : 'stream_error',
        usage,
        err,
      );
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

    // E3 DSML reject（与 ResponsesApiAdapter 对齐）。日志只记短元数据，协议正文可能含参数/Secret。
    if (detectDsmlLeak(content)) {
      logger.warn(`DSML leak rejected in chat completions model=${request.model}`);
      const error = new Error('模型输出格式异常（DSML 模板未被服务端解析），已中断本轮。');
      throw new ChatCompletionsAttemptError('parse_error', usage, error);
    }

    if (toolCallRepairMode === 'repair' && !sawDone && !finishReason) {
      const incompleteRepair = toolCallRepair.finish({
        text: content,
        allowedToolNames: request.tools.map((tool) => tool.name),
        nativeToolCallsPresent: toolByIndex.size > 0,
        provider: toolCallRepairProviderLabel(context.modelRef),
        model: request.model,
        requestSeed: toolCallRepairRequestSeed,
        streamComplete: false,
      });
      for (const visibleText of incompleteRepair.visibleText) {
        yield { type: 'text_delta', content: visibleText };
      }
      const error = new Error('Chat Completions stream ended before a terminal marker.');
      throw new ChatCompletionsAttemptError('stream_error', usage, error);
    }
    if (!sawDone && !finishReason) {
      const error = new Error('Chat Completions stream ended before a terminal marker.');
      throw new ChatCompletionsAttemptError('stream_error', usage, error);
    }

    // C1 mojibake warn（与 ResponsesApiAdapter 对齐）；不记录正文 preview。
    {
      const moji = detectMojibake(content);
      if (moji.hit) {
        logger.warn(
          `Mojibake detected in chat completions samples=${moji.sampleCount} model=${request.model}`,
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
    const nativeToolCalls = this.providerOptions.applyDeepseekArgumentUnescape
      ? validToolCallsRaw.map((c) => ({ ...c, arguments: unescapeDeepseekArguments(c.arguments) }))
      : validToolCallsRaw;
    const repair = toolCallRepair.finish({
      text: content,
      allowedToolNames: request.tools.map((tool) => tool.name),
      nativeToolCallsPresent: rawToolCalls.length > 0,
      provider: toolCallRepairProviderLabel(context.modelRef),
      model: request.model,
      requestSeed: toolCallRepairRequestSeed,
    });
    for (const visibleText of repair.visibleText) {
      yield { type: 'text_delta', content: visibleText };
    }
    const validToolCalls = nativeToolCalls.length > 0 ? nativeToolCalls : repair.promotedToolCalls;
    const completedContent = repair.scrubbed ? '' : content;

    yield {
      type: 'completed',
      content: completedContent,
      toolCalls: validToolCalls,
      ...(usage ? { usage } : {}),
      ...(finishReason ? { finishReason } : {}),
      responseChained: false,
      responseMode: 'full',
    };
  }
}

function parseChatCompletionsErrorCode(text: string): string | undefined {
  try {
    const body = JSON.parse(text) as unknown;
    if (!body || typeof body !== 'object') return undefined;
    const error = (body as { error?: unknown }).error;
    if (!error || typeof error !== 'object') return undefined;
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' && code.trim() ? code.trim() : undefined;
  } catch {
    return undefined;
  }
}

async function fetchChatCompletions(
  url: string,
  init: RequestInit,
  context: { signal?: AbortSignal },
): Promise<Response> {
  const response = await fetch(url, init);
  if (response.ok) return response;

  const text = await response.text().catch(() => '');
  const quotaExhausted = response.status === 429
    && /quota[_\s-]?exceeded|insufficient[_\s-]?quota|exhausted its free trial|额度(?:已)?(?:用尽|耗尽)/i.test(text);
  throw new ChatCompletionsHttpError(
    response.status,
    RETRYABLE_CHAT_COMPLETIONS_HTTP_STATUSES.has(response.status) && !quotaExhausted,
    parseChatCompletionsErrorCode(text),
  );
}

function isRetryableChatAttemptError(error: unknown): boolean {
  if (error instanceof ChatCompletionsHttpError) return error.retryable;
  if (error instanceof ChatCompletionsAttemptError) return error.outcome === 'stream_error';
  if (error instanceof SyntaxError) return false;
  const message = compactChatDiagnostic(error);
  return !/ERR_INVALID_URL|invalid url|unknown scheme|unsupported protocol|CERT_|ERR_TLS|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|certificate|self[- ]signed|unable to verify|ENOTFOUND|EAI_NONAME|proxy authentication required/i
    .test(message);
}

function chatRetryReason(error: unknown): ModelRetryReason {
  return error instanceof ChatCompletionsHttpError
    ? 'transient_http_error'
    : error instanceof ChatCompletionsAttemptError
      ? 'transient_stream_interrupt'
      : 'transient_network_error';
}

function compactChatDiagnostic(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined;
  const causeRecord = cause && typeof cause === 'object' ? cause as Record<string, unknown> : undefined;
  const causeDetail = [
    typeof causeRecord?.code === 'string' ? causeRecord.code : '',
    cause instanceof Error
      ? cause.message
      : typeof causeRecord?.message === 'string'
        ? causeRecord.message
        : typeof cause === 'string'
          ? cause
          : '',
  ].filter(Boolean).join(': ');
  const raw = error instanceof Error ? error.message : String(error ?? '');
  return `${raw}${causeDetail ? ` (cause=${causeDetail})` : ''}`
    .replace(/((?:"|')?(?:api[_-]?key|authorization|cookie|set-cookie|access_token|refresh_token|id_token)(?:"|')?\s*:\s*)(?:"[^"]*"|'[^']*')/gi, '$1"[REDACTED]"')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-[REDACTED]')
    .replace(/((?:api[_-]?key|authorization|cookie|set-cookie|access_token|refresh_token|id_token)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/\b(https?:\/\/)(?:[^@\s/]+@)?([^?\s#]+)\?[^\s#]*/gi, '$1$2?[REDACTED]')
    .replace(/\b(https?:\/\/)[^@\s/]+@/gi, '$1[REDACTED]@')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300) || 'unknown_error';
}

function isAbortError(err: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true;
  if (err instanceof Error && err.name === 'AbortError') return true;
  const cause = err instanceof Error ? err.cause : undefined;
  return cause instanceof Error && cause.name === 'AbortError';
}

async function waitForChatRetry(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) throw createAbortError();
  if (ms <= 0) return;
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

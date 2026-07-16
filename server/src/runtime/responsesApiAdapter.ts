/**
 * ResponsesApiAdapter（RFC v1 P0.1）
 *
 * 与 ChatCompletionsModelAdapter 平级，走火山 Ark `/responses` 端点。
 * 支持 `previous_response_id` 服务端接力，使 agent loop 跨步保留 reasoning chain。
 *
 * 接力策略（adapter 内部自动判定，对 RawAgentLoop 透明）：
 * - 首轮（无 previousResponseId）：全量 messages 转 Responses input items，system 走 instructions
 * - 接力轮（有 previousResponseId）：只发 messages 尾部「user 或 tool 增量」+ previous_response_id
 *
 * adapter 是无状态的，session state（lastResponseId / expireAt / cumulativeInputTokens）
 * 由 RawAgentLoop 持久化到 PG（见 RFC P0.4）。
 *
 * SSE 事件参考：assets/20260619/api-test/A4.sse + assets/20260620 round2 raw.jsonl。
 */

import type {
  ModelAdapter,
  ModelChatMessage,
  ModelEvent,
  ModelRequest,
  ModelToolCall,
  ModelToolDefinition,
  ModelUsage,
  ModelResponseMode,
  ModelRequestDiagnostic,
  ModelTerminalStatus,
  RunContext,
  RuntimeConnection,
} from './types.js';
import type { ModelProviderOptions } from '../types/index.js';
import { createHash, randomUUID } from 'node:crypto';
import { createLogger } from '../utils/logger.js';
import {
  defendUserMessageText,
  detectDsmlLeak,
  detectMojibake,
  unescapeDeepseekArguments,
} from './agentPlanDefense.js';
import { modelSupportsImage, readModelImageDataUrl, toTextOnlyContent } from './imageAttachments.js';

/**
 * prompt_cache_key 内容指纹：与 chatCompletionsAdapter.computePromptCacheKey 语义等价。
 * Responses 路径 system 走 instructions（非 messages 里的 system role），所以从 messages
 * 抽 system 内容用于指纹计算——与 chat 分支保持"相同 system + tools → 相同 key"的行为。
 * 07-04 实测：CLIProxyAPI 会自动为每次请求填新 UUID 覆盖 prompt_cache_key，
 * 显式传稳定 key 后 cached_tokens 命中率从 0 提升到 76%+。
 */
function computePromptCacheKey(
  model: string,
  messages: ModelChatMessage[],
  tools: ModelToolDefinition[] | undefined,
): string {
  const systemContent = messages.find((m) => m.role === 'system')?.content ?? '';
  const toolSignature = (tools ?? []).map((t) => t.name).sort().join(',');
  return createHash('sha256')
    .update(`${model}\n${systemContent}\n${toolSignature}`)
    .digest('hex')
    .slice(0, 32);
}

function computeRequestInputPrefixHash(body: Record<string, unknown>): string {
  const input = Array.isArray(body.input) ? body.input.slice(0, 8) : [];
  return createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 32);
}

const logger = createLogger('ResponsesAdapter');

/** Responses API 默认 max_output_tokens 下限：≤16 触发服务端 500（实测 doubao）。 */
const MAX_OUTPUT_TOKENS_FLOOR = 64;

/** cumulativeInputTokens 告警阈值（P1.3 嵌套接力监控）。 */
const CUMULATIVE_INPUT_WARN_THRESHOLD = 100_000;

/** previous_response_id 服务端 TTL：72 小时（实测火山所有公开模型）。 */
const RESPONSE_TTL_MS = 72 * 3600 * 1000;

/** 单帧未闭合缓冲上限。诊断只存长度+哈希，不保存原始 SSE。 */
const MAX_SSE_BUFFER_BYTES = 2 * 1024 * 1024;

/** usage 兜底查询不能拖住已经完成的模型轮次。 */
const USAGE_FETCH_TIMEOUT_MS = 2_000;

/** 诊断字段是 provider 输入，限制基数和长度，避免异常流放大 PG 事件。 */
const MAX_DIAGNOSTIC_EVENT_TYPES = 64;
const MAX_UNKNOWN_EVENT_TYPES = 20;

const RESERVED_EXTRA_BODY_KEYS = new Set([
  'model',
  'input',
  'previous_response_id',
  'instructions',
  'tools',
  'tool_choice',
  'max_output_tokens',
  'store',
  'stream',
  'prompt_cache_key',
]);

/**
 * 上游拒绝 previous_response_id 的判定。
 * - 火山 Ark：HTTP 400 `{"error":{"code":"InvalidParameter.PreviousResponseNotFound","param":"previous_response_id",...}}`
 * - OpenAI：HTTP 400/404 `Previous response with id 'resp_x' not found`
 * 仅在请求确实带了 previous_response_id 时调用（调用方保证），无误伤面。
 */
export function isPreviousResponseNotFound(status: number, bodyText: string): boolean {
  if (status !== 400 && status !== 404) return false;
  return /previous[_\s]?response/i.test(bodyText);
}

/** 单个 input item，对齐 OpenAI Responses input items 协议。 */
type ResponsesInputItem =
  | {
    type: 'message';
    role: 'user' | 'assistant' | 'system';
    content: Array<
      | { type: 'input_text' | 'output_text'; text: string }
      | { type: 'input_image'; image_url: string; detail: 'high' | 'original' }
    >;
  }
  | {
    type: 'function_call';
    call_id: string;
    name: string;
    arguments: string;
  }
  | {
    type: 'function_call_output';
    call_id: string;
    output: string;
  };

export class ResponsesApiAdapter implements ModelAdapter {
  constructor(
    private readonly connection: Required<RuntimeConnection>,
    private readonly providerOptions: ModelProviderOptions = {},
  ) {}

  async *stream(request: ModelRequest, context: RunContext): AsyncIterable<ModelEvent> {
    // P0.6：max_output_tokens 强制下限 ≥64
    // 取值优先级：调用方显式 request > 模型配置 max_output_tokens > 默认 4096。
    const requestedMax = typeof request.maxOutputTokens === 'number'
      ? request.maxOutputTokens
      : typeof this.providerOptions.maxOutputTokens === 'number'
        ? this.providerOptions.maxOutputTokens
        : 4096;
    const maxOutputTokens = Math.max(requestedMax, MAX_OUTPUT_TOKENS_FLOOR);
    if (requestedMax < MAX_OUTPUT_TOKENS_FLOOR) {
      logger.warn(
        `max_output_tokens=${requestedMax} 小于下限 ${MAX_OUTPUT_TOKENS_FLOOR}，已提升以避免火山 500（model=${request.model}）`,
      );
    }

    // P1.4：tool_choice 与 model 兼容性校验（详 RFC §2.3：glm 拒 required/specific）
    const toolChoice = this.validateAndNormalizeToolChoice(request.toolChoice ?? 'auto', request.model);
    assertReservedExtraBodyKeys(this.providerOptions.extraBody);

    // 决定走接力还是全量。
    // disableResponseChaining=true 时强制全量：无状态代理（cli-proxy 等）不持久化上一轮
    // response，接力轮只发增量 function_call_output 会触发上游
    // "No tool call found for function call output with call_id ..."。
    const hasPrevious = typeof request.previousResponseId === 'string'
      && request.previousResponseId.length > 0
      && !this.providerOptions.disableResponseChaining;

    const sessionIdShort = context.sessionId ? context.sessionId.slice(0, 8) : undefined;
    // usePrevious 可被降级：上游报 PreviousResponseNotFound（跨模型切换残留 / 服务端已过期）
    // 时切回全量重建 body 重试，不让确定性 400 直接打死整个 run。
    let usePrevious = hasPrevious;
    let responseMode: ModelResponseMode = hasPrevious ? 'relay' : 'full';
    const promptCacheKey = this.providerOptions.disablePromptCacheKey
      ? undefined
      : computePromptCacheKey(request.model, request.messages, request.tools);
    const buildRequestBody = async (): Promise<Record<string, unknown>> => {
      const { instructions, input } = usePrevious
        ? { instructions: undefined, input: await this.extractIncrementalInput(request.messages, context.cwd, sessionIdShort) }
        : await this.buildFullInput(request.messages, context.cwd, sessionIdShort);

      if (usePrevious && input.length === 0) {
        throw new Error(
          'ResponsesApiAdapter: previousResponseId 存在但 messages 尾部没有可接力的 user/tool 增量；'
          + 'RawAgentLoop 调用前请确认增量结构正确。',
        );
      }

      const built: Record<string, unknown> = {
        model: request.model,
        input,
        ...(usePrevious ? { previous_response_id: request.previousResponseId } : {}),
        ...(instructions ? { instructions } : {}),
        tools: this.adaptTools(request.tools),
        tool_choice: toolChoice,
        max_output_tokens: maxOutputTokens,
        store: true,
        stream: true,
        // prompt_cache_key（07-04）：内容指纹路由。默认传，让相同 system/instructions + tools
        // 的请求命中同一缓存分片（07-04 实测 CLIProxyAPI 会自动生成新 UUID 覆盖 → 缓存永远打散，
        // 显式传稳定 key 后 cached_tokens 命中率 76%+）。disablePromptCacheKey=true 时跳过。
        ...(promptCacheKey ? { prompt_cache_key: promptCacheKey } : {}),
        ...(this.providerOptions.extraBody ?? {}),
      };

      // reasoning 字段：伪推理模型不发，避免 Responses+tools 在伪推理模型上 broken（RFC §2.3）
      if (!this.providerOptions.isPseudoReasoning) {
        if (this.providerOptions.thinking !== undefined) built.thinking = this.providerOptions.thinking;
        if (this.providerOptions.reasoningEffort !== undefined) {
          built.reasoning = { effort: this.providerOptions.reasoningEffort };
        }
      }
      return built;
    };
    let body = await buildRequestBody();
    let requestBodyBytes = 0;
    let requestInputPrefixHash = '';
    let modelRequestAttemptCount = 0;

    const requestSignal = request.signal ?? context.signal;
    const url = responsesUrl(this.connection.baseUrl);
    const modelRequestId = randomUUID();
    let response: Response | null = null;
    let activeAttempt: ResponsesAttemptDiagnostics | null = null;
    // 网络错误/5xx 不能证明上游未接单、未计费，禁止隐式重试。唯一自动二次 POST 是
    // previous_response_id 被明确 400/404 拒绝后的全量降级（确定性未进入模型执行）。
    const maxAttempts = hasPrevious ? 2 : 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      modelRequestAttemptCount = attempt;
      const serializedBody = JSON.stringify(body);
      requestBodyBytes = Buffer.byteLength(serializedBody, 'utf8');
      requestInputPrefixHash = computeRequestInputPrefixHash(body);
      const attemptDiagnostics = new ResponsesAttemptDiagnostics(context, {
        modelRequestId,
        attempt,
        model: request.model,
        responseMode,
        maxOutputTokens,
        requestBodyBytes,
        toolsCount: request.tools.length,
        hasPreviousResponseId: usePrevious,
      });
      await attemptDiagnostics.started();
      let attemptResponse: Response;
      try {
        attemptResponse = await fetch(url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.connection.apiKey}`,
            'content-type': 'application/json',
            'x-client-request-id': attemptDiagnostics.clientRequestId,
          },
          body: serializedBody,
          signal: requestSignal,
        });
      } catch (err) {
        const aborted = requestSignal?.aborted === true;
        await attemptDiagnostics.finished(aborted ? 'aborted' : 'network_error', {
          errorCode: aborted ? 'MODEL_REQUEST_ABORTED' : 'MODEL_NETWORK_ERROR',
          errorMessage: compactDiagnosticMessage(err),
        });
        throw err;
      }
      attemptDiagnostics.observeHttpResponse(attemptResponse);
      if (attemptResponse.ok) {
        response = attemptResponse;
        activeAttempt = attemptDiagnostics;
        break;
      }
      const text = await attemptResponse.text().catch(() => '');
      // previous_response_id 不被上游认可（跨模型切换后残留 / 服务端 TTL 过期）：
      // 确定性 4xx，重发同 body 无意义 → 降级全量重建后立即重试（不退避，不占额外网络成本）。
      if (
        usePrevious
        && attempt < maxAttempts
        && !requestSignal?.aborted
        && isPreviousResponseNotFound(attemptResponse.status, text)
      ) {
        await attemptDiagnostics.finished('http_error', {
          errorCode: 'PREVIOUS_RESPONSE_NOT_FOUND',
          errorMessage: `Responses API HTTP ${attemptResponse.status}: previous_response_id not found`,
          willRetry: true,
        });
        logger.warn(
          `Responses API previous_response_id 不被上游认可（跨模型切换或已过期），降级全量重试：${compactDiagnosticMessage(text)}`,
        );
        responseMode = 'fallback_full';
        usePrevious = false;
        body = await buildRequestBody();
        continue;
      }
      const providerError = extractProviderError(text);
      await attemptDiagnostics.finished('http_error', {
        errorCode: providerError.code ?? `HTTP_${attemptResponse.status}`,
        errorMessage: providerError.message ?? `Responses API HTTP ${attemptResponse.status}`,
      });
      throw new Error(
        `Responses API HTTP ${attemptResponse.status}: ${providerError.message ?? 'upstream request failed'}`,
      );
    }
    if (!response || !activeAttempt) {
      throw new Error('Responses API request did not produce a response.');
    }
    if (!response.body) {
      await activeAttempt.finished('stream_error', {
        errorCode: 'MODEL_RESPONSE_BODY_MISSING',
        errorMessage: 'Responses API response body is empty',
      });
      throw new Error('Responses API response body is empty.');
    }
    const responseContentType = response.headers.get('content-type');
    if (responseContentType && !/\btext\/event-stream\b/i.test(responseContentType)) {
      await activeAttempt.finished('stream_error', {
        errorCode: 'MODEL_RESPONSE_CONTENT_TYPE_INVALID',
        errorMessage: `Expected text/event-stream, got ${compactHeader(responseContentType) ?? 'unknown'}`,
      });
      throw new Error(`Responses API expected text/event-stream, got ${responseContentType}`);
    }

    let content = '';
    let usage: ModelUsage | undefined;
    let finishReason: string | undefined;
    let responseId: string | undefined;
    let responseExpireAt: number | undefined;
    let actualModel: string | undefined;
    let terminalEventType: string | undefined;
    let terminalStatus: ModelTerminalStatus | undefined;
    let incompleteReason: string | undefined;
    let providerErrorCode: string | undefined;
    let providerErrorMessage: string | undefined;
    let refusal = '';

    // function_call 在 stream 里按 output_index 累积；item 整体在 output_item.done 出现
    const toolCallsByIndex = new Map<number, ModelToolCall>();
    const functionCallArgsBuffer = new Map<number, { call_id: string; name: string; arguments: string }>();

    const decoder = new TextDecoder();
    let reader: ReadableStreamDefaultReader<Uint8Array>;
    try {
      reader = response.body.getReader();
    } catch (err) {
      await activeAttempt.finished('stream_error', {
        errorCode: 'MODEL_STREAM_READER_ACQUIRE_ERROR',
        errorMessage: compactDiagnosticMessage(err),
      });
      throw err;
    }
    const frames = new SseFrameBuffer(MAX_SSE_BUFFER_BYTES);
    let streamReadSettled = false;
    let canonicalTextSuffix = '';

    try {
      readLoop: while (true) {
        const { done, value } = await reader.read();
        if (value) activeAttempt.observeBytes(value.byteLength);
        const decoded = done ? decoder.decode() : decoder.decode(value, { stream: true });
        for (const block of frames.push(decoded)) {
          for (const frame of parseSseFrames(block)) {
            const { data } = frame;
            activeAttempt.observeFrame();
            if (data === '[DONE]') {
              activeAttempt.observeDone();
              continue;
            }
            let event: Record<string, any>;
            try {
              event = JSON.parse(data) as Record<string, any>;
            } catch (err) {
              throw new ResponsesStreamError(
                'parse_error',
                'MODEL_SSE_JSON_INVALID',
                `Responses SSE JSON parse failed: ${compactDiagnosticMessage(err)}`,
              );
            }
            const eventType = typeof event.type === 'string' ? event.type : frame.eventName ?? '';
            activeAttempt.observeEvent(eventType, event.sequence_number);

            if (eventType === 'response.created') {
              responseId = event.response?.id;
              actualModel = compactDiagnosticToken(event.response?.model, 200);
              if (typeof event.response?.expire_at === 'number') {
                // Responses API expire_at 单位为 Unix epoch 秒
                responseExpireAt = event.response.expire_at;
              }
              await activeAttempt.checkpoint('response_created', { responseId, actualModel });
            } else if (eventType === 'response.output_text.delta') {
              const delta = typeof event.delta === 'string' ? event.delta : '';
              if (delta) {
                content += delta;
                yield { type: 'text_delta', content: delta };
              }
            } else if (eventType === 'response.reasoning_summary_text.delta') {
              // 公开派模型（glm 在带 tools 复杂 agent loop 时激活）发 reasoning summary；
              // 隐藏派（doubao/minimax）此事件不出现但 reasoning_tokens 仍计费
              const delta = typeof event.delta === 'string' ? event.delta : '';
              if (delta) yield { type: 'thinking_delta', content: delta };
            } else if (eventType === 'response.output_text.done') {
              const doneText = typeof event.text === 'string' ? event.text : '';
              const suffix = reconcileTextSnapshot(content, doneText);
              if (suffix) {
                content += suffix;
                yield { type: 'text_delta', content: suffix };
              }
            } else if (eventType === 'response.refusal.delta') {
              if (typeof event.delta === 'string') refusal += event.delta;
            } else if (eventType === 'response.refusal.done') {
              if (typeof event.refusal === 'string') refusal = event.refusal;
            } else if (eventType === 'response.function_call_arguments.delta') {
              const outputIndex: number = typeof event.output_index === 'number' ? event.output_index : 0;
              const delta = typeof event.delta === 'string' ? event.delta : '';
              const buf = functionCallArgsBuffer.get(outputIndex) ?? { call_id: '', name: '', arguments: '' };
              buf.arguments += delta;
              functionCallArgsBuffer.set(outputIndex, buf);
            } else if (eventType === 'response.output_item.added') {
              const item = event.item;
              if (item?.type === 'function_call') {
                const outputIndex: number = typeof event.output_index === 'number' ? event.output_index : 0;
                const buf = functionCallArgsBuffer.get(outputIndex) ?? { call_id: '', name: '', arguments: '' };
                if (typeof item.call_id === 'string') buf.call_id = item.call_id;
                if (typeof item.name === 'string') buf.name = item.name;
                if (typeof item.arguments === 'string') buf.arguments = item.arguments;
                functionCallArgsBuffer.set(outputIndex, buf);
              }
            } else if (eventType === 'response.output_item.done') {
              const item = event.item;
              const outputIndex: number = typeof event.output_index === 'number' ? event.output_index : 0;
              if (item?.type === 'function_call') {
                const buf = functionCallArgsBuffer.get(outputIndex) ?? { call_id: '', name: '', arguments: '' };
                const callId = (typeof item.call_id === 'string' && item.call_id) || buf.call_id;
                const name = (typeof item.name === 'string' && item.name) || buf.name;
                const args = (typeof item.arguments === 'string' && item.arguments) || buf.arguments;
                if (callId && name) {
                  toolCallsByIndex.set(outputIndex, { id: callId, name, arguments: args });
                }
              }
            } else if (eventType === 'response.completed') {
              const respObj = event.response;
              assertSingleTerminal(terminalEventType, eventType);
              terminalEventType = eventType;
              terminalStatus = normalizeTerminalStatus(respObj?.status, 'completed');
              if (terminalStatus !== 'completed') {
                throw new ResponsesStreamError(
                  'provider_error',
                  'MODEL_TERMINAL_STATUS_MISMATCH',
                  `response.completed carried status=${terminalStatus}`,
                );
              }
              if (typeof respObj?.id === 'string') responseId = respObj.id;
              if (respObj?.usage) usage = normalizeResponsesUsage(respObj.usage);
              if (typeof respObj?.expire_at === 'number') responseExpireAt = respObj.expire_at;
              actualModel = compactDiagnosticToken(respObj?.model, 200) ?? actualModel;
              activeAttempt.observeTerminal(eventType, terminalStatus, responseId);
              const canonicalOutputPresent = !!respObj
                && typeof respObj === 'object'
                && Object.hasOwn(respObj, 'output');
              const snapshot = parseCanonicalOutput(respObj?.output, canonicalOutputPresent);
              canonicalTextSuffix = reconcileTextSnapshot(content, snapshot.text, snapshot.present);
              if (snapshot.refusal) refusal = snapshot.refusal;
              reconcileToolCallSnapshot(toolCallsByIndex, snapshot.toolCalls, snapshot.present);
              finishReason = mapResponsesStatusToFinish('completed', toolCallsByIndex.size > 0);
              await activeAttempt.checkpoint('terminal_received', {
                responseId,
                actualModel,
                terminalEventType: eventType,
                terminalStatus,
              });
            } else if (eventType === 'response.incomplete') {
              const respObj = event.response;
              assertSingleTerminal(terminalEventType, eventType);
              terminalEventType = eventType;
              terminalStatus = 'incomplete';
              if (typeof respObj?.id === 'string') responseId = respObj.id;
              actualModel = compactDiagnosticToken(respObj?.model, 200) ?? actualModel;
              if (respObj?.usage) usage = normalizeResponsesUsage(respObj.usage);
              incompleteReason = compactDiagnosticToken(respObj?.incomplete_details?.reason, 200) ?? 'unknown';
              finishReason = incompleteReason === 'content_filter' ? 'content_filter' : 'length';
              activeAttempt.observeTerminal(eventType, terminalStatus, responseId, incompleteReason);
              await activeAttempt.checkpoint('terminal_received', {
                responseId,
                actualModel,
                terminalEventType: eventType,
                terminalStatus,
                incompleteReason,
                errorCode: 'MODEL_RESPONSE_INCOMPLETE',
              });
            } else if (eventType === 'response.failed') {
              const respObj = event.response;
              assertSingleTerminal(terminalEventType, eventType);
              terminalEventType = eventType;
              terminalStatus = 'failed';
              if (typeof respObj?.id === 'string') responseId = respObj.id;
              actualModel = compactDiagnosticToken(respObj?.model, 200) ?? actualModel;
              if (respObj?.usage) usage = normalizeResponsesUsage(respObj.usage);
              providerErrorCode = compactDiagnosticToken(respObj?.error?.code, 200) ?? 'MODEL_RESPONSE_FAILED';
              providerErrorMessage = compactDiagnosticMessage(respObj?.error?.message ?? 'Responses API response failed');
              activeAttempt.observeTerminal(eventType, terminalStatus, responseId);
              await activeAttempt.checkpoint('terminal_received', {
                responseId,
                actualModel,
                terminalEventType: eventType,
                terminalStatus,
                errorCode: providerErrorCode,
              });
            } else if (eventType === 'response.cancelled') {
              const respObj = event.response;
              assertSingleTerminal(terminalEventType, eventType);
              terminalEventType = eventType;
              terminalStatus = 'cancelled';
              if (typeof respObj?.id === 'string') responseId = respObj.id;
              actualModel = compactDiagnosticToken(respObj?.model, 200) ?? actualModel;
              if (respObj?.usage) usage = normalizeResponsesUsage(respObj.usage);
              providerErrorCode = 'MODEL_RESPONSE_CANCELLED';
              providerErrorMessage = 'Responses API response was cancelled';
              activeAttempt.observeTerminal(eventType, terminalStatus, responseId);
              await activeAttempt.checkpoint('terminal_received', {
                responseId,
                actualModel,
                terminalEventType: eventType,
                terminalStatus,
                errorCode: providerErrorCode,
              });
            } else if (eventType === 'error' || eventType === 'response.error') {
              assertSingleTerminal(terminalEventType, eventType);
              terminalEventType = eventType;
              terminalStatus = 'failed';
              providerErrorCode = compactDiagnosticToken(event.code ?? event.error?.code, 200)
                ?? 'MODEL_PROVIDER_ERROR';
              providerErrorMessage = compactDiagnosticMessage(
                event.message ?? event.error?.message ?? 'Responses API stream error',
              );
              activeAttempt.observeTerminal(eventType, terminalStatus);
              await activeAttempt.checkpoint('terminal_received', {
                terminalEventType: eventType,
                terminalStatus,
                errorCode: providerErrorCode,
              });
            } else {
              activeAttempt.observeUnknownEvent(eventType);
            }
            // 收到任一官方终态后立即封口。终态之后的帧不再有权修改文本或 tool_calls，
            // 同时不依赖 provider 主动关闭 HTTP 连接。
            if (terminalEventType) break readLoop;
          }
        }
        if (done) break;
      }

      if (!terminalEventType || !terminalStatus) {
        const tail = frames.finish();
        if (tail.trim()) {
          activeAttempt.observeTail(tail);
          throw new ResponsesStreamError(
            'unterminated_tail',
            'MODEL_SSE_UNTERMINATED_TAIL',
            `Responses SSE ended with an unterminated frame (${Buffer.byteLength(tail, 'utf8')} bytes)`,
          );
        }
        throw new ResponsesStreamError(
          'eof_without_terminal',
          'MODEL_SSE_EOF_WITHOUT_TERMINAL',
          'Responses SSE ended before a terminal event',
        );
      }
      // 不再等 EOF：终态就是协议边界，主动取消剩余 body，避免成功轮次被悬挂连接拖死。
      await reader.cancel().catch(() => undefined);
      if (canonicalTextSuffix) {
        content += canonicalTextSuffix;
        yield { type: 'text_delta', content: canonicalTextSuffix };
      }
      streamReadSettled = true;
    } catch (err) {
      const classified = classifyStreamError(err, requestSignal);
      await reader.cancel().catch(() => undefined);
      await activeAttempt.finished(classified.outcome, {
        errorCode: classified.code,
        errorMessage: classified.message,
        usage,
      });
      streamReadSettled = true;
      throw err;
    } finally {
      // async generator 的消费者可能在任一 delta 后 return()；该路径不会进入 catch。
      // 补齐 attempt 终态，避免 PG 永久只剩 started/checkpoint。
      if (!streamReadSettled && !activeAttempt.isFinished()) {
        await reader.cancel().catch(() => undefined);
        await activeAttempt.finished('aborted', {
          errorCode: 'MODEL_STREAM_CONSUMER_CLOSED',
          errorMessage: 'Model stream consumer closed before adapter completion',
          usage,
        });
      }
      reader.releaseLock();
    }

    if (terminalStatus !== 'completed' || refusal) {
      const failureStatus: ModelTerminalStatus = terminalStatus === 'completed' ? 'failed' : terminalStatus;
      const outcome: FinishedOutcome = refusal
        ? 'provider_error'
        : terminalStatus === 'incomplete'
          ? 'response_incomplete'
          : terminalEventType === 'response.failed'
            ? 'response_failed'
            : 'provider_error';
      const errorCode = refusal
        ? 'MODEL_RESPONSE_REFUSAL'
        : terminalStatus === 'incomplete'
          ? 'MODEL_RESPONSE_INCOMPLETE'
          : providerErrorCode ?? 'MODEL_RESPONSE_FAILED';
      const errorMessage = refusal
        ? 'Responses API returned a refusal'
        : terminalStatus === 'incomplete'
          ? `Responses API response incomplete: reason=${incompleteReason ?? 'unknown'}`
          : providerErrorMessage ?? 'Responses API response failed';
      await activeAttempt.finished(outcome, { errorCode, errorMessage, usage });
      yield {
        type: 'completed',
        content,
        toolCalls: [],
        ...(usage ? { usage } : {}),
        ...(finishReason ? { finishReason } : {}),
        terminalStatus: failureStatus,
        ...(incompleteReason ? { incompleteReason } : {}),
        errorCode,
        responseChained: usePrevious,
        responseMode,
        modelRequestAttemptCount,
        ...(promptCacheKey ? { promptCacheKey } : {}),
        requestInputPrefixHash,
        requestBodyBytes,
      };
      return;
    }

    // P1.1：stream 末尾 chunk usage 永远 null（RFC §2.4），用 GET /responses/{id} 兜底
    if (!usage && responseId) {
      const fetched = await this.fetchUsageById(responseId, requestSignal).catch((err) => {
        logger.warn(`fetchUsageById 失败 responseId=${responseId.slice(0, 12)}: ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
      });
      if (fetched) usage = fetched;
    }

    // P0.7：actualModel 与 aliasActual 校验告警
    const expectedAlias = this.providerOptions.aliasActual;
    if (expectedAlias && actualModel && actualModel !== expectedAlias) {
      logger.warn(
        `Model alias mismatch: expected=${expectedAlias} actual=${actualModel} requested=${request.model}`,
      );
    }

    // P1.3：嵌套接力 input_tokens 监控（按 turn 单点检查，跨 turn 累计由 RawAgentLoop 维护）
    if (usage && (usage.inputTokens ?? 0) > CUMULATIVE_INPUT_WARN_THRESHOLD) {
      logger.warn(
        `Responses turn input_tokens=${usage.inputTokens} 超阈值 ${CUMULATIVE_INPUT_WARN_THRESHOLD}，`
        + `建议开新会话（model=${request.model} session=${context.sessionId.slice(0, 8)}）`,
      );
    }

    // E3：DSML 泄露 reject（升级自 commit bb7be166 的仅 warn）。
    // 主报告 E3 实测：doubao 在接力轮省 tools 时 100% 泄漏 DSML 内部模板字串；
    // 生产路径已固定每轮重发 tools 应零触发，但若火山 server 端 tool-parsing 退化
    // 仍可能再次出现。沉默透传 = 前端看到内部 token + agent 丢工具能力 = 双重故障。
    //
    // 二轮加固：preview 写日志而非 throw message，避免内部 DSML token 字面暴露给用户。
    // throw 一个对用户友好的 message 让 RawAgentLoop 转给前端。
    if (detectDsmlLeak(content)) {
      const preview = content.slice(0, 200).replace(/\n/g, '\\n');
      const sessionLabel = context.sessionId ? context.sessionId.slice(0, 8) : '-';
      logger.warn(
        `DSML 泄漏到 output_text — model=${request.model} session=${sessionLabel} preview="${preview}"`,
      );
      await activeAttempt.finished('provider_error', {
        errorCode: 'MODEL_OUTPUT_DSML_LEAK',
        errorMessage: 'Model output contained an unparsed DSML template',
        usage,
      });
      throw new Error('模型输出格式异常（DSML 模板未被服务端解析），已中断本轮。');
    }

    // C1：mojibake 检测告警（仅 warn，不修复 — 历史观测但当前不可复现）。
    // 命中 = server 把 UTF-8 字节按 Latin-1 reinterpret 再 UTF-8 编码，
    // 检测特征 = `Ã` / `Â` + 任意字符连续序列 ≥ 2 次。
    {
      const moji = detectMojibake(content);
      if (moji.hit) {
        const preview = content.slice(0, 200).replace(/\n/g, '\\n');
        logger.warn(
          `Mojibake 检测命中 output_text — 可能是火山 server 字节处理回归。`
          + `samples=${moji.sampleCount} model=${request.model} `
          + `session=${context.sessionId?.slice(0, 8) ?? '-'} preview="${preview}"`,
        );
      }
    }

    // D1：deepseek arguments 双层 escape 反转（仅在 providerOptions 标记开启的模型路径）。
    const toolCallsRaw = Array.from(toolCallsByIndex.values()).filter((c) => c.name);
    const toolCalls = this.providerOptions.applyDeepseekArgumentUnescape
      ? toolCallsRaw.map((c) => ({ ...c, arguments: unescapeDeepseekArguments(c.arguments) }))
      : toolCallsRaw;

    await activeAttempt.finished('completed', { usage });

    logger.info(
      `Responses 请求完成 mode=${responseMode} attempts=${modelRequestAttemptCount} `
      + `model=${request.model} session=${sessionIdShort ?? '-'} body_bytes=${requestBodyBytes} `
      + `prompt_cache_key=${promptCacheKey?.slice(0, 12) ?? '-'} `
      + `input_prefix_hash=${requestInputPrefixHash.slice(0, 12)} `
      + `input=${usage?.inputTokens ?? 0} cache_read=${usage?.cacheReadInputTokens ?? 0} `
      + `output=${usage?.outputTokens ?? 0}`,
    );

    yield {
      type: 'completed',
      content,
      toolCalls,
      ...(usage ? { usage } : {}),
      ...(finishReason ? { finishReason } : {}),
      terminalStatus: 'completed',
      ...(responseId ? { responseId } : {}),
      ...(typeof responseExpireAt === 'number' ? { responseExpireAt } : {}),
      ...(actualModel ? { actualModel } : {}),
      responseChained: usePrevious,
      responseMode,
      modelRequestAttemptCount,
      ...(promptCacheKey ? { promptCacheKey } : {}),
      requestInputPrefixHash,
      requestBodyBytes,
    };
  }

  /**
   * P1.2：DELETE /responses/{id} — PIPL 合规闭环，删除服务端存储的 reasoning chain。
   */
  async revoke(responseId: string): Promise<void> {
    const response = await fetch(responsesByIdUrl(this.connection.baseUrl, responseId), {
      method: 'DELETE',
      headers: { authorization: `Bearer ${this.connection.apiKey}` },
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Responses DELETE HTTP ${response.status}: ${text.slice(0, 500)}`);
    }
  }

  /**
   * P1.6：用 GET /responses/{id} 拉回 session state（resume）。
   * 返回的字段供 RawAgentLoop 写回 runtime_runs / session catalog。
   */
  async resumeFromId(responseId: string): Promise<{
    responseId: string;
    expireAtMs?: number;
    actualModel?: string;
  }> {
    const response = await fetch(responsesByIdUrl(this.connection.baseUrl, responseId), {
      method: 'GET',
      headers: { authorization: `Bearer ${this.connection.apiKey}` },
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Responses GET HTTP ${response.status}: ${text.slice(0, 500)}`);
    }
    const data = await response.json() as Record<string, any>;
    return {
      responseId,
      ...(typeof data.expire_at === 'number' ? { expireAtMs: data.expire_at * 1000 } : {}),
      ...(typeof data.model === 'string' ? { actualModel: data.model } : {}),
    };
  }

  /**
   * P1.1 stream 末尾 usage 兜底：fetch 完整响应取 usage。
   */
  private async fetchUsageById(
    responseId: string,
    parentSignal?: AbortSignal,
  ): Promise<ModelUsage | undefined> {
    if (parentSignal?.aborted) return undefined;
    const controller = new AbortController();
    const abortFromParent = () => controller.abort(parentSignal?.reason);
    parentSignal?.addEventListener('abort', abortFromParent, { once: true });
    const timeout = setTimeout(() => controller.abort(new Error('usage fetch timeout')), USAGE_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(responsesByIdUrl(this.connection.baseUrl, responseId), {
        method: 'GET',
        headers: { authorization: `Bearer ${this.connection.apiKey}` },
        signal: controller.signal,
      });
      if (!response.ok) return undefined;
      const data = await response.json() as Record<string, any>;
      return data.usage ? normalizeResponsesUsage(data.usage) : undefined;
    } finally {
      clearTimeout(timeout);
      parentSignal?.removeEventListener('abort', abortFromParent);
    }
  }

  /**
   * 抽取 messages 尾部"user 或 tool"增量作为接力 input。
   * 标准 agent loop 结构：[..., assistant_with_tool_calls, tool_1, tool_2] → 抽取 [tool_1, tool_2]
   *                    [..., assistant_message, user_new] → 抽取 [user_new]
   *
   * user content 走确定性 defense（A3/B2 injection escape + B4 长英文中文 leading）。
   * 时间戳已在 runtime 入站时固化，接力 adapter 不再改写。
   */
  private async extractIncrementalInput(
    messages: ModelChatMessage[],
    cwd: string,
    sessionIdShort?: string,
  ): Promise<ResponsesInputItem[]> {
    const items: ResponsesInputItem[] = [];
    // 从尾部往前找连续的 user/tool
    let i = messages.length - 1;
    while (i >= 0) {
      const m = messages[i]!;
      if (m.role === 'user' || m.role === 'tool') {
        i--;
        continue;
      }
      break;
    }
    const tail = messages.slice(i + 1);
    for (const m of tail) {
      if (m.role === 'user') {
        items.push({
          type: 'message',
          role: 'user',
          content: await this.buildUserContent(m.content, cwd, sessionIdShort),
        });
      } else if (m.role === 'tool') {
        items.push({
          type: 'function_call_output',
          call_id: m.tool_call_id,
          output: m.content,
        });
      }
    }
    return items;
  }

  /**
   * 首轮全量 input 构造：system 走 instructions，其余按 ChatMessage → Responses input items 转换。
   * user content 走确定性 defendUserMessageText（A3/B2 injection escape + B4 长英文中文 leading；
   * 平台注入上下文块只保留 escape）。时间戳已在 runtime 入站时固化，full replay
   * 不得按当前时钟重写历史。
   */
  private async buildFullInput(messages: ModelChatMessage[], cwd: string, sessionIdShort?: string): Promise<{
    instructions?: string;
    input: ResponsesInputItem[];
  }> {
    const systemTexts: string[] = [];
    const items: ResponsesInputItem[] = [];
    for (const m of messages) {
      if (m.role === 'system') {
        systemTexts.push(m.content);
      } else if (m.role === 'user') {
        items.push({
          type: 'message',
          role: 'user',
          content: await this.buildUserContent(m.content, cwd, sessionIdShort),
        });
      } else if (m.role === 'assistant') {
        if (m.tool_calls?.length) {
          if (m.content) {
            items.push({
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: m.content }],
            });
          }
          for (const call of m.tool_calls) {
            items.push({
              type: 'function_call',
              call_id: call.id,
              name: call.function.name,
              arguments: call.function.arguments,
            });
          }
        } else if (m.content) {
          items.push({
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: m.content }],
          });
        }
      } else if (m.role === 'tool') {
        items.push({
          type: 'function_call_output',
          call_id: m.tool_call_id,
          output: m.content,
        });
      }
    }
    return {
      ...(systemTexts.length > 0 ? { instructions: systemTexts.join('\n\n') } : {}),
      input: items,
    };
  }

  private async buildUserContent(
    content: Extract<ModelChatMessage, { role: 'user' }>['content'],
    cwd: string,
    sessionIdShort?: string,
  ): Promise<Extract<ResponsesInputItem, { type: 'message' }>['content']> {
    if (typeof content === 'string') {
      return [{ type: 'input_text', text: defendUserMessageText(content, sessionIdShort) }];
    }
    if (!modelSupportsImage(this.providerOptions.inputModalities)) {
      return [{ type: 'input_text', text: defendUserMessageText(toTextOnlyContent(content), sessionIdShort) }];
    }
    const result: Extract<ResponsesInputItem, { type: 'message' }>['content'] = [];
    for (const part of content) {
      if (part.type === 'vision_summary') continue;
      if (part.type === 'text') {
        result.push({ type: 'input_text', text: defendUserMessageText(part.text, sessionIdShort) });
      } else {
        result.push({
          type: 'input_image',
          image_url: await readModelImageDataUrl(cwd, part),
          detail: part.detail === 'original' ? 'high' : part.detail,
        });
      }
    }
    return result;
  }

  /**
   * Chat Completions tools 格式：{type:"function", function:{name, description, parameters}}
   * Responses tools 格式：    {type:"function", name, description, parameters}（扁平）
   */
  private adaptTools(tools: ModelToolDefinition[]): Array<Record<string, unknown>> {
    return tools.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  /**
   * P1.4：按 modelConfig.toolChoiceModes 校验。
   * 未声明 toolChoiceModes 时不强制（向后兼容）。
   */
  private validateAndNormalizeToolChoice(
    choice: ModelRequest['toolChoice'],
    model: string,
  ): string | object {
    const value = choice ?? 'auto';
    const modes = this.providerOptions.toolChoiceModes;
    if (!modes) return value as string | object;

    let mode: 'auto' | 'required' | 'none' | 'specific';
    if (value === 'auto' || value === 'required' || value === 'none') {
      mode = value;
    } else if (typeof value === 'object' && (value as any).type === 'function') {
      mode = 'specific';
    } else {
      throw new Error(`ResponsesApiAdapter: 未知 tool_choice 值 ${JSON.stringify(value)}`);
    }
    if (!modes.includes(mode)) {
      throw new Error(
        `Model ${model} 不支持 tool_choice=${mode}；支持模式: ${modes.join(',')}。`
        + `（典型：glm-5.2 仅支持 auto/none）`,
      );
    }
    return value as string | object;
  }
}

// ─────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────

type FinishedDiagnostic = Extract<ModelRequestDiagnostic, { type: 'finished' }>;
type FinishedOutcome = FinishedDiagnostic['outcome'];
type FinishedPatch = Partial<Omit<FinishedDiagnostic,
  'type' | 'modelRequestId' | 'attemptId' | 'attempt' | 'outcome' | 'durationMs'>>;

class ResponsesAttemptDiagnostics {
  readonly attemptId = randomUUID();
  readonly clientRequestId = randomUUID();
  private readonly startedAt = Date.now();
  private finishedOnce = false;
  private readonly checkpointsWritten = new Set<'response_created' | 'terminal_received'>();
  private httpStatus: number | undefined;
  private contentType: string | undefined;
  private upstreamRequestId: string | undefined;
  private responseBytes = 0;
  private frameCount = 0;
  private readonly eventTypeCounts: Record<string, number> = {};
  private readonly unknownEventTypes = new Set<string>();
  private receivedDone = false;
  private lastSequenceNumber: number | undefined;
  private terminalEventType: string | undefined;
  private terminalStatus: ModelTerminalStatus | undefined;
  private responseIdHash: string | undefined;
  private incompleteReason: string | undefined;
  private tailBytes: number | undefined;
  private tailHash: string | undefined;

  constructor(
    private readonly context: RunContext,
    private readonly init: {
      modelRequestId: string;
      attempt: number;
      model: string;
      responseMode: ModelResponseMode;
      maxOutputTokens: number;
      requestBodyBytes: number;
      toolsCount: number;
      hasPreviousResponseId: boolean;
    },
  ) {}

  async started(): Promise<void> {
    await this.record({
      type: 'started',
      modelRequestId: this.init.modelRequestId,
      attemptId: this.attemptId,
      attempt: this.init.attempt,
      clientRequestId: this.clientRequestId,
      model: this.init.model,
      protocol: 'responses',
      responseMode: this.init.responseMode,
      maxOutputTokens: this.init.maxOutputTokens,
      requestBodyBytes: this.init.requestBodyBytes,
      toolsCount: this.init.toolsCount,
      hasPreviousResponseId: this.init.hasPreviousResponseId,
    });
  }

  observeHttpResponse(response: Response): void {
    this.httpStatus = response.status;
    this.contentType = compactHeader(response.headers.get('content-type'));
    this.upstreamRequestId = compactHeader(
      response.headers.get('x-request-id')
      ?? response.headers.get('request-id')
      ?? response.headers.get('openai-request-id'),
    );
  }

  observeBytes(bytes: number): void {
    this.responseBytes += Math.max(0, bytes);
  }

  observeFrame(): void {
    this.frameCount += 1;
  }

  observeDone(): void {
    this.receivedDone = true;
  }

  observeEvent(eventType: string, sequenceNumber: unknown): void {
    const normalized = compactDiagnosticToken(eventType, 120) || '(missing)';
    const key = Object.hasOwn(this.eventTypeCounts, normalized)
      || Object.keys(this.eventTypeCounts).length < MAX_DIAGNOSTIC_EVENT_TYPES - 1
      ? normalized
      : '(other)';
    this.eventTypeCounts[key] = (this.eventTypeCounts[key] ?? 0) + 1;
    if (typeof sequenceNumber === 'number' && Number.isFinite(sequenceNumber)) {
      this.lastSequenceNumber = sequenceNumber;
    }
  }

  observeUnknownEvent(eventType: string): void {
    const normalized = compactDiagnosticToken(eventType, 120);
    if (normalized && this.unknownEventTypes.size < MAX_UNKNOWN_EVENT_TYPES) {
      this.unknownEventTypes.add(normalized);
    }
  }

  observeTerminal(
    eventType: string,
    status: ModelTerminalStatus,
    responseId?: string,
    incompleteReason?: string,
  ): void {
    this.terminalEventType = compactDiagnosticToken(eventType, 120);
    this.terminalStatus = status;
    this.responseIdHash = responseId ? hashOpaqueId(responseId) : undefined;
    this.incompleteReason = compactDiagnosticToken(incompleteReason, 200);
  }

  observeTail(tail: string): void {
    this.tailBytes = Buffer.byteLength(tail, 'utf8');
    this.tailHash = createHash('sha256').update(tail).digest('hex').slice(0, 32);
  }

  async checkpoint(
    stage: 'response_created' | 'terminal_received',
    patch: {
      responseId?: string;
      actualModel?: string;
      terminalEventType?: string;
      terminalStatus?: ModelTerminalStatus;
      incompleteReason?: string;
      errorCode?: string;
    } = {},
  ): Promise<void> {
    if (this.checkpointsWritten.has(stage)) return;
    const { responseId, actualModel, terminalEventType, terminalStatus, incompleteReason, errorCode } = patch;
    if (responseId) this.responseIdHash = hashOpaqueId(responseId);
    const recorded = await this.record({
      type: 'checkpoint',
      modelRequestId: this.init.modelRequestId,
      attemptId: this.attemptId,
      attempt: this.init.attempt,
      stage,
      elapsedMs: Date.now() - this.startedAt,
      ...(this.responseIdHash ? { responseIdHash: this.responseIdHash } : {}),
      ...(actualModel ? { actualModel: compactDiagnosticToken(actualModel, 200) } : {}),
      ...(terminalEventType ? { terminalEventType: compactDiagnosticToken(terminalEventType, 120) } : {}),
      ...(terminalStatus ? { terminalStatus } : {}),
      ...(incompleteReason ? { incompleteReason: compactDiagnosticToken(incompleteReason, 200) } : {}),
      ...(errorCode ? { errorCode: compactDiagnosticToken(errorCode, 200) } : {}),
    });
    if (recorded) this.checkpointsWritten.add(stage);
  }

  async finished(outcome: FinishedOutcome, patch: FinishedPatch = {}): Promise<void> {
    if (this.finishedOnce) return;
    const recorded = await this.record({
      type: 'finished',
      modelRequestId: this.init.modelRequestId,
      attemptId: this.attemptId,
      attempt: this.init.attempt,
      outcome,
      durationMs: Date.now() - this.startedAt,
      ...(this.httpStatus !== undefined ? { httpStatus: this.httpStatus } : {}),
      ...(this.contentType ? { contentType: this.contentType } : {}),
      ...(this.upstreamRequestId ? { upstreamRequestId: this.upstreamRequestId } : {}),
      ...(this.responseIdHash ? { responseIdHash: this.responseIdHash } : {}),
      ...(this.responseBytes > 0 ? { responseBytes: this.responseBytes } : {}),
      ...(this.frameCount > 0 ? { frameCount: this.frameCount } : {}),
      ...(Object.keys(this.eventTypeCounts).length > 0 ? { eventTypeCounts: { ...this.eventTypeCounts } } : {}),
      ...(this.unknownEventTypes.size > 0 ? { unknownEventTypes: [...this.unknownEventTypes] } : {}),
      ...(this.receivedDone ? { receivedDone: true } : {}),
      ...(this.lastSequenceNumber !== undefined ? { lastSequenceNumber: this.lastSequenceNumber } : {}),
      ...(this.terminalEventType ? { terminalEventType: this.terminalEventType } : {}),
      ...(this.terminalStatus ? { terminalStatus: this.terminalStatus } : {}),
      ...(this.incompleteReason ? { incompleteReason: this.incompleteReason } : {}),
      ...(this.tailBytes !== undefined ? { tailBytes: this.tailBytes } : {}),
      ...(this.tailHash ? { tailHash: this.tailHash } : {}),
      ...sanitizeFinishedPatch(patch),
    });
    if (recorded) this.finishedOnce = true;
  }

  isFinished(): boolean {
    return this.finishedOnce;
  }

  private async record(event: ModelRequestDiagnostic): Promise<boolean> {
    if (!this.context.recordModelRequestDiagnostic) return true;
    try {
      return await this.context.recordModelRequestDiagnostic(event) !== false;
    } catch (err) {
      logger.warn(`model request diagnostic recorder failed: ${compactDiagnosticMessage(err)}`);
      return false;
    }
  }
}

class ResponsesStreamError extends Error {
  constructor(
    readonly outcome: FinishedOutcome,
    readonly code: string,
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'ResponsesStreamError';
  }
}

class SseFrameBuffer {
  private buffer = '';

  constructor(private readonly maxBytes: number) {}

  push(chunk: string): string[] {
    this.buffer += chunk;
    const blocks: string[] = [];
    while (true) {
      const boundary = /(?:\r\n|\r|\n)(?:\r\n|\r|\n)/.exec(this.buffer);
      if (!boundary || boundary.index === undefined) break;
      const block = this.buffer.slice(0, boundary.index);
      if (Buffer.byteLength(block, 'utf8') > this.maxBytes) {
        throw new ResponsesStreamError(
          'parse_error',
          'MODEL_SSE_FRAME_TOO_LARGE',
          `Responses SSE frame exceeded ${this.maxBytes} bytes`,
        );
      }
      blocks.push(block);
      this.buffer = this.buffer.slice(boundary.index + boundary[0].length);
    }
    if (Buffer.byteLength(this.buffer, 'utf8') > this.maxBytes) {
      throw new ResponsesStreamError(
        'parse_error',
        'MODEL_SSE_FRAME_TOO_LARGE',
        `Responses SSE frame exceeded ${this.maxBytes} bytes`,
      );
    }
    return blocks;
  }

  finish(): string {
    const tail = this.buffer;
    this.buffer = '';
    return tail;
  }
}

function assertReservedExtraBodyKeys(extraBody: Record<string, unknown> | undefined): void {
  if (!extraBody) return;
  const conflicts = Object.keys(extraBody).filter((key) => RESERVED_EXTRA_BODY_KEYS.has(key));
  if (conflicts.length > 0) {
    throw new Error(`ResponsesApiAdapter extraBody cannot override reserved fields: ${conflicts.join(', ')}`);
  }
}

function assertSingleTerminal(previous: string | undefined, next: string): void {
  if (!previous) return;
  throw new ResponsesStreamError(
    'provider_error',
    'MODEL_SSE_MULTIPLE_TERMINALS',
    `Responses SSE emitted multiple terminal events: ${previous}, ${next}`,
  );
}

function normalizeTerminalStatus(value: unknown, fallback: ModelTerminalStatus): ModelTerminalStatus {
  return value === 'completed' || value === 'incomplete' || value === 'failed' || value === 'cancelled'
    ? value
    : fallback;
}

function reconcileTextSnapshot(current: string, snapshot: string, canonicalPresent = true): string {
  if (!canonicalPresent) return '';
  if (snapshot === current) return '';
  if (snapshot.startsWith(current)) return snapshot.slice(current.length);
  throw new ResponsesStreamError(
    'provider_error',
    'MODEL_STREAM_RECONCILIATION_FAILED',
    `Responses terminal text did not match streamed prefix (stream=${current.length}, snapshot=${snapshot.length})`,
  );
}

function parseCanonicalOutput(raw: unknown, present: boolean): {
  present: boolean;
  text: string;
  refusal: string;
  toolCalls: Map<number, ModelToolCall>;
} {
  const result = {
    present,
    text: '',
    refusal: '',
    toolCalls: new Map<number, ModelToolCall>(),
  };
  if (!present) return result;
  if (!Array.isArray(raw)) {
    throw new ResponsesStreamError(
      'provider_error',
      'MODEL_CANONICAL_OUTPUT_INVALID',
      'Responses terminal output must be an array when present',
    );
  }
  raw.forEach((item, outputIndex) => {
    if (!item || typeof item !== 'object') return;
    const obj = item as Record<string, any>;
    if (obj.type === 'message' && Array.isArray(obj.content)) {
      for (const part of obj.content) {
        if (part?.type === 'output_text' && typeof part.text === 'string') result.text += part.text;
        if (part?.type === 'refusal' && typeof part.refusal === 'string') result.refusal += part.refusal;
      }
    } else if (obj.type === 'function_call') {
      const id = typeof obj.call_id === 'string' ? obj.call_id : '';
      const name = typeof obj.name === 'string' ? obj.name : '';
      const args = typeof obj.arguments === 'string' ? obj.arguments : '';
      if (id && name) result.toolCalls.set(outputIndex, { id, name, arguments: args });
    }
  });
  return result;
}

function reconcileToolCallSnapshot(
  streamed: Map<number, ModelToolCall>,
  snapshot: Map<number, ModelToolCall>,
  canonicalPresent = true,
): void {
  if (!canonicalPresent) return;
  if (snapshot.size === 0 && streamed.size > 0) {
    throw new ResponsesStreamError(
      'provider_error',
      'MODEL_TOOL_CALL_RECONCILIATION_FAILED',
      `Responses terminal output was empty after ${streamed.size} streamed tool call(s)`,
    );
  }
  for (const [index, call] of streamed) {
    const canonical = snapshot.get(index);
    if (!canonical
      || canonical.id !== call.id
      || canonical.name !== call.name
      || canonical.arguments !== call.arguments) {
      throw new ResponsesStreamError(
        'provider_error',
        'MODEL_TOOL_CALL_RECONCILIATION_FAILED',
        `Responses terminal tool call did not match streamed item at output_index=${index}`,
      );
    }
  }
  streamed.clear();
  for (const [index, call] of snapshot) streamed.set(index, call);
}

function classifyStreamError(
  err: unknown,
  signal: AbortSignal | undefined,
): { outcome: FinishedOutcome; code: string; message: string } {
  if (signal?.aborted) {
    return { outcome: 'aborted', code: 'MODEL_REQUEST_ABORTED', message: 'Model request was aborted' };
  }
  if (err instanceof ResponsesStreamError) {
    return { outcome: err.outcome, code: err.code, message: compactDiagnosticMessage(err.message) };
  }
  return {
    outcome: 'stream_error',
    code: 'MODEL_STREAM_READ_ERROR',
    message: compactDiagnosticMessage(err),
  };
}

function extractProviderError(text: string): { code?: string; message?: string } {
  try {
    const parsed = JSON.parse(text) as Record<string, any>;
    const error = parsed.error ?? parsed;
    return {
      ...(typeof error?.code === 'string' ? { code: compactDiagnosticMessage(error.code) } : {}),
      ...(typeof error?.message === 'string' ? { message: compactDiagnosticMessage(error.message) } : {}),
    };
  } catch {
    const message = compactDiagnosticMessage(text);
    return message ? { message } : {};
  }
}

function compactDiagnosticMessage(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value ?? '');
  return raw
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-[REDACTED]')
    .replace(/(api[_-]?key\s*[=:]\s*)\S+/gi, '$1[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function compactHeader(value: string | null): string | undefined {
  if (!value) return undefined;
  const compact = value.trim().slice(0, 200);
  return compact || undefined;
}

function compactDiagnosticToken(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const compact = value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, maxLength);
  return compact || undefined;
}

function sanitizeFinishedPatch(patch: FinishedPatch): FinishedPatch {
  return {
    ...patch,
    ...(patch.errorCode ? { errorCode: compactDiagnosticToken(patch.errorCode, 200) } : {}),
    ...(patch.errorMessage ? { errorMessage: compactDiagnosticMessage(patch.errorMessage) } : {}),
  };
}

function hashOpaqueId(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function responsesUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (trimmed.endsWith('/responses')) return trimmed;
  return `${trimmed}/responses`;
}

function responsesByIdUrl(baseUrl: string, responseId: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  const base = trimmed.endsWith('/responses') ? trimmed : `${trimmed}/responses`;
  return `${base}/${encodeURIComponent(responseId)}`;
}

function parseSseFrames(block: string): Array<{ eventName?: string; data: string }> {
  const dataLines: string[] = [];
  let eventName: string | undefined;
  for (const line of block.split(/\r\n|\r|\n/)) {
    if (line.startsWith('event:')) {
      eventName = compactDiagnosticToken(line.slice('event:'.length).trimStart(), 120);
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trimStart());
    }
  }
  return dataLines.length > 0 ? [{ ...(eventName ? { eventName } : {}), data: dataLines.join('\n').trim() }] : [];
}

function normalizeResponsesUsage(raw: Record<string, any>): ModelUsage {
  const inputTokens = numberOrZero(raw.input_tokens);
  const outputTokens = numberOrZero(raw.output_tokens);
  const cacheReadInputTokens = numberOrZero(raw.input_tokens_details?.cached_tokens);
  // reasoning_tokens 是 output_tokens 的子集（output 单价已覆盖），仅用于观测——展示
  // tool loop 内思考量、诊断是不是在重复思考。上游字段名：OpenAI Responses =
  // output_tokens_details.reasoning_tokens；Chat Completions 走 chatCompletionsAdapter。
  const reasoningTokens = numberOrZero(raw.output_tokens_details?.reasoning_tokens);
  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens: 0,
    reasoningTokens,
  };
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function mapResponsesStatusToFinish(status: string, hasToolCalls: boolean): string {
  // Responses status: completed / failed / incomplete / cancelled
  // Chat Completions finish_reason: stop / tool_calls / length / content_filter
  if (status === 'incomplete') return 'length';
  if (hasToolCalls) return 'tool_calls';
  if (status === 'completed') return 'stop';
  return status;
}

/** 测试导出：RESPONSE_TTL_MS（72h），供 RawAgentLoop 计算 expireAt。 */
export { RESPONSE_TTL_MS, MAX_OUTPUT_TOKENS_FLOOR };

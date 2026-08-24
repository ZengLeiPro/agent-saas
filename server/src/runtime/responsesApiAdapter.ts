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

import { ModelProviderError } from './types.js';
import type {
  ModelAdapter,
  ModelChatMessage,
  ModelEvent,
  ModelProviderContinuation,
  ModelRequest,
  ModelToolCall,
  ModelToolDefinition,
  ModelUsage,
  ModelResponseMode,
  ModelTerminalStatus,
  ModelToolSearchResult,
  ModelWireMode,
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
import { resolveModelOutputTransactionMode } from './modelOutputTransaction.js';
import { classifyModelFailure } from './runtimeFailure.js';
import type { FinishedOutcome, FinishedPatch } from './responsesAttemptDiagnostics.js';
import {
  ResponsesAttemptDiagnostics,
  compactDiagnosticCode,
  compactDiagnosticError,
  compactDiagnosticMessage,
  compactDiagnosticToken,
  compactHeader,
} from './responsesAttemptDiagnostics.js';
import { modelSupportsImage, readImagePartOrPlaceholder, toTextOnlyContent } from './imageAttachments.js';
import { ToolCallRepairStreamGate, toolCallRepairProviderLabel } from './toolCallRepair.js';
import { buildResponsesToolImageItems } from './responsesToolImages.js';
import { OpenAICompatibleResponsesTransport } from './responses/openAICompatibleResponsesTransport.js';
import {
  ResponsesTransportStreamError,
  type ProviderContinuationBinding,
  type ResponsesTransport,
  type ResponsesTransportStreamDiagnostic,
} from './responses/responsesTransport.js';
function computeRequestInputPrefixHash(body: Record<string, unknown>): string {
  const input = Array.isArray(body.input) ? body.input.slice(0, 8) : [];
  return createHash('sha256').update(JSON.stringify({
    instructions: body.instructions,
    tools: body.tools,
    input,
  })).digest('hex').slice(0, 32);
}

function computeRequestPrefixDiagnostics(body: Record<string, unknown>): {
  instructionsHash: string;
  toolsHash: string;
  historyHash: string;
} {
  const hash = (value: unknown) => createHash('sha256')
    .update(JSON.stringify(value ?? null))
    .digest('hex')
    .slice(0, 32);
  return {
    instructionsHash: hash(body.instructions),
    toolsHash: hash(body.tools),
    historyHash: hash(body.input),
  };
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

/**
 * 流传输中断类错误：官方终态从未出现，toolCalls 不会交付上层、工具必然未执行，
 * 半截 function_call 参数只存在于本次调用的局部 buffer，重试无副作用。
 */
const STREAM_TRANSPORT_INTERRUPT_CODES = new Set([
  'MODEL_STREAM_READ_ERROR',
  'MODEL_SSE_EOF_WITHOUT_TERMINAL',
  'MODEL_SSE_UNTERMINATED_TAIL',
]);

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
  'parallel_tool_calls',
  'include',
  'text',
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
    namespace?: string;
  }
  | {
    type: 'function_call_output';
    call_id: string;
    output: string;
  }
  | {
    type: 'additional_tools';
    role: 'developer';
    tools: Array<Record<string, unknown>>;
  }
  | {
    type: 'reasoning';
    encrypted_content: string;
    summary?: unknown[];
  };

interface ResponsesRetryState {
  modelRequestId: string;
  lastAttempt: number;
  transientRetryIndex: number;
  maxAttempts: number;
  body: Record<string, unknown>;
  usePrevious: boolean;
  responseMode: ModelResponseMode;
  continuationReplayReset: boolean;
}

export class ResponsesApiAdapter implements ModelAdapter {
  readonly capabilities: { responseState: 'stored' | 'stateless' };
  private readonly transport: ResponsesTransport;

  constructor(
    connection: Required<RuntimeConnection>,
    private readonly providerOptions: ModelProviderOptions = {},
    transport?: ResponsesTransport,
  ) {
    this.transport = transport ?? new OpenAICompatibleResponsesTransport(connection);
    this.capabilities = { responseState: this.transport.capabilities.responseState };
  }

  async *stream(request: ModelRequest, context: RunContext): AsyncIterable<ModelEvent> {
    try {
      for await (const event of this.streamWithRetry(request, context)) {
        if (event.type === 'completed') {
          try {
            this.transport.observeResult?.({
              model: request.model,
              terminalStatus: event.terminalStatus ?? 'completed',
              ...(event.usage ? { usage: event.usage } : {}),
              ...(event.cacheEligible !== undefined ? { cacheEligible: event.cacheEligible } : {}),
              ...(event.errorCode ? { errorCode: event.errorCode } : {}),
            });
          } catch (error) {
            logger.warn(`Responses transport 结果观测失败（不影响模型结果）: ${compactDiagnosticMessage(error)}`);
          }
        }
        yield event;
      }
    } catch (error) {
      try {
        this.transport.observeFailure?.({ model: request.model, error });
      } catch (observeError) {
        logger.warn(`Responses transport 错误观测失败（保留原始错误）: ${compactDiagnosticMessage(observeError)}`);
      }
      throw error;
    }
  }

  private async *streamWithRetry(
    request: ModelRequest,
    context: RunContext,
    retryState?: ResponsesRetryState,
  ): AsyncIterable<ModelEvent> {
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
      && !this.providerOptions.disableResponseChaining
      && this.transport.capabilities.responseState === 'stored';

    const sessionIdShort = context.sessionId ? context.sessionId.slice(0, 8) : undefined;
    // usePrevious 可被降级：上游报 PreviousResponseNotFound（跨模型切换残留 / 服务端已过期）
    // 时切回全量重建 body 重试，不让确定性 400 直接打死整个 run。
    let usePrevious = retryState?.usePrevious ?? hasPrevious;
    let responseMode: ModelResponseMode = retryState?.responseMode ?? (hasPrevious ? 'relay' : 'full');
    const promptCacheKey = this.providerOptions.disablePromptCacheKey
      ? undefined
      : this.transport.computePromptCacheKey({
        model: request.model,
        messages: request.messages,
        tools: request.tools,
        context,
      });
    const expectedContinuationBinding = await this.transport.getContinuationBinding?.();
    const buildRequestBody = async (): Promise<Record<string, unknown>> => {
      const { instructions, input } = usePrevious
        ? { instructions: undefined, input: await this.extractIncrementalInput(request.messages, context.cwd, sessionIdShort) }
        : await this.buildFullInput(
          request.messages,
          context.cwd,
          sessionIdShort,
          request.tools.some((tool) => tool.mcpServer && tool.deferLoading === true),
          expectedContinuationBinding,
        );

      if (usePrevious && input.length === 0) {
        throw new Error(
          'ResponsesApiAdapter: previousResponseId 存在但 messages 尾部没有可接力的 user/tool 增量；'
          + 'RawAgentLoop 调用前请确认增量结构正确。',
        );
      }

      const adaptedTools = this.adaptTools(request.tools);
      const includeToolConfiguration = adaptedTools.length > 0
        || !this.transport.capabilities.omitToolConfigurationWhenEmpty;
      const built: Record<string, unknown> = {
        model: request.model,
        input,
        ...(usePrevious ? { previous_response_id: request.previousResponseId } : {}),
        ...(instructions ? { instructions } : {}),
        ...(includeToolConfiguration ? { tools: adaptedTools } : {}),
        tool_choice: toolChoice,
        ...(this.transport.capabilities.parallelToolCalls ? { parallel_tool_calls: true } : {}),
        ...(this.transport.capabilities.maxOutputTokens ? { max_output_tokens: maxOutputTokens } : {}),
        store: this.transport.capabilities.responseState === 'stored',
        stream: true,
        // prompt_cache_key（07-04）：内容指纹路由。默认传，让相同 system/instructions + tools
        // 的请求命中同一缓存分片（07-04 实测 CLIProxyAPI 会自动生成新 UUID 覆盖 → 缓存永远打散，
        // 显式传稳定 key 后 cached_tokens 命中率 76%+）。disablePromptCacheKey=true 时跳过。
        ...(promptCacheKey ? { prompt_cache_key: promptCacheKey } : {}),
        ...(this.transport.capabilities.encryptedReasoning
          ? {
            include: ['reasoning.encrypted_content'],
            text: { verbosity: 'low' },
          }
          : {}),
        ...(this.providerOptions.extraBody ?? {}),
      };

      // reasoning 字段：伪推理模型不发，避免 Responses+tools 在伪推理模型上 broken（RFC §2.3）
      if (!this.providerOptions.isPseudoReasoning) {
        if (this.providerOptions.thinking !== undefined) built.thinking = this.providerOptions.thinking;
        if (this.providerOptions.reasoningEffort !== undefined) {
          built.reasoning = {
            effort: this.providerOptions.reasoningEffort,
            ...(this.transport.capabilities.encryptedReasoning ? { summary: 'auto' } : {}),
          };
        }
      }
      return built;
    };
    let body = retryState?.body ?? await buildRequestBody();
    let continuationReplayReset = retryState?.continuationReplayReset ?? false;
    let requestBodyBytes = 0;
    let wireMode: ModelWireMode | undefined;
    let wireRequestBodyBytes: number | undefined;
    let wireFallbackReason: string | undefined;
    let requestInputPrefixHash = '';
    let requestInstructionsHash = '';
    let requestToolsHash = '';
    let requestHistoryHash = '';
    let modelRequestAttemptCount = 0;

    const requestSignal = request.signal ?? context.signal;
    const modelRequestId = retryState?.modelRequestId ?? randomUUID();
    const outputTransactionMode = resolveModelOutputTransactionMode(context.channelContext);
    // 默认仍不重试：网络错误/5xx 不能证明上游未接单、未计费。只有模型组显式配置
    // pre_stream_retry_delays_ms 时才启用有限重试。流内额外覆盖 provider 官方
    // 瞬时服务端错误和零输出的 reader 异常；三类故障共用同一份次数与退避预算，
    // 避免重复工具副作用和重试乘法膨胀。
    const retryDelaysMs = this.providerOptions.preStreamRetryDelaysMs ?? [];
    let transientRetryIndex = retryState?.transientRetryIndex ?? 0;
    // previous_response_id 400/404 的全量降级不占瞬时故障重试次数。
    const maxAttempts = retryState?.maxAttempts
      ?? 1
        + retryDelaysMs.length
        + (hasPrevious ? 1 : 0)
        + (bodyContainsEncryptedReasoning(body) ? 1 : 0);
    let response: Response | null = null;
    let responseContinuationBinding = expectedContinuationBinding;
    let activeAttempt: ResponsesAttemptDiagnostics | null = null;
    const firstAttempt = (retryState?.lastAttempt ?? 0) + 1;
    for (let attempt = firstAttempt; attempt <= maxAttempts; attempt++) {
      modelRequestAttemptCount = attempt;
      const serializedBody = JSON.stringify(body);
      requestBodyBytes = Buffer.byteLength(serializedBody, 'utf8');
      requestInputPrefixHash = computeRequestInputPrefixHash(body);
      const prefixDiagnostics = computeRequestPrefixDiagnostics(body);
      requestInstructionsHash = prefixDiagnostics.instructionsHash;
      requestToolsHash = prefixDiagnostics.toolsHash;
      requestHistoryHash = prefixDiagnostics.historyHash;
      // adapter 内部每个真实 transport attempt 都必须重新过计费门禁；
      // RawAgentLoop 的轮级授权只是兼容其他 adapter，不能替代这里的逐请求授权。
      await context.authorizeModelTurn?.();
      const attemptDiagnostics = new ResponsesAttemptDiagnostics(context, {
        modelRequestId,
        attempt,
        model: request.model,
        responseMode,
        outputTransactionMode,
        maxOutputTokens,
        requestBodyBytes,
        toolsCount: request.tools.length,
        hasPreviousResponseId: usePrevious,
      });
      await attemptDiagnostics.started();
      let attemptResponse: Response;
      try {
        const executed = await this.transport.execute({
          serializedBody,
          context,
          clientRequestId: attemptDiagnostics.clientRequestId,
          ...(promptCacheKey ? { promptCacheKey } : {}),
          signal: requestSignal,
          ...(expectedContinuationBinding ? { expectedContinuationBinding } : {}),
        });
        attemptResponse = executed.response;
        wireMode = executed.wireMode;
        wireRequestBodyBytes = executed.wireRequestBodyBytes;
        wireFallbackReason = executed.wireFallbackReason;
        responseContinuationBinding = executed.continuationBinding ?? responseContinuationBinding;
        attemptDiagnostics.observeWireMode(executed.wireMode);
        if (executed.continuationReplayReset) continuationReplayReset = true;
      } catch (err) {
        const aborted = requestSignal?.aborted === true;
        const permanentTransportError = !aborted && isPermanentTransportError(err);
        const retryDelayMs = aborted || permanentTransportError
          ? undefined
          : retryDelaysMs[transientRetryIndex];
        const willRetry = retryDelayMs !== undefined;
        await attemptDiagnostics.finished(
          aborted ? 'aborted' : permanentTransportError ? 'provider_error' : 'network_error',
          {
            errorCode: aborted
              ? 'MODEL_REQUEST_ABORTED'
              : permanentTransportError
                ? 'MODEL_TRANSPORT_PERMANENT_ERROR'
                : 'MODEL_NETWORK_ERROR',
            errorMessage: compactDiagnosticError(err),
            ...(willRetry
              ? { willRetry: true, retryReason: 'transient_network_error' }
              : {
                retryBlockedReason: aborted
                  ? 'aborted'
                  : permanentTransportError
                    ? 'permanent_error'
                    : 'retry_budget_exhausted',
              }),
          },
        );
        if (!willRetry) throw err;
        transientRetryIndex += 1;
        logger.warn(
          `Responses API 发流前网络错误，${retryDelayMs}ms 后重试 `
          + `(${transientRetryIndex}/${retryDelaysMs.length})：${compactDiagnosticError(err)}`,
        );
        await waitForRetry(retryDelayMs, requestSignal);
        continue;
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
          retryReason: 'previous_response_not_found',
        });
        logger.warn(
          `Responses API previous_response_id 不被上游认可（跨模型切换或已过期），降级全量重试 status=${attemptResponse.status}`,
        );
        responseMode = 'fallback_full';
        usePrevious = false;
        body = await buildRequestBody();
        continue;
      }
      const providerError = extractProviderError(text);
      if (
        attempt < maxAttempts
        && !continuationReplayReset
        && isInvalidEncryptedContent(
          attemptResponse.status,
          providerError.code,
          providerError.message ?? text,
        )
      ) {
        const stripped = stripEncryptedReasoning(body);
        if (stripped.changed) {
          await attemptDiagnostics.finished('http_error', {
            errorCode: providerError.code ?? 'INVALID_ENCRYPTED_CONTENT',
            errorMessage: 'Codex rejected prior encrypted reasoning; retrying once without opaque items',
            willRetry: true,
            retryReason: 'invalid_encrypted_content',
          });
          body = stripped.body;
          continuationReplayReset = true;
          logger.warn('Codex encrypted reasoning replay 被拒绝；已剥离旧 opaque item 并重试一次');
          continue;
        }
      }
      const retryableHttp = isRetryablePreStreamHttpError(
        attemptResponse.status,
        providerError.code,
        providerError.message ?? text,
      );
      const providerDiagnosticMessage = providerErrorDiagnosticMessage(
        attemptResponse.status,
        providerError.code,
      );
      const retryDelayMs = retryableHttp ? retryDelaysMs[transientRetryIndex] : undefined;
      const willRetry = retryDelayMs !== undefined && !requestSignal?.aborted;
      const retryBlockedReason = requestSignal?.aborted ? 'aborted' : retryableHttp ? 'retry_budget_exhausted' : 'permanent_error';
      await attemptDiagnostics.finished('http_error', {
        errorCode: providerError.code ?? `HTTP_${attemptResponse.status}`,
        errorMessage: providerDiagnosticMessage,
        ...(willRetry
          ? { willRetry: true, retryReason: 'transient_http_error' }
          : { retryBlockedReason }),
      });
      if (willRetry) {
        transientRetryIndex += 1;
        logger.warn(
          `Responses API HTTP ${attemptResponse.status} 发流前瞬时故障，${retryDelayMs}ms 后重试 `
          + `(${transientRetryIndex}/${retryDelaysMs.length})：`
          + `${providerDiagnosticMessage}`,
        );
        await waitForRetry(retryDelayMs, requestSignal);
        continue;
      }
      const failureProtocol = classifyModelFailure(providerError.code, retryBlockedReason);
      throw new ModelProviderError(
        providerDiagnosticMessage,
        attemptResponse.status,
        providerError.code ?? `HTTP_${attemptResponse.status}`,
        modelRequestId,
        attemptDiagnostics.attemptId,
        0, failureProtocol?.failureKind, failureProtocol?.recoveryAction,
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
    let toolSearchResults: ModelToolSearchResult[] = [];
    // 通道只声明输出事务能力；attempt 的提交/丢弃/撤销和重试由 Runtime 统一执行。
    const commitOutputOnTerminal = outputTransactionMode === 'terminal_buffered';
    const canResetDeliveredOutput = outputTransactionMode === 'replaceable_draft';
    const bufferedOutputEvents: Array<{
      type: 'text_delta' | 'thinking_delta';
      content: string;
    }> = [];
    const toolCallRepair = new ToolCallRepairStreamGate(this.providerOptions.toolCallRepair ?? 'off');
    let hasDeliveredOutput = false;
    let emittedOutputCount = 0;
    const observedStructuredOutputs = new Set<string>();
    const markStructuredOutput = (kind: string, outputIndex: number) => {
      const key = `${kind}:${outputIndex}`;
      if (observedStructuredOutputs.has(key)) return;
      observedStructuredOutputs.add(key);
      emittedOutputCount += 1;
    };
    const markToolCallOutput = (outputIndex: number) => markStructuredOutput('function_call', outputIndex);

    // function_call 在 stream 里按 output_index 累积；item 整体在 output_item.done 出现
    const toolCallsByIndex = new Map<number, ModelToolCall>();
    const functionCallArgsBuffer = new Map<number, {
      call_id: string;
      name: string;
      arguments: string;
      namespace?: string;
    }>();
    let sawNativeFunctionCall = false;
    const outputTextByPart = new Map<string, string>();
    const encryptedReasoningItems: ModelProviderContinuation['items'] = [];
    let pendingToolSearchPaths: string[] = [];

    const decoder = new TextDecoder();
    let reader: ReadableStreamDefaultReader<Uint8Array>;
    try {
      reader = response.body.getReader();
    } catch (err) {
      await activeAttempt.finished('stream_error', {
        errorCode: 'MODEL_STREAM_READER_ACQUIRE_ERROR',
        errorMessage: compactDiagnosticError(err),
      });
      throw err;
    }
    const frames = new SseFrameBuffer(MAX_SSE_BUFFER_BYTES);
    let streamReadSettled = false;
    let canonicalTextSuffix = '';
    let pendingStreamReadRetry: {
      delayMs: number;
      errorCode: string;
      errorMessage: string;
      resetDeliveredDraft: boolean;
    } | undefined;

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
                emittedOutputCount += 1;
                const partKey = responseTextPartKey(event);
                outputTextByPart.set(partKey, (outputTextByPart.get(partKey) ?? '') + delta);
                content += delta;
                for (const visibleDelta of toolCallRepair.push(delta)) {
                  if (commitOutputOnTerminal) {
                    bufferedOutputEvents.push({ type: 'text_delta', content: visibleDelta });
                  } else {
                    hasDeliveredOutput = true;
                    yield { type: 'text_delta', content: visibleDelta };
                  }
                }
              }
            } else if (eventType === 'response.reasoning_summary_text.delta') {
              // 公开派模型（glm 在带 tools 复杂 agent loop 时激活）发 reasoning summary；
              // 隐藏派（doubao/minimax）此事件不出现但 reasoning_tokens 仍计费
              const delta = typeof event.delta === 'string' ? event.delta : '';
              if (delta) {
                emittedOutputCount += 1;
                if (commitOutputOnTerminal) {
                  bufferedOutputEvents.push({ type: 'thinking_delta', content: delta });
                } else {
                  hasDeliveredOutput = true;
                  yield { type: 'thinking_delta', content: delta };
                }
              }
            } else if (eventType === 'response.output_text.done') {
              const doneText = typeof event.text === 'string' ? event.text : '';
              const partKey = responseTextPartKey(event);
              const partContent = outputTextByPart.get(partKey) ?? '';
              const suffix = reconcileTextSnapshot(partContent, doneText);
              outputTextByPart.set(partKey, partContent + suffix);
              if (suffix) {
                emittedOutputCount += 1;
                content += suffix;
                for (const visibleDelta of toolCallRepair.push(suffix)) {
                  if (commitOutputOnTerminal) {
                    bufferedOutputEvents.push({ type: 'text_delta', content: visibleDelta });
                  } else {
                    hasDeliveredOutput = true;
                    yield { type: 'text_delta', content: visibleDelta };
                  }
                }
              }
            } else if (eventType === 'response.refusal.delta') {
              if (typeof event.delta === 'string' && event.delta) {
                emittedOutputCount += 1;
                refusal += event.delta;
              }
            } else if (eventType === 'response.refusal.done') {
              if (typeof event.refusal === 'string' && event.refusal) {
                if (!refusal) emittedOutputCount += 1;
                refusal = event.refusal;
              }
            } else if (eventType === 'response.function_call_arguments.delta') {
              sawNativeFunctionCall = true;
              const outputIndex: number = typeof event.output_index === 'number' ? event.output_index : 0;
              const delta = typeof event.delta === 'string' ? event.delta : '';
              if (delta) markToolCallOutput(outputIndex);
              const buf = functionCallArgsBuffer.get(outputIndex) ?? { call_id: '', name: '', arguments: '' };
              buf.arguments += delta;
              functionCallArgsBuffer.set(outputIndex, buf);
            } else if (eventType === 'response.output_item.added') {
              const item = event.item;
              if (item?.type === 'function_call') {
                sawNativeFunctionCall = true;
                const outputIndex: number = typeof event.output_index === 'number' ? event.output_index : 0;
                markToolCallOutput(outputIndex);
                const buf = functionCallArgsBuffer.get(outputIndex) ?? { call_id: '', name: '', arguments: '' };
                if (typeof item.call_id === 'string') buf.call_id = item.call_id;
                if (typeof item.name === 'string') buf.name = item.name;
                if (typeof item.arguments === 'string') buf.arguments = item.arguments;
                if (typeof item.namespace === 'string') buf.namespace = item.namespace;
                functionCallArgsBuffer.set(outputIndex, buf);
              } else if (item?.type === 'tool_search_call' || item?.type === 'tool_search_output') {
                const outputIndex: number = typeof event.output_index === 'number' ? event.output_index : 0;
                markStructuredOutput(item.type, outputIndex);
              }
            } else if (eventType === 'response.output_item.done') {
              const item = event.item;
              const outputIndex: number = typeof event.output_index === 'number' ? event.output_index : 0;
              if (item?.type === 'function_call') {
                sawNativeFunctionCall = true;
                markToolCallOutput(outputIndex);
                const buf = functionCallArgsBuffer.get(outputIndex) ?? { call_id: '', name: '', arguments: '' };
                const callId = (typeof item.call_id === 'string' && item.call_id) || buf.call_id;
                const name = (typeof item.name === 'string' && item.name) || buf.name;
                const args = (typeof item.arguments === 'string' && item.arguments) || buf.arguments;
                const namespace = (typeof item.namespace === 'string' && item.namespace) || buf.namespace;
                if (callId && name) {
                  toolCallsByIndex.set(outputIndex, {
                    id: callId,
                    name,
                    arguments: args,
                    ...(namespace ? { namespace } : {}),
                  });
                }
              } else if (
                item?.type === 'reasoning'
                && typeof item.encrypted_content === 'string'
                && item.encrypted_content.length > 0
              ) {
                encryptedReasoningItems.push({
                  type: 'reasoning',
                  encrypted_content: item.encrypted_content,
                  ...(Array.isArray(item.summary) ? { summary: item.summary } : {}),
                });
              } else if (item?.type === 'tool_search_call') {
                markStructuredOutput(item.type, outputIndex);
                pendingToolSearchPaths = Array.isArray(item.arguments?.paths)
                  ? item.arguments.paths.filter((path: unknown): path is string => typeof path === 'string')
                  : [];
              } else if (item?.type === 'tool_search_output') {
                markStructuredOutput(item.type, outputIndex);
                toolSearchResults.push({
                  execution: item.execution === 'client' ? 'client' : 'server',
                  ...(typeof item.call_id === 'string' ? { callId: item.call_id } : {}),
                  paths: pendingToolSearchPaths,
                  loadedToolNames: extractLoadedToolNames(item.tools),
                });
                pendingToolSearchPaths = [];
              }
            } else if (eventType === 'response.completed' || eventType === 'response.done') {
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
              const terminalOutputFieldPresent = !!respObj
                && typeof respObj === 'object'
                && Object.hasOwn(respObj, 'output');
              const canonicalOutputPresent = this.transport.capabilities.terminalOutput === 'canonical'
                ? terminalOutputFieldPresent
                : Array.isArray(respObj?.output) && respObj.output.length > 0;
              if (Array.isArray(respObj?.output)
                && respObj.output.some((item: unknown) => (
                  item !== null
                  && typeof item === 'object'
                  && (item as Record<string, unknown>).type === 'function_call'
                ))) {
                sawNativeFunctionCall = true;
              }
              const snapshot = parseCanonicalOutput(respObj?.output, canonicalOutputPresent);
              canonicalTextSuffix = reconcileTextSnapshot(content, snapshot.text, snapshot.present);
              if (snapshot.refusal) refusal = snapshot.refusal;
              if (snapshot.present) toolSearchResults = snapshot.toolSearchResults;
              if (encryptedReasoningItems.length === 0 && snapshot.reasoningItems.length > 0) {
                encryptedReasoningItems.push(...snapshot.reasoningItems);
              }
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
              providerErrorCode = compactDiagnosticCode(respObj?.error?.code) ?? 'MODEL_RESPONSE_FAILED';
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
              providerErrorCode = compactDiagnosticCode(event.code ?? event.error?.code)
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
        emittedOutputCount += 1;
        content += canonicalTextSuffix;
        for (const visibleDelta of toolCallRepair.push(canonicalTextSuffix)) {
          if (commitOutputOnTerminal) {
            bufferedOutputEvents.push({ type: 'text_delta', content: visibleDelta });
          } else {
            hasDeliveredOutput = true;
            yield { type: 'text_delta', content: visibleDelta };
          }
        }
      }
      streamReadSettled = true;
    } catch (err) {
      const classified = classifyStreamError(err, requestSignal);
      const transportInterrupted = STREAM_TRANSPORT_INTERRUPT_CODES.has(classified.code)
        && !requestSignal?.aborted;
      const replaySafe = !hasDeliveredOutput
        || commitOutputOnTerminal
        || canResetDeliveredOutput;
      const retryDelayMs = transportInterrupted && replaySafe
        ? retryDelaysMs[transientRetryIndex]
        : undefined;
      const willRetry = retryDelayMs !== undefined;
      const resetDeliveredDraft = willRetry && hasDeliveredOutput && canResetDeliveredOutput;
      const retryBlockedReason = requestSignal?.aborted
        ? 'aborted'
        : !transportInterrupted
          ? 'permanent_error'
          : !replaySafe
            ? 'irreversible_output_delivered'
            : 'retry_budget_exhausted';
      await reader.cancel().catch(() => undefined);
      await activeAttempt.finished(classified.outcome, {
        errorCode: classified.code,
        errorMessage: classified.message,
        usage,
        hasDeliveredOutput,
        officialTerminalReceived: false,
        ...transportDiagnosticPatch(classified.transportDiagnostic),
        ...(willRetry
          ? { willRetry: true, retryReason: 'transient_stream_interrupt' }
          : { retryBlockedReason }),
      });
      streamReadSettled = true;
      if (!willRetry) {
        // Preserve an incomplete candidate on an unretried Web/API error. Retryable attempts stay
        // transactional and are replaced by the recursive attempt instead of leaking stale text.
        for (const visibleDelta of toolCallRepair.abort()) {
          if (commitOutputOnTerminal) {
            bufferedOutputEvents.push({ type: 'text_delta', content: visibleDelta });
          } else {
            hasDeliveredOutput = true;
            yield { type: 'text_delta', content: visibleDelta };
          }
        }
        throw err;
      }
      pendingStreamReadRetry = {
        delayMs: retryDelayMs,
        errorCode: classified.code,
        errorMessage: classified.message,
        resetDeliveredDraft,
      };
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

    if (pendingStreamReadRetry) {
      transientRetryIndex += 1;
      logger.warn(
        `Responses API 流传输中断 ${pendingStreamReadRetry.errorCode}`
        + `${pendingStreamReadRetry.resetDeliveredDraft ? '，撤销已交付草稿后，' : '，丢弃未提交 attempt 后，'}`
        + `${pendingStreamReadRetry.delayMs}ms 后重试 `
        + `(${transientRetryIndex}/${retryDelaysMs.length})：${pendingStreamReadRetry.errorMessage}`,
      );
      if (pendingStreamReadRetry.resetDeliveredDraft) {
        yield { type: 'draft_reset', attempt: modelRequestAttemptCount };
      }
      await waitForRetry(pendingStreamReadRetry.delayMs, requestSignal);
      yield* this.streamWithRetry(request, context, {
        modelRequestId,
        lastAttempt: modelRequestAttemptCount,
        transientRetryIndex,
        maxAttempts,
        body,
        usePrevious,
        responseMode,
        continuationReplayReset,
      });
      return;
    }

    if (!terminalEventType || !terminalStatus) {
      throw new ResponsesStreamError(
        'provider_error',
        'MODEL_SSE_TERMINAL_STATE_MISSING',
        'Responses SSE terminal state was not recorded',
      );
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
      const providerClassificationMessage = providerErrorMessage ?? 'Responses API response failed';
      const errorMessage = refusal
        ? 'Responses API returned a refusal'
        : terminalStatus === 'incomplete'
          ? `Responses API response incomplete: reason=${incompleteReason ?? 'unknown'}`
          : providerErrorDiagnosticMessage(response.status, errorCode);
      const transientTerminal = isRetryableStreamTerminalError(
        terminalEventType,
        terminalStatus,
        errorCode,
        providerClassificationMessage,
      );
      const replaySafe = !hasDeliveredOutput
        || commitOutputOnTerminal
        || canResetDeliveredOutput;
      const retryableTerminal = transientTerminal && !requestSignal?.aborted && replaySafe;
      const retryDelayMs = retryableTerminal ? retryDelaysMs[transientRetryIndex] : undefined;
      if (retryDelayMs !== undefined) {
        await activeAttempt.finished(outcome, {
          errorCode,
          errorMessage,
          usage,
          hasDeliveredOutput,
          officialTerminalReceived: true,
          willRetry: true,
          retryReason: 'transient_provider_error',
        });
        transientRetryIndex += 1;
        logger.warn(
          `Responses API 流内 ${terminalEventType} ${errorCode}`
          + `${hasDeliveredOutput ? '，撤销已交付草稿后，' : '，丢弃未提交 attempt 后，'}`
          + `${retryDelayMs}ms 后重试 (${transientRetryIndex}/${retryDelaysMs.length})：${errorMessage}`,
        );
        if (hasDeliveredOutput && canResetDeliveredOutput) {
          yield { type: 'draft_reset', attempt: modelRequestAttemptCount };
        }
        await waitForRetry(retryDelayMs, requestSignal);
        yield* this.streamWithRetry(request, context, {
          modelRequestId,
          lastAttempt: modelRequestAttemptCount,
          transientRetryIndex,
          maxAttempts,
          body,
          usePrevious,
          responseMode,
          continuationReplayReset,
        });
        return;
      }
      const retryBlockedReason = requestSignal?.aborted ? 'aborted' : !transientTerminal ? 'permanent_error' : !replaySafe ? 'irreversible_output_delivered' : 'retry_budget_exhausted';
      await activeAttempt.finished(outcome, {
        errorCode,
        errorMessage,
        usage,
        hasDeliveredOutput,
        officialTerminalReceived: true,
        retryBlockedReason,
      });
      const failureProtocol = classifyModelFailure(errorCode, retryBlockedReason);
      yield {
        type: 'completed',
        content,
        toolCalls: [],
        ...(usage ? { usage } : {}),
        ...(finishReason ? { finishReason } : {}),
        terminalStatus: failureStatus,
        ...(incompleteReason ? { incompleteReason } : {}),
        errorCode,
        errorMessage,
        ...(failureProtocol ?? {}),
        modelRequestId,
        attemptId: activeAttempt.attemptId,
        emittedOutputCount,
        providerStatus: response.status,
        responseChained: usePrevious,
        responseMode,
        modelRequestAttemptCount,
        ...(promptCacheKey ? { promptCacheKey } : {}),
        requestInputPrefixHash,
        requestInstructionsHash,
        requestToolsHash,
        requestHistoryHash,
        cacheEligible: (usage?.inputTokens ?? 0) >= 1_024,
        requestBodyBytes,
        ...(wireMode ? { wireMode } : {}),
        ...(wireRequestBodyBytes !== undefined ? { wireRequestBodyBytes } : {}),
        ...(wireFallbackReason ? { wireFallbackReason } : {}),
      };
      return;
    }

    // P1.1：stream 末尾 chunk usage 永远 null（RFC §2.4），用 GET /responses/{id} 兜底
    if (!usage && responseId && this.transport.capabilities.usageLookup) {
      const fetched = await this.fetchUsageById(responseId, requestSignal).catch((err) => {
        logger.warn(`fetchUsageById 失败 responseId=${responseId.slice(0, 12)}: ${compactDiagnosticError(err)}`);
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
    // 日志只记录短错误码/模型元数据；DSML 正文可能包含工具参数或 Secret，绝不写 preview。
    if (detectDsmlLeak(content)) {
      logger.warn(`DSML leak rejected in Responses output_text model=${request.model}`);
      await activeAttempt.finished('provider_error', {
        errorCode: 'MODEL_OUTPUT_DSML_LEAK',
        errorMessage: 'Model output contained an unparsed DSML template',
        usage,
      });
      throw new Error('模型输出格式异常（DSML 模板未被服务端解析），已中断本轮。');
    }

    // C1：mojibake 检测告警（仅 warn，不修复；不记录正文 preview）。
    {
      const moji = detectMojibake(content);
      if (moji.hit) {
        logger.warn(`Mojibake detected in Responses output_text samples=${moji.sampleCount} model=${request.model}`);
      }
    }

    // D1：deepseek arguments 双层 escape 反转（仅在 providerOptions 标记开启的模型路径）。
    const toolCallsRaw = Array.from(toolCallsByIndex.values()).filter((c) => c.name);
    const nativeToolCalls = this.providerOptions.applyDeepseekArgumentUnescape
      ? toolCallsRaw.map((c) => ({ ...c, arguments: unescapeDeepseekArguments(c.arguments) }))
      : toolCallsRaw;
    const repair = toolCallRepair.finish({
      text: content,
      allowedToolNames: request.tools.map((tool) => tool.name),
      nativeToolCallsPresent: sawNativeFunctionCall || nativeToolCalls.length > 0,
      provider: toolCallRepairProviderLabel(context.modelRef),
      model: request.model,
      requestSeed: `${context.runId}:${requestHistoryHash}:${requestToolsHash}`,
    });
    for (const visibleText of repair.visibleText) {
      if (commitOutputOnTerminal) {
        bufferedOutputEvents.push({ type: 'text_delta', content: visibleText });
      } else {
        hasDeliveredOutput = true;
        yield { type: 'text_delta', content: visibleText };
      }
    }
    const toolCalls = nativeToolCalls.length > 0 ? nativeToolCalls : repair.promotedToolCalls;
    const completedContent = repair.scrubbed ? '' : content;
    const providerContinuation = encryptedReasoningItems.length > 0 && responseContinuationBinding
      ? {
        ...responseContinuationBinding,
        items: encryptedReasoningItems,
      } satisfies ModelProviderContinuation
      : undefined;

    await activeAttempt.finished('completed', {
      usage,
      hasDeliveredOutput,
      officialTerminalReceived: true,
    });

    logger.info(
      `Responses 请求完成 mode=${responseMode} attempts=${modelRequestAttemptCount} `
      + `model=${request.model} session=${sessionIdShort ?? '-'} body_bytes=${requestBodyBytes} `
      + `wire=${wireMode ?? '-'} wire_bytes=${wireRequestBodyBytes ?? requestBodyBytes} `
      + `prompt_cache_key=${promptCacheKey?.slice(0, 12) ?? '-'} `
      + `input_prefix_hash=${requestInputPrefixHash.slice(0, 12)} `
      + `input=${usage?.inputTokens ?? 0} cache_read=${usage?.cacheReadInputTokens ?? 0} `
      + `output=${usage?.outputTokens ?? 0}`,
    );

    for (const bufferedEvent of bufferedOutputEvents) {
      yield bufferedEvent;
    }

    yield {
      type: 'completed',
      content: completedContent,
      toolCalls,
      ...(usage ? { usage } : {}),
      ...(finishReason ? { finishReason } : {}),
      terminalStatus: 'completed',
      ...(responseId && repair.promotedToolCalls.length === 0 ? { responseId } : {}),
      ...(repair.promotedToolCalls.length > 0 ? { responseStateReset: true } : {}),
      ...(typeof responseExpireAt === 'number' ? { responseExpireAt } : {}),
      ...(actualModel ? { actualModel } : {}),
      responseChained: usePrevious,
      responseMode,
      modelRequestAttemptCount,
      ...(promptCacheKey ? { promptCacheKey } : {}),
      requestInputPrefixHash,
      requestInstructionsHash,
      requestToolsHash,
      requestHistoryHash,
      cacheEligible: (usage?.inputTokens ?? 0) >= 1_024,
      requestBodyBytes,
      ...(wireMode ? { wireMode } : {}),
      ...(wireRequestBodyBytes !== undefined ? { wireRequestBodyBytes } : {}),
      ...(wireFallbackReason ? { wireFallbackReason } : {}),
      ...(toolSearchResults.length > 0 ? { toolSearchResults } : {}),
      ...(providerContinuation ? { providerContinuation } : {}),
      ...(continuationReplayReset ? { providerContinuationReset: true } : {}),
    };
    return;
  }
  /**
   * P1.2：DELETE /responses/{id} — PIPL 合规闭环，删除服务端存储的 reasoning chain。
   */
  async revoke(responseId: string): Promise<void> {
    if (!this.transport.capabilities.responseDelete || !this.transport.deleteResponse) {
      throw new Error(`Responses transport ${this.transport.id} 不支持 DELETE response`);
    }
    const response = await this.transport.deleteResponse(responseId);
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
    if (this.transport.capabilities.responseState !== 'stored' || !this.transport.getResponse) {
      throw new Error(`Responses transport ${this.transport.id} 不支持 GET response`);
    }
    const response = await this.transport.getResponse(responseId);
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
      if (!this.transport.capabilities.usageLookup || !this.transport.getResponse) return undefined;
      const response = await this.transport.getResponse(responseId, controller.signal);
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
        items.push(...await buildResponsesToolImageItems({ message: m, cwd, sessionIdShort, inputModalities: this.providerOptions.inputModalities }));
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
  private async buildFullInput(
    messages: ModelChatMessage[],
    cwd: string,
    sessionIdShort?: string,
    allowAdditionalTools = false,
    expectedContinuationBinding?: ProviderContinuationBinding,
  ): Promise<{
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
        if (
          m.provider_continuation
          && expectedContinuationBinding
          && continuationMatches(m.provider_continuation, expectedContinuationBinding)
        ) {
          for (const item of m.provider_continuation.items) {
            if (item.type !== 'reasoning' || !item.encrypted_content) continue;
            items.push({
              type: 'reasoning',
              encrypted_content: item.encrypted_content,
              ...(Array.isArray(item.summary) ? { summary: item.summary } : {}),
            });
          }
        }
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
              ...(call.namespace ? { namespace: call.namespace } : {}),
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
        items.push(...await buildResponsesToolImageItems({ message: m, cwd, sessionIdShort, inputModalities: this.providerOptions.inputModalities }));
      } else if (m.role === 'additional_tools' && allowAdditionalTools) {
        items.push({
          type: 'additional_tools',
          role: 'developer',
          tools: this.adaptLoadedTools(m.tools),
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
        const dataUrl = await readImagePartOrPlaceholder(cwd, part);
        if (typeof dataUrl !== 'string') {
          result.push({ type: 'input_text', text: defendUserMessageText(dataUrl.placeholder, sessionIdShort) });
          continue;
        }
        result.push({
          type: 'input_image',
          image_url: dataUrl,
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
    const deferredMcp = tools.filter((tool) => tool.mcpServer && tool.deferLoading === true);
    const ordinary = tools
      .filter((tool) => !tool.mcpServer || tool.deferLoading !== true)
      .map((tool) => this.adaptFunction(tool));
    const namespaces = this.adaptMcpNamespaces(deferredMcp);
    return namespaces.length > 0
      ? [...ordinary, ...namespaces, { type: 'tool_search' }]
      : ordinary;
  }

  private adaptLoadedTools(tools: ModelToolDefinition[]): Array<Record<string, unknown>> {
    const ordinary = tools.filter((tool) => !tool.mcpServer).map((tool) => this.adaptFunction(tool));
    return [...ordinary, ...this.adaptMcpNamespaces(tools.filter((tool) => tool.mcpServer))];
  }

  private adaptMcpNamespaces(tools: ModelToolDefinition[]): Array<Record<string, unknown>> {
    const grouped = new Map<string, { definition: NonNullable<ModelToolDefinition['mcpServer']>; tools: ModelToolDefinition[] }>();
    for (const tool of tools) {
      if (!tool.mcpServer) continue;
      const group = grouped.get(tool.mcpServer.namespace) ?? { definition: tool.mcpServer, tools: [] };
      group.tools.push(tool);
      grouped.set(tool.mcpServer.namespace, group);
    }
    return [...grouped.values()].map(({ definition, tools: namespaceTools }) => ({
      type: 'namespace',
      name: definition.namespace,
      description: definition.description,
      tools: namespaceTools.map((tool) => this.adaptFunction(tool)),
    }));
  }

  private adaptFunction(tool: ModelToolDefinition): Record<string, unknown> {
    return {
      type: 'function',
      name: tool.name,
      description: tool.description,
      ...(tool.deferLoading ? { defer_loading: true } : {}),
      parameters: tool.parameters,
    };
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

function continuationMatches(
  continuation: ModelProviderContinuation,
  expected: ProviderContinuationBinding,
): boolean {
  return continuation.provider === expected.provider
    && continuation.issuer === expected.issuer
    && continuation.accountBindingHash === expected.accountBindingHash;
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

function responseTextPartKey(event: Record<string, any>): string {
  const outputIndex = typeof event.output_index === 'number' ? event.output_index : undefined;
  const contentIndex = typeof event.content_index === 'number' ? event.content_index : undefined;
  if (outputIndex !== undefined && contentIndex !== undefined) return `${outputIndex}:${contentIndex}`;
  const itemId = typeof event.item_id === 'string' ? event.item_id : '';
  if (itemId) return `${itemId}:${contentIndex ?? 0}`;
  return `${outputIndex ?? 0}:${contentIndex ?? 0}`;
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
  toolSearchResults: ModelToolSearchResult[];
  reasoningItems: ModelProviderContinuation['items'];
} {
  const result = {
    present,
    text: '',
    refusal: '',
    toolCalls: new Map<number, ModelToolCall>(),
    toolSearchResults: [] as ModelToolSearchResult[],
    reasoningItems: [] as ModelProviderContinuation['items'],
  };
  if (!present) return result;
  if (!Array.isArray(raw)) {
    throw new ResponsesStreamError(
      'provider_error',
      'MODEL_CANONICAL_OUTPUT_INVALID',
      'Responses terminal output must be an array when present',
    );
  }
  let pendingPaths: string[] = [];
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
      const namespace = typeof obj.namespace === 'string' ? obj.namespace : undefined;
      if (id && name) result.toolCalls.set(outputIndex, {
        id,
        name,
        arguments: args,
        ...(namespace ? { namespace } : {}),
      });
    } else if (
      obj.type === 'reasoning'
      && typeof obj.encrypted_content === 'string'
      && obj.encrypted_content.length > 0
    ) {
      result.reasoningItems.push({
        type: 'reasoning',
        encrypted_content: obj.encrypted_content,
        ...(Array.isArray(obj.summary) ? { summary: obj.summary } : {}),
      });
    } else if (obj.type === 'tool_search_call') {
      pendingPaths = Array.isArray(obj.arguments?.paths)
        ? obj.arguments.paths.filter((path: unknown): path is string => typeof path === 'string')
        : [];
    } else if (obj.type === 'tool_search_output') {
      result.toolSearchResults.push({
        execution: obj.execution === 'client' ? 'client' : 'server',
        ...(typeof obj.call_id === 'string' ? { callId: obj.call_id } : {}),
        paths: pendingPaths,
        loadedToolNames: extractLoadedToolNames(obj.tools),
      });
      pendingPaths = [];
    }
  });
  return result;
}

function extractLoadedToolNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const tool = item as Record<string, unknown>;
    if (tool.type === 'function' && typeof tool.name === 'string') {
      names.push(tool.name);
      continue;
    }
    if (tool.type !== 'namespace' || !Array.isArray(tool.tools)) continue;
    for (const nested of tool.tools) {
      if (!nested || typeof nested !== 'object') continue;
      const nestedTool = nested as Record<string, unknown>;
      if (nestedTool.type === 'function' && typeof nestedTool.name === 'string') names.push(nestedTool.name);
    }
  }
  return names;
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
      || canonical.arguments !== call.arguments
      || canonical.namespace !== call.namespace) {
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
): {
  outcome: FinishedOutcome;
  code: string;
  message: string;
  transportDiagnostic?: ResponsesTransportStreamDiagnostic;
} {
  if (signal?.aborted) {
    return { outcome: 'aborted', code: 'MODEL_REQUEST_ABORTED', message: 'Model request was aborted' };
  }
  if (err instanceof ResponsesStreamError) {
    return { outcome: err.outcome, code: err.code, message: compactDiagnosticMessage(err.message) };
  }
  return {
    outcome: 'stream_error',
    code: 'MODEL_STREAM_READ_ERROR',
    message: compactDiagnosticError(err),
    ...(err instanceof ResponsesTransportStreamError ? { transportDiagnostic: err.diagnostic } : {}),
  };
}

function transportDiagnosticPatch(
  diagnostic: ResponsesTransportStreamDiagnostic | undefined,
): FinishedPatch {
  if (!diagnostic) return {};
  return {
    wireMode: diagnostic.wireMode,
    webSocketErrorEmpty: diagnostic.webSocketErrorEmpty,
    ...(diagnostic.closeCode !== undefined ? { webSocketCloseCode: diagnostic.closeCode } : {}),
    ...(diagnostic.closeReason
      ? { webSocketCloseReason: compactDiagnosticMessage(diagnostic.closeReason) }
      : {}),
    webSocketRequestDurationMs: diagnostic.requestDurationMs,
    webSocketFrameCount: diagnostic.frameCount,
    ...(diagnostic.lastSequenceNumber !== undefined
      ? { webSocketLastSequenceNumber: diagnostic.lastSequenceNumber }
      : {}),
    officialTerminalReceived: diagnostic.officialTerminalReceived,
  };
}

function providerErrorDiagnosticMessage(status: number, code: string | undefined): string {
  const candidate = compactDiagnosticToken(code, 120);
  const safeCode = candidate && /^[A-Za-z0-9_.:-]+$/.test(candidate) ? candidate : undefined;
  if (safeCode?.toLowerCase() === 'invalid_prompt') {
    return `Responses API HTTP ${status}: Request blocked by provider`;
  }
  return `Responses API HTTP ${status}${safeCode ? ` (${safeCode})` : ''}`;
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

function bodyContainsEncryptedReasoning(body: Record<string, unknown>): boolean {
  return Array.isArray(body.input) && body.input.some((item) => (
    !!item
    && typeof item === 'object'
    && (item as Record<string, unknown>).type === 'reasoning'
    && typeof (item as Record<string, unknown>).encrypted_content === 'string'
  ));
}

function stripEncryptedReasoning(body: Record<string, unknown>): {
  body: Record<string, unknown>;
  changed: boolean;
} {
  if (!Array.isArray(body.input)) return { body, changed: false };
  const input = body.input.filter((item) => !(
    !!item
    && typeof item === 'object'
    && (item as Record<string, unknown>).type === 'reasoning'
  ));
  if (input.length === body.input.length) return { body, changed: false };
  return { body: { ...body, input }, changed: true };
}

function isInvalidEncryptedContent(status: number, code: string | undefined, message: string): boolean {
  if (status !== 400) return false;
  return /invalid[_\s-]?encrypted[_\s-]?content/i.test(`${code ?? ''} ${message}`);
}

// 429 里额度/配额耗尽类：需要人工充值或扩配额才能恢复，重试只会连续撞同一堵墙。
// 限流（RPM/TPM）、服务过载、模型加载中都不属于这一类，退避后通常可恢复。
function isQuotaExhausted(code: string | undefined, message: string): boolean {
  return /quota[_\s-]?exceeded|insufficient[_\s-]?quota|exhausted its free trial|额度(?:已)?(?:用尽|耗尽)/i
    .test(`${code ?? ''} ${message}`);
}

function isPermanentTransportError(error: unknown): boolean {
  if (error instanceof ModelProviderError) {
    return error.status === 400 || error.status === 401 || error.status === 403 || error.status === 404;
  }
  const message = compactDiagnosticMessage(error);
  if (/Codex subscription (?:transport 未启用|尚未完成账号授权)/i.test(message)) return true;
  if (/Codex (?:OAuth )?(?:凭据(?:格式损坏|字段不完整)|token 缺少|Responses endpoint|originator)/i.test(message)) {
    return true;
  }
  const oauthHttpStatus = /Codex OAuth .*HTTP (\d{3})/i.exec(message)?.[1];
  if (oauthHttpStatus) {
    const status = Number(oauthHttpStatus);
    return status >= 400 && status < 500 && status !== 408 && status !== 409 && status !== 429;
  }
  return false;
}

function isRetryablePreStreamHttpError(
  status: number,
  code: string | undefined,
  message: string,
): boolean {
  if (status === 502 || status === 503 || status === 504) return true;
  // 429 发流前被拒 = 上游未接单、不计费，退避重试只花时延不花钱；
  // 覆盖 ServerOverloaded / ModelLoadingError / RPM·TPM 限流等可自愈形态。
  if (status === 429) return !isQuotaExhausted(code, message);
  if (status !== 500) return false;
  return /\b(?:EOF|ECONNRESET|EPIPE|ETIMEDOUT)\b|socket hang up|connection (?:reset|closed)|unexpected end of file/i.test(message)
    || /stream error:\s*stream ID \d+;\s*PROTOCOL_ERROR;\s*received from peer/i.test(message);
}

function isRetryableStreamTerminalError(
  terminalEventType: string | undefined,
  terminalStatus: ModelTerminalStatus | undefined,
  errorCode: string,
  errorMessage: string,
): boolean {
  if (terminalStatus !== 'failed') return false;
  if (!['error', 'response.error', 'response.failed'].includes(terminalEventType ?? '')) return false;
  const normalizedCode = errorCode.trim().toLowerCase();
  if (['internal_server_error', 'server_error', 'server_is_overloaded'].includes(normalizedCode)) return true;
  return normalizedCode === 'model_provider_error'
    && errorMessage.trim().toLowerCase() === 'sorry, something went wrong.';
}

async function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortReason(signal);
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(signal ? abortReason(signal) : new Error('Model request aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Model request aborted');
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
  const cacheCreationInputTokens = numberOrZero(
    raw.input_tokens_details?.cache_write_tokens
    ?? raw.input_tokens_details?.cache_creation_tokens,
  );
  // reasoning_tokens 是 output_tokens 的子集（output 单价已覆盖），仅用于观测——展示
  // tool loop 内思考量、诊断是不是在重复思考。上游字段名：OpenAI Responses =
  // output_tokens_details.reasoning_tokens；Chat Completions 走 chatCompletionsAdapter。
  const reasoningTokens = numberOrZero(raw.output_tokens_details?.reasoning_tokens);
  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
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

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
  RunContext,
  RuntimeConnection,
} from './types.js';
import type { ModelProviderOptions } from '../types/index.js';
import { createHash } from 'node:crypto';
import { createLogger } from '../utils/logger.js';
import {
  defendUserMessageText,
  detectDsmlLeak,
  detectMojibake,
  unescapeDeepseekArguments,
} from './agentPlanDefense.js';

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

const logger = createLogger('ResponsesAdapter');

/** Responses API 默认 max_output_tokens 下限：≤16 触发服务端 500（实测 doubao）。 */
const MAX_OUTPUT_TOKENS_FLOOR = 64;

/** cumulativeInputTokens 告警阈值（P1.3 嵌套接力监控）。 */
const CUMULATIVE_INPUT_WARN_THRESHOLD = 100_000;

/** previous_response_id 服务端 TTL：72 小时（实测火山所有公开模型）。 */
const RESPONSE_TTL_MS = 72 * 3600 * 1000;

/**
 * 上游瞬时故障（5xx / 网络 EOF）重试。仅在「开始读流之前」重试，无重复内容风险；
 * 4xx 立即抛（请求本身的问题，重试无意义）。典型场景：cli-proxy 转发到 ChatGPT
 * codex 后端时偶发 `Post "https://chatgpt.com/...": EOF` 包装成的 HTTP 500。
 */
const MAX_REQUEST_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;

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

/** setTimeout 版 delay，监听 abort signal 提前结束（由调用方在循环里再判 aborted 跳出）。 */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

/** 单个 input item，对齐 OpenAI Responses input items 协议。 */
type ResponsesInputItem =
  | {
    type: 'message';
    role: 'user' | 'assistant' | 'system';
    content: Array<{ type: 'input_text' | 'output_text'; text: string }>;
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
    const requestedMax = typeof request.maxOutputTokens === 'number'
      ? request.maxOutputTokens
      : 4096;
    const maxOutputTokens = Math.max(requestedMax, MAX_OUTPUT_TOKENS_FLOOR);
    if (requestedMax < MAX_OUTPUT_TOKENS_FLOOR) {
      logger.warn(
        `max_output_tokens=${requestedMax} 小于下限 ${MAX_OUTPUT_TOKENS_FLOOR}，已提升以避免火山 500（model=${request.model}）`,
      );
    }

    // P1.4：tool_choice 与 model 兼容性校验（详 RFC §2.3：glm 拒 required/specific）
    const toolChoice = this.validateAndNormalizeToolChoice(request.toolChoice ?? 'auto', request.model);

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
    const buildRequestBody = (): Record<string, unknown> => {
      const { instructions, input } = usePrevious
        ? { instructions: undefined, input: this.extractIncrementalInput(request.messages, sessionIdShort) }
        : this.buildFullInput(request.messages, sessionIdShort);

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
        ...(this.providerOptions.disablePromptCacheKey
          ? {}
          : { prompt_cache_key: computePromptCacheKey(request.model, request.messages, request.tools) }),
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
    let body = buildRequestBody();

    const requestSignal = request.signal ?? context.signal;
    const url = responsesUrl(this.connection.baseUrl);
    // 瞬时故障重试：网络 EOF 与上游 5xx 退避重试，4xx 立即抛。重试均在读流前，无副作用。
    let response: Response | null = null;
    for (let attempt = 1; attempt <= MAX_REQUEST_ATTEMPTS; attempt++) {
      let attemptResponse: Response;
      try {
        attemptResponse = await fetch(url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.connection.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: requestSignal,
        });
      } catch (err) {
        // 网络层失败（连接 EOF / ECONNRESET / 上游主动断连）。abort 不重试，原样抛。
        if (requestSignal?.aborted || attempt >= MAX_REQUEST_ATTEMPTS) throw err;
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`Responses API 网络错误（attempt ${attempt}/${MAX_REQUEST_ATTEMPTS}），退避重试：${message}`);
        await delay(RETRY_BASE_DELAY_MS * 3 ** (attempt - 1), requestSignal);
        continue;
      }
      if (attemptResponse.ok) { response = attemptResponse; break; }
      const text = await attemptResponse.text().catch(() => '');
      // previous_response_id 不被上游认可（跨模型切换后残留 / 服务端 TTL 过期）：
      // 确定性 4xx，重发同 body 无意义 → 降级全量重建后立即重试（不退避，不占额外网络成本）。
      if (
        usePrevious
        && attempt < MAX_REQUEST_ATTEMPTS
        && !requestSignal?.aborted
        && isPreviousResponseNotFound(attemptResponse.status, text)
      ) {
        logger.warn(
          `Responses API previous_response_id 不被上游认可（跨模型切换或已过期），降级全量重试：${text.slice(0, 200)}`,
        );
        usePrevious = false;
        body = buildRequestBody();
        continue;
      }
      // 5xx（含上游 `Post "...": EOF` 包装成的 500）瞬时故障可重试；其余 4xx 立即抛。
      if (attemptResponse.status >= 500 && attempt < MAX_REQUEST_ATTEMPTS && !requestSignal?.aborted) {
        logger.warn(`Responses API HTTP ${attemptResponse.status}（attempt ${attempt}/${MAX_REQUEST_ATTEMPTS}），退避重试：${text.slice(0, 200)}`);
        await delay(RETRY_BASE_DELAY_MS * 3 ** (attempt - 1), requestSignal);
        continue;
      }
      throw new Error(`Responses API HTTP ${attemptResponse.status}: ${text.slice(0, 1000)}`);
    }
    if (!response) {
      throw new Error('Responses API 请求在多次重试后仍失败。');
    }
    if (!response.body) {
      throw new Error('Responses API response body is empty.');
    }

    let content = '';
    let usage: ModelUsage | undefined;
    let finishReason: string | undefined;
    let responseId: string | undefined;
    let responseExpireAt: number | undefined;
    let actualModel: string | undefined;

    // function_call 在 stream 里按 output_index 累积；item 整体在 output_item.done 出现
    const toolCallsByIndex = new Map<number, ModelToolCall>();
    const functionCallArgsBuffer = new Map<number, { call_id: string; name: string; arguments: string }>();

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
            const eventType: string = event.type ?? '';

            if (eventType === 'response.created') {
              responseId = event.response?.id;
              actualModel = event.response?.model;
              if (typeof event.response?.expire_at === 'number') {
                // Responses API expire_at 单位为 Unix epoch 秒
                responseExpireAt = event.response.expire_at;
              }
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
              if (respObj?.usage) usage = normalizeResponsesUsage(respObj.usage);
              if (typeof respObj?.expire_at === 'number') responseExpireAt = respObj.expire_at;
              if (typeof respObj?.model === 'string') actualModel = respObj.model;
              if (typeof respObj?.status === 'string') finishReason = mapResponsesStatusToFinish(respObj.status, toolCallsByIndex.size > 0);
            } else if (eventType === 'response.failed' || eventType === 'response.error') {
              const errMsg = event.response?.error?.message ?? event.error?.message ?? eventType;
              throw new Error(`Responses API stream error: ${errMsg}`);
            }
          }
          boundary = buffer.indexOf('\n\n');
        }
      }
    } finally {
      reader.releaseLock();
    }

    // P1.1：stream 末尾 chunk usage 永远 null（RFC §2.4），用 GET /responses/{id} 兜底
    if (!usage && responseId) {
      const fetched = await this.fetchUsageById(responseId).catch((err) => {
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

    yield {
      type: 'completed',
      content,
      toolCalls,
      ...(usage ? { usage } : {}),
      ...(finishReason ? { finishReason } : {}),
      ...(responseId ? { responseId } : {}),
      ...(typeof responseExpireAt === 'number' ? { responseExpireAt } : {}),
      ...(actualModel ? { actualModel } : {}),
      responseChained: usePrevious,
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
  private async fetchUsageById(responseId: string): Promise<ModelUsage | undefined> {
    const response = await fetch(responsesByIdUrl(this.connection.baseUrl, responseId), {
      method: 'GET',
      headers: { authorization: `Bearer ${this.connection.apiKey}` },
    });
    if (!response.ok) return undefined;
    const data = await response.json() as Record<string, any>;
    return data.usage ? normalizeResponsesUsage(data.usage) : undefined;
  }

  /**
   * 抽取 messages 尾部"user 或 tool"增量作为接力 input。
   * 标准 agent loop 结构：[..., assistant_with_tool_calls, tool_1, tool_2] → 抽取 [tool_1, tool_2]
   *                    [..., assistant_message, user_new] → 抽取 [user_new]
   *
   * user content 走 defendUserText（A3/B2 injection escape + B4 长英文中文 leading + G1 时间戳）。
   */
  private extractIncrementalInput(messages: ModelChatMessage[], sessionIdShort?: string): ResponsesInputItem[] {
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
          content: [{ type: 'input_text', text: defendUserMessageText(m.content, sessionIdShort) }],
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
   * user content 走 defendUserMessageText（A3/B2 injection escape + B4 长英文中文 leading + G1 时间戳；
   * 平台注入上下文块只保留 escape，不加时间戳/中文 leading）。
   */
  private buildFullInput(messages: ModelChatMessage[], sessionIdShort?: string): {
    instructions?: string;
    input: ResponsesInputItem[];
  } {
    const systemTexts: string[] = [];
    const items: ResponsesInputItem[] = [];
    for (const m of messages) {
      if (m.role === 'system') {
        systemTexts.push(m.content);
      } else if (m.role === 'user') {
        items.push({
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: defendUserMessageText(m.content, sessionIdShort) }],
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

function parseSseData(block: string): string[] {
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    dataLines.push(line.slice('data:'.length).trimStart());
  }
  return dataLines.length > 0 ? [dataLines.join('\n').trim()] : [];
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

/**
 * AI Title Generator
 *
 * 使用 OpenAI-compatible Chat Completions / Responses API 生成简短会话标题。
 * 无工具、单轮、短超时。
 */

import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { createInterface } from 'node:readline';

import OpenAI from 'openai';
import { openTrustedTranscript } from '../data/transcripts/trusted.js';
import type { SdkResultModelUsage } from './types.js';
import type { ModelProviderOptions } from '../types/index.js';
import type { ModelAdapter, RunContext } from '../runtime/types.js';
import { createLogger } from '../utils/logger.js';

const titleLogger = createLogger('Title');

/**
 * 从 transcript 文件读取前 N 轮的 user/assistant 文本，
 * 供自动命名 & 手动 auto-title 路由共用，保证两条路径的命名素材一致。
 *
 * - 剥离 `<memory-context>...` / `[用户消息]` / 时间戳前缀，
 *   避免模型被外围壳干扰
 * - 每条文本截到 1000 字符
 */
export async function extractTitleContext(
  transcript: string | FileHandle,
  rounds = 2,
): Promise<{ userMessages: string[]; assistantReplies: string[] }> {
  const userMessages: string[] = [];
  const assistantReplies: string[] = [];
  const callerOwnsHandle = typeof transcript !== 'string';
  let ownedHandle: FileHandle | undefined;
  const input = typeof transcript !== 'string'
    ? transcript.createReadStream({ encoding: 'utf-8', autoClose: false })
    : /^\/proc\/self\/fd\/\d+$/.test(transcript)
      // The caller owns and keeps this descriptor open (sessions route compatibility).
      ? createReadStream(transcript, { encoding: 'utf-8' })
      : (ownedHandle = (await openTrustedTranscript(transcript)).handle)
        .createReadStream({ encoding: 'utf-8', autoClose: false });
  const rl = createInterface({ input, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
    if (!line.trim()) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    if (userMessages.length < rounds && obj?.type === 'user' && obj?.message?.content != null) {
      const text =
        typeof obj.message.content === 'string'
          ? obj.message.content
          : Array.isArray(obj.message.content)
            ? (obj.message.content.find((b: any) => b?.type === 'text')?.text ?? null)
            : null;
      if (text) {
        let cleaned = text.replace(/^<memory-context>[\s\S]*?<\/memory-context>\s*/, '');
        const marker = '[用户消息]';
        const idx = cleaned.indexOf(marker);
        if (idx >= 0) cleaned = cleaned.slice(idx + marker.length).trim();
        cleaned = cleaned.replace(
          /^\[\d{4}\/\d{2}\/\d{2}\s+(?:周[一二三四五六日]\s+)?\d{2}:\d{2}\]\s*/,
          '',
        );
        if (cleaned) userMessages.push(cleaned.slice(0, 1000));
      }
    }

    if (assistantReplies.length < rounds && obj?.type === 'assistant' && obj?.message?.content) {
      const text =
        typeof obj.message.content === 'string'
          ? obj.message.content
          : Array.isArray(obj.message.content)
            ? (obj.message.content.find((b: any) => b?.type === 'text')?.text ?? null)
            : null;
      if (text) assistantReplies.push(text.slice(0, 1000));
    }

      if (userMessages.length >= rounds && assistantReplies.length >= rounds) break;
    }
  } finally {
    rl.close();
    if (callerOwnsHandle) input.pause();
    else input.destroy();
    await ownedHandle?.close().catch(() => undefined);
  }

  return { userMessages, assistantReplies };
}

export interface TitleGeneratorConfig {
  model: string;
  modelRef?: string;
  connection?: { apiKey?: string; baseUrl?: string };
  protocol?: 'chat_completions' | 'responses';
  responsesTransport?: 'openai_compatible' | 'codex_subscription';
  providerOptions?: ModelProviderOptions;
}

export type TitleModelAdapterFactory = (
  connection: { apiKey?: string; baseUrl?: string },
  providerOptions?: ModelProviderOptions,
) => ModelAdapter;

export interface TitleGenerationOptions {
  beforeModelCall?: (model: string) => void | Promise<void>;
  onUsage?: (model: string, usage: SdkResultModelUsage) => void | Promise<void>;
  /** 平台管理热更新后的系统提示语；缺省继续使用代码内置版本。 */
  systemPrompt?: string;
  /** Codex subscription 复用主 Runtime adapter；标题专用 factory 不注入 WebSocket pool。 */
  modelAdapterFactory?: TitleModelAdapterFactory;
  runtimeContext?: { sessionId: string; tenantId?: string; cwd: string };
  timeoutMs?: number;
}

export const TITLE_SYSTEM_PROMPT = `你的唯一任务是通过阅读我引用的这些用户消息与 Agent 回复来生成一个简短的会话标题。禁止调用工具，禁止执行命令，禁止输出解释。
规则：
- 检测用户消息的语言，用同种语言输出
- 中文不超过 15 个字，英文不超过 10 个词
- 不要加引号、标点或任何前缀
- 只输出标题本身`;

/** 首条消息足够长时，不等待 Agent 首次输出，直接生成标题。 */
export function shouldGenerateTitleFromFirstMessage(message: string, threshold = 20): boolean {
  const chineseCharacterCount = message.match(/\p{Script=Han}/gu)?.length ?? 0;
  const englishWordCount = message.match(/[A-Za-z]+(?:[-'’][A-Za-z]+)*/g)?.length ?? 0;
  return chineseCharacterCount > threshold || englishWordCount > threshold;
}

const RESPONSES_TITLE_MAX_OUTPUT_TOKENS = 512;

interface TitleProviderResult {
  raw: string;
  finishReason: string;
  responseId: string;
  usage?: SdkResultModelUsage;
  errorMessage?: string;
}

function extractResponsesText(payload: Record<string, any>): string {
  if (typeof payload.output_text === 'string') return payload.output_text;
  if (!Array.isArray(payload.output)) return '';
  for (const item of payload.output) {
    if (item?.type !== 'message' || !Array.isArray(item.content)) continue;
    const block = item.content.find((content: any) => content?.type === 'output_text');
    if (typeof block?.text === 'string') return block.text;
  }
  return '';
}

async function generateTitleViaResponses(input: {
  apiKey: string;
  baseURL: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  signal: AbortSignal;
}): Promise<TitleProviderResult> {
  const response = await fetch(`${input.baseURL.replace(/\/+$/, '')}/responses`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${input.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: input.model,
      instructions: input.systemPrompt,
      input: input.userPrompt,
      max_output_tokens: RESPONSES_TITLE_MAX_OUTPUT_TOKENS,
      store: false,
      stream: false,
    }),
    signal: input.signal,
  });
  const payload = await response.json() as Record<string, any>;
  if (!response.ok) throw new Error(`Responses API HTTP ${response.status}`);
  const usage = payload.usage as Record<string, any> | undefined;
  return {
    raw: extractResponsesText(payload),
    finishReason: typeof payload.status === 'string' ? payload.status : 'unknown',
    responseId: typeof payload.id === 'string' ? payload.id : 'n/a',
    ...(usage ? {
      usage: {
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        cacheReadInputTokens: usage.input_tokens_details?.cached_tokens ?? 0,
        cacheCreationInputTokens: 0,
        apiRequestCount: 1,
      },
    } : {}),
  };
}

interface TitleModelAdapterInput {
  config: TitleGeneratorConfig;
  factory: TitleModelAdapterFactory;
  runtimeContext: NonNullable<TitleGenerationOptions['runtimeContext']>;
  systemPrompt: string;
  userPrompt: string;
  signal: AbortSignal;
  authorizeModelTurn?: () => Promise<void>;
}

const codexTitleInFlight = new WeakMap<TitleModelAdapterFactory, Set<string>>();

function withTitleTimeout<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('Title generation timed out'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('Title generation timed out'));
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function runCodexTitleOperation(input: TitleModelAdapterInput): Promise<TitleProviderResult> {
  const key = input.config.model;
  const active = codexTitleInFlight.get(input.factory) ?? new Set<string>();
  if (active.has(key)) return Promise.reject(new Error('Codex title generation is still in flight'));
  active.add(key);
  codexTitleInFlight.set(input.factory, active);
  const operation = generateTitleViaModelAdapter(input);
  const release = () => {
    active.delete(key);
    if (active.size === 0) codexTitleInFlight.delete(input.factory);
  };
  operation.then(release, release);
  return withTitleTimeout(operation, input.signal);
}

async function generateTitleViaModelAdapter(input: TitleModelAdapterInput): Promise<TitleProviderResult> {
  const adapter = input.factory(input.config.connection ?? {}, {
    ...input.config.providerOptions,
    protocol: 'responses',
    responsesTransport: 'codex_subscription',
    disableResponseChaining: true,
    preStreamRetryDelaysMs: [],
  });
  const context: RunContext = {
    runId: `title-${randomUUID()}`,
    sessionId: input.runtimeContext.sessionId,
    ...(input.config.modelRef ? { modelRef: input.config.modelRef } : {}),
    model: input.config.model,
    cwd: input.runtimeContext.cwd,
    ...(input.runtimeContext.tenantId ? { tenantId: input.runtimeContext.tenantId } : {}),
    channelContext: { channel: 'web', resumeSessionId: input.runtimeContext.sessionId },
    signal: input.signal,
    ...(input.authorizeModelTurn ? { authorizeModelTurn: input.authorizeModelTurn } : {}),
  };
  let raw = '';
  let finishReason = 'unknown';
  let responseId = 'n/a';
  let usage: SdkResultModelUsage | undefined;
  let errorMessage: string | undefined;
  let completed = false;
  for await (const event of adapter.stream({
    model: input.config.model,
    messages: [
      { role: 'system', content: input.systemPrompt },
      { role: 'user', content: input.userPrompt },
    ],
    tools: [],
    toolChoice: 'none',
    maxOutputTokens: RESPONSES_TITLE_MAX_OUTPUT_TOKENS,
    signal: input.signal,
  }, context)) {
    if (event.type === 'text_delta') raw += event.content;
    if (event.type !== 'completed') continue;
    completed = true;
    raw = event.content || raw;
    finishReason = event.finishReason ?? event.terminalStatus ?? 'completed';
    responseId = event.responseId ?? 'n/a';
    usage = event.usage;
    if (event.terminalStatus && event.terminalStatus !== 'completed') {
      errorMessage = event.errorMessage || `Codex title generation ${event.terminalStatus}`;
    }
  }
  if (!completed) errorMessage = 'Codex title generation ended without terminal event';
  return {
    raw,
    finishReason,
    responseId,
    ...(usage ? { usage } : {}),
    ...(errorMessage ? { errorMessage } : {}),
  };
}

export async function generateTitle(
  userMessage: string,
  assistantReply: string,
  config: TitleGeneratorConfig,
  secondUserMessage?: string,
  secondAssistantReply?: string,
  options: TitleGenerationOptions = {},
): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  const apiKey = config.connection?.apiKey || process.env.OPENAI_API_KEY;
  const baseURL = config.connection?.baseUrl || process.env.OPENAI_BASE_URL;
  const isCodexSubscription = config.protocol === 'responses'
    && config.responsesTransport === 'codex_subscription';

  if (isCodexSubscription && (!options.modelAdapterFactory || !options.runtimeContext)) {
    titleLogger.warn(`Title generation skipped (model=${config.model}): codex_subscription runtime is unavailable`);
    clearTimeout(timeout);
    return null;
  }
  if (!isCodexSubscription && !apiKey) {
    titleLogger.warn(`Title generation skipped (model=${config.model}): missing OPENAI_API_KEY`);
    clearTimeout(timeout);
    return null;
  }
  if (config.protocol === 'responses' && !isCodexSubscription && !baseURL) {
    titleLogger.warn(`Title generation skipped (model=${config.model}): missing Responses baseUrl`);
    clearTimeout(timeout);
    return null;
  }

  // Codex 由 ResponsesApiAdapter 在真实 transport attempt 前授权；其他协议维持单次外层授权。
  if (!isCodexSubscription) await options.beforeModelCall?.(config.model);
  let authorizationCallbackFailed = false;
  let usageCallbackFailed = false;

  try {
    const parts = [
      '用户消息：',
      userMessage.slice(0, 1000),
      '',
      'Agent 回复：',
      assistantReply.slice(0, 1000),
    ];

    if (secondUserMessage) {
      parts.push('', '用户消息（第二轮）：', secondUserMessage.slice(0, 1000));
      if (secondAssistantReply) {
        parts.push('', 'Agent 回复（第二轮）：', secondAssistantReply.slice(0, 1000));
      }
    }

    let providerResult: TitleProviderResult;
    if (isCodexSubscription) {
      providerResult = await runCodexTitleOperation({
        config,
        factory: options.modelAdapterFactory!,
        runtimeContext: options.runtimeContext!,
        systemPrompt: options.systemPrompt ?? TITLE_SYSTEM_PROMPT,
        userPrompt: parts.join('\n'),
        signal: controller.signal,
        authorizeModelTurn: options.beforeModelCall
          ? async () => {
              try {
                await options.beforeModelCall!(config.model);
              } catch (err) {
                authorizationCallbackFailed = true;
                throw err;
              }
            }
          : undefined,
      });
    } else if (config.protocol === 'responses') {
      providerResult = await generateTitleViaResponses({
        apiKey: apiKey!,
        baseURL: baseURL!,
        model: config.model,
        systemPrompt: options.systemPrompt ?? TITLE_SYSTEM_PROMPT,
        userPrompt: parts.join('\n'),
        signal: controller.signal,
      });
    } else {
      const client = new OpenAI({
        apiKey: apiKey!,
        maxRetries: 0,
        ...(baseURL ? { baseURL } : {}),
      });
      const result = await client.chat.completions.create({
        model: config.model,
        messages: [
          { role: 'system', content: options.systemPrompt ?? TITLE_SYSTEM_PROMPT },
          { role: 'user', content: parts.join('\n') },
        ],
        temperature: 0.2,
        max_tokens: 64,
        n: 1,
      }, { signal: controller.signal });
      const choice = result.choices[0];
      providerResult = {
        raw: choice?.message?.content ?? '',
        finishReason: choice?.finish_reason ?? 'unknown',
        responseId: result.id ?? 'n/a',
        ...(result.usage ? {
          usage: {
            inputTokens: result.usage.prompt_tokens ?? 0,
            outputTokens: result.usage.completion_tokens ?? 0,
            cacheReadInputTokens: result.usage.prompt_tokens_details?.cached_tokens ?? 0,
            cacheCreationInputTokens: 0,
            apiRequestCount: 1,
          },
        } : {}),
      };
    }
    if (providerResult.usage) {
      try {
        await options.onUsage?.(config.model, providerResult.usage);
      } catch (err) {
        usageCallbackFailed = true;
        throw err;
      }
    }
    if (providerResult.errorMessage) throw new Error(providerResult.errorMessage);
    const raw = providerResult.raw;
    if (!raw) {
      // 上游 200 但 content 为空：通常是模型协议错配（如 Responses-only 模型被
      // 当成 Chat Completions 调）/ 安全过滤 / token 不足。打 warn 带 finish_reason
      // & usage 便于下次直接定位，避免之前那种"持续 502 但日志无线索"的盲查。
      titleLogger.warn(
        `Title generation got empty content (model=${config.model}) ` +
          `finish_reason=${providerResult.finishReason} ` +
          `usage=${JSON.stringify(providerResult.usage ?? null)} id=${providerResult.responseId}`,
      );
      return null;
    }

    let title = raw.trim().split('\n')[0].trim();
    if (title.length === 0) {
      titleLogger.warn(
        `Title generation produced whitespace-only result (model=${config.model}) raw=${JSON.stringify(raw.slice(0, 80))}`,
      );
      return null;
    }
    title = title.replace(/^["'"'"']|["'"'"']$/g, '').trim();
    if (title.length > 20) title = title.slice(0, 20);
    return title || null;
  } catch (err) {
    if (authorizationCallbackFailed || usageCallbackFailed) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    titleLogger.warn(`Title generation failed (model=${config.model}): ${reason}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 按 configs 顺序尝试生成标题，第一个成功的即返回。
 *
 * 设计动机：上游某些模型（典型是 Responses-only 协议被当成 Chat Completions 调）
 * 偶发返回 200 + 空 content，无异常可 catch。靠静默 fallback 到稳定模型保住功能可用性。
 *
 * - 第 i 次失败（i < N-1）记 warn 注明将尝试下一个 fallback
 * - 第 i 次成功（i > 0）记 info 标记走的是 fallback——方便观察主模型健康度
 * - 全部失败返回 null（自动命名调用方静默保留原标题）
 */
export async function generateTitleWithFallback(
  userMessage: string,
  assistantReply: string,
  configs: TitleGeneratorConfig[],
  secondUserMessage?: string,
  secondAssistantReply?: string,
  options: TitleGenerationOptions = {},
): Promise<string | null> {
  if (configs.length === 0) {
    titleLogger.warn('Title generation skipped: no config available');
    return null;
  }
  for (let i = 0; i < configs.length; i++) {
    const cfg = configs[i];
    const title = await generateTitle(
      userMessage,
      assistantReply,
      cfg,
      secondUserMessage,
      secondAssistantReply,
      options,
    );
    if (title) {
      if (i > 0) {
        titleLogger.info(
          `Title generated via fallback model "${cfg.model}" (attempt ${i + 1}/${configs.length})`,
        );
      }
      return title;
    }
    if (i < configs.length - 1) {
      titleLogger.warn(
        `Title generation via "${cfg.model}" returned null, trying fallback ${i + 2}/${configs.length}`,
      );
    }
  }
  return null;
}

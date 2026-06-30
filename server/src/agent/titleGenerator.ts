/**
 * AI Title Generator
 *
 * 使用 OpenAI-compatible Chat Completions API 生成简短会话标题。无工具、单轮、短超时。
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

import OpenAI from 'openai';
import type { SdkResultModelUsage } from './types.js';
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
  transcriptPath: string,
  rounds = 2,
): Promise<{ userMessages: string[]; assistantReplies: string[] }> {
  const userMessages: string[] = [];
  const assistantReplies: string[] = [];

  const rl = createInterface({
    input: createReadStream(transcriptPath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

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

  return { userMessages, assistantReplies };
}

export interface TitleGeneratorConfig {
  model: string;
  connection?: { apiKey?: string; baseUrl?: string };
}

export interface TitleGenerationOptions {
  onUsage?: (model: string, usage: SdkResultModelUsage) => void | Promise<void>;
}

const TITLE_SYSTEM_PROMPT = `你的唯一任务是通过阅读我引用的这些用户消息与 Agent 回复来生成一个简短的会话标题。禁止调用工具，禁止执行命令，禁止输出解释。
规则：
- 检测用户消息的语言，用同种语言输出
- 中文不超过 15 个字，英文不超过 10 个词
- 不要加引号、标点或任何前缀
- 只输出标题本身`;

export async function generateTitle(
  userMessage: string,
  assistantReply: string,
  config: TitleGeneratorConfig,
  secondUserMessage?: string,
  secondAssistantReply?: string,
  options: TitleGenerationOptions = {},
): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  const apiKey = config.connection?.apiKey || process.env.OPENAI_API_KEY;
  const baseURL = config.connection?.baseUrl || process.env.OPENAI_BASE_URL;

  if (!apiKey) {
    titleLogger.warn(`Title generation skipped (model=${config.model}): missing OPENAI_API_KEY`);
    clearTimeout(timeout);
    return null;
  }

  const client = new OpenAI({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
  });

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

    const result = await client.chat.completions.create({
      model: config.model,
      messages: [
        { role: 'system', content: TITLE_SYSTEM_PROMPT },
        { role: 'user', content: parts.join('\n') },
      ],
      temperature: 0.2,
      max_tokens: 64,
      n: 1,
    }, { signal: controller.signal });
    if (result.usage) {
      await options.onUsage?.(config.model, {
        inputTokens: result.usage.prompt_tokens ?? 0,
        outputTokens: result.usage.completion_tokens ?? 0,
        cacheReadInputTokens: result.usage.prompt_tokens_details?.cached_tokens ?? 0,
        cacheCreationInputTokens: 0,
        apiRequestCount: 1,
      });
    }
    const choice = result.choices[0];
    const raw = choice?.message?.content ?? '';
    if (!raw) {
      // 上游 200 但 content 为空：通常是模型协议错配（如 Responses-only 模型被
      // 当成 Chat Completions 调）/ 安全过滤 / token 不足。打 warn 带 finish_reason
      // & usage 便于下次直接定位，避免之前那种"持续 502 但日志无线索"的盲查。
      titleLogger.warn(
        `Title generation got empty content (model=${config.model}) ` +
          `finish_reason=${choice?.finish_reason ?? 'unknown'} ` +
          `usage=${JSON.stringify(result.usage ?? null)} id=${result.id ?? 'n/a'}`,
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
 * - 全部失败返回 null（调用方按现有 502 路径继续上报）
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

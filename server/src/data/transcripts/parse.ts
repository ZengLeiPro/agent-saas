/**
 * Transcript 解析模块
 *
 * 将 JSONL 格式的 transcript 解析为结构化的 blocks。
 */
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as readline from "node:readline";
import { apiLogger } from "../../utils/logger.js";
import { computeCacheHitDenominatorTokens, computeUsageTotalTokens, getUsageAccountingMode } from "../usage/pricing.js";
import { assertAllowedTranscriptPath } from "./projectKey.js";

export type TranscriptBlockKind =
  | "prompt"
  | "text"
  | "thinking"
  | "tool_use"
  | "tool_result"
  | "compaction"
  | "meta";

export interface TranscriptSubagentActivity {
  agentType: string;
  description: string;
  childSessionId: string;
  childRunId: string;
  model?: string;
  status: "running" | "completed" | "failed" | "cancelled" | "timeout";
  durationMs?: number;
  totalTokens?: number;
  toolUseCount?: number;
  turnCount?: number;
  errorMessage?: string;
  resultPreview?: string;
}

export interface TranscriptBlock {
  id: string;
  tsMs?: number;
  kind: TranscriptBlockKind;
  title: string;
  defaultOpen: boolean;
  /** Human-friendly content shown by default */
  content: string;
  /** Optional raw JSON for debugging */
  raw?: string;
  /** Mark blocks that represent an error */
  isError?: boolean;
  /** Tool name (for tool_use/tool_result) */
  toolName?: string;
  /** Tool use ID (for correlation) */
  toolId?: string;
  /** Activity duration derived from runtime events, when available */
  durationMs?: number;
  /** Tool lifecycle state derived from durable runtime events */
  executionStatus?: "pending" | "running" | "completed" | "failed" | "cancelled";
  /** Agent 工具对应的 durable child run 元数据。 */
  subagent?: TranscriptSubagentActivity;
  /** User prompt originated from mobile voice transcription */
  isVoiceTranscript?: boolean;
  /** compaction block：被摘要替代的历史事件数 */
  coveredEventCount?: number;
}

export interface ParsedTranscript {
  sessionId?: string;
  blocks: TranscriptBlock[];
  stats: {
    lines: number;
    parsedLines: number;
    parseErrors: number;
  };
}

function toTsMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function normalizeTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object") {
        const t = (block as any).text;
        if (typeof t === "string") parts.push(t);
      }
    }
    if (parts.length) return parts.join("\n");
    return formatJson(content);
  }
  if (content == null) return "";
  return String(content);
}

/** 剥离 <memory-context>...</memory-context> 前缀，用于前端展示时隐藏记忆内容 */
export function stripMemoryContext(text: string): string {
  return text.replace(/^<memory-context>[\s\S]*?<\/memory-context>\s*/, '');
}

/** 剥离 [YYYY/MM/DD 周X HH:MM] 时间戳前缀，时间信息改由 tsMs 元数据传递（兼容不含星期的旧格式） */
export function stripTimestampPrefix(text: string): string {
  return text.replace(/^\[\d{4}\/\d{2}\/\d{2}\s+(?:周[一二三四五六日]\s+)?\d{2}:\d{2}\]\s*/, '');
}

const VOICE_STT_TAG_RE = /^\[这是一条语音转文字的消息，可能存在识别准确度问题\]\s*/;

/** 判断用户文本是否带有语音转文字标注前缀 */
export function isVoiceSttTagged(text: string): boolean {
  return VOICE_STT_TAG_RE.test(text);
}

/** 从需要纯用户文本的场景中剥离语音转文字标注前缀 */
export function stripVoiceSttTag(text: string): string {
  return text.replace(VOICE_STT_TAG_RE, '');
}

function isSkillContextText(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (t.startsWith("Base directory for this skill:")) return true;
  if (t.includes("\n# gog\n") && t.includes("Use `gog`")) return true;
  if (t.includes("ARGUMENTS:") && t.includes("Base directory for this skill:")) return true;
  return false;
}

/** 从用户消息文本中剥离 <task-notification> 块（SDK 后台任务完成通知） */
export function stripTaskNotification(text: string): string {
  return text.replace(/<task-notification>[\s\S]*?<\/task-notification>\s*/g, '');
}

/**
 * 判断用户消息是否为纯 task-notification（没有实际用户文本）。
 * 通知可能带时间戳前缀或 memory-context，剥离后仅剩通知则判为纯通知。
 */
function isPureTaskNotification(text: string): boolean {
  if (!text.includes("<task-notification>")) return false;
  const remaining = stripTaskNotification(
    stripTimestampPrefix(stripMemoryContext(text.trim()))
  ).trim();
  return remaining === '';
}

/** 从 <task-notification> XML 中提取字段 */
function parseTaskNotification(text: string): {
  taskId?: string;
  toolUseId?: string;
  status?: string;
  summary?: string;
} {
  const tag = (name: string) => {
    const m = text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
    return m?.[1]?.trim();
  };
  return {
    taskId: tag('task-id'),
    toolUseId: tag('tool-use-id'),
    status: tag('status'),
    summary: tag('summary'),
  };
}

/**
 * 解析 transcript 文件
 */
async function parseTranscriptFileUncached(
  resolved: string,
): Promise<ParsedTranscript> {
  await fs.access(resolved);

  const blocks: TranscriptBlock[] = [];
  let lines = 0;
  let parsedLines = 0;
  let parseErrors = 0;
  let sessionId: string | undefined;

  // toolId -> toolName 映射，用于 tool_result 关联
  const toolIdToName: Record<string, string> = {};

  const rl = readline.createInterface({
    input: createReadStream(resolved, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    lines += 1;
    if (!line.trim()) continue;

    let obj: any;
    try {
      obj = JSON.parse(line);
      parsedLines += 1;
    } catch {
      parseErrors += 1;
      blocks.push({
        id: `line-${lines}`,
        kind: "meta",
        title: "Unparseable transcript line",
        defaultOpen: false,
        content: line,
      });
      continue;
    }

    const tsMs =
      toTsMs(obj?.timestamp) ?? toTsMs(obj?.ts) ?? toTsMs(obj?.startedAtMs);

    if (!sessionId && typeof obj?.sessionId === "string") sessionId = obj.sessionId;
    if (!sessionId && typeof obj?.session_id === "string") sessionId = obj.session_id;

    // Assistant messages
    if (obj?.type === "assistant" && obj?.message?.content) {
      const content = obj.message.content;
      if (Array.isArray(content)) {
        let idx = 0;
        for (const block of content) {
          idx += 1;
          const blockType = block?.type;
          if (blockType === "text") {
            blocks.push({
              id: `line-${lines}-assistant-${idx}`,
              tsMs,
              kind: "text",
              title: "输出",
              defaultOpen: true,
              content: typeof block.text === "string" ? block.text : formatJson(block),
            });
            continue;
          }
          if (blockType === "thinking" || blockType === "redacted_thinking") {
            const title = blockType === "thinking" ? "思考" : "思考（已脱敏）";
            const thinkingText =
              typeof block?.thinking === "string"
                ? block.thinking
                : typeof block?.text === "string"
                  ? block.text
                  : undefined;
            blocks.push({
              id: `line-${lines}-assistant-${idx}`,
              tsMs,
              kind: "thinking",
              title,
              defaultOpen: true,
              content: thinkingText ?? "(no thinking text)",
              raw: formatJson(block),
            });
            continue;
          }
          if (blockType === "tool_use") {
            const toolName = String(block?.name ?? "unknown");
            const toolId = String(block?.id ?? "");
            const maybeSkill = toolName === "Skill" ? block?.input?.skill : undefined;
            const title =
              toolName === "Skill" && typeof maybeSkill === "string" && maybeSkill.trim()
                ? `工具调用：技能（${maybeSkill.trim()}）`
                : `工具调用: ${toolName}`;

            // 记录 toolId -> toolName 映射
            if (toolId) {
              toolIdToName[toolId] = toolName;
            }

            blocks.push({
              id: `line-${lines}-assistant-${idx}`,
              tsMs,
              kind: "tool_use",
              title,
              defaultOpen: false,
              content: formatJson(block?.input),
              raw: formatJson({
                tool_use_id: block?.id,
                name: block?.name,
                input: block?.input,
              }),
              toolName,
              toolId,
            });
            continue;
          }

          blocks.push({
            id: `line-${lines}-assistant-${idx}`,
            tsMs,
            kind: "meta",
            title: `Assistant block: ${String(blockType ?? "unknown")}`,
            defaultOpen: false,
            content: formatJson(block),
          });
        }
      } else {
        blocks.push({
          id: `line-${lines}-assistant`,
          tsMs,
          kind: "text",
          title: "输出",
          defaultOpen: true,
          content: normalizeTextContent(content),
        });
      }
      continue;
    }

    // User messages
    if (obj?.type === "user" && obj?.message?.content != null) {
      const content = obj.message.content;
      if (Array.isArray(content)) {
        let idx = 0;
        for (const block of content) {
          idx += 1;
          const blockType = block?.type;
          if (blockType === "tool_result") {
            const isError = block?.is_error === true;
            const toolUseId = String(block?.tool_use_id ?? "");
            const toolName = toolUseId ? (toolIdToName[toolUseId] ?? "unknown") : undefined;

            blocks.push({
              id: `line-${lines}-user-${idx}`,
              tsMs,
              kind: "tool_result",
              title: `工具结果: ${toolUseId || "unknown"}${isError ? "（错误）" : ""}`,
              defaultOpen: false,
              content: normalizeTextContent(block?.content),
              raw: formatJson({
                tool_use_id: block?.tool_use_id,
                is_error: block?.is_error,
                content: block?.content,
              }),
              isError,
              toolName,
              toolId: toolUseId,
            });
            continue;
          }
          if (blockType === "text") {
            const text = typeof block.text === "string" ? block.text : formatJson(block);
            if (isSkillContextText(text)) {
              blocks.push({
                id: `line-${lines}-user-${idx}`,
                tsMs,
                kind: "meta",
                title: "技能上下文（自动注入）",
                defaultOpen: false,
                content: text,
              });
              continue;
            }
            if (isPureTaskNotification(text)) {
              const notif = parseTaskNotification(text);
              const statusLabel = notif.status === 'failed' ? '失败' : notif.status === 'completed' ? '完成' : notif.status || '未知';
              blocks.push({
                id: `line-${lines}-user-${idx}`,
                tsMs,
                kind: "tool_use",
                title: `后台任务: ${statusLabel}`,
                defaultOpen: false,
                content: JSON.stringify({ description: notif.summary, status: notif.status }, null, 2),
                toolName: "BackgroundTask",
                toolId: notif.toolUseId || `bg-task-${lines}-${idx}`,
                isError: notif.status === 'failed',
              });
              continue;
            }
            const strippedText = stripTaskNotification(text);
            const promptText = stripTimestampPrefix(stripMemoryContext(strippedText));
            const isVoiceTranscript = isVoiceSttTagged(promptText);
            blocks.push({
              id: `line-${lines}-user-${idx}`,
              tsMs,
              kind: "prompt",
              title: "输入（Prompt）",
              defaultOpen: true,
              content: stripVoiceSttTag(promptText),
              ...(isVoiceTranscript ? { isVoiceTranscript: true } : {}),
            });
            continue;
          }
          blocks.push({
            id: `line-${lines}-user-${idx}`,
            tsMs,
            kind: "meta",
            title: `User block: ${String(blockType ?? "unknown")}`,
            defaultOpen: false,
            content: formatJson(block),
          });
        }
      } else {
        const text = normalizeTextContent(content);
        if (isSkillContextText(text)) {
          blocks.push({
            id: `line-${lines}-user`,
            tsMs,
            kind: "meta",
            title: "技能上下文（自动注入）",
            defaultOpen: false,
            content: text,
          });
          continue;
        }
        if (isPureTaskNotification(text)) {
          const notif = parseTaskNotification(text);
          const statusLabel = notif.status === 'failed' ? '失败' : notif.status === 'completed' ? '完成' : notif.status || '未知';
          blocks.push({
            id: `line-${lines}-user`,
            tsMs,
            kind: "tool_use",
            title: `后台任务: ${statusLabel}`,
            defaultOpen: false,
            content: JSON.stringify({ description: notif.summary, status: notif.status }, null, 2),
            toolName: "BackgroundTask",
            toolId: notif.toolUseId || `bg-task-${lines}`,
            isError: notif.status === 'failed',
          });
          continue;
        }
        const strippedText = stripTaskNotification(text);
        const promptText = stripTimestampPrefix(stripMemoryContext(strippedText));
        const isVoiceTranscript = isVoiceSttTagged(promptText);
        blocks.push({
          id: `line-${lines}-user`,
          tsMs,
          kind: "prompt",
          title: "输入（Prompt）",
          defaultOpen: true,
          content: stripVoiceSttTag(promptText),
          ...(isVoiceTranscript ? { isVoiceTranscript: true } : {}),
        });
      }
      continue;
    }

    // /compact v2：压缩分界线。content 为摘要正文（前端仅 debugMode 提供展开查看）
    if (obj?.type === "compaction") {
      blocks.push({
        id: `line-${lines}-compaction`,
        tsMs,
        kind: "compaction",
        title: "上下文已压缩",
        defaultOpen: false,
        content: typeof obj?.summary === "string" ? obj.summary : "",
        ...(typeof obj?.coveredEventCount === "number"
          ? { coveredEventCount: obj.coveredEventCount }
          : {}),
      });
      continue;
    }

    // SDK result message
    if (obj?.type === "result") {
      blocks.push({
        id: `line-${lines}-result`,
        tsMs,
        kind: "meta",
        title: `结果: ${String(obj?.subtype ?? "unknown")}`,
        defaultOpen: false,
        content: formatJson(obj),
      });
      continue;
    }

    // Everything else
    const label =
      obj?.type && typeof obj.type === "string"
        ? `${obj.type}${obj.subtype ? `:${obj.subtype}` : ""}`
        : "meta";
    blocks.push({
      id: `line-${lines}-meta`,
      tsMs,
      kind: "meta",
      title: label,
      defaultOpen: false,
      content: formatJson(obj),
    });
  }

  return {
    sessionId,
    blocks,
    stats: { lines, parsedLines, parseErrors },
  };
}

/**
 * 快速摘要：提取 title/preview/createdAtMs 用于列表展示
 */
export interface TranscriptSummary {
  title?: string;
  preview?: string;
  createdAtMs?: number;
}

/**
 * 从 prompt 内容中提取标题，跳过钉钉上下文等系统前缀
 */
function extractTitleFromContent(content: string): string {
  let text = stripMemoryContext(content);

  // 钉钉格式: [钉钉消息上下文]...\n[用户消息]\n实际内容
  const userMsgMarker = "[用户消息]";
  const idx = text.indexOf(userMsgMarker);
  if (idx >= 0) {
    text = text.slice(idx + userMsgMarker.length).trim();
  }

  // 剥离 [2026/02/03 周一 22:13] 这类时间戳前缀（兼容不含星期的旧格式）
  text = text.replace(/^\[\d{4}\/\d{2}\/\d{2}\s+(?:周[一二三四五六日]\s+)?\d{2}:\d{2}\]\s*/, "");

  return text.slice(0, 100);
}

// ============================================
// Token usage
// ============================================

export interface TokenUsage {
  /**
   * 最后一轮 provider request 的 total token。
   * 是否可作为“当前上下文”展示，取决于模型 dispatch 口径：
   * full-history 请求可用；Responses previous_response_id 接力不可用。
   */
  contextTokens: number;
  /** 所有轮次的 input_tokens 累加（OpenAI-compatible 下包含缓存命中部分） */
  totalInputTokens: number;
  /** 所有轮次的 cache_read_input_tokens 累加 */
  totalCacheReadTokens: number;
  /** 所有轮次的 cache_creation_input_tokens 累加 */
  totalCacheCreationTokens: number;
  /** 所有轮次的 output_tokens 累加 */
  totalOutputTokens: number;
  /** 子 agent（Task 工具）的 totalTokens 累加 */
  subagentTotalTokens: number;
  /** 新 Agent 工具的 durable child-session 用量分项（由 sessions stats 路由补充）。 */
  subagentUsage?: {
    childCount: number;
    requestCount: number;
    inputTokens: number;
    uncachedInputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    outputTokens: number;
    totalTokens: number;
    cacheHitDenominatorTokens: number;
    cacheHitRatio: number | null;
  };
  /** 主 agent 逐轮 total + 子 agent total 的累计 token，用于 UI 展示累计口径 */
  totalTokens: number;
  /** 缓存命中率分母，按模型 accounting_mode 归一化 */
  cacheHitDenominatorTokens: number;
  /** 缓存命中率；无有效分母时为 null */
  cacheHitRatio: number | null;
}

/**
 * 轻量级 token 统计：遍历 jsonl 提取主 agent 和子 agent 的 token 数据。
 *
 * - contextTokens: 按 accounting_mode 估算的「当前上下文」净大小
 *   （full-history / Anthropic 类：最后一 leg 的全量 usage；
 *     input_includes_cache（Ark Responses+chain）：逐 leg 累加
 *     `(input_tokens - cache_read_input_tokens) + output_tokens`，
 *     遇 `cache_read_input_tokens === 0` 视为 chain 断/全量重发/首 leg，
 *     直接锚定到本 leg 的 `input_tokens + output_tokens`）
 * - totalTokens: 主 agent 每轮 total 累加 + 子 agent total
 * - totalOutputTokens: 所有 turn 的 output_tokens 累加
 * - subagentTotalTokens: user 消息中 toolUseResult.totalTokens 累加（子 agent 消耗）
 *
 * 强化 B 语义（2026-07-05 修复 glm-5.2 上下文显示为 last-leg-input 的低估 bug）：
 *   Ark Responses+previous_response_id 接力下，上游每 leg usage.input_tokens
 *   反映的是「本 leg payload（含 prompt cache）」，不是「chain 内全量历史」。
 *   老代码把最后一 leg input+output 当当前上下文，稳态误差 ≈ chain 累计历史。
 *   新算法沿转录逐 leg 累加净新增 = (input - cache_read) + output；每次 cache
 *   命中率归零（例如 /compact 后接力链被清、cache 过期、跨 model）视为新起点。
 *   仅对 input_includes_cache 生效；cache_tokens_separate（Anthropic 原生）
 *   仍走 computeUsageTotalTokens = input + output + cache_read + cache_creation。
 */
export async function getTokenUsage(
  transcriptPath: string,
): Promise<TokenUsage | null> {
  const resolved = assertAllowedTranscriptPath(transcriptPath);
  await fs.access(resolved);

  let lastContextTokens = 0;
  let accumulatingContextTokens = 0;
  let sawFirstUsage = false;
  let totalInputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheCreationTokens = 0;
  let totalOutputTokens = 0;
  let subagentTotalTokens = 0;
  let mainTotalTokens = 0;
  let cacheHitDenominatorTokens = 0;
  let hasUsage = false;

  const rl = readline.createInterface({
    input: createReadStream(resolved, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    // 子 agent 数据在 user 消息的 toolUseResult 中
    if (line.includes('"totalTokens"')) {
      try {
        const obj = JSON.parse(line);
        const tr = obj?.toolUseResult;
        if (tr && typeof tr.totalTokens === "number") {
          subagentTotalTokens += tr.totalTokens;
        }
      } catch {
        // ignore
      }
    }

    // 主 agent 数据在 assistant 消息中
    if (!line.includes('"type":"assistant"')) continue;

    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    if (obj?.type !== "assistant") continue;

    const usage = obj?.message?.usage;
    if (!usage || typeof usage !== "object") continue;

    hasUsage = true;

    const inp = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
    const cr = typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : 0;
    const cc = typeof usage.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : 0;
    const out = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
    const model = typeof obj?.message?.model === "string" ? obj.message.model : "";

    // turnTotal 保持原语义（按 accounting_mode 归一化的单 leg 计费口径），
    // 只用于 mainTotalTokens 累计展示，不再用于 contextTokens。
    const turnTotal = computeUsageTotalTokens(model, {
      inputTokens: inp,
      outputTokens: out,
      cacheReadTokens: cr,
      cacheCreationTokens: cc,
    });
    mainTotalTokens += turnTotal;
    cacheHitDenominatorTokens += computeCacheHitDenominatorTokens(model, {
      inputTokens: inp,
      outputTokens: out,
      cacheReadTokens: cr,
      cacheCreationTokens: cc,
    });

    // 当前上下文估算（跳过 usage 全为 0 的合成/错误消息）
    if (inp > 0 || out > 0) {
      const mode = getUsageAccountingMode(model);
      if (mode === 'input_includes_cache') {
        // Ark Responses+chain / OpenAI-compat：cache_read 是本 leg 中被缓存命中
        // 的部分，input_tokens 已经包含它。语义分三类：
        //   - 首次看到 usage（不管 cache_read 有没有值）：无法追溯 chain 历史，
        //     直接把 input+output 视为当前累计上下文（cache_read 是历史被缓存
        //     的近似占位）。
        //   - 之后 cache_read=0：视为重锚点（/compact 清链、cache 过期、跨模型
        //     接力等触发全量重发），累计归位到 input+output。
        //   - 之后 cache_read>0：接续同一 chain，本 leg 净新增 = input - cache_read。
        if (!sawFirstUsage || cr === 0) {
          accumulatingContextTokens = inp + out;
        } else {
          const delta = Math.max(0, inp - cr);
          accumulatingContextTokens += delta + out;
        }
        lastContextTokens = accumulatingContextTokens;
      } else {
        // cache_tokens_separate（Anthropic）/ unknown：每轮 input_tokens 本身就是
        // 净新增（不含 cache_read/cache_creation），累加口径 = full-history。
        // 稳定形态是最后一 leg 的 turnTotal 即当前上下文，沿用老口径。
        if (turnTotal > 0) lastContextTokens = turnTotal;
        accumulatingContextTokens = lastContextTokens;
      }
      sawFirstUsage = true;
    }

    // 分项累加
    totalInputTokens += inp;
    totalCacheReadTokens += cr;
    totalCacheCreationTokens += cc;
    totalOutputTokens += out;
  }

  if (!hasUsage) return null;

  return {
    contextTokens: lastContextTokens,
    totalInputTokens,
    totalCacheReadTokens,
    totalCacheCreationTokens,
    totalOutputTokens,
    subagentTotalTokens,
    totalTokens: mainTotalTokens + subagentTotalTokens,
    cacheHitDenominatorTokens,
    cacheHitRatio: cacheHitDenominatorTokens > 0 ? totalCacheReadTokens / cacheHitDenominatorTokens : null,
  };
}

// ============================================
// Transcript summary (with in-memory mtime cache)
// ============================================

/** 小文件阈值：低于此值直接全量 readline 扫描 */
const SMALL_FILE_THRESHOLD = 128 * 1024; // 128KB
/** 头部读取字节数（覆盖头部 3-5 行，提取 title + createdAtMs） */
const HEAD_BYTES = 8192; // 8KB
/** 尾部读取字节数（覆盖尾部约 20-30 行，提取最后一条 assistant preview） */
const TAIL_BYTES = 64 * 1024; // 64KB

/**
 * 从文件头部读取若干字节，返回完整行数组（丢弃最后一行可能的截断行）。
 */
async function readHeadLines(filePath: string, byteCount: number): Promise<string[]> {
  const fh = await fs.open(filePath, "r");
  try {
    const buf = Buffer.alloc(byteCount);
    const { bytesRead } = await fh.read(buf, 0, byteCount, 0);
    if (bytesRead === 0) return [];
    const text = buf.subarray(0, bytesRead).toString("utf-8");
    const lines = text.split("\n");
    // 没读到文件末尾时，最后一行可能被截断 — 丢弃
    if (bytesRead === byteCount) lines.pop();
    return lines.filter((l) => l.trim() !== "");
  } finally {
    await fh.close();
  }
}

/**
 * 从文件尾部读取若干字节，返回完整行数组（丢弃第一行可能的截断行）。
 * 行顺序与文件中的原始顺序一致。
 */
async function readTailLines(filePath: string, fileSize: number, byteCount: number): Promise<string[]> {
  if (fileSize === 0) return [];
  const readSize = Math.min(byteCount, fileSize);
  const offset = fileSize - readSize;

  const fh = await fs.open(filePath, "r");
  try {
    const buf = Buffer.alloc(readSize);
    const { bytesRead } = await fh.read(buf, 0, readSize, offset);
    if (bytesRead === 0) return [];
    const text = buf.subarray(0, bytesRead).toString("utf-8");
    const lines = text.split("\n");
    // 不是从文件头开始读的，第一行可能被截断 — 丢弃
    if (offset > 0) lines.shift();
    return lines.filter((l) => l.trim() !== "");
  } finally {
    await fh.close();
  }
}

/**
 * 从头部行中提取 title 和 createdAtMs。
 */
function extractHeadFields(headLines: string[]): { title?: string; createdAtMs?: number } {
  let title: string | undefined;
  let createdAtMs: number | undefined;

  for (const line of headLines) {
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    if (createdAtMs === undefined) {
      const tsMs = toTsMs(obj?.timestamp) ?? toTsMs(obj?.ts) ?? toTsMs(obj?.startedAtMs);
      if (tsMs) createdAtMs = tsMs;
    }

    if (title === undefined && obj?.type === "user" && obj?.message?.content != null) {
      const content = obj.message.content;
      if (typeof content === "string" && !isSkillContextText(content)) {
        title = extractTitleFromContent(content);
      } else if (Array.isArray(content)) {
        const textBlock = content.find((b: any) => b?.type === "text");
        if (textBlock && typeof textBlock.text === "string" && !isSkillContextText(textBlock.text)) {
          title = extractTitleFromContent(textBlock.text);
        }
      }
    }

    if (createdAtMs !== undefined && title !== undefined) break;
  }

  return { title, createdAtMs };
}

/**
 * 从尾部行中反向查找最后一条 assistant 消息的文本作为 preview。
 */
function extractLastAssistantPreview(tailLines: string[]): string | undefined {
  for (let i = tailLines.length - 1; i >= 0; i--) {
    const line = tailLines[i];
    // 快速字符串预筛，跳过非 assistant 行
    if (!line.includes('"type":"assistant"') && !line.includes('"type": "assistant"')) {
      continue;
    }

    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    if (obj?.type !== "assistant" || !obj?.message?.content) continue;

    const content = obj.message.content;
    if (typeof content === "string") {
      return content.slice(0, 200);
    }
    if (Array.isArray(content)) {
      const textBlock = content.find((b: any) => b?.type === "text");
      if (textBlock && typeof textBlock.text === "string") {
        return textBlock.text.slice(0, 200);
      }
    }
  }

  return undefined;
}

/** 大文件：并行读取头部和尾部 */
async function summarizeLargeFile(filePath: string, fileSize: number): Promise<TranscriptSummary> {
  const [headLines, tailLines] = await Promise.all([
    readHeadLines(filePath, HEAD_BYTES),
    readTailLines(filePath, fileSize, TAIL_BYTES),
  ]);

  const { title, createdAtMs } = extractHeadFields(headLines);
  const preview = extractLastAssistantPreview(tailLines);

  return { title, preview, createdAtMs };
}

/** 小文件：全量 readline 扫描（原逻辑） */
async function summarizeFullScan(filePath: string): Promise<TranscriptSummary> {
  let title: string | undefined;
  let createdAtMs: number | undefined;
  let lastAssistantText: string | undefined;
  let isFirstUserPrompt = true;

  const rl = readline.createInterface({
    input: createReadStream(filePath, { encoding: "utf-8" }),
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

    const tsMs = toTsMs(obj?.timestamp) ?? toTsMs(obj?.ts) ?? toTsMs(obj?.startedAtMs);
    if (!createdAtMs && tsMs) createdAtMs = tsMs;

    if (isFirstUserPrompt && obj?.type === "user" && obj?.message?.content != null) {
      const content = obj.message.content;
      if (typeof content === "string" && !isSkillContextText(content)) {
        title = extractTitleFromContent(content);
        isFirstUserPrompt = false;
      } else if (Array.isArray(content)) {
        const textBlock = content.find((b: any) => b?.type === "text");
        if (textBlock && typeof textBlock.text === "string" && !isSkillContextText(textBlock.text)) {
          title = extractTitleFromContent(textBlock.text);
          isFirstUserPrompt = false;
        }
      }
    }

    if (obj?.type === "assistant" && obj?.message?.content) {
      const content = obj.message.content;
      if (typeof content === "string") {
        lastAssistantText = content;
      } else if (Array.isArray(content)) {
        const textBlock = content.find((b: any) => b?.type === "text");
        if (textBlock && typeof textBlock.text === "string") {
          lastAssistantText = textBlock.text;
        }
      }
    }
  }

  const preview = lastAssistantText?.slice(0, 200);
  return { title, preview, createdAtMs };
}

const summaryCache = new Map<string, { mtimeMs: number; summary: TranscriptSummary }>();
const transcriptParseCache = new Map<string, { mtimeMs: number; parsed: ParsedTranscript }>();
const transcriptParseInFlight = new Map<string, Promise<ParsedTranscript>>();

export async function summarizeTranscript(
  transcriptPath: string,
): Promise<TranscriptSummary> {
  const resolved = assertAllowedTranscriptPath(transcriptPath);
  const stat = await fs.stat(resolved);

  // 命中缓存：mtime 未变则直接返回
  const cached = summaryCache.get(resolved);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached.summary;
  }

  const summary = stat.size > SMALL_FILE_THRESHOLD
    ? await summarizeLargeFile(resolved, stat.size)
    : await summarizeFullScan(resolved);

  summaryCache.set(resolved, { mtimeMs: stat.mtimeMs, summary });
  return summary;
}

export async function parseTranscriptFile(
  transcriptPath: string,
): Promise<ParsedTranscript> {
  const resolved = assertAllowedTranscriptPath(transcriptPath);
  const stat = await fs.stat(resolved);

  const cached = transcriptParseCache.get(resolved);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    apiLogger.info(`[transcript] detail cache hit path=${resolved}`);
    return cached.parsed;
  }

  const existing = transcriptParseInFlight.get(resolved);
  if (existing) {
    apiLogger.info(`[transcript] detail singleflight join path=${resolved}`);
    return existing;
  }

  const startedAt = Date.now();
  const parsePromise = parseTranscriptFileUncached(resolved)
    .then((parsed) => {
      transcriptParseCache.set(resolved, { mtimeMs: stat.mtimeMs, parsed });
      const durationMs = Date.now() - startedAt;
      apiLogger.info(`[transcript] detail cache miss path=${resolved} duration=${durationMs}ms blocks=${parsed.blocks.length} lines=${parsed.stats.lines}`);
      return parsed;
    })
    .finally(() => {
      transcriptParseInFlight.delete(resolved);
    });

  transcriptParseInFlight.set(resolved, parsePromise);
  return parsePromise;
}

/**
 * Agent Plan 协议适配防御层
 *
 * 集中实现火山 Agent Plan v3 端点上观察到的协议冲突缓解逻辑。
 * 所有 helper 都是纯函数（除日志副作用），便于复核与单测。
 *
 * 落地依据：`assets/20260620/Agent-Plan协议冲突主报告.md` 章节 1
 * 「冲突可在 ResponsesApiAdapter 屏蔽的」。
 *
 * 维护原则：
 * - 只做最小必要的字符串改写，不试图替代模型理解能力。
 * - 不抛错（除非 DSML reroute 那一条上层有重试路径）；其余命中只 warn + 改写。
 * - escape 用 zero-width-space (U+200B) 插入到关键 token 中间，
 *   既打断模式匹配又保留原文可读（与彻底删除相比，便于 debug 与告警上下文）。
 */

import { createLogger } from '../utils/logger.js';

const logger = createLogger('AgentPlanDefense');

// ─────────────────────────────────────────────────────────────
// A3 + B2: user 通道伪装系统注入模式签名
// ─────────────────────────────────────────────────────────────

/**
 * 已知 user 通道 prompt-injection 模式签名。
 *
 * 来源（实测打脸 deepseek 100% 屈服并泄漏 instructions 全文）：
 * - 主报告 B2：`<system-reminder>` / `<important-instructions>` / `<platform-policy>` /
 *   `<system_override>` 标签家族
 * - 主报告 A3：`<tool_call name=` / `<invoke name=` / `<function_calls>` XML
 *   句式触发 doubao "语法肌肉记忆" 降级
 *
 * 命中后用 zero-width-space 插入打断模式（不删原文，让告警上下文完整）。
 */
/**
 * 注入模式签名（fuzzy 匹配）：
 * - 名称允许 `-` `_` 或空格分隔（system-reminder / system_reminder / system reminder 全命中）
 * - 复数 `instructions?` `polic(y|ies)` 容差
 * - 允许标签内有 attribute（`\s` 后随 attribute 也命中尾部 `\s`）
 * - 二轮加固：除 ASCII 破折号外，输入会先做 unicode dash → `-` 归一化 + NFKC + 零宽字符清理（详 normalizeForInjectionScan）
 */
const INJECTION_TAG_PATTERNS: ReadonlyArray<{ regex: RegExp; label: string }> = [
  { regex: /<(\/?)\s*(system[-_ ]?reminder|important[-_ ]?instructions?|platform[-_ ]?polic(?:y|ies)|system[-_ ]?override)([\s>])/gi, label: 'pseudo-system-tag' },
  { regex: /<(\/?)\s*(function[-_ ]?calls?|tool[-_ ]?call|invoke)([\s>])/gi, label: 'tool-xml-mimicry' },
  // ChatML / Qwen / DeepSeek / Mistral / Alpaca tokenizer marker 风格
  { regex: /<\|(im_start|im_end|system|assistant|user|bos|eos)\|>/gi, label: 'chatml-marker' },
];

/** 替换攻击者常用的 unicode lookalike → ASCII。 */
const UNICODE_DASH_LIKE = /[‐-―−⁃˗﹘﹣－]/g;

/**
 * 二轮加固：对输入做扫描前归一化，把攻击者常见的 bypass 形态映射为标准形式。
 * - 替换数学减号 / em-dash / en-dash 等 ↔ ASCII `-`
 * - 移除零宽字符（U+200B/200C/200D/FEFF）防止攻击者预插
 *
 * 注意：曾试过 `.normalize('NFKC')` 但副作用是把中文全角逗号 `，` 转成 ASCII `,`、
 * 全角句号转半角等，污染用户文本可见输出。本场景只需对抗 dash lookalike，不做 NFKC。
 */
function normalizeForInjectionScan(text: string): string {
  return text
    .replace(UNICODE_DASH_LIKE, '-')
    .replace(/[​-‍﻿]/g, '');
}

/**
 * 检测 user message 是否含已知伪装注入模式（基于归一化后的副本扫描）。
 * 返回命中数（>0 表示已 escape）。
 *
 * 策略：用归一化文本做扫描定位匹配区间，把原文中**相同区间**的标签名用 U+200B
 * 打断。这保留了原文其他字符（包括用户合法的 unicode 字符）不被改动，同时让
 * tokenizer 看到的标签名不再是已知 attack token。
 *
 * 简化实现：扫归一化文本得到匹配区间 → 直接在归一化文本上做替换 → 返回。
 * （归一化的副作用是攻击者用 unicode 减号写的标签会被还原为 ASCII 后 escape，
 * 用户合法的 unicode 减号在 user content 中极少见，可接受。）
 */
export function sanitizeInjectionTags(text: string): { text: string; hits: number; labels: string[] } {
  let result = normalizeForInjectionScan(text);
  let totalHits = 0;
  const labels: string[] = [];
  for (const { regex, label } of INJECTION_TAG_PATTERNS) {
    let localHits = 0;
    result = result.replace(regex, (match: string, ...rest: unknown[]) => {
      localHits += 1;
      // 找到标签名（regex 的 capture group 1 或 2，取决于 pattern）
      // 三个 pattern 都是 group 1 = `\/?`，group 2 = name；chatml-marker pattern group 1 = name。
      const isChatml = match.startsWith('<|');
      const name = isChatml ? (rest[0] as string) : (rest[1] as string);
      const slash = isChatml ? '' : (rest[0] as string ?? '');
      const tail = isChatml ? '' : (rest[2] as string ?? '');
      // Array.from 保证 surrogate-safe 切割（防止未来加非 ASCII tag 名时切坏）
      const chars = Array.from(name);
      const broken = chars.length > 1 ? `${chars[0]}​${chars.slice(1).join('')}` : `${name}​`;
      if (isChatml) return `<|${broken}|>`;
      return `<${slash}${broken}${tail}`;
    });
    if (localHits > 0) {
      totalHits += localHits;
      labels.push(`${label}:${localHits}`);
    }
  }
  return { text: result, hits: totalHits, labels };
}

// ─────────────────────────────────────────────────────────────
// B4: 长英文 user query 自动追加中文 leading
// ─────────────────────────────────────────────────────────────

/** 触发中文 leading 的最短长度（实测来源：assets/20260620/Agent-Plan协议冲突主报告.md §B4，主测样本 700 字符英文 query 触发翻转；阈值 300 为保守边界）。 */
const CHINESE_LEADING_MIN_LENGTH = 300;
const CHINESE_LEADING_MIN_ASCII_RATIO = 0.8;
const CHINESE_LEADING = '请用简体中文回答以下问题：\n\n';

// 扩展的 CJK 范围：日语 hiragana/katakana + 韩语 hangul + 中文 CJK + Ext A/B + CJK 标点
const CJK_RE = /[　-〿぀-ゟ゠-ヿ가-힯一-鿿㐀-䶿]|[\uD840-\uD87F][\uDC00-\uDFFF]/;
// 用户明确语言诉求（"请用英文 / in English / respond in"）→ 跳过中文 leading
const ENGLISH_INTENT_RE = /\b(in english|respond in english|answer (me )?in english|reply in english|use english)\b/i;
// URL / 代码 / 命令 / 路径启发
const CODE_OR_PATH_RE = /```|>>>|https?:\/\/|^\s*[\/\\]|^[A-Za-z]:[\\\/]|\bfunction\s|\bclass\s|\bdef\s|^\s*\$\s|^\s*>\s/m;

/**
 * 主报告 B4：长英文 user query 触发 glm/deepseek 翻转为纯英文输出，违反产品中文优先定位。
 * 实测控制组证明追加一句中文 leading 即可扳回 ≥60% 中文比例。
 *
 * 二轮加固扩展的排除场景（避免误伤）：
 * - 已经以 CJK（中日韩）字符起手 — 包括 hiragana/katakana/hangul/CJK Ext A/B
 * - 看起来像代码 / 命令 / URL / 路径
 * - 用户明确表达"用英文回答"诉求
 */
export function maybePrependChineseLeading(text: string): string {
  if (text.length < CHINESE_LEADING_MIN_LENGTH) return text;
  const head = text.slice(0, 30);
  if (CJK_RE.test(head)) return text;
  if (CODE_OR_PATH_RE.test(text)) return text;
  if (ENGLISH_INTENT_RE.test(text)) return text;
  const asciiCount = countAscii(text);
  if (asciiCount / text.length < CHINESE_LEADING_MIN_ASCII_RATIO) return text;
  return `${CHINESE_LEADING}${text}`;
}

function countAscii(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code <= 0x7f) n += 1;
  }
  return n;
}

// ─────────────────────────────────────────────────────────────
// 统一 user message 预处理入口
// ─────────────────────────────────────────────────────────────

export interface UserTextDefenseOptions {
  /** 是否启用 injection tag escape。默认 true。 */
  sanitizeInjection?: boolean;
  /** 是否启用长英文中文 leading。默认 true。 */
  maybeChineseLeading?: boolean;
  /** 日志用 session 短 id，命中告警时附带便于追踪。 */
  sessionIdShort?: string;
}

/**
 * 主入口：把 raw user message 文本走全套防御后返回 sanitized text。
 *
 * 调用方一律走这个 helper，不要在 adapter 里散落实现 — 集中后便于
 * 子 agent 复核与配置版本演进。
 */
export function defendUserText(raw: string, options: UserTextDefenseOptions = {}): string {
  const {
    sanitizeInjection = true,
    maybeChineseLeading = true,
    sessionIdShort,
  } = options;

  let text = raw;

  if (sanitizeInjection) {
    const { text: sanitized, hits, labels } = sanitizeInjectionTags(text);
    if (hits > 0) {
      logger.warn(
        `User 通道注入模式命中 — 已 escape。hits=${hits} labels=[${labels.join(',')}] `
        + `session=${sessionIdShort ?? '-'} preview="${raw.slice(0, 120).replace(/\n/g, '\\n')}"`,
      );
    }
    text = sanitized;
  }

  if (maybeChineseLeading) {
    text = maybePrependChineseLeading(text);
  }

  return text;
}

// ─────────────────────────────────────────────────────────────
// 平台注入上下文块（memory-context / compaction summary / retrieval）
// ─────────────────────────────────────────────────────────────

/**
 * 平台在 user role 注入的系统上下文块前缀：
 * - `<memory-context>`：rawAgentLoop.formatMemoryContext（会话首轮长期记忆）
 * - `<context-summary>`：contextProjection.formatCompactionSummary（/compact 摘要）
 * - `<session-retrieval-results>`：contextProjection.formatRetrievalMessage（检索投影）
 *
 * 这些消息不是用户输入，中文 leading（B4）不适用。
 * 注入 escape（A3/B2）仍需执行——记忆/摘要正文可能被写入过恶意标签。
 *
 * 判定安全性：真实用户消息在 dispatch 层（buildPrompt）已强制加 `[时间戳] ` 前缀，
 * 到 adapter 时不可能以这些标签开头，用户无法伪造命中。
 */
const PLATFORM_CONTEXT_BLOCK_PREFIXES = [
  '<memory-context>',
  '<context-summary>',
  '<session-retrieval-results>',
] as const;

export function isPlatformContextBlock(text: string): boolean {
  return PLATFORM_CONTEXT_BLOCK_PREFIXES.some((prefix) => text.startsWith(prefix));
}

/**
 * adapter 层 user role 消息的统一、确定性防御入口。时间戳由消息进入 runtime 时
 * 的 buildPrompt（子 Agent 由 subagentRunner）固化一次；adapter 重放历史时绝不能
 * 读取当前时钟或改写时间戳，否则 full replay 的 prompt prefix 会按分钟失效。
 * 平台注入上下文块跳过中文 leading，只保留注入 escape；真实用户消息走 escape +
 * 中文 leading。三个 adapter 调用点（Responses 全量/增量、Chat Completions）一律
 * 用这个，不要散落各自判断。
 */
export function defendUserMessageText(raw: string, sessionIdShort?: string): string {
  const platformBlock = isPlatformContextBlock(raw);
  return defendUserText(raw, {
    sessionIdShort,
    maybeChineseLeading: !platformBlock,
  });
}

// ─────────────────────────────────────────────────────────────
// C1: mojibake 检测（UTF-8 字节按 Latin-1 reinterpret 再 UTF-8 编码的双重编码特征）
// ─────────────────────────────────────────────────────────────

/**
 * 主报告 C1 历史观测：火山 server 端把 description / output_text 的 UTF-8
 * 字节按 Latin-1 单字节 reinterpret 再 UTF-8 编码，常见结果是中文每字节
 * 变成 `Ã¥` / `Ã¦` / `ÂX` 类双字节序列。
 *
 * 当前不可复现，但保留检测；命中后只 warn，不修改文本（绝不应直接编码绕开 —
 * 添加 base64/percent-encoding 类兼容反而增加上下文污染风险）。
 *
 * 检测策略：扫描 ASCII 范围外的连续 `Ã` 或 `Â` + 任意字符，2 个以上序列视为命中。
 */
export function detectMojibake(text: string): { hit: boolean; sampleCount: number } {
  if (!text) return { hit: false, sampleCount: 0 };
  // U+00C3 (Ã) 与 U+00C2 (Â) 是 Latin-1 reinterpret UTF-8 后最典型的 marker
  // 字节，正常中文 / 常见西文文本中极少连续出现 2 次以上。
  const pattern = /[ÂÃ][-ÿ]/g;
  const matches = text.match(pattern);
  const count = matches?.length ?? 0;
  return { hit: count >= 2, sampleCount: count };
}

// ─────────────────────────────────────────────────────────────
// E3 doubao DSML 泄漏检测（已有 warn，升级为可触发上层重试的检测函数）
// ─────────────────────────────────────────────────────────────

/**
 * 二轮加固：复核发现原实现 case-sensitive + 不容空白，doubao 重新生成时若有变体
 * （如小写 `<｜dsml｜tool_calls>` 或 `< ｜DSML｜tool_calls>`）会完全 bypass。
 * 升级为 case-insensitive + 容忍标记内外空白，且同时识别 ASCII 竖线 `|` 与全角 `｜`。
 */
const DSML_LEAK_PATTERN = /<\s*[|｜]\s*dsml\s*[|｜]/i;

export function detectDsmlLeak(text: string): boolean {
  if (!text) return false;
  return DSML_LEAK_PATTERN.test(text);
}

// ─────────────────────────────────────────────────────────────
// D1: deepseek arguments 双层 escape 反转
// ─────────────────────────────────────────────────────────────

/**
 * 主报告 D1：deepseek-v4-pro 在 emit tool_call.arguments JSON string 字段时
 * 把所有反斜杠多 escape 一层 — 用户希望传字面 `\n`（2 字符）会被 emit 为
 * `\\n`（3 字符），`\t` / `\"` 同理；2/2 稳定复现。
 *
 * 修法：在 SSE delta 累积完成后，对包含可疑双 escape 模式的 arguments 字符串
 * 做一次反向 unescape。仅在 providerOptions.applyDeepseekArgumentUnescape=true
 * 的模型路径启用，避免误伤 doubao / glm。
 *
 * 限制：仅识别 `\\n` `\\t` `\\r` `\\"` `\\\\` 五种最常见 escape；其他罕见
 * escape（`\\b` `\\f` `\\uXXXX`）维持原样（避免改变语义）。
 *
 * 注意：args 已经是 raw arguments string（含外层 JSON 引号），unescape 只
 * 处理 JSON string 字面值层 — 拿到的 JSON 解析后字段字符串里多出的 `\\`。
 * 因此实现是 parse-then-rewrite：尝试 parse → 对 string 类字段 unescape → restringify。
 */
export function unescapeDeepseekArguments(args: string): string {
  if (!args) return args;
  // 没有可疑模式直接 short-circuit（不解析 JSON，零开销）。
  // raw JSON 中 deepseek 错误 emit 表现为「2 个字面反斜杠 + n/t/r/"/字面反斜杠」3 char 序列。
  // JS regex literal /\\\\[ntr"\\]/ 中 \\\\ 解释为 2 个字面反斜杠。
  if (!/\\\\[ntr"\\]/.test(args)) return args;
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    return args;
  }
  const rewritten = deepUnescapeStrings(parsed);
  try {
    return JSON.stringify(rewritten);
  } catch {
    return args;
  }
}

function deepUnescapeStrings(value: unknown): unknown {
  if (typeof value === 'string') return unescapeDoubleEscapedJsonString(value);
  if (Array.isArray(value)) return value.map(deepUnescapeStrings);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = deepUnescapeStrings(v);
    }
    return out;
  }
  return value;
}

/**
 * 在 JSON parse 之后的字符串字段值上做反向 unescape：
 * - 输入示例（parse 后字段值）：`a\nb`（字面 2 char `\` + `n`，即"反斜杠+字母n"）
 * - 输出示例：`a` + newline + `b`（字面 newline 1 char）
 *
 * 二轮加固：原实现用 `\x00` 作占位符，若用户原本传含 NUL 的 binary base64 解码字段
 * 会被错替换为反斜杠（数据腐化）。改用 Unicode 私有区 ``（PUA），用户文本几乎
 * 不会使用 PUA 字符。
 *
 * 只处理 5 种最常见 escape；罕见 `\b` `\f` `\uXXXX` 维持原样避免改变语义。
 */
function unescapeDoubleEscapedJsonString(s: string): string {
  return s
    .replace(/\\\\/g, '')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r')
    .replace(/\\"/g, '"')
    .replace(//g, '\\');
}

// ─────────────────────────────────────────────────────────────
// D4: tool error 措辞标准化（避免 deepseek 字面回声"try different approach"）
// ─────────────────────────────────────────────────────────────

/**
 * 主报告 D4：deepseek 把 error message 措辞当字面指令执行 —
 * "ERROR: tool unavailable, please try different approach" → 模型真的换语言
 * 重试工具调用，可能进入循环。
 *
 * 标准化原则：错误措辞用具体指令式（"请勿重试，请告知用户"）替代含糊建议。
 */
export function standardizeToolError(rawMessage: string): string {
  const trimmed = (rawMessage ?? '').trim();
  if (!trimmed) return '工具执行失败：请勿重试，请告知用户错误已上报。';
  // 二轮加固：短路条件从"全文包含"收紧为"末尾 30 字符内包含"，避免工具结果含
  // 用户字面文本 "the user said 'do not retry'" 触发误判跳过加后缀。
  const tail = trimmed.slice(-30);
  if (/请勿重试|请告知用户|do not retry|stop retrying/i.test(tail)) return trimmed;
  return `${trimmed}（请勿重试，请告知用户）`;
}

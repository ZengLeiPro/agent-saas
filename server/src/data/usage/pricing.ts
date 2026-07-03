/**
 * Token 单价表（USD per 1M tokens）+ cost 计算工具
 *
 * 设计原则：
 *   - 价格表为唯一权威源。**不再使用** SDK Result 给的 `costUSD` 字段：
 *     a) SDK 在 OAuth Max 20x 模式下报的是统计意义的 cost，不是真实账单
 *     b) SDK 对 CLIProxyAPI 转发的 GPT/国产模型用 Anthropic 价格估算，与真实计费偏差大
 *     c) 历史 jsonl 回填路径根本拿不到 SDK 的 costUSD
 *     由本地价格表统一计算，实时路径与回填路径走同一函数，结果一致
 *
 *   - cache write 单价按 **1h TTL** 计（KY Agent 默认开 1h cache）：Anthropic 文档
 *     1h cache write = 2× base input；5min = 1.25× base input。两者 SDK 给的
 *     `cacheCreationInputTokens` 不区分，我们统一按 1h 计
 *
 *   - 管理员可在 config.json 的 models.groups[].models[].pricing 覆盖内置单价；
 *     未配置时回退到下方内置表。
 *
 *   - 未知模型：返回 0 + 一次性 warn（按 model 去重避免日志爆炸）
 *
 *   - `<synthetic>` 等 SDK 内部合成消息：显式列为 0 单价，不告警
 *
 * 价格表来源：
 *   - Anthropic: https://platform.claude.com/docs/en/about-claude/pricing
 *   - OpenAI:    https://openai.com/api/pricing/
 *   - MiniMax:   https://platform.minimaxi.com/docs/guides/pricing-paygo
 *   - Kimi:      https://platform.kimi.ai/docs/pricing/chat-k26
 *   - 豆包：      第三方聚合页（≈估算，CLIProxyAPI 转发场景已足够）
 *
 * 调价时：
 *   1) 优先在平台管理 → 模型管理里维护单模型 pricing；或改 PRICING 表作为内置默认值
 *   2) 改内置 PRICING 时递增 PRICING_VERSION（用于 DB 追溯每行用的哪版价格）
 *   3) 如需对历史数据重算，触发一次 rebuild（清表 + 全量回填）
 */

export const PRICING_VERSION = '2026-06-26-v3';

export type UsageAccountingMode =
  | 'input_includes_cache'
  | 'cache_tokens_separate';

export interface ModelPrice {
  /** 输入 token 单价（USD per 1M tokens） */
  input: number;
  /** 输出 token 单价 */
  output: number;
  /** cache write 单价（按 1h TTL）。GPT/国产模型 cache 机制不同，置 0 表示不算 */
  cacheCreation: number;
  /** cache read 单价。Anthropic = 0.1× input；OpenAI ≈ 0.1× input */
  cacheRead: number;
}

export interface PricingModelConfig {
  value: string;
  alias_actual?: string;
  pricing?: ModelPrice;
  usage_accounting?: UsageAccountingMode;
  /** 模型上下文窗口（token 数）。自动压缩阈值判断用；未配置则该模型不触发自动压缩。 */
  context_window?: number;
}

export interface PricingModelsConfig {
  groups: Array<{ models: PricingModelConfig[] }>;
}

/**
 * 模型 → 单价。key 是 SDK 给出的 model id 原样字符串。
 *
 * 注意：1M 上下文窗口下 Anthropic 仍是标准价（官方文档：
 * "a 900k-token request is billed at the same per-token rate as a 9k-token request"），
 * 但 model id 带 `[1m]` 后缀需要单独列出，避免归一化后丢失这条记录。
 */
const PRICING: Record<string, ModelPrice> = {
  // ─── Anthropic Claude（cache write 按 1h TTL）───
  'claude-opus-4-7':      { input: 5,   output: 25, cacheCreation: 10,    cacheRead: 0.50 },
  'claude-opus-4-7[1m]':  { input: 5,   output: 25, cacheCreation: 10,    cacheRead: 0.50 },
  'claude-opus-4-6':      { input: 5,   output: 25, cacheCreation: 10,    cacheRead: 0.50 },
  'claude-opus-4-5':      { input: 5,   output: 25, cacheCreation: 10,    cacheRead: 0.50 },
  'claude-opus-4-1':      { input: 15,  output: 75, cacheCreation: 30,    cacheRead: 1.50 },
  'claude-opus-4':        { input: 15,  output: 75, cacheCreation: 30,    cacheRead: 1.50 },
  'claude-sonnet-4-6':    { input: 3,   output: 15, cacheCreation: 6,     cacheRead: 0.30 },
  'claude-sonnet-4-5':    { input: 3,   output: 15, cacheCreation: 6,     cacheRead: 0.30 },
  'claude-sonnet-4':      { input: 3,   output: 15, cacheCreation: 6,     cacheRead: 0.30 },
  'claude-haiku-4-5':     { input: 1,   output: 5,  cacheCreation: 2,     cacheRead: 0.10 },
  'claude-haiku-3-5':     { input: 0.80, output: 4, cacheCreation: 1.60,  cacheRead: 0.08 },

  // ─── OpenAI GPT（经 CLIProxyAPI 转发，近似精度即可）───
  'gpt-5.5':              { input: 5,    output: 30,   cacheCreation: 0, cacheRead: 0.50 },
  'gpt-5.4':              { input: 2.50, output: 15,   cacheCreation: 0, cacheRead: 0.25 },
  'gpt-5.4-mini':         { input: 0.75, output: 4.50, cacheCreation: 0, cacheRead: 0.075 },
  'gpt-5.4-nano':         { input: 0.20, output: 1.25, cacheCreation: 0, cacheRead: 0.02 },
  'gpt-5.3-codex':        { input: 1.75, output: 14,   cacheCreation: 0, cacheRead: 0.175 },
  // OpenAI 价表当前只单列 gpt-5.3-codex；Spark API 仍属 research preview，
  // 未见独立公开价格。先按 Codex 5.3 标准价估算，真实账单可在 config.json 覆盖。
  'gpt-5.3-codex-spark':  { input: 1.75, output: 14,   cacheCreation: 0, cacheRead: 0.175 },
  'gpt-5':                { input: 1.25, output: 10,   cacheCreation: 0, cacheRead: 0.125 },
  'gpt-5-mini':           { input: 0.25, output: 2,    cacheCreation: 0, cacheRead: 0.025 },

  // ─── 国产（估算，CLIProxyAPI 转发，cache 机制不显式收费按 0）───
  'doubao-seed-2.0-pro':  { input: 0.47,  output: 2.37, cacheCreation: 0, cacheRead: 0.047 },
  // CLIProxy / OpenAI Agents 配置里的别名；未查到独立官方价，沿用 doubao-seed-2.0-pro 估算价。
  'doubao-pro':           { input: 0.47,  output: 2.37, cacheCreation: 0, cacheRead: 0.047 },
  'doubao-seed-2.0-lite': { input: 0.10,  output: 0.50, cacheCreation: 0, cacheRead: 0.01 },
  'kimi-k2.6':            { input: 0.95,  output: 4.00, cacheCreation: 0,     cacheRead: 0.16 },
  'kimi-2.6':             { input: 0.95,  output: 4.00, cacheCreation: 0,     cacheRead: 0.16 },
  'MiniMax-M2.7':         { input: 0.30,  output: 1.20, cacheCreation: 0.375, cacheRead: 0.06 },
  'minimax-2.7':          { input: 0.30,  output: 1.20, cacheCreation: 0.375, cacheRead: 0.06 },

  // ─── 火山引擎 Agent Plan v3 新模型（RFC v1 P0.5 落地）───
  // 曾磊 2026-06-20 报价：input 0.0120 元/千 tokens、output 0.0240 元/千 tokens（统一价）
  // USD/M 换算：input 12 ¥/M ÷ 7.2 ≈ 1.67 USD/M，output 24 ¥/M ÷ 7.2 ≈ 3.33 USD/M
  // 真实别名（response.model 返回值）和 config.json 里 value 都登记，保险两端命中
  'doubao-seed-2.0-code':           { input: 1.67, output: 3.33, cacheCreation: 0, cacheRead: 0.167 },
  'doubao-seed-2-0-code-preview-260215': { input: 1.67, output: 3.33, cacheCreation: 0, cacheRead: 0.167 },
  'doubao-seed-2-0-pro-260215':     { input: 1.67, output: 3.33, cacheCreation: 0, cacheRead: 0.167 },
  'glm-5.2':                        { input: 1.67, output: 3.33, cacheCreation: 0, cacheRead: 0.167 },
  'deepseek-v4-pro':                { input: 1.67, output: 3.33, cacheCreation: 0, cacheRead: 0.167 },
  'deepseek-v4-pro-260425':         { input: 1.67, output: 3.33, cacheCreation: 0, cacheRead: 0.167 },
  'minimax-m3':                     { input: 1.67, output: 3.33, cacheCreation: 0, cacheRead: 0.167 },
  'kimi-k2.7-code':                 { input: 1.67, output: 3.33, cacheCreation: 0, cacheRead: 0.167 },
};

let configuredPricing: Record<string, ModelPrice> = {};
let configuredUsageAccounting: Record<string, UsageAccountingMode> = {};
let configuredContextWindows: Record<string, number> = {};

export function configureModelPricing(modelsConfig: PricingModelsConfig | undefined): void {
  const next: Record<string, ModelPrice> = {};
  const nextAccounting: Record<string, UsageAccountingMode> = {};
  const nextContextWindows: Record<string, number> = {};
  for (const group of modelsConfig?.groups ?? []) {
    for (const model of group.models ?? []) {
      if (model.pricing) {
        next[model.value] = model.pricing;
        if (model.alias_actual) next[model.alias_actual] = model.pricing;
      }
      if (model.usage_accounting) {
        nextAccounting[model.value] = model.usage_accounting;
        if (model.alias_actual) nextAccounting[model.alias_actual] = model.usage_accounting;
      }
      if (typeof model.context_window === 'number' && model.context_window > 0) {
        nextContextWindows[model.value] = model.context_window;
        if (model.alias_actual) nextContextWindows[model.alias_actual] = model.context_window;
      }
    }
  }
  configuredPricing = next;
  configuredUsageAccounting = nextAccounting;
  configuredContextWindows = nextContextWindows;
}

/**
 * 模型上下文窗口（token 数）。只认 config.json 显式配置（models.groups[].models[].context_window），
 * 不做内置猜测——窗口值直接决定自动压缩触发点，配错比不配危害更大。
 * 未配置返回 undefined，调用方（自动压缩）应视为「该模型不启用自动压缩」。
 */
export function getModelContextWindow(model: string): number | undefined {
  return configuredContextWindows[model];
}

/**
 * SDK 内部使用的合成消息标识。这些行通常代表 compact、思考占位等，
 * 不应进入未知模型告警。显式置 0 单价。
 */
const ZERO_COST_MODELS = new Set<string>(['<synthetic>']);

/** 进程级 warn 去重，避免同一个未知 model 反复刷日志 */
const warnedUnknownModels = new Set<string>();

export interface TokenAmounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export function getUsageAccountingMode(model: string): UsageAccountingMode {
  if (configuredUsageAccounting[model]) return configuredUsageAccounting[model];
  // Anthropic 原生 Messages usage 把 input/cache write/cache read 拆成独立分量。
  if (model.startsWith('claude-')) return 'cache_tokens_separate';
  // OpenAI-compatible / Responses / 火山 Agent Plan 均把 cached tokens 作为 input 子集。
  return 'input_includes_cache';
}

export function computeUsageTotalTokens(model: string, tokens: TokenAmounts): number {
  const inputTokens = Math.max(0, tokens.inputTokens);
  const outputTokens = Math.max(0, tokens.outputTokens);
  const cacheReadTokens = Math.max(0, tokens.cacheReadTokens);
  const cacheCreationTokens = Math.max(0, tokens.cacheCreationTokens);
  if (getUsageAccountingMode(model) === 'cache_tokens_separate') {
    return inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;
  }
  return inputTokens + outputTokens;
}

export function computeCacheHitDenominatorTokens(model: string, tokens: TokenAmounts): number {
  const inputTokens = Math.max(0, tokens.inputTokens);
  const cacheReadTokens = Math.max(0, tokens.cacheReadTokens);
  const cacheCreationTokens = Math.max(0, tokens.cacheCreationTokens);
  if (getUsageAccountingMode(model) === 'cache_tokens_separate') {
    return inputTokens + cacheReadTokens + cacheCreationTokens;
  }
  return inputTokens;
}

/**
 * 按价格表计算 cost，返回 micro USD（×1e6 整数，便于 SQLite 累加无精度问题）。
 *
 * 数学：
 *   USD = price_per_M × tokens / 1_000_000
 *   micro_USD = USD × 1_000_000 = price_per_M × tokens
 *   所以单项 micro = p.input × t.inputTokens（公式很简单）
 *
 * @param model SDK 给的 model id 原样字符串
 * @param tokens 4 类 token 用量
 * @param log 可选日志函数（默认 console.warn）
 */
export function computeCostMicro(
  model: string,
  tokens: TokenAmounts,
  log?: (msg: string) => void,
): number {
  if (!model || ZERO_COST_MODELS.has(model)) return 0;

  const p = configuredPricing[model] ?? PRICING[model];
  if (!p) {
    if (!warnedUnknownModels.has(model)) {
      warnedUnknownModels.add(model);
      const msg = `[pricing] unknown model "${model}" — cost=0；请在 server/src/data/usage/pricing.ts 补单价（当前版本 ${PRICING_VERSION}）`;
      (log ?? ((m: string) => console.warn(m)))(msg);
    }
    return 0;
  }

  const inputTokens = Math.max(0, tokens.inputTokens);
  const cacheReadTokens = Math.max(0, tokens.cacheReadTokens);
  const cacheCreationTokens = Math.max(0, tokens.cacheCreationTokens);
  const chargedInputTokens = getUsageAccountingMode(model) === 'cache_tokens_separate'
    ? inputTokens
    : Math.max(0, inputTokens - cacheReadTokens - cacheCreationTokens);

  const micro =
    p.input         * chargedInputTokens +
    p.output        * Math.max(0, tokens.outputTokens) +
    p.cacheRead     * cacheReadTokens +
    p.cacheCreation * cacheCreationTokens;

  return Math.max(0, Math.round(micro));
}

/** 测试用：重置 warn 去重集合 */
export function __resetPricingWarnCacheForTest(): void {
  warnedUnknownModels.clear();
}

/** 测试/管理脚本用：列出所有已知模型 */
export function listKnownModels(): string[] {
  return Array.from(new Set([...Object.keys(PRICING), ...Object.keys(configuredPricing)]));
}

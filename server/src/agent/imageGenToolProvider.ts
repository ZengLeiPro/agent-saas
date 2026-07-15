import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, extname, join, posix } from 'node:path';
import { z } from 'zod';

import type { BillingService } from '../data/billing/service.js';
import { CREDIT_MICRO, YUAN_MICRO } from '../data/billing/types.js';
import { getImageGenEnginePricing } from '../data/usage/imageGenPricing.js';
import type { EventAppendContext, PlatformEventInput } from '../runtime/types.js';
import { isPathWithinDirectory, resolveAuthorizedPath } from '../security/extraDirs.js';
import { loadToolDescription } from './tools/descriptionLoader.js';
import type {
  AuthorizedToolCall,
  ToolCallContext,
  ToolDescriptor,
  ToolProvider,
  ToolResult,
} from './toolRuntime.js';

/**
 * GenerateImage 平台内置生图工具（2026-07-15 批次）。
 *
 * 定位（仿 WebToolProvider）：brain 进程内执行的独立 ToolProvider，不进
 * WORKSPACE_HAND_TOOLS、不依赖 Shell/hand——受限 profile、无隔离 hand 的租户
 * 也可用，生图不占 ACS 冷启动。API key 由装配层经 secretVault 解析后留在
 * server 侧（绝不进 sandbox env、绝不上 wire）。
 *
 * risk:'safe' + approvalMode:'never' 的前提：落盘路径由 server 生成
 * （assets/generated/<YYYYMMDD>/img-<uuid8>.png），不接受模型传任意 path，
 * 且 'wx' flag 不覆盖已有文件。
 *
 * 计费三段式（防双重扣费见 billing/service.ts projectMeteredToolUsage）：
 *   ① 调 API 前 assertTenantCanAffordFixedFee 预检（不足返回工具错误，run 不崩）；
 *   ② 生成成功后 append `metered_tool_usage` 事件（失败不扣费）；
 *   ③ 投影写 billable=false usage 行 + 独立固定 debit（幂等键锚定 eventId）。
 */

export type ImageGenEngineId = 'gpt-image-2' | 'seedream';

export interface ResolvedImageGenEngineConfig {
  enabled?: boolean;
  /** OpenAI 兼容 base URL（含版本前缀，如 https://llm.kaiyan.net/v1、https://ark.cn-beijing.volces.com/api/v3）。 */
  baseUrl?: string;
  /** 装配层已从 secretVault 解析出的明文 key，只存在于 server 进程内。 */
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
}

export interface ResolvedImageGenToolsConfig {
  enabled?: boolean;
  gptImage2?: ResolvedImageGenEngineConfig;
  seedream?: ResolvedImageGenEngineConfig;
}

export interface ImageGenToolProviderOptions {
  config: ResolvedImageGenToolsConfig;
  /** 惰性 getter（与 dispatch config 同款形态）；未配置时跳过预检与扣费（file backend / 测试）。 */
  billingService?: () => BillingService | undefined;
  /** metered_tool_usage 事件直写 runtime_events（PG runtime 注入 pgEventStore.append）。 */
  appendPlatformEvent?: (event: PlatformEventInput, ctx?: EventAppendContext) => Promise<unknown>;
  /** 租户开关 features.imageGenEnabled（默认 false，fail-closed）。 */
  isImageGenEnabledForTenant?: (tenantId: string | undefined) => boolean;
  fetchImpl?: typeof fetch;
  /** 测试注入：gpt-image-2 订阅池退避重试延迟表。默认 15/30/60s（沿用原 skill 脚本策略）。 */
  retryDelaysMs?: readonly number[];
  logger?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
  };
}

const DEFAULT_ENGINE: ImageGenEngineId = 'gpt-image-2';
const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;
const DEFAULT_RETRY_DELAYS_MS = [15_000, 30_000, 60_000] as const;
const DEFAULT_SEEDREAM_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
const DEFAULT_SEEDREAM_MODEL = 'doubao-seedream-5-0-lite-260128';
const MAX_REF_IMAGE_BYTES_GPT = 20 * 1024 * 1024;
const MAX_REF_IMAGE_BYTES_SEEDREAM = 5 * 1024 * 1024;

/** 沿用原 skill 脚本的临时错误判定（RETRYABLE_HTTP_CODES + markers）。 */
const RETRYABLE_HTTP_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRYABLE_ERROR_MARKERS = [
  'auth_unavailable',
  'no auth available',
  'stream disconnected before completion',
  'stream closed before response.completed',
];

const ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'] as const;
type AspectRatio = (typeof ASPECT_RATIOS)[number];

const generateImageSchema = z.object({
  prompt: z.string().min(1).max(8_000).describe('Image description prompt. Chinese or English.'),
  model: z.enum(['gpt-image-2', 'seedream']).optional()
    .describe('Image engine. Default "gpt-image-2" (flagship). "seedream" (Volcengine Ark) is the alternative. Credits per image differ by engine; no automatic fallback between engines.'),
  aspectRatio: z.enum(ASPECT_RATIOS).optional().describe('Aspect ratio. Default "1:1".'),
  quality: z.enum(['low', 'medium', 'high', 'auto']).optional()
    .describe('Quality tier, only effective for gpt-image-2. Default "auto".'),
  refImages: z.array(z.string().min(1)).max(4).optional()
    .describe('Reference images for image-to-image: workspace-relative paths (e.g. "uploads/a.jpg"), max 4.'),
  count: z.number().int().min(1).max(4).optional()
    .describe('Number of images, default 1, max 4. Each image is charged separately.'),
});

export type GenerateImageInput = z.infer<typeof generateImageSchema>;

export const generateImageToolDescriptor: ToolDescriptor<GenerateImageInput> = {
  id: 'GenerateImage',
  name: 'GenerateImage',
  displayName: 'AI 生图',
  description: loadToolDescription('GenerateImage'),
  schema: generateImageSchema,
  risk: 'safe',
  approvalMode: 'never',
  auditCategory: 'media.imageGenerate',
};

// ─── gpt-image-2 订阅池进程内全局单飞队列 ────────────────────────────────────
//
// 多租户共享同一个 CLIProxyAPI 订阅池，任何时刻只允许一个 gpt-image-2 请求批次
// 在途（原 skill 脚本的跨进程文件锁上移为 brain 进程内 promise 链）。seedream
// 是正规按张计费 API，无需单飞。

let gptImage2Queue: Promise<unknown> = Promise.resolve();

function enqueueGptImage2<T>(task: () => Promise<T>): Promise<T> {
  const run = gptImage2Queue.then(task, task);
  gptImage2Queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

class ImageGenApiError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = 'ImageGenApiError';
  }
}

interface RefImagePayload {
  name: string;
  mime: string;
  data: Buffer;
}

interface ImageGenEngineDeps {
  connection: ResolvedImageGenEngineConfig;
  fetchImpl: typeof fetch;
  retryDelaysMs: readonly number[];
  logger?: ImageGenToolProviderOptions['logger'];
}

interface ImageGenEngineRequest {
  prompt: string;
  count: number;
  size: string;
  quality?: 'low' | 'medium' | 'high' | 'auto';
  refImages: readonly RefImagePayload[];
  signal?: AbortSignal;
}

interface ImageGenEngineResult {
  images: Buffer[];
  revisedPrompt?: string;
}

interface ImageGenEngineDefinition {
  id: ImageGenEngineId;
  resolveConnection(config: ResolvedImageGenToolsConfig): ResolvedImageGenEngineConfig | undefined;
  mapSize(aspectRatio: AspectRatio): string;
  maxRefImageBytes: number;
  generate(deps: ImageGenEngineDeps, request: ImageGenEngineRequest): Promise<ImageGenEngineResult>;
}

/** gpt-image-2 只支持 1024x1024 / 1536x1024 / 1024x1536（原 skill 实测映射）。 */
const GPT_IMAGE_2_SIZE_BY_ASPECT: Record<AspectRatio, string> = {
  '1:1': '1024x1024',
  '16:9': '1536x1024',
  '4:3': '1536x1024',
  '3:2': '1536x1024',
  '9:16': '1024x1536',
  '3:4': '1024x1536',
  '2:3': '1024x1536',
};

/** Seedream 5.0 要求最小约 3.69M 像素（~1920x1920），全部映射到 2K 档。 */
const SEEDREAM_SIZE_BY_ASPECT: Record<AspectRatio, string> = {
  '1:1': '2048x2048',
  '16:9': '2560x1440',
  '4:3': '2304x1728',
  '3:2': '2400x1600',
  '9:16': '1440x2560',
  '3:4': '1728x2304',
  '2:3': '1600x2400',
};

/**
 * 引擎注册表：后续加档（如 OpenAI 正规 images API 旗舰档）只需新增一个
 * ImageGenEngineDefinition 条目 + zod enum 值 + DEFAULT_IMAGE_GEN_PRICING 默认价。
 */
const IMAGE_GEN_ENGINES: Record<ImageGenEngineId, ImageGenEngineDefinition> = {
  'gpt-image-2': {
    id: 'gpt-image-2',
    resolveConnection: (config) => {
      const engine = config.gptImage2;
      if (!engine || engine.enabled === false || !engine.baseUrl || !engine.apiKey) return undefined;
      return engine;
    },
    mapSize: (aspectRatio) => GPT_IMAGE_2_SIZE_BY_ASPECT[aspectRatio],
    maxRefImageBytes: MAX_REF_IMAGE_BYTES_GPT,
    generate: (deps, request) =>
      // 单飞队列覆盖整个批次（count 张串行），与原 skill 的锁粒度一致。
      enqueueGptImage2(async () => {
        const images: Buffer[] = [];
        let revisedPrompt: string | undefined;
        for (let i = 0; i < request.count; i++) {
          const single = await gptImage2RequestWithRetries(deps, request);
          images.push(...single.images);
          revisedPrompt = single.revisedPrompt ?? revisedPrompt;
        }
        return { images, ...(revisedPrompt ? { revisedPrompt } : {}) };
      }),
  },
  seedream: {
    id: 'seedream',
    resolveConnection: (config) => {
      const engine = config.seedream;
      if (!engine || engine.enabled === false || !engine.apiKey) return undefined;
      return engine;
    },
    mapSize: (aspectRatio) => SEEDREAM_SIZE_BY_ASPECT[aspectRatio],
    maxRefImageBytes: MAX_REF_IMAGE_BYTES_SEEDREAM,
    // Ark 生图接口一次请求返回一张；count > 1 时逐张调用，计费数量与成功图片数一致。
    generate: async (deps, request) => {
      const images: Buffer[] = [];
      let revisedPrompt: string | undefined;
      for (let i = 0; i < request.count; i++) {
        const single = await seedreamGenerate(deps, request);
        images.push(...single.images);
        revisedPrompt = single.revisedPrompt ?? revisedPrompt;
      }
      return { images, ...(revisedPrompt ? { revisedPrompt } : {}) };
    },
  },
};

export function listAvailableImageGenEngineIds(
  config: ResolvedImageGenToolsConfig | undefined,
): ImageGenEngineId[] {
  if (!config || config.enabled === false) return [];
  return (Object.keys(IMAGE_GEN_ENGINES) as ImageGenEngineId[])
    .filter((id) => IMAGE_GEN_ENGINES[id].resolveConnection(config) !== undefined);
}

async function gptImage2RequestWithRetries(
  deps: ImageGenEngineDeps,
  request: ImageGenEngineRequest,
): Promise<ImageGenEngineResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await gptImage2RequestOnce(deps, request);
    } catch (err) {
      if (request.signal?.aborted) throw err;
      const retryable = err instanceof ImageGenApiError && err.retryable;
      if (retryable && attempt < deps.retryDelaysMs.length) {
        const delay = deps.retryDelaysMs[attempt]!;
        deps.logger?.warn?.(
          `[GenerateImage] gpt-image-2 疑似订阅池暂不可用，${delay}ms 后重试（${attempt + 1}/${deps.retryDelaysMs.length}）：${err instanceof Error ? err.message : String(err)}`,
        );
        await abortableSleep(delay, request.signal);
        continue;
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `gpt-image-2 生成失败${retryable ? `（已按 15/30/60s 策略退避重试 ${attempt} 次仍失败）` : ''}：${message}`
        + ' 如需继续生成，可显式改用 model:"seedream" 引擎重试；两个引擎按不同单价扣积分，平台不会自动切换。',
      );
    }
  }
}

async function gptImage2RequestOnce(
  deps: ImageGenEngineDeps,
  request: ImageGenEngineRequest,
): Promise<ImageGenEngineResult> {
  const baseUrl = trimTrailingSlash(deps.connection.baseUrl!);
  const model = deps.connection.model ?? 'gpt-image-2';
  const quality = request.quality ?? 'auto';
  let response: Response;
  if (request.refImages.length > 0) {
    // 有参考图 → OpenAI 兼容 /images/edits（multipart，无需 mask）
    const form = new FormData();
    form.set('model', model);
    form.set('prompt', request.prompt);
    form.set('size', request.size);
    form.set('quality', quality);
    for (const ref of request.refImages) {
      form.append('image[]', new Blob([new Uint8Array(ref.data)], { type: ref.mime }), ref.name);
    }
    response = await fetchWithTimeout(deps, `${baseUrl}/images/edits`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${deps.connection.apiKey}` },
      body: form,
    }, request.signal);
  } else {
    response = await fetchWithTimeout(deps, `${baseUrl}/images/generations`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${deps.connection.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model, prompt: request.prompt, size: request.size, quality }),
    }, request.signal);
  }
  const bodyText = await response.text();
  if (!response.ok) {
    throw new ImageGenApiError(
      `HTTP ${response.status}: ${bodyText.slice(0, 500)}`,
      isRetryableHttpFailure(response.status, bodyText),
    );
  }
  return parseImagesResponse(bodyText, deps.fetchImpl);
}

async function seedreamGenerate(
  deps: ImageGenEngineDeps,
  request: ImageGenEngineRequest,
): Promise<ImageGenEngineResult> {
  const baseUrl = trimTrailingSlash(deps.connection.baseUrl ?? DEFAULT_SEEDREAM_BASE_URL);
  const body: Record<string, unknown> = {
    model: deps.connection.model ?? DEFAULT_SEEDREAM_MODEL,
    prompt: request.prompt,
    size: request.size,
    response_format: 'b64_json',
    watermark: false,
  };
  if (request.refImages.length > 0) {
    body.image = request.refImages.map(
      (ref) => `data:${ref.mime};base64,${ref.data.toString('base64')}`,
    );
  }
  const response = await fetchWithTimeout(deps, `${baseUrl}/images/generations`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${deps.connection.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  }, request.signal);
  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`seedream 生成失败：HTTP ${response.status}: ${bodyText.slice(0, 500)}`);
  }
  return parseImagesResponse(bodyText, deps.fetchImpl);
}

async function parseImagesResponse(bodyText: string, fetchImpl: typeof fetch): Promise<ImageGenEngineResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw new Error(`生图 API 返回了无法解析的响应：${bodyText.slice(0, 200)}`);
  }
  const data = (parsed as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`生图 API 响应缺少 data 字段：${bodyText.slice(0, 300)}`);
  }
  const images: Buffer[] = [];
  let revisedPrompt: string | undefined;
  for (const item of data) {
    if (!item || typeof item !== 'object') continue;
    const record = item as { b64_json?: unknown; url?: unknown; revised_prompt?: unknown };
    if (typeof record.revised_prompt === 'string' && record.revised_prompt.trim()) {
      revisedPrompt = record.revised_prompt.trim();
    }
    if (typeof record.b64_json === 'string' && record.b64_json) {
      images.push(Buffer.from(record.b64_json, 'base64'));
      continue;
    }
    if (typeof record.url === 'string' && record.url) {
      const download = await fetchImpl(record.url);
      if (!download.ok) throw new Error(`下载生成图片失败：HTTP ${download.status}`);
      images.push(Buffer.from(await download.arrayBuffer()));
    }
  }
  if (images.length === 0) throw new Error('生图 API 未返回任何图片数据。');
  return { images, ...(revisedPrompt ? { revisedPrompt } : {}) };
}

async function fetchWithTimeout(
  deps: ImageGenEngineDeps,
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<Response> {
  // 生成型 API 慢（10-60s+），超时独立于全局 fetch 默认；context.signal 取消透传。
  const timeoutMs = deps.connection.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const combinedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    return await deps.fetchImpl(url, { ...init, signal: combinedSignal });
  } finally {
    clearTimeout(timeout);
  }
}

function isRetryableHttpFailure(status: number, body: string): boolean {
  if (RETRYABLE_HTTP_STATUS.has(status)) return true;
  const lower = body.toLowerCase();
  return RETRYABLE_ERROR_MARKERS.some((marker) => lower.includes(marker));
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolvePromise, rejectPromise) => {
    if (signal?.aborted) {
      rejectPromise(new Error('GenerateImage 已被取消。'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      rejectPromise(new Error('GenerateImage 已被取消。'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolvePromise();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

function guessImageMime(path: string): string {
  return IMAGE_MIME_BY_EXT[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

function resolveTenantId(context?: ToolCallContext): string | undefined {
  return context?.channelContext?.user?.tenantId
    ?? context?.channelContext?.sessionOwner?.tenantId
    ?? context?.workspace?.tenantId;
}

export class ImageGenToolProvider implements ToolProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly retryDelaysMs: readonly number[];

  constructor(private readonly options: ImageGenToolProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  }

  list(context?: ToolCallContext): ToolDescriptor[] {
    if (this.options.config.enabled === false) return [];
    if (listAvailableImageGenEngineIds(this.options.config).length === 0) return [];
    // 租户 gate（features.imageGenEnabled，默认 false）：未开通的组织模型根本看不到工具。
    if (this.options.isImageGenEnabledForTenant?.(resolveTenantId(context)) !== true) return [];
    return [generateImageToolDescriptor];
  }

  async invoke<TInput>(
    call: AuthorizedToolCall<TInput>,
    context: ToolCallContext,
  ): Promise<ToolResult | undefined> {
    if (call.toolId !== generateImageToolDescriptor.id) return undefined;
    if (this.options.config.enabled === false) return undefined;
    const input = generateImageToolDescriptor.schema.parse(call.input) as GenerateImageInput;
    const tenantId = resolveTenantId(context);
    // list() 已按租户隐藏；这里是防御纵深（invoke 侧二次拦截，防越权直调）。
    if (this.options.isImageGenEnabledForTenant?.(tenantId) !== true) {
      throw new Error('该组织未开通 AI 生图能力（features.imageGenEnabled），请联系平台管理员开通。');
    }

    const engineId = input.model ?? DEFAULT_ENGINE;
    const engine = IMAGE_GEN_ENGINES[engineId];
    const connection = engine.resolveConnection(this.options.config);
    if (!connection) {
      const alternatives = listAvailableImageGenEngineIds(this.options.config).filter((id) => id !== engineId);
      throw new Error(
        `生图引擎 ${engineId} 未在平台配置或未启用${alternatives.length > 0 ? `，可改用 model:"${alternatives[0]}"` : ''}。`,
      );
    }

    const pricing = getImageGenEnginePricing(engineId);
    if (!pricing) {
      throw new Error(`生图引擎 ${engineId} 未配置定价，请联系平台管理员在生图定价配置中补齐。`);
    }
    const count = input.count ?? 1;
    const requestedCredits = pricing.creditsPerImage * count;
    const requestedCreditsMicro = Math.round(requestedCredits * CREDIT_MICRO);

    // ① 工具内余额预检：run 级 preflight 不够——长 run 中途余额可能被烧穿。
    //    不足返回工具错误（模型可见原因），run 不崩、不扣费。
    const billing = this.options.billingService?.();
    let billed = false;
    if (billing && tenantId) {
      const allowed = await billing.assertTenantCanAffordFixedFee(tenantId, requestedCreditsMicro);
      if (!allowed.ok) {
        throw new Error(
          `生图请求已拒绝（未扣费）：${allowed.reason} 本次需 ${requestedCredits} 积分`
          + `（${engineId} 单价 ${pricing.creditsPerImage} 积分/张 × ${count} 张）。`,
        );
      }
      billed = await billing.isTenantBillable(tenantId);
    }

    const refImages = await this.loadRefImages(input.refImages ?? [], context, engine);
    const aspectRatio: AspectRatio = input.aspectRatio ?? '1:1';
    const size = engine.mapSize(aspectRatio);

    const result = await engine.generate(
      {
        connection,
        fetchImpl: this.fetchImpl,
        retryDelaysMs: this.retryDelaysMs,
        logger: this.options.logger,
      },
      {
        prompt: input.prompt,
        count,
        size,
        quality: input.quality,
        refImages,
        signal: context.signal,
      },
    );

    // ② 落盘：server 直写 NAS 固定子目录，路径由 server 生成（risk:'safe' 前提）。
    const relPaths = await this.persistImages(result.images, context.workspace.root);

    // ③ 生成成功才记账（失败不扣费）；实际扣费由 billing 投影消费该事件完成，
    //    幂等键锚定事件 id，投影重跑/事件重放不会重复扣。
    const chargedQuantity = result.images.length;
    if (this.options.appendPlatformEvent) {
      await this.options.appendPlatformEvent(
        {
          type: 'metered_tool_usage',
          runId: context.runId ?? '',
          sessionId: context.sessionId ?? context.workspace.sessionId ?? '',
          toolId: generateImageToolDescriptor.id,
          sku: `image_gen:${engineId}`,
          quantity: chargedQuantity,
          unitCreditsMicro: Math.round(pricing.creditsPerImage * CREDIT_MICRO),
          unitCostYuanMicro: Math.round(pricing.costYuanPerImage * YUAN_MICRO),
          note: `${size} quality=${input.quality ?? 'default'}${refImages.length > 0 ? ` ref=${refImages.length}` : ''}`,
        },
        tenantId ? { tenantId } : undefined,
      );
    }

    const creditsCharged = billed ? pricing.creditsPerImage * chargedQuantity : 0;
    const payload = {
      status: 'ok',
      engine: engineId,
      images: relPaths,
      size,
      count: chargedQuantity,
      creditsCharged,
      ...(billed
        ? { pricingNote: `${pricing.creditsPerImage} 积分/张` }
        : { billingNote: '该组织未启用积分计费（内部/未开计费租户），本次未扣积分' }),
      ...(result.revisedPrompt ? { revisedPrompt: result.revisedPrompt } : {}),
      deliveryInstruction:
        `在给用户的最终回复中用 markdown 图片语法内联展示图片，例如：![图片描述](${relPaths[0]})。路径必须原样使用返回的相对路径。`,
    };
    return { content: JSON.stringify(payload, null, 2) };
  }

  /** refImages 只收 workspace 相对路径；resolveAuthorizedPath + realpath 双重校验，拒 symlink 逃逸。 */
  private async loadRefImages(
    paths: readonly string[],
    context: ToolCallContext,
    engine: ImageGenEngineDefinition,
  ): Promise<RefImagePayload[]> {
    if (paths.length === 0) return [];
    const workspaceRoot = context.workspace.root;
    const out: RefImagePayload[] = [];
    for (const rel of paths) {
      const resolved = resolveAuthorizedPath(rel, workspaceRoot, []);
      if (!resolved) {
        throw new Error(`参考图路径越界：${rel}（只允许当前工作区内的相对路径，如 uploads/xxx.jpg）`);
      }
      let realPath: string;
      let realRoot: string;
      try {
        realPath = await realpath(resolved);
        realRoot = await realpath(workspaceRoot);
      } catch {
        throw new Error(`参考图不存在：${rel}`);
      }
      if (realPath !== realRoot && !isPathWithinDirectory(realPath, realRoot)) {
        throw new Error(`参考图路径越界（symlink 指向工作区外）：${rel}`);
      }
      const data = await readFile(realPath);
      if (data.byteLength > engine.maxRefImageBytes) {
        throw new Error(
          `参考图 ${rel} 超过 ${engine.id} 引擎单张上限 ${Math.round(engine.maxRefImageBytes / 1024 / 1024)}MB。`,
        );
      }
      out.push({ name: basename(realPath), mime: guessImageMime(realPath), data });
    }
    return out;
  }

  private async persistImages(images: Buffer[], workspaceRoot: string): Promise<string[]> {
    const now = new Date();
    const dateDir = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const relDir = posix.join('assets', 'generated', dateDir);
    const absDir = join(workspaceRoot, 'assets', 'generated', dateDir);
    await mkdir(absDir, { recursive: true });
    const relPaths: string[] = [];
    for (const image of images) {
      const fileName = `img-${randomUUID().slice(0, 8)}.png`;
      // 'wx'：文件已存在直接失败，绝不覆盖 workspace 既有文件。
      await writeFile(join(absDir, fileName), image, { flag: 'wx' });
      relPaths.push(posix.join(relDir, fileName));
    }
    return relPaths;
  }
}

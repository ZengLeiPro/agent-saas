/**
 * Memory Index — Embedding Provider
 *
 * OpenAI-compatible /v1/embeddings API。
 * 支持 OpenAI、DashScope 及任何兼容端点。
 */

import type { MemoryIndexConfig } from './types.js';
import type { SdkResultModelUsage } from '../../agent/types.js';
import type { BillingUtilityModelRun } from '../../data/billing/service.js';

interface EmbeddingResponse {
  data: Array<{ embedding: number[] }>;
  usage?: {
    prompt_tokens?: number;
    total_tokens?: number;
  };
}

export class EmbeddingBillingError extends Error {
  constructor(cause: unknown) {
    super(`Embedding billing failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'EmbeddingBillingError';
  }
}

export interface EmbeddingProviderOptions {
  beginBillingRun?: () => Promise<BillingUtilityModelRun | undefined>;
  onUsage?: (model: string, usage: SdkResultModelUsage) => void | Promise<void>;
}

export class EmbeddingProvider {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;

  constructor(
    config: MemoryIndexConfig['embedding'],
    private readonly options: EmbeddingProviderOptions = {},
  ) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.model = config.model;
  }

  /**
   * 批量获取嵌入向量。
   * 单次请求最多 64 条（OpenAI/DashScope 的默认上限）。
   */
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    // DashScope embedding API 单次最多 10 条；OpenAI 上限 2048，10 是两边安全交集。
    // 改大会让大文件（chunks > 10）100% 失败被 catch 吞掉，导致索引大面积缺失。
    const batchSize = 10;
    const allEmbeddings: number[][] = [];
    let billingRun: BillingUtilityModelRun | undefined;
    try {
      billingRun = await this.options.beginBillingRun?.();
    } catch (err) {
      throw new EmbeddingBillingError(err);
    }

    try {
      for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        const embeddings = await this.embedBatch(batch, billingRun);
        allEmbeddings.push(...embeddings);
      }
      return allEmbeddings;
    } finally {
      try {
        await billingRun?.finalize();
      } catch (err) {
        throw new EmbeddingBillingError(err);
      }
    }
  }

  /** 单次批量请求 */
  private async embedBatch(
    texts: string[],
    billingRun?: BillingUtilityModelRun,
  ): Promise<number[][]> {
    const url = `${this.baseUrl}/v1/embeddings`;
    try {
      await billingRun?.beforeModelCall();
    } catch (err) {
      throw new EmbeddingBillingError(err);
    }
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `Embedding API error ${response.status}: ${body.slice(0, 200)}`
      );
    }

    const json = (await response.json()) as EmbeddingResponse;
    if (json.usage) {
      const usage: SdkResultModelUsage = {
        inputTokens: json.usage.prompt_tokens ?? json.usage.total_tokens ?? 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        apiRequestCount: 1,
      };
      try {
        await billingRun?.recordUsage(this.model, usage);
      } catch (err) {
        throw new EmbeddingBillingError(err);
      }
      await this.options.onUsage?.(this.model, usage);
    }
    // API 返回的 data 按 index 排序，但为安全起见按原始顺序返回
    return json.data.map((d) => d.embedding);
  }
}

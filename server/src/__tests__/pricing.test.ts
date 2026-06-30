import { afterEach, describe, expect, it } from 'vitest';

import {
  PRICING_VERSION,
  configureModelPricing,
  computeCostMicro,
  computeUsageTotalTokens,
  listKnownModels,
  __resetPricingWarnCacheForTest,
} from '../data/usage/pricing.js';

describe('pricing.computeCostMicro', () => {
  afterEach(() => {
    __resetPricingWarnCacheForTest();
    configureModelPricing(undefined);
  });

  describe('已知模型按 4 类 token × 单价计算', () => {
    it('claude-opus-4-7（input $5, output $25, cacheRead $0.5, cacheCreation 1h $10）', () => {
      // 1000 input × $5/M = $0.005 = 5000 micro
      // 500 output × $25/M = $0.0125 = 12500 micro
      // 10000 cacheRead × $0.5/M = $0.005 = 5000 micro
      // 200 cacheCreation × $10/M = $0.002 = 2000 micro
      // 合计 = 24500 micro
      const micro = computeCostMicro('claude-opus-4-7', {
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 10000,
        cacheCreationTokens: 200,
      });
      expect(micro).toBe(24500);
    });

    it('claude-opus-4-7[1m] 与基础款同价（1M 上下文标准价）', () => {
      const base = computeCostMicro('claude-opus-4-7', {
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      });
      const m1 = computeCostMicro('claude-opus-4-7[1m]', {
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      });
      expect(m1).toBe(base);
      expect(m1).toBe(5 * 1000 + 25 * 500); // 17500 micro
    });

    it('claude-sonnet-4-6（input $3, output $15）', () => {
      const micro = computeCostMicro('claude-sonnet-4-6', {
        inputTokens: 1_000_000, // 整 1M tokens
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      });
      // 1M × $3/M = $3 = 3_000_000 micro
      expect(micro).toBe(3_000_000);
    });

    it('claude-haiku-4-5（input $1, output $5）', () => {
      const micro = computeCostMicro('claude-haiku-4-5', {
        inputTokens: 500,
        outputTokens: 200,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      });
      expect(micro).toBe(1 * 500 + 5 * 200); // 1500 micro
    });

    it('GPT-5.5（input $5, output $30, cacheCreation=0）', () => {
      const micro = computeCostMicro('gpt-5.5', {
        inputTokens: 6000,
        outputTokens: 100,
        cacheReadTokens: 5000,
        cacheCreationTokens: 0,
      });
      // OpenAI-compatible: cacheRead 是 input 子集，未命中 input = 6000 - 5000
      // 5*1000 + 30*100 + 0.5*5000 = 5000 + 3000 + 2500 = 10500
      expect(micro).toBe(10500);
    });

    it('豆包 Seed 2.0 Pro（input $0.47, output $2.37）', () => {
      const micro = computeCostMicro('doubao-seed-2.0-pro', {
        inputTokens: 10000,
        outputTokens: 1000,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      });
      // 0.47*10000 + 2.37*1000 = 4700 + 2370 = 7070
      expect(micro).toBe(7070);
    });

    it('OpenAI Agents 当前国产模型别名有单价', () => {
      expect(computeCostMicro('doubao-pro', {
        inputTokens: 10000,
        outputTokens: 1000,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      })).toBe(7070);

      expect(computeCostMicro('kimi-2.6', {
        inputTokens: 1000,
        outputTokens: 100,
        cacheReadTokens: 500,
        cacheCreationTokens: 0,
      })).toBe(955);

      expect(computeCostMicro('minimax-2.7', {
        inputTokens: 1000,
        outputTokens: 100,
        cacheReadTokens: 500,
        cacheCreationTokens: 200,
      })).toBe(315);
    });
  });

  describe('边缘情况', () => {
    it('<synthetic> 返回 0 且不告警', () => {
      const warns: string[] = [];
      const micro = computeCostMicro(
        '<synthetic>',
        { inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 1000, cacheCreationTokens: 1000 },
        (m) => warns.push(m),
      );
      expect(micro).toBe(0);
      expect(warns).toHaveLength(0);
    });

    it('空 model 返回 0', () => {
      expect(
        computeCostMicro('', {
          inputTokens: 100,
          outputTokens: 100,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        }),
      ).toBe(0);
    });

    it('未知 model 返回 0 + 一次性告警', () => {
      const warns: string[] = [];
      const tokens = {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      };
      const m1 = computeCostMicro('claude-future-9-9', tokens, (m) => warns.push(m));
      const m2 = computeCostMicro('claude-future-9-9', tokens, (m) => warns.push(m));
      const m3 = computeCostMicro('claude-future-9-9', tokens, (m) => warns.push(m));
      expect(m1).toBe(0);
      expect(m2).toBe(0);
      expect(m3).toBe(0);
      // 同 model 只 warn 一次
      expect(warns).toHaveLength(1);
      expect(warns[0]).toMatch(/unknown model "claude-future-9-9"/);
      expect(warns[0]).toContain(PRICING_VERSION);
    });

    it('config.json 模型 pricing 可覆盖内置单价、usage 语义并支持 alias_actual', () => {
      configureModelPricing({
        groups: [{
          models: [{
            value: 'gpt-5.5',
            alias_actual: 'gpt-5.5-alias',
            pricing: { input: 1, output: 2, cacheCreation: 3, cacheRead: 4 },
            usage_accounting: 'cache_tokens_separate',
          }],
        }],
      });

      const tokens = {
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 30,
        cacheCreationTokens: 40,
      };
      expect(computeCostMicro('gpt-5.5', tokens)).toBe(1 * 10 + 2 * 20 + 4 * 30 + 3 * 40);
      expect(computeCostMicro('gpt-5.5-alias', tokens)).toBe(290);
    });

    it('OpenAI-compatible total 不额外叠加 cached tokens', () => {
      expect(computeUsageTotalTokens('gpt-5.5', {
        inputTokens: 2006,
        outputTokens: 300,
        cacheReadTokens: 1920,
        cacheCreationTokens: 0,
      })).toBe(2306);
    });

    it('不同未知 model 各自 warn 一次', () => {
      const warns: string[] = [];
      const tokens = {
        inputTokens: 100,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      };
      computeCostMicro('unknown-model-a', tokens, (m) => warns.push(m));
      computeCostMicro('unknown-model-b', tokens, (m) => warns.push(m));
      computeCostMicro('unknown-model-a', tokens, (m) => warns.push(m));
      expect(warns).toHaveLength(2);
    });

    it('负数 token 被截断为 0（防御性）', () => {
      const micro = computeCostMicro('claude-opus-4-7', {
        inputTokens: -100,
        outputTokens: 500,
        cacheReadTokens: -50,
        cacheCreationTokens: 0,
      });
      // 只计 output: 25 * 500 = 12500
      expect(micro).toBe(12500);
    });

    it('全 0 token 返回 0', () => {
      expect(
        computeCostMicro('claude-opus-4-7', {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        }),
      ).toBe(0);
    });
  });

  describe('元信息', () => {
    it('PRICING_VERSION 是非空字符串', () => {
      expect(PRICING_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}-v\d+$/);
    });

    it('listKnownModels 包含 KY Agent 实际在用的所有 model id', () => {
      const known = new Set(listKnownModels());
      // 这些 model id 来自 business.sqlite 的 token_usage_daily 实测扫描（2026-05-17）
      const actualModelsInDb = [
        'claude-opus-4-7',
        'claude-opus-4-7[1m]',
        'claude-opus-4-6',
        'claude-sonnet-4-6',
        'gpt-5.5',
        'gpt-5.4',
        'doubao-seed-2.0-pro',
        'doubao-pro',
        'doubao-seed-2.0-lite',
        'kimi-k2.6',
        'kimi-2.6',
        'MiniMax-M2.7',
        'minimax-2.7',
      ];
      for (const m of actualModelsInDb) {
        expect(known.has(m), `pricing.ts 缺少 ${m} 单价`).toBe(true);
      }
    });
  });
});

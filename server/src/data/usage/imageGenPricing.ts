/**
 * GenerateImage 生图工具 per-engine 定价注册表（2026-07-15 批次）。
 *
 * 模式完全照抄 pricing.ts 的 configureModelPricing 先例（07-14 /compact 逐模型
 * 配置同款）：config.json `imageGenTools.pricing` 作为持久化载体，平台管理员经
 * `/api/admin/image-gen-pricing` PUT 后 jsonc 回写 config.json 并调用
 * configureImageGenPricing() 整体重建本模块级注册表——扣费点每次调用 getter
 * 现查，改价即时生效、无需重启。
 *
 * 内置默认值来自 2026-07-15 主报告的定价建模（credit 面值 0.01 元口径）：
 *   - gpt-image-2（CLIProxyAPI 订阅池，旗舰档）：400 积分/张，真实成本参考 ~¥1.5/张
 *   - seedream（火山方舟，正规按张计费）：100 积分/张，真实成本参考 ~¥0.4/张
 * 真实成本仅供毛利审计（<45% 毛利告警），不参与应收计算。
 */

export interface ImageGenEnginePricing {
  /** 每张图扣多少积分（面值口径，1 积分 = 0.01 元）。 */
  creditsPerImage: number;
  /** 每张图真实成本参考（元），写入 ledger actual_cost 供毛利审计。 */
  costYuanPerImage: number;
}

export type ImageGenPricingTable = Record<string, ImageGenEnginePricing>;

export const DEFAULT_IMAGE_GEN_PRICING: ImageGenPricingTable = {
  'gpt-image-2': { creditsPerImage: 400, costYuanPerImage: 1.5 },
  'seedream': { creditsPerImage: 100, costYuanPerImage: 0.4 },
};

let configuredImageGenPricing: ImageGenPricingTable = {};

/** 整体替换（非增量），与 configureModelPricing 语义一致。传 undefined 恢复内置默认。 */
export function configureImageGenPricing(pricing: ImageGenPricingTable | undefined): void {
  const next: ImageGenPricingTable = {};
  for (const [engine, entry] of Object.entries(pricing ?? {})) {
    if (!entry) continue;
    if (typeof entry.creditsPerImage !== 'number' || !Number.isFinite(entry.creditsPerImage) || entry.creditsPerImage <= 0) continue;
    if (typeof entry.costYuanPerImage !== 'number' || !Number.isFinite(entry.costYuanPerImage) || entry.costYuanPerImage < 0) continue;
    next[engine] = { creditsPerImage: entry.creditsPerImage, costYuanPerImage: entry.costYuanPerImage };
  }
  configuredImageGenPricing = next;
}

/** 扣费点实时读取：管理员配置优先，缺省回退内置默认；未知引擎返回 undefined（调用方应拒绝生成）。 */
export function getImageGenEnginePricing(engine: string): ImageGenEnginePricing | undefined {
  return configuredImageGenPricing[engine] ?? DEFAULT_IMAGE_GEN_PRICING[engine];
}

/** 管理端 GET 用：配置覆盖合并到默认表后的生效视图。 */
export function listEffectiveImageGenPricing(): ImageGenPricingTable {
  return { ...DEFAULT_IMAGE_GEN_PRICING, ...configuredImageGenPricing };
}

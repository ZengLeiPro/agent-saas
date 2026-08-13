import { z } from 'zod';

import { looksLikeSecret } from '../security/secretHeuristics.js';

export const sttPricingSchema = z.object({
  creditsPerCall: z.number().nonnegative(),
  costYuanPerCall: z.number().nonnegative(),
});

export const sttConfigSchema = z.object({
  enabled: z.boolean().optional(),
  /** inline 字段仅用于兼容迁移；生产优先使用对应 SecretVault ref。 */
  apiKey: z.string().optional(),
  apiKeyRef: z.string().min(1).optional(),
  model: z.string().optional(),
  ossAccessKeyId: z.string().optional(),
  ossAccessKeyIdRef: z.string().min(1).optional(),
  ossAccessKeySecret: z.string().optional(),
  ossAccessKeySecretRef: z.string().min(1).optional(),
  ossBucket: z.string().optional(),
  ossEndpoint: z.string().optional(),
  pricing: sttPricingSchema.optional(),
  /** 旧版 Sandbox 凭据注入白名单；直连工具不依赖。 */
  audioTranscribeTenantIds: z.array(z.string().min(1)).optional(),
}).superRefine((value, ctx) => {
  for (const [inlineKey, refKey] of [
    ['apiKey', 'apiKeyRef'],
    ['ossAccessKeyId', 'ossAccessKeyIdRef'],
    ['ossAccessKeySecret', 'ossAccessKeySecretRef'],
  ] as const) {
    const inline = value[inlineKey]?.trim();
    const ref = value[refKey]?.trim();
    if (inline && ref) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [refKey],
        message: `${inlineKey} 与 ${refKey} 只能配置一个`,
      });
    }
    if (ref && looksLikeSecret(ref)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [refKey],
        message: `${refKey} 必须是 SecretVault ref，不能填写真实凭据`,
      });
    }
  }
});

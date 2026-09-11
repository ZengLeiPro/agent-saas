import { z } from 'zod';

/** 火山管控面独立凭据：新 Secret 进 Vault，历史 inline 值兼容读取。 */
export const volcengineArkPlanQuotaSourceSchema = z.object({
  provider: z.literal('volcengine_ark_plan'),
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1).optional(),
  /** SecretVault ref（kind=models，purpose=quota-source）。 */
  secretAccessKeyRef: z.string().min(1).optional(),
  region: z
    .string()
    .regex(/^[a-z0-9-]+$/u)
    .default('cn-beijing'),
});

// 智谱复用分组 API Key，禁用来源也不携带凭据。显式拒绝另一供应商的 Secret/ref，
// 同时保持通用凭据清理代码可以安全读取这两个可选字段。
const noSeparateSecret = {
  secretAccessKey: z.never().optional(),
  secretAccessKeyRef: z.never().optional(),
};

export const zhipuCodingPlanQuotaSourceSchema = z.object({
  provider: z.literal('zhipu_coding_plan'),
  ...noSeparateSecret,
});

export const modelGroupQuotaSourceSchema = z.discriminatedUnion('provider', [
  volcengineArkPlanQuotaSourceSchema,
  zhipuCodingPlanQuotaSourceSchema,
  z.object({ provider: z.literal('none'), ...noSeparateSecret }),
]);

export type ModelGroupQuotaSource = z.infer<typeof modelGroupQuotaSourceSchema>;

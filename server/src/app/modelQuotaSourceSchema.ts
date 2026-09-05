import { z } from 'zod';

/**
 * 模型分组的「套餐用量查询来源」。
 *
 * 推理 API Key 查不到套餐额度：各家管控面 OpenAPI 要账号级凭据（火山 = AccessKey ID/Secret，
 * HMAC-SHA256 签名）。Secret 与模型 apiKey 同策略——新写入进 SecretVault、config.json 只落 ref，
 * 历史 inline 值兼容读取。
 */
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

export const modelGroupQuotaSourceSchema = z.discriminatedUnion('provider', [
  volcengineArkPlanQuotaSourceSchema,
]);

export type ModelGroupQuotaSource = z.infer<typeof modelGroupQuotaSourceSchema>;

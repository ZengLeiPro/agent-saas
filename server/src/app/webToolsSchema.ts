import { z } from 'zod';

/**
 * webTools 的 search/fetch/egress schema。从 config.ts 抽出的内聚块：
 * 双源（国内 + 境外）后这一段自成一体，留在 config.ts 只会持续推高文件体量。
 */

export const webSearchProviderIds = ['brave', 'volcengine', 'tencent_wsa', 'zhipu', 'tavily'] as const;

type ApiKeyCredentialFields = {
  apiKey: z.ZodOptional<z.ZodString>;
  apiKeyRef: z.ZodOptional<z.ZodString>;
};

type ApiKeyRefine = (
  value: { apiKey?: string; apiKeyRef?: string },
  ctx: z.RefinementCtx,
  opts?: { pathPrefix?: (string | number)[]; allowEmpty?: boolean },
) => void;

/**
 * 凭据字段与其校验逻辑仍归 config.ts 所有（多个工具共用），这里以参数注入，
 * 避免把凭据规则复制成第二份。
 */
export function buildWebToolsSchemas(
  apiKeyCredentialFields: ApiKeyCredentialFields,
  applyApiKeyCredentialRefine: ApiKeyRefine,
) {
  /** 境外来源（scope=global）。未配置时 scope=global 自动回落到主源。 */
  const globalSearch = z.object({
    provider: z.enum(webSearchProviderIds).default('tavily'),
    endpoint: z.string().url().optional(),
    ...apiKeyCredentialFields,
    timeoutMs: z.number().int().positive().max(60_000).optional(),
    maxResults: z.number().int().min(1).max(10).optional(),
    searchDepth: z.enum(['basic', 'advanced']).optional(),
  }).superRefine((value, ctx) => {
    applyApiKeyCredentialRefine(value, ctx, { pathPrefix: ['global'], allowEmpty: true });
  }).optional();

  const search = z.object({
    enabled: z.boolean().optional(),
    provider: z.enum(webSearchProviderIds).default('volcengine'),
    endpoint: z.string().url().optional(),
    ...apiKeyCredentialFields,
    timeoutMs: z.number().int().positive().max(60_000).optional(),
    maxResults: z.number().int().min(1).max(10).optional(),
    /** 智谱计费档位：search_std ¥0.01/次、search_pro ¥0.03/次。 */
    searchEngine: z.string().min(1).optional(),
    searchDepth: z.enum(['basic', 'advanced']).optional(),
    global: globalSearch,
  }).superRefine((value, ctx) => {
    applyApiKeyCredentialRefine(value, ctx, { allowEmpty: true });
  });

  const fetch = z.object({
    enabled: z.boolean().optional(),
    timeoutMs: z.number().int().positive().max(60_000).optional(),
    maxBytes: z.number().int().positive().max(10 * 1024 * 1024).optional(),
    maxChars: z.number().int().min(100).max(50_000).optional(),
    maxRedirects: z.number().int().min(0).max(10).optional(),
    allowedContentTypes: z.array(z.string().min(1)).optional(),
    userAgent: z.string().min(1).optional(),
  });

  const egress = z.object({
    allowPrivateNetworks: z.boolean().optional(),
    allowedHosts: z.array(z.string().min(1)).optional(),
    blockedHosts: z.array(z.string().min(1)).optional(),
  });

  return { search, fetch, egress };
}

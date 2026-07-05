import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { parse as parseJsonc } from 'jsonc-parser';
import { z } from 'zod';

import {
  DEFAULT_CODING_HAND_NETWORK_POLICY,
  NETWORK_POLICY_MODES,
  isValidCidr,
  isValidDomain,
  normalizeNetworkPolicy,
} from '../runtime/networkPolicy.js';
import { looksLikeSecret } from '../security/secretHeuristics.js';

const agentPermissionModeSchema = z.enum([
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
  // 用模型分类器自动放行/拒绝权限请求。
  'auto',
]);
const agentSettingSourceSchema = z.enum(['user', 'project', 'local']);

const proxyConfigSchema = z.object({
  HTTP_PROXY: z.string().optional(),
  HTTPS_PROXY: z.string().optional(),
  NO_PROXY: z.string().optional(),
});

const agentConfigSchema = z.object({
  cwd: z.string().optional(),
  /** ���享资源目录（相对于项目根目录），默认 join(cwd, '.shared') */
  sharedDir: z.string().optional(),
  permissionMode: agentPermissionModeSchema.optional(),
  allowDangerouslySkipPermissions: z.boolean().optional(),
  maxTurns: z.number().int().positive().optional(),
  effortLevel: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  /**
   * 推理模式配置（谨慎修改）：
   * - "adaptive"：模型自行决定思考深度（默认，推荐）
   * - "disabled"：禁用扩展思考（⚠️ 可能导致 GPA 代理的模型报错）
   * - 正整数：固定 thinking token budget（如 8192），仅对旧模型有效
   */
  thinkingMode: z.union([
    z.enum(['adaptive', 'disabled']),
    z.number().int().positive(),
  ]).optional(),
  userOverrides: z.record(z.string(), z.object({
    effortLevel: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
    extraDirs: z.array(
      z.string().startsWith('/', { message: 'extraDirs must be absolute paths' }),
    ).optional(),
    allowGhCli: z.boolean().optional(),
  })).optional(),
  settingSources: z.array(agentSettingSourceSchema).optional(),
  allowedTools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
});

const serverConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).optional(),
  timezone: z.string().optional(),
  corsOrigins: z.array(z.string().url()).optional(),
});

const cronConfigSchema = z.object({
  enabled: z.boolean().optional(),
  store: z.string().optional(),
});

const roleKitConfigSchema = z.object({
  v2Enabled: z.boolean().optional(),
  sanitizePreviewEnabled: z.boolean().optional(),
  signalAdaptation: z.object({
    dailyEmptyStreakToWeekly: z.number().int().min(1).max(14).optional(),
    userNoOpenStreakToPause: z.number().int().min(1).max(30).optional(),
    emptyContentFallback: z.string().optional(),
  }).optional(),
  activationFallback: z.object({
    enabled: z.boolean().optional(),
    defaultTitle: z.string().optional(),
  }).optional(),
  firstDayGuideBar: z.object({
    enabled: z.boolean().optional(),
    stageTimeoutMs: z.number().int().positive().optional(),
    showOnMobile: z.boolean().optional(),
  }).optional(),
  defaultPushSlot: z.object({
    channel: z.enum(["ding_work_notification", "ding_group", "ding_both"]).optional(),
    target: z.enum(["self", "manager", "group"]).optional(),
    humanReviewRequired: z.boolean().optional(),
  }).optional(),
  libraryVersion: z.enum(["v1", "v2"]).optional(),
  fallbackToV1OnValidationError: z.boolean().optional(),
}).optional();

const dingtalkRobotConfigSchema = z.object({
  name: z.string().min(1, '机器人名称不能为空'),
  enabled: z.boolean().optional(),
  appKey: z.string().min(1, 'appKey 不能为空'),
  appSecret: z.string().min(1, 'appSecret 不能为空'),
  verifySignature: z.boolean().optional(),
});

type NormalizedDingtalkConfig = {
  enabled?: boolean;
  mode?: 'webhook' | 'stream';
  robots: Record<string, z.infer<typeof dingtalkRobotConfigSchema>>;
  maxFileSize?: number;
  messageBufferMs?: number;
};

const dingtalkConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    mode: z.enum(['webhook', 'stream']).optional(),
    robots: z.record(z.string(), dingtalkRobotConfigSchema).optional(),
    maxFileSize: z.number().int().positive().optional(),
    messageBufferMs: z.number().int().min(0).optional(),
    // 兼容旧配置结构（enabled=true 时可自动转换成 robots）
    appKey: z.string().optional(),
    appSecret: z.string().optional(),
  })
  .transform((value): NormalizedDingtalkConfig => {
    let robots = value.robots ?? {};
    const legacyAppKey = value.appKey?.trim();
    const legacyAppSecret = value.appSecret?.trim();

    if (Object.keys(robots).length === 0 && legacyAppKey && legacyAppSecret) {
      robots = {
        [legacyAppKey]: {
          name: legacyAppKey,
          enabled: true,
          appKey: legacyAppKey,
          appSecret: legacyAppSecret,
        },
      };
    }

    const normalized: NormalizedDingtalkConfig = { robots };
    if (value.enabled !== undefined) {
      normalized.enabled = value.enabled;
    }
    if (value.mode !== undefined) {
      normalized.mode = value.mode;
    }
    if (value.maxFileSize !== undefined) {
      normalized.maxFileSize = value.maxFileSize;
    }
    if (value.messageBufferMs) {
      normalized.messageBufferMs = value.messageBufferMs;
    }

    return normalized;
  })
  .superRefine((value, ctx) => {
    if (value.enabled && Object.keys(value.robots).length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'dingtalk.enabled=true 时必须提供 dingtalk.robots，或提供 legacy appKey/appSecret',
        path: ['robots'],
      });
    }
  });

const dingtalkSendMessageConfigSchema = z.object({
  enabled: z.boolean().optional(),
  endpoint: z.string().optional(),
  appKey: z.string().optional(),
  appSecret: z.string().optional(),
  robotCode: z.string().optional(),
});

const ttsConfigSchema = z.object({
  doubaoAppId: z.string(),
  doubaoApiKey: z.string(),
  doubaoCluster: z.string().optional(),
  defaultVoice: z.string().optional(),
  defaultSpeed: z.number().positive().optional(),
});

const sttConfigSchema = z.object({
  apiKey: z.string(),
  model: z.string().optional(),
  ossAccessKeyId: z.string(),
  ossAccessKeySecret: z.string(),
  ossBucket: z.string().optional(),
  ossEndpoint: z.string().optional(),
});

const webDisplayConfigSchema = z.object({
  thinking: z.boolean().optional(),
  toolInput: z.boolean().optional(),
  toolResult: z.boolean().optional(),
  skillInput: z.boolean().optional(),
  skillResult: z.boolean().optional(),
});

const dingtalkDisplayConfigSchema = z.object({
  thinking: z.boolean().optional(),
  toolStart: z.boolean().optional(),
  toolComplete: z.boolean().optional(),
  skillStart: z.boolean().optional(),
  skillComplete: z.boolean().optional(),
  useAICard: z.boolean().optional(),
});

const messageDisplayConfigSchema = z.object({
  web: webDisplayConfigSchema.optional(),
  dingtalk: dingtalkDisplayConfigSchema.optional(),
});

const dispatchRateLimitSchema = z.object({
  enabled: z.boolean().optional(),
  maxRequests: z.number().int().positive().optional(),
  windowMs: z.number().int().positive().optional(),
});

const dispatchSandboxSchema = z.object({
  allowWrite: z.array(z.string()).optional(),
  denyRead: z.array(z.string()).optional(),
  allowRead: z.array(z.string()).optional(),
});

const dispatchConfigSchema = z.object({
  enabled: z.boolean().optional(),
  rateLimit: dispatchRateLimitSchema.optional(),
  /** 非 admin 用户沙箱规则（admin 走 bypassPermissions 不受影响）；未配置字段走 DEFAULT_SANDBOX_* */
  sandbox: dispatchSandboxSchema.optional(),
  /** 注入到 agent 子进程的环境变量（API Key 等），不污染宿主 process.env */
  env: z.record(z.string(), z.string()).optional(),
});

const observabilityAuditSchema = z.object({
  enabled: z.boolean().optional(),
  path: z.string().optional(),
  redact: z.boolean().optional(),
  maxSizeBytes: z.number().int().positive().optional(),
  maxFiles: z.number().int().min(0).optional(),
});

const loggingConfigSchema = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
  timestamp: z.boolean().optional(),
  timestampFormat: z.enum(['full', 'time', 'none']).optional(),
  colorEnabled: z.boolean().optional(),
});

const observabilityConfigSchema = z.object({
  enabled: z.boolean().optional(),
  logging: z.union([z.boolean(), loggingConfigSchema]).optional(),
  metrics: z.boolean().optional(),
  audit: observabilityAuditSchema.optional(),
});

const memoryInjectContextSchema = z.object({
  enabled: z.boolean().optional(),
  maxLines: z.number().int().positive().optional(),
});

const memoryMaintenanceSchema = z.object({
  enabled: z.boolean().optional(),
  minTextLength: z.number().int().positive().optional(),
  cooldownMinutes: z.number().int().positive().optional(),
});

const memoryIndexEmbeddingSchema = z.object({
  baseUrl: z.string().min(1),
  apiKey: z.string().min(1),
  model: z.string().min(1),
  dimensions: z.number().int().positive(),
});

const memoryIndexSchema = z.object({
  enabled: z.boolean().optional(),
  dbDir: z.string().min(1).optional(),
  embedding: memoryIndexEmbeddingSchema,
  chunking: z.object({
    tokens: z.number().int().positive().optional(),
    overlap: z.number().int().nonnegative().optional(),
  }).optional(),
  search: z.object({
    vectorWeight: z.number().min(0).max(1).optional(),
    textWeight: z.number().min(0).max(1).optional(),
    maxResults: z.number().int().positive().optional(),
    minScore: z.number().min(0).max(1).optional(),
  }).optional(),
  temporalDecay: z.object({
    enabled: z.boolean().optional(),
    halfLifeDays: z.number().positive().optional(),
  }).optional(),
  sync: z.object({
    debounceMs: z.number().int().positive().optional(),
  }).optional(),
});

const memoryConfigSchema = z.object({
  enabled: z.boolean().optional(),
  injectContext: memoryInjectContextSchema.optional(),
  maintenance: memoryMaintenanceSchema.optional(),
  index: memoryIndexSchema.optional(),
});

const modelProviderOptionsSchema = z.object({
  thinking: z.unknown().optional(),
  reasoning_effort: z.string().optional(),
  reasoningEffort: z.string().optional(),
  extraBody: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Responses API 相关 model 维度字段（RFC v1 P0.5）
 *
 * 这些字段只在 protocol="responses" 时生效；protocol="chat_completions"（默认）
 * 时全部忽略。新增字段后所有 model 项可以选择性地标注 Responses 协议相关元数据。
 */
const modelResponsesOptionsSchema = z.object({
  /**
   * 走哪种火山协议。默认 chat_completions 保持现有行为。
   * - "chat_completions"：现有 /chat/completions 端点
   * - "responses"：火山 /responses 端点，支持 previous_response_id 接力
   */
  protocol: z.enum(['chat_completions', 'responses']).optional(),
  /**
   * Responses API 返回的 response.model 字段实际值（别名展开后）。
   * 用于 adapter 层 actualModelSeen 校验，不一致时告警。
   * 例如 doubao-seed-2.0-pro 实际值是 doubao-seed-2-0-pro-260215。
   */
  alias_actual: z.string().optional(),
  /** 模型是否在响应里公开 reasoning summary（false=隐藏派 doubao/minimax；true=glm 等公开派）。 */
  supports_reasoning_output: z.boolean().optional(),
  /** 工具调用链路是否真正 think（false=doubao 被绕过；true=glm 等公开派）。 */
  supports_tool_reasoning: z.boolean().optional(),
  /**
   * 模型支持的 tool_choice 模式白名单。
   * 例如 glm 仅支持 ["auto", "none"]，传 required/specific 会被拒。
   */
  tool_choice_modes: z.array(z.enum(['auto', 'required', 'none', 'specific'])).optional(),
  /** call_id 格式标识（base62-24 / hex-24 / base32-24 / unknown），仅记录用。 */
  call_id_format: z.string().optional(),
  /**
   * 标记是否伪推理（reasoning_tokens 永 0），便于 adapter 静默跳过 reasoning。
   */
  is_pseudo_reasoning: z.boolean().optional(),
  /**
   * 关闭 Responses API 有状态接力（previous_response_id）。
   * 默认 false：依赖上游 store 上一轮 response，接力轮只发增量 function_call_output。
   * 设 true：每轮发全量 input（含成对 function_call + function_call_output），不依赖服务端 store。
   * 用于无状态 OpenAI 兼容代理（如 cli-proxy）——这类代理不持久化 response，
   * 接力会报 "No tool call found for function call output with call_id ..."。
   */
  disable_response_chaining: z.boolean().optional(),
  /**
   * 关闭 prompt_cache_key 传递（Chat Completions + Responses 两条路径）。
   * 默认 false：以 sha256(model + system/instructions + sorted_tool_names) 前 32 hex
   * 作为内容指纹传给上游，让相同前缀的请求路由到同一缓存分片、命中 prompt cache。
   * 设 true：不传 prompt_cache_key。用于极少数「兼容层会拒绝该字段」的端点——
   * 主流 OpenAI 兼容端点都会 silent ignore 未知字段，默认开启无害。
   * 07-04 实测：CLIProxyAPI 会自动为每次请求填新 UUID 覆盖 prompt_cache_key，
   * 导致缓存永远打散——显式传稳定 key 后 cached_tokens 命中率 76%+。
   */
  disable_prompt_cache_key: z.boolean().optional(),
});

const modelPricingSchema = z.object({
  /** 输入 token 单价（USD per 1M tokens） */
  input: z.number().min(0),
  /** 输出 token 单价（USD per 1M tokens） */
  output: z.number().min(0),
  /** cache write 单价（USD per 1M tokens） */
  cacheCreation: z.number().min(0).default(0),
  /** cache read 单价（USD per 1M tokens） */
  cacheRead: z.number().min(0).default(0),
});

const usageAccountingSchema = z.enum(['input_includes_cache', 'cache_tokens_separate']);

const modelItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  value: z.string().min(1),
  pricing: modelPricingSchema.optional(),
  /**
   * token usage 语义：
   * - input_includes_cache: OpenAI-compatible，cached tokens 是 input_tokens 子集
   * - cache_tokens_separate: Anthropic 原生，cache read/write 是独立 token 分量
   */
  usage_accounting: usageAccountingSchema.optional(),
  /**
   * 模型上下文窗口（token 数）。自动压缩用它计算触发阈值
   * （当前上下文 ≥ context_window × 阈值比例时 post-run 自动压缩）。
   * 不配置 = 该模型不启用自动压缩（无内置默认，配错比不配危害大）。
   */
  context_window: z.number().int().positive().optional(),
}).extend(modelProviderOptionsSchema.shape)
  .extend(modelResponsesOptionsSchema.shape);

const modelGroupSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  apiKey: z.string().optional(),
  baseUrl: z.string().nullable().optional(),
  /** 组级关闭 Responses 有状态接力（见 modelResponsesOptionsSchema.disable_response_chaining）。 */
  disable_response_chaining: z.boolean().optional(),
  /** 组级关闭 prompt_cache_key（见 modelResponsesOptionsSchema.disable_prompt_cache_key）。 */
  disable_prompt_cache_key: z.boolean().optional(),
  models: z.array(modelItemSchema).min(1),
}).extend(modelProviderOptionsSchema.shape)
  .extend(modelResponsesOptionsSchema.shape);

const modelsConfigSchema = z.object({
  groups: z.array(modelGroupSchema).min(1),
  default: z.string().min(1),
  allowCrossGroupSwitch: z.boolean().default(false),
});

const titleGeneratorConfigSchema = z.object({
  model: z.string().min(1),   // "groupId/modelId" 引用 models 中已配置的模型
  // fallbackModels: 主模型上游返回空 / 报错时，按顺序回退到这些模型。
  // 仅在标题生成场景生效——主模型挑稳定 + 表达好，fallback 挑最简单稳跑的小模型。
  fallbackModels: z.array(z.string().min(1)).optional(),
});

const selfSignupSmsSchema = z.object({
  /** dev = 验证码只打 server log（配合 env AGENT_SMS_DEV_CODE 万能码内测）；aliyun = 真实发送 */
  provider: z.enum(['dev', 'aliyun']).default('dev'),
  /** aliyun：AccessKey ID。Secret 只走 env `AGENT_SMS_ACCESS_KEY_SECRET`，不进 config 文件。 */
  accessKeyId: z.string().optional(),
  /** aliyun：控制台审核通过的短信签名名称 */
  signName: z.string().optional(),
  /** aliyun：验证码模板 CODE（模板变量固定为 ${code}） */
  templateCode: z.string().optional(),
  /** 验证码有效期，默认 300 秒 */
  codeTtlSeconds: z.number().int().min(60).max(1800).default(300),
  /** 同手机号发送冷却，默认 60 秒 */
  cooldownSeconds: z.number().int().min(30).max(600).default(60),
  /** 同手机号自然日发送上限，默认 10 条 */
  dailyLimitPerPhone: z.number().int().min(1).max(50).default(10),
  /** 单个验证码最多错误尝试次数，默认 5 次 */
  maxVerifyAttempts: z.number().int().min(1).max(10).default(5),
  /** 同 IP 每分钟发送验证码上限，默认 5 次 */
  maxSendPerIpPerMinute: z.number().int().min(1).max(60).default(5),
  /** 同 IP 每分钟注册提交上限，默认 5 次 */
  maxRegisterPerIpPerMinute: z.number().int().min(1).max(60).default(5),
});

/**
 * 手机号自助注册试用（官网联动 MVP，2026-07-04）。
 * 注册链路：官网 CTA → /signup → 手机验证码 → 独立试用租户 + 赠积分硬封顶 + 模型白名单
 * → 线索推钉钉「官网线索」群。缺省关闭；enabled=false 时 send-code/register 返回 403。
 */
export const selfSignupConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** 注册赠送积分数（试用额度，≠ 正式版套餐量） */
  grantCredits: z.number().positive().default(500),
  /**
   * 试用租户模型白名单（"group/model" ref 列表）；首个作为默认模型。
   * 缺省 = 仅全局默认模型（config.models.default）。
   */
  allowedModels: z.array(z.string().min(1)).optional(),
  /** 注册线索钉钉群机器人 webhook（含 access_token 完整 URL）；缺省不推送 */
  dingtalkLeadWebhook: z.string().url().optional(),
  sms: selfSignupSmsSchema.optional(),
});

const authConfigSchema = z.object({
  enabled: z.boolean().default(false),
  jwtSecret: z.string().min(32),
  tokenExpiresIn: z.string().default('30d'),
  usersFile: z.string().default('./data/users.json'),
  selfSignup: selfSignupConfigSchema.optional(),
});

const auditConfigSchema = z.object({
  /**
   * Runtime audit 读后端：
   *   - 'file'   (默认)：直接从 *.runtime-events.jsonl 实时读 tool_audit 事件
   *   - 'duckdb'      ：投影到独立 audit.duckdb 单文件，查询前 tick 增量
   *
   * 两种 backend 共享 RuntimeAuditQuery 接口，admin route 不感知；同一份 audit
   * 数据两 backend 结果一致（见 verify:audit-read 双 backend 验证）。
   */
  projection: z.enum(['file', 'duckdb']).optional(),
});

const artifactBaseConfigSchema = z.object({
  signedUrlSecret: z.string().min(16).optional(),
  readUrlTtlSeconds: z.number().int().positive().max(7 * 24 * 60 * 60).optional(),
  maxBlobBytes: z.number().int().positive().optional(),
  retentionDays: z.number().int().positive().optional(),
  gcIntervalMs: z.number().int().positive().optional(),
});

const artifactConfigSchema = z.discriminatedUnion('backend', [
  artifactBaseConfigSchema.extend({
    backend: z.literal('local'),
    rootDir: z.string().min(1).optional(),
    publicBaseUrl: z.string().url().optional(),
  }),
  artifactBaseConfigSchema.extend({
    backend: z.literal('oss'),
    accessKeyId: z.string().min(1),
    accessKeySecret: z.string().min(1),
    bucket: z.string().min(1),
    region: z.string().min(1).optional(),
    endpoint: z.string().min(1).optional(),
    prefix: z.string().min(1).optional(),
  }),
]).superRefine((value, ctx) => {
  if (value.backend === 'oss' && !value.region && !value.endpoint) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['endpoint'],
      message: 'artifact.backend="oss" 时必须提供 region 或 endpoint',
    });
  }
});

/**
 * Shared bearer credential shape: 任意接受 Bearer token 的下游（serverRemote /
 * tenantRemoteHand / clientDaemon）都复用 `authToken | authTokenRef` 二选一 +
 * 互斥 + ref 不能是 secret-like 值的语义，避免在多处重复手写 superRefine 漂移。
 *
 * 使用方式：
 *   z.object({ baseUrl: ..., ...bearerCredentialFields, ... })
 *     .superRefine((value, ctx) => applyBearerCredentialRefine(value, ctx))
 */
export const bearerCredentialFields = {
  /** Inline bearer token (≥8). Dev/staging only. Production should use `authTokenRef`. */
  authToken: z.string().min(8).optional(),
  /**
   * SecretVault ref id resolved at runtime (`actor: 'system'`). The ref id itself
   * is not a secret; the heuristic refine guards against accidentally pasting a
   * real token here.
   */
  authTokenRef: z.string().min(1).optional(),
} as const;

export function applyBearerCredentialRefine(
  value: { authToken?: string; authTokenRef?: string },
  ctx: z.RefinementCtx,
  opts: { pathPrefix?: (string | number)[]; allowEmpty?: boolean } = {},
): void {
  const prefix = opts.pathPrefix ?? [];
  const hasInline = typeof value.authToken === 'string' && value.authToken.length > 0;
  const hasRef = typeof value.authTokenRef === 'string' && value.authTokenRef.length > 0;
  if (!hasInline && !hasRef) {
    if (!opts.allowEmpty) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...prefix, 'authToken'],
        message: 'one of authToken or authTokenRef is required',
      });
    }
  }
  if (hasInline && hasRef) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [...prefix, 'authTokenRef'],
      message: 'authToken and authTokenRef are mutually exclusive',
    });
  }
  if (hasRef && looksLikeSecret(value.authTokenRef!)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [...prefix, 'authTokenRef'],
      message: 'authTokenRef must be a vault ref id, not an actual secret value',
    });
  }
}

/**
 * Server-remote hand 配置（PR 1.4+1.5；A4 扩展支持 authTokenRef）。
 *
 * 配置后，PlatformToolRuntime 在 `executionTarget=server-remote` 时通过
 * HttpTransport 调远端 hand-server；不配置则 `server-remote` 目标未注册，
 * admin 选该目标会得到"transport not registered"错误。
 *
 * `baseUrl` 示例：`http://127.0.0.1:3300`（本机 hand-server）。
 * 凭证形态：`authToken` 直接明文（dev/staging）；`authTokenRef` 走 SecretVault
 * （生产推荐）。两者互斥、二选一。
 * `invokeTimeoutMs` 是 HTTP 整体超时，默认 60 秒；工具自身 timeoutMs 在
 * input 内独立传递。
 */
const workspaceRecipeConfigSchema = z.object({
  workspaceId: z.string().min(1).optional(),
  sandboxScopeId: z.string().min(1).optional(),
  mountSubPath: z.string().min(1).optional(),
  repo: z.object({
    url: z.string().min(1),
    ref: z.string().min(1).optional(),
    remote: z.string().min(1).optional(),
  }).optional(),
  files: z.array(z.object({
    artifactId: z.string().min(1),
    path: z.string().min(1),
    url: z.string().url().optional(),
    signedUrl: z.string().url().optional(),
  })).optional(),
  setupCommands: z.array(z.string().min(1)).optional(),
  resources: z.object({
    cpu: z.string().min(1).optional(),
    memoryMb: z.number().int().positive().optional(),
    diskMb: z.number().int().positive().optional(),
    timeoutMs: z.number().int().positive().max(600_000).optional(),
  }).optional(),
});

const serverRemoteConfigSchema = z.object({
  baseUrl: z.string().url(),
  ...bearerCredentialFields,
  invokeTimeoutMs: z.number().int().positive().max(600_000).optional(),
  recipe: workspaceRecipeConfigSchema.optional(),
}).superRefine((value, ctx) => applyBearerCredentialRefine(value, ctx));

const tenantRemoteHandRolloutSchema = z.object({
  mode: z.enum(['disabled', 'drain', 'allowlist', 'tenant', 'all']),
  userIds: z.array(z.string().min(1)).optional(),
  usernames: z.array(z.string().min(1)).optional(),
  tenantIds: z.array(z.string().min(1)).optional(),
}).superRefine((value, ctx) => {
  const userIdCount = value.userIds?.length ?? 0;
  const usernameCount = value.usernames?.length ?? 0;
  const tenantIdCount = value.tenantIds?.length ?? 0;
  if (value.mode === 'allowlist') {
    if (userIdCount + usernameCount === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['userIds'],
        message: 'allowlist rollout requires userIds or usernames',
      });
    }
    if (tenantIdCount > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tenantIds'],
        message: 'allowlist rollout cannot include tenantIds',
      });
    }
    return;
  }
  if (value.mode === 'tenant') {
    if (tenantIdCount === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tenantIds'],
        message: 'tenant rollout requires tenantIds',
      });
    }
    if (userIdCount + usernameCount > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['userIds'],
        message: 'tenant rollout cannot include userIds or usernames',
      });
    }
    return;
  }
  if (userIdCount + usernameCount + tenantIdCount > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['mode'],
      message: `${value.mode} rollout cannot include allow-list fields`,
    });
  }
});

const networkPolicyConfigSchema = z.object({
  mode: z.enum(NETWORK_POLICY_MODES).default(DEFAULT_CODING_HAND_NETWORK_POLICY.mode),
  denyPrivateNetworks: z.boolean().optional(),
  allowCidrs: z.array(z.string().refine(isValidCidr, 'CIDR 格式不合法')).optional(),
  allowDomains: z.array(z.string().refine(isValidDomain, '域名格式不合法')).optional(),
  denyCidrs: z.array(z.string().refine(isValidCidr, 'CIDR 格式不合法')).optional(),
}).transform((value) => normalizeNetworkPolicy(value));

const tenantRemoteHandSchema = z.object({
  /**
   * Stable logical id shown to the model as `${sessionId}:${id}` when attached.
   * Keep this short and URL/path safe, e.g. "tenant-ecs" or "customer-vpc".
   */
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/),
  description: z.string().min(1).optional(),
  /**
   * Optional username allow-list (B1 legacy baseline). Omit `users` AND
   * `tenantIds` to attach to every authenticated user/session.
   */
  users: z.array(z.string().min(1)).optional(),
  /**
   * B1: Optional tenantId allow-list. The runtime resolves the requesting
   * user's `tenantId` (UserStore.findById/Username) and attaches the hand when
   * `user.tenantId` ∈ `tenantIds`. `users` and `tenantIds` are independently
   * permissive: either set, attach if any matches.
   */
  tenantIds: z.array(z.string().min(1)).optional(),
  /**
   * Explicit rollout strategy. Legacy top-level `users`/`tenantIds` remain
   * supported when `rollout` is omitted, but must not be mixed with it.
   */
  rollout: tenantRemoteHandRolloutSchema.optional(),
  /** Tenant ECS / Docker hand-server base URL. */
  baseUrl: z.string().url().refine((value) => {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
  }, 'baseUrl must be http(s) and must not include username/password'),
  /**
   * Desired network policy for this coding hand. This is not proof of runtime
   * enforcement; health/runtime ops must report effective status separately.
   *
   * Coding sandboxes must not be the path for RDS/CRM/high-privilege company
   * data. Those skills should use platform-controlled tools. Customer private
   * systems require explicit private-egress allow-lists.
   */
  networkPolicy: networkPolicyConfigSchema.default(DEFAULT_CODING_HAND_NETWORK_POLICY),
  ...bearerCredentialFields,
  invokeTimeoutMs: z.number().int().positive().max(600_000).optional(),
  recipe: workspaceRecipeConfigSchema.optional(),
}).superRefine((value, ctx) => {
  applyBearerCredentialRefine(value, ctx);
  if (value.rollout && ((value.users?.length ?? 0) > 0 || (value.tenantIds?.length ?? 0) > 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['rollout'],
      message: 'rollout cannot be combined with legacy users or tenantIds',
    });
  }
});

const tenantRemoteHandsConfigSchema = z.object({
  /**
   * Static tenant ECS hand appliances. Each matching session gets a session-scoped
   * server-remote hand record whose endpoint/auth route to the configured Docker.
   */
  hands: z.array(tenantRemoteHandSchema).default([]),
}).superRefine((value, ctx) => {
  const seen = new Set<string>();
  value.hands.forEach((hand, index) => {
    if (seen.has(hand.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['hands', index, 'id'],
        message: `duplicate tenant remote hand id: ${hand.id}`,
      });
      return;
    }
    seen.add(hand.id);
  });
}).optional();

/**
 * SecretVault backend 选择（A2）。
 *
 * 默认（未配置）：进程内 `InMemorySecretVault`，仅适合 dev/单进程。
 * `encrypted-file`：AES-256-GCM 落盘单文件，适合 staging/单实例。
 * `http`：外部 KMS / secret-manager proxy，生产推荐。
 *
 * vault 自身 auth 不能再走 vault ref（鸡生蛋），所以 http backend 的 token
 * 只接受 inline `authToken` 或 `authTokenEnv`（从环境变量读取）。
 * encrypted-file 的 `encryptionKey` 同理：`encryptionKey`(inline) 或
 * `encryptionKeyEnv` 二选一。
 */
const secretVaultConfigSchema = z.discriminatedUnion('backend', [
  z.object({
    backend: z.literal('memory'),
  }),
  z.object({
    backend: z.literal('encrypted-file'),
    /** 落盘加密文件路径（相对 server cwd 或绝对路径）。 */
    filePath: z.string().min(1),
    /** Inline AES-256-GCM 密钥（任意长度，内部 sha256）。dev only。 */
    encryptionKey: z.string().min(16).optional(),
    /** 环境变量名；从 process.env[name] 读取密钥（生产推荐）。 */
    encryptionKeyEnv: z.string().min(1).optional(),
  }).superRefine((value, ctx) => {
    const hasInline = typeof value.encryptionKey === 'string' && value.encryptionKey.length > 0;
    const hasEnv = typeof value.encryptionKeyEnv === 'string' && value.encryptionKeyEnv.length > 0;
    if (!hasInline && !hasEnv) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['encryptionKey'],
        message: 'one of encryptionKey or encryptionKeyEnv is required',
      });
    }
    if (hasInline && hasEnv) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['encryptionKeyEnv'],
        message: 'encryptionKey and encryptionKeyEnv are mutually exclusive',
      });
    }
  }),
  z.object({
    backend: z.literal('http'),
    baseUrl: z.string().url(),
    /** Inline bearer token (≥8). 仅 dev/staging；生产用 authTokenEnv。 */
    authToken: z.string().min(8).optional(),
    /** 环境变量名；从 process.env[name] 读取 bearer token（生产推荐）。 */
    authTokenEnv: z.string().min(1).optional(),
  }).superRefine((value, ctx) => {
    const hasInline = typeof value.authToken === 'string' && value.authToken.length > 0;
    const hasEnv = typeof value.authTokenEnv === 'string' && value.authTokenEnv.length > 0;
    if (!hasInline && !hasEnv) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['authToken'],
        message: 'one of authToken or authTokenEnv is required',
      });
    }
    if (hasInline && hasEnv) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['authTokenEnv'],
        message: 'authToken and authTokenEnv are mutually exclusive',
      });
    }
  }),
]);

const runtimeEventStoreConfigSchema = z.discriminatedUnion('backend', [
  z.object({
    backend: z.literal('file'),
  }),
  z.object({
    backend: z.literal('pg'),
    connectionString: z.string().min(1),
    tablePrefix: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/).optional(),
  }),
]);


const clientDaemonConfigSchema = z.object({
  /** Reverse WebSocket endpoint path for customer-side daemon connections. */
  path: z.string().startsWith('/').optional(),
  /**
   * Optional shared bearer/hello token. Omit both `authToken` and
   * `authTokenRef` only for trusted/dev deployments (gateway accepts any
   * connection). Production should set `authTokenRef` so the plaintext lives
   * in SecretVault; rotation is then a vault `rotateSecret` + `setAuthToken`
   * hot-update without restarting the gateway.
   */
  ...bearerCredentialFields,
  helloTimeoutMs: z.number().int().positive().max(60_000).optional(),
  /** 单 daemon 连接 lastSeenAt 未刷新超过该值视为失联。默认 60_000。设为 0 关闭扫描。 */
  heartbeatTimeoutMs: z.number().int().nonnegative().max(10 * 60_000).optional(),
  /** scanner 周期；默认 heartbeatTimeoutMs/3（最小 1s）。 */
  heartbeatScanIntervalMs: z.number().int().positive().max(10 * 60_000).optional(),
}).superRefine((value, ctx) => applyBearerCredentialRefine(value, ctx, { allowEmpty: true })).optional();

const apiKeyCredentialFields = {
  /** Inline API key. Dev/staging only. Production should use `apiKeyRef`. */
  apiKey: z.string().min(8).optional(),
  /** SecretVault ref id resolved at runtime. The ref id itself is not a secret. */
  apiKeyRef: z.string().min(1).optional(),
} as const;

function applyApiKeyCredentialRefine(
  value: { apiKey?: string; apiKeyRef?: string },
  ctx: z.RefinementCtx,
  opts: { pathPrefix?: (string | number)[]; allowEmpty?: boolean } = {},
): void {
  const prefix = opts.pathPrefix ?? [];
  const hasInline = typeof value.apiKey === 'string' && value.apiKey.length > 0;
  const hasRef = typeof value.apiKeyRef === 'string' && value.apiKeyRef.length > 0;
  if (!hasInline && !hasRef && !opts.allowEmpty) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [...prefix, 'apiKey'],
      message: 'one of apiKey or apiKeyRef is required',
    });
  }
  if (hasInline && hasRef) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [...prefix, 'apiKeyRef'],
      message: 'apiKey and apiKeyRef are mutually exclusive',
    });
  }
  if (hasRef && looksLikeSecret(value.apiKeyRef!)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [...prefix, 'apiKeyRef'],
      message: 'apiKeyRef must be a vault ref id, not an actual secret value',
    });
  }
}

const webToolsSearchConfigSchema = z.object({
  enabled: z.boolean().optional(),
  provider: z.enum(['brave', 'volcengine']).default('volcengine'),
  endpoint: z.string().url().optional(),
  ...apiKeyCredentialFields,
  timeoutMs: z.number().int().positive().max(60_000).optional(),
  maxResults: z.number().int().min(1).max(10).optional(),
}).superRefine((value, ctx) => {
  applyApiKeyCredentialRefine(value, ctx, { allowEmpty: true });
});

const webToolsFetchConfigSchema = z.object({
  enabled: z.boolean().optional(),
  timeoutMs: z.number().int().positive().max(60_000).optional(),
  maxBytes: z.number().int().positive().max(10 * 1024 * 1024).optional(),
  maxChars: z.number().int().min(100).max(50_000).optional(),
  maxRedirects: z.number().int().min(0).max(10).optional(),
  allowedContentTypes: z.array(z.string().min(1)).optional(),
  userAgent: z.string().min(1).optional(),
});

const webToolsEgressConfigSchema = z.object({
  allowPrivateNetworks: z.boolean().optional(),
  allowedHosts: z.array(z.string().min(1)).optional(),
  blockedHosts: z.array(z.string().min(1)).optional(),
});

const webToolsConfigSchema = z.object({
  enabled: z.boolean().optional(),
  search: webToolsSearchConfigSchema.optional(),
  fetch: webToolsFetchConfigSchema.optional(),
  egress: webToolsEgressConfigSchema.optional(),
}).superRefine((value, ctx) => {
  if (value.enabled !== false && value.search && value.search.enabled !== false) {
    applyApiKeyCredentialRefine(value.search, ctx, { pathPrefix: ['search'] });
  }
}).optional();

const toolControlsConfigSchema = z.object({
  /** 全局总开关。false 时除底层内部恢复逻辑外，不向模型暴露任何平台工具。 */
  enabled: z.boolean().optional(),
  /** 按 ToolDescriptor.name/id 控制模型可见工具。未列出的工具默认启用。 */
  tools: z.record(z.string().min(1), z.object({
    enabled: z.boolean().optional(),
  })).optional(),
}).optional();

const runtimeSchedulerConfigSchema = z.object({
  /** 默认 true：PG Web chat 默认 enqueue-only，并由 scheduler 调用 wakeRuntimeSession 执行。 */
  autoWake: z.boolean().optional(),
  pollIntervalMs: z.number().int().positive().optional(),
  leaseMs: z.number().int().positive().optional(),
  renewIntervalMs: z.number().int().positive().optional(),
  maxConcurrentRuns: z.number().int().positive().optional(),
  /** waiting_approval 超过该时间自动 rejected + cancelled。默认 24h；设 0 关闭。 */
  approvalTimeoutMs: z.number().int().nonnegative().optional(),
});

/** B4: Server-remote hands 健康检查 scanner（仅 PG runtime）。 */
const runtimeHandHealthScannerConfigSchema = z.object({
  /** 默认 true：PG runtime 启动时拉起 scanner；显式 false 完全关闭。 */
  enabled: z.boolean().optional(),
  /** 周期。默认 30_000；最小 1_000。 */
  intervalMs: z.number().int().min(1_000).max(10 * 60_000).optional(),
  /** 单次 /health 请求超时。默认 5_000；最小 500。 */
  healthTimeoutMs: z.number().int().min(500).max(60_000).optional(),
});

export const appConfigSchema = z.object({
  proxy: proxyConfigSchema.optional(),
  agent: agentConfigSchema,
  server: serverConfigSchema,
  cron: cronConfigSchema.optional(),
  roleKit: roleKitConfigSchema,
  dingtalk: dingtalkConfigSchema.optional(),
  dingtalkSendMessage: dingtalkSendMessageConfigSchema.optional(),
  tts: ttsConfigSchema.optional(),
  stt: sttConfigSchema.optional(),
  messageDisplay: messageDisplayConfigSchema.optional(),
  dispatch: dispatchConfigSchema.optional(),
  observability: observabilityConfigSchema.optional(),
  memory: memoryConfigSchema.optional(),
  auth: authConfigSchema.optional(),
  models: modelsConfigSchema.optional(),
  titleGenerator: titleGeneratorConfigSchema.optional(),
  audit: auditConfigSchema.optional(),
  artifact: artifactConfigSchema.optional(),
  serverRemote: serverRemoteConfigSchema.optional(),
  tenantRemoteHands: tenantRemoteHandsConfigSchema,
  runtimeEventStore: runtimeEventStoreConfigSchema.optional(),
  runtimeScheduler: runtimeSchedulerConfigSchema.optional(),
  runtimeHandHealthScanner: runtimeHandHealthScannerConfigSchema.optional(),
  clientDaemon: clientDaemonConfigSchema,
  secretVault: secretVaultConfigSchema.optional(),
  webTools: webToolsConfigSchema,
  toolControls: toolControlsConfigSchema,
}).superRefine((value, ctx) => {
  if ((value.tenantRemoteHands?.hands.length ?? 0) > 0 && value.runtimeEventStore?.backend !== 'pg') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['tenantRemoteHands'],
      message: 'tenantRemoteHands requires runtimeEventStore.backend="pg" so durable HandStore/RunStore are available',
    });
  }
});

export type ProxyConfig = z.infer<typeof proxyConfigSchema>;
export type AgentPermissionMode = z.infer<typeof agentPermissionModeSchema>;
export type AgentSettingSource = z.infer<typeof agentSettingSourceSchema>;
export type AgentConfig = z.infer<typeof agentConfigSchema>;
export type ServerConfig = z.infer<typeof serverConfigSchema>;
export type CronConfig = z.infer<typeof cronConfigSchema>;
export type RoleKitConfig = z.infer<typeof roleKitConfigSchema>;
export type DingtalkRobotConfig = z.infer<typeof dingtalkRobotConfigSchema>;
export type DingtalkConfig = z.infer<typeof dingtalkConfigSchema>;
export type DingtalkSendMessageConfig = z.infer<typeof dingtalkSendMessageConfigSchema>;
export type TtsConfig = z.infer<typeof ttsConfigSchema>;
export type WebMessageDisplayConfig = z.infer<typeof webDisplayConfigSchema>;
export type DingtalkMessageDisplayConfig = z.infer<typeof dingtalkDisplayConfigSchema>;
export type MessageDisplayConfig = z.infer<typeof messageDisplayConfigSchema>;
export type DispatchRateLimitConfig = z.infer<typeof dispatchRateLimitSchema>;
export type DispatchConfig = z.infer<typeof dispatchConfigSchema>;
export type LoggingConfig = z.infer<typeof loggingConfigSchema>;
export type ObservabilityAuditConfig = z.infer<typeof observabilityAuditSchema>;
export type ObservabilityConfig = z.infer<typeof observabilityConfigSchema>;
export type MemoryInjectContextConfig = z.infer<typeof memoryInjectContextSchema>;
export type MemoryMaintenanceConfig = z.infer<typeof memoryMaintenanceSchema>;
export type MemoryConfig = z.infer<typeof memoryConfigSchema>;
export type MemoryIndexAppConfig = z.infer<typeof memoryIndexSchema>;
export type AuthConfig = z.infer<typeof authConfigSchema>;
export type SelfSignupConfig = z.infer<typeof selfSignupConfigSchema>;
export type ModelItem = z.infer<typeof modelItemSchema>;
export type ModelGroup = z.infer<typeof modelGroupSchema>;
export type ModelsConfig = z.infer<typeof modelsConfigSchema>;
export type TitleGeneratorAppConfig = z.infer<typeof titleGeneratorConfigSchema>;
export type AuditConfig = z.infer<typeof auditConfigSchema>;
export type ArtifactConfig = z.infer<typeof artifactConfigSchema>;
export type ServerRemoteConfig = z.infer<typeof serverRemoteConfigSchema>;
export type TenantRemoteHandsConfig = NonNullable<z.infer<typeof tenantRemoteHandsConfigSchema>>;
export type RuntimeEventStoreConfig = z.infer<typeof runtimeEventStoreConfigSchema>;
export type RuntimeSchedulerConfig = z.infer<typeof runtimeSchedulerConfigSchema>;
export type RuntimeHandHealthScannerConfig = z.infer<typeof runtimeHandHealthScannerConfigSchema>;
export type ClientDaemonConfig = NonNullable<z.infer<typeof clientDaemonConfigSchema>>;
export type SecretVaultConfig = z.infer<typeof secretVaultConfigSchema>;
export type WebToolsConfig = z.infer<typeof webToolsConfigSchema>;
export type ToolControlsConfig = z.infer<typeof toolControlsConfigSchema>;
export type AppConfig = z.infer<typeof appConfigSchema>;

function formatValidationError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${path}: ${issue.message}`;
    })
    .join('\n');
}

export function parseAppConfig(rawConfig: unknown): AppConfig {
  const parsed = appConfigSchema.safeParse(rawConfig);
  if (!parsed.success) {
    throw new Error(`配置校验失败:\n${formatValidationError(parsed.error)}`);
  }
  const config: AppConfig = parsed.data;
  return config;
}

export function getAppConfigPath(processCwd: string): string {
  const explicitPath = process.env.AGENT_SAAS_CONFIG_PATH || process.env.CONFIG_JSON_PATH;
  if (explicitPath) return resolve(explicitPath);
  return resolve(join(processCwd, '..', 'config.json'));
}

export function loadAppConfig(processCwd: string): AppConfig {
  const configPath = getAppConfigPath(processCwd);
  let rawConfig: unknown;

  try {
    rawConfig = parseJsonc(readFileSync(configPath, 'utf-8'));
  } catch (error) {
    throw new Error(
      `读取配置失败 (${configPath}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return parseAppConfig(rawConfig);
}

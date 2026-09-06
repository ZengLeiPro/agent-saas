/**
 * WP2a：`kyApp` 平台侧配置域（规范 §3.1 / §3.8 / §4.6 / §8.4；WP2a 施工总则 §3.1）。
 *
 * 纪律：**本域不新增任何环境变量**，全部走 `config.json` 的 `kyApp` 键。
 * `server/src/app/config.ts` 的顶层 `appConfigSchema` 是 zod `z.object`（strip 语义），
 * 未登记的键会被静默丢弃，因此这里从**原始** config 对象自行解析，
 * 既不改动那个已到行数棘轮上限的文件，也不依赖它的解析结果。
 *
 * `kyApp` 缺失 → 返回 `null` → 定制项目对接功能整体关闭（路由不注册、后台循环不启动）。
 */
import { readFileSync } from 'node:fs';

import { parse as parseJsonc } from 'jsonc-parser';
import { z } from 'zod';

import { getAppConfigPath } from '../app/config.js';

/** 默认 JWKS 路径（规范 §3.1）。 */
export const DEFAULT_KY_APP_JWKS_PATH = '/.well-known/ky-app-jwks.json';

/** 规范 §3.8：各环境 `iss`。`local` 依赖端口，必须显式配置 `publicIssuer`。 */
const ISSUER_BY_ENVIRONMENT = {
  prod: 'https://agent.kaiyan.net',
  staging: 'https://staging.agent.kaiyan.net',
} as const;

/** 规范 §3.1：各环境 JWKS 所在的 API 域。`local` 与 `publicIssuer` 同源。 */
const API_BASE_BY_ENVIRONMENT = {
  prod: 'https://api.agent.kaiyan.net',
  staging: 'https://api.staging.agent.kaiyan.net',
} as const;

/** 规范 §3.1 TTL 表的默认值（秒）。 */
export const DEFAULT_SAT_TTL_SECONDS = { user: 300, agent: 60, platform: 60 } as const;

/** 规范 §4.6：live 60 s、ready 5 min、连续 5 次失败告警。 */
export const DEFAULT_PROBE = {
  liveIntervalMs: 60_000,
  readyIntervalMs: 300_000,
  failureThreshold: 5,
} as const;

/** 规范 §3.7：平台事件重试 24 小时。 */
export const DEFAULT_EVENT_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * 规范 §3.6/§3.4：目录变更流保留 30 天；投影节拍 5 分钟
 * （§3.4「调部门：数据范围随目录更新，延迟 ≤ 轮询间隔，默认 5 分钟」）。
 */
export const DEFAULT_DIRECTORY = {
  retentionDays: 30,
  reconcileIntervalMs: 5 * 60 * 1000,
} as const;

const absoluteUrl = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => {
    try {
      const parsed = new URL(value);
      return (
        (parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.origin === value
      );
    } catch {
      return false;
    }
  }, '必须是不含路径/查询/结尾斜杠的 origin');

const pathValue = z
  .string()
  .min(2)
  .max(120)
  .refine(
    (value) => value.startsWith('/') && !value.includes('//') && !value.includes('..'),
    '必须是规范化的绝对路径',
  );

const satTtlSchema = z
  .object({
    user: z.number().int().min(60).max(3600).optional(),
    agent: z.number().int().min(10).max(300).optional(),
    platform: z.number().int().min(10).max(300).optional(),
  })
  .strict();

const probeSchema = z
  .object({
    liveIntervalMs: z.number().int().min(5_000).max(3_600_000).optional(),
    readyIntervalMs: z.number().int().min(30_000).max(3_600_000).optional(),
    failureThreshold: z.number().int().min(1).max(50).optional(),
  })
  .strict();

const eventsSchema = z
  .object({
    retryWindowMs: z
      .number()
      .int()
      .min(60_000)
      .max(7 * 24 * 60 * 60 * 1000)
      .optional(),
  })
  .strict();

const directorySchema = z
  .object({
    /** 变更流保留天数（§3.6 默认 30 天）；早于下界的游标一律要求重拉快照。 */
    retentionDays: z.number().int().min(1).max(365).optional(),
    /** 目录投影节拍（§3.4 默认 5 分钟）。 */
    reconcileIntervalMs: z
      .number()
      .int()
      .min(30_000)
      .max(6 * 60 * 60 * 1000)
      .optional(),
  })
  .strict();

/** `config.json` 中 `kyApp` 域的原始形态。 */
export const kyAppConfigSchema = z
  .object({
    environment: z.enum(['prod', 'staging', 'local']),
    /** SAT 的 `iss`；prod/staging 缺省按 §3.8 取值，local 必填。 */
    publicIssuer: absoluteUrl.optional(),
    /** JWKS 所在 API 域；prod/staging 缺省按 §3.1 取值，local 与 `publicIssuer` 同源。 */
    publicApiBaseUrl: absoluteUrl.optional(),
    jwksPath: pathValue.optional(),
    satTtlSeconds: satTtlSchema.optional(),
    probe: probeSchema.optional(),
    events: eventsSchema.optional(),
    /** WP2b 组织目录变更流（§3.6）。整域缺省即全部取默认值，不需要新增任何环境变量。 */
    directory: directorySchema.optional(),
    /**
     * 仅 staging/local 可开：允许向 http 的本机地址出站（规范 §6.3 自建出站安全）。
     * prod 打开一律视为配置错误。
     */
    allowInsecureOutbound: z.boolean().optional(),
  })
  .strict();

export type KyAppRawConfig = z.infer<typeof kyAppConfigSchema>;

/** 解析后的平台侧配置；所有派生值都已定型，消费方不再做缺省判断。 */
export interface KyAppPlatformConfig {
  environment: 'prod' | 'staging' | 'local';
  /** SAT `iss`（规范 §3.8）。 */
  issuer: string;
  /** JWKS 绝对地址（规范 §3.1），写进定制项目部署配置。 */
  jwksUrl: string;
  jwksPath: string;
  satTtlSeconds: { user: number; agent: number; platform: number };
  probe: { liveIntervalMs: number; readyIntervalMs: number; failureThreshold: number };
  events: { retryWindowMs: number };
  directory: { retentionDays: number; reconcileIntervalMs: number };
  allowInsecureOutbound: boolean;
}

export class KyAppConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KyAppConfigError';
  }
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('；');
}

function resolveIssuer(raw: KyAppRawConfig): string {
  if (raw.environment === 'local') {
    if (!raw.publicIssuer)
      throw new KyAppConfigError('kyApp.environment=local 时必须配置 publicIssuer');
    return raw.publicIssuer;
  }
  return raw.publicIssuer ?? ISSUER_BY_ENVIRONMENT[raw.environment];
}

function resolveApiBase(raw: KyAppRawConfig, issuer: string): string {
  if (raw.publicApiBaseUrl) return raw.publicApiBaseUrl;
  return raw.environment === 'local' ? issuer : API_BASE_BY_ENVIRONMENT[raw.environment];
}

/**
 * 从**原始** config 对象解析 `kyApp` 域。
 * 未配置 → `null`（功能整体关闭）；配置了但非法 → 抛 `KyAppConfigError`（fail-closed）。
 */
export function resolveKyAppConfig(rawConfig: unknown): KyAppPlatformConfig | null {
  if (typeof rawConfig !== 'object' || rawConfig === null) return null;
  const candidate = (rawConfig as Record<string, unknown>).kyApp;
  if (candidate === undefined || candidate === null) return null;

  const parsed = kyAppConfigSchema.safeParse(candidate);
  if (!parsed.success)
    throw new KyAppConfigError(`kyApp 配置校验失败：${formatIssues(parsed.error)}`);
  const raw = parsed.data;
  if (raw.environment === 'prod' && raw.allowInsecureOutbound === true) {
    throw new KyAppConfigError('kyApp.allowInsecureOutbound 不允许在 prod 环境开启');
  }

  const issuer = resolveIssuer(raw);
  const jwksPath = raw.jwksPath ?? DEFAULT_KY_APP_JWKS_PATH;
  const apiBase = resolveApiBase(raw, issuer);
  return {
    environment: raw.environment,
    issuer,
    jwksUrl: `${apiBase}${jwksPath}`,
    jwksPath,
    satTtlSeconds: {
      user: raw.satTtlSeconds?.user ?? DEFAULT_SAT_TTL_SECONDS.user,
      agent: raw.satTtlSeconds?.agent ?? DEFAULT_SAT_TTL_SECONDS.agent,
      platform: raw.satTtlSeconds?.platform ?? DEFAULT_SAT_TTL_SECONDS.platform,
    },
    probe: {
      liveIntervalMs: raw.probe?.liveIntervalMs ?? DEFAULT_PROBE.liveIntervalMs,
      readyIntervalMs: raw.probe?.readyIntervalMs ?? DEFAULT_PROBE.readyIntervalMs,
      failureThreshold: raw.probe?.failureThreshold ?? DEFAULT_PROBE.failureThreshold,
    },
    events: { retryWindowMs: raw.events?.retryWindowMs ?? DEFAULT_EVENT_RETRY_WINDOW_MS },
    directory: {
      retentionDays: raw.directory?.retentionDays ?? DEFAULT_DIRECTORY.retentionDays,
      reconcileIntervalMs:
        raw.directory?.reconcileIntervalMs ?? DEFAULT_DIRECTORY.reconcileIntervalMs,
    },
    allowInsecureOutbound: raw.allowInsecureOutbound === true,
  };
}

/**
 * 从磁盘 `config.json` 读取 `kyApp` 域。
 * 与 `loadAppConfig` 共用 `getAppConfigPath`（同一 `AGENT_SAAS_CONFIG_PATH`/`CONFIG_JSON_PATH` 语义），
 * 但不经过 `appConfigSchema`（它会 strip 掉未登记的键）。
 */
export function loadKyAppConfig(processCwd: string): KyAppPlatformConfig | null {
  const configPath = getAppConfigPath(processCwd);
  let rawConfig: unknown;
  try {
    rawConfig = parseJsonc(readFileSync(configPath, 'utf-8'));
  } catch {
    // 读不到 config.json 时按「未配置」处理：功能关闭，不阻断进程启动。
    return null;
  }
  return resolveKyAppConfig(rawConfig);
}

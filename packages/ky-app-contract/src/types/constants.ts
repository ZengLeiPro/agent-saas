import type { AppErrorCode } from './errors.js';

/** 契约版本。壳只接受 1，其他值一律错误页「系统版本不兼容」（§8.3）。 */
export const CONTRACT_VERSION = 1 as const;

/** JWT header `typ`（§3.1、§3.2）。验签时必须显式比对，不接受缺省。 */
export const JWT_TYP = {
  sat: 'ky-sat+jwt',
  attest: 'ky-attest+jwt',
  localToken: 'ky-local+jwt',
} as const;

/** 安装密钥派生（§3.2）：HKDF-SHA-256(IKM=KY_INSTALLATION_KEY, salt, info, L=32)。 */
export const INSTALLATION_KEY_HKDF = {
  salt: 'ky-app-contract-v1',
  info: { attest: 'attest', localToken: 'local-token' },
  length: 32,
} as const;

/** SAT TTL（秒，§3.1 TTL 表）。 */
export const SAT_TTL_SECONDS = { user: 300, agent: 60, platform: 60 } as const;

/**
 * SAT 时钟容忍（秒，§3.1 TTL 表）。
 * jose 只有单一 clockTolerance，验签后必须按本表逐 act 复核 nbf / exp。
 */
export const SAT_CLOCK_TOLERANCE_SECONDS = {
  user: { nbf: 30, exp: 0 },
  agent: { nbf: 10, exp: 10 },
  platform: { nbf: 10, exp: 10 },
} as const;

/** `jti` ≥ 128 bit（§3.1）；按 base64url 编码折算的最小字符数。 */
export const JTI_MIN_LENGTH = 22;

/** 安装证明 JWT 有效期（秒，§3.2）：exp = iat + 60。 */
export const ATTEST_TTL_SECONDS = 60;

/** Local Token 上限 4 小时；兜底模式一次启用 4 小时（可续，§3.2/§3.5）。 */
export const LOCAL_TOKEN_MAX_TTL_SECONDS = 4 * 60 * 60;
export const BREAK_GLASS_SESSION_SECONDS = 4 * 60 * 60;

/** 能力调用约束（§4.3、§4.5）。 */
export const CAPABILITY_RESPONSE_MAX_BYTES = 6000;
export const CAPABILITY_TIMEOUT_MAX_MS = 15000;
export const CAPABILITY_SCHEMA_MAX_BYTES = 16 * 1024;
export const CAPABILITY_SCHEMA_MAX_DEPTH = 5;
export const CAPABILITY_EXECUTION_RETENTION_DAYS = 7;

/** 工具名 `app__<systemId>__<capabilityId>` ≤ 64（§4.5）。 */
export const TOOL_NAME_PREFIX = 'app__';
export const TOOL_NAME_MAX_LENGTH = 64;

/** 菜单约束（§4.2、附录 C）。 */
export const MENU_MAX_ITEMS = 200;
export const MENU_MAX_DEPTH = 3;
/** `adminRole` 用户的 menus 必须含这个 key（§4.2、§9.2）。 */
export const ADMIN_REQUIRED_MENU_KEY = 'settings.roles';

/** 应用路径长度上限，与附录 C `$defs.path` 的 maxLength 一致。 */
export const APP_PATH_MAX_LENGTH = 512;
/** 壳注入的保留 query 参数，规范化时一律剔除（§5.2）。 */
export const RESERVED_QUERY_PARAMS = ['ky', 'ky_iid', 'ky_nonce'] as const;
/** `pathPrefixes` 不得覆盖的前缀（§3.3）。 */
export const RESERVED_PATH_PREFIXES = ['/ky/', '/ky-local/', '/internal/'] as const;

/** 目录陈旧度门禁（秒，§3.4）。 */
export const DIRECTORY_STALENESS_SECONDS = {
  warn: 30 * 60,
  blockWrite: 2 * 60 * 60,
  blockRead: 24 * 60 * 60,
} as const;
/** 目录轮询默认间隔（秒，§3.4 默认 5 分钟）。 */
export const DIRECTORY_POLL_INTERVAL_SECONDS = 5 * 60;

/** HTTP 头（§4、§3.4）。 */
export const HTTP_HEADERS = {
  requestId: 'X-KY-Request-Id',
  idempotencyKey: 'X-KY-Idempotency-Key',
  permVersion: 'X-KY-Perm-Version',
} as const;

/** postMessage 信封（§5.3）。 */
export const MESSAGE_NAMESPACE = 'ky';
export const MESSAGE_NAMESPACE_EXPERIMENTAL = 'ky-experimental';
export const MESSAGE_VERSION = 1 as const;
/** 需应答消息的超时（毫秒，§5.3）。 */
export const MESSAGE_RESPONSE_TIMEOUT_MS = 5000;
/** 握手 ready 重发间隔与上限（§5.4）。 */
export const HANDSHAKE_READY_RESEND_INTERVAL_MS = 1000;
export const HANDSHAKE_READY_TIMEOUT_MS = 10000;
export const HANDSHAKE_INIT_RESEND_MAX = 3;

/** JWKS 客户端策略（§3.1-5）。 */
export const JWKS = {
  maxAgeSeconds: 600,
  maxBytes: 16 * 1024,
  negativeCacheSeconds: 60,
  negativeCacheMaxEntries: 1000,
  refetchMinIntervalMs: 10_000,
  staleIfErrorSeconds: 24 * 60 * 60,
} as const;

/** `KY_ENV` 取值（§3.8）。 */
export const KY_ENVS = ['prod', 'staging', 'local', 'test'] as const;
export type KyEnv = (typeof KY_ENVS)[number];

/** 各环境 `iss`（§3.8）；`local` 依赖端口，用 localIssuer() 生成。 */
export const ISSUER_BY_ENV = {
  prod: 'https://agent.kaiyan.net',
  staging: 'https://staging.agent.kaiyan.net',
  test: 'https://test.ky.invalid',
} as const;

/** 各环境 JWKS 地址（§3.1）；`local` 依赖端口，`test` 由 `ky-app doctor` 提供。 */
export const JWKS_URL_BY_ENV = {
  prod: 'https://api.agent.kaiyan.net/.well-known/ky-app-jwks.json',
  staging: 'https://api.staging.agent.kaiyan.net/.well-known/ky-app-jwks.json',
} as const;

/** `KY_ENV=local` 的 `iss`：`http://localhost:<port>`（§3.8）。 */
export function localIssuer(port: number): string {
  return `http://localhost:${port}`;
}

/** `KY_ENV=local` 的 JWKS 地址（§3.1）。 */
export function localJwksUrl(port: number): string {
  return `${localIssuer(port)}/.well-known/ky-app-jwks.json`;
}

/** 错误码 → HTTP 状态（§6.5）；Gateway 内部码没有 HTTP 状态，不在本表。 */
export const ERROR_HTTP_STATUS: Readonly<Record<AppErrorCode, number>> = {
  unauthorized: 401,
  token_replayed: 401,
  forbidden: 403,
  approval_required: 403,
  installation_disabled: 403,
  directory_stale: 403,
  not_found: 404,
  invalid_input: 400,
  idempotency_mismatch: 409,
  in_progress: 409,
  digest_mismatch: 409,
  state_gap: 409,
  response_too_large: 422,
  rate_limited: 429,
  maintenance: 503,
  upstream_unavailable: 503,
  internal: 500,
};

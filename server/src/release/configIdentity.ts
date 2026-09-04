/**
 * Release-bound Config Identity（TASK-318）核心实现。
 *
 * 语义总览（与 docs/config-identity.md 对齐）：
 * - ConfigIdentity 是「已解析、已通过 schema 校验、已应用稳定默认值」的 AppConfig
 *   的非敏感 canonical projection 摘要，不使用 Manifest / 组件制品 / 组件矩阵
 *   digest 冒充（那些绑定的是代码与制品，不是配置）。
 * - digest 输入排除：JSONC 注释（天然，因为作用于 parse 后对象）、对象键顺序
 *   （canonical JSON 递归排序）、绝对路径、时间/随机值、secret 明文、可能携带
 *   凭据的 URL query 明文 / DB 连接串口令、以及仅用于 bootstrap 的瞬态字段。
 * - 受管 inline/ref 双形态凭据进入投影为 `{form:'ref', ref}`（ref 为 ref id 的
 *   不可逆 domain-separated 摘要）或 `{form:'inline'}`；opaque version/rotation
 *   通过 `credentialVersionDigest` 单独成摘要（见下），使 secret 轮换在明文
 *   不可见时仍然改变 observed identity。
 * - `digest` 不包含 vault 版本，保证 expected（部署期工具计算，可能无 vault
 *   访问）与 observed（运行期有 vault）在同一语义层可比较；两侧都解析出版本
 *   时，`credentialVersionDigest` 参与一致性判定。
 */
import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, win32 } from 'node:path';
import type { AppConfig } from '../types/index.js';
import {
  CONFIG_IDENTITY_DIGEST_PATTERN,
  CONFIG_IDENTITY_SCHEMA_VERSION,
  type ConfigIdentityStatus,
  type ConfigIdentityUnverifiableReason,
  type ConfigIdentityVersionResolution,
} from '@agent/shared/schemas/configIdentity';
import { canonicalJson } from '@agent/shared/schemas/releaseManifest';
import type { SecretVault } from '../security/secretVault.js';

export { CONFIG_IDENTITY_SCHEMA_VERSION, CONFIG_IDENTITY_DIGEST_PATTERN };

/** digest domain separator；语义变化时递增版本并显式迁移 schema。 */
const CONFIG_IDENTITY_DOMAIN = 'agent-saas-config-identity-v1';
const SECRET_REF_DOMAIN = 'agent-saas-config-secret-ref-v1';
const CREDENTIAL_VERSION_DOMAIN = 'agent-saas-config-credential-versions-v1';

/**
 * 读取 Release expected config identity 的环境变量。
 * 部署脚本在发布时计算并写入 `.release.env`（见 scripts/release/deploy-*-release.sh）。
 */
export const EXPECTED_CONFIG_IDENTITY_DIGEST_ENV = 'AGENT_SAAS_CONFIG_IDENTITY_DIGEST';
export const EXPECTED_CONFIG_IDENTITY_SCHEMA_VERSION_ENV =
  'AGENT_SAAS_CONFIG_IDENTITY_SCHEMA_VERSION';
export const EXPECTED_CONFIG_IDENTITY_CREDENTIAL_VERSION_DIGEST_ENV =
  'AGENT_SAAS_CONFIG_IDENTITY_CREDENTIAL_VERSION_DIGEST';

export interface ExpectedConfigIdentity {
  schemaVersion: number;
  digest: string;
  credentialVersionDigest?: string;
}

/** 投影内联标记。用对象形态避免与任何真实字符串值碰撞。 */
const INLINE_SECRET_MARKER = { form: 'inline' } as const;
const REDACTED_SECRET_MARKER = { __redacted: 'secret' } as const;

export function secretRefIdentity(refId: string): string {
  return `sha256:${createHash('sha256').update(SECRET_REF_DOMAIN).update('\0').update(refId).digest('hex')}`;
}

export function calculateConfigIdentityDigest(projection: unknown): string {
  return `sha256:${createHash('sha256').update(CONFIG_IDENTITY_DOMAIN).update('\0').update(canonicalJson(projection)).digest('hex')}`;
}

export function calculateCredentialVersionDigest(
  versions: ReadonlyArray<{ refDigest: string; version: number }>,
): string | null {
  const resolvable = versions.filter(
    (entry) => Number.isSafeInteger(entry.version) && entry.version > 0,
  );
  if (resolvable.length === 0) return null;
  const body: Record<string, number> = {};
  for (const entry of resolvable) body[entry.refDigest] = entry.version;
  return `sha256:${createHash('sha256').update(CREDENTIAL_VERSION_DOMAIN).update('\0').update(canonicalJson(body)).digest('hex')}`;
}

// ── 受管凭据字段注册表 ────────────────────────────────────────────────────────
// 注册表是显式清单：只登记「已有 SecretVault ref 安全方案」的 inline/ref 双形态
// 字段，不做按字段名后缀猜测，避免误杀普通字符串字段。

type PathPattern = ReadonlyArray<string | '*'>;

function pathMatches(path: ReadonlyArray<string | number>, pattern: PathPattern): boolean {
  if (path.length !== pattern.length) return false;
  return pattern.every((segment, index) => segment === '*' || segment === path[index]);
}

function pathsMatchAny(
  path: ReadonlyArray<string | number>,
  patterns: ReadonlyArray<PathPattern>,
): boolean {
  return patterns.some((pattern) => pathMatches(path, pattern));
}

function valuesMatchingPattern(
  value: unknown,
  pattern: PathPattern,
  index = 0,
  path: ReadonlyArray<string | number> = [],
): Array<{ path: ReadonlyArray<string | number>; value: unknown }> {
  if (index === pattern.length) return [{ path, value }];
  if (!value || typeof value !== 'object') return [];
  const segment = pattern[index];
  if (segment === '*') {
    const entries = Array.isArray(value)
      ? value.map((entry, entryIndex) => [entryIndex, entry] as const)
      : Object.entries(value as Record<string, unknown>);
    return entries.flatMap(([key, entry]) =>
      valuesMatchingPattern(entry, pattern, index + 1, [...path, key]),
    );
  }
  return valuesMatchingPattern((value as Record<string, unknown>)[segment], pattern, index + 1, [
    ...path,
    segment,
  ]);
}

function formatConfigPath(path: ReadonlyArray<string | number>): string {
  return path
    .map((segment, index) =>
      typeof segment === 'number' ? `[${segment}]` : `${index === 0 ? '' : '.'}${segment}`,
    )
    .join('');
}

/** inline/ref 双形态受管凭据：inline 值不进投影；ref 换成不可逆 ref identity。 */
const MANAGED_CREDENTIAL_PAIRS: ReadonlyArray<{
  inline: PathPattern;
  ref: PathPattern;
}> = [
  { inline: ['serverRemote', 'authToken'], ref: ['serverRemote', 'authTokenRef'] },
  {
    inline: ['tenantRemoteHands', 'hands', '*', 'authToken'],
    ref: ['tenantRemoteHands', 'hands', '*', 'authTokenRef'],
  },
  { inline: ['clientDaemon', 'authToken'], ref: ['clientDaemon', 'authTokenRef'] },
  { inline: ['stt', 'apiKey'], ref: ['stt', 'apiKeyRef'] },
  { inline: ['stt', 'ossAccessKeyId'], ref: ['stt', 'ossAccessKeyIdRef'] },
  { inline: ['stt', 'ossAccessKeySecret'], ref: ['stt', 'ossAccessKeySecretRef'] },
  { inline: ['webTools', 'search', 'apiKey'], ref: ['webTools', 'search', 'apiKeyRef'] },
  {
    inline: ['webTools', 'search', 'global', 'apiKey'],
    ref: ['webTools', 'search', 'global', 'apiKeyRef'],
  },
  {
    inline: ['imageGenTools', 'gptImage2', 'apiKey'],
    ref: ['imageGenTools', 'gptImage2', 'apiKeyRef'],
  },
  {
    inline: ['imageGenTools', 'seedream', 'apiKey'],
    ref: ['imageGenTools', 'seedream', 'apiKeyRef'],
  },
  {
    inline: ['memory', 'index', 'embedding', 'apiKey'],
    ref: ['memory', 'index', 'embedding', 'apiKeyRef'],
  },
  {
    inline: ['models', 'groups', '*', 'apiKey'],
    ref: ['models', 'groups', '*', 'apiKeyRef'],
  },
];

/** ref-only 受管字段（无 inline 形态；schema 已禁止凭据进 config）。 */
const MANAGED_REF_ONLY_FIELDS: ReadonlyArray<PathPattern> = [
  ['codexSubscription', 'credentialRef'],
];

/** 值整体脱敏的 secret 字段（没有 ref 替代方案，不参与 fail-closed）。 */
const SECRET_VALUE_FIELDS: ReadonlyArray<PathPattern> = [
  ['auth', 'jwtSecret'],
  ['artifact', 'signedUrlSecret'],
  // artifact 是 discriminated union：oss 变体的凭据直接位于 artifact 之下。
  ['artifact', 'accessKeyId'],
  ['artifact', 'accessKeySecret'],
  ['dingtalk', 'appSecret'],
  ['dingtalk', 'robots', '*', 'appSecret'],
  ['dingtalkSendMessage', 'appSecret'],
  ['alerting', 'dingtalkRobot', 'appSecret'],
  ['tts', 'doubaoApiKey'],
  ['webPush', 'privateKey'],
  ['secretVault', 'encryptionKey'],
  ['secretVault', 'authToken'],
];

/**
 * 凭据标识、任意 JSON/命令/仓库 URL 可能夹带 token、绝对路径或密文。保留不可逆摘要以让
 * 行为变化仍改变 config digest，但 canonical projection 绝不携带原值。
 */
const OPAQUE_VALUE_FIELDS: ReadonlyArray<PathPattern> = [
  ['auth', 'selfSignup', 'sms', 'accessKeyId'],
  ['models', 'groups', '*', 'thinking'],
  ['models', 'groups', '*', 'extraBody'],
  ['models', 'groups', '*', 'models', '*', 'thinking'],
  ['models', 'groups', '*', 'models', '*', 'extraBody'],
  ['serverRemote', 'recipe', 'repo', 'url'],
  ['serverRemote', 'recipe', 'setupCommands'],
  ['tenantRemoteHands', 'hands', '*', 'recipe', 'repo', 'url'],
  ['tenantRemoteHands', 'hands', '*', 'recipe', 'setupCommands'],
  ['agent', 'userOverrides', '*', 'extraDirs'],
  ['dispatch', 'sandbox', 'allowWrite'],
  ['dispatch', 'sandbox', 'denyRead'],
  ['dispatch', 'sandbox', 'allowRead'],
  ['serverRemote', 'recipe', 'mountSubPath'],
  ['serverRemote', 'recipe', 'files', '*', 'path'],
  ['tenantRemoteHands', 'hands', '*', 'recipe', 'mountSubPath'],
  ['tenantRemoteHands', 'hands', '*', 'recipe', 'files', '*', 'path'],
  ['systemPrompts', '*'],
  ['toolControls', 'tools', '*', 'descriptionOverride', 'text'],
];

/** signedUrl 的 path/query/userinfo 都可能承载 token，只保留明确安全的 origin。 */
const SIGNED_URL_FIELDS: ReadonlyArray<PathPattern> = [
  ['serverRemote', 'recipe', 'files', '*', 'signedUrl'],
  ['tenantRemoteHands', 'hands', '*', 'recipe', 'files', '*', 'signedUrl'],
];

/** URL 可能携带 userinfo、token query 或签名：只保留非敏感 endpoint 形态。 */
const URL_REDACT_FIELDS: ReadonlyArray<PathPattern> = [
  ['server', 'corsOrigins', '*'],
  ['server', 'webBaseUrl'],
  ['dingtalkSendMessage', 'endpoint'],
  ['alerting', 'dingtalkWebhook'],
  ['memory', 'index', 'embedding', 'baseUrl'],
  ['models', 'groups', '*', 'baseUrl'],
  ['codexSubscription', 'endpoint'],
  ['auth', 'selfSignup', 'dingtalkLeadWebhook'],
  ['artifact', 'publicBaseUrl'],
  ['artifact', 'endpoint'],
  ['serverRemote', 'baseUrl'],
  ['serverRemote', 'recipe', 'files', '*', 'url'],
  ['tenantRemoteHands', 'hands', '*', 'baseUrl'],
  ['tenantRemoteHands', 'hands', '*', 'recipe', 'files', '*', 'url'],
  ['secretVault', 'baseUrl'],
  ['webTools', 'search', 'endpoint'],
  ['webTools', 'search', 'global', 'endpoint'],
  ['imageGenTools', 'gptImage2', 'baseUrl'],
  ['imageGenTools', 'seedream', 'baseUrl'],
  ['stt', 'ossEndpoint'],
  ['egress', 'server', 'proxyUrl'],
  ['egress', 'sandbox', 'proxyUrl'],
  ['egress', 'packageMirrors', 'pipIndexUrl'],
  ['egress', 'packageMirrors', 'npmRegistry'],
];

/** 集合语义数组：投影后按 canonical value 排序去重；其余数组保持原序。 */
const SET_LIKE_ARRAY_FIELDS: ReadonlyArray<PathPattern> = [
  ['server', 'corsOrigins'],
  ['egress', 'server', 'matchDomains'],
  ['egress', 'server', 'bypassDomains'],
];

/** 机器相关路径：不进入身份（同语义配置在不同主机应得到相同 identity）。 */
const ABSOLUTE_PATH_FIELDS: ReadonlyArray<PathPattern> = [
  ['agent', 'cwd'],
  ['agent', 'sharedDir'],
  ['cron', 'store'],
  ['observability', 'audit', 'path'],
  ['auth', 'usersFile'],
  ['artifact', 'rootDir'],
  ['memory', 'index', 'dbDir'],
  ['secretVault', 'filePath'],
];

/** 值可能内嵌凭据的 env 形态字段：保留键、脱敏值。 */
const ENV_VALUE_FIELDS: ReadonlyArray<PathPattern> = [
  ['dispatch', 'env', '*'],
  ['proxy', 'HTTP_PROXY'],
  ['proxy', 'HTTPS_PROXY'],
];

function opaqueProjectionIdentity(
  value: unknown,
  path: ReadonlyArray<string | number>,
): {
  __opaqueDigest__: string;
} {
  return {
    __opaqueDigest__: `sha256:${createHash('sha256')
      .update('agent-saas-config-opaque-v1')
      .update('\0')
      .update(path.join('.'))
      .update('\0')
      .update(canonicalJson(value))
      .digest('hex')}`,
  };
}

function compareCodeUnits(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function redactUrl(
  value: string,
  path: ReadonlyArray<string | number>,
):
  | {
      __url__: string;
      __path__: { __opaqueDigest__: string };
      __query__?: { __opaqueDigest__: string };
    }
  | { __opaqueDigest__: string } {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return opaqueProjectionIdentity(value, path);
    }
    // Path/query 都可能携带 token，也都可能改变 endpoint 行为。只保留安全 origin，
    // pathname 与 query 分别以 path-bound opaque digest 表达，避免 projection 持有明文。
    // Query 先按解码后的 key 做与 locale 无关的稳定排序；不同 key 的参数重排等价，
    // 同 key 的值顺序可能影响 first/last-value 语义，必须保留且不去重。
    const queryEntries = [...url.searchParams.entries()].sort(([leftKey], [rightKey]) =>
      compareCodeUnits(leftKey, rightKey),
    );
    return {
      __url__: url.origin,
      __path__: opaqueProjectionIdentity(url.pathname, [...path, 'pathname']),
      ...(queryEntries.length > 0
        ? { __query__: opaqueProjectionIdentity(queryEntries, [...path, 'query']) }
        : {}),
    };
  } catch {
    // 部分 endpoint（如 OSS）允许不带 scheme；不可安全拆解时只保留摘要。
    return opaqueProjectionIdentity(value, path);
  }
}

const DB_ENUM_BEHAVIOR_OPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  channel_binding: new Set(['disable', 'prefer', 'require']),
  gssencmode: new Set(['disable', 'prefer', 'require']),
  load_balance_hosts: new Set(['disable', 'random']),
  ssl: new Set(['0', '1', 'false', 'true']),
  sslaccept: new Set(['accept_invalid_certs', 'strict']),
  sslmode: new Set(['allow', 'disable', 'prefer', 'require', 'verify-ca', 'verify-full']),
  target_session_attrs: new Set([
    'any',
    'prefer-standby',
    'primary',
    'read-only',
    'read-write',
    'standby',
  ]),
};

const DB_SCALAR_BEHAVIOR_OPTIONS = new Set([
  'connect_timeout',
  'idle_in_transaction_session_timeout',
  'keepalives',
  'keepalives_count',
  'keepalives_idle',
  'keepalives_interval',
  'lock_timeout',
  'statement_timeout',
  'tcp_user_timeout',
]);

function redactSignedUrl(
  value: string,
): { __signedUrlOrigin__: string } | typeof REDACTED_SECRET_MARKER {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return REDACTED_SECRET_MARKER;
    return { __signedUrlOrigin__: url.origin };
  } catch {
    return REDACTED_SECRET_MARKER;
  }
}

function collectDbBehaviorOptions(url: URL): Record<string, string> {
  const options: Record<string, string> = {};
  for (const [rawKey, rawValue] of [...url.searchParams.entries()].sort(([a], [b]) =>
    compareCodeUnits(a, b),
  )) {
    const key = rawKey.toLowerCase();
    const value = rawValue.toLowerCase();
    const enums = DB_ENUM_BEHAVIOR_OPTIONS[key];
    if (enums?.has(value)) options[key] = value;
    else if (DB_SCALAR_BEHAVIOR_OPTIONS.has(key) && /^\d+(?:ms|s|min)?$/u.test(value)) {
      options[key] = value;
    }
  }
  return options;
}

function redactConnectionString(
  value: string,
  path: ReadonlyArray<string | number>,
): { __db__: Record<string, unknown> } | typeof REDACTED_SECRET_MARKER {
  try {
    const url = new URL(value);
    const parsedProtocol = url.protocol.replace(/:$/u, '');
    const protocol = parsedProtocol === 'postgres' ? 'postgresql' : parsedProtocol;
    const defaultPort = protocol === 'postgresql' ? '5432' : '';
    const body: Record<string, unknown> = {
      protocol,
      host: url.hostname,
      port: url.port || defaultPort,
    };
    if (url.pathname.length > 1) body.database = url.pathname.slice(1);
    if (url.username) {
      body.principal = opaqueProjectionIdentity(url.username, [...path, 'principal']);
    }
    const options = collectDbBehaviorOptions(url);
    if (Object.keys(options).length > 0) body.options = options;
    return { __db__: body };
  } catch {
    return REDACTED_SECRET_MARKER;
  }
}

export interface ManagedSecretRefEntry {
  /** 配置路径（不含 ref id；错误信息与测试断言用它，绝不输出凭据）。 */
  path: string;
  refId: string;
  refDigest: string;
}

interface ProjectionContext {
  managedRefs: ManagedSecretRefEntry[];
  processCwd: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function credentialEntryForRef(refId: string): { form: 'ref'; ref: string } {
  return { form: 'ref', ref: secretRefIdentity(refId) };
}

function projectValue(
  value: unknown,
  path: ReadonlyArray<string | number>,
  context: ProjectionContext,
): unknown {
  if (value === undefined) return undefined;

  // 1) 受管双形态字段：inline / ref 两条路径都在这里终结。
  for (const pair of MANAGED_CREDENTIAL_PAIRS) {
    if (pathMatches(path, pair.inline)) {
      return value === null || value === '' ? undefined : INLINE_SECRET_MARKER;
    }
    if (pathMatches(path, pair.ref)) {
      if (typeof value !== 'string' || value.length === 0) return undefined;
      context.managedRefs.push({
        path: path.join('.'),
        refId: value,
        refDigest: secretRefIdentity(value),
      });
      return credentialEntryForRef(value);
    }
  }
  // 2) ref-only 受管字段。
  if (pathsMatchAny(path, MANAGED_REF_ONLY_FIELDS)) {
    if (typeof value !== 'string' || value.length === 0) return undefined;
    context.managedRefs.push({
      path: path.join('.'),
      refId: value,
      refDigest: secretRefIdentity(value),
    });
    return credentialEntryForRef(value);
  }
  // credentialRefs 数组：每项都是受管 ref。
  if (pathMatches(path, ['codexSubscription', 'credentialRefs'])) {
    if (!Array.isArray(value)) return undefined;
    return value
      .filter((item): item is string => typeof item === 'string' && item.length > 0)
      .map((item) => {
        context.managedRefs.push({
          path: path.join('.'),
          refId: item,
          refDigest: secretRefIdentity(item),
        });
        return credentialEntryForRef(item);
      });
  }
  // 3) secret / 任意 payload / 机器路径 / URL 脱敏。
  if (pathsMatchAny(path, SECRET_VALUE_FIELDS)) {
    return value === null || value === '' ? undefined : REDACTED_SECRET_MARKER;
  }
  if (pathsMatchAny(path, SIGNED_URL_FIELDS)) {
    return typeof value === 'string' && value.length > 0 ? redactSignedUrl(value) : value;
  }
  if (pathsMatchAny(path, OPAQUE_VALUE_FIELDS)) {
    return value === null || value === '' ? undefined : opaqueProjectionIdentity(value, path);
  }
  if (pathsMatchAny(path, ABSOLUTE_PATH_FIELDS)) {
    if (typeof value !== 'string' || value.length === 0) return undefined;
    if (isAbsolute(value) || win32.isAbsolute(value)) return undefined;
    // 必须复刻运行期真实解析基准，才能覆盖文件系统根截断等仅靠 normalize(value)
    // 无法表达的等价关系。agent.sharedDir 的运行期基准是 projectRoot，其余机器
    // 路径以 processCwd 为基准。投影只保留相对 canonical form 的 opaque digest，
    // 绝不写入绝对 cwd 或 resolved target；相同目录规范为稳定的「.」。
    const basePath = pathMatches(path, ['agent', 'sharedDir'])
      ? resolve(context.processCwd, '..')
      : context.processCwd;
    const canonical = relative(basePath, resolve(basePath, value)) || '.';
    return opaqueProjectionIdentity(canonical, path);
  }
  if (pathsMatchAny(path, ENV_VALUE_FIELDS)) {
    // Env/proxy 值可能含凭据，不能原样进入投影；同时它们也会改变运行行为，
    // 因此用不可逆摘要保留变更信号，而不是统一替换成同一个常量。
    return typeof value === 'string' && value.length > 0
      ? opaqueProjectionIdentity(value, path)
      : value;
  }
  if (pathsMatchAny(path, URL_REDACT_FIELDS)) {
    return typeof value === 'string' && value.length > 0 ? redactUrl(value, path) : value;
  }
  if (pathMatches(path, ['runtimeEventStore', 'connectionString'])) {
    return typeof value === 'string' && value.length > 0
      ? redactConnectionString(value, path)
      : value;
  }

  // 4) 递归。
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      const projected = projectValue(item, [...path, '*'], context);
      out.push(projected);
    }
    if (pathsMatchAny(path, SET_LIKE_ARRAY_FIELDS)) {
      const unique = new Map<string, unknown>();
      for (const item of out) unique.set(canonicalJson(item), item);
      return [...unique.entries()]
        .sort(([left], [right]) => compareCodeUnits(left, right))
        .map(([, item]) => item);
    }
    return out;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const projected = projectValue(value[key], [...path, key], context);
      if (projected !== undefined) out[key] = projected;
    }
    return out;
  }
  return value;
}

export interface CanonicalConfigProjectionResult {
  /** canonical（键已排序）非敏感投影。 */
  projection: Record<string, unknown>;
  /** 投影中出现的受管 SecretVault ref（含不可逆 ref identity）。 */
  managedRefs: ManagedSecretRefEntry[];
}

/**
 * 从已校验 AppConfig 构造非敏感 canonical projection。
 * 输入必须是 `parseAppConfig` 的产物（默认值已物化）；本函数不再做校验。
 */
export function buildCanonicalConfigProjection(
  config: AppConfig,
  processCwd: string = process.cwd(),
): CanonicalConfigProjectionResult {
  const context: ProjectionContext = { managedRefs: [], processCwd: resolve(processCwd) };
  const projection = projectValue(config, [], context) as Record<string, unknown>;
  return { projection, managedRefs: context.managedRefs };
}

/** 收集配置中的受管 ref（不构造完整投影时的轻量入口）。 */
export function collectManagedSecretRefs(
  config: AppConfig,
  processCwd: string = process.cwd(),
): ManagedSecretRefEntry[] {
  return buildCanonicalConfigProjection(config, processCwd).managedRefs;
}

// ── Secret ref 版本解析（opaque version / rotation identity） ────────────────

export interface SecretRefVersionResolution {
  /** refId -> version（解析成功）或 null（不可解析）。 */
  versionByRefId: Map<string, number | null>;
  resolution: ConfigIdentityVersionResolution;
  /** 解析失败的配置路径（不含 ref id，同一路径只出现一次）。 */
  unresolvedPaths: string[];
}

interface UniqueManagedSecretRef {
  refId: string;
  refDigest: string;
  /** 同一 ref 可被多个字段引用；重复数组项产生的相同 path 在这里去重。 */
  paths: string[];
}

function uniqueManagedSecretRefs(
  refs: ReadonlyArray<ManagedSecretRefEntry>,
): UniqueManagedSecretRef[] {
  const byRefId = new Map<string, { refDigest: string; paths: Set<string> }>();
  for (const entry of refs) {
    const existing = byRefId.get(entry.refId);
    if (existing) {
      existing.paths.add(entry.path);
    } else {
      byRefId.set(entry.refId, { refDigest: entry.refDigest, paths: new Set([entry.path]) });
    }
  }
  return [...byRefId.entries()].map(([refId, entry]) => ({
    refId,
    refDigest: entry.refDigest,
    paths: [...entry.paths],
  }));
}

/**
 * 通过 vault 的只读元数据接口解析受管 ref 的 opaque version。
 * 每个唯一 ref id 只 inspect 一次；不读取、不哈希 secret 明文。
 * vault 不支持 inspectRef 时返回 unavailable。
 */
export async function resolveSecretRefVersions(
  refs: ReadonlyArray<ManagedSecretRefEntry>,
  vault: Pick<SecretVault, 'inspectRef'> | undefined,
): Promise<SecretRefVersionResolution> {
  const uniqueRefs = uniqueManagedSecretRefs(refs);
  const versionByRefId = new Map<string, number | null>();
  const unresolvedPaths = new Set<string>();
  if (uniqueRefs.length === 0) {
    return { versionByRefId, resolution: 'resolved', unresolvedPaths: [] };
  }
  if (!vault || typeof vault.inspectRef !== 'function') {
    for (const entry of uniqueRefs) {
      versionByRefId.set(entry.refId, null);
      for (const path of entry.paths) unresolvedPaths.add(path);
    }
    return {
      versionByRefId,
      resolution: 'unavailable',
      unresolvedPaths: [...unresolvedPaths],
    };
  }
  let resolvedCount = 0;
  for (const entry of uniqueRefs) {
    try {
      const ref = await vault.inspectRef(entry.refId, {
        actor: 'system',
        userId: '__system__',
        // metadata-only capability；不授予任何 secret kind 的 plaintext read。
        scopes: ['secret:metadata:read'],
      });
      const version =
        !ref?.revokedAt &&
        typeof ref?.version === 'number' &&
        Number.isSafeInteger(ref.version) &&
        ref.version > 0
          ? ref.version
          : null;
      versionByRefId.set(entry.refId, version);
      if (version !== null) {
        resolvedCount += 1;
      } else {
        for (const path of entry.paths) unresolvedPaths.add(path);
      }
    } catch {
      versionByRefId.set(entry.refId, null);
      for (const path of entry.paths) unresolvedPaths.add(path);
    }
  }
  const resolution: ConfigIdentityVersionResolution =
    resolvedCount === uniqueRefs.length
      ? 'resolved'
      : resolvedCount > 0
        ? 'partial'
        : 'unavailable';
  return { versionByRefId, resolution, unresolvedPaths: [...unresolvedPaths] };
}

// ── observed identity ────────────────────────────────────────────────────────

export interface ConfigIdentityObservation {
  schemaVersion: number;
  digest: string;
  credentialVersionDigest: string | null;
  versionResolution: ConfigIdentityVersionResolution;
  secretRefCount: number;
  /** 解析失败的受管字段路径（脱敏；不含 ref id，同一路径只出现一次）。 */
  unresolvedRefPaths: string[];
  computedAt: string;
}

/**
 * 计算 observed identity：projection digest + 凭据版本摘要。
 * `vault` 仅用于读取 ref 元数据（inspectRef），绝不读取明文。
 */
export async function computeObservedConfigIdentity(
  config: AppConfig,
  vault: Pick<SecretVault, 'inspectRef'> | undefined,
  processCwd: string = process.cwd(),
  now: () => Date = () => new Date(),
): Promise<ConfigIdentityObservation> {
  const { projection, managedRefs } = buildCanonicalConfigProjection(config, processCwd);
  const digest = calculateConfigIdentityDigest(projection);
  const uniqueRefs = uniqueManagedSecretRefs(managedRefs);
  const versions = await resolveSecretRefVersions(managedRefs, vault);
  const versionEntries = uniqueRefs.map((entry) => ({
    refDigest: entry.refDigest,
    version: versions.versionByRefId.get(entry.refId) ?? null,
  }));
  const credentialVersionDigest = calculateCredentialVersionDigest(
    versionEntries.filter(
      (entry): entry is { refDigest: string; version: number } => entry.version !== null,
    ),
  );
  return {
    schemaVersion: CONFIG_IDENTITY_SCHEMA_VERSION,
    digest,
    credentialVersionDigest,
    versionResolution: versions.resolution,
    secretRefCount: uniqueRefs.length,
    unresolvedRefPaths: versions.unresolvedPaths,
    computedAt: now().toISOString(),
  };
}

// ── expected identity（env 绑定） ─────────────────────────────────────────────

function optionalTrimmed(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value || undefined;
}

/**
 * 读取部署期绑定的 expected config identity。
 * - 提供 digest 但格式非法：抛错（fail closed，两边都如此）。
 * - 完全未提供：返回 undefined（staging 启动断言会拒绝；production 显示
 *   「不可验证」而不是拒启，兼容旧 release env / 紧急回滚路径）。
 */
export function readExpectedConfigIdentity(
  env: NodeJS.ProcessEnv = process.env,
): ExpectedConfigIdentity | undefined {
  const digest = optionalTrimmed(env, EXPECTED_CONFIG_IDENTITY_DIGEST_ENV);
  if (!digest) {
    const leftoverVersion = optionalTrimmed(env, EXPECTED_CONFIG_IDENTITY_SCHEMA_VERSION_ENV);
    const leftoverCredential = optionalTrimmed(
      env,
      EXPECTED_CONFIG_IDENTITY_CREDENTIAL_VERSION_DIGEST_ENV,
    );
    if (leftoverVersion || leftoverCredential) {
      throw new Error(
        `${EXPECTED_CONFIG_IDENTITY_SCHEMA_VERSION_ENV}/${EXPECTED_CONFIG_IDENTITY_CREDENTIAL_VERSION_DIGEST_ENV} set without ${EXPECTED_CONFIG_IDENTITY_DIGEST_ENV}`,
      );
    }
    return undefined;
  }
  if (!CONFIG_IDENTITY_DIGEST_PATTERN.test(digest)) {
    throw new Error(`${EXPECTED_CONFIG_IDENTITY_DIGEST_ENV} must be a sha256 digest`);
  }
  const rawSchemaVersion = optionalTrimmed(env, EXPECTED_CONFIG_IDENTITY_SCHEMA_VERSION_ENV);
  if (!rawSchemaVersion) {
    throw new Error(
      `${EXPECTED_CONFIG_IDENTITY_SCHEMA_VERSION_ENV} is required when ${EXPECTED_CONFIG_IDENTITY_DIGEST_ENV} is set`,
    );
  }
  const schemaVersion = Number(rawSchemaVersion);
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion <= 0) {
    throw new Error(`${EXPECTED_CONFIG_IDENTITY_SCHEMA_VERSION_ENV} must be a positive integer`);
  }
  const credentialVersionDigest = optionalTrimmed(
    env,
    EXPECTED_CONFIG_IDENTITY_CREDENTIAL_VERSION_DIGEST_ENV,
  );
  if (credentialVersionDigest && !CONFIG_IDENTITY_DIGEST_PATTERN.test(credentialVersionDigest)) {
    throw new Error(
      `${EXPECTED_CONFIG_IDENTITY_CREDENTIAL_VERSION_DIGEST_ENV} must be a sha256 digest`,
    );
  }
  return {
    schemaVersion,
    digest,
    ...(credentialVersionDigest ? { credentialVersionDigest } : {}),
  };
}

// ── 状态判定 ─────────────────────────────────────────────────────────────────

export interface ConfigIdentityEvaluation {
  status: ConfigIdentityStatus;
  reason?: ConfigIdentityUnverifiableReason;
}

/** expected 与 observed 的一致性判定（四态词汇见 shared 契约）。 */
export function evaluateConfigIdentityStatus(
  expected: ExpectedConfigIdentity | undefined,
  observed:
    | Pick<
        ConfigIdentityObservation,
        'schemaVersion' | 'digest' | 'credentialVersionDigest' | 'versionResolution' | 'secretRefCount'
      >
    | undefined,
): ConfigIdentityEvaluation {
  if (!observed) return { status: 'not_collected' };
  if (!expected) return { status: 'unverifiable', reason: 'expected_not_bound' };
  if (
    expected.schemaVersion !== observed.schemaVersion ||
    observed.schemaVersion !== CONFIG_IDENTITY_SCHEMA_VERSION
  ) {
    return { status: 'unverifiable', reason: 'schema_version_unsupported' };
  }
  // 配置 digest 已经能直接证明漂移时，不应被另一个「凭据版本暂不可解」
  // 信号降级成 unverifiable；只有配置侧一致后才需要版本解析来完成判定。
  if (expected.digest !== observed.digest) return { status: 'drifted' };
  if (observed.versionResolution !== 'resolved') {
    return { status: 'unverifiable', reason: 'secret_ref_version_unresolved' };
  }
  if (observed.secretRefCount > 0 && expected.credentialVersionDigest === undefined) {
    return { status: 'unverifiable', reason: 'expected_credential_version_not_bound' };
  }
  if (
    expected.credentialVersionDigest !== undefined &&
    expected.credentialVersionDigest !== observed.credentialVersionDigest
  ) {
    return { status: 'drifted' };
  }
  return { status: 'consistent' };
}

// ── Production fail-closed 门禁 ──────────────────────────────────────────────

/**
 * Production 对「已有 SecretVault ref 安全方案」的 inline secret fail closed。
 * 只按注册表显式判定，不做字段名猜测；没有 ref 替代方案的 secret 字段
 * （jwtSecret 等）不在此列（它们无法换成 ref，fail closed 会变成拒绝一切配置）。
 */
export function assertProductionManagedCredentialSafety(config: AppConfig): void {
  const failures: string[] = [];
  const root = config as unknown as Record<string, unknown>;

  // inline/ref 双形态只认同一份注册表，避免 projection、门禁与新增字段各自漂移。
  for (const pair of MANAGED_CREDENTIAL_PAIRS) {
    for (const match of valuesMatchingPattern(root, pair.inline)) {
      if (typeof match.value !== 'string' || match.value.length === 0) continue;
      const refField = pair.ref[pair.ref.length - 1];
      failures.push(
        `${formatConfigPath(match.path)} must use SecretVault ref (${refField}) in production`,
      );
    }
  }
  // SecretVault 自身的 bootstrap 凭据：inline key/token 在 production 一律拒绝
  // （encrypted-file 用 encryptionKeyEnv，http 用 authTokenEnv）。
  const vault = root.secretVault as Record<string, unknown> | undefined;
  if (vault) {
    if (
      vault.backend === 'encrypted-file' &&
      typeof vault.encryptionKey === 'string' &&
      vault.encryptionKey.length > 0
    ) {
      failures.push('secretVault.encryptionKey must use encryptionKeyEnv in production');
    }
    if (
      vault.backend === 'http' &&
      typeof vault.authToken === 'string' &&
      vault.authToken.length > 0
    ) {
      failures.push('secretVault.authToken must use authTokenEnv in production');
    }
  }

  if (failures.length > 0) {
    throw new Error(`Production config identity assertion failed:\n- ${failures.join('\n- ')}`);
  }
}

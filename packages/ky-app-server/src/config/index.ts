/**
 * §2.4 部署配置。**全包只有这个模块读 `process.env`**，其余模块一律接收 `KyAppConfig`。
 *
 * 环境变量（凭据只从密钥管理注入，不进仓库，§8.4）：
 * `KY_ENV / KY_SYSTEM_ID / KY_TENANT_ID / KY_INSTALLATION_ID / KY_ORIGIN /
 *  KY_SERVICE_CREDENTIAL / KY_INSTALLATION_KEY / KY_INSTALLATION_KEY_VERSION`
 * 可选：`KY_INSTALLATION_KEY_PREVIOUS / KY_INSTALLATION_KEY_PREVIOUS_VERSION /
 *  KY_JWKS_URL（仅 local/test） / KY_LOCAL_LOGIN_ENABLED`。
 */
import { ISSUER_BY_ENV, JWKS_URL_BY_ENV, KY_ENVS, type KyEnv } from '@kaiyan/ky-app-contract';

/** 读取到的部署配置。所有密钥都已解码成 32 字节。 */
export interface KyAppConfig {
  env: KyEnv;
  /** manifest `systemId`，同时是 SAT 的 `aud`。 */
  systemId: string;
  tenantId: string;
  installationId: string;
  /** 自身前端 origin，写进安装证明的 `origin`（§3.2）。 */
  origin: string;
  /** 目录接口的服务凭据（Bearer，§3.6）。 */
  serviceCredential: string;
  /** SAT 的 `iss`，按 §3.8 由 `KY_ENV` 派生。 */
  issuer: string;
  /** JWKS 地址，按 §3.1 由 `KY_ENV` 固定；local/test 允许注入。 */
  jwksUrl: string;
  /** 安装密钥（32 字节）与 keyVersion（= attest / Local Token 的 `kid`）。 */
  installationKey: Uint8Array;
  installationKeyVersion: string;
  /** 轮换窗口内的上一版安装密钥（§3.2：验证端 24 小时同时接受）。 */
  previousInstallationKey?: Uint8Array;
  previousInstallationKeyVersion?: string;
  /** 兜底登录（`/ky-local/login`）是否开放；`/ky-local/enable` 不受它约束（§3.3）。 */
  localLoginEnabled: boolean;
}

/**
 * 必填部署配置的全部名字。集中声明既是文档，也让 `check-env-var-count.mjs`
 * 能把 `packages` 域的名字数点准（它认这个数组形态，不认包装函数）。
 */
export const REQUIRED_ENV = [
  'KY_ENV',
  'KY_SYSTEM_ID',
  'KY_TENANT_ID',
  'KY_INSTALLATION_ID',
  'KY_ORIGIN',
  'KY_SERVICE_CREDENTIAL',
  'KY_INSTALLATION_KEY',
  'KY_INSTALLATION_KEY_VERSION',
] as const;

/** 可选部署配置。`KY_JWKS_URL` 只允许在 `KY_ENV ∈ local|test` 下出现（§3.1）。 */
export const OPTIONAL_ENV = [
  'KY_INSTALLATION_KEY_PREVIOUS',
  'KY_INSTALLATION_KEY_PREVIOUS_VERSION',
  'KY_JWKS_URL',
  'KY_LOCAL_LOGIN_ENABLED',
] as const;

export class KyAppConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KyAppConfigError';
  }
}

/** 环境变量来源，测试里直接传对象，避免污染 `process.env`。 */
export type EnvSource = Record<string, string | undefined>;

function required(env: EnvSource, name: string): string {
  const value = env[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new KyAppConfigError(`缺少必填部署配置 ${name}`);
  }
  return value.trim();
}

function optional(env: EnvSource, name: string): string | undefined {
  const value = env[name];
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  return value.trim();
}

const HEX_64 = /^[0-9a-fA-F]{64}$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;

/**
 * 安装密钥必须是 32 字节随机值（§2.4），接受 base64url 或 hex 两种编码。
 * 标准 base64（含 `+` `/` `=`）一律拒绝，避免 URL 传递时的歧义。
 */
export function decodeInstallationKey(raw: string, name: string): Uint8Array {
  if (HEX_64.test(raw)) return new Uint8Array(Buffer.from(raw, 'hex'));
  if (BASE64URL.test(raw)) {
    const bytes = new Uint8Array(Buffer.from(raw, 'base64url'));
    if (bytes.length === 32) return bytes;
    throw new KyAppConfigError(`${name} 解码后是 ${bytes.length} 字节，必须是 32 字节`);
  }
  throw new KyAppConfigError(`${name} 必须是 32 字节的 base64url 或 hex 编码`);
}

function resolveEndpoints(env: EnvSource, kyEnv: KyEnv): { issuer: string; jwksUrl: string } {
  const injected = optional(env, 'KY_JWKS_URL');
  if (kyEnv === 'prod' || kyEnv === 'staging') {
    if (injected !== undefined) {
      throw new KyAppConfigError(`KY_ENV=${kyEnv} 时不允许注入 KY_JWKS_URL`);
    }
    return { issuer: ISSUER_BY_ENV[kyEnv], jwksUrl: JWKS_URL_BY_ENV[kyEnv] };
  }
  if (injected === undefined) {
    throw new KyAppConfigError(`KY_ENV=${kyEnv} 时必须提供 KY_JWKS_URL`);
  }
  let parsed: URL;
  try {
    parsed = new URL(injected);
  } catch {
    throw new KyAppConfigError('KY_JWKS_URL 不是合法 URL');
  }
  // §3.8：test 的 iss 固定 https://test.ky.invalid；local 的 iss 是 http://localhost:<port>，
  // 端口由 doctor / 平台本地实例决定，这里从 KY_JWKS_URL 的 origin 反推，不再单列一个环境变量。
  const issuer = kyEnv === 'test' ? ISSUER_BY_ENV.test : parsed.origin;
  return { issuer, jwksUrl: parsed.toString() };
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new KyAppConfigError(`布尔配置只接受 true/false/1/0，收到 ${raw}`);
}

/** 从环境变量读取并校验部署配置。 */
export function loadKyAppConfig(env: EnvSource = process.env): KyAppConfig {
  for (const name of REQUIRED_ENV) required(env, name);
  const rawEnv = required(env, 'KY_ENV');
  if (!(KY_ENVS as readonly string[]).includes(rawEnv)) {
    throw new KyAppConfigError(`KY_ENV 只能是 ${KY_ENVS.join('|')}，收到 ${rawEnv}`);
  }
  const kyEnv = rawEnv as KyEnv;
  const origin = required(env, 'KY_ORIGIN');
  try {
    const parsed = new URL(origin);
    if (parsed.origin !== origin) {
      throw new KyAppConfigError('KY_ORIGIN 必须是纯 origin（无路径 / 查询 / 结尾斜杠）');
    }
  } catch (error) {
    if (error instanceof KyAppConfigError) throw error;
    throw new KyAppConfigError('KY_ORIGIN 不是合法 origin');
  }

  const endpoints = resolveEndpoints(env, kyEnv);
  const previousRaw = optional(env, 'KY_INSTALLATION_KEY_PREVIOUS');
  const previousVersion = optional(env, 'KY_INSTALLATION_KEY_PREVIOUS_VERSION');
  if ((previousRaw === undefined) !== (previousVersion === undefined)) {
    throw new KyAppConfigError(
      'KY_INSTALLATION_KEY_PREVIOUS 与 KY_INSTALLATION_KEY_PREVIOUS_VERSION 必须成对出现',
    );
  }

  return {
    env: kyEnv,
    systemId: required(env, 'KY_SYSTEM_ID'),
    tenantId: required(env, 'KY_TENANT_ID'),
    installationId: required(env, 'KY_INSTALLATION_ID'),
    origin,
    serviceCredential: required(env, 'KY_SERVICE_CREDENTIAL'),
    issuer: endpoints.issuer,
    jwksUrl: endpoints.jwksUrl,
    installationKey: decodeInstallationKey(
      required(env, 'KY_INSTALLATION_KEY'),
      'KY_INSTALLATION_KEY',
    ),
    installationKeyVersion: required(env, 'KY_INSTALLATION_KEY_VERSION'),
    ...(previousRaw === undefined
      ? {}
      : {
          previousInstallationKey: decodeInstallationKey(
            previousRaw,
            'KY_INSTALLATION_KEY_PREVIOUS',
          ),
          previousInstallationKeyVersion: previousVersion,
        }),
    localLoginEnabled: parseBoolean(optional(env, 'KY_LOCAL_LOGIN_ENABLED'), false),
  };
}

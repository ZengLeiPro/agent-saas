import { resolveV1BuildProfile, type V1BuildProfile } from '../app/v1Capabilities';

export type TrustedTransportKind = 'http' | 'websocket';

export type ServiceConfigIssueCode =
  | 'MISSING_API_ORIGIN'
  | 'MISSING_API_ALLOWLIST'
  | 'INVALID_URL'
  | 'INVALID_HOST'
  | 'INVALID_PORT'
  | 'EXAMPLE_DOMAIN'
  | 'USERINFO_NOT_ALLOWED'
  | 'FRAGMENT_NOT_ALLOWED'
  | 'ORIGIN_ONLY'
  | 'PRODUCTION_REQUIRES_HTTPS'
  | 'PRODUCTION_REQUIRES_WSS'
  | 'ORIGIN_NOT_ALLOWED'
  | 'WS_ORIGIN_NOT_ALLOWED'
  | 'CONFIG_NOT_READY'
  | 'INACTIVE_ORIGIN'
  | 'WS_ENDPOINT_INVALID'
  | 'ORIGIN_EDIT_DISABLED';

export interface ServiceConfigIssue {
  code: ServiceConfigIssueCode;
  message: string;
}

export class TrustedServiceConfigurationError extends Error {
  readonly code: ServiceConfigIssueCode;
  readonly userMessage: string;

  constructor(code: ServiceConfigIssueCode, message: string) {
    super(message);
    this.name = 'TrustedServiceConfigurationError';
    this.code = code;
    this.userMessage = message;
  }
}

export interface MobileServiceBuildInput {
  /** Metro development mode. It has the same precedence as the V1 route profile. */
  dev?: boolean;
  /** EXPO_PUBLIC_V1_PROFILE. Unknown values deliberately resolve to production. */
  profileEnv?: string;
  /** Selected API origin for this build profile. */
  apiOrigin?: string;
  /** Comma/newline separated API origins trusted by this build profile. */
  apiAllowlist?: string;
  /** Optional WS origin allowlist. When empty it is derived from the API allowlist. */
  wsAllowlist?: string;
}

export interface MobileServicePolicy {
  profile: V1BuildProfile;
  ready: boolean;
  editable: boolean;
  /** M10-01 removes implicit LAN routing in every profile. */
  lanEnabled: false;
  apiOrigin: string | null;
  wsUrl: string | null;
  apiAllowlist: readonly string[];
  wsAllowlist: readonly string[];
  issue: ServiceConfigIssue | null;
}

export interface ServiceOriginChangeDecision {
  changed: boolean;
  requiresReauthentication: boolean;
}

function fail(code: ServiceConfigIssueCode, message: string): never {
  throw new TrustedServiceConfigurationError(code, message);
}

function toIssue(error: unknown): ServiceConfigIssue {
  if (error instanceof TrustedServiceConfigurationError) {
    return { code: error.code, message: error.userMessage };
  }
  return {
    code: 'INVALID_URL',
    message: '服务配置无效，请联系发布负责人检查构建配置。',
  };
}

function hasRawUserInfo(value: string): boolean {
  const schemeEnd = value.indexOf('://');
  if (schemeEnd < 0) return false;
  const authorityStart = schemeEnd + 3;
  const remainder = value.slice(authorityStart);
  const authorityEnd = remainder.search(/[/?#]/);
  const authority = authorityEnd < 0 ? remainder : remainder.slice(0, authorityEnd);
  return authority.includes('@');
}

function assertValidHostname(hostname: string): void {
  if (!hostname || hostname.endsWith('.') || hostname.includes('%')) {
    fail('INVALID_HOST', '服务地址包含非法主机名。');
  }

  // WHATWG URL keeps brackets around IPv6 hostnames.
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    const address = hostname.slice(1, -1);
    if (!address.includes(':') || !/^[0-9a-f:.]+$/i.test(address)) {
      fail('INVALID_HOST', '服务地址包含非法主机名。');
    }
    return;
  }

  if (/^\d+(?:\.\d+){3}$/.test(hostname)) {
    const octets = hostname.split('.').map(Number);
    if (octets.some((octet) => octet < 0 || octet > 255)) {
      fail('INVALID_HOST', '服务地址包含非法主机名。');
    }
    return;
  }

  if (hostname.length > 253) {
    fail('INVALID_HOST', '服务地址包含非法主机名。');
  }
  const labels = hostname.split('.');
  if (
    labels.some(
      (label) =>
        label.length === 0 ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
    )
  ) {
    fail('INVALID_HOST', '服务地址包含非法主机名。');
  }
}

function assertSafeUrlParts(
  rawValue: string,
  parsed: URL,
  kind: TrustedTransportKind,
  profile: V1BuildProfile,
): void {
  if (rawValue.includes('\\') || /[\u0000-\u001f\u007f]/.test(rawValue)) {
    fail('INVALID_URL', '服务地址格式无效。');
  }
  if (hasRawUserInfo(rawValue) || parsed.username || parsed.password) {
    fail('USERINFO_NOT_ALLOWED', '服务地址不得包含用户名或密码。');
  }
  // Reject even an empty trailing fragment ("#"), which URL.hash normalizes to empty.
  if (rawValue.includes('#')) {
    fail('FRAGMENT_NOT_ALLOWED', '服务地址不得包含片段（#）。');
  }

  assertValidHostname(parsed.hostname);
  if (parsed.port === '0') {
    fail('INVALID_PORT', '服务地址包含非法端口。');
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname === 'example.com' || hostname.endsWith('.example.com')) {
    fail('EXAMPLE_DOMAIN', '示例域名不可作为服务地址。');
  }

  if (kind === 'http') {
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      fail('INVALID_URL', 'API 服务地址必须使用 HTTP(S)。');
    }
    if (profile === 'production' && parsed.protocol !== 'https:') {
      fail('PRODUCTION_REQUIRES_HTTPS', '生产服务必须使用 HTTPS。');
    }
  } else {
    if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') {
      fail('INVALID_URL', '实时服务地址必须使用 WS(S)。');
    }
    if (profile === 'production' && parsed.protocol !== 'wss:') {
      fail('PRODUCTION_REQUIRES_WSS', '生产实时服务必须使用 WSS。');
    }
  }
}

function parseUrl(
  rawValue: string,
  kind: TrustedTransportKind,
  profile: V1BuildProfile,
): URL {
  const value = rawValue.trim();
  if (!value) fail('INVALID_URL', '服务地址不能为空。');

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fail('INVALID_URL', '服务地址格式无效。');
  }
  assertSafeUrlParts(value, parsed, kind, profile);
  return parsed;
}

export function normalizeTrustedOrigin(
  rawValue: string,
  kind: TrustedTransportKind,
  profile: V1BuildProfile,
): string {
  const parsed = parseUrl(rawValue, kind, profile);
  if (parsed.pathname !== '/' || parsed.search || rawValue.trim().includes('?')) {
    fail('ORIGIN_ONLY', '构建服务地址必须是纯 origin，不得包含路径或查询参数。');
  }
  return parsed.origin;
}

function parseOriginAllowlist(
  rawValue: string | undefined,
  kind: TrustedTransportKind,
  profile: V1BuildProfile,
): string[] {
  const values = (rawValue ?? '')
    .split(/[\n,]/)
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set(values.map((value) => normalizeTrustedOrigin(value, kind, profile)))];
}

function toWsOrigin(apiOrigin: string): string {
  const parsed = new URL(apiOrigin);
  parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  return parsed.origin;
}

function unresolvedPolicy(
  profile: V1BuildProfile,
  apiAllowlist: readonly string[],
  wsAllowlist: readonly string[],
  error: unknown,
): MobileServicePolicy {
  return {
    profile,
    ready: false,
    editable: profile !== 'production',
    lanEnabled: false,
    apiOrigin: null,
    wsUrl: null,
    apiAllowlist,
    wsAllowlist,
    issue: toIssue(error),
  };
}

/**
 * Resolve all build-time service inputs into one fail-closed policy.
 * A saved origin is considered only in development/preview and still has to be
 * present in the build-time allowlist. Production always ignores it.
 */
export function resolveMobileServicePolicy(
  input: MobileServiceBuildInput,
  savedOrigin?: string | null,
): MobileServicePolicy {
  const profile = resolveV1BuildProfile({
    dev: input.dev,
    profileEnv: input.profileEnv,
  });

  let apiAllowlist: string[] = [];
  let wsAllowlist: string[] = [];
  try {
    apiAllowlist = parseOriginAllowlist(input.apiAllowlist, 'http', profile);
    if (apiAllowlist.length === 0) {
      fail(
        'MISSING_API_ALLOWLIST',
        '此版本未配置可信服务清单，请联系发布负责人重新构建。',
      );
    }

    wsAllowlist = input.wsAllowlist?.trim()
      ? parseOriginAllowlist(input.wsAllowlist, 'websocket', profile)
      : apiAllowlist.map(toWsOrigin);
    if (wsAllowlist.length === 0) {
      fail(
        'WS_ORIGIN_NOT_ALLOWED',
        '此版本未配置可信实时服务清单，请联系发布负责人重新构建。',
      );
    }

    const selected =
      profile !== 'production' && savedOrigin?.trim()
        ? savedOrigin.trim()
        : input.apiOrigin?.trim();
    if (!selected) {
      fail(
        'MISSING_API_ORIGIN',
        '此版本未配置服务地址，请联系发布负责人重新构建。',
      );
    }

    const apiOrigin = normalizeTrustedOrigin(selected, 'http', profile);
    if (!apiAllowlist.includes(apiOrigin)) {
      fail('ORIGIN_NOT_ALLOWED', '服务地址不在此版本的可信清单中。');
    }

    const wsOrigin = toWsOrigin(apiOrigin);
    // Re-validate the derived endpoint so production can never turn HTTPS into WS.
    normalizeTrustedOrigin(wsOrigin, 'websocket', profile);
    if (!wsAllowlist.includes(wsOrigin)) {
      fail('WS_ORIGIN_NOT_ALLOWED', '实时服务地址不在此版本的可信清单中。');
    }

    return {
      profile,
      ready: true,
      editable: profile !== 'production',
      lanEnabled: false,
      apiOrigin,
      wsUrl: `${wsOrigin}/ws`,
      apiAllowlist,
      wsAllowlist,
      issue: null,
    };
  } catch (error) {
    return unresolvedPolicy(profile, apiAllowlist, wsAllowlist, error);
  }
}

/**
 * Enforce the same policy at the final transport boundary. For authenticated
 * traffic, being somewhere on the allowlist is not sufficient: it must target
 * the currently selected origin, because credentials are origin-bound.
 */
export function assertTrustedServiceUrl(
  policy: MobileServicePolicy,
  rawUrl: string,
  kind: TrustedTransportKind,
): void {
  if (!policy.ready || !policy.apiOrigin || !policy.wsUrl) {
    fail(
      'CONFIG_NOT_READY',
      policy.issue?.message ?? '可信服务配置尚未就绪。',
    );
  }

  const parsed = parseUrl(rawUrl, kind, policy.profile);
  const allowlist = kind === 'http' ? policy.apiAllowlist : policy.wsAllowlist;
  if (!allowlist.includes(parsed.origin)) {
    fail(
      kind === 'http' ? 'ORIGIN_NOT_ALLOWED' : 'WS_ORIGIN_NOT_ALLOWED',
      '请求目标不在此版本的可信服务清单中。',
    );
  }

  const activeOrigin =
    kind === 'http' ? policy.apiOrigin : new URL(policy.wsUrl).origin;
  if (parsed.origin !== activeOrigin) {
    fail('INACTIVE_ORIGIN', '请求目标不是当前已确认的服务地址。');
  }

  if (kind === 'websocket' && (parsed.pathname !== '/ws' || parsed.search)) {
    fail('WS_ENDPOINT_INVALID', '实时服务端点无效。');
  }
}

export function decideServiceOriginChange(
  currentOrigin: string | null,
  nextOrigin: string,
): ServiceOriginChangeDecision {
  const changed = currentOrigin !== nextOrigin;
  return { changed, requiresReauthentication: changed };
}

export function serviceConfigurationErrorMessage(error: unknown): string {
  return toIssue(error).message;
}

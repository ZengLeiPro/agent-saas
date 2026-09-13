import { proxyRequiredSingleAttemptEgressFetch } from '../egressRequestPolicy.js';
import {
  GROK_DEVICE_GRANT,
  GROK_DISCOVERY_ENDPOINT,
  GROK_OAUTH_CLIENT_ID,
  GROK_OAUTH_ISSUER,
  GROK_OAUTH_SCOPE,
  GrokProtocolError,
  grokOAuthRequest,
  isRecord,
  positiveSeconds,
  requiredString,
  trustedGrokOAuthUrl,
} from './grokProtocol.js';
export interface GrokOAuthTokens {
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  expiresAt: string;
  accountId: string;
  email?: string;
  issuer: typeof GROK_OAUTH_ISSUER;
  clientId: string;
}
export interface GrokDiscovery {
  deviceEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string;
  revocationEndpoint?: string;
}
export interface GrokDeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  intervalMs: number;
  expiresAt: number;
  clientId: string;
}
export class GrokOAuthClient {
  private discovery?: { value: GrokDiscovery; expiresAt: number };
  private discoveryInFlight?: Promise<GrokDiscovery>;
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}
  async discover(): Promise<GrokDiscovery> {
    if (this.discovery && this.discovery.expiresAt > this.now()) return this.discovery.value;
    if (this.discoveryInFlight) return this.discoveryInFlight;
    const promise = (async () => {
      const raw = await grokOAuthRequest(this.fetchImpl, GROK_DISCOVERY_ENDPOINT);
      if (!isRecord(raw) || raw.issuer !== GROK_OAUTH_ISSUER)
        throw new GrokProtocolError('invalid_issuer');
      const value: GrokDiscovery = {
        deviceEndpoint: trustedGrokOAuthUrl(raw.device_authorization_endpoint),
        tokenEndpoint: trustedGrokOAuthUrl(raw.token_endpoint),
        userinfoEndpoint: trustedGrokOAuthUrl(raw.userinfo_endpoint),
        ...(raw.revocation_endpoint
          ? { revocationEndpoint: trustedGrokOAuthUrl(raw.revocation_endpoint) }
          : {}),
      };
      // 端点固定；缓存一小时可少走一跳代理，降低刷新链路上的传输失败暴露面。
      this.discovery = { value, expiresAt: this.now() + 3_600_000 };
      return value;
    })().finally(() => {
      if (this.discoveryInFlight === promise) this.discoveryInFlight = undefined;
    });
    this.discoveryInFlight = promise;
    return promise;
  }
  async start(clientId = GROK_OAUTH_CLIENT_ID): Promise<GrokDeviceCode> {
    requiredString(clientId, 256);
    const discovery = await this.discover();
    const raw = await grokOAuthRequest(this.fetchImpl, discovery.deviceEndpoint, {
      client_id: clientId,
      scope: GROK_OAUTH_SCOPE,
    });
    if (!isRecord(raw)) throw new GrokProtocolError('invalid_device_response');
    return {
      deviceCode: requiredString(raw.device_code),
      userCode: requiredString(raw.user_code, 128),
      verificationUri: trustedGrokOAuthUrl(
        raw.verification_uri_complete ?? raw.verification_uri,
        true,
      ),
      intervalMs: positiveSeconds(raw.interval ?? 5, 300) * 1_000,
      expiresAt: this.now() + positiveSeconds(raw.expires_in, 86_400) * 1_000,
      clientId,
    };
  }
  async poll(device: GrokDeviceCode): Promise<GrokOAuthTokens> {
    const discovery = await this.discover();
    const raw = await grokOAuthRequest(this.fetchImpl, discovery.tokenEndpoint, {
      grant_type: GROK_DEVICE_GRANT,
      device_code: device.deviceCode,
      client_id: device.clientId,
    });
    return this.validateTokens(raw, device.clientId, discovery);
  }
  async refresh(previous: GrokOAuthTokens): Promise<GrokOAuthTokens> {
    if (previous.issuer !== GROK_OAUTH_ISSUER) throw new GrokProtocolError('invalid_issuer');
    const discovery = await this.discover();
    // 授权服务器的明确拒绝（invalid_grant 等）原样抛出；连接级失败由 grokOAuthRequest 在同一代理上重试，
    // 仍失败时以 outcomeUnknown 抛出，由凭据管理器决定下次是否沿用同一 refresh token。
    const raw = await grokOAuthRequest(this.fetchImpl, discovery.tokenEndpoint, {
      grant_type: 'refresh_token',
      refresh_token: previous.refreshToken,
      client_id: previous.clientId,
    });
    let tokens: GrokOAuthTokens;
    try {
      tokens = await this.validateTokens(raw, previous.clientId, discovery, previous);
    } catch (error) {
      throw new GrokProtocolError(
        error instanceof GrokProtocolError ? error.code : 'invalid_token_response',
        undefined,
        true,
        { cause: error },
      );
    }
    if (tokens.accountId !== previous.accountId)
      throw new GrokProtocolError('identity_changed', undefined, true);
    return tokens;
  }
  async revoke(tokens: GrokOAuthTokens): Promise<boolean> {
    const { revocationEndpoint } = await this.discover();
    if (!revocationEndpoint) return false;
    const response = await proxyRequiredSingleAttemptEgressFetch(this.fetchImpl)(
      revocationEndpoint,
      {
        method: 'POST',
        redirect: 'error',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          token: tokens.refreshToken,
          token_type_hint: 'refresh_token',
          client_id: tokens.clientId,
        }).toString(),
        signal: AbortSignal.timeout(15_000),
      },
    );
    await response.body?.cancel().catch(() => undefined);
    return response.ok && !/text\/html/i.test(response.headers.get('content-type') ?? '');
  }
  private async validateTokens(
    raw: unknown,
    clientId: string,
    discovery: GrokDiscovery,
    previous?: GrokOAuthTokens,
  ): Promise<GrokOAuthTokens> {
    if (!isRecord(raw)) throw new GrokProtocolError('invalid_token_response');
    if (raw.token_type !== undefined && String(raw.token_type).toLowerCase() !== 'bearer')
      throw new GrokProtocolError('unsupported_token_type');
    const accessToken = requiredString(raw.access_token);
    const refreshToken = requiredString(raw.refresh_token ?? previous?.refreshToken);
    const expiresAt = new Date(this.now() + positiveSeconds(raw.expires_in) * 1_000).toISOString();
    const { accountId, email } = await this.resolveIdentity(
      discovery,
      accessToken,
      raw.id_token,
      previous,
    );
    return {
      accessToken,
      refreshToken,
      expiresAt,
      accountId,
      clientId,
      issuer: GROK_OAUTH_ISSUER,
      ...(raw.id_token ? { idToken: requiredString(raw.id_token) } : {}),
      ...(email ? { email } : {}),
    };
  }
  /**
   * 首次登录只信任经鉴权的 userinfo。刷新已换出新令牌后，userinfo 若因传输/上游原因取不到，
   * 退回到同一响应里 id_token 的 `sub` 与已登录身份做连续性比对；比对不一致仍按 identity_changed 拒绝。
   * 没有 id_token 可比对时把 userinfo 的错误原样抛出，由上层作为可重试失败处理，而不是丢弃 grant。
   */
  private async resolveIdentity(
    discovery: GrokDiscovery,
    accessToken: string,
    rawIdToken: unknown,
    previous?: GrokOAuthTokens,
  ): Promise<{ accountId: string; email?: string }> {
    try {
      const identity = await grokOAuthRequest(
        this.fetchImpl,
        discovery.userinfoEndpoint,
        undefined,
        undefined,
        accessToken,
      );
      if (!isRecord(identity)) throw new GrokProtocolError('invalid_identity_response');
      const accountId = requiredString(identity.sub, 512);
      const email =
        identity.email_verified === true && typeof identity.email === 'string'
          ? requiredString(identity.email, 254)
          : undefined;
      return { accountId, ...(email ? { email } : {}) };
    } catch (error) {
      if (!previous) throw error;
      const subject = idTokenSubject(rawIdToken);
      if (subject === undefined) throw error;
      if (subject !== previous.accountId)
        throw new GrokProtocolError('identity_changed', undefined, true);
      return {
        accountId: previous.accountId,
        ...(previous.email ? { email: previous.email } : {}),
      };
    }
  }
}
function idTokenSubject(rawIdToken: unknown): string | undefined {
  if (typeof rawIdToken !== 'string') return undefined;
  const parts = rawIdToken.split('.');
  if (parts.length < 2 || !parts[1]) return undefined;
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return isRecord(payload) && typeof payload.sub === 'string' && payload.sub.trim()
      ? payload.sub
      : undefined;
  } catch {
    return undefined;
  }
}

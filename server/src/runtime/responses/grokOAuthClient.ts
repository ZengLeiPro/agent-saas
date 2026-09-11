import { singleAttemptEgressFetch } from '../egressRequestPolicy.js';
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
      this.discovery = { value, expiresAt: this.now() + 300_000 };
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
    // One exchange only: a lost response may have consumed the rotating grant.
    const raw = await grokOAuthRequest(this.fetchImpl, discovery.tokenEndpoint, {
      grant_type: 'refresh_token',
      refresh_token: previous.refreshToken,
      client_id: previous.clientId,
    });
    try {
      const tokens = await this.validateTokens(
        raw,
        previous.clientId,
        discovery,
        previous.refreshToken,
      );
      if (tokens.accountId !== previous.accountId)
        throw new GrokProtocolError('identity_changed', undefined, true);
      return tokens;
    } catch (error) {
      throw new GrokProtocolError(
        error instanceof GrokProtocolError ? error.code : 'invalid_token_response',
        undefined,
        true,
      );
    }
  }
  async revoke(tokens: GrokOAuthTokens): Promise<boolean> {
    const { revocationEndpoint } = await this.discover();
    if (!revocationEndpoint) return false;
    const response = await singleAttemptEgressFetch(this.fetchImpl)(revocationEndpoint, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        token: tokens.refreshToken,
        token_type_hint: 'refresh_token',
        client_id: tokens.clientId,
      }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    await response.body?.cancel().catch(() => undefined);
    return response.ok && !/text\/html/i.test(response.headers.get('content-type') ?? '');
  }
  private async validateTokens(
    raw: unknown,
    clientId: string,
    discovery: GrokDiscovery,
    previousRefreshToken?: string,
  ): Promise<GrokOAuthTokens> {
    if (!isRecord(raw)) throw new GrokProtocolError('invalid_token_response');
    if (raw.token_type !== undefined && String(raw.token_type).toLowerCase() !== 'bearer')
      throw new GrokProtocolError('unsupported_token_type');
    const accessToken = requiredString(raw.access_token);
    const refreshToken = requiredString(raw.refresh_token ?? previousRefreshToken);
    const expiresAt = new Date(this.now() + positiveSeconds(raw.expires_in) * 1_000).toISOString();
    // Identity is authenticated userinfo, not frontend input or an unverified JWT.
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
}

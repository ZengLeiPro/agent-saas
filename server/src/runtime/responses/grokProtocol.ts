import { proxyRequiredSingleAttemptEgressFetch } from '../egressRequestPolicy.js';
/** xAI subscription protocol. No Console/API-key fallback. */
export const GROK_OAUTH_ISSUER = 'https://auth.x.ai';
export const GROK_DISCOVERY_ENDPOINT = `${GROK_OAUTH_ISSUER}/.well-known/openid-configuration`;
export const GROK_OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
export const GROK_OAUTH_SCOPE = 'openid profile email offline_access grok-cli:access api:access';
export const GROK_SUBSCRIPTION_BASE_URL = 'https://cli-chat-proxy.grok.com/v1';
export const GROK_RESPONSES_ENDPOINT = `${GROK_SUBSCRIPTION_BASE_URL}/responses`;
export const GROK_MODELS_ENDPOINT = `${GROK_SUBSCRIPTION_BASE_URL}/models`;
export const GROK_BILLING_ENDPOINT = `${GROK_SUBSCRIPTION_BASE_URL}/billing?format=credits`;
export const GROK_DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const OAUTH_ERRORS = new Set([
  'authorization_pending',
  'slow_down',
  'access_denied',
  'expired_token',
  'invalid_grant',
  'invalid_token',
  'invalid_client',
  'invalid_scope',
  'unauthorized_client',
  'unsupported_grant_type',
  'temporarily_unavailable',
  'server_error',
]);
/** Only locally selected codes enter diagnostics; upstream bodies may contain secrets. */
export class GrokProtocolError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
    readonly outcomeUnknown = false,
    options?: ErrorOptions,
  ) {
    super(`Grok ${code}${status === undefined ? '' : ` (HTTP ${status})`}`, options);
    this.name = 'GrokProtocolError';
  }
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
export function trustedGrokOAuthUrl(value: unknown, verification = false): string {
  if (typeof value !== 'string') throw new GrokProtocolError('untrusted_oauth_endpoint');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new GrokProtocolError('untrusted_oauth_endpoint');
  }
  const hosts = verification ? ['auth.x.ai', 'accounts.x.ai', 'x.ai'] : ['auth.x.ai'];
  if (
    url.protocol !== 'https:' ||
    !hosts.includes(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new GrokProtocolError('untrusted_oauth_endpoint');
  return url.href;
}
export function validateGrokEndpoint(value: string): string {
  if (value !== GROK_RESPONSES_ENDPOINT)
    throw new GrokProtocolError('untrusted_subscription_endpoint');
  return value;
}
export function subscriptionHeaders(token: string, model?: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'User-Agent': 'agent-saas/1.0',
    'x-grok-client-mode': 'cli',
    'x-grok-client-version': '1.0.4',
    ...(model ? { 'X-XAI-Token-Auth': 'xai-grok-cli', 'x-grok-model-override': model } : {}),
  };
}
export function positiveSeconds(value: unknown, max = 31_536_000): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > max)
    throw new GrokProtocolError('invalid_expiration');
  return value;
}
export function requiredString(value: unknown, max = 32_768): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw new GrokProtocolError('invalid_response_field');
  return value;
}
export async function readGrokJson(response: Response, maxBytes = 128 * 1024): Promise<unknown> {
  if (!/application\/(?:[\w.+-]+\+)?json\b/i.test(response.headers.get('content-type') ?? '')) {
    await response.body?.cancel().catch(() => undefined);
    throw new GrokProtocolError(
      'non_json_or_challenge',
      response.status,
      response.ok || response.status >= 500,
    );
  }
  const reader = response.body?.getReader();
  if (!reader) throw new GrokProtocolError('empty_response', response.status, response.ok);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes)
        throw new GrokProtocolError('response_too_large', response.status, response.ok);
      chunks.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch {
      throw new GrokProtocolError('invalid_json', response.status, response.ok);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
export async function grokOAuthRequest(
  fetchImpl: typeof fetch,
  url: string,
  body?: Record<string, string>,
  signal?: AbortSignal,
  accessToken?: string,
): Promise<unknown> {
  trustedGrokOAuthUrl(url);
  let response: Response;
  try {
    response = await proxyRequiredSingleAttemptEgressFetch(fetchImpl)(url, {
      method: body ? 'POST' : 'GET',
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'agent-saas/1.0',
        ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      ...(body ? { body: new URLSearchParams(body).toString() } : {}),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000),
    });
  } catch {
    signal?.throwIfAborted();
    throw new GrokProtocolError('network_outcome_unknown', undefined, true);
  }
  const json = await readGrokJson(response);
  if (!response.ok) {
    const code =
      isRecord(json) && typeof json.error === 'string' && OAUTH_ERRORS.has(json.error)
        ? json.error
        : 'upstream_error';
    throw new GrokProtocolError(code, response.status, response.status >= 500);
  }
  return json;
}

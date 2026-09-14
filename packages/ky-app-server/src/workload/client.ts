import {
  V2_JWT_TYP,
  V2_TTL_SECONDS,
  decodeV2Jws,
  verifyWorkloadAccessToken,
  type InstallationBinding,
} from '@kaiyan/ky-app-contract';

import { randomId, signDeploymentJws } from '../identity/jws.js';
import type { DeploymentKeyStore, PlatformKeyResolver } from '../identity/types.js';
import { createDpopProof } from './proof.js';

interface TokenEntry {
  token: string;
  expiresAt: number;
}

export interface WorkloadClientOptions {
  keys: DeploymentKeyStore;
  platformKeys: PlatformKeyResolver;
  fetch?: typeof fetch;
  now?: () => number;
}

/** 每次请求使用短期 DPoP token；缓存键绑定 iid/key/scope/generation。 */
export class KyAppWorkloadClient {
  private readonly cache = new Map<string, TokenEntry>();
  private readonly now: () => number;
  private readonly doFetch: typeof fetch;

  constructor(private readonly options: WorkloadClientOptions) {
    this.now = options.now ?? Date.now;
    this.doFetch = options.fetch ?? fetch;
  }

  async request(
    binding: InstallationBinding,
    scope: string,
    url: string,
    init: RequestInit = {},
    mutation = false,
  ): Promise<Response> {
    const first = await this.authorized(binding, scope, url, init, false);
    if (first.status !== 401 || mutation) return first;
    const reason = first.headers.get('dpop-error') ?? first.headers.get('www-authenticate') ?? '';
    if (!reason.includes('invalid_dpop_proof') && !reason.includes('invalid_token')) return first;
    return this.authorized(binding, scope, url, init, true);
  }

  clear(installationId: string): void {
    for (const key of this.cache.keys())
      if (key.startsWith(`${installationId}:`)) this.cache.delete(key);
  }

  private async authorized(
    binding: InstallationBinding,
    scope: string,
    url: string,
    init: RequestInit,
    force: boolean,
  ): Promise<Response> {
    const token = await this.token(binding, scope, force);
    const current = await this.options.keys.current();
    if (current.keyId !== binding.keyId) throw new Error('deployment_key_generation_mismatch');
    const method = init.method ?? 'GET';
    const proof = await createDpopProof({
      keys: this.options.keys,
      keyRef: current.keyRef,
      publicJwk: current.publicJwk,
      method,
      url,
      accessToken: token,
      now: this.now(),
    });
    return this.doFetch(url, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        authorization: `DPoP ${token}`,
        dpop: proof,
      },
      signal: init.signal ?? AbortSignal.timeout(10_000),
    });
  }

  private async token(
    binding: InstallationBinding,
    scope: string,
    force: boolean,
  ): Promise<string> {
    if (binding.state !== 'connected' && binding.state !== 'activating')
      throw new Error('installation_inactive');
    if (!binding.grantedScopes.includes(scope)) throw new Error('insufficient_scope');
    const key = `${binding.installationId}:${binding.keyId}:${scope}:${binding.generation}`;
    const cached = this.cache.get(key);
    if (!force && cached && cached.expiresAt - this.now() > 60_000) return cached.token;
    const current = await this.options.keys.current();
    if (current.keyId !== binding.keyId || current.deploymentId !== binding.deploymentId) {
      throw new Error('deployment_key_generation_mismatch');
    }
    const endpoint = `${binding.platformApiBaseUrl}/api/app-contract/v2/oauth/token`;
    const now = Math.floor(this.now() / 1000);
    const assertion = await signDeploymentJws({
      keys: this.options.keys,
      keyRef: current.keyRef,
      protectedHeader: { alg: 'ES256', typ: V2_JWT_TYP.clientAssertion, kid: current.keyId },
      payload: {
        iss: current.deploymentId,
        sub: current.deploymentId,
        aud: endpoint,
        iat: now,
        exp: now + V2_TTL_SECONDS.clientAssertion,
        jti: randomId(),
        iid: binding.installationId,
        key_id: current.keyId,
      },
    });
    const dpop = await createDpopProof({
      keys: this.options.keys,
      keyRef: current.keyRef,
      publicJwk: current.publicJwk,
      method: 'POST',
      url: endpoint,
      now: this.now(),
    });
    const response = await this.doFetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', dpop, 'cache-control': 'no-store' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        installation_id: binding.installationId,
        scope,
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: assertion,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`token_request_${response.status}`);
    const body = (await response.json()) as {
      access_token?: unknown;
      accessToken?: unknown;
      expires_in?: unknown;
    };
    const accessToken = body.access_token ?? body.accessToken;
    if (typeof accessToken !== 'string') throw new Error('invalid_token_response');
    const decoded = decodeV2Jws(accessToken);
    const platformKid = decoded.protectedHeader.kid;
    if (typeof platformKid !== 'string') throw new Error('token_missing_kid');
    const platformJwk = await this.options.platformKeys.resolve(
      binding.platformIssuer,
      platformKid,
    );
    const claims = verifyWorkloadAccessToken(accessToken, {
      platformPublicJwk: platformJwk,
      platformKeyId: platformKid,
      platformIssuer: binding.platformIssuer,
      tenantId: binding.tenantId,
      installationId: binding.installationId,
      systemId: binding.systemId,
      deploymentId: binding.deploymentId,
      keyId: binding.keyId,
      generation: binding.generation,
      requiredScope: scope,
      authorizationScheme: 'DPoP',
      now: Math.floor(this.now() / 1000),
    });
    this.cache.set(key, { token: accessToken, expiresAt: claims.exp * 1000 });
    return accessToken;
  }
}

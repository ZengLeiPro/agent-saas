import { createHash, randomBytes } from 'node:crypto';

import {
  V2_CALLBACK_PATH,
  V2_JWT_TYP,
  V2_SCOPES,
  V2_TTL_SECONDS,
  decodeV2Jws,
  sha256Hex,
  verifyInstallationGrant,
  type InstallationBinding,
} from '@kaiyan/ky-app-contract';

import { publicOnlyJwk, randomId, signDeploymentJws } from '../identity/jws.js';
import type { DeploymentKeyStore, PlatformKeyResolver } from '../identity/types.js';
import type { InstallationRuntimeManager } from '../identity/runtimeManager.js';
import { createDpopProof } from '../workload/proof.js';
import type {
  EnrollmentAttemptStore,
  EnrollmentChallengeInput,
  EphemeralSecretStore,
  PlatformChallengeVerifier,
} from './types.js';

export interface EnrollmentServiceOptions {
  enabled: boolean | (() => Promise<boolean> | boolean);
  systemId: string;
  origin: string;
  platformIssuer: string;
  platformApiBaseUrl: string;
  keys: DeploymentKeyStore;
  attempts: EnrollmentAttemptStore;
  secrets: EphemeralSecretStore;
  verifier: PlatformChallengeVerifier;
  platformKeys: PlatformKeyResolver;
  runtimes: InstallationRuntimeManager;
  activation?: { appVersion: string; manifestDigest: string };
  fetch?: typeof fetch;
  now?: () => number;
}

export class V2EnrollmentService {
  private readonly now: () => number;
  private readonly request: typeof fetch;

  constructor(private readonly options: EnrollmentServiceOptions) {
    this.now = options.now ?? Date.now;
    this.request = options.fetch ?? fetch;
  }

  async challenge(
    input: EnrollmentChallengeInput,
    platformSat: string,
  ): Promise<{ enrollmentRequest: string; state: string }> {
    const enabled =
      typeof this.options.enabled === 'function'
        ? await this.options.enabled()
        : this.options.enabled;
    if (!enabled) throw new Error('enrollment_disabled');
    if (
      input.platformIssuer !== this.options.platformIssuer ||
      input.systemId !== this.options.systemId ||
      input.origin !== this.options.origin ||
      input.callbackUrl !== `${this.options.origin}${V2_CALLBACK_PATH}`
    )
      throw new Error('enrollment_binding_mismatch');
    await this.options.verifier.verify(platformSat, input);

    const current = await this.options.keys.current();
    const existing = await this.options.attempts.get(input.operationId);
    let verifier: string;
    let state: string;
    let expiresAt: number;
    let verifierRef: string;
    if (existing) {
      if (
        existing.installationId !== input.installationId ||
        existing.tenantId !== input.tenantId ||
        existing.systemId !== input.systemId ||
        existing.keyId !== current.keyId ||
        existing.status !== 'pending'
      )
        throw new Error('operation_conflict');
      const secret = await this.options.secrets.get(existing.verifierRef);
      if (!secret) throw new Error('operation_expired');
      const parsed = JSON.parse(secret) as { verifier: string; state: string };
      verifier = parsed.verifier;
      state = parsed.state;
      expiresAt = existing.expiresAt;
      verifierRef = existing.verifierRef;
    } else {
      verifier = randomBytes(32).toString('base64url');
      state = randomBytes(32).toString('base64url');
      expiresAt = this.now() + V2_TTL_SECONDS.enrollmentRequest * 1000;
      verifierRef = await this.options.secrets.put(JSON.stringify({ verifier, state }), expiresAt);
    }
    const now = Math.floor(this.now() / 1000);
    const publicJwk = publicOnlyJwk(current.publicJwk);
    const attempt = await this.options.attempts.create({
      operationId: input.operationId,
      installationId: input.installationId,
      tenantId: input.tenantId,
      systemId: input.systemId,
      stateHash: sha256Hex(state),
      verifierRef,
      keyId: current.keyId,
      deploymentId: current.deploymentId,
      publicJwk,
      status: 'pending',
      expiresAt,
    });
    if (attempt.verifierRef !== verifierRef) {
      await this.options.secrets.delete(verifierRef);
      if (
        attempt.installationId !== input.installationId ||
        attempt.tenantId !== input.tenantId ||
        attempt.systemId !== input.systemId ||
        attempt.keyId !== current.keyId ||
        attempt.status !== 'pending'
      )
        throw new Error('operation_conflict');
      const stored = await this.options.secrets.get(attempt.verifierRef);
      if (!stored) throw new Error('operation_expired');
      const parsed = JSON.parse(stored) as { verifier: string; state: string };
      verifier = parsed.verifier;
      state = parsed.state;
      expiresAt = attempt.expiresAt;
      verifierRef = attempt.verifierRef;
    }
    if (attempt.stateHash !== sha256Hex(state)) throw new Error('operation_conflict');
    const enrollmentRequest = await signDeploymentJws({
      keys: this.options.keys,
      keyRef: current.keyRef,
      protectedHeader: { alg: 'ES256', typ: V2_JWT_TYP.enrollmentRequest, kid: current.keyId },
      payload: {
        iss: current.deploymentId,
        sub: input.installationId,
        aud: input.platformIssuer,
        iat: now,
        exp: Math.floor(expiresAt / 1000),
        jti: randomId(),
        tid: input.tenantId,
        iid: input.installationId,
        sid: input.systemId,
        deployment_id: current.deploymentId,
        origin: input.origin,
        callback_uri: input.callbackUrl,
        nonce: input.nonce,
        code_challenge_method: 'S256',
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        key_id: current.keyId,
        public_jwk: publicJwk,
        scope: [...V2_SCOPES],
      },
    });
    return { enrollmentRequest, state };
  }

  async callback(code: string, state: string): Promise<InstallationBinding> {
    const stateHash = sha256Hex(state);
    const attempt = await this.options.attempts.getByStateHash(stateHash);
    if (!attempt || !(await this.options.attempts.beginExchange(attempt.operationId, this.now()))) {
      throw new Error('invalid_or_expired_state');
    }
    let definitiveFailure = false;
    try {
      const stored = await this.options.secrets.get(attempt.verifierRef);
      if (!stored) throw new Error('pkce_verifier_unavailable');
      const secret = JSON.parse(stored) as {
        verifier: string;
        state: string;
        assertion?: string;
        dpop?: string;
      };
      if (sha256Hex(secret.state) !== stateHash) throw new Error('state_mismatch');
      const current = await this.options.keys.current();
      if (current.keyId !== attempt.keyId || current.deploymentId !== attempt.deploymentId) {
        throw new Error('deployment_key_changed');
      }
      const tokenEndpoint = `${this.options.platformApiBaseUrl}/api/app-contract/v2/oauth/token`;
      const assertion =
        secret.assertion ??
        (await this.clientAssertion(
          attempt.installationId,
          tokenEndpoint,
          current.keyRef,
          current.keyId,
          current.deploymentId,
        ));
      const dpop =
        secret.dpop ??
        (await createDpopProof({
          keys: this.options.keys,
          keyRef: current.keyRef,
          publicJwk: current.publicJwk,
          method: 'POST',
          url: tokenEndpoint,
          now: this.now(),
        }));
      if (!secret.assertion || !secret.dpop) {
        await this.options.secrets.set(
          attempt.verifierRef,
          JSON.stringify({ ...secret, assertion, dpop }),
          attempt.expiresAt,
        );
      }
      const response = await this.request(tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', dpop, 'cache-control': 'no-store' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code,
          code_verifier: secret.verifier,
          client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
          client_assertion: assertion,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        definitiveFailure = response.status >= 400 && response.status < 500;
        throw new Error(`token_exchange_${response.status}`);
      }
      const body = (await response.json()) as {
        installation_grant?: unknown;
        installationGrant?: unknown;
        access_token?: unknown;
        token_type?: unknown;
      };
      const installationGrant = body.installation_grant ?? body.installationGrant;
      if (typeof installationGrant !== 'string') throw new Error('invalid_token_response');
      const decoded = decodeV2Jws(installationGrant);
      const platformKid = decoded.protectedHeader.kid;
      if (typeof platformKid !== 'string') throw new Error('grant_missing_kid');
      const platformJwk = await this.options.platformKeys.resolve(
        this.options.platformIssuer,
        platformKid,
      );
      const claims = verifyInstallationGrant(installationGrant, {
        platformPublicJwk: platformJwk,
        platformKeyId: platformKid,
        platformIssuer: this.options.platformIssuer,
        deploymentId: attempt.deploymentId,
        tenantId: attempt.tenantId,
        installationId: attempt.installationId,
        systemId: attempt.systemId,
        origin: this.options.origin,
        keyId: attempt.keyId,
        now: Math.floor(this.now() / 1000),
      });
      const binding: InstallationBinding = {
        installationId: claims.iid,
        tenantId: claims.tid,
        systemId: claims.sid,
        deploymentId: claims.client_id,
        origin: claims.origin,
        platformIssuer: claims.iss,
        platformApiBaseUrl: this.options.platformApiBaseUrl,
        keyId: claims.key_id,
        grantedScopes: claims.scope,
        registeredDigest: claims.registered_digest,
        generation: claims.generation,
        state: 'activating',
        updatedAt: new Date(this.now()).toISOString(),
      };
      await this.options.runtimes.install(binding);
      if (this.options.activation) {
        if (typeof body.access_token !== 'string' || body.token_type !== 'DPoP') {
          throw new Error('invalid_activation_token');
        }
        const activationPath = `/api/app-contract/v2/installations/${encodeURIComponent(attempt.installationId)}/activate`;
        const activationUrl = `${this.options.platformApiBaseUrl}${activationPath}`;
        const activationProof = await createDpopProof({
          keys: this.options.keys,
          keyRef: current.keyRef,
          publicJwk: current.publicJwk,
          method: 'POST',
          url: activationUrl,
          accessToken: body.access_token,
          now: this.now(),
        });
        const activated = await this.request(activationUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `DPoP ${body.access_token}`,
            dpop: activationProof,
            'cache-control': 'no-store',
          },
          body: JSON.stringify({
            manifestDigest: this.options.activation.manifestDigest,
            appVersion: this.options.activation.appVersion,
            keyId: current.keyId,
            generation: claims.generation,
          }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!activated.ok) throw new Error(`activation_${activated.status}`);
      }
      await this.options.attempts.finish(attempt.operationId, 'consumed');
      await this.options.secrets.delete(attempt.verifierRef);
      return { ...binding, state: 'connected' };
    } catch (error) {
      if (definitiveFailure) {
        await this.options.attempts.finish(attempt.operationId, 'failed').catch(() => undefined);
        await this.options.secrets.delete(attempt.verifierRef).catch(() => undefined);
      }
      throw error;
    }
  }

  private async clientAssertion(
    iid: string,
    audience: string,
    keyRef: string,
    keyId: string,
    deploymentId: string,
  ): Promise<string> {
    const now = Math.floor(this.now() / 1000);
    return signDeploymentJws({
      keys: this.options.keys,
      keyRef,
      protectedHeader: { alg: 'ES256', typ: V2_JWT_TYP.clientAssertion, kid: keyId },
      payload: {
        iss: deploymentId,
        sub: deploymentId,
        aud: audience,
        iat: now,
        exp: now + V2_TTL_SECONDS.clientAssertion,
        jti: randomId(),
        iid,
        key_id: keyId,
      },
    });
  }
}

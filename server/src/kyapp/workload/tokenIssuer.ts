import { randomBytes } from 'node:crypto';

import { SignJWT } from 'jose';

import {
  V2_JWT_TYP,
  V2_TTL_SECONDS,
  V2_WORKLOAD_AUDIENCE,
  type InstallationGrantClaims,
  type WorkloadAccessTokenClaims,
} from '@kaiyan/ky-app-contract';

import type { KyAppSigningKeyService } from '../keys/service.js';
import type { KyAppInstallation } from '../systems/types.js';

const randomJti = () => randomBytes(16).toString('base64url');

export interface IssuedV2Token {
  token: string;
  expiresAt: number;
  jti: string;
  kid: string;
}

export class KyAppV2TokenIssuer {
  private readonly now: () => number;

  constructor(
    private readonly options: { keys: KyAppSigningKeyService; issuer: string; now?: () => number },
  ) {
    this.now = options.now ?? Date.now;
  }

  async issueInstallationGrant(input: {
    installation: KyAppInstallation;
    deploymentId: string;
    keyId: string;
    scopes: string[];
    generation: number;
    registeredDigest: string;
    grantJti?: string;
  }): Promise<IssuedV2Token> {
    const iat = Math.floor(this.now() / 1000);
    const exp = iat + V2_TTL_SECONDS.clientAssertion;
    const jti = input.grantJti ?? randomJti();
    const claims: InstallationGrantClaims = {
      iss: this.options.issuer,
      sub: input.installation.installationId,
      aud: input.deploymentId,
      iat,
      exp,
      jti,
      tid: input.installation.tenantId,
      iid: input.installation.installationId,
      sid: input.installation.systemId,
      client_id: input.deploymentId,
      origin: input.installation.origin,
      key_id: input.keyId,
      scope: [...input.scopes],
      registered_digest: input.registeredDigest,
      generation: input.generation,
    };
    return this.sign({ ...claims }, V2_JWT_TYP.installationGrant, exp, jti);
  }

  async issueWorkloadToken(input: {
    installation: KyAppInstallation;
    deploymentId: string;
    keyId: string;
    scopes: string[];
    generation: number;
  }): Promise<IssuedV2Token> {
    const iat = Math.floor(this.now() / 1000);
    const exp = iat + V2_TTL_SECONDS.workloadAccessToken;
    const jti = randomJti();
    const claims: WorkloadAccessTokenClaims = {
      iss: this.options.issuer,
      sub: input.installation.installationId,
      aud: V2_WORKLOAD_AUDIENCE,
      iat,
      nbf: iat,
      exp,
      jti,
      tid: input.installation.tenantId,
      iid: input.installation.installationId,
      sid: input.installation.systemId,
      client_id: input.deploymentId,
      scope: [...new Set(input.scopes)].sort().join(' '),
      cnf: { jkt: input.keyId },
      generation: input.generation,
    };
    return this.sign({ ...claims }, V2_JWT_TYP.workloadAccessToken, exp, jti);
  }

  private async sign(
    claims: Record<string, unknown>,
    typ: string,
    expiresAt: number,
    jti: string,
  ): Promise<IssuedV2Token> {
    const { kid, privateKey } = await this.options.keys.getActiveSigningKey();
    const token = await new SignJWT(claims)
      .setProtectedHeader({ alg: 'ES256', typ, kid })
      .sign(privateKey);
    return { token, expiresAt, jti, kid };
  }
}

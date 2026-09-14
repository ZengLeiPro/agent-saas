import {
  V2_TTL_SECONDS,
  assertReplayReservation,
  decodeV2Jws,
  verifyClientAssertion,
  verifyDpopProof,
  verifyWorkloadAccessToken,
  v2Fail,
  type P256PublicJwk,
  type WorkloadAccessTokenClaims,
} from '@kaiyan/ky-app-contract';

import type { KyAppInstallation, KyAppSystemStore } from '../systems/types.js';
import type { ReplayReservationStore } from './replayStore.js';

export interface PlatformVerificationKeyProvider {
  get(kid: string): Promise<{ publicJwk: Record<string, unknown>; status: string } | null>;
}

export class KyAppV2Authenticator {
  private readonly now: () => number;

  constructor(
    private readonly options: {
      issuer: string;
      tokenEndpoint: string;
      installations: KyAppSystemStore;
      platformKeys: PlatformVerificationKeyProvider;
      replays: ReplayReservationStore;
      now?: () => number;
    },
  ) {
    this.now = options.now ?? Date.now;
  }

  async authenticateTokenRequest(input: {
    installationId: string;
    deploymentId: string;
    keyId: string;
    publicJwk: P256PublicJwk;
    clientAssertion: string;
    dpopProof: string;
    dpopNonce?: string;
    reserveReplay?: boolean;
  }): Promise<{ assertionJti: string; dpopJti: string }> {
    const nowSeconds = Math.floor(this.now() / 1000);
    const assertion = verifyClientAssertion(input.clientAssertion, {
      deploymentPublicJwk: input.publicJwk,
      deploymentId: input.deploymentId,
      installationId: input.installationId,
      keyId: input.keyId,
      tokenEndpoint: this.options.tokenEndpoint,
      now: nowSeconds,
    });
    const dpop = verifyDpopProof(input.dpopProof, {
      method: 'POST',
      requestUrl: this.options.tokenEndpoint,
      expectedKeyId: input.keyId,
      ...(input.dpopNonce ? { nonce: input.dpopNonce } : {}),
      now: nowSeconds,
    });
    if (input.reserveReplay !== false) {
      const expiresAt = new Date((nowSeconds + V2_TTL_SECONDS.clientAssertion) * 1000);
      const reserved = await this.options.replays.reserveMany([
        {
          keyId: input.keyId,
          jti: assertion.claims.jti,
          kind: 'client_assertion',
          expiresAt,
        },
        { keyId: input.keyId, jti: dpop.claims.jti, kind: 'dpop', expiresAt },
      ]);
      if (reserved === 'client_assertion_replayed')
        assertReplayReservation(false, 'client_assertion');
      if (reserved === 'dpop_replayed') assertReplayReservation(false, 'dpop');
    }
    return { assertionJti: assertion.claims.jti, dpopJti: dpop.claims.jti };
  }

  async authenticateResource(input: {
    accessToken: string;
    dpopProof: string;
    method: string;
    requestUrl: string;
    requiredScope: string;
    allowedStatuses?: Array<KyAppInstallation['status']>;
  }): Promise<{ installation: KyAppInstallation; claims: WorkloadAccessTokenClaims }> {
    const decoded = decodeV2Jws(input.accessToken);
    const kid = decoded.protectedHeader.kid;
    const installationId = decoded.payload.iid;
    if (typeof kid !== 'string' || typeof installationId !== 'string') {
      v2Fail('invalid_claims', 'claims', 'workload token 缺少 kid/iid');
    }
    const [platformKey, installation] = await Promise.all([
      this.options.platformKeys.get(kid),
      this.options.installations.getInstallation(installationId),
    ]);
    if (!platformKey || platformKey.status === 'revoked' || !installation) {
      v2Fail('invalid_key_source', 'signature', 'workload token 引用的身份不存在');
    }
    if (
      installation.authMode !== 'v2_asymmetric' ||
      !installation.deploymentId ||
      !installation.currentKeyId ||
      !installation.identityGeneration
    ) {
      v2Fail('installation_inactive', 'resource_binding', '安装实例不是有效 V2 身份');
    }
    const statuses = input.allowedStatuses ?? ['enabled'];
    if (!statuses.includes(installation.status)) {
      v2Fail('installation_inactive', 'resource_binding', '安装实例当前不可用');
    }
    const nowSeconds = Math.floor(this.now() / 1000);
    const claims = verifyWorkloadAccessToken(input.accessToken, {
      platformPublicJwk: platformKey.publicJwk as unknown as P256PublicJwk,
      platformKeyId: kid,
      platformIssuer: this.options.issuer,
      tenantId: installation.tenantId,
      installationId: installation.installationId,
      systemId: installation.systemId,
      deploymentId: installation.deploymentId,
      keyId: installation.currentKeyId,
      generation: installation.identityGeneration,
      requiredScope: input.requiredScope,
      authorizationScheme: 'DPoP',
      now: nowSeconds,
    });
    const dpop = verifyDpopProof(input.dpopProof, {
      method: input.method,
      requestUrl: input.requestUrl,
      accessToken: input.accessToken,
      expectedKeyId: installation.currentKeyId,
      now: nowSeconds,
    });
    const reserved = await this.options.replays.reserve({
      keyId: dpop.keyId,
      jti: dpop.claims.jti,
      kind: 'dpop',
      expiresAt: new Date((nowSeconds + V2_TTL_SECONDS.dpopProof) * 1000),
    });
    assertReplayReservation(reserved, 'dpop');
    return { installation, claims };
  }
}
